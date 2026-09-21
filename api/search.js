// GET /api/search?q=<text>&type=user|player — suggestions for the leaderboard filters:
//   user    DraftKings usernames starting with q (synced accounts only)
//   player  rostered players whose name contains every typed word
import { db } from "../lib/db.js";
import { searchAccounts } from "../lib/accounts.js";
import { searchPlayers } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=20");
  const results = req.query.type === "player" ? await searchPlayers(db(), req.query.q) : await searchAccounts(db(), req.query.q);
  res.status(200).json({ results });
}
