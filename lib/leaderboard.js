// Site-wide season leaderboard for the front page: every synced team, scored exactly like the team pop-up
// (same base → computeSnapshot arithmetic), with two views over the same list:
//   teams    the leaderboard itself        filters: tournament, username, players (all of them), advancing only
//   players  every drafted player          teams with him, ownership, advance rate, average pick
//
// Built for thousands of teams (measured on a synthetic 5,150-team site — see scripts/bench-board.mjs):
//   • the board is scored ONCE for everybody and stored (board_cache); requests read the stored copy. The first
//     request to find it older than a minute takes a row lock and refreshes it (about 0.1 s today, 1–2 s at
//     5,000 teams); everyone else meanwhile keeps getting the stored copy. So the cost is one run a minute however
//     many people are watching, and nothing runs when nobody is. (Refreshing after the response, via waitUntil, was
//     tried first: the platform froze the instance and the run only finished when the next visitor arrived.)
//   • finished weeks come from pod_prior (lib/prior.js), so a run scores the current week only;
//   • the run uses computeSnapshot's lean mode (standings only, no per-player cards).
// Each request then filters / sorts the in-memory list.
import { computeSnapshot } from "./pubscore.js";
import { priorFor } from "./prior.js";
import { buildBase } from "./base.js";
import { getFeeds } from "./feeds.js";

const FRESH_MS = 60e3;      // a stored board older than this is refreshed by the request that notices
const MEM_MS = 15e3;        // how long an instance trusts its in-memory copy without asking the database
let mem = null;             // { loadedAt, at, board }
// Rosters never change after a draft, so the run keeps everything it read about them (every pod, every pick)
// in this instance's memory and only re-reads it when a sync has changed the data — otherwise a 5,000-team site
// would pull ~20 MB out of the database every minute just to find that nothing moved.
let rosterCache = null;     // { fp, at, accounts, base, meta }
const ROSTERS_MAX_MS = 6 * 3600e3;
async function rosters(db, now) {
  const r = (await db.query(`select (select count(*) from entries) e, (select max(synced_at) from entries) s, (select count(*) from pod_teams) t, (select count(*) from sleeper_map) m`)).rows[0];
  const fp = `${r.e}|${r.s?.toISOString?.() ?? r.s}|${r.t}|${r.m}`;
  if (rosterCache && rosterCache.fp === fp && now - rosterCache.at < ROSTERS_MAX_MS) return rosterCache;
  const accounts = (await db.query("select user_key, username from dk_accounts")).rows;
  const base = await buildBase(db, accounts.map((a) => a.user_key), now);
  const meta = new Map((await db.query(
    `select e.entry_id, e.user_key, c.name, c.buy_in, c.draft_date, t.draftable_ids, t.pick_numbers
       from entries e join contests c on c.contest_id = e.contest_id
       left join pod_teams t on t.contest_id = e.contest_id and t.user_key = e.user_key`)).rows.map((x) => [String(x.entry_id), x]));
  return (rosterCache = { fp, at: now, accounts, base, meta });
}
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

// score every synced team → a plain JSON-able board
export async function computeBoard(db, now = Date.now()) {
  const [{ accounts, base, meta }, f] = await Promise.all([rosters(db, now), getFeeds(now)]);
  const nameOf = new Map(accounts.map((a) => [a.user_key, a.username]));
  if (!f.ok) return { live: false, reason: f.error ?? "public feeds unavailable" };

  const { prior, stats: priorStats } = await priorFor(db, base, f, now);
  const snap = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior, lean: true });

  const teams = [], players = new Map(); // pid → { id, name, pos, team, key }
  for (const [id, e] of Object.entries(base.entries)) {
    const pod = snap.pods[e.cid]; if (!pod) continue;
    const row = pod.find((r) => r[0] === Number(id)); if (!row) continue;
    const m = meta.get(id), dg = base.draftables[e.dgid] ?? {}, picks = []; // [[pid, overall pick], …]
    (m?.draftable_ids ?? []).forEach((did, i) => {
      const d = dg[did]; if (!d || d[0] == null) return;
      picks.push([d[0], m.pick_numbers?.[i] ?? null]);
      if (!players.has(d[0])) players.set(d[0], { id: d[0], name: d[1], pos: d[2], team: d[3], key: norm(d[1]) });
    });
    const started = (base.pods[e.cid]?.from ?? 1) <= snap.week; // a contest that has not started has everyone tied on 0
    teams.push({ id, user: nameOf.get(m?.user_key) ?? row[1], contest: shortContest(m?.name), buyIn: m?.buy_in == null ? null : Number(m.buy_in),
      date: m?.draft_date ? new Date(m.draft_date).toISOString() : null, points: row[3], rank: row[2], entrants: pod.length,
      left: row[4] == null ? null : Math.round(row[4] / 60), // players still to play this week
      adv: !started ? null : e.pp != null && row[2] != null ? row[2] <= e.pp : null, gap: started ? gapToLine(pod, row, e.pp) : null, picks });
  }
  teams.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  return { live: true, at: snap.at, week: snap.week, playing: snap.live, accounts: accounts.length, teams, players: [...players.values()], priorStats };
}

// stored form → the form the views use (picks and players as Maps)
const revive = (body) => ({ ...body, teams: body.teams.map((t) => ({ ...t, picks: new Map(t.picks) })), players: new Map(body.players.map((p) => [p.id, p])) });

// one full run: score, store, and keep it in this instance's memory
export async function refreshBoard(db, now = Date.now()) {
  const t0 = Date.now();
  const body = await computeBoard(db, now);
  if (!body.live) { await db.query("update board_cache set refreshing_at = null where id = 1"); return null; }
  const ms = Date.now() - t0;
  await db.query(
    `insert into board_cache (id, at, refreshing_at, ms, body) values (1, $1, null, $2, $3::jsonb)
     on conflict (id) do update set at = excluded.at, refreshing_at = null, ms = excluded.ms, body = excluded.body`, [body.at, ms, JSON.stringify(body)]);
  mem = { loadedAt: Date.now(), at: body.at, board: revive(body) };
  return mem.board;
}

// the board every request reads. force = refresh even if the stored copy is recent (scripts and tests)
async function board(db, now, force = process.env.DKBBDB_SYNC_BOARD === "1") {
  if (mem && Date.now() - mem.loadedAt < MEM_MS && !force) return mem.board;
  const head = (await db.query("select at, extract(epoch from (now() - at)) * 1000 age from board_cache where id = 1")).rows[0];
  if (!head) return (await refreshBoard(db, now)) ?? { live: false, reason: "public feeds unavailable" };
  const at = new Date(head.at).toISOString();
  if (mem?.at === at) mem.loadedAt = Date.now();
  else mem = { loadedAt: Date.now(), at, board: revive((await db.query("select body from board_cache where id = 1")).rows[0].body) };

  if (Number(head.age) > FRESH_MS || force) {
    // one refresh at a time, whoever asks: the lock expires after two minutes in case a run died.
    // Requests that do not get the lock answer from the stored copy straight away.
    const lock = await db.query(
      `update board_cache set refreshing_at = now() where id = 1 and (refreshing_at is null or refreshing_at < now() - interval '2 minutes') returning 1`);
    if (lock.rowCount) await refreshBoard(db, Date.now()).catch(() => db.query("update board_cache set refreshing_at = null where id = 1").catch(() => {}));
  }
  return mem.board;
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
  return { live: true, at: b.at, week: b.week, playing: b.playing, accounts: b.accounts, teams: b.teams.length, tournaments: tournamentsOf(b.teams) };
}
// mine = the username's teams before the tournament filter (the profile page lists that user's tournaments from it)
const fieldOf = (b, t, u) => { const user = String(u ?? "").trim().toLowerCase();
  const mine = user ? b.teams.filter((x) => x.user?.toLowerCase() === user) : b.teams;
  return { user, mine, field: mine.filter((x) => !t || x.contest === t) }; };
const tournamentsOf = (list) => { const m = new Map(); for (const x of list) m.set(x.contest, (m.get(x.contest) ?? 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, teams: count })); };
// the profile page's header numbers for a username: buy-ins, the split behind the advance rate, the best team
function profileOf(user, mine) {
  if (!user) return null;
  const best = mine.reduce((a, x) => (a == null || x.points > a.points ? x : a), null);
  return { user: mine[0]?.user ?? user, teams: mine.length, buyIn: mine.reduce((s, x) => s + (x.buyIn ?? 0), 0),
    advancing: advOf(mine), advBuyIn: mine.filter((x) => x.adv === true).reduce((s, x) => s + (x.buyIn ?? 0), 0), out: mine.filter((x) => x.adv === false).length, unranked: mine.filter((x) => x.adv == null).length,
    tournaments: tournamentsOf(mine),
    best: best ? { id: best.id, points: best.points, contest: best.contest, rank: best.rank, entrants: best.entrants, adv: best.adv, gap: best.gap } : null };
}

// ---- teams ----  filters: t = tournament (short contest name), u = DraftKings username, p = DK player id(s) "id,id"
// (a team must have ALL of them), adv = "1" advancing only; sort = points | gap | left | date | buyIn | rank | user
export async function leaderboard(db, { t = "", u = "", p = "", adv = "", sort = "points", dir = "desc", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b = await board(db, now);
  if (!b.live) return b;
  const pls = [...new Set(String(p ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))]
    .slice(0, 5).map((id) => b.players.get(id)).filter(Boolean);
  // the field = teams in the chosen tournament / username; the player filter narrows it and is measured against it
  const { user, mine, field } = fieldOf(b, t, u);
  const withPlayers = pls.length ? field.filter((x) => pls.every((pl) => x.picks.has(pl.id))) : field;
  const shown = String(adv) === "1" ? withPlayers.filter((x) => x.adv === true) : withPlayers;
  const s = sortBy(shown, sort, dir, ["points", "gap", "left", "date", "buyIn", "rank", "user", "contest"], "points");
  const { from, rows } = page(s.list, offset, limit);
  return {
    ...common(b), view: "teams", sort: s.key, dir: s.dir, profile: profileOf(user, mine),
    filter: { t: t || null, u: user ? (field[0]?.user ?? u) : null, adv: String(adv) === "1", p: pls.map((pl) => ({ id: pl.id, name: pl.name, pos: pl.pos, team: pl.team })) },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field), count: withPlayers.length, advancing: advOf(withPlayers), ranked: rankedOf(withPlayers) },
    total: shown.length, offset: from,
    rows: rows.map((x, i) => ({ n: from + i + 1, id: x.id, user: x.user, contest: x.contest, buyIn: x.buyIn, date: x.date, points: x.points, rank: x.rank, entrants: x.entrants, adv: x.adv, gap: x.gap, left: x.left })),
  };
}

// ---- players ----  within the field (t, u): pos = QB | RB | WR | TE; sort = buyIn | teams | own | advRate | advancing | avgPick | name
// buyIn = the buy-ins of the teams that have him (what the account has riding on the player)
// q narrows the list to players whose name contains every typed word (the Exposure tab's search box)
export async function playersView(db, { t = "", u = "", pos = "", q = "", sort = "buyIn", dir = "desc", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b = await board(db, now);
  if (!b.live) return b;
  const { user, mine, field } = fieldOf(b, t, u);
  const acc = new Map(); // pid → { n, adv, ranked, pickSum, pickN, buyIn }
  for (const x of field) for (const [pid, pick] of x.picks) {
    const a = acc.get(pid) ?? { n: 0, adv: 0, ranked: 0, pickSum: 0, pickN: 0, buyIn: 0 };
    a.n++; a.buyIn += x.buyIn ?? 0; if (x.adv != null) { a.ranked++; if (x.adv) a.adv++; }
    if (pick != null) { a.pickSum += pick; a.pickN++; }
    acc.set(pid, a);
  }
  const P = /^(QB|RB|WR|TE)$/.test(pos) ? pos : "";
  const words = norm(q).split(" ").filter(Boolean);
  const list = [...acc.entries()].map(([pid, a]) => { const pl = b.players.get(pid); return { id: pid, name: pl.name, pos: pl.pos, team: pl.team, key: pl.key, teams: a.n, buyIn: a.buyIn,
    own: field.length ? r2(100 * a.n / field.length) : 0, advancing: a.adv, advRate: a.ranked ? r2(100 * a.adv / a.ranked) : null, avgPick: a.pickN ? Math.round(10 * a.pickSum / a.pickN) / 10 : null }; })
    .filter((x) => (!P || x.pos === P) && words.every((w) => x.key.includes(w))).map(({ key, ...x }) => x).sort((x, y) => y.buyIn - x.buyIn || y.teams - x.teams || x.name.localeCompare(y.name));
  const s = sortBy(list, sort, dir, ["buyIn", "teams", "own", "advRate", "advancing", "avgPick", "name"], "buyIn");
  const { from, rows } = page(s.list, offset, limit);
  return { ...common(b), view: "players", sort: s.key, dir: s.dir, profile: profileOf(user, mine), filter: { t: t || null, u: user ? (field[0]?.user ?? u) : null, pos: P || null, q: words.join(" ") || null },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field) }, total: list.length, offset: from,
    rows: rows.map((x, i) => ({ n: from + i + 1, ...x })) };
}

// player suggestions: players rostered by the account u (or by anyone, when u is empty) whose name contains every
// typed word, most-owned first; `teams` = how many of that account's teams have him
export async function searchPlayers(db, q, u = "", now = Date.now()) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const b = await board(db, now);
  if (!b.live) return [];
  const count = new Map();
  for (const x of fieldOf(b, "", u).mine) for (const pid of x.picks.keys()) count.set(pid, (count.get(pid) ?? 0) + 1);
  return [...b.players.values()].filter((p) => count.has(p.id) && words.every((w) => p.key.includes(w))).sort((x, y) => count.get(y.id) - count.get(x.id)).slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, teams: count.get(p.id) ?? 0 }));
}
