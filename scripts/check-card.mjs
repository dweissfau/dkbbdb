// Draw one team's share card (public/card.js) in the installed Chrome and save it as a PNG, plus a screenshot of the
// pop-up with its "save image" link. Runs against a local dev server (scripts/dev-server.mjs, which proxies /api to
// the live site) so an undeployed card.js can be checked.
//   node scripts/check-card.mjs <site base> <username> <entry id> <out dir>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./db.mjs";
const puppeteer = createRequire(path.join(ROOT, "..", "package.json"))("puppeteer-core");
const [site = "http://localhost:8787", user = "ajnesbit", id = "5189037736", out = "."] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
await page.goto(`${site}/u/${encodeURIComponent(user)}?team=${id}`, { waitUntil: "networkidle2", timeout: 90000 });
const frameEl = await page.waitForSelector("iframe.teamframe", { timeout: 30000 });
const frame = await frameEl.contentFrame();
await frame.waitForSelector(".card-btn", { timeout: 40000 });
await page.screenshot({ path: path.join(out, "card-popup.png") });
const dataUrl = await frame.evaluate(async (id) => { const c = await window.dkbbCard.render(Number(id)); return c.toDataURL("image/png"); }, id);
fs.writeFileSync(path.join(out, "card.png"), Buffer.from(dataUrl.split(",")[1], "base64"));
const groups = await frame.evaluate((id) => window.dkbbCard.groups(Number(id)).map(([k, rows]) => `${k}: ${rows.map((r) => `${r.r}.${r.pr} ${r.name}`).join(", ")}`), id);
console.log(groups.join("\n"));
console.log("saved", path.join(out, "card.png"));
await browser.close();
