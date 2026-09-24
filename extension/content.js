// Runs on https://www.draftkings.com/mycontests*
//   1. Reads the `var contests = {...}` blob already embedded in the page (your own entries).
//   2. For every Best Ball entry dkbbdb does not have yet, fetches its draft board (draftStatus) with your
//      signed-in DraftKings session: the same request the site itself makes.
//   3. Uploads the result to dkbbdb.com (no account: your teams join the leaderboard under your DraftKings username).
//   4. For each tournament whose payout table dkbbdb does not have yet, fetches the tournament's own DraftKings
//      pages and sends only their payout-related parts (the guaranteed prize per round → the "Winning" stat).
// No credentials are read or stored. One draft board lists all 12 teams, so nothing else is requested.

(() => {
  "use strict";

  const PANEL_ID = "dkbbdb-sync-panel";
  if (document.getElementById(PANEL_ID)) return;

  // ---------- contest extraction  ----------

  function matchBlock(text, start, open, close) {
    let depth = 0;
    let inStr = null;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") inStr = c;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function scanSections(objText) {
    const sections = {};
    let depth = 0;
    let inStr = null;
    let keyBuf = "";
    for (let i = 0; i < objText.length; i++) {
      const c = objText[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = c;
        continue;
      }
      if (c === "{" || c === "[") {
        if (depth === 1 && c === "[" && keyBuf.trim()) {
          const key = keyBuf.trim().replace(/[,:"']/g, "").trim();
          const arrText = matchBlock(objText, i, "[", "]");
          if (arrText) {
            try {
              sections[key] = JSON.parse(arrText);
            } catch {
              sections[key] = null;
            }
            i += arrText.length - 1;
            keyBuf = "";
            continue;
          }
        }
        depth++;
        continue;
      }
      if (c === "}" || c === "]") {
        depth--;
        continue;
      }
      if (depth === 1) {
        if (c === ",") keyBuf = "";
        else keyBuf += c;
      }
    }
    return sections;
  }

  function extractContests() {
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || !t.includes("var contests")) continue;
      const m = /var\s+contests\s*=/.exec(t);
      if (!m) continue;
      const objStart = t.indexOf("{", m.index);
      if (objStart === -1) continue;
      const objText = matchBlock(t, objStart, "{", "}");
      if (!objText) continue;
      return scanSections(objText);
    }
    return null;
  }

  const isBestBall = (c) =>
    /best ball/i.test(c?.GameType?.name ?? c?.GameTypeName ?? "") ||
    c?.GameTypeId === 145 ||
    c?.GameTypeId === 301;

  // ---------- DraftKings + dkbbdb calls (through the background worker) ----------
  const bg = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, status: 0, error: String(err) }));
  const dkJson = async (url) => {
    const r = await bg({ type: "FETCH_DK", url });
    if (!r?.ok) return { error: `HTTP ${r?.status ?? 0}` };
    try { return { json: JSON.parse(r.body) }; } catch { return { error: "response was not JSON" }; }
  };

  // ---------- payout tables ----------
  // A tournament's pages, reduced to what concerns payouts: JSON as it is (capped), HTML as the <script> blocks
  // that mention payouts plus windows of the page text around "advance / round / prize / $". A page that bounced
  // to the sign-in screen is dropped. Nothing about the account (balance, email…) is kept.
  const HOT = /advance|round\s*\d|payout|prize|guarantee|finals?/i, COLD = /password|balance|email|deposit|withdraw/i;
  function excerptOf(r) {
    if (!r?.ok || !r.body || /myaccount\.draftkings\.com|\/auth\/(signup|login)/i.test(r.url ?? "")) return null;
    const body = String(r.body);
    if (/^\s*[[{]/.test(body)) return body.slice(0, 200000);
    const parts = [];
    const sc = /<script\b[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = sc.exec(body)) && parts.join("").length < 160000) { const t = m[1]; if (t && HOT.test(t) && !COLD.test(t)) parts.push(t.slice(0, 80000)); }
    let text = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
    { const i = text.search(/contest details|tournament details|payouts?\b/i); if (i > 0) text = text.slice(i); } // from the contest's heading on, never the site header (account balance…)
    const seen = new Set(), win = []; const re = new RegExp(HOT.source + "|\\$\\s?\\d", "gi");
    while ((m = re.exec(text)) && win.join("").length < 30000) {
      const from = Math.max(0, m.index - 400), to = Math.min(text.length, m.index + 400), w = text.slice(from, to), k = w.slice(0, 60);
      if (!seen.has(k)) { seen.add(k); win.push(w); }
      re.lastIndex = to;
    }
    if (win.length) parts.push(win.join("\n…\n"));
    return parts.length ? parts.join("\n----\n") : null;
  }
  // the pages tried for one tournament (its key and the tournament-wide "mega" contest id)
  const tournamentUrls = (key, mega) => [
    [`https://www.draftkings.com/draft/tournament/${key.toLowerCase()}`, "text/html"],
    [`https://api.draftkings.com/contests/v1/tournaments/${key}?format=json`, "application/json"],
    [`https://api.draftkings.com/bestball/v1/tournaments/${key}?format=json`, "application/json"],
    ...(mega ? [[`https://api.draftkings.com/contests/v1/contests/${mega}?format=json`, "application/json"],
      [`https://api.draftkings.com/contests/v1/megacontests/${mega}?format=json`, "application/json"],
      [`https://www.draftkings.com/contest/gamecenter/${mega}`, "text/html"]] : []),
  ];
  // → { sent, read, tried, missing: [{ key, name }], error } — tournaments captured, those whose ladder dkbbdb
  // could read straight away, and those still without one (the panel links to their pages)
  async function capturePayouts(contests, haveLadders, say) {
    const todo = new Map();
    for (const c of contests) {
      const key = String(c.TournamentKey ?? "").toUpperCase();
      if (/^[0-9A-F]{32}$/.test(key) && !haveLadders.has(key) && !todo.has(key)) todo.set(key, { key, name: c.ContestName ?? null, mega: c.MegaContestId ?? null });
    }
    let sent = 0, read = 0, i = 0, error = null; const missing = [];
    for (const t of todo.values()) {
      say(`Reading payout tables… (${++i} of ${todo.size})`);
      let got = false;
      try {
        const sources = [];
        for (const [url, accept] of tournamentUrls(t.key, t.mega)) {
          const r = await bg({ type: "FETCH_DK", url, accept });
          const body = excerptOf(r);
          if (body) sources.push({ url, status: r.status, body });
          await sleep(150);
        }
        if (sources.length) {
          const r = await bg({ type: "TOURNAMENTS", tournaments: [{ key: t.key, name: t.name, sources }] });
          if (r?.ok) { sent++; if (r.tournaments?.[t.key]?.ladder) { read++; got = true; } }
          else error ??= r?.error ?? "upload failed";
        }
      } catch (err) { error ??= String(err?.message ?? err); }
      if (!got) missing.push({ key: t.key, name: t.name });
    }
    return { sent, read, tried: todo.size, missing, error };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // raw draftStatus → the compact upload form (keep in step with dkbbdb lib/ingest.js compactStatus)
  function compactStatus(ds) {
    const users = (ds.users ?? []).map((u) => [u.userKey, u.displayName ?? null]);
    const idx = new Map(users.map((u, i) => [u[0], i]));
    const board = [];
    for (const p of ds.draftBoard ?? []) {
      if (!idx.has(p.userKey)) { idx.set(p.userKey, users.length); users.push([p.userKey, null]); }
      board.push([idx.get(p.userKey), p.draftableId ?? null, p.playerId ?? null, p.roundNumber, p.selectionNumber, p.overallSelectionNumber]);
    }
    return { users, board, lineup: ds.lineup ?? [], startTime: ds.draftStartTime ?? null, state: ds.draftLifecycleState ?? null };
  }
  // the contest fields dkbbdb stores (lib/ingest.js readDraft)
  const trimContest = (c) => ({ section: c.section, ContestId: c.ContestId, UserContestId: c.UserContestId, ContestName: c.ContestName,
    GameType: c.GameType ? { name: c.GameType.name } : undefined, TournamentKey: c.TournamentKey, MegaContestId: c.MegaContestId,
    MegaContestRoundNumber: c.MegaContestRoundNumber, DraftGroupId: c.DraftGroupId, ActiveDraftGroupId: c.ActiveDraftGroupId,
    StartingDraftGroupId: c.StartingDraftGroupId, BuyInAmount: c.BuyInAmount, TotalPrizePool: c.TotalPrizePool,
    NumberOfEntrants: c.NumberOfEntrants, MaxNumberPlayers: c.MaxNumberPlayers, PositionsPaid: c.PositionsPaid,
    PrizesWon: c.PrizesWon, ContestStartDate: c.ContestStartDate });
  const groupOf = (c) => c.DraftGroupId ?? c.ActiveDraftGroupId ?? c.StartingDraftGroupId ?? null;

  // ---------- panel ----------
  const sections = extractContests();
  const all = [];
  if (sections) for (const [section, list] of Object.entries(sections)) if (Array.isArray(list)) for (const c of list) all.push({ section, ...c });
  // free contests (buy-in $0: community freerolls) are not part of the leaderboard
  const everyBestBall = all.filter(isBestBall).filter((c) => c.BuyInAmount !== 0).sort((a, b) => (b.ContestId ?? 0) - (a.ContestId ?? 0));
  // dkbbdb is a season leaderboard: contests that start after NFL week 1 are left out (the site says where week 1 ends)
  let bestBall = everyBestBall;
  function applyCutoff(startsBefore) {
    const cut = Date.parse(startsBefore ?? "");
    if (!isFinite(cut)) return;
    // (a later ROUND of a week-1 tournament is the same contest, not a late start)
    bestBall = everyBestBall.filter((c) => { const t = Date.parse(c.ContestStartDate ?? ""); return !isFinite(t) || t < cut || (c.MegaContestRoundNumber ?? 1) > 1; });
  }
  const teamsTxt = (n) => `${n} team${n === 1 ? "" : "s"}`;

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:#0d0d0d;color:#fff;border:1px solid #383835;" +
    "font:13px/1.5 system-ui,-apple-system,sans-serif;padding:14px 16px;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.5);width:300px";
  const title = document.createElement("div");
  title.textContent = "dkbbdb sync";
  title.style.cssText = "font-weight:700;margin-bottom:6px";
  const status = document.createElement("div");
  status.style.cssText = "margin-bottom:10px;white-space:pre-wrap;word-break:break-word;color:#c3c2b7";
  status.textContent = sections ? `Found ${teamsTxt(bestBall.length)} of Best Ball on this account.` : "Could not read the contest list on this page. Reload and try again.";
  const btn = document.createElement("button");
  btn.textContent = "Sync to dkbbdb";
  btn.disabled = everyBestBall.length === 0;
  btn.style.cssText = "background:#3987e5;color:#fff;border:none;border-radius:6px;padding:8px 12px;font:inherit;font-weight:700;cursor:pointer;width:100%";
  const link = document.createElement("a");
  link.target = "_blank";
  link.style.cssText = "display:none;margin-top:8px;color:#3987e5;text-align:center";
  const note = document.createElement("div");
  note.textContent = "Not affiliated with DraftKings.";
  note.style.cssText = "margin-top:8px;color:#898781;font-size:11px";
  panel.append(title, status, btn, link, note);
  document.body.appendChild(panel);

  // ask dkbbdb where week 1 ends and what it already has, so the count shown is the count that will be synced
  if (everyBestBall.length) bg({ type: "KNOWN", entries: everyBestBall.map((c) => c.UserContestId) }).then((known) => {
    if (!known?.ok || btn.disabled) return;
    applyCutoff(known.startsBefore);
    const have = new Set((known.complete ?? []).map(String));
    const fresh = bestBall.filter((c) => !have.has(String(c.UserContestId))).length;
    status.textContent = `Found ${teamsTxt(bestBall.length)} of season-long Best Ball on this account — ${fresh ? `${fresh} not on dkbbdb yet` : "all already on dkbbdb"}.`;
    btn.disabled = bestBall.length === 0;
  });
  const showLink = (text, href) => { link.textContent = text; link.href = href; link.style.display = "block"; };
  // tournaments whose payout table dkbbdb still lacks: one link each — the tournament's page reads the table
  // (its Contest Details pop-up) and the tab closes itself
  const missingBox = document.createElement("div");
  missingBox.style.cssText = "display:none;margin-top:10px;padding-top:8px;border-top:1px solid #383835;color:#c3c2b7";
  panel.insertBefore(missingBox, note);
  const shortName = (n) => String(n ?? "").replace(/^NFL Best Ball\s+/i, "").replace(/\s*\((Early Bird )?Tournament\)\s*$/i, "");
  function showMissing(list) {
    missingBox.replaceChildren(); missingBox.style.display = list?.length ? "block" : "none";
    if (!list?.length) return;
    const head = document.createElement("div");
    head.textContent = `Payout table still needed for ${list.length} tournament${list.length === 1 ? "" : "s"} — open each (the tab reads it and closes):`;
    head.style.cssText = "margin-bottom:4px";
    missingBox.appendChild(head);
    for (const t of list) {
      const a = document.createElement("a");
      a.href = `https://www.draftkings.com/draft/tournament/${t.key.toLowerCase()}`; a.target = "_blank";
      a.textContent = shortName(t.name) || t.key; a.style.cssText = "display:block;color:#3987e5;margin:2px 0";
      missingBox.appendChild(a);
    }
  }

  const PACE_MS = 350; // polite pacing between DraftKings requests
  const CHUNK = 25;    // drafts per upload

  btn.addEventListener("click", async () => {
    btn.disabled = true; link.style.display = "none";
    // what dkbbdb already has: finished pods are never fetched again, only their status is refreshed
    const known = await bg({ type: "KNOWN", entries: everyBestBall.map((c) => c.UserContestId) });
    if (!known?.ok) { status.textContent = `Could not reach dkbbdb: ${known?.error ?? "unknown error"}`; btn.disabled = false; return; }
    applyCutoff(known.startsBefore);
    const complete = new Set((known.complete ?? []).map(String)), haveGroups = new Set((known.draftGroups ?? []).map(String));
    const todo = bestBall.filter((c) => !complete.has(String(c.UserContestId)));
    const drafts = bestBall.filter((c) => complete.has(String(c.UserContestId))).map((c) => ({ contest: trimContest(c) }));
    const errors = [], adp = {}, draftables = {};
    const startedAt = Date.now();

    for (let i = 0; i < todo.length; i++) {
      const c = todo[i];
      status.textContent = `Reading draft ${i + 1} of ${todo.length}… (${Math.round((Date.now() - startedAt) / 1000)}s)\nKeep this tab open.`;
      const r = await dkJson(`https://api.draftkings.com/drafts/v1/${c.ContestId}/entries/${c.UserContestId}/draftStatus?format=json`);
      if (r.json) {
        const g = groupOf(c);
        if (g != null && !adp[g] && r.json.playerPool?.draftablePlayers) {
          adp[g] = {};
          for (const p of r.json.playerPool.draftablePlayers) if (p.playerId != null && p.averageDraftPosition != null) adp[g][p.playerId] = p.averageDraftPosition;
        }
        drafts.push({ contest: trimContest(c), ...compactStatus(r.json) });
      } else errors.push(`${c.ContestName ?? c.ContestId}: ${r.error}`);
      await sleep(PACE_MS);
    }

    // DraftKings' public player list (names, positions, teams) for draft groups dkbbdb has not seen
    for (const g of new Set(bestBall.map(groupOf).filter((x) => x != null).map(String))) {
      if (haveGroups.has(g)) continue;
      status.textContent = "Reading the player list…";
      const r = await dkJson(`https://api.draftkings.com/draftgroups/v1/draftgroups/${g}/draftables?format=json`);
      if (r.json?.draftables) draftables[g] = r.json.draftables.map((d) => [d.draftableId, d.playerId ?? null, d.displayName ?? null, d.position ?? null, d.teamAbbreviation ?? null]);
    }

    const serverErrors = [], usernames = new Set(known.usernames ?? []);
    const chunks = Math.max(1, Math.ceil(drafts.length / CHUNK));
    for (let i = 0; i < chunks; i++) {
      status.textContent = `Uploading… (${i + 1} of ${chunks})`;
      const body = { drafts: drafts.slice(i * CHUNK, (i + 1) * CHUNK), last: i === chunks - 1, ...(i === 0 ? { adp, draftables } : {}) };
      const r = await bg({ type: "UPLOAD", body });
      if (!r?.ok) { status.textContent = `Upload failed: ${r?.error ?? "unknown error"}\nClick Sync to try again.`; btn.disabled = false; return; }
      serverErrors.push(...(r.errors ?? []));
      for (const n of r.usernames ?? []) usernames.add(n);
    }
    // payout tables for tournaments dkbbdb has none for yet (the "Winning" stat)
    let pay = { sent: 0, read: 0, tried: 0, missing: [], error: null };
    try { pay = await capturePayouts(bestBall, new Set((known.ladders ?? []).map((k) => String(k).toUpperCase())), (t) => { status.textContent = t; }); }
    catch (err) { pay.error = String(err?.message ?? err); }
    const problems = [...errors, ...serverErrors];
    status.textContent = `Done — ${teamsTxt(bestBall.length)} on dkbbdb (${todo.length} new or updated).` +
      (pay.tried ? `\nPayout tables: ${pay.read} of ${pay.tried} read.` : "\nPayout tables: all on dkbbdb.") +
      (pay.error ? `\nPayout tables: ${pay.error}` : "") +
      (problems.length ? `\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.slice(0, 4).join("\n")}` : "");
    showMissing(pay.missing);
    const names = [...usernames];
    bg({ type: "SYNCED", usernames: names, teams: bestBall.length });
    if (names.length) showLink(`See ${names[0]} on the leaderboard ↗`, `https://dkbbdb.com/?u=${encodeURIComponent(names[0])}`);
    else showLink("Open dkbbdb ↗", "https://dkbbdb.com/");
    btn.disabled = false;
  });
})();
