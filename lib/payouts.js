// Payout ladders: the guaranteed prize for REACHING each round of a multi-round best ball tournament
// ({ "2": 30, "3": 100, "4": 1000 } = advance out of round 1 and you have $30 locked, and so on). DraftKings shows
// the table only to a signed-in user, so the extension captures payout-related excerpts of the tournament's pages
// on a sync (POST /api/tournaments) and this module reads a ladder out of them. Everything captured is kept
// (tournament_captures) so the reader can be improved and re-run without another sync.
import { createHash } from "node:crypto";

export const CAPTURE_LIMITS = { tournamentsPerCall: 12, sourcesPerTournament: 8, bodyBytes: 300_000, capturesPerHour: 400 };
const KEY_RE = /^[0-9A-Fa-f]{32}$/;
const SOURCE_RE = /^(https:\/\/(www|api)\.draftkings\.com\/[^\s]{1,300}|dom:\/[^\s]{1,200})$/;

const money = (s) => { const n = Number(String(s).replace(/[$,\s]/g, "")); return isFinite(n) && n > 0 ? n : null; };
const roundOf = (label) => { const s = String(label); const m = /(?:round|rd\.?|\br)\s*([1-9])\b/i.exec(s); if (m) return Number(m[1]); return /\b(?:finals?|championship)\b/i.test(s) ? "F" : null; };

// ---- JSON: DraftKings' own shapes (megaContestPayoutSummary.roundPayouts, tierPayoutDescriptions.Cash …) ----
function fromJson(root) {
  const ladder = {}; let top = null;
  const take = (round, cash) => { if (round == null || cash == null) return; ladder[round] = ladder[round] == null ? cash : Math.min(ladder[round], cash); };
  const minCash = (payouts) => { let min = null; for (const p of payouts ?? []) { const c = money(p?.tierPayoutDescriptions?.Cash ?? p?.payoutDescriptions?.Cash ?? p?.Cash ?? p?.cash ?? p?.amount ?? p?.value);
    if (c != null) { min = min == null ? c : Math.min(min, c); if (Number(p?.minPosition ?? p?.min ?? 0) === 1) top = top == null ? c : Math.max(top, c); } } return min; };
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 12) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    // { roundNumber: 2, roundDisplayText: "…", payouts: [...] }
    const rn = o.roundNumber ?? o.RoundNumber ?? o.round ?? o.Round;
    if (Number.isInteger(rn) && rn > 1 && Array.isArray(o.payouts ?? o.Payouts)) take(rn, minCash(o.payouts ?? o.Payouts));
    // { minPosition, maxPosition, tierPayoutDescriptions: { Cash: "$30.00" } } tagged with a round in its text
    const desc = o.tierPayoutDescriptions ?? o.payoutDescriptions;
    if (desc && typeof desc === "object") { const cash = money(desc.Cash), r = roundOf(JSON.stringify(desc)); if (cash != null && r != null && r !== "F") take(r, cash); }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(root, 0);
  return { ladder, top };
}

// ---- text: "Advance to Round 2 … $30", "Round 3 (Week 16) — min. $100", "Finals: $1,000 guaranteed" … ----
function fromText(text) {
  const ladder = {}; let top = null;
  const t = String(text).replace(/\s+/g, " ");
  const take = (round, cash) => { if (round == null || cash == null) return; ladder[round] = ladder[round] == null ? cash : Math.min(ladder[round], cash); };
  // a round label with the first dollar amount after it (within 120 characters)
  const re = /\b(?:advance(?:s|d)?\s+to\s+)?(round\s*[2-9]|r[2-9]\b|finals?|championship)\b[^$]{0,120}?\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/gi;
  let m; while ((m = re.exec(t))) { const r = roundOf(m[1]); const cash = money(m[2]); if (r === "F") { /* handled below */ } else take(r, cash); }
  // "$X to 1st" / "1st place … $X" → the top prize (only used for the display, never for the ladder)
  const tm = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:M|K)?\s*(?:to\s+1st|to first|for first)/i.exec(t) ?? /1st(?: place)?[^$]{0,40}\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(t);
  if (tm) top = money(tm[1]);
  return { ladder, top };
}

// A ladder must be a chain of increasing guarantees starting at round 2 — anything else is noise
function sane(ladder) {
  const rounds = Object.keys(ladder).map(Number).filter((r) => r >= 2 && r <= 9).sort((a, b) => a - b);
  if (!rounds.length || rounds[0] !== 2) return null;
  const out = {}; let prev = 0;
  for (const r of rounds) { const v = ladder[r]; if (!(v > 0) || v < prev || v > 1e7) break; out[r] = v; prev = v; }
  return Object.keys(out).length ? out : null;
}

// captures = [{ source, body }] → { ladder, top, source } | null
export function readLadder(captures) {
  for (const c of captures ?? []) {
    const body = String(c.body ?? ""); if (!body) continue;
    let got = null;
    if (/^\s*[[{]/.test(body)) { try { got = fromJson(JSON.parse(body)); } catch { /* not JSON after all */ } }
    if (!got || !sane(got.ladder)) { const txt = fromText(body.replace(/<[^>]+>/g, " ")); got = { ladder: { ...(got?.ladder ?? {}), ...txt.ladder }, top: got?.top ?? txt.top }; }
    const ladder = sane(got.ladder);
    if (ladder) return { ladder, top: got.top ?? null, source: c.source };
  }
  return null;
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// what the extension posts: [{ key, name, sources: [{ url, status, body }] }] → stored + parsed. Returns per key
// what happened; { limited } when the sender is over the hourly cap.
export async function storeCaptures(db, tournaments, { sender = null } = {}) {
  const list = (Array.isArray(tournaments) ? tournaments : []).slice(0, CAPTURE_LIMITS.tournamentsPerCall);
  if (sender) {
    const n = (await db.query(`select count(*)::int n from tournament_captures where sender = $1 and at > now() - interval '1 hour'`, [sender])).rows[0].n;
    if (n >= CAPTURE_LIMITS.capturesPerHour) return { limited: "Too many payout captures from this connection in the last hour." };
  }
  const out = {};
  for (const t of list) {
    const key = String(t?.key ?? "").toUpperCase();
    if (!KEY_RE.test(key)) { out[String(t?.key ?? "?")] = "bad key"; continue; }
    const name = t?.name == null ? null : String(t.name).slice(0, 200);
    const sources = (Array.isArray(t?.sources) ? t.sources : []).slice(0, CAPTURE_LIMITS.sourcesPerTournament)
      .filter((s) => SOURCE_RE.test(String(s?.url ?? "")) && typeof s?.body === "string" && s.body.length)
      .map((s) => ({ source: String(s.url).slice(0, 300), status: Number.isInteger(s.status) ? s.status : null, body: s.body.slice(0, CAPTURE_LIMITS.bodyBytes) }));
    for (const s of sources) {
      await db.query(
        `insert into tournament_captures (tournament_key, source, status, body, sender, at) values ($1,$2,$3,$4,$5,now())
         on conflict (tournament_key, source) do update set status = excluded.status, body = excluded.body, sender = excluded.sender, at = now()`,
        [key, s.source, s.status, s.body, sender]);
    }
    await db.query(`insert into tournaments (tournament_key, name) values ($1,$2) on conflict (tournament_key) do update set name = coalesce(tournaments.name, excluded.name)`, [key, name]);
    const r = await parseStored(db, key);
    out[key] = { sources: sources.length, ladder: r?.ladder ?? null, hash: sources.length ? hash(sources.map((s) => s.body).join("|")) : null };
  }
  return out;
}

// re-read a tournament's ladder from everything captured for it (a hand-set ladder is never overwritten)
export async function parseStored(db, key) {
  const caps = (await db.query(`select source, body from tournament_captures where tournament_key = $1 order by at desc`, [key])).rows;
  const got = readLadder(caps);
  if (!got) return null;
  await db.query(
    `update tournaments set ladder = $2::jsonb, top_prize = coalesce($3, top_prize), source = $4, updated_at = now()
      where tournament_key = $1 and coalesce(source, '') <> 'manual'`, [key, JSON.stringify(got.ladder), got.top, got.source]);
  return got;
}

// every ladder on file → Map(tournament_key → { ladder, top })
export async function loadLadders(db) {
  const rows = (await db.query(`select tournament_key, ladder, top_prize from tournaments where ladder is not null`)).rows;
  return new Map(rows.map((r) => [r.tournament_key, { ladder: r.ladder, top: r.top_prize == null ? null : Number(r.top_prize) }]));
}
