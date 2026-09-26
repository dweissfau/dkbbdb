// Boot public/app.html + app.js in jsdom with one user's real data (portfolio + live view straight from the
// libs, no HTTP) and check the page renders.   node scripts/smoke-app.mjs <dk username>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
import { userView } from "../lib/view.js";
import { loadStore, accountByName, baseOf, portfolioOf } from "../lib/store.js";

const { JSDOM } = createRequire(path.join(ROOT, "..", "package.json"))("jsdom");
const names = (process.argv[2] ?? "kknox20").toLowerCase().split(",");
const store = await loadStore();
const keys = names.map((n) => accountByName(store, n)?.user_key).filter(Boolean);
const [portfolio, view] = [portfolioOf(store, keys), (await userView(keys, { base: baseOf(store, keys) })).body];

const html = fs.readFileSync(path.join(ROOT, "public", "app.html"), "utf8").replace(`<script src="/boot.js"></script>`, "");
const errors = [];
const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://dkbbdb.com/u/" + names.join(","), pretendToBeVisual: true });
const w = dom.window;
w.addEventListener("error", (e) => errors.push(e.message));
w.console.error = (...a) => errors.push(a.join(" "));
w.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
w.__DK = portfolio;
w.dkbbLiveUrl = () => "/api/live?u=" + names.join(",");
let liveCalls = 0;
w.fetch = async (url, init) => { liveCalls++; if (!url.startsWith("/api/live?u=") || init.headers.Authorization) throw new Error("unexpected fetch " + url);
  return { status: 200, ok: true, headers: { get: () => '"x"' }, json: async () => JSON.parse(JSON.stringify(view)) }; };
w.eval(fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8"));
await new Promise((r) => setTimeout(r, 1500));

const d = w.document, checks = [];
const ok = (name, cond, extra = "") => { checks.push(cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const rows = d.querySelectorAll("#seasonTable tbody tr");
ok("season rows = teams", rows.length === portfolio.drafts.length, `${rows.length}/${portfolio.drafts.length}`);
ok("live feed fetched by username, no credentials", liveCalls >= 1);
ok("points rendered to 2 decimals", /\d+\.\d\d/.test(rows[0]?.textContent ?? ""), rows[0]?.textContent.replace(/\s+/g, " ").slice(0, 90));
ok("header says live", /live/.test(d.getElementById("genInfo").textContent), d.getElementById("genInfo").textContent);
const cards = [...d.querySelectorAll("#seasonCards .card .k")].map((x) => x.textContent);
ok("cards: Total buy-ins, no partner cards", cards.includes("Total buy-ins") && !cards.some((c) => /Shared|effective/.test(c)), cards.join(" | "));
const hidden = (sel) => { const el = d.querySelector(sel); return !!el && w.getComputedStyle(el).display === "none"; };
ok("Partners + Debug tabs hidden", hidden('nav.tabs button[data-tab="partners"]') && hidden('nav.tabs button[data-tab="debug"]'));
ok("Partners column hidden", hidden('#seasonTable th[data-key="partners"]'));
rows[0].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const modal = d.getElementById("modal");
ok("league view opens with 12 standings rows", modal.classList.contains("on") && modal.querySelectorAll("#lgStandings tbody tr, .lg-split table tbody tr").length >= 12, String(modal.querySelectorAll("table tbody tr").length) + " rows in modal");
ok("week-by-week strip present", !!modal.querySelector(".wkbar"));
for (const tab of ["exposure", "balance", "overview", "rosters", "analytics"]) {
  d.querySelector(`nav.tabs button[data-tab="${tab}"]`).click();
  const sec = d.getElementById("tab-" + tab);
  ok(`${tab} tab renders`, sec.classList.contains("on") && sec.textContent.trim().length > 50, `${sec.textContent.trim().length} chars`);
}
const tag = modal.querySelector(".gdone, .playing, .gnext");
ok("compact rows were expanded: the roster shows game tags", !!tag, tag?.textContent ?? "no game tag found");
ok("live view fits Vercel's 4.5 MB response cap", JSON.stringify(view).length < 3.0e6, `${(JSON.stringify(view).length / 1e6).toFixed(2)} MB`);
// team tick boxes → the "Teams" picker in the filter bar drives every filtered tab
d.querySelector('nav.tabs button[data-tab="season"]').click();
const total = portfolio.drafts.length, pickBtn = () => d.getElementById("pickBtn").textContent;
d.querySelectorAll("#seasonTable tbody tr .tick")[0].click();
d.querySelectorAll("#seasonTable tbody tr .tick")[1].click();
ok("ticking two teams updates the picker", pickBtn().startsWith("2 teams ticked"), pickBtn());
ok("ticked rows stay marked after the rerender", d.querySelectorAll("#seasonTable tbody tr.ticked").length === 2 && d.querySelectorAll("#rosterTable tbody tr.ticked").length === 2);
d.querySelector('#pickPanel button[data-mode="only"]').click();
ok("Only ticked: season shows 2 rows", d.querySelectorAll("#seasonTable tbody tr").length === 2, pickBtn());
ok("Only ticked: exposure counts 2 rosters", /· 2 rosters ·/.test(d.getElementById("filterCount").textContent), d.getElementById("filterCount").textContent);
ok("Only ticked: rosters tab shows 2 rows", d.querySelectorAll("#rosterTable tbody tr").length === 2);
d.querySelector('#pickPanel button[data-mode="hide"]').click();
ok("Hide ticked: season shows all but 2", d.querySelectorAll("#seasonTable tbody tr").length === total - 2, pickBtn());
const saved = JSON.parse(w.localStorage.getItem("dkbb-picks-v1") ?? "{}");
ok("ticks + mode persisted in this browser", saved.ids?.length === 2 && saved.mode === "hide", JSON.stringify(saved));
d.querySelector('#pickPanel [data-act="clear"]').click();
ok("Clear ticks restores every team", d.querySelectorAll("#seasonTable tbody tr").length === total && pickBtn().startsWith("Teams: none"), pickBtn());
d.querySelector("#seasonTable thead .tick-all").click();
ok("header box ticks every team shown", pickBtn().startsWith(`${total} teams ticked`), pickBtn());
d.querySelector('#pickPanel [data-act="clear"]').click();
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" || "));
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
