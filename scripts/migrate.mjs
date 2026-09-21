// Applies db/schema.sql (idempotent) and prints the row count of every table.
import fs from "node:fs";
import path from "node:path";
import { connect, ROOT } from "./db.mjs";

const db = await connect();
await db.query(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8"));
const { rows } = await db.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by 1");
for (const { table_name } of rows) {
  const n = (await db.query(`select count(*)::int c from "${table_name}"`)).rows[0].c;
  console.log(table_name.padEnd(14), n);
}
await db.end();
