// motion-contract.js: asserts that every animated duration in style.css is
// disabled when someone has asked their OS to reduce motion.
//
// WHY THIS EXISTS, and why it is a script rather than the one-line grep it
// replaces.
//
// style.css declares --motion-fast/medium/slow/bloom and zeroes all four from a
// single `@media (prefers-reduced-motion: reduce)` block. The design is good
// precisely because it is checkable: if every duration comes from a token, one
// block turns off every animation in the app. The problem has always been that
// the only thing ASSERTING it was a comment, and a comment cannot fail.
//
// It has now failed twice. ANALYSIS.md §3.7 found 3 of 6 transition
// declarations using hardcoded durations while the comment above them claimed
// none did - so anyone who had asked their OS to reduce motion still got
// animation on every button press. The fix held for exactly one commit series:
// e181738 added .radial-menu__item with `transform 140ms ... opacity 100ms ...`
// and the invariant was broken again, undetected, because nothing ran the check.
//
// ANALYSIS.md §3.7 proposed this as the check:
//
//     grep -E '^\s*(transition|animation):' style.css | grep -v 'var(--motion-'
//
// That grep cannot be the gate, and finding out why is most of this file. It
// has no way to tell a violation from three kinds of legitimate declaration:
//
//   1. `transition: none` - there is no duration to tokenize. Reduced motion
//      can only agree with it. (.radial-menu--instant, .doc-card.is-swiping)
//   2. A declaration INSIDE the reduced-motion block - it IS the reduced-motion
//      path, so demanding it use a token it would then zero is circular.
//      (.scan-busy__spinner's substituted pulse)
//   3. An infinite spinner. Zeroing an `animation-duration` on
//      `animation-iteration-count: infinite` does not calm it, it FREEZES it -
//      a busy indicator that has stopped reads as a hung app, which is the
//      exact impression it exists to prevent. style.css handles this correctly
//      by substituting a slower pulse under reduced motion instead. Tokenizing
//      it would be a real regression that the grep would have called a fix.
//
// So the grep's negative filter would have to encode all three, which a grep
// cannot do - (2) needs block structure, not line matching. This script does,
// and every exemption below states its reason next to itself rather than in a
// changelog. The one true allowlist entry is (3), and it is matched by content
// rather than by line number, so it cannot silently come to cover something
// else after an edit shifts the file.
//
// Usage: node test/motion-contract.js   (exits non-zero on a hardcoded duration)

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Exempt by content, never by line number. Each entry says why it is not a
// violation; adding one should require writing that sentence honestly.
const ALLOWLIST = [
  {
    match: /animation:\s*scan-spin\s/,
    reason:
      "infinite spinner - a zeroed duration freezes it rather than calming it, " +
      "so the reduced-motion block substitutes the slower scan-pulse animation instead",
  },
];

const source = await readFile(new URL("style.css", `file://${ROOT}`), "utf8");

// Blank out CSS comments before parsing anything, replacing each character with
// a space and keeping newlines, so line numbers stay exact. This is not
// optional tidiness: style.css's own comments discuss `transition: none`, and a
// scanner that reads prose as code reports a violation in a paragraph.
const stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

const lineOf = (index) => stripped.slice(0, index).split("\n").length;

// Character ranges covered by an `@media (prefers-reduced-motion: reduce)`
// block. Declarations inside one are the reduced path itself, so they are
// exempt - and knowing that needs block structure, which is the specific thing
// a line-based grep cannot do.
const reducedMotionRanges = [];
for (const media of stripped.matchAll(/@media[^{]*prefers-reduced-motion[^{]*reduce[^{]*\{/g)) {
  let depth = 0;
  for (let i = media.index + media[0].length - 1; i < stripped.length; i += 1) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        reducedMotionRanges.push([media.index, i]);
        break;
      }
    }
  }
}
const inReducedMotion = (index) => reducedMotionRanges.some(([a, b]) => index >= a && index <= b);

// Every property that can carry a duration. The shorthands are what style.css
// actually uses today; the longhands are here so that switching to one later is
// not an accidental way out of the contract.
//
// Deliberately NOT anchored to the start of a line. The grep in ANALYSIS.md
// §3.7 was (`^\s*(transition|animation):`), and that anchor is a hole: a rule
// written on one line - `.thing { transition: opacity 200ms; }` - never matches
// it. style.css happens to contain none today, which is exactly how a hole like
// this stays invisible until someone writes the first one.
const DECLARATION = /(?:^|[{;])\s*(transition|animation|transition-duration|animation-duration)\s*:([^;}]*)/g;

// Any bare time value: 120ms, 1.4s, .3s. A duration that came from a token is
// not written as a literal, which is the entire point of the token.
const LITERAL_DURATION = /(?<![\w-])\d*\.?\d+m?s(?![\w-])/;

const violations = [];
const exempt = [];
const tokenized = [];

for (const match of stripped.matchAll(DECLARATION)) {
  const value = match[2].trim();
  const record = {
    // The line of the PROPERTY, not of the match: the pattern starts at the
    // preceding `{` or `;`, which is usually on the line above.
    line: lineOf(match.index + match[0].indexOf(match[1])),
    text: `${match[1]}: ${value.replace(/\s+/g, " ")}`,
  };

  // Reason 1: nothing to reduce.
  if (/^none$/.test(value)) {
    exempt.push({ ...record, why: "transition: none - no duration to tokenize" });
    continue;
  }

  // Reason 2: it is itself the reduced-motion path.
  if (inReducedMotion(match.index)) {
    exempt.push({ ...record, why: "inside the prefers-reduced-motion block - it IS the reduced path" });
    continue;
  }

  // Reason 3: the explicit, reasoned allowlist.
  const allowed = ALLOWLIST.find((entry) => entry.match.test(record.text));
  if (allowed) {
    exempt.push({ ...record, why: allowed.reason });
    continue;
  }

  // Everything else must take every duration from a token the single block
  // zeroes. Strip the var() references, then look for any literal time left
  // behind - that is a duration reduced motion will never reach.
  const withoutTokens = value.replace(/var\(\s*--motion-[a-z-]+\s*\)/g, "");
  if (LITERAL_DURATION.test(withoutTokens)) violations.push(record);
  else tokenized.push(record);
}

// Assert the allowlist itself is still live. An entry that matches nothing is
// either a stale exemption covering a rule that no longer exists, or - worse -
// a hole left open for a future declaration to slip through unnoticed.
for (const entry of ALLOWLIST) {
  if (!exempt.some((e) => entry.match.test(e.text))) {
    violations.push({
      line: 0,
      text: `stale ALLOWLIST entry ${entry.match} in test/motion-contract.js matches nothing in style.css`,
    });
  }
}

// Report the real denominator. A gate that says "checked 4" while the file has
// twenty declarations is describing its own blind spot as a result.
const checked = violations.length + exempt.length + tokenized.length;
console.log(
  `Checked ${checked} transition/animation declarations in style.css: ` +
    `${tokenized.length} fully tokenized, ${exempt.length} exempt, ${violations.length} violating.`
);
for (const e of exempt) console.log(`  exempt  style.css:${e.line}  ${e.why}`);

if (violations.length) {
  console.error("\nFAILED - these animate on a hardcoded duration, so the single");
  console.error("prefers-reduced-motion block at the top of style.css never reaches them:");
  for (const v of violations) console.error(`  - style.css:${v.line}  ${v.text}`);
  console.error(
    "\nUse var(--motion-fast|medium|slow|bloom) for every duration. If this one\n" +
      "genuinely cannot be tokenized, add it to ALLOWLIST in this file WITH the reason."
  );
  process.exit(1);
}

console.log("\nEvery animated duration in style.css is zeroed by the single prefers-reduced-motion block.");
