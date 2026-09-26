// The stored-totals + lean + background board must give EXACTLY the numbers of the original full re-score.
//   node scripts/check-board.mjs
import { connect, loadEnv } from "./db.mjs";
import { buildBase } from "../lib/base.js";
import { getFeeds } from "../lib/feeds.js";
import { computeSnapshot, foldWeeks } from "../lib/pubscore.js";
import { computeBoard, leaderboard, refreshBoard, refreshAfterMs, refreshDue, cachePut, cacheGet, _forget, REFRESH_PLAYING_MS, REFRESH_IDLE_MS, REFRESH_UNKNOWN_MS } from "../lib/leaderboard.js";

process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
process.env.DKBBDB_SYNC_BOARD = "1";
const db = await connect();
const checks = [];
const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };

// the original path: fold every finished week, full snapshot
const keys = (await db.query("select user_key from dk_accounts")).rows.map((r) => r.user_key);
const now = Date.now(), base = await buildBase(db, keys, now), f = await getFeeds(now);
const past = foldWeeks(base, f.past);
const full = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
const want = new Map();
for (const [id, e] of Object.entries(base.entries)) { const row = full.pods[e.cid]?.find((r) => r[0] === Number(id)); if (row) want.set(id, row); }

await db.query("delete from pod_prior"); await db.query("delete from board_cache");
const first = await computeBoard(db, now);
ok("first run scores the finished weeks once and stores them", first.priorStats.computed === Object.keys(base.pods).length && first.priorStats.reused === 0, JSON.stringify(first.priorStats));
const same = (b) => b.teams.length === want.size && b.teams.every((t) => { const w = want.get(t.id); return w && w[3] === t.points && w[2] === t.rank && Math.round(w[4] / 60) === t.left; });
ok(`every team matches the full re-score exactly (points, league place, players left)`, same(first), `${first.teams.length} teams, top ${first.teams[0].points}`);
const second = await computeBoard(db, now);
ok("second run reuses the stored weeks and gives the same numbers", second.priorStats.reused === Object.keys(base.pods).length && second.priorStats.computed === 0 && same(second), JSON.stringify(second.priorStats));
ok("stored totals exist for every pod", (await db.query("select count(*)::int n, min(through_week) w from pod_prior")).rows[0].n === Object.keys(base.pods).length);

// a roster whose key changes (seat → entry id, when its owner syncs later) still finds its stored weeks
const cid = Object.keys(base.pods)[0], oldKey = Object.keys(base.pods[cid].rosters).find((k) => Number(k) <= 12);
if (oldKey) {
  const moved = structuredClone(base); moved.pods[cid].rosters["999000111"] = moved.pods[cid].rosters[oldKey]; delete moved.pods[cid].rosters[oldKey];
  const { priorFor } = await import("../lib/prior.js");
  const { prior } = await priorFor(db, moved, f, now);
  ok("stored weeks follow a roster whose key changed", JSON.stringify(prior[cid]["999000111"]) === JSON.stringify(past.prior[cid][oldKey]));
}

// the stored board + the views on top of it
const t0 = Date.now(); await refreshBoard(db); const ms = Date.now() - t0;
const row = (await db.query("select at, ms, pg_column_size(body) bytes from board_cache where id = 1")).rows[0];
ok("board stored", !!row, `run ${ms} ms · stored ${(row.bytes / 1024).toFixed(0)} KB`);
const lb = await leaderboard(db, { limit: 200 });
ok("leaderboard served from the stored board matches", lb.rows.every((r) => want.get(r.id)?.[3] === r.points) && lb.total === want.size, `${lb.total} teams`);
const lock = await db.query("update board_cache set refreshing_at = now() where id = 1 and (refreshing_at is null or refreshing_at < now() - interval '2 minutes') returning 1");
const lock2 = await db.query("update board_cache set refreshing_at = now() where id = 1 and (refreshing_at is null or refreshing_at < now() - interval '2 minutes') returning 1");
ok("only one refresh can run at a time", lock.rowCount === 1 && lock2.rowCount === 0);
await db.query("update board_cache set refreshing_at = null where id = 1");

// refresh cadence: a fixed Eastern timetable (lib SCHEDULE — six Sunday marks, Mon/Thu 11:59 pm, 6 am otherwise); the
// marks themselves are checked in scripts/check-offline.mjs. Here: the next mark is always ahead and within a day.
const t = Date.now(), idle = { live: true, playing: false, games: { pending: [t + 3 * 3600e3] } };
ok("the next refresh mark is ahead and within 24 hours", refreshAfterMs(idle, t) > 0 && refreshAfterMs(idle, t) <= 24 * 3600e3, `${(refreshAfterMs(idle, t) / 60e3).toFixed(0)} min`);
ok("a board scored a week ago is due, one scored now is not", refreshDue(t - 7 * 86400e3, t) && !refreshDue(t, t));
ok("the stored board carries this week's pending kickoffs", first.games && Array.isArray(first.games.pending), JSON.stringify(first.games?.pending?.slice(0, 3)));

// the shared cache round trip (in-memory stand-in outside Vercel): gzip'd copy comes back identical
const stored = await cachePut(first, t), back = await cacheGet();
ok("board survives the shared-cache round trip", stored && back?.storedAt === t && JSON.stringify(back.body) === JSON.stringify(first), `${(JSON.stringify(first).length / 1024).toFixed(0)} KB json`);
{ // a request served from the shared cache does not read the board out of the database
  const seen = []; const spy = { query: (sql, args) => { seen.push(String(sql)); return db.query(sql, args); }, end: () => {} };
  delete process.env.DKBBDB_SYNC_BOARD; await cachePut(first, Date.now());
  const r = await leaderboard(spy, { limit: 5 }, Date.now() + 20e3); // past the instance's 15 s memory, inside the refresh window
  ok("a request served from the shared cache never reads board_cache", r.total === want.size && !seen.some((q) => /from board_cache/.test(q)), `${seen.length} db queries`);
  // someone who has just synced: their username is not on the board yet -> refresh now, not in 30 minutes
  const L = await import("../lib/leaderboard.js");
  _forget(); await cachePut(first, Date.now() - 90e3);
  const known = await leaderboard(spy, { u: first.teams[0].user, limit: 1 }); const s1 = L.lastServed;
  _forget(); await cachePut(first, Date.now() - 90e3);
  const fresh = await leaderboard(spy, { u: "someone-who-just-synced", limit: 1 }); const s2 = L.lastServed;
  ok("a known username on an idle board is served from the cache", known.total > 0 && s1 === "cache", s1);
  ok("an unknown username refreshes the board at once (once a minute at most)", fresh.total === 0 && s2 === "run", s2);
  _forget(); await cachePut(first, Date.now() - 30e3);
  await leaderboard(spy, { u: "someone-who-just-synced", limit: 1 });
  ok("...but not when the board is under a minute old", L.lastServed === "cache", L.lastServed);
  process.env.DKBBDB_SYNC_BOARD = "1";
}

await db.end();
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
