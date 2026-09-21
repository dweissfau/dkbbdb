// Leaderboard filters + player stats straight from the lib (no HTTP), with invariants checked.
//   node scripts/check-leaderboard.mjs [player name]
import { connect, loadEnv } from "./db.mjs";
import { leaderboard, searchPlayers } from "../lib/leaderboard.js";

process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const db = await connect();
const checks = [];
const ok = (name, cond, extra = "") => { checks.push(cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };

const all = await leaderboard(db, { limit: 200 });
ok("all teams, sorted by season points", all.live && all.rows.every((r, i) => i === 0 || all.rows[i - 1].points >= r.points), `${all.total} teams, top ${all.rows[0]?.points}`);
ok("tournament counts add up to every team", all.tournaments.reduce((s, t) => s + t.teams, 0) === all.teams, all.tournaments.map((t) => `${t.name}: ${t.teams}`).join(" | "));

const t = all.tournaments[0].name;
const byT = await leaderboard(db, { t, limit: 200 });
ok("tournament filter", byT.total === all.tournaments[0].teams && byT.rows.every((r) => r.contest === t), `${t}: ${byT.total}`);

const byU = await leaderboard(db, { u: "FLEAFLICK" });
ok("username filter (case-insensitive)", byU.total === 10 && byU.rows.every((r) => r.user === "fleaflick"), `${byU.total} teams, filter.u = ${byU.filter.u}`);

const found = await searchPlayers(db, process.argv[2] ?? "justin jefferson");
ok("player suggestions", found.length >= 1, JSON.stringify(found.slice(0, 3)));
const p = found[0];
const byP = await leaderboard(db, { p: p.id, limit: 200 });
ok("player filter: count = suggestion's team count", byP.total === p.teams && byP.stats.count === p.teams, `${p.name}: ${byP.stats.count} of ${byP.stats.field} teams`);
ok("player stats are consistent", byP.stats.advancing <= byP.stats.count && byP.stats.field === all.teams && byP.stats.advancing === byP.rows.filter((r) => r.adv).length + 0 * byP.total,
  `ownership ${(100 * byP.stats.count / byP.stats.field).toFixed(1)}% · advancing ${byP.stats.advancing} · advance rate ${(100 * byP.stats.advancing / byP.stats.ranked).toFixed(1)}% (all teams ${(100 * byP.stats.fieldAdvancing / byP.stats.fieldRanked).toFixed(1)}%)`);
const combo = await leaderboard(db, { p: p.id, u: "kknox20", t });
ok("filters combine (player within username + tournament)", combo.stats.field === (await leaderboard(db, { u: "kknox20", t })).total && combo.total <= byP.total, `${combo.total} of ${combo.stats.field}`);
const page2 = await leaderboard(db, { offset: 100, limit: 50 });
ok("paging", page2.rows[0]?.n === 101 && page2.rows.length === 50 && page2.rows[0].id === all.rows[100].id);

await db.end();
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
