// The board's serving paths with nothing but the local file store and a fake runtime cache: a board in the cache
// is served, the Blob backup and the in-memory copy stand in when the cache is empty, DKBBDB_SYNC_BOARD=1 is
// honoured once a minute at most, the finished-week totals come from the file / memory / the cache, and the
// refresh timetable.   node scripts/check-offline.mjs   (touches nothing outside dkbbdb/.blob/, and puts it back)
import * as lb from "../lib/leaderboard.js";
import { leaderboard, playersView, searchUsers, cachePut, _forget, refreshDue, lastMark } from "../lib/leaderboard.js";
import { priorFor, _forgetPrior } from "../lib/prior.js";
import { rcDrop, rcGet } from "../lib/rcache.js";
import { getGz, putGz, delFile, backend } from "../lib/files.js";
import { PATHS, _forgetStore } from "../lib/store.js";
const checks = []; const ok = (n, c, x = "") => { checks.push(!!c); console.log(c ? "  ok  " : "  FAIL", n, x); };
if (backend() !== "local") { console.error("local file store only"); process.exit(1); }

// a tiny store file of its own, so the checks do not depend on what is in .blob/
const keep = await getGz(PATHS.base), keepPrior = await getGz(PATHS.prior), keepBoard = await getGz(PATHS.board);
const restore = async () => { for (const [p, v] of [[PATHS.base, keep], [PATHS.prior, keepPrior], [PATHS.board, keepBoard]]) { if (v) await putGz(p, v.value); else await delFile(p); } };
const store = { v: 2, at: new Date().toISOString(), accounts: [{ k: "k1", u: "kknox20" }, { k: "k2", u: "other" }],
  entries: { 1: { cid: "10", dgid: 5, pp: 2, u: "k1", state: "live", prizes: null }, 2: { cid: "10", dgid: 5, pp: 2, u: "k2", state: "live", prizes: null } },
  contests: { 10: { name: "T", type: "Best Ball", buyIn: 25, entrants: 2, draftDate: null, draftState: "done", picksTotal: 1, pp: 2, round: 1, dgid: 5, tkey: null, start: null } },
  pods: { 10: { dgid: 5, from: 1, rosters: { 1: { u: "kknox20", d: [100], s: 1, pk: [1] }, 2: { u: "other", d: [200], s: 2, pk: [2] } } } },
  draftables: { 5: { 100: [1, "A", "WR", "MIN", null], 200: [2, "B", "RB", "GB", null] } }, sleeper: {}, ladders: {}, groups: [5] };
await putGz(PATHS.base, store); await delFile(PATHS.board); _forgetStore();

const board = (at) => ({ live: true, at, week: 3, playing: false, games: { pending: [], asOf: Date.now() }, accounts: 2,
  teams: [{ id: "1", user: "kknox20", contest: "T", buyIn: 25, date: null, points: 100, rank: 1, entrants: 2, left: 0, adv: true, gap: 5, picks: [[1, 1]], tkey: null, round: 1, prizes: 0 },
          { id: "2", user: "other", contest: "T", buyIn: 25, date: null, points: 90, rank: 2, entrants: 2, left: 0, adv: false, gap: -3, picks: [[2, 1]], tkey: null, round: 1, prizes: 0 }],
  players: [{ id: 1, name: "A", pos: "WR", team: "MIN", key: "a" }, { id: 2, name: "B", pos: "RB", team: "GB", key: "b" }], priorStats: {} });

try {
  // 1. fresh board in the cache → served
  await cachePut(board(new Date().toISOString()), Date.now(), Date.now());
  _forget();
  let r = await leaderboard({ t: "T" });
  ok("fresh cached board is served", r.live && r.total === 2 && r.rows[0].user === "kknox20" && lb.lastServed === "cache", `${r.total} rows, from ${lb.lastServed}`);
  ok("a user's page too", (await leaderboard({ u: "kknox20" })).profile.teams === 1);
  ok("players view too", (await playersView({ t: "T" })).total === 2);
  ok("user search too", (await searchUsers("kk"))[0]?.username === "kknox20");

  // 2. the cache entry vanished → the Blob backup, then the in-memory copy
  await putGz(PATHS.board, { storedAt: Date.now(), body: board(new Date().toISOString()) });
  await rcDrop("board-v1"); lb._stale();
  r = await leaderboard({ t: "T" });
  ok("cache empty: the backup file is served and put back in the cache", r.live && lb.lastServed === "blob" && !!(await rcGet("board-v1"))?.value?.teams?.length, `from ${lb.lastServed}`);
  await delFile(PATHS.board); await rcDrop("board-v1"); lb._stale();
  r = await leaderboard({ t: "T" });
  ok("cache and backup empty: the in-memory board is served", r.live && r.total === 2 && lb.lastServed === "mem", `from ${lb.lastServed}`);

  // 3. the force flag: fifty calls on a fresh board = no refresh attempts (a refresh would rewrite the backup file)
  process.env.DKBBDB_SYNC_BOARD = "1";
  await cachePut(board(new Date().toISOString()), Date.now(), Date.now());
  _forget(); await delFile(PATHS.board);
  await leaderboard({ t: "T" }); await delFile(PATHS.board);
  for (let i = 0; i < 50; i++) await leaderboard({ t: "T", offset: i });
  ok("DKBBDB_SYNC_BOARD=1: fifty calls in a minute attempt no refresh", (await getGz(PATHS.board)) === null);
  delete process.env.DKBBDB_SYNC_BOARD;

  // 4. prior rows: the file is read once, then memory / the shared cache; a pod nobody has is recomputed and written back
  const base = (cids) => ({ pods: Object.fromEntries(cids.map((cid) => [cid, { rosters: { k1: { s: 1 } } }])), entries: {}, draftables: {} });
  const f = { week: 3, past: [] };
  await putGz(PATHS.prior, { want: 2, rows: [["10", { through_week: 2, computed_at: new Date().toISOString(), data: { 1: { d: [1, 1, 2] } } }], ["11", { through_week: 2, computed_at: new Date().toISOString(), data: { 1: { d: [2, 2, 2] } } }]] });
  _forgetPrior(); await rcDrop("prior-v1");
  let p = await priorFor(base(["10", "11"]), f);
  ok("finished-week totals come from the file", p.stats.reused === 2 && p.prior["10"].k1.d[0] === 1);
  await delFile(PATHS.prior);
  p = await priorFor(base(["10", "11"]), f);
  ok("then from memory (the file can even be gone)", p.stats.reused === 2);
  _forgetPrior();
  p = await priorFor(base(["10", "11"]), f);
  ok("a new instance gets them from the shared cache", p.stats.reused === 2);
  p = await priorFor(base(["10", "11", "12"]), f);
  ok("a pod nobody has is recomputed and the file written back", p.stats.reused === 2 && p.stats.computed === 1 && (await getGz(PATHS.prior))?.value?.rows?.length === 3, `${(await getGz(PATHS.prior))?.value?.rows?.length} rows in the file`);

  // 5. the timetable (Eastern): six Sunday marks, Monday/Thursday 11:59 pm, 6:00 am otherwise
  const et = (t) => new Date(t + "-04:00").getTime(); // EDT
  const hm = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  ok("Sunday 1:05 pm: a board from noon is due, one from 1:02 pm is not", refreshDue(et("2026-09-27T12:00"), et("2026-09-27T13:05")) && !refreshDue(et("2026-09-27T13:02"), et("2026-09-27T13:05")));
  ok("Sunday: marks at 1:00, 2:30, 4:25, 6:00, 8:30, 11:59 pm", ["13:00", "14:30", "16:25", "18:00", "20:30", "23:59"].every((m) => hm(lastMark(et(`2026-09-27T${m}`) + 60e3)) === m));
  ok("Wednesday 6:05 am: a board from Tuesday is due; at noon a board from 6:30 am is not", refreshDue(et("2026-09-29T07:00"), et("2026-09-30T06:05")) && !refreshDue(et("2026-09-30T06:30"), et("2026-09-30T12:00")));
  ok("Monday 9 am: nothing since Sunday 11:59 pm", lastMark(et("2026-09-28T09:00")) === et("2026-09-27T23:59"));
  ok("Thursday 11:59 pm is a mark; Friday morning's is 6:00 am", lastMark(et("2026-10-01T23:59")) === et("2026-10-01T23:59") && lastMark(et("2026-10-02T06:30")) === et("2026-10-02T06:00"));
} finally { await restore(); }

console.log(checks.every(Boolean) ? `\nall ${checks.length} offline checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
