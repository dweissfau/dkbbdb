// POST /api/tournaments — the extension sends payout-related excerpts of a tournament's DraftKings pages
// (shape: lib/payouts.js storeCaptures): { tournaments: [{ key, name, sources: [{ url, status, body }] }] }.
// They are stored per tournament and a payout ladder is read out of them (the "Winning" stat). Like /api/sync
// there is no sign-in; the payload is capped and the sender rate-limited.
import { db } from "../lib/db.js";
import { senderHash } from "../lib/guard.js";
import { storeCaptures } from "../lib/payouts.js";
import { publishStore } from "../lib/store.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!req.headers["x-dkbbdb-extension"]) return res.status(400).json({ error: "uploads come from the dkbbdb extension" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}; } catch { return res.status(400).json({ error: "not JSON" }); }
  if (!Array.isArray(body.tournaments)) return res.status(400).json({ error: "tournaments[] expected" });
  const out = await storeCaptures(db(), body.tournaments, { sender: senderHash(req) });
  if (out.limited) return res.status(429).json({ error: out.limited });
  let published = null; try { published = await publishStore(db()); } catch (e) { published = { error: String(e?.message ?? e) }; } // ladders live in the store file
  res.status(200).json({ ok: true, tournaments: out, published });
}
