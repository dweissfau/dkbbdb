// Site-wide leaderboard for the front page: the highest-scoring teams among every synced account, this season
// and this week, scored exactly like the portfolio pages (same base → computeSnapshot path).
// Computed over ALL synced teams and cached per instance; fine for thousands of teams — beyond that it should
// move to a table refreshed by a cron instead of being computed on request.
import { computeSnapshot, foldWeeks } from "./pubscore.js";
import { buildBase } from "./base.js";
import { getFeeds } from "./feeds.js";

const TTL = 60e3, TOP = 50;
let cache = null; // { at, body }

export async function leaderboard(db, now = Date.now()) {
  if (cache && now - cache.at < TTL) return cache.body;
  const accounts = (await db.query("select user_key, username from dk_accounts")).rows;
  const nameOf = new Map(accounts.map((a) => [a.user_key, a.username]));
  const [base, f] = await Promise.all([buildBase(db, accounts.map((a) => a.user_key), now), getFeeds(now)]);
  if (!f.ok) return cache?.body ?? { live: false, reason: f.error ?? "public feeds unavailable" };

  const past = foldWeeks(base, f.past);
  const snap = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
  const meta = new Map((await db.query(
    `select e.entry_id, e.user_key, c.name, c.buy_in from entries e join contests c on c.contest_id = e.contest_id`)).rows.map((r) => [String(r.entry_id), r]));

  const teams = [];
  for (const [id, e] of Object.entries(base.entries)) {
    const pod = snap.pods[e.cid]; if (!pod) continue;
    const row = pod.find((r) => r[0] === Number(id)); if (!row) continue;
    const m = meta.get(id), wk = snap.weekly?.teams?.[e.cid]?.[id]?.t ?? [];
    teams.push({ id, user: nameOf.get(m?.user_key) ?? row[1], contest: m?.name ?? null, buyIn: m?.buy_in == null ? null : Number(m.buy_in),
      points: row[3], week: wk.length ? wk[wk.length - 1] : null, rank: row[2], entrants: pod.length, adv: e.pp != null && row[2] != null ? row[2] <= e.pp : null });
  }
  const top = (key) => [...teams].filter((t) => t[key] != null).sort((a, b) => b[key] - a[key]).slice(0, TOP);
  const body = { live: true, at: snap.at, week: snap.week, playing: snap.live, accounts: accounts.length, teams: teams.length, season: top("points"), thisWeek: top("week") };
  cache = { at: now, body };
  return body;
}
