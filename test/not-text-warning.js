// not-text-warning.js: the confirm in front of deleting a region that OCR
// probably misread as a word, and the affordance that says so beforehand.
//
// WHY THIS EXISTS. OCR has no concept of a logo. A map-pin icon, a (c) mark, a
// decorative rule - they all come back as words, become editable word objects,
// and deleting one runs the inpainter over that part of the photograph. Someone
// tidying a stray character can paint over a company mark with a single press,
// having been told nothing.
//
// The rule that flags them is geometric, and it has to be, because CONFIDENCE
// CANNOT DO THIS JOB. On complexPic1 the map pin comes back at confidence 89
// while real text "&" scores 51 - any threshold that catches the pin discards
// more real words than it saves. So: at most 2 characters, more than 1.8x the
// image's median width-per-character, and a glyph box more than 1.4x its median
// glyph height. See scoreRegionsForNotText in js/editorObjects.js.
//
// WHAT THIS FILE IS MOSTLY GUARDING AGAINST is the fix overreaching. The flag
// fires on 16% of regions on complexPic2, which is far too many to suppress on -
// a silent filter there would quietly drop real words out of Copy, Download and
// text-to-speech to fix a rarer problem than it caused. So the assertions below
// are as much about what must NOT have changed (every flagged region is still a
// completely ordinary, editable, extractable word) as about the warning itself.
//
// And the confirm follows the discipline test/destructive-actions.js establishes:
// OK acts, Cancel does nothing whatsoever. Not a partial delete of the unflagged
// half of a mixed selection - that would be a destructive action carried out by
// a button labelled Cancel. Playwright auto-dismisses any dialog nothing is
// listening for, so a gate that installs no handler cannot tell "no dialog" from
// "a dialog that was silently cancelled": every dialog is counted here, and the
// unflagged case asserts the count is zero.
//
// Usage: node test/not-text-warning.js   (exits non-zero if anything regressed)

import { launchBrowser, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
const PORT = await listenOnEphemeralPort(server);

const failures = [];
const ok = (label) => console.log("  ok  ", label);
const check = (condition, label, detail) => {
  if (condition) ok(label);
  else failures.push(detail || label);
};

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// Every dialog is recorded, including ones we did not expect - that is the
// point. `reply` decides OK vs Cancel for the next one.
let reply = { accept: false };
let dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  if (reply.accept) await d.accept();
  else await d.dismiss();
});
const answerOk = () => {
  reply = { accept: true };
  dialogs = [];
};
const answerCancel = () => {
  reply = { accept: false };
  dialogs = [];
};

await page.goto(`http://localhost:${PORT}/index.html`);
// complexPic1: the reported case. Its map-pin icon is the single flagged region
// out of 18, and it comes back at confidence 89.
await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic1.jpeg"));
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
await page.click("#mode-full-btn");
await page.waitForTimeout(250);

const survey = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  window.__state = state;
  const words = state.editorObjects.filter((o) => o.type === "word" && o.origin === "ocr");
  const flagged = words.filter((o) => o.probablyNotText);
  const unflagged = words.filter((o) => !o.probablyNotText && o.el.textContent.trim().length >= 4);
  if (flagged[0]) window.__flagged = flagged[0].id;
  if (unflagged[0]) window.__unflagged = unflagged[0].id;
  return {
    total: words.length,
    flaggedCount: flagged.length,
    flaggedText: flagged[0]?.originalText ?? null,
    flaggedConfidence: flagged[0]?.confidence ?? null,
    unflaggedText: unflagged[0]?.originalText ?? null,
    // The affordance, both channels.
    flaggedHasClass: flagged.every((o) => o.el.classList.contains("is-probably-not-text")),
    flaggedHasOutline: flagged.every((o) => {
      const outline = getComputedStyle(o.el).outlineStyle;
      return outline === "dashed";
    }),
    flaggedAriaMentionsIt: flagged.every((o) => (o.el.getAttribute("aria-label") || "").includes("may not be text")),
    flaggedTitleMentionsIt: flagged.every((o) => (o.el.title || "").includes("may not be text")),
    unflaggedHasClass: words.filter((o) => !o.probablyNotText && o.el.classList.contains("is-probably-not-text")).length,
    unflaggedAriaMentionsIt: words.filter((o) => !o.probablyNotText && (o.el.getAttribute("aria-label") || "").includes("may not be text")).length,
  };
});

if (!survey.flaggedText || !survey.unflaggedText) {
  console.error(`FAILED: complexPic1 produced ${survey.flaggedCount} flagged of ${survey.total} - this gate needs at least one of each`);
  process.exit(1);
}
console.log(`complexPic1: ${survey.flaggedCount}/${survey.total} regions flagged`);
console.log(`  flagged:   "${survey.flaggedText}" at confidence ${survey.flaggedConfidence}`);
console.log(`  unflagged: "${survey.unflaggedText}"`);

try {
console.log("\n1. THE AFFORDANCE, before anything is deleted");
check(survey.flaggedHasClass, "every flagged region carries .is-probably-not-text");
check(survey.flaggedHasOutline, "...and actually renders the dashed outline", "a flagged region carries the class but computes no dashed outline - the CSS rule is not reaching it, so the warning is invisible until the confirm appears");
check(survey.flaggedTitleMentionsIt, "...and says so on hover");
check(
  survey.flaggedAriaMentionsIt,
  "...and in its accessible name, so the flag is not visual-only",
  "a flagged region's aria-label does not mention it - the affordance exists only for people who can see the outline"
);
check(survey.unflaggedHasClass === 0, "no unflagged region is marked", `${survey.unflaggedHasClass} unflagged regions carry .is-probably-not-text`);
check(survey.unflaggedAriaMentionsIt === 0, "...or described as flagged", `${survey.unflaggedAriaMentionsIt} unflagged regions claim they may not be text`);

// Confidence would have got this exactly backwards, and that is the whole
// reason the rule is geometric. Pinned so nobody "simplifies" it back.
check(
  survey.flaggedConfidence === null || survey.flaggedConfidence > 65,
  "the flagged region's own confidence is HIGH - no confidence threshold would have caught it",
  `the flagged region scored ${survey.flaggedConfidence}, below the low-confidence threshold - if this ever becomes the norm, re-read why the rule is geometric rather than assuming confidence works`
);

const state = (which) =>
  page.evaluate((key) => {
    const o = window.__state.editorObjects.find((x) => x.id === window[key]);
    return {
      text: o.el.textContent,
      selected: window.__state.selectedObjectIds.has(o.id),
      patchShown: getComputedStyle(o.patchEl).display !== "none",
      undoDepth: window.__state.undoStack.length,
      removed: !!o.removed,
    };
  }, which);

// Clicking, not setting selectedObjectIds directly: selection through the real
// pointer path is part of what is under test. A click that cannot land is
// recorded as a failure and execution continues - a 30-second timeout thrown
// from here would take every failure already recorded down with it, which is
// how the first version of this gate reported an empty summary on genuinely
// broken code.
async function select(which) {
  try {
    const handle = await page.evaluateHandle((key) => {
      const el = window.__state.editorObjects.find((x) => x.id === window[key]).el;
      el.scrollIntoView({ block: "center" });
      return el;
    }, which);
    await handle.click({ timeout: 5000 });
    await page.waitForTimeout(150);
    return true;
  } catch (err) {
    failures.push(`could not select the ${which === "__flagged" ? "flagged" : "unflagged"} region to act on it: ${String(err).split("\n")[0]}`);
    return false;
  }
}

console.log("\n2. DELETING A FLAGGED REGION ASKS FIRST, AND CANCEL LEAVES IT INTACT");
await select("__flagged");
const beforeCancel = await state("__flagged");
answerCancel();
await page.click("#delete-btn");
await page.waitForTimeout(700);
const afterCancel = await state("__flagged");

check(dialogs.length === 1, "Delete on a flagged region raises exactly one dialog", `expected 1 dialog, saw ${dialogs.length}`);
check(dialogs[0]?.type === "confirm", "...and it is a confirm, so it has a Cancel to press", `dialog type was "${dialogs[0]?.type}"`);
// A confirm has to say what it is about to do. "Are you sure?" over a photo
// edit is not informed consent.
const message = dialogs[0]?.message || "";
check(message.includes(survey.flaggedText), "...naming the region it is about to destroy", `the message never names "${survey.flaggedText}": ${JSON.stringify(message)}`);
check(/logo|icon|decorative/i.test(message), "...saying WHY it is asking", `the message does not explain why this region is different: ${JSON.stringify(message)}`);
check(/paints|background|photo/i.test(message), "...and what deleting it will do to the photo", `the message does not say what deleting does: ${JSON.stringify(message)}`);
check(/undo/i.test(message), "...and that Undo gets it back", `the message does not mention Undo: ${JSON.stringify(message)}`);

check(afterCancel.text === beforeCancel.text, "Cancel left the region's text exactly as it was", `Cancel changed the text from ${JSON.stringify(beforeCancel.text)} to ${JSON.stringify(afterCancel.text)}`);
check(afterCancel.text !== "", "...so the region was not deleted", "Cancel emptied the region anyway - dismiss deleted");
check(!afterCancel.patchShown, "...no patch was painted over the photo", "Cancel left an inpainted patch drawn over the photo, so the pixels were destroyed by a press of Cancel");
check(
  afterCancel.undoDepth === beforeCancel.undoDepth,
  "...and nothing was pushed onto the undo stack",
  `Cancel pushed an undo step (${beforeCancel.undoDepth} -> ${afterCancel.undoDepth}), so something happened that the user declined`
);

console.log("\n3. AN UNFLAGGED REGION DELETES EXACTLY AS BEFORE");
await select("__unflagged");
answerCancel(); // armed to dismiss, precisely so an unexpected dialog would BLOCK the delete
const beforePlain = await state("__unflagged");
await page.click("#delete-btn");
await page.waitForTimeout(900);
const afterPlain = await state("__unflagged");

check(dialogs.length === 0, "Delete on an unflagged region raises no dialog at all", `an unflagged region asked ${dialogs.length} question(s): ${JSON.stringify(dialogs.map((d) => d.message))} - the warning is firing where it should not, which is how people learn to dismiss it unread`);
check(afterPlain.text === "", "...and the word is emptied", `the unflagged word still reads ${JSON.stringify(afterPlain.text)} - deletion regressed for ordinary words`);
check(afterPlain.patchShown, "...with its inpainted patch drawn");
check(afterPlain.undoDepth > beforePlain.undoDepth, "...as one undoable step");

console.log("\n4. OK ON A FLAGGED REGION ACTUALLY DELETES IT");
await select("__flagged");
answerOk();
const beforeOk = await state("__flagged");
await page.click("#delete-btn");
await page.waitForTimeout(900);
const afterOk = await state("__flagged");
check(dialogs.length === 1, "OK path raises the confirm too", `expected 1 dialog, saw ${dialogs.length}`);
check(afterOk.text === "", "...and accepting empties the region", `after OK the region still reads ${JSON.stringify(afterOk.text)} - the confirm blocks the action it is supposed to gate`);
check(afterOk.patchShown, "...and paints the reconstructed background over it");
check(afterOk.undoDepth > beforeOk.undoDepth, "...as one undoable step");

console.log("\n5. RETIRING THE EMPTIED LEFTOVER DOES NOT ASK AGAIN");
// Those pixels are already gone and the patch is already drawn. A second prompt
// would protect nothing and would train the user to dismiss these unread.
await select("__flagged");
answerCancel();
await page.click("#delete-btn");
await page.waitForTimeout(400);
const afterRetire = await state("__flagged");
check(dialogs.length === 0, "deleting the already-emptied leftover asks nothing", `retiring an emptied region asked ${dialogs.length} question(s) about pixels that were already gone`);
check(afterRetire.removed, "...and retires it", "the emptied leftover was not retired");

console.log("\n6. THE FLAG IS A WARNING, NOT A FILTER");
// The half of this change most likely to go wrong later. Every flagged region
// must remain an ordinary word everywhere that is not the delete path.
const notFiltered = await page.evaluate(async () => {
  const { getActiveResultText } = await import("/js/editorExport.js");
  const { wordPasses } = await import("/js/filter.js");
  const { state } = await import("/js/state.js");
  const flagged = state.editorObjects.filter((o) => o.probablyNotText);
  const text = getActiveResultText();
  return {
    // Re-render fresh so the earlier deletions in this file don't confuse the
    // question - these are properties of a flagged region as scanned.
    everyFlaggedIsEditable: flagged.every((o) => o.el.getAttribute("role") === "textbox"),
    noneHiddenByFilter: flagged.every((o) => !o.el.classList.contains("is-filtered-out") || !wordPasses({ text: o.originalText, confidence: o.confidence }, state.activeFilterLevel, false)),
    noneDisplayNone: flagged.every((o) => o.removed || getComputedStyle(o.el).display !== "none"),
    extractedTextLength: text.length,
  };
});
check(notFiltered.everyFlaggedIsEditable, "a flagged region is still an editable textbox");
check(notFiltered.noneDisplayNone, "...still rendered", "a flagged region was hidden - that is suppression, not a warning");
check(
  notFiltered.noneHiddenByFilter,
  "...and is not excluded by the filter merely for being flagged",
  "a flagged region is dimmed as filtered-out for a reason the filter level does not justify - the flag has leaked into filtering"
);
check(notFiltered.extractedTextLength > 0, "...and the extracted text is not empty");

// The same question on the image where the rule fires hardest. 16% is the number
// that decided this must warn rather than suppress; if a future change starts
// filtering on the flag, this is where it would hurt most.
const page2 = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
await page2.goto(`http://localhost:${PORT}/index.html`);
await page2.setInputFiles("#file-input", join(ROOT, "test/images/complexPic2.jpeg"));
await page2.click("#scan-btn");
await page2.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
// Raw, deliberately. At the default "Filtered Text" level js/filter.js already
// drops single stray glyphs - "(c)", "-", "16" - and it has always done so, for
// reasons that predate and have nothing to do with this flag. Asking the
// question at that level would confuse "the flag filtered it" with "the filter
// filtered it", and the first run of this gate did exactly that. Raw excludes
// nothing, so anything missing here is missing because of the flag.
//
// Clicked here, still in Text mode: Phase 3 of the interaction-model rewrite
// made the filter set Text-mode only (inert elsewhere), so #filter-raw-btn is
// unreachable once #mode-full-btn is clicked. The chosen level persists in
// state.activeFilterLevel across the mode switch regardless (see
// test/chrome-reorganization.js), which is exactly what this section needs.
await page2.click("#filter-raw-btn");
await page2.waitForTimeout(300);
await page2.click("#mode-full-btn");
await page2.waitForTimeout(300);
const heavy = await page2.evaluate(async () => {
  const { getActiveResultText } = await import("/js/editorExport.js");
  const { state } = await import("/js/state.js");
  const words = state.editorObjects.filter((o) => o.type === "word" && o.origin === "ocr");
  const flagged = words.filter((o) => o.probablyNotText);
  const text = getActiveResultText();
  // Every flagged region's own text must still be findable in the output.
  const missingFromText = flagged
    .filter((o) => o.originalText.trim() && !text.includes(o.originalText.trim()))
    .map((o) => o.originalText);
  return {
    total: words.length,
    flagged: flagged.length,
    missingFromText,
    allFlaggedInExtractedText: missingFromText.length === 0,
  };
});
console.log(`  complexPic2: ${heavy.flagged}/${heavy.total} regions flagged (${((100 * heavy.flagged) / heavy.total).toFixed(1)}%)`);
check(heavy.flagged > 0, "complexPic2 still exercises the heavy-flagging case");
check(
  heavy.allFlaggedInExtractedText,
  "...and at Raw, every flagged region's text still reaches Copy/Download/TTS",
  `${heavy.missingFromText.length} flagged region(s) are missing from the Raw extracted text on the image that flags 16% of regions ` +
    `(${JSON.stringify(heavy.missingFromText)}) - the flag has become a silent filter, which is exactly what this was not supposed to be`
);
await page2.close();

} catch (err) {
  // A broken warning cascades: if the confirm stops gating, the flagged region
  // is already gone by the time a later section reaches for it, and something
  // downstream throws. Reporting what was already established beats an
  // unhandled rejection that discards it - the diagnosis is the point of a gate,
  // not the exit code.
  failures.push(`the run did not finish: ${String(err).split("\n")[0]}`);
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nDeleting a probably-not-text region asks first, Cancel leaves it untouched, ordinary words delete unchanged, and nothing is filtered out.");
