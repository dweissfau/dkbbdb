// GET /api/leaderboard — a profile page's data: one account's teams, scored like every other page (lib/leaderboard.js).
//   ?view=teams (default)  &u=<dk username>&t=<tournament>&p=<dk player id[,id…]>&adv=1&sort=&dir=&offset=&limit=
//   ?view=players          &u=<dk username>&t=&pos=QB|RB|WR|TE&q=<part of a name>&sort=&dir=&offset=&limit=
// The username is REQUIRED: the whole-field leaderboard (every synced account, public/leaderboard.html) is kept for
// the day DraftKings publishes everyone's teams and is only served when DKBBDB_FIELD=1 is set on the deployment.
import { db } from "../lib/db.js";
import * as lb from "../lib/leaderboard.js";
const { leaderboard, playersView } = lb;

// a request may carry the board refresh — and, right after a week ends, the one-off fold of that week
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const q = req.query, fn = q.view === "players" ? playersView : leaderboard;
  if (!String(q.u ?? "").trim() && process.env.DKBBDB_FIELD !== "1") return res.status(404).json({ error: "a username is required" });
  res.setHeader("cache-control", "public, s-maxage=45, stale-while-revalidate=60");
  const body = await fn(db(), q);
  res.setHeader("x-dkbbdb-board", lb.lastServed || "none"); // mem | cache | db | run — where the board came from
  res.status(200).json(body);
}
