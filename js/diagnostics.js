// diagnostics.js: user-triggered, opt-in diagnostic export (Phase 15 of
// TEXTSCANNER-HARDENING-PLAN.md). No automatic collection, no network call the
// app makes on its own - the assembled report is handed to the OS share sheet
// (native) or the Web Share API / a download (web), and the person chooses
// where it goes from there. Image data is never included unless the person
// explicitly checks the "include the image" box.
//
// Same no-bundler constraint as every other native-aware module here (see
// js/mlkitEngine.js's header comment): native plugins are read off
// window.Capacitor.Plugins, not imported from the npm packages, since nothing
// in this app resolves bare module specifiers.

import { state } from "./state.js";
import { getEngineName, isNativeEngine } from "./recognize.js";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function buildDiagnosticReport(includeImage) {
  const report = {
    timestamp: new Date().toISOString(),
    engine: getEngineName(),
    platform: isNativeEngine() ? "native" : "web",
    lastScanError: state.lastScanError,
  };

  if (isNativeEngine()) {
    const { Device } = window.Capacitor.Plugins;
    const info = await Device.getInfo();
    report.device = { model: info.model, osVersion: info.osVersion };
  } else {
    report.userAgent = navigator.userAgent;
  }

  if (includeImage && state.currentFile) {
    report.image = await fileToDataUrl(state.currentFile);
  }

  return report;
}

const REPORT_FILENAME = () => `textscanner-diagnostic-${Date.now()}.json`;

async function shareNative(json, filename) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: json,
    directory: "CACHE",
    encoding: "utf8",
  });
  await Share.share({ title: "TextScanner diagnostic report", files: [uri] });
}

async function shareWeb(json, filename) {
  const file = new File([json], filename, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: "TextScanner diagnostic report" });
    return;
  }
  // No Web Share API (or it won't take a file, e.g. desktop browsers): fall
  // back to an ordinary download, still entirely local, no upload.
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportDiagnosticReport(includeImage) {
  const report = await buildDiagnosticReport(includeImage);
  const json = JSON.stringify(report, null, 2);
  const filename = REPORT_FILENAME();
  if (isNativeEngine()) {
    await shareNative(json, filename);
  } else {
    await shareWeb(json, filename);
  }
}
