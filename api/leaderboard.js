// GET /api/leaderboard — the site's scored teams (lib/leaderboard.js): one account's page, or the leaderboard of one tournament.
//   ?view=teams (default)  &u=<dk username>&t=<tournament>&p=<dk player id[,id…]>&x=<player ids a team must NOT have>&adv=1&sort=&dir=&offset=&limit=
//   ?view=players          &u=<dk username>&t=&p=&x=&pos=QB|RB|WR|TE&q=<part of a name>&sort=&dir=&offset=&limit=
//   both views: &only=<entry id,id…> keeps just those teams, &hide=<entry id,id…> drops them (the page's ticked teams);
//   the teams view adds `ids` (every id in the filtered set) with &withIds=1. A POST with the same fields as a JSON
//   body is the same request — the page uses it when a ticked list is too long for an address.
// There is no whole-field list: without a username the answer is ONE tournament's teams — the one asked for, or
// the biggest one when none is (public/leaderboard.html never shows every synced team at once).
import { db } from "../lib/db.js";
import * as lb from "../lib/leaderboard.js";
const { leaderboard, playersView } = lb;

// a request may carry the board refresh — and, right after a week ends, the one-off fold of that week
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const body0 = req.method === "POST" && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const q = { ...req.query, ...Object.fromEntries(Object.entries(body0).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)])) };
  const fn = q.view === "players" ? playersView : leaderboard;
  if (req.method !== "POST") res.setHeader("cache-control", "public, s-maxage=45, stale-while-revalidate=60");
  const d = db();
  let body = await fn(d, q);
  if (body.live && !String(q.u ?? "").trim() && !String(q.t ?? "").trim() && body.tournaments?.length) body = await fn(d, { ...q, t: body.tournaments[0].name });
  res.setHeader("x-dkbbdb-board", lb.lastServed || "none"); // mem | cache | db | run — where the board came from
  res.status(200).json(body);
}
