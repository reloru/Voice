import type { CallRecord, TakenMessage } from "../agent/types.js";

/**
 * Persistence seam.
 *
 * The call bridge only ever writes through this interface, so the same agent
 * logic runs against append-only files on a server and against Workers KV in a
 * Durable Object without knowing the difference.
 */
export interface CallStore {
  recordCall(record: CallRecord): Promise<void>;
  recordMessage(message: TakenMessage): Promise<void>;
  recentCalls(limit?: number): Promise<CallRecord[]>;
  recentMessages(limit?: number): Promise<TakenMessage[]>;
}
