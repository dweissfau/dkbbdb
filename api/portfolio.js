// GET /api/portfolio?entry=<entry id> — one team's draft, picks and players: what the leaderboard's team pop-up
// boots from. Read from the store file in Blob (lib/store.js); the database only when the store is unavailable.
// There are no whole-portfolio pages on dkbbdb (the owner keeps those on his own site).
import { db } from "../lib/db.js";
import { resolveEntry } from "../lib/accounts.js";
import { userPortfolio } from "../lib/portfolio.js";
import { loadStore, entryOwner, portfolioOf } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const store = await loadStore();
  const one = req.query.entry ? (store ? entryOwner(store, req.query.entry) : await resolveEntry(db(), req.query.entry)) : null;
  if (!one) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "that team is not on dkbbdb" }); }
  const data = store ? portfolioOf(store, [one.account.user_key], [one.entryId]) : await userPortfolio(db(), [one.account.user_key], [one.entryId]);
  res.setHeader("cache-control", "public, s-maxage=30, stale-while-revalidate=60");
  res.setHeader("x-dkbbdb-source", store ? "store" : "db");
  res.status(200).json({ ...data, me: { accounts: [one.account.username] } });
}
