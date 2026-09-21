// Take a DraftKings account off dkbbdb: its teams, rank history, and every pod nobody else on the site is in.
// Frees the username too (the username lock is "first account to sync it").
//   node scripts/remove-account.mjs <dk username>            shows what would go
//   node scripts/remove-account.mjs <dk username> --yes      deletes it
import { connect } from "./db.mjs";

const [name, flag] = process.argv.slice(2);
if (!name) { console.error("usage: node scripts/remove-account.mjs <dk username> [--yes]"); process.exit(1); }
const db = await connect();
const accounts = (await db.query("select user_key, username, created_at from dk_accounts where lower(username) = lower($1)", [name])).rows;
if (!accounts.length) { console.log(`no account named ${name}`); await db.end(); process.exit(0); }

for (const a of accounts) {
  const teams = (await db.query("select count(*)::int n from entries where user_key = $1", [a.user_key])).rows[0].n;
  const pods = (await db.query(
    `select count(*)::int n from contests c where exists (select 1 from entries e where e.contest_id = c.contest_id and e.user_key = $1)
       and not exists (select 1 from entries e where e.contest_id = c.contest_id and e.user_key <> $1)`, [a.user_key])).rows[0].n;
  const log = (await db.query("select count(*)::int n, min(at) first, max(at) last, count(distinct sender)::int senders from upload_log where $1 = any(user_keys)", [a.user_key])).rows[0];
  console.log(`${a.username} (first synced ${new Date(a.created_at).toISOString().slice(0, 10)}): ${teams} teams, ${pods} pods only this account is in · ${log.n} uploads from ${log.senders} sender(s)`);
  if (flag !== "--yes") continue;
  await db.query("begin");
  const cids = (await db.query(
    `select c.contest_id from contests c where exists (select 1 from entries e where e.contest_id = c.contest_id and e.user_key = $1)
       and not exists (select 1 from entries e where e.contest_id = c.contest_id and e.user_key <> $1)`, [a.user_key])).rows.map((r) => r.contest_id);
  await db.query("delete from entries where user_key = $1", [a.user_key]); // rank_history goes with it (cascade)
  await db.query("delete from contests where contest_id = any($1::bigint[])", [cids]); // pod_teams go with it (cascade)
  await db.query("delete from dk_accounts where user_key = $1", [a.user_key]);
  await db.query("commit");
  console.log(`  removed. (pages refresh within a minute)`);
}
if (flag !== "--yes") console.log("nothing deleted — add --yes to remove");
await db.end();
