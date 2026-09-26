// Keep data/sleeper.json.gz (DK playerId → [Sleeper id, team]) filled for every rostered player. Used by the
// server after a sync brings in players it has not seen, and by scripts/map-sleeper.mjs.
import { buildSleeperMap } from "./pubscore.js";
import { fetchJson } from "./feeds.js";
import { getGz, putGz } from "./files.js";
import { PATHS, rosteredPlayers } from "./store.js";

export const SLEEPER_PLAYERS = "https://api.sleeper.app/v1/players/nfl"; // ~14 MB — fetch sparingly

// store = the assembled store (lib/store.js buildStore / loadStore) — its rosters say which players matter.
// onlyMissing: map just the rostered players with no entry yet (after a sync); otherwise refresh all
export async function mapSleeper(store, { list = null, aliases = {}, onlyMissing = true } = {}) {
  const have = (await getGz(PATHS.sleeper))?.value ?? {};
  const players = rosteredPlayers(store).filter((p) => !onlyMissing || !have[p.pid]);
  if (!players.length) return { mapped: 0, unmatched: [] };
  list ??= await fetchJson(SLEEPER_PLAYERS, 30e3);
  const { map, unmatched } = buildSleeperMap(players, list, aliases);
  const ids = Object.keys(map);
  if (ids.length) { for (const id of ids) have[id] = [map[id][0], map[id][1]]; await putGz(PATHS.sleeper, have); }
  return { mapped: ids.length, unmatched };
}
