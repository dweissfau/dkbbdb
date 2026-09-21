// GET /api/portfolio?u=<dk username>[,<dk username>…] — that portfolio's drafts, picks and players (what the
// app page boots from). Public, like bbmdb: only accounts whose owner synced them exist here.
import { db } from "../lib/db.js";
import { resolveAccounts } from "../lib/accounts.js";
import { userPortfolio } from "../lib/portfolio.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const accounts = await resolveAccounts(db(), req.query.u);
  if (!accounts.length) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "no synced teams under that username" }); }
  const data = await userPortfolio(db(), accounts.map((a) => a.user_key));
  res.setHeader("cache-control", "public, s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ ...data, me: { accounts: accounts.map((a) => a.username) } });
}
