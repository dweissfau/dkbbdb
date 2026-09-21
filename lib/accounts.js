// There are no site accounts: a portfolio is looked up by DraftKings username, and only usernames whose
// owner synced them (dk_accounts) resolve. One username = one DraftKings account = only that account's teams
// (accounts are never combined, and nothing like a partner share exists here).
export async function resolveAccounts(db, u) {
  const names = [String(u ?? "").split(",")[0].trim().toLowerCase()].filter(Boolean);
  if (!names.length) return [];
  return (await db.query(
    `select user_key, username, synced_at from dk_accounts where lower(username) = any($1::text[]) order by username`, [names])).rows;
}

// a single synced team (the front page's team pop-up): → { account, entryId } or null
export async function resolveEntry(db, entry) {
  const id = String(entry ?? "").trim();
  if (!/^[0-9]{1,18}$/.test(id)) return null;
  const row = (await db.query(
    `select a.user_key, a.username from entries e join dk_accounts a on a.user_key = e.user_key where e.entry_id = $1`, [id])).rows[0];
  return row ? { account: row, entryId: id } : null;
}

// usernames starting with q (synced accounts only), most teams first
export async function searchAccounts(db, q) {
  const s = String(q ?? "").trim().toLowerCase();
  if (s.length < 2) return [];
  return (await db.query(
    `select a.username, count(e.entry_id)::int teams from dk_accounts a left join entries e on e.user_key = a.user_key
      where starts_with(lower(a.username), $1) group by a.username order by (lower(a.username) = $1) desc, teams desc limit 8`, [s])).rows;
}
