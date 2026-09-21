// POST /api/sync — the extension uploads a chunk of drafts (shape: lib/ingest.js). No sign-in: the DraftKings
// account comes from the drafts themselves, and syncing is what makes a username searchable. Finished rosters
// are never overwritten (lib/ingest.js), so an upload cannot change what is already stored for a pod.
// Player lists the extension did not send are fetched from DraftKings' public feed, and players new to the
// site are matched to the public stats feed so they score immediately.
import { db } from "../lib/db.js";
import { fetchDraftables, ingestDrafts, missingDraftGroups } from "../lib/ingest.js";
import { mapSleeper } from "../lib/sleeper.js";
import aliases from "../db/sleeper-aliases.json" with { type: "json" };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!req.headers["x-dkbbdb-extension"]) return res.status(400).json({ error: "uploads come from the dkbbdb extension" });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  if (!Array.isArray(body.drafts)) return res.status(400).json({ error: "drafts[] expected" });
  if (body.drafts.length > 300) return res.status(413).json({ error: "at most 300 drafts per upload" });

  const out = await ingestDrafts(db(), body);
  // body.last marks the final chunk of a sync: do the slower follow-ups once, there
  if (body.last !== false) {
    for (const dgid of await missingDraftGroups(db())) {
      try { await ingestDrafts(db(), { drafts: [], draftables: { [dgid]: await fetchDraftables(dgid) } }); }
      catch (e) { out.errors.push(String(e?.message ?? e)); }
    }
    try { const m = await mapSleeper(db(), { aliases }); out.mapped = m.mapped; out.unmatched = m.unmatched.map((u) => u.name); }
    catch (e) { out.errors.push("stats matching: " + String(e?.message ?? e)); }
  }
  res.status(200).json({ ok: true, ...out });
}
