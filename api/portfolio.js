// GET /api/portfolio — the signed-in user's drafts, picks and players (what the app page boots from).
import { db } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { userPortfolio } from "../lib/portfolio.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const user = await requireUser(db(), req, res); if (!user) return;
  const data = await userPortfolio(db(), user.id);
  const accounts = (await db().query("select username from dk_accounts where user_id = $1 order by created_at", [user.id])).rows.map((r) => r.username);
  res.status(200).json({ ...data, me: { email: user.email, accounts } });
}
