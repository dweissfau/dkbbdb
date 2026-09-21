// Fill sleeper_map for every rostered player. Uses ../capture/sleeper-players.json when it is under a
// day old (the single-user publish keeps it fresh), otherwise downloads Sleeper's player list.
//   node scripts/map-sleeper.mjs [--all]     --all: re-map everyone, not just players without a row
import fs from "node:fs";
import path from "node:path";
import { connect, ROOT } from "./db.mjs";
import { mapSleeper } from "../lib/sleeper.js";

const cachePath = path.join(ROOT, "..", "capture", "sleeper-players.json");
const fresh = fs.existsSync(cachePath) && Date.now() - fs.statSync(cachePath).mtimeMs < 24 * 3600e3;
const list = fresh || process.argv.includes("--offline") ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : null;
const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "sleeper-aliases.json"), "utf8"));

const db = await connect();
const { mapped, unmatched } = await mapSleeper(db, { list, aliases, onlyMissing: !process.argv.includes("--all") });
console.log(`mapped ${mapped} players${list ? " (cached Sleeper list)" : ""}; ${unmatched.length} unmatched`);
for (const u of unmatched) console.log(`   ${u.name} (${u.pos} ${u.team}) — add to db/sleeper-aliases.json`);
await db.end();
