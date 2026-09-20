// inpaint-fidelity.js: measures how well a deleted word's spot is reconstructed,
// against ground truth this test HOLDS - each background is generated, captured
// before any text is drawn over it, and the inpainted fill is compared to the
// pixels that were really there.
//
// Synthetic fixtures are legitimate here, unlike for OCR accuracy
// (WEB-COMPLETION-PLAN.md §4.4), and the difference is worth stating. An OCR
// benchmark on generated images measures the generator, because what is being
// tested is the engine's response to real sensor noise, lens geometry and
// motion blur. Here the thing under test is "can this reconstruct a background
// it cannot see", and holding the pre-text background is the only way to know
// the right answer exactly. Real photos are measured too, in the harness this
// grew out of, and they are a harder problem - see the ceiling note below.
//
// TWO METRICS, because one of them is misleading on its own:
//
//   meanAbs - mean absolute per-channel error vs truth, 0-255. The obvious
//             metric, and the right one for structured backgrounds.
//   hfRatio - high-frequency energy of the fill divided by that of the truth.
//             1.0 means "the texture came back"; 0.0 means "it was erased".
//
// The second exists because meanAbs is actively WRONG for stochastic texture. A
// fill that puts back convincing wood grain in different places scores worse
// per-pixel than a flat blur, while looking incomparably better. Reporting only
// meanAbs would have called the blur the winner.
//
// Usage: node test/inpaint-fidelity.js   (BROWSER= to pick an engine)

import { launchBrowser, listenOnEphemeralPort, contentTypeFor } from "./browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const filePath = p === "/" ? "index.html" : p;
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
const PORT = await listenOnEphemeralPort(server);

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); failures.push(`${name}${detail ? `: ${detail}` : ""}`); }
};

const browser = await launchBrowser({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 20000 });

const measured = await page.evaluate(async () => {
  const { computeInpaintedPatch, ringTextureEnergy } = await import("/js/inpaint.js");
  const W = 420, H = 200;
  const BOX = { x0: 110, y0: 78, x1: 310, y1: 126 };

  // Every fixture is DETERMINISTIC. An earlier version of the wood-grain one
  // used Math.random() and its numbers moved run to run, which makes a
  // fidelity figure worthless - the same lesson as the seeded noise in
  // test/library-documents.js.
  const seeded = (s) => () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const backgrounds = {
    "plain paper": (g) => { g.fillStyle = "#f6f3ec"; g.fillRect(0, 0, W, H); },
    "soft gradient": (g) => {
      const gr = g.createLinearGradient(0, 0, W, H);
      gr.addColorStop(0, "#eef3f8"); gr.addColorStop(1, "#cfd9e6");
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    },
    "lined paper": (g) => {
      g.fillStyle = "#fdfdf7"; g.fillRect(0, 0, W, H);
      g.strokeStyle = "#9fc3e0"; g.lineWidth = 1.4;
      for (let y = 18; y < H; y += 22) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
      g.strokeStyle = "#e8b0b0"; g.beginPath(); g.moveTo(46.5, 0); g.lineTo(46.5, H); g.stroke();
    },
    "wood grain": (g) => {
      g.fillStyle = "#b07a45"; g.fillRect(0, 0, W, H);
      const rnd = seeded(0x2f6e2b1);
      for (let i = 0; i < 150; i++) {
        const y = rnd() * H;
        g.strokeStyle = `rgba(${(90 + rnd() * 60) | 0},${(55 + rnd() * 40) | 0},${(25 + rnd() * 25) | 0},${(0.25 + rnd() * 0.5).toFixed(3)})`;
        g.lineWidth = 0.5 + rnd() * 2.2;
        g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= W; x += 20) g.lineTo(x, y + Math.sin((x + i * 13) / 55) * 4.5);
        g.stroke();
      }
    },
    "graph paper": (g) => {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
      g.strokeStyle = "#cfe3cf"; g.lineWidth = 1;
      for (let x = 0; x < W; x += 14) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
      for (let y = 0; y < H; y += 14) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
    },
  };

  const highFreq = (im) => {
    let sum = 0, n = 0;
    for (let y = 1; y < im.height - 1; y++) for (let x = 1; x < im.width - 1; x++) {
      const i = (y * im.width + x) * 4;
      for (let k = 0; k < 3; k++) {
        sum += Math.abs(4 * im.data[i + k] - im.data[i - 4 + k] - im.data[i + 4 + k]
          - im.data[i - im.width * 4 + k] - im.data[i + im.width * 4 + k]) / 4;
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  const rows = [];
  for (const [name, paint] of Object.entries(backgrounds)) {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    paint(g);
    const truth = g.getImageData(BOX.x0, BOX.y0, BOX.x1 - BOX.x0, BOX.y1 - BOX.y0);

    g.fillStyle = "#1b1b1b";
    g.font = "600 40px Georgia, serif";
    g.fillText("Sample", BOX.x0 + 4, BOX.y1 - 10);

    const img = new Image(); img.src = c.toDataURL("image/png"); await img.decode();

    // The routing metric, measured on the same crop the real code builds.
    const bw = BOX.x1 - BOX.x0, bh = BOX.y1 - BOX.y0;
    const margin = Math.max(Math.max(8, Math.min(40, Math.round(Math.min(bw, bh) * 0.75))), 28);
    const px0 = Math.max(0, BOX.x0 - margin), py0 = Math.max(0, BOX.y0 - margin);
    const px1 = Math.min(W, BOX.x1 + margin), py1 = Math.min(H, BOX.y1 + margin);
    const mc = document.createElement("canvas"); mc.width = px1 - px0; mc.height = py1 - py0;
    const mg = mc.getContext("2d", { willReadFrequently: true });
    mg.drawImage(img, px0, py0, mc.width, mc.height, 0, 0, mc.width, mc.height);
    const md = mg.getImageData(0, 0, mc.width, mc.height);
    const energy = ringTextureEnergy(md.data, mc.width, mc.height, BOX.x0 - px0, BOX.y0 - py0, BOX.x1 - px0, BOX.y1 - py0);

    const t0 = performance.now();
    const patch = computeInpaintedPatch(img, W, H, BOX);
    const ms = performance.now() - t0;
    if (!patch) { rows.push({ name, error: "computeInpaintedPatch returned null" }); continue; }

    const got = patch.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, patch.width, patch.height);
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < truth.data.length; i += 4) for (let k = 0; k < 3; k++) {
      const d = Math.abs(truth.data[i + k] - got.data[i + k]);
      sum += d; sq += d * d; n++;
    }
    const th = highFreq(truth), gh = highFreq(got);
    rows.push({
      name, energy: +energy.toFixed(2), meanAbs: +(sum / n).toFixed(2),
      rmse: +Math.sqrt(sq / n).toFixed(2), hfRatio: th ? +(gh / th).toFixed(2) : 1, ms: Math.round(ms),
    });
  }
  return rows;
});

console.log("\n  background        energy  meanAbs   RMSE  hfRatio    time");
console.log("  " + "-".repeat(58));
for (const r of measured) {
  if (r.error) { console.log(`  ${r.name.padEnd(16)} ${r.error}`); continue; }
  console.log(`  ${r.name.padEnd(16)} ${String(r.energy).padStart(6)} ${String(r.meanAbs).padStart(8)} ${String(r.rmse).padStart(6)} ${String(r.hfRatio).padStart(8)} ${String(r.ms + "ms").padStart(7)}`);
}
console.log("");

const by = Object.fromEntries(measured.map((r) => [r.name, r]));

// ---- Routing: the smooth backgrounds must NOT take the exemplar path ----
//
// This is the half that protects what already worked. Diffusion is not a
// fallback on these, it is the correct answer: a linear gradient is harmonic,
// so harmonic interpolation reproduces it almost exactly.
check("plain paper routes to diffusion", by["plain paper"].energy < 1.0, String(by["plain paper"].energy));
check("soft gradient routes to diffusion", by["soft gradient"].energy < 1.0, String(by["soft gradient"].energy));
check("lined paper routes to exemplar", by["lined paper"].energy > 1.0, String(by["lined paper"].energy));
check("wood grain routes to exemplar", by["wood grain"].energy > 1.0, String(by["wood grain"].energy));
check("graph paper routes to exemplar", by["graph paper"].energy > 1.0, String(by["graph paper"].energy));

// ---- Smooth: exact, and it must stay exact ----
check("plain paper is reconstructed EXACTLY", by["plain paper"].meanAbs === 0, String(by["plain paper"].meanAbs));
check("soft gradient is reconstructed near-exactly", by["soft gradient"].meanAbs < 3, String(by["soft gradient"].meanAbs));

// ---- Structured texture: the case this was built for ----
//
// Before exemplar synthesis these were 4.15 (lined) and 18.49 (graph) with
// hfRatio 0.00 and 0.06 - the rules and the grid came back as flat colour.
check("lined paper: rules are restored, not erased", by["lined paper"].hfRatio > 0.8, String(by["lined paper"].hfRatio));
check("lined paper: error is far below the diffusion-only 4.15", by["lined paper"].meanAbs < 1.5, String(by["lined paper"].meanAbs));
check("graph paper: grid is restored, not erased", by["graph paper"].hfRatio > 0.8, String(by["graph paper"].hfRatio));
check("graph paper: error is far below the diffusion-only 18.49", by["graph paper"].meanAbs < 1.5, String(by["graph paper"].meanAbs));

// ---- Stochastic texture: THE CEILING, asserted as a ceiling ----
//
// Wood grain is where this approach stops being able to win on per-pixel error,
// and the test says so rather than hiding it. Exemplar synthesis puts back grain
// of the right character in the wrong places, so meanAbs gets WORSE than the
// blur it replaced (11.95 -> ~15) while the result looks correct and hfRatio
// goes from 0.22 to ~0.96. Both numbers are asserted: the texture must come
// back, and the per-pixel error is allowed to be worse but not unbounded.
check("wood grain: grain is restored", by["wood grain"].hfRatio > 0.8, String(by["wood grain"].hfRatio));
check("wood grain: per-pixel error stays bounded even though it is worse than a blur",
      by["wood grain"].meanAbs < 20, String(by["wood grain"].meanAbs));

// ---- Cost ----
//
// Exemplar synthesis is several times the work of diffusion. It runs once per
// word, cached (js/main.js's patchCache), on a user-initiated delete.
const slowest = Math.max(...measured.map((r) => r.ms || 0));
check("the slowest fixture still completes well inside a frame budget a user would notice",
      slowest < 1500, `${slowest}ms`);

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${[...new Set(pageErrors)].join("; ")}`);

await browser.close();
server.close();

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nSmooth backgrounds stay exact; structured texture is reconstructed; the stochastic ceiling is pinned.");
