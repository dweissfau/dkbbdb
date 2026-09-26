// Copy every data file of the live site (Vercel Blob, via /api/admin) to dkbbdb/backups/<UTC date-time>/ — the
// same layout as the store (lib/files.js), so a backup can be dropped into dkbbdb/.blob/ and run locally, or pushed
// back to the site with scripts/restore.mjs. Run it weekly. `--keep` prunes older backup folders (default 8).
//   node scripts/backup.mjs [site = https://dkbbdb.com] [--keep 8]
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT, loadEnv } from "./db.mjs";

const args = process.argv.slice(2), site = args.find((a) => a.startsWith("http")) ?? "https://dkbbdb.com";
const keep = Number(args[args.indexOf("--keep") + 1]) || 8;
const key = process.env.ADMIN_KEY ?? loadEnv().ADMIN_KEY;
if (!key) { console.error("ADMIN_KEY missing (dkbbdb/.env.local)"); process.exit(1); }
const hdr = { "x-admin-key": key };
const dir = path.join(ROOT, "backups"), stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19), out = path.join(dir, stamp);

const list = await (await fetch(`${site}/api/admin?files=1`, { headers: hdr })).json();
if (!list.ok) { console.error(list); process.exit(1); }
let total = 0;
for (const f of list.files) {
  const r = await (await fetch(`${site}/api/admin?file=${encodeURIComponent(f.pathname)}`, { headers: hdr })).json();
  if (!r.ok) { console.log(`  !! ${f.pathname}: ${r.error}`); continue; }
  const full = path.join(out, f.pathname); fs.mkdirSync(path.dirname(full), { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(r.value))); fs.writeFileSync(full, gz); total += gz.length;
  console.log(`  ${f.pathname.padEnd(48)} ${(gz.length / 1024).toFixed(0).padStart(6)} KB`);
}
console.log(`backup ${stamp}: ${list.files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${out}`);
const olds = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort().slice(0, -keep) : [];
for (const d of olds) { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); console.log(`  pruned ${d}`); }
