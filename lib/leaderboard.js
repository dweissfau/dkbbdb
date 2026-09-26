// Site-wide season leaderboard for the front page: every synced team, scored exactly like the team pop-up
// (same base → computeSnapshot arithmetic), with two views over the same list:
//   teams    the leaderboard itself        filters: tournament, username, players (all of them), advancing only
//   players  every drafted player          teams with him, ownership, advance rate, average pick
//
// Built for thousands of teams (measured on a synthetic 5,150-team site — see scripts/bench-board.mjs):
//   • the board is scored ONCE for everybody and kept in Vercel's runtime cache; requests read that copy. The first
//     request to find it older than its refresh window takes a cache marker and refreshes it (about 0.1 s today,
//     1–2 s at 5,000 teams); everyone else meanwhile keeps getting the copy in hand. So the cost is one run per
//     window however many people are watching, and nothing runs when nobody is. (Refreshing after the response, via
//     waitUntil, was tried first: the platform froze the instance and the run only finished when the next visitor
//     arrived.) The database copy (board_cache) is a backup, rewritten at most every six hours.
//   • finished weeks come from pod_prior (lib/prior.js), so a run scores the current week only;
//   • the run uses computeSnapshot's lean mode (standings only, no per-player cards).
// Each request then filters / sorts the in-memory list.
//
// Free-tier economics (2026-09-23): the database's monthly network allowance is the nearest limit, and what
// used it was every instance re-reading the whole stored board (half a megabyte and growing) once a minute.
//   • the board is refreshed on a fixed timetable (SCHEDULE / refreshDue below: six times on Sunday, once after the
//     Monday and Thursday night games, once a day otherwise) — the site is not live-scored minute by minute.
//   • the board lives in Vercel's runtime cache (regional, shared by every instance, gzip'd so it stays under the
//     2 MB item limit); instances read it from there and touch the database only when the cache has nothing
//     (cold region, expired) — then they fall back to board_cache and fill the cache again. The finished-weeks
//     totals (lib/prior.js) are cached the same way, so a refresh during the week reads NOTHING from the database.
import { computeSnapshot, gameStates } from "./pubscore.js";
import { priorFor } from "./prior.js";
import { getFeeds } from "./feeds.js";
import { nflDay } from "./live.js";
import { rcPut, rcGet, rcMark, rcRead, rcDrop } from "./rcache.js";
import { loadStore, storeEtag, boardInputs, PATHS } from "./store.js";
import { getGz, putGz, updateGz } from "./files.js";

const MEM_MS = 15e3;        // how long an instance trusts its in-memory copy without asking the shared cache
let mem = null;             // { loadedAt, storedAt, dbAt, at, board }
export let lastServed = ""; // where the last board() answer came from: mem | cache | blob | db | run (x-dkbbdb-board)

// The shared runtime cache holds the live board (one gzip'd JSON per production environment). The database copy
// (board_cache) is a BACKUP for cold regions and restarts, written at most every DB_WRITE_MS — not on every refresh:
// at 4,000 teams a board is ~2 MB, and writing it every minute through a game window is what used up the free
// database's monthly network allowance (2026-09-26).
// The cache entry is RENEWED whenever it is served and older than RENEW_MS, so the board stays available for as long
// as anyone visits — even with the database locked for weeks (a board is the only thing the site cannot rebuild).
const RC_KEY = "board-v1", RC_TTL_S = 7 * 24 * 3600, LOCK_KEY = "board-refreshing", LOCK_S = 120, RENEW_MS = 6 * 3600e3;
export async function cachePut(body, storedAt, dbAt = 0) { return rcPut(RC_KEY, body, RC_TTL_S, { storedAt, dbAt, putAt: Date.now() }); }
export async function cacheGet() {
  const v = await rcGet(RC_KEY); if (!v?.storedAt) return null;
  return { storedAt: Number(v.storedAt), dbAt: Number(v.dbAt) || 0, putAt: Number(v.putAt) || 0, body: v.value };
}
// WHEN the board is refreshed: a fixed timetable (Eastern time), not "every minute while a game is on" — the user
// does not need live updates for now (2026-09-26) and wants a few refreshes on Sunday and one a day otherwise.
//   Sunday            1:00, 2:30, 4:25, 6:00, 8:30 pm and 11:59 pm (after the night game)
//   Monday, Thursday  11:59 pm (after the night game)
//   other days        6:00 am
// The first request after a mark refreshes the board; everyone else gets the copy in hand. A board is "due" when a
// mark has passed since it was scored. (Someone who has just synced still gets a refresh at once — NEW_USER_MS.)
const ET = "America/New_York";
export const SCHEDULE = { 0: ["13:00", "14:30", "16:25", "18:00", "20:30", "23:59"], 1: ["23:59"], 4: ["23:59"], "*": ["06:00"] };
const etParts = (ms) => { const o = {}; for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone: ET, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(ms)) o[type] = value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) }; };
// the instant of an Eastern wall-clock time (one correction step handles the UTC offset, DST included)
const fromET = (y, m, d, h, mi) => { const t = Date.UTC(y, m - 1, d, h, mi); const p = etParts(t); return t - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - t); };
// the most recent mark at or before `now`
export function lastMark(now = Date.now()) {
  for (let back = 0; back < 8; back++) {
    const p = etParts(now - back * 86400e3), marks = SCHEDULE[p.wd] ?? SCHEDULE["*"];
    const past = marks.map((hm) => { const [h, mi] = hm.split(":").map(Number); return fromET(p.y, p.m, p.d, h, mi); }).filter((t) => t <= now);
    if (past.length) return Math.max(...past);
  }
  return now - 7 * 86400e3;
}
export const refreshDue = (storedAt, now = Date.now()) => storedAt < lastMark(now);
// kept for scripts/check-board.mjs: how long a board scored at `now` stands before the next mark
export const REFRESH_PLAYING_MS = 60e3, REFRESH_IDLE_MS = 30 * 60e3, REFRESH_UNKNOWN_MS = 5 * 60e3; // the old cadence, no longer used by board()
export function refreshAfterMs(b, now = Date.now()) {
  let t = now + 60e3; while (lastMark(t) <= now && t < now + 8 * 86400e3) t += 60e3; return t - now;
}
// kickoffs of this week's games that had not started when the board was scored (ms since epoch, sorted)
function pendingKicks(espn, now) {
  if (!espn?.events?.length) return null;
  const starts = new Set();
  for (const g of Object.values(gameStates(espn))) if (g.st === "U" && g.start) starts.add(Date.parse(g.start));
  return { pending: [...starts].filter((t) => Number.isFinite(t)).sort((a, b) => a - b), asOf: now };
}

// Rosters never change after a draft, so the run keeps everything it read about them (every pod, every pick)
// in this instance's memory and only re-reads it when a sync has changed the data — otherwise a 5,000-team site
// would pull ~20 MB out of the database every minute just to find that nothing moved.
let rosterCache = null;     // { fp, at, accounts, base, meta, ladders }
async function rosters(now) {
  const store = await loadStore(now);
  if (!store) throw new Error("no store file yet — publish one (GET /api/admin?publish=1)");
  const fp = "store:" + (storeEtag() ?? store.at);
  if (rosterCache?.fp === fp) return rosterCache;
  return (rosterCache = { fp, at: now, ...boardInputs(store) });
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
export async function computeBoard(now = Date.now()) {
  const [{ accounts, base, meta }, f] = await Promise.all([rosters(now), getFeeds(now)]);
  const nameOf = new Map(accounts.map((a) => [a.user_key, a.username]));
  if (!f.ok) return { live: false, reason: f.error ?? "public feeds unavailable" };

  const { prior, stats: priorStats } = await priorFor(base, f, now);
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
      adv: !started ? null : e.pp != null && row[2] != null ? row[2] <= e.pp : null, gap: started ? gapToLine(pod, row, e.pp) : null, picks,
      tkey: m?.tournament_key ? String(m.tournament_key).toUpperCase() : null, round: m?.round ?? 1, prizes: m?.prizes == null ? null : Number(m.prizes) });
  }
  teams.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  return { live: true, at: snap.at, week: snap.week, playing: snap.live, games: pendingKicks(f.espn, now), accounts: accounts.length, teams, players: [...players.values()], priorStats };
}

// stored form → the form the views use (picks and players as Maps)
const revive = (body) => ({ ...body, teams: body.teams.map((t) => ({ ...t, picks: new Map(t.picks) })), players: new Map(body.players.map((p) => [p.id, p])) });

// one full run: score, put it in the shared cache, keep it in this instance's memory, copy it to Blob (the backup
// every cold region starts from) and note today's rank of every team (the Δ arrows and rank trends in the pop-up)
export async function refreshBoard(now = Date.now()) {
  const body = await computeBoard(now);
  if (!body.live) return null;
  const storedAt = Date.now();
  try { await putGz(PATHS.board, { storedAt, body }); } catch (e) { console.error("board backup to Blob skipped:", e.message); }
  try { await saveHistory(body, now); } catch (e) { console.error("rank history skipped:", e.message); }
  await cachePut(body, storedAt, storedAt);
  mem = { loadedAt: storedAt, storedAt, dbAt: storedAt, at: body.at, raw: body, board: revive(body) };
  lastServed = "run";
  return mem.board;
}
// data/history.json.gz: { entryId: [[YYYY-MM-DD, rank, points], …] } — the last rank seen each NFL day, capped per team
const HISTORY_DAYS = 200;
async function saveHistory(body, now) {
  const day = nflDay(new Date(now).toISOString());
  await updateGz(PATHS.history, (h) => {
    h ??= {};
    for (const t of body.teams) {
      if (t.rank == null) continue;
      const rows = (h[t.id] ??= []), last = rows[rows.length - 1];
      if (last && last[0] === day) { last[1] = t.rank; last[2] = t.points; } else rows.push([day, t.rank, t.points]);
      if (rows.length > HISTORY_DAYS) rows.splice(0, rows.length - HISTORY_DAYS);
    }
    return h;
  });
}

// the board every request reads. force = a script asked for a fresh board (DKBBDB_SYNC_BOARD=1) — honoured at most
// once a minute, so a test that makes fifty calls costs one refresh, not fifty (that mistake used up a month's
// database transfer on 2026-09-26).
// wantUser: the username a page asks for. A username the board does not know yet (someone who has just synced)
// refreshes it right away instead of waiting out the idle cadence — at most once a minute, whatever is typed.
const NEW_USER_MS = 60e3, FORCE_MIN_MS = 60e3;
export const _forget = () => { mem = null; }, _stale = () => { if (mem) mem.loadedAt = 0; }; // tests
async function board(now, force = process.env.DKBBDB_SYNC_BOARD === "1", wantUser = "") {
  force = force && (!mem || Date.now() - mem.storedAt > FORCE_MIN_MS);
  if (mem && Date.now() - mem.loadedAt < MEM_MS && !force) { lastServed = "mem"; return mem.board; }
  // the shared cache first; the database only when it has nothing
  const hit = await cacheGet();
  if (hit) {
    if (mem?.storedAt === hit.storedAt) mem.loadedAt = Date.now();
    else mem = { loadedAt: Date.now(), storedAt: hit.storedAt, dbAt: hit.dbAt, at: hit.body.at, raw: hit.body, board: revive(hit.body) };
    if (Date.now() - hit.putAt > RENEW_MS) await cachePut(hit.body, hit.storedAt, hit.dbAt); // keep it alive
    lastServed = "cache";
  } else {
    // the backup copy in Blob (written on every run); nothing there = the very first run
    let fromBlob = null;
    try { fromBlob = (await getGz(PATHS.board))?.value ?? null; } catch (e) { console.error("board backup in Blob unreadable:", e.message); }
    if (fromBlob?.body?.live) {
      const { storedAt, body } = fromBlob;
      if (mem?.at === body.at) { mem.loadedAt = Date.now(); mem.storedAt ??= storedAt; }
      else mem = { loadedAt: Date.now(), storedAt, dbAt: storedAt, at: body.at, raw: body, board: revive(body) };
      await cachePut(body, storedAt, storedAt); lastServed = "blob";
    } else if (mem?.raw) { mem.loadedAt = Date.now(); await cachePut(mem.raw, mem.storedAt, mem.dbAt); lastServed = "mem"; }
    else return (await refreshBoard(now)) ?? { live: false, reason: "public feeds unavailable" };
  }

  const age = Date.now() - mem.storedAt, user = String(wantUser ?? "").trim().toLowerCase();
  const unknown = !!user && mem.board.live && !mem.board.teams.some((x) => x.user?.toLowerCase() === user);
  if (refreshDue(mem.storedAt, now) || (unknown && age > NEW_USER_MS) || force) {
    // one refresh at a time, whoever asks: a marker in the shared cache (no database round trip) that expires after
    // two minutes in case a run died. Requests that find the marker answer from the copy in hand straight away.
    // A database that will not answer (quota, outage) must not turn a page into a 500 while a board is in hand: the
    // stale copy is served and the next request tries again.
    const running = await rcRead(LOCK_KEY);
    if (!running || Date.now() - Number(running.at) > LOCK_S * 1000) {
      await rcMark(LOCK_KEY, { at: Date.now() }, LOCK_S);
      try { await refreshBoard(Date.now()); }
      catch (e) { console.error("board refresh skipped:", e.message); }
      finally { await rcDrop(LOCK_KEY); }
    }
  }
  return mem.board;
}

const advOf = (list) => list.filter((x) => x.adv === true).length, rankedOf = (list) => list.filter((x) => x.adv != null).length;

// ---- "Winning": what a team is sure to collect. Inside the cut line = the tournament's guaranteed prize for the
// next round (lib/payouts.js ladders); money DraftKings already credited (PrizesWon) counts whatever the place.
// null = inside the cut line but the tournament's payout table is not on file yet.
async function laddersFor(now) { return (await rosters(now)).ladders ?? new Map(); }
export const _forgetLadders = () => {};
function winOf(t, L) {
  const next = L.get(t.tkey)?.ladder?.[String((t.round ?? 1) + 1)], locked = t.prizes > 0 ? t.prizes : 0;
  if (t.adv === true) return next == null ? (locked || null) : Math.max(Number(next), locked);
  return locked;
}
const withWin = (teams, L) => teams.map((t) => ({ ...t, win: winOf(t, L) }));
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
  return { live: true, at: b.at, week: b.week, playing: b.playing, accounts: b.accounts, teams: b.teams.length, tournaments: tournamentsOf(b.teams), users: usersOf(b.teams) };
}
// every synced account with a team on the board, most teams first (the leaderboard's User menu)
const usersOf = (list) => { const m = new Map(); for (const x of list) if (x.user) m.set(x.user, (m.get(x.user) ?? 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([name, count]) => ({ name, teams: count })); };
// DK player ids "id,id,…" → the board's player records (at most 5, junk ignored)
const playersOf = (b, s) => [...new Set(String(s ?? "").split(",").map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5).map((id) => b.players.get(id)).filter(Boolean);
const plain = (pl) => ({ id: pl.id, name: pl.name, pos: pl.pos, team: pl.team });
// mine = the username's teams before the tournament filter (the profile page lists that user's tournaments from it)
// only / hide = entry ids the page's owner ticked ("id,id,…"): the field keeps only those teams, or drops them.
// A profile page can carry thousands of teams, so the lists are capped rather than trusted blindly.
const idsOf = (s) => { const out = new Set(); for (const part of String(s ?? "").split(",")) { const n = Number(part.trim()); if (Number.isInteger(n) && n > 0) out.add(n); if (out.size >= 5000) break; } return out; };
const fieldOf = (b, t, u, only = "", hide = "") => { const user = String(u ?? "").trim().toLowerCase();
  const mine = user ? b.teams.filter((x) => x.user?.toLowerCase() === user) : b.teams;
  const on = idsOf(only), off = idsOf(hide);
  const field = mine.filter((x) => (!t || x.contest === t) && (!on.size || on.has(Number(x.id))) && !off.has(Number(x.id)));
  return { user, mine, field, ticks: { only: on.size ? mine.filter((x) => on.has(Number(x.id))).length : 0, hide: off.size ? mine.filter((x) => off.has(Number(x.id))).length : 0 } }; };
const tournamentsOf = (list) => { const m = new Map(); for (const x of list) m.set(x.contest, (m.get(x.contest) ?? 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, teams: count })); };
// the header numbers for a set of teams: buy-ins, the split behind the advance rate, the best team
function summaryOf(list) {
  const best = list.reduce((a, x) => (a == null || x.points > a.points ? x : a), null);
  return { teams: list.length, buyIn: list.reduce((s, x) => s + (x.buyIn ?? 0), 0), tournamentCount: new Set(list.map((x) => x.contest)).size,
    winning: list.reduce((s, x) => s + (x.win ?? 0), 0), winTeams: list.filter((x) => x.win > 0).length, winUnknown: list.filter((x) => x.adv === true && x.win == null).length,
    advancing: advOf(list), advBuyIn: list.filter((x) => x.adv === true).reduce((s, x) => s + (x.buyIn ?? 0), 0), out: list.filter((x) => x.adv === false).length, unranked: list.filter((x) => x.adv == null).length,
    best: best ? { id: best.id, points: best.points, contest: best.contest, rank: best.rank, entrants: best.entrants, adv: best.adv, gap: best.gap } : null };
}
// the profile page's header for a username: the whole account (profile) — `scope` in each view is the same shape
// for the teams the filters leave (tournament, and on the Teams tab the chosen players), so the tiles can follow them
function profileOf(user, mine) {
  if (!user) return null;
  return { user: mine[0]?.user ?? user, ...summaryOf(mine), tournaments: tournamentsOf(mine) };
}

// ---- teams ----  filters: t = tournament (short contest name), u = DraftKings username, p = DK player id(s) "id,id"
// (a team must have ALL of them), x = DK player id(s) a team must have NONE of, adv = "1" advancing only;
// sort = points | gap | left | date | buyIn | rank | user
export async function leaderboard({ t = "", u = "", p = "", x = "", adv = "", only = "", hide = "", withIds = "", sort = "points", dir = "desc", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b0 = await board(now, undefined, u);
  if (!b0.live) return b0;
  const b = { ...b0, teams: withWin(b0.teams, await laddersFor(now)) };
  const pls = playersOf(b, p), xls = playersOf(b, x).filter((pl) => !pls.some((q) => q.id === pl.id)); // a player cannot be both wanted and excluded
  // the field = teams in the chosen tournament / username (and the ticked-team filter); the player filters narrow it and are measured against it
  const { user, mine, field, ticks } = fieldOf(b, t, u, only, hide);
  const withPlayers = pls.length || xls.length ? field.filter((tm) => pls.every((pl) => tm.picks.has(pl.id)) && !xls.some((pl) => tm.picks.has(pl.id))) : field;
  const shown = String(adv) === "1" ? withPlayers.filter((x) => x.adv === true) : withPlayers;
  const s = sortBy(shown, sort, dir, ["points", "gap", "left", "date", "buyIn", "rank", "user", "contest"], "points");
  const { from, rows } = page(s.list, offset, limit);
  return {
    ...common(b), view: "teams", sort: s.key, dir: s.dir, profile: profileOf(user, mine), scope: user ? summaryOf(withPlayers) : null,
    filter: { t: t || null, u: user ? (field[0]?.user ?? u) : null, adv: String(adv) === "1", p: pls.map(plain), x: xls.map(plain), ticks },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field), count: withPlayers.length, advancing: advOf(withPlayers), ranked: rankedOf(withPlayers) },
    total: shown.length, offset: from,
    ...(String(withIds) === "1" ? { ids: s.list.map((x) => x.id) } : {}), // every team the filters leave, for "tick all"
    rows: rows.map((x, i) => ({ n: from + i + 1, id: x.id, user: x.user, contest: x.contest, buyIn: x.buyIn, date: x.date, points: x.points, rank: x.rank, entrants: x.entrants, adv: x.adv, gap: x.gap, left: x.left, win: x.win })),
  };
}

// ---- players ----  within the field (t, u): pos = QB | RB | WR | TE; sort = buyIn | teams | own | advRate | advancing | avgPick | name
// buyIn = the buy-ins of the teams that have him (what the account has riding on the player)
// team words so "jets", "new york", "ny jets", "niners" or "kc" find every player on that team (same table as the partner pages)
const TEAM_WORDS = { ARI: "arizona cardinals cards", ATL: "atlanta falcons", BAL: "baltimore ravens", BUF: "buffalo bills", CAR: "carolina panthers", CHI: "chicago bears",
  CIN: "cincinnati bengals", CLE: "cleveland browns", DAL: "dallas cowboys", DEN: "denver broncos", DET: "detroit lions", GB: "green bay packers", HOU: "houston texans",
  IND: "indianapolis colts", JAX: "jacksonville jaguars jags", KC: "kansas city chiefs", LAC: "los angeles chargers la", LAR: "los angeles rams la", LV: "las vegas raiders",
  MIA: "miami dolphins", MIN: "minnesota vikings", NE: "new england patriots pats", NO: "new orleans saints", NYG: "new york giants ny", NYJ: "new york jets ny",
  PHI: "philadelphia eagles", PIT: "pittsburgh steelers", SEA: "seattle seahawks", SF: "san francisco 49ers niners", TB: "tampa bay buccaneers bucs", TEN: "tennessee titans", WAS: "washington commanders" };
const teamWords = (ab) => { const t = String(ab ?? "").toUpperCase(); return t ? `${t.toLowerCase()} ${TEAM_WORDS[t] ?? ""}` : ""; };

// q narrows the list (the Exposure tab's search box): every typed word must appear in the player's name OR in his
// team's abbreviation / city / nickname, so "jets" lists every Jet and "ja chase" finds Ja'Marr Chase
// p / x narrow the field like the teams view (teams that have ALL of p and NONE of x): ownership is then out of those teams
export async function playersView({ t = "", u = "", p = "", x = "", pos = "", q = "", only = "", hide = "", sort = "buyIn", dir = "desc", offset = 0, limit = 100 } = {}, now = Date.now()) {
  const b0 = await board(now, undefined, u);
  if (!b0.live) return b0;
  const b = { ...b0, teams: withWin(b0.teams, await laddersFor(now)) };
  const { user, mine, field: field0, ticks } = fieldOf(b, t, u, only, hide);
  const pls = playersOf(b, p), xls = playersOf(b, x).filter((pl) => !pls.some((q2) => q2.id === pl.id));
  const field = pls.length || xls.length ? field0.filter((tm) => pls.every((pl) => tm.picks.has(pl.id)) && !xls.some((pl) => tm.picks.has(pl.id))) : field0;
  const acc = new Map(); // pid → { n, adv, ranked, pickSum, pickN, buyIn }
  for (const x of field) for (const [pid, pick] of x.picks) {
    const a = acc.get(pid) ?? { n: 0, adv: 0, ranked: 0, pickSum: 0, pickN: 0, buyIn: 0 };
    a.n++; a.buyIn += x.buyIn ?? 0; if (x.adv != null) { a.ranked++; if (x.adv) a.adv++; }
    if (pick != null) { a.pickSum += pick; a.pickN++; }
    acc.set(pid, a);
  }
  const P = /^(QB|RB|WR|TE)$/.test(pos) ? pos : "";
  const words = norm(q).split(" ").filter(Boolean);
  const list = [...acc.entries()].map(([pid, a]) => { const pl = b.players.get(pid); return { id: pid, name: pl.name, pos: pl.pos, team: pl.team, key: `${pl.key} | ${norm(teamWords(pl.team))}`, teams: a.n, buyIn: a.buyIn,
    own: field.length ? r2(100 * a.n / field.length) : 0, advancing: a.adv, advRate: a.ranked ? r2(100 * a.adv / a.ranked) : null, avgPick: a.pickN ? Math.round(10 * a.pickSum / a.pickN) / 10 : null }; })
    .filter((x) => (!P || x.pos === P) && words.every((w) => x.key.includes(w))).map(({ key, ...x }) => x).sort((x, y) => y.buyIn - x.buyIn || y.teams - x.teams || x.name.localeCompare(y.name));
  const s = sortBy(list, sort, dir, ["buyIn", "teams", "own", "advRate", "advancing", "avgPick", "name"], "buyIn");
  const { from, rows } = page(s.list, offset, limit);
  return { ...common(b), view: "players", sort: s.key, dir: s.dir, profile: profileOf(user, mine), scope: user ? summaryOf(field) : null,
    filter: { t: t || null, u: user ? (field0[0]?.user ?? u) : null, pos: P || null, q: words.join(" ") || null, p: pls.map(plain), x: xls.map(plain), ticks },
    stats: { field: field.length, fieldAdvancing: advOf(field), fieldRanked: rankedOf(field) }, total: list.length, offset: from,
    rows: rows.map((x, i) => ({ n: from + i + 1, ...x })) };
}

// username suggestions for the leaderboard's User box: synced accounts whose name contains the typed text ("kk" finds
// kknox20), names starting with it first, then most teams; `teams` = how many of theirs are in the tournament t (or at all)
export async function searchUsers(q, t = "", now = Date.now()) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return [];
  const b = await board(now);
  if (!b.live) return [];
  return usersOf(fieldOf(b, t, "").field).filter((u) => u.name.toLowerCase().includes(s))
    .sort((x, y) => (y.name.toLowerCase().startsWith(s) - x.name.toLowerCase().startsWith(s)) || y.teams - x.teams).slice(0, 8)
    .map((u) => ({ username: u.name, teams: u.teams }));
}

// player suggestions: players rostered by the account u (or by anyone, when u is empty), within the tournament t when
// one is given, whose name contains every typed word, most-owned first; `teams` = how many of those teams have him
export async function searchPlayers(q, u = "", t = "", now = Date.now()) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const b = await board(now, undefined, u);
  if (!b.live) return [];
  const count = new Map();
  for (const x of fieldOf(b, t, u).field) for (const pid of x.picks.keys()) count.set(pid, (count.get(pid) ?? 0) + 1);
  return [...b.players.values()].filter((p) => count.has(p.id) && words.every((w) => p.key.includes(w))).sort((x, y) => count.get(y.id) - count.get(x.id)).slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, teams: count.get(p.id) ?? 0 }));
}
