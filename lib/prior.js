// Season totals from FINISHED weeks, stored per pod instead of being re-scored every minute.
//
// lib/pubscore.js foldWeeks() re-runs DraftKings' best-lineup pick for every roster for every completed week. That
// is exact but it is (rosters × weeks) work: 12 s a minute for 5,000 teams by week 17. Finished weeks only ever
// change through stat corrections, so the result is kept in pod_prior and the per-minute work is the current
// week only. The numbers are foldWeeks()' own — this file never scores anything itself.
//
// A pod's stored totals are reused when they cover exactly the completed weeks (through_week = week − 1).
// They are recomputed when a new week completes, and refreshed once a day so stat corrections flow in.
//
// The stored rows are ~3 MB at 4,000 teams, so they are NOT read from the database on every run: this instance
// keeps them in memory and the shared runtime cache keeps them for other instances; the database is read only for
// pods neither has (a cold start, or teams synced since) and written only when totals are (re)computed.
import { foldWeeks } from "./pubscore.js";
import { rcPut, rcGet } from "./rcache.js";

const REFRESH_MS = 24 * 3600e3, REFRESH_PER_RUN = 400; // daily correction refresh, spread over many runs
const RC_KEY = "prior-v1", RC_TTL_S = 24 * 3600;
let have = null; // { want, rows: Map(cid → { through_week, computed_at, data }) }
export const _forgetPrior = () => { have = null; }; // tests

// the rows for `cids` covering week `want`: memory → shared cache → database (only the missing ones)
async function rowsFor(db, cids, want) {
  if (have?.want !== want) {
    const c = await rcGet(RC_KEY);
    have = { want, rows: new Map(c?.value?.want === want ? c.value.rows : []) };
  }
  const missing = cids.filter((cid) => !have.rows.has(cid));
  if (missing.length) {
    for (const r of (await db.query(`select contest_id, through_week, computed_at, data from pod_prior where contest_id = any($1::bigint[])`, [missing])).rows)
      have.rows.set(String(r.contest_id), { through_week: r.through_week, computed_at: new Date(r.computed_at).toISOString(), data: r.data });
    await share();
  }
  return have.rows;
}
const share = () => rcPut(RC_KEY, { want: have.want, rows: [...have.rows] }, RC_TTL_S);

// → prior in foldWeeks()' shape { cid: { rosterKey: { did: [all, counted, through] } } } for every pod of `base`
// f = lib/feeds.js getFeeds(): f.week, f.past = [[week, Map], …] for every completed week
export async function priorFor(db, base, f, now = Date.now()) {
  const want = f.week - 1, cids = Object.keys(base.pods);
  if (want < 1 || !cids.length) return { prior: {}, stats: { reused: 0, computed: 0 } };
  const rows = await rowsFor(db, cids, want);

  const prior = {}, todo = [];
  let refresh = 0;
  for (const cid of cids) {
    const pod = base.pods[cid], row = rows.get(cid);
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
    const out = [], at = new Date(now).toISOString();
    for (const [cid, cacheable] of todo) {
      prior[cid] = fresh[cid] ?? {};
      if (!cacheable) continue;
      const bySeat = {};
      for (const [key, ro] of Object.entries(base.pods[cid].rosters)) if (fresh[cid]?.[key]) bySeat[ro.s] = fresh[cid][key];
      out.push({ contest_id: cid, through_week: want, data: bySeat });
      rows.set(cid, { through_week: want, computed_at: at, data: bySeat });
    }
    for (let i = 0; i < out.length; i += 500) {
      await db.query(
        `insert into pod_prior (contest_id, through_week, computed_at, data)
         select contest_id, through_week, now(), data from jsonb_to_recordset($1::jsonb) as x(contest_id bigint, through_week int, data jsonb)
         on conflict (contest_id) do update set through_week = excluded.through_week, computed_at = now(), data = excluded.data`, [JSON.stringify(out.slice(i, i + 500))]);
    }
    if (out.length) await share();
  }
  return { prior, stats: { reused: cids.length - todo.length, computed: todo.length } };
}
