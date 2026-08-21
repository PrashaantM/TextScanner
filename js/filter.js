// filter.js: three-level noise filter over OCR output. Pure functions only - no
// DOM, no mutation of the ocrWords it's given - so the same logic drives Text
// view's rendered text, Image format/Full image's per-word dimming, and
// Copy/Download/TTS's active text (all wired in via editor.js/main.js).
//
// - "raw": no filtering, exactly what Tesseract returned.
// - "symbol": strips pattern-obvious noise (pure punctuation, repeated-char
//   runs, mostly-symbol tokens) plus anything Tesseract itself was very
//   unsure about. Regex/confidence only, no semantic judgment - the default
//   level, since it's safe cleanup that can't plausibly eat real words.
// - "coherence": additionally strips lowercase words that are both absent
//   from the bundled common-word list AND recognized with middling
//   confidence. Deliberately narrow: anything with digits, punctuation,
//   hyphens, mixed/upper case, or under 3 letters is assumed to be a number,
//   abbreviation, or proper noun and is always kept, since silently dropping
//   correct text is worse than leaving an artifact in.
//
// A word the user has directly edited always passes every level - an explicit
// human edit is a stronger signal than any heuristic.

import { wordlist } from "./wordlist.js";

export const FILTER_LEVELS = ["raw", "symbol", "coherence"];
export const DEFAULT_FILTER_LEVEL = "symbol";

const SYMBOL_ONLY_RE = /^[^\w\s]+$/;
const REPEATED_CHAR_RE = /(.)\1{3,}/;
const NON_ALNUM_RATIO_THRESHOLD = 0.6;
// Well below LOW_CONFIDENCE_THRESHOLD (state.js's 65, used just to flag a word
// for the user to double-check) - this bar is for auto-hiding text entirely,
// so it only fires on recognitions Tesseract was almost certainly wrong about.
const SYMBOL_CONFIDENCE_THRESHOLD = 25;
const COHERENCE_CONFIDENCE_THRESHOLD = 75;
const COHERENCE_MIN_LENGTH = 3;
const LOWERCASE_WORD_RE = /^[a-z]+$/;
// A short all-caps token (COSC, MCQ, ...) reads as a genuine acronym far more
// often than as noise, and small/busy source images routinely give Tesseract
// low confidence on real acronyms just from print size, not because they're
// wrong - so these are exempted from the confidence-only strip below (the
// pattern-based checks above it still apply). Mirrors the same "mixed/upper
// case assumed to be a proper noun or abbreviation" reasoning isIncoherent
// already applies at the coherence level.
const UPPERCASE_ACRONYM_RE = /^[A-Z]{3,}$/;

function nonAlnumRatio(text) {
  const nonAlnum = text.replace(/[a-zA-Z0-9]/g, "").length;
  return nonAlnum / text.length;
}

function isSymbolNoise(text, confidence) {
  if (!text) return false;
  if (SYMBOL_ONLY_RE.test(text)) return true;
  if (REPEATED_CHAR_RE.test(text)) return true;
  if (nonAlnumRatio(text) > NON_ALNUM_RATIO_THRESHOLD) return true;
  if (UPPERCASE_ACRONYM_RE.test(text)) return false;
  if (typeof confidence === "number" && confidence < SYMBOL_CONFIDENCE_THRESHOLD) return true;
  return false;
}

function isIncoherent(text, confidence) {
  if (!LOWERCASE_WORD_RE.test(text)) return false; // digits/hyphens/mixed/upper case: kept by default
  if (text.length < COHERENCE_MIN_LENGTH) return false;
  if (wordlist.has(text)) return false;
  if (typeof confidence !== "number") return false; // unknown confidence: keep, don't guess
  return confidence < COHERENCE_CONFIDENCE_THRESHOLD;
}

// word: { text, confidence } (a plain ocrWords entry, or an equivalent shape
// built from a live editorObjects word). isUserEdited: true if this word's
// text was changed by the user (or it's a user-added object entirely) -
// always passes, regardless of level.
export function wordPasses(word, level, isUserEdited) {
  if (isUserEdited) return true;
  if (level === "raw" || !level) return true;
  const text = word.text || "";
  if (isSymbolNoise(text, word.confidence)) return false;
  if (level === "coherence" && isIncoherent(text, word.confidence)) return false;
  return true;
}

export function filterWords(words, level) {
  return words.filter((w) => wordPasses(w, level, false));
}

// Rebuilds display text from a flat, line-ordered ocrWords list (see
// ocrEngine.js) at the given filter level, grouping back into lines the same
// way textUtil.js's wordsToText does for the unfiltered case.
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
