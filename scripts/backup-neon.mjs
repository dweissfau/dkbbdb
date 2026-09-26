// (The old Postgres database — kept until it is deleted.) Copy every table to gzip'd JSON files: dkbbdb/backups/<UTC date-time>/<table>.json.gz
//   node scripts/backup.mjs [--keep 8]
// Run it weekly (and before anything risky). It reads the whole database once (~the database's size in transfer),
// so it is NOT something to run in a loop. `--keep` prunes older backup folders (default 8). backups/ is git-ignored.
// Restore = insert the rows back with db/schema.sql applied first (scripts/restore.mjs when it is needed).
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { loadEnv, ROOT } from "./db.mjs";
const pg = createRequire(import.meta.url)("pg");
const connect = async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; };

process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const keep = Number(process.argv[process.argv.indexOf("--keep") + 1]) || 8;
const dir = path.join(ROOT, "backups"), stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(dir, stamp);
fs.mkdirSync(out, { recursive: true });

const db = await connect();
const tables = (await db.query("select tablename from pg_tables where schemaname = 'public' order by tablename")).rows.map((r) => r.tablename);
let total = 0;
for (const t of tables) {
  const rows = [];
  // pages of 2,000 rows so a big table never sits in memory twice
  const key = (await db.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = $1::regclass and i.indisprimary order by a.attnum limit 1`, [t])).rows[0]?.attname;
  for (let off = 0; ; off += 2000) {
    const page = (await db.query(`select * from ${t}${key ? ` order by ${key}` : ""} limit 2000 offset ${off}`)).rows;
    rows.push(...page);
    if (page.length < 2000) break;
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(rows)));
  fs.writeFileSync(path.join(out, `${t}.json.gz`), gz);
  total += gz.length;
  console.log(`  ${t.padEnd(22)} ${String(rows.length).padStart(7)} rows  ${(gz.length / 1024).toFixed(0).padStart(6)} KB`);
}
await db.end();
console.log(`backup ${stamp}: ${tables.length} tables, ${(total / 1024 / 1024).toFixed(1)} MB → ${out}`);

// prune
const olds = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort().slice(0, -keep);
for (const d of olds) { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); console.log(`  pruned ${d}`); }
