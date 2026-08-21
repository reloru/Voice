import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks v1 verification.
 *
 * xAI signs each dispatch with the `dispatch_signing_secret` returned once from
 * `POST /v2/phone-numbers`. The signed payload is `{id}.{timestamp}.{body}`,
 * HMAC-SHA256, base64-encoded, and the header may carry several space-separated
 * `v1,<sig>` values so a secret can be rotated without dropping deliveries.
 *
 * @see https://www.standardwebhooks.com/
 */

export interface VerifyOptions {
  /** Raw request body **exactly** as received. Re-serialising JSON breaks the signature. */
  payload: string;
  headers: Record<string, string | string[] | undefined>;
  /** `whsec_...` secret. The prefix is optional. */
  secret: string;
  /** Max clock skew, in seconds, before a delivery is rejected as a replay. */
  toleranceSeconds?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
}

export type VerifyResult =
  { ok: true; id: string; timestamp: number } | { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "no_v1_signatures"
  | "signature_mismatch"
  | "invalid_secret";

const DEFAULT_TOLERANCE_SECONDS = 300;

function header(
  headers: VerifyOptions["headers"],
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    const resolved = Array.isArray(value) ? value[0] : value;
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  }
  return undefined;
}

/** Decode a `whsec_`-prefixed base64 secret into raw key bytes. */
export function decodeSigningSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  const base64 = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  const key = Buffer.from(base64, "base64");
  if (key.length === 0) throw new Error("signing secret decoded to zero bytes");
  return key;
}

/** Compute the base64 `v1` signature for a delivery. Exported for tests and tooling. */
export function computeSignature(
  key: Buffer,
  id: string,
  timestamp: number | string,
  payload: string,
): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`, "utf8").digest("base64");
}

export function verifyWebhookSignature({
  payload,
  headers,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Date.now,
}: VerifyOptions): VerifyResult {
  const id = header(headers, "webhook-id", "svix-id");
  const rawTimestamp = header(headers, "webhook-timestamp", "svix-timestamp");
  const signatureHeader = header(headers, "webhook-signature", "svix-signature");

  if (!id || !rawTimestamp || !signatureHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  const timestamp = Number(rawTimestamp);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const skewSeconds = Math.abs(Math.floor(now() / 1000) - timestamp);
  if (skewSeconds > toleranceSeconds) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  let key: Buffer;
  try {
    key = decodeSigningSecret(secret);
  } catch {
    return { ok: false, reason: "invalid_secret" };
  }

  // The header carries `v1,<sig>` entries; ignore versions we do not implement.
  const provided = signatureHeader
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice("v1,".length));

  if (provided.length === 0) return { ok: false, reason: "no_v1_signatures" };

  const expected = Buffer.from(computeSignature(key, id, rawTimestamp, payload), "base64");

  // Compare against every candidate without short-circuiting on the first
  // mismatch, so verification time does not leak which signature matched.
  let matched = false;
  for (const candidate of provided) {
    const actual = Buffer.from(candidate, "base64");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      matched = true;
    }
  }

  return matched ? { ok: true, id, timestamp } : { ok: false, reason: "signature_mismatch" };
}
