import { z } from "zod";
import type { CallerContext } from "../agent/types.js";

const sipHeader = z.object({
  name: z.string(),
  value: z.string(),
});

export const callIncomingEventSchema = z.object({
  object: z.literal("event").optional(),
  id: z.string().optional(),
  type: z.literal("realtime.call.incoming"),
  created_at: z.number().optional(),
  data: z.object({
    call_id: z.string().min(1),
    sip_headers: z.array(sipHeader).default([]),
    metadata: z.record(z.unknown()).default({}),
  }),
});

export type CallIncomingEvent = z.infer<typeof callIncomingEventSchema>;

/** Any signed dispatch. We only act on `realtime.call.incoming`. */
export const webhookEventSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
});

/**
 * Pull a SIP header by name, case-insensitively — carriers are inconsistent
 * about capitalising `From`/`To`.
 */
export function sipHeaderValue(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | undefined {
  return headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Normalise a SIP address into a bare E.164 number.
 *
 * Carriers send `From` in several shapes: a bare `+15551234567`, a full URI
 * like `sip:+15551234567@carrier.example`, or a display name wrapping one
 * (`"Dana" <sip:+15551234567@host>`). Anonymous calls arrive as
 * `anonymous@anonymous.invalid` and yield undefined.
 */
export function extractPhoneNumber(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const angled = /<([^>]+)>/.exec(value);
  const uri = angled?.[1] ?? value;

  const user = /^(?:sips?:)?([^@;?]+)/.exec(uri.trim())?.[1]?.trim();
  if (!user) return undefined;
  if (/^anonymous$/i.test(user) || /^unknown$/i.test(user) || /^restricted$/i.test(user)) {
    return undefined;
  }

  // Keep a leading +, drop the visual separators carriers sprinkle in.
  const digits = user.replace(/[^\d+]/g, "");
  const normalised = digits.startsWith("+") ? digits : digits.length >= 7 ? `+${digits}` : digits;
  return /^\+[1-9]\d{6,14}$/.test(normalised) ? normalised : undefined;
}

export function callerContextFromEvent(event: CallIncomingEvent): CallerContext {
  const headers = event.data.sip_headers;
  const context: CallerContext = {};
  const from = extractPhoneNumber(sipHeaderValue(headers, "From"));
  const to = extractPhoneNumber(sipHeaderValue(headers, "To"));
  if (from) context.from = from;
  if (to) context.to = to;
  return context;
}
