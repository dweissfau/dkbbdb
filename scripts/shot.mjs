// Screenshot a page with the installed Chrome at a given width and report anything wider than the viewport.
//   node scripts/shot.mjs <url> <out.png> [width=430] [height=1000] [click=<css selector>]
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./db.mjs";
const puppeteer = createRequire(path.join(ROOT, "..", "package.json"))("puppeteer-core");
const [url, out, w = "430", h = "1000", click = ""] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
if (click) { await page.click(click); await new Promise((r) => setTimeout(r, 700)); }
const report = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth, wide = [];
  for (const el of document.querySelectorAll("body *")) { const r = el.getBoundingClientRect(); if (r.right > vw + 1 && r.width > 0) wide.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} right=${Math.round(r.right)} w=${Math.round(r.width)}`); }
  return { vw, scrollWidth: document.documentElement.scrollWidth, wide: wide.slice(0, 12) };
});
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: out, fullPage: false });
await browser.close();
