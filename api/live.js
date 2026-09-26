// GET /api/live?entry=<entry id> — one team and its league, scored from public NFL stats (lib/view.js): the
// leaderboard's team pop-up. The league's rosters come from the store file (lib/store.js).
// Conditional: send If-None-Match with the previous ETag → 304 when nothing changed. The CDN may hold a
// response for 30 s, so a popular page costs one computation per half minute however many people watch it.
import { userView } from "../lib/view.js";
import { loadStore, entryOwner, baseOf } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const store = await loadStore();
  const one = store && req.query.entry ? entryOwner(store, req.query.entry) : null;
  if (!one) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "that team is not on dkbbdb" }); }
  const keys = [one.account.user_key];
  const r = await userView(keys, { ifNoneMatch: String(req.headers["if-none-match"] ?? ""), only: [one.entryId], base: baseOf(store, keys, [one.entryId]) });
  res.setHeader("cache-control", "public, s-maxage=30, stale-while-revalidate=30");
  if (r.etag) res.setHeader("etag", r.etag);
  if (r.status === 304) return res.status(304).end();
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(r.body));
}
