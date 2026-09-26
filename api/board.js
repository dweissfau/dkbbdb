// /api/board — the site's side of scoring off the site (scripts/score.mjs on GitHub Actions). Everything but the
// plain status needs Authorization: Bearer <CRON_SECRET>. Big payloads travel as gzip'd + base64 PIECES (a request or
// response body is capped at 4.5 MB): { stamp, part, parts, gz }.
//   GET  /api/board                          what the site is serving: { at, teams, storedAt, playing, week }
//   GET  /api/board?file=store&part=n        piece n of the store file, straight from this instance's memory (no Blob read)
//   GET  /api/board?file=prior&part=n        piece n of the finished-week totals (a Blob read — the job caches them between runs)
//   POST /api/board { kind: "board" | "prior", stamp, part, parts, gz }
//        board: the scored board → adopted (lib/leaderboard.js adoptBoard: runtime cache, rank history, daily Blob backup)
//        prior: recomputed finished-week totals → store/prior.json.gz (once a week, when a week ends)
import { timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { adoptBoard, boardStatus } from "../lib/leaderboard.js";
import { loadStore, storeEtag, PATHS } from "../lib/store.js";
import { getGz, putGz } from "../lib/files.js";
import { rcMark, rcRead, rcDrop, rcPut } from "../lib/rcache.js";

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "4.5mb" } } };
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const PIECE = 3_000_000, PIECE_S = 600;
let pulled = null; // { etag, gz } — the store file, gzip'd + base64 once per version

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const q = req.query ?? {};
  if (req.method === "GET" && !q.file) return res.status(200).json(await boardStatus());
  const secret = process.env.CRON_SECRET ?? "", given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !given || !same(secret, given)) return res.status(401).json({ error: "unauthorized" });
  try {
    if (req.method === "GET") {
      const part = Number(q.part ?? 0), file = String(q.file);
      let etag, gz;
      if (file === "store") {
        const store = await loadStore(); if (!store) return res.status(404).json({ error: "no store yet" });
        etag = storeEtag() ?? store.at;
        if (pulled?.etag !== etag) pulled = { etag, gz: gzipSync(Buffer.from(JSON.stringify(store))).toString("base64") };
        gz = pulled.gz;
      } else if (file === "prior") {
        const r = await getGz(PATHS.prior); if (!r) return res.status(404).json({ error: "no totals yet" });
        etag = r.etag; gz = gzipSync(Buffer.from(JSON.stringify(r.value))).toString("base64");
      } else return res.status(400).json({ error: "file=store|prior" });
      const parts = Math.ceil(gz.length / PIECE);
      if (!Number.isInteger(part) || part < 0 || part >= parts) return res.status(400).json({ error: `part 0..${parts - 1}` });
      return res.status(200).json({ ok: true, file, etag, part, parts, gz: gz.slice(part * PIECE, (part + 1) * PIECE) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    let body;
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}; } catch { return res.status(400).json({ error: "not JSON" }); }
    const { stamp, part, parts, gz } = body, kind = body.kind ?? "board";
    if (!["board", "prior"].includes(kind) || !/^[a-z0-9]{4,32}$/.test(String(stamp)) || !Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts || parts > 40 || typeof gz !== "string" || !gz) return res.status(400).json({ error: "expected { kind?, stamp, part, parts, gz }" });
    await rcMark(`boardin:${stamp}:${part}`, { gz }, PIECE_S);
    const have = []; // which pieces are in: the last request to find them all assembles the payload
    for (let i = 0; i < parts; i++) have.push(i === part ? { gz } : await rcRead(`boardin:${stamp}:${i}`));
    if (have.some((p) => !p?.gz)) return res.status(202).json({ ok: true, waiting: have.filter((p) => !p?.gz).length });
    const value = JSON.parse(gunzipSync(Buffer.from(have.map((p) => p.gz).join(""), "base64")).toString());
    for (let i = 0; i < parts; i++) await rcDrop(`boardin:${stamp}:${i}`);
    if (kind === "prior") {
      if (!Number.isInteger(value?.want) || !Array.isArray(value?.rows)) return res.status(400).json({ error: "that is not a totals file" });
      await putGz(PATHS.prior, value); await rcPut("prior-v1", value, 24 * 3600);
      return res.status(200).json({ ok: true, kind, want: value.want, rows: value.rows.length });
    }
    if (!value?.live || !Array.isArray(value.teams) || !Array.isArray(value.players)) return res.status(400).json({ error: "that is not a board" });
    const adopted = await adoptBoard(value);
    res.status(200).json({ ok: true, kind, teams: adopted.teams.length, at: value.at, playing: !!value.playing });
  } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
