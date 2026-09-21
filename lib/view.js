// One user's live view: their pods scored from the shared public feeds, in the shape the pages consume
// (lib/live.js deriveView). Nothing is stored except one rank per entry per NFL day (the weekly Δ arrow).
import { createHash } from "node:crypto";
import { deriveView, nflDay } from "./live.js";
import { computeSnapshot, foldWeeks, overlay } from "./pubscore.js";
import { buildBase } from "./base.js";
import { getFeeds } from "./feeds.js";

export const VIEW_VERSION = 1; // bump to invalidate browser-cached views after a view-format change
const HISTORY_SAVE_MS = 10 * 60e3;
const historySavedAt = new Map(); // userId → ms

async function readHistory(db, ids) {
  const out = {};
  if (!ids.length) return out;
  const { rows } = await db.query(
    `select entry_id, to_char(day, 'YYYY-MM-DD') d, rank from rank_history where entry_id = any($1::bigint[]) and rank is not null order by day`, [ids]);
  for (const r of rows) (out[r.entry_id] ??= []).push([r.d, r.rank]);
  return out;
}

async function saveToday(db, userId, snap, base, now, force) {
  if (!force && now - (historySavedAt.get(userId) ?? 0) <= HISTORY_SAVE_MS) return null;
  historySavedAt.set(userId, now);
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

// → { status: 200 | 304, etag, body }
export async function userView(db, userId, { ifNoneMatch = "", now = Date.now(), forceSave = false } = {}) {
  const [base, f] = await Promise.all([buildBase(db, userId, now), getFeeds(now)]);
  const ids = Object.keys(base.entries);
  if (!ids.length) return { status: 200, body: { live: false, reason: "no teams synced yet" } };
  if (!f.ok) return { status: 200, body: { live: false, reason: `public feeds unavailable (${f.error ?? "unknown"})` } };

  const past = foldWeeks(base, f.past); // f.past is always complete (lib/feeds.js refuses otherwise)
  const computed = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
  // scoring is cheap; hashing its result lets an unchanged view answer 304 with no body
  const etag = `"${createHash("sha1").update(JSON.stringify([computed.pods, computed.rosters, userId, VIEW_VERSION])).digest("hex").slice(0, 20)}"`;
  if (!forceSave && ifNoneMatch && ifNoneMatch.replace(/^W\//, "") === etag) return { status: 304, etag };
  const history = await readHistory(db, ids);
  const snap = overlay({ v: 1, at: null, week: null, contests: base.contests, pods: {}, rosters: {}, history, rostersAt: {} }, computed, base, now);
  const historySaved = await saveToday(db, userId, snap, base, now, forceSave).catch((e) => "failed: " + String(e?.message ?? e));
  const view = deriveView(snap, base, {});
  const source = { ...snap.source, feedError: f.error ?? null, feeds: f.feeds ?? null, historySaved };
  return { status: 200, etag, body: { live: true, ...view, source } };
}
