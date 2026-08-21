import { describe, expect, it, vi } from "vitest";
import { XaiApiError, XaiClient } from "../src/xai/client.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof next === "function" ? next() : next!;
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const client = (fetchImpl: typeof globalThis.fetch, maxRetries = 2) =>
  new XaiClient({
    apiKey: "xai-test",
    baseUrl: "https://api.example.test",
    fetch: fetchImpl,
    maxRetries,
  });

describe("XaiClient", () => {
  it("sends the API key as a bearer token", async () => {
    const { fetchImpl, calls } = stubFetch([json({ phone_numbers: [] })]);
    await client(fetchImpl).listPhoneNumbers();
    expect(calls[0]?.headers.Authorization).toBe("Bearer xai-test");
  });

  it("returns an empty list when the API responds with an empty object", async () => {
    // The live API returns `{}` rather than `{"phone_numbers": []}` when empty.
    const { fetchImpl } = stubFetch([json({})]);
    await expect(client(fetchImpl).listPhoneNumbers()).resolves.toEqual([]);
  });

  it("unwraps a phone number returned either bare or nested", async () => {
    const bare = stubFetch([json({ phone_number_id: "phone_1", phone_number: "+1555" })]);
    await expect(client(bare.fetchImpl).getPhoneNumber("phone_1")).resolves.toMatchObject({
      phone_number_id: "phone_1",
    });

    const nested = stubFetch([
      json({ phone_number: { phone_number_id: "phone_1", phone_number: "+1555" } }),
    ]);
    await expect(client(nested.fetchImpl).getPhoneNumber("phone_1")).resolves.toMatchObject({
      phone_number_id: "phone_1",
    });
  });

  it("posts a REFER to transfer a call", async () => {
    const { fetchImpl, calls } = stubFetch([json({})]);
    await client(fetchImpl).referCall("call-123", "tel:+15551234567");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/realtime/calls/call-123/refer");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ target_uri: "tel:+15551234567" });
  });

  it("url-encodes call ids", async () => {
    const { fetchImpl, calls } = stubFetch([json({})]);
    await client(fetchImpl).hangupCall("call/with spaces");
    expect(calls[0]?.url).toContain("call%2Fwith%20spaces");
  });

  it("treats a 404 on hangup as success, since the caller may have hung up first", async () => {
    const { fetchImpl } = stubFetch([json({ error: "not found" }, 404)]);
    await expect(client(fetchImpl).hangupCall("call-123")).resolves.toBeUndefined();
  });

  it("still surfaces a 404 on transfer, which is a real failure", async () => {
    const { fetchImpl } = stubFetch([json({ error: "call not found" }, 404)]);
    await expect(client(fetchImpl).referCall("call-123", "tel:+15551234567")).rejects.toThrow(
      XaiApiError,
    );
  });

  it("sends a field_mask naming exactly the fields being updated", async () => {
    const { fetchImpl, calls } = stubFetch([json({ phone_number: {} })]);
    await client(fetchImpl).updatePhoneNumber("phone_1", {
      webhook: { url: "https://example.com/webhooks/xai" },
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      phone_number: { webhook: { url: "https://example.com/webhooks/xai" } },
      field_mask: "webhook",
    });
  });

  it("refuses an update with no fields", async () => {
    const { fetchImpl } = stubFetch([json({})]);
    await expect(client(fetchImpl).updatePhoneNumber("phone_1", {})).rejects.toThrow(
      /at least one field/,
    );
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    const { fetchImpl, calls } = stubFetch([
      json({ error: "boom" }, 500),
      json({ error: "boom" }, 500),
      json({ phone_numbers: [{ phone_number_id: "phone_1" }] }),
    ]);
    await expect(client(fetchImpl).listPhoneNumbers()).resolves.toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("retries a 429", async () => {
    const { fetchImpl, calls } = stubFetch([json({ error: "slow down" }, 429), json({})]);
    await client(fetchImpl).listPhoneNumbers();
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 400, which will never succeed on retry", async () => {
    const { fetchImpl, calls } = stubFetch([json({ error: "name is required" }, 400)]);
    await expect(
      client(fetchImpl).createPhoneNumber({ origin: "byo_trunk", name: "" }),
    ).rejects.toThrow(/name is required/);
    expect(calls).toHaveLength(1);
  });

  it("surfaces the API's own error code and message", async () => {
    const { fetchImpl } = stubFetch([
      json(
        {
          code: "The caller does not have permission to execute the specified operation",
          error: "Provisioning SpaceXAI phone numbers via the API is not supported.",
        },
        403,
      ),
    ]);

    const error = await client(fetchImpl)
      .createPhoneNumber({ origin: "xai_provisioned", name: "test" })
      .catch((e: unknown) => e as XaiApiError);

    expect(error).toBeInstanceOf(XaiApiError);
    expect((error as XaiApiError).status).toBe(403);
    expect((error as XaiApiError).message).toMatch(/not supported/);
    expect((error as XaiApiError).retryable).toBe(false);
  });

  it("retries a network failure before giving up", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNRESET");
      return json({});
    }) as unknown as typeof globalThis.fetch;

    await expect(client(fetchImpl).listPhoneNumbers()).resolves.toEqual([]);
    expect(attempts).toBe(3);
  });

  it("gives up after exhausting retries", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    await expect(client(fetchImpl, 1).listPhoneNumbers()).rejects.toThrow(/ECONNRESET/);
  });

  it("requires an API key", () => {
    expect(() => new XaiClient({ apiKey: "" })).toThrow(/requires an apiKey/);
  });

  it("strips a trailing slash from the base URL", async () => {
    const { fetchImpl, calls } = stubFetch([json({})]);
    await new XaiClient({
      apiKey: "k",
      baseUrl: "https://api.example.test/",
      fetch: fetchImpl,
    }).listPhoneNumbers();
    expect(calls[0]?.url).toBe("https://api.example.test/v2/phone-numbers");
  });
});
