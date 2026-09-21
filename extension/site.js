// Runs on dkbbdb.com/connect: lets the page see that the extension is installed and hand it the
// sync token (window.postMessage, same origin only). Protocol documented in public/connect.html.
window.addEventListener("message", async (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data?.dkbbdb) return;
  if (e.data.dkbbdb === "ping") {
    const s = await chrome.runtime.sendMessage({ type: "STATUS" });
    window.postMessage({ dkbbdb: "pong", version: s.version, connected: s.connected }, location.origin);
  }
  if (e.data.dkbbdb === "token") {
    const r = await chrome.runtime.sendMessage({ type: "SET_TOKEN", token: e.data.token });
    if (r?.ok) window.postMessage({ dkbbdb: "connected" }, location.origin);
  }
});
