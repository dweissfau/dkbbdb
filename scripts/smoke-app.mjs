// Boot public/app.html + app.js in jsdom with one user's real data (portfolio + live view straight from the
// libs, no HTTP) and check the page renders.   node scripts/smoke-app.mjs <dk username>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { connect, loadEnv, ROOT } from "./db.mjs";
import { userPortfolio } from "../lib/portfolio.js";
import { userView } from "../lib/view.js";

const { JSDOM } = createRequire(path.join(ROOT, "..", "package.json"))("jsdom");
process.env.DATABASE_URL ??= loadEnv().DATABASE_URL;
const db = await connect();
const u = (await db.query("select user_id from dk_accounts where lower(username) = lower($1)", [process.argv[2] ?? "kknox20"])).rows[0];
const [portfolio, view] = [await userPortfolio(db, u.user_id), (await userView(db, u.user_id)).body];
await db.end();

const html = fs.readFileSync(path.join(ROOT, "public", "app.html"), "utf8").replace(`<script src="/boot.js"></script>`, "");
const errors = [];
const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://dkbbdb.com/app", pretendToBeVisual: true });
const w = dom.window;
w.addEventListener("error", (e) => errors.push(e.message));
w.console.error = (...a) => errors.push(a.join(" "));
w.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
w.__DK = portfolio;
w.dkbbToken = async () => "test";
let liveCalls = 0;
w.fetch = async (url, init) => { liveCalls++; if (url !== "/api/live" || init.headers.Authorization !== "Bearer test") throw new Error("unexpected fetch " + url);
  return { status: 200, ok: true, headers: { get: () => '"x"' }, json: async () => JSON.parse(JSON.stringify(view)) }; };
w.eval(fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8"));
await new Promise((r) => setTimeout(r, 1500));

const d = w.document, checks = [];
const ok = (name, cond, extra = "") => { checks.push(cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const rows = d.querySelectorAll("#seasonTable tbody tr");
ok("season rows = teams", rows.length === portfolio.drafts.length, `${rows.length}/${portfolio.drafts.length}`);
ok("live feed fetched with the bearer token", liveCalls >= 1);
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
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" || "));
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
