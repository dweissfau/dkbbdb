// The pause switch (2026-09-28). With DKBBDB_PAUSED set in the deployment's environment, the public site is closed
// while DraftKings reviews the way the extension reads teams:
//   • every page becomes /paused (the holding page); /privacy stays up
//   • the extension download is refused, and the API answers 503 { error } — the extension shows that message
//     instead of uploading; only the scoring job's /api/board, the weekly /api/cron and /api/admin keep working
//   • ?unlock=<DKBBDB_PAUSE_KEY> on any address sets a cookie that opens the whole site for that browser (the owner,
//     and anyone at DraftKings who is given the link)
// Nothing is deleted and the scoring keeps running underneath. Unpause: remove DKBBDB_PAUSED and redeploy.
import { next, rewrite } from "@vercel/functions/middleware";

const OPEN_API = new Set(["/api/board", "/api/cron", "/api/admin"]);
const OPEN_PAGES = new Set(["/paused", "/privacy"]);
const ASSET = /\.(css|js|svg|png|ico|txt|xml|webmanifest)$/;
const COOKIE = "dkbbdb-unlock";

export default function middleware(req) {
  if (!process.env.DKBBDB_PAUSED) return next();
  const url = new URL(req.url), p = url.pathname;
  const key = process.env.DKBBDB_PAUSE_KEY || "";

  if (key && url.searchParams.get("unlock") === key) {
    url.searchParams.delete("unlock");
    return new Response(null, { status: 302, headers: { location: url.pathname + url.search, "set-cookie": `${COOKIE}=${key}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" } });
  }
  if (key && (req.headers.get("cookie") ?? "").split(/;\s*/).includes(`${COOKIE}=${key}`)) return next();

  if (p.startsWith("/api/")) {
    if (OPEN_API.has(p)) return next();
    return new Response(JSON.stringify({ error: "dkbbdb is paused while DraftKings reviews it — nothing was uploaded" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  if (p.endsWith(".zip")) return new Response("dkbbdb is paused", { status: 503, headers: { "cache-control": "no-store" } });
  if (OPEN_PAGES.has(p) || ASSET.test(p)) return next();
  url.pathname = "/paused"; url.search = "";
  return rewrite(url, { headers: { "cache-control": "no-store" } });
}
