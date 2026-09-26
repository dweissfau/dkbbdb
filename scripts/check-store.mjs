// The store file (lib/store.js) built from the database must carry exactly what the database paths produce: the
// scoring base (lib/base.js), the pop-up data (lib/portfolio.js), the owner look-up (lib/accounts.js) and the board
// run's inputs. Reads the database ONCE (~the size of the data); writes nothing.
//   node scripts/check-store.mjs
import { gzipSync } from "node:zlib";
import { connect, loadEnv } from "./db.mjs";
import { buildStore, baseOf, entryOwner, portfolioOf, boardInputs } from "../lib/store.js";
import { buildBase } from "../lib/base.js";
import { userPortfolio } from "../lib/portfolio.js";
import { resolveEntry } from "../lib/accounts.js";

process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const db = await connect();
const checks = []; const ok = (n, c, x = "") => { checks.push(!!c); console.log(c ? "  ok  " : "  FAIL", n, x); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const t0 = Date.now(), store = await buildStore(db), ms = Date.now() - t0, gz = gzipSync(Buffer.from(JSON.stringify(store)));
ok("store built", store.accounts.length >= 2 && Object.keys(store.entries).length > 0 && Object.keys(store.pods).length > 0, `${store.accounts.length} accounts, ${Object.keys(store.entries).length} entries, ${Object.keys(store.pods).length} pods, ${(gz.length / 1e6).toFixed(2)} MB gz, ${ms} ms`);

// the scoring base for everyone, and for one account, equals lib/base.js's
const keys = store.accounts.map((a) => a.k);
const full = await buildBase(db, keys), fromStore = baseOf(store);
const stripPk = (pods) => Object.fromEntries(Object.entries(pods).map(([cid, p]) => [cid, { ...p, rosters: Object.fromEntries(Object.entries(p.rosters).map(([k, r]) => [k, { u: r.u, d: r.d, s: r.s }])) }]));
const stripAdp = (dr) => Object.fromEntries(Object.entries(dr).map(([g, m]) => [g, Object.fromEntries(Object.entries(m).map(([d, v]) => [d, v.slice(0, 4)]))]));
ok("base: entries match", same(full.entries, fromStore.entries), `${Object.keys(full.entries).length}`);
ok("base: contests match", same(full.contests, fromStore.contests));
ok("base: pods match (every roster, every seat)", same(full.pods, stripPk(fromStore.pods)), `${Object.keys(full.pods).length} pods`);
ok("base: draftables match", same(full.draftables, stripAdp(fromStore.draftables)));
ok("base: sleeper map matches", same(full.sleeper, fromStore.sleeper), `${Object.keys(full.sleeper).length} players`);
const one = store.accounts.find((a) => a.u === "fleaflick") ?? store.accounts[0];
const mine = await buildBase(db, [one.k]), mineS = baseOf(store, [one.k]);
ok("base for one account matches", same(mine.entries, mineS.entries) && same(mine.contests, mineS.contests) && same(mine.pods, stripPk(mineS.pods)), `${one.u}: ${Object.keys(mine.entries).length} teams`);
const id = Object.keys(mine.entries)[0];
const only = await buildBase(db, [one.k], Date.now(), [id]), onlyS = baseOf(store, [one.k], [id]);
ok("base for one team matches", same(only.entries, onlyS.entries) && same(only.pods, stripPk(onlyS.pods)));

// the pop-up
const own = await resolveEntry(db, id), ownS = entryOwner(store, id);
ok("owner look-up matches", same(own, ownS) && entryOwner(store, "1") === null && entryOwner(store, "abc") === null, JSON.stringify(ownS));
const pf = await userPortfolio(db, [one.k], [id]), pfS = portfolioOf(store, [one.k], [id]);
const norm = (p) => ({ drafts: p.drafts, picks: p.picks, players: p.players, meta: { ...p.meta, syncedAt: p.meta.syncedAt } });
ok("pop-up data matches (drafts, picks, players)", same(norm(pf), norm(pfS)), `${pfS.drafts.length} draft, ${pfS.picks.length} picks, ${Object.keys(pfS.players).length} players`);
const pfAll = await userPortfolio(db, [one.k]), pfAllS = portfolioOf(store, [one.k]);
ok("whole-account pop-up data matches", same(norm(pfAll), norm(pfAllS)), `${pfAllS.drafts.length} drafts`);

// the board run's inputs
const bi = boardInputs(store);
const metaDb = new Map((await db.query(
  `select e.entry_id, e.user_key, e.prizes, c.name, c.buy_in, c.draft_date, c.tournament_key, c.round, t.draftable_ids, t.pick_numbers
     from entries e join contests c on c.contest_id = e.contest_id left join pod_teams t on t.contest_id = e.contest_id and t.user_key = e.user_key`)).rows.map((x) => [String(x.entry_id), x]));
let diff = 0;
for (const [eid, m] of metaDb) {
  const s = bi.meta.get(eid);
  const eq = s && s.user_key === m.user_key && Number(s.prizes ?? 0) === Number(m.prizes ?? 0) && s.name === m.name && Number(s.buy_in ?? -1) === Number(m.buy_in ?? -1)
    && (s.draft_date ?? null) === (m.draft_date ? new Date(m.draft_date).toISOString() : null) && (s.tournament_key ?? null) === (m.tournament_key ? String(m.tournament_key).toUpperCase() : null)
    && s.round === (m.round ?? 1) && same(s.draftable_ids, m.draftable_ids ?? []) && same(s.pick_numbers, m.pick_numbers ?? null);
  if (!eq) diff++;
}
ok("board inputs: per-team facts match the database for every team", diff === 0 && bi.meta.size === metaDb.size, `${bi.meta.size} teams, ${diff} differ`);
ok("board inputs: accounts and ladders", bi.accounts.length === store.accounts.length && bi.ladders.size === Object.keys(store.ladders).length, `${bi.ladders.size} ladders`);

await db.end();
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
