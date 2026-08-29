// translateOnDevice.js: the on-device tier of translate-in-place, through the
// same Apple Foundation Models plugin the Coherence Filter uses (see
// ios/App/App/TextCoherencePlugin.swift). No API key, no network, no cost.
//
// Mirrors js/coherenceOnDevice.js exactly, for the same reason it exists: the
// module owns the native call and its failure modes, and js/translate.js owns
// the choice between tiers.
//
// Lines are translated one at a time rather than batched into a single numbered
// request. Batching is what js/translateClaude.js does, and it's the right call
// there - one round trip, one bill. Here it is the wrong call: the on-device
// model is small, and asking it to hold a numbered list in strict correspondence
// is exactly the kind of instruction it drops. Getting line 14 silently aligned
// to line 13's text would put the wrong words on the wrong part of the image,
// which is far worse than being slower. One line per call cannot misalign.

import { findLanguage } from "./translateLanguages.js";

let cachedSupported = null;

function getPlugin() {
  if (!window.Capacitor?.isNativePlatform?.()) return null;
  return window.Capacitor?.Plugins?.TextCoherence || null;
}

// The language codes the installed model actually supports, or null when there
// is no native plugin at all (the web build), which callers read as "this tier
// doesn't exist here" rather than "it supports nothing".
export async function getSupportedLanguageCodes() {
  if (cachedSupported) return cachedSupported;
  const plugin = getPlugin();
  if (!plugin) return null;
  try {
    const result = await plugin.supportedLanguages();
    cachedSupported = Array.isArray(result?.languages) ? result.languages : [];
  } catch {
    cachedSupported = [];
  }
  return cachedSupported;
}

export async function isOnDeviceTranslationAvailable(targetCode) {
  const supported = await getSupportedLanguageCodes();
  if (!supported || !supported.length) return false;
  return supported.includes(targetCode);
}

// Translates `lines` into the given language code, sequentially.
// onProgress({ done, total }) is called after each line so a long job can show
// real progress instead of a frozen button.
//
// A line that fails does NOT abort the batch: it comes back as its own original
// text. Half a translated sign with one untranslated line is a usable result;
// throwing away thirty successful translations because line 31 tripped a
// guardrail is not.
export async function translateLinesOnDevice(lines, targetCode, onProgress) {
  const plugin = getPlugin();
  if (!plugin) throw new Error("On-device translation isn't available here.");
  const language = findLanguage(targetCode);
  if (!language) throw new Error("Unknown target language.");

  const out = [];
  let failures = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out.push(line);
    } else {
      try {
        const result = await plugin.translate({ text: line, targetLanguage: language.name });
        out.push((result?.text || "").trim() || line);
      } catch {
        failures++;
        out.push(line);
      }
    }
    if (onProgress) onProgress({ done: i + 1, total: lines.length });
  }

  // Every single line failing is not a partial result, it's a broken tier, and
  // the caller needs to be able to fall back rather than paint the original
  // text back over itself and call it a translation.
  if (failures && failures === lines.filter((l) => l.trim()).length) {
    throw new Error("The on-device model couldn't translate this text.");
  }
  return out;
}
