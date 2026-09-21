// A contest that starts mid-season must only count points from its start week (pods[cid].from).
// Re-scores one account's real pods three ways and compares:  node scripts/check-start-week.mjs [dk username]
import { connect, loadEnv } from "./db.mjs";
import { buildBase } from "../lib/base.js";
import { getFeeds } from "../lib/feeds.js";
import { computeSnapshot, foldWeeks } from "../lib/pubscore.js";

process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const db = await connect();
const key = (await db.query("select user_key from dk_accounts where lower(username) = lower($1)", [process.argv[2] ?? "ZBbih"])).rows[0].user_key;
const base = structuredClone(await buildBase(db, [key]));
const f = await getFeeds();
await db.end();

const score = (b) => { const past = foldWeeks(b, f.past); return computeSnapshot(b, f.rows, f.espn, Date.now(), { week: f.week, prior: past.prior, weekly: past.weekly }); };
const [cid, other] = Object.keys(base.pods);
const total = (snap, c) => snap.pods[c].reduce((s, r) => s + r[3], 0);
const checks = [];
const ok = (name, cond, extra = "") => { checks.push(cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };

const normal = score(base);
ok("every stored contest starts in week 1", Object.values(base.pods).every((p) => p.from === 1), `week now ${f.week}`);

const late = structuredClone(base); late.pods[cid].from = f.week; // starts THIS week: only this week counts
const s2 = score(late);
const wkOnly = normal.pods[cid].map((r) => [r[0], normal.weekly.teams[cid][r[0]].t.at(-1)]);
ok("start = this week → season total is this week's score only", wkOnly.every(([k, w]) => Math.abs(s2.pods[cid].find((r) => r[0] === k)[3] - w) < 0.005),
  `pod total ${total(normal, cid).toFixed(2)} → ${total(s2, cid).toFixed(2)}`);
ok("earlier weeks show 0 in its week-by-week strip", Object.values(s2.weekly.teams[cid]).every((t) => t.t.slice(0, -1).every((x) => x === 0)));
ok("other pods are untouched", other == null || Math.abs(total(s2, other) - total(normal, other)) < 0.005);

const future = structuredClone(base); future.pods[cid].from = f.week + 1; // starts NEXT week (like a Thursday start)
const s3 = score(future);
ok("start = next week → everyone on 0.00 for now", s3.pods[cid].every((r) => r[3] === 0), `pod total ${total(s3, cid).toFixed(2)}`);

console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
