// What the extension uploads, and how it lands in the site's files (lib/store.js layout).
//
// POST /api/sync body (chunked by the extension; no sign-in — the DraftKings account is read from the drafts):
//   drafts:     [{ contest, users, board, lineup, startTime, state }]
//                 contest   one entry of /mycontests' `var contests` (+ section: upcoming | live | history)
//                 users     [[userKey, displayName], …]                       the 12 drafters
//                 board     [[userIdx, draftableId, playerId, round, pickInRound, overall], …]  all 240 slots;
//                           draftableId/playerId null = pick not made yet (draft in progress)
//                 lineup    [draftableId, …]   MY players — identifies which drafter I am
//                 A draft with only { contest } (no board) refreshes that entry's status — used for pods
//                 /api/known reported as complete, so finished drafts are never fetched twice.
//   draftables: { dgid: [[draftableId, playerId, name, pos, team], …] }        DK's public player list (optional:
//                           the server fetches it itself when it can)
//   adp:        { dgid: { playerId: averageDraftPosition } }                    from draftStatus.playerPool (optional)
//
// One draftStatus call returns the whole pod, so a user's sync also fills in their 11 opponents. Everything an
// account uploads goes into ITS file (data/accounts/<userKey>.json.gz); the store is assembled from those after
// the last chunk (api/sync.js → publishStore).
import { SEASON_WEEK1_TUESDAY_UTC } from "./live.js";
import { LIMITS, checkDraft, knownShare, logUpload, recentUse } from "./guard.js";
import { getGz, updateGz } from "./files.js";
import { rcRead, rcMark, rcDrop } from "./rcache.js";
import { PATHS, loadStore, addToIndex, readIndex } from "./store.js";

// dkbbdb is a SEASON leaderboard: only contests that start in NFL week 1 are kept, so every team on it has
// played the same weeks. Anything starting later (weekly / mid-season best ball) is skipped at the door.
export const WEEK1_ENDS = SEASON_WEEK1_TUESDAY_UTC + 7 * 864e5;
// (later ROUNDS of a week-1 tournament start in December — those are the same contest, not a late start)
export const startsInWeek1 = (c) => { const t = Date.parse(c?.ContestStartDate ?? ""); return !isFinite(t) || t < WEEK1_ENDS || (c?.MegaContestRoundNumber ?? 1) > 1; };

const nz = (v) => (typeof v === "number" && v !== 0 ? v : null); // DK uses 0 for "not yet"
const iso = (v) => { const t = Date.parse(v ?? ""); return isFinite(t) ? new Date(t).toISOString() : null; };

// raw draftStatus (as DraftKings returns it) → the compact upload form
export function compactStatus(ds) {
  const users = (ds.users ?? []).map((u) => [u.userKey, u.displayName ?? null]);
  const idx = new Map(users.map((u, i) => [u[0], i]));
  const board = [];
  for (const p of ds.draftBoard ?? []) {
    if (!idx.has(p.userKey)) { idx.set(p.userKey, users.length); users.push([p.userKey, null]); }
    board.push([idx.get(p.userKey), p.draftableId ?? null, p.playerId ?? null, p.roundNumber, p.selectionNumber, p.overallSelectionNumber]);
  }
  return { users, board, lineup: ds.lineup ?? [], startTime: ds.draftStartTime ?? null, state: ds.draftLifecycleState ?? null };
}

// one uploaded draft → { contest, teams, entry, me } or { error } / { skipped } / { statusOnly }
export function readDraft(d) {
  const c = d.contest ?? {};
  const contestId = c.ContestId, entryId = c.UserContestId;
  if (contestId == null || entryId == null) return { error: "contest without ContestId / UserContestId" };
  if (!startsInWeek1(c) || c.BuyInAmount === 0) return { skipped: true }; // late starts and free contests (buy-in $0) are not tracked
  // no board = a pod dkbbdb already has in full: only the entry's status (section, prizes) is refreshed
  if (!Array.isArray(d.board)) return { statusOnly: { entry_id: String(entryId), state: c.section ?? null, prizes: nz(c.PrizesWon) } };
  const users = d.users ?? [], lineup = new Set(d.lineup ?? []);
  const teams = new Map(); // userIdx → team
  const owns = new Map();
  for (const [u, did, pid, round, sel, overall] of [...(d.board ?? [])].sort((a, b) => a[5] - b[5])) {
    if (!users[u]) continue;
    let t = teams.get(u);
    if (!t) teams.set(u, t = { user_key: users[u][0], username: users[u][1], seat: null, slots: 0, draftable_ids: [], pick_numbers: [] });
    t.slots++;
    if (round === 1) t.seat = sel; // draft slot = where he picked in round 1
    if (did == null || pid == null) continue; // pre-allocated slot, pick not made yet
    t.draftable_ids.push(did); t.pick_numbers.push(overall);
    if (lineup.has(did)) owns.set(u, (owns.get(u) ?? 0) + 1);
  }
  const mine = [...owns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (mine == null) return { error: `entry ${entryId}: could not tell which drafter is you (empty lineup)` };
  const me = teams.get(mine);
  const entrants = c.NumberOfEntrants ?? c.MaxNumberPlayers ?? teams.size;
  return {
    me,
    contest: { cid: String(contestId), name: c.ContestName ?? null, type: c.GameType?.name ?? null, tkey: c.TournamentKey ? String(c.TournamentKey).toUpperCase() : null,
      mega: c.MegaContestId ?? null, round: c.MegaContestRoundNumber ?? null, dgid: c.DraftGroupId ?? c.ActiveDraftGroupId ?? c.StartingDraftGroupId ?? null,
      buyIn: c.BuyInAmount ?? null, prizePool: c.TotalPrizePool ?? null, entrants, pp: nz(c.PositionsPaid), draftState: d.state ?? null,
      draftDate: iso(d.startTime), start: iso(c.ContestStartDate), picksTotal: me.slots },
    teams: [...teams.values()].map((t) => ({ user_key: t.user_key, username: t.username, seat: t.seat, entry_key: t === me ? String(entryId) : null, draftable_ids: t.draftable_ids, pick_numbers: t.pick_numbers })),
    entry: { entry_id: String(entryId), user_key: me.user_key, cid: String(contestId), state: c.section ?? null, prizes: nz(c.PrizesWon) },
  };
}

const uniqBy = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];
const STATES = new Set(["upcoming", "live", "history"]);

// DraftKings' public player list for a draft group (no login) → [[draftableId, playerId, name, pos, team], …]
export async function fetchDraftables(dgid) {
  const r = await fetch(`https://api.draftkings.com/draftgroups/v1/draftgroups/${dgid}/draftables?format=json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw new Error(`draftables ${dgid} → HTTP ${r.status}`);
  const j = await r.json();
  return (j.draftables ?? []).map((d) => [d.draftableId, d.playerId ?? null, d.displayName ?? null, d.position ?? null, d.teamAbbreviation ?? null]);
}

// Player lists are shared by every page, so an upload may never CHANGE one: players are only ever added,
// DraftKings' own public feed is preferred, and the uploaded copy is the fallback when the server cannot reach
// that feed. Uploaded ADP only fills blanks. Group file: { dgid, players: { did: [pid, name, pos, team, adp] }, source, at }
async function addDraftables(dgid, list, source) {
  const rows = uniqBy((list ?? []).filter((r) => Array.isArray(r) && Number.isSafeInteger(r[0]) && r[0] > 0), (r) => r[0]).slice(0, 6000);
  if (!rows.length) return 0;
  await addToIndex("groups", Number(dgid));
  await updateGz(PATHS.group(dgid), (g) => {
    g ??= { dgid: Number(dgid), players: {}, source, at: new Date().toISOString() };
    for (const [did, pid, name, pos, team] of rows) g.players[did] ??= [Number.isSafeInteger(pid) ? pid : null, name == null ? null : String(name).slice(0, 80), pos == null ? null : String(pos).slice(0, 8), team == null ? null : String(team).slice(0, 8), null];
    return g;
  });
  return rows.length;
}
async function ensureDraftables(dgids, payload, { refresh = false, trusted = false } = {}) {
  const out = {};
  for (const dgid of dgids) {
    const have = !!(await getGz(PATHS.group(dgid)));
    if (have && !refresh) continue;
    const uploaded = payload.draftables?.[dgid];
    try { if (trusted && uploaded) throw new Error("trusted upload"); await addDraftables(dgid, await fetchDraftables(dgid), "dk"); out[dgid] = "dk"; }
    catch { out[dgid] = uploaded && (await addDraftables(dgid, uploaded, "upload")) ? "upload" : have ? "kept" : "missing"; }
  }
  for (const [dgid, adp] of Object.entries(payload.adp ?? {})) {
    if (!/^[0-9]{1,9}$/.test(dgid)) continue;
    const byPid = new Map(Object.entries(adp ?? {}).slice(0, 6000).map(([pid, v]) => [Number(pid), Number(v)]).filter(([pid, v]) => Number.isSafeInteger(pid) && v > 0 && v < 2000));
    if (!byPid.size) continue;
    await updateGz(PATHS.group(dgid), (g) => { if (!g) return undefined; let changed = false;
      for (const p of Object.values(g.players)) if (p[4] == null && p[0] != null && byPid.has(p[0])) { p[4] = byPid.get(p[0]); changed = true; }
      return changed ? g : undefined; });
  }
  return out;
}
const groupKnown = async (dgid, wanted) => { const g = (await getGz(PATHS.group(dgid)))?.value; return new Set(wanted.filter((did) => g?.players?.[did])); };

const EMPTY = { accounts: [], entries: {}, contests: {}, pods: {}, ladders: {}, groups: [] };

// one writer per account file at a time: a marker in the runtime cache, waited for up to ~10 s (two browsers syncing
// the same DraftKings account at once would otherwise each write the file from their own read of it)
const LOCK_S = 30;
async function withAccountLock(userKey, fn) {
  const key = `lock:acct:${userKey}`;
  for (let i = 0; i < 40; i++) {
    const l = await rcRead(key);
    if (!l || Date.now() - Number(l.at) > LOCK_S * 1000) {
      await rcMark(key, { at: Date.now() }, LOCK_S);
      try { return await fn(); } finally { await rcDrop(key); }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn(); // the other writer is stuck: go ahead rather than fail the upload
}

// → { usernames, drafts, refreshed, skipped, rejected, pods, teams, playerLists, errors } — or { limited: "reason" } (HTTP 429)
// opts.sender: hashed address of the uploader (lib/guard.js) — rate limits + the upload log apply when given
// opts.trusted: a local import (no limits, uploaded player lists used as they are)
export async function ingestDrafts(payload, { sender = null, ext = null, trusted = false, last = true } = {}) {
  const errors = [], now = new Date().toISOString();
  const use = sender && !trusted ? await recentUse(sender) : null;
  if (use && (use.uploads >= LIMITS.uploadsPerHour || use.drafts >= LIMITS.draftsPerHour))
    return { limited: "Too many syncs from this connection in the last hour — try again later." };

  // 1. read + plausibility
  let skipped = 0, rejected = 0; // skipped = late start / free; rejected = failed a check
  const full = [], statusOnly = [];
  const reject = (why) => { rejected++; if (errors.length < 20) errors.push(why); };
  for (const d of payload.drafts ?? []) {
    const r = readDraft(d);
    if (r.error) { reject(r.error); continue; }
    if (r.skipped) { skipped++; continue; }
    if (r.statusOnly) {
      const s = r.statusOnly;
      if (!/^[0-9]{1,18}$/.test(s.entry_id) || (s.state != null && !STATES.has(s.state)) || (s.prizes != null && !(s.prizes >= 0 && s.prizes < 1e8))) { reject(`entry ${s.entry_id}: implausible status`); continue; }
      statusOnly.push(s); continue;
    }
    const why = trusted ? null : checkDraft(d);
    if (why) { reject(`${d.contest?.ContestName ?? d.contest?.ContestId}: ${why}`); continue; }
    full.push({ d, r });
  }

  // 2. every drafted player must exist in DraftKings' player list for that draft group
  const dgids = [...new Set(full.map((x) => x.r.contest.dgid).filter((g) => Number.isSafeInteger(g) && g > 0))];
  const lists = await ensureDraftables(dgids, payload, { trusted });
  const accepted = [];
  for (const dgid of [...dgids, null]) {
    const group = full.filter((x) => (x.r.contest.dgid ?? null) === dgid);
    if (!group.length) continue;
    if (dgid == null) { for (const x of group) reject(`${x.r.contest.name ?? x.r.contest.cid}: no draft group`); continue; }
    const wanted = [...new Set(group.flatMap((x) => x.d.board.map((p) => p[1]).filter((v) => v != null)))];
    let known = await groupKnown(dgid, wanted);
    // players added to the draft group since the list was stored: refresh it from DraftKings once, then judge
    if (!trusted && known.size < wanted.length && lists[dgid] == null) { await ensureDraftables([dgid], payload, { refresh: true }); known = await groupKnown(dgid, wanted); }
    for (const x of group) {
      if (!trusted && knownShare(x.d, known) < 0.9) reject(`${x.r.contest.name ?? x.r.contest.cid}: players that are not in DraftKings' list for this contest`);
      else accepted.push(x.r);
    }
  }

  // 3. who is syncing: the first DraftKings account to sync a username owns it (no impersonation), a sender may
  //    only bring a handful of accounts a day, and an account has a ceiling on stored teams
  const store = (await loadStore().catch(() => null)) ?? EMPTY;
  const accounts = new Map(accepted.map((r) => [r.me.user_key, r.me.username]));
  const files = new Map(); // userKey → its account file (null = new)
  for (const [userKey, username] of [...accounts]) {
    const drop = (why) => { accounts.delete(userKey); const n = accepted.filter((r) => r.me.user_key === userKey).length; rejected += n; errors.push(why); };
    if (!username) { drop("could not read the DraftKings username from the draft"); continue; }
    const taken = store.accounts.some((a) => a.k !== userKey && String(a.u ?? "").toLowerCase() === username.toLowerCase());
    if (taken) { drop(`the username ${username} is already registered on dkbbdb from a different DraftKings account`); continue; }
    if (use && !use.accounts.has(userKey) && new Set([...use.accounts, userKey]).size > LIMITS.accountsPerDay) { drop("Too many different DraftKings accounts from this connection today — try again tomorrow."); continue; }
    if (use) use.accounts.add(userKey);
    const file = (await getGz(PATHS.account(userKey)))?.value ?? null;
    files.set(userKey, file);
    if (!trusted) {
      const ids = new Set(accepted.filter((r) => r.me.user_key === userKey).map((r) => r.entry.entry_id));
      const n = Object.keys(file?.entries ?? {}).filter((id) => !ids.has(id)).length;
      if (n + ids.size > LIMITS.entriesPerAccount) { drop(`${username}: more than ${LIMITS.entriesPerAccount} teams for one account`); continue; }
    }
  }
  const ok = accepted.filter((r) => accounts.has(r.me.user_key));
  const contests = uniqBy(ok.map((r) => r.contest), (c) => c.cid);
  const teams = uniqBy(ok.flatMap((r) => r.teams.map((t) => ({ ...t, cid: r.contest.cid }))), (t) => `${t.cid}|${t.user_key}`);
  const entries = uniqBy(ok.map((r) => r.entry), (e) => e.entry_id);

  // 4. write, one file per syncing account. Nothing already stored can be changed by an upload, only completed:
  //    a contest keeps its name / size, a team keeps its username, and a roster is only replaced by one with MORE
  //    picks (a draft that was still running last time) — rosters never change after a Best Ball draft. An entry
  //    never changes hands: one another account's file already holds is left alone.
  for (const [userKey, username] of accounts) {
    const mine = ok.filter((r) => r.me.user_key === userKey);
    if (!files.get(userKey)) await addToIndex("accounts", userKey);
    await withAccountLock(userKey, () => updateGz(PATHS.account(userKey), (a) => {
      a ??= { k: userKey, u: username, createdAt: now, entries: {}, contests: {}, pods: {} };
      a.u ??= username; a.syncedAt = now;
      for (const r of mine) {
        const c = r.contest, cur = a.contests[c.cid];
        a.contests[c.cid] = !cur ? { ...c } : { ...cur, dgid: cur.dgid ?? c.dgid, pp: cur.pp ?? c.pp /* reads 0 once live: keep the preseason value */, draftState: c.draftState,
          draftDate: cur.draftDate ?? c.draftDate, picksTotal: Math.max(cur.picksTotal ?? 0, c.picksTotal ?? 0) || null };
        const pod = (a.pods[c.cid] ??= { rosters: {} });
        for (const t of r.teams) {
          const old = pod.rosters[t.user_key];
          const longer = !old || t.draftable_ids.length > (old.d?.length ?? 0);
          pod.rosters[t.user_key] = { u: old?.u ?? t.username, s: old?.s ?? t.seat, ek: old?.ek ?? t.entry_key, d: longer ? t.draftable_ids : old.d, pk: longer ? t.pick_numbers : old.pk };
        }
        const e = r.entry, owner = store.entries[e.entry_id]?.u;
        if (owner && owner !== userKey) continue;
        const old = a.entries[e.entry_id];
        a.entries[e.entry_id] = { cid: e.cid, state: e.state ?? old?.state ?? null, prizes: e.prizes ?? old?.prizes ?? null, syncedAt: now };
      }
      return a;
    }));
  }
  let refreshed = 0;
  if (statusOnly.length) {
    const byOwner = new Map();
    for (const s of uniqBy(statusOnly, (e) => e.entry_id)) { const owner = store.entries[s.entry_id]?.u ?? (accounts.size === 1 ? [...accounts.keys()][0] : null); if (owner) (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)).push(s); }
    for (const [owner, rows] of byOwner) {
      await withAccountLock(owner, () => updateGz(PATHS.account(owner), (a) => { if (!a) return undefined; let n = 0;
        for (const s of rows) { const e = a.entries[s.entry_id]; if (!e) continue; e.state = s.state ?? e.state; e.prizes = s.prizes ?? e.prizes; e.syncedAt = now; n++; }
        refreshed += n; a.syncedAt = now; return n ? a : undefined; }));
    }
  }

  const usernames = [...accounts.values()].filter(Boolean);
  const out = { usernames, drafts: entries.length, refreshed, skipped, rejected, pods: contests.length, teams: teams.length, playerLists: lists, errors };
  if (sender) await logUpload({ sender, ext, userKeys: [...accounts.keys()], usernames, drafts: out.drafts, refreshed, skipped, rejected, note: errors.slice(0, 3).join(" | ") || null }, { persist: last }).catch(() => {});
  return out;
}

// what the extension may skip: of the entry ids it is about to sync, those whose whole pod is already
// drafted and stored; plus the draft groups whose player list is on file, and the usernames they belong to
export async function knownEntries(entryIds) {
  const ids = (entryIds ?? []).map(String).filter((x) => /^[0-9]{1,18}$/.test(x)).slice(0, 5000);
  const store = (await loadStore().catch(() => null)) ?? EMPTY;
  const complete = [], usernames = new Set(), need = new Map();
  for (const id of ids) {
    const e = store.entries[id]; if (!e) continue;
    const c = store.contests[e.cid] ?? {}, pod = store.pods[e.cid];
    const rosters = Object.values(pod?.rosters ?? {});
    if (c.picksTotal != null && rosters.length >= (c.entrants ?? 12) && rosters.every((r) => (r.d?.length ?? 0) >= c.picksTotal)) {
      complete.push(id);
      const a = store.accounts.find((x) => x.k === e.u); if (a?.u) usernames.add(a.u);
    }
    // tournaments of these entries with no payout table yet (the panel links to their pages)
    if (c.tkey && c.buyIn > 0 && !store.ladders?.[c.tkey]) { const t = need.get(c.tkey) ?? { key: c.tkey, name: c.name, teams: 0 }; t.teams++; need.set(c.tkey, t); }
  }
  const draftGroups = (await readIndex()).groups ?? [];
  return { startsBefore: new Date(WEEK1_ENDS).toISOString(), complete, usernames: [...usernames], draftGroups, ladders: Object.keys(store.ladders ?? {}),
    needLadders: [...need.values()].sort((a, b) => b.teams - a.teams) };
}
