import { WebSocket } from "ws";
import { dispatchTool, type ToolContext } from "../agent/tools.js";
import type {
  CallOutcome,
  CallRecord,
  CallerContext,
  TakenMessage,
  ToolInvocation,
  TranscriptEntry,
  TranscriptRole,
} from "../agent/types.js";
import type { AgentConfig } from "../config/agent.js";
import type { Logger } from "../logger.js";
import type { Notifier } from "../notify.js";
import type { CallStore } from "../storage/calls.js";
import type { XaiClient } from "../xai/client.js";
import { buildSessionUpdate } from "./session.js";

export interface RealtimeCallOptions {
  callId: string;
  caller: CallerContext;
  config: AgentConfig;
  xai: XaiClient;
  store: CallStore;
  notifier: Notifier;
  logger: Logger;
  /** Base WebSocket URL. Overridden in tests to point at a local fake server. */
  realtimeUrl?: string;
  apiKey: string;
  /** Injectable so tests can drive a fake socket. */
  createSocket?: (url: string, apiKey: string) => WebSocket;
}

type PendingAction =
  { type: "hangup"; reason: string } | { type: "transfer"; targetUri: string; reason: string };

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

const DEFAULT_REALTIME_URL = "wss://api.x.ai/v1/realtime";
/** xAI hard-caps a realtime session at 30 minutes; never wait longer than that. */
const ABSOLUTE_MAX_CALL_SECONDS = 1800;

/**
 * Bridges one inbound SIP call to a Grok realtime session.
 *
 * The audio itself never passes through this process — xAI holds both legs of
 * the SIP call. What runs here is the control plane: configure the session,
 * execute tool calls the model makes, keep a transcript, and decide when the
 * call ends.
 */
export class RealtimeCall {
  readonly callId: string;

  readonly #options: RealtimeCallOptions;
  readonly #logger: Logger;
  readonly #startedAt = new Date();
  readonly #transcript: TranscriptEntry[] = [];
  readonly #tools: ToolInvocation[] = [];
  readonly #messages: TakenMessage[] = [];

  #socket?: WebSocket;
  #pendingAction?: PendingAction;
  #responsesInFlight = 0;
  #toolsInFlight = 0;
  #settleTimer?: NodeJS.Timeout;
  #maxDurationTimer?: NodeJS.Timeout;
  #outcome: CallOutcome = "completed";
  #error?: string;
  #finished = false;
  #finishedPromise?: Promise<CallRecord>;

  constructor(options: RealtimeCallOptions) {
    this.#options = options;
    this.callId = options.callId;
    this.#logger = options.logger.child({ callId: options.callId });
  }

  /** Connects and resolves with the finished call record when the call ends. */
  start(): Promise<CallRecord> {
    this.#finishedPromise ??= new Promise<CallRecord>((resolve) => {
      const url = `${this.#options.realtimeUrl ?? DEFAULT_REALTIME_URL}?call_id=${encodeURIComponent(this.callId)}`;
      const socket = this.#options.createSocket
        ? this.#options.createSocket(url, this.#options.apiKey)
        : new WebSocket(url, { headers: { Authorization: `Bearer ${this.#options.apiKey}` } });

      this.#socket = socket;

      const maxSeconds = Math.min(this.#options.config.call.max_seconds, ABSOLUTE_MAX_CALL_SECONDS);
      this.#maxDurationTimer = setTimeout(() => {
        this.#logger.warn({ maxSeconds }, "call hit its duration limit");
        this.#outcome = "timed_out";
        this.#pendingAction = { type: "hangup", reason: "timed_out" };
        this.#settle(0);
      }, maxSeconds * 1000);

      socket.on("open", () => this.#logger.info("realtime session connected"));

      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        void this.#onMessage(data);
      });

      socket.on("error", (error: Error) => {
        this.#logger.error({ err: error }, "realtime socket error");
        this.#outcome = "failed";
        this.#error = error.message;
      });

      socket.on("close", (code: number, reason: Buffer) => {
        this.#logger.info(
          { code, reason: reason?.toString().slice(0, 200) },
          "realtime session closed",
        );
        void this.#finish().then(resolve);
      });
    });

    return this.#finishedPromise;
  }

  /** Ends the call from outside, e.g. during graceful shutdown. */
  async abort(reason: string): Promise<void> {
    this.#logger.warn({ reason }, "aborting call");
    this.#outcome = "failed";
    this.#error = reason;
    await this.#hangup();
    this.#socket?.close();
  }

  get record(): CallRecord {
    const endedAt = new Date();
    return {
      callId: this.callId,
      startedAt: this.#startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.round((endedAt.getTime() - this.#startedAt.getTime()) / 1000),
      outcome: this.#outcome,
      caller: this.#options.caller,
      transcript: [...this.#transcript],
      tools: [...this.#tools],
      messages: [...this.#messages],
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  // --- Event handling -----------------------------------------------------

  async #onMessage(data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    let event: ServerEvent;
    try {
      // `ws` hands back a Buffer, an ArrayBuffer, or — for a fragmented
      // message — an array of Buffers. Only the first stringifies correctly on
      // its own, so normalise before parsing.
      const raw = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      event = JSON.parse(raw.toString("utf8")) as ServerEvent;
    } catch {
      this.#logger.warn("received a non-JSON frame from the realtime API");
      return;
    }

    switch (event.type) {
      case "session.created":
        this.#send(buildSessionUpdate(this.#options.config, this.#options.caller));
        return;

      case "session.updated":
        // Session is live: prompt the model to deliver the greeting.
        this.#createResponse();
        return;

      case "response.created":
        this.#responsesInFlight += 1;
        return;

      case "response.done":
        this.#responsesInFlight = Math.max(0, this.#responsesInFlight - 1);
        this.#settle();
        return;

      case "response.function_call_arguments.done":
        await this.#onToolCall(event);
        return;

      case "response.output_audio_transcript.done":
        this.#addTranscript("agent", text(event.transcript));
        return;

      case "conversation.item.input_audio_transcription.completed":
        this.#addTranscript("caller", text(event.transcript));
        return;

      case "input_audio_buffer.dtmf_event_received":
        this.#addTranscript("system", `caller pressed ${text(event.event ?? event.digit, "?")}`);
        return;

      case "input_audio_buffer.timeout_triggered":
        this.#logger.debug("caller idle; model is checking in");
        return;

      case "error": {
        const details = (event.error ?? event) as Record<string, unknown>;
        this.#logger.error({ details }, "realtime API reported an error");
        this.#addTranscript("system", `error: ${text(details.message, "unknown")}`);
        return;
      }

      // Chatty per-token events and keepalives we intentionally ignore.
      case "ping":
      case "response.output_audio.delta":
      case "response.output_audio_transcript.delta":
      case "conversation.item.input_audio_transcription.updated":
      case "response.function_call_arguments.delta":
        return;

      default:
        this.#logger.debug({ type: event.type }, "unhandled realtime event");
    }
  }

  async #onToolCall(event: ServerEvent): Promise<void> {
    const name = text(event.name);
    const callId = text(event.call_id);
    const rawArguments = text(event.arguments, "{}");

    if (!callId) {
      this.#logger.warn({ name }, "tool call arrived without a call_id; ignoring");
      return;
    }

    this.#toolsInFlight += 1;
    try {
      const result = await dispatchTool(name, rawArguments, this.#toolContext());

      this.#tools.push({
        at: new Date().toISOString(),
        name,
        arguments: safeParse(rawArguments),
        result: result.output,
      });

      this.#send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result.output),
        },
      });

      if (result.speakAfter) this.#createResponse();
    } finally {
      this.#toolsInFlight = Math.max(0, this.#toolsInFlight - 1);
      this.#settle();
    }
  }

  #toolContext(): ToolContext {
    return {
      callId: this.callId,
      config: this.#options.config,
      caller: this.#options.caller,
      store: this.#options.store,
      notifier: this.#options.notifier,
      logger: this.#logger,
      onMessageTaken: (message) => this.#messages.push(message),
      requestHangup: (reason) => {
        this.#pendingAction = { type: "hangup", reason };
        if (this.#outcome === "completed") this.#outcome = "ended_by_agent";
      },
      requestTransfer: (targetUri, reason) => {
        this.#pendingAction = { type: "transfer", targetUri, reason };
        this.#outcome = "transferred";
      },
    };
  }

  // --- Deferred hangup / transfer ----------------------------------------

  /**
   * Runs a pending hangup or transfer once the model has stopped talking.
   *
   * A tool that ends the call is almost always invoked mid-sentence, so acting
   * on it immediately would cut off the goodbye. We wait for every in-flight
   * response and tool to settle, then allow a short grace period for the audio
   * already handed to the carrier to actually play out.
   */
  #settle(delayMs = this.#options.config.call.hangup_delay_ms): void {
    if (!this.#pendingAction) return;
    if (this.#responsesInFlight > 0 || this.#toolsInFlight > 0) return;
    if (this.#settleTimer) return;

    this.#settleTimer = setTimeout(() => {
      void this.#runPendingAction();
    }, delayMs);
  }

  async #runPendingAction(): Promise<void> {
    const action = this.#pendingAction;
    this.#pendingAction = undefined;
    if (!action) return;

    if (action.type === "transfer") {
      try {
        await this.#options.xai.referCall(this.callId, action.targetUri);
        this.#addTranscript("system", `transferred to ${action.targetUri} (${action.reason})`);
        this.#logger.info({ target: action.targetUri }, "call transferred");
        // The REFER moves the call away; our session is done either way.
        this.#socket?.close();
        return;
      } catch (error) {
        // A failed transfer must not silently drop the caller — tell the model
        // so it can apologise and fall back to taking a message.
        this.#logger.error({ err: error }, "transfer failed; returning control to the agent");
        this.#outcome = "completed";
        this.#addTranscript("system", "transfer failed");
        this.#send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "SYSTEM: The transfer failed and the caller is still on the line. Apologise " +
                  "briefly, do not try transferring again, and offer to take a message instead.",
              },
            ],
          },
        });
        this.#createResponse();
        return;
      }
    }

    this.#addTranscript("system", `call ended by agent (${action.reason})`);
    await this.#hangup();
    this.#socket?.close();
  }

  async #hangup(): Promise<void> {
    try {
      await this.#options.xai.hangupCall(this.callId);
    } catch (error) {
      this.#logger.warn({ err: error }, "hangup request failed");
    }
  }

  // --- Plumbing -----------------------------------------------------------

  #createResponse(): void {
    this.#send({ type: "response.create" });
  }

  #send(payload: unknown): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.#logger.debug("dropped an outbound event; socket is not open");
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  #addTranscript(role: TranscriptRole, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#transcript.push({ at: new Date().toISOString(), role, text: trimmed });
  }

  async #finish(): Promise<CallRecord> {
    if (this.#finished) return this.record;
    this.#finished = true;

    clearTimeout(this.#maxDurationTimer);
    clearTimeout(this.#settleTimer);

    const record = this.record;
    try {
      await this.#options.store.recordCall(record);
    } catch (error) {
      this.#logger.error({ err: error }, "failed to persist call record");
    }
    void this.#options.notifier.notify({ kind: "call.ended", call: record });
    return record;
  }
}

/**
 * Coerce an untyped field from a server event into a string.
 *
 * Event payloads are `unknown` by construction, and a plain `String()` on an
 * object would silently produce "[object Object]" — better to fall back to the
 * default than to feed that into a transcript or a tool name.
 */
function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
