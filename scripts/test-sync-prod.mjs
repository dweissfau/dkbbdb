// End-to-end check of the deployed upload path, as the extension would use it, for an existing user:
// issues a temporary sync token, GET /api/sync, re-uploads one real draft + one status-only draft, deletes the token.
//   node scripts/test-sync-prod.mjs <dk username> [site]
import path from "node:path";
import { createRequire } from "node:module";
import { connect, ROOT } from "./db.mjs";
import { issueSyncToken } from "../lib/auth.js";
import { compactStatus } from "../lib/ingest.js";

const [username = "ZBbih", site = "https://dkbbdb.vercel.app"] = process.argv.slice(2);
const lite = new (createRequire(path.join(ROOT, "..", "package.json"))("better-sqlite3"))(path.join(ROOT, "..", "data", "portfolio.sqlite"), { readonly: true });
const db = await connect();
const userId = (await db.query("select user_id from dk_accounts where lower(username) = lower($1)", [username])).rows[0].user_id;
const token = await issueSyncToken(db, userId, "test");
const call = async (method, body) => { const r = await fetch(`${site}/api/sync`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }); return [r.status, await r.json()]; };
try {
  const [s1, known] = await call("GET");
  console.log("GET", s1, "complete", known.complete?.length, "draftGroups", known.draftGroups);
  const rows = lite.prepare("select raw_contest, raw_draft_status from drafts where my_username = ? limit 2").all(username);
  const drafts = [{ contest: JSON.parse(rows[0].raw_contest), ...compactStatus(JSON.parse(rows[0].raw_draft_status)) }, { contest: JSON.parse(rows[1].raw_contest) }];
  const t0 = Date.now();
  const [s2, out] = await call("POST", { drafts, last: true });
  console.log("POST", s2, JSON.stringify(out), `${Date.now() - t0} ms`);
  const [s3] = await fetch(`${site}/api/sync`, { headers: { Authorization: "Bearer dkbb_" + "x".repeat(32) } }).then((r) => [r.status]);
  console.log("bad token →", s3);
} finally {
  await db.query("delete from sync_tokens where user_id = $1", [userId]);
  await db.end();
}
