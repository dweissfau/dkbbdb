// The no-database paths, with NO database at all (a fake one that throws): a board in the runtime cache is served,
// a stale board's refresh fails soft, DKBBDB_SYNC_BOARD=1 is honoured once a minute at most, and the finished-weeks
// totals (lib/prior.js) are read from the database once and then from memory / the shared cache.
//   node scripts/check-offline.mjs        (safe to run any time — it never touches Neon)
import { leaderboard, playersView, searchUsers, cachePut, _forget, lastServed as _ls } from "../lib/leaderboard.js";
import * as lb from "../lib/leaderboard.js";
import { refreshDue, lastMark } from "../lib/leaderboard.js";
import { priorFor, _forgetPrior } from "../lib/prior.js";
import { rcDrop, rcGet } from "../lib/rcache.js";
const checks = []; const ok = (n, c, x = "") => { checks.push(!!c); console.log(c ? "  ok  " : "  FAIL", n, x); };

const board = (at) => ({ live: true, at, week: 3, playing: false, games: { pending: [], asOf: Date.now() }, accounts: 1,
  teams: [{ id: "1", user: "kknox20", contest: "T", buyIn: 25, date: null, points: 100, rank: 1, entrants: 12, left: 0, adv: true, gap: 5, picks: [[1, 1]], tkey: null, round: 1, prizes: 0 },
          { id: "2", user: "other", contest: "T", buyIn: 25, date: null, points: 90, rank: 2, entrants: 12, left: 0, adv: false, gap: -3, picks: [[2, 1]], tkey: null, round: 1, prizes: 0 }],
  players: [{ id: 1, name: "A", pos: "WR", team: "MIN", key: "a" }, { id: 2, name: "B", pos: "RB", team: "GB", key: "b" }], priorStats: {} });
let queries = 0;
const deadDb = { query: async () => { queries++; throw new Error("Your account or project has exceeded the quota."); } };

// 1. fresh board in the cache, database dead → served, no board query
await cachePut(board(new Date().toISOString()), Date.now(), Date.now());
_forget();
let r = await leaderboard(deadDb, { t: "T" });
ok("fresh cached board is served with a dead database", r.live && r.total === 2 && r.rows[0].user === "kknox20" && lb.lastServed === "cache", `${r.total} rows, from ${lb.lastServed}`);
ok("a user's page too", (await leaderboard(deadDb, { u: "kknox20" })).profile.teams === 1);
ok("players view too", (await playersView(deadDb, { t: "T" })).total === 2);
ok("user search too", (await searchUsers(deadDb, "kk"))[0]?.username === "kknox20");
ok("only the (tiny, once-a-minute) payout-ladder read was attempted", queries <= 1, `${queries} attempted queries`);

// 2. stale board (a week old — a mark on the timetable has certainly passed) → refresh attempted, database dead → stale board still served
await cachePut(board(new Date(Date.now() - 7 * 86400e3).toISOString()), Date.now() - 7 * 86400e3, Date.now() - 7 * 86400e3);
_forget();
r = await leaderboard(deadDb, { t: "T" });
ok("stale cached board: the refresh fails soft and the stale board is served", r.live && r.total === 2, `from ${lb.lastServed}`);

// 2b. the cache entry vanished (expired) AND the database is dead → the board in this instance's memory is served
//     and put back into the cache, so the next instance finds it again
await rcDrop("board-v1"); lb._stale();
r = await leaderboard(deadDb, { t: "T" });
ok("cache empty + dead database: the in-memory board is served", r.live && r.total === 2 && lb.lastServed === "mem", `from ${lb.lastServed}`);
ok("…and it is back in the cache for everyone else", !!(await rcGet("board-v1"))?.value?.teams?.length);

// 3. the force flag: fifty calls on a fresh board = no refresh attempts
process.env.DKBBDB_SYNC_BOARD = "1";
await cachePut(board(new Date().toISOString()), Date.now(), Date.now());
_forget();
await leaderboard(deadDb, { t: "T" });
queries = 0;
for (let i = 0; i < 50; i++) await leaderboard(deadDb, { t: "T", offset: i });
ok("DKBBDB_SYNC_BOARD=1: fifty calls in a minute attempt no refresh", queries === 0, `${queries} attempted queries`);
delete process.env.DKBBDB_SYNC_BOARD;

// 4. prior rows: database read once, then memory / cache; only pods synced since are read later
let reads = 0, writes = 0;
const rowsDb = { query: async (q, params) => { if (/^select/.test(q.trim())) { reads++; return { rows: params[0].map((cid) => ({ contest_id: cid, through_week: 2, computed_at: new Date(), data: { 1: { d: [1, 1, 2] } } })) }; } writes++; return { rows: [] }; } };
const base = (cids) => ({ pods: Object.fromEntries(cids.map((cid) => [cid, { rosters: { k1: { s: 1 } } }])), entries: {}, draftables: {} });
const f = { week: 3, past: [] };
let p = await priorFor(rowsDb, base(["10", "11"]), f);
ok("first run reads the stored totals from the database once", reads === 1 && p.stats.reused === 2 && p.prior["10"].k1.d[0] === 1, `${reads} reads`);
p = await priorFor(rowsDb, base(["10", "11"]), f);
ok("second run reads nothing", reads === 1 && p.stats.reused === 2);
_forgetPrior();
p = await priorFor(rowsDb, base(["10", "11"]), f);
ok("a new instance gets them from the shared cache, not the database", reads === 1 && p.stats.reused === 2, `${reads} reads`);
p = await priorFor(rowsDb, base(["10", "11", "12"]), f);
ok("a pod synced since is the only one read", reads === 2 && p.stats.reused === 3, `${reads} reads, ${writes} writes`);

// 5. the timetable (Eastern): six Sunday marks, Monday/Thursday 11:59 pm, 6:00 am otherwise
const et = (t) => new Date(t + "-04:00").getTime(); // EDT
const hm = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
ok("Sunday 1:05 pm: a board from noon is due, one from 1:02 pm is not", refreshDue(et("2026-09-27T12:00"), et("2026-09-27T13:05")) && !refreshDue(et("2026-09-27T13:02"), et("2026-09-27T13:05")));
ok("Sunday: marks at 1:00, 2:30, 4:25, 6:00, 8:30, 11:59 pm", ["13:00", "14:30", "16:25", "18:00", "20:30", "23:59"].every((m) => hm(lastMark(et(`2026-09-27T${m}`) + 60e3)) === m));
ok("Wednesday 6:05 am: a board from Tuesday is due; at noon a board from 6:30 am is not", refreshDue(et("2026-09-29T07:00"), et("2026-09-30T06:05")) && !refreshDue(et("2026-09-30T06:30"), et("2026-09-30T12:00")));
ok("Monday 9 am: nothing since Sunday 11:59 pm", lastMark(et("2026-09-28T09:00")) === et("2026-09-27T23:59"));
ok("Thursday 11:59 pm is a mark; Friday morning's is 6:00 am", lastMark(et("2026-10-01T23:59")) === et("2026-10-01T23:59") && lastMark(et("2026-10-02T06:30")) === et("2026-10-02T06:00"));

console.log(checks.every(Boolean) ? `\nall ${checks.length} offline checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
