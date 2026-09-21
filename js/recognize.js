// recognize.js: picks the recognition engine at runtime - ML Kit (native,
// via Capacitor's iOS app shell), the hybrid cloud tier (opt-in, BYOK, web and
// native both), and Tesseract.js (js/ocrEngine.js, unchanged) everywhere else,
// including the plain GitHub Pages web deployment. Same exported
// signature/return shape as ocrEngine.js's recognizeImage, so js/main.js's call
// site doesn't need to know which engine actually ran.
//
// window.Capacitor only exists when running inside Capacitor's native
// CAPBridgeViewController WKWebView (it auto-injects the bridge before page
// JS runs, see js/mlkitEngine.js's header comment) - a plain browser never
// has it, so this safely falls through to the existing web path with no
// feature detection needed beyond the optional-chaining check below.
//
// ---------------------------------------------------------------------------
// THE THIRD BRANCH, and why it is a HYBRID rather than a third engine.
//
// Local recognition has a measured ceiling and both halves of it have now been
// hit. Seventeen categorical engine/preprocessing variants were swept over the
// full corpus and none helps without also hurting (RECOGNITION-SPIKE.md §3), and
// the one serious local alternative was rejected twice over
// (test/research/paddle-bakeoff/paddleocr-bakeoff.md): it reads this corpus
// better and CANNOT PLACE A WORD, and detection alone costs 2.30x the entire
// Tesseract payload, 87% of that being the ONNX runtime rather than the model.
//
// A vision model reads the corpus far better still, and has the same defect in a
// worse form: it returns a transcript and no geometry at all. Sending the image
// and using the text is a one-line change that produces perfect characters and
// an empty editor - which is the app's entire differentiator (README.md's front
// page) deleted to win a benchmark.
//
// So the cloud branch does not replace the local engine, it employs it. The
// local engine keeps the job it is measurably excellent at - finding where each
// word is, at 0.835 mean IoU and 0.4 px median centre error - and the model
// supplies the characters it is measurably bad at. js/transcriptAlign.js aligns
// one onto the other, and its header is where the alignment's behaviour on
// disagreement is set out in full. This file only routes.
//
// OFF BY DEFAULT. LOCAL IS STILL THE DEFAULT PATH. Two independent things must
// both be true before a scan leaves the device - the explicit Settings toggle
// AND a saved API key (js/cloudVision.js explains why having a key is not itself
// consent to upload a photograph) - and if the call fails for any reason, the
// local result this branch already computed is returned instead of the scan
// failing. Nobody who has not opted in is affected by any of this, and nobody
// who has opted in loses a scan to a flat network.

import { recognizeImage as recognizeWithTesseract } from "./ocrEngine.js";
import { recognizeImage as recognizeWithMlKit } from "./mlkitEngine.js";
import { cloudRecognitionReady, transcribeImage, initCloudRecognitionControl } from "./cloudVision.js";
import { alignTranscriptToWords } from "./transcriptAlign.js";

// The single place that answers "which engine is this build actually running?".
// Everything else that needs to know - the footer's engine name, the native
// confidence-signal note - reads it from here rather than re-testing for
// Capacitor itself, so there's exactly one definition of "native".
export function isNativeEngine() {
  return !!window.Capacitor?.isNativePlatform?.();
}

// Display name for the engine that will handle the next scan. Used in
// user-facing copy, so it names the product a reader would recognize.
//
// The cloud tier names BOTH halves, because naming only Claude would be a false
// statement about where the word boxes come from and naming only the local
// engine would hide that the image leaves the device.
export function getEngineName() {
  if (cloudRecognitionReady()) return `Claude + ${isNativeEngine() ? "Google ML Kit" : "Tesseract.js"}`;
  return isNativeEngine() ? "Google ML Kit" : "Tesseract.js";
}

// Whether the active engine reports a real per-word confidence score.
// Tesseract does; ML Kit exposes none at all. The UI's low-confidence underline
// is only meaningful when this is true - otherwise its absence would read as
// "every word scored perfectly" rather than "there is nothing to score with".
//
// The cloud tier is in ML Kit's position and is treated the same way. The words
// on screen carry the MODEL's characters, and a vision model reports no per-word
// confidence, so there is no score behind them - carrying Tesseract's confidence
// forward would be worse than carrying none, because it would describe text that
// is no longer there (a word Tesseract read at 30 and the model corrected would
// be flagged as doubtful precisely because it had just been fixed).
//
// js/transcriptAlign.js therefore sets confidence to null on every word placed
// on a real local box, exactly as js/mlkitEngine.js does, and the one number it
// does emit is not a confidence score at all - it marks the words whose POSITION
// was interpolated because the local engine never found them. That file's
// CONFIDENCE block has the full reasoning and the two thresholds the value sits
// between.
export function engineProvidesConfidence() {
  if (cloudRecognitionReady()) return false;
  return !isNativeEngine();
}

// The local engine for this platform. Both halves of the hybrid go through here,
// so the cloud branch cannot drift away from what a local scan would have done.
//
function recognizeLocally(previewImg, naturalWidth, naturalHeight, onProgress) {
  if (isNativeEngine()) return recognizeWithMlKit(previewImg, naturalWidth, naturalHeight, onProgress);
  return recognizeWithTesseract(previewImg, naturalWidth, naturalHeight, onProgress);
}

// The hybrid. Runs the local engine for geometry, asks the model for characters,
// and aligns the two. Returns the SAME { words, text, preprocessed } shape as
// either engine alone.
//
// The local pass runs FIRST and unconditionally, which is what makes the failure
// path free: by the time the network is touched there is already a complete,
// usable result in hand, so a refused key, a flat connection, a 429 or a refusal
// costs the user nothing but the wait.
async function recognizeHybrid(previewImg, naturalWidth, naturalHeight, onProgress) {
  // CONCURRENTLY, not one then the other. The two halves need nothing from each
  // other - one reads pixels on this device, the other uploads them - so running
  // them in sequence would add the round trip to a local pass that is already the
  // slow part. Measured: the local pass is 1.0-29.3s across the corpus and the
  // API round trip is seconds, so sequencing costs roughly the whole round trip
  // on every scan for nothing.
  //
  // allSettled rather than all: a rejected cloud half must NOT reject the local
  // half, which is the entire fallback guarantee. Promise.all would discard a
  // perfectly good local result because the network was flat.
  const [localOutcome, cloudOutcome] = await Promise.allSettled([
    recognizeLocally(previewImg, naturalWidth, naturalHeight, onProgress),
    transcribeImage(previewImg, naturalWidth, naturalHeight, onProgress),
  ]);

  // The local half throwing is a real scan failure with nothing to fall back to,
  // so it propagates exactly as it would on the local path.
  if (localOutcome.status === "rejected") throw localOutcome.reason;
  const local = localOutcome.value;

  let transcript;
  try {
    if (cloudOutcome.status === "rejected") throw cloudOutcome.reason;
    ({ transcript } = cloudOutcome.value);
  } catch (err) {
    // Deliberately console.warn and not console.error: this is a handled
    // degradation with a complete result behind it, not a failure. test/browser.js
    // fails a gate on any unclaimed console.error, and spending that signal on
    // an outcome the user is about to be told about in the status line would
    // train everyone to allow-list it.
    console.warn("TextScanner cloud recognition unavailable, using local result:", err.message);
    if (typeof onProgress === "function") {
      onProgress({ status: `cloud recognition unavailable (${err.message}) - showing local result`, progress: 1 });
    }
    return local;
  }

  const { words, stats } = alignTranscriptToWords(local.words, transcript, naturalWidth, naturalHeight);
  // An empty alignment means the transcript could not be turned into anything
  // placeable. Keeping the local result is strictly better than showing nothing.
  if (!words.length) return local;

  if (typeof onProgress === "function") {
    const inferred = stats.inferredWords
      ? `, ${stats.inferredWords} placed approximately where the local engine found no text`
      : "";
    onProgress({ status: `recognized by Claude on ${stats.placedWords} located words${inferred}`, progress: 1 });
  }

  return {
    words,
    // Rebuilt from the aligned words rather than passed through from either
    // source. The local engine's `text` describes text that is no longer on
    // screen, and the raw transcript describes words that may have been dropped
    // as unconfirmed - only the aligned list is true of both views at once.
    text: linesToText(words),
    preprocessed: local.preprocessed,
  };
}

// The aligned word list's own plain text, grouped back into lines. Mirrors
// js/filter.js's wordsToFilteredText at level "raw" without importing it, since
// that module is about FILTERING and this is the engine seam.
function linesToText(words) {
  const lines = [];
  let currentLineIndex = null;
  let current = [];
  for (const word of words) {
    if (word.lineIndex !== currentLineIndex) {
      if (current.length) lines.push(current.join(" "));
      current = [];
      currentLineIndex = word.lineIndex;
    }
    current.push(word.text);
  }
  if (current.length) lines.push(current.join(" "));
  return lines.join("\n").trim();
}

// Settings' cloud-recognition checkbox, wired from the module that owns the
// dispatch it controls. See initCloudRecognitionControl's own comment for why it
// is not in js/app.js with the other Settings controls.
//
// Guarded on `document` rather than assumed: test/unit/bbox.test.js already
// proves this repo imports engine modules in plain Node, and js/ocrEngine.js's
// header records a real break from touching document.baseURI at module load.
// A module script is deferred, so by the time this runs in a browser the
// document is parsed and the checkbox exists.
if (typeof document !== "undefined") initCloudRecognitionControl();

export async function recognizeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  if (cloudRecognitionReady()) {
    return recognizeHybrid(previewImg, naturalWidth, naturalHeight, onProgress);
  }
  return recognizeLocally(previewImg, naturalWidth, naturalHeight, onProgress);
}
