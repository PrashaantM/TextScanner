// pdf.js: writes a multi-page PDF from scanned pages, with an optional
// invisible text layer that makes the result searchable.
//
// Written by hand rather than with a library, and that is a considered choice
// rather than stubbornness. pdf-lib and jsPDF are 300-400 KB minified. This app
// has no bundler and no build step (see js/mlkitEngine.js's header), so a
// library would be another vendored megabyte shipped to every visitor and into
// the App Store binary - to do something a PDF writer scoped to exactly one job
// does in a few hundred lines.
//
// The job is narrow, which is what makes it tractable: every page is one JPEG
// filling the page box, plus optional invisible text positioned over it. No
// vector graphics, no embedded fonts beyond a standard-14, no annotations, no
// encryption, no incremental updates.
//
// The one genuinely clever thing a PDF gets us: a JPEG can be embedded WITHOUT
// re-encoding. /DCTDecode means the compressed JPEG bytes are the stream, so a
// 2 MB page photo occupies 2 MB in the PDF rather than being decoded to a 30 MB
// bitmap and re-compressed. Export is therefore near-instant and lossless
// relative to what is on screen.
//
// The searchable text layer uses text rendering mode 3 (`3 Tr`), which draws
// nothing at all but still participates in text extraction, selection and
// search. This is exactly how commercial scanners produce "searchable PDF", and
// it is why the output can look like a photograph and still be greppable.
//
// Reference: PDF 1.7 (ISO 32000-1). The structure below is the minimum
// conforming document: header, body objects, cross-reference table, trailer.

const PDF_HEADER = "%PDF-1.7\n";
// A comment line of bytes >127 immediately after the header. Required by the
// spec's own recommendation so that naive tools transferring the file detect it
// as binary rather than mangling line endings.
const BINARY_MARKER = "%\xE2\xE3\xCF\xD3\n";

// PDF's unit is 1/72 inch. Pages are laid out at 72 DPI against the image's
// pixel dimensions unless a paper size is requested, which keeps a scan the
// same proportions it was captured at.
const POINTS_PER_INCH = 72;

export const PAPER_SIZES = {
  auto: null,
  a4: { width: 595.28, height: 841.89, label: "A4" },
  letter: { width: 612, height: 792, label: "US Letter" },
  legal: { width: 612, height: 1008, label: "US Legal" },
};

function encodeLatin1(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

// Escapes a string for a PDF literal string object: backslash, parentheses, and
// anything outside printable ASCII. Unescaped parentheses are the single most
// common way a hand-written PDF ends up corrupt, because they nest.
function pdfString(text) {
  let out = "";
  for (const char of String(text)) {
    const code = char.charCodeAt(0);
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else if (code < 32 || code > 126) out += `\\${(code & 0xff).toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return `(${out})`;
}

function pdfDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`
  );
}

// Reads a JPEG's SOF marker for its true pixel dimensions and component count.
//
// Necessary rather than convenient: the PDF's /Width, /Height and /ColorSpace
// must match the JPEG's own headers exactly. If they disagree, viewers render
// garbage or refuse the file - and the caller's idea of the size can drift from
// the encoded reality after a canvas round-trip.
export function readJpegMetadata(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];

    // SOF0-SOF15, excluding DHT (c4), DAC (cc) and the RST range.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        precision: bytes[offset + 4],
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        components: bytes[offset + 9],
        // Progressive JPEGs (SOF2) are valid in PDF 1.3+ but some older
        // viewers stumble. Reported so the caller can re-encode if it cares.
        progressive: marker === 0xc2,
      };
    }

    offset += 2 + length;
  }

  return null;
}

// Assembles the file. Objects are appended in order and their byte offsets
// recorded as they go, because the cross-reference table at the end must give
// the exact offset of every object - which is only knowable once everything
// before it has been serialized.
class PdfBuilder {
  constructor() {
    this.chunks = [];
    this.length = 0;
    // Index 0 of the xref table is the mandatory free-object head, which is why
    // real object numbering starts at 1.
    this.offsets = [0];
  }

  pushRaw(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  push(text) {
    this.pushRaw(encodeLatin1(text));
  }

  // Reserves the next object number without writing it yet, so objects can
  // reference each other before either exists.
  reserve() {
    this.offsets.push(null);
    return this.offsets.length - 1;
  }

  write(objectNumber, body, streamBytes = null) {
    this.offsets[objectNumber] = this.length;
    this.push(`${objectNumber} 0 obj\n`);
    this.push(body);
    if (streamBytes) {
      this.push("\nstream\n");
      this.pushRaw(streamBytes);
      this.push("\nendstream");
    }
    this.push("\nendobj\n");
  }

  finish(rootRef, infoRef) {
    const xrefOffset = this.length;
    const count = this.offsets.length;

    this.push(`xref\n0 ${count}\n`);
    // The free-list head. Exactly 20 bytes per entry, including the two-byte
    // line ending - viewers seek into this table by fixed stride, so the
    // padding is load-bearing, not cosmetic.
    this.push("0000000000 65535 f \n");
    for (let i = 1; i < count; i++) {
      const offset = this.offsets[i] || 0;
      this.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }

    this.push(`trailer\n<< /Size ${count} /Root ${rootRef} 0 R /Info ${infoRef} 0 R >>\n`);
    this.push(`startxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(this.chunks, { type: "application/pdf" });
  }
}

// Builds the invisible text layer for one page.
//
// Each recognized word is drawn at its own position, scaled so its rendered
// width approximates the width of the source word - that approximation matters
// because text selection in a viewer follows the text object's advance width,
// not the image underneath. Getting it roughly right is what makes dragging a
// selection across a scanned line feel like selecting text rather than fighting
// it.
//
// `3 Tr` is the invisible rendering mode: the glyphs contribute to extraction
// and selection but paint nothing, leaving the scanned image as the only thing
// visible.
function buildTextLayer(words, pageWidth, pageHeight, imageWidth, imageHeight) {
  if (!words || !words.length) return "";

  const scaleX = pageWidth / imageWidth;
  const scaleY = pageHeight / imageHeight;

  const parts = ["BT", "3 Tr", "/F1 1 Tf"];

  for (const word of words) {
    const text = (word.text || "").trim();
    if (!text || !word.bbox) continue;

    const { x0, y0, x1, y1 } = word.bbox;
    const boxWidth = Math.max(1, x1 - x0);
    const boxHeight = Math.max(1, y1 - y0);

    // PDF's origin is bottom-left; image coordinates are top-left. The baseline
    // sits a little above the box's bottom edge, hence the 0.2 nudge.
    const x = x0 * scaleX;
    const y = (imageHeight - y1) * scaleY + boxHeight * scaleY * 0.2;

    const fontSize = boxHeight * scaleY;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(fontSize) || fontSize <= 0) continue;

    // Helvetica's average glyph advance is ~0.5 em. Solving for the horizontal
    // scale that makes the string span the box keeps selection aligned with what
    // the reader sees.
    const estimatedWidth = text.length * fontSize * 0.5;
    const horizontalScale = estimatedWidth > 0 ? Math.min(400, Math.max(10, ((boxWidth * scaleX) / estimatedWidth) * 100)) : 100;

    parts.push(`${horizontalScale.toFixed(2)} Tz`);
    parts.push(`/F1 ${fontSize.toFixed(3)} Tf`);
    parts.push(`1 0 0 1 ${x.toFixed(3)} ${y.toFixed(3)} Tm`);
    parts.push(`${pdfString(text)} Tj`);
  }

  parts.push("ET");
  return parts.join("\n");
}

// Fits an image into a fixed paper size, preserving aspect ratio and centring
// what is left over. Used only when a paper size is requested; "auto" makes the
// page exactly the image's own proportions instead, which is almost always what
// someone wants from a scan of a receipt.
function fitToPaper(imageWidth, imageHeight, paper) {
  const scale = Math.min(paper.width / imageWidth, paper.height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  return {
    pageWidth: paper.width,
    pageHeight: paper.height,
    drawWidth,
    drawHeight,
    offsetX: (paper.width - drawWidth) / 2,
    offsetY: (paper.height - drawHeight) / 2,
  };
}

/**
 * Builds a PDF from an ordered list of pages.
 *
 * Each page: { jpegBytes: Uint8Array, words?: [], width?, height? }
 *
 * Options:
 *   title, author      document metadata
 *   paperSize          key of PAPER_SIZES; "auto" sizes each page to its image
 *   dpi                pixels-per-inch for "auto" sizing (default 150)
 *   searchable         embed the invisible OCR text layer (default true)
 */
export async function buildPdf(pages, options = {}) {
  const { title = "Scan", author = "TextScanner", paperSize = "auto", dpi = 150, searchable = true } = options;

  if (!pages || !pages.length) throw new Error("There are no pages to export.");

  const paper = PAPER_SIZES[paperSize] || null;
  const builder = new PdfBuilder();

  builder.push(PDF_HEADER);
  builder.push(BINARY_MARKER);

  const catalogRef = builder.reserve();
  const pagesRef = builder.reserve();
  const infoRef = builder.reserve();
  const fontRef = searchable ? builder.reserve() : null;

  const pageRefs = [];

  for (const page of pages) {
    const bytes = page.jpegBytes;
    const meta = readJpegMetadata(bytes);

    // Fall back to the caller's dimensions if the JPEG could not be parsed, but
    // refuse the page entirely if neither source knows its size - a page object
    // with wrong dimensions renders as a corrupt file rather than a bad-looking
    // one, and a skipped page is far easier to notice and fix.
    const imageWidth = meta?.width || page.width;
    const imageHeight = meta?.height || page.height;
    if (!imageWidth || !imageHeight) continue;

    const components = meta?.components || 3;
    const colorSpace = components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB";

    let layout;
    if (paper) {
      layout = fitToPaper(imageWidth, imageHeight, paper);
    } else {
      const pageWidth = (imageWidth / dpi) * POINTS_PER_INCH;
      const pageHeight = (imageHeight / dpi) * POINTS_PER_INCH;
      layout = { pageWidth, pageHeight, drawWidth: pageWidth, drawHeight: pageHeight, offsetX: 0, offsetY: 0 };
    }

    const imageRef = builder.reserve();
    const contentRef = builder.reserve();
    const pageRef = builder.reserve();
    pageRefs.push(pageRef);

    builder.write(
      imageRef,
      `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent ${meta?.precision || 8} ` +
        `/Filter /DCTDecode /Length ${bytes.length} >>`,
      bytes
    );

    // `cm` places the image: PDF draws an image XObject into the unit square, so
    // the matrix is (width 0 0 height x y). q/Q brackets the transform so the
    // text layer that follows is not also scaled by it.
    const drawOps =
      `q\n${layout.drawWidth.toFixed(3)} 0 0 ${layout.drawHeight.toFixed(3)} ` +
      `${layout.offsetX.toFixed(3)} ${layout.offsetY.toFixed(3)} cm\n/Im0 Do\nQ`;

    const textOps =
      searchable && page.words?.length
        ? `\n${buildTextLayer(page.words, layout.drawWidth, layout.drawHeight, imageWidth, imageHeight)}`
        : "";

    // The text layer is positioned in the image's own drawn box, so shift it by
    // the same offset when the page is letterboxed onto fixed paper.
    const content =
      layout.offsetX || layout.offsetY
        ? `${drawOps}\nq\n1 0 0 1 ${layout.offsetX.toFixed(3)} ${layout.offsetY.toFixed(3)} cm${textOps}\nQ`
        : `${drawOps}${textOps}`;

    const contentBytes = encodeLatin1(content);
    builder.write(contentRef, `<< /Length ${contentBytes.length} >>`, contentBytes);

    const resources = searchable
      ? `<< /XObject << /Im0 ${imageRef} 0 R >> /Font << /F1 ${fontRef} 0 R >> >>`
      : `<< /XObject << /Im0 ${imageRef} 0 R >> >>`;

    builder.write(
      pageRef,
      `<< /Type /Page /Parent ${pagesRef} 0 R ` +
        `/MediaBox [0 0 ${layout.pageWidth.toFixed(3)} ${layout.pageHeight.toFixed(3)}] ` +
        `/Resources ${resources} /Contents ${contentRef} 0 R >>`
    );
  }

  if (!pageRefs.length) throw new Error("None of the pages could be encoded.");

  if (searchable) {
    // Helvetica is one of the standard 14 fonts every conforming viewer already
    // has, so nothing needs embedding. The layer is invisible, so the specific
    // face affects only the advance widths used for selection geometry.
    builder.write(fontRef, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  }

  builder.write(
    pagesRef,
    `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] >>`
  );

  builder.write(catalogRef, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);

  builder.write(
    infoRef,
    `<< /Title ${pdfString(title)} /Author ${pdfString(author)} ` +
      `/Producer ${pdfString("TextScanner")} /Creator ${pdfString("TextScanner")} ` +
      `/CreationDate ${pdfString(pdfDate())} >>`
  );

  return builder.finish(catalogRef, infoRef);
}

export async function blobToUint8Array(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
