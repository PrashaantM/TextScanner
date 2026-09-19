// web-tier-smoke.js: smoke coverage for the web-reachable features CI never
// touched - the Coherence Filter's Claude tier, translate-in-place's Claude
// tier, text-to-speech, and the export path in js/editorExport.js.
//
// These are not accuracy tests. Each asserts that the feature completes and
// produces the expected SHAPE, which is the gap that mattered: before this file
// existed, an exception in any of these four paths would have shipped, because
// nothing in CI imported them at all.
//
// **The Anthropic API is mocked and never called for real.** Every request to
// api.anthropic.com is intercepted by Playwright and answered locally. That is
// a hard requirement, not a convenience: a real call would need a real key in
// CI, would bill the account on every push, and would make the suite fail
// whenever a third party had an outage. The mock covers the success shape and
// each error status the code categorizes separately, which is more than a live
// call could test anyway - you cannot ask the real API for a 429 on demand.
//
// Usage: node test/web-tier-smoke.js   (exits non-zero on any failure)

import { launchBrowser, expectConsoleErrors } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8131;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
};

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(ROOT, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
}).listen(PORT);

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
const page = await browser.newPage();

// The mocked api.anthropic.com tiers deliberately answer 401, 429 and 503 -
// you cannot ask the real API for a 429 on demand, which is half the reason
// this gate mocks it. The browser logs every non-2xx response as a console
// error; those three ARE the test.
expectConsoleErrors(
  page,
  [/Failed to load resource.*40[13]/, /Failed to load resource.*429/, /Failed to load resource.*503/],
  "the mocked API tiers answer 401/429/503 on purpose"
);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// The Anthropic mock. `window.__mockClaude` decides what each request gets, so
// a single route handler covers the success path and every error branch.
await page.route("https://api.anthropic.com/**", async (route) => {
  const mode = await page.evaluate(() => window.__mockClaude || { status: 200, text: "MOCKED" });
  if (mode.status !== 200) {
    await route.fulfill({ status: mode.status, contentType: "application/json", body: JSON.stringify({ error: {} }) });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ content: [{ type: "text", text: mode.text }] }),
  });
});

await page.goto(`http://localhost:${PORT}/index.html`);
await page.evaluate(() => localStorage.setItem("textscanner.anthropicApiKey", "sk-ant-test-not-a-real-key"));

// ---- 1. Coherence Filter, Claude tier ----

console.log("\nCoherence Filter - Claude tier (mocked API)");

const coherence = await page.evaluate(async () => {
  const m = await import("/js/coherenceClaude.js");
  const out = {};

  window.__mockClaude = { status: 200, text: "The reconstructed sentence reads cleanly." };
  out.success = await m.rewriteWithClaude("Th3 rec0nstructed sentenc3 reads cleanly");

  out.hasKey = m.hasStoredApiKey();

  // Each status the module categorizes into its own user-facing message.
  const errorFor = async (status) => {
    window.__mockClaude = { status };
    try {
      await m.rewriteWithClaude("some text");
      return null;
    } catch (e) {
      return e.message;
    }
  };
  out.e401 = await errorFor(401);
  out.e429 = await errorFor(429);
  out.e500 = await errorFor(503);

  // Empty input must be rejected before any request is made.
  window.__mockClaude = { status: 200, text: "should not be reached" };
  try {
    await m.rewriteWithClaude("   ");
    out.emptyInput = null;
  } catch (e) {
    out.emptyInput = e.message;
  }

  // No key must also fail before any request.
  m.clearStoredApiKey();
  try {
    await m.rewriteWithClaude("some text");
    out.noKey = null;
  } catch (e) {
    out.noKey = e.message;
  }
  m.setStoredApiKey("sk-ant-test-not-a-real-key");

  return out;
});

check("rewriteWithClaude returns the model's text", coherence.success === "The reconstructed sentence reads cleanly.", coherence.success);
check("hasStoredApiKey reflects a saved key", coherence.hasKey === true);
check("401 is categorized as a rejected key", /rejected/i.test(coherence.e401 || ""), coherence.e401);
check("429 is categorized as rate limiting", /rate limit/i.test(coherence.e429 || ""), coherence.e429);
check("5xx is categorized as temporarily unavailable", /temporarily unavailable/i.test(coherence.e500 || ""), coherence.e500);
check("empty input is rejected without a request", /no filtered text/i.test(coherence.emptyInput || ""), coherence.emptyInput);
check("a missing key is rejected without a request", /no api key/i.test(coherence.noKey || ""), coherence.noKey);

// ---- 2. Translate in place, Claude tier ----

console.log("\nTranslate in place - Claude tier (mocked API)");

const translate = await page.evaluate(async () => {
  const m = await import("/js/translateClaude.js");
  const out = {};

  // The aligned path: a well-formed numbered response.
  window.__mockClaude = { status: 200, text: "1\tHola\n2\tMundo\n3\tPrueba" };
  out.aligned = await m.translateLinesWithClaude(["Hello", "World", "Test"], "es");

  // A blank translation for a non-empty line must keep the ORIGINAL rather than
  // blanking that spot on the image.
  //
  // The response shape matters here. parseNumbered requires a delimiter after
  // the index, so a bare "2\t" fails to parse at all and takes the per-line
  // fallback instead - a different branch. "2." parses cleanly to an empty
  // string, which is what actually reaches the keep-the-original branch.
  window.__mockClaude = { status: 200, text: "1\tHola\n2.\n3\tPrueba" };
  out.blankKept = await m.translateLinesWithClaude(["Hello", "World", "Test"], "es");

  // Correspondence broken (wrong line count) - falls back to one request per
  // line, which cannot misalign.
  window.__mockClaude = { status: 200, text: "1\tSolo una linea" };
  out.fallback = await m.translateLinesWithClaude(["Hello", "World"], "es");

  const progress = [];
  window.__mockClaude = { status: 200, text: "1\tHola\n2\tMundo" };
  await m.translateLinesWithClaude(["Hello", "World"], "es", (p) => progress.push(p));
  out.progress = progress;

  try {
    await m.translateLinesWithClaude(["Hello"], "not-a-language");
    out.badLanguage = null;
  } catch (e) {
    out.badLanguage = e.message;
  }

  return out;
});

check("aligned response maps line for line", JSON.stringify(translate.aligned) === JSON.stringify(["Hola", "Mundo", "Prueba"]), JSON.stringify(translate.aligned));
check("a blank translation keeps the original line", translate.blankKept?.[1] === "World", JSON.stringify(translate.blankKept));
check("broken correspondence falls back per line", Array.isArray(translate.fallback) && translate.fallback.length === 2, JSON.stringify(translate.fallback));
check("progress is reported", translate.progress?.length > 0 && translate.progress.at(-1).done === 2, JSON.stringify(translate.progress));
check("an unknown target language is rejected", /unknown target language/i.test(translate.badLanguage || ""), translate.badLanguage);

// ---- 3. Text to speech ----
//
// Headless Chromium exposes the speechSynthesis API but has no voices and never
// fires the utterance events, so this asserts the module's own contract -
// support detection, state transitions, and that no call throws - rather than
// that audio is produced, which is not observable here.

console.log("\nText to speech");

const tts = await page.evaluate(async () => {
  const m = await import("/js/tts.js");
  const out = { states: [] };
  m.setTTSStateChangeHandler((s) => out.states.push(s));

  out.supported = m.isTTSSupported();
  out.initial = m.getTTSState();

  try {
    m.speak("Testing one two three.");
    out.afterSpeak = m.getTTSState();
    m.pause();
    m.resume();
    m.stop();
    out.afterStop = m.getTTSState();
    out.threw = false;
  } catch (e) {
    out.threw = e.message;
  }

  // An empty utterance must be a no-op, not a queued silent utterance.
  m.stop();
  m.speak("");
  out.afterEmpty = m.getTTSState();

  await m.waitForVoices(200);
  out.waitedForVoices = true;
  return out;
});

check("TTS support is detected", tts.supported === true);
check("initial state is idle", tts.initial === "idle", tts.initial);
check("speak/pause/resume/stop never throw", tts.threw === false, String(tts.threw));
check("speak moves out of idle", tts.afterSpeak === "speaking", tts.afterSpeak);
check("stop returns to idle", tts.afterStop === "idle", tts.afterStop);
check("an empty utterance stays idle", tts.afterEmpty === "idle", tts.afterEmpty);
check("waitForVoices resolves even with no voices", tts.waitedForVoices === true);

// ---- 4. Export path ----

console.log("\nExport (js/editorExport.js)");

const exported = await page.evaluate(async () => {
  const dom = await import("/js/dom.js");
  const objects = await import("/js/editorObjects.js");
  const interactions = await import("/js/editorInteractions.js");
  const exp = await import("/js/editorExport.js");
  const { state } = await import("/js/state.js");
  const views = await import("/js/views.js");
  // The editor lives inside the scan view. Driving it directly means switching
  // to that view first, or its container is display:none and buildResultCanvas
  // measures a zero-sized surface.
  views.showView("scan", {}, { push: false });

  const W = 400;
  const H = 200;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000000";
  ctx.font = "24px sans-serif";
  ctx.fillText("HELLO WORLD", 20, 50);
  const src = canvas.toDataURL("image/png");

  dom.previewImg.src = src;
  await dom.previewImg.decode();
  document.getElementById("result-section").classList.remove("hidden");

  const words = [
    { lineIndex: 0, text: "HELLO", confidence: 90, bbox: { x0: 20, y0: 30, x1: 100, y1: 55 } },
    { lineIndex: 0, text: "WORLD", confidence: 90, bbox: { x0: 110, y0: 30, x1: 195, y1: 55 } },
    { lineIndex: 1, text: "SECOND", confidence: 90, bbox: { x0: 20, y0: 80, x1: 110, y1: 105 } },
  ];
  await objects.renderImageFormatView(dom.previewImg, words, W, H, src);
  interactions.setMode("image");

  const out = {};
  out.text = exp.getActiveResultText();
  out.lineTexts = exp.getLineTexts();
  out.lineObjectCount = exp.getLineObjects().length;

  const resultCanvas = exp.buildResultCanvas();
  out.canvasW = resultCanvas?.width ?? null;
  out.canvasH = resultCanvas?.height ?? null;
  out.canvasNonBlank = false;
  if (resultCanvas) {
    const data = resultCanvas.getContext("2d").getImageData(0, 0, resultCanvas.width, resultCanvas.height).data;
    // Any pixel that is not the flat fill means something was actually drawn.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) {
        out.canvasNonBlank = true;
        break;
      }
    }
    out.dataUrlPrefix = resultCanvas.toDataURL("image/png").slice(0, 21);
  }

  // Translation write-back must replace line text in place.
  exp.applyTranslatedLines(["HOLA MUNDO", "SEGUNDO"]);
  out.afterTranslate = exp.getLineTexts();

  out.wordObjects = state.editorObjects.filter((o) => o.type === "word").length;
  return out;
});

check("getActiveResultText returns the recognized text", /HELLO/.test(exported.text || "") && /SECOND/.test(exported.text || ""), JSON.stringify(exported.text));
check("getLineTexts groups by line", exported.lineTexts?.length === 2, JSON.stringify(exported.lineTexts));
check("getLineObjects matches the line count", exported.lineObjectCount === 2, String(exported.lineObjectCount));
check("buildResultCanvas uses the source dimensions", exported.canvasW === 400 && exported.canvasH === 200, `${exported.canvasW}x${exported.canvasH}`);
check("the exported canvas is not blank", exported.canvasNonBlank === true);
check("the canvas encodes to a PNG data URL", exported.dataUrlPrefix === "data:image/png;base64", exported.dataUrlPrefix);
check("applyTranslatedLines rewrites the lines", /HOLA/.test((exported.afterTranslate || []).join(" ")), JSON.stringify(exported.afterTranslate));
check("three word objects were created", exported.wordObjects === 3, String(exported.wordObjects));

// ---- Done ----

await browser.close();
server.close();

if (pageErrors.length) {
  failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);
}

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll web-tier smoke checks passed. The Anthropic API was mocked throughout; no real request was made.");
