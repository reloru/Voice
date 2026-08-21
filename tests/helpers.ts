import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseAgentConfig, type AgentConfig } from "../src/config/agent.js";
import type { Env } from "../src/config/env.js";
import { silentLogger } from "../src/logger.js";
import type { Notification, Notifier } from "../src/notify.js";
import { computeSignature, decodeSigningSecret } from "../src/webhooks/signature.js";

export const TEST_SECRET = "whsec_dGVzdC1zaWduaW5nLWtleS1mb3ItdW5pdC10ZXN0cw==";

export const MINIMAL_CONFIG_YAML = `
agent:
  name: Ada
owner:
  name: Reed
  timezone: America/Chicago
greeting: "Hi, you've reached Reed's line."
persona:
  style: Warm and brisk.
`;

export function testConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...parseAgentConfig(MINIMAL_CONFIG_YAML), ...overrides };
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    XAI_API_KEY: "xai-test-key",
    XAI_API_BASE: "https://api.example.test",
    XAI_WEBHOOK_SECRET: TEST_SECRET,
    WEBHOOK_TOLERANCE_SECONDS: 300,
    ALLOW_UNSIGNED_WEBHOOKS: false,
    HOST: "127.0.0.1",
    PORT: 0,
    AGENT_CONFIG_PATH: "agent.yaml",
    DATA_DIR: "data",
    MAX_CONCURRENT_CALLS: 10,
    ...overrides,
  };
}

/** Builds the headers xAI would send for a given body. */
export async function signedHeaders(
  body: string,
  {
    secret = TEST_SECRET,
    timestamp = Math.floor(Date.now() / 1000),
    id = `msg_${randomUUID()}`,
  } = {},
): Promise<Record<string, string>> {
  const signature = await computeSignature(decodeSigningSecret(secret), id, timestamp, body);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signature}`,
  };
}

export function callIncomingBody({
  callId = randomUUID(),
  from = "+15555550100",
  to = "+15555550199",
}: { callId?: string; from?: string; to?: string } = {}): string {
  return JSON.stringify({
    object: "event",
    id: `evt_${randomUUID()}`,
    type: "realtime.call.incoming",
    created_at: Math.floor(Date.now() / 1000),
    data: {
      call_id: callId,
      sip_headers: [
        { name: "From", value: from },
        { name: "To", value: to },
      ],
      metadata: {},
    },
  });
}

export class RecordingNotifier implements Notifier {
  readonly sent: Notification[] = [];
  async notify(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
}

export async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "voice-agent-test-"));
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export { silentLogger };

/**
 * A stand-in for xAI's realtime WebSocket.
 *
 * Speaks enough of the protocol to drive `RealtimeCall` through a full call:
 * it greets with `session.created`, acknowledges `session.update`, and lets a
 * test push arbitrary server events while recording everything the client sent.
 */
export class FakeRealtimeServer {
  readonly received: Record<string, unknown>[] = [];
  #wss?: WebSocketServer;
  #socket?: WebSocket;
  #connected?: Promise<void>;

  async start(): Promise<string> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.#wss = wss;

    this.#connected = new Promise<void>((resolve) => {
      wss.on("connection", (socket) => {
        this.#socket = socket;
        socket.on("message", (raw: Buffer) => {
          this.received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        });
        socket.send(
          JSON.stringify({
            type: "session.created",
            session: { id: "sess_test", model: "grok-voice-latest" },
          }),
        );
        resolve();
      });
    });

    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const address = wss.address();
    if (typeof address === "string" || address === null) throw new Error("no port bound");
    return `ws://127.0.0.1:${address.port}/v1/realtime`;
  }

  async waitForConnection(): Promise<void> {
    await this.#connected;
  }

  send(event: Record<string, unknown>): void {
    this.#socket?.send(JSON.stringify(event));
  }

  /** Resolves once a client message of `type` has been received. */
  async waitFor(type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find((message) => message.type === type);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for "${type}"; saw: ${this.received.map((m) => m.type).join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  sent(type: string): Record<string, unknown>[] {
    return this.received.filter((message) => message.type === type);
  }

  closeSocket(): void {
    this.#socket?.close();
  }

  async stop(): Promise<void> {
    this.#socket?.close();
    await new Promise<void>((resolve) => this.#wss?.close(() => resolve()));
  }
}
