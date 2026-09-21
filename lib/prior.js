// Season totals from FINISHED weeks, stored per pod instead of being re-scored every minute.
//
// lib/pubscore.js foldWeeks() re-runs DraftKings' best-lineup pick for every roster for every completed week. That
// is exact but it is (rosters × weeks) work: 12 s a minute for 5,000 teams by week 17. Finished weeks only ever
// change through stat corrections, so the result is kept in pod_prior and the per-minute work is the current
// week only. The numbers are foldWeeks()' own — this file never scores anything itself.
//
// A pod's stored totals are reused when they cover exactly the completed weeks (through_week = week − 1).
// They are recomputed when a new week completes, and refreshed once a day so stat corrections flow in.
import { foldWeeks } from "./pubscore.js";

const REFRESH_MS = 24 * 3600e3, REFRESH_PER_RUN = 400; // daily correction refresh, spread over many runs

// → prior in foldWeeks()' shape { cid: { rosterKey: { did: [all, counted, through] } } } for every pod of `base`
// f = lib/feeds.js getFeeds(): f.week, f.past = [[week, Map], …] for every completed week
export async function priorFor(db, base, f, now = Date.now()) {
  const want = f.week - 1, cids = Object.keys(base.pods);
  if (want < 1 || !cids.length) return { prior: {}, stats: { reused: 0, computed: 0 } };
  const have = new Map((await db.query(
    `select contest_id, through_week, computed_at, data from pod_prior where contest_id = any($1::bigint[])`, [cids])).rows.map((r) => [String(r.contest_id), r]));

  const prior = {}, todo = [];
  let refresh = 0;
  for (const cid of cids) {
    const pod = base.pods[cid], row = have.get(cid);
    const seats = Object.values(pod.rosters).map((r) => r.s);
    const cacheable = seats.every((s) => s != null) && new Set(seats).size === seats.length;
    const stale = row && now - Date.parse(row.computed_at) > REFRESH_MS && refresh < REFRESH_PER_RUN;
    if (!cacheable || !row || row.through_week !== want || stale) { if (stale) refresh++; todo.push([cid, cacheable]); continue; }
    const out = (prior[cid] = {});
    for (const [key, ro] of Object.entries(pod.rosters)) if (row.data[ro.s]) out[key] = row.data[ro.s];
  }

  if (todo.length) {
    const sub = { ...base, pods: Object.fromEntries(todo.map(([cid]) => [cid, base.pods[cid]])) };
    const fresh = foldWeeks(sub, f.past).prior;
    const rows = [];
    for (const [cid, cacheable] of todo) {
      prior[cid] = fresh[cid] ?? {};
      if (!cacheable) continue;
      const bySeat = {};
      for (const [key, ro] of Object.entries(base.pods[cid].rosters)) if (fresh[cid]?.[key]) bySeat[ro.s] = fresh[cid][key];
      rows.push({ contest_id: cid, through_week: want, data: bySeat });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.query(
        `insert into pod_prior (contest_id, through_week, computed_at, data)
         select contest_id, through_week, now(), data from jsonb_to_recordset($1::jsonb) as x(contest_id bigint, through_week int, data jsonb)
         on conflict (contest_id) do update set through_week = excluded.through_week, computed_at = now(), data = excluded.data`, [JSON.stringify(rows.slice(i, i + 500))]);
    }
  }
  return { prior, stats: { reused: cids.length - todo.length, computed: todo.length } };
}
