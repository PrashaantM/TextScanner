// textUtil.js: small shared helper for turning a flat, line-ordered OCR word list
// (see ocrEngine.js) back into plain multi-line text. Used both to populate the
// Text view right after a scan and, in filter.js, as the "raw" filter level.

export function wordsToText(words) {
  const lines = [];
  let currentLineIndex = null;
  let current = [];

  words.forEach((word) => {
    if (word.lineIndex !== currentLineIndex) {
      if (current.length) lines.push(current.join(" "));
      current = [];
      currentLineIndex = word.lineIndex;
    }
    current.push(word.text);
  });
  if (current.length) lines.push(current.join(" "));

  return lines.join("\n").trim();
}
