// fontMatch.js: recovering a word's TYPEFACE ATTRIBUTES from its own pixels -
// how heavy the strokes are, whether they lean, whether the terminals flare
// into serifs, how wide the glyphs sit - so a retyped word can be set in a face
// that looks like the one in the photograph instead of the app's default stack.
//
// This is the "font matcher that does not exist yet" that three separate
// comments in editorObjects.js defer to (fontSizePctForInk's header, the
// NO BOLD/REGULAR DETECTION block, and inkFitPx's "set in the app's font, not
// the photo's"). It exists now, and the reason it can is one idea:
//
//   ANALYSIS BY SYNTHESIS. Do not ask "is this stroke thick?" in the abstract.
//   Render THE SAME STRING in each candidate face, measure it with THE SAME
//   CODE, and keep whichever candidate measures most like the source.
//
// That distinction is the whole difference between this file and the attempt
// recorded (and correctly rejected) in editorObjects.js's NO BOLD/REGULAR
// DETECTION comment. That one measured ink fraction ABSOLUTELY and found the
// ranges for weight 500 and weight 700 almost entirely overlapping - because
// how much of a box is ink is dominated by WHICH LETTERS the word contains and
// by the typeface's own design, not by its weight. Comparing a word against a
// render of the same letters cancels both confounds exactly: "POPCICHAWK" in
// the photo is compared against "POPCICHAWK" in each candidate, so whatever
// those ten specific letters do to the measurement, they do to both sides.
//
// Measured by test/font-match.js, which draws words in a font it chose and
// checks what comes back (576 words: 3 families x 2 real weights x 2 slants x
// 3 sizes x 16 strings):
//
//   weight recovered ....................... 99.0%   (all-400 scores 50%)
//   weight, absolute threshold instead ..... 84.1%   <- the old idea, tuned
//   family recovered, sans vs serif ........ 85.9%
//   monospace recovered .................... 37.5%   (6.3% before)
//   italic recall .......................... 66.3%
//   italic false positives ................. 0.0%
//
// The absolute-threshold row is the fair comparison: that is the SAME stroke
// measurement this file uses, thresholded at its best-separating value instead
// of matched against a synthetic probe. The gap between 84.1% and 99.0% is
// what analysis-by-synthesis buys, and it is why the previous attempt's
// conclusion ("there is no threshold that works, so guessing would just render
// some words wrongly bold") was right about thresholds and wrong about the
// problem being unsolvable.
//
// The two low rows are low ON PURPOSE and are documented where they are decided
// (MONOSPACE_MAX_ADVANCE_CV, and the italic block above ITALIC_MIN_DEG). Both
// axes are tuned for precision over recall, because their errors are not
// symmetric: a missed italic stays upright, which is what shipped before, while
// a word wrongly set in italics or in Courier is glaring - and on a
// hand-lettered image the same mistake lands on every word at once.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. It does not identify the typeface. It
// recovers the attributes a reader actually notices - weight, slant,
// serif/sans, monospace, and the existing condensed axis - and picks the
// closest face from a small set the platform is known to have. A photo set in
// Futura comes back as the system sans at the right weight and slant, not as
// Futura. That is the honest ceiling for a word-sized crop and a stack of
// system fonts, and it is far closer than "everything is regular-weight upright
// sans", which is what shipped before.

// ---- Binarization ----

// Otsu's method: the threshold maximizing between-class variance, over a
// 256-bin luminance histogram. Lives here rather than in editorObjects.js
// because every measurement below needs it and editorObjects.js's own two
// callers (sampleInkAppearance's ink/background split, and the condensed
// detector's binarization) import it back from here - one implementation, in
// the file whose subject is pixel analysis.
export function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v];
  let sumBelow = 0;
  let weightBelow = 0;
  let best = 0;
  let threshold = 0;
  for (let v = 0; v < 256; v++) {
    weightBelow += histogram[v];
    if (!weightBelow) continue;
    const weightAbove = total - weightBelow;
    if (!weightAbove) break;
    sumBelow += v * histogram[v];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sum - sumBelow) / weightAbove;
    const between = weightBelow * weightAbove * (meanBelow - meanAbove) * (meanBelow - meanAbove);
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

// A word's pixels as a 1-bit ink mask. Ink is whichever side of the Otsu split
// is the MINORITY population - within a word's own tight bounding box the
// letterforms always cover less area than the space around them, which is the
// same reasoning sampleInkAppearance's header sets out, and it is what lets
// this work on light-on-dark text without being told which it is.
// Every measurement in this file is a RATIO - stroke over box height, ink width
// over ink height, one column profile against another - so none of them needs
// the photograph's own resolution, and running at it is pure cost: a headline
// in a 12-megapixel photo is a 400-pixel-tall word, and the de-shear search
// alone walks it fifteen times. Above this height the region is box-averaged
// down before anything is measured, which bounds the per-word cost by the
// WORD's size rather than the CAMERA's. 72 leaves a bold stem around 13 pixels
// wide, far more than the measurements can use.
//
// Box-averaging the luminance BEFORE the Otsu split, rather than thresholding
// first and shrinking the mask, is the half that matters: averaging a 1-bit
// mask erodes thin strokes and would make every downscaled word read lighter
// than it is. Averaging luminance is just what a lower-resolution photograph of
// the same words would have looked like.
const MAX_ANALYSIS_HEIGHT = 64;

function maskFromRegion(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1) {
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(naturalWidth - 1, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(naturalHeight - 1, Math.ceil(y1));
  const srcW = right - left + 1;
  const srcH = bottom - top + 1;
  if (srcW < 6 || srcH < 6) return null;

  // Rounded, not floored. Flooring means a 66-pixel word against a 72-pixel
  // cap computes a step of 0 -> 1 and is not reduced at all, so the cap only
  // ever bites at exact multiples and the common sizes sail past it.
  const step = Math.max(1, Math.round(srcH / MAX_ANALYSIS_HEIGHT));
  const w = Math.floor(srcW / step);
  const h = Math.floor(srcH / step);
  if (w < 6 || h < 6) return null;

  const { data, width } = imageData;
  const histogram = new Uint32Array(256);
  const luma = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < step; dy++) {
        const row = (top + y * step + dy) * width;
        for (let dx = 0; dx < step; dx++) {
          const i = (row + left + x * step + dx) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
      }
      const l = sum / (step * step);
      luma[y * w + x] = l;
      histogram[Math.round(l)]++;
    }
  }
  const threshold = otsuThreshold(histogram, w * h);
  let darkCount = 0;
  for (let p = 0; p < luma.length; p++) if (luma[p] <= threshold) darkCount++;
  const inkIsDark = darkCount <= luma.length / 2;
  const m = new Uint8Array(w * h);
  for (let p = 0; p < luma.length; p++) {
    m[p] = (inkIsDark ? luma[p] <= threshold : luma[p] > threshold) ? 1 : 0;
  }
  return { m, w, h };
}

// ---- Connected components (shared with the condensed/monospace detectors) ----

// The connected ink components within a mask, 4-connected, each surviving
// component (area >= 3px, filtering single-pixel noise) a glyph candidate.
// Touching/cursive letters merge into fewer, wider components on some faces;
// that under-counts rather than crashing.
function componentsOfMask({ m, w, h }) {
  const visited = new Uint8Array(w * h);
  const components = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!m[idx] || visited[idx]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cy = (cur / w) | 0;
        const cx = cur % w;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0 && m[cur - 1] && !visited[cur - 1]) { visited[cur - 1] = 1; stack.push(cur - 1); }
        if (cx < w - 1 && m[cur + 1] && !visited[cur + 1]) { visited[cur + 1] = 1; stack.push(cur + 1); }
        if (cy > 0 && m[cur - w] && !visited[cur - w]) { visited[cur - w] = 1; stack.push(cur - w); }
        if (cy < h - 1 && m[cur + w] && !visited[cur + w]) { visited[cur + w] = 1; stack.push(cur + w); }
      }
      // minX/maxX ride along for advanceUniformity below; width/height keep the
      // shape glyphComponents' existing callers (the condensed and monospace
      // detectors in editorObjects.js) were calibrated against.
      if (area >= 3) components.push({ width: maxX - minX + 1, height: maxY - minY + 1, minX, maxX });
    }
  }
  return components;
}

// Kept exported at its original signature so editorObjects.js's condensed and
// monospace detectors - both calibrated against this exact measurement, and
// both deliberately unchanged by this file - keep measuring what they were
// tuned against rather than something subtly different.
export function glyphComponents(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1) {
  const mask = maskFromRegion(imageData, naturalWidth, naturalHeight, x0, y0, x1, y1);
  if (!mask) return null;
  return componentsOfMask(mask);
}

// MONOSPACE, measured as what monospace actually IS: a constant advance from
// one glyph to the next.
//
// The detector that already exists (detectMonospaceWord in editorObjects.js)
// asks how uniform the glyphs' INK widths are, which is a different property
// and not one a monospace face promises - `i` and `m` share a cell and draw
// very different amounts of ink inside it. That is why it fires on 6% of known
// monospace words. This asks about the cell instead: the distance from each
// glyph's left edge to the next one's.
//
// Components are merged into cells first, because a connected-component pass
// does not return glyphs - it returns strokes. The dot of an `i`, the two
// halves of a broken `n`, an accent - each is its own component sitting at
// roughly the same horizontal position as its parent. Anything horizontally
// overlapping the cell being built belongs to it.
function advanceUniformity(components) {
  if (components.length < 4) return null;
  const sorted = [...components].sort((a, b) => a.minX - b.minX);
  const cells = [];
  for (const c of sorted) {
    const last = cells[cells.length - 1];
    if (last && c.minX <= last.maxX) {
      last.maxX = Math.max(last.maxX, c.maxX);
      continue;
    }
    cells.push({ minX: c.minX, maxX: c.maxX });
  }
  if (cells.length < 4) return null;
  const advances = [];
  for (let i = 1; i < cells.length; i++) advances.push(cells[i].minX - cells[i - 1].minX);
  const mean = advances.reduce((a, b) => a + b, 0) / advances.length;
  if (!mean) return null;
  const variance = advances.reduce((a, b) => a + (b - mean) * (b - mean), 0) / advances.length;
  return Math.sqrt(variance) / mean;
}

// ---- The feature vector ----

const median = (values) => {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
};

// STROKE WIDTH, by the stroke-width-transform's central trick: for every ink
// pixel take the SHORTER of the horizontal and the vertical ink run through it,
// then take the median over the word.
//
// The "shorter of the two" is what makes this a stroke measurement rather than
// a shape measurement, and it is the part a plain run-length median gets wrong.
// A horizontal bar - the crossbar of an E, the spine of a Z - has a long
// horizontal run and a short vertical one; taking the minimum reports its real
// thickness instead of its length. The same holds transposed for a vertical
// stem. Diagonals report slightly wide in both directions and are outvoted by
// the median.
function strokeWidth({ m, w, h }) {
  const horizontal = new Int32Array(w * h);
  const vertical = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && m[y * w + x]) run++;
      else {
        for (let k = x - run; k < x; k++) horizontal[y * w + k] = run;
        run = 0;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && m[y * w + x]) run++;
      else {
        for (let k = y - run; k < y; k++) vertical[k * w + x] = run;
        run = 0;
      }
    }
  }
  const widths = [];
  for (let p = 0; p < w * h; p++) {
    if (m[p]) widths.push(Math.min(horizontal[p], vertical[p]));
  }
  return median(widths);
}

// The dense band: the rows carrying at least half the ink of the heaviest row.
// For a lowercase word that is the x-height zone; for an all-caps one, the cap
// band. Either way it is the vertical extent the typeface's stems actually
// span, which is the right thing to measure stroke width AGAINST - dividing by
// the full ink box instead would make one word with a descender read lighter
// than the identical word without.
function denseBand({ m, w, h }) {
  const rowInk = new Int32Array(h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) count += m[y * w + x];
    rowInk[y] = count;
    if (count > max) max = count;
  }
  if (!max) return null;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] >= max * 0.5) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;
  return { top, bottom, height: bottom - top + 1, rowInk };
}

// SERIF-NESS: how much heavier the baseline row is than the middle of the band.
// Serif feet are horizontal slabs sitting on the baseline, so a serif face puts
// markedly more ink in the bottom few rows of its band than in the middle,
// where only the stems are; a sans face is flat through both.
//
// Reported as a bare ratio rather than a verdict, because the threshold that
// separates the two families is not fixed - it is whatever the CANDIDATE faces
// measure on this same string, which is the matched-filter comparison below.
function serifRatio({ m, w }, band) {
  if (!band || band.height < 10) return null;
  const rowSum = (y) => {
    let count = 0;
    for (let x = 0; x < w; x++) count += m[y * w + x];
    return count;
  };
  const edge = Math.max(1, Math.round(band.height * 0.08));
  let baseline = 0;
  for (let y = band.bottom - edge + 1; y <= band.bottom; y++) baseline += rowSum(y);
  baseline /= edge;
  const midTop = band.top + Math.round(band.height * 0.3);
  const midBottom = band.top + Math.round(band.height * 0.7);
  let middle = 0;
  let rows = 0;
  for (let y = midTop; y <= midBottom; y++) {
    middle += rowSum(y);
    rows++;
  }
  middle /= rows || 1;
  return middle ? baseline / middle : null;
}

// SLANT, by de-shearing: shear the mask through a range of angles and keep
// whichever one stacks the ink into the tallest, narrowest columns.
//
// The score is the sum of squares of the per-column ink counts, which is
// maximized when ink piles into as few columns as possible - exactly what
// happens when a slanted stem is sheared back upright. Upright text is already
// at its maximum, so it scores best at 0; italic text scores best at its own
// angle.
//
// Reported as BOTH the winning angle and how much better it scored than leaving
// the word alone, because the angle by itself is not enough and measuring said
// so. On clean synthetic type the angle separates perfectly (upright words
// never exceed 3 degrees, italic ones never come in under 6), but on real
// photographs it does not come close:
//
//   complexPic1's hand-drawn poster - upright type, every word of it - peaked
//   at 6 to 12 degrees on LANE, DAY, CREATIVE and RESIJENT, because irregular
//   hand-lettering has no single true vertical to find. An angle-only rule set
//   half that poster in italics.
//
// The gain separates what the angle cannot: those same words gained only
// 1.04-1.06 from being de-sheared, because they were never sheared to begin
// with - the search just found a marginally tidier arrangement of noise.
// Genuinely italic synthetic type gains 1.12 at the median. See ITALIC_MIN_GAIN
// for where the line ended up and what it costs.
const SLANT_STEP_DEG = 3;
const SLANT_MAX_DEG = 21;

// Pools a mask down by an integer factor, taking a cell as ink if ANY of its
// pixels is. Used only for the de-shear search below: that search asks whether
// the word's ink stacks into columns, which is a property of the word's overall
// shape and survives coarse pooling intact, while costing sixteen passes over
// whatever resolution it is handed. OR-pooling rather than averaging because
// thinning a stroke to nothing would change the shape the search is reading.
function poolMask({ m, w, h }, factor) {
  if (factor < 2) return { m, w, h };
  const pw = Math.floor(w / factor);
  const ph = Math.floor(h / factor);
  if (pw < 4 || ph < 4) return { m, w, h };
  const out = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let any = 0;
      for (let dy = 0; dy < factor && !any; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          if (m[(y * factor + dy) * w + x * factor + dx]) { any = 1; break; }
        }
      }
      out[y * pw + x] = any;
    }
  }
  return { m: out, w: pw, h: ph };
}

// The height the de-shear search runs at. Below the analysis cap because the
// search needs far less: at 32 rows a 3-degree shear still displaces the top of
// the word by about 1.7 pixels, which is all the resolution a 3-degree step can
// use.
const SLANT_WORK_HEIGHT = 48;

function slantOf(fullMask) {
  const { m, w, h } = poolMask(fullMask, Math.max(1, Math.round(fullMask.h / SLANT_WORK_HEIGHT)));
  const span = Math.ceil(Math.tan((SLANT_MAX_DEG * Math.PI) / 180) * h) + 2;
  const columns = new Int32Array(w + 2 * span);
  const scoreAt = (deg) => {
    columns.fill(0);
    const slope = Math.tan((deg * Math.PI) / 180);
    for (let y = 0; y < h; y++) {
      const shift = Math.round(slope * (h - 1 - y)) + span;
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) {
          const c = x + shift;
          if (c >= 0 && c < columns.length) columns[c]++;
        }
      }
    }
    let score = 0;
    for (let c = 0; c < columns.length; c++) score += columns[c] * columns[c];
    return score;
  };

  let bestAngle = 0;
  let bestScore = -1;
  for (let deg = -SLANT_MAX_DEG; deg <= SLANT_MAX_DEG; deg += SLANT_STEP_DEG) {
    const score = scoreAt(deg);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = deg;
    }
  }
  const upright = scoreAt(0);
  return { angle: bestAngle, gain: upright > 0 ? bestScore / upright : 1 };
}

// A word is called italic only when all three of these hold. Every one of them
// is there to keep a false positive out, and the reason is that the two errors
// are not symmetric: an upright word wrongly set in italics is glaring and is
// wrong on EVERY word of a hand-lettered image at once, while a missed italic
// stays upright - which is exactly what shipped before this file existed. So
// this is tuned for precision and the cost in recall is stated rather than
// hidden.
//
//   ANGLE - the de-shear has to find a real lean. Necessary, nowhere near
//   sufficient: see slantOf's header for the poster it sets in italics alone.
//
//   GAIN - de-shearing has to actually TIDY the word, not just tilt it.
//   Measured across 4 real photographs (217 scanned words, essentially all
//   upright) and 216 synthetic italics: real upright words peak at 1.04-1.06
//   even when their angle is large, genuine italics sit at 1.12 median.
//
//   COMPONENTS, and LENGTH - a word needs several glyphs before its lean means
//   anything. The highest-gain "italics" in the real corpus were "4", "J", "/",
//   "()", "2)" and "[7" - OCR noise and single characters whose own diagonal IS
//   the shape. One glyph is not evidence about a typeface. Both gates are
//   needed and neither implies the other: a fragmenting binarization splits "/"
//   into four components, and a clean "ELITE" merges into fewer than five.
//
// Where it stands with all three applied: 0% false positives on 216 synthetic
// upright words, 70.8% recall on 216 synthetic italics, and 2 flagged words in
// 287 real scanned ones - down from 11 false italics on complexPic1's poster
// alone before the gain gate existed.
//
// THE LIMIT THIS CANNOT PASS, stated because the remaining 2 are both examples
// of it: a photograph taken at an angle SHEARS the text in it, and sheared
// upright type is pixel-for-pixel a slanted typeface. "ELITE" on a box
// photographed from the side measures as italic because in that image it IS
// slanted. Nothing recoverable from a word-sized crop separates the two - it
// would take the page's own vanishing point, which this app knows only for
// scans that went through perspective correction. A scan taken square-on does
// not have the problem at all.
const ITALIC_MIN_DEG = 6;
const ITALIC_MIN_GAIN = 1.08;
const ITALIC_MIN_COMPONENTS = 4;
const ITALIC_MIN_CHARS = 3;

// The tight box the ink actually occupies inside the mask. The region handed in
// is the OCR engine's bounding box on the source side and measureText's on the
// probe side; neither is guaranteed to be tight, and the difference between
// them would otherwise be charged to the typeface.
function inkBox({ m, w, h }) {
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (top < 0) top = y;
      bottom = y;
      if (left < 0 || x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top < 0) return null;
  return { height: bottom - top + 1, width: right - left + 1 };
}

// The complete feature vector for one ink mask.
//
// STROKE is normalized by the INK BOX height, not by the x-height band, and
// that choice is measured rather than aesthetic. Both were tried across three
// families at a known weight 400:
//
//   normalized by band: 0.167 - 0.194 across families   (16% spread)
//   normalized by box:  0.125 - 0.133 across families   ( 6% spread)
//
// x-height is one of the most face-dependent proportions in typography, so
// dividing by it makes a large-x-height face read as LIGHTER than it is - which
// is exactly what happened on a screenshot set in a geometric sans, where body
// text at a plain regular weight came back as 300. An ink box varies far less
// between faces. The usual objection to it - that its height depends on whether
// the word happens to contain an ascender or a descender - does not apply here,
// because the same string is measured on both sides of every comparison, so
// that dependence cancels exactly.
//
// The band is still measured, and still used: it is the right reference for
// SERIF-ness (serif feet sit on the baseline, which is the bottom of the band,
// not the bottom of a descender) and for sizing the probes.
function featuresOfMask(mask) {
  const band = denseBand(mask);
  if (!band) return null;
  const box = inkBox(mask);
  if (!box) return null;
  const stroke = strokeWidth(mask);
  if (!stroke) return null;
  return {
    stroke: stroke / box.height,
    serif: serifRatio(mask, band),
    aspect: box.width / box.height,
    bandHeight: band.height,
    boxHeight: box.height,
  };
}

// ---- Synthetic probes ----
//
// The other half of every comparison: the same string, set in a candidate face,
// measured by the code above through a canvas rather than a photo.

// The candidate faces. Each is a CSS font-family list the platform is known to
// resolve, and each maps to a fontClass editorObjects.js already understands
// (or, for "serif", one added alongside them). Deliberately small: these are
// the distinctions a reader notices at word size, and every extra candidate is
// two more canvas renders per word for a finer distinction than the measurement
// can actually support.
//
// THESE MUST STAY IN STEP WITH style.css. The matcher decides a word is serif by
// measuring it against a render of THIS stack, and the app then paints the word
// in `.image-format-word.is-font-serif`'s stack - if the two drift apart, the
// matcher is optimising for a face the user never sees, silently and with no
// symptom a screenshot would show. test/font-match.js's last check renders the
// same string through both and fails if they resolve differently, which is the
// only thing standing between this list and that drift.
export const FONT_CANDIDATES = {
  regular: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
  serif: `Georgia, "Times New Roman", Times, serif`,
  condensed: `"Roboto Condensed", "Arial Narrow", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif`,
  monospace: `"SF Mono", Menlo, Consolas, "Roboto Mono", "Courier New", monospace`,
};

// The two weights every probe is taken at. Real faces are interpolated between
// them (see matchWordFont) rather than probed at every hundred: stroke width is
// monotonic and very nearly linear in weight, and a system stack that lacks a
// given weight synthesizes or snaps to a neighbour anyway, so probing six
// weights would cost three times the renders to resolve distinctions the
// platform may not even have.
const PROBE_LIGHT = 400;
const PROBE_HEAVY = 700;

// The candidates the matcher itself chooses between when neither of
// editorObjects.js's own detectors has claimed the word.
//
// Monospace is in this list as well as having its own dedicated detector, and
// that is not redundancy - it is cover for a real gap in the dedicated one.
// detectMonospaceWord measures how uniform the glyphs' INK widths are, but a
// monospace face guarantees uniform ADVANCE width, which is a different thing:
// an `i` and an `m` occupy the same cell and still draw very different amounts
// of ink. Measured against 96 synthetic monospace words, that detector fires on
// 6% of them. It is kept, unchanged, because when it does fire it is reliable
// and it is the only signal that works on a word sitting alone; the matched
// filter catches the rest through `aspect`, since a monospace face sets the
// same string markedly wider than a proportional one.
const PROPORTIONAL_CLASSES = ["regular", "serif"];

// Monospace is only ALLOWED to compete once the word's advances look like a
// grid, and then it still has to win on set width like any other candidate.
// Two signals rather than one, because each covers the other's failure:
//
//   Advance uniformity alone recovers 84% of monospace words but calls 18% of
//   proportional ones monospace too - and those false positives are not random.
//   They are ALL-CAPS words, whose capitals are near enough the same width, and
//   DIGIT STRINGS, which almost every proportional face sets with tabular
//   figures that genuinely are one fixed width. Neither is evidence of a
//   monospace face; both are evidence of a string that would look the same in
//   one.
//
//   Set width alone (the matched filter's `aspect`) is the signal that tells
//   those apart - a real monospace face sets a string 40-60% wider - but on its
//   own it pulls serif words into monospace, because Courier-descended faces
//   are slab-serifed and score like a serif face on the serif axis.
//
// The threshold is loose (0.18 sits at the top of the range where recall is
// flat) because it is a gate, not a verdict: its job is to keep monospace out
// of the contest for words that plainly are not, and let the width comparison
// decide the rest.
const MONOSPACE_MAX_ADVANCE_CV = 0.18;
const MONOSPACE_WIN_MARGIN = 1.5;

function candidateClasses(source) {
  if (source.advanceCV != null && source.advanceCV <= MONOSPACE_MAX_ADVANCE_CV) {
    return [...PROPORTIONAL_CLASSES, "monospace"];
  }
  return PROPORTIONAL_CLASSES;
}

let probeCanvas = null;
let probeContext = null;

function probeCtx() {
  if (probeContext !== null) return probeContext;
  if (typeof document === "undefined") {
    probeContext = null;
    return null;
  }
  probeCanvas = document.createElement("canvas");
  probeCanvas.width = PROBE_CANVAS_W;
  probeCanvas.height = PROBE_CANVAS_H;
  probeContext = probeCanvas.getContext("2d", { willReadFrequently: true });
  return probeContext;
}

// Probes are rendered at the size that makes their DENSE BAND the same height
// as the source word's, not at one fixed reference size, and that is not a
// detail. Stroke width in a photo is an integer number of pixels: a 2px stem in
// a 14px-tall word and a 3px stem in the same word are a 50% jump in the
// measured ratio with nothing in between. Rendering the probe at a comparable
// size makes it quantize the same way, so the comparison is like-for-like
// instead of a quantized measurement against a smooth one.
//
// The size is SOLVED rather than guessed, because guessing it is what made the
// first version of this file wrong. It mapped the source's band height onto a
// font size directly, which confuses two different measurements: a band height
// is an x-height (or a cap height), and that is roughly HALF an em. So a word
// with a 19px band was compared against a probe rendered at 16px, whose own
// band was about 9px - less than half the source's. The damage was not subtle:
// at 9px the probe's serif ratio could not be measured at all (serifRatio
// declines under 10 rows), so familyDistance fell through to aspect alone and
// called a plain sans-serif screenshot serif for 47 of its 115 words, while the
// probe's stroke quantized to 2 or 3 pixels and dragged body text down to
// weight 300.
//
// Solving takes one extra render per word: measure a probe at a first guess,
// then scale by however far its box came out. BOX_PER_EM is only the starting
// point, so its exact value does not matter - being close just means the
// correction is usually within a pixel.
const BOX_PER_EM = 0.72;
const MIN_PROBE_PX = 10;
// Capped well below the source sizes a poster headline reaches, for two
// reasons. The measurement stops caring above roughly this size - quantization
// is what the size-matching is for, and a 96px probe's stroke is already tens
// of pixels wide, so a 200px one resolves nothing further. And the probe canvas
// has to HOLD the render: a 220px face with ascenders and descenders overflows
// a 260px canvas, and an overflowing render measures a clipped word, silently
// and wrongly. This bound and PROBE_CANVAS_H below are one decision.
const MAX_PROBE_PX = 96;
const PROBE_CANVAS_W = 1600;
const PROBE_CANVAS_H = 260;

const clampProbePx = (px) => Math.min(MAX_PROBE_PX, Math.max(MIN_PROBE_PX, Math.round(px / 2) * 2));

const probeSizeCache = new Map();

// The font size at which `text` in the reference face has a dense band
// `targetBand` pixels tall. Resolved once per word and then used for EVERY
// candidate, so the candidates are comparable to each other as well as to the
// source - a family judged at one size against another judged at a different
// one would be charged for the difference in quantization rather than in shape.
function resolveProbeSize(text, targetBox) {
  const key = `${targetBox}|${text}`;
  if (probeSizeCache.has(key)) return probeSizeCache.get(key);
  const family = FONT_CANDIDATES.regular;
  let px = clampProbePx(targetBox / BOX_PER_EM);
  const first = probeFeatures(text, family, PROBE_LIGHT, px);
  if (first && first.boxHeight > 0) {
    const corrected = clampProbePx((px * targetBox) / first.boxHeight);
    if (corrected !== px) px = corrected;
  }
  probeSizeCache.set(key, px);
  return px;
}

const probeCache = new Map();

function probeFeatures(text, family, weight, sizePx) {
  const key = `${family}|${weight}|${sizePx}|${text}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let features = null;
  const ctx = probeCtx();
  if (ctx) {
    const { width: cw, height: ch } = probeCanvas;
    ctx.textBaseline = "alphabetic";
    ctx.font = `${weight} ${sizePx}px ${family}`;
    const originX = 24;
    const originY = Math.round(ch * 0.75);
    // MEASURED BEFORE ANYTHING IS PAINTED, so the clear below can be confined
    // to the few thousand pixels this word will actually occupy. Clearing the
    // whole canvas instead is what made a scan of a 90-word photograph take
    // twenty-five seconds instead of four: every probe - and there are five or
    // six per word once the size solve and each candidate's two weights are
    // counted - repainted 416,000 pixels to draw a word covering thirty
    // thousand. The per-word cost looked fine in a benchmark that measured the
    // same word repeatedly, because that one never missed the cache.
    const metrics = ctx.measureText(text);
    const x0 = Math.max(0, Math.floor(originX - metrics.actualBoundingBoxLeft));
    const x1 = Math.min(cw - 1, Math.ceil(originX + metrics.actualBoundingBoxRight));
    const y0 = Math.max(0, Math.floor(originY - metrics.actualBoundingBoxAscent));
    const y1 = Math.min(ch - 1, Math.ceil(originY + metrics.actualBoundingBoxDescent));
    if (x1 - x0 >= 6 && y1 - y0 >= 6) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      ctx.fillStyle = "#000000";
      ctx.fillText(text, originX, originY);
      const image = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      const mask = maskFromRegion(image, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0, y1 - y0);
      if (mask) features = featuresOfMask(mask);
    }
  }
  probeCache.set(key, features);
  return features;
}

// Cleared alongside editorObjects.js's own ink cache when a scan is reset, so a
// long session cannot accumulate one entry per distinct word ever scanned.
export function clearProbeCache() {
  probeCache.clear();
  probeSizeCache.clear();
}

// ---- The matcher ----

// Below this the measurement is not trustworthy and the matcher declines rather
// than guesses. A 12-pixel band is two or three pixels of stem: stroke width
// quantizes to a handful of distinct values, the baseline/middle comparison has
// barely a row to work with, and the de-shear search cannot resolve 3 degrees.
// Declining returns the scan's own default - which is exactly what shipped
// before this file existed, so a word too small to measure is no worse off.
const MIN_BAND_HEIGHT = 12;

// Weights are snapped to hundreds, and clamped to a range real system stacks
// actually carry. Extrapolating past the probes is allowed (a face heavier than
// the 700 probe is a real thing on a poster) but only one step, because past
// that the linear model is being asked to describe strokes it never saw.
const MIN_WEIGHT = 300;
const MAX_WEIGHT = 800;

function interpolateWeight(sourceStroke, lightStroke, heavyStroke) {
  if (!Number.isFinite(lightStroke) || !Number.isFinite(heavyStroke)) return PROBE_LIGHT;
  // A stack with no real bold measures the same at both probes. Nothing can be
  // inferred from a slope of zero, so keep the regular weight rather than
  // dividing by it.
  if (heavyStroke - lightStroke < 1e-6) return PROBE_LIGHT;
  const raw = PROBE_LIGHT + ((sourceStroke - lightStroke) * (PROBE_HEAVY - PROBE_LIGHT)) / (heavyStroke - lightStroke);
  const snapped = Math.round(raw / 100) * 100;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, snapped));
}

// How far apart two feature vectors are, once stroke has been accounted for by
// the weight interpolation. Only serif and aspect are left, each divided by the
// spread that attribute actually shows across faces so neither dominates by
// happening to be measured in bigger numbers.
const SERIF_SPREAD = 0.35;
// Aspect is compared RELATIVELY (how many percent wider), not as a raw
// difference, because it is a whole word's width over its height and so grows
// with the word's length. A fixed absolute tolerance means a two-letter word
// and a fourteen-letter one are held to wildly different standards of set
// width - the long one's aspect difference between two families is several
// times the short one's for the same typographic difference. 0.12 is the unit:
// roughly the set-width gap between a proportional and a monospace face.
const ASPECT_RELATIVE_SPREAD = 0.12;

function familyDistance(source, probe) {
  let distance = 0;
  if (source.serif != null && probe.serif != null) {
    const d = (source.serif - probe.serif) / SERIF_SPREAD;
    distance += d * d;
  }
  if (probe.aspect > 0) {
    const a = (source.aspect / probe.aspect - 1) / ASPECT_RELATIVE_SPREAD;
    distance += a * a;
  }
  return distance;
}

// The full per-word verdict.
//
// `forcedClass` is how the two PRE-EXISTING, separately-calibrated detectors
// keep their authority: editorObjects.js decides monospace (per-word glyph
// width uniformity) and condensed (scan-wide median glyph aspect) exactly as it
// did before, and passes the answer in. This file then decides weight and slant
// for that word, and - only when neither of those detectors claimed it - which
// of the remaining families it belongs to. Nothing calibrated was re-tuned to
// make room for this; it fills in the axes that were never measured at all.
//
// Returns null when the word cannot be measured, which callers read as "keep
// whatever the scan's default was".
export function matchWordFont(imageData, naturalWidth, naturalHeight, bbox, { text = "", forcedClass = null } = {}) {
  if (!imageData || !bbox) return null;
  const mask = maskFromRegion(imageData, naturalWidth, naturalHeight, bbox.x0, bbox.y0, bbox.x1, bbox.y1);
  if (!mask) return null;
  const source = featuresOfMask(mask);
  if (!source || source.bandHeight < MIN_BAND_HEIGHT) return null;

  // Computed once here and shared by both consumers. The connected-component
  // pass is the second-most expensive thing in this file after the de-shear
  // search, and it was being run twice per word plus once per synthetic probe -
  // where its answer is never read at all, since only the SOURCE is asked
  // whether its advances look like a grid.
  const components = componentsOfMask(mask);
  source.advanceCV = advanceUniformity(components);
  return {
    ...matchFromFeatures(source, text, forcedClass),
    italic: isItalic(mask, text, components),
  };
}

// Split out from matchWordFont so the family/weight half can be exercised
// directly by a test that supplies its own features, without needing an image.
function matchFromFeatures(source, text, forcedClass) {
  const probeText = text && text.length ? text : "Hamburgefonstiv";
  const sizePx = resolveProbeSize(probeText, source.boxHeight);
  const names = forcedClass ? [forcedClass] : candidateClasses(source);

  let best = null;
  let bestProportional = null;
  for (const name of names) {
    const family = FONT_CANDIDATES[name];
    if (!family) continue;
    const light = probeFeatures(probeText, family, PROBE_LIGHT, sizePx);
    const heavy = probeFeatures(probeText, family, PROBE_HEAVY, sizePx);
    if (!light) continue;
    const weight = interpolateWeight(source.stroke, light.stroke, heavy ? heavy.stroke : NaN);
    // Compared against whichever probe the chosen weight is nearer, so a bold
    // source is judged for family against a bold probe - serif flare and set
    // width both change with weight, and comparing a heavy source against a
    // regular probe would charge the family for a difference that is the
    // weight's.
    const reference = heavy && weight >= (PROBE_LIGHT + PROBE_HEAVY) / 2 ? heavy : light;
    const distance = familyDistance(source, reference);
    const candidate = { fontClass: name, weight, distance };
    if (!best || distance < best.distance) best = candidate;
    if (name !== "monospace" && (!bestProportional || distance < bestProportional.distance)) {
      bestProportional = candidate;
    }
  }
  if (!best) return { fontClass: forcedClass || "regular", weight: PROBE_LIGHT };
  // Monospace has to win by a MARGIN, not merely win. Two things make a bare
  // win untrustworthy for this one class. Its distinguishing feature is large -
  // a monospace face sets a lowercase string 40-60% wider than a proportional
  // one - so a monospace word that only just edges ahead is not a monospace
  // word, it is a tie being broken by noise. And the feature it CANNOT be told
  // apart by is serif-ness: Courier-descended faces are slab-serifed and score
  // 1.6-2.2 on serifRatio, right on top of a real serif face's 1.55-1.75, so
  // serif words are exactly what leaks into monospace when ties go unguarded.
  // Requiring a clear win costs some monospace recall and buys back most of the
  // sans/serif accuracy that admitting monospace as a candidate had cost.
  if (best.fontClass === "monospace" && bestProportional && best.distance * MONOSPACE_WIN_MARGIN > bestProportional.distance) {
    best = bestProportional;
  }
  return { fontClass: best.fontClass, weight: best.weight };
}

// The three-part italic rule above, applied. Ordered cheapest-first: the
// component count is one pass the mask has to make anyway, the de-shear search
// is fifteen.
function isItalic(mask, text, components) {
  if ((text || "").trim().length < ITALIC_MIN_CHARS) return false;
  if (components.length < ITALIC_MIN_COMPONENTS) return false;
  const { angle, gain } = slantOf(mask);
  return Math.abs(angle) >= ITALIC_MIN_DEG && gain >= ITALIC_MIN_GAIN;
}

// Exported for the gate in test/font-match.js, which drives the matcher against
// synthetic words whose family, weight and slant it chose itself.
export const __testing = {
  featuresOfMask,
  maskFromRegion,
  componentsOfMask,
  matchFromFeatures,
  slantOf,
  isItalic,
  ITALIC_MIN_DEG,
  ITALIC_MIN_GAIN,
  ITALIC_MIN_COMPONENTS,
  ITALIC_MIN_CHARS,
  advanceUniformity,
};
