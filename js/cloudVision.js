// cloudVision.js: the BYOK cloud tier of RECOGNITION - sends the photograph to
// Anthropic's Claude API and returns a plain-text transcript. It does NOT return
// geometry and is not asked to; js/transcriptAlign.js aligns what comes back
// onto the word boxes the local engine measured, and js/recognize.js is the only
// caller of either.
//
// THE SAME SEAM AND THE SAME OPT-IN AS THE COHERENCE FILTER, deliberately.
// js/coherenceClaude.js already established every part of this: the key lives in
// localStorage under LOCAL_KEY_ANTHROPIC_API and nowhere else, the call goes
// straight from the browser to api.anthropic.com with
// anthropic-dangerous-direct-browser-access (this project has no server and no
// build step, and adding one to hide a key would be a bigger architecture change
// than the feature warrants), and the honest consequence - anyone with access to
// this browser profile, and on the web build anyone else on the shared github.io
// origin, can read the key back - is disclosed in the UI rather than
// rationalised. Reusing that key rather than adding a second one is the point:
// there is one place a key is entered, one place it is cleared
// (js/store.js's clearAll), and one thing to warn about.
//
// OFF BY DEFAULT, AND THE DEFAULT IS NOT A DETAIL. Local recognition stays the
// path for every user who does not turn this on, and it stays the path for a
// user who turns it on and then has no key, no network, or a refused request -
// js/recognize.js falls back to the local result rather than failing the scan.
// The only thing the flag changes is whether a scan is ALLOWED to leave the
// device; the disclosure below fires on every scan that actually does.
//
// WHY A SEPARATE FLAG FROM "has a key". A saved key means the person opted into
// sending TEXT for the Coherence Filter, on a screen that says so. Sending the
// PHOTOGRAPH is a materially larger disclosure - a picture of a prescription, a
// bank statement, a passport - and inheriting consent from one to the other is
// exactly the kind of quiet scope creep this app's threat model (ANALYSIS.md
// §4.1) exists to prevent. So it is its own explicit toggle, and having a key is
// necessary but not sufficient.

import { getStoredApiKey } from "./coherenceClaude.js";
import { LOCAL_KEY_CLOUD_RECOGNITION } from "./store.js";

const API_URL = "https://api.anthropic.com/v1/messages";
// The same model js/coherenceClaude.js uses. One model in the app means one
// thing to re-verify when it moves, and the vision and text paths have no
// reason to diverge.
const MODEL = "claude-opus-5";
// A dense page is the sizing case: complexPic3's ground truth alone is 7,351
// characters, which is roughly 1,900 tokens of output before any structure. This
// leaves headroom for the densest image in the corpus and several times over for
// an ordinary one.
const MAX_TOKENS = 8192;
// Anthropic downscales anything larger than 1568px on the long edge server-side
// before the model sees it, so sending more costs upload time and nothing else.
// Capping here rather than relying on that makes the token cost - and therefore
// the money cost - a property of this file rather than of whatever camera took
// the photo. Image tokens are approximately (w x h) / 750, so this caps one
// image at roughly 2,500 tokens whatever its source resolution.
const MAX_IMAGE_EDGE = 1568;
// JPEG rather than PNG, and 0.85 rather than 1.0: the request body is base64, so
// bytes are latency. Measured on this corpus, 0.85 is visually indistinguishable
// on text at this resolution and roughly a third the size of 0.95.
const JPEG_QUALITY = 0.85;

// The transcript this asks for has one job - characters in reading order, one
// line per line of the image - because everything else the app needs (which word
// is where, how big, in what face) comes from the local engine's geometry, not
// from here. Asking for anything more would be asking the model to do a job that
// js/transcriptAlign.js's header explains it cannot do.
//
// THE GROUP-COMPLETE READING-ORDER RULE IS THE ONE PART OF THIS PROMPT THAT WAS
// MEASURED RATHER THAN WRITTEN, and it matters more than anything else in here.
//
// The first version said "top to bottom, and within a horizontal band, left to
// right". On complexPic3 - a nine-panel UI mockup, and 58.8% of the corpus's
// gated text - that produced a transcript whose words are 93.8% correct as a BAG
// (bag-of-words WER 6.2%) and 67.3% wrong AS A SEQUENCE. The model was reading
// all four panel headings across the top, then all four panels' first rows, and
// so on. Every character was right and the serialization was unusable.
//
// The rule below is not a corpus-specific patch. It is the same intent
// js/ocrEngine.js's orderRegionsForReading already implements for the local
// path, where its comment explains that it sorts at BLOCK granularity precisely
// so "a grid of same-height UI panel screenshots" is not scrambled by
// interleaving unrelated panels whose rows land at similar heights. Both halves
// of the app now state the same reading-order contract.
//
// DISCLOSED, because it is the circularity this project keeps naming: the defect
// was FOUND by scoring against the same eight images that set every threshold in
// this pipeline, and the fix's benefit is measured on them too. The
// justification above is independent of the corpus; the evidence that it
// mattered is not.
const SYSTEM_PROMPT = `You are a transcription engine. You will be given a photograph or screenshot. Transcribe every piece of text visible in it.

Rules:
- Output ONLY the transcribed text. No preamble, no commentary, no markdown, no explanation, no description of the image.
- Read each visually distinct GROUP completely before moving to the next one. A group is a panel, a card, a dialog, a table, a sign, a product package, a column of text - anything a person would take in as one unit. Never interleave text from two groups, even when their lines happen to sit at the same height.
- Order the groups the way a person would: top to bottom, and left to right among groups at a similar height. Read a multi-column layout one full column at a time, not across the columns.
- One line of output per visual line of text. Do not merge two visual lines into one, and do not split one visual line across two.
- Transcribe exactly what is written, including misspellings, stylised capitalisation, partial words, prices, phone numbers, units and punctuation. Do not correct, translate, expand, summarise or paraphrase anything.
- Include small print, captions, labels, watermarks, button text, and text on packaging or signage. If text is genuinely illegible, omit that text rather than guessing at it.
- Do not transcribe decorative marks, logos without lettering, or illustrations as if they were text.
- If the image contains no text at all, output nothing.`;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private browsing / storage disabled: the preference just won't persist
    // across reloads, which is a degraded experience, not a crash. Same
    // treatment as js/coherenceClaude.js's key storage.
  }
}

// Whether the person has explicitly turned cloud recognition on. Off unless the
// stored value is exactly "1", so any unexpected value fails closed.
export function isCloudRecognitionEnabled() {
  return readStorage(LOCAL_KEY_CLOUD_RECOGNITION) === "1";
}

export function setCloudRecognitionEnabled(enabled) {
  writeStorage(LOCAL_KEY_CLOUD_RECOGNITION, enabled ? "1" : "");
}

// Both halves are required before a scan may leave the device: the explicit
// toggle AND a key. See the header on why having a key is not consent on its own.
export function cloudRecognitionReady() {
  return isCloudRecognitionEnabled() && !!getStoredApiKey();
}

// Draws the image into a canvas capped at MAX_IMAGE_EDGE and returns base64 JPEG
// bytes with the data: prefix stripped, which is what the API wants.
//
// Through a canvas rather than reading the original bytes, for two reasons that
// both matter: the file may be HEIC, which the browser can decode and the API
// does not accept (js/ocrEngine.js has the same problem from the other side),
// and canvas output is EXIF-free and upright by construction, so the transcript
// can never be of a sideways image while the boxes are of an upright one.
function encodeImageForApi(previewImg, naturalWidth, naturalHeight) {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(previewImg, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const comma = dataUrl.indexOf(",");
  return { data: comma >= 0 ? dataUrl.slice(comma + 1) : "", width, height };
}

/**
 * Sends the image to Claude and returns { transcript, usage, encodedWidth,
 * encodedHeight }. Throws an Error whose message is safe to show directly in the
 * UI, exactly as js/coherenceClaude.js's rewriteWithClaude does - js/recognize.js
 * catches it and falls back to the local result.
 *
 * `onProgress` is the same { status, progress } shape Tesseract's logger emits,
 * so the existing progress bar in js/main.js renders it with no changes. It is
 * also where the per-scan disclosure lives: the status text says the image is
 * being sent, on every scan that sends one.
 */
export async function transcribeImage(previewImg, naturalWidth, naturalHeight, onProgress) {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error("Cloud recognition is on but no API key is saved.");

  const report = (status, progress) => {
    if (typeof onProgress === "function") onProgress({ status, progress });
  };

  report("preparing image for cloud recognition", 0.05);
  const image = encodeImageForApi(previewImg, naturalWidth, naturalHeight);
  if (!image.data) throw new Error("Couldn't prepare the image for cloud recognition.");

  // The disclosure, on every scan that actually sends one. Not a one-time
  // consent screen that a person stops seeing after the first week.
  report("sending this image to Claude for recognition", 0.15);

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Transcription is not a reasoning task - the characters are either in
        // the pixels or they are not - so the cheapest effort setting is the
        // right one. js/coherenceClaude.js makes the same call for the same
        // reason.
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.data } },
              { type: "text", text: "Transcribe all text in this image." },
            ],
          },
        ],
      }),
    });
  } catch {
    throw new Error("Couldn't reach Claude's API - check your connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("That API key was rejected. Check it and try again.");
    if (response.status === 429) throw new Error("Rate limited by the API. Wait a moment and try again.");
    if (response.status >= 500) throw new Error("Claude's API is temporarily unavailable. Try again shortly.");
    throw new Error(`Cloud recognition failed (status ${response.status}).`);
  }

  report("reading the transcript back", 0.85);
  const data = await response.json();
  // stop_reason "refusal" arrives as HTTP 200 with no usable text, so content
  // has to be checked rather than assumed - see the Messages API's stop reasons.
  const transcript = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!transcript) throw new Error("Claude returned no text for this image.");

  return {
    transcript,
    // Returned so a caller can report what the scan actually cost. The API is
    // the only place this is knowable; estimating it from the image dimensions
    // would be a guess dressed as a measurement.
    usage: data.usage || null,
    encodedWidth: image.width,
    encodedHeight: image.height,
  };
}

// ---------------------------------------------------------------------------
// The Settings toggle.
//
// WIRED HERE RATHER THAN IN js/app.js, WHICH IS WHERE EVERY OTHER SETTINGS
// CONTROL IS WIRED, and that inconsistency is deliberate but not ideal. This
// change is scoped to the recognition engine and its own modules; js/app.js
// belongs to a different change running in parallel, and editing it would mean
// two branches touching the same wiring block. The control is therefore owned by
// the module that owns the decision it makes - js/recognize.js imports this and
// calls the initialiser - and re-homing it alongside settings-persist and
// settings-offline-recognition is a follow-up worth doing, not a second
// mechanism worth keeping.
//
// No inline handler and no inline <script>: index.html's CSP is
// script-src 'self' 'wasm-unsafe-eval' with no 'unsafe-inline', so either would
// be refused outright (the same constraint that forced
// js/serviceWorkerRegistration.js to be a module). The checkbox also carries no
// style attribute, because style-src 'self' blocks style ATTRIBUTES too.
export function initCloudRecognitionControl() {
  const checkbox = document.getElementById("settings-cloud-recognition");
  if (!checkbox) return;
  checkbox.checked = isCloudRecognitionEnabled();
  checkbox.addEventListener("change", () => setCloudRecognitionEnabled(checkbox.checked));
}
