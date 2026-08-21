import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeCall } from "../src/realtime/call.js";
import { parseAgentConfig, type AgentConfig } from "../src/config/agent.js";
import { CallStore } from "../src/storage/calls.js";
import type { XaiClient } from "../src/xai/client.js";
import {
  FakeRealtimeServer,
  MINIMAL_CONFIG_YAML,
  RecordingNotifier,
  silentLogger,
  tempDir,
  testConfig,
} from "./helpers.js";

/**
 * Drives the call bridge end to end against a fake realtime server, so the
 * event ordering, tool round trip, and deferred-hangup behaviour are exercised
 * the same way the real API would exercise them.
 */
describe("RealtimeCall", () => {
  let server: FakeRealtimeServer;
  let url: string;
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let store: CallStore;
  let notifier: RecordingNotifier;
  let xai: { referCall: ReturnType<typeof vi.fn>; hangupCall: ReturnType<typeof vi.fn> };

  const makeCall = (config: AgentConfig = testConfig()) =>
    new RealtimeCall({
      callId: "call_test_1",
      caller: { from: "+15555550100", to: "+15555550199" },
      config,
      xai: xai as unknown as XaiClient,
      store,
      notifier,
      logger: silentLogger,
      realtimeUrl: url,
      apiKey: "xai-test",
    });

  beforeEach(async () => {
    server = new FakeRealtimeServer();
    url = await server.start();
    dir = await tempDir();
    store = new CallStore(dir.path);
    notifier = new RecordingNotifier();
    xai = {
      referCall: vi.fn().mockResolvedValue(undefined),
      hangupCall: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await server.stop();
    await dir.cleanup();
  });

  it("connects with the call_id in the query string", async () => {
    const call = makeCall();
    const finished = call.start();
    await server.waitForConnection();
    await server.waitFor("session.update");
    server.closeSocket();
    await finished;
  });

  it("configures the session with the persona, voice, and tools", async () => {
    const call = makeCall();
    const finished = call.start();

    const update = (await server.waitFor("session.update")) as {
      session: {
        instructions: string;
        voice: string;
        tools: { name: string }[];
        turn_detection: { type: string; idle_timeout_ms?: number };
      };
    };

    expect(update.session.voice).toBe("eve");
    expect(update.session.instructions).toContain("Hi, you've reached Reed's line.");
    expect(update.session.turn_detection.type).toBe("server_vad");
    expect(update.session.turn_detection.idle_timeout_ms).toBe(12_000);
    expect(update.session.tools.map((tool) => tool.name)).toEqual([
      "take_message",
      "get_local_time",
      "end_call",
    ]);

    server.closeSocket();
    await finished;
  });

  it("asks the model to speak first, so the caller is greeted", async () => {
    const call = makeCall();
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "session.updated", session: {} });
    await server.waitFor("response.create");

    server.closeSocket();
    await finished;
  });

  it("executes a tool call and returns the output to the model", async () => {
    const call = makeCall();
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "session.updated", session: {} });
    server.send({ type: "response.created", response: { id: "resp_1" } });
    server.send({
      type: "response.function_call_arguments.done",
      call_id: "call-abc-0",
      name: "take_message",
      arguments: JSON.stringify({
        caller_name: "Dana",
        message: "The roof quote came in at four thousand dollars.",
      }),
    });

    const item = (await server.waitFor("conversation.item.create")) as {
      item: { type: string; call_id: string; output: string };
    };
    expect(item.item.type).toBe("function_call_output");
    expect(item.item.call_id).toBe("call-abc-0");
    expect(JSON.parse(item.item.output)).toMatchObject({ ok: true, saved: true });

    const messages = await store.recentMessages();
    expect(messages[0]).toMatchObject({ callerName: "Dana", callId: "call_test_1" });

    server.closeSocket();
    const record = await finished;
    expect(record.messages).toHaveLength(1);
    expect(record.tools[0]).toMatchObject({ name: "take_message" });
  });

  it("waits for the goodbye to finish before hanging up", async () => {
    const config = parseAgentConfig(`${MINIMAL_CONFIG_YAML}\ncall:\n  hangup_delay_ms: 30\n`);
    const call = makeCall(config);
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "session.updated", session: {} });

    // A response is in flight when the model decides to end the call.
    server.send({ type: "response.created", response: { id: "resp_1" } });
    server.send({
      type: "response.function_call_arguments.done",
      call_id: "call-end-0",
      name: "end_call",
      arguments: JSON.stringify({ reason: "finished" }),
    });
    await server.waitFor("conversation.item.create");

    // While the model is still speaking, the line must stay up.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(xai.hangupCall).not.toHaveBeenCalled();

    // Once the response completes, the hangup fires after the grace period.
    server.send({ type: "response.done", response: { id: "resp_1" } });
    await vi.waitFor(() => expect(xai.hangupCall).toHaveBeenCalledWith("call_test_1"));

    const record = await finished;
    expect(record.outcome).toBe("ended_by_agent");
  });

  it("issues a SIP REFER when the agent transfers the call", async () => {
    const config = parseAgentConfig(
      `${MINIMAL_CONFIG_YAML}\ncall:\n  hangup_delay_ms: 10\ntransfer:\n  enabled: true\n  target: "tel:+15551234567"\n`,
    );
    const call = makeCall(config);
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "session.updated", session: {} });
    server.send({
      type: "response.function_call_arguments.done",
      call_id: "call-xfer-0",
      name: "transfer_call",
      arguments: JSON.stringify({ reason: "urgent" }),
    });

    await vi.waitFor(() =>
      expect(xai.referCall).toHaveBeenCalledWith("call_test_1", "tel:+15551234567"),
    );
    expect(xai.hangupCall).not.toHaveBeenCalled();

    const record = await finished;
    expect(record.outcome).toBe("transferred");
  });

  it("hands the caller back to the agent when a transfer fails", async () => {
    xai.referCall.mockRejectedValue(new Error("REFER rejected"));
    const config = parseAgentConfig(
      `${MINIMAL_CONFIG_YAML}\ncall:\n  hangup_delay_ms: 10\ntransfer:\n  enabled: true\n  target: "tel:+15551234567"\n`,
    );
    const call = makeCall(config);
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "session.updated", session: {} });
    server.send({
      type: "response.function_call_arguments.done",
      call_id: "call-xfer-0",
      name: "transfer_call",
      arguments: JSON.stringify({ reason: "urgent" }),
    });

    await vi.waitFor(() => {
      const recovery = server
        .sent("conversation.item.create")
        .find((message) => (message as any).item?.role === "user");
      expect(JSON.stringify(recovery)).toContain("transfer failed");
    });

    server.closeSocket();
    const record = await finished;
    // The caller is still on the line, so this is not a completed transfer.
    expect(record.outcome).toBe("completed");
  });

  it("records both sides of the conversation in the transcript", async () => {
    const call = makeCall();
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "session.updated", session: {} });
    server.send({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hi, this is Dana.",
    });
    server.send({
      type: "response.output_audio_transcript.done",
      transcript: "Hi Dana, how can I help?",
    });
    server.send({ type: "input_audio_buffer.dtmf_event_received", event: "5" });

    server.closeSocket();
    const record = await finished;

    expect(record.transcript.map((entry) => [entry.role, entry.text])).toEqual([
      ["caller", "Hi, this is Dana."],
      ["agent", "Hi Dana, how can I help?"],
      ["system", "caller pressed 5"],
    ]);
  });

  it("ignores keepalives and streaming deltas without logging errors", async () => {
    const call = makeCall();
    const finished = call.start();

    await server.waitFor("session.update");
    server.send({ type: "ping", event_id: "1" });
    server.send({ type: "response.output_audio.delta", delta: "AAAA" });
    server.send({ type: "response.output_audio_transcript.delta", delta: "Hi" });

    server.closeSocket();
    const record = await finished;
    expect(record.transcript).toHaveLength(0);
  });

  it("survives a malformed frame", async () => {
    const call = makeCall();
    const finished = call.start();
    await server.waitFor("session.update");
    server.send("not json" as unknown as Record<string, unknown>);
    server.send({ type: "session.updated", session: {} });
    await server.waitFor("response.create");
    server.closeSocket();
    await finished;
  });

  it("persists the call record and notifies when the call ends", async () => {
    const call = makeCall();
    const finished = call.start();
    await server.waitFor("session.update");
    server.closeSocket();

    const record = await finished;
    expect(record.callId).toBe("call_test_1");
    expect(record.caller.from).toBe("+15555550100");
    expect(await store.recentCalls()).toHaveLength(1);
    await vi.waitFor(() => expect(notifier.sent.some((n) => n.kind === "call.ended")).toBe(true));
  });

  it("hangs up a call that runs past its duration limit", async () => {
    const config = parseAgentConfig(
      `${MINIMAL_CONFIG_YAML}\ncall:\n  max_seconds: 30\n  hangup_delay_ms: 0\n`,
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const call = makeCall(config);
      const finished = call.start();
      await server.waitFor("session.update");

      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(xai.hangupCall).toHaveBeenCalled());

      const record = await finished;
      expect(record.outcome).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hangs up live calls when aborted during shutdown", async () => {
    const call = makeCall();
    const finished = call.start();
    await server.waitFor("session.update");

    await call.abort("server shutting down");
    const record = await finished;

    expect(xai.hangupCall).toHaveBeenCalledWith("call_test_1");
    expect(record.outcome).toBe("failed");
    expect(record.error).toBe("server shutting down");
  });
});
