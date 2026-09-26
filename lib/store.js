// dkbbdb's data is files (lib/files.js) — no database. What the extension uploads lands in small files, and
// everything the pages need is assembled from them into ONE file, the store, which scoring, the leaderboard and
// the team pop-up read. Like deploy/data/base.json on the owner's own site, but for everyone.
//
// Uploaded (lib/ingest.js, lib/payouts.js, lib/sleeper.js write these):
//   data/accounts/<userKey>.json.gz  one synced DraftKings account: its entries, the contests they are in, and every
//                                    roster of those leagues (opponents included)
//   data/groups/<dgid>.json.gz       DraftKings' player list for a draft group (+ ADP)
//   data/sleeper.json.gz             DK player id → Sleeper id (stats feed)         data/tournaments.json.gz  payout ladders + captures
//   data/uploads/<sender>.json.gz    upload log per sender (rate limits, admin)     data/history.json.gz      rank per team per day
// Assembled (publishStore):
//   store/base.json.gz   { v, at, accounts: [{ k, u, syncedAt }], entries: { id: { cid, dgid, pp, u, state, prizes, syncedAt } },
//                          contests: { cid: { name, type, buyIn, entrants, draftDate, draftState, picksTotal, pp, round, dgid, tkey, start } },
//                          pods: { cid: { dgid, from, rosters: { key: { u, d: [did], s, pk } } } }, draftables: { dgid: { did: [pid, name, pos, team, adp] } },
//                          sleeper: { pid: [sleeperId, team] }, ladders: { tkey: { ladder, top } }, groups: [dgid] }
// Scoring side files: store/prior.json.gz (finished-week totals, lib/prior.js), store/board.json.gz (the scored board).
import { getGz, putGz, listFiles } from "./files.js";
import { nflWeek } from "./live.js";

export const PATHS = {
  base: "store/base.json.gz", prior: "store/prior.json.gz", board: "store/board.json.gz",
  history: "data/history.json.gz", sleeper: "data/sleeper.json.gz", tournaments: "data/tournaments.json.gz",
  accounts: "data/accounts/", account: (k) => `data/accounts/${k}.json.gz`,
  groups: "data/groups/", group: (dgid) => `data/groups/${dgid}.json.gz`,
  uploads: "data/uploads/", uploadLog: (sender) => `data/uploads/${sender}.json.gz`,
};
export const STORE_PATH = PATHS.base, PRIOR_PATH = PATHS.prior, BOARD_PATH = PATHS.board;
export const putJSON = putGz, getJSON = getGz;

// ---- small readers with a per-instance cache keyed by the file's ETag ----
const cached = new Map(); // path → { etag, value, checkedAt }
export async function readCached(path, { maxAgeMs = 15e3, now = Date.now() } = {}) {
  const c = cached.get(path);
  if (c && now - c.checkedAt < maxAgeMs) return c.value;
  try {
    const r = await getGz(path, { etag: c?.etag ?? "" });
    if (r === null) { cached.set(path, { etag: "", value: null, checkedAt: now }); return null; }
    if (r.unchanged) { c.checkedAt = now; return c.value; }
    cached.set(path, { etag: r.etag, value: r.value, checkedAt: now });
    return r.value;
  } catch (e) { if (c) { c.checkedAt = now; return c.value; } throw e; }
}
export const _forgetCached = () => cached.clear();

// ---- assemble the store from the uploaded files ----
// Merge rules match what the database used to enforce: a contest keeps its first name / size, a roster is only
// replaced by one with MORE picks, an entry belongs to the account whose file holds it (first one wins on a clash).
const fileCache = new Map(); // account path → { version, value }  (publish re-reads only files that changed)
async function readVersioned(f) {
  const c = fileCache.get(f.pathname);
  if (c && c.version === f.version) return c.value;
  const r = await getGz(f.pathname); const value = r?.value ?? null;
  fileCache.set(f.pathname, { version: f.version, value });
  return value;
}
export async function buildStore(now = Date.now()) {
  const files = (await listFiles(PATHS.accounts)).filter((f) => f.pathname.endsWith(".json.gz"));
  const accounts = [], entries = {}, contests = {}, pods = {}, draftables = {}, sleeper = {}, ladders = {};
  const tournaments = (await getGz(PATHS.tournaments))?.value ?? {};
  for (const f of files) {
    const a = await readVersioned(f); if (!a?.k) continue;
    accounts.push({ k: a.k, u: a.u, createdAt: a.createdAt ?? null, syncedAt: a.syncedAt ?? null });
    for (const [cid, c] of Object.entries(a.contests ?? {})) {
      const have = contests[cid];
      if (!have) contests[cid] = { ...c };
      else contests[cid] = { ...have, dgid: have.dgid ?? c.dgid, pp: have.pp ?? c.pp, draftDate: have.draftDate ?? c.draftDate, draftState: c.draftState ?? have.draftState,
        picksTotal: Math.max(have.picksTotal ?? 0, c.picksTotal ?? 0) || null, tkey: have.tkey ?? c.tkey, round: have.round ?? c.round, name: have.name ?? c.name };
    }
    for (const [cid, p] of Object.entries(a.pods ?? {})) {
      const pod = (pods[cid] ??= { rosters: {} });
      for (const [uk, r] of Object.entries(p.rosters ?? {})) {
        const cur = pod.rosters[uk];
        if (!cur) pod.rosters[uk] = { ...r };
        else pod.rosters[uk] = { u: cur.u ?? r.u, s: cur.s ?? r.s, ek: cur.ek ?? r.ek, ...((r.d?.length ?? 0) > (cur.d?.length ?? 0) ? { d: r.d, pk: r.pk } : { d: cur.d, pk: cur.pk }) };
      }
    }
    for (const [id, e] of Object.entries(a.entries ?? {})) if (!entries[id]) entries[id] = { ...e, u: a.k };
  }
  // contests → the fields scoring needs (pp from the tournament's round structure when DraftKings reads 0)
  for (const [cid, c] of Object.entries(contests)) {
    const rounds = c.tkey ? tournaments[c.tkey]?.rounds : null;
    const fromRounds = rounds?.[String(c.round ?? 1)]?.adv;
    c.round = c.round ?? 1; // DraftKings leaves it empty on single-round contests
    c.pp = c.pp ?? (fromRounds != null ? fromRounds : c.round === 1 && c.entrants === 12 ? 2 : null);
    const pod = pods[cid];
    if (pod) { pod.dgid = c.dgid; pod.from = c.start ? nflWeek(c.start) ?? 1 : 1; }
  }
  for (const [id, e] of Object.entries(entries)) { const c = contests[e.cid] ?? {}; e.dgid = c.dgid ?? null; e.pp = c.pp ?? null; }
  // roster keys: the entry id for a synced account's own team, else the seat (base.js rule)
  const dids = new Map(); // dgid → Set(did)
  for (const [cid, pod] of Object.entries(pods)) {
    const byKey = {}; let i = 0;
    for (const r of Object.values(pod.rosters)) { byKey[r.ek ?? r.s ?? 100 + i++] = { u: r.u, d: r.d ?? [], s: r.s ?? null, pk: r.pk ?? null }; if (pod.dgid != null) { if (!dids.has(pod.dgid)) dids.set(pod.dgid, new Set()); for (const d of r.d ?? []) dids.get(pod.dgid).add(d); } }
    pods[cid] = { dgid: pod.dgid ?? null, from: pod.from ?? 1, rosters: byKey };
  }
  const pids = new Set(), groups = [];
  for (const [dgid, set] of dids) {
    const g = (await getGz(PATHS.group(dgid)))?.value; if (!g) continue;
    groups.push(Number(dgid));
    const dg = (draftables[dgid] = {});
    for (const did of set) { const p = g.players?.[did]; if (p) { dg[did] = p; if (p[0] != null) pids.add(p[0]); } }
  }
  const smap = (await getGz(PATHS.sleeper))?.value ?? {};
  for (const pid of pids) if (smap[pid]) sleeper[pid] = smap[pid];
  for (const [tkey, t] of Object.entries(tournaments)) if (t?.ladder) ladders[tkey] = { ladder: t.ladder, top: t.top ?? null };
  accounts.sort((a, b) => String(a.u).localeCompare(String(b.u)));
  return { v: 2, at: new Date(now).toISOString(), accounts, entries, contests, pods, draftables, sleeper, ladders, groups };
}
// assemble + write; → { at, accounts, entries, pods, bytes }
export async function publishStore(now = Date.now()) {
  const store = await buildStore(now);
  const { bytes } = await putGz(PATHS.base, store);
  loaded = null; // this instance re-reads on the next request
  return { at: store.at, accounts: store.accounts.length, entries: Object.keys(store.entries).length, pods: Object.keys(store.pods).length, bytes };
}

// ---- read ----  this instance keeps the store in memory and asks for it by ETag (a few bytes when unchanged)
// at most every CHECK_MS. → the store, or null when there is none yet
const CHECK_MS = 15e3;
let loaded = null; // { etag, store, checkedAt }
export const _forgetStore = () => { loaded = null; };
export async function loadStore(now = Date.now()) {
  if (loaded && now - loaded.checkedAt < CHECK_MS) return loaded.store;
  try {
    const r = await getGz(PATHS.base, { etag: loaded?.etag ?? "" });
    if (r === null) return loaded?.store ?? null;
    if (r.unchanged) { loaded.checkedAt = now; return loaded.store; }
    loaded = { etag: r.etag, store: r.value, checkedAt: now };
    return loaded.store;
  } catch (e) {
    if (loaded) { loaded.checkedAt = now; return loaded.store; } // a hiccup: keep serving what we have
    throw e;
  }
}
export const storeEtag = () => loaded?.etag ?? null;

// ---- views of the store ----
// the scoring "base" (lib/pubscore.js shape) for some accounts (null = everyone) and optionally only some entry ids
export function baseOf(store, userKeys = null, only = null) {
  const keys = userKeys ? new Set(userKeys) : null, ids = only ? new Set(only.map(String)) : null;
  const entries = {}, contests = {}, pods = {};
  for (const [id, e] of Object.entries(store.entries)) {
    if ((keys && !keys.has(e.u)) || (ids && !ids.has(id))) continue;
    const c = store.contests[e.cid] ?? {};
    entries[id] = { cid: Number(e.cid), dgid: e.dgid, pp: e.pp };
    contests[id] = { cid: Number(e.cid), dgid: e.dgid, pp: e.pp, entrants: c.entrants ?? null, state: e.state, prizes: e.prizes, blobRank: null, blobPoints: null };
    pods[e.cid] ??= store.pods[e.cid];
  }
  return { entries, contests, draftables: store.draftables, pods, sleeper: store.sleeper, partners: {}, prior: {}, ownerHidden: [] };
}
// who owns a team → { account: { user_key, username }, entryId } | null
export function entryOwner(store, entry) {
  const id = String(entry ?? "").trim();
  const e = /^[0-9]{1,18}$/.test(id) ? store.entries[id] : null; if (!e) return null;
  const a = store.accounts.find((x) => x.k === e.u); if (!a) return null;
  return { account: { user_key: a.k, username: a.u }, entryId: id };
}
// a synced account by username → { user_key, username, synced_at } | null
export function accountByName(store, name) {
  const s = String(name ?? "").split(",")[0].trim().toLowerCase();
  const a = s ? store.accounts.find((x) => String(x.u ?? "").toLowerCase() === s) : null;
  return a ? { user_key: a.k, username: a.u, synced_at: a.syncedAt } : null;
}
// the team pop-up's boot data (what public/boot.js expects) for one account's teams (only = entry ids)
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
    drafts.push({ id: Number(id), contestId: Number(e.cid), name: c.name, type: c.type, buyIn: c.buyIn, size, slot: ro?.s ?? null, date: c.draftDate, state: c.draftState,
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
// what the board run needs (lib/leaderboard.js): accounts, the whole base, per-entry facts, ladders
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
// every rostered player (for the stats mapping): [{ pid, name, pos, team }]
export function rosteredPlayers(store) {
  const out = new Map();
  for (const pod of Object.values(store.pods)) for (const r of Object.values(pod.rosters)) for (const did of r.d ?? []) {
    const p = store.draftables[pod.dgid]?.[did]; if (p && p[0] != null && !out.has(p[0])) out.set(p[0], { pid: p[0], name: p[1], pos: p[2], team: p[3] });
  }
  return [...out.values()];
}
