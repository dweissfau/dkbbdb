// The public league view names only synced teams and sends no other player's roster (lib/view.js scrubView), scored
// from the local file store for one entry the way /api/live does.   node scripts/check-scrub.mjs [entry id]
import { userView } from "../lib/view.js";
import { loadStore, entryOwner, baseOf } from "../lib/store.js";
const store = await loadStore();
const entry = process.argv[2] ?? Object.keys(store.entries)[0];
const one = entryOwner(store, entry); if (!one) { console.error("no such entry"); process.exit(1); }
const keys = [one.account.user_key], reveal = new Set(Object.keys(store.entries));
const seatOf = (cid, key) => store.pods?.[cid]?.rosters?.[key]?.s ?? null;
const opts = { only: [one.entryId], base: baseOf(store, keys, [one.entryId]) };
const [{ body: pub }, { body: full }] = await Promise.all([userView(keys, { ...opts, reveal, seatOf }), userView(keys, opts)]);
if (!pub.live) { console.error("not live:", pub.reason); process.exit(1); }
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) fail++; };
const names = new Set(store.accounts.map((a) => a.u));
for (const [cid, rows] of Object.entries(pub.pods)) {
  const others = rows.filter((r) => !reveal.has(String(r[0])));
  ok(others.every((r) => /^Seat \d+$/.test(r[1]) || r[1] === "Another player"), `pod ${cid}: ${others.length} other players shown by seat (${others.map((r) => r[1]).join(", ")})`);
  ok(rows.filter((r) => reveal.has(String(r[0]))).every((r) => names.has(r[1])), `pod ${cid}: synced teams keep their username`);
  const sent = Object.keys(pub.opp.rosters[cid] ?? {}), had = Object.keys(full.opp.rosters[cid] ?? {});
  ok(sent.every((k) => reveal.has(k)) && sent.includes(String(one.entryId)), `pod ${cid}: rosters sent for ${sent.length} of ${had.length} teams, own team included, all synced`);
  ok(JSON.stringify(rows.map((r) => [r[0], r[2], r[3]])) === JSON.stringify(full.pods[cid].map((r) => [r[0], r[2], r[3]])), `pod ${cid}: places and points unchanged`);
}
ok(!JSON.stringify(pub).includes("Sync opponent"), "no leftover wording");
console.log(fail ? `${fail} FAILED` : "scrub ok"); process.exit(fail ? 1 : 0);
