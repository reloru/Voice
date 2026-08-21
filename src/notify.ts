import type { Logger } from "./logger.js";
import type { CallRecord, TakenMessage } from "./agent/types.js";

export type Notification =
  { kind: "message.taken"; message: TakenMessage } | { kind: "call.ended"; call: CallRecord };

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

/**
 * POSTs each notification to `NOTIFY_WEBHOOK_URL`, which is the seam for
 * plugging in SMS, email, Slack, or a home automation hook without this
 * project needing credentials for any of them.
 *
 * Delivery is best-effort: a notification failure must never take down a live
 * call, so errors are logged and swallowed.
 */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  async notify(notification: Notification): Promise<void> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...notification, sent_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, kind: notification.kind },
          "notification webhook returned a non-2xx response",
        );
      }
    } catch (error) {
      this.logger.warn({ err: error, kind: notification.kind }, "notification webhook failed");
    }
  }
}

/** Used when NOTIFY_WEBHOOK_URL is unset: the log is the notification channel. */
export class LogNotifier implements Notifier {
  constructor(private readonly logger: Logger) {}

  async notify(notification: Notification): Promise<void> {
    if (notification.kind === "message.taken") {
      const { callerName, callbackNumber, urgency, message } = notification.message;
      this.logger.info(
        { callerName, callbackNumber, urgency },
        `message taken: ${message.slice(0, 500)}`,
      );
      return;
    }
    const { callId, outcome, durationSeconds, messages } = notification.call;
    this.logger.info({ callId, outcome, durationSeconds, messages: messages.length }, "call ended");
  }
}

export function createNotifier(url: string | undefined, logger: Logger): Notifier {
  return url ? new WebhookNotifier(url, logger) : new LogNotifier(logger);
}
