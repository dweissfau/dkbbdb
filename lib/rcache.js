// Vercel's Runtime Cache as a small key → JSON store, gzip'd so the values stay under the 2 MB item limit.
// Regional, shared by every instance, 24 h at most. Outside Vercel (scripts, tests) the SDK falls back to this
// process's memory, which is enough for a single process. Every call is best-effort: a failure means "nothing".
import { gzipSync, gunzipSync } from "node:zlib";
import { getCache } from "@vercel/functions";

const NS = "dkbbdb";
const rc = () => { try { return getCache({ namespace: NS }); } catch { return null; } };

// put(key, value, ttlSeconds, meta?) — value is JSON'd + gzip'd; meta stays plain (small fields read without inflating)
export async function rcPut(key, value, ttl, meta = {}) {
  const c = rc(); if (!c) return false;
  try { await c.set(key, { ...meta, gz: gzipSync(Buffer.from(JSON.stringify(value))).toString("base64") }, { ttl, name: key }); return true; }
  catch { return false; }
}
// → { value, ...meta } or null
export async function rcGet(key) {
  const c = rc(); if (!c) return null;
  try {
    const v = await c.get(key); if (!v?.gz) return null;
    const { gz, ...meta } = v;
    return { ...meta, value: JSON.parse(gunzipSync(Buffer.from(gz, "base64")).toString()) };
  } catch { return null; }
}
// a plain small entry (locks, markers)
export async function rcMark(key, value, ttl) { const c = rc(); if (!c) return false; try { await c.set(key, value, { ttl, name: key }); return true; } catch { return false; } }
export async function rcRead(key) { const c = rc(); if (!c) return null; try { return (await c.get(key)) ?? null; } catch { return null; } }
export async function rcDrop(key) { const c = rc(); if (!c) return; try { await c.delete(key); } catch { /* nothing to drop */ } }
