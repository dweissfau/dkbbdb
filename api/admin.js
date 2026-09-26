// /api/admin — the owner's tools. Needs the ADMIN_KEY (deployment env + .env.local), as the header x-admin-key or
// ?key=. Nothing here is served without it; the page is public/admin.html.
//   GET  (no action)          who has signed up: every synced account with its teams, entry fees, syncs, uploads;
//                             the recent upload log; teams per tournament
//   GET  ?publish=1           rebuild store/base.json.gz from the uploaded files (lib/store.js publishStore)
//   GET  ?files=1             list every data file (backups)      GET ?file=<path>   one file, gzip'd, as stored
//   POST ?import=<table>[&part=n]   a table of the old database (JSON rows, gzip'd, base64 text body) → import/<table>[.n]
//   GET  ?remove=<username>   take an account off the site (scripts/remove-account.mjs)
//   GET  ?migrate=1           turn the imported tables into the site's files (lib/migrate.js), then publish
import { timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { getGz, putGz, listFiles, delFile, updateGz } from "../lib/files.js";
import { PATHS, loadStore, publishStore } from "../lib/store.js";
import { shortContest } from "../lib/leaderboard.js";
import { allUploads } from "../lib/guard.js";
import { filesFromTables } from "../lib/migrate.js";

export const config = { maxDuration: 300, api: { bodyParser: { sizeLimit: "4.5mb" } } };
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const key = process.env.ADMIN_KEY ?? "", given = String(req.headers["x-admin-key"] ?? req.query.key ?? "");
  if (!key || !given || !same(key, given)) return res.status(401).json({ error: "unauthorized" });
  try {
    if (req.query.publish === "1") return res.status(200).json({ ok: true, published: await publishStore() });
    if (req.query.files === "1") return res.status(200).json({ ok: true, files: [...(await listFiles("data/")), ...(await listFiles("store/"))] });
    if (req.query.file) {
      const p = String(req.query.file);
      if (!/^(data|store)\/[A-Za-z0-9_./-]+\.json\.gz$/.test(p) || p.includes("..")) return res.status(400).json({ error: "bad path" });
      const r = await getGz(p); if (!r) return res.status(404).json({ error: "no such file" });
      return res.status(200).json({ ok: true, path: p, etag: r.etag, value: r.value });
    }
    if (req.query.import) {
      if (req.method !== "POST") return res.status(405).json({ error: "POST the table" });
      const table = String(req.query.import); if (!/^[a-z_]{1,40}$/.test(table)) return res.status(400).json({ error: "bad table name" });
      const b64 = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : String(req.body ?? "");
      const rows = JSON.parse(gunzipSync(Buffer.from(b64.replace(/\s+/g, ""), "base64")).toString());
      if (!Array.isArray(rows)) return res.status(400).json({ error: "rows[] expected" });
      const part = req.query.part ? `.${String(req.query.part).replace(/[^0-9]/g, "")}` : "";
      await putGz(`import/${table}${part}.json.gz`, rows);
      return res.status(200).json({ ok: true, table, part: part || null, rows: rows.length });
    }
    if (req.query.remove) { // take an account off the site: its file and its rank history; the store is rebuilt without it
      const store = await loadStore(), a = store?.accounts.find((x) => String(x.u).toLowerCase() === String(req.query.remove).toLowerCase());
      if (!a) return res.status(404).json({ error: "no such account" });
      const ids = new Set(Object.entries(store.entries).filter(([, e]) => e.u === a.k).map(([id]) => id));
      await delFile(PATHS.account(a.k));
      await updateGz(PATHS.history, (h) => { if (!h) return undefined; for (const id of ids) delete h[id]; return h; });
      return res.status(200).json({ ok: true, removed: a.u, teams: ids.size, published: await publishStore() });
    }
    if (req.query.migrate === "1") {
      const T = {};
      for (const f of await listFiles("import/")) {
        const m = /^import\/([a-z_]+)(?:\.([0-9]+))?\.json\.gz$/.exec(f.pathname); if (!m) continue;
        (T[m[1]] ??= []).push(...((await getGz(f.pathname))?.value ?? []));
      }
      const written = await filesFromTables(T);
      const published = await publishStore();
      return res.status(200).json({ ok: true, tables: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.length])), written, published });
    }

    // the overview
    const store = await loadStore();
    const uploads = await allUploads(40);
    const perKey = new Map();
    for (const u of uploads) for (const k of u.userKeys ?? []) { const p = perKey.get(k) ?? { uploads: 0, rejected: 0, ext: null }; p.uploads++; p.rejected += u.rejected ?? 0; p.ext ??= u.ext; perKey.set(k, p); }
    const accounts = (store?.accounts ?? []).map((a) => {
      const mine = Object.entries(store.entries).filter(([, e]) => e.u === a.k);
      const fees = mine.reduce((s, [, e]) => s + (store.contests[e.cid]?.buyIn ?? 0), 0);
      const names = new Set(mine.map(([, e]) => store.contests[e.cid]?.name)), p = perKey.get(a.k) ?? {};
      return { username: a.u, created_at: a.createdAt, synced_at: a.syncedAt, teams: mine.length, fees, tournaments: names.size,
        last_entry: mine.reduce((m, [, e]) => (e.syncedAt && (!m || e.syncedAt > m) ? e.syncedAt : m), null), uploads: p.uploads ?? 0, rejected: p.rejected ?? 0, ext: p.ext ?? null };
    }).sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    const byName = new Map();
    for (const e of Object.values(store?.entries ?? {})) { const n = store.contests[e.cid]?.name; const r = byName.get(n) ?? { name: shortContest(n), teams: 0, accounts: new Set() }; r.teams++; r.accounts.add(e.u); byName.set(n, r); }
    const byContest = [...byName.values()].map((r) => ({ name: r.name, teams: r.teams, accounts: r.accounts.size })).sort((a, b) => b.teams - a.teams);
    const totals = { accounts: accounts.length, teams: accounts.reduce((s, a) => s + a.teams, 0), fees: accounts.reduce((s, a) => s + a.fees, 0),
      today: accounts.filter((a) => a.created_at && Date.now() - new Date(a.created_at) < 86400e3).length, week: accounts.filter((a) => a.created_at && Date.now() - new Date(a.created_at) < 7 * 86400e3).length };
    res.status(200).json({ at: new Date().toISOString(), totals, accounts, uploads: uploads.map((u) => ({ at: u.at, ext: u.ext, usernames: u.usernames, drafts: u.drafts, refreshed: u.refreshed, skipped: u.skipped, rejected: u.rejected, note: u.note })), byContest, store: store ? { at: store.at, accounts: store.accounts.length } : null });
  } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
