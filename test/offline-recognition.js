// offline-recognition.js: the user-facing half of the offline story.
//
// test/offline.js gates sw.js's caching contract. This gates what the APP does
// about the one honest hole in that contract: the recognition payload is cached
// on the first SUCCESSFUL scan, so a brand new install that has never scanned
// online cannot scan offline. README states that; until this change the app did
// nothing with it, and the person it happens to - installed the PWA, opened it on
// a plane - got "Part of the OCR engine couldn't load. Reload the page and try
// again." Advice that is actively wrong, because reloading changes nothing, from a
// sentence that reads as the app being broken.
//
// Three things are checked, and the third is the one that makes the other two
// worth anything:
//
//   1. THE MESSAGE. An offline first scan must name the real cause and the real
//      remedy, not fall through to the generic network category.
//   2. THE CONTROL. Settings' "Make recognition work offline" must report the
//      ACTUAL cache state - a control that says "saved" when nothing is saved
//      costs someone a scan somewhere with no signal at all.
//   3. THE CORE CHOICE, END TO END. js/offlineRecognition.js has to pick the same
//      wasm core the Tesseract worker will later ask for, because the worker
//      appends its own filename after runtime SIMD detection and
//      js/ocrEngine.js only hands it a DIRECTORY. Caching the wrong one would
//      leave a device that had just been told "recognition works offline now"
//      reaching for the network on its first scan - the exact failure the feature
//      exists to prevent, and invisible to any check that only looks at whether
//      three files landed in a cache. So this warms the cache through the control
//      with NO prior scan, goes offline, and scans. A wrong core fails here.
//
// And the quota path, because the cache-write fixes made sw.js survive a failing
// put SILENTLY. That is right for a scan - a scan should not die because the disk
// is full - but it means "the download finished" says nothing about whether
// anything was stored, so the control has to re-read the cache and say so.
//
// Usage: node test/offline-recognition.js

import { launchBrowser, listenOnEphemeralPort, contentTypeFor, takeConsoleErrors, expectConsoleErrors } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Same stub as test/offline.js STEP 7: the real sw.js behind a prelude that makes
// every cache.put reject, so the quota branch is exercised against production code
// rather than against a test-only flag inside it.
const FAIL_PUT_PRELUDE = `
(() => {
  const realOpen = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await realOpen(name);
    return new Proxy(cache, {
      get(target, prop) {
        if (prop === "put") {
          return () => Promise.reject(new DOMException("Quota exceeded (test stub)", "QuotaExceededError"));
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
})();
`;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  const failPut = req.url.includes("failput=1");
  const filePath = path.endsWith("/") ? `${path}index.html` : path;
  try {
    let body = await readFile(join(ROOT, filePath));
    if (failPut && filePath.endsWith("sw.js")) body = Buffer.from(FAIL_PUT_PRELUDE + String(body));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
const PORT = await listenOnEphemeralPort(server);
const origin = `http://localhost:${PORT}`;

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
};

const browser = await launchBrowser({ headless: true });
const IMAGE = join(ROOT, "test/images/complexPic2.jpeg");

async function controlledPage({ failPut = false, allowPageError = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // A gate that drives a failure ON PURPOSE has to say so for pageerror the same
  // way expectConsoleErrors says it for the console - scoped to one pattern, not
  // a blanket "ignore errors here". The offline first scan below cannot fail
  // WITHOUT the worker script failing to load; that uncaught error IS the
  // symptom, and js/main.js catching and explaining it is what is under test.
  page.on("pageerror", (e) => {
    if (allowPageError?.test(e.message)) return;
    failures.push(`pageerror: ${e.message}`);
  });
  await page.goto(`${origin}/index.html?sw=1`);
  if (failPut) {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js?failput=1", { scope: "./" });
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes("failput=1"), null, {
      timeout: 30000,
    });
  } else {
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  }
  await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 15000 });
  return { context, page };
}

// renderSettings() is async - it awaits a storage estimate and the persistence
// query before it fills the panel - so the view flipping to "settings" is NOT the
// same moment as the panel being populated. Waiting on the view alone read an
// empty state line and failed a check about wording that was in fact correct.
const openSettings = async (page) => {
  await page.click("#nav-settings");
  await page.waitForFunction(() => document.body.dataset.activeView === "settings", null, { timeout: 5000 });
  await page.waitForFunction(
    () => (document.getElementById("settings-offline-recognition-state")?.textContent || "").trim().length > 0,
    null,
    { timeout: 15000 }
  );
};

// ---------------------------------------------------------------------------
// 1. An offline first scan names its real cause.
console.log("\nAn offline first scan explains itself");

{
  const { context, page } = await controlledPage({
    allowPageError: /importScripts|worker\.min\.js|NetworkError|Failed to fetch|Load failed/i,
  });

  // Nothing has ever been scanned in this profile, so the recognition payload is
  // not cached - the exact state a fresh PWA install is in.
  const before = await page.evaluate(async () => {
    const { recognitionCacheState } = await import("/js/offlineRecognition.js");
    return (await recognitionCacheState()).status;
  });
  check("a fresh install reports the payload as not cached", before === "empty", before);

  await context.setOffline(true);

  // The scan is EXPECTED to fail here, and the failure path logs through
  // console.error by design - that is the handler under test, not a defect.
  expectConsoleErrors(page, [/TextScanner scan failed/, /NetworkError|Failed to fetch|importScripts|Load failed/], "an offline first scan must fail; this gate is about HOW");

  await page.setInputFiles("#file-input", IMAGE);
  await page.click("#scan-btn");
  await page.waitForFunction(
    () => {
      const el = document.getElementById("status-section");
      return el && !el.classList.contains("hidden") && el.textContent.trim().length > 0;
    },
    null,
    { timeout: 120000 }
  );
  const message = await page.evaluate(() => document.getElementById("status-section").textContent.trim());
  console.log(`       message: ${JSON.stringify(message.slice(0, 150))}${message.length > 150 ? "..." : ""}`);

  check(
    "it does NOT fall through to the generic reload advice",
    !/Reload the page and try again/i.test(message),
    "the generic network category answered, so the specific case was never detected"
  );
  check("it names the size, so the user knows what they are agreeing to", /6\.7 MB/.test(message), message);
  check("it says the files are not on this device yet", /not saved on this device|only part of them/i.test(message), message);
  check("it points at the Settings control by name", /Make recognition work offline/i.test(message), message);
  check(
    "it keeps the privacy claim intact rather than implying an upload",
    /never fetched from anyone else|ship with the app/i.test(message),
    message
  );

  takeConsoleErrors(page);
  await context.close();
}

// ---------------------------------------------------------------------------
// 2. The control tells the truth, and 3. the core it picks is the right one.
console.log("\nThe Settings control, in each cache state");

{
  const { context, page } = await controlledPage();
  await openSettings(page);

  const emptyState = await page.evaluate(() => ({
    line: document.getElementById("settings-offline-recognition-state").textContent.trim(),
    disabled: document.getElementById("settings-offline-recognition").disabled,
    hidden: document.getElementById("settings-offline-recognition").hidden,
    label: document.getElementById("settings-offline-recognition").textContent.trim(),
  }));
  console.log(`       empty:  ${JSON.stringify(emptyState.line)}`);
  check("with nothing cached it says so", /not saved yet/i.test(emptyState.line), emptyState.line);
  check("and says the first scan needs a connection", /needs a connection/i.test(emptyState.line), emptyState.line);
  check("the button is offered", emptyState.disabled === false && emptyState.hidden === false);
  check("the button is worded as what it buys, with the size", /Make recognition work offline/.test(emptyState.label) && /6\.7 MB/.test(emptyState.label), emptyState.label);

  // Fill it on demand. No scan has happened, so this is the control's own doing.
  await page.click("#settings-offline-recognition");
  await page.waitForFunction(
    () => /Saved|Couldn't/i.test(document.getElementById("settings-offline-recognition-status").textContent),
    null,
    { timeout: 180000 }
  );

  const warmed = await page.evaluate(() => ({
    status: document.getElementById("settings-offline-recognition-status").textContent.trim(),
    line: document.getElementById("settings-offline-recognition-state").textContent.trim(),
    disabled: document.getElementById("settings-offline-recognition").disabled,
  }));
  console.log(`       warmed: ${JSON.stringify(warmed.status)} / ${JSON.stringify(warmed.line)}`);
  check("warming reports success", /^Saved\./.test(warmed.status), warmed.status);
  check("the state line flips to saved", /^Saved\./.test(warmed.line), warmed.line);
  check("and the button stops inviting a second 6.7 MB download", warmed.disabled === true);

  // What actually landed, and that exactly one core did.
  const cached = await page.evaluate(async () => {
    const { recognitionCacheState, recognitionCoreFilename } = await import("/js/offlineRecognition.js");
    const state = await recognitionCacheState();
    return { status: state.status, present: state.present.map((u) => u.split("/").pop()), core: recognitionCoreFilename() };
  });
  check("all three payload files are cached", cached.status === "ready", JSON.stringify(cached));
  check("exactly one wasm core was stored", cached.present.filter((n) => n.endsWith(".wasm.js")).length === 1, JSON.stringify(cached.present));

  // THE ASSERTION THAT MAKES THE CORE CHOICE REAL. No scan has ever run in this
  // profile, so if the control picked the core the worker will not ask for, this
  // is where it shows up.
  await context.setOffline(true);
  // A fresh navigation rather than in-page routing, so this is the cold-start
  // case a user actually hits: open the app offline, then scan.
  await page.goto(`${origin}/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 30000 });
  await page.setInputFiles("#file-input", IMAGE);
  await page.click("#scan-btn");
  let scanned = true;
  try {
    await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });
  } catch {
    scanned = false;
  }
  const words = scanned
    ? await page.evaluate(async () => (await import("/js/state.js")).state.ocrWords?.length ?? 0)
    : 0;
  check(
    "an offline scan works after warming, with no prior scan ever",
    scanned && words > 0,
    scanned
      ? `finished but recognized ${words} words`
      : `the scan failed offline, so the core the control cached (${cached.core}) is not the one the worker asked for`
  );

  const consoleErrors = takeConsoleErrors(page);
  check("no console error through the whole warm-then-scan path", consoleErrors.length === 0, consoleErrors.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------------------
// 4. The quota path, surfaced rather than swallowed.
console.log("\nWhen the files download but cannot be stored");

{
  const { context, page } = await controlledPage({ failPut: true });
  await openSettings(page);

  await page.click("#settings-offline-recognition");
  await page.waitForFunction(
    () => /Saved|Couldn't|couldn't/i.test(document.getElementById("settings-offline-recognition-status").textContent),
    null,
    { timeout: 180000 }
  );
  const quota = await page.evaluate(() => ({
    status: document.getElementById("settings-offline-recognition-status").textContent.trim(),
    line: document.getElementById("settings-offline-recognition-state").textContent.trim(),
  }));
  console.log(`       quota:  ${JSON.stringify(quota.status)}`);

  check("it does NOT claim success when nothing was stored", !/^Saved\./.test(quota.status), quota.status);
  check("it names storage as the cause", /couldn't be saved|storage is full/i.test(quota.status), quota.status);
  check("it says what to do about it", /free some space/i.test(quota.status), quota.status);
  check(
    "it reassures that online scanning still works, because it does",
    /still works while you are online/i.test(quota.status),
    quota.status
  );
  check("and the state line still says not saved", /not saved yet|partly saved/i.test(quota.line), quota.line);

  const quotaConsole = takeConsoleErrors(page);
  check("a refused cache write logs no console ERROR in the page", quotaConsole.length === 0, quotaConsole.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------------------
await browser.close();
server.close();

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nAll offline-recognition checks passed: an offline first scan explains itself, the");
console.log("Settings control reports the real cache state, the core it caches is the one the");
console.log("worker asks for (proved by an offline scan with no prior scan), and a refused");
console.log("cache write is reported rather than silently called success.");
