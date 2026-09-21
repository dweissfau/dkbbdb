// Public-feed live scoring: DraftKings Best Ball points computed on the server from public
// NFL stats, so the pages update without the owner's browser or DraftKings session.
//
//   Sleeper  https://api.sleeper.com/stats/nfl/{season}/{week}?season_type=regular&position[]=QB…
//            raw per-player stats for the week (pass_yd, rec, rush_td, …), updated play by play
//   ESPN     https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
//            every game's state (pre / in / post), clock, kickoff — the LIVE / FINAL / kickoff tags
//
// Everything here is pure (no I/O) so it can be tested against captured feeds:
//   dkPoints(stats)                          DraftKings NFL scoring over Sleeper stat keys
//   gameStates(espn)                         team abbr → { st, ts, pmr, game, start }
//   computeSnapshot(base, sleeperRows, espn, now)
//                                            → { at, week, pods, rosters, rostersAt, weekly } in the SAME
//                                              internal shapes live.js keeps (see mergeLive); weekly =
//                                              the week-by-week breakdown (see foldWeeks)
//   overlay(extSnap, computed, base, now, opts) → one snapshot: the extension's official DraftKings
//                                              numbers for pods it pushed recently, computed ones
//                                              for everything else
//
// base.json (tools/build-live-base.mjs) adds for this:
//   pods     { cid: { dgid, rosters: { entryKey: { u: userName, d: [did, …] } } } }  every roster in
//            every synced pod (rosters never change after a Best Ball draft)
//   sleeper  { dkPlayerId: [sleeperPlayerId, team] }  built from Sleeper's player list + aliases

import { gameSt, nflDay, nflWeek } from "./live.js";

const n0 = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const r2 = (x) => Math.round(x * 100) / 100;

// ---- DraftKings NFL scoring (Best Ball / classic) ----
export function dkPoints(s) {
  if (!s) return 0;
  let p = 0;
  p += 0.04 * n0(s.pass_yd) + 4 * n0(s.pass_td) - 1 * n0(s.pass_int) + (n0(s.pass_yd) >= 300 ? 3 : 0);
  p += 0.1 * n0(s.rush_yd) + 6 * n0(s.rush_td) + (n0(s.rush_yd) >= 100 ? 3 : 0);
  p += 1 * n0(s.rec) + 0.1 * n0(s.rec_yd) + 6 * n0(s.rec_td) + (n0(s.rec_yd) >= 100 ? 3 : 0);
  p += 2 * (n0(s.pass_2pt) + n0(s.rush_2pt) + n0(s.rec_2pt));
  p -= 1 * n0(s.fum_lost);
  // return / recovery touchdowns: kr_td + pr_td when Sleeper splits them, else st_td
  const ret = s.kr_td != null || s.pr_td != null ? n0(s.kr_td) + n0(s.pr_td) : n0(s.st_td);
  p += 6 * (ret + n0(s.fum_rec_td));
  return r2(p);
}

// ---- names (for the publish-time map and the runtime fallback) ----
export const normName = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]/g, "");

// Map DK players → Sleeper ids. players: DK [{ pid, name, pos, team }]; sleeper: Sleeper player list
// (object or array of { player_id, first_name, last_name, team, position, fantasy_positions, active, status });
// aliases: { "DK name": "sleeper player_id" }. Returns { map: { pid: [sleeperId, team] }, unmatched: [...] }.
export function buildSleeperMap(players, sleeper, aliases = {}) {
  const list = Array.isArray(sleeper) ? sleeper : Object.values(sleeper ?? {});
  const SKILL = /^(QB|RB|WR|TE)$/;
  const byName = new Map(), byId = new Map();
  for (const p of list) {
    if (!p?.player_id) continue;
    byId.set(String(p.player_id), p);
    if (!(SKILL.test(p.position) || (p.fantasy_positions ?? []).some((x) => SKILL.test(x)))) continue;
    const k = normName(`${p.first_name ?? ""}${p.last_name ?? ""}`);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  const aliasByName = new Map(Object.entries(aliases ?? {}).map(([k, v]) => [normName(k), String(v)]));
  const map = {}, unmatched = [];
  for (const d of players) {
    const key = normName(d.name);
    let hit = null;
    const a = aliasByName.get(key);
    if (a && byId.has(a)) hit = byId.get(a);
    if (!hit) {
      const c = byName.get(key) ?? [];
      const pick = (f) => { const x = c.filter(f); return x.length === 1 ? x[0] : null; };
      hit = (c.length === 1 ? c[0] : null) ?? pick((p) => p.team === d.team) ?? pick((p) => p.team === d.team && p.position === d.pos)
        ?? pick((p) => p.active && p.position === d.pos) ?? pick((p) => p.active && p.team);
    }
    if (hit) map[d.pid] = [String(hit.player_id), hit.team ?? d.team ?? null];
    else unmatched.push(d);
  }
  return { map, unmatched };
}

// ---- ESPN scoreboard → per-team game state ----
const ESPN_TEAM = { WSH: "WAS" }; // ESPN abbreviations that differ from DraftKings'
const dkTeam = (ab) => ESPN_TEAM[ab] ?? ab;

function clockMinutes(status) {
  // minutes left in regulation from ESPN's period + displayClock ("Q3 5:12" → 5:12 + 15 = 20.2)
  const period = n0(status?.period), [m, s] = String(status?.displayClock ?? "0:00").split(":").map(Number);
  const left = n0(m) + n0(s) / 60;
  if (period <= 0) return 60;
  if (period <= 4) return Math.max(0, (4 - period) * 15 + left);
  return Math.max(0, left); // overtime
}

export function gameStates(espn) {
  const out = {};
  for (const e of espn?.events ?? []) {
    const comp = e.competitions?.[0]; if (!comp) continue;
    const teams = (comp.competitors ?? []).map((c) => ({ ab: dkTeam(c.team?.abbreviation), ha: c.homeAway }));
    const away = teams.find((t) => t.ha === "away")?.ab, home = teams.find((t) => t.ha === "home")?.ab;
    const game = away && home ? `${away} @ ${home}` : teams.map((t) => t.ab).join(" vs ");
    const status = e.status ?? {}, type = status.type ?? {}, state = type.state;
    let st, ts, pmr;
    if (state === "post") { st = "F"; ts = type.shortDetail || type.detail || "Final"; pmr = 0; }
    else if (state === "in") {
      st = "L"; pmr = Math.round(clockMinutes(status));
      const per = n0(status.period);
      ts = type.name === "STATUS_HALFTIME" || /half/i.test(type.detail ?? "") ? "Half"
        : per > 4 ? `OT ${status.displayClock ?? ""}`.trim() : per > 0 ? `Q${per} ${status.displayClock ?? ""}`.trim() : type.shortDetail ?? "Live";
      if (/delay|suspend/i.test(type.detail ?? "")) ts = type.detail;
    } else { st = "U"; ts = type.shortDetail ?? null; pmr = 60; }
    const start = e.date ? new Date(e.date).toISOString() : null;
    for (const t of teams) if (t.ab) out[t.ab] = { st, ts, pmr, game, start };
  }
  return out;
}

// Fallback when ESPN is unreachable: Sleeper's schedule (https://api.sleeper.app/schedule/nfl/regular/{season})
// has status only (pre_game / in_game / complete / canceled), no clock — shaped like the ESPN
// scoreboard so gameStates() needs no second code path.
export function scheduleToEspn(sched, week, season) {
  const events = [];
  for (const g of sched ?? []) {
    if (Number(g.week) !== Number(week) || !g.home || !g.away) continue;
    const done = g.status === "complete" || g.status === "canceled";
    const state = done ? "post" : g.status === "pre_game" ? "pre" : "in";
    const detail = g.status === "canceled" ? "Canceled" : state === "post" ? "Final" : state === "in" ? "In progress" : g.date ?? "Scheduled";
    events.push({
      date: g.date ? `${g.date}T17:00:00Z` : null,
      status: { period: 0, displayClock: "0:00", type: { state, name: state === "in" ? "STATUS_IN_PROGRESS" : state === "post" ? "STATUS_FINAL" : "STATUS_SCHEDULED", detail, shortDetail: detail } },
      competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: g.home } }, { homeAway: "away", team: { abbreviation: g.away } }] }],
    });
  }
  return { week: { number: Number(week) }, season: { year: Number(season) }, events, fallback: "sleeper-schedule" };
}

// ---- lineups ----
const SLOTS = { QB: 1, RB: 2, WR: 3, TE: 1 };
// players: [{ did, pos, pts }] → Map(did → slot) with QB/RB/WR/TE/FLEX/BN (DraftKings Best Ball)
export function optimalLineup(players) {
  const sorted = [...players].sort((a, b) => b.pts - a.pts);
  const slot = new Map(), used = new Set(), count = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const p of sorted) {
    const pos = p.pos in SLOTS ? p.pos : null;
    if (pos && count[pos] < SLOTS[pos]) { count[pos]++; slot.set(p.did, pos); used.add(p.did); }
  }
  const flex = sorted.find((p) => !used.has(p.did) && /^(RB|WR|TE)$/.test(p.pos));
  if (flex) { slot.set(flex.did, "FLEX"); used.add(flex.did); }
  for (const p of sorted) if (!used.has(p.did)) slot.set(p.did, "BN");
  return slot;
}

// ---- completed weeks (season totals with no DraftKings sync) ----
// Sleeper stats rows → Map(sleeperId → { pts, team }) with DraftKings points; the same map serves
// the current week's scoring and the per-week fold below, so a cached week costs one small Map.
export function weekPointsMap(sleeperRows) {
  const m = new Map();
  for (const r of sleeperRows ?? []) if (r?.player_id != null) m.set(String(r.player_id), { pts: dkPoints(r.stats), team: r.team ?? null });
  return m;
}

// one roster's players for a week: [{ did, pid, pos, pts, team }]
// counts = false: the pod's contest had not started that week (pod.from, see dkbbdb lib/base.js) → everyone scores 0
function rosterPlayers(dg, sleeper, ro, wk, counts = true) {
  const players = [];
  for (const did of ro.d ?? []) {
    const d = dg[did]; if (!d) continue;
    const [pid, , pos, dkTeamAb] = d;
    const sl = sleeper[pid] ?? null;
    const row = sl ? wk.get(sl[0]) : null;
    players.push({ did, pid, pos, pts: counts ? row?.pts ?? 0 : 0, team: row?.team ?? sl?.[1] ?? dkTeamAb });
  }
  return players;
}

// Fold every COMPLETED week into { cid: { entryKey: { did: [all, counted, through] } } } — the shape
// of base.prior — by re-running DraftKings' best-lineup pick per roster per week. weeks: [[weekNumber,
// Map from weekPointsMap()], …]; weeks whose stats are missing are simply not counted (the caller
// decides whether that is acceptable). Completed weeks never change apart from stat corrections,
// so this is safe to recompute from cached maps on every request.
//
// The same pass keeps the week-by-week breakdown the pages show (every array is indexed like `weeks`):
//   weekly { weeks:   [1, 2, …]
//            players: { dkPlayerId: [points per week] }          a player scores the same on every roster
//            teams:   { cid: { entryKey: { t: [team score per week], s: { did: "QB…" } } } }
//                     s = the slot he filled each week, one letter per week (SLOT_CHAR; B = bench)
export const SLOT_CHAR = { QB: "Q", RB: "R", WR: "W", TE: "T", FLEX: "F", BN: "B" };
export function foldWeeks(base, weeks) {
  const sleeper = base?.sleeper ?? {}, draftables = base?.draftables ?? {};
  const prior = {};
  const sorted = [...(weeks ?? [])].filter(([w, m]) => Number(w) >= 1 && m instanceof Map).sort((a, b) => a[0] - b[0]);
  const weekly = { weeks: sorted.map(([w]) => Number(w)), players: {}, teams: {} };
  for (const [cid, pod] of Object.entries(base?.pods ?? {})) {
    const dg = draftables[pod.dgid] ?? {};
    for (const [key, ro] of Object.entries(pod.rosters ?? {})) {
      const acc = {}, t = sorted.map(() => 0), s = {};
      sorted.forEach(([w, wk], i) => {
        const players = rosterPlayers(dg, sleeper, ro, wk, Number(w) >= (pod.from ?? 1));
        if (!players.length) return;
        const slots = optimalLineup(players);
        for (const p of players) {
          const slot = slots.get(p.did) ?? "BN";
          const a = (acc[p.did] ??= [0, 0, 0]);
          a[0] += p.pts; if (slot !== "BN") { a[1] += p.pts; t[i] += p.pts; } a[2] = Number(w);
          (s[p.did] ??= sorted.map(() => "B"))[i] = SLOT_CHAR[slot] ?? "B";
          if (Number(w) >= (pod.from ?? 1)) (weekly.players[p.pid] ??= sorted.map(() => 0))[i] = p.pts; // a player's own score: only from pods that counted the week
        }
      });
      if (!Object.keys(acc).length) continue;
      (prior[cid] ??= {})[key] = Object.fromEntries(Object.entries(acc).map(([did, a]) => [did, [r2(a[0]), r2(a[1]), a[2]]]));
      (weekly.teams[cid] ??= {})[key] = { t: t.map(r2), s: Object.fromEntries(Object.entries(s).map(([did, a]) => [did, a.join("")])) };
    }
  }
  return { prior, weekly };
}
export const buildPrior = (base, weeks) => foldWeeks(base, weeks).prior;

// ---- the computed snapshot ----
// sleeperRows: the week's stats rows [{ player_id, team, stats, player: { position, … } }]
// espn: scoreboard JSON. now: ms epoch (default Date.now()).
// opts.week:  the NFL week the rows belong to — MUST be the week the stats were fetched for (the
//             caller knows it from Sleeper's state); defaults to the scoreboard's week. Getting this
//             wrong either drops or double-counts the previous week around Tuesday's rollover.
// opts.prior: completed-week totals from buildPrior(); defaults to base.prior (publish-time DB data).
// opts.weekly: foldWeeks().weekly for the completed weeks; the week being scored is appended to it, so
//             the snapshot's `weekly` covers the whole season (only the current week without it).
// opts.lean:  standings only (dkbbdb's site-wide leaderboard scores tens of thousands of rosters a minute):
//             identical arithmetic and identical `pods` rows, but no per-player cards and no week-by-week
//             breakdown are built — those are what made a 60,000-roster run need ~2 GB.
export function computeSnapshot(base, sleeperRows, espn, now = Date.now(), opts = {}) {
  const at = new Date(now).toISOString();
  const espnWeek = espn?.week?.number ?? null;
  const week = Number(opts.week) || espnWeek || nflWeek(at) || 1;
  const stats = weekPointsMap(sleeperRows);
  const games = gameStates(espn);
  // a player whose team has no game this week (free agent "FA", TBD, bye) has 0 minutes to play —
  // DraftKings counts them as done; only fall back to 60 per player when no scoreboard loaded at all
  const hasGames = Object.keys(games).length > 0;
  const sleeper = base?.sleeper ?? {}, draftables = base?.draftables ?? {}, prior = opts.prior ?? base?.prior ?? {};
  const pods = {}, rosters = {}, rostersAt = {};
  // week-by-week breakdown: the completed weeks (before this one) + this week, same shape as foldWeeks().weekly
  const lean = !!opts.lean;
  const past = opts.weekly ?? null;
  const keep = (past?.weeks ?? []).map((w, i) => [w, i]).filter(([w]) => w < week);
  const pick = (arr, fill) => keep.map(([, i]) => arr?.[i] ?? fill);
  const weekly = { weeks: [...keep.map(([w]) => w), week], players: {}, teams: {} };

  for (const [cid, pod] of Object.entries(base?.pods ?? {})) {
    const dg = draftables[pod.dgid] ?? {};
    const podRosters = {}, rows = [];
    for (const [key, ro] of Object.entries(pod.rosters ?? {})) {
      const counts = week >= (pod.from ?? 1);
      const players = rosterPlayers(dg, sleeper, ro, stats, counts);
      if (!players.length) continue;
      const slots = optimalLineup(players);
      const pr = prior[cid]?.[key] ?? null;
      const cards = [];
      let total = 0, tr = 0, wkTotal = 0;
      const pastTeam = past?.teams?.[cid]?.[key] ?? null, slotStr = {};
      for (const p of players) {
        const slot = slots.get(p.did) ?? "BN", bench = slot === "BN" ? 1 : 0;
        if (!bench) wkTotal += p.pts;
        if (!lean) {
          slotStr[p.did] = pick(pastTeam?.s?.[p.did], "B").join("") + (SLOT_CHAR[slot] ?? "B");
          if (counts) weekly.players[p.pid] ??= [...pick(past?.players?.[p.pid], 0), p.pts];
        }
        let baseAll = 0, baseCounted = 0;
        const pp = pr?.[p.did];
        if (pp && pp[2] < week) { baseAll = pp[0]; baseCounted = pp[1]; }
        const g = games[p.team] ?? null;
        const pmr = g ? g.pmr : null;
        const st = g && !lean ? gameSt(g.st, g.ts, g.pmr) : null;
        if (!lean) cards.push([p.did, slot, p.pts, bench, r2(baseAll), r2(baseCounted), pmr, st, g?.ts ?? null, g?.game ?? null, g?.start ?? null]);
        total += baseCounted + (bench ? 0 : p.pts);
        tr += pmr ?? (hasGames ? 0 : 60);
      }
      if (!lean) {
        podRosters[key] = { week, cards };
        (weekly.teams[cid] ??= {})[key] = { t: [...pick(pastTeam?.t, 0), r2(wkTotal)], s: slotStr };
      }
      rows.push([Number(key), ro.u ?? null, null, r2(total), Math.round(tr)]);
    }
    if (!rows.length) continue;
    rows.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
    for (let i = 0; i < rows.length; i++) rows[i][2] = i > 0 && rows[i][3] === rows[i - 1][3] ? rows[i - 1][2] : i + 1;
    pods[cid] = rows;
    if (!lean) { rosters[cid] = podRosters; rostersAt[cid] = at; }
  }
  const live = Object.values(games).some((g) => g.st === "L");
  return { at, week, pods, rosters, rostersAt, weekly, live, games: Object.keys(games).length, matched: stats.size };
}

// ---- combine with the extension's snapshot ----
// For each pod: the extension's numbers if it pushed that pod's rosters within freshMs AND its last
// push overall is within freshMs (official DraftKings data wins while the owner's browser is
// actually running); otherwise the computed numbers. Contests/history/prizes stay from the extension.
export function overlay(extSnap, computed, base, now = Date.now(), { freshMs = 5 * 60e3 } = {}) {
  const snap = extSnap ? structuredClone(extSnap) : { v: 1, at: null, week: null, contests: {}, pods: {}, rosters: {}, history: {}, rostersAt: {} };
  const extAt = Date.parse(snap.at ?? "") || 0;
  const extFresh = now - extAt <= freshMs;
  const source = { dk: 0, computed: 0 };
  const day = nflDay(computed.at); // rank history key (see live.js nflDay)
  for (const cid of Object.keys(computed.pods)) {
    const rAt = Date.parse(snap.rostersAt?.[cid] ?? "") || 0;
    if (extFresh && snap.pods?.[cid] && snap.rosters?.[cid] && now - rAt <= freshMs) { source.dk++; continue; }
    snap.pods[cid] = computed.pods[cid];
    snap.rosters[cid] = computed.rosters[cid];
    snap.rostersAt[cid] = computed.rostersAt[cid];
    source.computed++;
  }
  if (source.computed) {
    snap.at = computed.at;
    snap.week = Math.max(computed.week, snap.week ?? 0);
    // today's rank for my teams (Δ vs the previous day needs the extension's persisted history)
    for (const [cid, rows] of Object.entries(computed.pods)) {
      for (const row of rows) {
        const id = String(row[0]);
        if (!(base?.entries?.[id] || snap.contests[id])) continue;
        const h = (snap.history[id] ??= []);
        // upsert today's row (rows may arrive out of order around a key change), keep the list sorted by day
        const i = h.findIndex((r) => r[0] === day);
        if (i >= 0) h[i][1] = row[2] ?? h[i][1];
        else if (row[2] != null) { h.push([day, row[2]]); h.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
      }
    }
  }
  // week-by-week scores are always the computed ones (DraftKings' feed only ever carries the current week)
  snap.weekly = computed.weekly ?? null;
  snap.source = { ...source, live: computed.live, computedAt: computed.at };
  return snap;
}
