// "Save image" on the team pop-up: a share card of one team, drawn on a canvas from the team's own picks — QB, then RB,
// then WR, then TE, each group in the order the players were drafted. Loaded by boot.js after app.js; it reads the
// pop-up's globals (DK, P, SEA, draftById, picksByEntry, podRoster, shortContest, openSeason.current) and puts a
// "Save image" button beside the close ✕ whenever the pop-up is (re)drawn. On a phone the image goes to the share
// sheet, elsewhere it downloads as a PNG. Team logos come from the same CDN the page uses (it allows canvas use).
(() => {
  const ORDER = ["QB", "RB", "WR", "TE"];
  const COLOR = { QB: "#e03a3a", RB: "#1f9d4f", WR: "#f2c200", TE: "#3987e5", other: "#898781" };
  const INK = "#ffffff", INK2 = "#c3c2b7", MUTED = "#898781", PAGE = "#0d0d0d", SURFACE = "#1a1a19", LINE = "rgba(255,255,255,.10)", GOOD = "#0ca30c", ACCENT = "#3987e5";
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const W = 1080, PAD = 56;
  const LOGO_ABBR = { WAS: "wsh" };
  const logoUrl = (team) => { const t = String(team ?? "").toUpperCase(); return /^[A-Z]{2,3}$/.test(t) && t !== "FA" && t !== "TBD" ? `https://a.espncdn.com/i/teamlogos/nfl/500/${LOGO_ABBR[t] ?? t.toLowerCase()}.png` : null; };

  // images are fetched once and kept; a logo that fails or takes too long is simply left off the card
  const images = new Map();
  const loadImage = (src, ms = 3000) => {
    if (images.has(src)) return images.get(src);
    const p = new Promise((ok) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const done = (v) => { clearTimeout(t); ok(v); };
      const t = setTimeout(() => done(null), ms);
      img.onload = () => done(img); img.onerror = () => done(null);
      img.src = src;
    });
    images.set(src, p);
    return p;
  };

  // the team's picks, grouped by position in ORDER (anything else last), each group in draft order
  function groups(id) {
    const picks = (picksByEntry.get(id) ?? []).slice().sort((a, b) => a.pk - b.pk);
    const by = new Map();
    for (const pk of picks) {
      const p = P[pk.pl] ?? {};
      const pos = ORDER.includes(p.p) ? p.p : "other";
      if (!by.has(pos)) by.set(pos, []);
      by.get(pos).push({ pk: pk.pk, r: pk.r, pr: pk.pr, name: p.n ?? String(pk.pl), team: p.t ?? "", pos: p.p ?? "" });
    }
    return [...ORDER, "other"].filter((k) => by.has(k)).map((k) => [k, by.get(k)]);
  }

  const fmtPts = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt$ = (n) => "$" + (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const localDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function clip(ctx, text, maxW) { // shorten with an ellipsis so a long name never runs into the next column
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text; while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1); return s + "…";
  }

  async function render(id) {
    const d = draftById.get(id);
    if (!d) throw new Error("team not loaded");
    const gs = groups(id);
    if (!gs.length) throw new Error("no picks for this team");
    const user = DK.me?.accounts?.[0] ?? "";
    const syn = SEA.status?.[id] ?? {};
    const pod = (SEA.pods?.[d.contestId] ?? []).find((x) => x[0] === d.id);
    const rank = syn.rank ?? pod?.[2] ?? null, entrants = syn.entrants ?? d.ent ?? d.size ?? null, points = syn.points ?? pod?.[3] ?? null, cut = syn.pp ?? d.pp ?? null;
    // season points per player (weeks he started), when the roster has been scored
    const season = new Map((podRoster?.(d.contestId, d.id) ?? []).filter((p) => p.season != null).map((p) => [p.name, p.season]));
    const scored = points != null;

    // ---- measure ----
    const ROW = 54, HEAD = 58, GAP = 22;
    const top = 320 + (scored ? 44 : 0);
    const body = gs.reduce((h, [, rows]) => h + HEAD + rows.length * ROW + GAP, 0);
    const H = top + body + 26; // no footer: the header already says dkbbdb.com
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    const [crown, ...logos] = await Promise.all([loadImage("/crown.svg"), ...gs.flatMap(([, rows]) => rows.map((r) => { const u = logoUrl(r.team); return u ? loadImage(u) : Promise.resolve(null); }))]);
    const logoOf = new Map(); { let i = 0; for (const [, rows] of gs) for (const r of rows) logoOf.set(r, logos[i++]); }

    // ---- background ----
    ctx.fillStyle = PAGE; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = SURFACE; roundRect(ctx, 24, 24, W - 48, H - 48, 28); ctx.fill();

    // ---- header: crown + wordmark, site on the right ----
    let y = PAD;
    if (crown) ctx.drawImage(crown, PAD, y - 2, 40, 40);
    ctx.fillStyle = INK; ctx.font = `700 34px ${FONT}`; ctx.textBaseline = "top";
    ctx.fillText("dkbbdb", PAD + 52, y + 1);
    ctx.fillStyle = MUTED; ctx.font = `500 22px ${FONT}`; ctx.textAlign = "right";
    ctx.fillText("dkbbdb.com", W - PAD, y + 8); ctx.textAlign = "left";

    // ---- who / what ----
    y += 84;
    ctx.fillStyle = INK; ctx.font = `800 54px ${FONT}`; ctx.fillText(clip(ctx, user, W - PAD * 2), PAD, y);
    y += 74;
    ctx.fillStyle = INK2; ctx.font = `600 30px ${FONT}`; ctx.fillText(clip(ctx, shortContest(d.name), W - PAD * 2), PAD, y);
    y += 48;
    ctx.fillStyle = MUTED; ctx.font = `400 24px ${FONT}`;
    const meta = [d.date ? `drafted ${localDate(d.date)}` : "", d.slot != null ? `pick ${d.slot} of ${d.size}` : d.size ? `${d.size} teams` : "", d.buyIn != null ? fmt$(d.buyIn) : "", `entry ${d.id}`].filter(Boolean).join("  ·  ");
    ctx.fillText(clip(ctx, meta, W - PAD * 2), PAD, y);
    if (scored) {
      y += 44;
      const adv = rank != null && cut != null && rank <= cut;
      ctx.font = `700 26px ${FONT}`;
      let x = PAD;
      if (rank != null) { ctx.fillStyle = adv ? GOOD : INK; const s = `${rank}${entrants ? ` / ${entrants}` : ""}`; ctx.fillText(s, x, y); x += ctx.measureText(s).width; ctx.fillStyle = MUTED; ctx.font = `400 26px ${FONT}`; ctx.fillText("  ·  ", x, y); x += ctx.measureText("  ·  ").width; }
      ctx.fillStyle = INK; ctx.font = `700 26px ${FONT}`; const pts = `${fmtPts(points)} pts`; ctx.fillText(pts, x, y); x += ctx.measureText(pts).width;
      if (adv) { ctx.fillStyle = MUTED; ctx.font = `400 26px ${FONT}`; ctx.fillText("  ·  ", x, y); x += ctx.measureText("  ·  ").width; ctx.fillStyle = GOOD; ctx.font = `700 26px ${FONT}`; ctx.fillText("advancing", x, y); }
    }
    y = top;

    // ---- position groups ----
    for (const [pos, rows] of gs) {
      const color = COLOR[pos];
      // group header: coloured badge with the position, the count, and a rule in the group's colour
      ctx.fillStyle = color; roundRect(ctx, PAD, y + 8, 76, 36, 8); ctx.fill();
      ctx.fillStyle = pos === "WR" ? "#1a1a19" : "#fff"; ctx.font = `800 22px ${FONT}`; ctx.textAlign = "center"; ctx.fillText(pos === "other" ? "—" : pos, PAD + 38, y + 15); ctx.textAlign = "left";
      ctx.fillStyle = MUTED; ctx.font = `500 22px ${FONT}`; ctx.fillText(`${rows.length} drafted`, PAD + 92, y + 15);
      ctx.strokeStyle = color; ctx.globalAlpha = .45; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(PAD, y + HEAD - 4); ctx.lineTo(W - PAD, y + HEAD - 4); ctx.stroke(); ctx.globalAlpha = 1;
      y += HEAD;
      for (const r of rows) {
        const mid = y + ROW / 2;
        // pick as round.pick, overall in grey
        ctx.textBaseline = "middle";
        ctx.fillStyle = color; ctx.font = `700 24px ${FONT}`; ctx.fillText(r.r != null && r.pr != null ? `${r.r}.${String(r.pr).padStart(2, "0")}` : String(r.pk), PAD, mid);
        ctx.fillStyle = MUTED; ctx.font = `400 20px ${FONT}`; ctx.fillText(`#${r.pk}`, PAD + 84, mid);
        const logo = logoOf.get(r);
        if (logo) ctx.drawImage(logo, PAD + 150, mid - 19, 38, 38);
        ctx.fillStyle = INK; ctx.font = `600 27px ${FONT}`;
        const nameW = W - PAD - (PAD + 202) - 200;
        const shown = clip(ctx, r.name, nameW), shownW = ctx.measureText(shown).width;
        ctx.fillText(shown, PAD + 202, mid);
        ctx.fillStyle = MUTED; ctx.font = `500 22px ${FONT}`; ctx.fillText(r.team, PAD + 202 + shownW + 14, mid);
        const pts = season.get(r.name);
        if (pts != null) { ctx.fillStyle = INK2; ctx.font = `600 24px ${FONT}`; ctx.textAlign = "right"; ctx.fillText(fmtPts(pts), W - PAD, mid); ctx.textAlign = "left"; }
        ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y + ROW - .5); ctx.lineTo(W - PAD, y + ROW - .5); ctx.stroke();
        ctx.textBaseline = "top";
        y += ROW;
      }
      y += GAP;
    }

    return canvas;
  }

  async function save(id, el, btn) {
    const d = draftById.get(id);
    const was = el.textContent; el.textContent = "Drawing…"; if (btn) btn.disabled = true;
    try {
      const canvas = await render(id);
      const blob = await new Promise((ok) => canvas.toBlob(ok, "image/png"));
      const name = `${(DK.me?.accounts?.[0] ?? "team").replace(/[^\w.-]+/g, "_")}-${shortContest(d?.name).replace(/[^\w.-]+/g, "_").slice(0, 40)}-${id}.png`;
      const file = new File([blob], name, { type: "image/png" });
      // phones and tablets get the share sheet (which has "Save image"); a desktop browser just downloads the file
      if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: `${DK.me?.accounts?.[0] ?? ""} · ${shortContest(d?.name)}` }); return; }
        catch (e) { if (e?.name === "AbortError") return; /* share refused: fall back to a download */ }
      }
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      alert(`Couldn't make the image: ${e?.message ?? e}`);
    } finally { el.textContent = was; if (btn) btn.disabled = false; }
  }

  // a "Save image" button at the top of the pop-up, beside the close ✕, every time the pop-up is drawn
  const style = document.createElement("style");
  style.textContent = `
#modal .card-btn { float: right; margin: -1px 10px 0 8px; display: inline-flex; align-items: center; gap: 6px; background: var(--accent); color: #fff;
  border: 0; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; line-height: 1.2; cursor: pointer; }
#modal .card-btn:hover { filter: brightness(1.12); }
#modal .card-btn:disabled { opacity: .6; cursor: default; }
#modal .card-btn svg { width: 15px; height: 15px; flex: none; }
@media (max-width: 700px) { #modal .card-btn { margin: 0 8px 0 6px; padding: 6px 10px; } }`;
  document.head.appendChild(style);
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>';
  function addButton() {
    const box = document.getElementById("modalBox");
    const id = window.openSeason?.current?.id;
    if (!box || id == null || box.querySelector(".card-btn")) return;
    const close = box.querySelector(".close"); if (!close) return;
    const btn = document.createElement("button");
    btn.className = "card-btn"; btn.type = "button"; btn.dataset.card = String(id);
    btn.innerHTML = `${ICON}<span>Save image</span>`;
    btn.title = "Save this team as an image: QB, RB, WR, TE in draft order";
    close.after(btn);
    btn.addEventListener("click", () => save(Number(btn.dataset.card), btn.querySelector("span"), btn));
    // warm the logos so the image is ready by the time the button is tapped
    for (const [, rows] of groups(id)) for (const r of rows) { const u = logoUrl(r.team); if (u) loadImage(u); }
  }
  const box = document.getElementById("modalBox");
  if (box) new MutationObserver(addButton).observe(box, { childList: true });
  addButton();
  window.dkbbCard = { render, groups };
})();
