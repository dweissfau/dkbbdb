const $ = (id) => document.getElementById(id);
async function render() {
  const s = await chrome.runtime.sendMessage({ type: "STATUS" });
  $("dot").classList.toggle("on", s.connected);
  $("state").textContent = s.connected ? "Connected to your dkbbdb account." : "Not connected yet.";
  $("last").textContent = s.lastSync ? `Last sync ${new Date(s.lastSync.at).toLocaleString()}${s.lastSync.summary ? ` · ${s.lastSync.summary}` : ""}` : "";
  $("main").textContent = s.connected ? "Sync: open DraftKings contests ↗" : "Connect to dkbbdb";
  $("main").href = s.connected ? "https://www.draftkings.com/mycontests" : "https://dkbbdb.com/connect";
}
$("code").addEventListener("change", async () => {
  const r = await chrome.runtime.sendMessage({ type: "SET_TOKEN", token: $("code").value.trim() });
  $("codeMsg").textContent = r?.ok ? "Connected ✓" : "That does not look like a connection code.";
  if (r?.ok) { $("code").value = ""; render(); }
});
render();
