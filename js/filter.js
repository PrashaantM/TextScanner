// filter.js: pure functions over OCR output for the Raw and Filtered Text
// levels. No DOM, no mutation of the ocrWords it's given - so the same logic
// drives Text view's rendered text, Image format/Full image's per-word
// dimming, and Copy/Download/TTS's active text (all wired in via
// the editor modules/main.js).
//
// - "raw": no filtering, exactly what Tesseract returned - every
//   character/word/symbol the engine detected as text-like, unfiltered.
// - "filtered": strips OCR noise, garbage tokens, and misrecognized artifacts
//   Tesseract itself was very unsure about, while keeping anything a human
//   would consider meaningful content - complete words, and standalone
//   letters/numbers/symbols that are legitimately part of the content (a
//   price, a phone number, a single initial). This is a cleanup/denoising
//   pass on the raw output, not a rewrite: regex/confidence-shape checks
//   only, no semantic judgment about whether a correctly-recognized word
//   "belongs."
//
// The third level, Coherence Filter, is NOT handled here - it's a generative
// LLM reconstruction of the Filtered Text output into readable prose (see
// js/coherence.js), not a selection over ocrWords, so it doesn't fit this
// module's "which words pass" model at all.
//
// A word the user has directly edited always passes every level - an explicit
// human edit is a stronger signal than any heuristic.

const SYMBOL_ONLY_RE = /^[^\w\s]+$/;
const REPEATED_CHAR_RE = /(.)\1{3,}/;
const NON_ALNUM_RATIO_THRESHOLD = 0.6;
// Well below state.js's LOW_CONFIDENCE_THRESHOLD (65, used just to flag a word
// for the user to double-check) - this bar is for auto-hiding text entirely,
// so it only fires on recognitions Tesseract was almost certainly wrong about.
const NOISE_CONFIDENCE_THRESHOLD = 25;
// A short all-caps token (COSC, MCQ, ...) reads as a genuine acronym far more
// often than as noise, and small/busy source images routinely give Tesseract
// low confidence on real acronyms just from print size, not because they're
// wrong - so these are exempted from the confidence-only strip below (the
// pattern-based checks above it still apply).
const UPPERCASE_ACRONYM_RE = /^[A-Z]{3,}$/;

function nonAlnumRatio(text) {
  const nonAlnum = text.replace(/[a-zA-Z0-9]/g, "").length;
  return nonAlnum / text.length;
}

function isNoise(text, confidence) {
  if (!text) return false;
  if (SYMBOL_ONLY_RE.test(text)) return true;
  if (REPEATED_CHAR_RE.test(text)) return true;
  if (nonAlnumRatio(text) > NON_ALNUM_RATIO_THRESHOLD) return true;
  if (UPPERCASE_ACRONYM_RE.test(text)) return false;
  if (typeof confidence === "number" && confidence < NOISE_CONFIDENCE_THRESHOLD) return true;
  return false;
}

// word: { text, confidence } (a plain ocrWords entry, or an equivalent shape
// built from a live editorObjects word). isUserEdited: true if this word's
// text was changed by the user (or it's a user-added object entirely) -
// always passes, regardless of level. level "coherence" is treated the same
// as "filtered" here (the underlying word-level view, e.g. Image format
// dimming, has no other sensible fallback while a generative reconstruction
// is showing in Text view - see editorObjects.js/main.js).
export function wordPasses(word, level, isUserEdited) {
  if (isUserEdited) return true;
  if (level === "raw" || !level) return true;
  return !isNoise(word.text || "", word.confidence);
}

// Rebuilds display text from a flat, line-ordered ocrWords list (see
// ocrEngine.js) at the given filter level, grouping back into lines. Calling
// this with level "raw" is also how the app gets its unfiltered plain-text
// view - wordPasses always passes everything at that level, so no separate
// helper is needed just for the raw case.
export function wordsToFilteredText(words, level) {
  const lines = [];
  let currentLineIndex = null;
  let current = [];

  words.forEach((word) => {
    if (word.lineIndex !== currentLineIndex) {
      if (current.length) lines.push(current.join(" "));
      current = [];
      currentLineIndex = word.lineIndex;
    }
    if (wordPasses(word, level, false)) current.push(word.text);
  });
  if (current.length) lines.push(current.join(" "));

  return lines.join("\n").trim();
}
