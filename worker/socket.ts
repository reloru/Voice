import type { ConnectRealtime } from "../src/realtime/socket.js";

/**
 * Workers implementation of {@link ConnectRealtime}.
 *
 * The runtime has no WebSocket constructor for outbound connections — you make
 * a normal `fetch` with an `Upgrade` header and take the socket off the 101
 * response. Handlers are attached before `accept()`, because frames start
 * flowing the moment the socket is accepted and xAI's `session.created`
 * arrives immediately.
 */
export const connectWithWorkersSocket: ConnectRealtime = async (options) => {
  // The Workers fetch API rejects ws:// and wss:// outright — an upgrade is an
  // ordinary HTTPS request carrying the Upgrade header.
  const httpUrl = options.url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

  const response = await fetch(httpUrl, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${options.apiKey}` },
  });

  const socket = response.webSocket;
  if (!socket) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `realtime upgrade failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
    );
  }

  socket.addEventListener("message", (event) => options.onMessage(event.data));
  socket.addEventListener("close", (event) => {
    options.onClose({ code: event.code, reason: event.reason });
  });
  socket.addEventListener("error", () => options.onError("realtime socket error"));

  socket.accept();
  return socket;
};
