#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadAgentConfig } from "./config/agent.js";
import { loadEnv } from "./config/env.js";
import { computeSignature, decodeSigningSecret } from "./webhooks/signature.js";
import { XaiApiError, XaiClient } from "./xai/client.js";

const USAGE = `
voice-agent — manage the phone numbers and configuration for your voice agent

Usage:
  voice-agent doctor                      Check credentials, config, and wiring
  voice-agent numbers list                List phone numbers on your xAI team
  voice-agent numbers show    --id <id>   Show one phone number
  voice-agent numbers register            Register a number you already own (BYO SIP trunk)
                --number <+E164> --url <https://.../webhooks/xai> --name <name>
                [--sip-user <u> --sip-pass <p>] [--allow-cidr <a.b.c.d/32>]
  voice-agent numbers set-webhook --id <id> --url <https://...>
                                          Point an existing number at a new webhook URL
  voice-agent numbers delete  --id <id>   Remove a phone number
  voice-agent voices                      List the built-in voices you can use
  voice-agent simulate-call               POST a signed fake incoming call at your own server
                [--url http://localhost:8080/webhooks/xai] [--from +15551234567]

Notes:
  xAI-provisioned numbers cannot be created over the API — the API returns 403 and
  points you at the console (Voice Agents). Create the number there, then use
  'numbers set-webhook' to point it at this server. 'numbers register' is for
  numbers you already own on your own SIP trunk.
`.trim();

type Argv = string[];

async function main(argv: Argv): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "doctor":
      return doctor();
    case "voices":
      return voices();
    case "simulate-call":
      return simulateCall(rest);
    case "numbers":
      return numbers(rest);
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
  }
}

function client(): XaiClient {
  const env = loadEnv();
  return new XaiClient({ apiKey: env.XAI_API_KEY, baseUrl: env.XAI_API_BASE });
}

// --- doctor ---------------------------------------------------------------

async function doctor(): Promise<number> {
  let failures = 0;
  const ok = (message: string) => console.log(`  ok    ${message}`);
  const warn = (message: string) => console.log(`  warn  ${message}`);
  const fail = (message: string) => {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  };

  console.log("\nEnvironment");
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
    ok("environment variables parsed");
  } catch (error) {
    fail((error as Error).message);
    console.log("\n1 or more checks failed.\n");
    return 1;
  }

  if (env.XAI_WEBHOOK_SECRET) {
    try {
      decodeSigningSecret(env.XAI_WEBHOOK_SECRET);
      ok("XAI_WEBHOOK_SECRET decodes as a signing key");
    } catch {
      fail("XAI_WEBHOOK_SECRET is set but is not valid base64");
    }
  } else {
    warn("XAI_WEBHOOK_SECRET is unset — inbound webhooks are NOT verified");
  }

  console.log("\nAgent config");
  try {
    const config = await loadAgentConfig(env.AGENT_CONFIG_PATH);
    ok(`${env.AGENT_CONFIG_PATH} is valid`);
    ok(
      `agent "${config.agent.name}" answering for ${config.owner.name} in ${config.owner.timezone}`,
    );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.owner.timezone });
    } catch {
      fail(`owner.timezone "${config.owner.timezone}" is not a valid IANA timezone`);
    }
    if (config.transfer.enabled) ok(`transfers go to ${config.transfer.target}`);
    else warn("transfers are disabled — the agent can only take messages");
  } catch (error) {
    fail((error as Error).message);
  }

  console.log("\nxAI API");
  const api = new XaiClient({ apiKey: env.XAI_API_KEY, baseUrl: env.XAI_API_BASE });
  try {
    const key = await api.verifyApiKey();
    ok(`API key ${key.redacted_api_key} valid (team ${key.team_id})`);
  } catch (error) {
    fail(`API key rejected: ${describe(error)}`);
  }

  try {
    const list = await api.listPhoneNumbers();
    if (list.length === 0) {
      warn("no phone numbers on this team yet — see 'Getting a number' in the README");
    } else {
      for (const number of list) {
        const target = number.webhook_id
          ? `webhook ${number.webhook_id}`
          : number.agent_id
            ? `agent ${number.agent_id}`
            : "NOT ROUTED";
        ok(`${number.phone_number} (${number.origin}) → ${target}`);
        if (!number.webhook_id && !number.agent_id) {
          fail(`${number.phone_number} has no webhook or agent — calls to it go nowhere`);
        }
      }
    }
  } catch (error) {
    fail(`could not list phone numbers: ${describe(error)}`);
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  return failures === 0 ? 0 : 1;
}

async function voices(): Promise<number> {
  const env = loadEnv();
  const response = await fetch(`${env.XAI_API_BASE}/v1/tts/voices`, {
    headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
  });
  if (!response.ok) {
    console.error(`Failed to list voices: HTTP ${response.status}`);
    return 1;
  }
  const body = (await response.json()) as {
    voices: { voice_id: string; name: string; language?: string }[];
  };
  for (const voice of body.voices) {
    console.log(`  ${voice.voice_id.padEnd(12)} ${voice.name} (${voice.language ?? "unknown"})`);
  }
  console.log(`\nSet one as agent.voice in your agent config.\n`);
  return 0;
}

// --- numbers --------------------------------------------------------------

async function numbers(argv: Argv): Promise<number> {
  const [sub, ...rest] = argv;
  const api = client();

  switch (sub) {
    case "list": {
      const list = await api.listPhoneNumbers();
      if (list.length === 0) {
        console.log("No phone numbers registered on this team.");
        return 0;
      }
      for (const number of list) {
        console.log(
          `  ${number.phone_number}  ${number.phone_number_id}  ${number.origin}  ` +
            `${number.webhook_id ?? number.agent_id ?? "unrouted"}  ${number.name}`,
        );
      }
      return 0;
    }

    case "show": {
      const { values } = parseArgs({ args: rest, options: { id: { type: "string" } } });
      if (!values.id) return usageError("numbers show requires --id");
      console.log(JSON.stringify(await api.getPhoneNumber(values.id), null, 2));
      return 0;
    }

    case "register": {
      const { values } = parseArgs({
        args: rest,
        options: {
          number: { type: "string" },
          url: { type: "string" },
          name: { type: "string" },
          "sip-user": { type: "string" },
          "sip-pass": { type: "string" },
          "allow-cidr": { type: "string", multiple: true },
        },
      });
      if (!values.number || !values.url) {
        return usageError("numbers register requires --number and --url");
      }

      const response = await api.createPhoneNumber({
        origin: "byo_trunk",
        name: values.name ?? `voice-agent ${values.number}`,
        phone_number: values.number,
        webhook: { url: values.url, name: values.name ?? "voice-agent" },
        ...(values["sip-user"] && values["sip-pass"]
          ? {
              sip_auth: {
                auth_username: values["sip-user"],
                auth_password: values["sip-pass"],
                ...(values["allow-cidr"]?.length
                  ? { allowed_addresses: values["allow-cidr"] }
                  : {}),
              },
            }
          : values["allow-cidr"]?.length
            ? { sip_auth: { allowed_addresses: values["allow-cidr"] } }
            : {}),
      });

      console.log(`\nRegistered ${response.phone_number.phone_number}`);
      console.log(`  phone_number_id: ${response.phone_number.phone_number_id}`);
      console.log(`  sip_host:        ${response.phone_number.sip_host ?? "(none)"}`);
      console.log(`  Point your carrier's SIP trunk at that host.`);

      const secret = response.webhook?.dispatch_signing_secret;
      if (secret) {
        console.log(`\n  Add this to your .env — it is shown only once:\n`);
        console.log(`  XAI_WEBHOOK_SECRET=${secret}\n`);
      }
      return 0;
    }

    case "set-webhook": {
      const { values } = parseArgs({
        args: rest,
        options: { id: { type: "string" }, url: { type: "string" }, name: { type: "string" } },
      });
      if (!values.id || !values.url) {
        return usageError("numbers set-webhook requires --id and --url");
      }
      await api.updatePhoneNumber(values.id, {
        webhook: { url: values.url, ...(values.name ? { name: values.name } : {}) },
      });
      console.log(`Updated ${values.id} to dispatch calls to ${values.url}`);
      console.log(
        "If xAI issued a new signing secret, update XAI_WEBHOOK_SECRET to match before the next call.",
      );
      return 0;
    }

    case "delete": {
      const { values } = parseArgs({ args: rest, options: { id: { type: "string" } } });
      if (!values.id) return usageError("numbers delete requires --id");
      await api.deletePhoneNumber(values.id);
      console.log(`Deleted ${values.id}`);
      return 0;
    }

    default:
      return usageError(`Unknown 'numbers' subcommand: ${sub ?? "(none)"}`);
  }
}

// --- simulate-call --------------------------------------------------------

/**
 * Sends a correctly signed `realtime.call.incoming` at your own server so the
 * webhook path can be exercised without placing a real call. The call_id is
 * fake, so the server will accept it and then fail to open a realtime session —
 * that is expected, and enough to prove signature checks and routing work.
 */
async function simulateCall(argv: Argv): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      secret: { type: "string" },
    },
  });

  const env = loadEnv();
  const url = values.url ?? `http://localhost:${env.PORT}/webhooks/xai`;
  const secret = values.secret ?? env.XAI_WEBHOOK_SECRET;

  const body = JSON.stringify({
    object: "event",
    id: `evt_${randomUUID()}`,
    type: "realtime.call.incoming",
    created_at: Math.floor(Date.now() / 1000),
    data: {
      call_id: randomUUID(),
      sip_headers: [
        { name: "From", value: values.from ?? "+15555550100" },
        { name: "To", value: values.to ?? "+15555550199" },
      ],
      metadata: { simulated: true },
    },
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    const id = `msg_${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    headers["webhook-id"] = id;
    headers["webhook-timestamp"] = String(timestamp);
    const signature = await computeSignature(decodeSigningSecret(secret), id, timestamp, body);
    headers["webhook-signature"] = `v1,${signature}`;
  } else {
    console.log("No signing secret available — sending unsigned.");
  }

  const response = await fetch(url, { method: "POST", headers, body });
  console.log(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.ok ? 0 : 1;
}

// --- helpers --------------------------------------------------------------

function usageError(message: string): number {
  console.error(`${message}\n`);
  console.error(USAGE);
  return 1;
}

function describe(error: unknown): string {
  if (error instanceof XaiApiError) return `HTTP ${error.status} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(describe(error));
    process.exit(1);
  });
