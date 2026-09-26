// Vercel's Runtime Cache as a small key → JSON store, gzip'd. Regional, shared by every instance, 24 h at most (the
// SDK's own limit; callers renew). Outside Vercel (scripts, tests) the SDK falls back to this process's memory, which
// is enough for a single process. Every call is best-effort: a failure means "nothing".
//
// An item may be at most ~2 MB, so a big value (the scored board at tens of thousands of teams, the finished-week
// totals) is stored in PIECES: the key holds a manifest { parts, stamp, ...meta }, the pieces sit at key#stamp#i.
// A reader that finds a manifest fetches its pieces (in parallel) and joins them; a put in between changes the
// stamp, so pieces never mix. That lifts the ceiling from "what fits in one item" (~20,000 teams for the board) to
// whatever memory allows (well past 100,000).
import { gzipSync, gunzipSync } from "node:zlib";
import { getCache } from "@vercel/functions";

const NS = "dkbbdb";
const PART = 1_400_000; // base64 characters per piece — safely under the item limit
const rc = () => { try { return getCache({ namespace: NS }); } catch { return null; } };

// put(key, value, ttlSeconds, meta?) — value is JSON'd + gzip'd; meta stays plain (small fields read without inflating)
export async function rcPut(key, value, ttl, meta = {}) {
  const c = rc(); if (!c) return false;
  try {
    const gz = gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");
    if (gz.length <= PART) { await c.set(key, { ...meta, gz }, { ttl, name: key }); return true; }
    const parts = Math.ceil(gz.length / PART), stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await Promise.all(Array.from({ length: parts }, (_, i) => c.set(`${key}#${stamp}#${i}`, { gz: gz.slice(i * PART, (i + 1) * PART) }, { ttl, name: key })));
    await c.set(key, { ...meta, parts, stamp, len: gz.length }, { ttl, name: key });
    return true;
  } catch { return false; }
}
// → { value, ...meta } or null
export async function rcGet(key) {
  const c = rc(); if (!c) return null;
  try {
    const v = await c.get(key); if (!v) return null;
    let gz = v.gz;
    if (v.parts) {
      const pieces = await Promise.all(Array.from({ length: v.parts }, (_, i) => c.get(`${key}#${v.stamp}#${i}`)));
      if (pieces.some((p) => !p?.gz)) return null;
      gz = pieces.map((p) => p.gz).join("");
      if (gz.length !== v.len) return null;
    }
    if (!gz) return null;
    const { gz: _gz, parts: _p, stamp: _s, len: _l, ...meta } = v;
    return { ...meta, value: JSON.parse(gunzipSync(Buffer.from(gz, "base64")).toString()) };
  } catch { return null; }
}
// a plain small entry (locks, markers)
export async function rcMark(key, value, ttl) { const c = rc(); if (!c) return false; try { await c.set(key, value, { ttl, name: key }); return true; } catch { return false; } }
export async function rcRead(key) { const c = rc(); if (!c) return null; try { return (await c.get(key)) ?? null; } catch { return null; } }
export async function rcDrop(key) { const c = rc(); if (!c) return; try { await c.delete(key); } catch { /* nothing to drop */ } }
