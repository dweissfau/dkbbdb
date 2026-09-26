// POST /api/sync — the extension uploads a chunk of drafts (shape: lib/ingest.js). No sign-in: the DraftKings
// account comes from the drafts themselves. Because anyone can call this, every upload goes through lib/guard.js
// (plausibility checks, username lock, rate limits, upload log) and can only ADD to what is stored — never change
// a finished roster, a contest, a username or a player list. After the last chunk the store file is rebuilt and
// players new to the site are matched to the public stats feed so they score immediately.
import { senderHash } from "../lib/guard.js";
import { ingestDrafts } from "../lib/ingest.js";
import { mapSleeper } from "../lib/sleeper.js";
import { publishStore, buildStore } from "../lib/store.js";
import aliases from "../db/sleeper-aliases.json" with { type: "json" };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!req.headers["x-dkbbdb-extension"]) return res.status(400).json({ error: "uploads come from the dkbbdb extension" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}; } catch { return res.status(400).json({ error: "not JSON" }); }
  if (!Array.isArray(body.drafts)) return res.status(400).json({ error: "drafts[] expected" });
  if (body.drafts.length > 300) return res.status(413).json({ error: "at most 300 drafts per upload" });

  const out = await ingestDrafts(body, { sender: senderHash(req), ext: req.headers["x-dkbbdb-extension"] });
  if (out.limited) return res.status(429).json({ error: out.limited });
  // body.last marks the final chunk of a sync: do the slower follow-up once, there
  if (body.last !== false && out.drafts) {
    try {
      const store = await buildStore();
      const m = await mapSleeper(store, { aliases }); out.mapped = m.mapped; out.unmatched = m.unmatched.map((u) => u.name);
    } catch (e) { out.errors.push("stats matching: " + String(e?.message ?? e)); }
    try { out.published = await publishStore(); } catch (e) { out.errors.push("publish: " + String(e?.message ?? e)); }
  }
  res.status(200).json({ ok: true, ...out });
}
