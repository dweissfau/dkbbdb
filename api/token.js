// POST /api/token — a fresh sync token for the signed-in user's extension (replaces any earlier one).
// The token is shown once; only its hash is stored.
import { db } from "../lib/db.js";
import { issueSyncToken, requireUser } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = await requireUser(db(), req, res); if (!user) return;
  res.status(200).json({ token: await issueSyncToken(db(), user.id) });
}
