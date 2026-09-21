// measure.mjs: every text-over-surface pair in the single "Instrument" scheme,
// as a computed WCAG 2.1 contrast ratio.
//
// NOT A GATE. It is a measurement, and this repo puts a measurement that does
// not gate anything under test/research/ rather than test/, where
// test/repo-contract.js's CHECK 2 would require a `run:` line for it in
// .github/workflows/ci.yml.
//
// WHY IT EXISTS, and what it found. Removing the theme system left the app with
// one scheme and therefore no light mode to fall back to. Several surfaces here
// are glass - a translucent fill plus backdrop-filter - and their backdrop is
// the user's own photograph, which spans a white page scan to a night shot.
// Run against the palette as it stood BEFORE this change, this script found
// --text-muted at 1.49:1 on a context menu over a white scan and --text at
// 4.26:1, i.e. body text below the 4.5:1 floor and secondary text effectively
// invisible. That is what moved --text-muted and the glass fill/alpha below;
// the numbers are the argument, not the taste.
//
// The backdrop model: backdrop-filter's blur redistributes the backdrop's
// pixels but preserves their mean, so the mean is what text has to survive. A
// pure-white page scan and a near-black night photo bracket it.
//
// Usage: node test/research/palette/measure.mjs

import { ratio, over, toHex, fmt } from "./contrast.mjs";

// The shipped tokens. Kept in sync by hand with style.css's :root - this file
// reports, it does not gate, so a drift here is a wrong report rather than a
// false green.
const T = {
  bg: "#070a0f",
  surface: "#0e141d",
  "surface-2": "#141c27",
  "surface-3": "#1b2431",
  border: "#26303f",
  text: "#eef3f8",
  "text-muted": "#9fb0c8",
  accent: "#34e2ff",
  "accent-hover": "#6eecff",
  "accent-contrast": "#04222c",
  success: "#35e0a1",
  error: "#ff5c76",
  warning: "#ffb020",
  danger: "#ff5c76",
  "danger-contrast": "#070a0f",
};

// The two photographs that bracket everything a scanner app is pointed at.
const BACKDROPS = [["a white page scan", "#ffffff"], ["a night photo", "#0b0b0d"]];

const AA_BODY = 4.5;   // WCAG 1.4.3, normal text
const AA_LARGE = 3.0;  // WCAG 1.4.3 large text / 1.4.11 UI components

let worst = Infinity;
const row = (label, r, floor) => {
  const ok = r >= floor ? "ok  " : "FAIL";
  if (r < floor) worst = Math.min(worst, r);
  console.log(`  ${ok} ${label.padEnd(52)} ${fmt(r).padStart(6)}:1   (floor ${floor})`);
};

console.log("OPAQUE SURFACES");
for (const [fg, bg, floor] of [
  ["text", "bg", AA_BODY], ["text", "surface", AA_BODY],
  ["text", "surface-2", AA_BODY], ["text", "surface-3", AA_BODY],
  ["text-muted", "bg", AA_BODY], ["text-muted", "surface", AA_BODY],
  ["text-muted", "surface-2", AA_BODY], ["text-muted", "surface-3", AA_BODY],
  ["accent", "bg", AA_LARGE], ["accent", "surface", AA_LARGE],
  ["accent-hover", "surface", AA_LARGE],
  ["accent-contrast", "accent", AA_BODY],
  ["danger-contrast", "danger", AA_BODY],
  ["success", "surface", AA_LARGE], ["error", "surface", AA_BODY],
  ["warning", "surface", AA_BODY], ["danger", "surface", AA_BODY],
  ["border", "bg", 1.0], ["border", "surface", 1.0],
]) row(`--${fg} on --${bg}`, ratio(T[fg], T[bg]), floor);

// --surface-glass: rgba(6, 9, 13, 0.8). Stated as fill+alpha so the composite
// below is the same arithmetic the browser does.
const GLASS_FILL = "#06090d", GLASS_ALPHA = 0.8;

console.log("\nGLASS SURFACES over a photograph  (.context-menu, .library-sidebar)");
console.log(`  --surface-glass = rgba(6, 9, 13, ${GLASS_ALPHA})`);
for (const [name, bd] of BACKDROPS) {
  const c = over(GLASS_FILL, GLASS_ALPHA, bd);
  console.log(`  over ${name} -> composites to ${toHex(c)}`);
  row(`--text on glass over ${name}`, ratio(T.text, c), AA_BODY);
  row(`--text-muted on glass over ${name}`, ratio(T["text-muted"], c), AA_BODY);
  row(`--accent on glass over ${name}`, ratio(T.accent, c), AA_LARGE);
}

// The structural bars tint --surface with color-mix() rather than using
// --surface-glass, at their own percentages. Same arithmetic, different alpha.
console.log("\nTINTED BARS over a photograph  (color-mix(in srgb, --surface N%, transparent))");
for (const [label, pct] of [[".app-bar", 0.86], [".note-toolbar", 0.92], [".scan-busy", 0.82]]) {
  for (const [name, bd] of BACKDROPS) {
    const c = over(T.surface, pct, bd);
    row(`${label} ${pct * 100}%: --text over ${name}`, ratio(T.text, c), AA_BODY);
    row(`${label} ${pct * 100}%: --text-muted over ${name}`, ratio(T["text-muted"], c), AA_BODY);
  }
}

console.log("\nREDUCED TRANSPARENCY (:root.reduced-transparency resolves glass to --surface)");
row("--text on --surface", ratio(T.text, T.surface), AA_BODY);
row("--text-muted on --surface", ratio(T["text-muted"], T.surface), AA_BODY);

console.log(
  worst === Infinity
    ? "\nEvery pair above clears its floor."
    : `\nSOMETHING IS BELOW ITS FLOOR (worst ${fmt(worst)}:1).`
);
