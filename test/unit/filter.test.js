// Unit tests for js/filter.js - the Raw/Filtered Text predicates. Phase 3 tunes
// recognition thresholds around these, so their exact boundaries need to be
// pinned down rather than rediscovered by eye in the UI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { wordPasses, wordsToFilteredText } from "../../js/filter.js";

const word = (text, confidence = 90) => ({ text, confidence });

test("raw level passes everything, including obvious noise", () => {
  assert.equal(wordPasses(word("hello"), "raw"), true);
  assert.equal(wordPasses(word("|||"), "raw"), true);
  assert.equal(wordPasses(word("~~~~", 2), "raw"), true);
});

test("a missing level is treated as raw", () => {
  assert.equal(wordPasses(word("|||"), undefined), true);
  assert.equal(wordPasses(word("|||"), null), true);
});

test("filtered level strips symbol-only tokens", () => {
  assert.equal(wordPasses(word("|||"), "filtered"), false);
  assert.equal(wordPasses(word("~~~"), "filtered"), false);
  assert.equal(wordPasses(word("hello"), "filtered"), true);
});

test("filtered level strips runs of 4+ repeated characters", () => {
  // 3 repeats is a real word ("aaa" appears in real text); 4+ is OCR noise.
  assert.equal(wordPasses(word("aaaa"), "filtered"), false);
  assert.equal(wordPasses(word("looooong"), "filtered"), false);
  assert.equal(wordPasses(word("aaa"), "filtered"), true);
});

test("filtered level strips tokens that are mostly non-alphanumeric", () => {
  assert.equal(wordPasses(word("a#$%^"), "filtered"), false); // 4/5 non-alnum
  assert.equal(wordPasses(word("$19.99"), "filtered"), true); // a real price survives
  assert.equal(wordPasses(word("(555)"), "filtered"), true); // a phone fragment survives
});

test("filtered level strips very-low-confidence recognitions", () => {
  assert.equal(wordPasses(word("wobble", 10), "filtered"), false);
  assert.equal(wordPasses(word("wobble", 30), "filtered"), true);
  // The bar for auto-hiding (25) sits well below the bar for flagging (65),
  // so a merely uncertain word is still shown, just marked.
  assert.equal(wordPasses(word("wobble", 24), "filtered"), false);
  assert.equal(wordPasses(word("wobble", 25), "filtered"), true);
});

test("short all-caps acronyms are exempt from the confidence strip", () => {
  // Small print routinely gives Tesseract low confidence on genuine acronyms.
  assert.equal(wordPasses(word("COSC", 5), "filtered"), true);
  assert.equal(wordPasses(word("MCQ", 5), "filtered"), true);
  // ...but the exemption is confidence-only. Pattern noise still fails.
  assert.equal(wordPasses(word("AAAA", 5), "filtered"), false); // repeated-char rule
  // ...and it doesn't extend to two-letter or mixed-case tokens.
  assert.equal(wordPasses(word("AB", 5), "filtered"), false);
  assert.equal(wordPasses(word("Cosc", 5), "filtered"), false);
});

test("a user-edited word passes every level regardless of content", () => {
  assert.equal(wordPasses(word("|||", 1), "filtered", true), true);
  assert.equal(wordPasses(word("", 1), "filtered", true), true);
});

test("an empty word is not treated as noise", () => {
  // isNoise returns false for empty text, so a deleted word doesn't get
  // double-handled as a filter decision.
  assert.equal(wordPasses(word(""), "filtered"), true);
});

test("coherence level filters identically to filtered", () => {
  // filter.js deliberately treats them the same: the coherence reconstruction
  // is generative and can't be mapped back to individual words, so the
  // word-level dimming falls back to Filtered Text.
  assert.equal(wordPasses(word("|||"), "coherence"), false);
  assert.equal(wordPasses(word("hello"), "coherence"), true);
});

test("wordsToFilteredText regroups a flat word list back into lines", () => {
  const words = [
    { lineIndex: 0, text: "hello", confidence: 90 },
    { lineIndex: 0, text: "world", confidence: 90 },
    { lineIndex: 1, text: "second", confidence: 90 },
    { lineIndex: 1, text: "line", confidence: 90 },
  ];
  assert.equal(wordsToFilteredText(words, "raw"), "hello world\nsecond line");
});

test("wordsToFilteredText drops filtered words but keeps their line", () => {
  const words = [
    { lineIndex: 0, text: "real", confidence: 90 },
    { lineIndex: 0, text: "|||", confidence: 90 },
    { lineIndex: 1, text: "~~~~", confidence: 90 },
    { lineIndex: 2, text: "text", confidence: 90 },
  ];
  // Line 1 becomes empty and is dropped entirely rather than left as a blank line.
  assert.equal(wordsToFilteredText(words, "filtered"), "real\ntext");
  assert.equal(wordsToFilteredText(words, "raw"), "real |||\n~~~~\ntext");
});

test("wordsToFilteredText handles an empty word list", () => {
  assert.equal(wordsToFilteredText([], "filtered"), "");
  assert.equal(wordsToFilteredText([], "raw"), "");
});

test("wordsToFilteredText starts a new line whenever lineIndex changes", () => {
  // ML Kit and Tesseract both emit sequential line indices, but the grouping
  // keys off "changed", not "incremented" - so a repeated index after a gap
  // still opens a new line rather than merging into the earlier one.
  const words = [
    { lineIndex: 0, text: "a", confidence: 90 },
    { lineIndex: 1, text: "b", confidence: 90 },
    { lineIndex: 0, text: "c", confidence: 90 },
  ];
  assert.equal(wordsToFilteredText(words, "raw"), "a\nb\nc");
});
