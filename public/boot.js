// Data loading for the portfolio page (app.html, served at /u/<dk username>): there is no sign-in — the
// username in the address picks the portfolio, like bbmdb. Loads /api/portfolio into window.__DK, then
// runs /app.js (generated from the single-user dashboard template by scripts/build-app.mjs).
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const u = decodeURIComponent((/^\/u\/([^/]+)/.exec(location.pathname) ?? [])[1] ?? new URLSearchParams(location.search).get("u") ?? "").trim();
  window.dkbbUser = u;

  const veil = document.createElement("div");
  veil.style.cssText = "position:fixed;inset:0;z-index:1000;background:#0d0d0d;color:#c3c2b7;display:grid;place-items:center;padding:24px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif";
  const say = (html) => { veil.innerHTML = `<div style="text-align:center;max-width:440px">${html}</div>`; };
  say(u ? `Loading ${esc(u)}’s teams…` : "");
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
  window.dkbbLiveUrl = () => "/api/live?u=" + encodeURIComponent(u);

  const loadScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error("could not load " + src));
    document.head.appendChild(s);
  });

  async function start() {
    if (!u) { location.replace("/"); return; }
    const res = await fetch("/api/portfolio?u=" + encodeURIComponent(u));
    if (res.status === 404) {
      say(`<h1 style="color:#fff;font-size:20px;margin:0 0 8px">No teams under “${esc(u)}” yet</h1>
        <p>Teams show up here after their owner syncs them from DraftKings with the dkbbdb extension.</p>
        <p><a href="/connect" style="color:#3987e5">Add your teams</a> · <a href="/" style="color:#3987e5">Search another username</a></p>`);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.__DK = await res.json();
    document.title = `${window.__DK.me.accounts.join(" + ")} · dkbbdb`;
    await loadScript("/app.js");
    const who = $("#who"); if (who) who.textContent = window.__DK.me.accounts.join(" + ");
    veil.remove();
  }

  start().catch((e) => say(`<p style="color:#e66767">Something went wrong: ${esc(e?.message ?? e)}</p><p><a href="" style="color:#3987e5">Try again</a></p>`));
})();
