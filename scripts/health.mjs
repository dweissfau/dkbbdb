// The weekly look at dkbbdb, in one screen, from the LOCAL file store (run scripts/backup.mjs first and drop the
// newest backup into .blob/, or scripts/migrate-local.mjs):   node scripts/health.mjs
//   • accounts, teams, leagues, the store file's size and age
//   • rostered players with no match in the public stats feed (they score 0 until aliased in db/sleeper-aliases.json)
//   • syncs that had drafts rejected, and the busiest accounts
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db.mjs";
import { mapSleeper } from "../lib/sleeper.js";
import { allUploads } from "../lib/guard.js";
import { loadStore, rosteredPlayers, PATHS } from "../lib/store.js";
import { getGz, listFiles } from "../lib/files.js";

const store = await loadStore();
if (!store) { console.error("no local store"); process.exit(1); }
const files = await listFiles("data/"), bytes = files.reduce((s, f) => s + f.size, 0);
const week = Date.now() - 7 * 86400e3;
console.log(`${store.accounts.length} accounts (${store.accounts.filter((a) => a.createdAt && Date.parse(a.createdAt) > week).length} new this week) · ${Object.keys(store.entries).length} teams · ${Object.keys(store.pods).length} leagues · ${files.length} data files, ${(bytes / 1e6).toFixed(1)} MB · store built ${store.at}`);
const board = (await getGz(PATHS.board))?.value;
if (board) console.log(`board: last scored ${board.body.at} · ${board.body.teams.length} teams · week ${board.body.week}`);
const prior = (await getGz(PATHS.prior))?.value;
if (prior) console.log(`finished-week totals: ${prior.rows.length} leagues through week ${prior.want}`);

// try to match anyone new first, then report who is still unmatched
const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "sleeper-aliases.json"), "utf8"));
const { mapped, unmatched } = await mapSleeper(store, { aliases }).catch((e) => ({ mapped: 0, unmatched: [], error: e }));
if (mapped) console.log(`matched ${mapped} new player(s) to the stats feed just now (local file only — the site does this itself on sync)`);
if (unmatched.length) {
  const counts = new Map();
  for (const pod of Object.values(store.pods)) for (const r of Object.values(pod.rosters)) for (const did of r.d ?? []) { const p = store.draftables[pod.dgid]?.[did]; if (p) counts.set(p[0], (counts.get(p[0]) ?? 0) + 1); }
  console.log(`\n!! ${unmatched.length} rostered player(s) score 0 because the stats feed has no match — add "DK name": "sleeper player_id" to db/sleeper-aliases.json, then run this again:`);
  for (const u of unmatched.sort((a, b) => (counts.get(b.pid) ?? 0) - (counts.get(a.pid) ?? 0))) console.log(`   ${u.name} (${u.pos} ${u.team}) on ${counts.get(u.pid) ?? 0} rosters`);
} else console.log(`every rostered player (${rosteredPlayers(store).length}) is matched to the stats feed`);

const uploads = await allUploads(2000, { store });
const rejected = uploads.filter((u) => u.rejected > 0);
if (rejected.length) { console.log(`\n${rejected.length} upload(s) had drafts rejected:`); for (const u of rejected.slice(0, 10)) console.log(`   ${u.at} ${u.usernames.join(",") || "?"} rejected ${u.rejected}: ${u.note ?? ""}`); }
const byUser = new Map(); for (const u of uploads) byUser.set(u.usernames?.[0] ?? "?", (byUser.get(u.usernames?.[0] ?? "?") ?? 0) + 1);
console.log(`\n${uploads.length} syncs from ${byUser.size} accounts; busiest: ${[...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s} ×${n}`).join(", ")}`);
