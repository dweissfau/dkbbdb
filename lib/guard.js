// Protection for the open upload (POST /api/sync has no sign-in, so nothing proves who is sending):
//   checkDraft()      plausibility — a real DraftKings draft board has a very particular shape
//   rate limits       per sender (hashed IP) and per DraftKings account, counted from upload_log
//   logUpload()       every upload is recorded so bad data can be traced and removed (scripts/remove-account.mjs)
// None of this can prove a draft is genuine (only DraftKings could, and it needs the owner's login). The aim is
// that faking data is tedious, cannot be aimed at someone else's username, and is quick to undo.
import { createHash } from "node:crypto";

export const LIMITS = {
  uploadsPerHour: 150,     // requests per sender; a 200-team sync is ~9 requests, so this is ~15 full syncs an hour
  draftsPerHour: 4000,     // drafts (full or status-only) per sender per hour
  accountsPerDay: 6,       // different DraftKings accounts one sender may sync in 24 h
  entriesPerAccount: 2500, // teams stored for one DraftKings account (a sign-up reached 1,025 on day one; raised from 1,500 on 2026-09-23)
  maxUsers: 20, maxRounds: 30,
};

// the sender, as a salted hash — the address itself is never stored
export function senderHash(req) {
  const ip = String(req.headers["x-real-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0] ?? "").trim() || "unknown";
  return createHash("sha256").update(ip + "|" + (process.env.CRON_SECRET ?? "dkbbdb")).digest("hex").slice(0, 32);
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;

// d = one uploaded draft WITH a board (shape: lib/ingest.js). → null when plausible, otherwise the reason.
export function checkDraft(d) {
  const c = d.contest ?? {}, users = d.users, board = d.board;
  if (!isId(c.ContestId) || !isId(c.UserContestId)) return "contest / entry id is not a number";
  if (!Array.isArray(users) || users.length < 2 || users.length > LIMITS.maxUsers) return "drafter list has an impossible size";
  if (!Array.isArray(board) || !board.length || board.length % users.length) return "draft board does not divide evenly between the drafters";
  const size = users.length, rounds = board.length / size;
  if (rounds > LIMITS.maxRounds) return "draft has too many rounds";
  if (c.NumberOfEntrants != null && c.NumberOfEntrants !== size) return "drafter count does not match the contest's entrants";
  if (c.BuyInAmount != null && !(c.BuyInAmount >= 0 && c.BuyInAmount <= 100000)) return "impossible buy-in";
  const keys = new Set();
  for (const u of users) {
    if (!Array.isArray(u) || typeof u[0] !== "string" || !u[0] || u[0].length > 80 || keys.has(u[0])) return "drafter ids are missing or repeated";
    if (u[1] != null && (typeof u[1] !== "string" || u[1].length > 40)) return "a username is not plausible";
    keys.add(u[0]);
  }
  const overall = new Set(), dids = new Set(), pids = new Set(), perRound = new Map();
  for (const p of board) {
    if (!Array.isArray(p) || p.length < 6) return "malformed pick";
    const [u, did, pid, round, sel, ov] = p;
    if (!Number.isInteger(u) || u < 0 || u >= size) return "pick by an unknown drafter";
    if (!Number.isInteger(round) || round < 1 || round > rounds || !Number.isInteger(sel) || sel < 1 || sel > size) return "pick outside the board";
    if (ov !== (round - 1) * size + sel || overall.has(ov)) return "pick numbers are inconsistent";
    overall.add(ov);
    const k = `${round}|${u}`; // everyone picks exactly once per round (true for snake and third-round-reversal alike)
    if (perRound.has(k)) return "a drafter picks twice in one round";
    perRound.set(k, 1);
    if ((did == null) !== (pid == null)) return "half-made pick";
    if (did == null) continue;
    if (!isId(did) || !isId(pid) || dids.has(did) || pids.has(pid)) return "a player is drafted twice in the same league";
    dids.add(did); pids.add(pid);
  }
  if (!Array.isArray(d.lineup) || d.lineup.length > rounds || d.lineup.some((x) => !dids.has(x))) return "lineup does not belong to this board";
  const start = Date.parse(d.startTime ?? "");
  if (isFinite(start) && start > Date.now() + 2 * 864e5) return "draft date is in the future";
  return null;
}

// share of a draft's made picks that exist in DraftKings' player list for its draft group (known: Set of draftable ids)
export const knownShare = (d, known) => { const made = d.board.filter((p) => p[1] != null); return made.length ? made.filter((p) => known.has(p[1])).length / made.length : 1; };

export async function recentUse(db, sender) {
  const r = (await db.query(
    `select count(*) filter (where at > now() - interval '1 hour')::int uploads,
            coalesce(sum(drafts + refreshed + rejected) filter (where at > now() - interval '1 hour'), 0)::int drafts,
            coalesce(array_agg(distinct k) filter (where k is not null), '{}') accounts
       from upload_log l left join lateral unnest(l.user_keys) k on true
      where l.sender = $1 and l.at > now() - interval '24 hours'`, [sender])).rows[0];
  return { uploads: r.uploads, drafts: r.drafts, accounts: new Set(r.accounts) };
}

export async function logUpload(db, row) {
  await db.query(
    `insert into upload_log (sender, ext_version, user_keys, usernames, drafts, refreshed, skipped, rejected, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.sender, String(row.ext ?? "").slice(0, 20), row.userKeys ?? [], row.usernames ?? [], row.drafts ?? 0, row.refreshed ?? 0, row.skipped ?? 0, row.rejected ?? 0, row.note ? String(row.note).slice(0, 500) : null]);
}
