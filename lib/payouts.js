// Payout ladders: the guaranteed prize for REACHING each round of a multi-round best ball tournament
// ({ "2": 40, "3": 100, "4": 1000 } = advance out of round 1 and you have $40 locked — the last-place prize of
// round 2 — and so on). DraftKings shows the table only to a signed-in user (the Contest Details pop-up of the
// tournament's page: "PRIZE PAYOUTS Round 2 · 1st Advance to R3 · 2nd - 3rd $50 · 4th - 12th $40"), so the
// extension captures payout-related excerpts of the tournament's pages and this module reads a ladder out of
// them. Everything captured is kept (tournament_captures) so the reader can be improved and re-run without
// another sync.
import { createHash } from "node:crypto";

export const CAPTURE_LIMITS = { tournamentsPerCall: 12, sourcesPerTournament: 8, bodyBytes: 300_000, capturesPerHour: 400 };
const KEY_RE = /^[0-9A-Fa-f]{32}$/;
const SOURCE_RE = /^(https:\/\/(www|api)\.draftkings\.com\/[^\s]{1,300}|dom:\/[^\s]{1,200})$/;

// "$40", "$1,000.00", "$3M", "$20.0M", "$50K" → a number of dollars
const MONEY = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*([MK])?(?![0-9])/i;
const money = (s) => { const m = MONEY.exec(String(s)); if (!m) return null; const n = Number(m[1].replace(/,/g, "")) * (m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1); return isFinite(n) && n > 0 ? n : null; };
const roundOf = (label) => { const s = String(label); const m = /(?:round|rd\.?|\br)\s*([1-9])\b/i.exec(s); if (m) return Number(m[1]); return /\b(?:finals?|championship)\b/i.test(s) ? "F" : null; };
const lowest = (ladder, round, cash) => { if (round == null || cash == null || round === "F") return; ladder[round] = ladder[round] == null ? cash : Math.min(ladder[round], cash); };

// ---- JSON: DraftKings' own shapes (megaContestPayoutSummary.roundPayouts, tierPayoutDescriptions.Cash …) ----
function fromJson(root) {
  const ladder = {}; let top = null;
  const minCash = (payouts) => { let min = null; for (const p of payouts ?? []) { const c = money(p?.tierPayoutDescriptions?.Cash ?? p?.payoutDescriptions?.Cash ?? p?.Cash ?? p?.cash ?? p?.amount ?? p?.value);
    if (c != null) { min = min == null ? c : Math.min(min, c); if (Number(p?.minPosition ?? p?.min ?? 0) === 1) top = top == null ? c : Math.max(top, c); } } return min; };
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 12) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const rn = o.roundNumber ?? o.RoundNumber ?? o.round ?? o.Round;
    if (Number.isInteger(rn) && rn > 1 && Array.isArray(o.payouts ?? o.Payouts)) lowest(ladder, rn, minCash(o.payouts ?? o.Payouts));
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(root, 0);
  return { ladder, top };
}

// ---- the page's PRIZE PAYOUTS table, as text: "Round 2 1st … Advance to R3 2nd - 3rd $50 4th - 12th $40" ----
// Each round's section runs to the next "Round N" heading or the next capitalised heading; within it every
// "<place>[ - <place>] $X" row is a payout, and the round's guarantee is the smallest.
const ORD = "(?:[0-9]{1,6}(?:st|nd|rd|th))";
const ROW = new RegExp(`${ORD}(?:\\s*-\\s*${ORD})?\\s*(\\$\\s?[0-9][0-9,]*(?:\\.[0-9]+)?\\s*[MK]?)(?![0-9])`, "gi");
function fromTable(text) {
  const ladder = {}; let top = null;
  const t = String(text).replace(/\s+/g, " ");
  const heads = [...t.matchAll(/\bround\s*([1-9])\b/gi)];
  for (let i = 0; i < heads.length; i++) {
    const r = Number(heads[i][1]), from = heads[i].index + heads[i][0].length;
    const next = heads[i + 1]?.index ?? t.length;
    const stop = t.slice(from, next).search(/\b(CONTEST SIZES|ENTRANTS|RULES & SCORING|SUMMARY|Experience Badges)\b/);
    const section = t.slice(from, stop >= 0 ? from + stop : next);
    let m; ROW.lastIndex = 0;
    while ((m = ROW.exec(section))) { const cash = money(m[1]); lowest(ladder, r, cash); if (/^1st/i.test(m[0]) && cash != null) top = Math.max(top ?? 0, cash); }
  }
  return { ladder, top };
}

// ---- loose text: "Advance to Round 2 … guaranteed $40", "Round 3 … minimum $100" (a guarantee word is required) ----
function fromText(text) {
  const ladder = {}; let top = null;
  const t = String(text).replace(/\s+/g, " ");
  const re = /\b(round\s*[2-9]|r[2-9]\b)\b[^$]{0,80}?(?:minimum|min\.?|guaranteed?|at least)[^$]{0,40}?(\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s*[MK]?)(?![0-9])/gi;
  let m; while ((m = re.exec(t))) lowest(ladder, roundOf(m[1]), money(m[2]));
  const re2 = /(\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s*[MK]?)(?![0-9])[^$]{0,40}?(?:minimum|min\.?|guaranteed?|at least)[^$]{0,40}?\b(round\s*[2-9]|r[2-9]\b)/gi;
  while ((m = re2.exec(t))) lowest(ladder, roundOf(m[2]), money(m[1]));
  const tm = /(\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s*[MK]?)\s*(?:to\s+1st|to first|for first)/i.exec(t);
  if (tm) top = money(tm[1]);
  return { ladder, top };
}

// A ladder must be a chain of guarantees starting at round 2, each at least the one before — anything else is noise
function sane(ladder) {
  const rounds = Object.keys(ladder).map(Number).filter((r) => r >= 2 && r <= 9).sort((a, b) => a - b);
  if (!rounds.length || rounds[0] !== 2) return null;
  const out = {}; let prev = 0;
  for (const r of rounds) { const v = ladder[r]; if (!(v > 0) || v < prev || v > 1e7) break; out[r] = v; prev = v; }
  return Object.keys(out).length ? out : null;
}

// captures = [{ source, body }] → { ladder, top, source } | null. The table reader is trusted first, then
// DraftKings' JSON, then guarantee wording in prose.
export function readLadder(captures) {
  for (const c of captures ?? []) {
    const body = String(c.body ?? ""); if (!body) continue;
    const text = body.replace(/<[^>]+>/g, " ");
    const tries = [fromTable(text)];
    if (/^\s*[[{]/.test(body)) { try { tries.push(fromJson(JSON.parse(body))); } catch { /* not JSON after all */ } }
    tries.push(fromText(text));
    for (const got of tries) { const ladder = sane(got.ladder); if (ladder) return { ladder, top: got.top ?? tries.map((x) => x.top).find((x) => x != null) ?? null, source: c.source }; }
  }
  return null;
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// "CONTEST SIZES Round 1 (Top 2 Advance) 12-Player Round 2 (Top 1 Advance) 12-Player Round 3 (Top 1 Advance) 10-Player Round 4 1089-Player"
// → { "1": { adv: 2, size: 12 }, "2": { adv: 1, size: 12 }, … } (the final round has no advance count)
export function readRounds(captures) {
  for (const c of captures ?? []) {
    const t = String(c.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!/CONTEST SIZES/i.test(t)) continue;
    // the whole capture: the table may be cut short in one excerpt window and complete in another
    const out = {}; let m;
    const re = /Round\s*([1-9])\s*(?:\((?:Top\s*)?([0-9]+)\s*Advance\)\s*)?([0-9]{1,6})-Player/gi;
    while ((m = re.exec(t))) { const r = m[1]; if (!out[r]) out[r] = { adv: m[2] == null ? null : Number(m[2]), size: Number(m[3]) }; }
    if (out["1"]) return out;
  }
  return null;
}

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
  const rounds = readRounds(caps);
  if (rounds) await db.query(`update tournaments set rounds = $2::jsonb where tournament_key = $1`, [key, JSON.stringify(rounds)]);
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
