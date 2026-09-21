// Build the public app page from the single-user dashboard template, so both sites share one UI:
//   ../tools/dashboard-template.html  →  public/app.html (markup + CSS) and public/app.js (the page script)
// The page script is unchanged except for where its data comes from (window.__DK, set by boot.js from the
// username in the address, instead of JSON baked into the file) and the partner / local-tooling bits the public version
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
html = swap(html, "<title>DK Best Ball Portfolio</title>", `<title>dkbbdb</title>\n<link rel="icon" href="/favicon.png">`, "title");
html = swap(html, "<h1>DK Best Ball Portfolio</h1>", `<h1><a href="/" style="color:inherit;text-decoration:none">dkbbdb</a> <span id="who" style="font-weight:400;color:var(--ink-2)"></span></h1>`, "h1");
html = swap(html, `<button class="btn" id="exportCsv">`, `<a class="btn" href="/" style="text-decoration:none">Leaderboard</a>\n  <a class="btn" href="/connect" style="text-decoration:none">Add your teams</a>\n  <button class="btn" id="exportCsv">`, "header links");
html = swap(html, "</style>", `
/* public version: no partner features, no local-tooling tab */
nav.tabs button[data-tab="partners"], nav.tabs button[data-tab="debug"], [data-sf="shared"], [data-sf="manual"],
#seasonTable [data-key="partners"] { display: none !important; }
</style>`, "css");

// ---- script ----
js = swap(js, `const DK = JSON.parse(document.getElementById("dk-data").textContent);`, `const DK = window.__DK; // set by boot.js from /api/portfolio`, "DK source");
js = swap(js,
  `const res = await fetch("live/", { headers: LIVE.etag ? { "If-None-Match": LIVE.etag } : {}, cache: "no-store", credentials: "same-origin" });`,
  `const res = await fetch(window.dkbbLiveUrl(), { headers: LIVE.etag ? { "If-None-Match": LIVE.etag } : {}, cache: "no-cache" });`,
  "live fetch");
js = swap(js, `applyLive(await res.json());`, `applyLive(window.dkbbExpand(await res.json())); window.dkbbAfterLive?.();`, "expand compact view");
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

// the viewer is not necessarily the owner: no first-person wording in the league view
function swapAll(where, from, to, label, times) {
  const n = where.split(from).length - 1;
  if (n !== times) throw new Error(`build-app: "${label}" matched ${n} times (expected ${times})`);
  return where.split(from).join(to);
}
js = swapAll(js, `\${me ? " (mine)" : ""}`, "", "(mine) tag", 2);
js = swap(js, `const who = me ? "My team" : esc(std?.[1] ?? String(key));`, `const who = esc(std?.[1] ?? (me ? "This team" : String(key)));`, "roster heading");
js = swap(js, `\${me ? "my" : \`<b style="color:var(--ink)">\${esc(std?.[1] ?? "this team")}</b>'s\`} score each week`,
  `<b style="color:var(--ink)">\${esc(std?.[1] ?? "this team")}</b>'s score each week`, "week strip heading");
js = swap(js, "`Synced: ${syn.rank != null", "`Now: ${syn.rank != null", "status line");

// the public version has no partner shares and no manual overrides: every team belongs to the account it was
// synced from and counts at its full buy-in, whatever a browser's storage may hold
js = swap(js, `function sharesOf(id) { return LS.shares[id] ?? SEA.shares[id] ?? []; }`, `function sharesOf() { return []; }`, "no shares");
js = swap(js, `  const ls = LS.entries[id] ?? {};
`, `  const ls = {};
`, "no manual overrides");
js = swap(js, `<span class="lg">My </span>stake`, `Buy-in`, "stake label");

fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "public", "app.html"), html);
fs.writeFileSync(path.join(ROOT, "public", "app.js"), js);
console.log(`public/app.html ${(html.length / 1024).toFixed(0)} KB · public/app.js ${(js.length / 1024).toFixed(0)} KB`);
