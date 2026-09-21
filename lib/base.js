// One portfolio's "base" (the teams of one or more synced DraftKings accounts) — the static facts lib/pubscore.js and lib/live.js score from — read from Postgres.
// Same shape the single-user site bakes into base.json at publish time:
//   entries    { entryId: { cid, dgid, pp } }
//   draftables { dgid: { did: [pid, name, pos, team] } }       only the rostered players
//   pods       { cid: { dgid, from, rosters: { key: { u, d: [did], s } } } }   from = first NFL week that counts, s = draft seat
//   sleeper    { dkPlayerId: [sleeperId, team] }
// plus contests { entryId: { cid, dgid, pp, entrants, state, prizes } } (what the extension snapshot used to carry).
//
// Roster key: the DK entry id when known (always for a synced account's own team — the pages find "my" row by it),
// otherwise the draft seat (1–12), which can never collide with an entry id.

import { nflWeek } from "./live.js";

const TTL = 60e3;
const cache = new Map(); // sorted user keys → { at, base }
export const keyOf = (userKeys, only = null) => [...userKeys].sort().join(",") + (only ? "#" + [...only].sort().join(",") : "");
// an upload changed these accounts: drop every cached base that includes one of them
export const forgetBase = (userKeys) => { for (const k of cache.keys()) if (userKeys.some((u) => k.split("#")[0].split(",").includes(u))) cache.delete(k); };

// only: limit the base to these entry ids (null = every team of the accounts)
export async function buildBase(db, userKeys, now = Date.now(), only = null) {
  const hit = cache.get(keyOf(userKeys, only));
  if (hit && now - hit.at < TTL) return hit.base;

  const ents = (await db.query(
    `select e.entry_id, e.contest_id, e.state, e.prizes, c.draft_group_id dgid, c.positions_paid pp, c.entrants, c.round, c.start_date
       from entries e join contests c on c.contest_id = e.contest_id
      where e.user_key = any($1::text[]) and ($2::bigint[] is null or e.entry_id = any($2::bigint[]))`, [userKeys, only])).rows;
  const entries = {}, contests = {}, pods = {}, draftables = {}, sleeper = {};
  const cids = [...new Set(ents.map((e) => e.contest_id))];
  for (const e of ents) {
    // PositionsPaid reads 0 once a contest is live → unknown; round-1 12-team pods advance 2
    const pp = e.pp ?? ((e.round ?? 1) === 1 && e.entrants === 12 ? 2 : null);
    entries[e.entry_id] = { cid: Number(e.contest_id), dgid: e.dgid, pp };
    contests[e.entry_id] = { cid: Number(e.contest_id), dgid: e.dgid, pp, entrants: e.entrants, state: e.state, prizes: e.prizes == null ? null : Number(e.prizes), blobRank: null, blobPoints: null };
    // from = the first NFL week that counts: a contest starting mid-season scores nothing for earlier weeks
    pods[e.contest_id] ??= { dgid: e.dgid, from: e.start_date ? nflWeek(new Date(e.start_date).toISOString()) ?? 1 : 1, rosters: {} };
  }

  if (cids.length) {
    const teams = (await db.query(
      `select contest_id, username, seat, entry_key, draftable_ids from pod_teams where contest_id = any($1::bigint[])`, [cids])).rows;
    const byDg = new Map(); // dgid → Set(did)
    teams.forEach((t, i) => {
      const pod = pods[t.contest_id]; if (!pod) return;
      const key = t.entry_key ?? t.seat ?? 100 + i;
      pod.rosters[key] = { u: t.username, d: t.draftable_ids, s: t.seat };
      if (!byDg.has(pod.dgid)) byDg.set(pod.dgid, new Set());
      for (const did of t.draftable_ids) byDg.get(pod.dgid).add(did);
    });
    const pids = new Set();
    for (const [dgid, dids] of byDg) {
      const rows = (await db.query(
        `select draftable_id did, player_id pid, name, position pos, team from draftables
          where draft_group_id = $1 and draftable_id = any($2::int[])`, [dgid, [...dids]])).rows;
      const dg = (draftables[dgid] = {});
      for (const r of rows) { dg[r.did] = [r.pid, r.name, r.pos, r.team]; if (r.pid != null) pids.add(r.pid); }
    }
    if (pids.size) {
      for (const r of (await db.query(`select player_id, sleeper_id, team from sleeper_map where player_id = any($1::int[])`, [[...pids]])).rows)
        sleeper[r.player_id] = [r.sleeper_id, r.team];
    }
  }

  const base = { entries, contests, draftables, pods, sleeper, partners: {}, prior: {}, ownerHidden: [] };
  cache.set(keyOf(userKeys, only), { at: now, base });
  return base;
}
