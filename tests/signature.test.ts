import { describe, expect, it } from "vitest";
import {
  computeSignature,
  decodeSigningSecret,
  verifyWebhookSignature,
} from "../src/webhooks/signature.js";
import { TEST_SECRET, signedHeaders } from "./helpers.js";

const BODY = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "abc" } });

const verify = (headers: Record<string, string>, payload = BODY, secret = TEST_SECRET) =>
  verifyWebhookSignature({ payload, headers, secret });

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed delivery", async () => {
    expect(await verify(await signedHeaders(BODY))).toMatchObject({ ok: true });
  });

  it("rejects a body that was modified after signing", async () => {
    const headers = await signedHeaders(BODY);
    const tampered = BODY.replace("abc", "xyz");
    expect(await verify(headers, tampered)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a signature made with a different secret", async () => {
    const headers = await signedHeaders(BODY, { secret: "whsec_b3RoZXItc2VjcmV0LXZhbHVlLWhlcmU=" });
    expect(await verify(headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a replayed delivery outside the tolerance window", async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const headers = await signedHeaders(BODY, { timestamp: stale });
    expect(await verify(headers)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a delivery timestamped in the future beyond tolerance", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const headers = await signedHeaders(BODY, { timestamp: future });
    expect(await verify(headers)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("accepts a delivery inside the tolerance window", async () => {
    const recent = Math.floor(Date.now() / 1000) - 120;
    expect(await verify(await signedHeaders(BODY, { timestamp: recent }))).toMatchObject({
      ok: true,
    });
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])(
    "rejects when %s is missing",
    async (missing) => {
      const headers = await signedHeaders(BODY);
      delete headers[missing];
      expect(await verify(headers)).toEqual({ ok: false, reason: "missing_headers" });
    },
  );

  it("rejects a non-numeric timestamp", async () => {
    const headers = { ...(await signedHeaders(BODY)), "webhook-timestamp": "not-a-number" };
    expect(await verify(headers)).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects when no v1 signature is present", async () => {
    const headers = { ...(await signedHeaders(BODY)), "webhook-signature": "v2,abcdef" };
    expect(await verify(headers)).toEqual({ ok: false, reason: "no_v1_signatures" });
  });

  it("accepts when one of several rotated signatures matches", async () => {
    const headers = await signedHeaders(BODY);
    headers["webhook-signature"] = `v1,d3Jvbmctc2lnbmF0dXJl ${headers["webhook-signature"]!}`;
    expect(await verify(headers)).toMatchObject({ ok: true });
  });

  it("binds the signature to the webhook id, not just the body", async () => {
    const headers = await signedHeaders(BODY);
    headers["webhook-id"] = "msg_someone_elses_id";
    expect(await verify(headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("treats the secret the same with or without the whsec_ prefix", async () => {
    const bare = TEST_SECRET.slice("whsec_".length);
    expect(decodeSigningSecret(bare)).toEqual(decodeSigningSecret(TEST_SECRET));
    expect(await verify(await signedHeaders(BODY), BODY, bare)).toMatchObject({ ok: true });
  });

  it("reports an unusable secret rather than throwing", async () => {
    expect(await verify(await signedHeaders(BODY), BODY, "whsec_")).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("also accepts svix-prefixed headers", async () => {
    const headers = await signedHeaders(BODY);
    expect(
      await verify({
        "svix-id": headers["webhook-id"]!,
        "svix-timestamp": headers["webhook-timestamp"]!,
        "svix-signature": headers["webhook-signature"]!,
      }),
    ).toMatchObject({ ok: true });
  });

  it("ignores a malformed candidate signature instead of throwing", async () => {
    const headers = await signedHeaders(BODY);
    headers["webhook-signature"] = `v1,!!!not-base64!!! ${headers["webhook-signature"]!}`;
    expect(await verify(headers)).toMatchObject({ ok: true });
  });

  it("produces a stable signature bound to id, timestamp, and body", async () => {
    // Locks the exact Standard Webhooks construction: `{id}.{timestamp}.{body}`.
    const key = decodeSigningSecret(TEST_SECRET);
    const base = await computeSignature(key, "msg_1", 1700000000, "{}");

    // A numeric and string timestamp must sign identically.
    expect(await computeSignature(key, "msg_1", "1700000000", "{}")).toBe(base);
    // Every other component must change the signature.
    expect(await computeSignature(key, "msg_2", 1700000000, "{}")).not.toBe(base);
    expect(await computeSignature(key, "msg_1", 1700000001, "{}")).not.toBe(base);
    expect(await computeSignature(key, "msg_1", 1700000000, "{ }")).not.toBe(base);
  });

  it("matches the published Standard Webhooks vector", async () => {
    // From the Standard Webhooks reference implementation. Pins our Web Crypto
    // HMAC to the same bytes an independent implementation produces.
    const key = decodeSigningSecret("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
    const signature = await computeSignature(
      key,
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      // The exact bytes matter — dropping the space after the colon changes
      // the signature, which is the whole reason we verify the raw body.
      '{"test": 2432232314}',
    );
    expect(signature).toBe("g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });
});
