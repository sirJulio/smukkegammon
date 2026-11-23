// Kris Kringle (Secret Santa) events — one Durable Object per event.
//
// The organiser enters names and details; the draw happens at once on the server and is never shown to
// the organiser. They get two links: the game link (shared with everyone) and a private organiser link.
// Each player opens the game link, picks their name and sets a 4-digit PIN; from then on they see who
// they're buying for and that person's wishlist. Everything else stays hidden until the day after the
// exchange date (Melbourne time), when the whole draw is revealed.
//
// The draw is a single loop: shuffle, each person gives to the next, the last gives to the first. With
// exclusions it searches for a loop that breaks none of them, and refuses (explaining which exclusions
// are the problem) when none exists or when so few exist that players could work the draw out.
//
// POST /api/kk/new                 {title,budget,date,location,names[],exclusions[[i,j]],accept}
// GET  /api/kk/<id>?t=<session>    the event as this viewer may see it (&admin=<token> for the organiser)
// POST /api/kk/<id>                {action, ...} — claim, login, wish, admin-details, admin-reset

const ID = /^[a-z0-9-]{5,40}$/;
// Christmas myths, figures and objects from around the world (with a few Australian ones)
const WORDS = ("krampus befana christkind sinterklaas olentzero nisse tomte yulecat yulegoat juleboy belsnickel "
  + "mistletoe holly ivy tinsel bauble wreath sleigh reindeer stocking candycane gingerbread nutcracker "
  + "pudding wassail eggnog carol angel star snowglobe chimney yulelog frankincense myrrh manger lantern "
  + "bonbon pavlova christmasbush christmasbeetle prawn mince fruitcake shortbread pinecone poinsettia "
  + "advent ornament jinglebell elf coal kringle").split(" ");
const enc = new TextEncoder();

export async function kkRoute(req, env, url) {
  if (url.pathname === "/api/kk/new" && req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return bad("Bad request"); }
    // event id: a Christmas myth or object plus 3 digits (krampus-482), like SmukkeGammon's room names
    for (let tries = 0; tries < 8; tries++) {
      const r16 = crypto.getRandomValues(new Uint16Array(2));
      const id = WORDS[r16[0] % WORDS.length] + "-" + String(r16[1] % 900 + 100), admin = rand(24);
      const stub = env.EVENTS.get(env.EVENTS.idFromName(id));
      const r = await stub.fetch(new Request("https://kk/create", { method: "POST", body: JSON.stringify({ ...b, id, admin }) }));
      if (r.status !== 400 || !(await r.clone().text()).includes("Try again")) return r;
    }
    return bad("Couldn't create the event. Try again.", 503);
  }
  const m = url.pathname.match(/^\/api\/kk\/([a-z0-9]+)$/);
  if (m) {
    if (!ID.test(m[1])) return bad("No such event", 404);
    const stub = env.EVENTS.get(env.EVENTS.idFromName(m[1]));
    return stub.fetch(req);
  }
  return null;
}

export class KKEvent {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/create") return this.create(await req.json());
    const ev = await this.ctx.storage.get("ev");
    if (!ev) return bad("No such event", 404);
    if (req.method === "GET") return json(view(ev, url.searchParams.get("t"), url.searchParams.get("admin"), url.searchParams.get("c")));
    let b;
    try { b = await req.json(); } catch { return bad("Bad request"); }
    const r = await this.act(ev, b);
    if (r instanceof Response) return r;
    await this.ctx.storage.put("ev", ev);
    return json({ ...(r || {}), event: view(ev, r?.session || b.t, b.admin, b.c) });
  }

  async create(b) {
    if (await this.ctx.storage.get("ev")) return bad("Try again");
    const names = (Array.isArray(b.names) ? b.names : []).map(cleanName).filter(Boolean);
    if (names.length < 3) return bad("Add at least 3 people.");
    if (names.length > 40) return bad("40 people at most.");
    const keys = names.map((n) => n.toLowerCase());
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) return bad(`"${names[keys.indexOf(dup)]}" is in the list twice. Add a surname or initial to tell them apart.`);
    const ex = [];
    for (const p of Array.isArray(b.exclusions) ? b.exclusions : []) {
      const [i, j] = [Number(p?.[0]), Number(p?.[1])];
      if (Number.isInteger(i) && Number.isInteger(j) && i !== j && names[i] && names[j]
        && !ex.some(([a, c]) => (a === i && c === j) || (a === j && c === i))) ex.push([i, j]);
    }
    const d = details(b);
    if (d.error) return bad(d.error);
    const r = draw(names.length, ex);
    if (!r.loop) {
      return json({ error: "impossible", message: "No draw can satisfy all the exclusions." + culprits(names, ex, 1) }, 422);
    }
    if (r.count === 1 && names.length > 3) {
      return json({ error: "predictable", message: "These exclusions leave only one possible draw, so anyone who knows who they have could work out everyone else's." + culprits(names, ex, 2) }, 422);
    }
    if (r.count < 6 && names.length > 3 && !b.accept) {
      return json({ error: "few", count: r.count, message: `These exclusions leave only ${r.count} possible draws, so a player who knows who they have could make a good guess at the rest.` + culprits(names, ex, r.count + 1) }, 409);
    }
    const now = Date.now();
    const ev = {
      id: b.id, admin: b.admin, created: now, ...d,
      people: names.map((name) => ({ name, code: rand(12), salt: "", pin: "", sessions: [], claimed: 0, wish: "", fails: 0, lock: 0 })),
      gives: r.loop, // gives[i] = index of the person i buys for
      starter: Math.floor(Math.random() * names.length),
      exclusions: ex,
      flags: [],
      log: [{ at: now, text: `Event created with ${names.length} people${ex.length ? ` and ${ex.length} exclusion${ex.length > 1 ? "s" : ""}` : ""}. The draw was made.` }],
    };
    await this.ctx.storage.put("ev", ev);
    return json({ id: ev.id, admin: ev.admin });
  }

  async act(ev, b) {
    const now = Date.now();
    const isAdmin = typeof b.admin === "string" && b.admin === ev.admin;
    const me = whoIs(ev, b.t);
    const log = (text) => { ev.log.push({ at: now, text }); if (ev.log.length > 500) ev.log.shift(); };

    if (b.action === "claim" || b.action === "login") {
      const i = Number(b.person), p = ev.people[i];
      const pin = String(b.pin || "");
      if (!p) return bad("Pick your name.");
      if (!/^\d{4}$/.test(pin)) return bad("The PIN is 4 digits.");
      if (b.action === "claim") {
        if (b.c !== p.code) return bad(`Use your own personal link to claim ${p.name}. The organiser sent it to you.`, 403);
        if (p.claimed) {
          ev.flags.push({ at: now, person: i, text: `Someone tried to claim ${p.name}, but that name was already claimed.` });
          log(`Someone tried to claim ${p.name}, but it was already claimed. The organiser has been flagged.`);
          await this.ctx.storage.put("ev", ev);
          return json({ error: "taken", message: `${p.name} has already been claimed. If that wasn't you, enter your PIN if you set one, or tell the organiser, who can reset it.` }, 409);
        }
        p.salt = rand(16); p.pin = await hash(p.salt, pin); p.claimed = now; p.fails = 0;
        const s = rand(24); p.sessions = [s];
        log(`${p.name} claimed their name.`);
        return { session: s };
      }
      if (!p.claimed) return bad(`${p.name} hasn't been claimed yet. Choose "This is me" instead.`);
      if (p.lock > now) return json({ error: "locked", message: `Too many wrong PINs. Try again in ${Math.ceil((p.lock - now) / 60000)} minutes, or ask the organiser to reset it.` }, 429);
      if ((await hash(p.salt, pin)) !== p.pin) {
        p.fails++;
        if (p.fails >= 5) { p.fails = 0; p.lock = now + 15 * 60000; log(`${p.name}'s PIN was entered wrongly 5 times; locked for 15 minutes.`); }
        await this.ctx.storage.put("ev", ev);
        return json({ error: "wrong", message: "That PIN doesn't match." }, 403);
      }
      p.fails = 0;
      const s = rand(24); p.sessions = [...p.sessions.slice(-4), s];
      return { session: s };
    }

    if (b.action === "wish") {
      if (me < 0) return bad("Sign in first.", 401);
      const w = String(b.wish || "").slice(0, 1000).trim();
      if (w === ev.people[me].wish) return {};
      ev.people[me].wish = w;
      log(`${ev.people[me].name} updated their wishlist.`);
      return {};
    }

    if (b.action === "report") {
      const i = Number(b.person), p = ev.people[i];
      if (!p || !p.claimed) return bad("Pick the name.");
      ev.flags.push({ at: now, person: i, text: `Someone says ${p.name} was claimed by the wrong person.` });
      log(`Someone reported that ${p.name} was claimed by the wrong person. The organiser has been flagged.`);
      return {};
    }

    if (b.action === "logout") {
      if (me >= 0) ev.people[me].sessions = ev.people[me].sessions.filter((s) => s !== b.t);
      return {};
    }

    if (!isAdmin) return bad("Organiser link needed.", 403);

    if (b.action === "admin-details") {
      const d = details(b);
      if (d.error) return bad(d.error);
      const label = { title: "name", budget: "budget", date: "exchange date", location: "location" };
      for (const k of Object.keys(label)) {
        if (d[k] !== ev[k]) { log(`Organiser changed the ${label[k]} from "${ev[k] || "—"}" to "${d[k] || "—"}".`); ev[k] = d[k]; }
      }
      return {};
    }
    if (b.action === "admin-reset") {
      const i = Number(b.person), p = ev.people[i];
      if (!p) return bad("No such person.");
      Object.assign(p, { code: rand(12), salt: "", pin: "", sessions: [], claimed: 0, fails: 0, lock: 0 });
      ev.flags = ev.flags.filter((f) => f.person !== i);
      log(`Organiser reset ${p.name}'s claim and PIN. They have a new personal link (the old one no longer works); their wishlist was kept.`);
      return {};
    }
    if (b.action === "admin-rename") {
      const i = Number(b.person), p = ev.people[i], name = cleanName(b.name);
      if (!p || !name) return bad("Enter a name.");
      if (ev.people.some((q, k) => k !== i && q.name.toLowerCase() === name.toLowerCase())) return bad(`${name} is already in the list.`);
      if (name !== p.name) { log(`Organiser renamed ${p.name} to ${name}. The draw is unchanged.`); p.name = name; }
      return {};
    }
    if (b.action === "admin-dismiss") {
      ev.flags = [];
      return {};
    }
    return bad("Unknown action");
  }
}

// What one viewer may see. Names, claim status, details and the log are public to anyone with the link.
// A signed-in player also sees who they buy for, their own wishlist and that person's wishlist.
// After the exchange day everything is shown.
function view(ev, token, admin, c) {
  const me = whoIs(ev, token);
  const revealed = today() > ev.date;
  const kk = me >= 0 ? ev.gives[me] : -1;
  return {
    id: ev.id, title: ev.title, budget: ev.budget, date: ev.date, location: ev.location,
    revealed, me, kk, invite: c ? ev.people.findIndex((p) => p.code === c) : -1,
    starter: ev.people[ev.starter].name,
    people: ev.people.map((p, i) => ({
      name: p.name,
      claimed: !!p.claimed,
      gives: revealed || i === me ? ev.people[ev.gives[i]].name : null,
      wish: revealed || i === me || i === kk ? p.wish : null,
      hasWish: !!p.wish,
    })),
    log: ev.log.slice().reverse(),
    admin: admin && admin === ev.admin ? { codes: ev.people.map((p) => p.code), flags: ev.flags, exclusions: ev.exclusions.map(([a, b]) => [ev.people[a].name, ev.people[b].name]) } : null,
  };
}

// Search for single-loop draws that break no exclusion (an excluded pair never gives to each other).
// Person 0 starts every loop, so each loop is counted once. Counts up to `cap` loops and stops after a
// fixed amount of work, which keeps it instant even for 40 people.
export function draw(n, ex, cap = 6) {
  const ok = Array.from({ length: n }, () => Array(n).fill(true));
  for (let i = 0; i < n; i++) ok[i][i] = false;
  for (const [a, b] of ex) { ok[a][b] = false; ok[b][a] = false; }
  const perm = shuffle([...Array(n).keys()]); // random labels so the first loop found is a random one
  const P = (x) => perm[x];
  const used = Array(n).fill(false), path = [0];
  used[0] = true;
  let count = 0, first = null, steps = 0;
  const go = () => {
    if (++steps > 300000 || count >= cap) return;
    const last = path[path.length - 1];
    if (path.length === n) {
      if (ok[P(last)][P(0)]) { count++; if (!first) first = path.map(P); }
      return;
    }
    for (const nx of shuffle([...Array(n).keys()])) {
      if (!used[nx] && ok[P(last)][P(nx)]) {
        used[nx] = true; path.push(nx); go(); path.pop(); used[nx] = false;
        if (count >= cap || steps > 300000) return;
      }
    }
  };
  go();
  if (!first) return { loop: null, count: 0 };
  const gives = Array(n);
  for (let k = 0; k < n; k++) gives[first[k]] = first[(k + 1) % n];
  return { loop: gives, count };
}

// Which exclusions, dropped one at a time, would get the draw to at least `need` possible loops.
function culprits(names, ex, need) {
  const fix = ex.filter((_, k) => draw(names.length, ex.filter((__, j) => j !== k), need).count >= need)
    .map(([a, b]) => `${names[a]} & ${names[b]}`);
  return fix.length ? ` Removing any one of these exclusions would fix it: ${fix.join("; ")}.` : " Try removing a few exclusions.";
}

function details(b) {
  const title = String(b.title || "").trim().slice(0, 80) || "Kris Kringle";
  const budget = String(b.budget || "").trim().slice(0, 40);
  const location = String(b.location || "").trim().slice(0, 120);
  const date = String(b.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Choose the exchange date." };
  return { title, budget, date, location };
}

function whoIs(ev, token) {
  if (!token || typeof token !== "string") return -1;
  return ev.people.findIndex((p) => p.sessions.includes(token));
}
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date()); }
function cleanName(s) { return typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 30) : ""; }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function rand(len) {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789", out = crypto.getRandomValues(new Uint8Array(len));
  return [...out].map((x) => abc[x % abc.length]).join("").replace(/[^a-z0-9]/g, "a");
}
async function hash(salt, pin) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(salt + ":" + pin));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function json(o, status = 200) { return Response.json(o, { status, headers: { "cache-control": "no-store" } }); }
function bad(message, status = 400) { return json({ error: "bad", message }, status); }
