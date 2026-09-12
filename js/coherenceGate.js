// coherenceGate.js: a deterministic, no-model-call check for whether filtered
// text is already coherent prose - a single clean sentence or two - and would
// gain nothing from a Coherence Filter rewrite.
//
// From 07-REMAINING-ROADMAP.md §1, the one piece of the original Coherence
// Filter plan (02-COHERENCE-FILTER-AGENT-PLAN.md §4) that hadn't shipped yet.
// Deliberately a suggestion surfaced in the UI (js/main.js's cleanUpTextBtn
// handler), not a silent skip: a false positive here costs the user one extra
// click, while a silent skip that's wrong costs them a feature they wanted and
// didn't get.

export function looksAlreadyCoherent(filteredText) {
  const trimmed = (filteredText || "").trim();
  const sentences = trimmed.split(/[.!?]+/).filter(Boolean);
  const hasTerminalPunctuation = /[.!?]\s*$/.test(trimmed);
  return sentences.length <= 2 && hasTerminalPunctuation && trimmed.length < 200;
}
