import framework from "vinext/server/fetch-handler";
import { handleAPI, eventPage } from "./api.mjs";
let sockets = 0;
export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/stream") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket required", { status: 426 });
      if (request.headers.get("origin") !== url.origin)
        return new Response("Forbidden", { status: 403 });
      const after = Number(url.searchParams.get("after") || 0);
      if (!Number.isSafeInteger(after) || after < 0)
        return new Response("Invalid cursor", { status: 400 });
      if (sockets >= 80) return new Response("Busy", { status: 503 });
      const pair = new WebSocketPair(),
        client = pair[0],
        server = pair[1];
      server.accept();
      sockets++;
      let cursor = after,
        closed = false,
        busy = false,
        queries = 0;
      const started = Date.now();
      let timer: ReturnType<typeof setInterval>;
      const close = () => {
        if (closed) return;
        closed = true;
        sockets--;
        clearInterval(timer);
        try {
          server.close(1000, "Reconnect to resume");
        } catch {}
      };
      server.addEventListener("close", close);
      server.addEventListener("error", close);
      server.addEventListener("message", () => close()); // Spectators cannot send world mutations over the socket.
      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          if (Date.now() - started > 40000) {
            close();
            return;
          }
          for (let i = 0; i < 4; i++) {
            // Free D1 permits 50 queries/invocation. Rotate before catch-up can exceed it.
            if (queries >= 44) {
              close();
              return;
            }
            queries++;
            const events = await eventPage(env.DB, cursor);
            if (events.length) {
              server.send(JSON.stringify({ type: "events", events }));
              cursor = events.at(-1).seq;
            }
            if (events.length < 100) break;
          }
          server.send(
            JSON.stringify({ type: "heartbeat", cursor, at: Date.now() }),
          );
        } catch {
          close();
        } finally {
          busy = false;
        }
      };
      timer = setInterval(tick, 1000);
      ctx.waitUntil(tick());
      return new Response(null, { status: 101, webSocket: client } as any);
    }
    if (url.pathname.startsWith("/api/")) return handleAPI(request, env);
    const response = await framework.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
    return new Response(response.body, { status: response.status, headers });
  },
};
