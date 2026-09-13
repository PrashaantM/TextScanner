// make-non-latin-images.js: renders the non-Latin script samples used by
// test/non-latin-limitation.js.
//
// These are generated rather than photographed on purpose. They are not corpus
// images and they are not a benchmark - they exist to pin the CURRENT behaviour
// of a known limitation (see that test's header), and for that the text needs to
// be unambiguous and its ground truth exact, which a clean render gives and a
// photo does not.
//
// Usage: node test/make-non-latin-images.js

import { launchBrowser } from "./browser.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "test/images/non-latin");

// Each sample is a script this app cannot currently recognize, plus a Latin
// control that it can - the control is what makes a null result meaningful,
// since "recognized nothing" is only evidence of a script limitation if the
// same pipeline recognizes the same-shaped Latin image fine.
const SAMPLES = [
  {
    name: "non-latin-devanagari",
    lines: ["नमस्ते दुनिया", "यह एक परीक्षण है"],
    font: '48px "Noto Sans Devanagari", "Devanagari Sangam MN", sans-serif',
  },
  {
    name: "non-latin-cjk",
    lines: ["你好世界", "这是一个测试"],
    font: '48px "PingFang SC", "Hiragino Sans GB", "Heiti SC", sans-serif',
  },
  {
    name: "non-latin-cyrillic",
    lines: ["Привет мир", "Это проверка"],
    font: '48px "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    name: "latin-control",
    lines: ["HELLO WORLD", "THIS IS A TEST"],
    font: '48px "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
];

const browser = await launchBrowser({ headless: true });
const page = await browser.newPage();
await mkdir(OUT, { recursive: true });

for (const sample of SAMPLES) {
  const dataUrl = await page.evaluate(({ lines, font }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = font;
    ctx.textBaseline = "top";
    lines.forEach((line, i) => ctx.fillText(line, 60, 60 + i * 90));
    return canvas.toDataURL("image/png");
  }, sample);

  await writeFile(join(OUT, `${sample.name}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
  // Ground truth lives beside the image, NOT in test/groundtruth/ -
  // run-benchmark.js treats every .txt in that directory as a corpus entry and
  // would try to score these as benchmark images.
  await writeFile(join(OUT, `${sample.name}.txt`), `${sample.lines.join("\n")}\n`);
  console.log(`wrote ${sample.name}.png + ${sample.name}.txt`);
}

await browser.close();
console.log(`\n${SAMPLES.length} samples in ${OUT}`);
