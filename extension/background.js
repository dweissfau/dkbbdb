// Service worker.
//   FETCH_DK         draftkings.com requests for the content scripts (host_permissions exempt them from CORS).
//                    The browser attaches the user's own DraftKings session; this extension never reads, stores
//                    or sends cookies or credentials.
//   KNOWN / UPLOAD   talk to dkbbdb.com (no account: the uploaded drafts say which DraftKings username they are).
//   TOURNAMENTS      payout-table excerpts of a tournament's pages → dkbbdb.com (the "Winning" stat).
//   STATUS           last sync, for the popup.
const SITE = "https://dkbbdb.com";
const VERSION = chrome.runtime.getManifest().version;
const DK = ["https://api.draftkings.com/", "https://www.draftkings.com/"];

async function dkFetch(url, accept) {
  try {
    const res = await fetch(url, { credentials: "include", headers: { Accept: accept ?? "application/json" } });
    return { ok: res.ok, status: res.status, url: res.url, body: await res.text() };
  } catch (err) { return { ok: false, status: 0, error: String(err) }; }
}

async function site(path, body) {
  try {
    const res = await fetch(SITE + path, { method: "POST", headers: { "content-type": "application/json", "x-dkbbdb-extension": VERSION }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...json } : { ok: false, status: res.status, error: json.error ?? `HTTP ${res.status}` };
  } catch (err) { return { ok: false, status: 0, error: String(err) }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FETCH_DK") {
    if (typeof msg.url !== "string" || !DK.some((p) => msg.url.startsWith(p))) { sendResponse({ ok: false, status: 0, error: "URL not allowed" }); return; }
    dkFetch(msg.url, msg.accept).then(sendResponse); return true;
  }
  if (msg?.type === "KNOWN") { site("/api/known", { entries: msg.entries ?? [] }).then(sendResponse); return true; }
  if (msg?.type === "UPLOAD") { site("/api/sync", msg.body).then(sendResponse); return true; }
  if (msg?.type === "TOURNAMENTS") { site("/api/tournaments", { tournaments: msg.tournaments ?? [] }).then(sendResponse); return true; }
  if (msg?.type === "SYNCED") {
    chrome.storage.local.set({ lastSync: { at: new Date().toISOString(), usernames: msg.usernames ?? [], teams: msg.teams ?? null } }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "STATUS") { chrome.storage.local.get({ lastSync: null }).then((s) => sendResponse({ version: VERSION, lastSync: s.lastSync })); return true; }
});
