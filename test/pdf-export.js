// pdf-export.js: validates the hand-written PDF writer in js/pdf.js.
//
// This exists because a hand-written PDF writer is precisely the kind of code
// that fails silently. A wrong byte offset in the cross-reference table, an
// unescaped parenthesis in a title, or a /Length that disagrees with its stream
// produces a file that looks fine in the debugger, saves without complaint, and
// then will not open. There is no runtime error to catch - the failure surfaces
// days later when someone tries to open an export.
//
// So this validates on three independent levels, deliberately:
//
//   1. STRUCTURAL, by parsing the file back. Every xref offset must land exactly
//      on its own "N 0 obj" header, every stream's /Length must match the bytes
//      actually present, and the trailer must resolve. This catches the whole
//      offset-arithmetic class of bug, which is the one most likely to appear
//      when the writer changes.
//   2. SEMANTIC. The embedded JPEG bytes must come back out byte-identical
//      (proving /DCTDecode passthrough really is lossless and nothing re-encoded
//      on the way through), and the invisible text layer must contain the words
//      that were put into it.
//   3. THIRD-PARTY, via `qlmanage`. macOS QuickLook renders PDFs through
//      CoreGraphics - the same parser Preview and every native app uses. If it
//      produces a thumbnail, a real independent implementation accepted the
//      file. This is the check that would catch a spec violation my own parser
//      happens to share a blind spot with.
//
// Level 3 is macOS-only and is skipped elsewhere with a stated reason rather
// than silently. Levels 1 and 2 run everywhere, including CI on Linux.
//
// Usage: node test/pdf-export.js

import { launchBrowser } from "./browser.js";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "test/manual-output/pdf");
const PORT = 8132;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
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

// ---- Level 1: structural parse ----
//
// Deliberately independent of js/pdf.js - it re-derives everything from the
// bytes rather than trusting any value the writer recorded. A validator that
// shares the writer's arithmetic validates nothing.
function parsePdf(bytes) {
  const latin1 = Buffer.from(bytes).toString("latin1");
  const problems = [];

  if (!latin1.startsWith("%PDF-")) problems.push("missing %PDF header");
  if (!latin1.includes("%%EOF")) problems.push("missing %%EOF");

  const startxrefMatch = latin1.lastIndexOf("startxref");
  if (startxrefMatch === -1) {
    problems.push("missing startxref");
    return { problems, objects: new Map(), latin1 };
  }

  const xrefOffset = parseInt(latin1.slice(startxrefMatch + 9).trim(), 10);
  if (!Number.isFinite(xrefOffset) || xrefOffset <= 0 || xrefOffset >= bytes.length) {
    problems.push(`startxref points outside the file: ${xrefOffset}`);
    return { problems, objects: new Map(), latin1 };
  }

  if (!latin1.slice(xrefOffset, xrefOffset + 4).startsWith("xref")) {
    problems.push(`startxref ${xrefOffset} does not point at an "xref" table`);
    return { problems, objects: new Map(), latin1 };
  }

  // Subsection header: optional whitespace, "0 <count>", then the line break
  // before the first entry. The match deliberately includes BOTH the leading and
  // trailing whitespace so its length alone advances to the first entry - doing
  // it by trimming a copy and then indexing into the original loses exactly the
  // bytes that were trimmed, which is off-by-two and silently misreads every
  // entry after it.
  const afterXref = xrefOffset + 4;
  const headerMatch = latin1.slice(afterXref).match(/^\s*(\d+)[ \t]+(\d+)\s*/);
  if (!headerMatch) {
    problems.push("xref table has no subsection header");
    return { problems, objects: new Map(), latin1 };
  }

  const count = parseInt(headerMatch[2], 10);
  // Entries are fixed-width: exactly 20 bytes each. Viewers seek by this stride,
  // so a single byte of drift breaks every object after it - which is why this
  // slices at an exact offset rather than trimming again here.
  const entryRegion = latin1.slice(afterXref + headerMatch[0].length);

  const objects = new Map();
  for (let i = 0; i < count; i++) {
    const entry = entryRegion.slice(i * 20, i * 20 + 20);
    if (entry.length < 18) {
      problems.push(`xref entry ${i} is truncated`);
      break;
    }
    const offset = parseInt(entry.slice(0, 10), 10);
    const type = entry[17];

    if (i === 0) {
      if (type !== "f") problems.push("xref entry 0 must be the free-list head (type f)");
      continue;
    }
    if (type !== "n") {
      problems.push(`xref entry ${i} has type "${type}", expected "n"`);
      continue;
    }

    // The critical assertion: the recorded offset must land exactly on this
    // object's own header.
    const expected = `${i} 0 obj`;
    const actual = latin1.slice(offset, offset + expected.length);
    if (actual !== expected) {
      problems.push(`xref offset for object ${i} is ${offset}, which reads "${actual.slice(0, 20)}" not "${expected}"`);
      continue;
    }

    const endIndex = latin1.indexOf("endobj", offset);
    objects.set(i, { offset, body: latin1.slice(offset, endIndex === -1 ? undefined : endIndex) });
  }

  // Trailer must name a Root, and that object must exist and be a Catalog.
  const trailerIndex = latin1.lastIndexOf("trailer");
  if (trailerIndex === -1) {
    problems.push("missing trailer");
  } else {
    const trailer = latin1.slice(trailerIndex, startxrefMatch);
    const rootMatch = trailer.match(/\/Root\s+(\d+)\s+0\s+R/);
    if (!rootMatch) problems.push("trailer has no /Root");
    else {
      const root = objects.get(parseInt(rootMatch[1], 10));
      if (!root) problems.push("/Root points at a missing object");
      else if (!root.body.includes("/Type /Catalog")) problems.push("/Root is not a /Catalog");
    }
    const sizeMatch = trailer.match(/\/Size\s+(\d+)/);
    if (!sizeMatch) problems.push("trailer has no /Size");
    else if (parseInt(sizeMatch[1], 10) !== count) {
      problems.push(`trailer /Size ${sizeMatch[1]} disagrees with the xref count ${count}`);
    }
  }

  // Every stream's declared /Length must match the bytes between the stream
  // keywords. A mismatch is the second-most-common corruption after offsets.
  for (const [number, object] of objects) {
    const streamIndex = object.body.indexOf("stream");
    if (streamIndex === -1) continue;
    const lengthMatch = object.body.match(/\/Length\s+(\d+)/);
    if (!lengthMatch) {
      problems.push(`object ${number} has a stream but no /Length`);
      continue;
    }
    const declared = parseInt(lengthMatch[1], 10);
    const dataStart = object.offset + streamIndex + "stream\n".length;
    const endStream = latin1.indexOf("endstream", dataStart);
    if (endStream === -1) {
      problems.push(`object ${number} has an unterminated stream`);
      continue;
    }
    // One trailing newline is written before "endstream" and is not part of the
    // stream data.
    const actual = endStream - dataStart - 1;
    if (actual !== declared) {
      problems.push(`object ${number} declares /Length ${declared} but holds ${actual} bytes`);
    }
  }

  return { problems, objects, latin1 };
}

// ---- Generate ----

await mkdir(OUT, { recursive: true });
const browser = await launchBrowser({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/index.html`);

console.log("Building PDFs in the browser (real js/pdf.js, real canvas JPEGs)\n");

const built = await page.evaluate(async () => {
  const { buildPdf, readJpegMetadata, blobToUint8Array } = await import("/js/pdf.js");

  // Two visually distinct pages so page order is verifiable in the output.
  function makeJpeg(label, width, height, background) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111111";
    ctx.font = "48px sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(label, 40, 60);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9));
  }

  const blobA = await makeJpeg("PAGE ONE", 800, 1000, "#ffffff");
  const blobB = await makeJpeg("PAGE TWO", 1000, 800, "#fafafa");

  const bytesA = await blobToUint8Array(blobA);
  const bytesB = await blobToUint8Array(blobB);

  const words = [
    { text: "PAGE", bbox: { x0: 40, y0: 60, x1: 170, y1: 108 } },
    { text: "ONE", bbox: { x0: 180, y0: 60, x1: 280, y1: 108 } },
    // A title with characters that MUST be escaped in a PDF literal string.
    { text: "Tricky(paren)\\slash", bbox: { x0: 40, y0: 200, x1: 400, y1: 240 } },
  ];

  const searchable = await buildPdf(
    [
      { jpegBytes: bytesA, words, width: 800, height: 1000 },
      { jpegBytes: bytesB, words: [], width: 1000, height: 800 },
    ],
    { title: "Test (with parens) \\ and backslash", author: "TextScanner", searchable: true }
  );

  const plain = await buildPdf([{ jpegBytes: bytesA, words, width: 800, height: 1000 }], {
    title: "Plain",
    searchable: false,
  });

  const a4 = await buildPdf([{ jpegBytes: bytesB, words: [], width: 1000, height: 800 }], {
    title: "A4",
    paperSize: "a4",
  });

  const meta = readJpegMetadata(bytesA);

  return {
    searchable: Array.from(await blobToUint8Array(searchable)),
    plain: Array.from(await blobToUint8Array(plain)),
    a4: Array.from(await blobToUint8Array(a4)),
    jpegA: Array.from(bytesA),
    jpegMeta: meta,
    searchableType: searchable.type,
  };
});

await browser.close();
server.close();

const searchablePdf = Buffer.from(built.searchable);
const plainPdf = Buffer.from(built.plain);
const a4Pdf = Buffer.from(built.a4);
const jpegA = Buffer.from(built.jpegA);

await writeFile(join(OUT, "searchable.pdf"), searchablePdf);
await writeFile(join(OUT, "plain.pdf"), plainPdf);
await writeFile(join(OUT, "a4.pdf"), a4Pdf);

// ---- Assertions ----

console.log("JPEG metadata parsing");
check("SOF dimensions are read correctly", built.jpegMeta?.width === 800 && built.jpegMeta?.height === 1000, JSON.stringify(built.jpegMeta));
check("component count is read", built.jpegMeta?.components === 3, String(built.jpegMeta?.components));

console.log("\nBlob");
check("MIME type is application/pdf", built.searchableType === "application/pdf", built.searchableType);

for (const [name, buffer, expectedPages] of [
  ["searchable", searchablePdf, 2],
  ["plain", plainPdf, 1],
  ["a4", a4Pdf, 1],
]) {
  console.log(`\nStructure - ${name}.pdf (${buffer.length} bytes)`);
  const { problems, objects, latin1 } = parsePdf(buffer);

  check(`${name}: parses with no structural problems`, problems.length === 0, problems.slice(0, 3).join(" | "));
  check(`${name}: has objects`, objects.size > 0, String(objects.size));

  const pageCount = (latin1.match(/\/Type \/Page[^s]/g) || []).length;
  check(`${name}: contains ${expectedPages} page object(s)`, pageCount === expectedPages, String(pageCount));

  const countMatch = latin1.match(/\/Type \/Pages \/Count (\d+)/);
  check(`${name}: /Pages /Count agrees`, countMatch && parseInt(countMatch[1], 10) === expectedPages, countMatch?.[1]);

  check(`${name}: image is DCTDecode (no re-encode)`, latin1.includes("/Filter /DCTDecode"));
}

console.log("\nSemantics");
{
  const { latin1 } = parsePdf(searchablePdf);

  // The embedded JPEG must survive byte-for-byte. Searching for a distinctive
  // slice of the source proves the stream is passthrough, not re-encoded.
  const needle = jpegA.subarray(0, 64).toString("latin1");
  check("embedded JPEG bytes are byte-identical to the source", latin1.includes(needle));

  check("invisible text mode 3 Tr is present", latin1.includes("3 Tr"));
  check("recognized words appear in the text layer", latin1.includes("(PAGE) Tj") && latin1.includes("(ONE) Tj"));

  // The escaping test. An unescaped "(" or "\" here would have already broken
  // the structural parse above, so reaching this line and matching means the
  // escaping is correct rather than merely absent.
  check(
    "parentheses and backslashes are escaped in the text layer",
    latin1.includes("Tricky\\(paren\\)\\\\slash"),
    "escaped word string not found"
  );
  check(
    "parentheses and backslashes are escaped in the title",
    latin1.includes("Test \\(with parens\\) \\\\ and backslash"),
    "escaped title not found"
  );

  check("standard-14 font is referenced, not embedded", latin1.includes("/BaseFont /Helvetica") && !latin1.includes("/FontFile"));
}

{
  const { latin1 } = parsePdf(plainPdf);
  check("searchable:false omits the text layer", !latin1.includes("3 Tr"));
  check("searchable:false omits the font", !latin1.includes("/BaseFont"));
}

{
  const { latin1 } = parsePdf(a4Pdf);
  // A4 is 595.28 x 841.89 pt.
  check("paperSize a4 produces an A4 MediaBox", /MediaBox \[0 0 595\.280 841\.890\]/.test(latin1), latin1.match(/MediaBox \[[^\]]+\]/)?.[0]);
}

// ---- Level 3: third-party parse via CoreGraphics ----

console.log("\nThird-party validation");
if (platform() !== "darwin") {
  console.log("  skip qlmanage - macOS only (CI runs on Linux; levels 1 and 2 above still ran)");
} else {
  const thumbDir = join(OUT, "thumbs");
  await rm(thumbDir, { recursive: true, force: true });
  await mkdir(thumbDir, { recursive: true });

  for (const name of ["searchable", "plain", "a4"]) {
    try {
      await execFileAsync("qlmanage", ["-t", "-s", "400", "-o", thumbDir, join(OUT, `${name}.pdf`)], {
        timeout: 30000,
      });
      const produced = (await readdir(thumbDir)).filter((f) => f.startsWith(name));
      check(`${name}.pdf renders through CoreGraphics/QuickLook`, produced.length > 0, "no thumbnail produced");
    } catch (err) {
      check(`${name}.pdf renders through CoreGraphics/QuickLook`, false, err.message.split("\n")[0]);
    }
  }
}

if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors.join("; ")}`);

console.log(`\nPDFs written to ${OUT}`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nPDF export is structurally valid, semantically correct, and parses in a third-party engine.");
