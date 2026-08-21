import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const E164 = /^\+[1-9]\d{6,14}$/;

/** `tel:+15551234567` for PSTN, or `sip:user@host` for a direct SIP endpoint. */
const transferTarget = z
  .string()
  .refine(
    (value) => /^tel:\+[1-9]\d{6,14}$/.test(value) || /^sips?:[^\s@]+@[^\s@]+$/.test(value),
    "transfer.target must look like `tel:+15551234567` or `sip:user@example.com`",
  );

const knowledgeEntry = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

export const agentConfigSchema = z.object({
  agent: z.object({
    /** What the agent calls itself on the phone. */
    name: z.string().min(1),
    /** Built-in voice id from `GET /v1/tts/voices`, or a custom voice id. */
    voice: z.string().min(1).default("eve"),
    model: z
      .enum(["grok-voice-latest", "grok-voice-think-fast-2.0", "grok-voice-think-fast-1.0"])
      .default("grok-voice-latest"),
    /**
     * `high` lets the model think before speaking (better judgement on whether
     * to transfer or hang up); `none` is faster and cheaper.
     */
    reasoning_effort: z.enum(["high", "none"]).default("high"),
    /** Speaking rate. 1.0 is normal; phone audio is often clearer slightly slow. */
    speed: z.number().min(0.7).max(1.5).default(1.0),
    language_hint: z.string().min(2).default("en"),
    /**
     * Transcribe the caller's side of the call so it lands in the saved
     * transcript. Turn off if you would rather not store what callers said.
     */
    transcribe_caller: z.boolean().default(true),
    /** Names/terms the transcriber should be biased toward (max 100). */
    keyterms: z.array(z.string().max(50)).max(100).default([]),
    /** Pronunciation fixes applied before speech, e.g. { "Reloru": "Rell-or-oo" }. */
    pronunciations: z.record(z.string()).default({}),
  }),

  owner: z.object({
    /** Whose phone this is. Used in the persona and in message notifications. */
    name: z.string().min(1),
    /** IANA timezone, e.g. `America/Chicago`. Drives the `get_local_time` tool. */
    timezone: z.string().min(1).default("UTC"),
  }),

  /** Spoken verbatim as the first thing the caller hears. */
  greeting: z.string().min(1),

  persona: z.object({
    /** One paragraph on how the agent should come across. */
    style: z.string().min(1),
    /** Hard behavioural rules, rendered as a numbered list in the system prompt. */
    rules: z.array(z.string().min(1)).default([]),
    /** Things the agent must never do or reveal. */
    guardrails: z.array(z.string().min(1)).default([]),
  }),

  transfer: z
    .object({
      enabled: z.boolean().default(false),
      /** Where a transferred call is sent. Required when `enabled` is true. */
      target: transferTarget.optional(),
      /** Plain-English policy the model uses to decide whether to transfer. */
      policy: z
        .string()
        .default("Transfer only when the caller says the matter is urgent and time-sensitive."),
    })
    .default({ enabled: false })
    .superRefine((value, ctx) => {
      if (value.enabled && !value.target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target"],
          message: "transfer.target is required when transfer.enabled is true",
        });
      }
    }),

  call: z
    .object({
      /** Hard stop for a single call. xAI caps realtime sessions at 30 minutes. */
      max_seconds: z.number().int().min(30).max(1800).default(600),
      /**
       * If the caller says nothing for this long, the agent checks in rather
       * than sitting in dead air. Set to 0 to disable.
       */
      idle_prompt_seconds: z.number().int().min(0).max(120).default(12),
      /**
       * Grace period after the agent's goodbye finishes before the line drops,
       * so the last word is not clipped by SIP playback lag.
       */
      hangup_delay_ms: z.number().int().min(0).max(10_000).default(1200),
      /** Let the agent hang up on obvious robocalls and abusive callers. */
      allow_agent_hangup: z.boolean().default(true),
    })
    .default({}),

  /** Numbers the agent greets by name instead of screening. */
  known_callers: z
    .array(
      z.object({
        number: z.string().regex(E164, "known_callers[].number must be E.164, e.g. +15551234567"),
        name: z.string().min(1),
        note: z.string().optional(),
      }),
    )
    .default([]),

  /** Numbers that are hung up on immediately, before the agent says anything. */
  blocklist: z
    .array(z.string().regex(E164, "blocklist[] entries must be E.164, e.g. +15551234567"))
    .default([]),

  /** Facts the agent can answer from directly, inlined into the system prompt. */
  knowledge: z.array(knowledgeEntry).default([]),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function parseAgentConfig(source: string): AgentConfig {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (cause) {
    throw new Error(`agent config is not valid YAML: ${(cause as Error).message}`, { cause });
  }

  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid agent config:\n${details}`);
  }
  return parsed.data;
}

export async function loadAgentConfig(path: string): Promise<AgentConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(
      `Could not read agent config at "${path}". Copy agent.example.yaml to ${path} to get started.`,
      { cause },
    );
  }
  return parseAgentConfig(source);
}

/** Look up a caller in `known_callers` by E.164 number. */
export function findKnownCaller(
  config: AgentConfig,
  number: string | undefined,
): AgentConfig["known_callers"][number] | undefined {
  if (!number) return undefined;
  return config.known_callers.find((caller) => caller.number === number);
}

export function isBlocked(config: AgentConfig, number: string | undefined): boolean {
  if (!number) return false;
  return config.blocklist.includes(number);
}
