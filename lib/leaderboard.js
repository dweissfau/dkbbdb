// Site-wide season leaderboard for the front page: every synced team, scored exactly like the team pop-up
// (same base → computeSnapshot path), with two views over the same list:
//   teams    the leaderboard itself        filters: tournament, username, players (all of them), advancing only
//   players  every drafted player          teams with him, ownership, advance rate, average pick
// All teams are computed once and cached per instance (60 s); each request filters / sorts that list in memory.
// Fine for thousands of teams — beyond that it should move to a table refreshed by a cron.
import { computeSnapshot, foldWeeks } from "./pubscore.js";
import { buildBase } from "./base.js";
import { getFeeds } from "./feeds.js";

const TTL = 60e3;
let cache = null; // { at, board }
const r2 = (x) => Math.round(x * 100) / 100;

// contest name as shown on the site: "NFL Best Ball $20M Millionaire [$3M to 1st] (Tournament)" → "$20M Millionaire [$3M to 1st]"
export const shortContest = (name) => String(name ?? "").replace(/^NFL Best Ball\s+/i, "").replace(/\s*\(Tournament\)\s*$/i, "").trim();
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// points between a team and the cut line of its league: advancing → cushion over the best team outside (+),
// outside → distance to the last team inside (−). pod rows = [key, name, rank, points, minutesLeft]
function gapToLine(pod, row, pp) {
  if (pp == null || row[2] == null || pod.length <= pp) return null;
  const inside = pod.filter((r) => r[2] != null && r[2] <= pp), outside = pod.filter((r) => r[2] != null && r[2] > pp);
  if (row[2] <= pp) return outside.length ? r2(row[3] - Math.max(...outside.map((r) => r[3]))) : null;
  return inside.length ? r2(row[3] - Math.min(...inside.map((r) => r[3]))) : null;
}

async function board(db, now) {
  if (cache && now - cache.at < TTL) return cache.board;
  const accounts = (await db.query("select user_key, username from dk_accounts")).rows;
  const nameOf = new Map(accounts.map((a) => [a.user_key, a.username]));
  const [base, f] = await Promise.all([buildBase(db, accounts.map((a) => a.user_key), now), getFeeds(now)]);
  if (!f.ok) return cache?.board ?? { live: false, reason: f.error ?? "public feeds unavailable" };

  const past = foldWeeks(base, f.past);
  const snap = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
  const meta = new Map((await db.query(
    `select e.entry_id, e.user_key, c.name, c.buy_in, c.draft_date, t.draftable_ids, t.pick_numbers
       from entries e join contests c on c.contest_id = e.contest_id
       left join pod_teams t on t.contest_id = e.contest_id and t.user_key = e.user_key`)).rows.map((r) => [String(r.entry_id), r]));

  const teams = [], players = new Map(); // pid → { id, name, pos, team, key }
  for (const [id, e] of Object.entries(base.entries)) {
    const pod = snap.pods[e.cid]; if (!pod) continue;
    const row = pod.find((r) => r[0] === Number(id)); if (!row) continue;
    const m = meta.get(id), dg = base.draftables[e.dgid] ?? {}, picks = new Map(); // pid → overall pick
    (m?.draftable_ids ?? []).forEach((did, i) => {
      const d = dg[did]; if (!d || d[0] == null) return;
      picks.set(d[0], m.pick_numbers?.[i] ?? null);
      if (!players.has(d[0])) players.set(d[0], { id: d[0], name: d[1], pos: d[2], team: d[3], key: norm(d[1]) });
    });
    const started = (base.pods[e.cid]?.from ?? 1) <= snap.week; // a contest that has not started has everyone tied on 0
    teams.push({ id, user: nameOf.get(m?.user_key) ?? row[1], contest: shortContest(m?.name), buyIn: m?.buy_in == null ? null : Number(m.buy_in),
      date: m?.draft_date ? new Date(m.draft_date).toISOString() : null, points: row[3], rank: row[2], entrants: pod.length,
      left: row[4] == null ? null : Math.round(row[4] / 60), // players still to play this week
      adv: !started ? null : e.pp != null && row[2] != null ? row[2] <= e.pp : null, gap: started ? gapToLine(pod, row, e.pp) : null, picks });
  }
  teams.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  const out = { live: true, at: snap.at, week: snap.week, playing: snap.live, accounts: accounts.length, teams, players };
  cache = { at: now, board: out };
  return out;
}

const advOf = (list) => list.filter((x) => x.adv === true).length, rankedOf = (list) => list.filter((x) => x.adv != null).length;
const page = (list, offset, limit, max = 200) => { const from = Math.max(0, Number(offset) || 0), n = Math.min(max, Math.max(1, Number(limit) || 100)); return { from, rows: list.slice(from, from + n) }; };
// sort by a column; nulls always last; ties keep the order of the list handed in
function sortBy(list, key, dir, allowed, fallback) {
  const k = allowed.includes(key) ? key : fallback, sign = dir === "asc" ? 1 : -1;
  const val = (x) => (k === "date" ? (x.date ? Date.parse(x.date) : null) : x[k]);
  return { key: k, dir: sign === 1 ? "asc" : "desc", list: [...list].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null || vb == null) return (va == null) - (vb == null);
    return typeof va === "string" ? sign * va.localeCompare(vb) : sign * (va - vb);
  }) };
}
function common(b) {
  const tournaments = new Map();
  for (const x of b.teams) tournaments.set(x.contest, (tournaments.get(x.contest) ?? 0) + 1);
  return { live: true, at: b.at, week: b.week, playing: b.playing, accounts: b.accounts, teams: b.teams.length,
    tournaments: [...tournaments.entries()].sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, teams: count })) };
}
const fieldOf = (b, t, u) => { const user = String(u ?? "").trim().toLowerCase(); return { user, field: b.teams.filter((x) => (!t || x.contest === t) && (!user || x.user?.toLowerCase() === user)) }; };

// ---- teams ----  filters: t = tournament (short contest name), u = DraftKings username, p = DK player id(s) "id,id"
// (a team must have ALL of them), adv = "1" advancing only; sort = points | gap | left | date | buyIn | rank | user
export async function leaderboard(db, { t = "", u = "", p = "", adv = "", sort = "points", dir = "desc", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b = await board(db, now);
  if (!b.live) return b;
  const pls = [...new Set(String(p ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))]
    .slice(0, 5).map((id) => b.players.get(id)).filter(Boolean);
  // the field = teams in the chosen tournament / username; the player filter narrows it and is measured against it
  const { user, field } = fieldOf(b, t, u);
  const withPlayers = pls.length ? field.filter((x) => pls.every((pl) => x.picks.has(pl.id))) : field;
  const shown = String(adv) === "1" ? withPlayers.filter((x) => x.adv === true) : withPlayers;
  const s = sortBy(shown, sort, dir, ["points", "gap", "left", "date", "buyIn", "rank", "user"], "points");
  const { from, rows } = page(s.list, offset, limit);
  return {
    ...common(b), view: "teams", sort: s.key, dir: s.dir,
    filter: { t: t || null, u: user ? (field[0]?.user ?? u) : null, adv: String(adv) === "1", p: pls.map((pl) => ({ id: pl.id, name: pl.name, pos: pl.pos, team: pl.team })) },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field), count: withPlayers.length, advancing: advOf(withPlayers), ranked: rankedOf(withPlayers) },
    total: shown.length, offset: from,
    rows: rows.map((x, i) => ({ n: from + i + 1, id: x.id, user: x.user, contest: x.contest, buyIn: x.buyIn, date: x.date, points: x.points, rank: x.rank, entrants: x.entrants, adv: x.adv, gap: x.gap, left: x.left })),
  };
}

// ---- players ----  within the field (t, u): pos = QB | RB | WR | TE; sort = teams | own | advRate | advancing | avgPick | name
export async function playersView(db, { t = "", u = "", pos = "", sort = "teams", dir = "desc", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b = await board(db, now);
  if (!b.live) return b;
  const { user, field } = fieldOf(b, t, u);
  const acc = new Map(); // pid → { n, adv, ranked, pickSum, pickN }
  for (const x of field) for (const [pid, pick] of x.picks) {
    const a = acc.get(pid) ?? { n: 0, adv: 0, ranked: 0, pickSum: 0, pickN: 0 };
    a.n++; if (x.adv != null) { a.ranked++; if (x.adv) a.adv++; }
    if (pick != null) { a.pickSum += pick; a.pickN++; }
    acc.set(pid, a);
  }
  const P = /^(QB|RB|WR|TE)$/.test(pos) ? pos : "";
  const list = [...acc.entries()].map(([pid, a]) => { const pl = b.players.get(pid); return { id: pid, name: pl.name, pos: pl.pos, team: pl.team, teams: a.n,
    own: field.length ? r2(100 * a.n / field.length) : 0, advancing: a.adv, advRate: a.ranked ? r2(100 * a.adv / a.ranked) : null, avgPick: a.pickN ? Math.round(10 * a.pickSum / a.pickN) / 10 : null }; })
    .filter((x) => !P || x.pos === P).sort((x, y) => y.teams - x.teams || x.name.localeCompare(y.name));
  const s = sortBy(list, sort, dir, ["teams", "own", "advRate", "advancing", "avgPick", "name"], "teams");
  const { from, rows } = page(s.list, offset, limit);
  return { ...common(b), view: "players", sort: s.key, dir: s.dir, filter: { t: t || null, u: user ? (field[0]?.user ?? u) : null, pos: P || null },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field) }, total: list.length, offset: from,
    rows: rows.map((x, i) => ({ n: from + i + 1, ...x })) };
}

// player suggestions: rostered players whose name contains every typed word, most-owned first
export async function searchPlayers(db, q, now = Date.now()) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const b = await board(db, now);
  if (!b.live) return [];
  const count = new Map();
  for (const x of b.teams) for (const pid of x.picks.keys()) count.set(pid, (count.get(pid) ?? 0) + 1);
  return [...b.players.values()].filter((p) => words.every((w) => p.key.includes(w))).sort((x, y) => (count.get(y.id) ?? 0) - (count.get(x.id) ?? 0)).slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, teams: count.get(p.id) ?? 0 }));
}
