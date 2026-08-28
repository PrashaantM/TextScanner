// score-manual.js: scores hand-collected OCR output against test/groundtruth/,
// for engines this repo can't drive automatically (e.g. native ML Kit on a
// physical iPhone - no headless harness for that, see run-benchmark.js's
// header for the automated Tesseract/Playwright equivalent).
//
// Usage:
//   1. For each image you want scored, create test/manual-output/<name>.txt
//      containing the Raw-view text the app produced for that image.
//   2. node test/score-manual.js
//
// Only images with both a groundtruth file and a manual-output file are
// scored; everything else is listed as missing so it's obvious what's left.

import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { characterErrorRate, wordErrorRate } from "./metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GROUNDTRUTH_DIR = join(ROOT, "test/groundtruth");
const MANUAL_DIR = join(ROOT, "test/manual-output");

async function readTextFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return new Map();
  }
  const files = new Map();
  for (const entry of entries.filter((f) => f.endsWith(".txt"))) {
    files.set(basename(entry, ".txt"), join(dir, entry));
  }
  return files;
}

async function main() {
  const groundTruth = await readTextFiles(GROUNDTRUTH_DIR);
  const manualOutput = await readTextFiles(MANUAL_DIR);

  if (manualOutput.size === 0) {
    console.log(`No manual output found in ${MANUAL_DIR}.`);
    console.log("Create one .txt file per image (named after the image, e.g. complexPic5.txt) and re-run.");
    return;
  }

  const names = [...groundTruth.keys()].sort();
  const rows = [];
  const missing = [];

  for (const name of names) {
    if (!manualOutput.has(name)) {
      missing.push(name);
      continue;
    }
    const reference = await readFile(groundTruth.get(name), "utf8");
    const hypothesis = await readFile(manualOutput.get(name), "utf8");
    rows.push({
      name,
      cer: characterErrorRate(hypothesis, reference),
      wer: wordErrorRate(hypothesis, reference),
    });
  }

  console.log("\nimage           CER      WER");
  console.log("--------------------------------");
  for (const r of rows) {
    console.log(`${r.name.padEnd(15)} ${(r.cer * 100).toFixed(1).padStart(5)}%   ${(r.wer * 100).toFixed(1).padStart(5)}%`);
  }
  if (rows.length) {
    const avgCer = rows.reduce((sum, r) => sum + r.cer, 0) / rows.length;
    const avgWer = rows.reduce((sum, r) => sum + r.wer, 0) / rows.length;
    console.log("--------------------------------");
    console.log(`${"average".padEnd(15)} ${(avgCer * 100).toFixed(1).padStart(5)}%   ${(avgWer * 100).toFixed(1).padStart(5)}%`);
  }
  console.log();

  if (missing.length) {
    console.log(`Missing manual output for: ${missing.join(", ")}`);
    console.log(`Add test/manual-output/<name>.txt for each to include it.\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
