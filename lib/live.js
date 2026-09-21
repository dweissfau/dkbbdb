// Live snapshot: what the extension pushes every few minutes, merged into one JSON document
// (kept in Vercel Blob as live.json) and served back to the pages as the same shapes the
// build scripts produce from SQLite. Pure functions — no I/O — so they can be unit-tested
// against captured sync files.
//
//   mergeLive(prev, base, post)      → next snapshot (partial posts merge into the previous one)
//   deriveView(snap, base, scope)    → { at, week, status, scores, pods, opp, history, rostersAt, weekly }
//
// base (deploy/data/base.json, written by tools/build-live-base.mjs at publish time):
//   entries    { entryId: { cid, dgid, pp } }                   my teams (for the owner view)
//   draftables { dgid: { did: [pid, name, pos, team] } }        DK's public draftables feed
//   partners   { slug: [entryId, ...] }                          who may see which teams
//   prior      { cid: { entryKey: { did: [all, counted, week] } } }  points from weeks before the
//              live feed knew a roster (seeds the season totals; repaired on every publish)
//
// Snapshot (internal):
//   contests { entryId: { cid, dgid, pp, entrants, state, prizes, blobRank, blobPoints } }
//   pods     { cid: [[entryKey, userName, rank, points, timeRemaining], ...] }
//   rosters  { cid: { entryKey: { week, cards: [[did, slot, wk, bench, baseAll, baseCounted], ...] } } }
//            wk = this week's points; baseAll/baseCounted = earlier weeks (all / starter weeks).
//            When a roster arrives for a later week, wk folds into the bases first.
//   history  { entryId: [[YYYY-MM-DD, rank], ...] }  last rank seen each day (rank trend + Δ)
//   rostersAt{ cid: iso }                              when the pod's rosters were last pushed

export const SEASON_WEEK1_TUESDAY_UTC = Date.UTC(2026, 8, 8, 8); // Tue 2026-09-08 04:00 ET; NFL weeks roll on Tuesday
export const nflWeek = (iso) => {
  const t = Date.parse(iso);
  return isFinite(t) ? Math.max(1, Math.floor((t - SEASON_WEEK1_TUESDAY_UTC) / (7 * 864e5)) + 1) : null;
};
// NFL "day" used as the rank-history key: the UTC date shifted back 8 h, so a Monday-night game that ends
// after midnight UTC still lands on Monday, and each week's Tuesday key begins exactly at the rollover
export const nflDay = (iso) => new Date(Date.parse(iso) - 8 * 3600e3).toISOString().slice(0, 10);
// the Tuesday key that starts the NFL week containing `iso`
export const weekTuesday = (iso) => nflDay(new Date(SEASON_WEEK1_TUESDAY_UTC + ((nflWeek(iso) ?? 1) - 1) * 7 * 864e5).toISOString());
// rank at the END of the previous week: the latest history row on or before this week's Tuesday. Nothing is
// played on a Tuesday, so a Tuesday row still holds the previous week's final rank (the weekly cron writes one).
// null during week 1 or with no history — the pages then show no arrow.
export function prevWeekRank(hist, iso) {
  const tue = weekTuesday(iso);
  const rows = (hist ?? []).filter(([day, rank]) => day <= tue && rank != null).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows.length ? rows[rows.length - 1][1] : null;
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(Number(v)) ? Number(v) : null);
const nz = (v) => (typeof v === "number" && v !== 0 ? v : null); // DK uses 0 for "not yet"
const r2 = (x) => Math.round(x * 100) / 100;

export function emptySnapshot() {
  return { v: 1, at: null, week: null, contests: {}, pods: {}, rosters: {}, history: {}, rostersAt: {} };
}

// ---- contests (the /mycontests blob the content script caches) ----
function mergeContests(snap, list) {
  for (const c of list ?? []) {
    const id = c.UserContestId ?? c.entryId; if (id == null) continue;
    const entrants = c.NumberOfEntrants ?? c.MaxNumberPlayers ?? null;
    const started = c.section != null && c.section !== "upcoming";
    const prev = snap.contests[id] ?? {};
    snap.contests[id] = {
      cid: c.ContestId ?? prev.cid ?? null,
      dgid: c.DraftGroupId ?? c.ActiveDraftGroupId ?? c.StartingDraftGroupId ?? prev.dgid ?? null,
      // PositionsPaid reads 2 preseason but 0 once live → 0 = unknown; round-1 12-team pods advance 2
      pp: nz(c.PositionsPaid) ?? prev.pp ?? (c.MegaContestRoundNumber === 1 && entrants === 12 ? 2 : null),
      entrants: entrants ?? prev.entrants ?? null,
      state: c.section ?? prev.state ?? null,
      prizes: nz(c.PrizesWon) ?? prev.prizes ?? null,
      blobRank: nz(c.ResultsRank) ?? prev.blobRank ?? null,
      blobPoints: started ? (typeof c.PlayerPoints === "number" ? c.PlayerPoints : prev.blobPoints ?? null) : nz(c.PlayerPoints) ?? prev.blobPoints ?? null,
    };
  }
}

// ---- pods (scores/v1/leaderboards/{cid}?embed=leaderboard → leaderBoard[]) ----
function podRows(lb) {
  const list = Array.isArray(lb) ? lb : Array.isArray(lb?.leaderBoard) ? lb.leaderBoard : Array.isArray(lb?.entries) ? lb.entries : null;
  if (!list) return null;
  const rows = [];
  for (const e of list) {
    const key = e.entryKey ?? e.userContestId ?? e.entryId; if (key == null) continue;
    rows.push([Number(key), e.userName ?? null, num(e.rank), num(e.fantasyPoints ?? e.points ?? e.score),
      typeof e.timeRemaining === "number" ? e.timeRemaining : null]);
  }
  rows.sort((a, b) => (a[2] ?? 99) - (b[2] ?? 99) || (b[3] ?? 0) - (a[3] ?? 0));
  return rows;
}

// ---- rosters (scores/v2/entries/{dgid}/{entryKey}?embed=roster → trimmed scorecards) ----
// card: { draftableId, slot, bench, score, start }  (extension trimCard) — raw DK scorecards also accepted
// A "Final"-style clock always wins over the stored state: DK leaves PMR > 0 after some finals and
// extension < 0.5.3 tagged those "L" (seen as green "LIVE Final"); applied on ingest and in the view.
export const gameSt = (st, ts, pmr) => /final|complete|ended|postponed|cancel/i.test(ts ?? "") ? "F" : st ?? (pmr === 0 ? "F" : null);
function normCard(sc) {
  const did = sc.draftableId ?? sc.did; if (did == null) return null;
  const c = sc.competition ?? {};
  return { did: Number(did), slot: sc.slot ?? sc.rosterPosition ?? null, bench: !!(sc.bench ?? sc.isNonScoring),
    score: typeof sc.score === "number" ? sc.score : 0, start: sc.start ?? c.startTime ?? null,
    // game state (extension ≥ 0.5.2 sends these; raw DK cards carry the pieces)
    pmr: typeof sc.pmr === "number" ? sc.pmr : typeof sc.timeRemaining === "number" ? sc.timeRemaining : null,
    st: gameSt(sc.st ?? null, sc.ts ?? c.timeStatus ?? null, typeof sc.pmr === "number" ? sc.pmr : sc.timeRemaining), ts: sc.ts ?? c.timeStatus ?? null, game: sc.game ?? c.name ?? null };
}
function mergeRoster(snap, base, cid, key, cards, fetchedAt) {
  const norm = cards.map(normCard).filter(Boolean);
  if (!norm.length) return false;
  const latestGame = norm.map((c) => c.start).filter(Boolean).sort().pop();
  const week = nflWeek(latestGame ?? fetchedAt) ?? 1;
  const podR = (snap.rosters[cid] ??= {});
  const prev = podR[key];
  const prevCards = new Map((prev?.cards ?? []).map((c) => [c[0], c]));
  const prior = base?.prior?.[cid]?.[key] ?? null;
  const out = [];
  for (const c of norm) {
    let baseAll = 0, baseCounted = 0;
    const p = prevCards.get(c.did);
    if (p) {
      baseAll = p[4]; baseCounted = p[5];
      if (prev.week < week) { baseAll += p[2]; baseCounted += p[3] ? 0 : p[2]; } // fold last week into the bases
    } else if (prior?.[c.did]) {
      const [all, counted, through] = prior[c.did];
      if (through < week) { baseAll = all; baseCounted = counted; }
    }
    out.push([c.did, c.slot, c.score, c.bench ? 1 : 0, r2(baseAll), r2(baseCounted), c.pmr, c.st, c.ts, c.game, c.start]);
  }
  podR[key] = { week, cards: out };
  return true;
}

// ---- merge one push ----
// post: { fetchedAt, contests?, leaderboards?: { cid: leaderBoard[] | {leaderBoard} }, rosters?: { cid: { entryKey: [cards] } } }
export function mergeLive(prev, base, post) {
  const snap = prev ? structuredClone(prev) : emptySnapshot();
  const at = post.fetchedAt ?? new Date().toISOString();
  const day = nflDay(at);
  mergeContests(snap, post.contests);
  for (const [cid, lb] of Object.entries(post.leaderboards ?? {})) {
    const rows = podRows(lb);
    if (rows && rows.length >= 2) snap.pods[cid] = rows; // a full pod list only
  }
  let rosterCount = 0;
  for (const [cid, byKey] of Object.entries(post.rosters ?? {})) {
    let any = false;
    for (const [key, cards] of Object.entries(byKey ?? {})) if (Array.isArray(cards) && mergeRoster(snap, base, cid, key, cards, at)) { any = true; rosterCount++; }
    if (any) snap.rostersAt[cid] = at;
  }
  // rank history: last rank seen each day, for my entries (base.entries) that have a pod row today
  const myIds = new Set(Object.keys(base?.entries ?? {}).concat(Object.keys(snap.contests)));
  for (const id of myIds) {
    const cid = snap.contests[id]?.cid ?? base?.entries?.[id]?.cid; if (cid == null) continue;
    if (!(String(cid) in (post.leaderboards ?? {}))) continue; // only when this push carried the pod
    const row = (snap.pods[cid] ?? []).find((r) => r[0] === Number(id)); if (!row || row[2] == null) continue;
    const h = (snap.history[id] ??= []);
    if (h.length && h[h.length - 1][0] === day) h[h.length - 1][1] = row[2]; else h.push([day, row[2]]);
    if (h.length > 400) h.splice(0, h.length - 400);
  }
  snap.at = at;
  const weeks = Object.values(snap.rosters).flatMap((p) => Object.values(p).map((r) => r.week));
  snap.week = weeks.length ? Math.max(...weeks) : snap.week ?? nflWeek(at);
  snap.stats = { pods: Object.keys(snap.pods).length, rosters: Object.values(snap.rosters).reduce((s, p) => s + Object.keys(p).length, 0), lastPush: { at, pods: Object.keys(post.leaderboards ?? {}).length, rosters: rosterCount } };
  return snap;
}

// ---- the view the pages consume ----
// scope: { entryIds: [..] } limits to those teams (a partner) — omit for the owner.
export function deriveView(snap, base, scope = {}) {
  const entries = base?.entries ?? {};
  const ids = scope.entryIds ? scope.entryIds.map(String).filter((id) => id in entries || id in snap.contests) : [...new Set([...Object.keys(entries), ...Object.keys(snap.contests)])];
  const cidOf = (id) => snap.contests[id]?.cid ?? entries[id]?.cid ?? null;
  const dgOf = (id) => snap.contests[id]?.dgid ?? entries[id]?.dgid ?? null;
  const cids = new Set(ids.map(cidOf).filter((c) => c != null).map(String));
  const draftable = (dgid, did) => base?.draftables?.[dgid]?.[did] ?? null;

  const status = {}, scores = {}, history = {}, pods = {}, rostersAt = {};
  for (const id of ids) {
    const c = snap.contests[id] ?? {}, cid = cidOf(id), dgid = dgOf(id);
    const pod = cid != null ? snap.pods[cid] : null;
    const row = pod?.find((r) => r[0] === Number(id)) ?? null;
    const hist = snap.history[id] ?? [];
    const st = {
      rank: row?.[2] ?? c.blobRank ?? null, entrants: pod?.length ?? c.entrants ?? null,
      points: row?.[3] ?? c.blobPoints ?? null, pp: c.pp ?? entries[id]?.pp ?? null,
      state: c.state ?? null, prizes: c.prizes ?? null, at: snap.at,
      prevRank: prevWeekRank(hist, snap.at ?? new Date().toISOString()), // rank at the end of last week (Δ arrow)
      topPid: null, topPts: null, weekTopPid: null, weekTopPts: null, week: null,
    };
    const ro = cid != null ? snap.rosters[cid]?.[id] : null;
    if (ro) {
      const rows = []; let top = null, wtop = null;
      for (const [did, , wk, bench, baseAll, baseCounted, pmr, st, ts, game, start] of ro.cards) {
        const d = draftable(dgid, did); if (!d) continue;
        const pid = d[0], total = r2(baseAll + wk), counted = r2(baseCounted + (bench ? 0 : wk));
        rows.push([pid, total, counted, wk, pmr ?? null, gameSt(st, ts, pmr), ts ?? null, game ?? null, start ?? null]);
        if (!top || counted > top.pts) top = { pid, pts: counted };
        if (!wtop || wk > wtop.pts) wtop = { pid, pts: wk };
      }
      if (rows.length) { scores[id] = rows; st.week = ro.week; st.topPid = top.pid; st.topPts = top.pts; st.weekTopPid = wtop.pid; st.weekTopPts = wtop.pts; }
    }
    status[id] = st;
    if (hist.length) history[id] = hist;
  }
  // opponent rosters (mine included) for the pods in scope, in the dashboard's compact shape
  // weekly (when the snapshot has the computed week-by-week breakdown, see pubscore.js foldWeeks): every array is
  // indexed like weekly.weeks — teams { cid: { entryKey: [team score per week] } }, players[i] = points per week of
  // opp.players[i]; each opp row then ends with the slots he filled, one letter per week (Q R W T F, B = bench)
  const players = [], pidx = new Map();
  const opp = { players, rosters: {} };
  const wk = snap.weekly?.weeks?.length ? snap.weekly : null;
  const weekly = wk ? { weeks: wk.weeks, teams: {}, players: [] } : null;
  for (const cid of cids) {
    if (snap.pods[cid]) pods[cid] = snap.pods[cid];
    if (snap.rostersAt[cid]) rostersAt[cid] = snap.rostersAt[cid];
    const byKey = snap.rosters[cid]; if (!byKey) continue;
    const dgid = [...ids].map((id) => (String(cidOf(id)) === String(cid) ? dgOf(id) : null)).find((x) => x != null);
    const out = {};
    for (const [key, ro] of Object.entries(byKey)) {
      const list = [];
      for (const [did, slot, wkPts, bench, , baseCounted, pmr, st, ts, game, start] of ro.cards) {
        const d = draftable(dgid, did); if (!d) continue;
        const pk = `${d[1]}|${d[2]}|${d[3]}`;
        if (!pidx.has(pk)) { pidx.set(pk, players.length); players.push([d[1], d[2], d[3]]); if (weekly) weekly.players.push(wk.players?.[d[0]] ?? null); }
        const row = [pidx.get(pk), slot, wkPts, r2(baseCounted + (bench ? 0 : wkPts)), pmr ?? null, gameSt(st, ts, pmr), ts ?? null, game ?? null, start ?? null];
        if (weekly) row.push(wk.teams?.[cid]?.[key]?.s?.[did] ?? null);
        list.push(row);
      }
      if (list.length) out[key] = list;
      if (weekly && wk.teams?.[cid]?.[key]?.t) (weekly.teams[cid] ??= {})[key] = wk.teams[cid][key].t;
    }
    if (Object.keys(out).length) opp.rosters[cid] = out;
  }
  return { at: snap.at, week: snap.week, status, scores, pods, opp, history, rostersAt, weekly, stats: snap.stats ?? null };
}
