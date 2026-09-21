// One portfolio (the teams of one or more synced DraftKings accounts) in the shape the app page boots from (same object the single-user build script
// embeds as DK): drafts, my picks, the players on them, the current ADP pool. Season numbers are left
// empty — the page fills them from /api/live right after load.
export async function userPortfolio(db, userKeys, only = null) {
  const { rows: ents } = await db.query(
    `select e.entry_id, e.state section, e.synced_at, c.contest_id, c.name, c.contest_type, c.buy_in, c.entrants, c.draft_date,
            c.draft_state, c.picks_total, c.positions_paid, c.round, c.draft_group_id dgid, t.seat, t.draftable_ids, t.pick_numbers
       from entries e join contests c on c.contest_id = e.contest_id
       left join pod_teams t on t.contest_id = e.contest_id and t.user_key = e.user_key
      where e.user_key = any($1::text[]) and ($2::bigint[] is null or e.entry_id = any($2::bigint[])) order by c.draft_date`, [userKeys, only]);

  const dids = new Map(); // dgid → Set(did)
  for (const e of ents) { if (!dids.has(e.dgid)) dids.set(e.dgid, new Set()); for (const d of e.draftable_ids ?? []) dids.get(e.dgid).add(d); }
  const dr = new Map(); // "dgid:did" → row
  for (const [dgid, set] of dids) {
    const { rows } = await db.query(
      `select draftable_id did, player_id pid, name, position pos, team, adp from draftables where draft_group_id = $1 and draftable_id = any($2::int[])`, [dgid, [...set]]);
    for (const r of rows) dr.set(`${dgid}:${r.did}`, r);
  }

  const drafts = [], picks = [], players = {};
  let syncedAt = null;
  for (const e of ents) {
    const size = e.entrants ?? 12, made = e.draftable_ids?.length ?? 0;
    drafts.push({
      id: Number(e.entry_id), contestId: Number(e.contest_id), name: e.name, type: e.contest_type, buyIn: e.buy_in == null ? null : Number(e.buy_in),
      size, slot: e.seat, date: e.draft_date ? new Date(e.draft_date).toISOString() : null, state: e.draft_state,
      picksMade: made, picksTotal: e.picks_total ?? made,
      pp: e.positions_paid ?? ((e.round ?? 1) === 1 && size === 12 ? 2 : null), ent: size, section: e.section,
    });
    (e.draftable_ids ?? []).forEach((did, i) => {
      const d = dr.get(`${e.dgid}:${did}`); if (!d || d.pid == null) return;
      const pk = e.pick_numbers[i], r = Math.ceil(pk / size);
      players[d.pid] ??= { n: d.name, p: d.pos, t: d.team, dk: null };
      picks.push({ e: Number(e.entry_id), pl: d.pid, pk, r, pr: pk - (r - 1) * size, adp: d.adp == null ? null : Number(d.adp), ts: null });
    });
    const at = e.synced_at ? new Date(e.synced_at).toISOString() : null;
    if (at && (!syncedAt || at > syncedAt)) syncedAt = at;
  }

  // current player pool for the Balance tab: the most recently drafted group's ADP list
  let pool = [];
  const latest = [...ents].reverse().find((e) => e.dgid != null)?.dgid;
  if (latest != null) {
    pool = (await db.query(
      `select player_id pl, name n, position p, team t, round(adp, 1)::float adp from draftables
        where draft_group_id = $1 and adp is not null and adp <= 300 and player_id is not null order by adp`, [latest])).rows;
  }

  return {
    pool,
    season: { status: {}, scores: {}, manual: {}, shares: {}, history: {}, pods: {}, scoresSyncedAt: null, week: null },
    generatedAt: new Date().toISOString(),
    meta: { sourceFile: "dkbbdb", syncedAt, syncErrors: 0, draftCount: drafts.length, pickCount: picks.length,
      playerCount: Object.keys(players).length, unnamedPlayers: 0, draftGroups: [...dids.keys()].join(", ") },
    drafts, players, picks,
  };
}
