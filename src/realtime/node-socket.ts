import { WebSocket } from "ws";
import type { ConnectRealtime, RealtimeSocket } from "./socket.js";

/**
 * Node implementation of {@link ConnectRealtime}, backed by the `ws` package.
 *
 * Kept in its own module so nothing that has to run on Workers ever imports
 * `ws` transitively.
 */
export const connectWithWs: ConnectRealtime = (options) =>
  new Promise<RealtimeSocket>((resolve, reject) => {
    const socket = new WebSocket(options.url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    let opened = false;

    // Attached before the socket can emit anything, so the `session.created`
    // event that arrives immediately on open is never dropped.
    socket.addEventListener("message", (event) => options.onMessage(event.data));
    socket.addEventListener("close", (event) => {
      options.onClose({ code: event.code, reason: event.reason });
    });
    socket.addEventListener("error", (event) => {
      const message = event.message || "realtime socket error";
      // Before the handshake completes there is nobody to report to but the
      // caller awaiting this promise.
      if (opened) options.onError(message);
      else reject(new Error(message));
    });

    socket.addEventListener("open", () => {
      opened = true;
      resolve(socket);
    });
  });
