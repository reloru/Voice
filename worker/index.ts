import { findKnownCaller, isBlocked } from "../src/config/agent.js";
import { XaiClient } from "../src/xai/client.js";
import {
  callIncomingEventSchema,
  callerContextFromEvent,
  webhookEventSchema,
} from "../src/webhooks/events.js";
import { verifyWebhookSignature } from "../src/webhooks/signature.js";
import {
  AGENT_CONFIG_KEY,
  authorized,
  createWorkerLogger,
  json,
  loadWorkerAgentConfig,
  type WorkerEnv,
} from "./env.js";
import { KvCallStore } from "./kv-store.js";

export { CallSession } from "./call-session.js";

const WEBHOOK_PATH = "/webhooks/xai";
const MAX_BODY_BYTES = 256 * 1024;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const logger = createWorkerLogger();

    if (url.pathname === "/healthz") {
      return json({
        status: "ok",
        runtime: "cloudflare-workers",
        webhookPath: WEBHOOK_PATH,
        signatureVerification: env.XAI_WEBHOOK_SECRET ? "enabled" : "DISABLED",
      });
    }

    if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
      return handleWebhook(request, env, ctx, logger);
    }

    // Everything below exposes transcripts or spends credit, so it is gated.
    if (["/calls", "/messages", "/selftest", "/config"].includes(url.pathname)) {
      if (!authorized(request, env.DASHBOARD_TOKEN)) return json({ error: "unauthorized" }, 401);

      const store = new KvCallStore(env.VOICE_KV);
      switch (url.pathname) {
        case "/calls":
          return json({ calls: await store.recentCalls(20) });
        case "/messages":
          return json({ messages: await store.recentMessages(50) });
        case "/config":
          return handleConfig(request, env, logger);
        case "/selftest": {
          const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName("selftest"));
          return stub.fetch(new Request("https://call-session/selftest"));
        }
      }
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleWebhook(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<Response> {
  // Signature verification runs over the exact bytes xAI signed, so the body is
  // read as text and only parsed once it has been authenticated.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

  if (env.XAI_WEBHOOK_SECRET) {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));

    const result = await verifyWebhookSignature({
      payload: rawBody,
      headers,
      secret: env.XAI_WEBHOOK_SECRET,
    });
    if (!result.ok) {
      logger.warn({ reason: result.reason }, "rejected an unverified webhook");
      return json({ error: "invalid signature" }, 401);
    }
  } else if (env.ALLOW_UNSIGNED_WEBHOOKS !== "true") {
    logger.error("XAI_WEBHOOK_SECRET is not set; refusing the delivery");
    return json({ error: "server is not configured to verify signatures" }, 500);
  } else {
    logger.warn("accepting an unsigned webhook (ALLOW_UNSIGNED_WEBHOOKS is on)");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "body is not valid JSON" }, 400);
  }

  const envelope = webhookEventSchema.safeParse(payload);
  if (!envelope.success) return json({ error: "unrecognised event envelope" }, 400);

  if (envelope.data.type !== "realtime.call.incoming") {
    logger.info({ type: envelope.data.type }, "ignoring unhandled event type");
    return json({ ignored: true });
  }

  const event = callIncomingEventSchema.safeParse(payload);
  if (!event.success) {
    logger.warn({ issues: event.error.issues }, "malformed realtime.call.incoming event");
    return json({ error: "malformed realtime.call.incoming payload" }, 400);
  }

  const callId = event.data.data.call_id;
  const caller = callerContextFromEvent(event.data);
  const config = await loadWorkerAgentConfig(env, logger);

  if (isBlocked(config, caller.from)) {
    logger.info({ callId, from: caller.from }, "hanging up on a blocklisted caller");
    const xai = new XaiClient({
      apiKey: env.XAI_API_KEY,
      ...(env.XAI_API_BASE ? { baseUrl: env.XAI_API_BASE } : {}),
    });
    ctx.waitUntil(
      xai.hangupCall(callId).catch((error: unknown) => {
        logger.error({ err: error, callId }, "failed to hang up on blocked caller");
      }),
    );
    return json({ accepted: false, reason: "blocked" });
  }

  const known = findKnownCaller(config, caller.from);
  if (known) {
    caller.knownAs = known.name;
    if (known.note) caller.note = known.note;
  }

  // Addressing the object by call id makes xAI's webhook retries idempotent.
  const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(callId));

  // Answer immediately — xAI is holding a ringing caller while it waits on this
  // response — and let the call run in the Durable Object behind waitUntil.
  ctx.waitUntil(
    stub
      .fetch(
        new Request("https://call-session/start", {
          method: "POST",
          body: JSON.stringify({ callId, caller }),
          headers: { "content-type": "application/json" },
        }),
      )
      .catch((error: unknown) => {
        logger.error({ err: error, callId }, "call session failed");
      }),
  );

  logger.info({ callId, from: caller.from, known: Boolean(known) }, "accepted call");
  return json({ accepted: true });
}

/**
 * Read or replace the agent config without a redeploy. `PUT` validates before
 * storing, so a malformed edit is rejected here rather than at call time.
 */
async function handleConfig(
  request: Request,
  env: WorkerEnv,
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<Response> {
  if (request.method === "PUT") {
    const body = await request.text();
    try {
      const { parseAgentConfig } = await import("../src/config/agent.js");
      parseAgentConfig(body);
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
    await env.VOICE_KV.put(AGENT_CONFIG_KEY, body);
    logger.info("agent config updated");
    return json({ updated: true });
  }

  const config = await loadWorkerAgentConfig(env, logger);
  const stored = await env.VOICE_KV.get(AGENT_CONFIG_KEY, "text");
  return json({ source: stored ? "kv" : "bundled default", config });
}
