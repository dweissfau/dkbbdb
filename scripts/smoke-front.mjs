// Boot the front page in jsdom against the LIVE api and click through it: tabs, sorting, filters, row clicks.
//   node scripts/smoke-front.mjs [site]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
const { JSDOM } = createRequire(path.join(ROOT, "..", "package.json"))("jsdom");
const site = process.argv[2] ?? "https://dkbbdb.com";
const errors = [];
let html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8").replace('<script src="/site.js"></script>', `<script>${fs.readFileSync(path.join(ROOT, "public", "site.js"), "utf8")}</script>`);
const dom = new JSDOM(html, { runScripts: "dangerously", url: site + "/", pretendToBeVisual: true, beforeParse(w) {
  w.fetch = (u, init) => fetch(new URL(u, site), init); w.scrollTo = () => {};
  w.addEventListener("error", (e) => errors.push(e.message));
} });
const w = dom.window, d = w.document, wait = (ms = 2500) => new Promise((r) => setTimeout(r, ms));
const checks = []; const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const rows = () => [...d.querySelectorAll("#rows tr[tabindex]")], heads = () => [...d.querySelectorAll("#thead th")].map((t) => t.textContent.trim());
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

await wait(6000);
ok("teams tab renders 100 rows", rows().length === 100, `${rows().length} rows · ${heads().join(" | ")}`);
ok("first-visit strip is shown", !d.getElementById("hello").hidden);
ok("cut-line chip on the top row", /Advancing|Out by/.test(rows()[0]?.textContent ?? ""), rows()[0]?.textContent.replace(/\s+/g, " ").slice(0, 110));
click(d.querySelector('th[data-sort="gap"]')); await wait();
ok("sort by cut line", /▼/.test(d.querySelector('th[data-sort="gap"]').textContent) && w.location.search.includes("sort=gap"), w.location.search);
d.getElementById("advOnly").checked = true; d.getElementById("advOnly").dispatchEvent(new w.Event("change", { bubbles: true })); await wait();
ok("advancing only", rows().length > 0 && rows().every((r) => /Advancing/.test(r.textContent)), `${rows().length} rows`);
click(d.querySelector('[data-tab="players"]')); await wait();
ok("players tab", rows().length === 100 && heads().some((h) => /Ownership/.test(h)) && !d.getElementById("posPills").hidden && d.getElementById("fP").hidden, heads().join(" | "));
click(d.querySelector('[data-pos="TE"]')); await wait();
ok("position pill", rows().every((r) => r.querySelector(".pos")?.textContent === "TE"), `${rows().length} TEs, top ${rows()[0]?.querySelector(".pname")?.textContent}`);
const name = rows()[0].querySelector(".pname").textContent; click(rows()[0]); await wait();
ok("clicking a player → teams that have him", d.querySelector('[data-tab="teams"]').classList.contains("on") && d.getElementById("title") === null && d.getElementById("active").textContent.includes(name) && /Teams with him/.test(d.getElementById("cards").textContent), d.getElementById("cards").textContent.replace(/\s+/g, " ").slice(0, 90));
click(d.querySelector('[data-tab="users"]')); await wait();
ok("users tab", rows().length >= 3 && heads().some((h) => /Best/.test(h)), rows().map((r) => r.textContent.replace(/\s+/g, " ").trim().slice(0, 40)).join(" || "));
click(rows().find((r) => /fleaflick/.test(r.textContent))); await wait();
ok("clicking a user → their teams", d.querySelector('[data-tab="teams"]').classList.contains("on") && rows().length === 10 && rows().every((r) => /fleaflick/.test(r.textContent)), `${rows().length} rows`);
click(rows()[0]); await wait(300);
ok("clicking a team opens the pop-up frame and puts ?team= in the address", !!d.querySelector("iframe.teamframe") && /team=\d+/.test(w.location.search), w.location.search);
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
