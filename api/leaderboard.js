// GET /api/leaderboard — the front page's data, three views over every synced team (lib/leaderboard.js):
//   ?view=teams (default)  &t=<tournament>&u=<dk username>&p=<dk player id[,id…]>&adv=1&sort=&dir=&offset=&limit=
//   ?view=players          &t=&u=&pos=QB|RB|WR|TE&sort=&dir=&offset=&limit=
//   ?view=users            &t=&sort=&dir=&offset=&limit=
import { db } from "../lib/db.js";
import { leaderboard, playersView, usersView } from "../lib/leaderboard.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=45, stale-while-revalidate=60");
  const q = req.query, fn = q.view === "players" ? playersView : q.view === "users" ? usersView : leaderboard;
  res.status(200).json(await fn(db(), q));
}
