// piiDetect.js: finds PII-shaped text in a scan document page's OCR words, and
// converts each find into a redaction box in the page's own coordinate space.
//
// WHY THIS OPERATES ON `page.words`, NOT `state.editorObjects`. The obvious
// place to look for a word's bounding box is the OCR/image-format editor
// (js/editorObjects.js's `state.editorObjects`, built by renderImageFormatView)
// - it is a DOM-backed, per-word, boxed representation of exactly this kind.
// But that editor belongs to VIEWS.SCAN, the app's original single-image flow,
// and VIEWS.SCAN has no import of js/documents.js or js/scanDoc.js anywhere:
// the only connection from that flow into the document model is
// `bridge.addCurrentImageAsPage` (js/app.js), which commits the RAW previewImg
// as a brand-new page's pixels and carries none of the editor's word objects,
// edits or (if it had any) redactions along with it. There is no code path
// today - checked by reading, not assumed - that turns a `state.editorObjects`
// box into a `page.annotations` stroke, because there is no code path from that
// editor to any existing page at all.
//
// `page.words` is the word list that actually lives on the record redaction
// already targets. It is populated by js/scanDoc.js's recognizeSelected/
// recognizeAll, which call the exact same `recognizeImage()` js/recognize.js
// exports for VIEWS.SCAN - same `{ lineIndex, text, confidence, bbox }` shape
// (js/ocrEngine.js, js/mlkitEngine.js) - just run against `page.blobKey`'s own
// image instead of `previewImg`. That match matters for what follows.
//
// THE COORDINATE SPACES ARE THE SAME, AND NO TRANSFORM IS NEEDED. A word's
// `bbox` is `{x0, y0, x1, y1}` in the pixel space of whatever `naturalWidth`/
// `naturalHeight` was passed to `recognizeImage`. For a scan-doc page, that is
// `loaded.img.naturalWidth/naturalHeight` from `page.blobKey` (js/scanDoc.js's
// recognizeSelected), and `page.blobKey`'s pixel dimensions are always exactly
// `page.width` x `page.height` - every write path that changes the blob
// (addPageFromCanvas, rebuildPage) sets both from the same canvas in the same
// call. `page.width`/`page.height` is ALSO the space js/scanDoc.js's redaction
// overlay is sized against (`previewImageRect`) and the space its normalized
// 0-1 boxes are defined in (`boxFromDrag`, `strokeFromBox`). So a word's bbox
// and a hand-drawn redaction box already share an origin (top-left), a scale
// (page pixels) and an orientation (none applied beyond what the pixels
// already show) - because `rebuildPage` bakes crop, rotation and the filter
// into `page.blobKey` BEFORE anything ever OCRs it (its own header states the
// order: crop -> rotate -> filter -> burn). By the time `page.words` exists,
// whatever crop or rotation the page has is already baked into the pixels
// those words were measured against. The conversion below is therefore a
// straight linear rescale - divide by page.width/page.height - not a
// transform, and js/scanDoc.js's `test/pii-redaction.js` proves this against a
// page that really has been rotated, rather than only asserting it in prose.
//
// ML Kit additionally reports `word.frame` - a possibly-ROTATED quad - for a
// tilted word. This module ignores it and always uses `bbox`, which
// js/mlkitEngine.js documents as `envelopeOfQuad(quad)`: the axis-aligned
// envelope of that same quad. Redaction boxes here are axis-aligned rectangles
// (js/scanDoc.js's `strokeFromBox` has no rotation parameter), so the envelope
// is the right shape to draw regardless, and using it can only make a
// candidate's box a little LARGER than a tight rotated box would be - the safe
// direction for something that exists to make sure content is actually
// covered.

// ---- Detectors ----
//
// Each one is deliberately narrow, and the limits are stated here rather than
// left to be discovered:
//
//   SSN: format-shaped only (`\d{3}-\d{2}-\d{4}`). NOT validated against SSA
//   allocation rules (which area/group/serial combinations have ever actually
//   been issued) - there is no such rule checked here at all, not even the
//   well-known static exclusions (no 000/666/900-series area, no 00 group, no
//   0000 serial). Anything of that shape matches: an invoice or account number
//   formatted the same way will false-positive, and this detector cannot tell
//   the difference.
//
//   CREDIT_CARD: format-shaped (13-19 digits, optionally grouped with spaces
//   or dashes) AND Luhn-validated. Luhn is a checksum, not proof of a real,
//   active card - but it rejects the overwhelming majority of ordinary
//   digit runs of the right length (a phone number plus an extension, a long
//   invoice number), which format alone cannot.
//
//   EMAIL: a standard, permissive local@domain.tld pattern. Not a full RFC
//   5322 implementation - it will accept a few addresses that are not quite
//   legal and reject a few quoted-string edge cases nobody uses.
//
//   PHONE: two patterns and no more, stated here rather than implied to be
//   general coverage: NANP (US/Canada 10-digit, optionally parenthesized area
//   code, optional leading +1) and a loose "+<country code> <2-4 digit
//   groups>" international shape. Real numbers in most of the rest of the
//   world - and plenty within these two families written without separators
//   or with a leading 0 instead of a country code - will be MISSED. This is
//   the pattern set, not a claim of coverage beyond it.
//
// All four run over each LINE's text (words with the same lineIndex, joined
// by a single space, in OCR order) rather than one word at a time, because a
// credit card is routinely OCR'd as four separate 4-digit tokens and a phone
// number as two or three - matching only within a single word's text would
// miss both. js/filter.js's wordsToFilteredText groups words by lineIndex the
// same way and is the app's existing convention for "what is one line",
// followed here rather than invented fresh.

export const PII_KINDS = {
  SSN: "ssn",
  CREDIT_CARD: "credit-card",
  EMAIL: "email",
  PHONE: "phone",
};

export const PII_LABELS = {
  [PII_KINDS.SSN]: "SSN",
  [PII_KINDS.CREDIT_CARD]: "Credit card",
  [PII_KINDS.EMAIL]: "Email",
  [PII_KINDS.PHONE]: "Phone number",
};

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// A run of digit groups (13-23 characters including separators covers 13-19
// digits with up to 4 single-character separators between them), checked for
// digit COUNT and Luhn validity afterward rather than trying to encode "13 to
// 19 digits, however grouped" directly in the regex.
const CARD_CANDIDATE_RE = /\b\d(?:[\d \-]{11,21})\d\b/g;
// NANP: optional +1, optional parenthesized area code, 3-3-4 digits.
const PHONE_NANP_RE = /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g;
// Loose international: a leading +, then 2-4 digit groups.
const PHONE_INTL_RE = /\+\d{1,3}(?:[ .-]?\d{2,4}){2,5}\b/g;

function luhnValid(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alternate) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// Every match this module reports carries `[start, end)` character offsets
// into the LINE STRING it was found in, so the caller (buildLineIndex below)
// can map back to which word(s) it spans without re-searching.
function findMatches(lineText, kind) {
  const matches = [];

  if (kind === PII_KINDS.EMAIL) {
    EMAIL_RE.lastIndex = 0;
    for (const m of lineText.matchAll(EMAIL_RE)) matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    return matches;
  }

  if (kind === PII_KINDS.SSN) {
    SSN_RE.lastIndex = 0;
    for (const m of lineText.matchAll(SSN_RE)) matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    return matches;
  }

  if (kind === PII_KINDS.CREDIT_CARD) {
    CARD_CANDIDATE_RE.lastIndex = 0;
    for (const m of lineText.matchAll(CARD_CANDIDATE_RE)) {
      const digits = m[0].replace(/[ \-]/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      if (!luhnValid(digits)) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return matches;
  }

  if (kind === PII_KINDS.PHONE) {
    for (const re of [PHONE_NANP_RE, PHONE_INTL_RE]) {
      re.lastIndex = 0;
      for (const m of lineText.matchAll(re)) {
        // A bare "\d{3}-\d{2}-\d{4}"-shaped SSN also satisfies neither phone
        // pattern's digit grouping, so no cross-filtering against SSN_RE is
        // needed here - the shapes do not overlap.
        const digits = m[0].replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) continue;
        matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
    return matches;
  }

  return matches;
}

// Groups `words` into lines (consecutive run of the same lineIndex, matching
// js/filter.js's wordsToFilteredText), and for each line returns its joined
// text plus, for every word, the [start, end) character range that word
// occupies in that joined text - the exact information matchAll's offsets
// need to be mapped back to specific words.
function buildLineIndex(words) {
  const lines = [];
  let current = null;

  for (const word of words) {
    const text = word.text || "";
    if (!current || word.lineIndex !== current.lineIndex) {
      current = { lineIndex: word.lineIndex, parts: [], entries: [] };
      lines.push(current);
    }
    const joinedSoFar = current.parts.join(" ");
    const offset = joinedSoFar.length ? joinedSoFar.length + 1 : 0;
    current.parts.push(text);
    current.entries.push({ word, start: offset, end: offset + text.length });
  }

  return lines.map((line) => ({ text: line.parts.join(" "), entries: line.entries }));
}

function unionBbox(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

// Masks a candidate's matched text for display: the SHAPE stays visible (so
// someone can tell an SSN box from a phone box at a glance) but the digits
// that make it identifiable do not appear in the DOM, the undo history, or a
// screenshot of this panel. Only the last 4 characters of digit runs stay
// legible, matching the convention receipts and statements already use.
export function maskForDisplay(kind, text) {
  if (kind === PII_KINDS.EMAIL) return text; // not masked: needed to tell a false positive from a real one
  const keep = 4;
  const chars = text.split("");
  let digitsSeen = 0;
  const totalDigits = (text.match(/\d/g) || []).length;
  return chars
    .map((c) => {
      if (!/\d/.test(c)) return c;
      digitsSeen += 1;
      return digitsSeen > totalDigits - keep ? c : "•";
    })
    .join("");
}

// The main entry point. `words` is a page's `page.words` (or any array in the
// same `{ lineIndex, text, confidence, bbox }` shape). Returns candidates in
// OCR order: `{ kind, label, text, maskedText, bbox: {x0,y0,x1,y1}, wordCount }`.
export function detectPiiInWords(words) {
  if (!words || !words.length) return [];

  const lines = buildLineIndex(words);
  const candidates = [];

  // Priority order: the two validated/most-specific shapes first, so a
  // matched span is claimed before the loosest detector (PHONE) gets a chance
  // to also match a subset of the same digits. Each line tracks which
  // character ranges are already claimed.
  const ORDER = [PII_KINDS.EMAIL, PII_KINDS.CREDIT_CARD, PII_KINDS.SSN, PII_KINDS.PHONE];

  for (const line of lines) {
    const claimed = []; // [start, end) ranges already turned into a candidate on this line

    for (const kind of ORDER) {
      const matches = findMatches(line.text, kind);
      for (const match of matches) {
        const overlapsClaimed = claimed.some((c) => match.start < c.end && match.end > c.start);
        if (overlapsClaimed) continue;

        const coveredWords = line.entries
          .filter((e) => e.start < match.end && e.end > match.start)
          .map((e) => e.word);
        if (!coveredWords.length) continue;

        claimed.push({ start: match.start, end: match.end });
        const bbox = unionBbox(coveredWords.map((w) => w.bbox));
        candidates.push({
          kind,
          label: PII_LABELS[kind],
          text: match.text,
          maskedText: maskForDisplay(kind, match.text),
          bbox,
          wordCount: coveredWords.length,
        });
      }
    }
  }

  // Reading order: top-to-bottom, then left-to-right - matches how someone
  // scans the page while reviewing the candidate list against it.
  candidates.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  return candidates;
}

// Converts one candidate's pixel-space bbox into the normalized 0-1 box shape
// js/scanDoc.js's hand-drawn boxes already use (see boxFromDrag there) - the
// one real conversion this module exists to do. `pageWidth`/`pageHeight` must
// be the PAGE's own dimensions (page.width/page.height), because that is the
// space `bbox` was measured in - see this file's header.
export function bboxToNormalizedBox(bbox, pageWidth, pageHeight) {
  if (!pageWidth || !pageHeight) return null;
  const x = Math.max(0, bbox.x0 / pageWidth);
  const y = Math.max(0, bbox.y0 / pageHeight);
  return {
    x,
    y,
    width: Math.min(1, bbox.x1 / pageWidth) - x,
    height: Math.min(1, bbox.y1 / pageHeight) - y,
  };
}
