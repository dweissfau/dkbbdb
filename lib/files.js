// Where dkbbdb keeps its data: gzip'd JSON files. On Vercel they live in Vercel Blob (the deployment's own
// credentials — BLOB_STORE_ID + OIDC — nothing to configure); anywhere else (scripts, tests, a laptop) the same
// paths live under dkbbdb/.blob/ (or $DKBBDB_FILES), so every check runs against a local copy of the site's data.
//
//   putGz(path, value)              write (overwrite) one JSON value
//   getGz(path, { etag })           → { etag, value } | { unchanged: true } (etag still current) | null (no such file)
//   listFiles(prefix)               → [{ pathname, version, size }]   version = something that changes when the file does
//   delFile(path)
//   fileVersion(path)               → the ETag the runtime cache last saw for the file (null = not known) — a FREE check;
//                                     a Blob read is a metered operation, and Hobby has 10,000 a month (then a 30-day lockout)
//                                     so readers ask this first and touch Blob only when the file changed or the marker is gone
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { rcMark, rcRead } from "./rcache.js";

export const onBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN || (!!process.env.VERCEL && !!process.env.BLOB_STORE_ID);
export const backend = () => (onBlob() ? "blob" : "local");
const blob = () => import("@vercel/blob");
const isMissing = (e) => /not\s*found|404|BlobNotFound/i.test(String(e?.message ?? e?.name ?? e));

let localDir = null;
export const filesDir = () => (localDir ??= process.env.DKBBDB_FILES || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".blob"));
const localPath = (p) => { const full = path.join(filesDir(), p); if (!full.startsWith(filesDir())) throw new Error("bad path"); return full; };
const sha = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 24);
const MARK_S = 7 * 24 * 3600;
const mark = (p, etag) => rcMark(`fv:${p}`, { etag }, MARK_S).catch(() => {});
export const fileVersion = async (p) => (await rcRead(`fv:${p}`))?.etag ?? null;

export async function putGz(p, value) {
  const gz = gzipSync(Buffer.from(JSON.stringify(value)));
  if (onBlob()) {
    const { put } = await blob();
    const r = await put(p, gz, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/gzip", cacheControlMaxAge: 0 });
    const etag = r.etag ?? sha(gz); await mark(p, etag);
    return { etag, bytes: gz.length };
  }
  const full = localPath(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full + ".tmp", gz); fs.renameSync(full + ".tmp", full); // never a half-written file
  const etag = sha(gz); await mark(p, etag);
  return { etag, bytes: gz.length };
}

export async function getGz(p, { etag = "" } = {}) {
  if (onBlob()) {
    const { get } = await blob();
    let r;
    try { r = await get(p, { access: "private", useCache: false, ...(etag ? { ifNoneMatch: etag } : {}) }); }
    catch (e) { if (isMissing(e)) return null; throw e; }
    if (!r) return null;
    if (r.statusCode === 304) return { unchanged: true };
    const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
    const tag = r.blob?.etag ?? sha(buf); await mark(p, tag);
    return { etag: tag, value: JSON.parse(gunzipSync(buf).toString()) };
  }
  const full = localPath(p);
  if (!fs.existsSync(full)) return null;
  const buf = fs.readFileSync(full), tag = sha(buf);
  if (etag && etag === tag) return { unchanged: true };
  await mark(p, tag);
  return { etag: tag, value: JSON.parse(gunzipSync(buf).toString()) };
}

export async function listFiles(prefix) {
  if (onBlob()) {
    const { list } = await blob();
    const out = []; let cursor;
    do {
      const r = await list({ prefix, limit: 1000, cursor });
      for (const b of r.blobs) out.push({ pathname: b.pathname, version: `${b.size}|${new Date(b.uploadedAt).getTime()}`, size: b.size });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  const root = localPath(prefix);
  const dirp = fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(root);
  if (!fs.existsSync(dirp)) return [];
  const out = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); const st = fs.statSync(full); if (st.isDirectory()) walk(full); else out.push({ full, st }); } };
  walk(dirp);
  return out.map(({ full, st }) => ({ pathname: path.relative(filesDir(), full).split(path.sep).join("/"), version: `${st.size}|${st.mtimeMs}`, size: st.size }))
    .filter((f) => f.pathname.startsWith(prefix) && !f.pathname.endsWith(".tmp"));
}

export async function delFile(p) {
  await mark(p, "");
  if (onBlob()) { const { del } = await blob(); try { await del(p); } catch (e) { if (!isMissing(e)) throw e; } return; }
  const full = localPath(p); if (fs.existsSync(full)) fs.unlinkSync(full);
}

// read-modify-write of one file: fn(value | null) → new value (or undefined = leave it)
export async function updateGz(p, fn) {
  const cur = await getGz(p);
  const next = await fn(cur?.value ?? null);
  if (next !== undefined) await putGz(p, next);
  return next;
}
