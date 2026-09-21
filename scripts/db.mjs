// Shared Postgres connection for local scripts: reads DATABASE_URL from dkbbdb/.env.local.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

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

export async function connect() {
  const url = process.env.DATABASE_URL || loadEnv().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing (dkbbdb/.env.local)");
  // sslmode=verify-full is what pg already does for "require"; saying so silences its warning
  const client = new pg.Client({ connectionString: url.replace("sslmode=require", "sslmode=verify-full") });
  await client.connect();
  return client;
}
