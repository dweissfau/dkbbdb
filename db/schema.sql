-- dkbbdb — multi-user schema (Postgres / Neon). Idempotent: safe to re-run.
-- Scores are NOT stored: they are computed on the server from public NFL stats (lib/pubscore.js),
-- so the database only has to know who drafted whom in which pod.

-- A DraftKings account whose owner synced it with the extension. There are no site accounts: like bbmdb,
-- anyone can look a username up — but ONLY usernames in this table (people who synced themselves), never
-- the opponents who merely appear in their pods.
create table if not exists dk_accounts (
  user_key    text primary key,         -- DK userKey (stable per DK account)
  username    text,
  created_at  timestamptz not null default now(),
  synced_at   timestamptz not null default now()
);
create index if not exists dk_accounts_username on dk_accounts (lower(username));

-- one row per pod (a DK "contest" is a single 12-team draft). Shared by every user in it.
create table if not exists contests (
  contest_id      bigint primary key,
  name            text,
  tournament_key  text,
  mega_contest_id bigint,
  round           int,
  draft_group_id  int,
  buy_in          numeric,
  prize_pool      numeric,
  entrants        int,
  positions_paid  int,                  -- advance cutoff in round contests (0/unknown → 2 for 12-team round 1)
  draft_state     text,
  draft_date      timestamptz,
  start_date      timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists contests_tournament on contests (tournament_key);

-- every team in the pod, from the draft board (one draftStatus call returns all 12)
create table if not exists pod_teams (
  contest_id     bigint not null references contests(contest_id) on delete cascade,
  user_key       text not null,
  username       text,
  seat           int,                   -- draft slot, 1-based
  entry_key      bigint,                -- DK entry id when known (always known for a synced account's own team)
  draftable_ids  int[] not null,        -- in pick order
  pick_numbers   int[] not null,        -- overall selection number, aligned with draftable_ids
  primary key (contest_id, user_key)
);
create index if not exists pod_teams_username on pod_teams (lower(username));

-- the synced accounts' own teams
create table if not exists entries (
  entry_id     bigint primary key,      -- DK UserContestId
  user_key     text not null references dk_accounts(user_key) on delete cascade,
  contest_id   bigint not null references contests(contest_id),
  state        text,                    -- upcoming | live | history
  prizes       numeric,                 -- official PrizesWon, when DK reports it
  synced_at    timestamptz not null default now()
);
create index if not exists entries_user_key on entries (user_key);
create index if not exists entries_contest on entries (contest_id);

-- public DK player list per draft group (names / positions / teams / ADP at sync time)
create table if not exists draftables (
  draft_group_id int not null,
  draftable_id   int not null,
  player_id      int,
  name           text,
  position       text,
  team           text,
  adp            numeric,
  primary key (draft_group_id, draftable_id)
);
create index if not exists draftables_player on draftables (player_id);

-- end-of-day rank per entry, keyed by NFL day (lib/live.js nflDay) — feeds the weekly Δ arrow
create table if not exists rank_history (
  entry_id  bigint not null references entries(entry_id) on delete cascade,
  day       date not null,
  rank      int,
  points    numeric,
  primary key (entry_id, day)
);

-- DK playerId → Sleeper player id (public stats feed) — filled by scripts/map-sleeper.mjs and on sync
create table if not exists sleeper_map (
  player_id   int primary key,
  sleeper_id  text not null,
  team        text,
  updated_at  timestamptz not null default now()
);

-- per-contest facts the pages show that the pod itself does not carry
alter table contests add column if not exists contest_type text;
alter table contests add column if not exists picks_total int;
