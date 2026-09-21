// Data loading for app.html. There is no sign-in — the address picks what to show, like bbmdb:
//   /u/<dk username>     that account's full portfolio page
//   /team/<entry id>     ONE team's league view only (standings, rosters, week by week). The front page opens
//                        this in a full-screen frame when a leaderboard row is clicked, so the pop-up is the very
//                        same UI as on the portfolio pages. Closing it tells the parent page to remove the frame.
// Loads /api/portfolio into window.__DK, then runs /app.js (generated from the single-user dashboard template
// by scripts/build-app.mjs).
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const part = (re) => decodeURIComponent((re.exec(location.pathname) ?? [])[1] ?? "").trim();
  const team = part(/^\/team\/([^/]+)/);
  const u = team ? "" : part(/^\/u\/([^/]+)/) || (new URLSearchParams(location.search).get("u") ?? "").trim();
  const query = team ? "entry=" + encodeURIComponent(team) : "u=" + encodeURIComponent(u);
  const framed = window.parent !== window;
  const closeFrame = () => { if (framed) window.parent.postMessage({ dkbbdb: "close-team" }, location.origin); else location.href = "/"; };

  const veil = document.createElement("div");
  veil.style.cssText = `position:fixed;inset:0;z-index:1000;background:${team ? "rgba(0,0,0,.6)" : "#0d0d0d"};color:#c3c2b7;display:grid;place-items:center;padding:24px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif`;
  const say = (html) => { veil.innerHTML = `<div style="text-align:center;max-width:440px">${html}</div>`; };
  say(team ? "Loading team…" : u ? `Loading ${esc(u)}’s teams…` : "");
  if (team) {
    // only the pop-up is visible; the page behind it is the dimmed leaderboard of the parent
    const css = document.createElement("style");
    css.textContent = "html, body { background: transparent !important; } body > *:not(#modal):not(#tooltip):not(.veil) { display: none !important; } #modal { background: rgba(0,0,0,.6); }";
    document.head.appendChild(css);
    veil.addEventListener("click", closeFrame);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFrame(); });
  }
  veil.className = "veil";
  document.body.appendChild(veil);

  // /api/live sends each roster row's game state as an index into view.games (lib/view.js compactView):
  // put the five fields back so the page script sees the rows it was written for
  window.dkbbExpand = (v) => {
    if (!v?.games) return v;
    const un = (row) => [...row.slice(0, 4), ...(v.games[row[4]] ?? [null, null, null, null, null]), ...row.slice(5)];
    for (const id of Object.keys(v.scores ?? {})) v.scores[id] = v.scores[id].map(un);
    for (const byKey of Object.values(v.opp?.rosters ?? {})) for (const k of Object.keys(byKey)) byKey[k] = byKey[k].map(un);
    return v;
  };
  window.dkbbLiveUrl = () => "/api/live?" + query;

  const loadScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error("could not load " + src));
    document.head.appendChild(s);
  });

  async function start() {
    if (!u && !team) { location.replace("/"); return; }
    const res = await fetch("/api/portfolio?" + query);
    if (res.status === 404) {
      say(team ? `<p>That team is not on dkbbdb.</p>` : `<h1 style="color:#fff;font-size:20px;margin:0 0 8px">No teams under “${esc(u)}” yet</h1>
        <p>Teams show up here after their owner syncs them from DraftKings with the dkbbdb extension.</p>
        <p><a href="/connect" style="color:#3987e5">Add your teams</a> · <a href="/" style="color:#3987e5">Back to the leaderboard</a></p>`);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.__DK = await res.json();
    document.title = `${window.__DK.me.accounts.join(" + ")} · dkbbdb`;

    if (team) {
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
    }
    await loadScript("/app.js");
    if (team) setTimeout(() => window.dkbbAfterLive(), 8000); // live scores unavailable: still show the rosters
    if (!team) { const who = $("#who"); if (who) who.textContent = window.__DK.me.accounts.join(" + "); veil.remove(); }
  }

  start().catch((e) => say(`<p style="color:#e66767">Something went wrong: ${esc(e?.message ?? e)}</p><p><a href="" style="color:#3987e5">Try again</a></p>`));
})();
