// Exercises renderImageAudit() as it actually exists in index.html, including
// that hostile file names from a client site are escaped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf8");
const grab = (re) => { const m = html.match(re); if (!m) throw new Error("not found: " + re); return m[0]; };

const src = [
  grab(/^const esc = .*$/m),
  grab(/^const escJs = [\s\S]*?^\);$/m),
  grab(/^const fmtBytes = [\s\S]*?^};$/m),
  grab(/^function renderImageAudit\(r\) \{[\s\S]*?^\}$/m),
].join("\n");

const ctx = {};
vm.createContext(ctx);
new vm.Script(src + "\nglobalThis.out={esc,fmtBytes,renderImageAudit};").runInContext(ctx);
const { fmtBytes, renderImageAudit } = ctx.out;

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};

console.log("--- fmtBytes matches the PHP formatter ---");
ok("0 B", fmtBytes(0) === "0 B", fmtBytes(0));
ok("512 B", fmtBytes(512) === "512 B", fmtBytes(512));
ok("1.0 KB", fmtBytes(1024) === "1.0 KB", fmtBytes(1024));
ok("1.5 MB", fmtBytes(1572864) === "1.5 MB", fmtBytes(1572864));
ok("50 MB", fmtBytes(52428800) === "50 MB", fmtBytes(52428800));
ok("1.0 GB", fmtBytes(1073741824) === "1.0 GB", fmtBytes(1073741824));

console.log("\n--- renderImageAudit ---");
ok("no images key -> empty string", renderImageAudit({ layers: [] }) === "");
ok("null-safe", renderImageAudit(null) === "");

const full = {
  cached: false,
  images: {
    scanned: 1284, candidates: 1284, partial: false, capped: false, timed_out: false,
    total_bytes: 2254857830, est_total_bytes: 61847529, missing_files: 0,
    oversized: { count: 37, est_bytes: 43000000, threshold_px: 2560, samples: [
      { file: "hero-banner.jpg", width: 5120, height: 2880, bytes: 3565158, est_saved: 2673868 },
      { file: "about-team.jpg", width: 4000, height: 2250, bytes: 1887436, est_saved: 1114000 },
    ] },
    large: { count: 9, threshold_bytes: 512000, samples: [
      { file: "hero-banner.jpg", bytes: 3565158 },
    ] },
    missing_webp: { count: 112, est_bytes: 18800000, samples: [] },
    duration_ms: 4210,
  },
};
const out = renderImageAudit(full);
ok("reports estimated recoverable", out.includes("Estimated recoverable"));
ok("formats the estimate", out.includes("59.0 MB") || out.includes("59 MB"), out.match(/Estimated[^<]*/)?.[0]);
ok("lists oversized samples", out.includes("hero-banner.jpg"));
ok("shows dimensions", out.includes("5120") && out.includes("2880"));
ok("shows per-file recoverable", out.includes("recoverable"));
ok("always states read-only", out.includes("Read-only audit"));
ok("states estimates are not measured", out.includes("not measured re-encodes"));
ok("no partial warning when complete", !out.includes("Partial scan"));
ok("no cached note when fresh", !out.includes("Cached result"));

console.log("\n--- partial scans must never read as complete ---");
const capped = renderImageAudit({ images: { ...full.images, partial: true, capped: true, timed_out: false, scanned: 5000, candidates: 9143 } });
ok("capped: warns", capped.includes("Partial scan"));
ok("capped: names the cap", capped.includes("5,000 image cap"), capped.match(/Partial[^<]*/)?.[0]);
ok("capped: shows both counts", capped.includes("5000") && capped.includes("9143"));
const timedOut = renderImageAudit({ images: { ...full.images, partial: true, capped: false, timed_out: true } });
ok("timed out: names the budget", timedOut.includes("12s time budget"), timedOut.match(/Partial[^<]*/)?.[0]);

console.log("\n--- cached result is disclosed ---");
ok("cached note shown", renderImageAudit({ ...full, cached: true }).includes("Cached result"));

console.log("\n--- file names from the client site are escaped ---");
const hostile = renderImageAudit({ images: { ...full.images, oversized: { count: 1, est_bytes: 10, threshold_px: 2560,
  samples: [{ file: `<img src=x onerror=alert(1)>'"&.jpg`, width: 3000, height: 2000, bytes: 999, est_saved: 500 }] } } });
ok("no raw < from file name", !hostile.includes("<img src=x"), hostile.match(/opt-sub[^<]*<?[^<]*/)?.[0]);
ok("escaped as &lt;", hostile.includes("&lt;img src=x"));
ok("quote escaped", hostile.includes("&#39;") || hostile.includes("&quot;"));
ok("ampersand escaped", hostile.includes("&amp;"));

console.log("\n--- zero / empty states ---");
const clean = renderImageAudit({ images: {
  scanned: 12, candidates: 12, partial: false, capped: false, timed_out: false,
  total_bytes: 500000, est_total_bytes: 0, missing_files: 0,
  oversized: { count: 0, est_bytes: 0, threshold_px: 2560, samples: [] },
  large: { count: 0, threshold_bytes: 512000, samples: [] },
  missing_webp: { count: 0, est_bytes: 0, samples: [] }, duration_ms: 40,
} });
ok("clean library: no estimate line", !clean.includes("Estimated recoverable"));
ok("clean library: no sample headings", !clean.includes("Largest oversized"));
ok("clean library: still states read-only", clean.includes("Read-only audit"));

console.log("\n" + (fail ? `FAILED: ${fail}` : "OK: all checks passed"));
process.exit(fail ? 1 : 0);
