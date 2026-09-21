// Attack tests for the open upload, against the real database (everything it writes is removed again).
//   node scripts/check-guard.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { connect, ROOT } from "./db.mjs";
import { compactStatus, ingestDrafts } from "../lib/ingest.js";
import { LIMITS, checkDraft } from "../lib/guard.js";

const lite = new (createRequire(path.join(ROOT, "..", "package.json"))("better-sqlite3"))(path.join(ROOT, "..", "data", "portfolio.sqlite"), { readonly: true });
const db = await connect();
const SENDER = "test-guard-" + Date.now();
const checks = [];
const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const real = lite.prepare("select my_username u, raw_contest c, raw_draft_status s from drafts").all().map((r) => ({ u: r.u, d: { contest: JSON.parse(r.c), ...compactStatus(JSON.parse(r.s)) } }));
const clone = (x) => structuredClone(x);
const counts = async () => (await db.query("select (select count(*) from entries)::int e, (select count(*) from pod_teams)::int t, (select count(*) from contests)::int c, (select count(*) from dk_accounts)::int a, (select count(*) from draftables)::int d")).rows[0];
const before = await counts();

try {
  // 1. no false alarms: every real draft passes
  const bad = real.map((r) => checkDraft(r.d)).filter(Boolean);
  ok(`all ${real.length} real drafts pass the plausibility checks`, bad.length === 0, bad.slice(0, 2).join(" | "));

  // 2. forged boards are turned away
  const base = real.find((r) => r.u === "ZBbih").d;
  const forge = (fn) => { const d = clone(base); fn(d); return checkDraft(d); };
  const made = base.board.filter((p) => p[1] != null);
  ok("same player drafted twice", forge((d) => { const m = d.board.filter((p) => p[1] != null); m[1][1] = m[0][1]; m[1][2] = m[0][2]; }));
  ok("pick numbers that do not add up", forge((d) => { d.board[5][5] = 999; }));
  ok("a 13th drafter", forge((d) => { d.users.push(["extra-key", "extra"]); }));
  ok("a drafter picking twice in a round", forge((d) => { d.board[1][0] = d.board[0][0]; }));
  ok("lineup that is not on the board", forge((d) => { d.lineup = [1, 2, 3]; }));
  ok("absurd buy-in", forge((d) => { d.contest.BuyInAmount = 5e6; }));

  // 3. a well-formed board full of players DraftKings never listed (fresh contest + entry ids)
  const fake = clone(base); fake.contest.ContestId = 990000001; fake.contest.UserContestId = 990000002;
  fake.users = fake.users.map(([k, n], i) => [`fake-${i}`, `fakeuser${i}`]);
  let n = 880000000; const map = new Map();
  for (const p of fake.board) if (p[1] != null) { map.set(p[1], ++n); p[1] = n; p[2] = n; }
  fake.lineup = fake.lineup.map((x) => map.get(x));
  let r = await ingestDrafts(db, { drafts: [fake], last: true }, { sender: SENDER });
  ok("made-up players are rejected", r.drafts === 0 && r.rejected === 1, r.errors[0]);

  // 4. impersonation: real players, my own account id, somebody else's username
  const imp = clone(base); imp.contest.ContestId = 990000003; imp.contest.UserContestId = 990000004;
  const me = imp.board.find((p) => imp.lineup.includes(p[1]))[0];
  imp.users = imp.users.map(([k, name], i) => [i === me ? "attacker-key" : `imp-${i}`, name]); // keeps the username "ZBbih" on a new account id
  r = await ingestDrafts(db, { drafts: [imp], last: true }, { sender: SENDER });
  ok("a second account cannot claim an existing username", r.drafts === 0 && /already registered/.test(r.errors.join()), r.errors[0]);

  // 5. nothing stored can be changed: re-upload a real pod with two teams' players swapped, a new contest name and renamed opponents
  const cid = base.contest.ContestId;
  const stored = async () => JSON.stringify((await db.query("select user_key, username, draftable_ids from pod_teams where contest_id = $1 order by user_key", [cid])).rows) +
    JSON.stringify((await db.query("select name, entrants, buy_in from contests where contest_id = $1", [cid])).rows);
  const was = await stored();
  const tam = clone(base); tam.contest.ContestName = "HACKED"; tam.contest.BuyInAmount = 1;
  tam.users = tam.users.map(([k, name]) => [k, name === "ZBbih" ? name : "renamed_" + name.slice(0, 20)]);
  const m = tam.board.filter((p) => p[1] != null); [m[0][1], m[1][1]] = [m[1][1], m[0][1]]; [m[0][2], m[1][2]] = [m[1][2], m[0][2]];
  tam.lineup = tam.board.filter((p) => p[0] === tam.board.find((q) => base.lineup.includes(q[1]))[0] && p[1] != null).map((p) => p[1]);
  r = await ingestDrafts(db, { drafts: [tam], last: true }, { sender: SENDER });
  ok("a tampered re-upload changes nothing that is stored", (await stored()) === was, `accepted as ${r.drafts} draft, rosters / names / contest identical`);

  // 6. player lists cannot be overwritten
  const dg = base.contest.DraftGroupId, did = made[0][1];
  const nameWas = (await db.query("select name from draftables where draft_group_id = $1 and draftable_id = $2", [dg, did])).rows[0].name;
  await ingestDrafts(db, { drafts: [], draftables: { [dg]: [[did, 1, "HACKED NAME", "QB", "XXX"]] }, last: true }, { sender: SENDER });
  ok("an uploaded player list cannot rename a player", (await db.query("select name from draftables where draft_group_id = $1 and draftable_id = $2", [dg, did])).rows[0].name === nameWas, nameWas);

  // 7. rate limits
  await db.query(`insert into upload_log (sender, drafts) select $1, 1 from generate_series(1, $2)`, [SENDER + "-flood", LIMITS.uploadsPerHour]);
  r = await ingestDrafts(db, { drafts: [clone(base)] }, { sender: SENDER + "-flood" });
  ok(`sender is cut off after ${LIMITS.uploadsPerHour} uploads in an hour`, !!r.limited, r.limited);
  await db.query(`insert into upload_log (sender, user_keys) select $1, array['k' || g] from generate_series(1, $2) g`, [SENDER + "-many", LIMITS.accountsPerDay]);
  const fresh = clone(base); fresh.contest.ContestId = 990000005; fresh.contest.UserContestId = 990000006;
  fresh.users = fresh.users.map(([k, name], i) => [`many-${i}`, `manyuser${i}`]);
  r = await ingestDrafts(db, { drafts: [fresh] }, { sender: SENDER + "-many" });
  ok(`one sender cannot bring more than ${LIMITS.accountsPerDay} accounts a day`, r.drafts === 0 && /Too many different/.test(r.errors.join()), r.errors[0]);

  const after = await counts();
  ok("the database holds exactly what it held before", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
} finally {
  await db.query("delete from upload_log where sender like $1", [SENDER + "%"]);
  await db.query("delete from entries where entry_id between 990000000 and 990000999");
  await db.query("delete from contests where contest_id between 990000000 and 990000999");
  await db.query("delete from dk_accounts where user_key in ('attacker-key') or user_key like 'many-%' or user_key like 'fake-%' or user_key like 'imp-%'");
  await db.end();
}
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
