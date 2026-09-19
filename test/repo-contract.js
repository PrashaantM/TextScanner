// repo-contract.js: the repository's own bookkeeping, asserted instead of
// maintained by hand. Two checks, both about claims this repo makes ABOUT
// itself rather than about how the app behaves.
//
// WHY THIS IS A SEPARATE FILE FROM dom-contract.js. That gate's header calls
// its scope "deliberately narrow": js/dom.js's ids, and nothing else. The two
// checks below are not about ids at all - they are about whether a document's
// stated numbers match the tree and whether ci.yml runs what test/ contains.
// Folding them in would have made "the id contract" the name of a file that
// also parses markdown and YAML, and the next check of this kind would have
// gone in there too because the file was already impure. Both gates are
// browser-free and finish in well under a second, so there is no cost to
// keeping them apart.
//
// ---------------------------------------------------------------------------
// CHECK 1: WEB-COMPLETION-PLAN.md §0's counts vs. the tree.
//
// §0 opens with a standing rule, added after its own numbers drifted three
// times in three sessions: whichever commit moves a count updates §0 in that
// same commit. The rule is sound and it kept being broken, because a rule is a
// comment and a comment cannot fail. Between `0def681` and `10d1e5d` the line
// count went stale again (§0 said 17,394; `wc -l js/*.js` said 17,402) and the
// CI-gate count went stale twice over (§0 said 28 while the workflow ran 30 -
// font-match.js and chrome-reorganization.js were never added to its table).
//
// The numbers are PARSED OUT OF THE MARKDOWN, not restated here. That is the
// whole design: the document stays the single source of truth and this file
// only checks it. Hardcoding the expected values here would just move the
// drift, giving two places to update instead of one - which is precisely the
// failure EXPECTED_ID_COUNT in dom-contract.js accepts deliberately for the id
// contract (an id change SHOULD be an explicit edit) and which makes no sense
// at all for a derived count nobody chooses.
//
// Each count is checked at EVERY place §0 states it, not just the fact table,
// so a restatement in prose cannot drift away from the table above it. Lines
// inside a blockquote are excluded: §0's `>` block is a historical record of
// what a past commit corrected the numbers TO, and rewriting history to match
// today's tree would destroy the evidence the standing rule exists to preserve.
//
// The tree-side numbers are computed the way §0's own "How it was checked"
// column computes them, down to `wc -l`'s newline-counting semantics - see
// countLines below for why that distinction is not pedantry.
//
// ---------------------------------------------------------------------------
// CHECK 2: every gate in test/ is actually wired into CI.
//
// `test/chrome-reorganization.js` was written, committed, and sat in the tree
// for a full commit cycle with no `run:` line in .github/workflows/ci.yml. It
// passed locally, it was listed in the commit message, and it gated nothing.
// `test/paste-placement.js` had been in exactly the same state one commit
// earlier, since `b823567`, and is wired in by the same commit that adds this
// file - see the note under EXEMPT_HELPERS.
//
// A gate that is not in the workflow is strictly worse than no gate: it costs
// the effort of writing it and buys a false sense that the behaviour is
// covered. Nothing catches it, because everything about the file looks right.
//
// The rule here is a whitelist, not a heuristic. Every top-level `test/*.js`
// must have a `run:` line in the per-push `test:` job unless it is named in
// EXEMPT_HELPERS below WITH A REASON. Sniffing for `process.exit(1)` or an
// assertion count would be guessing, and would quietly reclassify a file the
// day someone refactored it.
//
// test/unit/*.test.js is deliberately out of scope: those run as one step
// (`node --test test/unit/*.test.js`) via the glob, so an individual unit test
// needs no workflow line of its own and adding one would be wrong.
//
// test/research/ is out of scope too, and that directory is the reason this
// check can be strict about test/*.js. It is where this repo already puts
// tools that measure rather than assert - font-features.mjs says so in its
// first line - and the `.mjs` extension in a subdirectory keeps them out of
// the `test/*.js` glob by construction. Two of the exemptions below
// (score-manual.js, tune-thresholds.js) are that same kind of tool and would
// arguably be better off moved there; they are left where they are because
// moving files is not what this change is for, and an exemption with a
// written reason costs nothing until someone does move them.
//
// Usage: node test/repo-contract.js   (exits non-zero if either contract broke)

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// The exemption list. Every entry was opened and read before being put here;
// the reason is the evidence, not a restatement of the filename.
//
// The test for membership is "running this under `node` asserts nothing, so a
// workflow line for it would be a no-op or worse." Four of these are pure
// modules with no top-level behaviour at all, two generate fixtures, and two
// are hand-driven measurement tools with no pass/fail to gate on.
const EXEMPT_HELPERS = new Map([
  [
    "browser.js",
    "Pure module. Exports launchBrowser/BROWSER_NAME/skipUnlessChromium/" +
      "blobStorageWorks/noteBlobSkip and runs no assertion of its own; 29 of the " +
      "gates import it. Its one process.exit(2) rejects an unknown BROWSER env " +
      "value at import time, which is an argument check, not a test result.",
  ],
  [
    "metrics.js",
    "Pure functions (characterErrorRate, wordErrorRate) over two strings, with " +
      "no side effects and no I/O. Its arithmetic IS gated - by " +
      "test/unit/metrics.test.js under `node --test`, which is its own workflow step.",
  ],
  [
    "partialGroundTruth.js",
    "A single exported Set of three image names, 15 lines, no executable " +
      "behaviour whatsoever. It exists so run-benchmark.js and tune-thresholds.js " +
      "cannot disagree about which ground truth is incomplete.",
  ],
  [
    "sizeVerdict.js",
    "Pure exported decision functions (evaluateProperty, wordVerdict) with the " +
      "only measurement passed in as a callback. It was pulled OUT of " +
      "replacement-size.js precisely so it could be driven offline, and it is " +
      "gated by test/unit/size-verdict.test.js under `node --test`.",
  ],
  [
    "make-mlkit-fixture.js",
    "Fixture generator. Its main-guard (`process.argv[1].endsWith(...)`) WRITES " +
      "ML-Kit-shaped fixtures to disk rather than checking anything, so a " +
      "workflow line would make CI produce files instead of verdicts. The " +
      "fixtures it exports are asserted by test/unit/mlkit-geometry.test.js and " +
      "consumed by render-fidelity.js, both of which are gated.",
  ],
  [
    "make-non-latin-images.js",
    "Fixture generator. Renders the non-Latin PNGs and their ground-truth .txt " +
      "files that non-latin-limitation.js (gated) consumes. It asserts nothing " +
      "and exits 0 whatever it produces.",
  ],
  [
    "score-manual.js",
    "Reporting tool, not a gate. It scores output hand-collected from an engine " +
      "this repo cannot drive automatically (native ML Kit on a physical iPhone) " +
      "and needs test/manual-output/*.txt files that are not in the tree. It " +
      "prints a CER/WER table and has no failing branch at all - its lone " +
      "process.exit(1) is the catch on an unhandled error.",
  ],
  [
    "tune-thresholds.js",
    "Threshold sweep, not a gate. It PATCHES `const` declarations in " +
      "js/ocrEngine.js on disk, re-runs the corpus per variant, and restores the " +
      "file in a finally block and on SIGINT. There is no pass/fail - the output " +
      "is a table to read - and a step that mutates application source mid-run " +
      "is the opposite of what a gate should do.",
  ],
]);

// NOT exempt, and the reason is worth stating because the brief for this gate
// assumed otherwise: test/paste-placement.js is a real browser gate. It stands
// up a server, launches a browser, runs 11 `check()` assertions over Ctrl/Cmd+C
// and +V and the touch long-press menu, collects failures and exits 1 - the
// same shape as every gate in the workflow - and it already calls
// skipUnlessChromium() so the nightly cross-browser job would handle it
// correctly. Nothing in the repo documents a reason to exclude it; it simply
// never got a `run:` line when `b823567` added it, exactly like
// chrome-reorganization.js one commit later. It runs in ~7s and passed three
// consecutive local runs before being wired in.

// ---------------------------------------------------------------------------
// Tree-side counts, computed the way §0's own "How it was checked" column
// computes them.

// `wc -l` counts NEWLINE CHARACTERS, not lines of text: a file whose last line
// has no trailing newline reports one fewer than an editor shows. Splitting on
// "\n" and taking .length would overcount by one for every newline-terminated
// file, so every count would be off by the module count. §0 quotes `wc -l`, so
// this has to be `wc -l`.
function countLines(text) {
  let newlines = 0;
  for (const ch of text) if (ch === "\n") newlines++;
  return newlines;
}

const jsEntries = await readdir(join(ROOT, "js"), { withFileTypes: true });
// `js/*.js` is a shell glob: top level only, and it matches files, not
// directories that happen to end in .js.
const jsModules = jsEntries.filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name);

let actualLineCount = 0;
for (const name of jsModules) {
  actualLineCount += countLines(await readFile(join(ROOT, "js", name), "utf8"));
}
const actualModuleCount = jsModules.length;

// ---------------------------------------------------------------------------
// The per-push job's steps, replicating
//   awk '/^  test:/,/^  cross-browser:/' .github/workflows/ci.yml
// which is the command §0's fact table names. awk's range is inclusive of both
// delimiter lines; `  cross-browser:` is not a run line so the boundary does
// not affect the count, but the range is reproduced faithfully anyway so the
// two can never disagree for a reason nobody predicted.
const ciSource = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const ciLines = ciSource.split("\n");
const jobStart = ciLines.findIndex((l) => /^  test:/.test(l));
const jobEnd = ciLines.findIndex((l) => /^  cross-browser:/.test(l));

const failures = [];

if (jobStart === -1 || jobEnd === -1 || jobEnd < jobStart) {
  console.error(
    "FAILED: could not find the `  test:` .. `  cross-browser:` range in " +
      ".github/workflows/ci.yml. The job names changed; this gate and " +
      "WEB-COMPLETION-PLAN.md §0's counting command both need updating."
  );
  process.exit(1);
}

const perPushLines = ciLines.slice(jobStart, jobEnd + 1);

// `grep -c '^      - run: node'` - six spaces, i.e. a step in that job. This
// deliberately includes `node --test test/unit/*.test.js`, which §0's table
// has always listed as one of the gates.
const gateStepLines = perPushLines.filter((l) => /^      - run: node/.test(l));
const actualGateCount = gateStepLines.length;

// Which test/*.js files the per-push job actually runs.
const wiredTestFiles = new Set();
for (const line of gateStepLines) {
  const m = line.match(/\btest\/([A-Za-z0-9_.-]+\.js)\b/);
  if (m) wiredTestFiles.add(m[1]);
}

// ---------------------------------------------------------------------------
// CHECK 1: parse §0 and compare.

const planPath = "WEB-COMPLETION-PLAN.md";
const planSource = await readFile(join(ROOT, planPath), "utf8");

// §0 runs from its own heading to the next top-level heading.
const sectionMatch = planSource.match(/^## 0\..*$([\s\S]*?)(?=^## \d)/m);
if (!sectionMatch) {
  console.error(`FAILED: could not locate §0 ("## 0. ...") in ${planPath}.`);
  process.exit(1);
}

// Line numbers are carried through so a failure names the line to edit rather
// than just the number that was wrong.
const sectionStartLine = planSource.slice(0, sectionMatch.index).split("\n").length;
const section0 = sectionMatch[1].split("\n").map((text, i) => ({
  text,
  line: sectionStartLine + i + 1,
}));

// Blockquote lines are §0's historical record of what past commits corrected
// these numbers TO. They are deliberately not maintained against the tree.
const liveLines = section0.filter((l) => !l.text.startsWith(">"));

// Collects every stated value of one count, so a restatement in prose cannot
// drift away from the fact table that states it first.
function statedValues(pattern, label) {
  const found = [];
  for (const { text, line } of liveLines) {
    for (const m of text.matchAll(pattern)) {
      found.push({ value: Number(m[1].replace(/,/g, "")), raw: m[1], line });
    }
  }
  if (!found.length) {
    failures.push(
      `${planPath} §0 no longer states ${label} anywhere this gate can find it. ` +
        `If §0's wording changed, update the pattern in test/repo-contract.js in the same commit.`
    );
  }
  return found;
}

function assertStated(found, actual, label, howChecked) {
  for (const { value, raw, line } of found) {
    if (value !== actual) {
      failures.push(
        `${planPath}:${line} states ${label} as ${raw}; the tree has ${actual.toLocaleString("en-US")}. ` +
          `Update §0 in the commit that moved it, by copying the literal output of: ${howChecked}`
      );
    }
  }
}

// "49 modules, ..." in the fact table, and "49 unbundled ES modules over
// HTTP/2 ..." in the prose below it - which said 48 while the table said 49.
assertStated(
  statedValues(/\b(\d+)\s+(?:unbundled ES )?modules\b/g, "the js/ module count"),
  actualModuleCount,
  "the js/ module count",
  "ls js/*.js | wc -l"
);

assertStated(
  statedValues(/\b([\d,]+)\s+lines in `js\/`/g, "the js/ line count"),
  actualLineCount,
  "the js/ line count",
  "wc -l js/*.js"
);

// Stated twice on purpose: once in the fact table, once in the heading over
// the per-gate table. Both are checked, so neither can drift from the other.
assertStated(
  statedValues(/\b(\d+)\s+gates in `ci\.yml`'s per-push/g, "the CI gate count"),
  actualGateCount,
  "the CI gate count",
  "awk '/^  test:/,/^  cross-browser:/' .github/workflows/ci.yml | grep -c '^      - run: node'"
);
assertStated(
  statedValues(/^###\s+The\s+(\d+)\s+CI gates\b/g, "the CI gate count"),
  actualGateCount,
  "the CI gate count",
  "awk '/^  test:/,/^  cross-browser:/' .github/workflows/ci.yml | grep -c '^      - run: node'"
);

// ---------------------------------------------------------------------------
// CHECK 2: every gate in test/ is wired into the per-push job.

const testEntries = await readdir(join(ROOT, "test"), { withFileTypes: true });
const testFiles = testEntries.filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name).sort();

for (const name of testFiles) {
  if (EXEMPT_HELPERS.has(name)) {
    if (wiredTestFiles.has(name)) {
      failures.push(
        `test/${name} has a \`run:\` line in .github/workflows/ci.yml but is listed as an ` +
          `exempt helper in test/repo-contract.js. One of the two is wrong - if it became a ` +
          `gate, remove its EXEMPT_HELPERS entry; if not, remove the workflow step.`
      );
    }
    continue;
  }
  if (!wiredTestFiles.has(name)) {
    failures.push(
      `test/${name} is a gate with no \`run: node test/${name}\` line in ` +
        `.github/workflows/ci.yml's per-push \`test:\` job, so it gates nothing. ` +
        `Add the step in the same commit (and a row to WEB-COMPLETION-PLAN.md §0's gate ` +
        `table), or add it to EXEMPT_HELPERS in this file with a reason if it is a helper.`
    );
  }
}

// A stale exemption is its own bug: the file is gone, and the entry now
// excuses nothing while looking like it still covers something.
for (const name of EXEMPT_HELPERS.keys()) {
  if (!testFiles.includes(name)) {
    failures.push(
      `test/repo-contract.js exempts test/${name}, which no longer exists. ` +
        `Remove the EXEMPT_HELPERS entry.`
    );
  }
}

// And a workflow line pointing at a deleted file fails the whole job at run
// time with a bare "Cannot find module", which says nothing about why.
for (const name of wiredTestFiles) {
  if (!testFiles.includes(name)) {
    failures.push(
      `.github/workflows/ci.yml's per-push job runs test/${name}, which does not exist.`
    );
  }
}

// ---------------------------------------------------------------------------

console.log(`js/ holds ${actualModuleCount} modules and ${actualLineCount.toLocaleString("en-US")} lines (wc -l).`);
console.log(`ci.yml's per-push test: job runs ${actualGateCount} node steps.`);
console.log(
  `test/ holds ${testFiles.length} top-level .js files: ` +
    `${testFiles.length - EXEMPT_HELPERS.size} gates, ${EXEMPT_HELPERS.size} exempt helpers.`
);

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}

console.log(`\n${planPath} §0's counts match the tree, and every gate in test/ is wired into CI.`);
