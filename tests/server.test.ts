import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { parseAgentConfig } from "../src/config/agent.js";
import { CallManager } from "../src/realtime/manager.js";
import { connectWithWs } from "../src/realtime/node-socket.js";
import { buildServer } from "../src/server.js";
import { FileCallStore } from "../src/storage/file.js";
import type { XaiClient } from "../src/xai/client.js";
import {
  MINIMAL_CONFIG_YAML,
  RecordingNotifier,
  TEST_SECRET,
  callIncomingBody,
  signedHeaders,
  tempDir,
  testConfig,
  testEnv,
} from "./helpers.js";

describe("webhook server", () => {
  let app: FastifyInstance;
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let store: FileCallStore;
  let accept: ReturnType<typeof vi.fn>;
  let hangupCall: ReturnType<typeof vi.fn>;
  let manager: CallManager;

  const build = async (overrides: Partial<Parameters<typeof buildServer>[0]> = {}) => {
    accept = vi.fn().mockResolvedValue(undefined);
    hangupCall = vi.fn().mockResolvedValue(undefined);

    manager = {
      accept,
      atCapacity: false,
      activeCount: 0,
      shutdown: vi.fn(),
    } as unknown as CallManager;

    const built = await buildServer({
      env: testEnv(),
      config: testConfig(),
      xai: { hangupCall } as unknown as XaiClient,
      store,
      notifier: new RecordingNotifier(),
      manager,
      ...overrides,
    });
    app = built.app;
    await app.ready();
    return built;
  };

  beforeEach(async () => {
    dir = await tempDir();
    store = new FileCallStore(dir.path);
  });

  afterEach(async () => {
    await app?.close();
    await dir.cleanup();
  });

  describe("GET /healthz", () => {
    it("reports readiness without authentication", async () => {
      await build();
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ok", agent: "Ada" });
    });
  });

  describe("POST /webhooks/xai", () => {
    it("accepts a correctly signed incoming call and bridges it", async () => {
      await build();
      const body = callIncomingBody({ callId: "call_1", from: "+15555559999" });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: true });
      expect(accept).toHaveBeenCalledWith("call_1", { from: "+15555559999", to: "+15555550199" });
    });

    it("rejects a forged signature", async () => {
      await build();
      const body = callIncomingBody();
      const headers = await signedHeaders(body, { secret: "whsec_b3RoZXItc2VjcmV0LXZhbHVl" });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers,
        payload: body,
      });

      expect(response.statusCode).toBe(401);
      expect(accept).not.toHaveBeenCalled();
    });

    it("rejects a body altered after signing", async () => {
      await build();
      const body = callIncomingBody({ callId: "call_1" });
      const headers = await signedHeaders(body);

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers,
        payload: body.replace("call_1", "call_2"),
      });

      expect(response.statusCode).toBe(401);
      expect(accept).not.toHaveBeenCalled();
    });

    it("rejects a request with no signature headers at all", async () => {
      await build();
      const body = callIncomingBody();
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: { "content-type": "application/json" },
        payload: body,
      });
      expect(response.statusCode).toBe(401);
    });

    it("accepts unsigned requests when explicitly allowed for local development", async () => {
      await build({
        env: testEnv({ XAI_WEBHOOK_SECRET: undefined, ALLOW_UNSIGNED_WEBHOOKS: true }),
      });
      const body = callIncomingBody({ callId: "call_1" });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: { "content-type": "application/json" },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(accept).toHaveBeenCalled();
    });

    it("ignores event types it does not handle", async () => {
      await build();
      const body = JSON.stringify({ object: "event", type: "realtime.call.completed", data: {} });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ignored: true });
      expect(accept).not.toHaveBeenCalled();
    });

    it("rejects a signed body that is not valid JSON", async () => {
      await build();
      const body = "not json at all";
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a call event with no call_id", async () => {
      await build();
      const body = JSON.stringify({ type: "realtime.call.incoming", data: {} });
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(accept).not.toHaveBeenCalled();
    });

    it("hangs up on a blocklisted caller without starting a session", async () => {
      const config = parseAgentConfig(`${MINIMAL_CONFIG_YAML}\nblocklist:\n  - "+15555550111"\n`);
      await build({ config });
      const body = callIncomingBody({ callId: "call_1", from: "+15555550111" });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });

      expect(response.json()).toEqual({ accepted: false, reason: "blocked" });
      expect(accept).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(hangupCall).toHaveBeenCalledWith("call_1"));
    });

    it("attaches known-caller details so the agent can greet them by name", async () => {
      const config = parseAgentConfig(`
${MINIMAL_CONFIG_YAML}
known_callers:
  - number: "+15555550100"
    name: Dana
    note: Reed's sister
`);
      await build({ config });
      const body = callIncomingBody({ callId: "call_1", from: "+15555550100" });

      await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });

      expect(accept).toHaveBeenCalledWith("call_1", {
        from: "+15555550100",
        to: "+15555550199",
        knownAs: "Dana",
        note: "Reed's sister",
      });
    });

    it("hangs up rather than queueing when at capacity", async () => {
      await build();
      Object.defineProperty(manager, "atCapacity", { get: () => true });

      const body = callIncomingBody({ callId: "call_1" });
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/xai",
        headers: await signedHeaders(body),
        payload: body,
      });

      expect(response.json()).toEqual({ accepted: false, reason: "at_capacity" });
      expect(accept).not.toHaveBeenCalled();
    });
  });

  describe("read-only endpoints", () => {
    it("are not registered when no dashboard token is configured", async () => {
      await build();
      expect((await app.inject({ method: "GET", url: "/calls" })).statusCode).toBe(404);
    });

    it("reject requests without the token", async () => {
      await build({ env: testEnv({ DASHBOARD_TOKEN: "a".repeat(32) }) });
      expect((await app.inject({ method: "GET", url: "/calls" })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/messages",
            headers: { authorization: "Bearer wrong-token-entirely-here" },
          })
        ).statusCode,
      ).toBe(401);
    });

    it("return stored calls and messages with the right token", async () => {
      const token = "a".repeat(32);
      await build({ env: testEnv({ DASHBOARD_TOKEN: token }) });

      await store.recordMessage({
        id: "m1",
        callId: "call_1",
        at: new Date().toISOString(),
        callerName: "Dana",
        message: "Call me back",
        urgency: "routine",
      });

      const response = await app.inject({
        method: "GET",
        url: "/messages",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().messages[0]).toMatchObject({ callerName: "Dana" });
    });
  });
});

describe("CallManager", () => {
  it("reports capacity based on the configured limit", () => {
    const manager = new CallManager({
      config: testConfig(),
      xai: {} as XaiClient,
      store: new FileCallStore("data"),
      notifier: new RecordingNotifier(),
      logger: { child: () => ({}) } as never,
      apiKey: "k",
      maxConcurrentCalls: 1,
      connect: connectWithWs,
    });
    expect(manager.activeCount).toBe(0);
    expect(manager.atCapacity).toBe(false);
  });
});

describe("signature helper self-check", () => {
  it("produces headers this server accepts", async () => {
    const body = callIncomingBody();
    const headers = await signedHeaders(body, { secret: TEST_SECRET });
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
  });
});
