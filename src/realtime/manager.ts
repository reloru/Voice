import type { CallerContext, CallRecord } from "../agent/types.js";
import type { AgentConfig } from "../config/agent.js";
import type { Logger } from "../logger.js";
import type { Notifier } from "../notify.js";
import type { CallStore } from "../storage/calls.js";
import type { XaiClient } from "../xai/client.js";
import { RealtimeCall, type RealtimeCallOptions } from "./call.js";

export interface CallManagerOptions {
  config: AgentConfig;
  xai: XaiClient;
  store: CallStore;
  notifier: Notifier;
  logger: Logger;
  apiKey: string;
  maxConcurrentCalls: number;
  realtimeUrl?: string;
  createSocket?: RealtimeCallOptions["createSocket"];
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
   * Starts bridging a call. Resolves as soon as the socket is opening — the
   * webhook must return promptly, so the call runs in the background and the
   * returned promise is only for tests and shutdown.
   */
  accept(callId: string, caller: CallerContext): Promise<CallRecord> {
    if (this.#active.has(callId)) {
      // xAI retries webhook deliveries; a duplicate must not open a second socket.
      this.#options.logger.warn({ callId }, "ignoring duplicate call event");
      return Promise.resolve(this.#active.get(callId)!.record);
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
      ...(this.#options.realtimeUrl ? { realtimeUrl: this.#options.realtimeUrl } : {}),
      ...(this.#options.createSocket ? { createSocket: this.#options.createSocket } : {}),
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
