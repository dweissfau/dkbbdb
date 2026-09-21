// Site-wide season leaderboard for the front page: every synced team, scored exactly like the portfolio pages
// (same base → computeSnapshot path), filterable by tournament, DraftKings username and player.
//   all teams are computed once and cached per instance (60 s); each request filters that list in memory.
//   Fine for thousands of teams — beyond that it should move to a table refreshed by a cron.
import { computeSnapshot, foldWeeks } from "./pubscore.js";
import { buildBase } from "./base.js";
import { getFeeds } from "./feeds.js";

const TTL = 60e3;
let cache = null; // { at, board }

// contest name as shown on the site: "NFL Best Ball $20M Millionaire [$3M to 1st] (Tournament)" → "$20M Millionaire [$3M to 1st]"
export const shortContest = (name) => String(name ?? "").replace(/^NFL Best Ball\s+/i, "").replace(/\s*\(Tournament\)\s*$/i, "").trim();
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function board(db, now) {
  if (cache && now - cache.at < TTL) return cache.board;
  const accounts = (await db.query("select user_key, username from dk_accounts")).rows;
  const nameOf = new Map(accounts.map((a) => [a.user_key, a.username]));
  const [base, f] = await Promise.all([buildBase(db, accounts.map((a) => a.user_key), now), getFeeds(now)]);
  if (!f.ok) return cache?.board ?? { live: false, reason: f.error ?? "public feeds unavailable" };

  const past = foldWeeks(base, f.past);
  const snap = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
  const meta = new Map((await db.query(
    `select e.entry_id, e.user_key, c.name, c.buy_in from entries e join contests c on c.contest_id = e.contest_id`)).rows.map((r) => [String(r.entry_id), r]));

  const teams = [], players = new Map(); // pid → { id, name, pos, team, n }
  for (const [id, e] of Object.entries(base.entries)) {
    const pod = snap.pods[e.cid]; if (!pod) continue;
    const row = pod.find((r) => r[0] === Number(id)); if (!row) continue;
    const m = meta.get(id), dg = base.draftables[e.dgid] ?? {}, pids = new Set();
    for (const did of base.pods[e.cid]?.rosters?.[id]?.d ?? []) {
      const d = dg[did]; if (!d || d[0] == null) continue;
      pids.add(d[0]);
      const p = players.get(d[0]) ?? { id: d[0], name: d[1], pos: d[2], team: d[3], n: 0, key: norm(d[1]) };
      p.n++; players.set(d[0], p);
    }
    teams.push({ id, user: nameOf.get(m?.user_key) ?? row[1], contest: shortContest(m?.name), buyIn: m?.buy_in == null ? null : Number(m.buy_in),
      points: row[3], rank: row[2], entrants: pod.length,
      // a contest that has not started yet has everyone tied on 0: nobody is "advancing"
      adv: (base.pods[e.cid]?.from ?? 1) > snap.week ? null : e.pp != null && row[2] != null ? row[2] <= e.pp : null, pids });
  }
  teams.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  const out = { live: true, at: snap.at, week: snap.week, playing: snap.live, accounts: accounts.length, teams, players };
  cache = { at: now, board: out };
  return out;
}

// filters: t = tournament (short contest name), u = DraftKings username, p = DK player id(s), comma-separated
export async function leaderboard(db, { t = "", u = "", p = "", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b = await board(db, now);
  if (!b.live) return b;
  const tournaments = new Map();
  for (const x of b.teams) tournaments.set(x.contest, (tournaments.get(x.contest) ?? 0) + 1);

  const user = String(u).trim().toLowerCase();
  // p = one player id or several ("id,id", at most 5): a team must have ALL of them (a stack / combo)
  const pls = [...new Set(String(p ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))]
    .slice(0, 5).map((id) => b.players.get(id)).filter(Boolean);
  // the field = teams in the chosen tournament / username; the player filter narrows it and is measured against it
  const field = b.teams.filter((x) => (!t || x.contest === t) && (!user || x.user?.toLowerCase() === user));
  const rows = pls.length ? field.filter((x) => pls.every((pl) => x.pids.has(pl.id))) : field;
  const advOf = (list) => list.filter((x) => x.adv === true).length, rankedOf = (list) => list.filter((x) => x.adv != null).length;
  const from = Math.max(0, Number(offset) || 0), n = Math.min(200, Math.max(1, Number(limit) || 100));

  return {
    live: true, at: b.at, week: b.week, playing: b.playing, accounts: b.accounts, teams: b.teams.length,
    tournaments: [...tournaments.entries()].sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, teams: count })),
    filter: { t: t || null, u: user ? (field[0]?.user ?? u) : null, p: pls.map((pl) => ({ id: pl.id, name: pl.name, pos: pl.pos, team: pl.team })) },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field),
      count: rows.length, advancing: advOf(rows), ranked: rankedOf(rows) },
    total: rows.length, offset: from,
    rows: rows.slice(from, from + n).map((x, i) => ({ n: from + i + 1, id: x.id, user: x.user, contest: x.contest, buyIn: x.buyIn, points: x.points, rank: x.rank, entrants: x.entrants, adv: x.adv })),
  };
}

// player suggestions: rostered players whose name contains every typed word, most-owned first
export async function searchPlayers(db, q, now = Date.now()) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const b = await board(db, now);
  if (!b.live) return [];
  return [...b.players.values()].filter((p) => words.every((w) => p.key.includes(w))).sort((x, y) => y.n - x.n).slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, teams: p.n }));
}
