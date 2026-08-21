import { RealtimeCall } from "../src/realtime/call.js";
import type { CallerContext, CallRecord } from "../src/agent/types.js";
import { createNotifier } from "../src/notify.js";
import { XaiClient } from "../src/xai/client.js";
import { createWorkerLogger, json, loadWorkerAgentConfig, type WorkerEnv } from "./env.js";
import { KvCallStore } from "./kv-store.js";
import { connectWithWorkersSocket } from "./socket.js";
import { asText } from "../src/realtime/socket.js";

interface StartPayload {
  callId: string;
  caller: CallerContext;
}

/**
 * One Durable Object instance per call, addressed by `call_id`.
 *
 * A plain Worker invocation cannot hold a WebSocket open for the length of a
 * phone call, and addressing the object by call id gives idempotency for free:
 * xAI retrying its webhook routes to the same instance, which refuses to open a
 * second session for a call that is already running.
 */
export class CallSession {
  #running?: Promise<CallRecord>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/selftest") return this.#selftest();
    if (path !== "/start") return json({ error: "not found" }, 404);

    const payload = await request.json<StartPayload>();
    const logger = createWorkerLogger({ callId: payload.callId });

    if (this.#running) {
      logger.warn("duplicate start for a call already in progress; ignoring");
      return json({ accepted: false, reason: "already_running" });
    }

    const config = await loadWorkerAgentConfig(this.env, logger);
    const xai = new XaiClient({
      apiKey: this.env.XAI_API_KEY,
      ...(this.env.XAI_API_BASE ? { baseUrl: this.env.XAI_API_BASE } : {}),
    });

    const call = new RealtimeCall({
      callId: payload.callId,
      caller: payload.caller,
      config,
      xai,
      store: new KvCallStore(this.env.VOICE_KV),
      notifier: createNotifier(this.env.NOTIFY_WEBHOOK_URL, logger),
      logger,
      apiKey: this.env.XAI_API_KEY,
      connect: connectWithWorkersSocket,
    });

    // The object stays alive for as long as this request is in flight, which is
    // exactly the length of the call.
    this.#running = call.start().finally(() => {
      this.#running = undefined;
    });

    const record = await this.#running;
    logger.info(
      { outcome: record.outcome, durationSeconds: record.durationSeconds },
      "call finished",
    );

    return json({
      accepted: true,
      outcome: record.outcome,
      durationSeconds: record.durationSeconds,
      messages: record.messages.length,
    });
  }

  /**
   * Proves the hard part of running here at all: that a Durable Object can hold
   * an outbound WebSocket to xAI, authenticate, and exchange messages. Opens a
   * direct realtime session (no `call_id`), asks for one word, and reports what
   * came back.
   */
  async #selftest(): Promise<Response> {
    const logger = createWorkerLogger({ selftest: true });
    const startedAt = Date.now();
    const seen: string[] = [];
    let transcript = "";
    let audioBytes = 0;
    let failure: string | undefined;

    try {
      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out after 30s")), 30_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };

        void connectWithWorkersSocket({
          url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
          apiKey: this.env.XAI_API_KEY,
          onError: (message) => {
            clearTimeout(timer);
            reject(new Error(message));
          },
          onClose: done,
          onMessage: (data) => {
            const event = JSON.parse(asText(data)) as { type: string; [k: string]: unknown };
            if (!seen.includes(event.type)) seen.push(event.type);

            if (event.type === "response.output_audio.delta") {
              audioBytes += asText(event.delta).length;
              return;
            }
            if (event.type === "response.output_audio_transcript.done") {
              transcript = asText(event.transcript);
              return;
            }
            if (event.type === "response.done") done();
          },
        }).then((socket) => {
          socket.send(
            JSON.stringify({
              type: "session.update",
              session: { instructions: "Reply with exactly one word.", voice: "eve" },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Say the word ready and nothing else." }],
              },
            }),
          );
          socket.send(JSON.stringify({ type: "response.create" }));
        }, reject);
      });

      await finished;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      logger.error({ err: failure }, "selftest failed");
    }

    return json({
      ok: !failure && transcript.length > 0,
      elapsedMs: Date.now() - startedAt,
      transcript,
      audioBase64Chars: audioBytes,
      eventsSeen: seen,
      ...(failure ? { error: failure } : {}),
    });
  }
}
