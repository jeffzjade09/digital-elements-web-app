#!/usr/bin/env node
// Builds the helper-plugin zip that /api/plugin/download serves.
//
// Why this exists: the zip used to be hand-made and committed, so the version in
// the plugin header (which /api/plugin/manifest reports) could drift from the
// version actually inside the zip. When that happens WordPress offers the same
// update forever, because the installed version never reaches the advertised one.
// This script makes the header the single source of truth and fails loudly on any
// mismatch.
//
// It writes the archive with Node's built-in zlib rather than an npm package: one
// less dependency in the path that produces code installed on client sites, and
// the output is byte-reproducible (fixed timestamps), so the sha256 below is
// stable for identical input. That checksum is what the updater should verify
// before installing — see CRITICAL-2 in CODE_REVIEW.md.
//
// Usage: npm run build:plugin

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "wordpress-plugin", "digital-elements-helper");
const OUT_DIR = path.join(ROOT, "wordpress-plugin", "dist");
const OUT_ZIP = path.join(OUT_DIR, "digital-elements-helper.zip");
const MAIN_FILE = path.join(SRC_DIR, "digital-elements-helper.php");
const ZIP_PREFIX = "digital-elements-helper/"; // WordPress unzips to this folder

// Files that must never ship to a client site.
const EXCLUDE = [/(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /\.zip$/i, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/i];

// ---------------------------------------------------------------- zip writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// Fixed DOS timestamp (1980-01-01 00:00:00) keeps builds reproducible so the
// checksum only changes when file contents actually change.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // year 1980, month 1, day 1

function zipEntry(name, contents) {
  const nameBuf = Buffer.from(name, "utf8");
  const deflated = zlib.deflateRawSync(contents, { level: 9 });
  // Only use deflate if it actually helps; otherwise store.
  const useDeflate = deflated.length < contents.length;
  const data = useDeflate ? deflated : contents;
  return {
    nameBuf,
    data,
    method: useDeflate ? 8 : 0,
    crc: crc32(contents),
    uncompressedSize: contents.length,
    compressedSize: data.length,
  };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.compressedSize, 18);
    local.writeUInt32LE(e.uncompressedSize, 22);
    local.writeUInt16LE(e.nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra length
    chunks.push(local, e.nameBuf, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                 // version made by
    cd.writeUInt16LE(20, 6);                 // version needed
    cd.writeUInt16LE(0, 8);                  // flags
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compressedSize, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);                 // extra
    cd.writeUInt16LE(0, 32);                 // comment
    cd.writeUInt16LE(0, 34);                 // disk start
    cd.writeUInt16LE(0, 36);                 // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38);       // external attrs (unix perms)
    cd.writeUInt32LE(offset, 42);            // relative offset of local header
    central.push(cd, e.nameBuf);

    offset += local.length + e.nameBuf.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ------------------------------------------------------------------- helpers
function walk(dir, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

function fail(msg) {
  console.error(`\n[build-plugin] ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------- main
if (!fs.existsSync(MAIN_FILE)) fail(`Plugin main file not found: ${MAIN_FILE}`);
const mainSrc = fs.readFileSync(MAIN_FILE, "utf8");

const headerMatch = mainSrc.match(/^\s*\*\s*Version:\s*([0-9][\w.\-]*)/m);
if (!headerMatch) fail("Could not read the Version: header from the plugin main file.");
const version = headerMatch[1];

// The header is authoritative; DEHELED_VERSION must agree with it.
const constMatch = mainSrc.match(/define\(\s*'DEHELED_VERSION'\s*,\s*'([^']+)'\s*\)/);
if (!constMatch) fail("Could not find the DEHELED_VERSION constant.");
if (constMatch[1] !== version) {
  fail(`Version mismatch: header says ${version} but DEHELED_VERSION is ${constMatch[1]}.\n` +
       `             Update both in ${path.relative(ROOT, MAIN_FILE)} — the header is the source of truth.`);
}

const files = walk(SRC_DIR);
if (!files.length) fail("No files found to package.");

const entries = files.map(({ rel, full }) => zipEntry(ZIP_PREFIX + rel, fs.readFileSync(full)));
const zipBuf = buildZip(entries);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_ZIP, zipBuf);

const sha256 = crypto.createHash("sha256").update(zipBuf).digest("hex");
fs.writeFileSync(path.join(OUT_DIR, "digital-elements-helper.zip.sha256"), `${sha256}  digital-elements-helper.zip\n`);

console.log(`\n[build-plugin] digital-elements-helper ${version}`);
console.log(`[build-plugin] ${files.length} files, ${(zipBuf.length / 1024).toFixed(1)} KB`);
console.log(`[build-plugin] -> ${path.relative(ROOT, OUT_ZIP)}`);
console.log(`[build-plugin] sha256 ${sha256}\n`);
for (const f of files) console.log(`    ${f.rel}`);
console.log();
