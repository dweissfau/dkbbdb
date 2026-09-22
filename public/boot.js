// Data loading for app.html, which on dkbbdb exists for ONE purpose: the team pop-up.
//   /team/<entry id>   one team's league view (standings, rosters, week by week). A profile page (/u/<name>) opens
//                      this in a full-screen frame when a row is clicked, so the pop-up is the same league view the
//                      template was built with. Closing it tells the parent page to remove the frame.
// There are no whole-portfolio dashboards here (the owner keeps those, and his partners' pages, on his own site):
// any other address goes back to the home page.
// Loads /api/portfolio?entry= into window.__DK, then runs /app.js (generated from the single-user dashboard
// template by scripts/build-app.mjs).
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const team = decodeURIComponent((/^\/team\/([^/]+)/.exec(location.pathname) ?? [])[1] ?? "").trim();
  if (!team) { location.replace("/"); return; }
  const query = "entry=" + encodeURIComponent(team);
  const framed = window.parent !== window;
  // a team link opened directly (shared, bookmarked): show it where it belongs — over its owner's page
  if (!framed) {
    fetch("/api/portfolio?" + query).then((r) => (r.ok ? r.json() : null))
      .then((d) => { const name = d?.me?.accounts?.[0]; location.replace(name ? `/u/${encodeURIComponent(name)}?team=${encodeURIComponent(team)}` : "/"); })
      .catch(() => location.replace("/"));
    return;
  }
  const closeFrame = () => { if (framed) window.parent.postMessage({ dkbbdb: "close-team" }, location.origin); else location.href = "/"; };

  // only the pop-up is visible; behind it is the dimmed parent page
  const css = document.createElement("style");
  css.textContent = "html, body { background: transparent !important; } body > *:not(#modal):not(#tooltip):not(.veil) { display: none !important; } #modal { background: rgba(0,0,0,.6); }";
  document.head.appendChild(css);
  const veil = document.createElement("div");
  veil.className = "veil";
  veil.style.cssText = "position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);color:#c3c2b7;display:grid;place-items:center;padding:24px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif";
  const say = (html) => { veil.innerHTML = `<div style="text-align:center;max-width:440px">${html}</div>`; };
  say("Loading team…");
  veil.addEventListener("click", closeFrame);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFrame(); });
  document.body.appendChild(veil);

  // (/api/live sends the compact view; app.js expands it itself — expandLive comes with the template)
  window.dkbbLiveUrl = () => "/api/live?" + query;

  const loadScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error("could not load " + src));
    document.head.appendChild(s);
  });

  async function start() {
    const res = await fetch("/api/portfolio?" + query);
    if (res.status === 404) { say("<p>That team is not on dkbbdb.</p>"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.__DK = await res.json();
    document.title = `${window.__DK.me.accounts.join(" + ")} · dkbbdb`;

    // open the league view as soon as the first live scores are in; when it closes, the frame goes away
    let opened = false;
    window.dkbbAfterLive = () => {
      if (opened) return;
      opened = true;
      window.openSeason(Number(team));
      veil.remove();
      const modal = $("#modal");
      new MutationObserver(() => { if (!modal.classList.contains("on")) closeFrame(); }).observe(modal, { attributes: true, attributeFilter: ["class"] });
    };
    await loadScript("/app.js");
    setTimeout(() => window.dkbbAfterLive(), 8000); // live scores unavailable: still show the rosters
  }

  start().catch((e) => say(`<p style="color:#e66767">Something went wrong: ${esc(e?.message ?? e)}</p><p><a href="" style="color:#3987e5">Try again</a></p>`));
})();
