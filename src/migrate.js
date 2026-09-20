// Ordered, once-only SQL migrations.
//
// Why this exists alongside bootstrap(): bootstrap() self-heals the monitoring
// schema with idempotent `add column if not exists` statements, which is fine
// for adding a column but cannot express *data* (the seeded teams and staff) or
// guarantee ordering between dependent changes. Migrations are plain .sql files
// applied in filename order and recorded in schema_migrations, so a file runs
// exactly once per database and the same files can be replayed verbatim when
// this feature is ported to Nexus.
//
// Each file runs inside a transaction: a failure rolls the whole file back and
// aborts boot, so the database is never left half-migrated.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getPool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

export function listMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort() // NNN_ prefix makes lexical order the intended order
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      return { version: file.replace(/\.sql$/, ""), file, sql, checksum: sha256(sql) };
    });
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Applies every migration that hasn't run yet. Returns the versions applied.
export async function runMigrations({ dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const client = await getPool().connect();
  const applied = [];
  try {
    await client.query(`create table if not exists schema_migrations (
      version    text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`);

    const { rows } = await client.query("select version, checksum from schema_migrations");
    const known = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of listMigrations(dir)) {
      const seen = known.get(m.version);
      if (seen) {
        // An edited migration means the database and the repo disagree about
        // what was applied. Warn loudly rather than silently re-running it.
        if (seen !== m.checksum) {
          console.warn(`[migrate] ${m.file} changed since it was applied — not re-run. Add a new migration instead.`);
        }
        continue;
      }
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query(
          "insert into schema_migrations (version, checksum) values ($1,$2)",
          [m.version, m.checksum]
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${m.file} failed: ${err.message}`);
      }
      applied.push(m.version);
      log(`[migrate] applied ${m.file}`);
    }

    if (!applied.length) log("[migrate] schema up to date");
    return applied;
  } finally {
    client.release();
  }
}
