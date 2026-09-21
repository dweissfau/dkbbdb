// The upload log, newest first: who synced what, and what was turned away.
//   node scripts/uploads.mjs [how many = 30] [--rejected]
import { connect } from "./db.mjs";

const n = Number(process.argv.find((a) => /^[0-9]+$/.test(a))) || 30;
const db = await connect();
const { rows } = await db.query(
  `select at, left(sender, 8) sender, ext_version ext, usernames, drafts, refreshed, skipped, rejected, note from upload_log
    ${process.argv.includes("--rejected") ? "where rejected > 0" : ""} order by at desc limit $1`, [n]);
console.table(rows.map((r) => ({ at: new Date(r.at).toISOString().replace("T", " ").slice(0, 19), sender: r.sender, ext: r.ext, accounts: r.usernames.join(", "),
  drafts: r.drafts, refreshed: r.refreshed, skipped: r.skipped, rejected: r.rejected, note: (r.note ?? "").slice(0, 70) })));
const busy = (await db.query(
  `select left(sender, 8) sender, count(*)::int uploads, sum(rejected)::int rejected, count(distinct k)::int accounts
     from upload_log l left join lateral unnest(l.user_keys) k on true where at > now() - interval '24 hours' group by 1 order by 2 desc limit 5`)).rows;
console.log("busiest senders, last 24 h:"); console.table(busy);
await db.end();
