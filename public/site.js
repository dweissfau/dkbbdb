// Username search in the top bar (front page + connect page): suggestions from /api/search — synced
// accounts only — and Enter / click opens /u/<username>.
(() => {
  const form = document.getElementById("find"); if (!form) return;
  const q = form.querySelector("input"), hits = form.querySelector(".hits");
  const go = (name) => { location.href = "/u/" + encodeURIComponent(name.trim()); };
  let timer = 0, seq = 0;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const s = q.value.trim();
    if (s.length < 2) { hits.hidden = true; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { results } = await (await fetch("/api/search?q=" + encodeURIComponent(s))).json();
        if (mine !== seq) return;
        hits.replaceChildren(...(results.length ? results.map((r) => {
          const b = document.createElement("button");
          b.type = "button"; b.textContent = r.username;
          const n = document.createElement("span"); n.textContent = `${r.teams} team${r.teams === 1 ? "" : "s"}`;
          b.append(n); b.onclick = () => go(r.username);
          return b;
        }) : [Object.assign(document.createElement("div"), { className: "none", textContent: "No synced teams under that name yet" })]));
        hits.hidden = false;
      } catch { hits.hidden = true; }
    }, 180);
  });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") hits.hidden = true; });
  document.addEventListener("click", (e) => { if (!form.contains(e.target)) hits.hidden = true; });
  form.addEventListener("submit", (e) => { e.preventDefault(); if (q.value.trim()) go(q.value); });
})();
