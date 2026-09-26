// GET /api/portfolio?entry=<entry id> — one team's draft, picks and players: what the leaderboard's team pop-up
// boots from, read from the store file (lib/store.js). There are no whole-portfolio pages on dkbbdb.
import { loadStore, entryOwner, portfolioOf } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const store = await loadStore();
  const one = store && req.query.entry ? entryOwner(store, req.query.entry) : null;
  if (!one) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "that team is not on dkbbdb" }); }
  const data = portfolioOf(store, [one.account.user_key], [one.entryId]);
  res.setHeader("cache-control", "public, s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ ...data, me: { accounts: [one.account.username] } });
}
