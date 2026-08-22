// metrics.js: CER/WER computation over two plain-text strings (recognized output
// vs. manual ground truth). Standard Levenshtein edit distance at the character
// level (CER) and word level (WER), normalized by ground-truth length. Pure JS,
// no dependencies, importable from Node (test/run-benchmark.js) or a browser.

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Collapses all whitespace runs to a single space and trims, so line breaks vs.
// spaces (which OCR output and ground truth won't agree on pixel-for-pixel) don't
// get counted as character errors.
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function characterErrorRate(hypothesis, reference) {
  const ref = normalizeWhitespace(reference);
  const hyp = normalizeWhitespace(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(hyp, ref) / ref.length;
}

export function wordErrorRate(hypothesis, reference) {
  const refWords = normalizeWhitespace(reference).split(" ").filter(Boolean);
  const hypWords = normalizeWhitespace(hypothesis).split(" ").filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  return editDistance(hypWords, refWords) / refWords.length;
}
