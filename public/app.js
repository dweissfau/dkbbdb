"use strict";
const DK = window.__DK; // set by boot.js from /api/portfolio
const P = DK.players;               // playerId -> {n, p, t, dk}
const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3 };
const fmt$ = (n) => "$" + (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPct = (n) => (100 * n).toFixed(1) + "%";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const localDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }) : "—");
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const picksByEntry = new Map();
for (const pk of DK.picks) {
  if (!picksByEntry.has(pk.e)) picksByEntry.set(pk.e, []);
  picksByEntry.get(pk.e).push(pk);
}
for (const arr of picksByEntry.values()) arr.sort((a, b) => a.pk - b.pk);
const draftById = new Map(DK.drafts.map((d) => [d.id, d]));

// ---------- filters ----------
const F = { pos: "", team: "", contests: null, buyins: null, from: "", to: "", lastN: "", adpMax: "", search: "" }; // contests/buyins: null = all, Set = only these
function filteredDrafts() {
  let out = DK.drafts.filter((d) => {
    if (F.contests && !F.contests.has(d.name)) return false;
    if (F.buyins && !F.buyins.has(String(d.buyIn))) return false;
    if (d.date) {
      const k = dayKey(d.date);
      if (F.from && k < F.from) return false;
      if (F.to && k > F.to) return false;
    }
    return true;
  });
  const n = Number(F.lastN);
  if (n > 0) out = out.slice(-n); // DK.drafts is ordered by draft date ascending
  return out;
}

// ---------- tooltip ----------
const tip = document.getElementById("tooltip");
function showTip(html, ev) {
  tip.innerHTML = html; tip.style.display = "block";
  tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = (ev.clientY + 14) + "px";
}
function hideTip() { tip.style.display = "none"; }

// ---------- sortable table helper ----------
function renderTable(tableEl, cols, rows, state, rerender) {
  const thead = tableEl.querySelector("thead");
  thead.innerHTML = "<tr>" + cols.map((c) =>
    `<th class="${c.num ? "num " : ""}${c.sort ? "sortable" : ""}" data-key="${c.key}">${c.label}` +
    (state.key === c.key ? ` <span class="arrow">${state.dir > 0 ? "▲" : "▼"}</span>` : "") + "</th>").join("") + "</tr>";
  thead.querySelectorAll("th.sortable").forEach((th) => th.onclick = () => {
    const k = th.dataset.key;
    if (state.key === k) state.dir = -state.dir; else { state.key = k; state.dir = -1; }
    rerender();
  });
  const col = cols.find((c) => c.key === state.key);
  if (col) rows.sort((a, b) => {
    const x = a[state.key], y = b[state.key];
    const r = typeof x === "string" ? String(x ?? "").localeCompare(String(y ?? "")) : (x ?? -Infinity) - (y ?? -Infinity);
    return r * state.dir;
  });
  tableEl.querySelector("tbody").innerHTML = rows.map((r) => r.__html).join("");
  // tag body cells with their column key (phone CSS hides low-value columns by key; no effect on desktop)
  tableEl.querySelectorAll("tbody tr").forEach((tr) => { let i = 0; for (const td of tr.children) { if (cols[i]) td.dataset.key = cols[i].key; i++; } });
}

// ---------- exposure tab ----------
const expState = { key: "count", dir: -1 };
function computeExposure(drafts) {
  const byPlayer = new Map();
  for (const d of drafts) {
    for (const pk of picksByEntry.get(d.id) ?? []) {
      let r = byPlayer.get(pk.pl);
      if (!r) byPlayer.set(pk.pl, r = { picks: [], adps: [], dollars: 0 });
      r.picks.push(pk.pk);
      r.dollars += d.buyIn ?? 0;
      if (pk.adp != null) r.adps.push(pk.adp);
    }
  }
  return byPlayer;
}
function renderExposure() {
  const drafts = filteredDrafts();
  const total = drafts.length;
  const totalFees = drafts.reduce((s, d) => s + (d.buyIn ?? 0), 0);
  const byPlayer = computeExposure(drafts);
  const q = F.search.trim().toLowerCase();
  const rows = [];
  for (const [pid, r] of byPlayer) {
    const p = P[pid] ?? {};
    if (F.pos && p.p !== F.pos) continue;
    if (F.team && p.t !== F.team) continue;
    if (q && !(p.n ?? "").toLowerCase().includes(q)) continue;
    const picks = r.picks.slice().sort((a, b) => a - b);
    const med = picks[Math.floor(picks.length / 2)];
    const avg = picks.reduce((s, x) => s + x, 0) / picks.length;
    const adp = r.adps.length ? r.adps.reduce((s, x) => s + x, 0) / r.adps.length : null;
    if (F.adpMax && !(adp != null && adp <= Number(F.adpMax))) continue;
    const diff = adp != null ? adp - avg : null; // + = drafted earlier than ADP
    const row = {
      name: p.n ?? String(pid), pos: p.p ?? "?", team: p.t ?? "?", count: picks.length,
      expo: total ? picks.length / total : 0, dollars: r.dollars,
      dexpo: totalFees ? r.dollars / totalFees : 0,
      avg, min: picks[0], max: picks[picks.length - 1], med,
      adp, diff,
    };
    row.__html = `<tr>
      <td>${logo(row.team)}<span class="plink" onclick="openPlayer(${Number(pid)})" title="Show all drafts with ${esc(row.name)}">${esc(row.name)}</span></td>
      <td><span class="pos ${row.pos}">${row.pos}</span></td>
      <td>${row.team}</td>
      <td class="num">${row.count} / ${total}</td>
      <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, 100 * row.expo).toFixed(1)}%"></div></div><span>${fmtPct(row.expo)}</span></div></td>
      <td class="num">${fmt$(row.dollars)}</td>
      <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, 100 * row.dexpo).toFixed(1)}%"></div></div><span>${fmtPct(row.dexpo)}</span></div></td>
      <td class="num">${avg.toFixed(1)}</td>
      <td class="num">${row.min}</td>
      <td class="num">${row.max}</td>
      <td class="num">${med}</td>
      <td class="num">${adp != null ? adp.toFixed(1) : "—"}</td>
      <td class="num ${diff == null ? "" : diff >= 0 ? "diff-bad" : "diff-good"}">${diff == null ? "—" : (diff >= 0 ? "−" : "+") + Math.abs(diff).toFixed(1)}</td>
    </tr>`;
    rows.push(row);
  }
  renderTable(document.getElementById("expTable"), [
    { key: "name", label: "Player", sort: 1 }, { key: "pos", label: "Pos", sort: 1 },
    { key: "team", label: "Team", sort: 1 }, { key: "count", label: "Rosters", num: 1, sort: 1 },
    { key: "expo", label: "Exposure", sort: 1 },
    { key: "dollars", label: "$ at stake", num: 1, sort: 1 },
    { key: "dexpo", label: "$ Exposure", sort: 1 },
    { key: "avg", label: "Avg pick", num: 1, sort: 1 },
    { key: "min", label: "Earliest", num: 1, sort: 1 }, { key: "max", label: "Latest", num: 1, sort: 1 },
    { key: "med", label: "Median", num: 1, sort: 1 }, { key: "adp", label: "DK ADP", num: 1, sort: 1 },
    { key: "diff", label: "vs ADP", num: 1, sort: 1 },
  ], rows, expState, renderExposure);
  document.getElementById("filterCount").textContent = `${rows.length} players · ${total} rosters · ${fmt$(totalFees)} in filter`;
}

// ---------- balance ----------
const balState = { key: "adp", dir: 1 };
function renderBalance() {
  const table = document.getElementById("balTable");
  if (!DK.pool?.length) {
    document.getElementById("balNote").textContent = "no player pool in database — run npm run refresh once to populate it";
    table.querySelector("tbody").innerHTML = "";
    return;
  }
  const drafts = filteredDrafts();
  const total = drafts.length || 1;
  const counts = new Map();
  for (const d of drafts) for (const pk of picksByEntry.get(d.id) ?? []) counts.set(pk.pl, (counts.get(pk.pl) ?? 0) + 1);
  const avgSize = drafts.length ? drafts.reduce((s, d) => s + (d.size ?? 12), 0) / drafts.length : 12;
  const neutral = 1 / avgSize;
  document.getElementById("balNote").textContent =
    `every player in the current pool vs the neutral baseline of 1 ÷ ${avgSize.toFixed(0)} = ${fmtPct(neutral)} — sort "vs neutral" to find who you're over/under on`;
  const q = F.search.trim().toLowerCase();
  const rows = [];
  for (const pl of DK.pool) {
    if (!(pl.p in POS_ORDER)) continue;
    if (F.pos && pl.p !== F.pos) continue;
    if (F.team && pl.t !== F.team) continue;
    if (F.adpMax && !(pl.adp <= Number(F.adpMax))) continue;
    if (q && !(pl.n ?? "").toLowerCase().includes(q)) continue;
    const c = counts.get(pl.pl) ?? 0;
    const expo = c / total;
    const delta = expo - neutral;
    let chip, chipCls;
    if (c === 0) { chip = "None"; chipCls = "none"; }
    else if (expo >= 2 * neutral) { chip = "High"; chipCls = "high"; }
    else if (expo <= 0.5 * neutral) { chip = "Low"; chipCls = "low"; }
    else { chip = "Balanced"; chipCls = "ok"; }
    const row = { name: pl.n ?? String(pl.pl), pos: pl.p, team: pl.t ?? "?", adp: pl.adp, count: c, expo, delta, chip };
    row.__html = `<tr>
      <td>${logo(row.team)}<span class="plink" onclick="openPlayer(${pl.pl})">${esc(row.name)}</span></td>
      <td><span class="pos ${pl.p}">${pl.p}</span></td>
      <td>${row.team}</td>
      <td class="num">${pl.adp}</td>
      <td class="num">${c} / ${total}</td>
      <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, 100 * expo).toFixed(1)}%"></div></div><span>${fmtPct(expo)}</span></div></td>
      <td class="num">${(delta >= 0 ? "+" : "−") + (100 * Math.abs(delta)).toFixed(1)} pp</td>
      <td><span class="chip ${chipCls}">${chip}</span></td>
    </tr>`;
    rows.push(row);
  }
  renderTable(table, [
    { key: "name", label: "Player", sort: 1 }, { key: "pos", label: "Pos", sort: 1 },
    { key: "team", label: "Team", sort: 1 }, { key: "adp", label: "ADP", num: 1, sort: 1 },
    { key: "count", label: "Rosters", num: 1, sort: 1 }, { key: "expo", label: "Exposure", sort: 1 },
    { key: "delta", label: "vs neutral", num: 1, sort: 1 }, { key: "chip", label: "Status", sort: 1 },
  ], rows, balState, renderBalance);
}

// ---------- overview ----------
function renderOverview() {
  const drafts = DK.drafts;
  const byPlayer = computeExposure(drafts);
  let topPlayer = null;
  for (const [pid, r] of byPlayer) if (!topPlayer || r.picks.length > topPlayer.count) topPlayer = { pid, count: r.picks.length };
  const teamCount = new Map();
  for (const d of drafts) {
    const teams = new Set((picksByEntry.get(d.id) ?? []).map((pk) => P[pk.pl]?.t).filter(Boolean));
    for (const t of teams) teamCount.set(t, (teamCount.get(t) ?? 0) + 1);
  }
  const topTeam = [...teamCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const complete = drafts.filter((d) => d.picksMade === d.picksTotal);
  const posAvg = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const d of complete) for (const pk of picksByEntry.get(d.id) ?? []) {
    const pos = P[pk.pl]?.p; if (pos in posAvg) posAvg[pos]++;
  }
  for (const k in posAvg) posAvg[k] = complete.length ? (posAvg[k] / complete.length) : 0;
  const cards = [
    ["Total drafts", drafts.length, `${complete.length} complete · ${drafts.length - complete.length} in progress`],
    ["Dollars entered", fmt$(drafts.reduce((s, d) => s + (d.buyIn ?? 0), 0)), ""],
    ["Unique players", byPlayer.size, ""],
    ["Top exposure", P[topPlayer?.pid]?.n ?? "—", `${topPlayer?.count ?? 0} of ${drafts.length} rosters (${fmtPct((topPlayer?.count ?? 0) / drafts.length)})`],
    ["Top NFL team", topTeam?.[0] ?? "—", `on ${topTeam?.[1] ?? 0} rosters`],
    ["Avg construction", `${posAvg.QB.toFixed(1)} / ${posAvg.RB.toFixed(1)} / ${posAvg.WR.toFixed(1)} / ${posAvg.TE.toFixed(1)}`, "QB / RB / WR / TE"],
  ];
  document.getElementById("ovCards").innerHTML = cards.map(([k, v, d]) =>
    `<div class="card"><div class="k">${k}</div><div class="v">${esc(String(v))}</div><div class="d">${esc(d)}</div></div>`).join("");

  const byDay = new Map();
  for (const d of drafts) if (d.date) byDay.set(dayKey(d.date), (byDay.get(dayKey(d.date)) ?? 0) + 1);
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  document.getElementById("chartByDate").innerHTML = barChart(days.map(([k, v]) => ({ label: k.slice(5), value: v, tip: `${k}: <b>${v}</b> draft${v > 1 ? "s" : ""}` })), { height: 180 });

  const byContest = new Map();
  for (const d of drafts) {
    const c = byContest.get(d.name) ?? { n: 0, fees: 0 };
    c.n++; c.fees += d.buyIn ?? 0; byContest.set(d.name, c);
  }
  document.querySelector("#ovContests tbody").innerHTML = [...byContest.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([name, c]) => `<tr><td style="white-space:normal">${esc(name)}</td><td class="num">${c.n}</td><td class="num">${fmt$(c.fees)}</td></tr>`).join("");
}

// vertical bar chart (single series, sequential hue)
function barChart(items, { height = 180 } = {}) {
  if (!items.length) return "<div class='sub'>No data</div>";
  const w = 560, padL = 28, padB = 30, padT = 12;
  const max = Math.max(...items.map((i) => i.value));
  const bw = Math.min(26, (w - padL) / items.length - 2);
  const step = (w - padL) / items.length;
  const y = (v) => padT + (height - padB - padT) * (1 - v / max);
  const ticks = max <= 5 ? max : 4;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="xMidYMid meet">`;
  for (let t = 1; t <= ticks; t++) {
    const v = (max * t) / ticks, yy = y(v);
    s += `<line class="gridline" x1="${padL}" x2="${w}" y1="${yy}" y2="${yy}"/><text x="${padL - 5}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  s += `<line class="baseline" x1="${padL}" x2="${w}" y1="${height - padB}" y2="${height - padB}"/>`;
  const labelEvery = Math.ceil(items.length / 9);
  items.forEach((it, i) => {
    const x = padL + i * step + (step - bw) / 2, yy = y(it.value);
    s += `<rect class="mark" data-i="${i}" x="${x}" y="${yy}" width="${bw}" height="${height - padB - yy}" rx="3"/>`;
    s += `<rect class="hit" data-i="${i}" x="${padL + i * step}" y="${padT}" width="${step}" height="${height - padB - padT}"/>`;
    if (i % labelEvery === 0) s += `<text x="${x + bw / 2}" y="${height - padB + 14}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  s += "</svg>";
  return `<div class="chart-wrap" data-tips='${esc(JSON.stringify(items.map((i) => i.tip)))}'>` + s + "</div>";
}
// horizontal bar chart (single series)
function hbarChart(items, { valueFmt = String } = {}) {
  if (!items.length) return "<div class='sub'>No data</div>";
  const w = 560, rowH = 20, padL = 42, labelW = 40;
  const max = Math.max(...items.map((i) => i.value));
  const h = items.length * rowH + 8;
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">`;
  items.forEach((it, i) => {
    const y = 4 + i * rowH;
    const bw = Math.max(2, (w - padL - labelW - 8) * (it.value / max));
    s += `<text x="${padL - 6}" y="${y + 13}" text-anchor="end">${esc(it.label)}</text>`;
    s += `<rect class="mark" data-i="${i}" x="${padL}" y="${y + 3}" width="${bw}" height="${rowH - 8}" rx="3" ${it.color ? `style="fill:${it.color}"` : ""}/>`;
    s += `<text class="val" x="${padL + bw + 6}" y="${y + 13}">${esc(valueFmt(it.value))}</text>`;
    s += `<rect class="hit" data-i="${i}" x="0" y="${y}" width="${w}" height="${rowH}"/>`;
  });
  s += "</svg>";
  return `<div class="chart-wrap" data-tips='${esc(JSON.stringify(items.map((i) => i.tip ?? "")))}'>` + s + "</div>";
}
document.addEventListener("mousemove", (ev) => {
  const hit = ev.target.closest?.(".chart-wrap .hit, .chart-wrap .mark");
  document.querySelectorAll(".chart .mark.hov").forEach((m) => m.classList.remove("hov"));
  if (!hit) return hideTip();
  const wrap = hit.closest(".chart-wrap");
  const tips = JSON.parse(wrap.dataset.tips || "[]");
  const t = tips[Number(hit.dataset.i)];
  wrap.querySelector(`.mark[data-i="${hit.dataset.i}"]`)?.classList.add("hov");
  if (t) showTip(t, ev); else hideTip();
});

// ---------- rosters ----------
const rosterState = { key: "date", dir: -1 };
function constructionOf(entryId) {
  const c = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pk of picksByEntry.get(entryId) ?? []) { const p = P[pk.pl]?.p; if (p in c) c[p]++; }
  return c;
}
function renderRosters() {
  const rows = filteredDrafts().map((d) => {
    const c = constructionOf(d.id);
    const row = { id: d.id, date: d.date ?? "", name: d.name, buyIn: d.buyIn, slot: d.slot,
      qb: c.QB, rb: c.RB, wr: c.WR, te: c.TE, state: d.state };
    row.__html = `<tr class="click" data-id="${d.id}">
      <td>${localDate(d.date)}</td><td style="white-space:normal">${esc(d.name)}</td>
      <td class="num">${fmt$(d.buyIn)}</td><td class="num">${d.slot ?? "—"}</td>
      <td class="num">${c.QB}</td><td class="num">${c.RB}</td><td class="num">${c.WR}</td><td class="num">${c.TE}</td>
      <td>${d.state === "Completed" ? "Complete" : `<span class="warn">${esc(d.state)} (${d.picksMade}/${d.picksTotal})</span>`}</td></tr>`;
    return row;
  });
  renderTable(document.getElementById("rosterTable"), [
    { key: "date", label: "Date", sort: 1 }, { key: "name", label: "Contest", sort: 1 },
    { key: "buyIn", label: "Buy-in", num: 1, sort: 1 }, { key: "slot", label: "Slot", num: 1, sort: 1 },
    { key: "qb", label: "QB", num: 1, sort: 1 }, { key: "rb", label: "RB", num: 1, sort: 1 },
    { key: "wr", label: "WR", num: 1, sort: 1 }, { key: "te", label: "TE", num: 1, sort: 1 },
    { key: "state", label: "Status", sort: 1 },
  ], rows, rosterState, renderRosters);
  document.querySelectorAll("#rosterTable tbody tr").forEach((tr) =>
    tr.onclick = () => openRoster(Number(tr.dataset.id)));
}
function stacksOf(entryId) {
  const picks = picksByEntry.get(entryId) ?? [];
  const out = [];
  for (const qbPick of picks) {
    const qb = P[qbPick.pl]; if (qb?.p !== "QB" || !qb.t) continue;
    const mates = picks.map((pk) => P[pk.pl]).filter((p) => p && p.t === qb.t && p.p !== "QB");
    if (mates.length) out.push({ qb: qb.n, team: qb.t, mates });
  }
  return out;
}
const picksByPlayer = new Map();
for (const pk of DK.picks) {
  if (!picksByPlayer.has(pk.pl)) picksByPlayer.set(pk.pl, []);
  picksByPlayer.get(pk.pl).push(pk);
}
function openPlayer(pid) {
  const p = P[pid] ?? {};
  const rows = (picksByPlayer.get(pid) ?? [])
    .map((pk) => ({ pk, d: draftById.get(pk.e) }))
    .filter((x) => x.d)
    .sort((a, b) => String(b.d.date ?? "").localeCompare(String(a.d.date ?? "")));
  const dollars = rows.reduce((s, x) => s + (x.d.buyIn ?? 0), 0);
  const avg = rows.length ? rows.reduce((s, x) => s + x.pk.pk, 0) / rows.length : 0;
  document.getElementById("modalBox").innerHTML = `
    <button class="close" onclick="document.getElementById('modal').classList.remove('on')">✕</button>
    <h3>${logo(p.t)}${esc(p.n ?? pid)} <span class="pos ${p.p}">${p.p ?? "?"}</span> ${esc(p.t ?? "")}</h3>
    <div class="meta">On ${rows.length} of ${DK.drafts.length} drafts (${fmtPct(rows.length / DK.drafts.length)})
      · ${fmt$(dollars)} at stake · avg pick ${avg.toFixed(1)}</div>
    <table><thead><tr><th>Date</th><th>Contest</th><th class="num">Buy-in</th><th class="num">Slot</th><th class="num">Pick</th><th class="num">Rd</th></tr></thead>
    <tbody>${rows.map(({ pk, d }) => `<tr class="click" onclick="openRoster(${d.id}, ${pid})">
      <td>${localDate(d.date)}</td><td style="white-space:normal">${esc(d.name)}</td>
      <td class="num">${fmt$(d.buyIn)}</td><td class="num">${d.slot ?? "—"}</td>
      <td class="num">${pk.pk}</td><td class="num">${pk.r}.${String(pk.pr).padStart(2, "0")}</td></tr>`).join("")}</tbody></table>`;
  document.getElementById("modal").classList.add("on");
}
function openRoster(id, fromPid) {
  const d = draftById.get(id);
  const picks = picksByEntry.get(id) ?? [];
  const c = constructionOf(id);
  const stacks = stacksOf(id);
  const teamN = new Map();
  for (const pk of picks) { const t = P[pk.pl]?.t; if (t) teamN.set(t, (teamN.get(t) ?? 0) + 1); }
  const teamStacks = [...teamN.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  document.getElementById("modalBox").innerHTML = `
    <button class="close" onclick="document.getElementById('modal').classList.remove('on')">✕</button>
    ${fromPid != null ? `<span class="backlink" onclick="openPlayer(${fromPid})">← ${esc(P[fromPid]?.n ?? "back")}</span>` : ""}
    <h3>${esc(d.name)}</h3>
    <div class="meta">${localDate(d.date)} · slot ${d.slot ?? "—"} of ${d.size} · ${fmt$(d.buyIn)} ·
      ${c.QB}QB / ${c.RB}RB / ${c.WR}WR / ${c.TE}TE · entry ${d.id}</div>
    <div style="margin-bottom:10px">${
      stacks.map((s) => `<span class="stack-chip">${esc(s.qb)} + ${s.mates.map((m) => esc(m.n)).join(" + ")} (${s.team})</span>`).join("") || "<span class='meta'>No QB stacks</span>"}
      ${teamStacks.map(([t, n]) => `<span class="stack-chip">${t} ×${n}</span>`).join("")}</div>
    <table><thead><tr><th class="num">Pick</th><th class="num">Rd</th><th>Player</th><th>Pos</th><th>Team</th><th class="num">ADP</th></tr></thead>
    <tbody>${picks.map((pk) => { const p = P[pk.pl] ?? {}; return `<tr>
      <td class="num">${pk.pk}</td><td class="num">${pk.r}.${String(pk.pr).padStart(2, "0")}</td>
      <td>${logo(p.t)}${esc(p.n)}</td><td><span class="pos ${p.p}">${p.p}</span></td><td>${p.t ?? "?"}</td>
      <td class="num">${pk.adp != null ? pk.adp.toFixed(1) : "—"}</td></tr>`; }).join("")}</tbody></table>`;
  document.getElementById("modal").classList.add("on");
}
document.getElementById("modal").onclick = (e) => { if (e.target.id === "modal") e.target.classList.remove("on"); };

// ---------- season: standings, manual scores, partner shares ----------
// Synced data comes from DK.season (populated by "Sync current scores" imports).
// Manual edits + shares live in localStorage and overlay the imported baseline;
// "Export teams file" + npm run refresh persists them into the database.
const SEA = DK.season ?? { status: {}, scores: {}, manual: {}, shares: {}, history: {}, scoresSyncedAt: null };
SEA.history ??= {};
// Opened as a local file = the owner (full editor). Served over http(s) = a published
// copy for partners: hide the manual-score / partner editor and the export button.
const READONLY = location.protocol !== "file:";
// NFL team logo (ESPN's CDN) shown left of player names; free agents / unknown teams get a blank spacer
const LOGO_ABBR = { WAS: "wsh" };
const logo = (team) => { const t = String(team ?? "").toUpperCase(); return /^[A-Z]{2,3}$/.test(t) && t !== "FA" && t !== "TBD"
  ? `<img class="tlogo" src="https://a.espncdn.com/i/teamlogos/nfl/500/${LOGO_ABBR[t] ?? t.toLowerCase()}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
  : `<span class="tlogo"></span>`; };
if (READONLY) document.body.classList.add("ro");
const partnersOf = (id) => (SEA.shares[id] ?? []).filter((p) => p.name);
const LS_KEY = "dkbb-manual-v1";
let LS = { entries: {}, shares: {} };
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
  if (saved && typeof saved === "object") LS = { entries: {}, shares: {}, ...saved };
} catch { /* storage unavailable — manual edits won't persist across reloads */ }
function saveLS() {
  LS.updatedAt = new Date().toISOString();
  try { localStorage.setItem(LS_KEY, JSON.stringify(LS)); } catch { /* ignore */ }
}
const numOr = (v) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const txtOr = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const shortContest = (n) => String(n ?? "").replace(/^NFL Best Ball\s*/, "").replace(/\s*\(Tournament\)\s*$/, "");
const stateLabel = (s) => ({ upcoming: "Not started", live: "Live", history: "Final" }[s] ?? (s || "—"));

// tiny rank sparkline: series = [[day, rank], ...]; lower rank = higher on the chart
function rankSpark(series, entrants) {
  const w = 220, h = 40, pad = 6;
  const ranks = series.map(([, r]) => r);
  const lo = 1, hi = Math.max(entrants ?? 0, ...ranks, 2);
  const x = (i) => pad + (w - 2 * pad) * (series.length === 1 ? 0.5 : i / (series.length - 1));
  const y = (r) => pad + (h - 2 * pad) * ((r - lo) / (hi - lo));
  const pts = series.map(([, r], i) => `${x(i).toFixed(1)},${y(r).toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" style="overflow:visible;flex:none">` +
    `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>` +
    series.map(([, r], i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r).toFixed(1)}" r="2.5" fill="var(--accent)"/>`).join("") +
    `</svg>`;
}

// effective manual value: localStorage overlays the imported baseline;
// an explicitly emptied field ("") masks the baseline (reverts to synced)
function manualOf(id) {
  const m = { ...(SEA.manual[id] ?? {}) };
  const ls = LS.entries[id] ?? {};
  for (const k of Object.keys(ls)) {
    if (ls[k] === "" || ls[k] == null) delete m[k];
    else m[k] = ls[k];
  }
  return m;
}
function sharesOf(id) { return LS.shares[id] ?? SEA.shares[id] ?? []; }
function myShareOf(id) {
  const sum = sharesOf(id).reduce((s, x) => s + (numOr(x.pct) ?? 0), 0);
  return Math.min(1, Math.max(0, 1 - sum / 100));
}
function seasonOf(d) {
  const man = manualOf(d.id);
  const syn = SEA.status[d.id] ?? {};
  const rank = numOr(man.rank) ?? syn.rank ?? null;
  const entrants = numOr(man.entrants) ?? syn.entrants ?? d.ent ?? d.size ?? null;
  const points = numOr(man.points) ?? syn.points ?? null;
  const cutoff = numOr(man.cutoff) ?? syn.pp ?? d.pp ?? null;
  const manual = ["rank", "entrants", "points", "cutoff", "top"].some((k) => man[k] != null && man[k] !== "");
  let topName = txtOr(man.top), topPts = null; // season carrier (manual override wins)
  if (!topName && syn.topPid != null) { topName = P[syn.topPid]?.n ?? String(syn.topPid); topPts = syn.topPts ?? null; }
  let weekTopName = null, weekTopPts = null; // this week's top scorer (synced only)
  if (syn.weekTopPid != null) { weekTopName = P[syn.weekTopPid]?.n ?? String(syn.weekTopPid); weekTopPts = syn.weekTopPts ?? null; }
  const advancing = rank != null && cutoff != null ? rank <= cutoff : null;
  // movement vs the rank at the END of the previous NFL week — only for synced ranks (a manual rank has no baseline)
  const delta = numOr(man.rank) == null && syn.rank != null && syn.prevRank != null
    ? syn.prevRank - syn.rank : null; // + = moved up
  const topTeam = !txtOr(man.top) && syn.topPid != null ? P[syn.topPid]?.t ?? null : null;
  const weekTopTeam = syn.weekTopPid != null ? P[syn.weekTopPid]?.t ?? null : null;
  return { rank, entrants, points, cutoff, topName, topPts, topTeam, weekTopName, weekTopPts, weekTopTeam, advancing, manual, delta,
    prizes: syn.prizes ?? null, state: syn.state ?? d.section ?? null, at: syn.at ?? null,
    partners: sharesOf(d.id), myShare: myShareOf(d.id) };
}

let seasonPill = "";
// default "order" = the partner pages' rule: advancing teams first, then biggest stake (my share × buy-in), equal stakes
// by closeness to the cutoff line in points (advancing: biggest cushion first), then best-placed, then buy-in.
// Clicking a column header sorts by that column instead; "default order" next to the count brings this back.
const seasonState = { key: "order", dir: 1 };
const gapCmp = (ga, gb) => ga == null && gb == null ? 0 : ga == null ? 1 : gb == null ? -1 : gb - ga;
const defaultOrder = (a, b) => (b.adv === 2) - (a.adv === 2) || b.stake - a.stake || gapCmp(a.gap, b.gap) || a.pct - b.pct || b.buyIn - a.buyIn || String(a.date).localeCompare(String(b.date));
function renderSeason() {
  const drafts = filteredDrafts();
  const q = F.search.trim().toLowerCase(), nq = searchQuery();
  // starting a search sorts my teams with him to the top (opponents have most players somewhere); clearing restores the default
  if (nq && !renderSeason.lastQ) Object.assign(seasonState, { key: "hit", dir: -1 });
  else if (!nq && renderSeason.lastQ && seasonState.key === "hit") Object.assign(seasonState, { key: "order", dir: 1 });
  renderSeason.lastQ = nq;
  let myTeams = 0, oppTeams = 0, oppLeagues = 0; const names = new Set();
  const rows = [];
  const all = [];
  for (const d of drafts) {
    const s = seasonOf(d);
    all.push({ d, s });
    if (seasonPill === "advancing" && s.advancing !== true) continue;
    if (seasonPill === "out" && s.advancing !== false) continue;
    if (seasonPill === "shared" && !s.partners.length) continue;
    if (seasonPill === "manual" && !s.manual) continue;
    // search: a player on my roster, a player on any opponent's roster in the pod, or (as before) contest/carrier/partner text
    const hit = searchHits(d, nq);
    if (q && !hit?.any && !`${d.name} ${s.topName ?? ""} ${s.weekTopName ?? ""} ${s.partners.map((p) => p.name).join(" ")}`.toLowerCase().includes(q)) continue;
    if (hit?.mine.length) { myTeams++; for (const n of hit.mine) names.add(n); }
    if (hit?.opps.length) { oppLeagues++; oppTeams += hit.opps.length; for (const o of hit.opps) for (const n of o.found) names.add(n); }
    const hitCell = !hit?.any ? "—"
      : (hit.mine.length ? `<span class="hit-mine">★ mine</span>` : "") +
        (hit.opps.length ? `${hit.mine.length ? " · " : ""}<span class="hit-opps" title="${esc(hit.opps.map((o) => `${o.name}${o.rank != null ? ` (${o.rank})` : ""}`).join(", "))}">⚠ ${hit.opps.length} opp${hit.opps.length === 1 ? "" : "s"}</span>` : "");
    const row = {
      hit: (hit?.mine.length ? 2 : hit?.opps.length ? 1 : 0) * 100000 + (d.buyIn ?? 0), // group first, then biggest buy-in
      id: d.id, date: d.date ?? "", name: d.name, buyIn: d.buyIn ?? 0,
      pct: s.rank != null && s.entrants ? s.rank / s.entrants : 9,
      delta: s.delta,
      points: s.points, wk: teamWeekPts(d), adv: s.advancing === true ? 2 : s.advancing === false ? 0 : 1,
      top: s.topName ?? "", wtop: s.weekTopName ?? "", partners: s.partners.map((p) => p.name).filter(Boolean).join(", "),
      prizes: s.prizes ?? 0, state: stateLabel(s.state),
      stake: (d.buyIn ?? 0) * s.myShare, gap: lineGapOf(d, s), // for the default order
    };
    const shareTxt = s.partners.length
      ? ` <span class="chip low" title="${esc(s.partners.map((p) => `${p.name} ${p.pct}%`).join(", "))}">yours ${Math.round(s.myShare * 100)}%</span>` : "";
    const chip = advChip(d, s, "—");
    const race = raceOf(d, s);
    row.race = row.pct; // sorts like Place
    row.__html = `<tr class="click${hit?.mine.length ? " hit-me" : hit?.opps.length ? " hit-opp" : ""}${s.advancing ? " adv-in" : ""}" data-id="${d.id}">
      <td>${localDate(d.date)}</td>
      <td style="white-space:normal">${esc(shortContest(d.name))}</td>
      ${nq ? `<td>${hitCell}</td>` : ""}
      <td class="num">${fmt$(d.buyIn)}${shareTxt}</td>
      <td class="num">${s.rank != null ? `${s.rank} / ${s.entrants ?? "?"}` : "—"}${s.manual ? " ✎" : ""}</td>
      <td>${raceBarHtml(race, s)}</td>
      <td class="num" title="places moved since the end of last week">${
        s.delta == null ? `<span style="color:var(--muted)">—</span>`
        : s.delta > 0 ? `<span class="diff-good">▲${s.delta}</span>`
        : s.delta < 0 ? `<span class="diff-bad">▼${-s.delta}</span>`
        : `<span style="color:var(--muted)">·</span>`}</td>
      <td class="num">${s.points != null ? s.points.toFixed(2) : "—"}</td>
      <td class="num" title="points scored this week — click the row for every week">${row.wk != null ? row.wk.toFixed(2) : "—"}</td>
      <td>${chip}${s.cutoff != null ? ` <span style="color:var(--muted);font-size:11px">top ${s.cutoff}</span>` : ""}</td>
      <td>${s.topName ? logo(s.topTeam) + esc(s.topName) + (s.topPts != null ? ` <span style="color:var(--muted)">· ${s.topPts.toFixed(2)}</span>` : "") : "—"}</td>
      <td>${s.weekTopName ? logo(s.weekTopTeam) + esc(s.weekTopName) + (s.weekTopPts != null ? ` <span style="color:var(--muted)">· ${s.weekTopPts.toFixed(2)}</span>` : "") : "—"}</td>
      <td>${esc(row.partners) || "—"}</td>
      <td class="num">${s.prizes ? fmt$(s.prizes) : "—"}</td>
      <td>${esc(row.state)}</td>
    </tr>`;
    row.__card = seasonCardHtml(d, s, hit);
    rows.push(row);
  }
  if (seasonState.key === "order") rows.sort(defaultOrder); // renderTable leaves the order alone when no column matches
  renderTable(document.getElementById("seasonTable"), [
    { key: "date", label: "Drafted", sort: 1 }, { key: "name", label: "Contest", sort: 1 },
    ...(nq ? [{ key: "hit", label: "Has him", sort: 1 }] : []),
    { key: "buyIn", label: "Buy-in", num: 1, sort: 1 }, { key: "pct", label: "Place", num: 1, sort: 1 },
    { key: "race", label: "Race", sort: 1 },
    { key: "delta", label: "Δ", num: 1, sort: 1 },
    { key: "points", label: "Points", num: 1, sort: 1 }, { key: "wk", label: SEA.week ? `Wk ${SEA.week}` : "This wk", num: 1, sort: 1 },
    { key: "adv", label: "Advancing", sort: 1 },
    { key: "top", label: "Season carrier", sort: 1 }, { key: "wtop", label: SEA.week ? `Wk ${SEA.week} top` : "Week top", sort: 1 },
    { key: "partners", label: "Partners", sort: 1 },
    { key: "prizes", label: "Won", num: 1, sort: 1 }, { key: "state", label: "Status", sort: 1 },
  ], rows, seasonState, renderSeason);
  document.querySelectorAll("#seasonTable tbody tr").forEach((tr) =>
    tr.onclick = () => openSeason(Number(tr.dataset.id)));
  // phone list in the same order as the table (renderTable sorted rows in place)
  document.getElementById("seasonList").innerHTML = rows.map((r) => r.__card).join("");
  const cnt = document.getElementById("seasonCount");
  cnt.innerHTML = `${rows.length} of ${drafts.length} teams` + (seasonState.key === "order" ? ` <span style="color:var(--muted)" title="advancing first, then biggest stake, then closest to the cutoff line">· advancing → stake → gap</span>`
    : ` · <button type="button" id="seasonDefaultOrder" style="background:none;border:0;color:var(--accent);font:inherit;font-weight:600;cursor:pointer;padding:0" title="advancing first, then biggest stake, then closest to the cutoff line">default order</button>`);
  cnt.querySelector("#seasonDefaultOrder")?.addEventListener("click", () => { Object.assign(seasonState, { key: "order", dir: 1 }); renderSeason(); });
  // search summary, same wording as the partner pages
  const list = [...names];
  document.getElementById("seasonSearch").innerHTML = !nq ? ""
    : !list.length ? `Nobody in your leagues has a player matching “${esc(F.search.trim())}”${rows.length ? ` — showing ${rows.length} team${rows.length === 1 ? "" : "s"} matched by contest, carrier or partner name` : ""}`
    : `<b>${esc(list.slice(0, 6).join(", "))}${list.length > 6 ? ` +${list.length - 6} more` : ""}</b> — <span class="hit-mine">on ${myTeams} of your ${drafts.length} teams</span>` +
      (oppTeams ? ` · <span class="hit-opps">on ${oppTeams} opponent team${oppTeams === 1 ? "" : "s"}</span> in ${oppLeagues} of your leagues` : ` · no opponent has him`) +
      (list.length > 1 ? ` <span style="color:var(--muted)">(keep typing to narrow it down)</span>` : "") +
      ` <span style="color:var(--muted)">· click a team to see him in the league view</span>`;
  renderSeasonCards(all);
  renderPartners();
  document.getElementById("seasonNote").textContent = SEA.scoresSyncedAt
    ? `live scoring · updated ${new Date(SEA.scoresSyncedAt).toLocaleString()} · click a row for the league view`
    : `loading live scores…`;
}

// The rank line (phone rows + the Season table's Race column): where this team sits between last and 1st, the
// advancing zone (cutoff/entrants of the width), and the clock — DK's PMR = minutes still to play across the roster
const ord = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
// points relative to the cutoff line, from the pod standings [key, name, rank, points, pmr]: out → minus the gap to
// the last team inside; in → plus the cushion over the first team outside (rank ties: lowest score inside / highest
// outside). null = no standings for that league yet
function lineGapOf(d, s) {
  const pod = SEA.pods?.[d.contestId] ?? [];
  if (s.points == null || s.cutoff == null || s.advancing == null || pod.length < 2) return null;
  const others = pod.filter((p) => p[0] !== d.id && p[2] != null && p[3] != null);
  const ins = others.filter((p) => p[2] <= s.cutoff).map((p) => p[3]), outs = others.filter((p) => p[2] > s.cutoff).map((p) => p[3]);
  if (s.advancing) return outs.length ? s.points - Math.max(...outs) : null;
  return ins.length ? s.points - Math.min(...ins) : null;
}
const fmtGap = (g) => (Math.round(Math.abs(g) * 100) / 100).toFixed(2);
// chip: "Out by 12.3 pts" = behind the last advancing spot, "Advancing +8.4" = cushion; places only without standings
function advChip(d, s, noneLabel) {
  if (s.advancing == null) return `<span class="chip none">${noneLabel}</span>`;
  const g = lineGapOf(d, s), top = `top ${s.cutoff ?? 2}`;
  if (s.advancing) return g != null ? `<span class="chip ok" title="${fmtGap(g)} points ahead of the first team outside the ${top}">Advancing +${fmtGap(g)}</span>` : `<span class="chip ok">Advancing</span>`;
  return g != null ? `<span class="chip high" title="${fmtGap(g)} points behind the last advancing spot (${top})">Out by ${fmtGap(g)} pts</span>`
    : `<span class="chip high" title="no league standings yet — places behind the ${top}, not points">Out by ${s.rank - s.cutoff} place${s.rank - s.cutoff === 1 ? "" : "s"}</span>`;
}
function raceOf(d, s) {
  const pod = SEA.pods?.[d.contestId] ?? [], me = pod.find((x) => x[0] === d.id);
  const pmr = me?.[4] ?? null, nR = (picksByEntry.get(d.id) ?? []).length || 20;
  const left = pmr != null ? Math.round(pmr / 60) : null;
  const leftPct = pmr != null ? Math.max(0, Math.min(100, 100 * pmr / (60 * nR))).toFixed(1) : "0";
  const zonePct = s.cutoff != null && s.entrants ? Math.max(0, Math.min(100, 100 * s.cutoff / s.entrants)).toFixed(1) : (100 * 2 / 12).toFixed(1);
  const markPct = s.rank != null && s.entrants ? (100 * (s.entrants - s.rank + 0.5) / s.entrants).toFixed(1) : null;
  return { pmr, nR, left, leftPct, zonePct, markPct };
}
const raceTitle = (r, s) => `${s.rank != null ? `${ord(s.rank)} of ${s.entrants ?? "?"} · ` : ""}top ${s.cutoff ?? 2} advance${s.advancing ? " — inside the cutoff" : ""}`;
const raceMark = (r) => r.markPct != null ? `<span class="mark" style="left:${r.markPct}%;--left:${r.leftPct}%" title="${r.left != null ? `${r.left} of ${r.nR} players still to play` : ""}"></span>` : "";
const raceBarHtml = (r, s) => `<span class="rbar" title="${raceTitle(r, s)}"><span class="zone" style="width:${r.zonePct}%"></span>${raceMark(r)}</span>`;

// DraftKings-style row for phones: rank line (12th … 1st, advancing zone at the right, clock = this team,
// red = minutes still to play), my stake / players left / points (+ won), big ordinal place, chip, draft date + pick
function seasonCardHtml(d, s, hit) {
  const { left, leftPct, zonePct, markPct, nR } = raceOf(d, s);
  const stake = (d.buyIn ?? 0) * s.myShare;
  const chip = advChip(d, s, "no rank yet");
  const dShort = s.delta == null || s.delta === 0 ? "" : s.delta > 0 ? ` · <span class="diff-good">▲${s.delta}</span>` : ` · <span class="diff-bad">▼${-s.delta}</span>`;
  return `<button class="srow${hit?.mine.length ? " hit-me" : hit?.opps.length ? " hit-opp" : ""}${s.advancing ? " adv-in" : ""}" type="button" data-id="${d.id}" title="${esc(shortContest(d.name))}"><span class="tl">
      <span class="bar" title="${s.rank != null ? `${ord(s.rank)} of ${s.entrants ?? "?"} · ` : ""}top ${s.cutoff ?? 2} advance${s.advancing ? " — inside the cutoff" : ""}"><span class="zone" style="width:${zonePct}%"></span>${markPct != null ? `<span class="mark" style="left:${markPct}%;--left:${leftPct}%" title="${left != null ? `${left} of ${nR} players still to play` : ""}"></span>` : ""}</span>
      <span class="ks"><span class="ks-i"><span class="k"><span class="lg">My </span>stake</span><span class="v">${fmt$(stake)}</span></span><span class="ks-i"><span class="k">Left</span><span class="v">${left ?? "—"}</span></span><span class="ks-i ks-wk" title="points scored this week (FPTS is the season total)"><span class="k">${SEA.week ? `Wk ${SEA.week}` : "This wk"}</span><span class="v">${(() => { const w = teamWeekPts(d); return w != null ? w.toFixed(2) : "—"; })()}</span></span><span class="ks-i"><span class="k">FPTS</span><span class="v">${s.points != null ? s.points.toFixed(2) : "—"}</span></span>${s.prizes ? `<span class="ks-i"><span class="k">Won</span><span class="v won">${fmt$(s.prizes)}</span></span>` : ""}</span>
    </span><span class="tr"><span class="pl">${s.rank != null ? `${ord(s.rank)}<small>/${s.entrants ?? "?"}</small>` : "—"}<span class="chev" aria-hidden="true">›</span></span>${chip}<small class="when">${localDate(d.date)} · pick ${d.slot ?? "—"}${dShort}</small></span></button>`;
}
document.getElementById("seasonList").addEventListener("click", (e) => { const b = e.target.closest(".srow"); if (b) openSeason(Number(b.dataset.id)); });

function summarizePartners(shared) {
  const n = new Map();
  for (const x of shared) for (const p of x.s.partners) if (p.name) n.set(p.name, (n.get(p.name) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([name, k]) => `${name} ×${k}`).join(" · ");
}
function renderSeasonCards(all) {
  const ranked = all.filter((x) => x.s.rank != null);
  const advancing = ranked.filter((x) => x.s.advancing === true);
  const shared = all.filter((x) => x.s.partners.length);
  const fees = all.reduce((s, x) => s + (x.d.buyIn ?? 0), 0);
  const myFees = all.reduce((s, x) => s + (x.d.buyIn ?? 0) * x.s.myShare, 0);
  const winnings = all.reduce((s, x) => s + (x.s.prizes ?? 0), 0);
  const live = all.filter((x) => x.s.state === "live").length;
  const contrib = new Map(), weekContrib = new Map();
  for (const x of (advancing.length ? advancing : ranked)) {
    if (x.s.topName) contrib.set(x.s.topName, (contrib.get(x.s.topName) ?? 0) + 1);
    if (x.s.weekTopName) weekContrib.set(x.s.weekTopName, (weekContrib.get(x.s.weekTopName) ?? 0) + 1);
  }
  const carrier = [...contrib.entries()].sort((a, b) => b[1] - a[1])[0];
  const weekCarrier = [...weekContrib.entries()].sort((a, b) => b[1] - a[1])[0];
  const pool = advancing.length ? "advancing" : "ranked";
  const ord = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
  let best = null; // highest-scoring team
  for (const x of all) if (x.s.points != null && (!best || x.s.points > best.s.points)) best = x;
  const cards = [
    ["Advancing", ranked.length ? `${advancing.length} of ${ranked.length}` : "—",
      ranked.length ? "teams at or inside the advance cutoff, of teams with a rank" : `no ranks yet · ${live} live teams`, "adv"],
    ["Highest score", best ? best.s.points.toFixed(2) : "—",
      best ? `${best.s.rank != null ? `${ord(best.s.rank)} in ` : ""}${shortContest(best.d.name)}` : "no scores yet"],
    ["Season carrier", carrier?.[0] ?? "—",
      carrier ? `season top scorer on ${carrier[1]} ${pool} team${carrier[1] > 1 ? "s" : ""}` : "needs synced or manual scores"],
    [SEA.week ? `Week ${SEA.week} top scorer` : "This week's top scorer", weekCarrier?.[0] ?? "—",
      weekCarrier ? `this week's top scorer on ${weekCarrier[1]} ${pool} team${weekCarrier[1] > 1 ? "s" : ""}` : "needs a scores sync"],
    ["Total buy-ins", fmt$(fees), `${all.length} team${all.length === 1 ? "" : "s"}`],
    ["Winnings so far", fmt$(winnings), winnings ? "as of your last sync" : "—"],
  ];
  document.getElementById("seasonCards").innerHTML = cards.map(([k, v, d, filter]) =>
    `<div class="card${filter ? ` click${seasonPill === "advancing" ? " on" : ""}` : ""}"${filter ? ` data-filter="${filter}" role="button" tabindex="0" title="${seasonPill === "advancing" ? "Show all teams" : "Show only the teams that are currently advancing"}"` : ""}><div class="k">${k}</div><div class="v">${esc(String(v))}</div><div class="d">${esc(d)}</div></div>`).join("");
}
// the Advancing card toggles the "Advancing" pill filter
function setSeasonPill(sf) {
  seasonPill = sf;
  document.querySelectorAll("#seasonPills .pill").forEach((x) => x.classList.toggle("on", x.dataset.sf === sf));
  renderSeason();
}
document.getElementById("seasonCards").addEventListener("click", (e) => { const c = e.target.closest(".card[data-filter='adv']"); if (c) setSeasonPill(seasonPill === "advancing" ? "" : "advancing"); });
document.getElementById("seasonCards").addEventListener("keydown", (e) => { const c = e.target.closest(".card[data-filter='adv']"); if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setSeasonPill(seasonPill === "advancing" ? "" : "advancing"); } });

// ---------- player search (Season tab + editor), same rules as the partner pages ----------
// case/accent/punctuation-insensitive; every typed word must appear in the player's name
const normName2 = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const searchQuery = () => normName2(F.search);
const playerMatch = (name, q = searchQuery()) => q !== "" && q.split(" ").every((w) => normName2(name).includes(w));
// for one of my entries: my matching players + the opponents in that pod who have a matching player
function searchHits(d, q = searchQuery()) {
  if (q === "") return null;
  const mine = [...new Set((picksByEntry.get(d.id) ?? []).map((pk) => P[pk.pl]?.n).filter((n) => n && playerMatch(n, q)))];
  const opps = [];
  const pod = SEA.pods[d.contestId] ?? [];
  for (const [k, n, r] of pod) {
    if (k === d.id) continue;
    const found = [...new Set((podRoster(d.contestId, k) ?? []).map((p) => p.name).filter((nm) => playerMatch(nm, q)))];
    if (found.length) opps.push({ key: k, name: n, rank: r, found });
  }
  return { mine, opps, any: mine.length > 0 || opps.length > 0 };
}

// ---------- league view (editor): standings + any team's roster, mirroring the partner pages ----------
const SLOT_ORDER = { QB: 1, RB: 2, WR: 3, TE: 4, FLEX: 5, BN: 9 };
const ordinal = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
// roster of any entry in a pod from the opponent-roster sync: [{name,pos,team,slot,wk,season}] or null
function podRoster(contestId, key) {
  const rows = SEA.opp?.rosters?.[contestId]?.[key];
  if (!rows || !rows.length) return null;
  return rows.map(([i, slot, wk, season, pmr, st, ts, game, start, slots]) => { const p = SEA.opp.players[i] ?? []; return { name: p[0], pos: p[1], team: p[2], slot, wk, season, pmr, st, ts, game, start, wkPts: SEA.weekly?.players?.[i] ?? null, slots: slots ?? null }; });
}
// ---------- week by week (live feed) ----------
// SEA.weekly = { weeks: [1, 2, …] (the last one is the week in progress), teams: { contestId: { entryKey: [team score per
// week] } }, players: [points per week] aligned with SEA.opp.players }; each roster row also carries the slot he filled
// each week, one letter per week (B = bench). openSeason.current.wk = the week picked on the strip (null = season view).
const SLOT_OF = { Q: "QB", R: "RB", W: "WR", T: "TE", F: "FLEX", B: "BN" };
const weekList = () => SEA.weekly?.weeks ?? [];
const teamWeeks = (contestId, key) => SEA.weekly?.teams?.[contestId]?.[key] ?? null;
const selWeekIdx = () => openSeason.current?.wk != null ? weekList().indexOf(openSeason.current.wk) : -1;
// this team's score in the week being played: from the live feed, else the starters of the synced lineup
function teamWeekPts(d) {
  const n = weekList().length, w = teamWeeks(d.contestId, d.id);
  if (n && w?.[n - 1] != null) return w[n - 1];
  const r = podRoster(d.contestId, d.id) ?? [];
  return r.some((p) => p.slot && p.wk != null) ? r.reduce((a, p) => a + (p.slot !== "BN" ? p.wk ?? 0 : 0), 0) : null;
}
// places for one week inside a league: Map(entryKey → place), equal scores share a place
function weekRanksOf(contestId, i) {
  const rows = (SEA.pods[contestId] ?? []).map((r) => [r[0], teamWeeks(contestId, r[0])?.[i] ?? null]).filter((r) => r[1] != null).sort((a, b) => b[1] - a[1]);
  const out = new Map();
  rows.forEach(([k, w], n) => out.set(k, n > 0 && rows[n - 1][1] === w ? out.get(rows[n - 1][0]) : n + 1));
  return out;
}
// the strip follows the team picked in the standings (openSeason.current.key): mine by default, an opponent once clicked
function weekStripHtml(d) {
  const weeks = weekList();
  if (!weeks.length || !teamWeeks(d.contestId, d.id)) return "";
  const selKey = openSeason.current?.key ?? d.id;
  const key = selKey !== d.id && teamWeeks(d.contestId, selKey) ? selKey : d.id, me = key === d.id;
  const mine = teamWeeks(d.contestId, key), std = (SEA.pods[d.contestId] ?? []).find((x) => x[0] === key);
  const s = seasonOf(d), sel = openSeason.current?.wk ?? "";
  const points = me ? s.points : std?.[3] ?? null, rank = me ? s.rank : std?.[2] ?? null;
  const btn = (wk, k, v, r) => `<button type="button" class="wk${sel === wk ? " on" : ""}" data-wk="${wk}"><span class="k">${k}</span><span class="v">${v}</span><span class="r">${r}</span></button>`;
  // newest week first, so the week being played is always in view
  return `<h4 style="margin:14px 0 6px">Week by week <span class="lg-note">${me ? "my" : `<b style="color:var(--ink)">${esc(std?.[1] ?? "this team")}</b>'s`} score each week · click a week to see that week's standings and lineup</span></h4>
    <div class="wkbar">${btn("", "Season", points != null ? Number(points).toFixed(2) : "—", rank != null ? `${ordinal(rank)} of ${s.entrants ?? "?"}` : "—")}${
    weeks.map((w, i) => [w, i]).reverse().map(([w, i]) => { const place = weekRanksOf(d.contestId, i).get(key);
      return btn(w, `Week ${w}${i === weeks.length - 1 ? ` <span class="now">· now</span>` : ""}`, mine[i] != null ? Number(mine[i]).toFixed(2) : "—", place != null ? `${ordinal(place)} that week` : "—"); }).join("")}</div>`;
}
// "playing now" tag: the live feed marks each player's game state (L = in progress) with DK's clock text
const kickTxt = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
const gst = (p) => /final|complete|ended|postponed|cancel/i.test(p.ts ?? "") ? "F" : p.st; // a Final clock always means done
const playingChip = (p) => gst(p) === "L" ? `<span class="playing" title="${esc(p.game ?? "")}${p.pmr != null ? ` · ${p.pmr} min left` : ""}">LIVE${p.ts ? ` ${esc(p.ts)}` : ""}</span>`
  : gst(p) === "F" ? `<span class="gdone" title="${esc(p.game ?? "")} · game over">FINAL</span>`
  : gst(p) === "U" && p.start ? `<span class="gnext" title="${esc(p.game ?? "")} · not started">${esc(kickTxt(p.start))}</span>` : "";
const playingCount = (list) => (list ?? []).filter((p) => gst(p) === "L").length;
// "3 playing · 12 done · 5 to play" — only once the live feed has game states
const gameSummary = (list) => { const r = list ?? []; const n = { L: 0, F: 0, U: 0 }; for (const p of r) { const s = gst(p); if (s in n) n[s]++; }
  if (!n.L && !n.F && !n.U) return "";
  return [n.L ? `<span class="playing-n">${n.L} playing</span>` : "", n.F ? `${n.F} done` : "", n.U ? `${n.U} to play` : ""].filter(Boolean).join(" · "); };
function leagueStandingsHtml(d, selKey) {
  const pod = SEA.pods[d.contestId] ?? [], man = manualOf(d.id), syn = SEA.status[d.id] ?? {};
  const cut = numOr(man.cutoff) ?? syn.pp ?? d.pp;
  const inCut = (r) => cut != null && r != null && r <= cut;
  const hasHim = (k) => searchQuery() !== "" && (k === d.id ? (picksByEntry.get(d.id) ?? []).some((pk) => playerMatch(P[pk.pl]?.n)) : (podRoster(d.contestId, k) ?? []).some((p) => playerMatch(p.name)));
  const wi = selWeekIdx();
  if (wi >= 0 && SEA.weekly?.teams?.[d.contestId]) { // one week's scores, ranked by that week
    const places = weekRanksOf(d.contestId, wi), wkNo = weekList()[wi];
    const order = pod.slice().sort((a, b) => (places.get(a[0]) ?? 99) - (places.get(b[0]) ?? 99));
    return `<h4>Week ${wkNo} scores <span class="lg-note">ranked by that week's points · tap a team to see its lineup</span></h4>
      <div class="scroll-x"><table><thead><tr><th class="num">#</th><th>Team</th><th class="num">Wk ${wkNo}</th><th class="num" title="season total and place">Season</th></tr></thead>
      <tbody>${order.map(([k, n, r, p]) => { const me = k === d.id, w = teamWeeks(d.contestId, k)?.[wi];
        return `<tr class="pick${me ? " me" : ""}${k === selKey ? " sel" : ""}" data-key="${k}">
          <td class="num">${places.get(k) ?? "—"}</td><td class="team-name">${esc(n)}${me ? " (mine)" : ""}${hasHim(k) ? `<span class="tag ${me ? "mine" : "opp"}">has him</span>` : ""}</td>
          <td class="num">${w != null ? Number(w).toFixed(2) : "—"}</td><td class="num wk-muted">${p != null ? Number(p).toFixed(2) : "—"}${r != null ? ` · ${ordinal(r)}` : ""}</td></tr>`; }).join("")}</tbody></table></div>`;
  }
  return `<h4>League standings <span class="lg-note">${pod.length} teams · top ${cut ?? "?"} advance · "left" = players yet to play this week · tap a team to see its roster</span></h4>
    <div class="scroll-x"><table><thead><tr><th class="num">#</th><th>Team</th><th class="num">Points</th><th class="num">Left</th></tr></thead>
    <tbody>${pod.map(([k, n, r, p, t], i) => { const me = k === d.id, adv = inCut(r), lastIn = adv && !(pod[i + 1] && inCut(pod[i + 1][2]));
      const has = searchQuery() !== "" && (me ? (picksByEntry.get(d.id) ?? []).some((pk) => playerMatch(P[pk.pl]?.n)) : (podRoster(d.contestId, k) ?? []).some((p) => playerMatch(p.name)));
      return `<tr class="pick${me ? " me" : ""}${lastIn ? " cut-line" : ""}${k === selKey ? " sel" : ""}" data-key="${k}">
        <td class="num"${adv ? ' style="color:var(--good);font-weight:700"' : ""}>${r ?? "—"}</td><td class="team-name">${esc(n)}${me ? " (mine)" : ""}${has ? `<span class="tag ${me ? "mine" : "opp"}">has him</span>` : ""}</td>
        <td class="num">${p != null ? Number(p).toFixed(2) : "—"}</td><td class="num">${t != null ? Math.round(t / 60) : "—"}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function leagueRosterHtml(d, key) {
  const me = key === d.id;
  const std = (SEA.pods[d.contestId] ?? []).find((x) => x[0] === key);
  const who = me ? "My team" : esc(std?.[1] ?? String(key));
  let synced = podRoster(d.contestId, key);
  // a week picked on the strip → that week's lineup and points (game tags only for the week being played)
  const wi = selWeekIdx(), inWeek = wi >= 0 && (synced ?? []).some((p) => p.wkPts), wkNo = weekList()[wi];
  if (inWeek) {
    const nowWeek = wi === weekList().length - 1;
    synced = synced.map((p) => ({ ...p, slot: SLOT_OF[p.slots?.[wi]] ?? p.slot ?? null, wk: p.wkPts?.[wi] ?? null, ...(nowWeek ? {} : { st: null, ts: null, start: null }) }));
  }
  const gsum = gameSummary(synced ?? (me ? (SEA.scores[d.id] ?? []).map(([, , , , pmr, st, ts, game, start]) => ({ pmr, st, ts, game, start })) : null));
  const wkPlace = inWeek ? weekRanksOf(d.contestId, wi).get(key) : null, wkTeam = inWeek ? teamWeeks(d.contestId, key)?.[wi] : null;
  const head = `<h4>${inWeek ? `Week ${wkNo} lineup` : "Roster"} <span class="lg-who">${who}</span> <span class="lg-note">${me ? "this team" : "opponent"}${
    inWeek ? ` · Week ${wkNo}: ${wkTeam != null ? Number(wkTeam).toFixed(2) : "—"} pts${wkPlace != null ? ` · ${ordinal(wkPlace)} that week` : ""}`
    : std?.[2] != null ? ` · ${ordinal(std[2])} · ${Number(std[3] ?? 0).toFixed(2)} pts` : ""}${gsum ? ` · ${gsum}` : ""}</span></h4>`;
  const wkLabel = inWeek ? `Wk ${wkNo}` : SEA.week ? `Wk ${SEA.week}` : "This week";
  if (synced) {
    const rows = synced.slice().sort((a, b) => (SLOT_ORDER[a.slot] ?? 8) - (SLOT_ORDER[b.slot] ?? 8) || (b.wk ?? -1) - (a.wk ?? -1) || (b.season ?? -1) - (a.season ?? -1) || String(a.name).localeCompare(String(b.name)));
    return head + `<div class="scroll-x"><table><thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th>Team</th><th class="num">${wkLabel}</th><th class="num">Season</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="${p.slot === "BN" ? "bench" : ""}${playerMatch(p.name) ? (me ? " hit" : " hit opp") : ""}">
        <td>${esc(p.slot ?? "")}</td><td>${logo(p.team)}${esc(p.name)}${playingChip(p)}</td><td>${p.pos ? `<span class="pos ${esc(p.pos)}">${esc(p.pos)}</span>` : "—"}</td><td>${esc(p.team ?? "—")}</td>
        <td class="num">${p.wk != null ? Number(p.wk).toFixed(2) : "—"}</td><td class="num">${p.season != null ? Number(p.season).toFixed(2) : "—"}</td></tr>`).join("")}</tbody></table></div>
      <div class="lg-note" style="margin-top:6px">${inWeek ? `The lineup DraftKings counted in week ${wkNo}: starters` : "Starters"} first, then bench. Season = points in weeks he started.</div>`;
  }
  if (!me) return head + `<div class="lg-note" style="padding:8px 0">This team's roster hasn't been synced yet — run "Sync opponent rosters" in the extension.</div>`;
  // my own team without an opponent-roster sync: fall back to the per-player scores table
  const scoreRows = (SEA.scores[d.id] ?? []).slice().sort((a, b) => (b[2] ?? b[1]) - (a[2] ?? a[1]) || (b[3] ?? 0) - (a[3] ?? 0));
  if (!scoreRows.length) return head + `<div class="lg-note" style="padding:8px 0">No player scores synced yet.</div>`;
  return head + `<div class="scroll-x"><table><thead><tr><th>Player</th><th>Pos</th><th class="num">${wkLabel}</th><th class="num">Season</th><th class="num">Total</th></tr></thead>
    <tbody>${scoreRows.map(([pid, pts, counted, wk, pmr, st, ts, game, start]) => { const p = P[pid] ?? {}; return `<tr${playerMatch(p.n) ? ' class="hit"' : ""}>
      <td>${logo(p.t)}${esc(p.n ?? pid)}${playingChip({ pmr, st, ts, game, start })}</td><td>${p.p ? `<span class="pos ${p.p}">${p.p}</span>` : "—"}</td>
      <td class="num">${wk != null ? Number(wk).toFixed(2) : "—"}</td>
      <td class="num">${counted != null ? Number(counted).toFixed(2) : "—"}</td>
      <td class="num">${pts != null ? Number(pts).toFixed(2) : "—"}</td></tr>`; }).join("")}</tbody></table></div>
    <div class="lg-note" style="margin-top:6px">season = points in weeks he started (what counted) · total = all weeks</div>`;
}

function openSeason(id, keyPref = null, wkPref = null) {
  const d = draftById.get(id);
  if (!d) return;
  const syn = SEA.status[id] ?? {};
  const man = manualOf(id);
  const inputCss = "border:1px solid var(--border);background:var(--page);color:var(--ink);border-radius:8px;padding:6px 8px;font:inherit;width:100%";
  const fld = (key, label, ph, type = "number") =>
    `<label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--muted)">${label}
      <input data-mf="${key}" type="${type}" ${type === "number" ? 'step="any" min="0"' : ""} value="${esc(man[key] ?? "")}"
        placeholder="${esc(ph ?? "")}" style="${inputCss}"></label>`;
  const syncedLine = syn.rank != null || syn.points != null
    ? `Synced: ${syn.rank != null ? `rank ${syn.rank} / ${syn.entrants ?? "?"}` : "no rank"}` +
      `${syn.points != null ? ` · ${Number(syn.points).toFixed(2)} pts` : ""}` +
      `${(syn.pp ?? d.pp) != null ? ` · top ${syn.pp ?? d.pp} advance/get paid` : ""}` +
      `${syn.at ? ` · as of ${new Date(syn.at).toLocaleString()}` : ""}`
    : `No synced standings yet${(syn.pp ?? d.pp) != null ? ` · top ${syn.pp ?? d.pp} of ${syn.entrants ?? d.ent ?? d.size ?? "?"} advance/get paid` : ""} — fill in the manual fields below.`;
  // while a player search is active, open on the opponent who has him if my team doesn't
  const hit = searchHits(d);
  const startKey = keyPref ?? (hit && !hit.mine.length && hit.opps.length ? hit.opps[0].key : d.id);
  openSeason.current = { id, key: startKey, wk: wkPref != null && weekList().includes(wkPref) ? wkPref : null }; // so a live refresh can redraw the open editor in place
  document.getElementById("modalBox").innerHTML = `
    <button class="close" onclick="document.getElementById('modal').classList.remove('on')">✕</button>
    <h3>${esc(shortContest(d.name))}</h3>
    <div class="meta">drafted ${localDate(d.date)} · slot ${d.slot ?? "—"} of ${d.size} · ${fmt$(d.buyIn)} · entry ${d.id}
      · <span class="plink" onclick="openRoster(${d.id})">view roster →</span></div>
    <div class="meta">${esc(syncedLine)}</div>
    ${(SEA.history[id] ?? []).length >= 2 ? `
    <div class="meta" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Rank trend:
      ${rankSpark(SEA.history[id], syn.entrants ?? d.ent ?? d.size)}
      <span title="${esc(SEA.history[id].map(([day, r]) => `${day}: ${r}`).join("  ·  "))}">${esc(SEA.history[id].slice(-6).map(([, r]) => r).join(" → "))}</span>
    </div>` : ""}
    <div class="owner-only">
    <h4 style="margin:14px 0 6px">Manual scores <span class="note" style="color:var(--muted);font-weight:400">overrides synced values — clear a field to go back to synced</span></h4>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
      ${fld("rank", "Place / rank", syn.rank ?? "")}
      ${fld("entrants", "Of (entrants)", syn.entrants ?? d.ent ?? d.size ?? "")}
      ${fld("points", "Points", syn.points ?? "")}
      ${fld("cutoff", "Advance cutoff", syn.pp ?? d.pp ?? "")}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      ${fld("top", "Season carrier", syn.topPid != null ? (P[syn.topPid]?.n ?? "") : "", "text")}
      ${fld("note", "Note", "", "text")}
    </div>
    <h4 style="margin:14px 0 6px">Partners <span class="note" style="color:var(--muted);font-weight:400">people who split this entry's cost</span></h4>
    <div id="shareRows"></div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
      <button class="btn" id="addShare">+ Add partner</button>
      <span class="meta" id="shareSummary" style="margin:0"></span>
    </div>
    </div>
    ${READONLY && partnersOf(id).length ? `<div class="meta">Partners: ${esc(partnersOf(id).map((p) => `${p.name} ${p.pct}%`).join(", "))}</div>` : ""}
    ${(SEA.pods[d.contestId] ?? []).length >= 2 ? `
    <div id="lgWeeks">${weekStripHtml(d)}</div>
    <div class="lg-split" style="margin-top:14px" data-league="${d.id}">
      <div class="lg-left">${leagueStandingsHtml(d, startKey)}</div>
      <div class="lg-right" id="lgRoster">${leagueRosterHtml(d, startKey)}</div>
    </div>` : leagueRosterHtml(d, d.id)}`;
  const box = document.getElementById("modalBox");
  // redraw the week strip in place (keeps its sideways scroll position)
  const drawWeekStrip = () => {
    const strip = box.querySelector("#lgWeeks"); if (!strip) return;
    const x = strip.querySelector(".wkbar")?.scrollLeft ?? 0;
    strip.innerHTML = weekStripHtml(d);
    if (strip.querySelector(".wkbar")) strip.querySelector(".wkbar").scrollLeft = x;
  };
  // click a standings row → the roster panel and the week strip switch to that team (same as the partner pages)
  box.querySelector(".lg-split")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.pick"); if (!tr) return;
    tr.closest("tbody").querySelectorAll("tr.pick").forEach((r) => r.classList.toggle("sel", r === tr));
    if (openSeason.current) openSeason.current.key = Number(tr.dataset.key);
    drawWeekStrip();
    box.querySelector("#lgRoster").innerHTML = leagueRosterHtml(d, Number(tr.dataset.key));
  });
  // click a week on the strip → the standings and the roster switch to that week ("Season" switches back)
  box.querySelector("#lgWeeks")?.addEventListener("click", (e) => {
    const b = e.target.closest(".wkbar .wk"); if (!b || !openSeason.current) return;
    openSeason.current.wk = b.dataset.wk === "" ? null : Number(b.dataset.wk);
    drawWeekStrip();
    box.querySelector(".lg-left").innerHTML = leagueStandingsHtml(d, openSeason.current.key);
    box.querySelector("#lgRoster").innerHTML = leagueRosterHtml(d, openSeason.current.key);
  });
  box.querySelectorAll("[data-mf]").forEach((inp) => inp.addEventListener("input", () => {
    LS.entries[id] = { ...(LS.entries[id] ?? {}), [inp.dataset.mf]: inp.value };
    saveLS();
    renderSeason();
  }));
  const ensureShares = () => {
    if (!LS.shares[id]) LS.shares[id] = sharesOf(id).map((x) => ({ ...x }));
    return LS.shares[id];
  };
  function drawShares() {
    const list = sharesOf(id);
    const rowsEl = box.querySelector("#shareRows");
    rowsEl.innerHTML = list.map((x, i) => `
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
        <input data-sn="${i}" placeholder="Partner name" value="${esc(x.name ?? "")}" style="${inputCss};flex:1">
        <input data-sp="${i}" type="number" min="0" max="100" step="any" placeholder="%" value="${esc(x.pct ?? "")}" style="${inputCss};width:80px;flex:none">
        <span style="color:var(--muted)">%</span>
        <button class="btn" data-sx="${i}" title="Remove partner">✕</button>
      </div>`).join("") || `<div class="meta">No partners — this team is 100% yours.</div>`;
    rowsEl.querySelectorAll("[data-sn]").forEach((inp) => inp.addEventListener("input", () => {
      ensureShares()[Number(inp.dataset.sn)].name = inp.value; saveLS(); drawSummary(); renderSeason();
    }));
    rowsEl.querySelectorAll("[data-sp]").forEach((inp) => inp.addEventListener("input", () => {
      ensureShares()[Number(inp.dataset.sp)].pct = inp.value; saveLS(); drawSummary(); renderSeason();
    }));
    rowsEl.querySelectorAll("[data-sx]").forEach((b) => b.addEventListener("click", () => {
      ensureShares().splice(Number(b.dataset.sx), 1); saveLS(); drawShares(); renderSeason();
    }));
    drawSummary();
  }
  function drawSummary() {
    const mine = myShareOf(id);
    box.querySelector("#shareSummary").textContent =
      `Your share: ${Math.round(mine * 100)}% · your cost ${fmt$((d.buyIn ?? 0) * mine)}`;
  }
  box.querySelector("#addShare").addEventListener("click", () => {
    ensureShares().push({ name: "", pct: "" }); saveLS(); drawShares();
  });
  drawShares();
  document.getElementById("modal").classList.add("on");
}

// ---------- partners tab: only teams with a partner listed, filterable per partner ----------
// Ignores the global filter bar on purpose: a partner wants the full list of their teams.
let partnerPick = ""; // "" = all partners, otherwise a normalised partner name
const partnerState = { key: "pct", dir: 1 };
const normName = (n) => String(n ?? "").trim().toLowerCase();
function partnerIndex() {
  // name -> { label (first-seen casing), teams: [{ d, s, pct }] }
  const idx = new Map();
  for (const d of DK.drafts) {
    const s = seasonOf(d);
    for (const p of s.partners) {
      const key = normName(p.name), pct = numOr(p.pct);
      if (!key || pct == null || pct <= 0) continue;
      if (!idx.has(key)) idx.set(key, { label: String(p.name).trim(), teams: [] });
      idx.get(key).teams.push({ d, s, pct });
    }
  }
  return idx;
}
function renderPartners() {
  const idx = partnerIndex();
  const names = [...idx.entries()].sort((a, b) => b[1].teams.length - a[1].teams.length || a[1].label.localeCompare(b[1].label));
  if (partnerPick && !idx.has(partnerPick)) partnerPick = "";
  document.getElementById("partnerPills").innerHTML =
    [`<button class="pill${partnerPick ? "" : " on"}" data-pn="">All partners</button>`,
     ...names.map(([k, v]) => `<button class="pill${partnerPick === k ? " on" : ""}" data-pn="${esc(k)}">${esc(v.label)} <span style="opacity:.7">${v.teams.length}</span></button>`)].join("");

  // rows: one per (team, partner) when showing all, so a team split three ways lists each partner's stake
  const items = partnerPick ? idx.get(partnerPick).teams.map((t) => ({ ...t, who: idx.get(partnerPick).label }))
    : names.flatMap(([, v]) => v.teams.map((t) => ({ ...t, who: v.label })));
  const rows = [];
  for (const { d, s, pct, who } of items) {
    const share = pct / 100;
    const cost = (d.buyIn ?? 0) * share;
    const won = (s.prizes ?? 0) * share;
    const chip = advChip(d, s, "—");
    const row = {
      who, name: d.name, date: d.date ?? "", buyIn: d.buyIn ?? 0, share: pct, cost,
      pct: s.rank != null && s.entrants ? s.rank / s.entrants : 9, delta: s.delta,
      points: s.points, wk: teamWeekPts(d), adv: s.advancing === true ? 2 : s.advancing === false ? 0 : 1,
      top: s.topName ?? "", wtop: s.weekTopName ?? "", won, state: stateLabel(s.state),
    };
    row.__html = `<tr class="click" data-id="${d.id}">
      ${partnerPick ? "" : `<td>${esc(who)}</td>`}
      <td style="white-space:normal">${esc(shortContest(d.name))}</td>
      <td>${localDate(d.date)}</td>
      <td class="num">${fmt$(d.buyIn)}</td>
      <td class="num">${pct}%</td>
      <td class="num">${fmt$(cost)}</td>
      <td class="num">${s.rank != null ? `${s.rank} / ${s.entrants ?? "?"}` : "—"}</td>
      <td class="num">${s.delta == null ? `<span style="color:var(--muted)">—</span>`
        : s.delta > 0 ? `<span class="diff-good">▲${s.delta}</span>`
        : s.delta < 0 ? `<span class="diff-bad">▼${-s.delta}</span>` : `<span style="color:var(--muted)">·</span>`}</td>
      <td class="num">${s.points != null ? s.points.toFixed(2) : "—"}</td>
      <td class="num" title="points scored this week — click the row for every week">${row.wk != null ? row.wk.toFixed(2) : "—"}</td>
      <td>${chip}${s.cutoff != null ? ` <span style="color:var(--muted);font-size:11px">top ${s.cutoff}</span>` : ""}</td>
      <td>${s.topName ? logo(s.topTeam) + esc(s.topName) + (s.topPts != null ? ` <span style="color:var(--muted)">· ${s.topPts.toFixed(2)}</span>` : "") : "—"}</td>
      <td>${s.weekTopName ? logo(s.weekTopTeam) + esc(s.weekTopName) + (s.weekTopPts != null ? ` <span style="color:var(--muted)">· ${s.weekTopPts.toFixed(2)}</span>` : "") : "—"}</td>
      <td class="num">${won ? fmt$(won) : "—"}</td>
      <td>${esc(row.state)}</td>
    </tr>`;
    rows.push(row);
  }
  renderTable(document.getElementById("partnerTable"), [
    ...(partnerPick ? [] : [{ key: "who", label: "Partner", sort: 1 }]),
    { key: "name", label: "Contest", sort: 1 }, { key: "date", label: "Drafted", sort: 1 },
    { key: "buyIn", label: "Buy-in", num: 1, sort: 1 }, { key: "share", label: "Share", num: 1, sort: 1 },
    { key: "cost", label: "Their cost", num: 1, sort: 1 }, { key: "pct", label: "Place", num: 1, sort: 1 },
    { key: "delta", label: "Δ", num: 1, sort: 1 }, { key: "points", label: "Points", num: 1, sort: 1 },
    { key: "wk", label: SEA.week ? `Wk ${SEA.week}` : "This wk", num: 1, sort: 1 },
    { key: "adv", label: "Advancing", sort: 1 }, { key: "top", label: "Season carrier", sort: 1 },
    { key: "wtop", label: SEA.week ? `Wk ${SEA.week} top` : "Week top", sort: 1 },
    { key: "won", label: "Their cut", num: 1, sort: 1 }, { key: "state", label: "Status", sort: 1 },
  ], rows, partnerState, renderPartners);
  document.querySelectorAll("#partnerTable tbody tr").forEach((tr) =>
    tr.onclick = () => openSeason(Number(tr.dataset.id)));

  const teams = partnerPick ? idx.get(partnerPick).teams : [...new Map(items.map((t) => [t.d.id, t])).values()];
  const who = partnerPick ? idx.get(partnerPick).label : null;
  document.getElementById("partnerCount").textContent = who
    ? `${teams.length} team${teams.length === 1 ? "" : "s"} with ${who}`
    : `${teams.length} shared team${teams.length === 1 ? "" : "s"} · ${names.length} partner${names.length === 1 ? "" : "s"}`;

  const ranked = teams.filter((t) => t.s.rank != null);
  const advancing = ranked.filter((t) => t.s.advancing === true);
  const stake = items.reduce((a, t) => a + (t.d.buyIn ?? 0) * t.pct / 100, 0);
  const cut = items.reduce((a, t) => a + (t.s.prizes ?? 0) * t.pct / 100, 0);
  let best = null;
  for (const t of ranked) { const p = t.s.entrants ? t.s.rank / t.s.entrants : 9; if (!best || p < best.p) best = { p, t }; }
  const cards = teams.length ? [
    [who ? `${who}'s teams` : "Shared teams", teams.length, who ? "teams they have a piece of" : `across ${names.length} partner${names.length === 1 ? "" : "s"}`],
    [who ? "Their stake" : "Partners' stake", fmt$(stake), "share % × buy-in, summed"],
    ["Advancing", ranked.length ? `${advancing.length} of ${ranked.length}` : "—", ranked.length ? "at or inside the advance cutoff" : "no ranks synced yet"],
    ["Best placed", best ? `${best.t.s.rank} / ${best.t.s.entrants ?? "?"}` : "—", best ? shortContest(best.t.d.name) : "—"],
    [who ? "Their cut of winnings" : "Partners' cut of winnings", fmt$(cut), cut ? "share % × prizes won" : "nothing won yet"],
  ] : [["No shared teams yet", "—", "open the Season tab, click a team row and add a partner with their %"]];
  document.getElementById("partnerCards").innerHTML = cards.map(([k, v, d]) =>
    `<div class="card"><div class="k">${esc(String(k))}</div><div class="v">${esc(String(v))}</div><div class="d">${esc(d)}</div></div>`).join("");
}
document.getElementById("partnerPills").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  partnerPick = b.dataset.pn;
  location.hash = partnerPick ? `partners=${encodeURIComponent(partnerPick)}` : "partners";
  renderPartners();
});

document.getElementById("seasonPills").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  seasonPill = b.dataset.sf;
  document.querySelectorAll("#seasonPills .pill").forEach((x) => x.classList.toggle("on", x === b));
  renderSeason();
});
document.getElementById("exportTeams").onclick = () => {
  const entries = {}, shares = {};
  for (const d of DK.drafts) {
    const m = manualOf(d.id);
    const clean = {};
    for (const k of ["rank", "entrants", "points", "cutoff", "top", "note"]) {
      if (m[k] != null && String(m[k]).trim() !== "") clean[k] = m[k];
    }
    if (Object.keys(clean).length) entries[d.id] = clean;
    const s = sharesOf(d.id).filter((x) => txtOr(x.name) && numOr(x.pct) != null && numOr(x.pct) > 0);
    if (s.length) shares[d.id] = s.map((x) => ({ name: txtOr(x.name), pct: numOr(x.pct) }));
  }
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  download(`dkbb-teams-${ts}.json`,
    JSON.stringify({ version: 1, kind: "teams", source: "dkbb-dashboard", exportedAt: new Date().toISOString(), entries, shares }, null, 2),
    "application/json");
};

// ---------- analytics ----------
function renderAnalytics() {
  const drafts = filteredDrafts();
  const total = drafts.length || 1;
  const teamRosters = new Map(), teamPlayers = new Map(), team3 = new Map(), team4 = new Map();
  for (const d of drafts) {
    const n = new Map();
    for (const pk of picksByEntry.get(d.id) ?? []) { const t = P[pk.pl]?.t; if (t) n.set(t, (n.get(t) ?? 0) + 1); }
    for (const [t, k] of n) {
      teamRosters.set(t, (teamRosters.get(t) ?? 0) + 1);
      teamPlayers.set(t, (teamPlayers.get(t) ?? 0) + k);
      if (k >= 3) team3.set(t, (team3.get(t) ?? 0) + 1);
      if (k >= 4) team4.set(t, (team4.get(t) ?? 0) + 1);
    }
  }
  const teams = [...teamRosters.entries()].sort((a, b) => b[1] - a[1]);
  document.getElementById("chartTeams").innerHTML = hbarChart(
    teams.map(([t, n]) => ({ label: t, value: n / total, tip: `${t}: on <b>${n}</b> of ${total} rosters (${fmtPct(n / total)}) · ${(teamPlayers.get(t) / total).toFixed(2)} players/roster` })),
    { valueFmt: fmtPct });

  const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let totalPicks = 0;
  for (const d of drafts) for (const pk of picksByEntry.get(d.id) ?? []) {
    const p = P[pk.pl]?.p; if (p in posCount) { posCount[p]++; totalPicks++; }
  }
  const posColor = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
  document.getElementById("chartPos").innerHTML = hbarChart(
    Object.entries(posCount).map(([p, n]) => ({ label: p, value: totalPicks ? n / totalPicks : 0, color: posColor[p],
      tip: `${p}: <b>${n}</b> picks (${fmtPct(totalPicks ? n / totalPicks : 0)})` })),
    { valueFmt: fmtPct });

  const complete = drafts.filter((d) => d.picksMade === d.picksTotal);
  const constr = new Map();
  for (const d of complete) {
    const c = constructionOf(d.id);
    const k = `${c.QB} QB / ${c.RB} RB / ${c.WR} WR / ${c.TE} TE`;
    constr.set(k, (constr.get(k) ?? 0) + 1);
  }
  document.querySelector("#constrTable tbody").innerHTML = [...constr.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<tr><td>${k}</td><td class="num">${n}</td><td class="num">${fmtPct(n / (complete.length || 1))}</td></tr>`).join("");

  // combos
  const pair = new Map(), triple = new Map();
  for (const d of drafts) {
    const ids = (picksByEntry.get(d.id) ?? []).map((pk) => pk.pl).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + "," + ids[j];
      pair.set(k, (pair.get(k) ?? 0) + 1);
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) for (let l = j + 1; l < ids.length; l++) {
      const k = ids[i] + "," + ids[j] + "," + ids[l];
      triple.set(k, (triple.get(k) ?? 0) + 1);
    }
  }
  const comboRows = (m, el) => {
    document.querySelector(el + " tbody").innerHTML = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([k, n]) => `<tr><td style="white-space:normal">${k.split(",").map((id) => esc(P[id]?.n ?? id)).join(" + ")}</td><td class="num">${n}</td><td class="num">${fmtPct(n / total)}</td></tr>`).join("");
  };
  comboRows(pair, "#combo2"); comboRows(triple, "#combo3");

  // QB stacks aggregated: QB + one same-team pass catcher (WR/TE)
  const stackCount = new Map();
  for (const d of drafts) {
    const picks = picksByEntry.get(d.id) ?? [];
    for (const qbPick of picks) {
      const qb = P[qbPick.pl]; if (qb?.p !== "QB" || !qb.t) continue;
      for (const pk of picks) {
        const m = P[pk.pl];
        if (m && m.t === qb.t && (m.p === "WR" || m.p === "TE")) {
          const k = `${qb.n} + ${m.n}`;
          stackCount.set(k, (stackCount.get(k) ?? 0) + 1);
        }
      }
    }
  }
  document.querySelector("#qbStacks tbody").innerHTML = [...stackCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, n]) => `<tr><td style="white-space:normal">${esc(k)}</td><td class="num">${n}</td><td class="num">${fmtPct(n / total)}</td></tr>`).join("");

  document.querySelector("#teamStacks tbody").innerHTML = teams.slice(0, 20)
    .map(([t]) => `<tr><td>${t}</td><td class="num">${(teamPlayers.get(t) / total).toFixed(2)}</td>
      <td class="num">${team3.get(t) ?? 0}</td><td class="num">${team4.get(t) ?? 0}</td></tr>`).join("");
}

// ---------- debug ----------
function renderDebug() {
  const m = DK.meta;
  document.getElementById("debugInfo").innerHTML = `<h2>Import diagnostics</h2>
    <p>Generated <b>${new Date(DK.generatedAt).toLocaleString()}</b> from <code>${esc(m.sourceFile)}</code>
    (synced ${new Date(m.syncedAt).toLocaleString()}).</p>
    <p>${m.draftCount} drafts · ${m.pickCount} picks · ${m.playerCount} players · ${m.unnamedPlayers} players missing names
    · sync errors recorded: ${m.syncErrors}</p>
    <p>Data sources: contest list from <code>draftkings.com/mycontests</code> (embedded <code>var contests</code>);
    rosters from <code>api.draftkings.com/drafts/v1/{contestId}/entries/{entryId}/draftStatus</code> (via extension, session-auth);
    positions/teams from public <code>draftgroups/v1/draftgroups/{id}/draftables</code>. Draft groups: ${esc(String(m.draftGroups))}.</p>
    <p>Database: <code>data/portfolio.sqlite</code> — raw JSON per draft is stored in <code>drafts.raw_draft_status</code>.</p>`;
  document.querySelector("#dbgIncomplete tbody").innerHTML = DK.drafts.filter((d) => d.picksMade !== d.picksTotal)
    .map((d) => `<tr><td>${d.id}</td><td style="white-space:normal">${esc(d.name)}</td><td>${localDate(d.date)}</td>
      <td class="num">${d.picksMade}/${d.picksTotal}</td><td class="warn">${esc(d.state)}</td></tr>`).join("") ||
    `<tr><td colspan="5">None — every synced draft is complete.</td></tr>`;
}

// ---------- exports ----------
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
document.getElementById("exportCsv").onclick = () => {
  const lines = ["draft_id,entry_id,contest,draft_date,draft_slot,player,position,nfl_team,pick,round,pick_in_round,adp"];
  for (const d of DK.drafts) for (const pk of picksByEntry.get(d.id) ?? []) {
    const p = P[pk.pl] ?? {};
    lines.push([d.contestId, d.id, `"${(d.name ?? "").replace(/"/g, '""')}"`, d.date ?? "", d.slot ?? "",
      `"${(p.n ?? "").replace(/"/g, '""')}"`, p.p ?? "", p.t ?? "", pk.pk, pk.r, pk.pr, pk.adp ?? ""].join(","));
  }
  download("dk-bestball-portfolio.csv", lines.join("\n"), "text/csv");
};
document.getElementById("exportJson").onclick = () => {
  const out = DK.drafts.map((d) => ({
    draft_id: d.contestId, entry_id: d.id, contest: d.name, contest_type: d.type, buy_in: d.buyIn,
    draft_date: d.date, draft_slot: d.slot, draft_size: d.size, state: d.state,
    players: (picksByEntry.get(d.id) ?? []).map((pk) => { const p = P[pk.pl] ?? {}; return {
      name: p.n, player_id: pk.pl, position: p.p, team: p.t, pick_number: pk.pk, round: pk.r,
      pick_in_round: pk.pr, adp: pk.adp }; }),
  }));
  download("dk-bestball-portfolio.json", JSON.stringify(out, null, 2), "application/json");
};

// ---------- wiring ----------
function activateTab(name) {
  const b = document.querySelector(`nav.tabs button[data-tab="${name}"]`); if (!b) return;
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("on", s.id === "tab-" + name));
  document.getElementById("filterBar").style.display = ["season", "exposure", "balance", "rosters", "analytics"].includes(name) ? "flex" : "none";
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  activateTab(b.dataset.tab);
  if (b.dataset.tab === "partners") location.hash = partnerPick ? `partners=${encodeURIComponent(partnerPick)}` : "partners";
  else if (location.hash) history.replaceState(null, "", location.pathname);
});
// deep link: dashboard.html#partners or #partners=<name> opens straight to a partner's teams
function applyHash() {
  const m = /^#partners(?:=(.*))?$/.exec(location.hash);
  if (!m) return;
  partnerPick = m[1] ? normName(decodeURIComponent(m[1])) : "";
  activateTab("partners");
  renderPartners();
}
window.addEventListener("hashchange", applyHash);
document.getElementById("posPills").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  F.pos = b.dataset.pos;
  document.querySelectorAll("#posPills .pill").forEach((x) => x.classList.toggle("on", x === b));
  rerenderAll();
});
for (const [id, key] of [["fTeam", "team"], ["fFrom", "from"], ["fTo", "to"], ["fLastN", "lastN"], ["fAdpMax", "adpMax"], ["fSearch", "search"]]) {
  document.getElementById(id).addEventListener("input", (e) => { F[key] = e.target.value; rerenderAll(); });
}
function rerenderAll() { renderSeason(); renderExposure(); renderBalance(); renderRosters(); renderAnalytics(); }

// populate filter options
{
  const teams = [...new Set(Object.values(P).map((p) => p.t).filter(Boolean))].sort();
  document.getElementById("fTeam").innerHTML += teams.map((t) => `<option>${t}</option>`).join("");

  // reusable checkbox multi-select: onChange(null) = all selected, onChange(Set) = only these
  function multiSelect({ ddId, items, noun, onChange }) {
    const dd = document.getElementById(ddId);
    const btn = dd.querySelector(".dd-btn");
    const panel = dd.querySelector(".dd-panel");
    panel.innerHTML = `<div class="dd-actions"><a data-act="all">Select all</a><a data-act="none">Clear</a></div>` +
      items.map((it) =>
        `<label title="${esc(it.title ?? it.label)}"><input type="checkbox" checked data-value="${esc(it.value)}"> ${esc(it.label)}</label>`).join("");
    const boxes = () => [...panel.querySelectorAll("input[type=checkbox]")];
    function apply() {
      const checked = boxes().filter((b) => b.checked).map((b) => b.dataset.value);
      if (checked.length === items.length) {
        onChange(null);
        btn.textContent = `All ${noun}s ▾`;
        btn.classList.remove("active");
      } else {
        onChange(new Set(checked));
        btn.textContent = `${checked.length} of ${items.length} ${noun}s ▾`;
        btn.classList.add("active");
      }
      rerenderAll();
    }
    btn.onclick = (e) => { e.stopPropagation(); document.querySelectorAll(".dd.open").forEach((x) => { if (x !== dd) x.classList.remove("open"); }); dd.classList.toggle("open"); };
    panel.onclick = (e) => e.stopPropagation();
    panel.addEventListener("change", apply);
    panel.querySelectorAll(".dd-actions a").forEach((a) =>
      a.onclick = () => { boxes().forEach((b) => b.checked = a.dataset.act === "all"); apply(); });
  }
  document.addEventListener("click", () => document.querySelectorAll(".dd.open").forEach((x) => x.classList.remove("open")));

  const shortName = (n) => n.replace(/^NFL Best Ball\s*/, "").replace(/\s*\([^)]*\)\s*$/, "");
  const contestNames = [...new Set(DK.drafts.map((d) => d.name))].sort();
  multiSelect({
    ddId: "contestDD",
    items: contestNames.map((n) => ({ value: n, label: shortName(n), title: n })),
    noun: "contest",
    onChange: (s) => { F.contests = s; },
  });

  const buyinCounts = new Map();
  for (const d of DK.drafts) buyinCounts.set(d.buyIn, (buyinCounts.get(d.buyIn) ?? 0) + 1);
  const buyins = [...buyinCounts.keys()].sort((a, b) => a - b);
  multiSelect({
    ddId: "buyinDD",
    items: buyins.map((b) => ({ value: String(b), label: `${fmt$(b)} (${buyinCounts.get(b)} drafts)` })),
    noun: "buy-in",
    onChange: (s) => { F.buyins = s; },
  });
}
document.getElementById("genInfo").textContent =
  `${DK.drafts.length} drafts · generated ${new Date(DK.generatedAt).toLocaleString()}`;

renderSeason(); renderExposure(); renderBalance(); renderOverview(); renderRosters(); renderAnalytics(); renderDebug();

// ---------- live feed (published copy only) ----------
// GET live/ (→ /api/live) every minute. The response carries the same shapes the build script
// puts in DK.season, so it is merged into SEA and everything re-renders; the open editor is redrawn.
const LIVE = { at: null, etag: null, ok: null };
const agoTxt = (iso) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`; };
function renderLiveInfo() {
  if (!LIVE.at) return;
  const stale = Date.now() - Date.parse(LIVE.at) > 30 * 60e3;
  document.getElementById("genInfo").innerHTML = `${DK.drafts.length} drafts · <span class="live${stale ? " stale" : ""}" title="scored from public NFL stats with DraftKings' rules"><span class="dot"></span>${stale ? "live feed paused" : "live"} · updated ${agoTxt(LIVE.at)}</span>`;
  document.getElementById("seasonNote").textContent = `${stale ? "live feed paused — last update" : "live scoring · updated"} ${new Date(LIVE.at).toLocaleString()} · click a row for the league view`;
}
function applyLive(v) {
  if (!v || !v.live) return false;
  for (const [id, st] of Object.entries(v.status ?? {})) { const cur = SEA.status[id] ?? (SEA.status[id] = {}); for (const [k, val] of Object.entries(st)) if (val != null || k === "prevRank") cur[k] = val; } // prevRank null = no end-of-last-week rank → no arrow
  for (const [id, rows] of Object.entries(v.scores ?? {})) SEA.scores[id] = rows;
  SEA.pods ??= {}; for (const [cid, rows] of Object.entries(v.pods ?? {})) SEA.pods[cid] = rows;
  if (v.opp?.players?.length) { SEA.opp = v.opp; SEA.weekly = v.weekly ?? null; } // weekly.players is aligned with opp.players
  for (const [id, h] of Object.entries(v.history ?? {})) if (h.length >= 2) SEA.history[id] = h;
  if (v.week) SEA.week = v.week;
  SEA.scoresSyncedAt = v.at; LIVE.at = v.at;
  rerenderAll(); renderLiveInfo();
  if (document.getElementById("modal").classList.contains("on") && openSeason.current) openSeason(openSeason.current.id, openSeason.current.key, openSeason.current.wk);
  return true;
}
async function pollLive() {
  if (document.visibilityState === "hidden") return;
  try {
    const res = await fetch(window.dkbbLiveUrl(), { headers: LIVE.etag ? { "If-None-Match": LIVE.etag } : {}, cache: "no-cache" });
    if (res.status === 304) { LIVE.ok = true; return; }
    if (!res.ok) { LIVE.ok = false; return; }
    LIVE.etag = res.headers.get("etag");
    applyLive(window.dkbbExpand(await res.json()));
    LIVE.ok = true;
  } catch { LIVE.ok = false; }
}
if (READONLY) {
  pollLive();
  setInterval(pollLive, 60e3);
  setInterval(renderLiveInfo, 15e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollLive(); });
}
applyHash();
