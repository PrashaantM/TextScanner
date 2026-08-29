// recognize.js: picks the recognition engine at runtime - ML Kit (native,
// via Capacitor's iOS app shell), Tesseract.js (js/ocrEngine.js, unchanged)
// everywhere else, including the plain GitHub Pages web deployment. Same
// exported signature/return shape as ocrEngine.js's recognizeImage, so
// js/main.js's call site doesn't need to know which engine actually ran.
// This dispatch itself has no platform-specific branching at all (it's just
// isNativePlatform()), so it needed no changes when Android support was
// dropped and needs none if another native platform is ever added later.
//
// window.Capacitor only exists when running inside Capacitor's native
// CAPBridgeViewController WKWebView (it auto-injects the bridge before page
// JS runs, see js/mlkitEngine.js's header comment) - a plain browser never
// has it, so this safely falls through to the existing web path with no
// feature detection needed beyond the optional-chaining check below.

import { recognizeImage as recognizeWithTesseract } from "./ocrEngine.js";
import { recognizeImage as recognizeWithMlKit } from "./mlkitEngine.js";

// The single place that answers "which engine is this build actually running?".
// Everything else that needs to know - the footer's engine name, the native
// confidence-signal note - reads it from here rather than re-testing for
// Capacitor itself, so there's exactly one definition of "native".
export function isNativeEngine() {
  return !!window.Capacitor?.isNativePlatform?.();
}

// Display name for the engine that will handle the next scan. Used in
// user-facing copy, so it names the product a reader would recognize.
export function getEngineName() {
  return isNativeEngine() ? "Google ML Kit" : "Tesseract.js";
}

// Whether the active engine reports a real per-word confidence score.
// Tesseract does; ML Kit exposes none at all. The UI's low-confidence underline
// is only meaningful when this is true - otherwise its absence would read as
// "every word scored perfectly" rather than "there is nothing to score with".
export function engineProvidesConfidence() {
  return !isNativeEngine();
}

export async function recognizeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  if (isNativeEngine()) {
    return recognizeWithMlKit(previewImg, naturalWidth, naturalHeight, onProgress);
  }
  return recognizeWithTesseract(previewImg, naturalWidth, naturalHeight, onProgress);
}
