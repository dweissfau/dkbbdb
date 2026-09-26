// GET /api/admin — the owner's view of who has signed up: every synced account with its teams, entry fees, first and
// last sync, uploads and rejections, plus the recent upload log. Needs the ADMIN_KEY (deployment env + .env.local),
// as the header x-admin-key or ?key=. Nothing here is served without it; the page is public/admin.html.
import { timingSafeEqual } from "node:crypto";
import { db } from "../lib/db.js";
import { shortContest } from "../lib/leaderboard.js";
import { publishStore } from "../lib/store.js";

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const key = process.env.ADMIN_KEY ?? "", given = String(req.headers["x-admin-key"] ?? req.query.key ?? "");
  if (!key || !given || !same(key, given)) return res.status(401).json({ error: "unauthorized" });
  const d = db();
  if (req.query.publish === "1") { // rebuild the store file from the database (lib/store.js) — the owner's manual trigger
    try { return res.status(200).json({ ok: true, published: await publishStore(d) }); } catch (e) { return res.status(500).json({ error: String(e?.message ?? e) }); }
  }
  const accounts = (await d.query(
    `select a.username, a.created_at, a.synced_at,
            count(e.entry_id)::int teams, coalesce(sum(c.buy_in), 0)::float fees, count(distinct c.name)::int tournaments,
            max(e.synced_at) last_entry,
            (select count(*)::int from upload_log l where a.user_key = any(l.user_keys)) uploads,
            (select coalesce(sum(rejected), 0)::int from upload_log l where a.user_key = any(l.user_keys)) rejected,
            (select ext_version from upload_log l where a.user_key = any(l.user_keys) order by at desc limit 1) ext
       from dk_accounts a left join entries e on e.user_key = a.user_key left join contests c on c.contest_id = e.contest_id
      group by a.user_key, a.username, a.created_at, a.synced_at order by a.created_at desc`)).rows;
  const uploads = (await d.query(
    `select at, ext_version ext, usernames, drafts, refreshed, skipped, rejected, note from upload_log order by at desc limit 40`)).rows;
  const byContest = (await d.query(
    `select c.name, count(*)::int teams, count(distinct e.user_key)::int accounts from entries e join contests c on c.contest_id = e.contest_id group by c.name order by teams desc`)).rows
    .map((r) => ({ name: shortContest(r.name), teams: r.teams, accounts: r.accounts }));
  const totals = { accounts: accounts.length, teams: accounts.reduce((s, a) => s + a.teams, 0), fees: accounts.reduce((s, a) => s + a.fees, 0),
    today: accounts.filter((a) => Date.now() - new Date(a.created_at) < 86400e3).length, week: accounts.filter((a) => Date.now() - new Date(a.created_at) < 7 * 86400e3).length };
  res.status(200).json({ at: new Date().toISOString(), totals, accounts, uploads, byContest });
}
