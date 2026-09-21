// End-to-end check of the deployed site the way the extension and a visitor use it (no accounts):
// POST /api/known, re-upload one real draft + one status-only draft, then search → portfolio → live.
//   node scripts/test-sync-prod.mjs <dk username> [site]
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
import { compactStatus } from "../lib/ingest.js";

const [username = "ZBbih", site = "https://dkbbdb.com"] = process.argv.slice(2);
const lite = new (createRequire(path.join(ROOT, "..", "package.json"))("better-sqlite3"))(path.join(ROOT, "..", "data", "portfolio.sqlite"), { readonly: true });
const post = async (p, body, headers = {}) => { const r = await fetch(site + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
const get = async (p, headers = {}) => { const r = await fetch(site + p, { headers }); return [r.status, r.status === 304 ? null : await r.json(), r.headers]; };

const rows = lite.prepare("select entry_id, raw_contest, raw_draft_status from drafts where my_username = ? limit 2").all(username);
const [s1, known] = await post("/api/known", { entries: rows.map((r) => r.entry_id) });
console.log("known", s1, "complete", known.complete?.length, "of", rows.length, "· usernames", known.usernames, "· draftGroups", known.draftGroups);

const drafts = [{ contest: JSON.parse(rows[0].raw_contest), ...compactStatus(JSON.parse(rows[0].raw_draft_status)) }, { contest: JSON.parse(rows[1].raw_contest) }];
const [s2] = await post("/api/sync", { drafts, last: true });
console.log("upload without the extension header →", s2);
const t0 = Date.now();
const [s3, out] = await post("/api/sync", { drafts, last: true }, { "x-dkbbdb-extension": "test" });
console.log("upload", s3, JSON.stringify(out), `${Date.now() - t0} ms`);

const [s4, found] = await get("/api/search?q=" + encodeURIComponent(username.slice(0, 3)));
console.log("search", s4, JSON.stringify(found.results));
const entry = rows[0].entry_id;
const [s5, pf] = await get("/api/portfolio?entry=" + entry);
console.log("team pop-up data", s5, "teams", pf.drafts?.length, "picks", pf.picks?.length, "account", pf.me?.accounts);
const [s6, live, h] = await get("/api/live?entry=" + entry);
console.log("team pop-up live", s6, "teams", Object.keys(live.status ?? {}).length, "league rows", Object.values(live.pods ?? {})[0]?.length, "cache", h.get("cache-control"));
const [s7] = await get("/api/live?entry=" + entry, { "if-none-match": h.get("etag") });
console.log("again with the ETag →", s7);
const [s8] = await get("/api/portfolio?u=" + encodeURIComponent(username));
const [s9] = await get("/api/live?u=" + encodeURIComponent(username));
console.log("whole-portfolio requests (removed) →", s8, s9);
const old = await fetch(`${site}/u/${encodeURIComponent(username)}`, { redirect: "manual" });
console.log("/u/" + username, "→", old.status, old.headers.get("location"));
const lb = await get("/api/leaderboard?u=" + encodeURIComponent(username));
console.log("leaderboard filtered to the username:", lb[1].total, "teams");
