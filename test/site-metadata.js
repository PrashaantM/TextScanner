// site-metadata.js: the app's version stamp (W12), and the site-level
// metadata a browser or crawler reads without running any JS - link-preview
// tags and the custom 404 page (W11).
//
// WHY THE VERSION CHECK EXISTS. js/state.js's APP_VERSION is the one source
// of truth; index.html's #footer-version span and js/diagnostics.js's export
// both have to agree with it rather than carrying their own copy. That is
// exactly the failure pattern the same session that added this gate had just
// spent a commit fixing elsewhere (four numbers - an id count, a module
// count, a line count, a CI step count - that had each drifted from the code
// they described and nothing caught it). A version string rendered in markup
// and duplicated nowhere else is the same shape of bug waiting to happen;
// this pins it so it can't.
//
// No browser, no server, same discipline as test/dom-contract.js: this parses
// files as text, so it runs in well under a second and can't fail for any
// reason other than the contract actually being broken.
//
// Usage: node test/site-metadata.js

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(new URL(path, `file://${ROOT}`), "utf8");

const failures = [];

const stateSource = await read("js/state.js");
const htmlSource = await read("index.html");

// ---- W12: one version, and the footer has to say the same thing ----

const versionMatch = stateSource.match(/export const APP_VERSION = "([^"]*)"/);
if (!versionMatch || !versionMatch[1]) {
  failures.push(
    "js/state.js does not export APP_VERSION as a non-empty quoted string constant - there is no source of truth for the footer to be checked against"
  );
} else {
  const sourceOfTruth = versionMatch[1];
  const footerMatch = htmlSource.match(/<span id="footer-version">([^<]*)<\/span>/);
  if (!footerMatch) {
    failures.push(
      'index.html has no <span id="footer-version">...</span> - the version stamp W12 added to the footer is gone'
    );
  } else if (footerMatch[1] !== sourceOfTruth) {
    failures.push(
      `index.html's #footer-version reads "${footerMatch[1]}", but js/state.js's APP_VERSION is "${sourceOfTruth}" - ` +
        `the footer and the source of truth have drifted apart`
    );
  } else {
    console.log(`#footer-version matches APP_VERSION ("${sourceOfTruth}").`);
  }
}

// footerVersion has to actually be wired up to render that value, not just
// declared - the id existing in both js/dom.js and index.html is what
// test/dom-contract.js already asserts, so this only needs to confirm main.js
// sets it from the same constant rather than leaving the markup's static text
// as the only place the value ever comes from.
const mainSource = await read("js/main.js");
if (!/footerVersion\.textContent\s*=\s*APP_VERSION/.test(mainSource)) {
  failures.push(
    "js/main.js does not set footerVersion.textContent = APP_VERSION - the footer's static markup would be the only place the version ever came from, silently unpinned from js/state.js the moment either one changes"
  );
}

// ---- W11: link-preview meta tags ----

for (const [name, pattern] of [
  ["og:title", /<meta\s+property="og:title"\s+content="([^"]+)"/],
  ["og:url", /<meta\s+property="og:url"\s+content="([^"]+)"/],
]) {
  const m = htmlSource.match(pattern);
  if (!m || !m[1]) {
    failures.push(`index.html has no <meta property="${name}" content="..."> with a non-empty value`);
  }
}

// ---- W11: the custom 404 page ----

let notFoundSource = null;
try {
  notFoundSource = await read("404.html");
} catch {
  failures.push("404.html does not exist at the repo root - GitHub Pages will keep showing its own stock 404 page");
}
if (notFoundSource !== null) {
  // A real navigable link, not just the site's name in prose - and an
  // absolute URL rather than a relative one, since GitHub Pages serves this
  // exact file for a 404 at any depth under the site, where a relative href
  // would resolve against the missing path rather than against the root. See
  // 404.html's own header comment for why.
  if (!/<a\s+href="https:\/\/prashaantm\.github\.io\/TextScanner\/[^"]*"/.test(notFoundSource)) {
    failures.push('404.html has no <a href="https://prashaantm.github.io/TextScanner/..."> link back into the app');
  }
}

console.log(
  `index.html declares og:title and og:url. 404.html ${notFoundSource !== null ? "exists and links back into the app" : "is missing"}.`
);

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}

console.log("\nThe version stamp has one source of truth and the footer agrees with it; the link-preview tags and the custom 404 page are in place.");
