// One portfolio's live view: its pods scored from the shared public feeds, in the shape the pages consume
// (lib/live.js deriveView). Nothing is stored except one rank per entry per NFL day (the weekly Δ arrow).
import { createHash } from "node:crypto";
import { deriveView, nflDay } from "./live.js";
import { computeSnapshot, foldWeeks, overlay } from "./pubscore.js";
import { buildBase, keyOf } from "./base.js";
import { getFeeds } from "./feeds.js";

export const VIEW_VERSION = 1; // bump to invalidate browser-cached views after a view-format change
const HISTORY_SAVE_MS = 10 * 60e3;
const historySavedAt = new Map(); // portfolio key → ms

async function readHistory(db, ids) {
  const out = {};
  if (!ids.length) return out;
  const { rows } = await db.query(
    `select entry_id, to_char(day, 'YYYY-MM-DD') d, rank from rank_history where entry_id = any($1::bigint[]) and rank is not null order by day`, [ids]);
  for (const r of rows) (out[r.entry_id] ??= []).push([r.d, r.rank]);
  return out;
}

async function saveToday(db, who, snap, base, now, force) {
  if (!force && now - (historySavedAt.get(who) ?? 0) <= HISTORY_SAVE_MS) return null;
  historySavedAt.set(who, now);
  const day = nflDay(new Date(now).toISOString());
  const ids = [], ranks = [], pts = [];
  for (const [id, e] of Object.entries(base.entries)) {
    const row = snap.pods?.[e.cid]?.find((r) => r[0] === Number(id));
    if (row?.[2] != null) { ids.push(id); ranks.push(row[2]); pts.push(row[3]); }
  }
  if (!ids.length) return 0;
  await db.query(
    `insert into rank_history (entry_id, day, rank, points)
     select * from unnest($1::bigint[], array_fill($2::date, array[$5::int]), $3::int[], $4::numeric[])
     on conflict (entry_id, day) do update set rank = excluded.rank, points = excluded.points`, [ids, day, ranks, pts, ids.length]);
  return ids.length;
}

// A roster row ends with its game state — [.., pmr, st, ts, game, start, (slots)] — identical for every player of
// the same NFL team, and it made a 200-team view ~4 MB (Vercel caps a response at 4.5 MB). Rows carry an index
// into view.games instead; public/boot.js expandView() restores the original rows before the page sees them.
//   scores rows: game fields at 4–8      opp rows: game fields at 4–8, then the weekly slot letters
export function compactView(view) {
  const games = [], idx = new Map();
  const gi = (row) => {
    const g = row.slice(4, 9), k = JSON.stringify(g);
    if (!idx.has(k)) { idx.set(k, games.length); games.push(g); }
    return idx.get(k);
  };
  const pack = (row) => [...row.slice(0, 4), gi(row), ...row.slice(9)];
  const scores = Object.fromEntries(Object.entries(view.scores ?? {}).map(([id, rows]) => [id, rows.map(pack)]));
  const rosters = Object.fromEntries(Object.entries(view.opp?.rosters ?? {}).map(([cid, byKey]) =>
    [cid, Object.fromEntries(Object.entries(byKey).map(([k, rows]) => [k, rows.map(pack)]))]));
  return { ...view, games, scores, opp: { ...(view.opp ?? {}), rosters } };
}

// → { status: 200 | 304, etag, body }
export async function userView(db, userKeys, { ifNoneMatch = "", now = Date.now(), forceSave = false, only = null } = {}) {
  const who = keyOf(userKeys, only);
  const [base, f] = await Promise.all([buildBase(db, userKeys, now, only), getFeeds(now)]);
  const ids = Object.keys(base.entries);
  if (!ids.length) return { status: 200, body: { live: false, reason: "no teams synced yet" } };
  if (!f.ok) return { status: 200, body: { live: false, reason: `public feeds unavailable (${f.error ?? "unknown"})` } };

  const past = foldWeeks(base, f.past); // f.past is always complete (lib/feeds.js refuses otherwise)
  const computed = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
  // scoring is cheap; hashing its result lets an unchanged view answer 304 with no body
  const etag = `"${createHash("sha1").update(JSON.stringify([computed.pods, computed.rosters, who, VIEW_VERSION])).digest("hex").slice(0, 20)}"`;
  if (!forceSave && ifNoneMatch && ifNoneMatch.replace(/^W\//, "") === etag) return { status: 304, etag };
  const history = await readHistory(db, ids);
  const snap = overlay({ v: 1, at: null, week: null, contests: base.contests, pods: {}, rosters: {}, history, rostersAt: {} }, computed, base, now);
  const historySaved = await saveToday(db, who, snap, base, now, forceSave).catch((e) => "failed: " + String(e?.message ?? e));
  const view = compactView(deriveView(snap, base, {}));
  const source = { ...snap.source, feedError: f.error ?? null, feeds: f.feeds ?? null, historySaved };
  return { status: 200, etag, body: { live: true, ...view, source } };
}
