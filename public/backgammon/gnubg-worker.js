// GNU Backgammon in a Web Worker, used for deep game analysis.
// The engine is Ted Hwa's gnubg_web port (GPL), built in the deploy workflow into ./gnubg/.
// Messages in:  {id, kind:"analyse", mat, plies}
// Messages out: {id, kind:"progress", note} … then {id, kind:"done", text, stats} or {id, kind:"error", message}
// (names kept distinct from the engine script's own globals, such as `out`)
let gbOut = [], gbReady = null, gbQueue = Promise.resolve();

self.Module = {
  noInitialRun: true,
  print: s => gbOut.push(s),
  printErr: s => gbOut.push(s),
  locateFile: f => "gnubg/" + f,
};
gbReady = new Promise((resolve, reject) => {
  self.Module.onRuntimeInitialized = () => {
    try {
      self.Module._start();
      cmd("set confirm new off");
      resolve();
    } catch (e) { reject(e); }
  };
  self.Module.onAbort = e => reject(new Error("engine stopped: " + e));
});
importScripts("gnubg/gnubg.js");

function cmd(s) {
  const M = self.Module, b = new TextEncoder().encode(s + "\0"), p = M._malloc(b.length);
  M.HEAPU8.set(b, p);
  try { M._run_command(p); } finally { M._free(p); }
}
function readFile(path) { return FS.readFile(path, { encoding: "utf8" }); }

async function analyse({ id, mat, plies }) {
  await gbReady;
  const p = Math.max(0, Math.min(3, plies | 0 || 2));
  self.postMessage({ id, kind: "progress", note: "import" });
  FS.writeFile("/game.mat", mat);
  gbOut = [];
  cmd("import mat /game.mat");
  cmd("set analysis chequerplay evaluation plies " + p);
  cmd("set analysis cubedecision evaluation plies " + p);
  self.postMessage({ id, kind: "progress", note: "analyse" });
  cmd("analyse match");
  cmd("export match text /analysis.txt");
  const text = readFile("/analysis.txt");
  gbOut = [];
  cmd("show statistics match");
  const stats = gbOut.join("\n");
  return { text, stats };
}

self.onmessage = e => {
  const m = e.data || {};
  gbQueue = gbQueue.then(async () => {
    try {
      if (m.kind === "analyse") {
        const r = await analyse(m);
        self.postMessage({ id: m.id, kind: "done", ...r });
      }
    } catch (err) {
      self.postMessage({ id: m.id, kind: "error", message: String(err && err.message || err) });
    }
  });
};
