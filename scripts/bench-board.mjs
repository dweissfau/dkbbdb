// How the leaderboard run scales: copies the real pods N times (default 25 → ~5,000 teams / ~62,000 rosters) and
// times the OLD per-minute work (fold every finished week + full snapshot) against the NEW one (stored weeks +
// lean snapshot), at a given NFL week.   node --expose-gc scripts/bench-board.mjs [copies=25] [week=17]
import { connect, loadEnv } from "./db.mjs";
import { buildBase } from "../lib/base.js";
import { getFeeds } from "../lib/feeds.js";
import { computeSnapshot, foldWeeks } from "../lib/pubscore.js";

const copies = Number(process.argv[2]) || 25, week = Number(process.argv[3]) || 17;
process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const db = await connect();
const keys = (await db.query("select user_key from dk_accounts")).rows.map((r) => r.user_key);
const base = await buildBase(db, keys), f = await getFeeds();
await db.end();

const big = { ...base, entries: {}, pods: {} };
for (let k = 0; k < copies; k++) for (const [id, e] of Object.entries(base.entries)) {
  const cid = e.cid * 100 + k, nid = Number(id) * 100 + k, pod = base.pods[e.cid];
  big.entries[nid] = { ...e, cid };
  big.pods[cid] = { ...pod, rosters: Object.fromEntries(Object.entries(pod.rosters).map(([rk, ro]) => [String(rk) === String(id) ? nid : rk, ro])) };
}
const teams = Object.keys(big.entries).length, rosters = Object.values(big.pods).reduce((s, p) => s + Object.keys(p.rosters).length, 0);
const weeks = []; for (let w = 1; w < week; w++) weeks.push([w, f.past[0]?.[1] ?? new Map()]); // every finished week reuses week 1's real stats
const mb = () => { globalThis.gc?.(); return Math.round(process.memoryUsage().heapUsed / 1e6); };
const time = (fn) => { const m0 = mb(), t = Date.now(); const out = fn(); return { out, ms: Date.now() - t, mb: Math.round(process.memoryUsage().heapUsed / 1e6) - m0 }; };

console.log(`${teams.toLocaleString()} teams · ${rosters.toLocaleString()} rosters · NFL week ${week}`);
const fold = time(() => foldWeeks(big, weeks));
const old = time(() => computeSnapshot(big, f.rows, f.espn, Date.now(), { week, prior: fold.out.prior, weekly: fold.out.weekly }));
console.log(`OLD, every minute:  fold ${weeks.length} finished weeks ${fold.ms} ms + full snapshot ${old.ms} ms = ${fold.ms + old.ms} ms · ~${fold.mb + old.mb} MB extra memory`);
const prior = fold.out.prior; fold.out = null; old.out = null;
const lean = time(() => computeSnapshot(big, f.rows, f.espn, Date.now(), { week, prior, lean: true }));
console.log(`NEW, every minute:  current week only, standings only ${lean.ms} ms · ~${lean.mb} MB extra memory`);
console.log(`NEW, once per finished week (and a slice of it daily for stat corrections): ${fold.ms} ms`);
const same = Object.keys(lean.out.pods).length === Object.keys(big.pods).length;
console.log(`pods scored: ${Object.keys(lean.out.pods).length.toLocaleString()} ${same ? "(all)" : "(MISSING SOME)"} · stored finished-week totals ≈ ${(JSON.stringify(prior).length / 1e6).toFixed(0)} MB in the database`);
