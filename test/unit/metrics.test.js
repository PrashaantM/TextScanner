// Unit tests for test/metrics.js - the CER/WER numbers every phase of the
// completion plan is measured against. If these are wrong, every "this change
// helped" conclusion drawn from the benchmark is wrong with them, silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { characterErrorRate, wordErrorRate } from "../metrics.js";

const close = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: got ${actual}, expected ${expected}`);

test("identical strings score zero error", () => {
  close(characterErrorRate("hello world", "hello world"), 0, "CER");
  close(wordErrorRate("hello world", "hello world"), 0, "WER");
});

test("whitespace differences are normalized away, not counted as errors", () => {
  close(characterErrorRate("hello\n\nworld", "hello world"), 0, "CER across newlines");
  close(characterErrorRate("  hello   world  ", "hello world"), 0, "CER with padding");
  close(wordErrorRate("hello\nworld", "hello world"), 0, "WER across newlines");
});

test("CER counts single-character substitutions, insertions and deletions", () => {
  // "cat" -> "bat": one substitution over 3 reference chars.
  close(characterErrorRate("bat", "cat"), 1 / 3, "substitution");
  // "cat" -> "cats": one insertion.
  close(characterErrorRate("cats", "cat"), 1 / 3, "insertion");
  // "cat" -> "ca": one deletion.
  close(characterErrorRate("ca", "cat"), 1 / 3, "deletion");
});

test("WER operates on whole words, not characters", () => {
  // One wrong word out of four - a WER of 0.25 regardless of how many
  // characters differ inside that word.
  close(wordErrorRate("the quick brown dog", "the quick brown fox"), 1 / 4, "one wrong word");
  close(wordErrorRate("the quick brown elephants", "the quick brown fox"), 1 / 4, "length-independent");
});

test("CER can exceed 1 when the hypothesis is much longer than the reference", () => {
  // This is why the HANDOFF table shows numbers like 381% - not a bug, and the
  // metric must not be silently clamped, or a hallucinating engine would look
  // merely bad rather than catastrophic.
  const cer = characterErrorRate("aaaaaaaaaaaaaaaaaaaa", "a");
  assert.ok(cer > 1, `expected CER > 1 for a flood of spurious output, got ${cer}`);
});

test("empty reference: empty hypothesis is perfect, non-empty is fully wrong", () => {
  close(characterErrorRate("", ""), 0, "both empty CER");
  close(wordErrorRate("", ""), 0, "both empty WER");
  close(characterErrorRate("spurious", ""), 1, "hallucinated text CER");
  close(wordErrorRate("spurious", ""), 1, "hallucinated text WER");
});

test("empty hypothesis against a real reference scores total error", () => {
  close(characterErrorRate("", "hello"), 1, "nothing recognized CER");
  close(wordErrorRate("", "hello world"), 1, "nothing recognized WER");
});

test("edit distance is symmetric in cost but normalized by the reference", () => {
  // Deliberate asymmetry: the denominator is always the ground truth's length,
  // so the same edit distance means different rates depending on direction.
  const short = characterErrorRate("abcdef", "abc"); // 3 insertions / 3 ref chars
  const long = characterErrorRate("abc", "abcdef"); // 3 deletions / 6 ref chars
  close(short, 1, "insertions against a short reference");
  close(long, 0.5, "deletions against a long reference");
});
