import { describe, expect, it } from "vitest";
import { findKnownCaller, isBlocked, parseAgentConfig } from "../src/config/agent.js";
import { loadEnv } from "../src/config/env.js";
import { MINIMAL_CONFIG_YAML } from "./helpers.js";

describe("parseAgentConfig", () => {
  it("fills in sensible defaults from a minimal file", () => {
    const config = parseAgentConfig(MINIMAL_CONFIG_YAML);
    expect(config.agent.voice).toBe("eve");
    expect(config.agent.model).toBe("grok-voice-latest");
    expect(config.agent.transcribe_caller).toBe(true);
    expect(config.call.max_seconds).toBe(600);
    expect(config.transfer.enabled).toBe(false);
    expect(config.knowledge).toEqual([]);
  });

  it("rejects a config that is missing a greeting", () => {
    expect(() =>
      parseAgentConfig(`
agent: { name: Ada }
owner: { name: Reed }
persona: { style: Warm }
`),
    ).toThrow(/greeting/);
  });

  it("rejects transfers that are enabled without a target", () => {
    expect(() => parseAgentConfig(`${MINIMAL_CONFIG_YAML}\ntransfer:\n  enabled: true\n`)).toThrow(
      /transfer.target is required/,
    );
  });

  it("accepts a tel: transfer target", () => {
    const config = parseAgentConfig(
      `${MINIMAL_CONFIG_YAML}\ntransfer:\n  enabled: true\n  target: "tel:+15551234567"\n`,
    );
    expect(config.transfer.target).toBe("tel:+15551234567");
  });

  it("accepts a sip: transfer target", () => {
    const config = parseAgentConfig(
      `${MINIMAL_CONFIG_YAML}\ntransfer:\n  enabled: true\n  target: "sip:reed@pbx.example.com"\n`,
    );
    expect(config.transfer.target).toBe("sip:reed@pbx.example.com");
  });

  it("rejects a transfer target that is a bare phone number", () => {
    expect(() =>
      parseAgentConfig(
        `${MINIMAL_CONFIG_YAML}\ntransfer:\n  enabled: true\n  target: "+15551234567"\n`,
      ),
    ).toThrow(/transfer.target must look like/);
  });

  it("rejects known_callers numbers that are not E.164", () => {
    expect(() =>
      parseAgentConfig(
        `${MINIMAL_CONFIG_YAML}\nknown_callers:\n  - number: "555-1234"\n    name: Dana\n`,
      ),
    ).toThrow(/E\.164/);
  });

  it("rejects a speed outside the supported range", () => {
    expect(() =>
      parseAgentConfig(`${MINIMAL_CONFIG_YAML.replace("name: Ada", "name: Ada\n  speed: 3.0")}`),
    ).toThrow();
  });

  it("rejects malformed YAML with a helpful message", () => {
    expect(() => parseAgentConfig("agent: [unclosed")).toThrow(/not valid YAML/);
  });

  it("caps max_seconds at the 30 minute realtime session limit", () => {
    expect(() =>
      parseAgentConfig(`${MINIMAL_CONFIG_YAML}\ncall:\n  max_seconds: 5000\n`),
    ).toThrow();
  });
});

describe("caller lookups", () => {
  const config = parseAgentConfig(`
${MINIMAL_CONFIG_YAML}
known_callers:
  - number: "+15555550100"
    name: Dana
    note: Reed's sister
blocklist:
  - "+15555550111"
`);

  it("finds a known caller by number", () => {
    expect(findKnownCaller(config, "+15555550100")?.name).toBe("Dana");
  });

  it("returns undefined for an unknown or withheld number", () => {
    expect(findKnownCaller(config, "+15555559999")).toBeUndefined();
    expect(findKnownCaller(config, undefined)).toBeUndefined();
  });

  it("detects a blocklisted number", () => {
    expect(isBlocked(config, "+15555550111")).toBe(true);
    expect(isBlocked(config, "+15555550100")).toBe(false);
    expect(isBlocked(config, undefined)).toBe(false);
  });
});

describe("loadEnv", () => {
  const base = { XAI_API_KEY: "xai-test", XAI_WEBHOOK_SECRET: "whsec_abc" };

  it("parses a valid environment", () => {
    const env = loadEnv({ ...base });
    expect(env.PORT).toBe(8080);
    expect(env.WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });

  it("requires an API key", () => {
    expect(() => loadEnv({ XAI_WEBHOOK_SECRET: "whsec_abc" })).toThrow(/XAI_API_KEY/);
  });

  it("requires a webhook secret unless unsigned webhooks are explicitly allowed", () => {
    expect(() => loadEnv({ XAI_API_KEY: "xai-test" })).toThrow(/XAI_WEBHOOK_SECRET is required/);
    expect(() =>
      loadEnv({ XAI_API_KEY: "xai-test", ALLOW_UNSIGNED_WEBHOOKS: "true" }),
    ).not.toThrow();
  });

  it("refuses to run unsigned in production", () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: "production",
        ALLOW_UNSIGNED_WEBHOOKS: "true",
      }),
    ).toThrow(/cannot be enabled when NODE_ENV=production/);
  });

  it("rejects a dashboard token short enough to brute force", () => {
    expect(() => loadEnv({ ...base, DASHBOARD_TOKEN: "short" })).toThrow(/at least 16 characters/);
  });
});
