// GET /api/live?u=<dk username>[,…] — that portfolio's teams scored from public NFL stats (lib/view.js).
// Conditional: send If-None-Match with the previous ETag → 304 when nothing changed. The CDN may hold a
// response for 30 s, so a popular page costs one computation per half minute however many people watch it.
import { db } from "../lib/db.js";
import { resolveAccounts } from "../lib/accounts.js";
import { userView } from "../lib/view.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const accounts = await resolveAccounts(db(), req.query.u);
  if (!accounts.length) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "no synced teams under that username" }); }
  const r = await userView(db(), accounts.map((a) => a.user_key), { ifNoneMatch: String(req.headers["if-none-match"] ?? "") });
  res.setHeader("cache-control", "public, s-maxage=30, stale-while-revalidate=30");
  if (r.etag) res.setHeader("etag", r.etag);
  if (r.status === 304) return res.status(304).end();
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(r.body));
}
