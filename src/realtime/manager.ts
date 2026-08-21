import type { CallerContext, CallRecord } from "../agent/types.js";
import type { AgentConfig } from "../config/agent.js";
import type { Logger } from "../logger.js";
import type { Notifier } from "../notify.js";
import type { CallStore } from "../storage/store.js";
import type { XaiClient } from "../xai/client.js";
import { RealtimeCall } from "./call.js";
import type { ConnectRealtime } from "./socket.js";

export interface CallManagerOptions {
  config: AgentConfig;
  xai: XaiClient;
  store: CallStore;
  notifier: Notifier;
  logger: Logger;
  apiKey: string;
  maxConcurrentCalls: number;
  connect: ConnectRealtime;
  realtimeUrl?: string;
}

/**
 * Owns every in-flight call: enforces the concurrency cap, keeps handles for
 * graceful shutdown, and makes sure a finished call is always unregistered.
 */
export class CallManager {
  readonly #active = new Map<string, RealtimeCall>();
  readonly #options: CallManagerOptions;

  constructor(options: CallManagerOptions) {
    this.#options = options;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get atCapacity(): boolean {
    return this.#active.size >= this.#options.maxConcurrentCalls;
  }

  /**
   * Starts bridging a call. The returned promise resolves when the call ends —
   * the webhook handler must not await it, since xAI is holding a ringing
   * caller while it waits for the HTTP response.
   */
  accept(callId: string, caller: CallerContext): Promise<CallRecord> {
    const existing = this.#active.get(callId);
    if (existing) {
      // xAI retries webhook deliveries; a duplicate must not open a second socket.
      this.#options.logger.warn({ callId }, "ignoring duplicate call event");
      return Promise.resolve(existing.record);
    }

    const call = new RealtimeCall({
      callId,
      caller,
      config: this.#options.config,
      xai: this.#options.xai,
      store: this.#options.store,
      notifier: this.#options.notifier,
      logger: this.#options.logger,
      apiKey: this.#options.apiKey,
      connect: this.#options.connect,
      ...(this.#options.realtimeUrl ? { realtimeUrl: this.#options.realtimeUrl } : {}),
    });

    this.#active.set(callId, call);

    return call
      .start()
      .catch((error: unknown) => {
        this.#options.logger.error({ err: error, callId }, "call failed");
        return call.record;
      })
      .finally(() => {
        this.#active.delete(callId);
      });
  }

  /** Hangs up everything still live. Used on SIGTERM so callers are not stranded. */
  async shutdown(reason = "server shutting down"): Promise<void> {
    const calls = [...this.#active.values()];
    await Promise.allSettled(calls.map((call) => call.abort(reason)));
    this.#active.clear();
  }
}
