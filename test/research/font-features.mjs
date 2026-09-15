// font-features.mjs: a research script, NOT part of the app or the CI suite
// (nothing in .github/workflows/ci.yml runs this) - preserved here, rather
// than only in a chat transcript, so the numbers behind js/editorObjects.js's
// detectCondensedSource are auditable and rerunnable, not just
// asserted. See condensed-source-detection.md in this directory for the
// write-up; font-features-raw.json is this script's own output, committed
// alongside it, from the run that write-up quotes.
//
// Scans all 11 images in test/images/ through the real app to get real OCR
// word boxes, then for each word crops the ACTUAL SOURCE PHOTOGRAPH pixels
// (not a rendered fixture) and measures candidate font-matching features:
// stroke-width distribution, per-glyph aspect ratio, inter-character width
// variance, x-height/cap-height ratio, stroke contrast, and a terminal-shape
// proxy. Reports per-image (per-face) median/IQR so within-face vs
// between-face spread can be compared by hand.
//
// Runs on whatever Chromium is on this machine - font-independent, since
// every feature here is read from JPEG pixels via canvas, never from text
// the browser renders itself. Takes a few minutes: 11 real OCR scans.
//
// Usage: node test/research/font-features.mjs

import { launchBrowser } from "../browser.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 8199;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".wasm": "application/wasm", ".traineddata": "application/octet-stream", ".gz": "application/gzip", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

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

const browser = await launchBrowser();
const IMAGES = Array.from({ length: 11 }, (_, i) => `complexPic${i + 1}.jpeg`);
const results = {};

for (const image of IMAGES) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.setInputFiles("#file-input", join(ROOT, "test/images/" + image));
  await page.click("#scan-btn");
  await page.waitForSelector("#result-section:not(.hidden)", { timeout: 120000 });
  await page.click("#mode-full-btn");
  await page.waitForTimeout(200);

  const rows = await page.evaluate(async () => {
    const { state } = await import("/js/state.js");

    // Otsu threshold on luminance - same standard method the app's own
    // sampleInkAppearance uses (js/editorObjects.js), reimplemented here
    // standalone since this script imports nothing from the app.
    function otsuThreshold(hist, total) {
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, wF = 0, varMax = 0, threshold = 127;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        wF = total - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > varMax) { varMax = between; threshold = t; }
      }
      return threshold;
    }

    function binarize(imageData) {
      const { data, width, height } = imageData;
      const hist = new Array(256).fill(0);
      const luma = new Float32Array(width * height);
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        luma[p] = l;
        hist[Math.round(l)]++;
      }
      const t = otsuThreshold(hist, width * height);
      let darkCount = 0;
      for (let p = 0; p < luma.length; p++) if (luma[p] <= t) darkCount++;
      const inkIsDark = darkCount <= luma.length / 2;
      const grid = new Uint8Array(width * height);
      for (let p = 0; p < luma.length; p++) {
        const isDark = luma[p] <= t;
        grid[p] = (inkIsDark ? isDark : !isDark) ? 1 : 0;
      }
      return { grid, width, height };
    }

    function runLengths(grid, width, height, axis) {
      const runs = [];
      if (axis === "h") {
        for (let y = 0; y < height; y++) {
          let run = 0;
          for (let x = 0; x < width; x++) {
            if (grid[y * width + x]) run++;
            else { if (run > 0) runs.push(run); run = 0; }
          }
          if (run > 0) runs.push(run);
        }
      } else {
        for (let x = 0; x < width; x++) {
          let run = 0;
          for (let y = 0; y < height; y++) {
            if (grid[y * width + x]) run++;
            else { if (run > 0) runs.push(run); run = 0; }
          }
          if (run > 0) runs.push(run);
        }
      }
      return runs;
    }

    function percentile(sorted, p) {
      if (!sorted.length) return null;
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
      return sorted[idx];
    }

    function mode(values) {
      if (!values.length) return null;
      const counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      let best = values[0], bestCount = 0;
      for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
      return best;
    }

    function connectedComponents(grid, width, height) {
      const visited = new Uint8Array(width * height);
      const comps = [];
      const stack = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          if (!grid[idx] || visited[idx]) continue;
          let minX = x, maxX = x, minY = y, maxY = y, area = 0;
          stack.push(idx);
          visited[idx] = 1;
          while (stack.length) {
            const cur = stack.pop();
            const cy = (cur / width) | 0;
            const cx = cur % width;
            area++;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
            for (const [nx, ny] of neighbors) {
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const nIdx = ny * width + nx;
              if (grid[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                stack.push(nIdx);
              }
            }
          }
          comps.push({ minX, maxX, minY, maxY, area, w: maxX - minX + 1, h: maxY - minY + 1 });
        }
      }
      return comps;
    }

    function densityProfile(grid, width, height) {
      const profile = new Array(height).fill(0);
      for (let y = 0; y < height; y++) {
        let c = 0;
        for (let x = 0; x < width; x++) c += grid[y * width + x];
        profile[y] = c / width;
      }
      return profile;
    }

    function measureWord(imageData, text) {
      const { grid, width, height } = binarize(imageData);
      let inkCount = 0;
      for (let i = 0; i < grid.length; i++) inkCount += grid[i];
      if (inkCount < 8) return null;

      const hRuns = runLengths(grid, width, height, "h").sort((a, b) => a - b);
      const vRuns = runLengths(grid, width, height, "v").sort((a, b) => a - b);
      const strokeCandidatesH = hRuns.slice(0, Math.max(1, Math.ceil(hRuns.length * 0.6)));
      const strokeCandidatesV = vRuns.slice(0, Math.max(1, Math.ceil(vRuns.length * 0.6)));
      const strokeWidthH = {
        p25: percentile(strokeCandidatesH, 0.25),
        p50: percentile(strokeCandidatesH, 0.5),
        p75: percentile(strokeCandidatesH, 0.75),
        mode: mode(strokeCandidatesH),
      };
      const strokeWidthV = {
        p25: percentile(strokeCandidatesV, 0.25),
        p50: percentile(strokeCandidatesV, 0.5),
        p75: percentile(strokeCandidatesV, 0.75),
        mode: mode(strokeCandidatesV),
      };
      const strokeContrast =
        strokeWidthH.mode && strokeWidthV.mode
          ? Math.max(strokeWidthH.mode, strokeWidthV.mode) / Math.min(strokeWidthH.mode, strokeWidthV.mode)
          : null;

      const comps = connectedComponents(grid, width, height).filter((c) => c.area >= 3);
      const letterCount = (text || "").replace(/[^A-Za-z0-9]/g, "").length;
      const glyphAspects = comps.map((c) => c.w / c.h);
      const glyphWidths = comps.map((c) => c.w);
      const centroidsX = comps.map((c) => (c.minX + c.maxX) / 2).sort((a, b) => a - b);
      const advances = [];
      for (let i = 1; i < centroidsX.length; i++) advances.push(centroidsX[i] - centroidsX[i - 1]);
      const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const std = (xs) => {
        if (xs.length < 2) return null;
        const m = mean(xs);
        return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
      };
      const cv = (xs) => {
        const m = mean(xs);
        const s = std(xs);
        return m && s !== null ? s / m : null;
      };

      const profile = densityProfile(grid, width, height);
      const maxDensity = Math.max(...profile);
      let capTop = null, xHeightTop = null, baseline = null;
      for (let y = 0; y < height; y++) {
        if (capTop === null && profile[y] > 0.12 * maxDensity) capTop = y;
        if (xHeightTop === null && profile[y] > 0.55 * maxDensity) xHeightTop = y;
      }
      for (let y = height - 1; y >= 0; y--) {
        if (baseline === null && profile[y] > 0.12 * maxDensity) baseline = y;
      }
      const xCapRatio =
        capTop !== null && xHeightTop !== null && baseline !== null && baseline > capTop
          ? (baseline - xHeightTop) / (baseline - capTop)
          : null;

      const stems = comps.filter((c) => c.h >= 6 && c.w / c.h < 0.45);
      const flareRatios = [];
      for (const c of stems) {
        const rowWidth = (y) => {
          let minX = Infinity, maxX = -Infinity, any = false;
          for (let x = c.minX; x <= c.maxX; x++) {
            if (grid[y * width + x]) { any = true; if (x < minX) minX = x; if (x > maxX) maxX = x; }
          }
          return any ? maxX - minX + 1 : 0;
        };
        const inset = Math.min(2, Math.floor((c.h - 2) / 3));
        if (inset < 1) continue;
        const tip = (rowWidth(c.minY) + rowWidth(c.maxY)) / 2;
        const core = (rowWidth(c.minY + inset) + rowWidth(c.maxY - inset)) / 2;
        if (core > 0) flareRatios.push(tip / core);
      }

      return {
        text,
        wordBoxH: height,
        wordBoxW: width,
        inkFraction: inkCount / (width * height),
        strokeWidthH,
        strokeWidthV,
        strokeContrastRatio: strokeContrast,
        relStrokeWidth: strokeWidthH.mode !== null ? strokeWidthH.mode / height : null,
        componentCount: comps.length,
        letterCount,
        componentsPerLetter: letterCount > 0 ? comps.length / letterCount : null,
        glyphAspectMedian: percentile([...glyphAspects].sort((a, b) => a - b), 0.5),
        glyphWidthCV: cv(glyphWidths),
        interCharAdvanceCV: cv(advances),
        xCapRatio,
        terminalFlareMedian: flareRatios.length ? percentile([...flareRatios].sort((a, b) => a - b), 0.5) : null,
        terminalFlareN: flareRatios.length,
      };
    }

    const previewImg = document.getElementById("preview-img");
    const naturalWidth = state.lastNaturalWidth;
    const naturalHeight = state.lastNaturalHeight;

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = naturalWidth;
    srcCanvas.height = naturalHeight;
    const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(previewImg, 0, 0, naturalWidth, naturalHeight);

    const out = [];
    for (const o of state.editorObjects) {
      if (o.type !== "word" || o.origin !== "ocr" || !o.originalBbox) continue;
      if (o.probablyNotText) continue;
      const { x0, y0, x1, y1 } = o.originalBbox;
      const w = Math.round(x1 - x0);
      const h = Math.round(y1 - y0);
      if (w < 6 || h < 6) continue;
      const x = Math.max(0, Math.round(x0));
      const y = Math.max(0, Math.round(y0));
      const cw = Math.min(w, naturalWidth - x);
      const ch = Math.min(h, naturalHeight - y);
      if (cw < 6 || ch < 6) continue;
      let imageData;
      try {
        imageData = sctx.getImageData(x, y, cw, ch);
      } catch {
        continue;
      }
      const text = o.el.textContent;
      const measured = measureWord(imageData, text);
      if (measured) out.push(measured);
    }
    return out;
  });

  results[image] = rows;
  console.log(`${image}: measured ${rows.length} words`);
  await context.close();
}

await browser.close();
server.close();

function stats(values) {
  const xs = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0 };
  const p = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
  return { n: xs.length, min: xs[0], p25: p(0.25), median: p(0.5), p75: p(0.75), max: xs[xs.length - 1] };
}

const FEATURES = [
  ["relStrokeWidth", (r) => r.relStrokeWidth],
  ["strokeContrastRatio", (r) => r.strokeContrastRatio],
  ["glyphAspectMedian", (r) => r.glyphAspectMedian],
  ["glyphWidthCV", (r) => r.glyphWidthCV],
  ["interCharAdvanceCV", (r) => r.interCharAdvanceCV],
  ["xCapRatio", (r) => r.xCapRatio],
  ["componentsPerLetter", (r) => r.componentsPerLetter],
  ["terminalFlareMedian", (r) => r.terminalFlareMedian],
];

console.log("\n===== per-image, per-feature spread =====\n");
for (const [name, getter] of FEATURES) {
  console.log(`--- ${name} ---`);
  for (const image of IMAGES) {
    const s = stats(results[image].map(getter));
    console.log(
      `  ${image.padEnd(18)} n=${String(s.n).padEnd(4)} ${s.n ? `min=${s.min?.toFixed(3)} p25=${s.p25?.toFixed(3)} median=${s.median?.toFixed(3)} p75=${s.p75?.toFixed(3)} max=${s.max?.toFixed(3)}` : "(no data)"}`
    );
  }
  console.log("");
}

const fs = await import("node:fs");
await fs.promises.writeFile(
  fileURLToPath(new URL("font-features-raw.json", import.meta.url)),
  JSON.stringify(results, null, 2)
);
console.log("Raw per-word data written to test/research/font-features-raw.json");
