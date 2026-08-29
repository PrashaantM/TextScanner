// translateClaude.js: the BYOK tier of translate-in-place. Uses the same stored
// Anthropic key as the Coherence Filter (js/coherenceClaude.js owns the key
// storage; this module only reads it through there), and is the only tier the
// web build has, since there is no on-device model in a plain browser.
//
// Unlike the on-device tier, this batches every line into ONE request. That is
// the right trade here and the wrong one there: a round trip is billed and slow,
// the model is large enough to hold a numbered list in strict correspondence,
// and translating a sign's lines together gives it the context to get shared
// terminology and register consistent across them - which per-line translation
// measurably does not.
//
// The correspondence is still checked rather than trusted. If the response
// doesn't come back with exactly one numbered line per input line, the batch is
// rejected and retried line by line, because a silent off-by-one here means
// putting the wrong words on the wrong part of someone's image.

import { getStoredApiKey } from "./coherenceClaude.js";
import { findLanguage } from "./translateLanguages.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5";
const MAX_TOKENS = 4096;

function systemPrompt(languageName) {
  return `You translate short text lines extracted from a photograph into ${languageName}.

You will receive numbered lines, one per line, in the form "12<TAB>text".
Return exactly the same numbers, in the same order, in the same "12<TAB>translation" form, one per line.

Rules:
- Output only those numbered lines. No preamble, no commentary, no markdown, no blank lines.
- Return a line for every input number, even if the translation is identical to the input.
- Preserve numbers, prices, times, phone numbers, and proper names exactly as they appear.
- Keep each translation about as short as its original. This text is being placed back into the same space on an image.
- Translate the lines as one connected piece of text, so shared terms and register stay consistent between them.
- If a line is already in ${languageName}, or is a bare number or name with nothing to translate, return it unchanged.`;
}

async function callClaude(apiKey, system, userContent) {
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
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch {
    throw new Error("Couldn't reach Claude's API - check your connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("That API key was rejected. Check it and try again.");
    if (response.status === 429) throw new Error("Rate limited by the API. Wait a moment and try again.");
    if (response.status >= 500) throw new Error("Claude's API is temporarily unavailable. Try again shortly.");
    throw new Error(`Translation request failed (status ${response.status}).`);
  }

  const data = await response.json();
  return (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

// Parses "<index><TAB><text>" lines back into an array positioned by index.
// Returns null if anything doesn't line up, which is the signal to fall back to
// per-line translation rather than to guess at the alignment.
function parseNumbered(responseText, expectedCount) {
  const out = new Array(expectedCount).fill(null);
  for (const raw of responseText.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)[\t.):]\s?(.*)$/);
    if (!match) return null;
    const index = Number(match[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) return null;
    out[index] = match[2];
  }
  if (out.some((v) => v === null)) return null;
  return out;
}

// Translates `lines` into the given language code.
// onProgress({ done, total }) is called as work completes - once for the batch
// when it succeeds, per line when it has to fall back.
export async function translateLinesWithClaude(lines, targetCode, onProgress) {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error("No API key saved yet.");
  const language = findLanguage(targetCode);
  if (!language) throw new Error("Unknown target language.");

  const system = systemPrompt(language.name);
  const indexed = lines.map((text, i) => `${i + 1}\t${text}`).join("\n");

  const responseText = await callClaude(apiKey, system, indexed);
  const parsed = parseNumbered(responseText, lines.length);
  if (parsed) {
    if (onProgress) onProgress({ done: lines.length, total: lines.length });
    // An empty translation for a non-empty line is a dropped line, not a valid
    // result - keep the original rather than blanking that spot on the image.
    return parsed.map((text, i) => (text && text.trim() ? text.trim() : lines[i]));
  }

  // Correspondence broke. One line per request can't misalign, so pay the extra
  // round trips rather than risk putting the wrong words in the wrong place.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out.push(line);
    } else {
      try {
        const single = await callClaude(apiKey, system, `1\t${line}`);
        const parsedSingle = parseNumbered(single, 1);
        out.push(parsedSingle && parsedSingle[0].trim() ? parsedSingle[0].trim() : single.trim() || line);
      } catch {
        out.push(line);
      }
    }
    if (onProgress) onProgress({ done: i + 1, total: lines.length });
  }
  return out;
}
