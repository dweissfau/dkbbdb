// The weekly look at dkbbdb: what needs attention, in one screen.   node scripts/health.mjs
//   • rostered players with no match in the public stats feed (they score 0 until aliased in db/sleeper-aliases.json)
//   • uploads that had drafts rejected, and the busiest senders
//   • how full the free database is (Neon free tier: 0.5 GB)
import fs from "node:fs";
import path from "node:path";
import { connect, ROOT } from "./db.mjs";
import { mapSleeper } from "../lib/sleeper.js";

const db = await connect();
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

const c = await one(`select (select count(*) from dk_accounts)::int accounts, (select count(*) from entries)::int teams, (select count(*) from contests)::int pods,
  (select count(*) from dk_accounts where created_at > now() - interval '7 days')::int new_accounts, pg_database_size(current_database()) bytes`);
console.log(`${c.accounts} accounts (${c.new_accounts} new this week) · ${c.teams} teams · ${c.pods} leagues · database ${(c.bytes / 1e6).toFixed(0)} MB of 500 MB (${(100 * c.bytes / 5e8).toFixed(0)} %)`);

// the leaderboard run (lib/leaderboard.js): how long the last one took. Seconds, not tenths, would be the sign to look at it
const b = await one(`select at, ms, pg_column_size(body) bytes, (select count(*) from pod_prior)::int stored from board_cache where id = 1`);
if (b) console.log(`leaderboard: last scored ${new Date(b.at).toISOString().slice(0, 16).replace("T", " ")} UTC in ${b.ms} ms · stored board ${(b.bytes / 1024).toFixed(0)} KB · finished-week totals stored for ${b.stored} of ${c.pods} leagues`);

// try to match anyone new first, then report who is still unmatched
const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "sleeper-aliases.json"), "utf8"));
const { mapped, unmatched } = await mapSleeper(db, { aliases }).catch((e) => ({ mapped: 0, unmatched: [], error: e }));
if (mapped) console.log(`matched ${mapped} new player(s) to the stats feed just now`);
if (unmatched.length) {
  const counts = new Map((await db.query(
    `select d.player_id pid, count(*)::int n from pod_teams t join contests c on c.contest_id = t.contest_id
       join draftables d on d.draft_group_id = c.draft_group_id and d.draftable_id = any(t.draftable_ids)
      where d.player_id = any($1::int[]) group by 1`, [unmatched.map((u) => u.pid)])).rows.map((r) => [r.pid, r.n]));
  console.log(`\n!! ${unmatched.length} rostered player(s) score 0 because the stats feed has no match — add "DK name": "sleeper player_id" to db/sleeper-aliases.json, then run this again:`);
  for (const u of unmatched.sort((a, b) => (counts.get(b.pid) ?? 0) - (counts.get(a.pid) ?? 0))) console.log(`   ${u.name} (${u.pos} ${u.team}) — on ${counts.get(u.pid) ?? 0} rosters`);
} else console.log("every rostered player is matched to the stats feed");

const rej = (await db.query(`select at, left(sender, 8) sender, usernames, rejected, note from upload_log where rejected > 0 and at > now() - interval '7 days' order by at desc limit 10`)).rows;
console.log(rej.length ? `\nuploads with rejected drafts, last 7 days:` : "\nno rejected uploads in the last 7 days");
for (const r of rej) console.log(`   ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} · sender ${r.sender} · ${r.usernames.join(", ") || "—"} · ${r.rejected} rejected · ${(r.note ?? "").slice(0, 90)}`);
const busy = (await db.query(`select left(sender, 8) sender, count(*)::int uploads, count(distinct k)::int accounts from upload_log l left join lateral unnest(l.user_keys) k on true
  where at > now() - interval '7 days' group by 1 having count(*) > 60 or count(distinct k) > 3 order by 2 desc limit 5`)).rows;
if (busy.length) { console.log("\nunusually busy senders, last 7 days:"); for (const b of busy) console.log(`   sender ${b.sender}: ${b.uploads} uploads, ${b.accounts} accounts`); }
await db.end();
