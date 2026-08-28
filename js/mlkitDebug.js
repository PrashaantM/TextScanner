// mlkitDebug.js: captures ML Kit's raw, untransformed recognition result so the
// Image format/Full image positioning bug can be diagnosed OFF the device.
//
// Why this exists: the on-device run rendered Image format as "gibberish" on
// complexPic1/2/6/7 and "really good" on 4/5/8/10, with no correlation to image
// dimensions or EXIF orientation. test/render-fidelity.js has since ruled out the
// renderer - fed perfect word boxes, js/editor.js's renderImageFormatView
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
// Two ways to get the dump off the device, in preference order:
//   1. Safari > Develop > <device> > TextScanner, then in the console:
//        copy(JSON.stringify(window.__textscannerDebug))
//   2. The JSON is also written to the app's Documents directory as
//      textscanner-mlkit-debug.json (Xcode > Window > Devices and Simulators >
//      the app > Download Container, then look in AppData/Documents).
//
// DIAGNOSTIC ONLY - delete this module, its import in mlkitEngine.js, and
// test/replay-dump.js once the positioning bug is understood.

const DUMP_FILE = "textscanner-mlkit-debug.json";

// Accumulates across scans in one session, keyed in order, so all 11 test images
// can be captured in a single pass rather than one file per image.
if (!window.__textscannerDebug) window.__textscannerDebug = { scans: [] };

// The bboxes are what's under investigation, so nothing here is normalized,
// rounded, or reshaped - ML Kit's JSON is kept as-is and only annotated with the
// image geometry the renderer positions against.
export async function recordScan({ label, naturalWidth, naturalHeight, rawResult, imageByteLength }) {
  const entry = {
    label,
    at: new Date().toISOString(),
    // What editor.js's renderImageFormatView divides every bbox by. If ML Kit's
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
