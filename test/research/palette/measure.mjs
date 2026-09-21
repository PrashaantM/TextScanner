// measure.mjs: a readable contrast report for the single colour scheme.
//
// NOT THE GATE. test/palette-contrast.js is the gate; it runs in CI and fails
// the build. This file exists for the times you want the numbers laid out to
// look at - comparing a candidate token against what ships, or writing up why
// a value is what it is - without reading them out of a pass/fail log.
//
// IT CARRIES NO COLOURS AND NO ARITHMETIC OF ITS OWN. Both come from
// ../../palette-contrast.js, which parses them out of style.css. An earlier
// version of this file hard-coded a 16-token copy of the palette and said so in
// its header; that copy was correct the day it was written, which is exactly
// the property that makes it dangerous later. The dependency points research ->
// gate and never the other way: a gate that imported a research harness could
// be disabled by editing something nothing runs.
//
// Usage: node test/research/palette/measure.mjs

import {
  readStylesheet, parseTokens, requireHex, requireRgba, findSurfaceTints,
  ratio, over, toHex, WHITE_SCAN, NIGHT_PHOTO, AA_BODY, AA_LARGE,
} from "../../palette-contrast.js";

const css = await readStylesheet();
const tokens = parseTokens(css);
const hex = (n) => requireHex(tokens, n);
const fmt = (n) => n.toFixed(2);

const TEXT = hex("--text");
const MUTED = hex("--text-muted");
const ACCENT = hex("--accent");

console.log("Palette read from style.css's :root\n");
for (const [name, value] of [...tokens].filter(([, v]) => /^#|^rgba\(/.test(v))) {
  console.log(`  ${name.padEnd(20)} ${value}`);
}

const row = (label, r, floor) =>
  console.log(`  ${r >= floor ? "    " : "LOW "}${label.padEnd(52)} ${fmt(r).padStart(6)}:1   (floor ${floor})`);

console.log("\nOpaque surfaces");
for (const surface of ["--bg", "--surface", "--surface-2", "--surface-3"]) {
  row(`--text on ${surface}`, ratio(TEXT, hex(surface)), AA_BODY);
  row(`--text-muted on ${surface}`, ratio(MUTED, hex(surface)), AA_BODY);
}
for (const surface of ["--bg", "--surface"]) {
  row(`--accent on ${surface}`, ratio(ACCENT, hex(surface)), AA_LARGE);
}
row("--accent-contrast on --accent", ratio(hex("--accent-contrast"), ACCENT), AA_BODY);
row("--danger-contrast on --danger", ratio(hex("--danger-contrast"), hex("--danger")), AA_BODY);
for (const token of ["--success", "--error", "--warning", "--danger"]) {
  row(`${token} on --surface`, ratio(hex(token), hex("--surface")), token === "--success" ? AA_LARGE : AA_BODY);
}

// The backdrop model: backdrop-filter's blur redistributes the backdrop's
// pixels but preserves their mean, so the mean is what text has to survive.
// Pure white and near-black bracket what a camera can hand this app.
console.log("\nGlass over a photograph (--surface-glass)");
const glass = requireRgba(tokens, "--surface-glass");
for (const [name, backdrop] of [["a white page scan", WHITE_SCAN], ["a night photo", NIGHT_PHOTO]]) {
  const c = over(glass.fill, glass.alpha, backdrop);
  console.log(`  over ${name} -> ${toHex(c)}`);
  row(`--text on glass over ${name}`, ratio(TEXT, c), AA_BODY);
  row(`--text-muted on glass over ${name}`, ratio(MUTED, c), AA_BODY);
  row(`--accent on glass over ${name}`, ratio(ACCENT, c), AA_LARGE);
}

console.log("\nTinted surfaces, found by reading style.css rather than listed here");
const SURFACE = hex("--surface");
for (const { percent, line } of findSurfaceTints(css)) {
  for (const [name, backdrop] of [["a white page scan", WHITE_SCAN], ["a night photo", NIGHT_PHOTO]]) {
    const c = over(SURFACE, percent, backdrop);
    row(`style.css:${line} ${Math.round(percent * 100)}%: --text over ${name}`, ratio(TEXT, c), AA_BODY);
    row(`style.css:${line} ${Math.round(percent * 100)}%: --text-muted over ${name}`, ratio(MUTED, c), AA_BODY);
  }
}

console.log("\nFloors are asserted by node test/palette-contrast.js, not by this file.");
