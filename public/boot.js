// Sign-in + data loading for every dkbbdb page (Clerk in the browser, no framework).
//   <body data-page="home">     landing: swaps "Sign in" for "Open my teams" when already signed in
//   <body data-page="connect">  extension pairing (see connect.html)
//   app.html (no data-page)     signs in, loads /api/portfolio into window.__DK, then runs /app.js
(() => {
  const page = document.body.dataset.page ?? "app";
  const $ = (sel) => document.querySelector(sel);

  const veil = document.createElement("div");
  veil.id = "veil";
  veil.style.cssText = "position:fixed;inset:0;z-index:1000;background:#0d0d0d;color:#c3c2b7;display:grid;place-items:center;padding:24px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;overflow:auto";
  const say = (html) => { veil.innerHTML = `<div style="text-align:center;max-width:420px">${html}</div>`; };
  if (page === "app") { say("Loading your teams…"); document.body.appendChild(veil); }

  const loadScript = (src, attrs = {}) => new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src; s.async = true; s.crossOrigin = "anonymous";
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = ok; s.onerror = () => fail(new Error("could not load " + src));
    document.head.appendChild(s);
  });

  async function clerk() {
    const { clerkPublishableKey: pk } = await (await fetch("/api/config")).json();
    if (!pk) throw new Error("sign-in is not configured");
    const host = atob(pk.split("_")[2]).replace(/\$$/, ""); // the key carries the instance's Frontend API host
    await loadScript(`https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`, { "data-clerk-publishable-key": pk });
    await window.Clerk.load({ appearance: { variables: { colorPrimary: "#3987e5" } } });
    return window.Clerk;
  }

  window.dkbbToken = async () => (await window.Clerk.session?.getToken()) ?? "";
  window.dkbbApi = async (path, init = {}) => {
    const res = await fetch(path, { ...init, cache: "no-store", headers: { ...(init.headers ?? {}), Authorization: "Bearer " + await window.dkbbToken() } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json();
  };

  function signInWall(C) {
    document.body.appendChild(veil);
    say(`<h1 style="color:#fff;font-size:20px;margin:0 0 4px">dkbbdb</h1><p style="margin:0 0 18px">Sign in to see your teams.</p><div id="signin" style="display:inline-block;text-align:left"></div>`);
    C.mountSignIn($("#signin"), { forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
  }

  async function start() {
    const C = await clerk();
    if (page === "home") {
      if (C.user) { const a = $("#cta"); if (a) { a.textContent = "Open my teams"; a.href = "/app"; } }
      return;
    }
    if (!C.user) return signInWall(C);
    if (page === "connect") return window.dkbbConnect?.(C);

    const data = await window.dkbbApi("/api/portfolio");
    if (!data.drafts.length) { location.replace("/connect"); return; }
    window.__DK = data;
    await loadScript("/app.js");
    const btn = $("#userBtn"); if (btn) C.mountUserButton(btn, { afterSignOutUrl: "/" });
    veil.remove();
  }

  start().catch((e) => {
    if (!veil.isConnected) document.body.appendChild(veil);
    say(`<p style="color:#e66767">Something went wrong: ${String(e?.message ?? e).replace(/</g, "&lt;")}</p><p><a href="" style="color:#3987e5">Try again</a></p>`);
  });
})();
