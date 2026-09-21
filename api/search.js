// GET /api/search?q=<start of a dk username> — synced accounts only.
import { db } from "../lib/db.js";
import { searchAccounts } from "../lib/accounts.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=20");
  res.status(200).json({ results: await searchAccounts(db(), req.query.q) });
}
