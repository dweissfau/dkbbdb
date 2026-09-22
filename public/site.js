// Suggestion box for the profile page's player filter:
//   dkbbSuggest(formEl, "player", onPick, { u: username })   → onPick(result) with a row of /api/search
// Enter picks the first suggestion; Esc / click-away closes the list.
window.dkbbSuggest = (form, type, onPick, scope = {}) => {
  const q = form.querySelector("input"), hits = form.querySelector(".hits");
  let timer = 0, seq = 0, last = [];
  // a row looks like the player rows elsewhere: position badge, team logo, name — and how many teams have him
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LOGO_ABBR = { WAS: "wsh" };
  const logo = (team) => { const t = String(team ?? "").toUpperCase(); return /^[A-Z]{2,3}$/.test(t) && t !== "FA" && t !== "TBD"
    ? `<img class="tlogo" src="https://a.espncdn.com/i/teamlogos/nfl/500/${LOGO_ABBR[t] ?? t.toLowerCase()}.png" alt="${esc(t)}" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<span class="tlogo"></span>`; };
  const label = (r) => type === "player" ? `<b class="pos ${esc(r.pos)}">${esc(r.pos)}</b>${logo(r.team)}<span class="pname">${esc(r.name)}</span>` : esc(r.username);
  const sub = (r) => `${r.teams} team${r.teams === 1 ? "" : "s"}`;
  const pick = (r) => { hits.hidden = true; q.value = ""; q.blur(); onPick(r); };
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const s = q.value.trim();
    if (s.length < 2) { hits.hidden = true; last = []; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { results } = await (await fetch(`/api/search?type=${type}&q=${encodeURIComponent(s)}${scope.u ? "&u=" + encodeURIComponent(scope.u) : ""}`)).json();
        if (mine !== seq) return;
        last = results;
        hits.replaceChildren(...(results.length ? results.map((r) => {
          const b = document.createElement("button");
          b.type = "button"; b.innerHTML = `<span class="who">${label(r)}</span><span>${sub(r)}</span>`;
          b.onclick = () => pick(r);
          return b;
        }) : [Object.assign(document.createElement("div"), { className: "none", textContent: type === "player" ? "Nobody has a player by that name" : "No synced teams under that name yet" })]));
        hits.hidden = false;
      } catch { hits.hidden = true; }
    }, 180);
  });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") hits.hidden = true; });
  document.addEventListener("click", (e) => { if (!form.contains(e.target)) hits.hidden = true; });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (last.length) pick(last[0]);
  });
};
