// Boot a profile page (/u/<name>) in jsdom against the LIVE api and click through it: tiles, tabs, filters, rows.
//   node scripts/smoke-user.mjs [site] [username]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
const { JSDOM } = createRequire(path.join(ROOT, "..", "package.json"))("jsdom");
const site = process.argv[2] ?? "https://dkbbdb.com", name = process.argv[3] ?? "kknox20";
const html = fs.readFileSync(path.join(ROOT, "public", "u.html"), "utf8").replace('<script src="/site.js"></script>', `<script>${fs.readFileSync(path.join(ROOT, "public", "site.js"), "utf8")}</script>`);
const boot = (url) => { const errors = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url, pretendToBeVisual: true, beforeParse(w) {
    w.fetch = (u, init) => fetch(new URL(u, site), { ...init, headers: { ...init?.headers, ...(process.env.VERCEL_OIDC_TOKEN ? { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN } : {}) } }); w.scrollTo = () => {}; w.addEventListener("error", (e) => errors.push(e.message)); } });
  return { w: dom.window, d: dom.window.document, errors }; };
const wait = (ms = 2500) => new Promise((r) => setTimeout(r, ms));
const checks = []; const ok = (name, cond, extra = "") => { checks.push(!!cond); console.log(cond ? "  ok  " : "  FAIL", name, extra); };
const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const { w, d, errors } = boot(`${site}/u/${encodeURIComponent(name)}`);
const rows = () => [...d.querySelectorAll("#rows tr[tabindex]")], heads = () => [...d.querySelectorAll("#thead th")].map((t) => text(t));
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await wait(6000);
ok("header names the account and the week", text(d.getElementById("name")).toLowerCase() === name.toLowerCase() && /NFL week \d+/.test(text(d.getElementById("sub"))), text(d.getElementById("sub")));
const tiles = [...d.querySelectorAll(".tile")];
ok("two tiles: advancing, winning", tiles.length === 2 && tiles.map((t) => text(t.querySelector(".k"))).join("|") === "Advancing|Winning", tiles.map((t) => text(t)).join(" · "));
ok("teams table: tick box + rank, then tournament; no username column", rows().length === 100 && heads()[2] === "Tournament" && !!d.getElementById("tickAll") && rows().every((r) => r.querySelector("input.tick")) && !heads().includes("User"), heads().join(" | "));
ok("tournament dropdown lists this account's tournaments with counts", d.getElementById("fT").options.length > 1 && /\(\d+\)/.test(d.getElementById("fT").options[1].text), d.getElementById("fT").options[1].text);
ok("cut-line chip on the top row", /Advancing|Out/.test(text(rows()[0])), text(rows()[0]).slice(0, 100));
click(d.querySelector('th[data-sort="gap"]')); await wait();
ok("sort by cut line goes into the address", /▼/.test(text(d.querySelector('th[data-sort="gap"]'))) && w.location.search.includes("sort=gap") && w.location.pathname === `/u/${name}`, w.location.href);
d.getElementById("fT").value = d.getElementById("fT").options[1].value; d.getElementById("fT").dispatchEvent(new w.Event("change", { bubbles: true })); await wait();
ok("tournament filter", rows().length > 0 && rows().every((r) => text(r).includes(d.getElementById("fT").options[1].text.replace(/ \(\d+\)$/, ""))) && tiles.length === 2 && text(d.querySelector(".tile .v")) === text(d.querySelector("#tiles .tile .v")), `${rows().length} rows · ${text(d.getElementById("count"))}`);
d.getElementById("fT").value = ""; d.getElementById("fT").dispatchEvent(new w.Event("change", { bubbles: true })); await wait();
click(d.querySelector('[data-tab="exposure"]')); await wait();
ok("exposure tab", rows().length === 100 && heads().some((h) => /Exposure/.test(h)) && heads().some((h) => /Entry fees/.test(h)) && !heads().includes("Teams") && /^\$[\d,]+$/.test(text(rows()[0].querySelectorAll("td")[2])) && !d.getElementById("posPills").hidden && d.getElementById("fP").hidden && d.getElementById("advWrap").hidden, heads().join(" | "));
click(d.querySelector('[data-pos="RB"]')); await wait();
ok("position pill", rows().every((r) => r.querySelector(".pos")?.textContent === "RB"), `${rows().length} RBs, top ${text(rows()[0]?.querySelector(".pname"))}`);
const pname = text(rows()[0].querySelector(".pname")); click(rows()[0]); await wait();
ok("clicking a player → teams that have him, with the numbers line", d.querySelector('[data-tab="teams"]').classList.contains("on") && text(d.getElementById("active")).includes(pname) && /have him/.test(text(d.getElementById("active"))), text(d.getElementById("active")).slice(0, 120));
click(d.querySelector("#active [data-clear]")); await wait();
ok("removing the player chip restores every team", d.getElementById("active").hidden && rows().length === 100);
click(rows()[0]); await wait(300);
ok("clicking a team opens the pop-up frame and puts ?team= in the address", !!d.querySelector("iframe.teamframe") && /team=\d+/.test(w.location.search), w.location.search);
w.dispatchEvent(new w.MessageEvent("message", { data: { dkbbdb: "close-team" }, origin: site })); await wait(200);
ok("the frame closes on the pop-up's message", !d.querySelector("iframe.teamframe") && !/team=/.test(w.location.search));
// ticked teams: the boxes on the Teams rows, then "Only ticked" / "Hide ticked" narrow both tabs (and the header line)
const tk = () => text(d.getElementById("active"));
rows()[0].querySelector("input.tick").click(); rows()[1].querySelector("input.tick").click(); await wait(500);
ok("ticking two teams: chip + mode pills appear, no pop-up opens", /2 teams ticked/.test(tk()) && !d.getElementById("tickPills").hidden && !d.querySelector("iframe.teamframe") && rows()[0].classList.contains("ticked"), tk());
click(d.querySelector('#tickPills [data-tick-mode="only"]')); await wait();
ok("Only ticked: two rows, header '2 of N teams · 2 ticked', Advancing tile 'of 2'", rows().length === 2 && /2 of \d+ teams · 2 ticked/.test(text(d.getElementById("sub"))) && /of 2/.test(text(d.querySelector(".tile.t-adv"))), text(d.getElementById("sub")));
click(d.querySelector('[data-tab="exposure"]')); await wait();
ok("Exposure counts only the two ticked teams (every player 50% or 100%)", rows().length > 10 && rows().every((r) => /^(50|100)\.0%$/.test(text(r.querySelector("td.col-own")))), `${rows().length} players`);
click(d.querySelector('#tickPills [data-tick-mode="hide"]')); await wait();
ok("Hide ticked: header 'N-2 of N teams · all but 2 ticked'", /all but 2 ticked/.test(text(d.getElementById("sub"))) && /hidden/.test(tk()), text(d.getElementById("sub")));
click(d.querySelector('#active [data-clear="ticks"]')); await wait();
ok("clearing the ticks restores every player (the RB pill is still on) and hides the pills", rows().length > 50 && rows().every((r) => r.querySelector(".pos")?.textContent === "RB") && d.getElementById("tickPills").hidden && !/ticked/.test(tk()) && /193 teams in/.test(text(d.getElementById("sub"))), `${rows().length} RBs · ${text(d.getElementById("sub"))}`);
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
ok("no username search anywhere on the page", !d.querySelector("#find") && ![...d.querySelectorAll("input")].some((i) => /username/i.test(i.placeholder + i.getAttribute("aria-label"))));
const hdr = { headers: process.env.VERCEL_OIDC_TOKEN ? { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN } : {} };
ok("api: username search is gone", (await (await fetch(`${site}/api/search?type=user&q=kkn`, hdr)).json()).results.length === 0);
ok("api: player search within the account counts only its teams; without one it counts the whole field", (await (await fetch(`${site}/api/search?type=player&q=justin`, hdr)).json()).results.some((r) => r.teams > 10)
  && (await (await fetch(`${site}/api/search?type=player&q=justin&u=fleaflick`, hdr)).json()).results.every((r) => r.teams <= 10));
{ const b = await (await fetch(`${site}/api/leaderboard?limit=1`, hdr)).json();
  ok("api: no whole-field board — without a username the answer is the biggest tournament", b.live && b.filter.t === b.tournaments[0].name && b.total === b.tournaments[0].teams && b.total < b.teams, `${b.filter.t}: ${b.total} of ${b.teams}`); }

const nobody = boot(`${site}/u/nobody-xyz-123`); await wait(5000);
ok("unknown username → 'no teams yet' with the connect link", /No teams under/.test(text(nobody.d.getElementById("panel"))) && !!nobody.d.querySelector('#panel a[href="/"]') && nobody.d.querySelectorAll(".tile").length === 0, text(nobody.d.getElementById("panel")).slice(0, 80));
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
