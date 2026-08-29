// coherenceOnDevice.js: the on-device tier of the Coherence Filter - Apple's
// Foundation Models framework, reached through the app-target Capacitor plugin
// in ios/App/App/TextCoherencePlugin.swift. No API key, no network request, no
// per-user cost, and nothing leaves the phone.
//
// iOS-only by nature, and further limited even there: the framework is iOS 26+,
// and on iOS 26 the model is still unavailable on devices that aren't Apple
// Intelligence-eligible, where the user has turned Apple Intelligence off, or
// while the model assets are still downloading. There is no comparable
// on-device option in a plain browser, so on the web build every export here
// reports unavailable and js/coherence.js falls through to the BYOK Claude
// path - which is the honest outcome, not a degraded one.
//
// Mirrors js/mlkitEngine.js's relationship to js/recognize.js: this module owns
// the native call and its failure modes, the dispatcher above it owns the
// choice. Like that module, it reaches the plugin through the Capacitor bridge
// object injected into the WKWebView (window.Capacitor.Plugins.*) rather than
// an ES import, because this app has no bundler.

// Cached because it triggers a real availability query into the framework, and
// the answer can't change without the app being backgrounded and the user
// changing a system setting - not mid-session, and not between two clicks of
// the same button. `null` means "not asked yet".
let cachedAvailability = null;

function getPlugin() {
  if (!window.Capacitor?.isNativePlatform?.()) return null;
  return window.Capacitor?.Plugins?.TextCoherence || null;
}

// Maps the plugin's stable reason codes (see the Reason enum in
// TextCoherencePlugin.swift) to copy for the user. The wording lives here, with
// the rest of the app's copy, rather than in Swift.
const REASON_COPY = {
  "os-too-old": "On-device rewriting needs iOS 26 or later.",
  "framework-missing": "This build doesn't include on-device rewriting.",
  "device-not-eligible": "This device doesn't support Apple Intelligence.",
  "apple-intelligence-off": "Turn on Apple Intelligence in Settings to rewrite on-device.",
  "model-not-ready": "The on-device model is still downloading. Try again shortly.",
  "context-too-long": "That's more text than the on-device model can take at once.",
  declined: "The on-device model declined to rewrite this text.",
  "unsupported-language": "The on-device model doesn't support this language.",
  busy: "The on-device model is busy. Try again in a moment.",
  "empty-output": "The on-device model returned an empty response.",
  "empty-input": "There's no filtered text to reconstruct.",
  "generation-failed": "The on-device rewrite didn't work. You can try again.",
  unknown: "On-device rewriting isn't available right now.",
};

export function describeReason(reason) {
  return REASON_COPY[reason] || REASON_COPY.unknown;
}

// -> { available: boolean, reason: string|null }. Never throws: a bridge that
// isn't there, or a plugin call that fails outright, is just "unavailable", and
// the dispatcher treats it the same as an ineligible device.
export async function getOnDeviceAvailability() {
  if (cachedAvailability) return cachedAvailability;

  const plugin = getPlugin();
  if (!plugin) {
    cachedAvailability = { available: false, reason: "framework-missing" };
    return cachedAvailability;
  }

  try {
    const result = await plugin.availability();
    cachedAvailability = {
      available: !!result?.available,
      reason: result?.reason || null,
    };
  } catch {
    cachedAvailability = { available: false, reason: "unknown" };
  }
  return cachedAvailability;
}

export async function isOnDeviceAvailable() {
  return (await getOnDeviceAvailability()).available;
}

// Rewrites `filteredText` on-device. Throws an Error whose message is safe to
// show directly in the UI, matching rewriteWithClaude's contract so
// js/coherence.js can treat the two tiers identically at the call site.
export async function rewriteOnDevice(filteredText) {
  if (!filteredText || !filteredText.trim()) throw new Error("There's no filtered text to reconstruct.");

  const plugin = getPlugin();
  if (!plugin) throw new Error(describeReason("framework-missing"));

  let result;
  try {
    result = await plugin.rewrite({ text: filteredText });
  } catch (err) {
    // Capacitor surfaces the Swift side's reject(message, code) as
    // err.code / err.message. Prefer our own copy for the codes we know, and
    // fall back to the plugin's message for anything unrecognized rather than
    // swallowing a real error into a generic one.
    const code = err?.code;
    if (code && REASON_COPY[code]) throw new Error(REASON_COPY[code]);
    throw new Error(err?.message || describeReason("generation-failed"));
  }

  const text = (result?.text || "").trim();
  if (!text) throw new Error(describeReason("empty-output"));
  return text;
}

// A fresh availability query on the next call. The one case that genuinely
// changes mid-session is a user leaving to enable Apple Intelligence in
// Settings and coming back, which is exactly the case worth re-checking for.
export function invalidateAvailabilityCache() {
  cachedAvailability = null;
}
