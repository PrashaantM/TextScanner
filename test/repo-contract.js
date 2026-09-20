// repo-contract.js: the repository's own bookkeeping, asserted instead of
// maintained by hand. Six checks, all about claims this repo makes ABOUT itself
// rather than about how the app behaves. (This line read "Two checks" through the
// additions of CHECK 3, CHECK 4 and CHECK 5 - a header miscounting the file it
// heads, in the one gate whose whole subject is numbers that drift. CHECK 1 and
// CHECK 2 are documented here; 3, 4, 5 and 6 at their own sites below.)
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

// NOT exempt. test/paste-placement.js is a real browser gate: it stands up a
// server, launches a browser, runs 11 `check()` assertions over Ctrl/Cmd+C and
// +V and the touch long-press menu, collects failures and exits 1 - the same
// shape as every gate in the workflow - and it already calls
// skipUnlessChromium() so the nightly cross-browser job handles it correctly.
//
// It was KNOWN TO EXIST AND NEVER WIRED, which is not the same thing as
// unnoticed. UI-REDESIGN-PLAN.md:17 counts it deliberately apart from CI:
//
//     "All 29 gates in the local suite (the 28 per-push CI gates plus a new
//      test/paste-placement.js) pass"
//
// That sentence is an author who knew the file was outside CI, said so in the
// count, and did not wire it. So this is NOT the chrome-reorganization.js
// accident repeated - and `b823567` is six commits before `0def681`
// (`git rev-list --count b823567..0def681` = 6), not one.
//
// Wiring it in is still right: being counted separately records the fact, it
// does not give a REASON. Nothing anywhere states why it should stay out, and
// every property that would justify exclusion (slow, flaky, engine-specific,
// needs absent fixtures) is false - it runs in ~7s and passed three consecutive
// local runs. This comment is the permanent answer to anyone re-litigating it,
// so it records what was actually the case rather than the tidier story.

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
// CHECK 1: every document's stated counts vs. the tree.
//
// THE MARKER, and why deciding by inference was the wrong design. This started
// as "WEB-COMPLETION-PLAN.md §0 only", because extending it meant judging, per
// number, whether a document was making a live claim or recording what was true
// at some past revision - and ANALYSIS.md is partly the latter by construction.
// Guessing that from context is exactly the kind of inference a gate should not
// be doing: it is unstated, unreviewable, and wrong the first time someone
// writes a sentence the heuristic did not anticipate. The first version of this
// file inferred it from markdown blockquoting, which is not what a blockquote
// means.
//
// So a number says which it is, in the document, next to itself:
//
//     **Scale:** 14 new modules ... <!-- count-snapshot: reason -->
//
//     <!-- count-snapshot-begin: reason -->
//     ```
//     ├── js/   ← 24 modules, 5,709 LOC
//     ```
//     <!-- count-snapshot-end -->
//
// Inline for a prose line; the range form for a fenced block, where an inline
// HTML comment would RENDER rather than hide, and for a record that spans
// lines. A marked number is frozen history and is never checked. An unmarked
// number is a live claim about the tree right now and must be true.
//
// The marker carries a REASON, not just a flag, for the same purpose as the
// reasons in EXEMPT_HELPERS: the next person re-reading it gets the argument,
// not a mute switch. And a marker that covers no count at all is itself a
// failure - markers must not accumulate as decoration over text that has
// stopped making a claim.
const SNAPSHOT_INLINE = /<!--\s*count-snapshot:\s*(.+?)\s*-->/;
const SNAPSHOT_BEGIN = /<!--\s*count-snapshot-begin:\s*(.+?)\s*-->/;
const SNAPSHOT_END = /<!--\s*count-snapshot-end\s*-->/;

// The three counts, and every phrasing the gated documents use for each. A
// phrasing this does not know about is invisible to the gate, so adding one to
// a document means adding it here in the same commit.
const COUNT_CLAIMS = [
  {
    label: "the js/ module count",
    pattern: /\b(\d+)\s+(?:unbundled ES )?modules\b/g,
    actual: () => actualModuleCount,
    how: "ls js/*.js | wc -l",
  },
  {
    label: "the js/ line count",
    pattern: /\b([\d,]+)\s+(?:lines in `js\/`|lines of vanilla ES-module JavaScript|LOC)\b/g,
    actual: () => actualLineCount,
    how: "wc -l js/*.js",
  },
  {
    label: "the CI gate count",
    pattern: /\b(\d+)\s+(?:CI )?gates\b/g,
    actual: () => actualGateCount,
    how: "awk '/^  test:/,/^  cross-browser:/' .github/workflows/ci.yml | grep -c '^      - run: node'",
  },
];

// WEB-COMPLETION-PLAN.md is checked over §0 ONLY. That is not the timidity the
// marker was introduced to replace - §0 is the section defined as "checked
// today rather than carried forward", so a stale number there is a defect by
// the section's own terms, while §1's task write-ups quote the counts as they
// stood when each task was specified and are a record of the plan, not of the
// tree. README.md and ANALYSIS.md are checked whole, with markers where a
// number is deliberately historical.
const GATED_DOCS = [
  { path: "WEB-COMPLETION-PLAN.md", section: /^## 0\..*$([\s\S]*?)(?=^## \d)/m },
  { path: "README.md", section: null },
  { path: "ANALYSIS.md", section: null },
];

for (const { path: docPath, section } of GATED_DOCS) {
  const source = await readFile(join(ROOT, docPath), "utf8");

  let offset = 0;
  let body = source;
  if (section) {
    const m = source.match(section);
    if (!m) {
      failures.push(
        `${docPath}: could not locate the region this gate checks. If the section heading ` +
          `changed, update GATED_DOCS in test/repo-contract.js in the same commit.`
      );
      continue;
    }
    // m.index is the start of the heading line; the capture group begins at the
    // `$` before that line's newline, so element i of the split is the line
    // (headingLine + i). This read `+ i + 1` and reported every line one too
    // high - three for three against 10d1e5d.
    offset = source.slice(0, m.index).split("\n").length;
    body = m[1];
  }

  const docLines = body.split("\n").map((text, i) => ({ text, line: section ? offset + i : i + 1 }));

  // Resolve marker coverage before looking at any number.
  //
  // Markers are matched against the line with markdown CODE SPANS removed, so
  // prose that DOCUMENTS the syntax - §0 explains it, wrapped in backticks -
  // is not mistaken for a live marker. It was: writing the syntax down opened
  // a range that was never closed. A description of a mechanism is not the
  // mechanism, the same lesson CHECK 4 learned about page.on("console") in a
  // comment.
  //
  // Code spans are stripped for MARKER detection only, never for claim
  // detection: the line-count phrasing is literally "lines in `js/`", so a
  // claim can legitimately contain backticks and must still be read.
  const markerText = (text) => text.replace(/`[^`]*`/g, "");
  let openRange = null;
  const covered = new Map();
  for (const entry of docLines) {
    const begin = markerText(entry.text).match(SNAPSHOT_BEGIN);
    if (begin) {
      if (openRange) {
        failures.push(
          `${docPath}:${entry.line} opens a count-snapshot range while the one opened at ` +
            `line ${openRange.line} is still open. Ranges do not nest.`
        );
      }
      openRange = { line: entry.line, reason: begin[1], claims: 0 };
      covered.set(entry, openRange);
      continue;
    }
    if (SNAPSHOT_END.test(markerText(entry.text))) {
      if (!openRange) {
        failures.push(`${docPath}:${entry.line} closes a count-snapshot range that was never opened.`);
      }
      openRange = null;
      continue;
    }
    const inline = markerText(entry.text).match(SNAPSHOT_INLINE);
    if (inline) covered.set(entry, { line: entry.line, reason: inline[1], claims: 0, inline: true });
    else if (openRange) covered.set(entry, openRange);
  }
  if (openRange) {
    failures.push(
      `${docPath}:${openRange.line} opens a count-snapshot range that is never closed. ` +
        `Add <!-- count-snapshot-end --> after the frozen block.`
    );
  }

  for (const entry of docLines) {
    const marker = covered.get(entry);
    for (const { label, pattern, actual, how } of COUNT_CLAIMS) {
      pattern.lastIndex = 0;
      for (const m of entry.text.matchAll(pattern)) {
        if (marker) {
          marker.claims++;
          continue;
        }
        const stated = Number(m[1].replace(/,/g, ""));
        const truth = actual();
        if (stated !== truth) {
          failures.push(
            `${docPath}:${entry.line} states ${label} as ${m[1]}; the tree has ` +
              `${truth.toLocaleString("en-US")}. Either correct it by copying the literal output of ` +
              `\`${how}\`, or - if this number is deliberately a record of some past revision - ` +
              `mark it with <!-- count-snapshot: why --> in the same commit.`
          );
        }
      }
    }
  }

  // A marker over text that no longer states a count is a stale exemption by
  // another name: it looks like it is protecting something and is not.
  for (const marker of new Set(covered.values())) {
    if (marker.claims === 0) {
      failures.push(
        `${docPath}:${marker.line} carries a count-snapshot marker but no count claim is ` +
          `${marker.inline ? "on that line" : "inside that range"} any more. Remove the marker.`
      );
    }
  }
}


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
// CHECK 3: no gate may bind a fixed TCP port.
//
// Every gate stands up a static server. They used to do it on a hand-picked
// `const PORT = 81xx`, and 28 files were sharing 20 numbers - eight pairs
// collided outright (the list is in test/browser.js's listenOnEphemeralPort).
//
// Renumbering would have been the wrong fix. It repairs those eight pairs and
// leaves the actual defect untouched: a FIXED port means two runs of the SAME
// gate collide too, so one developer running a gate twice, or two sessions on
// one machine, still lose a run to EADDRINUSE. That is measured, not feared -
// it cost one session a chrome-reorganization run on 8140 and another a full
// benchmark run on 8123. Port 0 removes the whole class, including collisions
// with unrelated software that happens to want 8131.
//
// THIS CHECK COVERS EXEMPT HELPERS TOO, unlike CHECK 2. The exemption list
// answers "is this a CI gate?", and that is a different question from "does
// this bind a socket?". tune-thresholds.js is an exempt helper AND was half of
// the 8124 collision with render-fidelity.js; exempting it would have left one
// of the eight pairs standing and would encode the idea that a helper cannot
// cause a collision, which is exactly backwards - a helper is likelier to be
// run by hand alongside a gate. The port rule is about a shared machine
// resource, not about CI membership, so it applies on a different axis.
const PORT_LITERAL = /\b(?:listen\(\s*(\d{2,5})\s*[,)]|(?:PORT|port)\s*=\s*(\d{2,5})\b|localhost:(\d{2,5}))/;

for (const name of testFiles) {
  const source = await readFile(join(ROOT, "test", name), "utf8");
  for (const [i, line] of source.split("\n").entries()) {
    if (line.trimStart().startsWith("//")) continue;
    const m = line.match(PORT_LITERAL);
    if (!m) continue;
    const port = m[1] || m[2] || m[3];
    if (port === "0") continue;
    failures.push(
      `test/${name}:${i + 1} binds or addresses a fixed port (${port}). Take the port from ` +
        `listenOnEphemeralPort(server) in test/browser.js and build URLs from it, so two runs ` +
        `of this file - or of any other - can never collide.`
    );
  }
}

// ---------------------------------------------------------------------------
// CHECK 4: a gate that watches for uncaught errors must also see handled ones.
//
// Measured at 10d1e5d: 25 gates installed page.on("pageerror") and ZERO
// installed any console listener, while js/ carries eleven console.error sites,
// six of them directly inside a catch. js/scanDoc.js's withBusy catches what
// the work throws, logs it and alerts - correct code - so when rebuildPage
// threw on every filter chip, the gate written to click all of them reported
// six clean passes. Nothing uncaught had happened.
//
// A gate that cannot see a whole category of error gates less than it claims
// to, which is the same defect as a gate with no `run:` line in CHECK 2: the
// coverage is believed rather than real.
//
// HOW THE CAPTURE IS SATISFIED, and why this does not demand a listener per
// file. The fix (cedffae) put the listener in test/browser.js and attached it
// to every page reachable through launchBrowser - browser.newPage(),
// context.newPage(), and popups - so gates inherit it and the gate nobody has
// written yet inherits it too. Requiring each file to install its own
// page.on("console") would push 26 files back to the copy-paste design that
// produced the blind spot. So a gate satisfies this by ROUTING THROUGH
// launchBrowser; installing its own console listener also counts, for a gate
// that some day needs bespoke handling.
//
// touch-interactions.js is why the routing half is checked rather than assumed.
// It called chromium.launch() directly, so it installed pageerror like the
// other 25 and was the one file the central fix could not reach.
const CENTRAL_CAPTURE = /\.on\(\s*"console"/;

// Comment lines are stripped before any of these content checks run. This is
// not hypothetical tidiness: test/browser.js's own header quotes
// `page.on("console")` while explaining why the listener exists, so matching
// raw source reported the capture as present no matter what the code did -
// the check passed while the listener was renamed out of existence. A comment
// describing a mechanism is not the mechanism.
const codeOnly = (source) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const browserSource = await readFile(join(ROOT, "test/browser.js"), "utf8");
const centralCaptureExists = CENTRAL_CAPTURE.test(codeOnly(browserSource));

if (!centralCaptureExists) {
  failures.push(
    `test/browser.js installs no console listener, so no gate inherits one and every ` +
      `handled console.error in js/ is invisible to the whole suite. Restore the capture ` +
      `in watchPage() - see this file's CHECK 4 comment.`
  );
}

for (const name of testFiles) {
  const source = codeOnly(await readFile(join(ROOT, "test", name), "utf8"));
  // Only files that actually drive a browser. Without this, THIS file matches:
  // the comments above quote page.on("pageerror") and page.on("console") while
  // launching nothing, and it would be scanned - then pass for the wrong
  // reason, which is worse than being scanned and failing.
  if (!/\blaunchBrowser\s*\(|\.launch\s*\(/.test(source)) continue;
  if (!/\.on\(\s*"pageerror"/.test(source)) continue;
  const ownConsoleListener = CENTRAL_CAPTURE.test(source);
  const inheritsCapture = centralCaptureExists && /\blaunchBrowser\s*\(/.test(source);
  if (ownConsoleListener || inheritsCapture) continue;
  failures.push(
    `test/${name} installs page.on("pageerror") but nothing watches its console, so every ` +
      `handled error - a catch that calls console.error, like withBusy in js/scanDoc.js - is ` +
      `invisible to it. Launch through launchBrowser() from test/browser.js to inherit the ` +
      `capture, or install a console listener of its own.`
  );
}

// ---------------------------------------------------------------------------
// CHECK 5: sw.js's record of the vendored tesseract.js version vs. the bytes.
//
// WHY THIS IS A GATE AND NOT A COMMENT. sw.js caches the 6.7 MB recognition
// payload CACHE-FIRST. If tesseract.js is bumped and the new bytes land under the
// same filenames - which is exactly what happens, since the filenames carry no
// version - every client that already cached the old core keeps serving it
// forever. The app would report the new version while recognizing with the old
// engine, on precisely the users who had used it most. The fix is to bump
// SW_VERSION in the same commit, which renames the caches so activate() drops the
// old ones.
//
// That was recorded in prose, and the prose ran ONE WAY: sw.js pointed at
// vendor/tesseract/README.md's "Before you bump the version" section as the place
// the coupling was written down, and that section never mentioned SW_VERSION. So
// the one person who needed the instruction - whoever opens the vendor README to
// do the bump - was the one person who could not find it. A second prose pointer
// would have fixed today's gap and drifted like the first; §0's standing rule is
// the whole lesson on that.
//
// So sw.js declares the version as DATA and this reads the truth out of the
// vendored bundle's own bytes. A bump now CANNOT land without editing sw.js,
// because CI fails until the declaration matches - and sw.js is the file
// SW_VERSION lives in, so the edit puts the bumper exactly where they need to be.
// This does not verify SW_VERSION was bumped (nothing can know what the right
// value is); it guarantees the bumper is standing in front of it.
//
// The extractor requires EXACTLY ONE quoted semver in the bundle. Measured
// against tesseract.js 5.1.1: there is precisely one, webpack's own version
// module (`{i8:"5.1.1"}`). If a future bundle carries more, this fails asking for
// the extractor to be updated - which lands on the desk of someone already
// mid-bump, the only person with the context to do it.
const swSource = await readFile(join(ROOT, "sw.js"), "utf8");
const vendorReadme = await readFile(join(ROOT, "vendor/tesseract/README.md"), "utf8");
const tesseractBundle = await readFile(join(ROOT, "vendor/tesseract/tesseract.min.js"), "utf8");

const declaredVersion = swSource.match(/VENDORED_TESSERACT_VERSION\s*=\s*"([^"]+)"/)?.[1];
const bundleVersions = [...new Set((tesseractBundle.match(/"\d+\.\d+\.\d+"/g) || []).map((m) => m.slice(1, -1)))];

if (!declaredVersion) {
  failures.push(
    `sw.js no longer declares VENDORED_TESSERACT_VERSION. It is what couples a tesseract.js ` +
      `bump to SW_VERSION - without it a bumped core is pinned forever on any client that ` +
      `cached the old one. Restore it, or delete this check and say why in the same commit.`
  );
} else if (bundleVersions.length !== 1) {
  failures.push(
    `vendor/tesseract/tesseract.min.js carries ${bundleVersions.length} quoted semvers ` +
      `(${bundleVersions.join(", ") || "none"}), so this gate cannot tell which is the ` +
      `tesseract.js version. Update the extractor in test/repo-contract.js CHECK 5.`
  );
} else if (bundleVersions[0] !== declaredVersion) {
  failures.push(
    `sw.js declares VENDORED_TESSERACT_VERSION "${declaredVersion}" but ` +
      `vendor/tesseract/tesseract.min.js is "${bundleVersions[0]}". If you have just bumped ` +
      `tesseract.js: set the declaration to "${bundleVersions[0]}" AND bump SW_VERSION in the ` +
      `same commit. SW_VERSION is what renames the caches so activate() drops the stale core; ` +
      `without it, every client that already cached the old core keeps using it forever. See ` +
      `vendor/tesseract/README.md "Before you bump the version".`
  );
}

// And both halves of the pointer must keep existing, since the gate above is only
// as useful as the explanation it sends people to.
const bumpSection = vendorReadme.split(/^## /m).find((part) => part.startsWith("Before you bump the version"));
if (!bumpSection) {
  failures.push(
    `vendor/tesseract/README.md has no "Before you bump the version" section, which sw.js ` +
      `points at for the SW_VERSION coupling.`
  );
} else if (!bumpSection.includes("SW_VERSION")) {
  failures.push(
    `vendor/tesseract/README.md's "Before you bump the version" section does not mention ` +
      `SW_VERSION, so someone bumping tesseract.js is never told that the cache-first ` +
      `recognition payload pins the old core until SW_VERSION changes. That one-way pointer ` +
      `is the defect this check was added for; restore the reverse half.`
  );
}
if (!swSource.includes("vendor/tesseract/README.md")) {
  failures.push(
    `sw.js no longer points at vendor/tesseract/README.md for the version-bump coupling. ` +
      `Both halves of that pointer are checked, because the bug was having only one.`
  );
}

// ---------------------------------------------------------------------------
// CHECK 6: no gate may carry its own extension-to-content-type map.
//
// Measured at 89f0da6: 30 files in test/ declared `const MIME = {...}`, and 25
// of them resolved the type from the REQUEST path - MIME[extname(p)] - while
// serving a file they had already resolved to something else. extname("/") is
// "", so the bare directory URL went out as application/octet-stream carrying
// index.html's bytes. Every one of those 25 gates navigated to /index.html
// explicitly, so none of them could see it. test/offline.js navigates to the
// directory URL a bookmark opens, its service worker precached the
// octet-stream response, and replaying it offline made Chromium DOWNLOAD the
// app rather than render it ("page.goto: Download is starting").
//
// WHY THE FIX IS A GATE AND NOT 25 EDITS. Correcting 25 files leaves the 26th
// to be written wrong - the same shape as CHECK 3's fixed ports and CHECK 4's
// missing console capture, both of which were fixed by moving the thing into
// test/browser.js and then gating the property rather than the instances. The
// resolver is contentTypeFor() there, the map is the union of all 30 it
// replaced, and this check removes the raw material: with no local map left to
// copy, the next gate's author reaches for the import.
//
// The check is absolute - no exemption list. That is deliberate, and it is why
// all 30 were converted rather than only the 25 that were wrong: an exemption
// list here would need an entry per "this one is fine really", and CHECK 2's
// EXEMPT_HELPERS shows what that costs to keep honest. test/browser.js itself
// is the one file that must declare the map, and it is excluded by name below
// for that reason, exactly as CHECK 4 treats it as the home of the capture.
//
// SCOPE: top-level test/*.js, the same glob as every other check here. The
// research harnesses under test/research/ are .mjs files in a subdirectory and
// are not gates; they are outside this and always have been.
const EXTENSION_TYPE_PAIR = /"\.[a-z0-9]{2,12}"\s*:\s*"[a-z]+\/[a-z0-9.+-]+"/i;
const RESOLVER_EXPORT = /export\s+function\s+contentTypeFor\s*\(/;

if (!RESOLVER_EXPORT.test(codeOnly(browserSource))) {
  failures.push(
    `test/browser.js no longer exports contentTypeFor(), so the gates that import it cannot ` +
      `run and this check would pass by having nothing left to find. Restore the resolver - ` +
      `see this file's CHECK 6 comment and test/browser.js's own.`
  );
}

for (const name of testFiles) {
  // The one file that has to hold the map, for the same reason it holds the
  // console capture: it is where the gates get it from.
  if (name === "browser.js") continue;
  // Raw lines with a per-line comment skip, like CHECK 3 and unlike CHECK 4's
  // codeOnly(): a whole-file strip renumbers everything, and a failure here has
  // to name the line someone can open.
  const source = await readFile(join(ROOT, "test", name), "utf8");
  for (const [i, line] of source.split("\n").entries()) {
    if (line.trimStart().startsWith("//")) continue;
    if (!EXTENSION_TYPE_PAIR.test(line)) continue;
    failures.push(
      `test/${name}:${i + 1} maps a file extension to a content type of its own. Import ` +
        `contentTypeFor from test/browser.js and pass it the path whose BYTES you are ` +
        `serving - never req.url, which is "/" for the directory URL and has no extension ` +
        `at all. See CHECK 6 in this file.`
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

console.log(
  "\nCounts in " +
    GATED_DOCS.map((d) => d.path).join(", ") +
    " match the tree (or are marked as snapshots), every gate in test/ is wired into CI,\n" +
    "no gate binds a fixed port, every browser gate can see handled console errors, no gate carries\n" +
    "a content-type map of its own, and sw.js's record of the vendored tesseract.js version still\n" +
    "matches the bytes."
);
