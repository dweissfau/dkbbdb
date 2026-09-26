// Attack tests for the open upload, against the LOCAL file store (dkbbdb/.blob/ — everything they write is removed again).
//   node scripts/check-guard.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
import { compactStatus, ingestDrafts } from "../lib/ingest.js";
import { LIMITS, checkDraft } from "../lib/guard.js";
import { getGz, putGz, delFile, listFiles, backend } from "../lib/files.js";
import { PATHS, loadStore, _forgetStore } from "../lib/store.js";

if (backend() !== "local") { console.error("local file store only"); process.exit(1); }
const lite = new (createRequire(path.join(ROOT, "..", "package.json"))("better-sqlite3"))(path.join(ROOT, "..", "data", "portfolio.sqlite"), { readonly: true });
const SENDER = "test-guard-" + Date.now();
const checks = [];
const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const real = lite.prepare("select my_username u, raw_contest c, raw_draft_status s from drafts").all().map((r) => ({ u: r.u, d: { contest: JSON.parse(r.c), ...compactStatus(JSON.parse(r.s)) } }));
const clone = (x) => structuredClone(x);
const store = await loadStore();
const zb = store.accounts.find((a) => a.u === "ZBbih");
const zbFile = await getGz(PATHS.account(zb.k));
const counts = async () => ({ accounts: (await listFiles(PATHS.accounts)).length, groups: (await listFiles(PATHS.groups)).length, entries: Object.keys((await getGz(PATHS.account(zb.k)))?.value?.entries ?? {}).length });
const before = await counts();
const testFiles = async () => (await listFiles("data/")).filter((f) => /accounts\/(attacker-key|many-|fake-|imp-)|uploads\/test-guard-/.test(f.pathname)).map((f) => f.pathname);

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
  let r = await ingestDrafts({ drafts: [fake], last: true }, { sender: SENDER });
  ok("made-up players are rejected", r.drafts === 0 && r.rejected === 1, r.errors[0]);

  // 4. impersonation: real players, my own account id, somebody else's username
  const imp = clone(base); imp.contest.ContestId = 990000003; imp.contest.UserContestId = 990000004;
  const me = imp.board.find((p) => imp.lineup.includes(p[1]))[0];
  imp.users = imp.users.map(([k, name], i) => [i === me ? "attacker-key" : `imp-${i}`, name]); // keeps the username "ZBbih" on a new account id
  r = await ingestDrafts({ drafts: [imp], last: true }, { sender: SENDER });
  ok("a second account cannot claim an existing username", r.drafts === 0 && /already registered/.test(r.errors.join()), r.errors[0]);

  // 5. nothing stored can be changed: re-upload a real pod with two teams' players swapped, a new contest name and renamed opponents
  const cid = String(base.contest.ContestId);
  const stored = async () => { const a = (await getGz(PATHS.account(zb.k))).value; const c = a.contests[cid], p = a.pods[cid];
    return JSON.stringify([c.name, c.entrants, c.buyIn, Object.entries(p.rosters).sort().map(([k, r]) => [k, r.u, r.d])]); };
  const was = await stored();
  const tam = clone(base); tam.contest.ContestName = "HACKED"; tam.contest.BuyInAmount = 1;
  tam.users = tam.users.map(([k, name]) => [k, name === "ZBbih" ? name : "renamed_" + name.slice(0, 20)]);
  const m = tam.board.filter((p) => p[1] != null); [m[0][1], m[1][1]] = [m[1][1], m[0][1]]; [m[0][2], m[1][2]] = [m[1][2], m[0][2]];
  tam.lineup = tam.board.filter((p) => p[0] === tam.board.find((q) => base.lineup.includes(q[1]))[0] && p[1] != null).map((p) => p[1]);
  r = await ingestDrafts({ drafts: [tam], last: true }, { sender: SENDER });
  ok("a tampered re-upload changes nothing that is stored", (await stored()) === was, `accepted as ${r.drafts} draft, rosters / names / contest identical`);

  // 6. player lists cannot be overwritten
  const dg = base.contest.DraftGroupId, did = made[0][1];
  const nameOf = async () => (await getGz(PATHS.group(dg)))?.value?.players?.[did]?.[1];
  const nameWas = await nameOf();
  await ingestDrafts({ drafts: [], draftables: { [dg]: [[did, 1, "HACKED NAME", "QB", "XXX"]] }, last: true }, { sender: SENDER });
  ok("an uploaded player list cannot rename a player", (await nameOf()) === nameWas, nameWas);

  // 7. rate limits
  const now = new Date().toISOString();
  await putGz(PATHS.uploadLog(SENDER + "-flood"), Array.from({ length: LIMITS.uploadsPerHour }, () => ({ at: now, drafts: 1, userKeys: [] })));
  r = await ingestDrafts({ drafts: [clone(base)] }, { sender: SENDER + "-flood" });
  ok(`sender is cut off after ${LIMITS.uploadsPerHour} uploads in an hour`, !!r.limited, r.limited);
  await putGz(PATHS.uploadLog(SENDER + "-many"), Array.from({ length: LIMITS.accountsPerDay }, (_, g) => ({ at: now, drafts: 0, userKeys: ["k" + g] })));
  const fresh = clone(base); fresh.contest.ContestId = 990000005; fresh.contest.UserContestId = 990000006;
  fresh.users = fresh.users.map(([k, name], i) => [`many-${i}`, `manyuser${i}`]);
  r = await ingestDrafts({ drafts: [fresh] }, { sender: SENDER + "-many" });
  ok(`one sender cannot bring more than ${LIMITS.accountsPerDay} accounts a day`, r.drafts === 0 && /Too many different/.test(r.errors.join()), r.errors[0]);

  const after = await counts();
  ok("the store holds exactly what it held before (no new accounts, groups or teams)", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
} finally {
  for (const p of await testFiles()) await delFile(p);
  await putGz(PATHS.account(zb.k), zbFile.value); // the re-upload touched syncedAt
  _forgetStore();
}
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
