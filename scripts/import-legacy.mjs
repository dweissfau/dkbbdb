// One-off: load the single-user SQLite portfolio (../data/portfolio.sqlite) into the multi-user database
// THROUGH THE SAME CODE PATH AS AN EXTENSION UPLOAD (lib/ingest.js), one upload per DraftKings account.
// Every DK username becomes a searchable account (dkbbdb.com/u/<username>). Rosters are cross-checked against
// the old leaderboard + roster sync.
//   node scripts/import-legacy.mjs [--reset]     --reset: empty every table first
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { connect, ROOT } from "./db.mjs";
import { compactStatus, ingestDrafts } from "../lib/ingest.js";

const require = createRequire(path.join(ROOT, "..", "package.json"));
const Database = require("better-sqlite3");
const lite = new Database(path.join(ROOT, "..", "data", "portfolio.sqlite"), { readonly: true });
const db = await connect();

if (process.argv.includes("--reset")) {
  await db.query("drop table if exists rank_history, entries, pod_teams, contests, dk_accounts, sync_tokens, users, draftables cascade");
  await db.query(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8"));
  console.log("tables recreated from db/schema.sql (sleeper_map kept)");
}

const draftables = {}, adp = {};
for (const r of lite.prepare("select * from draftables").all()) (draftables[r.draft_group_id] ??= []).push([r.draftable_id, r.player_id, r.name, r.position, r.team]);
for (const r of lite.prepare("select draft_group_id g, player_id p, adp from pool where adp is not null").all()) (adp[r.g] ??= {})[r.p] = r.adp;

const byUser = new Map();
for (const d of lite.prepare("select my_username, raw_contest, raw_draft_status from drafts").all()) {
  if (!byUser.has(d.my_username)) byUser.set(d.my_username, []);
  byUser.get(d.my_username).push({ contest: JSON.parse(d.raw_contest), ...compactStatus(JSON.parse(d.raw_draft_status)) });
}

let first = true;
for (const [username, drafts] of byUser) {
  // chunked like the extension will (keeps every request small)
  const total = { drafts: 0, pods: 0, teams: 0, errors: [] };
  for (let i = 0; i < drafts.length; i += 25) {
    const r = await ingestDrafts(db, { drafts: drafts.slice(i, i + 25), ...(first ? { draftables, adp } : {}) });
    first = false;
    total.drafts += r.drafts; total.pods += r.pods; total.teams += r.teams; total.errors.push(...r.errors);
  }
  console.log(`${username}: ${total.drafts} teams, ${total.pods} pods, ${total.teams} pod teams${total.errors.length ? `, errors: ${total.errors.join(" | ")}` : ""}`);
}

// cross-check: does the draft board give the same 20 players the old opponent sync found?
const old = lite.prepare(
  `select p.contest_id cid, p.user_name u, group_concat(o.draftable_id) dids from pod_standings p
     join opponent_rosters o on o.contest_id = p.contest_id and o.entry_key = p.entry_key
    where o.week = (select max(week) from opponent_rosters x where x.contest_id = p.contest_id)
    group by p.contest_id, p.entry_key`).all();
const now = new Map((await db.query("select contest_id, username, draftable_ids from pod_teams")).rows
  .map((r) => [`${r.contest_id}|${r.username}`, [...r.draftable_ids].sort((a, b) => a - b).join()]));
let same = 0, differ = 0, absent = 0;
for (const r of old) {
  const have = now.get(`${r.cid}|${r.u}`);
  if (have == null) absent++;
  else if (have === r.dids.split(",").map(Number).sort((a, b) => a - b).join()) same++;
  else differ++;
}
console.log(`cross-check vs old opponent sync: ${same} identical rosters, ${differ} differ, ${absent} not found`);
await db.end();
