// What the extension uploads, and how it lands in Postgres.
//
// POST /api/sync body (chunked by the extension; no sign-in — the DraftKings account is read from the drafts):
//   drafts:     [{ contest, users, board, lineup, startTime, state }]
//                 contest   one entry of /mycontests' `var contests` (+ section: upcoming | live | history)
//                 users     [[userKey, displayName], …]                       the 12 drafters
//                 board     [[userIdx, draftableId, playerId, round, pickInRound, overall], …]  all 240 slots;
//                           draftableId/playerId null = pick not made yet (draft in progress)
//                 lineup    [draftableId, …]   MY players — identifies which drafter I am
//                 A draft with only { contest } (no board) refreshes that entry's status — used for pods
//                 GET /api/sync reported as complete, so finished drafts are never fetched twice.
//   draftables: { dgid: [[draftableId, playerId, name, pos, team], …] }        DK's public player list (optional:
//                           the server fetches it itself when it can)
//   adp:        { dgid: { playerId: averageDraftPosition } }                    from draftStatus.playerPool (optional)
//
// One draftStatus call returns the whole pod, so a user's sync also fills in their 11 opponents.
import { forgetBase } from "./base.js";
import { SEASON_WEEK1_TUESDAY_UTC } from "./live.js";
import { LIMITS, checkDraft, knownShare, logUpload, recentUse } from "./guard.js";

// dkbbdb is a SEASON leaderboard: only contests that start in NFL week 1 are kept, so every team on it has
// played the same weeks. Anything starting later (weekly / mid-season best ball) is skipped at the door.
export const WEEK1_ENDS = SEASON_WEEK1_TUESDAY_UTC + 7 * 864e5;
// (later ROUNDS of a week-1 tournament start in December — those are the same contest, not a late start)
export const startsInWeek1 = (c) => { const t = Date.parse(c?.ContestStartDate ?? ""); return !isFinite(t) || t < WEEK1_ENDS || (c?.MegaContestRoundNumber ?? 1) > 1; };

const nz = (v) => (typeof v === "number" && v !== 0 ? v : null); // DK uses 0 for "not yet"

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

// one uploaded draft → { contest row, teams, entry } or { error }
export function readDraft(d) {
  const c = d.contest ?? {};
  const contestId = c.ContestId, entryId = c.UserContestId;
  if (contestId == null || entryId == null) return { error: "contest without ContestId / UserContestId" };
  if (!startsInWeek1(c) || c.BuyInAmount === 0) return { skipped: true }; // late starts and free contests (buy-in $0) are not tracked
  // no board = a pod dkbbdb already has in full: only the entry's status (section, prizes) is refreshed
  if (!Array.isArray(d.board)) return { statusOnly: { entry_id: entryId, state: c.section ?? null, prizes: nz(c.PrizesWon) } };
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
    contest: {
      contest_id: contestId, name: c.ContestName ?? null, contest_type: c.GameType?.name ?? null,
      tournament_key: c.TournamentKey ?? null, mega_contest_id: c.MegaContestId ?? null, round: c.MegaContestRoundNumber ?? null,
      draft_group_id: c.DraftGroupId ?? c.ActiveDraftGroupId ?? c.StartingDraftGroupId ?? null,
      buy_in: c.BuyInAmount ?? null, prize_pool: c.TotalPrizePool ?? null, entrants, positions_paid: nz(c.PositionsPaid),
      draft_state: d.state ?? null, draft_date: d.startTime ?? null, start_date: c.ContestStartDate ?? null, picks_total: me.slots,
    },
    teams: [...teams.values()].map((t) => ({ contest_id: contestId, user_key: t.user_key, username: t.username, seat: t.seat,
      entry_key: t === me ? entryId : null, draftable_ids: t.draftable_ids, pick_numbers: t.pick_numbers })),
    entry: { entry_id: entryId, user_key: me.user_key, contest_id: contestId, state: c.section ?? null, prizes: nz(c.PrizesWon) },
  };
}

const uniqBy = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];
const J = (rows) => JSON.stringify(rows);
const STATES = new Set(["upcoming", "live", "history"]);

// DraftKings' public player list for a draft group (no login) → [[draftableId, playerId, name, pos, team], …]
export async function fetchDraftables(dgid) {
  const r = await fetch(`https://api.draftkings.com/draftgroups/v1/draftgroups/${dgid}/draftables?format=json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw new Error(`draftables ${dgid} → HTTP ${r.status}`);
  const j = await r.json();
  return (j.draftables ?? []).map((d) => [d.draftableId, d.playerId ?? null, d.displayName ?? null, d.position ?? null, d.teamAbbreviation ?? null]);
}

// Player lists are shared by every page, so an upload may never CHANGE one: rows are only ever added
// (on conflict do nothing), DraftKings' own public feed is preferred, and the uploaded copy is the fallback
// when the server cannot reach that feed. Uploaded ADP only fills blanks. → { dgid: "dk" | "upload" | "missing" }
async function addDraftables(db, dgid, list) {
  const rows = uniqBy((list ?? []).filter((r) => Array.isArray(r) && Number.isSafeInteger(r[0]) && r[0] > 0), (r) => r[0]).slice(0, 6000)
    .map(([did, pid, name, pos, team]) => ({ draftable_id: did, player_id: Number.isSafeInteger(pid) ? pid : null, name: name == null ? null : String(name).slice(0, 80),
      position: pos == null ? null : String(pos).slice(0, 8), team: team == null ? null : String(team).slice(0, 8) }));
  for (let i = 0; i < rows.length; i += 1000) {
    await db.query(
      `insert into draftables (draft_group_id, draftable_id, player_id, name, position, team)
       select $2::int, draftable_id, player_id, name, position, team
       from jsonb_to_recordset($1::jsonb) as x(draftable_id int, player_id int, name text, position text, team text)
       on conflict (draft_group_id, draftable_id) do nothing`, [J(rows.slice(i, i + 1000)), dgid]);
  }
  return rows.length;
}
async function ensureDraftables(db, dgids, payload, { refresh = false, trusted = false } = {}) {
  const out = {};
  for (const dgid of dgids) {
    const have = (await db.query("select 1 from draftables where draft_group_id = $1 limit 1", [dgid])).rows.length > 0;
    if (have && !refresh) continue;
    const uploaded = payload.draftables?.[dgid];
    try { if (trusted && uploaded) throw new Error("trusted upload"); await addDraftables(db, dgid, await fetchDraftables(dgid)); out[dgid] = "dk"; }
    catch { out[dgid] = uploaded && (await addDraftables(db, dgid, uploaded)) ? "upload" : have ? "kept" : "missing"; }
  }
  for (const [dgid, adp] of Object.entries(payload.adp ?? {})) {
    if (!/^[0-9]{1,9}$/.test(dgid)) continue;
    const rows = Object.entries(adp ?? {}).slice(0, 6000).map(([pid, v]) => ({ player_id: Number(pid), adp: Number(v) }))
      .filter((r) => Number.isSafeInteger(r.player_id) && r.adp > 0 && r.adp < 2000);
    if (rows.length) await db.query(
      `update draftables d set adp = x.adp from jsonb_to_recordset($1::jsonb) as x(player_id int, adp numeric)
        where d.draft_group_id = $2::int and d.player_id = x.player_id and d.adp is null`, [J(rows), dgid]);
  }
  return out;
}

// → { usernames, drafts, refreshed, skipped, rejected, pods, teams, errors } — or { limited: "reason" } (HTTP 429)
// opts.sender: hashed address of the uploader (lib/guard.js) — rate limits + the upload log apply when given
// opts.trusted: the local import script (no limits, uploaded player lists used as they are)
export async function ingestDrafts(db, payload, { sender = null, ext = null, trusted = false } = {}) {
  const errors = [];
  const use = sender && !trusted ? await recentUse(db, sender) : null;
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
      if (!/^[0-9]{1,18}$/.test(String(s.entry_id)) || (s.state != null && !STATES.has(s.state)) || (s.prizes != null && !(s.prizes >= 0 && s.prizes < 1e8))) { reject(`entry ${s.entry_id}: implausible status`); continue; }
      statusOnly.push(s); continue;
    }
    const why = trusted ? null : checkDraft(d);
    if (why) { reject(`${d.contest?.ContestName ?? d.contest?.ContestId}: ${why}`); continue; }
    full.push({ d, r });
  }

  // 2. every drafted player must exist in DraftKings' player list for that draft group
  const dgids = [...new Set(full.map((x) => x.r.contest.draft_group_id).filter((g) => Number.isSafeInteger(g) && g > 0))];
  const lists = await ensureDraftables(db, dgids, payload, { trusted });
  const accepted = [];
  for (const dgid of [...dgids, null]) {
    const group = full.filter((x) => (x.r.contest.draft_group_id ?? null) === dgid);
    if (!group.length) continue;
    if (dgid == null) { for (const x of group) reject(`${x.r.contest.name ?? x.r.contest.contest_id}: no draft group`); continue; }
    const wanted = [...new Set(group.flatMap((x) => x.d.board.map((p) => p[1]).filter((v) => v != null)))];
    const load = async () => new Set((await db.query(`select draftable_id from draftables where draft_group_id = $1 and draftable_id = any($2::int[])`, [dgid, wanted])).rows.map((r) => r.draftable_id));
    let known = await load();
    // players added to the draft group since the list was stored: refresh it from DraftKings once, then judge
    if (!trusted && known.size < wanted.length && lists[dgid] == null) { await ensureDraftables(db, [dgid], payload, { refresh: true }); known = await load(); }
    for (const x of group) {
      if (!trusted && knownShare(x.d, known) < 0.9) reject(`${x.r.contest.name ?? x.r.contest.contest_id}: players that are not in DraftKings' list for this contest`);
      else accepted.push(x.r);
    }
  }

  // 3. who is syncing: the first DraftKings account to sync a username owns it (no impersonation), a sender may
  //    only bring a handful of accounts a day, and an account has a ceiling on stored teams
  const accounts = new Map(accepted.map((r) => [r.me.user_key, r.me.username]));
  for (const [userKey, username] of [...accounts]) {
    const drop = (why) => { accounts.delete(userKey); const n = accepted.filter((r) => r.me.user_key === userKey).length; rejected += n; errors.push(why); };
    if (!username) { drop("could not read the DraftKings username from the draft"); continue; }
    const taken = (await db.query(`select 1 from dk_accounts where lower(username) = lower($1) and user_key <> $2 limit 1`, [username, userKey])).rows.length;
    if (taken) { drop(`the username ${username} is already registered on dkbbdb from a different DraftKings account`); continue; }
    if (use && !use.accounts.has(userKey) && new Set([...use.accounts, userKey]).size > LIMITS.accountsPerDay) { drop("Too many different DraftKings accounts from this connection today — try again tomorrow."); continue; }
    if (use) use.accounts.add(userKey);
    if (!trusted) {
      const ids = accepted.filter((r) => r.me.user_key === userKey).map((r) => r.entry.entry_id);
      const n = (await db.query(`select count(*)::int n from entries where user_key = $1 and entry_id <> all($2::bigint[])`, [userKey, ids])).rows[0].n;
      if (n + ids.length > LIMITS.entriesPerAccount) { drop(`${username}: more than ${LIMITS.entriesPerAccount} teams for one account`); continue; }
    }
  }
  const ok = accepted.filter((r) => accounts.has(r.me.user_key));
  const contests = uniqBy(ok.map((r) => r.contest), (c) => c.contest_id);
  const teams = uniqBy(ok.flatMap((r) => r.teams), (t) => `${t.contest_id}|${t.user_key}`);
  const entries = uniqBy(ok.map((r) => r.entry), (e) => e.entry_id);

  // 4. write. Nothing that is already stored can be changed by an upload, only completed: a contest keeps its
  //    name / size, a team keeps its username, and a roster is only replaced by one with MORE picks (a draft
  //    that was still running last time) — rosters never change after a Best Ball draft.
  for (const [userKey, username] of accounts) {
    await db.query(
      `insert into dk_accounts (user_key, username) values ($1,$2)
       on conflict (user_key) do update set username = coalesce(dk_accounts.username, excluded.username), synced_at = now()`, [userKey, username]);
  }
  if (ok.length) {
    await db.query(
      `insert into contests (contest_id, name, contest_type, tournament_key, mega_contest_id, round, draft_group_id, buy_in, prize_pool,
         entrants, positions_paid, draft_state, draft_date, start_date, picks_total)
       select contest_id, name, contest_type, tournament_key, mega_contest_id, round, draft_group_id, buy_in, prize_pool,
         entrants, positions_paid, draft_state, draft_date, start_date, picks_total
       from jsonb_to_recordset($1::jsonb) as x(contest_id bigint, name text, contest_type text, tournament_key text, mega_contest_id bigint,
         round int, draft_group_id int, buy_in numeric, prize_pool numeric, entrants int, positions_paid int, draft_state text,
         draft_date timestamptz, start_date timestamptz, picks_total int)
       on conflict (contest_id) do update set
         draft_group_id = coalesce(contests.draft_group_id, excluded.draft_group_id),
         positions_paid = coalesce(contests.positions_paid, excluded.positions_paid), -- reads 0 once live: keep the preseason value
         draft_state = excluded.draft_state, draft_date = coalesce(contests.draft_date, excluded.draft_date),
         picks_total = greatest(contests.picks_total, excluded.picks_total), updated_at = now()`, [J(contests)]);
    await db.query(
      `insert into pod_teams (contest_id, user_key, username, seat, entry_key, draftable_ids, pick_numbers)
       select * from jsonb_to_recordset($1::jsonb) as x(contest_id bigint, user_key text, username text, seat int, entry_key bigint,
         draftable_ids int[], pick_numbers int[])
       on conflict (contest_id, user_key) do update set
         entry_key = coalesce(pod_teams.entry_key, excluded.entry_key),
         username = coalesce(pod_teams.username, excluded.username),
         draftable_ids = case when cardinality(excluded.draftable_ids) > cardinality(pod_teams.draftable_ids) then excluded.draftable_ids else pod_teams.draftable_ids end,
         pick_numbers  = case when cardinality(excluded.draftable_ids) > cardinality(pod_teams.draftable_ids) then excluded.pick_numbers  else pod_teams.pick_numbers end`, [J(teams)]);
    await db.query(
      `insert into entries (entry_id, user_key, contest_id, state, prizes)
       select entry_id, user_key, contest_id, state, prizes
       from jsonb_to_recordset($1::jsonb) as x(entry_id bigint, user_key text, contest_id bigint, state text, prizes numeric)
       on conflict (entry_id) do update set state = coalesce(excluded.state, entries.state),
         prizes = coalesce(excluded.prizes, entries.prizes), synced_at = now()
       where entries.user_key = excluded.user_key`, // an entry never changes hands
      [J(entries)]);
  }
  let refreshed = 0;
  if (statusOnly.length) {
    refreshed = (await db.query(
      `update entries e set state = coalesce(x.state, e.state), prizes = coalesce(x.prizes, e.prizes), synced_at = now()
         from jsonb_to_recordset($1::jsonb) as x(entry_id bigint, state text, prizes numeric)
        where e.entry_id = x.entry_id`, [J(uniqBy(statusOnly, (e) => e.entry_id))])).rowCount;
  }

  forgetBase([...accounts.keys()]);
  const usernames = [...accounts.values()].filter(Boolean);
  const out = { usernames, drafts: entries.length, refreshed, skipped, rejected, pods: contests.length, teams: teams.length, playerLists: lists, errors };
  if (sender) await logUpload(db, { sender, ext, userKeys: [...accounts.keys()], usernames, drafts: out.drafts, refreshed, skipped, rejected, note: errors.slice(0, 3).join(" | ") || null }).catch(() => {});
  return out;
}

// what the extension may skip: of the entry ids it is about to sync, those whose whole pod is already
// drafted and stored; plus the draft groups whose player list is on file, and the usernames they belong to
export async function knownEntries(db, entryIds) {
  const ids = (entryIds ?? []).map(String).filter((x) => /^[0-9]{1,18}$/.test(x)).slice(0, 5000);
  const rows = ids.length ? (await db.query(
    `select e.entry_id, a.username from entries e join contests c on c.contest_id = e.contest_id join dk_accounts a on a.user_key = e.user_key
      where e.entry_id = any($1::bigint[]) and c.picks_total is not null
        and (select count(*) from pod_teams t where t.contest_id = e.contest_id) >= coalesce(c.entrants, 12)
        and (select min(cardinality(t.draftable_ids)) from pod_teams t where t.contest_id = e.contest_id) >= c.picks_total`, [ids])).rows : [];
  const draftGroups = (await db.query("select distinct draft_group_id g from draftables")).rows.map((r) => r.g);
  const ladders = (await db.query("select tournament_key from tournaments where ladder is not null")).rows.map((r) => r.tournament_key);
  // tournaments of these entries with no payout table yet (the panel links to their pages) — from what is stored,
  // so it works even when the contests page carries no tournament key
  const needLadders = ids.length ? (await db.query(
    `select upper(c.tournament_key) key, min(c.name) name, count(*)::int teams from entries e join contests c on c.contest_id = e.contest_id
      where e.entry_id = any($1::bigint[]) and c.tournament_key is not null and c.buy_in > 0
        and not exists (select 1 from tournaments t where t.tournament_key = upper(c.tournament_key) and t.ladder is not null)
      group by 1 order by teams desc`, [ids])).rows : [];
  return { startsBefore: new Date(WEEK1_ENDS).toISOString(), complete: rows.map((r) => String(r.entry_id)), usernames: [...new Set(rows.map((r) => r.username).filter(Boolean))], draftGroups, ladders, needLadders };
}
