// games.jdunne.au — static pages plus one Durable Object per backgammon room.
// /api/room/<code>/ws  → WebSocket into that room
// /api/room/<code>/history → JSON list of finished games in that room

const CODE = /^[a-z0-9-]{3,40}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/room\/([^/]+)\/(ws|history)$/);
    if (m) {
      const code = m[1].toLowerCase();
      if (!CODE.test(code)) return new Response("Bad room code", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/history")) {
      const hist = (await this.ctx.storage.get("history")) || [];
      return Response.json(hist, { headers: { "cache-control": "no-store" } });
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const state = (await this.ctx.storage.get("state")) || null;
    const rev = (await this.ctx.storage.get("rev")) || 0;
    pair[1].send(JSON.stringify({ type: "state", state, rev }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "hello" && typeof msg.player === "string") {
      ws.serializeAttachment({ player: msg.player.slice(0, 64) });
      this.broadcastPresence();
      return;
    }
    if (msg.type === "set" && msg.state && typeof msg.state === "object") {
      const rev = (await this.ctx.storage.get("rev")) || 0;
      if (msg.base !== rev) {
        // Someone else moved first: send the current board back to this player only.
        ws.send(JSON.stringify({ type: "state", state: await this.ctx.storage.get("state"), rev, conflict: true }));
        return;
      }
      const body = JSON.stringify(msg.state);
      if (body.length > 200000) return;
      await this.ctx.storage.put({ state: msg.state, rev: rev + 1 });
      const by = (ws.deserializeAttachment() || {}).player || null;
      const out = JSON.stringify({ type: "state", state: msg.state, rev: rev + 1, by });
      for (const s of this.ctx.getWebSockets()) { try { s.send(out); } catch {} }
      return;
    }
    if (msg.type === "record" && msg.rec && typeof msg.rec === "object") {
      const hist = (await this.ctx.storage.get("history")) || [];
      if (hist.some((h) => h.id === msg.rec.id)) return;
      hist.unshift(msg.rec);
      await this.ctx.storage.put("history", hist.slice(0, 200));
    }
  }

  webSocketClose() { this.broadcastPresence(); }
  webSocketError() { this.broadcastPresence(); }

  broadcastPresence() {
    const socks = this.ctx.getWebSockets();
    const players = [...new Set(socks.map((s) => (s.deserializeAttachment() || {}).player).filter(Boolean))];
    const out = JSON.stringify({ type: "presence", players });
    for (const s of socks) { try { s.send(out); } catch {} }
  }
}
