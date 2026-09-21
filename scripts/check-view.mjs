// Score one user's teams from the new database and (optionally) compare with the single-user site.
//   node scripts/check-view.mjs <dk username> [prod live url] [cookie]
// e.g. node scripts/check-view.mjs ZBbih  → prints a summary of the computed view
import { connect, loadEnv } from "./db.mjs";
import { userView } from "../lib/view.js";

const [username, prodUrl, cookie] = process.argv.slice(2);
process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const db = await connect();
const u = (await db.query(`select user_id from dk_accounts where lower(username) = lower($1)`, [username])).rows[0];
if (!u) { console.error("no such DK account:", username); process.exit(1); }

const t0 = Date.now();
const { body } = await userView(db, u.user_id);
console.log(`view in ${Date.now() - t0} ms · live ${body.live} · week ${body.week} · teams ${Object.keys(body.status ?? {}).length} · pods ${Object.keys(body.pods ?? {}).length}`);
console.log("source", JSON.stringify(body.source));
const ranked = Object.entries(body.status ?? {}).filter(([, s]) => s.rank != null);
console.log(`ranked ${ranked.length} · weekly weeks ${JSON.stringify(body.weekly?.weeks)} · bytes ${JSON.stringify(body).length}`);

if (prodUrl) {
  const prod = await (await fetch(prodUrl, { headers: { cookie } })).json();
  let same = 0, diff = 0, missing = 0;
  for (const [id, s] of Object.entries(body.status)) {
    const p = prod.status?.[id];
    if (!p) { missing++; continue; }
    if (p.rank === s.rank && Math.abs((p.points ?? 0) - (s.points ?? 0)) < 0.005) same++;
    else { diff++; if (diff <= 5) console.log("  differs", id, "new", s.rank, s.points, "prod", p.rank, p.points); }
  }
  console.log(`vs single-user site: ${same} identical rank+points, ${diff} differ, ${missing} not on that page`);
}
await db.end();
