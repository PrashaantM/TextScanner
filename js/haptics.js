// haptics.js: thin, fire-and-forget wrapper around Capacitor's Haptics plugin
// (Phase 17 of TEXTSCANNER-HARDENING-PLAN.md). A silent no-op on web -
// window.Capacitor.Plugins only exists inside the native WKWebView (see
// js/mlkitEngine.js's header comment on why plugins are read off that global
// rather than imported from the npm package: no bundler resolves bare module
// specifiers here). Never awaited by callers and never throws - haptic
// feedback is polish, not something a tap/drag/delete should ever fail over.

function hapticsPlugin() {
  return window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins.Haptics : null;
}

function impact(style) {
  hapticsPlugin()
    ?.impact({ style })
    .catch(() => {});
}

export function hapticLight() {
  impact("LIGHT");
}

export function hapticMedium() {
  impact("MEDIUM");
}
