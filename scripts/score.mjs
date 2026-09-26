// Score the board OFF the site and hand it over: reads the store and the finished-week totals from Blob, pulls the
// public stats feeds, scores every league (lib/leaderboard.js computeBoard) and POSTs the result to /api/board in
// pieces. Run by GitHub Actions on a schedule (.github/workflows/score.yml) — every 5 minutes while games are on —
// so the site itself spends no function time scoring and no visitor ever waits for a refresh.
//   BLOB_READ_WRITE_TOKEN=…  CRON_SECRET=…  [DKBBDB_SITE=https://dkbbdb.com]  node scripts/score.mjs
// Locally (no token) it scores the local file store (dkbbdb/.blob/) and only prints.
import { gzipSync } from "node:zlib";
import { computeBoard } from "../lib/leaderboard.js";
import { backend } from "../lib/files.js";

const site = (process.env.DKBBDB_SITE ?? "https://dkbbdb.com").replace(/\/$/, ""), secret = process.env.CRON_SECRET ?? "";
const PIECE = 3_000_000; // base64 characters per request (under the 4.5 MB body cap)
const t0 = Date.now();
console.log(`store: ${backend()} · site: ${site}`);
const board = await computeBoard(Date.now());
if (!board.live) { console.log("feeds unavailable:", board.reason); process.exit(0); }
const scored = Date.now() - t0;
console.log(`scored ${board.teams.length} teams (${board.accounts} accounts) · week ${board.week} · ${board.playing ? "games on" : "no game on"} · ${scored} ms`);
if (backend() === "local" || !secret) { console.log("no site credentials — not posting"); process.exit(0); }

const gz = gzipSync(Buffer.from(JSON.stringify(board))).toString("base64");
const parts = Math.ceil(gz.length / PIECE), stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let last = null;
for (let part = 0; part < parts; part++) {
  const r = await fetch(`${site}/api/board`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ stamp, part, parts, gz: gz.slice(part * PIECE, (part + 1) * PIECE) }) });
  last = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) { console.error(`piece ${part + 1}/${parts} failed:`, JSON.stringify(last)); process.exit(1); }
}
console.log(`posted ${(gz.length / 1e6).toFixed(2)} MB in ${parts} piece(s) → ${JSON.stringify(last)} · total ${Date.now() - t0} ms`);
