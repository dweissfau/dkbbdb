// GET /api/search?type=player&q=<text>&u=<dk username> — player suggestions for a profile page's filter: rostered
// players (within that account's teams) whose name contains every typed word. There is no username search on the
// site: a page is reached by its address, never by looking other people up.
import { db } from "../lib/db.js";
import { searchPlayers } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=20");
  const results = req.query.type === "player" && req.query.u ? await searchPlayers(db(), req.query.q, req.query.u) : [];
  res.status(200).json({ results });
}
