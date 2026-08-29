// mlkitDebug.js: captures ML Kit's raw, untransformed recognition result so the
// Image format/Full image positioning bug can be diagnosed OFF the device.
//
// OFF BY DEFAULT, AND INERT UNLESS EXPLICITLY ARMED. See "Arming it" below.
// Until then every export here is a no-op: nothing is recorded, nothing is
// written to disk, and window.__textscannerDebug is never even created. That
// matters because what this records is the full recognized text of every scan
// in a session, and it used to be written unconditionally to the app's
// Documents directory - which is included in unencrypted local backups and
// retrievable via Xcode's Download Container. A user who scanned a passport, a
// prescription or a bank statement left that text sitting in a plaintext JSON
// file indefinitely, on a build they had no way to tell was instrumented.
//
// Why this exists: the on-device run rendered Image format as "gibberish" on
// complexPic1/2/6/7 and "really good" on 4/5/8/10, with no correlation to image
// dimensions or EXIF orientation. test/render-fidelity.js has since ruled out the
// renderer - fed perfect word boxes, js/editorObjects.js's renderImageFormatView
// reproduces a poster's layout cleanly, large display text included. So the wrong
// coordinates are coming out of ML Kit (or out of how mlkitEngine.js reads them),
// and settling WHICH needs the raw numbers, which only exist on-device.
//
// This deliberately records ML Kit's output verbatim - both `boundingBox` (the
// axis-aligned rect mlkitEngine.js currently uses) AND `cornerPoints` (the rotated
// quad it currently ignores), for blocks, lines and elements alike - and changes
// no app behaviour whatsoever. One device run then produces a dump that
// test/replay-dump.js can replay offline against the same source image, so the
// diagnosis needs exactly one round trip to the device rather than one per guess.
//
// ---- Arming it ----
//
// There is no build step in this project to hang a compile-time flag off, so the
// gate is an explicit runtime opt-in that a shipped build can never satisfy on
// its own. Either:
//   - open the app with ?mlkitDebug=1 in the URL (works on the web build, and
//     persists the flag so it survives the reload), or
//   - set the flag directly from Safari > Develop > <device> > TextScanner:
//       localStorage.setItem("textscanner.debug.mlkit", "1")
//     then rescan. This is the native route, and it costs nothing extra: the
//     Web Inspector console is already where the dump gets collected from.
// Disarm with ?mlkitDebug=0, or localStorage.removeItem("textscanner.debug.mlkit").
//
// Retrieving a dump, once armed:
//   1. Safari > Develop > <device> > TextScanner, then in the console:
//        copy(JSON.stringify(window.__textscannerDebug))
//   2. The JSON is also written to the app's Documents directory as
//      textscanner-mlkit-debug.json (Xcode > Window > Devices and Simulators >
//      the app > Download Container, then look in AppData/Documents).
//
// DIAGNOSTIC ONLY - delete this module, its import in mlkitEngine.js, and
// test/replay-dump.js once the positioning bug is understood. It is gated rather
// than already deleted because the bug is still open: the one instrumented
// device run it was built for hasn't happened yet (see HANDOFF.md's Next action).

const DUMP_FILE = "textscanner-mlkit-debug.json";
const DEBUG_FLAG_KEY = "textscanner.debug.mlkit";

// Resolved once at module load. A scan can't quietly arm itself halfway through
// a session, and the check can't be re-run per scan on a whim - the flag has to
// be set deliberately, before the scan, by someone with a console or a URL bar.
const debugEnabled = resolveDebugFlag();

function resolveDebugFlag() {
  let enabled = false;
  try {
    enabled = localStorage.getItem(DEBUG_FLAG_KEY) === "1";
  } catch {
    // Private browsing / storage disabled. Stays off, which is the safe default.
  }

  try {
    const param = new URLSearchParams(window.location.search).get("mlkitDebug");
    if (param === "1" || param === "0") {
      enabled = param === "1";
      // Persist so the flag survives the WKWebView's own navigations, and so
      // disarming actually sticks rather than reverting on the next load.
      try {
        if (enabled) localStorage.setItem(DEBUG_FLAG_KEY, "1");
        else localStorage.removeItem(DEBUG_FLAG_KEY);
      } catch {
        // Same as above - the flag just won't persist past this page load.
      }
    }
  } catch {
    // No URL/searchParams available (shouldn't happen in a browser context).
  }

  return enabled;
}

// Exported so mlkitEngine.js and any future UI can tell whether a session is
// instrumented without duplicating the gate logic.
export function isMlkitDebugEnabled() {
  return debugEnabled;
}

// Accumulates across scans in one session, keyed in order, so all 11 test images
// can be captured in a single pass rather than one file per image. Only created
// once armed - an un-armed session leaves no stash to find at all.
if (debugEnabled && !window.__textscannerDebug) window.__textscannerDebug = { scans: [] };

// The bboxes are what's under investigation, so nothing here is normalized,
// rounded, or reshaped - ML Kit's JSON is kept as-is and only annotated with the
// image geometry the renderer positions against.
export async function recordScan({ label, naturalWidth, naturalHeight, rawResult, imageByteLength }) {
  if (!debugEnabled) return null;

  const entry = {
    label,
    at: new Date().toISOString(),
    // What renderImageFormatView divides every bbox by. If ML Kit's
    // coordinates are in some other space, the mismatch shows up as boxes whose
    // extent doesn't reach (or overshoots) these numbers.
    naturalWidth,
    naturalHeight,
    imageByteLength,
    // Cheap, immediately readable summary - the union of every element box. On a
    // correctly-scaled result this should roughly fill the image; anything far
    // short of it (or past it) is the bug, visible without any replay step.
    extent: computeExtent(rawResult),
    rawResult,
  };
  window.__textscannerDebug.scans.push(entry);

  try {
    const { Filesystem } = window.Capacitor.Plugins;
    await Filesystem.writeFile({
      path: DUMP_FILE,
      data: JSON.stringify(window.__textscannerDebug, null, 2),
      directory: "DOCUMENTS",
      encoding: "utf8",
    });
  } catch {
    // The in-memory window.__textscannerDebug copy is the primary channel; a
    // failed file write must never break a scan that otherwise worked.
  }
  return entry;
}

function computeExtent(rawResult) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let elements = 0;
  (rawResult?.blocks || []).forEach((block) =>
    (block.lines || []).forEach((line) =>
      (line.elements || []).forEach((el) => {
        const b = el.boundingBox;
        if (!b) return;
        elements++;
        minX = Math.min(minX, b.left);
        minY = Math.min(minY, b.top);
        maxX = Math.max(maxX, b.right);
        maxY = Math.max(maxY, b.bottom);
      })
    )
  );
  if (!elements) return { elements: 0 };
  return { elements, minX, minY, maxX, maxY };
}
