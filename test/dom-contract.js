// dom-contract.js: asserts that every element id js/dom.js resolves actually
// exists in index.html, and pins how many there are.
//
// WHY THIS EXISTS. Three documents in this repo call the ids in js/dom.js "the
// app's de-facto public interface" (ANALYSIS.md §8.2, HANDOFF.md §0,
// 06-INTERACTION-MODEL-SPEC.md's verification checklist) because the browser
// gates drive the app through them. Until this file, nothing enforced that.
//
// The failure mode is specifically quiet. document.getElementById returns
// `null` for a missing id - it does not throw - so js/dom.js imports perfectly
// cleanly with an element gone, every module that imports it loads, and the
// break surfaces later as a TypeError at the first use, and ONLY if some gate
// happens to exercise that particular control. Renaming an id no test touches
// is a green-CI regression today. That is the whole reason this is a gate and
// not a comment.
//
// It also pins the COUNT, and that half is not redundant. The number drifted
// from 68 to 71 across two commits (8d37a35 added clean-up-text-btn and
// view-on-photo-btn; e181738 added coherence-gate-hint) and no document
// noticed - all three still said 68 until WEB-COMPLETION-PLAN.md checked.
// Pinning it makes adding an id a deliberate one-line edit to EXPECTED_ID_COUNT
// below, with the commit that changes the contract saying so out loud, rather
// than a number that quietly diverges from the prose describing it.
//
// SCOPE, deliberately narrow. This covers js/dom.js only. index.html carries
// 153 ids in total; the other 82 are looked up locally by app.js, library.js,
// scanDoc.js and friends, and some markup is generated at runtime. Widening
// this to "every id anywhere" would trade a precise, meaningful contract for a
// noisy one. Two ids are worth knowing about as honourable mentions, since
// js/main.js queries them directly and treats them exactly like the contract:
// add-to-doc-btn and save-note-btn (js/main.js:1141-1142). They are not
// asserted here, because dom.js is the line this gate is drawing.
//
// No browser, no server, no dependencies: this parses both files as text, so
// it runs in well under a second and cannot fail for any reason other than the
// contract actually being broken.
//
// Usage: node test/dom-contract.js   (exits non-zero if the contract broke)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The one number that encodes the contract. Changing an id count is a real
// change to the app's public interface, so it should be an explicit edit here
// in the same commit, not a silently-absorbed drift. See the header.
const EXPECTED_ID_COUNT = 72;

// Matches `document.getElementById("some-id")` as it is written in js/dom.js -
// every one of the 71 uses a double-quoted literal. A computed id would not
// match, which is intentional: this gate can only assert what it can read
// statically, and dom.js deliberately contains nothing dynamic.
const DOM_ID_PATTERN = /getElementById\(\s*"([^"]+)"\s*\)/g;

// Requires whitespace or start-of-line before `id=`, so attributes that merely
// END in "id" (data-id, aria-labelledby, and anything similar added later) are
// not mistaken for an element id.
const HTML_ID_PATTERN = /(?:^|\s)id="([^"]+)"/gm;

const domSource = await readFile(new URL("js/dom.js", `file://${ROOT}`), "utf8");
const htmlSource = await readFile(new URL("index.html", `file://${ROOT}`), "utf8");

// Line numbers are carried through so a failure names the exact line in
// js/dom.js to look at, rather than just the id.
const domLines = domSource.split("\n");
const resolvedIds = [];
for (const [index, line] of domLines.entries()) {
  DOM_ID_PATTERN.lastIndex = 0;
  for (const match of line.matchAll(DOM_ID_PATTERN)) {
    resolvedIds.push({ id: match[1], line: index + 1 });
  }
}

const markupIds = [...htmlSource.matchAll(HTML_ID_PATTERN)].map((m) => m[1]);
const markupIdSet = new Set(markupIds);

const failures = [];

// 1. Every id dom.js resolves must exist in the markup. This is the assertion
//    the whole file is for.
for (const { id, line } of resolvedIds) {
  if (!markupIdSet.has(id)) {
    failures.push(`js/dom.js:${line} resolves id="${id}", which does not exist in index.html`);
  }
}

// 2. The count is pinned. A dom.js id that was deleted outright still leaves
//    the app working (nothing resolves it any more) but silently shrinks the
//    contract, which check 1 cannot see.
if (resolvedIds.length !== EXPECTED_ID_COUNT) {
  const direction = resolvedIds.length > EXPECTED_ID_COUNT ? "added" : "removed";
  failures.push(
    `js/dom.js resolves ${resolvedIds.length} ids, expected ${EXPECTED_ID_COUNT}. ` +
      `An id was ${direction}. If that is intended, update EXPECTED_ID_COUNT in this file ` +
      `in the same commit - and the count quoted in HANDOFF.md §0 and ANALYSIS.md §8.2 with it.`
  );
}

// 3. No id appears twice in dom.js. Two exports pointing at one element is not
//    a crash, but it means one of them is almost certainly a typo for an id
//    that no longer exists.
const seenInDom = new Map();
for (const { id, line } of resolvedIds) {
  if (seenInDom.has(id)) {
    failures.push(`js/dom.js resolves id="${id}" twice (lines ${seenInDom.get(id)} and ${line})`);
  } else {
    seenInDom.set(id, line);
  }
}

// 4. No id appears twice in index.html. getElementById silently returns the
//    first match, so a duplicate means half the app is wired to an element
//    nobody can see is the wrong one.
const seenInMarkup = new Set();
const duplicateMarkupIds = new Set();
for (const id of markupIds) {
  if (seenInMarkup.has(id)) duplicateMarkupIds.add(id);
  seenInMarkup.add(id);
}
for (const id of duplicateMarkupIds) {
  failures.push(`index.html declares id="${id}" more than once - getElementById will silently take the first`);
}

console.log(`js/dom.js resolves ${resolvedIds.length} element ids (expected ${EXPECTED_ID_COUNT}).`);
console.log(`index.html declares ${markupIds.length} ids in total, ${markupIdSet.size} of them unique.`);

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}

console.log("\nEvery id js/dom.js resolves exists in index.html, and the count is unchanged.");
