// games.jdunne.au — static pages plus one Durable Object per backgammon room.
// /api/room/<code>/ws  → WebSocket into that room
// /api/room/<code>/history → JSON list of finished games in that room
// /api/room/<code>/state   → the current board, read-only (for checking a room from outside)
// /api/room/<code>/game/<id>.mat → one finished game's log in .mat format (GNU Backgammon / eXtreme Gammon)

const CODE = /^[a-z0-9-]{3,40}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/room\/([^/]+)\/(ws|history|state|game\/[a-z0-9]{4,40}\.mat)$/);
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
    if (url.pathname.endsWith("/state")) {
      const state = (await this.ctx.storage.get("state")) || null;
      const rev = (await this.ctx.storage.get("rev")) || 0;
      if (state) delete state.prev; // undo history isn't useful from outside
      return Response.json({ rev, state }, { headers: { "cache-control": "no-store" } });
    }
    const g = url.pathname.match(/\/game\/([a-z0-9]{4,40})\.mat$/);
    if (g) {
      const mat = await this.ctx.storage.get("mat:" + g[1]);
      if (!mat) return new Response("No such game", { status: 404 });
      return new Response(mat, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="smukkegammon-${g[1]}.mat"`, "cache-control": "no-store" } });
    }
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
    const analysis = (await this.ctx.storage.get("analysis")) || null;
    if (analysis) pair[1].send(JSON.stringify({ type: "analysis", grades: analysis.grades || {}, evals: analysis.evals || {} }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // clock sync: reply with the server's time, so every device measures game clocks against one clock
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: msg.t, now: Date.now() }));
      return;
    }
    if (msg.type === "hello" && typeof msg.player === "string") {
      ws.serializeAttachment({ player: msg.player.slice(0, 64), name: typeof msg.name === "string" ? msg.name.slice(0, 20) : "" });
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
    // Move grades and win chances worked out by one device, shared so the others needn't run the engine.
    // Kept apart from the board (no rev), so they can never cause a save conflict.
    if (msg.type === "analysis") {
      const clean = (o) => {
        const r = {};
        if (!o || typeof o !== "object") return r;
        for (const [k, v] of Object.entries(o).slice(0, 400)) {
          if (typeof k !== "string" || k.length > 40) continue;
          const j = JSON.stringify(v);
          if (j && j.length <= 300) r[k] = v;
        }
        return r;
      };
      const grades = clean(msg.grades), evals = clean(msg.evals);
      if (!Object.keys(grades).length && !Object.keys(evals).length) return;
      const a = (await this.ctx.storage.get("analysis")) || { grades: {}, evals: {} };
      Object.assign(a.grades, grades);
      Object.assign(a.evals, evals);
      // keep the store small: drop the oldest entries past 3000
      for (const key of ["grades", "evals"]) {
        const ks = Object.keys(a[key]);
        if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete a[key][k];
      }
      await this.ctx.storage.put("analysis", a);
      const out = JSON.stringify({ type: "analysis", grades, evals });
      for (const s of this.ctx.getWebSockets()) { if (s !== ws) { try { s.send(out); } catch {} } }
      return;
    }
    if (msg.type === "record" && msg.rec && typeof msg.rec === "object") {
      const hist = (await this.ctx.storage.get("history")) || [];
      if (hist.some((h) => h.id === msg.rec.id)) return;
      const rec = msg.rec;
      // keep the .mat log as its own small file in the room's storage, and point to it from the history entry
      if (typeof rec.mat === "string" && /^[a-z0-9]{4,40}$/.test(String(rec.id)) && rec.mat.length < 100000) {
        await this.ctx.storage.put("mat:" + rec.id, rec.mat);
        rec.file = "game/" + rec.id + ".mat";
      }
      delete rec.mat;
      hist.unshift(rec);
      for (const old of hist.slice(1000)) if (old.file) await this.ctx.storage.delete("mat:" + old.id);
      await this.ctx.storage.put("history", hist.slice(0, 1000));
    }
  }

  webSocketClose() { this.broadcastPresence(); }
  webSocketError() { this.broadcastPresence(); }

  broadcastPresence() {
    const socks = this.ctx.getWebSockets();
    const players = [...new Set(socks.map((s) => (s.deserializeAttachment() || {}).player).filter(Boolean))];
    // display names of everyone connected, so the page can list who is observing
    const names = {};
    for (const s of socks) { const a = s.deserializeAttachment() || {}; if (a.player && a.name) names[a.player] = a.name; }
    const out = JSON.stringify({ type: "presence", players, names });
    for (const s of socks) { try { s.send(out); } catch {} }
  }
}
