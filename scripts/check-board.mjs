// The stored-totals + lean board must give EXACTLY the numbers of a full re-score, and the cache round trip must
// hold. Runs on the LOCAL file store (dkbbdb/.blob/); recomputes the finished-week totals from scratch, so it
// reads the public feeds and takes a few seconds.   node scripts/check-board.mjs
import { getFeeds } from "../lib/feeds.js";
import { computeSnapshot, foldWeeks } from "../lib/pubscore.js";
import { computeBoard, leaderboard, refreshBoard, cachePut, cacheGet, _forget, refreshDue, refreshAfterMs } from "../lib/leaderboard.js";
import { _forgetPrior } from "../lib/prior.js";
import { rcDrop } from "../lib/rcache.js";
import { getGz, putGz, delFile, backend } from "../lib/files.js";
import { PATHS, loadStore, baseOf } from "../lib/store.js";

if (backend() !== "local") { console.error("local file store only"); process.exit(1); }
process.env.DKBBDB_SYNC_BOARD = "1";
const checks = []; const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const store = await loadStore(); if (!store) { console.error("no local store"); process.exit(1); }
const keepPrior = await getGz(PATHS.prior);

// the original path: fold every finished week, full snapshot
const now = Date.now(), base = baseOf(store), f = await getFeeds(now);
const past = foldWeeks(base, f.past);
const full = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
const want = new Map();
for (const [id, e] of Object.entries(base.entries)) { const row = full.pods[e.cid]?.find((r) => r[0] === Number(id)); if (row) want.set(id, row); }

try {
  await delFile(PATHS.prior); _forgetPrior(); await rcDrop("prior-v1");
  const first = await computeBoard(now);
  ok("first run scores the finished weeks once and stores them", first.priorStats.computed === Object.keys(base.pods).length && first.priorStats.reused === 0, JSON.stringify(first.priorStats));
  const same = (b) => b.teams.length === want.size && b.teams.every((t) => { const w = want.get(t.id); return w && w[3] === t.points && w[2] === t.rank && Math.round(w[4] / 60) === t.left; });
  ok("every team matches the full re-score exactly (points, league place, players left)", same(first), `${first.teams.length} teams, top ${first.teams[0].points}`);
  const second = await computeBoard(now);
  ok("second run reuses the stored weeks and gives the same numbers", second.priorStats.reused === Object.keys(base.pods).length && second.priorStats.computed === 0 && same(second), JSON.stringify(second.priorStats));
  ok("stored totals exist for every pod (the file)", (await getGz(PATHS.prior))?.value?.rows?.length === Object.keys(base.pods).length);

  // the refresh writes the backup file and the rank history
  await delFile(PATHS.board);
  const t0 = Date.now(); const b = await refreshBoard(); const ms = Date.now() - t0;
  ok("refresh: backup file written, history noted", (await getGz(PATHS.board))?.value?.body?.teams?.length === b.teams.length && Object.keys((await getGz(PATHS.history))?.value ?? {}).length > 0, `${ms} ms`);
  // the cache round trip
  const stored = await cachePut(first, now), back = await cacheGet();
  ok("board survives the cache round trip", stored && back?.storedAt === now && back.body.teams.length === first.teams.length && same({ teams: back.body.teams.map((t) => ({ ...t })) }));
  _forget();
  const r = await leaderboard({ limit: 1 });
  ok("a request answers from the cached board", r.live && r.teams === first.teams.length);
  // the timetable helpers
  ok("the next refresh mark is ahead and within 24 hours", refreshAfterMs(null, now) > 0 && refreshAfterMs(null, now) <= 24 * 3600e3, `${(refreshAfterMs(null, now) / 60e3).toFixed(0)} min`);
  ok("a board scored a week ago is due, one scored now is not", refreshDue(now - 7 * 86400e3, now) && !refreshDue(now, now));
} finally { if (keepPrior) await putGz(PATHS.prior, keepPrior.value); }

console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
