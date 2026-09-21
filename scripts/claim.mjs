// Put DraftKings accounts that are already in the database under one person's email, so their first
// sign-in with that (verified) address shows those teams (lib/auth.js adopts the row).
//   node scripts/claim.mjs <email> <dk username> [<dk username> …]
import { connect } from "./db.mjs";

const [email, ...names] = process.argv.slice(2);
if (!email || !names.length) { console.error("usage: node scripts/claim.mjs <email> <dk username> …"); process.exit(1); }
const db = await connect();
await db.query("begin");
const target = (await db.query("select id from users where lower(email) = lower($1)", [email])).rows[0]?.id
  ?? (await db.query("insert into users (email) values ($1) returning id", [email])).rows[0].id;
for (const name of names) {
  const acc = (await db.query("select user_key, user_id from dk_accounts where lower(username) = lower($1)", [name])).rows[0];
  if (!acc) { console.log(`${name}: no such DraftKings account`); continue; }
  const from = acc.user_id;
  await db.query("update dk_accounts set user_id = $1 where user_key = $2", [target, acc.user_key]);
  const moved = await db.query("update entries set user_id = $1 where user_key = $2", [target, acc.user_key]);
  // drop the placeholder user once nothing is left under it
  if (String(from) !== String(target)) await db.query(
    "delete from users u where u.id = $1 and u.clerk_id is null and not exists (select 1 from dk_accounts a where a.user_id = u.id)", [from]);
  console.log(`${name}: ${moved.rowCount} teams → ${email} (user ${target})`);
}
await db.query("commit");
await db.end();
