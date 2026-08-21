import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config/agent.js";
import { buildInstructions } from "../src/agent/persona.js";
import { buildSessionUpdate } from "../src/realtime/session.js";

/**
 * The shipped example is the first thing a new user copies. If it drifts out of
 * sync with the schema, setup fails at the least helpful possible moment.
 */
describe("agent.example.yaml", () => {
  it("parses against the current schema", async () => {
    const config = await loadAgentConfig("agent.example.yaml");
    expect(config.agent.name).toBeTruthy();
    expect(config.greeting).toBeTruthy();
    expect(config.owner.timezone).toBeTruthy();
  });

  it("uses a timezone the runtime actually recognises", async () => {
    const config = await loadAgentConfig("agent.example.yaml");
    expect(
      () => new Intl.DateTimeFormat("en-US", { timeZone: config.owner.timezone }),
    ).not.toThrow();
  });

  it("produces a usable session configuration", async () => {
    const config = await loadAgentConfig("agent.example.yaml");
    const update = buildSessionUpdate(config, { from: "+15555550100" });

    expect(update.type).toBe("session.update");
    expect(update.session.voice).toBe(config.agent.voice);
    expect(update.session.tools).toBeInstanceOf(Array);
    expect(
      (update.session.audio as { input: { transcription: { model?: string } } }).input.transcription
        .model,
    ).toBe("grok-transcribe");
  });

  it("builds instructions that stay well inside a sensible prompt budget", async () => {
    const config = await loadAgentConfig("agent.example.yaml");
    const instructions = buildInstructions(config, { from: "+15555550100" });
    expect(instructions.length).toBeGreaterThan(500);
    expect(instructions.length).toBeLessThan(12_000);
  });
});
