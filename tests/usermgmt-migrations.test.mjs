// Tests for the migration runner's inputs.
//
// Migrations run against the production database at boot, so the things worth
// asserting without a database are the ones a reviewer can't easily eyeball:
// that ordering is unambiguous, that nothing destructive slipped in, and that
// the seeded roster matches the one the agency actually asked for.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listMigrations } from "../src/migrate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "db", "migrations");

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const migrations = listMigrations(DIR);
const byVersion = Object.fromEntries(migrations.map((m) => [m.version, m]));
const allSql = migrations.map((m) => m.sql).join("\n").toLowerCase();

console.log("--- discovery and ordering ---");
ok("migrations are found", migrations.length >= 2);
ok("every file has a NNN_ prefix", migrations.every((m) => /^\d{3}_/.test(m.version)),
   migrations.map((m) => m.version).join(", "));
const prefixes = migrations.map((m) => m.version.slice(0, 3));
ok("numeric prefixes are unique", new Set(prefixes).size === prefixes.length, prefixes.join(", "));
ok("returned in ascending order", prefixes.join(",") === [...prefixes].sort().join(","));
ok("every migration carries a checksum", migrations.every((m) => /^[0-9a-f]{64}$/.test(m.checksum)));
ok("checksums are stable across reads",
   listMigrations(DIR).every((m, i) => m.checksum === migrations[i].checksum));
ok("a missing directory yields no migrations", listMigrations(path.join(DIR, "nope")).length === 0);

console.log("\n--- nothing destructive ---");
// These run unattended at boot against live data. A drop or truncate would need
// a deliberate, reviewed exception rather than slipping in unnoticed.
for (const bad of ["drop table", "drop column", "truncate", "drop database", "delete from"]) {
  ok(`no "${bad}"`, !allSql.includes(bad));
}
// Altering `websites` is expected — the per-site credential columns live there
// — but only ever additively. A drop or a type change on a live monitoring
// table is what must not slip through.
const alters = allSql.match(/alter table\s+\w+[^;]*/g) || [];
ok("every alter is an additive add-column",
   alters.every((a) => /add column if not exists/.test(a)),
   alters.filter((a) => !/add column if not exists/.test(a)).join(" | "));
ok("app_users and the metric tables are untouched",
   !/alter table\s+(app_users|metric_samples|request_metrics|status_events)\b/.test(allSql));

console.log("\n--- 001: core entities ---");
const core = byVersion["001_user_management_core"];
ok("001 exists", !!core);
for (const table of ["teams", "staff_users", "audit_log"]) {
  ok(`creates ${table}`, new RegExp(`create table if not exists ${table}\\b`).test(core.sql));
}
// "departments" may appear in a comment explaining why we avoid the name; what
// must never appear is a departments *identifier* that could collide with Nexus.
ok("no departments identifier", !/\b(table|into|from|join|update)\s+\w*departments\b/i.test(core.sql));
ok("email uniqueness is case-insensitive",
   /create unique index if not exists staff_users_email_lower_idx on staff_users \(lower\(email\)\)/.test(core.sql));
ok("team names are case-insensitively unique",
   /teams_name_lower_idx on teams \(lower\(name\)\)/.test(core.sql));
ok("default team role is editor, not administrator",
   /default_wp_role text not null default 'editor'/.test(core.sql) && !/default 'administrator'/.test(core.sql));
ok("staff rows survive their team being deleted",
   /team_id\s+uuid references teams\(id\) on delete set null/.test(core.sql));
ok("is re-runnable", (core.sql.match(/create table (?!if not exists)/g) || []).length === 0);

console.log("\n--- 002: the seeded roster ---");
const seed = byVersion["002_seed_teams_and_staff"];
ok("002 exists", !!seed);

const TEAMS = ["SEO", "Content", "PPC", "Web Development", "Admin"];
for (const t of TEAMS) ok(`seeds the ${t} team`, seed.sql.includes(`'${t}'`));
// Counted on the row terminator, not a line break: git normalizes these files
// to CRLF on a Windows checkout, so an assertion that depends on \n passes only
// for whoever happened to write the file.
eq("exactly five teams", (seed.sql.match(/'editor'\)/g) || []).length, 5);

const ROSTER = {
  seo: ["jason", "npappas", "jhaley", "bhalinar", "wsmall"],
  content: ["regan", "mwhittle", "agill", "bpowell"],
  ppc: ["pdemeter", "jmosher", "jaguilar"],
  "web-development": ["groseman", "ggardner", "jeff"],
  admin: ["ryan", "danny"],
};
let seeded = 0;
for (const [team, people] of Object.entries(ROSTER)) {
  for (const person of people) {
    const line = new RegExp(`'${person}@digitalelementsgroup\\.com'\\s*,\\s*'${team}'`);
    ok(`${person} is on ${team}`, line.test(seed.sql));
    seeded++;
  }
}
eq("seventeen people seeded", seeded, 17);
// 17 roster rows, each a separately quoted address, plus the grant list — which
// is one quoted comma-separated string, so it contributes a single closing quote.
eq("no extra addresses crept in",
   (seed.sql.match(/@digitalelementsgroup\.com'/g) || []).length, 18);

console.log("\n--- 002: re-runnable and self-contained ---");
ok("teams tolerate re-running", /on conflict \(slug\) do nothing/.test(seed.sql));
ok("staff tolerate re-running", /on conflict \(lower\(email\)\) do nothing/.test(seed.sql));
ok("the grant list tolerates re-running", /on conflict \(key\) do nothing/.test(seed.sql));
for (const grantee of ["ryan", "danny", "jeff"]) {
  ok(`${grantee} is seeded into the manageWpUsers grant list`,
     new RegExp(`wp_user_managers[\\s\\S]*${grantee}@digitalelementsgroup\\.com`).test(seed.sql));
}

console.log("\n--- 003: per-site credentials ---");
const creds = byVersion["003_site_user_management_credentials"];
ok("003 exists", !!creds);
ok("the secret column is the encrypted one", /um_secret_enc/.test(creds.sql));
ok("no plaintext secret column", !/um_secret\s+text/.test(creds.sql));
ok("key ids are unique across sites", /websites_um_key_id_idx on websites \(um_key_id\)/.test(creds.sql));
ok("enrollment codes are stored hashed", /code_hash\s+text not null unique/.test(creds.sql));
ok("enrollment codes expire", /expires_at\s+timestamptz not null/.test(creds.sql));
ok("enrollment codes are single-use", /redeemed_at/.test(creds.sql));
ok("codes die with their website", /website_id\s+uuid not null references websites\(id\) on delete cascade/.test(creds.sql));
ok("the license key is left alone", !/license_key\s*=/.test(creds.sql));

console.log("\n--- the reference schema stays in step ---");
const schema = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
for (const table of ["teams", "staff_users", "audit_log", "schema_migrations", "um_enrollment_codes"]) {
  ok(`db/schema.sql documents ${table}`, new RegExp(`\\b${table}\\b`).test(schema));
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
