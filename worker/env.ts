import { parseAgentConfig, type AgentConfig } from "../src/config/agent.js";
import type { Logger } from "../src/logger.js";
// Bundled at build time by the wrangler Text rule, so a fresh deploy always has
// a valid config even before anything is written to KV.
import defaultAgentYaml from "../agent.example.yaml";

export interface WorkerEnv {
  /** xAI API key. Set with `wrangler secret put XAI_API_KEY`. */
  XAI_API_KEY: string;
  /** `dispatch_signing_secret` for the phone number's webhook. */
  XAI_WEBHOOK_SECRET?: string;
  /** Bearer token guarding /calls, /messages and /selftest. */
  DASHBOARD_TOKEN?: string;
  /** Optional outbound notification hook for taken messages. */
  NOTIFY_WEBHOOK_URL?: string;
  XAI_API_BASE?: string;
  LOG_LEVEL?: string;
  /** Set to "true" to accept unsigned webhooks. Development only. */
  ALLOW_UNSIGNED_WEBHOOKS?: string;

  VOICE_KV: KVNamespace;
  CALL_SESSION: DurableObjectNamespace;
}

export const AGENT_CONFIG_KEY = "agent.yaml";

/**
 * Loads the agent config from KV, falling back to the bundled example.
 *
 * Keeping it in KV means the persona, greeting, knowledge and blocklist can be
 * changed from the Cloudflare dashboard without a redeploy — which matters when
 * the person tuning the agent does not have a terminal.
 */
export async function loadWorkerAgentConfig(env: WorkerEnv, logger: Logger): Promise<AgentConfig> {
  const stored = await env.VOICE_KV.get(AGENT_CONFIG_KEY, "text");
  if (stored) {
    try {
      return parseAgentConfig(stored);
    } catch (error) {
      // A broken edit in the dashboard must not take the phone line down.
      logger.error({ err: error }, "stored agent config is invalid; using the bundled default");
    }
  }
  return parseAgentConfig(defaultAgentYaml);
}

/** Structured JSON logging; `wrangler tail` renders these nicely. */
export function createWorkerLogger(bindings: Record<string, unknown> = {}): Logger {
  const emit = (level: string, objOrMsg: object | string, msg?: string) => {
    const payload =
      typeof objOrMsg === "string" ? { msg: objOrMsg } : { ...objOrMsg, ...(msg ? { msg } : {}) };
    const line = JSON.stringify({ level, ...bindings, ...payload });
    if (level === "error" || level === "fatal") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    fatal: (o: object | string, m?: string) => emit("fatal", o, m),
    error: (o: object | string, m?: string) => emit("error", o, m),
    warn: (o: object | string, m?: string) => emit("warn", o, m),
    info: (o: object | string, m?: string) => emit("info", o, m),
    debug: (o: object | string, m?: string) => emit("debug", o, m),
    child: (extra: Record<string, unknown>) => createWorkerLogger({ ...bindings, ...extra }),
  };
}

/** Constant-time bearer-token check for the read-only endpoints. */
export function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const provided = new TextEncoder().encode(header.slice("Bearer ".length));
  const expected = new TextEncoder().encode(token);
  if (provided.length !== expected.length) return false;

  let difference = 0;
  for (let i = 0; i < expected.length; i += 1)
    difference |= (provided[i] ?? 0) ^ (expected[i] ?? 0);
  return difference === 0;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
