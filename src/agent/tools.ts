import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentConfig } from "../config/agent.js";
import type { Logger } from "../logger.js";
import type { Notifier } from "../notify.js";
import type { CallStore } from "../storage/store.js";
import type { CallerContext, TakenMessage } from "./types.js";

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Side effects a tool can ask the call loop to perform. Tools never hang up or
 * transfer directly: the agent is usually mid-sentence ("let me put you
 * through") when it calls one, and dropping the line right then clips the
 * audio. The loop defers these until the current response has finished
 * speaking.
 */
export interface CallActions {
  requestHangup(reason: string): void;
  requestTransfer(targetUri: string, reason: string): void;
}

export interface ToolContext extends CallActions {
  callId: string;
  config: AgentConfig;
  caller: CallerContext;
  store: CallStore;
  notifier: Notifier;
  logger: Logger;
  onMessageTaken(message: TakenMessage): void;
}

export function buildToolDefinitions(config: AgentConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      name: "take_message",
      description:
        `Record a message for ${config.owner.name}. Call this whenever the caller leaves ` +
        "information, asks for a call back, or explains why they rang. Call it before ending the call.",
      parameters: {
        type: "object",
        properties: {
          caller_name: {
            type: "string",
            description: "The caller's name. Use 'Unknown' only if they refused to give it.",
          },
          message: {
            type: "string",
            description:
              "What the caller wants, in their own words where possible. Include any detail " +
              `${config.owner.name} needs to act on it.`,
          },
          callback_number: {
            type: "string",
            description: "The number to call back, if the caller gave one. Omit if they did not.",
          },
          urgency: {
            type: "string",
            enum: ["routine", "urgent"],
            description: "Use 'urgent' only if the caller said it is time-sensitive.",
          },
        },
        required: ["caller_name", "message"],
      },
    },
    {
      type: "function",
      name: "get_local_time",
      description:
        `Get the current date and time in ${config.owner.name}'s timezone. Use this instead of ` +
        "guessing the time, and before saying anything about today, tomorrow, or business hours.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  ];

  if (config.transfer.enabled) {
    tools.push({
      type: "function",
      name: "transfer_call",
      description:
        `Transfer the caller to ${config.owner.name}. Policy: ${config.transfer.policy} ` +
        "Tell the caller you are putting them through before calling this.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why this call warrants a transfer under the policy.",
          },
        },
        required: ["reason"],
      },
    });
  }

  if (config.call.allow_agent_hangup) {
    tools.push({
      type: "function",
      name: "end_call",
      description:
        "End the call. Say goodbye first for a normal call. Use immediately, without a goodbye, " +
        "for a recorded robocall, a line with no human on it, or an abusive caller.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["finished", "robocall", "no_human", "abusive", "caller_requested"],
            description: "Why the call is ending.",
          },
        },
        required: ["reason"],
      },
    });
  }

  return tools;
}

const takeMessageArgs = z.object({
  caller_name: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  callback_number: z.string().max(50).optional(),
  urgency: z.enum(["routine", "urgent"]).default("routine"),
});

const transferArgs = z.object({ reason: z.string().max(500).default("caller requested") });

const endCallArgs = z.object({
  reason: z
    .enum(["finished", "robocall", "no_human", "abusive", "caller_requested"])
    .default("finished"),
});

export interface ToolResult {
  output: unknown;
  /** Whether the model should immediately speak again after this tool. */
  speakAfter: boolean;
}

/**
 * Runs one tool call. Never throws: a rejected promise here would strand the
 * model waiting for output it will never get, so failures come back as a
 * structured `{ ok: false }` the model can speak around.
 */
export async function dispatchTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolResult> {
  let args: unknown;
  try {
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return {
      output: { ok: false, error: "arguments were not valid JSON; call the tool again" },
      speakAfter: true,
    };
  }

  try {
    switch (name) {
      case "take_message":
        return await takeMessage(args, context);
      case "get_local_time":
        return getLocalTime(context);
      case "transfer_call":
        return transferCall(args, context);
      case "end_call":
        return endCall(args, context);
      default:
        context.logger.warn({ tool: name }, "model called an unknown tool");
        return { output: { ok: false, error: `unknown tool "${name}"` }, speakAfter: true };
    }
  } catch (error) {
    context.logger.error({ err: error, tool: name }, "tool execution failed");
    return {
      output: { ok: false, error: "that action failed; apologise briefly and continue" },
      speakAfter: true,
    };
  }
}

async function takeMessage(args: unknown, context: ToolContext): Promise<ToolResult> {
  const parsed = takeMessageArgs.safeParse(args);
  if (!parsed.success) {
    return {
      output: { ok: false, error: "caller_name and message are both required" },
      speakAfter: true,
    };
  }

  const callbackNumber = parsed.data.callback_number?.trim() || context.caller.from;

  const message: TakenMessage = {
    id: randomUUID(),
    callId: context.callId,
    at: new Date().toISOString(),
    callerName: parsed.data.caller_name.trim(),
    ...(callbackNumber ? { callbackNumber } : {}),
    message: parsed.data.message.trim(),
    urgency: parsed.data.urgency,
  };

  await context.store.recordMessage(message);
  context.onMessageTaken(message);
  // Fire-and-forget: the caller is waiting on the line, not on our webhook.
  void context.notifier.notify({ kind: "message.taken", message });

  context.logger.info(
    { messageId: message.id, urgency: message.urgency },
    "message taken from caller",
  );

  return {
    output: {
      ok: true,
      saved: true,
      confirmation: `Message saved for ${context.config.owner.name}.`,
    },
    speakAfter: true,
  };
}

function getLocalTime(context: ToolContext): ToolResult {
  const timezone = context.config.owner.timezone;
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return {
      output: { ok: true, timezone, local_time: formatter.format(now), iso: now.toISOString() },
      speakAfter: true,
    };
  } catch {
    // An invalid IANA zone in config should degrade, not break the call.
    context.logger.warn({ timezone }, "owner.timezone is not a valid IANA timezone");
    return {
      output: { ok: true, timezone: "UTC", local_time: new Date().toUTCString() },
      speakAfter: true,
    };
  }
}

function transferCall(args: unknown, context: ToolContext): ToolResult {
  const { transfer } = context.config;
  if (!transfer.enabled || !transfer.target) {
    return {
      output: { ok: false, error: "transfers are not enabled; take a message instead" },
      speakAfter: true,
    };
  }

  const reason = transferArgs.parse(args).reason;
  context.requestTransfer(transfer.target, reason);
  context.logger.info({ reason }, "transfer requested by agent");

  // The line is about to move to a human; no further agent speech is wanted.
  return { output: { ok: true, transferring: true }, speakAfter: false };
}

function endCall(args: unknown, context: ToolContext): ToolResult {
  if (!context.config.call.allow_agent_hangup) {
    return {
      output: { ok: false, error: "you cannot end calls; wait for the caller to hang up" },
      speakAfter: true,
    };
  }

  const reason = endCallArgs.parse(args).reason;
  context.requestHangup(reason);
  context.logger.info({ reason }, "hangup requested by agent");

  return { output: { ok: true, ending: true }, speakAfter: false };
}
