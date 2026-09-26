// Turn a backup of the old database (scripts/backup-neon.mjs → dkbbdb/backups/<stamp>/) into the site's files
// under dkbbdb/.blob/ (the local file store, lib/files.js) and publish the store from them — a full local copy of
// the site to run every check against.
//   node scripts/migrate-local.mjs [backup dir = the newest]
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db.mjs";
import { tablesFromBackup, filesFromTables } from "../lib/migrate.js";
import { publishStore } from "../lib/store.js";
import { backend, filesDir } from "../lib/files.js";

if (backend() !== "local") { console.error("this writes the LOCAL file store only"); process.exit(1); }
const dir = process.argv[2] ?? path.join(ROOT, "backups", fs.readdirSync(path.join(ROOT, "backups")).filter((d) => /^\d{4}-/.test(d) && fs.existsSync(path.join(ROOT, "backups", d, "entries.json.gz"))).sort().at(-1));
console.log(`from ${dir}\n  to ${filesDir()}`);
const T = tablesFromBackup(dir);
console.log("tables:", Object.entries(T).map(([k, v]) => `${k} ${v.length}`).join(" · "));
const written = await filesFromTables(T);
console.log("written:", JSON.stringify(written));
const published = await publishStore();
console.log("published:", JSON.stringify(published));
