const $ = (id) => document.getElementById(id);
chrome.runtime.sendMessage({ type: "STATUS" }).then((s) => {
  const l = s.lastSync;
  $("last").textContent = l ? `Last sync ${new Date(l.at).toLocaleString()}${l.teams != null ? ` · ${l.teams} teams` : ""}` : "Nothing synced yet. Open your DraftKings contests page and click “Sync to dkbbdb”.";
  for (const name of l?.usernames ?? []) {
    const a = document.createElement("a");
    a.href = `https://dkbbdb.com/?u=${encodeURIComponent(name)}`; a.target = "_blank"; a.textContent = `See ${name} on the leaderboard ↗`; a.style.display = "block";
    $("pages").appendChild(a);
  }
});
