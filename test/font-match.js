// font-match.js: does js/fontMatch.js actually recover the font a word was set
// in, or does it just produce a confident-looking answer?
//
// WHY THIS EXISTS. The app used to render every recognized word at weight 400,
// upright, in one of three families, whatever the photograph showed - and
// editorObjects.js carried a long comment explaining that bold/regular
// detection had been tried, measured, and abandoned because the signal it used
// (ink fraction) could not separate the two. That conclusion was right about
// that signal. fontMatch.js uses a different one, and a claim like "this is
// better" is worth nothing without a number attached, so this file produces the
// number.
//
// HOW. Ground truth is generated rather than annotated: the page draws words in
// a font it CHOSE, hands the pixels to the real matcher, and compares what came
// back against what it drew. Nothing here is hand-labelled, so the corpus can
// be widened by editing a list rather than by re-annotating anything.
//
// The thresholds below are floors, not targets - they sit under the measured
// figures with enough room that ordinary rasteriser drift cannot trip them, and
// far enough above the pre-existing behaviour that a regression to it fails.
// "Weight recovered" in particular has a hard floor to beat: rendering every
// word at 400 (what shipped before) scores 50% on a corpus half of which is
// bold, so anything at or under that has bought nothing.
//
// Usage: node test/font-match.js   (exits non-zero if anything regressed)

import { launchBrowser, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Floors. See the header for why weight's is expressed against 50%.
const MIN_WEIGHT_ACCURACY = 0.9;
const MIN_FAMILY_ACCURACY = 0.8;
// Lower than the others on purpose, and not because monospace is harder to
// see: detectMonospaceWord will not fire under 12 glyph components, so every
// short word in the corpus is a miss BY DESIGN. The floor records the trade
// rather than pretending it away - if it ever rises, that is the calibration
// changing, which is a decision to make deliberately.
const MIN_MONO_RECALL = 0.3;
const MIN_ITALIC_RECALL = 0.6;
const MAX_ITALIC_FALSE_POSITIVE = 0.02;

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
const PORT = await listenOnEphemeralPort(server);

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}${detail ? ` - ${detail}` : ""}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
};

const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(`http://localhost:${PORT}/index.html`);

const result = await page.evaluate(async () => {
  const { __testing } = await import("/js/fontMatch.js");
  // classifyWordFont, not matchWordFont: the composition is the thing under
  // test. In the app the monospace verdict comes from editorObjects.js's own
  // glyph-width detector and is handed to the matcher as a constraint, so a
  // test that called the matcher directly would be asking it to decide an axis
  // it is deliberately not responsible for - and would score every monospace
  // word wrong for doing exactly what it was designed to do.
  const { classifyWordFont } = await import("/js/editorObjects.js");

  // The families are the GENERIC keywords, not the app's own stacks, and that
  // is deliberate: a headless browser resolves "Helvetica" or "SF Mono" to
  // whatever it happens to have, so naming real faces would test the test
  // machine's font collection. serif/sans-serif/monospace are the three the
  // platform is required to provide and to give a real bold for.
  const FAMILIES = { regular: "sans-serif", serif: "serif", monospace: "monospace" };
  const WORDS = [
    "POPCICHAWK", "DRAWINGS", "RESIDENT", "SUNNY", "carefully", "nobody",
    "Building", "Company", "Hamburgefonstiv", "LOWER", "reads", "31ST",
    "Specifications", "Rechargeable", "included", "Warranty",
  ];
  const WEIGHTS = [400, 700];
  const SIZES = [26, 48, 84];

  const canvas = document.createElement("canvas");
  canvas.width = 1800;
  canvas.height = 320;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Draws one word and hands its pixels to the matcher exactly the way
  // renderImageFormatView does - a full-image ImageData plus a bounding box,
  // not a pre-cropped bitmap - so the path under test is the shipped one.
  function recover(text, familyKey, weight, style, px) {
    ctx.fillStyle = "#f7f3ea";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = "alphabetic";
    ctx.font = `${style} ${weight} ${px}px ${FAMILIES[familyKey]}`;
    ctx.fillStyle = "#14161c";
    const originX = 40;
    const originY = 240;
    const m = ctx.measureText(text);
    ctx.fillText(text, originX, originY);
    const x0 = Math.floor(originX - m.actualBoundingBoxLeft);
    const x1 = Math.ceil(originX + m.actualBoundingBoxRight);
    const y0 = Math.floor(originY - m.actualBoundingBoxAscent);
    const y1 = Math.ceil(originY + m.actualBoundingBoxDescent);
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // scanIsCondensed false: the condensed axis is a scan-wide decision made
    // from many words at once (detectCondensedSource), which a single-word
    // corpus cannot pose a question about either way.
    return classifyWordFont(pixels, canvas.width, canvas.height, { x0, y0, x1, y1 }, false, text);
  }

  // Confirms the platform actually HAS a distinct bold for a family before
  // scoring weight recovery against it. Without this the suite silently grades
  // the matcher on a face where 400 and 700 rasterise identically, which no
  // measurement can separate and which would be the test's fault, not the
  // matcher's.
  function hasRealBold(familyKey) {
    ctx.font = `400 100px ${FAMILIES[familyKey]}`;
    const light = ctx.measureText("Hamburgefonstiv").width;
    ctx.font = `700 100px ${FAMILIES[familyKey]}`;
    return Math.abs(ctx.measureText("Hamburgefonstiv").width - light) > 0.5;
  }

  const boldCapable = Object.keys(FAMILIES).filter(hasRealBold);

  let weightTotal = 0, weightOK = 0;
  let familyTotal = 0, familyOK = 0;
  let monoTotal = 0, monoOK = 0;
  let italicTotal = 0, italicOK = 0;
  let uprightTotal = 0, uprightFalse = 0;
  const confusion = {};

  for (const familyKey of Object.keys(FAMILIES)) {
    for (const weight of WEIGHTS) {
      for (const px of SIZES) {
        for (const text of WORDS) {
          for (const style of ["normal", "italic"]) {
            const got = recover(text, familyKey, weight, style, px);
            if (!got) continue;

            if (style === "italic") {
              italicTotal++;
              if (got.fontItalic) italicOK++;
            } else {
              uprightTotal++;
              if (got.fontItalic) uprightFalse++;
            }

            // Family and weight are scored on upright words only. An italic
            // face is a different drawing of the letters - different set width,
            // different terminals - and grading the family match against the
            // upright probes it is compared with would be measuring the slant,
            // not the family.
            if (style !== "normal") continue;

            // Monospace is scored on its own, against its own floor. Its
            // detector requires 12 surviving glyph components before it will
            // fire at all - a deliberate, separately-calibrated trade that
            // trades recall on short words for not mislabelling ordinary prose
            // (see detectMonospaceWord in editorObjects.js). Pooling it with
            // the proportional families would hide that trade inside one
            // average instead of stating it.
            if (familyKey === "monospace") {
              monoTotal++;
              if (got.fontClass === "monospace") monoOK++;
            } else {
              familyTotal++;
              if (got.fontClass === familyKey) familyOK++;
            }
            const key = `${familyKey}/${weight} -> ${got.fontClass}/${got.fontWeight}`;
            confusion[key] = (confusion[key] || 0) + 1;

            if (boldCapable.includes(familyKey)) {
              weightTotal++;
              // Graded as "on the right side of the middle", not as an exact
              // hundred. The matcher interpolates a continuous weight and the
              // corpus only has two real ones to compare against, so demanding
              // exactly 700 back from a 700 would be scoring precision the
              // ground truth does not carry.
              const heavy = got.fontWeight >= 550;
              if (heavy === (weight >= 550)) weightOK++;
            }
          }
        }
      }
    }
  }

  // The matcher must DECLINE on text too small to read rather than inventing a
  // verdict - the guarantee that makes a bad match impossible on the one class
  // of word where a guess would be pure noise.
  const tiny = recover("tiny", "regular", 400, "normal", 9);

  // THE PROBE STACKS AND THE PAINTED STACKS ARE THE SAME STACKS.
  //
  // fontMatch.js decides a word is serif by measuring it against a render of
  // FONT_CANDIDATES.serif; editorObjects.js then paints that word through
  // wordFontFamily("serif"), which reads the live resolution of
  // `.image-format-word.is-font-serif` out of style.css. Those are two separate
  // declarations of the same intent, in two different files and two different
  // languages, and nothing but this check couples them. If they drift, the
  // matcher optimises for a face nobody ever sees - and there is no symptom: the
  // words still render, still fit, still look plausible, just matched against
  // the wrong reference.
  //
  // Compared by RENDERED WIDTH rather than by string equality, because the two
  // are not the same string even when they name the same font: one is authored
  // CSS, the other is getComputedStyle's normalisation of it. Identical widths
  // for a pangram-ish string at 100px mean the same face won both lookups.
  const { wordFontFamily } = await import("/js/editorObjects.js");
  const { FONT_CANDIDATES } = await import("/js/fontMatch.js");
  const stackDrift = [];
  for (const cls of ["regular", "serif", "monospace"]) {
    ctx.font = `400 100px ${FONT_CANDIDATES[cls]}`;
    const probed = ctx.measureText("Hamburgefonstiv 0123").width;
    ctx.font = `400 100px ${wordFontFamily(cls)}`;
    const painted = ctx.measureText("Hamburgefonstiv 0123").width;
    if (Math.abs(probed - painted) > 0.01) stackDrift.push(`${cls}: probe ${probed.toFixed(1)}px vs painted ${painted.toFixed(1)}px`);
  }

  return {
    boldCapable,
    weight: { total: weightTotal, ok: weightOK },
    family: { total: familyTotal, ok: familyOK },
    mono: { total: monoTotal, ok: monoOK },
    italicRecall: { total: italicTotal, ok: italicOK },
    italicFalse: { total: uprightTotal, bad: uprightFalse },
    tinyDeclined: tiny === null || tiny.fontWeight === 400,
    stackDrift,
    confusion,
    constants: {
      italicMinDeg: __testing.ITALIC_MIN_DEG,
      italicMinGain: __testing.ITALIC_MIN_GAIN,
      italicMinComponents: __testing.ITALIC_MIN_COMPONENTS,
      italicMinChars: __testing.ITALIC_MIN_CHARS,
    },
  };
});

const pct = (n, d) => (d ? n / d : 0);
const show = (n, d) => `${n}/${d} = ${(100 * pct(n, d)).toFixed(1)}%`;

console.log(`\nfont matching, against synthetic ground truth`);
console.log(`  families with a real bold on this platform: ${result.boldCapable.join(", ") || "(none)"}`);
console.log(`  italic rule: >=${result.constants.italicMinDeg} deg, gain >=${result.constants.italicMinGain}, >=${result.constants.italicMinComponents} components, >=${result.constants.italicMinChars} chars\n`);

check(
  "weight is recovered, and beats rendering everything at 400",
  pct(result.weight.ok, result.weight.total) >= MIN_WEIGHT_ACCURACY,
  `${show(result.weight.ok, result.weight.total)} (floor ${100 * MIN_WEIGHT_ACCURACY}%; all-400 would score 50%)`
);
check(
  "family is recovered (sans vs serif)",
  pct(result.family.ok, result.family.total) >= MIN_FAMILY_ACCURACY,
  `${show(result.family.ok, result.family.total)} (floor ${100 * MIN_FAMILY_ACCURACY}%)`
);
check(
  "monospace is recovered where its detector can fire",
  pct(result.mono.ok, result.mono.total) >= MIN_MONO_RECALL,
  `${show(result.mono.ok, result.mono.total)} (floor ${100 * MIN_MONO_RECALL}%; short words are a known, deliberate miss)`
);
check(
  "italic is detected when it is there",
  pct(result.italicRecall.ok, result.italicRecall.total) >= MIN_ITALIC_RECALL,
  `${show(result.italicRecall.ok, result.italicRecall.total)} (floor ${100 * MIN_ITALIC_RECALL}%)`
);
check(
  "upright words are not set in italics",
  pct(result.italicFalse.bad, result.italicFalse.total) <= MAX_ITALIC_FALSE_POSITIVE,
  `${show(result.italicFalse.bad, result.italicFalse.total)} false (ceiling ${100 * MAX_ITALIC_FALSE_POSITIVE}%)`
);
check("text too small to measure gets the neutral default, not a guess", result.tinyDeclined);
check(
  "every face the matcher probes is the face the app actually paints",
  result.stackDrift.length === 0,
  result.stackDrift.join("; ") || "js/fontMatch.js's FONT_CANDIDATES and style.css agree"
);
check("no page errors", pageErrors.length === 0, pageErrors.join("; "));

console.log("\n  confusion (true -> matched), most common first:");
for (const [k, v] of Object.entries(result.confusion).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${k}: ${v}`);
}

await browser.close();
server.close();

if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log("\nfont-match: all checks passed");
