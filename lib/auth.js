// Who is calling?
//   the app page     → Authorization: Bearer <Clerk session token>   (requireUser)
//   the extension    → Authorization: Bearer dkbb_<sync token>        (requireSyncUser; only its SHA-256 is stored)
import { createHash, randomBytes } from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";

const bearer = (req) => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim() ?? null;
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function deny(res, status, error) { res.status(status).json({ error }); return null; }

// → users row { id, clerk_id, email } (created on first sight), or null after answering 401
export async function requireUser(db, req, res) {
  const token = bearer(req);
  if (!token || token.startsWith("dkbb_")) return deny(res, 401, "sign in first");
  let claims;
  try {
    const parties = String(process.env.CLERK_AUTHORIZED_PARTIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY, ...(parties.length ? { authorizedParties: parties } : {}) });
  } catch { return deny(res, 401, "session expired — sign in again"); }
  const clerkId = claims.sub;
  const found = (await db.query("select id, clerk_id, email from users where clerk_id = $1", [clerkId])).rows[0];
  if (found) return found;
  let email = null, verified = [];
  try {
    const u = await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY }).users.getUser(clerkId);
    email = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? null;
    verified = (u.emailAddresses ?? []).filter((e) => e.verification?.status === "verified").map((e) => e.emailAddress.toLowerCase());
  } catch { /* the account still works without an email on file */ }
  // teams loaded before this person signed up (scripts/claim.mjs) wait under their email with no clerk_id:
  // the first sign-in with that VERIFIED address adopts them
  if (verified.length) {
    const adopted = (await db.query(
      `update users set clerk_id = $1 where id = (select id from users where clerk_id is null and lower(email) = any($2::text[]) order by id limit 1)
       returning id, clerk_id, email`, [clerkId, verified])).rows[0];
    if (adopted) return adopted;
  }
  return (await db.query(
    `insert into users (clerk_id, email) values ($1,$2)
     on conflict (clerk_id) do update set email = coalesce(excluded.email, users.email) returning id, clerk_id, email`, [clerkId, email])).rows[0];
}

export async function requireSyncUser(db, req, res) {
  const token = bearer(req);
  if (!token?.startsWith("dkbb_")) return deny(res, 401, "extension is not connected — open dkbbdb.com/connect");
  const row = (await db.query(
    `update sync_tokens set last_used_at = now() where token_hash = $1 returning user_id`, [sha(token)])).rows[0];
  if (!row) return deny(res, 401, "this connection was removed — reconnect the extension at dkbbdb.com/connect");
  return { id: row.user_id };
}

// one live token per user: connecting again replaces the old one
export async function issueSyncToken(db, userId, label = "extension") {
  const token = "dkbb_" + randomBytes(24).toString("base64url");
  await db.query("delete from sync_tokens where user_id = $1", [userId]);
  await db.query("insert into sync_tokens (token_hash, user_id, label) values ($1,$2,$3)", [sha(token), userId, label]);
  return token;
}
