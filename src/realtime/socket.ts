/**
 * The slice of the WebSocket API the call bridge actually uses.
 *
 * Both the `ws` package (Node) and the Workers runtime implement the standard
 * event-listener interface, so writing the bridge against this lets one
 * implementation of the call logic run on a server and inside a Durable Object.
 */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeHandlers {
  onMessage(data: unknown): void;
  onClose(event: { code?: number; reason?: string }): void;
  onError(message: string): void;
}

export interface ConnectOptions extends RealtimeHandlers {
  url: string;
  apiKey: string;
}

/**
 * Opens a realtime connection.
 *
 * Handlers are passed in rather than attached by the caller afterwards, because
 * xAI sends `session.created` the instant the socket opens. Attaching a
 * listener after awaiting the connection leaves a window — however small — in
 * which that first event is delivered to nobody, and the call then sits in
 * silence because the session is never configured. Implementations must wire
 * the handlers up before the socket can deliver anything.
 *
 * Resolves only once the socket is ready to send: the Workers runtime hands
 * back an already-open socket with no `open` event, so readiness is the
 * factory's contract rather than something the bridge waits for.
 */
export type ConnectRealtime = (options: ConnectOptions) => Promise<RealtimeSocket>;

const decoder = new TextDecoder();

/**
 * Coerce an untyped field from a server event into a string.
 *
 * Event payloads are `unknown` by construction, and a plain `String()` on an
 * object would silently produce "[object Object]" — better to fall back to the
 * default than to feed that into a transcript or a tool name.
 */
export function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/**
 * Turn a received frame into text.
 *
 * Runtimes disagree here: Workers hands over a string or ArrayBuffer, `ws`
 * hands over a Buffer or — for a fragmented message — an array of them.
 */
export function decodeFrame(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  // Re-view rather than slice: a Node Buffer is often a window onto a larger
  // shared pool, so byteOffset/byteLength must be carried across or the frame
  // decodes as neighbouring garbage.
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (Array.isArray(data)) {
    const parts = data.map((part) => decodeFrame(part));
    return parts.some((part) => part === undefined) ? undefined : parts.join("");
  }
  return undefined;
}
