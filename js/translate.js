// translate.js: translate-in-place - the dispatcher. Recognized text is replaced
// with its translation AT THE SAME POSITION on the image, which is the thing
// Live Text and Google Lens don't do: they help you read a foreign menu, this
// hands you back the menu in your language.
//
// Third module to use this dispatch shape, after js/recognize.js and
// js/coherence.js, and for the same reason each time - the caller states intent,
// the dispatcher picks an implementation:
//
//   js/translateOnDevice.js  Apple Foundation Models, iOS 26+ (no key, no network)
//   js/translateClaude.js    Anthropic Claude, BYOK (the only web-build tier)
//
// ---- Why lines, not words ----
//
// The editor's object model is per-word, but translation is not a per-word
// operation: word order, agreement and article use all change between languages,
// so translating "the red door" a word at a time produces nonsense in most
// target languages. Translation therefore works on LINES (state.imageFormatLines
// already groups word spans exactly that way from the OCR result).
//
// Putting a line's translation back is where this gets to reuse the editor
// wholesale. The line's first word span takes the entire translated string, and
// the rest of that line's spans are emptied. Emptying a word is already a
// first-class operation - it is what Delete does - so the vacated spots get the
// existing inpainting treatment for free, and the whole thing lands on the undo
// stack as one step through the existing snapshot mechanism. No new object type,
// no new export path, no new undo handling.

import { getStoredApiKey } from "./coherenceClaude.js";
import { translateLinesOnDevice, isOnDeviceTranslationAvailable, getSupportedLanguageCodes } from "./translateOnDevice.js";
import { translateLinesWithClaude } from "./translateClaude.js";
import { TARGET_LANGUAGES, findLanguage, NON_LATIN_TARGETS } from "./translateLanguages.js";

export { TARGET_LANGUAGES, findLanguage, NON_LATIN_TARGETS };

export const TRANSLATE_TIER = {
  ON_DEVICE: "on-device",
  CLAUDE: "claude",
  NONE: "none",
};

export function translateTierLabel(tier) {
  if (tier === TRANSLATE_TIER.ON_DEVICE) return "On-device";
  if (tier === TRANSLATE_TIER.CLAUDE) return "Claude (your API key)";
  return "Unavailable";
}

// Which languages are actually offerable right now. On the web build that's the
// full list (Claude handles all of them); on native it's the full list only if a
// key is saved, otherwise just the intersection with what the installed
// on-device model supports. Offering a language that would quietly produce
// nonsense is worse than offering fewer.
export async function getOfferableLanguages() {
  if (getStoredApiKey()) return TARGET_LANGUAGES;
  const supported = await getSupportedLanguageCodes();
  if (supported === null) return TARGET_LANGUAGES; // web build, no native tier at all
  return TARGET_LANGUAGES.filter((l) => supported.includes(l.code));
}

// What would happen if the user hit Translate right now, for this target.
// -> { tier, reason }. Same contract as js/coherence.js's resolveTier.
// targetCode may be null - callers use that to ask "could translation work here
// at all?", which is what the UI needs when there is no language to offer.
export async function resolveTranslateTier(targetCode, preferOnDevice = true) {
  const onDevice = targetCode ? await isOnDeviceTranslationAvailable(targetCode) : false;
  const hasKey = !!getStoredApiKey();

  if (preferOnDevice && onDevice) return { tier: TRANSLATE_TIER.ON_DEVICE, reason: null };
  if (hasKey) return { tier: TRANSLATE_TIER.CLAUDE, reason: null };
  if (onDevice) return { tier: TRANSLATE_TIER.ON_DEVICE, reason: null };

  const supported = await getSupportedLanguageCodes();
  return {
    tier: TRANSLATE_TIER.NONE,
    reason:
      supported && supported.length
        ? "The on-device model doesn't support that language. Add an Anthropic API key to translate into it."
        : "Translation needs an Anthropic API key on this device.",
  };
}

// Translates `lines` (an array of plain strings, one per recognized line).
// -> { lines, tier }, where `lines` is the same length and order as the input.
// Throws an Error whose message is safe to show directly in the UI.
export async function translateLines(lines, targetCode, { preferOnDevice = true, onProgress } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("There's no text to translate.");
  if (!findLanguage(targetCode)) throw new Error("Pick a language to translate into.");

  const { tier, reason } = await resolveTranslateTier(targetCode, preferOnDevice);

  if (tier === TRANSLATE_TIER.ON_DEVICE) {
    try {
      return { lines: await translateLinesOnDevice(lines, targetCode, onProgress), tier: TRANSLATE_TIER.ON_DEVICE };
    } catch (err) {
      // Same rule as the Coherence Filter's fallback: don't strand a user who
      // has a key, don't silently spend money for one who doesn't.
      if (getStoredApiKey()) {
        return { lines: await translateLinesWithClaude(lines, targetCode, onProgress), tier: TRANSLATE_TIER.CLAUDE };
      }
      throw err;
    }
  }

  if (tier === TRANSLATE_TIER.CLAUDE) {
    return { lines: await translateLinesWithClaude(lines, targetCode, onProgress), tier: TRANSLATE_TIER.CLAUDE };
  }

  throw new Error(reason || "Translation isn't available right now.");
}
