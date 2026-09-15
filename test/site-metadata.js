// site-metadata.js: the app's version stamp (W12) - one source of truth,
// rendered in the footer and included in the diagnostic export, and this
// gate is what keeps the footer's rendered value from silently drifting away
// from it.
//
// WHY THIS EXISTS. js/state.js's APP_VERSION is the one source of truth;
// index.html's #footer-version span and js/diagnostics.js's export both have
// to agree with it rather than carrying their own copy. That is exactly the
// failure pattern the same session that added this gate had just spent a
// commit fixing elsewhere (four numbers - an id count, a module count, a
// line count, a CI step count - that had each drifted from the code they
// described and nothing caught it). A version string rendered in markup and
// duplicated nowhere else is the same shape of bug waiting to happen; this
// pins it so it can't.
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

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}

console.log("\nThe version stamp has one source of truth and the footer agrees with it.");
