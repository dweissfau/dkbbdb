// Public NFL feeds, fetched once per function instance and shared by every user:
//   Sleeper state (season / week), Sleeper weekly stats (current week + every completed week),
//   ESPN scoreboard (game state, clock, kickoff) with Sleeper's schedule as the last resort.
// Cached ~1 min while a game is live, 5 min otherwise; completed weeks 6 h (stat corrections).
import { nflWeek } from "./live.js";
import { gameStates, scheduleToEspn, weekPointsMap } from "./pubscore.js";

const SLEEPER_STATE = "https://api.sleeper.app/v1/state/nfl";
// ESPN's CDN scoreboard first: site.api.espn.com answers 403 to server IPs at times
const ESPN_URLS = ["https://cdn.espn.com/core/nfl/scoreboard?xhr=1", "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"];
const sleeperSchedule = (season) => `https://api.sleeper.app/schedule/nfl/regular/${season}`;
const sleeperUrl = (season, week) => `https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`;
const TTL_LIVE = 55e3, TTL_IDLE = 5 * 60e3, TTL_PAST = 6 * 60 * 60e3;

let cache = null; // { at, ok, season, week, espn, rows, past, live, feeds, error }
const pastWeeks = new Map(); // week → { at, season, map }

export async function fetchJson(url, ms = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "user-agent": "Mozilla/5.0 (compatible; dkbbdb/1.0; live scoring)", accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function fetchScoreboard() {
  const errors = [];
  for (const u of ESPN_URLS) {
    try { const j = await fetchJson(u); const sb = j?.content?.sbData ?? j; if (Array.isArray(sb?.events)) return { sb, from: u }; errors.push(`${u} → no events`); }
    catch (e) { errors.push(String(e?.message ?? e)); }
  }
  return { sb: null, error: errors.join(" | ") };
}

// completed weeks 1 … week-1 → [[week, Map(sleeperId → { pts, team })], …], or null when any week is
// missing (season totals must never silently drop a week)
async function getPastWeeks(season, week, feeds) {
  const now = Date.now(), want = [];
  for (let w = 1; w < week; w++) want.push(w);
  const errors = [];
  await Promise.all(want.map(async (w) => {
    const have = pastWeeks.get(w);
    if (have && have.season === season && now - have.at < TTL_PAST) return;
    try {
      const rows = await fetchJson(sleeperUrl(season, w));
      const map = weekPointsMap(Array.isArray(rows) ? rows : []);
      if (!map.size) throw new Error(`week ${w}: no stats rows`); // a finished week is never empty
      pastWeeks.set(w, { at: now, season, map });
    } catch (e) {
      errors.push(String(e?.message ?? e));
      if (have && have.season === season) have.at = now - TTL_PAST + 15 * 60e3; // keep the stale map, retry in 15 min
    }
  }));
  const weeks = want.map((w) => [w, pastWeeks.get(w)?.map]).filter(([, m]) => m);
  feeds.priorWeeks = weeks.map(([w]) => w);
  if (errors.length) feeds.priorError = errors.join(" | ");
  return weeks.length === want.length ? weeks : null;
}

export async function getFeeds(now = Date.now()) {
  if (cache?.ok && now - cache.at < (cache.live ? TTL_LIVE : TTL_IDLE)) return cache;
  const feeds = {};
  try {
    const [state, board] = await Promise.all([fetchJson(SLEEPER_STATE).catch((e) => { feeds.stateError = String(e?.message ?? e); return null; }), fetchScoreboard()]);
    const season = Number(state?.season) || board.sb?.season?.year || new Date(now).getUTCFullYear();
    // week comes from Sleeper's state, the same source the stats are fetched for — never from the
    // scoreboard, which flips to the next week at a different moment on Tuesday
    const week = Number(state?.week) || board.sb?.week?.number || nflWeek(new Date(now).toISOString()) || 1;
    let espn = board.sb;
    feeds.games = board.from ?? null;
    if (!espn) {
      feeds.espnError = board.error;
      try { espn = scheduleToEspn(await fetchJson(sleeperSchedule(season)), week, season); feeds.games = "sleeper-schedule"; }
      catch (e) { feeds.scheduleError = String(e?.message ?? e); espn = { week: { number: week }, season: { year: season }, events: [] }; feeds.games = "none"; }
    }
    let [rows, past] = await Promise.all([fetchJson(sleeperUrl(season, week)), getPastWeeks(season, week, feeds)]);
    if (!past) past = await getPastWeeks(season, week, feeds); // one retry: only the weeks still missing are fetched
    // there is no database fallback for completed weeks, and a view missing one would show wrong season
    // totals and ranks — better to keep serving the last good feeds (or "unavailable") than that
    if (!past) throw new Error(`completed weeks unavailable: ${feeds.priorError ?? "unknown"}`);
    feeds.prior = week <= 1 ? "none (week 1)" : "sleeper";
    const live = Object.values(gameStates(espn)).some((g) => g.st === "L");
    cache = { at: now, ok: true, season, week, espn, rows: Array.isArray(rows) ? rows : [], past, live, feeds: { ...feeds, season, week }, error: null };
  } catch (e) {
    // keep serving the last good feeds; note the failure
    cache = { ...(cache ?? { ok: false, feeds: {} }), at: now, error: String(e?.message ?? e) };
  }
  return cache;
}
