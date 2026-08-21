import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined ? defaultValue : /^(1|true|yes|on)$/i.test(value)));

const intWithin = (min: number, max: number, defaultValue: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /** xAI API key. The only credential the agent needs to run a call. */
    XAI_API_KEY: z.string().min(1, "XAI_API_KEY is required"),
    XAI_API_BASE: z.string().url().default("https://api.x.ai"),

    /**
     * `dispatch_signing_secret` from `POST /v2/phone-numbers`, returned exactly
     * once. Without it we cannot prove an inbound webhook really came from xAI.
     */
    XAI_WEBHOOK_SECRET: z.string().optional(),
    /**
     * Reject webhooks whose `webhook-timestamp` is further away than this, so a
     * captured request cannot be replayed later.
     */
    WEBHOOK_TOLERANCE_SECONDS: intWithin(30, 3600, 300),
    /**
     * Escape hatch for local development only. Refused when NODE_ENV=production
     * so a misconfigured deploy fails loudly instead of accepting forged calls.
     */
    ALLOW_UNSIGNED_WEBHOOKS: bool(false),

    HOST: z.string().default("0.0.0.0"),
    PORT: intWithin(1, 65535, 8080),

    AGENT_CONFIG_PATH: z.string().default("agent.yaml"),
    DATA_DIR: z.string().default("data"),

    /** Optional: POST a JSON summary here whenever a call ends or a message is taken. */
    NOTIFY_WEBHOOK_URL: z.string().url().optional(),

    /**
     * Bearer token guarding the read-only /calls and /messages endpoints.
     * Those return transcripts and personal details, so when this is unset the
     * routes are not registered at all.
     */
    DASHBOARD_TOKEN: z
      .string()
      .min(16, "DASHBOARD_TOKEN must be at least 16 characters")
      .optional(),

    /** Cap on simultaneous live calls this process will bridge. */
    MAX_CONCURRENT_CALLS: intWithin(1, 100, 10),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.ALLOW_UNSIGNED_WEBHOOKS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ALLOW_UNSIGNED_WEBHOOKS"],
        message: "ALLOW_UNSIGNED_WEBHOOKS cannot be enabled when NODE_ENV=production",
      });
    }
    if (!env.XAI_WEBHOOK_SECRET && !env.ALLOW_UNSIGNED_WEBHOOKS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["XAI_WEBHOOK_SECRET"],
        message:
          "XAI_WEBHOOK_SECRET is required. Set ALLOW_UNSIGNED_WEBHOOKS=true only for local development.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
