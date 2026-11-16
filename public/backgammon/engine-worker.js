// Runs wildbg off the main thread, so the board never freezes while the engine thinks.
// Jobs: {id, method, args, prio}. Lower prio runs first: 0 = bot move or cube decision, 1 = newest grades,
// 2 = older history. Methods ending in "Fast" use the one-ply net (quick); the others use the deep search.
let mod = null, deep = null, fast = null, failed = null;
const queue = [];
let running = false;

async function boot() {
  if (mod || failed) return;
  try {
    mod = await import("./wildbg/wildbg_wasm.js");
    await mod.default();
  } catch (e) { failed = "boot: " + String(e && e.message || e); }
}
function engine(kind) {
  if (kind === "fast") {
    if (!fast) fast = mod.WildbgFast ? new mod.WildbgFast() : engine("deep"); // older builds have no fast engine
    return fast;
  }
  if (!deep) deep = new mod.Wildbg();
  return deep;
}
function run(job) {
  const [kind, name] = job.method.endsWith("Fast") ? ["fast", job.method.slice(0, -4)] : ["deep", job.method];
  const e = engine(kind);
  return e[name](...job.args);
}
async function pump() {
  if (running) return;
  running = true;
  await boot();
  while (queue.length) {
    queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    const job = queue.shift();
    if (failed) { postMessage({ id: job.id, error: failed }); continue; }
    try { postMessage({ id: job.id, result: run(job) }); }
    catch (e) { postMessage({ id: job.id, error: String(e && e.message || e) }); }
    // let newly arrived urgent jobs jump the queue
    await new Promise((r) => setTimeout(r, 0));
  }
  running = false;
}
let seq = 0;
onmessage = (ev) => {
  const m = ev.data || {};
  if (m.drop) { // forget queued jobs at this priority or lower (e.g. history grades after a new game)
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].prio >= m.drop) {
      postMessage({ id: queue[i].id, error: "dropped" }); queue.splice(i, 1);
    }
    return;
  }
  queue.push({ id: m.id, method: m.method, args: m.args || [], prio: m.prio ?? 1, seq: seq++ });
  pump();
};
