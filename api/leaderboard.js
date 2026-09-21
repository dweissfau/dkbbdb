// GET /api/leaderboard — the front page's top teams (season and this week) among every synced account.
import { db } from "../lib/db.js";
import { leaderboard } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=45, stale-while-revalidate=60");
  res.status(200).json(await leaderboard(db()));
}
