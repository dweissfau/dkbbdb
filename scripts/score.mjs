// Score the board OFF the site and hand it over. Run by GitHub Actions on a schedule (.github/workflows/score.yml),
// every 5 minutes while games are on, so the site spends no function time scoring and no visitor waits.
//   1. pull the store file from the site (GET /api/board?file=store, in pieces — served from the site's memory)
//   2. the finished-week totals come from the Actions cache (.blob/store/prior.json.gz), or from the site once
//   3. score every league (lib/leaderboard.js computeBoard) on the local file store
//   4. POST the board to /api/board in pieces; if the week rolled and the totals were recomputed, POST those too
//   CRON_SECRET=…  [DKBBDB_SITE=https://dkbbdb.com]  node scripts/score.mjs
// Without CRON_SECRET it scores whatever is in the local file store and only prints.
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { computeBoard } from "../lib/leaderboard.js";
import { filesDir, getGz, putGz } from "../lib/files.js";
import { PATHS, _forgetStore } from "../lib/store.js";

const site = (process.env.DKBBDB_SITE ?? "https://dkbbdb.com").replace(/\/$/, ""), secret = process.env.CRON_SECRET ?? "";
const PIECE = 3_000_000, t0 = Date.now();
const auth = { authorization: `Bearer ${secret}` };
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function pull(file) { // → { etag, value } | null
  const first = await (await fetch(`${site}/api/board?file=${file}&part=0`, { headers: auth })).json();
  if (!first.ok) { if (/no /.test(first.error ?? "")) return null; throw new Error(`${file}: ${JSON.stringify(first)}`); }
  let gz = first.gz;
  for (let p = 1; p < first.parts; p++) { const r = await (await fetch(`${site}/api/board?file=${file}&part=${p}`, { headers: auth })).json(); if (!r.ok || r.etag !== first.etag) throw new Error(`${file}: piece ${p} ${JSON.stringify(r).slice(0, 100)}`); gz += r.gz; }
  return { etag: first.etag, value: JSON.parse(gunzipSync(Buffer.from(gz, "base64")).toString()), pieces: first.parts };
}
async function push(kind, value) {
  const gz = gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");
  const parts = Math.ceil(gz.length / PIECE), stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let last = null;
  for (let part = 0; part < parts; part++) {
    const r = await fetch(`${site}/api/board`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ kind, stamp, part, parts, gz: gz.slice(part * PIECE, (part + 1) * PIECE) }) });
    last = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(`${kind} piece ${part + 1}/${parts}: ${JSON.stringify(last)}`);
  }
  log(`posted ${kind}: ${(gz.length / 1e6).toFixed(2)} MB in ${parts} piece(s) → ${JSON.stringify(last)}`);
}

if (secret) {
  const store = await pull("store");
  if (!store) { log("the site has no store yet — nothing to score"); process.exit(0); }
  await putGz(PATHS.base, store.value); _forgetStore();
  log(`pulled the store: ${store.value.accounts.length} accounts, ${Object.keys(store.value.entries).length} teams (${store.pieces} piece(s))`);
  if (!(await getGz(PATHS.prior))) { const prior = await pull("prior"); if (prior) { await putGz(PATHS.prior, prior.value); log(`pulled the finished-week totals: ${prior.value.rows.length} leagues through week ${prior.value.want}`); } else log("no finished-week totals on the site yet — they will be computed"); }
  else log("finished-week totals: from the cache");
}
const priorBefore = (await getGz(PATHS.prior))?.etag ?? null;
const board = await computeBoard(Date.now());
if (!board.live) { log(`feeds unavailable: ${board.reason}`); process.exit(0); }
log(`scored ${board.teams.length} teams (${board.accounts} accounts) · week ${board.week} · ${board.playing ? "games on" : "no game on"} · totals reused ${board.priorStats?.reused ?? "?"}, computed ${board.priorStats?.computed ?? "?"}`);
if (!secret) { log("no CRON_SECRET — not posting"); process.exit(0); }
await push("board", board);
const priorAfter = await getGz(PATHS.prior);
if (priorAfter && priorAfter.etag !== priorBefore) await push("prior", priorAfter.value);
fs.mkdirSync(path.join(filesDir(), "store"), { recursive: true });
log("done");
