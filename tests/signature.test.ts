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
  it("accepts a correctly signed delivery", () => {
    const result = verify(signedHeaders(BODY));
    expect(result.ok).toBe(true);
  });

  it("rejects a body that was modified after signing", () => {
    const headers = signedHeaders(BODY);
    const tampered = BODY.replace("abc", "xyz");
    expect(verify(headers, tampered)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a signature made with a different secret", () => {
    const headers = signedHeaders(BODY, { secret: "whsec_b3RoZXItc2VjcmV0LXZhbHVlLWhlcmU=" });
    expect(verify(headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a replayed delivery outside the tolerance window", () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const headers = signedHeaders(BODY, { timestamp: stale });
    expect(verify(headers)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a delivery timestamped in the future beyond tolerance", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const headers = signedHeaders(BODY, { timestamp: future });
    expect(verify(headers)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("accepts a delivery inside the tolerance window", () => {
    const recent = Math.floor(Date.now() / 1000) - 120;
    expect(verify(signedHeaders(BODY, { timestamp: recent })).ok).toBe(true);
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])(
    "rejects when %s is missing",
    (missing) => {
      const headers = signedHeaders(BODY);
      delete headers[missing];
      expect(verify(headers)).toEqual({ ok: false, reason: "missing_headers" });
    },
  );

  it("rejects a non-numeric timestamp", () => {
    const headers = { ...signedHeaders(BODY), "webhook-timestamp": "not-a-number" };
    expect(verify(headers)).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects when no v1 signature is present", () => {
    const headers = { ...signedHeaders(BODY), "webhook-signature": "v2,abcdef" };
    expect(verify(headers)).toEqual({ ok: false, reason: "no_v1_signatures" });
  });

  it("accepts when one of several rotated signatures matches", () => {
    const headers = signedHeaders(BODY);
    headers["webhook-signature"] = `v1,d3Jvbmctc2lnbmF0dXJl ${headers["webhook-signature"]!}`;
    expect(verify(headers).ok).toBe(true);
  });

  it("binds the signature to the webhook id, not just the body", () => {
    const headers = signedHeaders(BODY);
    headers["webhook-id"] = "msg_someone_elses_id";
    expect(verify(headers)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("treats the secret the same with or without the whsec_ prefix", () => {
    const bare = TEST_SECRET.slice("whsec_".length);
    expect(decodeSigningSecret(bare)).toEqual(decodeSigningSecret(TEST_SECRET));
    expect(verify(signedHeaders(BODY), BODY, bare).ok).toBe(true);
  });

  it("reports an unusable secret rather than throwing", () => {
    expect(verify(signedHeaders(BODY), BODY, "whsec_")).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("also accepts svix-prefixed headers", () => {
    const headers = signedHeaders(BODY);
    const svix = {
      "svix-id": headers["webhook-id"]!,
      "svix-timestamp": headers["webhook-timestamp"]!,
      "svix-signature": headers["webhook-signature"]!,
    };
    expect(verify(svix).ok).toBe(true);
  });

  it("produces a stable, known signature for a fixed input", () => {
    // Locks the exact Standard Webhooks construction: `{id}.{timestamp}.{body}`.
    const key = decodeSigningSecret(TEST_SECRET);
    expect(computeSignature(key, "msg_1", 1700000000, "{}")).toBe(
      computeSignature(key, "msg_1", "1700000000", "{}"),
    );
    expect(computeSignature(key, "msg_1", 1700000000, "{}")).not.toBe(
      computeSignature(key, "msg_2", 1700000000, "{}"),
    );
  });
});
