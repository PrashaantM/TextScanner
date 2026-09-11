// factCheck.js: a deterministic check that the Coherence Filter's rewrite kept
// every price, time, date, phone number and bare number that was in the
// filtered text it started from - no model call, no network, just string
// matching against the same two strings the rewrite already produced.
//
// The Coherence Filter's system prompt (js/coherenceClaude.js) already asks the
// model to "preserve every factual detail exactly... never invent, guess, or
// drop a fact". Until now that rule was enforced entirely by hoping the model
// listens. This is the deterministic half of 02-COHERENCE-FILTER-AGENT-PLAN.md:
// route/verify around the generative call rather than try to replace it - the
// rewrite itself stays genuinely generative (turning scattered fragments into
// prose has no rule-based substitute), but whether it kept the numbers is a
// closed, checkable question.
//
// This is deliberately a heuristic, not a guarantee: a phone number reformatted
// from "555-123-4567" to "(555) 123-4567" reads as "dropped" even though the
// fact survived, because the check is substring matching, not semantic
// equivalence. That tradeoff is intentional - it costs no tokens and runs on
// every result, which a smarter check calling back into a model would not.

// Ordered roughly most-specific to least: a price or a formatted phone number
// is a much stronger signal than a bare number, but every pattern's matches are
// checked independently, so a fact caught by an earlier pattern is not skipped
// by a later, looser one.
const FACT_PATTERNS = [
  /\$\s?\d[\d,]*\.?\d*/g, // prices: $5, $12.50, $1,200
  /\b\d{1,2}:\d{2}\s?(am|pm)?\b/gi, // times: 5:00, 5:00pm
  /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/gi, // dates: 31st July, July 31st
  /\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone numbers
  /\b\d+\b/g, // bare numbers - the loosest net, checked last
];

// -> { ok: boolean, missing: string[] }. `missing` lists each fact found in
// `originalText` that does not appear verbatim in `rewrittenText`, in the order
// first encountered, with duplicates removed.
export function checkFactPreservation(originalText, rewrittenText) {
  const original = originalText || "";
  const rewritten = rewrittenText || "";
  const missing = [];

  for (const pattern of FACT_PATTERNS) {
    const facts = original.match(pattern) || [];
    for (const fact of facts) {
      if (!rewritten.includes(fact) && !missing.includes(fact)) missing.push(fact);
    }
  }

  return { ok: missing.length === 0, missing };
}
