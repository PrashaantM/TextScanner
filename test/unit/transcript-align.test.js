// transcript-align.test.js: the four disagreement shapes js/transcriptAlign.js
// reduces every local-vs-model mismatch to, plus the two invariants the rest of
// the app depends on.
//
// WHY THESE ARE UNIT TESTS AND NOT PART OF A BROWSER GATE. This module is pure -
// two arrays in, one array out, no DOM - and it is coordinate math that silently
// misplaces every word on screen when it is wrong. That is exactly the argument
// js/ocrEngine.js's header already makes for test/unit/bbox.test.js, and the
// same argument applies here. The end-to-end behaviour is measured separately by
// `node test/run-benchmark.js --cloud`.
//
// The shapes under test are the ones the module's own header enumerates:
//
//   a == b        keep the measured box, take the model's text
//   a != b, both  union the local boxes and split by character count
//   b == 0        the model declined to confirm it - drop the local box
//   a == 0        no local ink at all - interpolate a coarse line object

import test from "node:test";
import assert from "node:assert/strict";
import { alignTranscriptToWords, INFERRED_PLACEMENT_CONFIDENCE } from "../../js/transcriptAlign.js";

const W = 1000;
const H = 800;

function word(text, x0, y0, x1, y1, lineIndex = 0) {
  return { lineIndex, text, confidence: 80, bbox: { x0, y0, x1, y1 } };
}

const inside = (box) => box.x0 >= 0 && box.y0 >= 0 && box.x1 <= W && box.y1 <= H && box.x1 > box.x0 && box.y1 > box.y0;

test("the flat return shape is exactly what js/main.js's call site already takes", () => {
  const { words } = alignTranscriptToWords([word("HELLO", 10, 10, 90, 30)], "HELLO", W, H);
  assert.equal(words.length, 1);
  const w = words[0];
  assert.deepEqual(Object.keys(w).sort(), ["bbox", "confidence", "lineIndex", "text"]);
  assert.equal(typeof w.lineIndex, "number");
  assert.equal(typeof w.text, "string");
  assert.deepEqual(Object.keys(w.bbox).sort(), ["x0", "x1", "y0", "y1"]);
});

test("a == b: the local box is kept EXACTLY and the model's text replaces the local text", () => {
  const local = [word("HELL0", 10, 10, 90, 30), word("W0RLD", 100, 10, 190, 30)];
  const { words } = alignTranscriptToWords(local, "HELLO WORLD", W, H);
  assert.deepEqual(words.map((w) => w.text), ["HELLO", "WORLD"]);
  // Not merely close - the same numbers. A measured box must survive untouched.
  assert.deepEqual(words[0].bbox, { x0: 10, y0: 10, x1: 90, y1: 30 });
  assert.deepEqual(words[1].bbox, { x0: 100, y0: 10, x1: 190, y1: 30 });
});

test("confidence is null on a word placed on real local ink - absent, not invented", () => {
  const { words } = alignTranscriptToWords([word("HELLO", 10, 10, 90, 30)], "HELLO", W, H);
  // js/mlkitEngine.js's precedent: an engine with no per-word score says so with
  // null rather than with a number nobody measured.
  assert.equal(words[0].confidence, null);
});

test("a != b, split: one local box read as two words yields two boxes inside that box", () => {
  const local = [word("BUILDINGD", 10, 10, 210, 30), word("AREA", 400, 10, 500, 30)];
  const { words } = alignTranscriptToWords(local, "BUILDINGD AREA EXTRA", W, H);
  assert.deepEqual(words.map((w) => w.text), ["BUILDINGD", "AREA", "EXTRA"]);
  for (const w of words) assert.ok(inside(w.bbox), `box out of bounds: ${JSON.stringify(w.bbox)}`);
});

test("a != b, merge: two local boxes read as one word produce a box spanning both", () => {
  const local = [word("TEXT", 10, 10, 60, 30), word("SCANNER", 62, 10, 150, 30)];
  const { words } = alignTranscriptToWords(local, "TEXTSCANNER", W, H);
  assert.equal(words.length, 1);
  assert.equal(words[0].text, "TEXTSCANNER");
  // The union of the ink it replaces, so the inpaint patch covers both.
  assert.equal(words[0].bbox.x0, 10);
  assert.equal(words[0].bbox.x1, 150);
});

test("b == 0: a local box the model never confirmed is dropped, and counted", () => {
  const local = [word("REAL", 10, 10, 90, 30), word("QD", 300, 400, 330, 420, 1)];
  const { words, stats } = alignTranscriptToWords(local, "REAL", W, H);
  assert.deepEqual(words.map((w) => w.text), ["REAL"]);
  assert.equal(stats.droppedLocalWords, 1);
});

test("a == 0: a transcript line with no local ink becomes a flagged, in-bounds line object", () => {
  const local = [word("TOP", 10, 10, 90, 30, 0), word("BOTTOM", 10, 700, 120, 730, 1)];
  const { words, stats } = alignTranscriptToWords(local, "TOP\nMISSED LINE\nBOTTOM", W, H);

  const missed = words.filter((w) => w.text === "MISSED" || w.text === "LINE");
  assert.equal(missed.length, 2, "the missed line's words must still reach the user");
  for (const w of missed) {
    // Flagged, so the editor's existing low-confidence underline lands on the
    // words whose POSITION is a guess and on nothing else.
    assert.equal(w.confidence, INFERRED_PLACEMENT_CONFIDENCE);
    assert.ok(inside(w.bbox), `interpolated box out of bounds: ${JSON.stringify(w.bbox)}`);
  }
  // Interpolated into the gap between the two anchors, not on top of either.
  assert.ok(missed[0].bbox.y0 >= 30, "must sit below the line above it");
  assert.ok(missed[0].bbox.y1 <= 700 + 1, "must sit above the line below it");
  assert.equal(stats.inferredWords, 2);
  assert.equal(stats.inferredLines, 1);

  // And the words that DID have ink are not flagged.
  assert.equal(words.find((w) => w.text === "TOP").confidence, null);
  assert.equal(words.find((w) => w.text === "BOTTOM").confidence, null);
});

test("a word read BETWEEN two placed words on one line takes the gap and is NOT flagged", () => {
  // This is not a missed region: both ends of the gap are real measurements, so
  // the placement is derived from ink rather than inferred from neighbours.
  const local = [word("LOWER", 10, 10, 80, 30), word("LANE", 200, 10, 260, 30)];
  const { words } = alignTranscriptToWords(local, "LOWER RESIDENT LANE", W, H);
  const resident = words.find((w) => w.text === "RESIDENT");
  assert.ok(resident, "the word the local engine missed must survive");
  assert.equal(resident.confidence, null, "a gap between two measured boxes is a placement, not a guess");
  assert.equal(resident.bbox.x0, 80);
  assert.equal(resident.bbox.x1, 200);
});

test("the alignment is text-lossless: every transcript token reaches the output", () => {
  const local = [word("GARBAGE", 10, 10, 90, 30), word("N0ISE", 100, 10, 180, 30)];
  const transcript = "THE QUICK BROWN FOX\nJUMPS OVER\nTHE LAZY DOG";
  const { words } = alignTranscriptToWords(local, transcript, W, H);
  const expected = transcript.split(/\s+/).filter(Boolean);
  assert.deepEqual(words.map((w) => w.text), expected);
});

test("lineIndex follows the MODEL's line structure, sequentially from zero", () => {
  const local = [word("A", 10, 10, 30, 30), word("B", 10, 100, 30, 120, 1)];
  const { words } = alignTranscriptToWords(local, "FIRST LINE\nSECOND LINE", W, H);
  const byLine = new Map();
  for (const w of words) byLine.set(w.lineIndex, [...(byLine.get(w.lineIndex) || []), w.text]);
  assert.deepEqual([...byLine.keys()], [0, 1]);
  assert.deepEqual(byLine.get(0), ["FIRST", "LINE"]);
  assert.deepEqual(byLine.get(1), ["SECOND", "LINE"]);
});

test("zero local geometry still returns the text, every word flagged and in bounds", () => {
  // The degenerate case the module's header calls out: the local engine found
  // nothing, so the editor degrades to line objects - but the scan's primary
  // output, the text, is not withheld because of it.
  const { words, stats } = alignTranscriptToWords([], "ALPHA BETA\nGAMMA", W, H);
  assert.deepEqual(words.map((w) => w.text), ["ALPHA", "BETA", "GAMMA"]);
  for (const w of words) {
    assert.equal(w.confidence, INFERRED_PLACEMENT_CONFIDENCE);
    assert.ok(inside(w.bbox), `box out of bounds: ${JSON.stringify(w.bbox)}`);
  }
  assert.equal(stats.placedWords, 0);
});

test("an empty transcript returns no words, so the caller keeps the local result", () => {
  const local = [word("KEEP", 10, 10, 90, 30)];
  assert.deepEqual(alignTranscriptToWords(local, "", W, H).words, []);
  assert.deepEqual(alignTranscriptToWords(local, "   \n  \n", W, H).words, []);
});

test("INFERRED_PLACEMENT_CONFIDENCE sits between the two thresholds it is chosen against", () => {
  // Below js/state.js's LOW_CONFIDENCE_THRESHOLD, so it is flagged for a human;
  // above js/filter.js's NOISE_CONFIDENCE_THRESHOLD, so Filtered Text, Copy and
  // TTS do not silently delete text the app went to the trouble of keeping.
  // Hard-coded here on purpose: if either threshold moves, this fails and the
  // choice gets re-made deliberately instead of drifting.
  assert.ok(INFERRED_PLACEMENT_CONFIDENCE > 25, "must not be auto-hidden as noise by js/filter.js");
  assert.ok(INFERRED_PLACEMENT_CONFIDENCE < 65, "must be underlined as worth checking by js/editorObjects.js");
});
