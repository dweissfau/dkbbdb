// Runs on https://www.draftkings.com/mycontests*
//   1. Reads the `var contests = {...}` blob already embedded in the page (your own entries).
//   2. For every Best Ball entry dkbbdb does not have yet, fetches its draft board (draftStatus) with your
//      signed-in DraftKings session: the same request the site itself makes.
//   3. Uploads the result to dkbbdb.com (no account: your page is dkbbdb.com/u/<your DraftKings username>).
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
  const bestBall = all.filter(isBestBall).sort((a, b) => (b.ContestId ?? 0) - (a.ContestId ?? 0));
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
  btn.disabled = bestBall.length === 0;
  btn.style.cssText = "background:#3987e5;color:#fff;border:none;border-radius:6px;padding:8px 12px;font:inherit;font-weight:700;cursor:pointer;width:100%";
  const link = document.createElement("a");
  link.target = "_blank";
  link.style.cssText = "display:none;margin-top:8px;color:#3987e5;text-align:center";
  const note = document.createElement("div");
  note.textContent = "Not affiliated with DraftKings.";
  note.style.cssText = "margin-top:8px;color:#898781;font-size:11px";
  panel.append(title, status, btn, link, note);
  document.body.appendChild(panel);
  const showLink = (text, href) => { link.textContent = text; link.href = href; link.style.display = "block"; };

  const PACE_MS = 350; // polite pacing between DraftKings requests
  const CHUNK = 25;    // drafts per upload

  btn.addEventListener("click", async () => {
    btn.disabled = true; link.style.display = "none";
    // what dkbbdb already has: finished pods are never fetched again, only their status is refreshed
    const known = await bg({ type: "KNOWN", entries: bestBall.map((c) => c.UserContestId) });
    if (!known?.ok) { status.textContent = `Could not reach dkbbdb: ${known?.error ?? "unknown error"}`; btn.disabled = false; return; }
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
    const problems = [...errors, ...serverErrors];
    status.textContent = `Done — ${teamsTxt(bestBall.length)} on dkbbdb (${todo.length} new or updated).` +
      (problems.length ? `\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.slice(0, 4).join("\n")}` : "");
    const names = [...usernames];
    bg({ type: "SYNCED", usernames: names, teams: bestBall.length });
    if (names.length) showLink(`Open ${names[0]} on dkbbdb ↗`, `https://dkbbdb.com/u/${encodeURIComponent(names[0])}`);
    else showLink("Open dkbbdb ↗", "https://dkbbdb.com/");
    btn.disabled = false;
  });
})();
