/**
 * Standard Webhooks v1 verification.
 *
 * xAI signs each dispatch with the `dispatch_signing_secret` returned once from
 * `POST /v2/phone-numbers`. The signed payload is `{id}.{timestamp}.{body}`,
 * HMAC-SHA256, base64-encoded, and the header may carry several space-separated
 * `v1,<sig>` values so a secret can be rotated without dropping deliveries.
 *
 * Built on Web Crypto rather than `node:crypto` so the exact same code runs on
 * Node and inside a Cloudflare Worker — signature verification is the last
 * place you want two implementations that could drift apart.
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
const encoder = new TextEncoder();

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

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode a `whsec_`-prefixed base64 secret into raw key bytes. */
export function decodeSigningSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  const base64 = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  const key = base64Decode(base64);
  if (key.length === 0) throw new Error("signing secret decoded to zero bytes");
  return key;
}

/** Compute the base64 `v1` signature for a delivery. Exported for tests and tooling. */
export async function computeSignature(
  keyBytes: Uint8Array,
  id: string,
  timestamp: number | string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${id}.${timestamp}.${payload}`),
  );
  return base64Encode(new Uint8Array(signature));
}

/**
 * Compare two byte strings without an early exit on the first differing byte.
 *
 * Node has `timingSafeEqual`, Workers does not, so this is hand-rolled. The
 * length check is not itself constant time, which matches what `timingSafeEqual`
 * does (it throws outright on a length mismatch) and leaks nothing useful here:
 * the signature length is a fixed property of SHA-256.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

export async function verifyWebhookSignature({
  payload,
  headers,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Date.now,
}: VerifyOptions): Promise<VerifyResult> {
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

  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeSigningSecret(secret);
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

  const expected = base64Decode(await computeSignature(keyBytes, id, rawTimestamp, payload));

  // Compare against every candidate without short-circuiting on the first
  // mismatch, so verification time does not leak which signature matched.
  let matched = false;
  for (const candidate of provided) {
    let actual: Uint8Array;
    try {
      actual = base64Decode(candidate);
    } catch {
      continue;
    }
    if (timingSafeEqualBytes(actual, expected)) matched = true;
  }

  return matched ? { ok: true, id, timestamp } : { ok: false, reason: "signature_mismatch" };
}
