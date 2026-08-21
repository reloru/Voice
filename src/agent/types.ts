/** What we know about the person on the other end when the call connects. */
export interface CallerContext {
  /** Caller's number in E.164, from the SIP `From` header. Undefined if withheld. */
  from?: string;
  /** The number they dialled, from the SIP `To` header. */
  to?: string;
  /** Name from `known_callers` when the caller ID matched. */
  knownAs?: string;
  /** Free-text note from `known_callers`. */
  note?: string;
}

export type TranscriptRole = "caller" | "agent" | "system";

export interface TranscriptEntry {
  at: string;
  role: TranscriptRole;
  text: string;
}

export interface ToolInvocation {
  at: string;
  name: string;
  arguments: unknown;
  result: unknown;
}

export interface TakenMessage {
  id: string;
  callId: string;
  at: string;
  callerName: string;
  callbackNumber?: string;
  message: string;
  urgency: "routine" | "urgent";
}

export type CallOutcome =
  "completed" | "transferred" | "ended_by_agent" | "blocked" | "timed_out" | "failed";

export interface CallRecord {
  callId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  outcome: CallOutcome;
  caller: CallerContext;
  transcript: TranscriptEntry[];
  tools: ToolInvocation[];
  messages: TakenMessage[];
  error?: string;
}
