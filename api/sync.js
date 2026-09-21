// POST /api/sync — the extension uploads a chunk of drafts (shape: lib/ingest.js). Authenticated by the
// sync token. Player lists the extension did not send are fetched from DraftKings' public feed, and
// players new to the site are matched to the public stats feed so they score immediately.
import { createRequire } from "node:module";
import { db } from "../lib/db.js";
import { requireSyncUser } from "../lib/auth.js";
import { fetchDraftables, ingestDrafts, missingDraftGroups } from "../lib/ingest.js";
import { mapSleeper } from "../lib/sleeper.js";

const aliases = createRequire(import.meta.url)("../db/sleeper-aliases.json");
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("cache-control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const user = await requireSyncUser(db(), req, res); if (!user) return;
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  if (!Array.isArray(body.drafts)) return res.status(400).json({ error: "drafts[] expected" });
  if (body.drafts.length > 50) return res.status(413).json({ error: "at most 50 drafts per upload" });

  const out = await ingestDrafts(db(), user.id, body);
  // body.last marks the final chunk of a sync: do the slower follow-ups once, there
  if (body.last !== false) {
    for (const dgid of await missingDraftGroups(db())) {
      try { await ingestDrafts(db(), user.id, { drafts: [], draftables: { [dgid]: await fetchDraftables(dgid) } }); }
      catch (e) { out.errors.push(String(e?.message ?? e)); }
    }
    try { const m = await mapSleeper(db(), { aliases }); out.mapped = m.mapped; out.unmatched = m.unmatched.map((u) => u.name); }
    catch (e) { out.errors.push("stats matching: " + String(e?.message ?? e)); }
  }
  res.status(200).json({ ok: true, ...out });
}
