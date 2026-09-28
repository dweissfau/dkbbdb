// Serve public/ locally the way Vercel does (clean URLs, the /u/<name> and /team/<id> rewrites) and proxy /api/* to a
// deployment — a protected preview when run through `vercel env run -- node scripts/dev-server.mjs <url>` (the CLI's
// short-lived token goes on the proxied requests and is never printed).
//   node scripts/dev-server.mjs [api base = https://dkbbdb.com] [port = 8787]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db.mjs";
const api = (process.argv[2] ?? "https://dkbbdb.com").replace(/\/$/, ""), port = Number(process.argv[3] ?? 8787);
const pub = path.join(ROOT, "public");
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml", json: "application/json" };
const page = (p) => p === "/" ? "index.html" : /^\/u\/[^/]+$/.test(p) ? "u.html" : /^\/team\/[^/]+$/.test(p) ? "app.html" : p.slice(1) + (path.extname(p) ? "" : ".html");
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/")) {
    const headers = { accept: "application/json" };
    if (process.env.VERCEL_OIDC_TOKEN) headers["x-vercel-trusted-oidc-idp-token"] = process.env.VERCEL_OIDC_TOKEN;
    const r = await fetch(api + u.pathname + u.search, { headers, method: req.method });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (u.pathname === "/" && u.searchParams.get("u")) { res.writeHead(307, { location: "/u/" + encodeURIComponent(u.searchParams.get("u")) }); return res.end(); }
  const file = path.join(pub, page(u.pathname));
  if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file).slice(1)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port} → api ${api}`));
