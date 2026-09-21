// GET /api/leaderboard?t=<tournament>&u=<dk username>&p=<dk player id>&offset=&limit=
// The front page's season leaderboard among every synced team, with its filters and the player stats.
import { db } from "../lib/db.js";
import { leaderboard } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=45, stale-while-revalidate=60");
  const { t, u, p, offset, limit } = req.query;
  res.status(200).json(await leaderboard(db(), { t, u, p, offset, limit }));
}
