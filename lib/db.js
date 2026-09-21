// Postgres pool for the API functions (Neon pooled connection string in DATABASE_URL).
import pg from "pg";

let pool = null;
export function db() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // sslmode=verify-full is what pg already does for "require"; saying so silences its warning
    pool = new pg.Pool({ connectionString: url.replace("sslmode=require", "sslmode=verify-full"), max: 3, idleTimeoutMillis: 20e3 });
  }
  return pool;
}
