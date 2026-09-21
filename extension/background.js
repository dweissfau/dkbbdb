// Service worker.
//   FETCH_DK   api.draftkings.com requests for the content script (host_permissions exempt them from CORS).
//              The browser attaches the user's own DraftKings session; this extension never reads, stores
//              or sends cookies or credentials.
//   UPLOAD / KNOWN   talk to dkbbdb.com/api/sync with the sync token saved by the connect page.
//   SET_TOKEN / STATUS   pairing state for the popup and the connect page.
const SITE = "https://dkbbdb.com";

async function dkFetch(url) {
  try {
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) { return { ok: false, status: 0, error: String(err) }; }
}

async function site(method, body) {
  const { token } = await chrome.storage.local.get({ token: null });
  if (!token) return { ok: false, status: 401, error: "Not connected — open dkbbdb.com/connect and click Connect extension." };
  try {
    const res = await fetch(`${SITE}/api/sync`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...json } : { ok: false, status: res.status, error: json.error ?? `HTTP ${res.status}` };
  } catch (err) { return { ok: false, status: 0, error: String(err) }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FETCH_DK") {
    if (typeof msg.url !== "string" || !msg.url.startsWith("https://api.draftkings.com/")) { sendResponse({ ok: false, status: 0, error: "URL not allowed" }); return; }
    dkFetch(msg.url).then(sendResponse); return true;
  }
  if (msg?.type === "KNOWN") { site("GET").then(sendResponse); return true; }
  if (msg?.type === "UPLOAD") {
    site("POST", msg.body).then(async (r) => {
      if (r.ok && msg.body?.last !== false) await chrome.storage.local.set({ lastSync: { at: new Date().toISOString(), summary: msg.summary ?? null } });
      sendResponse(r);
    });
    return true;
  }
  if (msg?.type === "SET_TOKEN") {
    const ok = typeof msg.token === "string" && /^dkbb_[\w-]{20,}$/.test(msg.token);
    (ok ? chrome.storage.local.set({ token: msg.token, connectedAt: new Date().toISOString() }) : Promise.resolve()).then(() => sendResponse({ ok }));
    return true;
  }
  if (msg?.type === "STATUS") {
    chrome.storage.local.get({ token: null, connectedAt: null, lastSync: null }).then((s) =>
      sendResponse({ version: chrome.runtime.getManifest().version, connected: !!s.token, connectedAt: s.connectedAt, lastSync: s.lastSync }));
    return true;
  }
});
