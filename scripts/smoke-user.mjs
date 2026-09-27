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
ok("header names the account, its teams and tournaments, and the week", text(d.getElementById("name")).toLowerCase() === name.toLowerCase() && /\d+ teams · \d+ tournaments · NFL week \d+/.test(text(d.getElementById("sub"))), text(d.getElementById("sub")));
ok("the live pill by the name says how old the scores are", /^(Live · |Updated |Couldn't refresh · showing )/.test(text(d.getElementById("liveNote"))), text(d.getElementById("liveNote")));
const tiles = [...d.querySelectorAll(".tile")];
ok("four tiles: advancing, winnings, entry fees, best team", tiles.length === 4 && tiles.map((t) => text(t.querySelector(".k"))).join("|") === "Advancing|Winnings|Entry fees|Best team" && /^\$[\d,]+$/.test(text(tiles[2].querySelector(".v"))) && /^\d+\.\d\d$/.test(text(tiles[3].querySelector(".v"))), tiles.map((t) => text(t)).join(" · "));
ok("teams table: tick box, #, Team, Place, Cut line, To play, Points; every team at once", rows().length >= 100 && heads().slice(1).join("|") === "#|Team|Place|Cut line|To play|Points▼" && !!d.getElementById("tickAll") && rows().every((r) => r.querySelector("input.tick")), heads().join(" | ") + " · " + rows().length + " rows");
ok("a team row names its first three picks, then tournament · fee · draft date", rows().every((r) => text(r.querySelector(".t1")).split(" · ").length === 3) && / · \$\d+ · \w{3} \d+$/.test(text(rows()[0].querySelector(".t2"))), text(rows()[0].querySelector("td.team")));
const weeks = () => [...d.querySelectorAll("#wList [data-w]")].map((b) => text(b) + (b.classList.contains("on") ? "*" : "") + (b.disabled ? "(off)" : ""));
ok("week menu: one option per week so far, this week selected by default and marked live, Playoffs off until they start", weeks().length >= 2 && /^Wk \d+ · live\*$/.test(weeks()[weeks().length - 2]) && weeks()[weeks().length - 1] === "Playoffs(off)" && /^Wk \d+ · live/.test(text(d.getElementById("wBtn"))) && d.getElementById("wList").hidden, weeks().join(" ") + " · button: " + text(d.getElementById("wBtn")));
const before = text(rows()[0].querySelector("td.points"));
click(d.getElementById("wBtn")); ok("the week button opens its list", !d.getElementById("wList").hidden);
click(d.querySelector('#wList [data-w="1"]')); await wait();
ok("Wk 1 → the standing as of week 1 (address ?w=1, subline says so, no 'to play', chip selected)", /(^|[?&])w=1(&|$)/.test(w.location.search) && /as of week 1/.test(text(d.getElementById("sub"))) && weeks()[0] === "Wk 1*" && d.getElementById("wList").hidden && text(d.getElementById("wBtn")).startsWith("Wk 1") && rows().every((r) => text(r.querySelector("td.col-left")) === "—") && text(rows()[0].querySelector("td.points")) !== before, `${weeks().join(" ")} · top ${text(rows()[0].querySelector("td.points"))} (season ${before})`);
click(d.querySelector("#wList [data-w]:nth-last-child(2)")); await wait();
ok("this week's chip → back to the season", !/w=/.test(w.location.search) && text(rows()[0].querySelector("td.points")) === before);
ok("tournament dropdown lists this account's tournaments with counts", d.getElementById("fT").options.length > 1 && /\(\d+\)/.test(d.getElementById("fT").options[1].text), d.getElementById("fT").options[1].text);
ok("cut-line chip on the top row", /Advancing|Out/.test(text(rows()[0])), text(rows()[0]).slice(0, 100));
click(d.querySelector('th[data-sort="gap"]')); await wait();
ok("sort by cut line goes into the address", /▼/.test(text(d.querySelector('th[data-sort="gap"]'))) && w.location.search.includes("sort=gap") && w.location.pathname === `/u/${name}`, w.location.href);
d.getElementById("fT").value = d.getElementById("fT").options[1].value; d.getElementById("fT").dispatchEvent(new w.Event("change", { bubbles: true })); await wait();
{ const tname = d.getElementById("fT").options[1].text.replace(/ \(\d+\)$/, "").replace(/\s*\[[^\]]*\]/g, "").trim();
  ok("tournament filter (the sheet's select): rows narrow, the menu button and subline name it", rows().length > 0 && rows().every((r) => text(r.querySelector(".t2")).includes(tname)) && text(d.getElementById("tBtn")).includes(tname) && text(d.getElementById("sub")).includes(tname), `${rows().length} rows · ${text(d.getElementById("tBtn"))}`); }
click(d.getElementById("tBtn")); ok("the tournament menu lists every tournament with a count, the chosen one marked", !d.getElementById("tList").hidden && d.querySelectorAll("#tList [data-t]").length === d.getElementById("fT").options.length && !!d.querySelector("#tList .on"), `${d.querySelectorAll("#tList [data-t]").length} options`);
click(d.querySelector('#tList [data-t=""]')); await wait();
ok("picking 'All tournaments' in the menu clears the filter and closes it", d.getElementById("tList").hidden && !/[?&]t=/.test(w.location.search) && rows().length >= 100);
click(d.querySelector('[data-tab="exposure"]')); await wait();
ok("exposure tab", rows().length >= 100 && heads().some((h) => /Exposure/.test(h)) && heads().some((h) => /Entry fees/.test(h)) && !heads().includes("Teams") && /^\$[\d,]+$/.test(text(rows()[0].querySelectorAll("td")[2])) && !d.getElementById("posPills").hidden && d.getElementById("fP").hidden && d.getElementById("advWrap").hidden, heads().join(" | "));
click(d.querySelector('[data-pos="RB"]')); await wait();
ok("position pill", rows().every((r) => r.querySelector(".pos")?.textContent === "RB"), `${rows().length} RBs, top ${text(rows()[0]?.querySelector(".pname"))}`);
const pname = text(rows()[0].querySelector(".pname")); click(rows()[0]); await wait();
ok("clicking a player → teams that have him, with the numbers line", d.querySelector('[data-tab="teams"]').classList.contains("on") && text(d.getElementById("active")).includes(pname) && /have him/.test(text(d.getElementById("active"))), text(d.getElementById("active")).slice(0, 120));
click(d.querySelector("#active [data-clear]")); await wait();
ok("removing the player chip restores every team", d.getElementById("active").hidden && rows().length >= 100);
click(rows()[0]); await wait(300);
ok("clicking a team opens the pop-up frame and puts ?team= in the address", !!d.querySelector("iframe.teamframe") && /team=\d+/.test(w.location.search), w.location.search);
w.dispatchEvent(new w.MessageEvent("message", { data: { dkbbdb: "close-team" }, origin: site })); await wait(200);
ok("the frame closes on the pop-up's message", !d.querySelector("iframe.teamframe") && !/team=/.test(w.location.search));
// ticked teams: the boxes on the Teams rows, then "Only ticked" / "Hide ticked" narrow both tabs (and the header line)
const tk = () => text(d.getElementById("active"));
rows()[0].querySelector("input.tick").click(); rows()[1].querySelector("input.tick").click(); await wait(500);
ok("ticking two teams: chip + mode pills appear, no pop-up opens", /2 teams ticked/.test(tk()) && !d.getElementById("tickPills").hidden && !d.querySelector("iframe.teamframe") && rows()[0].classList.contains("ticked"), tk());
click(d.querySelector('#tickPills [data-tick-mode="only"]')); await wait();
ok("Only ticked: two rows, subline '2 of N teams · 2 ticked'", rows().length === 2 && /2 of \d+ teams · 2 ticked/.test(text(d.getElementById("sub"))), text(d.getElementById("sub")));
click(d.querySelector('[data-tab="exposure"]')); await wait();
ok("Exposure counts only the two ticked teams (every player 50% or 100%)", rows().length > 10 && rows().every((r) => /^(50|100)\.0%$/.test(text(r.querySelector("td.col-own")))), `${rows().length} players`);
click(d.querySelector('#tickPills [data-tick-mode="hide"]')); await wait();
ok("Hide ticked: header 'N-2 of N teams · all but 2 ticked'", /all but 2 ticked/.test(text(d.getElementById("sub"))) && /hidden/.test(tk()), text(d.getElementById("sub")));
click(d.querySelector('#active [data-clear="ticks"]')); await wait();
ok("clearing the ticks restores every player (the RB pill is still on) and hides the pills", rows().length > 50 && rows().every((r) => r.querySelector(".pos")?.textContent === "RB") && d.getElementById("tickPills").hidden && !/ticked/.test(tk()) && /\d+ teams · \d+ tournaments/.test(text(d.getElementById("sub"))), `${rows().length} RBs · ${text(d.getElementById("sub"))}`);
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
ok("the wordmark is not a link", d.querySelector(".pbar .brand")?.tagName === "SPAN" && !d.querySelector(".pbar a.brand"));
ok("a browser that never synced: the add-your-teams button; no username search anywhere",![...d.querySelectorAll("input")].some((i) => /username/i.test(i.placeholder + i.getAttribute("aria-label"))) && !d.getElementById("navAdd").hidden && d.querySelectorAll(".pbar a").length === 1);
{ const own = boot(`${site}/u/fleaflick?me=1`); await wait(5000);
  ok("a browser that has synced (?me=1 remembers it): nothing at the nav's right end", own.d.getElementById("navAdd").hidden && !own.d.querySelector(".pbar a:not([hidden])") && own.w.localStorage.getItem("dkbbdb-me") === "fleaflick");
  own.d.getElementById("forgetLink").click();
  ok("'forget that' brings the add-your-teams button back", !own.d.getElementById("navAdd").hidden && !own.w.localStorage.getItem("dkbbdb-me")); }
const hdr = { headers: process.env.VERCEL_OIDC_TOKEN ? { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN } : {} };
ok("api: username search finds an account from part of its name", (await (await fetch(`${site}/api/search?type=user&q=kkn`, hdr)).json()).results.some((r) => r.username === "kknox20" && r.teams > 0));
ok("api: player search within the account counts only its teams; without one it counts the whole field", (await (await fetch(`${site}/api/search?type=player&q=justin`, hdr)).json()).results.some((r) => r.teams > 10)
  && (await (await fetch(`${site}/api/search?type=player&q=justin&u=fleaflick`, hdr)).json()).results.every((r) => r.teams <= 10));
{ const b = await (await fetch(`${site}/api/leaderboard?limit=1`, hdr)).json();
  ok("api: no whole-field board — without a username the answer is the biggest tournament", b.live && b.filter.t === b.tournaments[0].name && b.total === b.tournaments[0].teams && b.total < b.teams, `${b.filter.t}: ${b.total} of ${b.teams}`); }

const nobody = boot(`${site}/u/nobody-xyz-123`); await wait(5000);
ok("unknown username → 'no teams yet' with the connect link", /No teams under/.test(text(nobody.d.getElementById("panel"))) && !!nobody.d.querySelector('#panel a[href="/"]') && nobody.d.querySelectorAll(".tile").length === 0, text(nobody.d.getElementById("panel")).slice(0, 80));
console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
