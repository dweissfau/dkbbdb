// POST /api/known { entries: [entry ids] } — what the extension may skip: finished pods already stored
// (their drafts are never fetched from DraftKings twice) and draft groups whose player list is on file.
import { knownEntries } from "../lib/ingest.js";

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  res.status(200).json({ ok: true, ...(await knownEntries(body.entries)) });
}
