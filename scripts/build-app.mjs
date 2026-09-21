// Build the public app page from the single-user dashboard template, so both sites share one UI:
//   ../tools/dashboard-template.html  →  public/app.html (markup + CSS) and public/app.js (the page script)
// The page script is unchanged except for where its data comes from (window.__DK, set by boot.js after
// sign-in, instead of JSON baked into the file) and the partner / local-tooling bits the public version
// does not have. Every edit below must match exactly once — a template change that breaks one fails the build.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./db.mjs";

const src = fs.readFileSync(path.join(ROOT, "..", "tools", "dashboard-template.html"), "utf8").replace(/\r\n/g, "\n");
const m = /<script id="dk-data" type="application\/json">\/\*__DATA__\*\/<\/script>\s*<script>\n([\s\S]*?)<\/script>\s*<\/body>/.exec(src);
if (!m) throw new Error("template: data + script block not found");
let html = src.slice(0, m.index) + `<script src="/boot.js"></script>\n</body>` + src.slice(m.index + m[0].length);
let js = m[1];

function swap(where, from, to, label) {
  const n = where.split(from).length - 1;
  if (n !== 1) throw new Error(`build-app: "${label}" matched ${n} times (expected 1)`);
  return where.replace(from, () => to);
}

// ---- markup ----
html = swap(html, "<title>DK Best Ball Portfolio</title>", "<title>dkbbdb</title>", "title");
html = swap(html, "<h1>DK Best Ball Portfolio</h1>", `<h1>dkbbdb</h1>`, "h1");
html = swap(html, `<button class="btn" id="exportCsv">`, `<a class="btn" href="/connect" style="text-decoration:none">Sync teams</a>\n  <button class="btn" id="exportCsv">`, "header sync link");
html = swap(html, `<button class="btn" id="exportJson">Export JSON</button>`, `<button class="btn" id="exportJson">Export JSON</button>\n  <div id="userBtn" style="margin-left:10px"></div>`, "header user button");
html = swap(html, "</style>", `
/* public version: no partner features, no local-tooling tab */
nav.tabs button[data-tab="partners"], nav.tabs button[data-tab="debug"], [data-sf="shared"],
#seasonTable [data-key="partners"] { display: none !important; }
</style>`, "css");

// ---- script ----
js = swap(js, `const DK = JSON.parse(document.getElementById("dk-data").textContent);`, `const DK = window.__DK; // set by boot.js from /api/portfolio`, "DK source");
js = swap(js,
  `const res = await fetch("live/", { headers: LIVE.etag ? { "If-None-Match": LIVE.etag } : {}, cache: "no-store", credentials: "same-origin" });`,
  `const res = await fetch("/api/live", { headers: { ...(LIVE.etag ? { "If-None-Match": LIVE.etag } : {}), Authorization: "Bearer " + await window.dkbbToken() }, cache: "no-store" });`,
  "live fetch");
js = swap(js,
  `    ["My effective buy-ins", fmt$(myFees),
      shared.length ? \`of \${fmt$(fees)} total — partners carry the rest\` : "no shared teams marked yet"],
    ["Shared teams", shared.length, shared.length ? summarizePartners(shared) : "click a team row to add partners"],
    ["Winnings so far", fmt$(winnings), winnings ? "synced from DraftKings" : "—"],`,
  `    ["Total buy-ins", fmt$(fees), \`\${all.length} team\${all.length === 1 ? "" : "s"}\`],
    ["Winnings so far", fmt$(winnings), winnings ? "as of your last sync" : "—"],`,
  "season cards");
js = swap(js,
  "`scores synced ${new Date(SEA.scoresSyncedAt).toLocaleString()} · refresh: DK mycontests → “Sync current scores” → npm run refresh · click a row to edit scores & shares`",
  "`live scoring · updated ${new Date(SEA.scoresSyncedAt).toLocaleString()} · click a row for the league view`", "season note (synced)");
js = swap(js,
  "`no synced scores yet · to sync: DK mycontests → “Sync current scores” → npm run refresh · click a row to enter scores manually or add partners`",
  "`loading live scores…`", "season note (empty)");
js = swap(js,
  `title="scored on the server from public NFL stats with DraftKings' rules; official DraftKings numbers take over whenever the extension is running"`,
  `title="scored from public NFL stats with DraftKings' rules"`, "live tooltip");

fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "public", "app.html"), html);
fs.writeFileSync(path.join(ROOT, "public", "app.js"), js);
console.log(`public/app.html ${(html.length / 1024).toFixed(0)} KB · public/app.js ${(js.length / 1024).toFixed(0)} KB`);
