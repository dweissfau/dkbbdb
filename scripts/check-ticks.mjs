// Boot public/u.html in jsdom with fetch wired straight to lib/leaderboard.js (GET query or POST body, like
// api/leaderboard.js) and click through the ticked-teams flow (Teams rows → "Only ticked" / "Hide ticked" on both tabs).
//   node scripts/check-ticks.mjs [username]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { loadEnv, ROOT } from "./db.mjs";
import { leaderboard, playersView } from "../lib/leaderboard.js";
const { JSDOM } = createRequire(path.join(ROOT, "..", "package.json"))("jsdom");

let pending = 0; const settle = async () => { await new Promise((r) => setTimeout(r, 80)); while (pending > 0) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 150)); };

const name = process.argv[2] ?? "kknox20";

const html = fs.readFileSync(path.join(ROOT, "public", "u.html"), "utf8").replace('<script src="/site.js"></script>', `<script>${fs.readFileSync(path.join(ROOT, "public", "site.js"), "utf8")}</script>`);
const errors = [], calls = [];
const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://dkbbdb.com/u/" + name, pretendToBeVisual: true, beforeParse(w) {
  w.scrollTo = () => {};
  w.addEventListener("error", (e) => errors.push(e.message));
  w.fetch = async (u, init) => {
    const url = new URL(u, "https://dkbbdb.com");
    let q = Object.fromEntries(url.searchParams);
    if (init?.method === "POST") q = { ...q, ...JSON.parse(init.body) };
    calls.push({ method: init?.method ?? "GET", len: String(u).length, q });
    if (url.pathname !== "/api/leaderboard") return { ok: true, status: 200, json: async () => ({ results: [] }) };
    const fn = q.view === "players" ? playersView : leaderboard;
    pending++; let body; try { body = await fn(q); } finally { pending--; }
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
} });
const w = dom.window, d = w.document;
w.console.error = (...a) => errors.push(a.join(" "));
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const checks = []; const ok = (n, c, extra = "") => { checks.push(!!c); console.log(c ? "  ok  " : "  FAIL", n, extra); };
const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const rows = () => [...d.querySelectorAll("#rows tr[tabindex]")];
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const $ = (id) => d.getElementById(id);
await settle();

const total = Number(/(\d+) teams/.exec(text($("sub")))?.[1]);
ok("page loaded: teams table with a tick box per row and a tick-all box in the header", rows().length === 100 && rows().every((r) => r.querySelector("input.tick")) && !!$("tickAll") && total > 10, `${total} teams`);
ok("tick pills hidden until something is ticked", $("tickPills").hidden && $("active").hidden);
const id0 = rows()[0].dataset.id, id1 = rows()[1].dataset.id;
rows()[0].querySelector("input.tick").click(); await settle();
ok("ticking a row: chip '1 team ticked', row marked, pills shown, no pop-up opened", /1 team ticked/.test(text($("active"))) && rows()[0].classList.contains("ticked") && !$("tickPills").hidden && !d.querySelector("iframe.teamframe") && $("tickAll").indeterminate, text($("active")));
rows()[1].querySelector("input.tick").click(); await settle();
ok("second tick → '2 teams ticked', header line still every team (mode = All teams)", /2 teams ticked/.test(text($("active"))) && new RegExp(`^${total} teams`).test(text($("sub")).replace(/^DraftKings best ball · /, "")), text($("sub")));
click($("tickPills").querySelector('[data-tick-mode="only"]')); await settle();
ok("Only ticked: two rows, header '2 of N teams · 2 ticked', Advancing tile 'of 2'", rows().length === 2 && rows().map((r) => r.dataset.id).sort().join() === [id0, id1].sort().join() && new RegExp(`2 of ${total} teams · 2 ticked`).test(text($("sub"))) && /of 2/.test(text(d.querySelector(".tile.t-adv"))), `${text($("sub"))} | ${text(d.querySelector(".tile.t-adv"))}`);
ok("tick-all box is checked when every row in view is ticked", $("tickAll").checked && !$("tickAll").indeterminate);
click(d.querySelector('[data-tab="exposure"]')); await settle();
const owns = rows().map((r) => Number(text(r.querySelector("td.col-own")).replace("%", "")));
ok("Exposure tab follows: every player is on 50% or 100% of the two ticked teams, header keeps '2 of N'", rows().length > 10 && owns.every((o) => o === 50 || o === 100) && owns.includes(100) && new RegExp(`2 of ${total} teams · 2 ticked`).test(text($("sub"))) && !$("tickPills").hidden, `${rows().length} players, owns ${[...new Set(owns)].join("/")}`);
click($("tickPills").querySelector('[data-tick-mode="hide"]')); await settle();
ok("Hide ticked on Exposure: header 'N-2 of N teams · all but 2 ticked'", new RegExp(`${total - 2} of ${total} teams · all but 2 ticked`).test(text($("sub"))) && /hidden/.test(text($("active"))), text($("sub")));
click(d.querySelector('[data-tab="teams"]')); await settle();
ok("Teams tab under Hide ticked: the two ticked teams are gone", rows().length === 100 && !rows().some((r) => r.dataset.id === id0 || r.dataset.id === id1) && /hidden/.test(text($("active"))));
const saved = JSON.parse(w.localStorage.getItem("dkbbdb-ticks:" + name.toLowerCase()) ?? "{}");
ok("ticks + mode persisted per account", saved.ids?.length === 2 && saved.mode === "hide", JSON.stringify(saved));
click($("active").querySelector('[data-clear="ticks"]')); await settle();
ok("clearing the chip: every team back, pills hidden, mode reset", rows().length === 100 && $("tickPills").hidden && $("active").hidden && JSON.parse(w.localStorage.getItem("dkbbdb-ticks:" + name.toLowerCase())).mode === "", text($("sub")));
// tick-all → every team the filters leave, via the server's id list; a long list travels as a POST body
$("tickAll").click(); await settle();
ok("tick-all ticks every team, not just the loaded page", new RegExp(`${total} teams ticked`).test(text($("active"))) && rows().every((r) => r.querySelector("input.tick").checked), text($("active")));
const before = calls.length;
click($("tickPills").querySelector('[data-tick-mode="only"]')); await settle();
const posts = calls.slice(before).filter((c) => c.method === "POST");
ok("a long ticked list goes as a POST body and works: 'N of N teams · N ticked'", posts.length >= 1 && posts.every((c) => c.q.only.split(",").length === total && c.len < 200) && new RegExp(`${total} of ${total} teams · ${total} ticked`).test(text($("sub"))), `${posts.length} POST(s) · ${text($("sub"))}`);
$("tickAll").click(); await settle();
ok("unticking all from the header clears everything", rows().length === 100 && $("tickPills").hidden && $("active").hidden);
// the row click still opens the pop-up when it is not on the box
click(rows()[0].querySelector("td.contest")); await settle();
ok("clicking the row itself still opens the team pop-up", !!d.querySelector("iframe.teamframe"));
ok("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));
// every other account (now or signed up later): the plain page — no tick column, no pills, a stored tick list is ignored
{
  const other = "fleaflick";
  const dom2 = new JSDOM(html, { runScripts: "dangerously", url: "https://dkbbdb.com/u/" + other, pretendToBeVisual: true, beforeParse(w2) {
    w2.scrollTo = () => {}; w2.fetch = w.fetch; w2.addEventListener("error", (e) => errors.push("other: " + e.message));
    try { w2.localStorage.setItem("dkbbdb-ticks:" + other, JSON.stringify({ ids: ["1"], mode: "only" })); } catch { /* fine */ } } });
  const d2 = dom2.window.document; await settle(); await settle();
  const rows2 = [...d2.querySelectorAll("#rows tr[tabindex]")];
  ok("another account's page: no tick boxes, no pills, stored ticks ignored, every team shown", rows2.length === 10 && !d2.querySelector("input.tick") && !d2.getElementById("tickAll") && d2.getElementById("tickPills").hidden && !d2.body.classList.contains("ticks") && /10 teams/.test(text(d2.getElementById("sub"))) && errors.length === 0, `${rows2.length} rows · ${text(d2.getElementById("sub"))}`);
}

console.log(checks.every(Boolean) ? `\nall ${checks.length} checks pass` : `\n${checks.filter((c) => !c).length} FAILED`);
process.exit(checks.every(Boolean) ? 0 : 1);
