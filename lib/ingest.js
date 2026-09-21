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

// → { drafts, pods, teams, errors: [..], newPlayers }
export async function ingestDrafts(db, payload) {
  const errors = [], contests = [], teams = [], entries = [], statusOnly = [], accounts = new Map();
  let skipped = 0; // contests that start after week 1, or are free
  for (const d of payload.drafts ?? []) {
    const r = readDraft(d);
    if (r.error) { errors.push(r.error); continue; }
    if (r.skipped) { skipped++; continue; }
    if (r.statusOnly) { statusOnly.push(r.statusOnly); continue; }
    contests.push(r.contest); teams.push(...r.teams); entries.push(r.entry);
    accounts.set(r.me.user_key, r.me.username);
  }

  // syncing is what makes an account searchable on the site
  for (const [userKey, username] of accounts) {
    await db.query(
      `insert into dk_accounts (user_key, username) values ($1,$2)
       on conflict (user_key) do update set username = coalesce(excluded.username, dk_accounts.username), synced_at = now()`, [userKey, username]);
  }
  const mineOnly = entries.filter((e) => accounts.has(e.user_key));
  const okContests = new Set(mineOnly.map((e) => String(e.contest_id)));

  const J = (rows) => JSON.stringify(rows);
  if (okContests.size) {
    await db.query(
      `insert into contests (contest_id, name, contest_type, tournament_key, mega_contest_id, round, draft_group_id, buy_in, prize_pool,
         entrants, positions_paid, draft_state, draft_date, start_date, picks_total)
       select contest_id, name, contest_type, tournament_key, mega_contest_id, round, draft_group_id, buy_in, prize_pool,
         entrants, positions_paid, draft_state, draft_date, start_date, picks_total
       from jsonb_to_recordset($1::jsonb) as x(contest_id bigint, name text, contest_type text, tournament_key text, mega_contest_id bigint,
         round int, draft_group_id int, buy_in numeric, prize_pool numeric, entrants int, positions_paid int, draft_state text,
         draft_date timestamptz, start_date timestamptz, picks_total int)
       on conflict (contest_id) do update set name = excluded.name, contest_type = excluded.contest_type, round = excluded.round,
         draft_group_id = coalesce(excluded.draft_group_id, contests.draft_group_id), entrants = excluded.entrants,
         positions_paid = coalesce(excluded.positions_paid, contests.positions_paid), -- reads 0 once live: keep the preseason value
         draft_state = excluded.draft_state, draft_date = coalesce(excluded.draft_date, contests.draft_date),
         picks_total = excluded.picks_total, updated_at = now()`,
      [J(uniqBy(contests.filter((c) => okContests.has(String(c.contest_id))), (c) => c.contest_id))]);
    // rosters never change after a Best Ball draft: an existing team is only replaced by one with MORE picks
    // (a draft that was still running last time), so nobody can overwrite a finished pod for the others in it
    await db.query(
      `insert into pod_teams (contest_id, user_key, username, seat, entry_key, draftable_ids, pick_numbers)
       select * from jsonb_to_recordset($1::jsonb) as x(contest_id bigint, user_key text, username text, seat int, entry_key bigint,
         draftable_ids int[], pick_numbers int[])
       on conflict (contest_id, user_key) do update set
         entry_key = coalesce(pod_teams.entry_key, excluded.entry_key),
         username = coalesce(excluded.username, pod_teams.username),
         draftable_ids = case when cardinality(excluded.draftable_ids) > cardinality(pod_teams.draftable_ids) then excluded.draftable_ids else pod_teams.draftable_ids end,
         pick_numbers  = case when cardinality(excluded.draftable_ids) > cardinality(pod_teams.draftable_ids) then excluded.pick_numbers  else pod_teams.pick_numbers end`,
      [J(uniqBy(teams.filter((t) => okContests.has(String(t.contest_id))), (t) => `${t.contest_id}|${t.user_key}`))]);
    await db.query(
      `insert into entries (entry_id, user_key, contest_id, state, prizes)
       select entry_id, user_key, contest_id, state, prizes
       from jsonb_to_recordset($1::jsonb) as x(entry_id bigint, user_key text, contest_id bigint, state text, prizes numeric)
       on conflict (entry_id) do update set state = coalesce(excluded.state, entries.state),
         prizes = coalesce(excluded.prizes, entries.prizes), synced_at = now()
       where entries.user_key = excluded.user_key`, // an entry never changes hands
      [J(uniqBy(mineOnly, (e) => e.entry_id))]);
  }

  if (statusOnly.length) {
    await db.query(
      `update entries e set state = coalesce(x.state, e.state), prizes = coalesce(x.prizes, e.prizes), synced_at = now()
         from jsonb_to_recordset($1::jsonb) as x(entry_id bigint, state text, prizes numeric)
        where e.entry_id = x.entry_id`, [J(uniqBy(statusOnly, (e) => e.entry_id))]);
  }

  let players = 0;
  for (const [dgid, list] of Object.entries(payload.draftables ?? {})) {
    const adp = payload.adp?.[dgid] ?? {};
    const rows = uniqBy(list.filter((r) => r?.[0] != null), (r) => r[0]).map(([did, pid, name, pos, team]) => ({ draftable_id: did, player_id: pid, name, position: pos, team, adp: adp[pid] ?? null }));
    for (let i = 0; i < rows.length; i += 1000) {
      await db.query(
        `insert into draftables (draft_group_id, draftable_id, player_id, name, position, team, adp)
         select $2::int, draftable_id, player_id, name, position, team, adp
         from jsonb_to_recordset($1::jsonb) as x(draftable_id int, player_id int, name text, position text, team text, adp numeric)
         on conflict (draft_group_id, draftable_id) do update set name = excluded.name, position = excluded.position, team = excluded.team,
           player_id = coalesce(excluded.player_id, draftables.player_id), adp = coalesce(excluded.adp, draftables.adp)`,
        [J(rows.slice(i, i + 1000)), dgid]);
    }
    players += rows.length;
  }
  forgetBase([...accounts.keys()]);
  const usernames = [...accounts.values()].filter(Boolean);
  return { usernames, drafts: mineOnly.length, refreshed: statusOnly.length, skipped, pods: okContests.size, teams: teams.filter((t) => okContests.has(String(t.contest_id))).length, draftables: players, errors };
}

// draft groups some contest uses but whose player list we do not have yet
export async function missingDraftGroups(db) {
  const { rows } = await db.query(
    `select distinct c.draft_group_id g from contests c where c.draft_group_id is not null
       and not exists (select 1 from draftables d where d.draft_group_id = c.draft_group_id)`);
  return rows.map((r) => r.g);
}

// DraftKings' public player list for a draft group (no login) → the upload's draftables shape
export async function fetchDraftables(dgid) {
  const r = await fetch(`https://api.draftkings.com/draftgroups/v1/draftgroups/${dgid}/draftables?format=json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw new Error(`draftables ${dgid} → HTTP ${r.status}`);
  const j = await r.json();
  return (j.draftables ?? []).map((d) => [d.draftableId, d.playerId ?? null, d.displayName ?? null, d.position ?? null, d.teamAbbreviation ?? null]);
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
  return { startsBefore: new Date(WEEK1_ENDS).toISOString(), complete: rows.map((r) => String(r.entry_id)), usernames: [...new Set(rows.map((r) => r.username).filter(Boolean))], draftGroups };
}
