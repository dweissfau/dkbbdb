// Keep sleeper_map (DK playerId → Sleeper id) filled for every rostered player. Used by the local
// script (scripts/map-sleeper.mjs) and by the server after a sync brings in players it has not seen.
import { buildSleeperMap } from "./pubscore.js";
import { fetchJson } from "./feeds.js";

export const SLEEPER_PLAYERS = "https://api.sleeper.app/v1/players/nfl"; // ~14 MB — fetch sparingly

// onlyMissing: map just the rostered players that have no row yet (after a sync); otherwise refresh all
export async function mapSleeper(db, { list = null, aliases = {}, onlyMissing = true } = {}) {
  const { rows: players } = await db.query(
    `select distinct on (d.player_id) d.player_id pid, d.name, d.position pos, d.team
       from pod_teams t join contests c on c.contest_id = t.contest_id
       join draftables d on d.draft_group_id = c.draft_group_id and d.draftable_id = any(t.draftable_ids)
      where d.player_id is not null ${onlyMissing ? "and not exists (select 1 from sleeper_map m where m.player_id = d.player_id)" : ""}
      order by d.player_id`);
  if (!players.length) return { mapped: 0, unmatched: [] };
  list ??= await fetchJson(SLEEPER_PLAYERS, 30e3);
  const { map, unmatched } = buildSleeperMap(players, list, aliases);
  const ids = Object.keys(map).map(Number);
  if (ids.length) {
    await db.query(
      `insert into sleeper_map (player_id, sleeper_id, team)
       select * from unnest($1::int[], $2::text[], $3::text[])
       on conflict (player_id) do update set sleeper_id = excluded.sleeper_id, team = excluded.team, updated_at = now()`,
      [ids, ids.map((i) => map[i][0]), ids.map((i) => map[i][1])]);
  }
  return { mapped: ids.length, unmatched };
}
