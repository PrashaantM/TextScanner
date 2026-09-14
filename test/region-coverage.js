// region-coverage.js: scores complexPic1 one text area at a time, instead of
// averaging the whole poster into a single number.
//
// WHY AN AVERAGE WAS NOT ENOUGH. test/run-benchmark.js already scores this image
// against test/groundtruth/complexPic1.txt, and it was green at a 2-point
// tolerance the whole time the poster was losing its pink headline AND its
// entire middle band - "POPCICHAWK", "POPSICLES", "RELAXING ON A SUNNY DAY",
// "JULY 31ST" and "5-7PM", none of them recognized at all. The lines that WERE
// read scored well enough to carry the mean, so a hole big enough to swallow
// half the poster never moved the number past its tolerance. An average is the
// wrong instrument for "a whole area went missing": it is exactly the shape of
// failure an average cannot see.
//
// So this cuts the same ground truth into areas that fail independently - by
// what they sit on, which is what actually varies: cream, a yellow swash, a
// solid teal panel, a solid pink panel - and scores each on its own. See
// test/groundtruth/complexPic1.regions.json for the boxes and the reasoning.
//
// WHAT THE CEILINGS MEAN. `maxCer` per region is a measured ceiling on the
// current build, not an accuracy target. Two things make it go red:
//
//   1. A region gets WORSE than it is today. That is the regression this file
//      exists to catch, and it is the whole reason for cutting the image up.
//   2. A region gets BETTER and nobody updates the ceiling. Reported with the
//      number to paste in. A ceiling left far above what the code actually does
//      stops constraining it, which is how a gate quietly becomes decoration -
//      the same failure this repo already found in render-fidelity.js.
//
// Two regions are pinned at 1.0 (`popsicles`, `date-panel`): still not
// recognized at all. That is recorded rather than hidden, in the same spirit as
// test/non-latin-limitation.js - a known gap with a number on it beats a gap
// nobody has measured. They go red the moment they start working, which is the
// point.
//
// Usage: node test/region-coverage.js
//        node test/region-coverage.js --report   (print measurements, never fail)

import { launchBrowser } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8135;
const REPORT_ONLY = process.argv.includes("--report");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".wasm": "application/wasm", ".traineddata": "application/octet-stream", ".gz": "application/gzip", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(ROOT, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
}).listen(PORT);

// Slack above the recorded ceiling before a region is called a regression.
// Recognition on this path is deterministic run to run (test/TUNING-2.md §1
// measured 0.00pts across two bit-identical runs), so this is not a noise
// allowance - it is room for an unrelated change to shift one region slightly
// without failing a build for something nobody would notice.
const CER_SLACK = 0.05;
// How far BELOW its ceiling a region has to fall before the ceiling is called
// stale and worth re-pinning. Wider than the slack above, so a build cannot
// both pass and demand an edit for the same measurement.
const STALE_CEILING_MARGIN = 0.12;

const spec = JSON.parse(await readFile(join(ROOT, "test/groundtruth/complexPic1.regions.json"), "utf8"));

const failures = [];
const improvements = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);
await page.setInputFiles("#file-input", join(ROOT, "test/images/" + spec.image));
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });

const measured = await page.evaluate(async (spec) => {
  const { state } = await import("/js/state.js");
  const W = state.lastNaturalWidth;
  const H = state.lastNaturalHeight;
  // A word belongs to the region its CENTRE falls in, so boxes drawn generously
  // enough to contain a swash or a panel cannot annex a neighbour's words.
  const assigned = spec.regions.map((r) => ({ id: r.id, words: [] }));
  const unassigned = [];
  for (const w of state.ocrWords) {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2 / W;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2 / H;
    const hit = spec.regions.findIndex((r) => cx >= r.box[0] && cx <= r.box[2] && cy >= r.box[1] && cy <= r.box[3]);
    // Vertical CENTRE, not the box top. "&" sits on the same line as "CHAWK" and
    // "DRAWINGS" but is a shorter glyph, so its box starts 35px lower and top-edge
    // grouping split it onto a line of its own - which then sorted after them and
    // scored "& CHAWK DRAWINGS" as 25% wrong for a reason that had nothing to do
    // with recognition.
    if (hit >= 0) assigned[hit].words.push({ text: w.text, x: w.bbox.x0, y: (w.bbox.y0 + w.bbox.y1) / 2 });
    else unassigned.push({ text: w.text, xPct: +(cx * 100).toFixed(1), yPct: +(cy * 100).toFixed(1) });
  }
  return {
    naturalWidth: W,
    naturalHeight: H,
    // Reading order within a region: group into lines by vertical position, then
    // left to right within each line, matching how the ground-truth line reads.
    //
    // Done as an explicit grouping pass rather than one clever comparator. The
    // obvious `Math.abs(p.y - q.y) > tol ? p.y - q.y : p.x - q.x` is not a valid
    // total order - it is not transitive, so Array.sort is free to return
    // anything, and it did: "& CHAWK DRAWINGS" came back as "DRAWINGS CHAWK &",
    // which then scored as a recognition failure rather than a sorting one.
    regions: assigned.map((a) => {
      // Generous enough to hold a line whose glyphs differ in height, tight
      // enough not to merge the footer's two lines (their centres are 4% apart).
      const lineTolerance = H * 0.025;
      const lines = [];
      for (const w of [...a.words].sort((p, q) => p.y - q.y)) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(w.y - line.y) <= lineTolerance) line.words.push(w);
        else lines.push({ y: w.y, words: [w] });
      }
      return {
        id: a.id,
        text: lines
          .map((l) => l.words.sort((p, q) => p.x - q.x).map((w) => w.text).join(" "))
          .join(" "),
      };
    }),
    unassigned,
    totalWords: state.ocrWords.length,
  };
}, spec);

if (measured.naturalWidth !== spec.naturalWidth || measured.naturalHeight !== spec.naturalHeight) {
  failures.push(
    `${spec.image} decoded at ${measured.naturalWidth}x${measured.naturalHeight}, but the region boxes were measured against ` +
      `${spec.naturalWidth}x${spec.naturalHeight} - every box below is in the wrong place, so nothing here means anything`
  );
}

console.log(`${spec.image}: ${measured.totalWords} words recognized\n`);
console.log(`${"region".padEnd(18)}${"CER".padStart(7)}${"ceiling".padStart(9)}   recognized`);
console.log("-".repeat(96));

for (const region of spec.regions) {
  const got = measured.regions.find((r) => r.id === region.id)?.text ?? "";
  const cer = characterErrorRate(got, region.text);
  const over = cer > region.maxCer + CER_SLACK;
  const stale = cer < region.maxCer - STALE_CEILING_MARGIN;
  const flag = over ? "  FAIL" : stale ? "  improved" : "";
  console.log(
    `${region.id.padEnd(18)}${(cer * 100).toFixed(1).padStart(6)}%${(region.maxCer * 100).toFixed(0).padStart(8)}%   ${JSON.stringify(got).slice(0, 52)}${flag}`
  );

  if (over) {
    failures.push(
      `${region.id} ("${region.text}", ${region.appearance}): CER ${(cer * 100).toFixed(1)}% is worse than the ` +
        `${(region.maxCer * 100).toFixed(0)}% recorded for this area. Recognized: ${JSON.stringify(got)}`
    );
  } else if (stale) {
    improvements.push(`${region.id}: ${(cer * 100).toFixed(1)}% (ceiling says ${(region.maxCer * 100).toFixed(0)}%) - set "maxCer": ${cer.toFixed(2)}`);
  }
}

if (measured.unassigned.length) {
  console.log(`\n${measured.unassigned.length} recognized word(s) fell outside every region box:`);
  for (const u of measured.unassigned.slice(0, 12)) console.log(`  ${JSON.stringify(u.text)} at ${u.xPct}%, ${u.yPct}%`);
}

if (improvements.length) {
  console.log("\nRegions that got BETTER than their recorded ceiling:");
  for (const i of improvements) console.log("  -", i);
  console.log("\nUpdate test/groundtruth/complexPic1.regions.json so the ceiling keeps constraining the code.");
  if (!REPORT_ONLY) {
    failures.push(
      `${improvements.length} region(s) improved past their recorded ceiling - re-pin them (see above). ` +
        `A ceiling nobody updates stops meaning anything, which is the failure mode this file was written to avoid.`
    );
  }
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (REPORT_ONLY) {
  console.log("\n--report: measurements only, nothing asserted.");
  process.exit(0);
}
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nEvery text area of complexPic1 is recognized at least as well as when it was last measured.");
