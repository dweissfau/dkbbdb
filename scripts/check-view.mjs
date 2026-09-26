// Score one DK account's teams from the local file store and (optionally) compare with the single-user site.
//   node scripts/check-view.mjs <dk username> [prod live url] [cookie]
// e.g. node scripts/check-view.mjs ZBbih  → prints a summary of the computed view
import { userView } from "../lib/view.js";
import { loadStore, accountByName, baseOf } from "../lib/store.js";

const [username, prodUrl, cookie] = process.argv.slice(2);
const store = await loadStore();
const u = store ? accountByName(store, username) : null;
if (!u) { console.error("no such DK account:", username); process.exit(1); }

const t0 = Date.now();
const { body } = await userView([u.user_key], { base: baseOf(store, [u.user_key]) });
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
