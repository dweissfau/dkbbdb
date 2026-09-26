// Match every rostered DraftKings player to the public stats feed (lib/sleeper.js) in the LOCAL file store and
// report who is still unmatched (they score 0 until aliased in db/sleeper-aliases.json). The live site does the
// same by itself after every sync; run this after adding an alias, then push the alias file with a deploy.
//   node scripts/map-sleeper.mjs [--all]
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db.mjs";
import { mapSleeper, SLEEPER_PLAYERS } from "../lib/sleeper.js";
import { fetchJson } from "../lib/feeds.js";
import { loadStore, publishStore } from "../lib/store.js";

const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "sleeper-aliases.json"), "utf8"));
const store = await loadStore();
if (!store) { console.error("no local store — run scripts/migrate-local.mjs or drop a backup into .blob/"); process.exit(1); }
const list = await fetchJson(SLEEPER_PLAYERS, 30e3);
const { mapped, unmatched } = await mapSleeper(store, { list, aliases, onlyMissing: !process.argv.includes("--all") });
console.log(`mapped ${mapped} player(s); ${unmatched.length} unmatched`);
for (const u of unmatched) console.log(`   ${u.name} (${u.pos} ${u.team}) — add to db/sleeper-aliases.json`);
if (mapped) console.log("republished:", JSON.stringify(await publishStore()));
