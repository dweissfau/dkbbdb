// Score the board OFF the site and hand it over. Run by GitHub Actions (.github/workflows/score.yml): one job per
// game window that scores every 5 minutes until the window closes, so the site spends no function time scoring and
// no visitor waits. (A cron tick per refresh was the first design; GitHub's schedule is best effort and delivered
// 3 of Sunday's ~140 ticks on 2026-09-27, so the site sat for hours between updates.)
//   1. pull the store file from the site (GET /api/board?file=store, in pieces — served from the site's memory)
//   2. the finished-week totals come from the Actions cache (.blob/store/prior.json.gz), or from the site once
//   3. score every league (lib/leaderboard.js computeBoard) on the local file store
//   4. POST the board to /api/board in pieces; if the week rolled and the totals were recomputed, POST those too
//   CRON_SECRET=…  [DKBBDB_SITE=https://dkbbdb.com]  [DKBBDB_UNTIL=HH:MM]  [DKBBDB_EVERY=300]  node scripts/score.mjs
// Without CRON_SECRET it scores whatever is in the local file store and only prints. With DKBBDB_UNTIL (a UTC clock
// time) it repeats every DKBBDB_EVERY seconds until that time — the next such time, at most 5 h 50 min away (a job
// may run 6 h); a start after the window has closed does a single pass. A failed pass is logged and the next one
// still runs; the job ends red only if its last pass failed.
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { computeBoard } from "../lib/leaderboard.js";
import { filesDir, getGz, putGz } from "../lib/files.js";
import { PATHS, _forgetStore } from "../lib/store.js";

const site = (process.env.DKBBDB_SITE ?? "https://dkbbdb.com").replace(/\/$/, ""), secret = process.env.CRON_SECRET ?? "";
// a POSTed piece is parked in the site's runtime cache until its siblings arrive, and an item there holds ~2 MB —
// 3 MB pieces were dropped silently once the totals file outgrew one piece (2026-09-27)
const PIECE = 1_400_000, t0 = Date.now();
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

const EVERY = Math.max(60, Number(process.env.DKBBDB_EVERY) || 300) * 1000, MAX_MS = 350 * 60e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function windowEnd() { // → epoch ms of the DKBBDB_UNTIL clock time, or null for a single pass
  const m = /^(\d\d):(\d\d)$/.exec(process.env.DKBBDB_UNTIL ?? "");
  if (!m) return null;
  const end = new Date(); end.setUTCHours(+m[1], +m[2], 0, 0);
  if (end.getTime() <= Date.now()) end.setUTCDate(end.getUTCDate() + 1);
  if (end.getTime() - Date.now() > MAX_MS) { log(`the window to ${m[0]} UTC has closed — one pass`); return null; }
  return end.getTime();
}

let storeEtag = null, priorSaid = false;
async function pass() { // → true when the pass ran (posted, or nothing to do); throws on a failure
  if (secret) {
    const store = await pull("store");
    if (!store) { log("the site has no store yet — nothing to score"); return true; }
    if (store.etag !== storeEtag) {
      await putGz(PATHS.base, store.value); _forgetStore(); storeEtag = store.etag;
      log(`pulled the store: ${store.value.accounts.length} accounts, ${Object.keys(store.value.entries).length} teams (${store.pieces} piece(s))`);
    } else log("the store has not changed");
    if (!(await getGz(PATHS.prior))) { const prior = await pull("prior"); if (prior) { await putGz(PATHS.prior, prior.value); log(`pulled the finished-week totals: ${prior.value.rows.length} leagues through week ${prior.value.want}`); } else log("no finished-week totals on the site yet — they will be computed"); }
    else if (!priorSaid) log("finished-week totals: from the cache");
    priorSaid = true;
  }
  const priorBefore = (await getGz(PATHS.prior))?.etag ?? null;
  const board = await computeBoard(Date.now());
  if (!board.live) { log(`feeds unavailable: ${board.reason}`); return true; }
  log(`scored ${board.teams.length} teams (${board.accounts} accounts) · week ${board.week} · ${board.playing ? "games on" : "no game on"} · totals reused ${board.priorStats?.reused ?? "?"}, computed ${board.priorStats?.computed ?? "?"}`);
  if (!secret) { log("no CRON_SECRET — not posting"); return true; }
  await push("board", board);
  const priorAfter = await getGz(PATHS.prior);
  if (priorAfter && priorAfter.etag !== priorBefore) await push("prior", priorAfter.value);
  return true;
}
const attempt = () => pass().catch((e) => { log(`pass failed: ${e.message}`); return false; });

const end = windowEnd();
if (end) log(`scoring every ${EVERY / 60e3} min until ${new Date(end).toISOString().slice(11, 16)} UTC`);
let started = Date.now(), ok = await attempt(), passes = 1;
while (end && started + EVERY < end) {
  await sleep(Math.max(0, started + EVERY - Date.now()));
  started = Date.now(); ok = await attempt(); passes++;
}
fs.mkdirSync(path.join(filesDir(), "store"), { recursive: true });
log(`done${passes > 1 ? ` (${passes} passes)` : ""}${ok ? "" : " — the last pass failed"}`);
process.exit(ok ? 0 : 1);
