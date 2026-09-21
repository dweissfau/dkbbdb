// One-off: load the single-user SQLite portfolio (../data/portfolio.sqlite) into the multi-user database.
// Every DK username becomes its own unclaimed site user, so the three synced accounts act as the first
// three tenants. Pods come from drafts.raw_draft_status (the draft board holds all 12 teams) — the same
// payload the extension will upload — and are cross-checked against the old opponent_rosters sync.
import path from "node:path";
import { createRequire } from "node:module";
import { connect, ROOT } from "./db.mjs";

const require = createRequire(path.join(ROOT, "..", "package.json"));
const Database = require("better-sqlite3");
const lite = new Database(path.join(ROOT, "..", "data", "portfolio.sqlite"), { readonly: true });
const db = await connect();

// the 12 teams of a pod, from one draftStatus payload
export function podTeams(ds) {
  const names = new Map((ds.users ?? []).map((u) => [u.userKey, { username: u.displayName }]));
  const teams = new Map();
  const board = [...(ds.draftBoard ?? [])].sort((a, b) => a.overallSelectionNumber - b.overallSelectionNumber);
  for (const p of board) {
    if (!p.userKey) continue;
    let t = teams.get(p.userKey);
    if (!t) teams.set(p.userKey, t = { userKey: p.userKey, ...(names.get(p.userKey) ?? {}), dids: [], picks: [] });
    if (p.roundNumber === 1) t.seat = p.selectionNumber; // draft slot = where he picked in round 1
    if (p.draftableId == null || p.playerId == null) continue; // pre-allocated slot, pick not made yet
    t.dids.push(p.draftableId);
    t.picks.push(p.overallSelectionNumber);
  }
  return [...teams.values()];
}

const drafts = lite.prepare("select * from drafts").all();
const userIds = new Map(); // dk username → users.id
let pods = 0, teams = 0, mismatched = 0, checked = 0;

await db.query("begin");
for (const d of drafts) {
  const rc = JSON.parse(d.raw_contest || "{}");
  const ds = JSON.parse(d.raw_draft_status || "{}");

  if (!userIds.has(d.my_username)) {
    const found = await db.query(
      "select u.id from users u join dk_accounts a on a.user_id = u.id where a.user_key = $1", [d.my_user_key]);
    const id = found.rows[0]?.id ??
      (await db.query("insert into users (email) values ($1) returning id", [`legacy:${d.my_username}`])).rows[0].id;
    await db.query(
      "insert into dk_accounts (user_key, user_id, username) values ($1,$2,$3) on conflict (user_key) do nothing",
      [d.my_user_key, id, d.my_username]);
    userIds.set(d.my_username, id);
  }

  await db.query(
    `insert into contests (contest_id, name, tournament_key, mega_contest_id, round, draft_group_id, buy_in,
       prize_pool, entrants, positions_paid, draft_state, draft_date, start_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (contest_id) do update set draft_state = excluded.draft_state, updated_at = now()`,
    [d.contest_id, d.contest_name, d.tournament_key, d.mega_contest_id, rc.MegaContestRoundNumber ?? null,
      d.draft_group_id, d.buy_in, d.total_prize_pool, d.draft_size, rc.PositionsPaid || null, d.draft_state,
      d.draft_date, d.contest_start_date]);
  pods++;

  const old = lite.prepare(
    `select p.user_name, group_concat(o.draftable_id) dids from pod_standings p
       join opponent_rosters o on o.contest_id = p.contest_id and o.entry_key = p.entry_key
      where p.contest_id = ? and o.week = (select max(week) from opponent_rosters where contest_id = ?)
      group by p.entry_key`).all(d.contest_id, d.contest_id);
  const oldByName = new Map(old.map((r) => [r.user_name, r.dids.split(",").map(Number).sort((a, b) => a - b).join()]));

  for (const t of podTeams(ds)) {
    const mine = t.userKey === d.my_user_key;
    await db.query(
      `insert into pod_teams (contest_id, user_key, username, seat, entry_key, draftable_ids, pick_numbers)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (contest_id, user_key) do update set username = excluded.username,
         entry_key = coalesce(excluded.entry_key, pod_teams.entry_key),
         draftable_ids = excluded.draftable_ids, pick_numbers = excluded.pick_numbers`,
      [d.contest_id, t.userKey, t.username ?? null, t.seat ?? null, mine ? d.entry_id : null, t.dids, t.picks]);
    teams++;
    // does the draft board give the same 20 players the old leaderboard + roster sync found?
    const was = oldByName.get(t.username);
    if (was) {
      checked++;
      if (was !== [...t.dids].sort((a, b) => a - b).join()) {
        mismatched++;
        if (mismatched <= 5) console.log("  roster differs:", d.contest_id, t.username, t.dids.length, "picks vs", was.split(",").length);
      }
    }
  }

  const st = lite.prepare("select contest_state, prizes from entry_status where entry_id = ?").get(d.entry_id);
  await db.query(
    `insert into entries (entry_id, user_id, user_key, contest_id, state, prizes) values ($1,$2,$3,$4,$5,$6)
     on conflict (entry_id) do update set state = excluded.state, prizes = excluded.prizes, synced_at = now()`,
    [d.entry_id, userIds.get(d.my_username), d.my_user_key, d.contest_id, st?.contest_state ?? null, st?.prizes ?? null]);
}

// player lists: batch insert
const dr = lite.prepare("select * from draftables").all();
const adp = new Map(lite.prepare("select draft_group_id g, player_id p, adp from pool").all().map((r) => [`${r.g}:${r.p}`, r.adp]));
for (let i = 0; i < dr.length; i += 500) {
  const chunk = dr.slice(i, i + 500);
  const vals = [], args = [];
  chunk.forEach((r, j) => {
    const b = j * 7;
    vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
    args.push(r.draft_group_id, r.draftable_id, r.player_id, r.name, r.position, r.team, adp.get(`${r.draft_group_id}:${r.player_id}`) ?? null);
  });
  await db.query(
    `insert into draftables (draft_group_id, draftable_id, player_id, name, position, team, adp) values ${vals.join(",")}
     on conflict (draft_group_id, draftable_id) do update set name = excluded.name, position = excluded.position,
       team = excluded.team, adp = coalesce(excluded.adp, draftables.adp)`, args);
}
await db.query("commit");

console.log(`users ${userIds.size} (${[...userIds.keys()].join(", ")}) · pods ${pods} · teams ${teams} · draftables ${dr.length}`);
console.log(`cross-check vs old opponent sync: ${checked} teams compared, ${mismatched} differ`);
await db.end();
