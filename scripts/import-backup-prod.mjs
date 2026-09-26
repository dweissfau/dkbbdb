// One-off for leaving the database (2026-09-26): push a scripts/backup-neon.mjs dump (the old tables) to the live
// site through /api/admin?import=<table>, then ask it to turn them into the site's files and publish the store.
//   node scripts/import-backup-prod.mjs [backup dir = the newest] [site = https://dkbbdb.com]
// Uploads are base64 text under 4 MB each; big tables go in parts.
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { ROOT, loadEnv } from "./db.mjs";

const args = process.argv.slice(2), site = args.find((a) => a.startsWith("http")) ?? "https://dkbbdb.com";
const dir = args.find((a) => !a.startsWith("http")) ?? path.join(ROOT, "backups", fs.readdirSync(path.join(ROOT, "backups")).filter((d) => /^\d{4}-/.test(d) && fs.existsSync(path.join(ROOT, "backups", d, "entries.json.gz"))).sort().at(-1));
const key = process.env.ADMIN_KEY ?? loadEnv().ADMIN_KEY;
const MAX = 3_000_000; // bytes of base64 per request
console.log(`from ${dir} → ${site}`);
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz"))) {
  const table = f.replace(/\.json\.gz$/, ""), rows = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
  if (table === "board_cache") continue; // recomputed
  // split into parts that fit
  const parts = []; let cur = [];
  for (const r of rows) { cur.push(r); if (gzipSync(Buffer.from(JSON.stringify(cur))).length * 1.37 > MAX && cur.length > 1) { parts.push(cur.slice(0, -1)); cur = [r]; } }
  if (cur.length || !parts.length) parts.push(cur);
  for (let i = 0; i < parts.length; i++) {
    const body = gzipSync(Buffer.from(JSON.stringify(parts[i]))).toString("base64");
    const r = await (await fetch(`${site}/api/admin?import=${table}${parts.length > 1 ? `&part=${i + 1}` : ""}`, { method: "POST", headers: { "x-admin-key": key, "content-type": "text/plain" }, body })).json();
    console.log(`  ${table}${parts.length > 1 ? ` part ${i + 1}/${parts.length}` : ""}: ${r.ok ? `${r.rows} rows` : "FAILED " + JSON.stringify(r)}`);
    if (!r.ok) process.exit(1);
  }
}
const m = await (await fetch(`${site}/api/admin?migrate=1`, { headers: { "x-admin-key": key } })).json();
console.log("migrate:", JSON.stringify(m));
process.exit(m.ok ? 0 : 1);
