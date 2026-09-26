// POST /api/board — the scoring job (scripts/score.mjs, run by GitHub Actions on a schedule) hands the site a freshly
// scored board. Authorization: Bearer <CRON_SECRET>. The board is gzip'd + base64 and may arrive in PIECES (a request
// body is capped at 4.5 MB): { stamp, part, parts, gz }. Pieces wait in the runtime cache; the last one assembles the
// board and the site adopts it (lib/leaderboard.js adoptBoard: runtime cache, rank history, the daily Blob backup) —
// no Blob write per run, no function time spent scoring, nobody waiting on a page.
//   GET /api/board — what the site is serving: { at, teams, storedAt, playing }
import { timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { adoptBoard, boardStatus } from "../lib/leaderboard.js";
import { rcMark, rcRead, rcDrop } from "../lib/rcache.js";

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "4.5mb" } } };
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const PIECE_S = 600;

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") return res.status(200).json(await boardStatus());
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const secret = process.env.CRON_SECRET ?? "", given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !given || !same(secret, given)) return res.status(401).json({ error: "unauthorized" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}; } catch { return res.status(400).json({ error: "not JSON" }); }
  const { stamp, part, parts, gz } = body;
  if (!/^[a-z0-9]{4,32}$/.test(String(stamp)) || !Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts || parts > 40 || typeof gz !== "string" || !gz) return res.status(400).json({ error: "expected { stamp, part, parts, gz }" });
  try {
    await rcMark(`boardin:${stamp}:${part}`, { gz }, PIECE_S);
    const have = []; // which pieces are in: the last request to find them all assembles the board
    for (let i = 0; i < parts; i++) have.push(i === part ? { gz } : await rcRead(`boardin:${stamp}:${i}`));
    if (have.some((p) => !p?.gz)) return res.status(202).json({ ok: true, waiting: have.filter((p) => !p?.gz).length });
    const board = JSON.parse(gunzipSync(Buffer.from(have.map((p) => p.gz).join(""), "base64")).toString());
    if (!board?.live || !Array.isArray(board.teams) || !Array.isArray(board.players)) return res.status(400).json({ error: "that is not a board" });
    const adopted = await adoptBoard(board);
    for (let i = 0; i < parts; i++) await rcDrop(`boardin:${stamp}:${i}`);
    res.status(200).json({ ok: true, teams: adopted.teams.length, at: board.at, playing: !!board.playing });
  } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
