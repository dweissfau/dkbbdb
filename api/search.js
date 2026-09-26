// GET /api/search?type=player&q=<text>&u=<dk username>&t=<tournament> — player suggestions for a filter box: rostered
// players (within that account's teams, or within the tournament on the leaderboard) whose name contains every typed
// word. There is no username search: accounts are picked from the leaderboard's menu, and a page is reached by its address.
import { db } from "../lib/db.js";
import { searchPlayers } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=20");
  const results = req.query.type === "player" ? await searchPlayers(db(), req.query.q, req.query.u ?? "", req.query.t ?? "") : [];
  res.status(200).json({ results });
}
