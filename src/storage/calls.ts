import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CallRecord, TakenMessage } from "../agent/types.js";

/**
 * Append-only JSONL storage for call records and messages.
 *
 * Deliberately boring: a phone agent that loses a message because a database
 * was unreachable is worse than useless, and one file append per call is
 * durable, greppable, and trivial to back up. Swap this class out if you want
 * a real database — the rest of the app only depends on this interface.
 */
export class CallStore {
  readonly #dir: string;
  #ready?: Promise<void>;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get callsPath(): string {
    return path.join(this.#dir, "calls.jsonl");
  }

  get messagesPath(): string {
    return path.join(this.#dir, "messages.jsonl");
  }

  #ensureDir(): Promise<void> {
    this.#ready ??= mkdir(this.#dir, { recursive: true }).then(() => undefined);
    return this.#ready;
  }

  async recordCall(record: CallRecord): Promise<void> {
    await this.#ensureDir();
    await appendFile(this.callsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async recordMessage(message: TakenMessage): Promise<void> {
    await this.#ensureDir();
    await appendFile(this.messagesPath, `${JSON.stringify(message)}\n`, "utf8");
  }

  async recentCalls(limit = 20): Promise<CallRecord[]> {
    return (await readJsonl<CallRecord>(this.callsPath)).slice(-limit).reverse();
  }

  async recentMessages(limit = 50): Promise<TakenMessage[]> {
    return (await readJsonl<TakenMessage>(this.messagesPath)).slice(-limit).reverse();
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }

  const rows: T[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip a torn final line rather than failing the whole read.
    }
  }
  return rows;
}
