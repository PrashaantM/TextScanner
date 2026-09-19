// score-paddle.mjs: scores PP-OCRv6 (via ppu-paddle-ocr + ONNX Runtime) on the
// SAME eleven corpus images and the SAME test/metrics.js used by
// test/run-benchmark.js, so the numbers are comparable rather than adjacent.
//
//   node score-paddle.mjs [--engine canvas|opencv] [--model tiny|small]
//
// Models are read from ./vendor-candidate/paddle/models (downloaded once), not
// from the package's HuggingFace default, so a run makes no network request and
// the offline story is the one that would actually ship.

import { readFile, readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
// The repo's OWN metric code, imported by absolute path rather than copied, so
// a CER printed here is computed by the identical function run-benchmark.js uses.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const { characterErrorRate, wordErrorRate, referenceLengths } = await import(new URL("../../metrics.js", import.meta.url).href);
const { PARTIAL_GROUND_TRUTH } = await import(new URL("../../partialGroundTruth.js", import.meta.url).href);

const REPO = REPO_ROOT;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const MODELS = join(REPO_ROOT, "vendor-candidate", "paddle", "models");
const IMAGE_DIR = join(REPO, "test/images");
const GT_DIR = join(REPO, "test/groundtruth");

const engineArg = process.argv.indexOf("--engine");
const ENGINE = engineArg !== -1 ? process.argv[engineArg + 1] : "canvas";

const { PaddleOcrService } = await import("ppu-paddle-ocr");

const model = {
  detection: join(MODELS, "PP-OCRv6_tiny_det.ort"),
  recognition: join(MODELS, "PP-OCRv6_tiny_rec.ort"),
  charactersDictionary: join(MODELS, "ppocrv6_tiny_dict.txt"),
};

console.log(`engine: ${ENGINE}   model: PP-OCRv6 tiny (local files)\n`);

const coldStart = Date.now();
const service = new PaddleOcrService({ model, processing: { engine: ENGINE } });
await service.initialize();
const coldStartMs = Date.now() - coldStart;
console.log(`cold start (model load + session init): ${coldStartMs}ms\n`);

const files = (await readdir(IMAGE_DIR))
  .filter((f) => /^complexPic\d+\.jpe?g$/i.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

const rows = [];
console.log("image           CER      WER      time");
console.log("------------------------------------------");
for (const f of files) {
  const name = basename(f, extname(f));
  const reference = await readFile(join(GT_DIR, `${name}.txt`), "utf8");
  const started = Date.now();
  let text = "";
  let error = null;
  try {
    const result = await service.recognize(join(IMAGE_DIR, f), { flatten: true });
    text = (result.text || (result.lines || []).map((l) => l.text).join("\n") || "").trim();
  } catch (err) {
    error = String(err.message || err).split("\n")[0];
  }
  const elapsedMs = Date.now() - started;
  if (error) {
    console.log(`${name.padEnd(15)} ERROR: ${error}`);
    rows.push({ name, error });
    continue;
  }
  const { chars: refChars, words: refWords } = referenceLengths(reference);
  const cer = characterErrorRate(text, reference);
  const wer = wordErrorRate(text, reference);
  rows.push({ name, cer, wer, refChars, refWords, elapsedMs, chars: text.length });
  const tag = PARTIAL_GROUND_TRUTH.has(name) ? " *" : "";
  console.log(
    `${(name + tag).padEnd(15)} ${(cer * 100).toFixed(1).padStart(5)}%   ${(wer * 100).toFixed(1).padStart(5)}%   ${(elapsedMs / 1000).toFixed(1)}s`
  );
}

await service.destroy();

const scored = rows.filter((r) => !r.error);
const complete = scored.filter((r) => !PARTIAL_GROUND_TRUTH.has(r.name));
const partial = scored.filter((r) => PARTIAL_GROUND_TRUTH.has(r.name));
const mean = (xs, k) => (xs.length ? xs.reduce((s, r) => s + r[k], 0) / xs.length : NaN);
const pooled = (xs, k, l) => xs.reduce((s, r) => s + r[k] * r[l], 0) / xs.reduce((s, r) => s + r[l], 0);

console.log("------------------------------------------");
console.log(`complete-GT (${complete.length})  ${(mean(complete, "cer") * 100).toFixed(1).padStart(5)}%   ${(mean(complete, "wer") * 100).toFixed(1).padStart(5)}%`);
console.log(`partial-GT (${partial.length}) *  ${(mean(partial, "cer") * 100).toFixed(1).padStart(5)}%   ${(mean(partial, "wer") * 100).toFixed(1).padStart(5)}%`);
console.log(`pooled (${complete.length})       ${(pooled(complete, "cer", "refChars") * 100).toFixed(1).padStart(5)}%   ${(pooled(complete, "wer", "refWords") * 100).toFixed(1).padStart(5)}%`);
console.log("------------------------------------------");
console.log(`Tesseract.js baseline, same 8 images:  macro 41.6% CER / 57.1% WER,  pooled 62.2% / 76.3%`);
console.log(`total recognition time: ${(scored.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s for ${scored.length} images`);

const { writeFile } = await import("node:fs/promises");
await writeFile(join(HERE, `paddle-${ENGINE}-raw.json`), JSON.stringify({ engine: ENGINE, coldStartMs, rows }, null, 2));
console.log(`\nraw: paddle-${ENGINE}-raw.json`);
