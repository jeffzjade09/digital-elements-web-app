#!/usr/bin/env node
// Test runner. Deliberately dependency-free: each suite is a standalone script
// that prints PASS/FAIL lines and exits non-zero on failure, so `npm test` works
// on a bare checkout with no install step and is trivial to wire into CI.
//
// Add a suite by dropping a *.test.mjs or *.test.php file in this directory.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");

const suites = fs.readdirSync(DIR)
  .filter((f) => /\.test\.(mjs|php)$/.test(f))
  .sort();

if (!suites.length) {
  console.error("No test suites found in tests/");
  process.exit(1);
}

// PHP suites are skipped rather than failed when no php binary is on PATH, so a
// machine without PHP can still run the JavaScript side.
const hasPhp = spawnSync("php", ["-v"], { stdio: "ignore", shell: true }).status === 0;

let failed = 0;
let skipped = 0;

for (const suite of suites) {
  const isPhp = suite.endsWith(".php");
  console.log(`\n${"=".repeat(64)}\n  ${suite}\n${"=".repeat(64)}`);

  if (isPhp && !hasPhp) {
    console.log("SKIP  php not found on PATH");
    skipped++;
    continue;
  }

  const cmd = isPhp ? "php" : process.execPath;
  const args = [path.join(DIR, suite)];
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: isPhp });
  if (res.status !== 0) failed++;
}

console.log(`\n${"=".repeat(64)}`);
console.log(failed
  ? `FAILED — ${failed} of ${suites.length} suite(s) failed${skipped ? `, ${skipped} skipped` : ""}`
  : `OK — ${suites.length - skipped} suite(s) passed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
