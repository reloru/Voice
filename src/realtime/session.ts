import { buildInstructions } from "../agent/persona.js";
import { buildToolDefinitions } from "../agent/tools.js";
import type { CallerContext } from "../agent/types.js";
import type { AgentConfig } from "../config/agent.js";

export interface SessionUpdate {
  type: "session.update";
  session: Record<string, unknown>;
}

/**
 * Builds the one `session.update` we send after `session.created`.
 *
 * Audio formats are deliberately not set. On a SIP call xAI owns both audio
 * legs and negotiates the codec with the carrier; pinning a format here would
 * fight that. On a direct WebSocket the caller of this function supplies one.
 */
export function buildSessionUpdate(
  config: AgentConfig,
  caller: CallerContext,
  overrides: Record<string, unknown> = {},
): SessionUpdate {
  const { agent, call } = config;

  const transcription: Record<string, unknown> = { language_hint: agent.language_hint };
  if (agent.transcribe_caller) transcription.model = "grok-transcribe";
  if (agent.keyterms.length > 0) transcription.keyterms = agent.keyterms;

  const turnDetection: Record<string, unknown> = { type: "server_vad" };
  if (call.idle_prompt_seconds > 0) {
    // Re-engage rather than sit in dead air; common on calls that connect to
    // an answering machine or a caller who put the phone down.
    turnDetection.idle_timeout_ms = call.idle_prompt_seconds * 1000;
  }

  const session: Record<string, unknown> = {
    instructions: buildInstructions(config, caller),
    voice: agent.voice,
    turn_detection: turnDetection,
    tools: buildToolDefinitions(config),
    tool_choice: "auto",
    audio: {
      input: { transcription },
      output: { speed: agent.speed },
    },
    ...overrides,
  };

  if (Object.keys(agent.pronunciations).length > 0) {
    session.replace = agent.pronunciations;
  }

  return { type: "session.update", session };
}
