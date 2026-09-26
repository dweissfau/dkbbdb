// Leaderboard filters + player stats straight from the lib (no HTTP), with invariants checked.
//   node scripts/check-leaderboard.mjs [player name]
import { connect, loadEnv } from "./db.mjs";
import { leaderboard, playersView, searchPlayers, searchUsers } from "../lib/leaderboard.js";

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
// the profile page's header comes with the same response
const P = byU.profile;
ok("profile for a username: teams, buy-ins, split, tournaments, best team", P && P.user === "fleaflick" && P.teams === 10 && P.buyIn === byU.rows.reduce((s, r) => s + (r.buyIn ?? 0), 0)
  && P.tournaments.reduce((s, t) => s + t.teams, 0) === 10 && P.advancing + P.out + P.unranked === 10 && P.advBuyIn === byU.rows.filter((r) => r.adv).reduce((s, r) => s + r.buyIn, 0) && P.advBuyIn <= P.buyIn && P.best.points === Math.max(...byU.rows.map((r) => r.points)) && byU.rows.some((r) => r.id === P.best.id),
  `${P?.teams} teams · $${P?.buyIn} · advancing ${P?.advancing}, out ${P?.out}, not started ${P?.unranked} · best ${P?.best?.points} (${P?.best?.contest})`);
ok("profile ignores the tournament filter and is null without a username", (await playersView(db, { u: "fleaflick", t: P.tournaments[0].name })).profile.teams === 10 && all.profile === null);
ok("unknown username → empty profile", (await leaderboard(db, { u: "nobody-xyz" })).profile.teams === 0);

const found = await searchPlayers(db, process.argv[2] ?? "justin jefferson");
const mineOnly = await searchPlayers(db, "on", "fleaflick");
ok("player search within one account: only his players, counted over his teams", mineOnly.length > 0 && mineOnly.every((r) => r.teams >= 1 && r.teams <= 10) && (await searchPlayers(db, "zzzz", "fleaflick")).length === 0, `${mineOnly.length} hits, top ${mineOnly[0]?.name} on ${mineOnly[0]?.teams}`);
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
// every row, not one page: a popular player is on more than 200 teams now
const allRows = async (q) => { const first = await leaderboard(db, { ...q, limit: 200 }); let rows = first.rows; while (rows.length < first.total) rows = rows.concat((await leaderboard(db, { ...q, limit: 200, offset: rows.length })).rows); return { ...first, rows }; };
const [onlyA, onlyB, both] = [await allRows({ p: a.id }), await allRows({ p: b2.id }), await allRows({ p: `${a.id},${b2.id}` })];
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
ok("players view: sorted by buy-ins, ownership = teams / field", pv.rows.every((r, i) => i === 0 || pv.rows[i - 1].buyIn >= r.buyIn) && pv.rows.every((r) => Math.abs(r.own - 100 * r.teams / pv.stats.field) < 0.01) && pv.rows.every((r) => r.buyIn >= 0), `${pv.total} players, top ${pv.rows[0]?.name} ${pv.rows[0]?.buyIn} on ${pv.rows[0]?.teams} teams`);
const pvF = await playersView(db, { u: "fleaflick", limit: 200 });
ok("players view: a player's buy-ins = the buy-ins of the teams that have him", pvF.rows.every((r) => r.buyIn === r.teams * 555), `fleaflick: ${pvF.rows[0]?.name} ${pvF.rows[0]?.buyIn} / ${pvF.rows[0]?.teams} teams`);
const qbs = await playersView(db, { pos: "QB", sort: "advRate", dir: "desc", limit: 50 });
ok("players view: position filter + sort by advance rate", qbs.rows.every((r) => r.pos === "QB") && qbs.rows.filter((r) => r.advRate != null).every((r, i, l) => i === 0 || l[i - 1].advRate >= r.advRate), `${qbs.total} QBs, top ${qbs.rows[0]?.name} ${qbs.rows[0]?.advRate}%`);
const pvU = await playersView(db, { u: "fleaflick" });
ok("players view within one username", pvU.stats.field === 10 && pvU.rows.every((r) => r.teams <= 10));

// ticked teams: only= keeps just those entry ids, hide= drops them — both views, tiles (scope) follow, the profile does not
const tk = byU.rows.slice(0, 3).map((r) => r.id);
const onlyT = await leaderboard(db, { u: "fleaflick", only: tk.join(","), withIds: "1" });
ok("only=: just the ticked teams, their ids listed, scope follows, profile stays whole", onlyT.total === 3 && onlyT.rows.every((r) => tk.includes(r.id)) && onlyT.ids?.length === 3 && onlyT.scope.teams === 3 && onlyT.filter.ticks.only === 3 && onlyT.profile.teams === 10, `${onlyT.total} teams, ids ${onlyT.ids?.length}`);
const hideT = await leaderboard(db, { u: "fleaflick", hide: tk.join(",") });
ok("hide=: everything but the ticked teams", hideT.total === 7 && hideT.rows.every((r) => !tk.includes(r.id)) && hideT.filter.ticks.hide === 3 && hideT.ids === undefined, `${hideT.total} teams`);
const pvOnly = await playersView(db, { u: "fleaflick", only: tk.join(","), limit: 200 });
ok("players view over the ticked teams: exposure is out of 3", pvOnly.stats.field === 3 && pvOnly.rows.every((r) => r.teams <= 3 && Math.abs(r.own - 100 * r.teams / 3) < 0.01) && pvOnly.scope.teams === 3, `${pvOnly.total} players, top ${pvOnly.rows[0]?.name} on ${pvOnly.rows[0]?.teams}`);
const foreign = all.rows.find((r) => r.user !== "fleaflick");
ok("junk ids = no filter; another account's ids match nothing", (await leaderboard(db, { u: "fleaflick", only: "abc,-1" })).total === 10 && (await leaderboard(db, { u: "fleaflick", only: String(foreign.id) })).total === 0 && (await leaderboard(db, { u: "fleaflick", hide: String(foreign.id) })).total === 10);
ok("only= combines with the tournament filter", (await leaderboard(db, { u: "fleaflick", t: byU.rows[0].contest, only: tk.join(",") })).total === tk.filter((id) => byU.rows.find((r) => r.id === id).contest === byU.rows[0].contest).length);

// ---- the leaderboard page's menus and the excluded-players filter ----
ok("users list: every synced account, counts add up to every team", all.users.length >= 2 && all.users.reduce((s2, x) => s2 + x.teams, 0) === all.teams && all.users.some((x) => x.name === "fleaflick" && x.teams === 10), all.users.map((x) => `${x.name}: ${x.teams}`).join(" | "));
const byX = await leaderboard(db, { x: p.id, limit: 200 });
ok("x=: teams WITHOUT the player = every team minus the teams with him", byX.total === all.teams - byP.total && byX.filter.x.length === 1 && byX.filter.x[0].id === p.id && byX.filter.p.length === 0, `${byX.total} without ${p.name}`);
ok("a player on both lists is only wanted, not excluded", (await leaderboard(db, { p: p.id, x: p.id })).total === byP.total);
const px = await leaderboard(db, { p: p.id, x: b2.id, limit: 200 }), pAndB = await leaderboard(db, { p: `${p.id},${b2.id}` });
ok("p= and x= combine: teams with A that do not have B", px.total === byP.total - pAndB.total && px.filter.x[0].id === b2.id, `${px.total} teams with ${p.name} and not ${b2.name}`);
const pvX = await playersView(db, { x: p.id, limit: 200 });
ok("players view without him: he is gone, ownership is out of the teams without him", pvX.stats.field === byX.total && !pvX.rows.some((r) => r.id === p.id) && pvX.rows.every((r) => Math.abs(r.own - 100 * r.teams / byX.total) < 0.01), `${pvX.total} players over ${pvX.stats.field} teams`);
const pvP = await playersView(db, { p: p.id, limit: 200 });
ok("players view with him: 100% ownership, field = his teams", pvP.stats.field === byP.total && pvP.rows.find((r) => r.id === p.id)?.own === 100 && pvP.filter.p[0].id === p.id);
const inT = await searchPlayers(db, p.name, "", t);
ok("player search within a tournament counts that tournament's teams", inT.length >= 1 && inT[0].teams === (await leaderboard(db, { t, p: p.id })).total && inT[0].teams <= p.teams, `${inT[0]?.name}: ${inT[0]?.teams} in ${t}`);

const su = await searchUsers(db, "KK"), suT = await searchUsers(db, "kk", t);
ok("user search: part of a name, any case, team counts; scoped to a tournament", su[0]?.username === "kknox20" && su[0].teams === 193 && suT[0]?.username === "kknox20" && suT[0].teams === (await leaderboard(db, { u: "kknox20", t })).total && (await searchUsers(db, "")).length === 0, `${su.map((x) => x.username).join(", ")} · in ${t}: ${suT[0]?.teams}`);
await db.end();
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
