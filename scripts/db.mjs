// Shared bits for local scripts: the project root and dkbbdb/.env.local. (The Postgres connection that used to live here is gone — 2026-09-26.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes("=") || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
