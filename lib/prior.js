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
// The rows live in store/prior.json.gz (~3 MB at 4,000 teams): this instance keeps them in memory, the shared
// runtime cache keeps them for other instances, and the file is read once per instance and written when totals
// are (re)computed.
//
// Each row also keeps every roster's score per finished week (`wk`, one array per seat, indexed like the weeks) —
// the profile page's week chips show a team's standing as of any week from them. A row without `wk` (written
// before 2026-09-27) is recomputed once.
import { foldWeeks } from "./pubscore.js";
import { rcPut, rcGet } from "./rcache.js";
import { getGz, putGz } from "./files.js";
import { PATHS } from "./store.js";

const REFRESH_MS = 24 * 3600e3, REFRESH_PER_RUN = 400; // daily correction refresh, spread over many runs
const RC_KEY = "prior-v1", RC_TTL_S = 24 * 3600;
let have = null; // { want, rows: Map(cid → { through_week, computed_at, data }) }
export const _forgetPrior = () => { have = null; }; // tests

// the rows covering week `want`: memory → shared cache → the file; a pod neither has is simply recomputed
async function rowsFor(want) {
  if (have?.want !== want) {
    const c = await rcGet(RC_KEY);
    have = { want, rows: new Map(c?.value?.want === want ? c.value.rows : []) };
    if (!have.rows.size) { // the file: read once per instance, then shared through the cache for the next instance
      const f = await getGz(PATHS.prior);
      if (f?.value?.want === want) { for (const [cid, row] of f.value.rows) have.rows.set(cid, row); await rcPut(RC_KEY, { want, rows: [...have.rows] }, RC_TTL_S); }
    }
  }
  return have.rows;
}
const share = async () => { const v = { want: have.want, rows: [...have.rows] }; await rcPut(RC_KEY, v, RC_TTL_S); await putGz(PATHS.prior, v); };

// → { prior, weekly, weeks, stats }
//   prior   foldWeeks()' shape { cid: { rosterKey: { did: [all, counted, through] } } } for every pod of `base`
//   weekly  { cid: { rosterKey: [team score per finished week] } }, indexed like `weeks` (= [1, 2, …, want])
// f = lib/feeds.js getFeeds(): f.week, f.past = [[week, Map], …] for every completed week
export async function priorFor(base, f, now = Date.now()) {
  const want = f.week - 1, cids = Object.keys(base.pods);
  const weeks = [...(f.past ?? [])].map(([w]) => Number(w)).filter((w) => w >= 1).sort((a, b) => a - b);
  if (want < 1 || !cids.length) return { prior: {}, weekly: {}, weeks, stats: { reused: 0, computed: 0 } };
  const rows = await rowsFor(want);

  const prior = {}, weekly = {}, todo = [];
  let refresh = 0;
  for (const cid of cids) {
    const pod = base.pods[cid], row = rows.get(cid);
    const seats = Object.values(pod.rosters).map((r) => r.s);
    const cacheable = seats.every((s) => s != null) && new Set(seats).size === seats.length;
    const stale = row && now - Date.parse(row.computed_at) > REFRESH_MS && refresh < REFRESH_PER_RUN;
    if (!cacheable || !row || row.through_week !== want || !row.wk || stale) { if (stale) refresh++; todo.push([cid, cacheable]); continue; }
    const out = (prior[cid] = {}), wk = (weekly[cid] = {});
    for (const [key, ro] of Object.entries(pod.rosters)) { if (row.data[ro.s]) out[key] = row.data[ro.s]; if (row.wk[ro.s]) wk[key] = row.wk[ro.s]; }
  }

  if (todo.length) {
    const sub = { ...base, pods: Object.fromEntries(todo.map(([cid]) => [cid, base.pods[cid]])) };
    const fresh = foldWeeks(sub, f.past);
    const out = [], at = new Date(now).toISOString();
    for (const [cid, cacheable] of todo) {
      prior[cid] = fresh.prior[cid] ?? {};
      weekly[cid] = Object.fromEntries(Object.entries(fresh.weekly.teams[cid] ?? {}).map(([key, v]) => [key, v.t]));
      if (!cacheable) continue;
      const bySeat = {}, wkSeat = {};
      for (const [key, ro] of Object.entries(base.pods[cid].rosters)) { if (fresh.prior[cid]?.[key]) bySeat[ro.s] = fresh.prior[cid][key]; if (weekly[cid][key]) wkSeat[ro.s] = weekly[cid][key]; }
      out.push({ contest_id: cid, through_week: want, data: bySeat });
      rows.set(cid, { through_week: want, computed_at: at, data: bySeat, wk: wkSeat });
    }
    if (out.length) await share();
  }
  return { prior, weekly, weeks, stats: { reused: cids.length - todo.length, computed: todo.length } };
}
