// Runs on https://www.draftkings.com/draft/tournament/<key> — a tournament's own page, which shows its payout
// table to a signed-in user (behind its "Tournament Details" tab). The script opens that tab, and sends the
// payout-related lines of the page's text — from the contest's heading down, never the account header above it —
// to dkbbdb.com so the site can read the guaranteed prize per round (the "Winning" stat). It sends again if the
// table appears later. Nothing else is read; no credentials are touched.
(() => {
  "use strict";
  const key = (/\/draft\/tournament\/([0-9a-f]{32})/i.exec(location.pathname) ?? [])[1];
  if (!key) return;
  const bg = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err) }));
  const HOT = /advance|round\s*\d|payout|prize|guarantee|finals?|\$\s?\d/i;

  // the page's text from the contest's heading on (the site header with the account's balance is above it)
  function pageText() {
    const t = String(document.body?.innerText ?? "").replace(/\s+/g, " ");
    const i = t.search(/contest details|tournament details/i);
    return i > 0 ? t.slice(i) : t;
  }
  // payout-related windows of that text, deduplicated, capped
  function excerpt(t) {
    const out = [], seen = new Set(); let m;
    const re = new RegExp(HOT.source, "gi");
    while ((m = re.exec(t)) && out.join("").length < 40000) {
      const from = Math.max(0, m.index - 600), to = Math.min(t.length, m.index + 600);
      const w = t.slice(from, to), k = w.slice(0, 80);
      if (!seen.has(k)) { seen.add(k); out.push(w); }
      re.lastIndex = to;
    }
    return out.join("\n…\n");
  }
  const looksLikeTable = (t) => /round\s*[2-9]|advance|finals?/i.test(t) && /\$\s?\d/.test(t);
  // the page's own "Contest Details" link (its pop-up holds the PRIZE PAYOUTS table) — a plain click, as the user would
  function openDetails() {
    for (const el of document.querySelectorAll("a, button, li, [role=tab], span, div")) {
      const s = (el.textContent ?? "").trim();
      if (/^contest details$/i.test(s) && el.children.length <= 2 && el.offsetParent !== null) { el.click(); return true; }
    }
    return false;
  }

  const toast = (msg) => {
    document.getElementById("dkbbdb-toast")?.remove();
    const d = document.createElement("div");
    d.id = "dkbbdb-toast"; d.textContent = msg;
    d.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;background:#0d0d0d;color:#c3c2b7;border:1px solid #383835;" +
      "font:12.5px/1.4 system-ui,-apple-system,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.5);max-width:360px";
    document.body.appendChild(d); setTimeout(() => d.remove(), 8000);
  };

  let sent = "";
  async function send() {
    const text = pageText(), body = excerpt(text);
    if (!body) return;
    const sig = `${body.length}:${body.slice(0, 300)}`;
    if (sig === sent) return;
    sent = sig;
    const name = (document.querySelector("h1")?.textContent ?? document.title ?? "").trim().slice(0, 200) || null;
    const r = await bg({ type: "TOURNAMENTS", tournaments: [{ key: key.toUpperCase(), name, sources: [{ url: `dom:/draft/tournament/${key.toLowerCase()}`, status: 200, body }] }] });
    const got = r?.tournaments?.[key.toUpperCase()]?.ladder;
    toast(!r?.ok ? `dkbbdb: could not send the payout table (${r?.error ?? "unknown error"})`
      : got ? `dkbbdb: payout table read — reaching round 2 is worth at least $${got["2"]}`
      : looksLikeTable(text) ? "dkbbdb: payout text sent for a closer look" : "dkbbdb: page sent — click Contest Details to show the payout table");
  }
  // whenever the page changes (a tab opened, the table rendered), send again once it looks like a payout table
  function watch() {
    let timer = 0;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { if (looksLikeTable(pageText())) send(); }, 1500); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  // wait for the page to settle, open the details tab, send, then keep watching
  let tries = 0, last = -1;
  const tick = () => {
    const n = pageText().length, settled = n === last; last = n;
    if (!settled && ++tries < 30) return setTimeout(tick, 1000);
    openDetails();
    // the pop-up can take a moment (or a second click) to render its table
    setTimeout(async () => { if (!looksLikeTable(pageText())) openDetails(); await new Promise((r) => setTimeout(r, 2000)); await send(); watch(); }, 2500);
  };
  setTimeout(tick, 1500);
})();
