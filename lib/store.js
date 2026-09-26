// The site's data as ONE FILE in Vercel Blob — every synced account's teams with every league's opponents, the
// player lists, the stats mapping and the payout ladders: everything scoring and the team pop-up need. Built from
// the database after each upload (publishStore) and read by everything else (loadStore), so the pages, the board
// and the pop-up never touch the database. Like deploy/data/base.json on the owner's own site, but for everyone.
//
//   store/base.json.gz   { v, at, accounts: [{ k, u, syncedAt }], entries: { id: { cid, dgid, pp, u, state, prizes, syncedAt } },
//                          contests: { cid: { name, type, buyIn, entrants, draftDate, draftState, picksTotal, pp, round, dgid, tkey, start } },
//                          pods: { cid: { dgid, from, rosters: { key: { u, d: [did], s, pk: [pick numbers] } } } },
//                          draftables: { dgid: { did: [pid, name, pos, team, adp] } }, sleeper: { pid: [sleeperId, team] },
//                          ladders: { tkey: { ladder, top } } }
//   store/prior.json.gz  finished-week totals (lib/prior.js)        store/board.json.gz  the scored board (backup copy)
//
// Blob is reached with Vercel's own credentials on the deployment (OIDC + BLOB_STORE_ID); scripts on a laptop have
// no Blob, so every reader falls back to the database when the store is unavailable.
import { gzipSync, gunzipSync } from "node:zlib";
import { nflWeek } from "./live.js";

export const STORE_PATH = "store/base.json.gz", PRIOR_PATH = "store/prior.json.gz", BOARD_PATH = "store/board.json.gz";
const blob = () => import("@vercel/blob");
const isMissing = (e) => /not\s*found|404|BlobNotFound/i.test(String(e?.message ?? e?.name ?? e));

// ---- files ----
export async function putJSON(path, value) {
  const { put } = await blob();
  const r = await put(path, gzipSync(Buffer.from(JSON.stringify(value))), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/gzip", cacheControlMaxAge: 0 });
  return { etag: r.etag ?? null, pathname: r.pathname };
}
// → { etag, value } | { unchanged: true } (etag matched) | null (no such file)
export async function getJSON(path, { etag = "" } = {}) {
  const { get } = await blob();
  let r;
  try { r = await get(path, { access: "private", useCache: false, ...(etag ? { ifNoneMatch: etag } : {}) }); }
  catch (e) { if (isMissing(e)) return null; throw e; }
  if (!r) return null;
  if (r.statusCode === 304) return { unchanged: true };
  const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
  return { etag: r.blob?.etag ?? "", value: JSON.parse(gunzipSync(buf).toString()) };
}

// ---- build from the database ----
export async function buildStore(db, now = Date.now()) {
  const accounts = (await db.query("select user_key, username, synced_at from dk_accounts")).rows.map((a) => ({ k: a.user_key, u: a.username, syncedAt: a.synced_at ? new Date(a.synced_at).toISOString() : null }));
  const ents = (await db.query(
    `select e.entry_id, e.user_key, e.contest_id, e.state, e.prizes, e.synced_at, c.name, c.contest_type, c.buy_in, c.entrants, c.draft_date, c.draft_state, c.picks_total,
            c.positions_paid pp, c.round, c.draft_group_id dgid, c.tournament_key, c.start_date, t.rounds
       from entries e join contests c on c.contest_id = e.contest_id left join tournaments t on t.tournament_key = upper(c.tournament_key)`)).rows;
  const entries = {}, contests = {}, pods = {}, draftables = {}, sleeper = {}, ladders = {};
  for (const e of ents) {
    const cid = Number(e.contest_id);
    const fromRounds = e.rounds?.[String(e.round ?? 1)]?.adv;
    const pp = e.pp ?? (fromRounds != null ? fromRounds : (e.round ?? 1) === 1 && e.entrants === 12 ? 2 : null);
    entries[e.entry_id] = { cid, dgid: e.dgid, pp, u: e.user_key, state: e.state, prizes: e.prizes == null ? null : Number(e.prizes), syncedAt: e.synced_at ? new Date(e.synced_at).toISOString() : null };
    contests[cid] ??= { name: e.name, type: e.contest_type, buyIn: e.buy_in == null ? null : Number(e.buy_in), entrants: e.entrants, draftDate: e.draft_date ? new Date(e.draft_date).toISOString() : null,
      draftState: e.draft_state, picksTotal: e.picks_total, pp, round: e.round ?? 1, dgid: e.dgid, tkey: e.tournament_key ? String(e.tournament_key).toUpperCase() : null, start: e.start_date ? new Date(e.start_date).toISOString() : null };
    pods[cid] ??= { dgid: e.dgid, from: e.start_date ? nflWeek(new Date(e.start_date).toISOString()) ?? 1 : 1, rosters: {} };
  }
  const cids = Object.keys(pods).map(Number);
  const byDg = new Map();
  if (cids.length) {
    const teams = (await db.query(`select contest_id, username, seat, entry_key, draftable_ids, pick_numbers from pod_teams where contest_id = any($1::bigint[])`, [cids])).rows;
    teams.forEach((t, i) => {
      const pod = pods[t.contest_id]; if (!pod) return;
      pod.rosters[t.entry_key ?? t.seat ?? 100 + i] = { u: t.username, d: t.draftable_ids, s: t.seat, pk: t.pick_numbers ?? null };
      if (!byDg.has(pod.dgid)) byDg.set(pod.dgid, new Set());
      for (const did of t.draftable_ids) byDg.get(pod.dgid).add(did);
    });
  }
  const pids = new Set();
  for (const [dgid, dids] of byDg) {
    const rows = (await db.query(`select draftable_id did, player_id pid, name, position pos, team, adp from draftables where draft_group_id = $1 and draftable_id = any($2::int[])`, [dgid, [...dids]])).rows;
    const dg = (draftables[dgid] = {});
    for (const r of rows) { dg[r.did] = [r.pid, r.name, r.pos, r.team, r.adp == null ? null : Number(r.adp)]; if (r.pid != null) pids.add(r.pid); }
  }
  if (pids.size) for (const r of (await db.query(`select player_id, sleeper_id, team from sleeper_map where player_id = any($1::int[])`, [[...pids]])).rows) sleeper[r.player_id] = [r.sleeper_id, r.team];
  for (const r of (await db.query(`select tournament_key, ladder, top_prize from tournaments where ladder is not null`)).rows) ladders[r.tournament_key] = { ladder: r.ladder, top: r.top_prize == null ? null : Number(r.top_prize) };
  return { v: 1, at: new Date(now).toISOString(), accounts, entries, contests, pods, draftables, sleeper, ladders };
}
// build + write; → { at, accounts, entries, pods, bytes }
export async function publishStore(db, now = Date.now()) {
  const store = await buildStore(db, now);
  const gz = gzipSync(Buffer.from(JSON.stringify(store)));
  const { put } = await blob();
  await put(STORE_PATH, gz, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/gzip", cacheControlMaxAge: 0 });
  loaded = null; // this instance re-reads on the next request
  return { at: store.at, accounts: store.accounts.length, entries: Object.keys(store.entries).length, pods: Object.keys(store.pods).length, bytes: gz.length };
}

// ---- read ----  this instance keeps the file in memory and asks Blob (by ETag, a few bytes when unchanged) at most
// every CHECK_MS. → the store, or null when Blob is unreachable / empty (callers then read the database)
const CHECK_MS = 15e3;
let loaded = null; // { etag, store, checkedAt }
export const _forgetStore = () => { loaded = null; };
export async function loadStore(now = Date.now()) {
  if (loaded && now - loaded.checkedAt < CHECK_MS) return loaded.store;
  try {
    const r = await getJSON(STORE_PATH, { etag: loaded?.etag ?? "" });
    if (r === null) return null;
    if (r.unchanged) { loaded.checkedAt = now; return loaded.store; }
    loaded = { etag: r.etag, store: r.value, checkedAt: now };
    return loaded.store;
  } catch (e) {
    if (loaded) { loaded.checkedAt = now; return loaded.store; } // Blob hiccup: keep serving what we have
    return null;
  }
}
export const storeEtag = () => loaded?.etag ?? null;

// ---- views of the store ----
// the scoring "base" (lib/base.js shape) for some accounts (null = everyone) and optionally only some entry ids
export function baseOf(store, userKeys = null, only = null) {
  const keys = userKeys ? new Set(userKeys) : null, ids = only ? new Set(only.map(String)) : null;
  const entries = {}, contests = {}, pods = {};
  for (const [id, e] of Object.entries(store.entries)) {
    if ((keys && !keys.has(e.u)) || (ids && !ids.has(id))) continue;
    const c = store.contests[e.cid] ?? {};
    entries[id] = { cid: e.cid, dgid: e.dgid, pp: e.pp };
    contests[id] = { cid: e.cid, dgid: e.dgid, pp: e.pp, entrants: c.entrants ?? null, state: e.state, prizes: e.prizes, blobRank: null, blobPoints: null };
    pods[e.cid] ??= store.pods[e.cid];
  }
  return { entries, contests, draftables: store.draftables, pods, sleeper: store.sleeper, partners: {}, prior: {}, ownerHidden: [] };
}
// who owns a team → { account: { user_key, username }, entryId } | null   (lib/accounts.js resolveEntry)
export function entryOwner(store, entry) {
  const id = String(entry ?? "").trim();
  const e = /^[0-9]{1,18}$/.test(id) ? store.entries[id] : null; if (!e) return null;
  const a = store.accounts.find((x) => x.k === e.u); if (!a) return null;
  return { account: { user_key: a.k, username: a.u }, entryId: id };
}
// the team pop-up's boot data (lib/portfolio.js userPortfolio shape) for one account's teams (only = entry ids)
export function portfolioOf(store, userKeys, only = null) {
  const keys = new Set(userKeys), ids = only ? new Set(only.map(String)) : null;
  const ents = Object.entries(store.entries).filter(([id, e]) => keys.has(e.u) && (!ids || ids.has(id)))
    .map(([id, e]) => [id, e, store.contests[e.cid] ?? {}, store.pods[e.cid]?.rosters?.[id] ?? null])
    .sort((a, b) => String(a[2].draftDate ?? "").localeCompare(String(b[2].draftDate ?? "")));
  const drafts = [], picks = [], players = {}, groups = new Set();
  let syncedAt = null;
  for (const [id, e, c, ro] of ents) {
    const size = c.entrants ?? 12, made = ro?.d?.length ?? 0;
    groups.add(e.dgid);
    drafts.push({ id: Number(id), contestId: e.cid, name: c.name, type: c.type, buyIn: c.buyIn, size, slot: ro?.s ?? null, date: c.draftDate, state: c.draftState,
      picksMade: made, picksTotal: c.picksTotal ?? made, pp: c.pp ?? ((c.round ?? 1) === 1 && size === 12 ? 2 : null), ent: size, section: e.state });
    (ro?.d ?? []).forEach((did, i) => {
      const d = store.draftables[e.dgid]?.[did]; if (!d || d[0] == null) return;
      const pk = ro.pk?.[i] ?? i + 1, r = Math.ceil(pk / size);
      players[d[0]] ??= { n: d[1], p: d[2], t: d[3], dk: null };
      picks.push({ e: Number(id), pl: d[0], pk, r, pr: pk - (r - 1) * size, adp: d[4] ?? null, ts: null });
    });
    if (e.syncedAt && (!syncedAt || e.syncedAt > syncedAt)) syncedAt = e.syncedAt;
  }
  return { pool: [], season: { status: {}, scores: {}, manual: {}, shares: {}, history: {}, pods: {}, scoresSyncedAt: null, week: null }, generatedAt: new Date().toISOString(),
    meta: { sourceFile: "dkbbdb", syncedAt, syncErrors: 0, draftCount: drafts.length, pickCount: picks.length, playerCount: Object.keys(players).length, unnamedPlayers: 0, draftGroups: [...groups].join(", ") },
    drafts, players, picks };
}
// what the board run needs (lib/leaderboard.js rosters()): accounts, the whole base, and per-entry facts
export function boardInputs(store) {
  const accounts = store.accounts.map((a) => ({ user_key: a.k, username: a.u }));
  const meta = new Map();
  for (const [id, e] of Object.entries(store.entries)) {
    const c = store.contests[e.cid] ?? {}, ro = store.pods[e.cid]?.rosters?.[id] ?? null;
    meta.set(id, { entry_id: id, user_key: e.u, prizes: e.prizes, name: c.name, buy_in: c.buyIn, draft_date: c.draftDate, tournament_key: c.tkey, round: c.round ?? 1, draftable_ids: ro?.d ?? [], pick_numbers: ro?.pk ?? null });
  }
  const ladders = new Map(Object.entries(store.ladders ?? {}));
  return { accounts, base: baseOf(store), meta, ladders };
}
