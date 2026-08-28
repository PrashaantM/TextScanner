// ocrEngine.js: runs Tesseract.js and normalizes its result into the flat
// { lineIndex, text, confidence, bbox } word list the rest of the app works with.
// Uses the createWorker API (rather than the one-shot Tesseract.recognize()
// convenience call) because that's the only way to control page segmentation mode.
//
// Testing against real-world images (screenshots, designed flyers, UI mockups)
// showed that Phase 1's contrast-normalization preprocessing (preprocess.js) is a
// clear win on genuinely uneven-lit/low-contrast photos, but a clear LOSS on
// already-clean images (flat screenshots, evenly-lit graphics) - it has nothing to
// correct there and only adds blur/amplification artifacts. So rather than always
// trust preprocessing, this module runs the raw image first, only tries the
// preprocessed version when the raw pass leaves real room for improvement, and
// keeps whichever candidate actually scored higher. That guarantees preprocessing
// can only help, never hurt, at the cost of a second pass on harder images.
//
// A later pass adds region-based reprocessing: a whole-image recognition pass
// treats a poster's title, body copy, and fine print identically, which is
// exactly where posters/multi-font images/cluttered photos lose to a
// screenshot of clean text. So after the whole-image pass, each recognized
// text block (Tesseract's own layout analysis, requested via `blocks: true`
// but previously left unread) that scored poorly is individually re-cropped,
// re-preprocessed with settings tuned to that crop alone (see
// preprocess.js's preprocessRegion), optionally keystone-corrected (see
// perspective.js), and re-recognized at a PSM suited to a single block/line
// rather than a whole page. Same "can only help" rule applies: a region's
// reprocessed result replaces its original words only if it scores higher.
//
// Deskewing is delegated to Tesseract's own `rotateAuto` option (Leptonica-backed,
// well tested) rather than a hand-rolled estimate. Tesseract reports the angle it
// corrected for as data.rotateRadians, which this module inverts to map returned
// word boxes back onto the original, on-screen image.

import { preprocessImage, preprocessRegion } from "./preprocess.js";
import { detectKeystoneQuad, warpPerspective } from "./perspective.js";

// Tesseract.js's PSM constants (see naptha/tesseract.js src/constants/PSM.js) are
// exposed as Tesseract.PSM at runtime; this mirrors that file in case a future CDN
// build ever omits the export, so a missing global degrades gracefully instead of
// throwing before OCR can even start.
const FALLBACK_PSM = { AUTO: "3", SPARSE_TEXT: "11", SINGLE_BLOCK: "6", SINGLE_LINE: "7" };

// Below this mean confidence, the raw pass is considered to have real room for
// improvement, and preprocessing is worth trying as a second candidate.
const PREPROCESS_WORTH_TRYING_THRESHOLD = 70;
// Below this mean confidence (or with zero words), the best candidate so far is
// still bad enough to justify a bounded PSM.SPARSE_TEXT retry - well suited to
// scattered text on busy backgrounds (signs, flyers) where AUTO's block-based
// segmentation struggles.
const RETRY_MEAN_CONFIDENCE_THRESHOLD = 40;
// Above this overall mean confidence, the whole-image result is already clean
// enough (a typical flat screenshot) that per-region reprocessing wouldn't find
// anything worth fixing - skipped entirely so simple images stay fast.
const SKIP_REGION_PASS_OVERALL_THRESHOLD = 85;
// A region below this confidence is worth the extra crop/preprocess/recognize
// cost; a region above it (e.g. a poster's title, already crisp) is left alone.
const REGION_REPROCESS_THRESHOLD = 70;
// Caps how many of a page's weakest regions get the expensive per-region
// treatment, so a highly fragmented layout can't blow up recognition time.
const MAX_REGIONS = 16;
// How far past a region's tight bbox to crop, so re-recognition has real
// surrounding context (ascenders/descenders, adjoining punctuation) rather than
// a bbox trimmed exactly to Tesseract's own (imperfect) block boundary.
const REGION_CROP_MARGIN = 6;
// A region reads as "one line" rather than "one block of several lines" when
// it's this many times wider than it is tall - selects PSM.SINGLE_LINE instead
// of PSM.SINGLE_BLOCK, which Tesseract does noticeably better with.
const SINGLE_LINE_ASPECT_RATIO = 6;
// A reprocessed region has to recover at least this fraction of the original
// pass's word count to be trusted - guards against a mis-segmented multi-column
// region (several real columns Tesseract grouped into one block) collapsing
// into fewer, confidently-wrong merged words when forced through a
// single-block re-recognition.
const MIN_REGION_WORD_COUNT_RATIO = 0.5;
// A zero-word region larger than this fraction of the whole image is treated
// as an unreliable "layout analysis merged unrelated content together" signal
// rather than a real text block, and skipped - see the reasoning where this is
// used in recognizeImage.
const MAX_ZERO_WORD_REGION_AREA_FRACTION = 0.08;

function meanOf(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function rotatePoint(x, y, cx, cy, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// Maps a bbox's 4 corners through transformFn(x, y) -> {x, y} (a rotation,
// an unwarp, ...) and returns the axis-aligned box around the transformed
// corners. A rotated/warped bbox isn't itself axis-aligned, so this re-fits
// one around whatever the 4 corners land at - used by both buildBboxMapper
// below and reprocessRegion's keystone-correction path.
function transformBboxCorners({ x0, y0, x1, y1 }, transformFn) {
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => transformFn(x, y));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

// Builds a function mapping a bbox in the recognized (rotated, possibly upscaled)
// image's pixel space back to the original image's pixel space: undo Tesseract's
// auto-rotation (around the image center) first, then undo any upscale.
function buildBboxMapper(imgWidth, imgHeight, rotateRadians, scaleFactor) {
  const cx = imgWidth / 2;
  const cy = imgHeight / 2;
  const angle = -(rotateRadians || 0);
  const inv = 1 / scaleFactor;

  return (bbox) => {
    const { x0, y0, x1, y1 } = transformBboxCorners(bbox, (x, y) => rotatePoint(x, y, cx, cy, angle));
    return { x0: x0 * inv, y0: y0 * inv, x1: x1 * inv, y1: y1 * inv };
  };
}

// Walks Tesseract's block > paragraph > line > word hierarchy (requested via
// `blocks: true`) into a list of regions, each carrying its own line/word
// bboxes (already mapped into original-image space) and mean confidence - the
// per-block detail a flat `data.lines` walk discards.
function extractRegions(data, mapBoxToOriginal) {
  const regions = [];
  if (!Array.isArray(data.blocks)) return regions;

  data.blocks.forEach((block) => {
    const lines = [];
    (block.paragraphs || []).forEach((para) => {
      (para.lines || []).forEach((line) => {
        const words = (line.words || [])
          .map((w) => ({
            text: (w.text || "").trim(),
            confidence: typeof w.confidence === "number" ? w.confidence : 0,
            bbox: mapBoxToOriginal(w.bbox),
          }))
          .filter((w) => w.text);
        if (words.length) lines.push({ bbox: mapBoxToOriginal(line.bbox), words });
      });
    });
    // Tesseract's layout analysis can find a block-shaped region with a real
    // bbox and its own (sometimes high) block-level confidence, yet recognize
    // zero actual words within it - seen in practice on poster text sitting on
    // a solid/saturated color background (word-level recognition apparently
    // fails harder on that than the geometric block/line detection step does).
    // Discarding these would mean the region reprocessing pass below never
    // even gets a chance at them, so they're kept as zero-word regions (using
    // the block's own bbox) rather than dropped - region reprocessing treats
    // an empty region as maximally worth retrying.
    if (!lines.length) {
      if (!block.bbox) return;
      const bbox = mapBoxToOriginal(block.bbox);
      if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return;
      regions.push({ bbox, lines: [], words: [], meanConfidence: 0 });
      return;
    }

    const allWords = lines.flatMap((l) => l.words);
    regions.push({
      bbox: {
        x0: Math.min(...lines.map((l) => l.bbox.x0)),
        y0: Math.min(...lines.map((l) => l.bbox.y0)),
        x1: Math.max(...lines.map((l) => l.bbox.x1)),
        y1: Math.max(...lines.map((l) => l.bbox.y1)),
      },
      lines,
      words: allWords,
      meanConfidence: meanOf(allWords.map((w) => w.confidence)),
    });
  });

  return regions;
}

// Orders regions (blocks) into reading order: primarily top-to-bottom, with
// blocks at roughly the same height ordered left-to-right. Tesseract's own
// block emission order turned out not to be reliable reading order on its own
// - e.g. a notification list where each row's right-aligned timestamp gets
// segmented into its own block, with ALL timestamp blocks then emitted after
// ALL body-text blocks rather than interleaved per row. This sorts at BLOCK
// granularity only (each block's internal line order is left untouched), which
// is coarse enough to fix that case without the failure mode a word-level or
// line-level global sort has: scrambling genuinely multi-column layouts (a
// grid of same-height UI panel screenshots) by interleaving unrelated panels
// whose rows happen to land at similar heights.
function orderRegionsForReading(regions) {
  return [...regions].sort((a, b) => {
    const rowTolerance = Math.min(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0) * 0.5;
    if (Math.abs(a.bbox.y0 - b.bbox.y0) > rowTolerance) return a.bbox.y0 - b.bbox.y0;
    return a.bbox.x0 - b.bbox.x0;
  });
}

// Flattens regions (each already ordered into lines) into the final
// { lineIndex, text, confidence, bbox } word list, assigning a fresh
// sequential lineIndex per line as it goes.
function flattenRegions(regions) {
  const words = [];
  let lineIndex = -1;
  orderRegionsForReading(regions).forEach((region) => {
    region.lines.forEach((line) => {
      if (!line.words.length) return;
      lineIndex++;
      line.words.forEach((w) => words.push({ lineIndex, text: w.text, confidence: w.confidence, bbox: w.bbox }));
    });
  });
  return words;
}

// Crops one region (+ margin) from the original image, optionally corrects
// keystone distortion detected from its own line geometry, tries preprocess.js's
// region-scoped preprocessing candidates, and re-recognizes at a PSM suited to
// the region's shape. Returns { words, meanConfidence } in original-image
// coordinates, or null if the region couldn't be processed.
async function reprocessRegion(worker, PSM, previewImg, naturalWidth, naturalHeight, region) {
  const cx0 = Math.max(0, Math.floor(region.bbox.x0) - REGION_CROP_MARGIN);
  const cy0 = Math.max(0, Math.floor(region.bbox.y0) - REGION_CROP_MARGIN);
  const cx1 = Math.min(naturalWidth, Math.ceil(region.bbox.x1) + REGION_CROP_MARGIN);
  const cy1 = Math.min(naturalHeight, Math.ceil(region.bbox.y1) + REGION_CROP_MARGIN);
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  if (cw <= 0 || ch <= 0) return null;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cw;
  cropCanvas.height = ch;
  try {
    cropCanvas.getContext("2d").drawImage(previewImg, cx0, cy0, cw, ch, 0, 0, cw, ch);
  } catch {
    return null;
  }

  const localLines = region.lines.map((l) => ({
    x0: l.bbox.x0 - cx0,
    y0: l.bbox.y0 - cy0,
    x1: l.bbox.x1 - cx0,
    y1: l.bbox.y1 - cy0,
  }));
  const keystoneQuad = detectKeystoneQuad(localLines, cw, ch);

  let source = cropCanvas;
  let unwarpPoint = null;
  if (keystoneQuad) {
    const warped = warpPerspective(cropCanvas, keystoneQuad, cw, ch);
    if (warped) {
      source = warped.canvas;
      unwarpPoint = warped.unwarpPoint;
    }
  }

  const candidates = preprocessRegion(source);
  // A region pass 1 found zero words in isn't safely assumed to be one
  // coherent block of text - it's often geometry Tesseract's layout analysis
  // grouped together (e.g. a poster's decorative illustrations plus a small
  // text box, merged into one large blob) rather than a real single text
  // block. Forcing PSM.SINGLE_BLOCK there was found, in testing, to make
  // Tesseract hallucinate text out of illustration/icon content it otherwise
  // correctly ignored. PSM.SPARSE_TEXT is built for exactly this case -
  // scattered text amid non-text content - and is far more conservative about
  // calling something text in the first place.
  const psm = region.words.length === 0 ? PSM.SPARSE_TEXT : cw / ch > SINGLE_LINE_ASPECT_RATIO ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK;

  let best = null;
  for (const candidate of candidates) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const result = await worker.recognize(candidate.canvas, {}, { blocks: true });
    const inv = 1 / candidate.scaleFactor;

    // Preserve the recognized line grouping/order (not just a flat word list)
    // so the merge back in recognizeImage can flatten it with flattenRegions
    // the same way as an untouched region, instead of needing its own
    // position-based reading-order guess.
    const lines = [];
    (result.data.blocks || []).forEach((block) =>
      (block.paragraphs || []).forEach((para) =>
        (para.lines || []).forEach((line) => {
          const lineWords = (line.words || [])
            .map((w) => {
              const text = (w.text || "").trim();
              if (!text) return null;
              let bx = {
                x0: w.bbox.x0 * inv,
                y0: w.bbox.y0 * inv,
                x1: w.bbox.x1 * inv,
                y1: w.bbox.y1 * inv,
              };
              if (unwarpPoint) {
                bx = transformBboxCorners(bx, unwarpPoint);
              }
              return {
                text,
                confidence: typeof w.confidence === "number" ? w.confidence : 0,
                bbox: { x0: bx.x0 + cx0, y0: bx.y0 + cy0, x1: bx.x1 + cx0, y1: bx.y1 + cy0 },
              };
            })
            .filter(Boolean);
          if (lineWords.length) lines.push({ words: lineWords });
        })
      )
    );

    const allWords = lines.flatMap((l) => l.words);
    const confidence = meanOf(allWords.map((w) => w.confidence));
    if (allWords.length && (!best || confidence > best.meanConfidence)) {
      best = { lines, meanConfidence: confidence };
    }
  }

  return best;
}

// Runs the full Phase 1 pipeline -> { words, text, preprocessed }. `onProgress`
// receives Tesseract's raw logger messages ({status, progress}); this module stays
// UI-agnostic and leaves rendering the progress bar to the caller.
export async function recognizeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  const PSM = { ...FALLBACK_PSM, ...((window.Tesseract && window.Tesseract.PSM) || {}) };
  const worker = await window.Tesseract.createWorker("eng", 1, { logger: onProgress });

  const runPass = async (source, width, height, psm, preprocessed) => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const result = await worker.recognize(source, { rotateAuto: true }, { text: true, blocks: true });
    const mapBoxToOriginal = buildBboxMapper(width, height, result.data.rotateRadians, width / naturalWidth);
    const regions = extractRegions(result.data, mapBoxToOriginal);
    const words = regions.flatMap((r) => r.words);
    return {
      regions,
      words,
      text: (result.data.text || "").trim(),
      meanConfidence: meanOf(words.map((w) => w.confidence)),
      source,
      width,
      height,
      preprocessed,
    };
  };

  try {
    let best = await runPass(previewImg, naturalWidth, naturalHeight, PSM.AUTO, false);

    if (best.meanConfidence < PREPROCESS_WORTH_TRYING_THRESHOLD) {
      const { canvas } = await preprocessImage(previewImg, naturalWidth, naturalHeight);
      const preResult = await runPass(canvas, canvas.width, canvas.height, PSM.AUTO, true);
      if (preResult.meanConfidence > best.meanConfidence) best = preResult;
    }

    if (best.words.length === 0 || best.meanConfidence < RETRY_MEAN_CONFIDENCE_THRESHOLD) {
      const retry = await runPass(best.source, best.width, best.height, PSM.SPARSE_TEXT, best.preprocessed);
      if (retry.words.length && retry.meanConfidence > best.meanConfidence) best = retry;
    }

    if (best.regions.length && best.meanConfidence < SKIP_REGION_PASS_OVERALL_THRESHOLD) {
      const imageArea = naturalWidth * naturalHeight;
      const weakRegions = best.regions
        .filter((r) => r.meanConfidence < REGION_REPROCESS_THRESHOLD)
        // A region pass 1 recognized zero words in is only trustworthy as a
        // "there's text here" signal when it's a plausibly text-box-sized
        // area. Tested in practice on a poster where Tesseract's layout
        // analysis merged a small text box together with a large surrounding
        // area of decorative illustrations into one big zero-word block:
        // reprocessing that under any PSM hallucinated garbage tokens out of
        // the illustration content, which is worse than the current "nothing
        // recognized there" result. A region with actual (if low-confidence)
        // words already passed real word-level recognition once, so it isn't
        // held to this - only the zero-word "layout analysis found a shape but
        // no text" case is this unreliable.
        .filter((r) => r.words.length > 0 || (r.bbox.x1 - r.bbox.x0) * (r.bbox.y1 - r.bbox.y0) < imageArea * MAX_ZERO_WORD_REGION_AREA_FRACTION)
        .sort((a, b) => a.meanConfidence - b.meanConfidence)
        .slice(0, MAX_REGIONS);

      for (const region of weakRegions) {
        const reprocessed = await reprocessRegion(worker, PSM, previewImg, naturalWidth, naturalHeight, region);
        const reprocessedWordCount = reprocessed ? reprocessed.lines.reduce((n, l) => n + l.words.length, 0) : 0;
        // A higher average confidence isn't enough on its own: a region that's
        // actually several real columns merged into one Tesseract block (this
        // pipeline's region detection is only as good as Tesseract's own block
        // segmentation) can, when forced through a single-block re-recognition,
        // collapse/merge many words into fewer garbled ones that each still
        // score confidently. Requiring the reprocessed word count to be within
        // shouting distance of the original catches that failure mode without
        // needing to know anything about *why* it happened.
        const keepsEnoughContent = reprocessedWordCount >= region.words.length * MIN_REGION_WORD_COUNT_RATIO;
        if (reprocessed && keepsEnoughContent && reprocessed.meanConfidence > region.meanConfidence) {
          region.lines = reprocessed.lines;
        }
      }
    }

    return { words: flattenRegions(best.regions), text: best.text, preprocessed: best.preprocessed };
  } finally {
    await worker.terminate();
  }
}
