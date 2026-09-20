// offlineRecognition.js: the user-facing half of sw.js's lazy recognition bucket.
//
// THE GAP THIS CLOSES. sw.js caches the app shell eagerly and the 6.7 MB
// recognition payload - Tesseract's worker, one wasm core and the English
// language data - only on the first SUCCESSFUL scan. That split is deliberate:
// precaching 11 MB of vendor/tesseract at install would make every first visit
// pay for it, including the visits that never scan. README's offline paragraph
// states the consequence honestly: the FIRST scan still needs the network.
//
// The app did nothing with that. Someone who installs the PWA, never scans while
// online, then opens it on a plane got the generic "Part of the OCR engine
// couldn't load. Reload the page and try again." - advice that is actively wrong
// (reloading changes nothing) from a message that reads as the app being broken,
// for a situation that is expected, explainable and fixable.
//
// So two things live here: a sentence that names the real cause, and a way to
// fill the cache on purpose instead of waiting for a lucky online scan.
//
// ---------------------------------------------------------------------------
// WHY THE CORE FILENAME IS DETECTED RATHER THAN LISTED. js/ocrEngine.js passes
// Tesseract a corePath DIRECTORY and the worker appends its own filename after
// runtime feature detection, so there is no single right answer to cache - the
// two vendored cores are simd-lstm and plain lstm, and which one a device asks
// for is the device's business. Caching both would mean 10.5 MB for a payload
// that is 6.7 MB, and caching the wrong one would leave a device that had just
// been told "recognition works offline now" reaching for the network on its first
// scan, which is the exact failure this module exists to prevent.
//
// The detection therefore has to agree with the worker's EXACTLY, so the probe
// below is the byte-for-byte sequence lifted out of
// vendor/tesseract/worker.min.js rather than a reimplementation of the same idea.
// The worker's selection reads:
//
//     l ? (e ? "/tesseract-core-simd-lstm.wasm.js" : "/tesseract-core-simd.wasm.js")
//       : (e ? "/tesseract-core-lstm.wasm.js"      : "/tesseract-core.wasm.js")
//
// with `l` = SIMD available and `e` = LSTM-only, which js/ocrEngine.js pins by
// creating the worker with oem 1. So the two live branches are the -lstm pair.
//
// Agreement is not merely asserted: test/offline-recognition.js warms the cache
// through this module with NO prior scan, then goes offline and scans. A wrong
// core choice fails there.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

// What the control promises, as one string in one place so the UI and the docs
// cannot drift: worker.min.js (124 KB) + one core (3.76 MB) + eng.traineddata.gz
// (2.82 MB).
export const RECOGNITION_PAYLOAD_LABEL = "6.7 MB";

function simdAvailable() {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

export function recognitionCoreFilename() {
  return simdAvailable() ? "tesseract-core-simd-lstm.wasm.js" : "tesseract-core-lstm.wasm.js";
}

// Absolute, and resolved from document.baseURI exactly as
// js/ocrEngine.js's tesseractAssetPaths does, so these are the same URLs the
// worker will ask for on the deployed /TextScanner/ path.
export function recognitionPayloadUrls() {
  const at = (path) => new URL(path, document.baseURI).href;
  return [
    at("vendor/tesseract/worker.min.js"),
    at(`vendor/tesseract/core/${recognitionCoreFilename()}`),
    at("vendor/tesseract/tessdata/eng.traineddata.gz"),
  ];
}

// Asks the worker what it is caching under which name. sw.js already answers
// "sw:manifest" for test/offline.js, so this reuses that channel rather than
// adding a second one - and it means the cache NAME lives in exactly one place
// (sw.js) instead of being restated here where it could drift.
function swManifest(timeoutMs = 3000) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    // Never leave a settings panel spinning on a worker that does not answer.
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    channel.port1.onmessage = (event) => settle(event.data);
    try {
      controller.postMessage("sw:manifest", [channel.port2]);
    } catch {
      settle(null);
    }
  });
}

// The honest current state, with each distinguishable situation kept separate
// rather than collapsed into a boolean. A control that says "already saved" when
// it is actually "no worker here" would be lying in the direction that costs
// someone a scan on a plane.
//
//   unsupported  - no service worker in this browser at all
//   uncontrolled - a worker exists but is not driving this page (http dev, the
//                  Capacitor WKWebView, or a first load before it claims)
//   ready        - every payload file is cached
//   partial      - some but not all (an interrupted warm, or an eviction)
//   empty        - none of it
export async function recognitionCacheState() {
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    return { status: "unsupported", present: [], missing: [] };
  }
  const manifest = await swManifest();
  if (!manifest?.vendorCache) {
    return { status: "uncontrolled", present: [], missing: [] };
  }

  const wanted = recognitionPayloadUrls();
  let cachedUrls = [];
  try {
    if (await caches.has(manifest.vendorCache)) {
      const cache = await caches.open(manifest.vendorCache);
      cachedUrls = (await cache.keys()).map((request) => request.url);
    }
  } catch {
    // Storage refused outright. Reported as uncontrolled rather than empty,
    // because "press this button" is the wrong advice when the cache cannot be
    // read at all.
    return { status: "uncontrolled", present: [], missing: wanted };
  }

  const present = wanted.filter((url) => cachedUrls.includes(url));
  const missing = wanted.filter((url) => !cachedUrls.includes(url));
  const status = missing.length === 0 ? "ready" : present.length > 0 ? "partial" : "empty";
  return { status, present, missing, vendorCache: manifest.vendorCache };
}

// Fills the cache by REQUESTING the payload, not by asking the worker to. The
// worker's cacheFirst handler is what actually stores it, so this deliberately
// goes through the same path a real scan does - one mechanism, exercised the same
// way, rather than a parallel warm path that could drift from it.
//
// THE QUOTA CASE IS WHY THIS VERIFIES AFTERWARDS. Since the cache-write fixes,
// sw.js survives a failing cache.put silently: the fetch resolves, the page gets
// its bytes, and nothing is stored. That is right for a scan - the scan should not
// die because the disk is full - but it means a successful fetch here proves
// nothing about whether anything was SAVED. So the state is re-read at the end and
// the caller is told what is actually in the cache, not what was downloaded.
export async function warmRecognitionCache({ onProgress } = {}) {
  const before = await recognitionCacheState();
  if (before.status === "unsupported" || before.status === "uncontrolled") {
    return { ok: false, reason: before.status, state: before };
  }

  const urls = recognitionPayloadUrls();
  const fetchFailures = [];
  let done = 0;
  for (const url of urls) {
    onProgress?.({ done, total: urls.length });
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Drained so the worker sees a completed response to store. Without
      // reading the body the request can be cancelled before cacheFirst's put.
      await response.arrayBuffer();
    } catch (error) {
      fetchFailures.push(`${url.split("/").pop()}: ${error.message}`);
    }
    done += 1;
    onProgress?.({ done, total: urls.length });
  }

  const after = await recognitionCacheState();
  if (after.status === "ready") return { ok: true, state: after };
  if (fetchFailures.length) return { ok: false, reason: "network", failures: fetchFailures, state: after };
  // Everything downloaded and it is still not in the cache: the worker could not
  // store it. Quota is overwhelmingly the reason, so report the numbers.
  return { ok: false, reason: "storage", state: after, estimate: await storageEstimate() };
}

async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

// No formatBytes here on purpose: js/library.js already exports one and app.js
// already imports it. A second copy would be the textbook version of the drift
// ANALYSIS.md §1.2's one-source-of-truth rule exists to stop.

// Returns a sentence naming the real cause, or null to let
// describeScanError's generic categories handle it.
//
// GATED ON THE CACHE, NOT ON navigator.onLine. onLine is famously willing to say
// true on a captive portal, and false is not the only way this fails - a browser
// that evicted the payload (WebKit's 7-day cap on script-writable storage covers
// service worker caches) hits exactly this with the network up. So the question
// asked is the one that actually matters: did the engine files fail to load, and
// are they absent from the cache?
export async function describeOfflineRecognitionFailure(err) {
  const raw = String(err?.message || err || "");
  const looksLikeAssetLoad = /NetworkError|Failed to fetch|Load failed|importScripts|worker|wasm|WebAssembly/i.test(raw);
  if (!looksLikeAssetLoad) return null;

  let state;
  try {
    state = await recognitionCacheState();
  } catch {
    return null;
  }
  if (state.status === "ready") return null;
  if (state.status === "unsupported" || state.status === "uncontrolled") return null;

  const partial = state.status === "partial";
  return (
    `Recognition needs its engine files (${RECOGNITION_PAYLOAD_LABEL}) and ` +
    `${partial ? "only part of them is" : "they are not"} saved on this device yet. ` +
    `They are never fetched from anyone else - they ship with the app - but the first scan does ` +
    `need a connection. Go online and scan once, or use Settings › "Make recognition work ` +
    `offline" while you have a connection, and every scan after that works with the network off.`
  );
}
