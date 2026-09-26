// GET /api/cron — Tuesday morning after the NFL week rolls (vercel.json): score the board once so the finished week
// is folded into the stored totals (lib/prior.js) and every team's rank for the new week's Tuesday is on record
// (lib/leaderboard.js saveHistory — the Δ arrow compares against it). Vercel calls it with "Authorization: Bearer <CRON_SECRET>".
import { refreshBoard } from "../lib/leaderboard.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  const errors = [];
  let board = null;
  try { const b = await refreshBoard(); board = b ? { teams: b.teams.length, week: b.week } : "feeds unavailable"; } catch (e) { errors.push("board: " + String(e?.message ?? e)); }
  res.status(200).json({ ok: true, board, errors });
}
