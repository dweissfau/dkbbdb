// Runs on https://www.draftkings.com/draft/tournament/<key> — a tournament's own page, which shows its payout
// table to a signed-in user. When the table has rendered, the payout-related lines of the page's text are sent
// to dkbbdb.com so the site can read the guaranteed prize per round (the "Winning" stat). Nothing else on the
// page is read; no credentials are touched.
(() => {
  "use strict";
  const key = (/\/draft\/tournament\/([0-9a-f]{32})/i.exec(location.pathname) ?? [])[1];
  if (!key) return;
  const bg = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err) }));
  const HOT = /advance|round\s*\d|payout|prize|guarantee|finals?|\$\s?\d/i;

  // payout-related windows of the page text, deduplicated, capped
  function excerpt(text) {
    const t = String(text).replace(/\s+/g, " ");
    const out = [], seen = new Set(); let m;
    const re = new RegExp(HOT.source, "gi");
    while ((m = re.exec(t)) && out.join("").length < 40000) {
      const from = Math.max(0, m.index - 500), to = Math.min(t.length, m.index + 500);
      const w = t.slice(from, to); const k = w.slice(0, 80);
      if (!seen.has(k)) { seen.add(k); out.push(w); }
      re.lastIndex = to;
    }
    return out.join("\n…\n");
  }

  const toast = (msg) => {
    const d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;background:#0d0d0d;color:#c3c2b7;border:1px solid #383835;" +
      "font:12.5px/1.4 system-ui,-apple-system,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.5)";
    document.body.appendChild(d); setTimeout(() => d.remove(), 6000);
  };

  // wait for the table to render: the text must mention rounds/prizes with dollar amounts and stop changing
  let tries = 0, last = "";
  const tick = async () => {
    const text = document.body?.innerText ?? "";
    const ready = /\$\s?\d/.test(text) && /advance|round|payout|prize/i.test(text) && text.length === last.length;
    last = text;
    if (!ready && ++tries < 30) return setTimeout(tick, 1000);
    if (!ready) return;
    const body = excerpt(text);
    if (!body) return;
    const name = (document.querySelector("h1")?.textContent ?? document.title ?? "").trim().slice(0, 200) || null;
    const r = await bg({ type: "TOURNAMENTS", tournaments: [{ key: key.toUpperCase(), name, sources: [{ url: `dom:/draft/tournament/${key.toLowerCase()}`, status: 200, body }] }] });
    const got = r?.tournaments?.[key.toUpperCase()]?.ladder;
    toast(r?.ok ? (got ? `dkbbdb: payout table read (round 2 = $${got["2"]})` : "dkbbdb: payout table sent") : `dkbbdb: could not send the payout table (${r?.error ?? "unknown error"})`);
  };
  setTimeout(tick, 1500);
})();
