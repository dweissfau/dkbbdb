// Boot the leaderboard page (/leaderboard) in jsdom against the LIVE api and click through it: the filter card
// (tournament, user, rostered / excluded players), tabs, sorting, row clicks.
//   node scripts/smoke-front.mjs [site]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
const { JSDOM } = createRequire(path.join(ROOT, "..", "package.json"))("jsdom");
const site = process.argv[2] ?? "https://dkbbdb.com";
const errors = [];
let html = fs.readFileSync(path.join(ROOT, "public", "leaderboard.html"), "utf8").replace('<script src="/site.js"></script>', `<script>${fs.readFileSync(path.join(ROOT, "public", "site.js"), "utf8")}</script>`);
const dom = new JSDOM(html, { runScripts: "dangerously", url: site + "/leaderboard", pretendToBeVisual: true, beforeParse(w) {
  w.fetch = (u, init) => fetch(new URL(u, site), { ...init, headers: { ...init?.headers, ...(process.env.VERCEL_OIDC_TOKEN ? { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN } : {}) } }); w.scrollTo = () => {};
  w.addEventListener("error", (e) => errors.push(e.message));
} });
const w = dom.window, d = w.document, wait = (ms = 2500) => new Promise((r) => setTimeout(r, ms));
const checks = []; const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const rows = () => [...d.querySelectorAll("#rows tr[tabindex]")], heads = () => [...d.querySelectorAll("#thead th")].map((t) => t.textContent.trim());
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const change = (el, value) => { el.value = value; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
const opts = (id) => [...d.getElementById(id).options].map((o) => o.value);
const count = () => Number(/^([\d,]+) /.exec(d.getElementById("count").textContent)?.[1].replace(/,/g, "") ?? -1);
// type into a suggestion box and pick the first hit
const pick = async (id, text) => { const q = d.querySelector(`#${id} input`); q.value = text; q.dispatchEvent(new w.Event("input", { bubbles: true })); await wait(3000); const b = d.querySelector(`#${id} .hits button`); if (b) click(b); await wait(); return b?.textContent ?? ""; };

await wait(6000);
ok("teams tab renders rows", rows().length > 0 && rows().length <= 100, `${rows().length} rows · ${heads().join(" | ")}`);
ok("a tournament is chosen and there is no every-team option", d.getElementById("fT").value !== "" && !opts("fT").includes(""), d.getElementById("fT").value);
ok("every row is in that tournament (the count matches the menu)", opts("fT").length >= 1 && count() === Number(/\((\d[\d,]*)\)/.exec(d.getElementById("fT").selectedOptions[0].textContent)[1].replace(/,/g, "")), `${count()} teams`);
ok("first-visit strip is shown", !d.getElementById("hello").hidden);
ok("the page keeps its own address", w.location.pathname === "/leaderboard", w.location.href);
ok("updated line", /pdated \d+/.test(d.getElementById("liveNote").textContent), d.getElementById("liveNote").textContent);
ok("cut-line chip on the top row", /Advancing|Out by|Not started/.test(rows()[0]?.textContent ?? ""), rows()[0]?.textContent.replace(/\s+/g, " ").slice(0, 110));
const kk = await pick("fU", "kk");
const tour = d.getElementById("fT").value;
ok("typing part of a username suggests it; picking it fills the box with the full name and shows only that user's teams", /kknox20/.test(kk) && rows().length > 0 && rows().every((r) => r.querySelector("[data-user]").textContent === "kknox20") && d.querySelector("#fU input").value === "kknox20" && !d.getElementById("fU").hidden && w.location.search.includes("u=kknox20"), `${kk.replace(/\s+/g, " ")} → ${count()} teams`);
ok("the tournament stays selected when a user is picked (150 of kknox20's 193 are in the $20M)", d.getElementById("fT").value === tour && count() < 193 && w.location.search.includes("t="), `${count()} teams in ${tour}`);
{ const q = d.querySelector("#fU input"); q.value = ""; q.dispatchEvent(new w.Event("input", { bubbles: true })); } await wait();
ok("emptying the box brings the field back", !w.location.search.includes("u=") && count() > 150, `${count()} teams`);
const before = count();
const who = await pick("fP", "justin jefferson");
ok("rostered player → chip + fewer teams + numbers line", d.querySelectorAll("#pChips .tag").length === 1 && count() < before && count() > 0 && !d.getElementById("active").hidden && /have /.test(d.getElementById("active").textContent) && w.location.search.includes("p="), `${who.replace(/\s+/g, " ")} → ${count()} of ${before}`);
const withP = count();
const ex = await pick("fX", "jaxon smith");
ok("excluded player → red chip, still fewer teams, 'do not have' in the line", d.querySelectorAll("#xChips .tag.x").length === 1 && count() <= withP && /do not have/.test(d.getElementById("active").textContent) && w.location.search.includes("x="), `${ex.replace(/\s+/g, " ")} → ${count()}`);
click(d.querySelector("#xChips [data-clear]")); await wait();
ok("removing the excluded chip", d.querySelectorAll("#xChips .tag").length === 0 && count() === withP && !w.location.search.includes("x="));
click(d.querySelector("#pChips [data-clear]")); await wait();
ok("removing the rostered chip: back to the tournament", d.querySelectorAll("#pChips .tag").length === 0 && count() === before && d.getElementById("active").hidden);
click(d.querySelector('th[data-sort="gap"]')); await wait();
ok("sort by cut line", /▼/.test(d.querySelector('th[data-sort="gap"]').textContent) && w.location.search.includes("sort=gap"), w.location.search);
d.getElementById("advOnly").checked = true; d.getElementById("advOnly").dispatchEvent(new w.Event("change", { bubbles: true })); await wait();
ok("advancing only", rows().length > 0 && rows().every((r) => /Advancing/.test(r.textContent)), `${rows().length} rows`);
click(d.querySelector('[data-tab="players"]')); await wait();
ok("position buttons are visible on desktop", w.getComputedStyle(d.querySelector('[data-pos="QB"]')).display !== "none");
ok("players tab", rows().length > 0 && heads().some((h) => /Ownership/.test(h)) && !d.getElementById("posPills").hidden, heads().join(" | "));
click(d.querySelector('[data-pos="TE"]')); await wait();
ok("position pill", rows().every((r) => r.querySelector(".pos")?.textContent === "TE"), `${rows().length} TEs, top ${rows()[0]?.querySelector(".pname")?.textContent}`);
const name = rows()[0].querySelector(".pname").textContent; click(rows()[0]); await wait();
ok("clicking a player → teams that have him", d.querySelector('[data-tab="teams"]').classList.contains("on") && d.getElementById("pChips").textContent.includes(name) && /Share/.test(d.getElementById("cards").textContent), d.getElementById("cards").textContent.replace(/\s+/g, " ").slice(0, 90));
ok("there is no Users tab", !d.querySelector('[data-tab="users"]') && d.querySelectorAll("#tabs [data-tab]").length === 2);
click(rows()[0]); await wait(300);
ok("clicking a team opens the pop-up frame and puts ?team= in the address", !!d.querySelector("iframe.teamframe") && /team=\d+/.test(w.location.search), w.location.search);
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
