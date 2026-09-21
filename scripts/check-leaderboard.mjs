// Leaderboard filters + player stats straight from the lib (no HTTP), with invariants checked.
//   node scripts/check-leaderboard.mjs [player name]
import { connect, loadEnv } from "./db.mjs";
import { leaderboard, playersView, searchPlayers, usersView } from "../lib/leaderboard.js";

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
// two players at once = teams that have BOTH
const [a, b2] = [(await searchPlayers(db, "jaxon smith"))[0], (await searchPlayers(db, "brock bowers"))[0]];
const [onlyA, onlyB, both] = [await leaderboard(db, { p: a.id, limit: 200 }), await leaderboard(db, { p: b2.id, limit: 200 }), await leaderboard(db, { p: `${a.id},${b2.id}`, limit: 200 })];
const idsB = new Set(onlyB.rows.map((r) => r.id)), expect = onlyA.rows.filter((r) => idsB.has(r.id)).map((r) => r.id).sort().join();
ok("two players = intersection of each one's teams", both.rows.map((r) => r.id).sort().join() === expect && both.filter.p.length === 2 && both.stats.field === all.teams,
  `${a.name} ${onlyA.total} · ${b2.name} ${onlyB.total} · both ${both.total} (advancing ${both.stats.advancing})`);
ok("order of the ids does not matter; junk ids are ignored", (await leaderboard(db, { p: `${b2.id}, ${a.id},abc,-4` })).total === both.total);
const page2 = await leaderboard(db, { offset: 100, limit: 50 });
ok("paging", page2.rows[0]?.n === 101 && page2.rows.length === 50 && page2.rows[0].id === all.rows[100].id);

// columns, sorting, advancing-only
const byGap = await leaderboard(db, { sort: "gap", dir: "desc", limit: 200 });
const gaps = byGap.rows.map((r) => r.gap).filter((g) => g != null);
ok("sort by gap: biggest cushion first, and the sign matches advancing / out", gaps.every((g, i) => i === 0 || gaps[i - 1] >= g) && byGap.rows.every((r) => r.gap == null || r.adv == null || (r.adv ? r.gap >= 0 : r.gap <= 0)), `best +${gaps[0]}, worst ${gaps.at(-1)}`);
const byDate = await leaderboard(db, { sort: "date", dir: "asc", limit: 5 });
ok("sort by draft date ascending", byDate.rows.every((r, i) => i === 0 || byDate.rows[i - 1].date <= r.date), byDate.rows[0].date?.slice(0, 10));
const advOnly = await leaderboard(db, { adv: "1", limit: 200 });
ok("advancing-only filter", advOnly.total === all.stats.advancing && advOnly.rows.every((r) => r.adv === true), `${advOnly.total} teams`);
ok("rows carry players left", all.rows.every((r) => r.left == null || (r.left >= 0 && r.left <= 20)));

// players view
const pv = await playersView(db, { limit: 200 });
const jsn = pv.rows.find((r) => r.id === a.id);
ok("players view agrees with the player filter", jsn && jsn.teams === onlyA.total && jsn.advancing === onlyA.stats.advancing, `${jsn?.name}: ${jsn?.teams} teams, own ${jsn?.own}%, adv ${jsn?.advRate}%, avg pick ${jsn?.avgPick}`);
ok("players view: sorted by teams, ownership = teams / field", pv.rows.every((r, i) => i === 0 || pv.rows[i - 1].teams >= r.teams) && pv.rows.every((r) => Math.abs(r.own - 100 * r.teams / pv.stats.field) < 0.01), `${pv.total} players`);
const qbs = await playersView(db, { pos: "QB", sort: "advRate", dir: "desc", limit: 50 });
ok("players view: position filter + sort by advance rate", qbs.rows.every((r) => r.pos === "QB") && qbs.rows.filter((r) => r.advRate != null).every((r, i, l) => i === 0 || l[i - 1].advRate >= r.advRate), `${qbs.total} QBs, top ${qbs.rows[0]?.name} ${qbs.rows[0]?.advRate}%`);
const pvU = await playersView(db, { u: "fleaflick" });
ok("players view within one username", pvU.stats.field === 10 && pvU.rows.every((r) => r.teams <= 10));

// users view
const uv = await usersView(db, {});
const kk = uv.rows.find((r) => r.user === "kknox20");
ok("users view: one row per account, totals add up", uv.total === all.accounts && uv.rows.reduce((s, r) => s + r.teams, 0) === all.teams, uv.rows.map((r) => `${r.user} ${r.teams} teams $${r.buyIns} ${r.advancing} adv`).join(" | "));
ok("users view: best team = that user's top leaderboard row", kk && kk.best === (await leaderboard(db, { u: "kknox20", limit: 1 })).rows[0].points, `kknox20 best ${kk?.best}`);

await db.end();
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
