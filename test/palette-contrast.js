// palette-contrast.js: the single colour scheme's contrast floors, asserted
// against the stylesheet that actually ships.
//
// WHY THIS IS A GATE AND NOT A SCRIPT. It started as
// test/research/palette/measure.mjs, which hard-coded its own 16-token copy of
// the palette and said so in its header. That copy was correct the day it was
// written. It is the same shape as the 30 test servers that each carried their
// own MIME map (CHECK 6 in test/repo-contract.js): an honest local copy of a
// value that lives somewhere else is a false green waiting for the original to
// move. So this file PARSES :root out of style.css and carries no colour of its
// own. There is nothing here to drift.
//
// WHAT IT IS PROTECTING. 49d1176 removed the theme system, leaving one scheme
// and therefore no light mode to fall back to when a surface sits over
// something bright. Several surfaces here are glass - a translucent fill plus
// backdrop-filter - and their backdrop is the USER'S OWN PHOTOGRAPH, anywhere
// from a blown-out white page scan to a night shot. Measured properly, the
// palette as it stood before that commit put --text-muted at 1.49:1 on a
// context menu over a white scan: not "low contrast", gone. The tokens moved to
// fix it, and nothing stopped them moving back.
//
// THE BACKDROP MODEL. backdrop-filter's blur redistributes the backdrop's
// pixels but preserves their mean, so the mean is what text has to survive.
// Pure white and near-black bracket what a camera can hand this app.
//
// NO BROWSER, NO SERVER, NO npm install - it is a text-parsing gate like
// dom-contract.js, motion-contract.js and repo-contract.js, and runs in
// milliseconds. It binds no port and launches no browser, so CHECK 3 and
// CHECK 4 in repo-contract.js have nothing to find here.
//
// Usage: node test/palette-contrast.js

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// WCAG 2.1 arithmetic. This file owns it; test/research/palette/ imports it
// from here. The dependency points that way on purpose - a gate that depended
// on a research harness could be disabled by editing something nothing runs.

export function hexToRgb(s) {
  const h = s.trim().replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

// sRGB -> relative luminance, WCAG 2.1 definition of relative luminance.
export function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratio(fg, bg) {
  const a = luminance(Array.isArray(fg) ? fg : hexToRgb(fg));
  const b = luminance(Array.isArray(bg) ? bg : hexToRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Source-over composite of a translucent fill onto an opaque backdrop - what
// `background: rgba(...)` over a photograph resolves to for contrast purposes.
export function over(fill, alpha, backdrop) {
  const f = Array.isArray(fill) ? fill : hexToRgb(fill);
  const b = Array.isArray(backdrop) ? backdrop : hexToRgb(backdrop);
  return f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)));
}

export const toHex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------
// Parsing the shipped stylesheet.
//
// The bare `:root {` block ONLY. style.css also carries
// `:root.reduced-transparency { ... }`, which redefines --surface-glass to
// var(--surface); anchoring to start-of-line with nothing between `:root` and
// `{` is what keeps the two apart. If that block is ever renamed or the
// selector reformatted, findRootBlock throws rather than silently matching the
// wrong one or returning nothing - see the "loudly, not vacuously" note below.

export async function readStylesheet() {
  return readFile(join(ROOT, "style.css"), "utf8");
}

export function findRootBlock(css) {
  const m = css.match(/^:root\s*\{([\s\S]*?)^\}/m);
  if (!m) {
    throw new Error(
      "style.css: could not locate the bare `:root {` block. Every colour in this app is " +
        "defined there and this gate reads them from it - if the selector was reformatted or " +
        "the palette moved, re-point findRootBlock in test/palette-contrast.js in the same " +
        "commit. This gate must not pass by reading nothing."
    );
  }
  return m[1];
}

// Every `--name: value;` in the block, values kept as written.
export function parseTokens(css) {
  const block = findRootBlock(css);
  const tokens = new Map();
  for (const m of block.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    tokens.set(m[1], m[2].trim());
  }
  if (tokens.size === 0) {
    throw new Error("style.css: the :root block parsed to zero tokens. See findRootBlock's note.");
  }
  return tokens;
}

// A token that must exist and must be a plain hex colour. Anything else - a
// var() indirection, a colour function, a missing name - is a hard failure
// rather than something to skip, because skipping is how a gate stops gating.
export function requireHex(tokens, name) {
  const raw = tokens.get(name);
  if (raw === undefined) {
    throw new Error(
      `style.css: :root does not define ${name}, which this gate asserts a contrast floor for. ` +
        `If the token was renamed or removed, update test/palette-contrast.js in the same commit.`
    );
  }
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
    throw new Error(
      `style.css: ${name} is "${raw}", which this gate cannot evaluate as a colour. It expects a ` +
        `plain hex literal. If the palette moved to a colour function, teach this gate to read ` +
        `it rather than letting the floor go unchecked.`
    );
  }
  return raw;
}

// --surface-glass is the one token stated as rgba(), because its ALPHA is the
// load-bearing number: it decides whether text survives over the photograph
// underneath. Parsed as fill + alpha so the composite below is the same
// arithmetic the browser does.
export function requireRgba(tokens, name) {
  const raw = tokens.get(name);
  if (raw === undefined) {
    throw new Error(`style.css: :root does not define ${name}. See requireHex's note.`);
  }
  const m = raw.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/i);
  if (!m) {
    throw new Error(
      `style.css: ${name} is "${raw}", which this gate cannot read as rgba(r, g, b, a). Its alpha ` +
        `is what decides whether text survives over a photograph, so this gate refuses to guess.`
    );
  }
  return { fill: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

// The structural bars tint --surface with color-mix() at their own percentages
// rather than using --surface-glass. Found by reading the stylesheet, not
// listed here, so a new bar added later is covered without editing this gate.
export function findSurfaceTints(css) {
  const found = [];
  for (const m of css.matchAll(/color-mix\(\s*in srgb\s*,\s*var\(--surface\)\s*(\d+)%\s*,\s*transparent\s*\)/gi)) {
    const line = css.slice(0, m.index).split("\n").length;
    found.push({ percent: Number(m[1]) / 100, line });
  }
  return found;
}

// WHAT IS DELIBERATELY NOT ASSERTED HERE. --glass-edge is a 1px translucent
// hairline drawn over whatever the photograph underneath happens to be, so no
// fixed floor can be guaranteed for it by construction - over a backdrop that
// matches it, its own contrast is 1:1 and no token value changes that. The
// panels it edges are identified by their fill's luminance step (asserted
// above) and --shadow-lg, with the edge as refinement on top, so WCAG 1.4.11
// is carried by the fill rather than the hairline. Stated here so its absence
// from the rows below reads as a decision rather than an oversight.

// The two ends of what a camera can put behind a glass surface.
export const WHITE_SCAN = "#ffffff";
export const NIGHT_PHOTO = "#0b0b0d";

// WCAG 1.4.3 normal text, and 1.4.3 large text / 1.4.11 UI components.
export const AA_BODY = 4.5;
export const AA_LARGE = 3.0;

// ---------------------------------------------------------------------------
// The gate proper. Guarded so importing this module for its arithmetic - which
// test/research/palette/measure.mjs does - runs no assertions and exits
// nothing.

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const css = await readStylesheet();
  const tokens = parseTokens(css);

  const failures = [];
  let checked = 0;
  const floor = (label, r, min) => {
    checked++;
    if (r >= min) {
      console.log(`  ok   ${label.padEnd(54)} ${r.toFixed(2).padStart(6)}:1  (floor ${min})`);
    } else {
      console.log(`  FAIL ${label.padEnd(54)} ${r.toFixed(2).padStart(6)}:1  (floor ${min})`);
      failures.push(`${label} is ${r.toFixed(2)}:1, below the ${min}:1 floor`);
    }
  };

  const hex = (n) => requireHex(tokens, n);
  const TEXT = hex("--text");
  const MUTED = hex("--text-muted");
  const ACCENT = hex("--accent");

  console.log("Opaque surfaces");
  for (const surface of ["--bg", "--surface", "--surface-2", "--surface-3"]) {
    floor(`--text on ${surface}`, ratio(TEXT, hex(surface)), AA_BODY);
    floor(`--text-muted on ${surface}`, ratio(MUTED, hex(surface)), AA_BODY);
  }
  for (const surface of ["--bg", "--surface"]) {
    floor(`--accent on ${surface}`, ratio(ACCENT, hex(surface)), AA_LARGE);
  }
  floor("--accent-hover on --surface", ratio(hex("--accent-hover"), hex("--surface")), AA_LARGE);
  floor("--accent-contrast on --accent", ratio(hex("--accent-contrast"), ACCENT), AA_BODY);
  floor("--danger-contrast on --danger", ratio(hex("--danger-contrast"), hex("--danger")), AA_BODY);
  floor("--success on --surface", ratio(hex("--success"), hex("--surface")), AA_LARGE);
  for (const token of ["--error", "--warning", "--danger"]) {
    floor(`${token} on --surface`, ratio(hex(token), hex("--surface")), AA_BODY);
  }

  // The pair that caught the 1.49:1 defect.
  console.log("\nGlass over a photograph  (--surface-glass; .context-menu, .library-sidebar)");
  const glass = requireRgba(tokens, "--surface-glass");
  for (const [name, backdrop] of [["a white page scan", WHITE_SCAN], ["a night photo", NIGHT_PHOTO]]) {
    const composite = over(glass.fill, glass.alpha, backdrop);
    console.log(`  over ${name} -> composites to ${toHex(composite)}`);
    floor(`--text on glass over ${name}`, ratio(TEXT, composite), AA_BODY);
    floor(`--text-muted on glass over ${name}`, ratio(MUTED, composite), AA_BODY);
    floor(`--accent on glass over ${name}`, ratio(ACCENT, composite), AA_LARGE);
  }

  console.log("\nTinted bars over a photograph  (color-mix of --surface, read from style.css)");
  const tints = findSurfaceTints(css);
  if (tints.length === 0) {
    // Loudly, not vacuously: a zero-length loop is a green that proves nothing.
    // If the bars stop using color-mix, this gate has to be re-pointed rather
    // than quietly dropping three surfaces' worth of coverage.
    failures.push(
      "style.css declares no color-mix(in srgb, var(--surface) N%, transparent) surfaces at all. " +
        "The app bar, note toolbar and scan-busy overlay used to be tinted that way and this gate " +
        "checks each one it finds - if they moved to another mechanism, teach findSurfaceTints " +
        "about it in the same commit instead of leaving them unchecked."
    );
    console.log("  FAIL no color-mix surface tints found - see the failure below");
  }
  const SURFACE = hex("--surface");
  for (const { percent, line } of tints) {
    for (const [name, backdrop] of [["a white page scan", WHITE_SCAN], ["a night photo", NIGHT_PHOTO]]) {
      const composite = over(SURFACE, percent, backdrop);
      floor(`style.css:${line} ${Math.round(percent * 100)}%: --text over ${name}`, ratio(TEXT, composite), AA_BODY);
      floor(`style.css:${line} ${Math.round(percent * 100)}%: --text-muted over ${name}`, ratio(MUTED, composite), AA_BODY);
    }
  }

  // :root.reduced-transparency resolves the glass tokens to the opaque
  // --surface/--border, so that path is the opaque rows above. Asserted here so
  // the coupling is stated rather than assumed.
  console.log("\nReduced transparency (glass resolves to --surface)");
  floor("--text on --surface", ratio(TEXT, SURFACE), AA_BODY);
  floor("--text-muted on --surface", ratio(MUTED, SURFACE), AA_BODY);

  if (failures.length) {
    console.error("\nFAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log(`\nAll ${checked} text-over-surface pairs in style.css's :root clear their WCAG floor, including the glass composites over both a white page scan and a night photo.`);
}
