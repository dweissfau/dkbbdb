// Take a DraftKings account off the live site: its file (teams and every league it uploaded) and its rank history;
// the store is rebuilt without it. Leagues another account also uploaded stay through that account's file.
//   node scripts/remove-account.mjs <username> [--yes] [site = https://dkbbdb.com]
import { loadEnv } from "./db.mjs";

const args = process.argv.slice(2), site = args.find((a) => a.startsWith("http")) ?? "https://dkbbdb.com";
const name = args.find((a) => !a.startsWith("http") && !a.startsWith("--"));
if (!name) { console.error("usage: node scripts/remove-account.mjs <username> [--yes]"); process.exit(1); }
const key = process.env.ADMIN_KEY ?? loadEnv().ADMIN_KEY, hdr = { "x-admin-key": key };
const who = await (await fetch(`${site}/api/admin`, { headers: hdr })).json();
const a = (who.accounts ?? []).find((x) => String(x.username).toLowerCase() === name.toLowerCase());
if (!a) { console.log(`no account named ${name}`); process.exit(0); }
console.log(`${a.username}: ${a.teams} teams, ${a.tournaments} tournaments, signed up ${a.created_at}, last sync ${a.synced_at}`);
if (!args.includes("--yes")) { console.log("add --yes to remove it"); process.exit(0); }
const r = await (await fetch(`${site}/api/admin?remove=${encodeURIComponent(a.username)}`, { headers: hdr })).json();
console.log(JSON.stringify(r));
