// coherence.js: the Coherence Filter's dispatcher. Takes the Filtered Text
// output (already-denoised OCR fragments, still in their raw reading-order
// layout) and returns grammatically correct, readable prose - via whichever
// tier is actually available. This is a genuinely generative task (turning a
// scattered event poster's name, location, and time into "'Event name' is held
// at 'location'...") that no rule-based approach generalizes past a handful of
// hardcoded cases, so unlike the rest of this app it needs a language model.
//
// This file used to BE the Claude implementation. It is now purely the choice
// between two implementations, mirroring js/recognize.js's split between
// ocrEngine.js and mlkitEngine.js - the same seam, and it works for the same
// reason: main.js calls one function and never needs to know which ran.
//
//   js/coherenceOnDevice.js  Apple Foundation Models, iOS 26+ (no key, no network)
//   js/coherenceClaude.js    Anthropic Claude, BYOK (the only web-build option)
//
// ---- Which tier runs, and why ----
//
// On-device is preferred whenever it's actually available. It needs no API key,
// costs the user nothing per use, makes no network request, and keeps the
// local-first story the rest of the app tells. BYOK Claude is the opt-in
// higher-quality tier - a much larger model, noticeably better on long or
// messy input - and remains the ONLY tier on the web build, where no
// comparable on-device option exists.
//
// The web build's behaviour is therefore unchanged: it still requires a key. It
// is now labelled as such rather than silently failing, and nothing here
// implies a free tier the web version doesn't have.
//
// preferOnDevice lets the user override the default in the UI while keeping the
// dispatcher honest: asking for on-device on a device that can't run it falls
// back rather than failing, and asking for Claude without a key does the same
// in reverse. The only case that ends in `unavailable` is when NEITHER tier can
// run, which is a real state the UI has to render rather than a silent no-op.

import { rewriteWithClaude, hasStoredApiKey, getStoredApiKey, setStoredApiKey, clearStoredApiKey } from "./coherenceClaude.js";
import {
  rewriteOnDevice,
  getOnDeviceAvailability,
  isOnDeviceAvailable,
  describeReason,
  invalidateAvailabilityCache,
} from "./coherenceOnDevice.js";

// Re-exported so main.js keeps importing key management from one place, exactly
// as it did before the split.
export { getStoredApiKey, setStoredApiKey, clearStoredApiKey, hasStoredApiKey };
export { getOnDeviceAvailability, isOnDeviceAvailable, invalidateAvailabilityCache, describeReason };

export const TIER = {
  ON_DEVICE: "on-device",
  CLAUDE: "claude",
  NONE: "none",
};

// Human-readable label for a tier, used next to the Coherence Filter toggle so
// it's never ambiguous which quality level just ran.
export function tierLabel(tier) {
  if (tier === TIER.ON_DEVICE) return "On-device";
  if (tier === TIER.CLAUDE) return "Claude (your API key)";
  return "Unavailable";
}

// Resolves what would actually happen if the user hit Generate right now.
// -> { tier, reason }, where reason is set only for TIER.NONE and explains
// which of the two tiers failed to be available and why.
//
// preferOnDevice defaults true: the on-device tier is the default for anyone on
// an eligible device, since it removes the key requirement entirely for them.
export async function resolveTier(preferOnDevice = true) {
  const onDevice = await getOnDeviceAvailability();
  const hasKey = hasStoredApiKey();

  if (preferOnDevice && onDevice.available) return { tier: TIER.ON_DEVICE, reason: null };
  if (hasKey) return { tier: TIER.CLAUDE, reason: null };
  if (onDevice.available) return { tier: TIER.ON_DEVICE, reason: null };

  return {
    tier: TIER.NONE,
    // On a device that could never run the model, the actionable message is
    // "add a key", not "your device is ineligible" - the latter is true but
    // sounds like a dead end when it isn't one.
    reason: onDevice.reason === "framework-missing" || onDevice.reason === "os-too-old" || onDevice.reason === "device-not-eligible"
      ? "Coherence Filter needs an Anthropic API key on this device."
      : describeReason(onDevice.reason),
  };
}

// Runs the reconstruction on whichever tier resolveTier picks.
// -> { text, tier }. Throws an Error whose message is safe to show directly in
// the UI; both implementations already guarantee that.
export async function reconstructCoherentText(filteredText, preferOnDevice = true) {
  if (!filteredText || !filteredText.trim()) throw new Error("There's no filtered text to reconstruct.");

  const { tier, reason } = await resolveTier(preferOnDevice);

  if (tier === TIER.ON_DEVICE) {
    try {
      return { text: await rewriteOnDevice(filteredText), tier: TIER.ON_DEVICE };
    } catch (err) {
      // A device-side failure shouldn't strand a user who does have a key -
      // but it also shouldn't silently spend their money, so the fallback only
      // happens when a key is already saved, and the UI reports which tier the
      // result actually came from either way.
      if (hasStoredApiKey()) {
        return { text: await rewriteWithClaude(filteredText), tier: TIER.CLAUDE };
      }
      throw err;
    }
  }

  if (tier === TIER.CLAUDE) {
    return { text: await rewriteWithClaude(filteredText), tier: TIER.CLAUDE };
  }

  throw new Error(reason || "Coherence Filter isn't available right now.");
}
