// transcriptAlign.js: the answer to "a vision model returns a transcript and no
// per-word bounding boxes, and this app is built entirely on per-word boxes".
//
// THE PROBLEM THIS EXISTS TO SOLVE, stated before the algorithm.
//
// README.md's front page argues that every recognized word becomes an object you
// can retype, move, resize and delete with the pixels underneath repaired. That
// is a claim about GEOMETRY: js/editorObjects.js's renderImageFormatView places a
// span at `x0 / naturalWidth * 100`, js/fontMatch.js measures the crop inside the
// box, js/inpaint.js repairs the rectangle the box vacates. None of it has
// anything to anchor to without a per-word box.
//
// A vision model reads this corpus far better than Tesseract does and returns a
// flat transcript. Sending the image and using the text produces perfect
// characters and an editor with nothing in it. That is the SAME defect that
// closed the PaddleOCR bake-off
// (test/research/paddle-bakeoff/paddleocr-bakeoff.md: 10 boxes for 30 words, a
// median per-word centre error of 105.6 px against Tesseract's 0.4 px) except
// worse, because PP-OCR at least returned line polygons and a transcript returns
// no geometry at all.
//
// THE RESOLUTION: the local engine keeps its job, and it is not recognition.
//
// Tesseract is demonstrably good at exactly the thing the model cannot do. The
// same bake-off measured its word boxes at 0.835 mean IoU, 25/30 words over 0.5
// IoU, and a median centre error of 0.4 px on a 1024x1536 image. It is bad at
// READING (41.6% macro CER) and excellent at FINDING. So this module keeps the
// box and takes the model's text: local geometry, model characters, aligned onto
// one another.
//
// WHY NOT LINE-LEVEL OBJECTS ON CLOUD SCANS, which is the simpler alternative.
// Because it is visibly worse at the one thing the app is for, and the bake-off
// already measured how much worse. complexPic4 holds 214 Tesseract word boxes
// and 31 PP-OCR line boxes - 6.61 words per box. An editor where retyping "the"
// means retyping the whole line, and where deleting one word inpaints six, is
// not the product README.md describes. Line objects are what this module falls
// back to for regions the local engine never saw, and nowhere else.
//
// ---------------------------------------------------------------------------
// WHAT THE ALIGNMENT DOES WHEN THE TWO DISAGREE ABOUT HOW MANY WORDS THERE ARE.
//
// This is the case that decides whether the idea works, because the two engines
// disagree constantly - it is why the model is worth calling at all. ONE global
// alignment runs over the two word sequences in reading order, and walking it
// reduces every disagreement to one of four shapes. `a` is how many local boxes
// a block holds, `b` how many model tokens:
//
//   a == b (and 1:1)   Keep each box, take each model token. The common case,
//                      and the only one where nothing is estimated.
//
//   a > 0, b > 0,      Union the block's local boxes and split that union among
//   a != b             the b model tokens in proportion to their character
//                      counts. This is one rule covering both directions:
//                      Tesseract merging "BUILDING D" into one box and the model
//                      reading two words (split), and Tesseract splitting one
//                      word into three fragments the model reads as one (merge).
//                      Every resulting box lies inside real ink that the local
//                      engine actually found; only the boundary between them is
//                      estimated, and it is estimated from the text itself.
//
//   a > 0, b == 0      The model declined to transcribe something Tesseract
//                      boxed. Dropped. This is the filtering signal the bake-off
//                      identified without being able to use: Tesseract emits 166%
//                      and 143% CER on complexPic10/11 - it writes more than
//                      exists - and a second reader that sees nothing there is
//                      evidence, not silence.
//
//   a == 0, b > 0      The model read text with no local box anywhere near it.
//                      No geometry exists. See the next block.
//
// ---------------------------------------------------------------------------
// THE REGIONS THE LOCAL ENGINE NEVER DETECTED, which need an explicit decision.
//
// They are not hypothetical and they are not rare: test/region-coverage.js pins
// two of complexPic1's nine areas at maxCer 1.0 - `popsicles` and `date-panel`,
// "still not recognized at all". A model reads both. There is no box for either.
//
// The choice is between dropping the text and placing it coarsely, and this
// module places it coarsely, as a LINE object, positioned by interpolation
// between the lines around it that DO have boxes (with the image's own top and
// bottom edge as the outer anchors, so every unmatched line is bracketed by
// construction). Three reasons, in order of weight:
//
//   1. Dropping silently loses text the app successfully read. The transcript is
//      the scan's primary output - Text view, Copy, Download, TTS and the
//      Coherence Filter all consume it - and an editor limitation is not a
//      reason to withhold it.
//   2. The coarseness is BOUNDED to the regions that caused it. This is the
//      material difference from the PaddleOCR outcome, where line granularity
//      applied to the whole image including the 214-word page. Here every word
//      the local engine found keeps its own measured box, and only what it
//      missed is coarse.
//   3. It is flagged rather than presented as equivalent. A word on an
//      interpolated box carries INFERRED_PLACEMENT_CONFIDENCE (see below) so the
//      editor's existing low-confidence underline and its
//      "low confidence, worth checking" aria hint land on exactly the objects
//      whose POSITION is a guess - and on nothing else.
//
// The residual risk, stated rather than buried: on an image where local
// recognition finds almost nothing, most objects are coarse and the editor
// degrades to line-level THERE. That is the failure mode this whole module is
// arguing against, and the honest position is that it is bounded to the case
// where the alternative was no text at all.
//
// ---------------------------------------------------------------------------
// CONFIDENCE. A model returns no per-word confidence, and this does not invent
// one.
//
// js/mlkitEngine.js hit this first and set the precedent: ML Kit reports no
// per-word score, so every word's confidence is `null` - "explicitly absent, not
// a number" - and js/recognize.js's engineProvidesConfidence() returns false so
// the UI states the absence instead of letting a missing underline read as "every
// word scored perfectly". A vision model is in exactly that position and gets
// exactly that treatment: `null`, and engineProvidesConfidence() false.
//
// The ONE exception is the interpolated line objects above, and it is not a
// confidence score - it is a deliberate use of the one channel the editor
// already reads. The value sits in the band between two existing thresholds,
// which is the entire reason for the number chosen:
//
//   js/filter.js       NOISE_CONFIDENCE_THRESHOLD     25   below -> auto-hidden
//   js/state.js        LOW_CONFIDENCE_THRESHOLD       65   below -> underlined
//
// 50 is between them, so an interpolated word is flagged for a human to check
// and is NOT stripped from Filtered Text, Copy or TTS. Picking 20 would delete
// the text this module went to the trouble of keeping; picking 80 would present
// a guessed position as a measured one.

// ---------------------------------------------------------------------------
// THE SCORING MODEL, AND THE MEASUREMENT THAT FORCED IT.
//
// The first version of this file matched LINES by text similarity, with a floor
// below which two lines were left unpaired. It was measured on the corpus before
// anything was claimed for it, and it failed in exactly the place the whole idea
// has to work: 58.2% of all placed words fell back to an interpolated box, and on
// complexPic3 - the densest image in the corpus - 92.9% did, 403 of 434 words.
//
// The cause is worth writing down because it is the trap this design is most
// exposed to. Matching on text asks the LOCAL engine's reading to be good enough
// to recognise, and on the images where a model is worth calling, it is not:
// complexPic3's local CER is 79.1%, so a local line and the model's reading of
// the same line share almost no characters, score ~0 similarity, and are left
// unpaired. The engine that is supposed to be a word LOCATOR was being required
// to be a READER before its boxes could be used - which defeats the premise.
//
// So the alignment is driven by READING ORDER, with text as refinement rather
// than as a gate. Both sequences describe the same page in the same order, so a
// monotonic correspondence between them is the prior; global alignment enforces
// monotonicity by construction, and BASE_MATCH_CREDIT makes pairing worth
// something even when the two readings share no characters at all. Where text
// similarity does exist it dominates and snaps the correspondence to the right
// place; where it does not, position still carries it.
//
// It is also now ONE alignment over words rather than two nested ones. The line
// pass was what made an unmatched line lose all of its words at once; removing it
// means a local box can only be lost on its own evidence.
//
// Every pairing is worth at least this much, before similarity. It must be
// positive, or two gaps (scoring 0) beat any pair the text cannot vouch for -
// which is the defect above. Its exact value does not change the ORDER of the
// correspondence, only how readily surplus tokens on one side are left unpaired,
// because similarity is added on top and dominates wherever it exists.
const BASE_MATCH_CREDIT = 0.25;
// How much a real text agreement is worth relative to that credit. Similarity
// runs 0..1, so an exact match outscores the credit fourfold and a correspondence
// the text can vouch for always wins over one only position suggests.
const SIMILARITY_WEIGHT = 1.0;
// Below this bigram overlap, two strings are treated as completely dissimilar
// without computing an edit distance at all. Purely a cost guard: the line pass
// is O(local lines x model lines) and complexPic3 holds several hundred of each,
// so the prefilter is what keeps a dense page from spending seconds here. It can
// only make a pair score LOWER than the real similarity, and the floors above
// are far higher than this, so it cannot change which pairs match.
const BIGRAM_PREFILTER = 0.12;
// See the CONFIDENCE block above. Deliberately between js/filter.js's
// NOISE_CONFIDENCE_THRESHOLD (25) and js/state.js's LOW_CONFIDENCE_THRESHOLD (65).
export const INFERRED_PLACEMENT_CONFIDENCE = 50;

// ---------------------------------------------------------------------------
// String similarity.

function normalizeForCompare(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Plain Levenshtein, two rows. Deliberately NOT imported from test/metrics.js:
// this file ships to the browser and test/ does not, and the two are measuring
// different things anyway (that one scores a hypothesis against ground truth,
// this one asks whether two readings are of the same thing).
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  if (!set.size && text.length) set.add(text);
  return set;
}

// 0..1. 1 means identical after normalization.
function similarity(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;

  // Cheap rejection before the quadratic part - see BIGRAM_PREFILTER.
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const g of bx) if (by.has(g)) shared++;
  const jaccard = shared / (bx.size + by.size - shared);
  if (jaccard < BIGRAM_PREFILTER) return 0;

  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

// ---------------------------------------------------------------------------
// Global sequence alignment (Needleman-Wunsch) over two arrays, scored by a
// caller-supplied similarity and a floor.
//
// Gap score is 0 and a match scores `similarity - floor`, so a pair is only ever
// aligned when it is more similar than the floor - otherwise two gaps score
// higher and the pair is left unmatched. That is the single knob, and it is what
// makes "the local engine never saw this line" representable rather than being
// smeared onto whichever line happens to be nearest.
//
// Returns a list of { aIndex, bIndex } where either may be -1 for a gap, in
// sequence order.
function alignSequences(a, b, score) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  // 0 = diagonal (pair), 1 = up (a-gap), 2 = left (b-gap)
  const back = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  for (let i = 1; i <= n; i++) back[i][0] = 1;
  for (let j = 1; j <= m; j++) back[0][j] = 2;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + score(a[i - 1], b[j - 1]);
      const up = dp[i - 1][j];
      const left = dp[i][j - 1];
      if (diag >= up && diag >= left) {
        dp[i][j] = diag;
        back[i][j] = 0;
      } else if (up >= left) {
        dp[i][j] = up;
        back[i][j] = 1;
      } else {
        dp[i][j] = left;
        back[i][j] = 2;
      }
    }
  }

  const out = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = back[i][j];
    if (move === 0) out.push({ aIndex: --i, bIndex: --j });
    else if (move === 1) out.push({ aIndex: --i, bIndex: -1 });
    else out.push({ aIndex: -1, bIndex: --j });
  }
  out.reverse();
  return out;
}

// ---------------------------------------------------------------------------
// Geometry helpers.

function unionBox(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

// Splits one box horizontally among `weights`, proportional to each weight.
//
// Horizontally and not by any cleverer rule, because the union being split is a
// run of words on ONE line - the word pass only ever groups tokens inside a
// single matched line pair, so a vertical split would never be right. Weight is
// character count, which is the best available proxy for how much of the line's
// width each token occupies without re-measuring the pixels.
function splitBoxByWeights(box, weights) {
  const total = weights.reduce((s, w) => s + w, 0) || weights.length;
  const width = box.x1 - box.x0;
  const out = [];
  let cursor = box.x0;
  for (let i = 0; i < weights.length; i++) {
    const share = (weights[i] || 1) / total;
    const next = i === weights.length - 1 ? box.x1 : cursor + width * share;
    out.push({ x0: cursor, y0: box.y0, x1: next, y1: box.y1 });
    cursor = next;
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------

// Turns a model transcript into lines. Blank lines are dropped rather than kept
// as empty ones: they carry paragraph structure the app has no way to render and
// would align against nothing.
function transcriptLines(transcript) {
  return (transcript || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Precomputes each token's normalized form and bigram set once, so the O(n*m)
// alignment below does no string allocation in its inner loop. On complexPic3
// that loop runs ~500k times; doing the normalization inside it was the
// difference between milliseconds and seconds.
function prepareTokens(texts) {
  return texts.map((text) => {
    const norm = normalizeForCompare(text);
    return { text, norm, grams: bigrams(norm) };
  });
}

// Similarity between two PREPARED tokens. Same definition as similarity(), with
// the normalization and bigram sets hoisted out.
function preparedSimilarity(a, b) {
  if (!a.norm && !b.norm) return 1;
  if (!a.norm || !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  let shared = 0;
  for (const g of a.grams) if (b.grams.has(g)) shared++;
  const union = a.grams.size + b.grams.size - shared;
  if (union > 0 && shared / union < BIGRAM_PREFILTER) return 0;
  return 1 - editDistance(a.norm, b.norm) / Math.max(a.norm.length, b.norm.length);
}

// Walks a word-level alignment into blocks bounded by 1:1 matches, so a run of
// disagreement is handled as one unit rather than token by token. See the
// four-shapes table in this file's header.
function blocksFromWordAlignment(pairs) {
  const blocks = [];
  let pending = { localIndices: [], modelIndices: [] };
  const flushPending = () => {
    if (pending.localIndices.length || pending.modelIndices.length) blocks.push({ ...pending, exact: false });
    pending = { localIndices: [], modelIndices: [] };
  };

  for (const { aIndex, bIndex } of pairs) {
    if (aIndex >= 0 && bIndex >= 0) {
      flushPending();
      blocks.push({ localIndices: [aIndex], modelIndices: [bIndex], exact: true });
      continue;
    }
    if (aIndex >= 0) pending.localIndices.push(aIndex);
    else pending.modelIndices.push(bIndex);
  }
  flushPending();
  return blocks;
}

// True when two boxes sit on the same text line closely enough that unioning
// them describes a real run of ink rather than a rectangle spanning half the
// page. A block's local boxes are contiguous in reading order, but reading order
// can still step from the end of one line to the start of the next, and unioning
// across that step produces a box covering everything in between.
function onSameRun(a, b) {
  const aHeight = a.y1 - a.y0;
  const bHeight = b.y1 - b.y0;
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return overlap > Math.min(aHeight, bHeight) * 0.5;
}

// Splits a block's local boxes into runs that each lie on one line, so the
// union-and-split rule never spans a line break.
function splitIntoRuns(boxes, localIndices) {
  const runs = [];
  boxes.forEach((box, i) => {
    const current = runs[runs.length - 1];
    if (current && onSameRun(current.boxes[current.boxes.length - 1], box)) {
      current.boxes.push(box);
      current.localIndices.push(localIndices[i]);
    } else {
      runs.push({ boxes: [box], localIndices: [localIndices[i]] });
    }
  });
  return runs;
}

/**
 * Aligns a model transcript onto locally-recognized word geometry.
 *
 * @param localWords flat { lineIndex, text, confidence, bbox } list from
 *        js/ocrEngine.js - the geometry source.
 * @param transcript the model's plain-text reading of the same image.
 * @param imageWidth/imageHeight the original-image pixel space every bbox is in.
 * @returns { words, stats } - `words` in the SAME flat shape the caller was
 *          already handed, so js/main.js's call site is untouched.
 */
export function alignTranscriptToWords(localWords, transcript, imageWidth, imageHeight) {
  const modelLines = transcriptLines(transcript);
  const stats = {
    localWords: localWords.length,
    modelLines: modelLines.length,
    droppedLocalWords: 0,
    placedWords: 0,
    inferredWords: 0,
    inferredLines: 0,
  };

  // No transcript at all: nothing to align onto. The caller treats this as a
  // failed cloud pass and keeps the local result.
  if (!modelLines.length) return { words: [], stats };

  // Flatten the transcript to tokens, remembering which line each came from -
  // that line index is what the output's lineIndex is rebuilt from, so the
  // model's own line structure survives the alignment intact.
  const modelTokens = [];
  modelLines.forEach((line, lineNo) => {
    for (const text of line.split(/\s+/).filter(Boolean)) modelTokens.push({ text, lineNo });
  });
  if (!modelTokens.length) return { words: [], stats };

  const localPrepared = prepareTokens(localWords.map((w) => w.text));
  const modelPrepared = prepareTokens(modelTokens.map((t) => t.text));

  // ONE global alignment over the two word sequences, in reading order. See the
  // SCORING MODEL block at the top of this file for why pairing carries a base
  // credit rather than having to clear a similarity floor.
  const pairs = localWords.length
    ? alignSequences(localPrepared, modelPrepared, (a, b) => BASE_MATCH_CREDIT + SIMILARITY_WEIGHT * preparedSimilarity(a, b))
    : modelPrepared.map((_, bIndex) => ({ aIndex: -1, bIndex }));

  // Walk the alignment into placements. `bbox: null` means "no local ink was
  // available here"; pass 2 interpolates those from their neighbours.
  const placed = [];
  const dropped = [];
  for (const block of blocksFromWordAlignment(pairs)) {
    const boxes = block.localIndices.map((i) => localWords[i].bbox);
    const tokens = block.modelIndices.map((i) => modelTokens[i]);

    // a > 0, b == 0: the model declined to confirm something the local engine
    // boxed. Dropped - see the four-shapes table in the header. Recorded rather
    // than discarded outright, because the absorb pass below has to be able to
    // tell "the model saw nothing here" from "the model spelled this and its
    // neighbour as one token".
    if (!tokens.length) {
      for (const localIndex of block.localIndices) dropped.push(localIndex);
      continue;
    }

    // a == 0, b > 0: no local ink. Recorded as a hole for pass 2.
    if (!boxes.length) {
      for (const token of tokens) placed.push({ text: token.text, lineNo: token.lineNo, bbox: null, localIndices: [] });
      continue;
    }

    // a == b == 1: keep the measured box exactly as the local engine found it.
    if (block.exact) {
      placed.push({ text: tokens[0].text, lineNo: tokens[0].lineNo, bbox: boxes[0], localIndices: [block.localIndices[0]] });
      continue;
    }

    // a == b > 1: pair them off, each token on its own measured box.
    if (boxes.length === tokens.length) {
      tokens.forEach((token, i) => placed.push({ text: token.text, lineNo: token.lineNo, bbox: boxes[i], localIndices: [block.localIndices[i]] }));
      continue;
    }

    // a > 0, b > 0, a != b: union and split proportionally by character count -
    // one rule covering both a merge and a split. Done per line-run, so a block
    // that happens to straddle a line break never produces a box spanning both.
    const runs = splitIntoRuns(boxes, block.localIndices);
    const totalChars = tokens.reduce((sum, t) => sum + t.text.length, 0) || tokens.length;
    let cursor = 0;
    runs.forEach((run, runIndex) => {
      const share = runIndex === runs.length - 1 ? tokens.length - cursor : Math.max(1, Math.round((tokens.length * run.boxes.length) / boxes.length));
      const slice = tokens.slice(cursor, cursor + share);
      cursor += slice.length;
      if (!slice.length) return;
      const split = splitBoxByWeights(unionBox(run.boxes), slice.map((t) => t.text.length || 1));
      slice.forEach((token, i) => placed.push({ text: token.text, lineNo: token.lineNo, bbox: split[i], localIndices: run.localIndices }));
    });
    // Anything left over (rounding, or fewer runs than tokens) still has to be
    // emitted rather than silently dropped - it becomes a hole for pass 2.
    for (let i = cursor; i < tokens.length; i++) {
      placed.push({ text: tokens[i].text, lineNo: tokens[i].lineNo, bbox: null, localIndices: [] });
    }
    void totalChars;
  }

  // Pass 2: interpolate the holes, one coarse LINE object per run of holes that
  // share a transcript line. The image's own top and bottom edges act as the
  // outer anchors, so a hole at the very start or end of the transcript is
  // bracketed exactly like one in the middle rather than needing its own rule.
  const anchorBoxes = placed.filter((p) => p.bbox).map((p) => p.bbox);
  const lineHeight = anchorBoxes.length
    ? median(anchorBoxes.map((b) => b.y1 - b.y0))
    : Math.max(8, imageHeight * 0.02);
  const columnX0 = anchorBoxes.length ? Math.min(...anchorBoxes.map((b) => b.x0)) : imageWidth * 0.05;
  const columnX1 = anchorBoxes.length ? Math.max(...anchorBoxes.map((b) => b.x1)) : imageWidth * 0.95;

  // ABSORB: a dropped local box that sits immediately beside a kept one, on the
  // same text line, is covered by the kept word's box rather than discarded.
  //
  // THE DEFECT THIS FIXES, caught by test/unit/transcript-align.test.js rather
  // than by reading the code. Local "TEXT" + "SCANNER" against a model reading
  // "TEXTSCANNER" aligns SCANNER<->TEXTSCANNER as a 1:1 pair - it is the more
  // similar of the two - and leaves TEXT with nothing, so it was dropped. The
  // text output was right and the GEOMETRY was wrong in the way that matters
  // most here: js/inpaint.js repairs the rectangle a word's box vacates, so
  // retyping that word would have painted over "SCANNER" and left "TEXT" sitting
  // in the photograph underneath it.
  //
  // The rule distinguishes the two reasons a local box ends up unmatched.
  // Isolated, it means the model looked and saw nothing - that is the filtering
  // signal the PaddleOCR bake-off identified, and it is kept. Immediately
  // adjacent to a kept word on the same line, it means the model spelled that
  // ink as part of its neighbour, and the neighbour's box has to cover it.
  const droppedSet = new Set(dropped);
  for (const localIndex of dropped) {
    const neighbour = placed.find((p) => p.bbox && p.localIndices.some((i) => i === localIndex - 1 || i === localIndex + 1));
    if (!neighbour) continue;
    const box = localWords[localIndex].bbox;
    if (!onSameRun(neighbour.bbox, box)) continue;
    neighbour.bbox = unionBox([neighbour.bbox, box]);
    neighbour.localIndices.push(localIndex);
    droppedSet.delete(localIndex);
  }
  stats.droppedLocalWords = droppedSet.size;

  // The same-line fill FIRST, token by token, because it is not a missed region
  // at all: a token the model read BETWEEN two words the local engine did place,
  // on the same line. Tesseract merging "BUILDING D" into one box, or dropping a
  // short word between two it found, both land here. The ink is physically in
  // the gap between those two boxes and both ends of that gap are real
  // measurements - so this is a placement, not an inference, and it is NOT
  // flagged.
  for (let i = 0; i < placed.length; i++) {
    if (placed[i].bbox) continue;
    const prev = placed[i - 1];
    const next = placed[i + 1];
    if (prev?.bbox && next?.bbox && onSameRun(prev.bbox, next.bbox) && next.bbox.x0 > prev.bbox.x1) {
      placed[i].bbox = {
        x0: prev.bbox.x1,
        y0: Math.min(prev.bbox.y0, next.bbox.y0),
        x1: next.bbox.x0,
        y1: Math.max(prev.bbox.y1, next.bbox.y1),
      };
    }
  }

  // Then the genuinely missed regions, a RUN at a time rather than a token at a
  // time. Per token was tried and is wrong: two words of one missed line each
  // took their own vertical slot and stacked on top of each other, when they are
  // one line of text and belong side by side on one line box. So a run is split
  // into its transcript lines, each line gets a vertical slot in the gap between
  // the surrounding real boxes, and that line's box is split horizontally among
  // its own tokens by character count - the same rule the union-and-split case
  // uses, for the same reason.
  let i = 0;
  while (i < placed.length) {
    if (placed[i].bbox) {
      i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < placed.length - 1 && !placed[runEnd + 1].bbox) runEnd++;

    const before = placed.slice(0, i).reverse().find((p) => p.bbox);
    const after = placed.slice(runEnd + 1).find((p) => p.bbox);
    const top = before ? before.bbox.y1 : 0;
    const bottom = after ? after.bbox.y0 : imageHeight;

    // Group the run's tokens by the transcript line they came from, preserving
    // order.
    const lineGroups = [];
    for (let k = i; k <= runEnd; k++) {
      const group = lineGroups[lineGroups.length - 1];
      if (group && group.lineNo === placed[k].lineNo) group.tokens.push(placed[k]);
      else lineGroups.push({ lineNo: placed[k].lineNo, tokens: [placed[k]] });
    }

    // A degenerate or inverted gap (overlapping neighbours) still has to produce
    // a box, so fall back to stacking one line height below the upper anchor.
    const span = bottom - top > lineHeight * lineGroups.length ? (bottom - top) / lineGroups.length : lineHeight;
    lineGroups.forEach((group, slot) => {
      const y0 = Math.min(top + span * slot, Math.max(0, imageHeight - lineHeight));
      const lineBox = {
        x0: columnX0,
        y0,
        x1: columnX1,
        y1: Math.min(y0 + Math.min(span, lineHeight * 1.5), imageHeight),
      };
      const split = splitBoxByWeights(lineBox, group.tokens.map((t) => t.text.length || 1));
      group.tokens.forEach((token, n) => {
        token.bbox = split[n];
        token.inferred = true;
      });
    });

    i = runEnd + 1;
  }

  // Flatten, assigning a fresh sequential lineIndex per transcript line exactly
  // as js/ocrEngine.js's flattenRegions does. The order is the MODEL's reading
  // order, which is the order the transcript arrived in - and on the scene-text
  // images this path exists for, a better reading order than the local engine's
  // block sort.
  const words = [];
  let lineIndex = -1;
  let lastLineNo = null;
  const countedInferredLines = new Set();
  for (const p of placed) {
    if (p.lineNo !== lastLineNo) {
      lineIndex++;
      lastLineNo = p.lineNo;
    }
    words.push({ lineIndex, text: p.text, confidence: p.inferred ? INFERRED_PLACEMENT_CONFIDENCE : null, bbox: p.bbox });
    if (p.inferred) {
      stats.inferredWords++;
      countedInferredLines.add(p.lineNo);
    } else {
      stats.placedWords++;
    }
  }
  stats.inferredLines = countedInferredLines.size;

  return { words, stats };
}
