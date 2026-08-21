import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { findKnownCaller, isBlocked, type AgentConfig } from "./config/agent.js";
import type { Env } from "./config/env.js";
import type { Logger } from "./logger.js";
import { createNotifier, type Notifier } from "./notify.js";
import { CallManager } from "./realtime/manager.js";
import type { CallStore } from "./storage/calls.js";
import {
  callIncomingEventSchema,
  callerContextFromEvent,
  webhookEventSchema,
} from "./webhooks/events.js";
import { verifyWebhookSignature } from "./webhooks/signature.js";
import type { XaiClient } from "./xai/client.js";

export interface BuildServerOptions {
  env: Env;
  config: AgentConfig;
  xai: XaiClient;
  store: CallStore;
  /** Defaults to a notifier derived from `NOTIFY_WEBHOOK_URL` and the app logger. */
  notifier?: Notifier;
  manager?: CallManager;
}

export interface Server {
  app: FastifyInstance;
  manager: CallManager;
}

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export async function buildServer(options: BuildServerOptions): Promise<Server> {
  const { env, config, xai, store } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never let a signing secret or bearer token reach the log.
      redact: ["req.headers.authorization", "req.headers['webhook-signature']"],
    },
    bodyLimit: MAX_WEBHOOK_BODY_BYTES,
    // Deployments sit behind a tunnel or load balancer; honour X-Forwarded-For
    // so request logs show the real origin.
    trustProxy: true,
  });

  const logger = app.log as unknown as Logger;
  const notifier = options.notifier ?? createNotifier(env.NOTIFY_WEBHOOK_URL, logger);

  const manager =
    options.manager ??
    new CallManager({
      config,
      xai,
      store,
      notifier,
      logger,
      apiKey: env.XAI_API_KEY,
      maxConcurrentCalls: env.MAX_CONCURRENT_CALLS,
    });

  /**
   * Signature verification runs over the exact bytes xAI signed, so the body
   * is kept as a string and only parsed after it has been authenticated.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/healthz", async () => ({
    status: "ok",
    activeCalls: manager.activeCount,
    agent: config.agent.name,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.post("/webhooks/xai", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";

    if (env.XAI_WEBHOOK_SECRET) {
      const result = verifyWebhookSignature({
        payload: rawBody,
        headers: request.headers,
        secret: env.XAI_WEBHOOK_SECRET,
        toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
      });
      if (!result.ok) {
        request.log.warn({ reason: result.reason }, "rejected an unverified webhook");
        return reply.code(401).send({ error: "invalid signature" });
      }
    } else {
      request.log.warn("accepting an unsigned webhook (ALLOW_UNSIGNED_WEBHOOKS is on)");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return reply.code(400).send({ error: "body is not valid JSON" });
    }

    const envelope = webhookEventSchema.safeParse(payload);
    if (!envelope.success) {
      return reply.code(400).send({ error: "unrecognised event envelope" });
    }

    if (envelope.data.type !== "realtime.call.incoming") {
      request.log.info({ type: envelope.data.type }, "ignoring unhandled event type");
      return reply.code(200).send({ ignored: true });
    }

    const event = callIncomingEventSchema.safeParse(payload);
    if (!event.success) {
      request.log.warn({ issues: event.error.issues }, "malformed realtime.call.incoming event");
      return reply.code(400).send({ error: "malformed realtime.call.incoming payload" });
    }

    const callId = event.data.data.call_id;
    const caller = callerContextFromEvent(event.data);

    if (isBlocked(config, caller.from)) {
      request.log.info({ callId, from: caller.from }, "hanging up on a blocklisted caller");
      void xai.hangupCall(callId).catch((error: unknown) => {
        request.log.error({ err: error, callId }, "failed to hang up on blocked caller");
      });
      return reply.code(200).send({ accepted: false, reason: "blocked" });
    }

    if (manager.atCapacity) {
      request.log.warn({ callId, active: manager.activeCount }, "at capacity; rejecting call");
      void xai.hangupCall(callId).catch(() => {});
      return reply.code(200).send({ accepted: false, reason: "at_capacity" });
    }

    const known = findKnownCaller(config, caller.from);
    if (known) {
      caller.knownAs = known.name;
      if (known.note) caller.note = known.note;
    }

    // Answer the webhook immediately — the caller is listening to ringing while
    // xAI waits on this response — and bridge the call in the background.
    void manager.accept(callId, caller);

    request.log.info({ callId, from: caller.from, known: Boolean(known) }, "accepted call");
    return reply.code(200).send({ accepted: true });
  });

  if (env.DASHBOARD_TOKEN) {
    const expected = Buffer.from(env.DASHBOARD_TOKEN);

    const requireToken = (header: string | undefined): boolean => {
      if (!header?.startsWith("Bearer ")) return false;
      const provided = Buffer.from(header.slice("Bearer ".length));
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    };

    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/calls") && !request.url.startsWith("/messages")) return;
      if (!requireToken(request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    app.get("/calls", async () => ({ calls: await store.recentCalls(20) }));
    app.get("/messages", async () => ({ messages: await store.recentMessages(50) }));
  } else {
    app.log.info("DASHBOARD_TOKEN is unset; /calls and /messages are disabled");
  }

  return { app, manager };
}
