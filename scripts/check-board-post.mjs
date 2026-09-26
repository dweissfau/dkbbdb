// The hand-over endpoint (api/board.js): a board posted in pieces is assembled and served; bad callers are refused.
// Runs the handler in-process against the LOCAL file store.   node scripts/check-board-post.mjs
import { gzipSync } from "node:zlib";
import handler from "../api/board.js";
import { leaderboard, _forget } from "../lib/leaderboard.js";
import { rcDrop } from "../lib/rcache.js";
import { getGz, putGz, delFile, backend } from "../lib/files.js";
import { PATHS, _forgetStore } from "../lib/store.js";
const checks = []; const ok = (n, c, x = "") => { checks.push(!!c); console.log(c ? "  ok  " : "  FAIL", n, x); };
if (backend() !== "local") { console.error("local file store only"); process.exit(1); }
process.env.CRON_SECRET = "test-secret";

const call = (method, body, auth = "Bearer test-secret") => new Promise((resolve) => {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(j) { resolve({ status: this.code, body: j }); }, end() { resolve({ status: this.code }); } };
  handler({ method, headers: { authorization: auth }, body }, res);
});
const keep = await getGz(PATHS.base), keepBoard = await getGz(PATHS.board);
const store = { v: 2, at: new Date().toISOString(), accounts: [{ k: "k1", u: "kknox20" }], entries: { 1: { cid: "10", dgid: 5, pp: 2, u: "k1", state: "live", prizes: null } },
  contests: { 10: { name: "T", type: "Best Ball", buyIn: 25, entrants: 2, pp: 2, round: 1, dgid: 5 } }, pods: { 10: { dgid: 5, from: 1, rosters: { 1: { u: "kknox20", d: [100], s: 1, pk: [1] } } } },
  draftables: { 5: { 100: [1, "A", "WR", "MIN", null] } }, sleeper: {}, ladders: {}, groups: [5] };
await putGz(PATHS.base, store); _forgetStore();
const board = { live: true, at: new Date().toISOString(), week: 3, playing: true, games: { pending: [], asOf: Date.now() }, accounts: 1,
  teams: Array.from({ length: 3000 }, (_, i) => ({ id: String(i + 1), user: "kknox20", contest: "T", buyIn: 25, date: null, points: 300 - i / 100, rank: 1, entrants: 2, left: 0, adv: true, gap: 5, picks: [[1, 1]], tkey: null, round: 1, prizes: 0 })),
  players: [{ id: 1, name: "A", pos: "WR", team: "MIN", key: "a" }], priorStats: {} };
try {
  ok("no secret → 401", (await call("POST", { stamp: "abc123", part: 0, parts: 1, gz: "x" }, "Bearer wrong")).status === 401);
  ok("garbage → 400", (await call("POST", { stamp: "abc123", part: 0, parts: 1, gz: Buffer.from("nope").toString("base64") })).status === 400 || (await call("POST", {})).status === 400);
  const gz = gzipSync(Buffer.from(JSON.stringify(board))).toString("base64"), half = Math.ceil(gz.length / 2);
  const first = await call("POST", { stamp: "stamp1", part: 0, parts: 2, gz: gz.slice(0, half) });
  ok("first of two pieces → 202, waiting for one", first.status === 202 && first.body.waiting === 1, JSON.stringify(first.body));
  const second = await call("POST", { stamp: "stamp1", part: 1, parts: 2, gz: gz.slice(half) });
  ok("last piece → assembled and adopted", second.status === 200 && second.body.teams === 3000 && second.body.playing === true, JSON.stringify(second.body));
  _forget(); await rcDrop("board-v1"); // a fresh instance: the adopted board is in the cache
  const r = await leaderboard({ t: "T", limit: 1 });
  ok("the site now serves the posted board", r.live && r.teams === 3000 && r.rows[0].points === 300, `${r.teams} teams`);
  const st = await call("GET");
  ok("GET reports what is served", st.body.teams === 3000 && st.body.playing === true, JSON.stringify(st.body));
} finally {
  await rcDrop("board-v1"); _forget();
  if (keep) await putGz(PATHS.base, keep.value); else await delFile(PATHS.base);
  if (keepBoard) await putGz(PATHS.board, keepBoard.value); else await delFile(PATHS.board);
}
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
