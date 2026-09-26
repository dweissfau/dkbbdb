// GET /api/search?type=player&q=<text>&u=<dk username>&t=<tournament> — player suggestions for a filter box: rostered
// players (within that account's teams, or within the tournament on the leaderboard) whose name contains every typed word.
// GET /api/search?type=user&q=<text>&t=<tournament> — the leaderboard's User box: synced accounts whose username
// contains the typed text, with their team count in that tournament.
import { db } from "../lib/db.js";
import { searchPlayers, searchUsers } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=20");
  const { type, q, u = "", t = "" } = req.query;
  const results = type === "player" ? await searchPlayers(db(), q, u, t) : type === "user" ? await searchUsers(db(), q, t) : [];
  res.status(200).json({ results });
}
