// One portfolio's live view: its pods scored from the shared public feeds, in the shape the pages consume
// (lib/live.js deriveView). Nothing is stored here; the rank history it shows is written by the board run.
import { createHash } from "node:crypto";
import { deriveView, nflDay } from "./live.js";
import { computeSnapshot, foldWeeks, overlay } from "./pubscore.js";
import { getFeeds } from "./feeds.js";
import { readHistoryAll } from "./leaderboard.js";

export const VIEW_VERSION = 1; // bump to invalidate browser-cached views after a view-format change
// rank history (data/history.json.gz, written by the board run — lib/leaderboard.js saveHistory) for these entries
async function readHistory(ids) {
  const h = await readHistoryAll(), out = {};
  for (const id of ids) if (h[id]?.length) out[id] = h[id].map(([d, r]) => [d, r]);
  return out;
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

// → { status: 200 | 304, etag, body }   base = the scoring base for these teams (lib/store.js baseOf)
export async function userView(userKeys, { ifNoneMatch = "", now = Date.now(), only = null, base } = {}) {
  const who = [...userKeys].sort().join(",") + (only ? "#" + [...only].sort().join(",") : "");
  const f = await getFeeds(now);
  const ids = Object.keys(base?.entries ?? {});
  if (!ids.length) return { status: 200, body: { live: false, reason: "no teams synced yet" } };
  if (!f.ok) return { status: 200, body: { live: false, reason: `public feeds unavailable (${f.error ?? "unknown"})` } };

  const past = foldWeeks(base, f.past); // f.past is always complete (lib/feeds.js refuses otherwise)
  const computed = computeSnapshot(base, f.rows, f.espn, now, { week: f.week, prior: past.prior, weekly: past.weekly });
  // scoring is cheap; hashing its result lets an unchanged view answer 304 with no body
  const etag = `"${createHash("sha1").update(JSON.stringify([computed.pods, computed.rosters, who, VIEW_VERSION])).digest("hex").slice(0, 20)}"`;
  if (ifNoneMatch && ifNoneMatch.replace(/^W\//, "") === etag) return { status: 304, etag };
  const history = await readHistory(ids).catch(() => ({}));
  const snap = overlay({ v: 1, at: null, week: null, contests: base.contests, pods: {}, rosters: {}, history, rostersAt: {} }, computed, base, now);
  const view = compactView(deriveView(snap, base, {}));
  const source = { ...snap.source, feedError: f.error ?? null, feeds: f.feeds ?? null };
  return { status: 200, etag, body: { live: true, ...view, source } };
}
