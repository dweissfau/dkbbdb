// GET /api/live — the signed-in user's teams scored from public NFL stats (lib/view.js).
// Conditional: send If-None-Match with the previous ETag → 304 when nothing changed.
import { db } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { userView } from "../lib/view.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const user = await requireUser(db(), req, res); if (!user) return;
  const r = await userView(db(), user.id, { ifNoneMatch: String(req.headers["if-none-match"] ?? "") });
  if (r.etag) res.setHeader("etag", r.etag);
  if (r.status === 304) return res.status(304).end();
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(r.body));
}
