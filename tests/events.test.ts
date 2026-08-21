import { describe, expect, it } from "vitest";
import {
  callIncomingEventSchema,
  callerContextFromEvent,
  extractPhoneNumber,
  sipHeaderValue,
} from "../src/webhooks/events.js";

describe("extractPhoneNumber", () => {
  it.each([
    ["+15551234567", "+15551234567"],
    ["sip:+15551234567@carrier.example.com", "+15551234567"],
    ['"Dana Smith" <sip:+15551234567@carrier.example.com>', "+15551234567"],
    ["<sips:+15551234567@secure.example.com>", "+15551234567"],
    ["sip:+15551234567@carrier.example.com;user=phone", "+15551234567"],
    ["+1 (555) 123-4567", "+15551234567"],
    ["15551234567", "+15551234567"],
  ])("normalises %s", (input, expected) => {
    expect(extractPhoneNumber(input)).toBe(expected);
  });

  it.each([
    ["anonymous@anonymous.invalid"],
    ["sip:anonymous@anonymous.invalid"],
    ["Unknown"],
    ["restricted"],
    ["sip:support@example.com"],
    ["123"],
    [""],
  ])("returns undefined for %s", (input) => {
    expect(extractPhoneNumber(input)).toBeUndefined();
  });

  it("returns undefined when the header is absent", () => {
    expect(extractPhoneNumber(undefined)).toBeUndefined();
  });
});

describe("sipHeaderValue", () => {
  it("matches header names case-insensitively", () => {
    const headers = [{ name: "FROM", value: "+15551234567" }];
    expect(sipHeaderValue(headers, "From")).toBe("+15551234567");
  });

  it("returns undefined for a header that is not present", () => {
    expect(sipHeaderValue([], "From")).toBeUndefined();
  });
});

describe("callIncomingEventSchema", () => {
  it("parses a full event", () => {
    const parsed = callIncomingEventSchema.parse({
      object: "event",
      id: "evt_123",
      type: "realtime.call.incoming",
      created_at: 1750000000,
      data: {
        call_id: "00000000-0000-0000-0000-000000000000",
        sip_headers: [
          { name: "From", value: "+14155550100" },
          { name: "To", value: "+18005550199" },
        ],
        metadata: {},
      },
    });
    expect(parsed.data.call_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("defaults sip_headers and metadata when omitted", () => {
    const parsed = callIncomingEventSchema.parse({
      type: "realtime.call.incoming",
      data: { call_id: "abc" },
    });
    expect(parsed.data.sip_headers).toEqual([]);
    expect(parsed.data.metadata).toEqual({});
  });

  it("rejects an event with no call_id", () => {
    expect(() =>
      callIncomingEventSchema.parse({ type: "realtime.call.incoming", data: {} }),
    ).toThrow();
  });
});

describe("callerContextFromEvent", () => {
  it("pulls From and To out of the SIP headers", () => {
    const context = callerContextFromEvent(
      callIncomingEventSchema.parse({
        type: "realtime.call.incoming",
        data: {
          call_id: "abc",
          sip_headers: [
            { name: "From", value: '"Dana" <sip:+14155550100@carrier.test>' },
            { name: "To", value: "+18005550199" },
          ],
        },
      }),
    );
    expect(context).toEqual({ from: "+14155550100", to: "+18005550199" });
  });

  it("omits `from` entirely for a withheld caller ID", () => {
    const context = callerContextFromEvent(
      callIncomingEventSchema.parse({
        type: "realtime.call.incoming",
        data: {
          call_id: "abc",
          sip_headers: [{ name: "From", value: "sip:anonymous@anonymous.invalid" }],
        },
      }),
    );
    expect(context.from).toBeUndefined();
  });
});
