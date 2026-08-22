// recognize.js: picks the recognition engine at runtime - ML Kit (native,
// via Capacitor) inside the Android app shell, Tesseract.js (js/ocrEngine.js,
// unchanged) everywhere else, including the plain GitHub Pages web
// deployment. Same exported signature/return shape as ocrEngine.js's
// recognizeImage, so js/main.js's call site doesn't need to know which
// engine actually ran.
//
// window.Capacitor only exists when running inside Capacitor's native
// BridgeActivity WebView (it auto-injects the bridge before page JS runs,
// see js/mlkitEngine.js's header comment) - a plain browser never has it, so
// this safely falls through to the existing web path with no feature
// detection needed beyond the optional-chaining check below.

import { recognizeImage as recognizeWithTesseract } from "./ocrEngine.js";
import { recognizeImage as recognizeWithMlKit } from "./mlkitEngine.js";

export async function recognizeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  if (window.Capacitor?.isNativePlatform?.()) {
    return recognizeWithMlKit(previewImg, naturalWidth, naturalHeight, onProgress);
  }
  return recognizeWithTesseract(previewImg, naturalWidth, naturalHeight, onProgress);
}
