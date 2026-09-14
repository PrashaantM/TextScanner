// make-icons.mjs: renders the app's PNG icons from the ONE SVG mark that already
// lives in index.html's favicon, so there is a single source of truth for the
// brand and no hand-exported file that can silently drift from it.
//
// The mark is read out of index.html rather than duplicated here - change the
// favicon and re-run this, and every size follows. Run:
//
//     node scripts/make-icons.mjs
//
// Outputs (all committed, because the app is a zero-build static site and
// nothing regenerates them at deploy time):
//
//   icons/icon-192.png           web app manifest, "any"
//   icons/icon-512.png           web app manifest, "any"
//   icons/icon-maskable-512.png  manifest "maskable" - the mark inset to the
//                                80% safe zone so Android's circle/squircle
//                                masks cannot clip the viewfinder corners
//   icons/apple-touch-icon.png   180x180, no alpha, square corners: iOS applies
//                                its own mask and an alpha channel there is a
//                                known way to get a black halo
//
// Needs playwright-core, which test/ already depends on - this is the only
// script outside test/ that uses it, and only to get a real renderer.

import { chromium } from "../test/node_modules/playwright-core/index.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "icons");

const html = await readFile(join(ROOT, "index.html"), "utf8");
const match = html.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/);
if (!match) {
  console.error("Could not find the inline SVG favicon in index.html - has it been replaced?");
  process.exit(1);
}
const svg = decodeURIComponent(match[1]);

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// `inset` is the fraction of the canvas left as padding on each side. Android
// maskable icons crop to a circle inscribed in the middle 80%, so anything that
// must survive - here the viewfinder corners - has to sit inside that.
async function render(size, file, { inset = 0, background = null } = {}) {
  const png = await page.evaluate(async ({ svg, size, inset, background }) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");
    if (background) { g.fillStyle = background; g.fillRect(0, 0, size, size); }
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    const pad = Math.round(size * inset);
    g.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
    return canvas.toDataURL("image/png");
  }, { svg, size, inset, background });
  await writeFile(join(OUT, file), Buffer.from(png.split(",")[1], "base64"));
  console.log(`  ${file.padEnd(26)} ${size}x${size}`);
}

console.log("Rendering icons from index.html's SVG mark:");
await render(192, "icon-192.png");
await render(512, "icon-512.png");
// The mark's own rounded rect is inset so the safe zone holds it; the indigo
// fills the rest so a circular mask still lands on brand colour rather than
// transparency.
await render(512, "icon-maskable-512.png", { inset: 0.12, background: "#3457d5" });
// iOS: opaque, and it applies its own corner mask - our rounded rect inside a
// second rounded mask reads as a mistake, so the background is filled flat.
await render(180, "apple-touch-icon.png", { background: "#3457d5" });

await browser.close();
console.log("Done. These are committed; re-run only if index.html's mark changes.");
