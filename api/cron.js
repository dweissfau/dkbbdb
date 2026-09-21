// GET /api/cron — Tuesday morning after the NFL week rolls (vercel.json): record every synced account's ranks
// for the new week's Tuesday key = last week's final standings, which the Δ arrow compares against
// (lib/live.js prevWeekRank). Vercel calls it with "Authorization: Bearer <CRON_SECRET>".
import { db } from "../lib/db.js";
import { userView } from "../lib/view.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  const { rows } = await db().query("select distinct user_key from entries");
  let saved = 0; const errors = [];
  for (const { user_key } of rows) {
    try { const r = await userView(db(), [user_key], { forceSave: true }); saved += r.body?.source?.historySaved > 0 ? 1 : 0; }
    catch (e) { errors.push(`${user_key}: ${String(e?.message ?? e)}`); }
  }
  res.status(200).json({ ok: true, accounts: rows.length, saved, errors });
}
