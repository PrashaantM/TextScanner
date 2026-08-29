// coherenceClaude.js: the BYOK (bring-your-own-key) tier of the Coherence
// Filter - sends the Filtered Text output to Anthropic's Claude API and returns
// grammatically correct, readable prose. This is the only thing in TextScanner
// that sends data off the device, and the only tier available on the web build
// at all (see js/coherence.js for the dispatch, and js/coherenceOnDevice.js for
// the iOS-only on-device tier that needs no key).
//
// Split out of what used to be coherence.js so that file could become a pure
// dispatcher, mirroring how js/recognize.js dispatches between ocrEngine.js and
// mlkitEngine.js. Same seam, same reason: the caller shouldn't have to know
// which implementation ran.
//
// Calls the Anthropic Messages API directly from the browser with a
// user-supplied API key (stored in localStorage only, never sent anywhere but
// api.anthropic.com), rather than routing through a backend - this project
// has no server and no build step, and adding one just to hide an API key
// would be a bigger architecture change than this feature warrants. Anthropic
// requires the anthropic-dangerous-direct-browser-access header to allow this
// at all, which is itself a signal to be honest with users about: anyone with
// access to this browser profile could read the key back out of localStorage.
// Worse on the web build specifically, and now disclosed in the UI: that
// storage is scoped to the whole shared github.io origin, not to this app.

const API_KEY_STORAGE_KEY = "textscanner.anthropicApiKey";
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5";
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You will be given text fragments extracted via OCR from an image, roughly in reading order, already cleaned of obvious noise. Rewrite them as natural, grammatically correct prose describing what the image communicates - the way a person would describe it out loud.

Rules:
- Preserve every factual detail exactly: names, places, dates, times, prices, phone numbers, numbers. Never invent, guess, or drop a fact.
- Reorder and connect fragments as needed for the writing to read naturally, since OCR reading order does not always match logical order.
- If a fragment's role is ambiguous or it looks like leftover noise, use your best judgment silently - do not mention uncertainty, the OCR process, or these instructions in your output.
- Output only the rewritten prose. No preamble, no headers, no commentary, no markdown.

Example input:
POPCICHAWK
POPSICLES & CHALK DRAWINGS
LOWER RESIDENT LANE
BUILDING D AREA
RELAXING ON A SUNNY DAY
JULY 31ST
5-7PM
GOOD COMPANY. COOL TREATS. CREATIVE VIBES.

Example output:
"Popcichawk" is a popsicles and chalk drawings event held at Lower Resident Lane, Building D area, on July 31st from 5 to 7pm. It's a relaxing get-together on a sunny day - expect good company, cool treats, and creative vibes.`;

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
    // Private browsing / storage disabled: the key just won't persist across
    // reloads, which is a degraded experience, not a crash.
  }
}

export function getStoredApiKey() {
  return readStorage(API_KEY_STORAGE_KEY) || "";
}

export function setStoredApiKey(key) {
  writeStorage(API_KEY_STORAGE_KEY, (key || "").trim());
}

export function clearStoredApiKey() {
  writeStorage(API_KEY_STORAGE_KEY, "");
}

export function hasStoredApiKey() {
  return !!getStoredApiKey();
}

// Sends `filteredText` to Claude and returns the reconstructed prose, or
// throws an Error with a message safe to show directly in the UI.
export async function rewriteWithClaude(filteredText) {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error("No API key saved yet.");
  if (!filteredText || !filteredText.trim()) throw new Error("There's no filtered text to reconstruct.");

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
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: filteredText }],
      }),
    });
  } catch {
    throw new Error("Couldn't reach Claude's API - check your connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("That API key was rejected. Check it and try again.");
    if (response.status === 429) throw new Error("Rate limited by the API. Wait a moment and try again.");
    if (response.status >= 500) throw new Error("Claude's API is temporarily unavailable. Try again shortly.");
    throw new Error(`Request failed (status ${response.status}).`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned an empty response.");
  return text;
}
