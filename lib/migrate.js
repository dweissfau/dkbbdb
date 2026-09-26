// Turn the old database's tables (a scripts/backup.mjs dump, or files uploaded through /api/admin?import=) into the
// site's files (lib/store.js layout). One-off for leaving Postgres behind (2026-09-26); also the restore path for a
// backup taken before that. Row shapes = the old tables' columns as JSON (numerics may be strings).
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { putGz } from "./files.js";
import { PATHS } from "./store.js";
import { LIMITS } from "./guard.js";

const num = (v) => (v == null ? null : Number(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const up = (s) => (s == null ? null : String(s).toUpperCase());

// dir with <table>.json.gz files → { table: rows }
export function tablesFromBackup(dir) {
  const T = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json.gz")) T[f.replace(/\.json\.gz$/, "")] = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
  return T;
}

// → { accounts, groups, sleeper, tournaments, history, uploads, prior } (counts written)
export async function filesFromTables(T, { now = new Date().toISOString() } = {}) {
  const get = (t) => T[t] ?? [];
  const out = {};
  // accounts: entries + their contests + every roster of those leagues
  const contests = new Map(get("contests").map((c) => [String(c.contest_id), c]));
  const podTeams = new Map();
  for (const t of get("pod_teams")) { const k = String(t.contest_id); if (!podTeams.has(k)) podTeams.set(k, []); podTeams.get(k).push(t); }
  const accounts = new Map(get("dk_accounts").map((a) => [a.user_key, { k: a.user_key, u: a.username, createdAt: iso(a.created_at), syncedAt: iso(a.synced_at), entries: {}, contests: {}, pods: {} }]));
  for (const e of get("entries")) {
    const a = accounts.get(e.user_key), cid = String(e.contest_id), c = contests.get(cid);
    if (!a || !c) continue;
    a.entries[String(e.entry_id)] = { cid, state: e.state ?? null, prizes: num(e.prizes), syncedAt: iso(e.synced_at) };
    a.contests[cid] ??= { cid, name: c.name ?? null, type: c.contest_type ?? null, tkey: up(c.tournament_key), mega: c.mega_contest_id == null ? null : String(c.mega_contest_id), round: c.round ?? null,
      dgid: c.draft_group_id ?? null, buyIn: num(c.buy_in), prizePool: num(c.prize_pool), entrants: c.entrants ?? null, pp: c.positions_paid ?? null, draftState: c.draft_state ?? null,
      draftDate: iso(c.draft_date), start: iso(c.start_date), picksTotal: c.picks_total ?? null };
    a.pods[cid] ??= { rosters: Object.fromEntries((podTeams.get(cid) ?? []).map((t) => [t.user_key, { u: t.username ?? null, s: t.seat ?? null, ek: t.entry_key == null ? null : String(t.entry_key), d: t.draftable_ids ?? [], pk: t.pick_numbers ?? null }])) };
  }
  for (const a of accounts.values()) await putGz(PATHS.account(a.k), a);
  out.accounts = accounts.size;
  // player lists
  const groups = new Map();
  for (const d of get("draftables")) { const g = groups.get(d.draft_group_id) ?? groups.set(d.draft_group_id, { dgid: d.draft_group_id, players: {}, source: "migrated", at: now }).get(d.draft_group_id); g.players[d.draftable_id] = [d.player_id ?? null, d.name ?? null, d.position ?? null, d.team ?? null, num(d.adp)]; }
  for (const g of groups.values()) await putGz(PATHS.group(g.dgid), g);
  out.groups = groups.size;
  // stats mapping
  const sleeper = {}; for (const r of get("sleeper_map")) sleeper[r.player_id] = [r.sleeper_id, r.team ?? null];
  await putGz(PATHS.sleeper, sleeper); out.sleeper = Object.keys(sleeper).length;
  // tournaments + captures
  const tournaments = {};
  for (const t of get("tournaments")) tournaments[up(t.tournament_key)] = { name: t.name ?? null, ladder: t.ladder ?? null, top: num(t.top_prize), rounds: t.rounds ?? null, source: t.source ?? null, updatedAt: iso(t.updated_at), captures: {} };
  for (const c of get("tournament_captures")) { const t = (tournaments[up(c.tournament_key)] ??= { name: null, ladder: null, top: null, rounds: null, source: null, updatedAt: null, captures: {} }); t.captures[c.source] = { status: c.status ?? null, body: c.body ?? "", sender: c.sender ?? null, at: iso(c.at) ?? now }; }
  await putGz(PATHS.tournaments, tournaments); out.tournaments = Object.keys(tournaments).length;
  // rank history: { entryId: [[YYYY-MM-DD, rank, points], …] } — the old "day" column is a date at Eastern midnight
  const history = {};
  for (const r of get("rank_history").sort((a, b) => String(a.day).localeCompare(String(b.day)))) { if (r.rank == null) continue; const day = new Date(r.day).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); (history[String(r.entry_id)] ??= []).push([day, r.rank, num(r.points)]); }
  await putGz(PATHS.history, history); out.history = Object.keys(history).length;
  // upload log, per sender
  const uploads = new Map();
  for (const r of get("upload_log")) { if (!r.sender) continue; (uploads.get(r.sender) ?? uploads.set(r.sender, []).get(r.sender)).push({ at: iso(r.at), ext: r.ext_version ?? "", userKeys: r.user_keys ?? [], usernames: r.usernames ?? [], drafts: r.drafts ?? 0, refreshed: r.refreshed ?? 0, skipped: r.skipped ?? 0, rejected: r.rejected ?? 0, note: r.note ?? null }); }
  for (const [sender, rows] of uploads) await putGz(PATHS.uploadLog(sender), rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-LIMITS.logRows));
  out.uploads = uploads.size;
  // finished-week totals (lib/prior.js file shape)
  const pr = get("pod_prior"), want = Math.max(0, ...pr.map((r) => r.through_week ?? 0));
  if (want > 0) await putGz(PATHS.prior, { want, rows: pr.filter((r) => r.through_week === want).map((r) => [String(r.contest_id), { through_week: r.through_week, computed_at: iso(r.computed_at), data: r.data }]) });
  out.prior = want > 0 ? pr.filter((r) => r.through_week === want).length : 0;
  return out;
}
