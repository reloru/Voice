import type { CallRecord, TakenMessage } from "../src/agent/types.js";
import type { CallStore } from "../src/storage/store.js";

/**
 * Workers KV implementation of {@link CallStore}.
 *
 * KV has no append and no ordered scan by insertion time, so each record is a
 * separate key prefixed with a reverse-chronological sort key. Listing by
 * prefix then returns newest first without reading any values.
 */
export class KvCallStore implements CallStore {
  constructor(
    private readonly kv: KVNamespace,
    /** Records expire after this long. Transcripts are personal data; do not keep them forever. */
    private readonly ttlSeconds = 60 * 60 * 24 * 30,
  ) {}

  async recordCall(record: CallRecord): Promise<void> {
    await this.kv.put(
      `call:${sortKey(record.startedAt)}:${record.callId}`,
      JSON.stringify(record),
      {
        expirationTtl: this.ttlSeconds,
      },
    );
  }

  async recordMessage(message: TakenMessage): Promise<void> {
    await this.kv.put(`msg:${sortKey(message.at)}:${message.id}`, JSON.stringify(message), {
      expirationTtl: this.ttlSeconds,
    });
  }

  async recentCalls(limit = 20): Promise<CallRecord[]> {
    return this.#list<CallRecord>("call:", limit);
  }

  async recentMessages(limit = 50): Promise<TakenMessage[]> {
    return this.#list<TakenMessage>("msg:", limit);
  }

  async #list<T>(prefix: string, limit: number): Promise<T[]> {
    const listing = await this.kv.list({ prefix, limit });
    const values = await Promise.all(listing.keys.map((key) => this.kv.get(key.name, "json")));
    return values.filter((value): value is T => value !== null);
  }
}

/**
 * Descending sort key: KV lists keys in lexicographic order, so storing
 * (max millis - timestamp) puts the newest record first.
 */
function sortKey(isoTimestamp: string): string {
  const millis = Date.parse(isoTimestamp);
  const inverted = 99999999999999 - (Number.isFinite(millis) ? millis : 0);
  return String(inverted).padStart(14, "0");
}
