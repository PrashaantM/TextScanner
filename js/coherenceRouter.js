// coherenceRouter.js: a deterministic classifier that picks which system prompt
// variant js/coherenceClaude.js uses, based on cheap pattern matching over the
// filtered text - no model call.
//
// This is the "detect intent with keywords, not ML" half of
// 02-COHERENCE-FILTER-AGENT-PLAN.md applied to the one part of this problem
// that is actually enumerable: WHAT KIND of document this is has a small,
// closed set of answers, even though WHAT THE PROSE SHOULD SAY does not (which
// is why the rewrite itself still needs the model - see coherence.js's header).
// A receipt reads better as an itemized total than as prose narrated aloud,
// which is the right voice for a poster but a strange one for a receipt; this
// is what lets the prompt pick the right voice for free, before the one API
// call that actually costs anything.
//
// Only two variants beyond "general" - not because nothing else is
// distinguishable, but because these are the two where the RIGHT VOICE for the
// rewrite genuinely differs from narrated prose. An event poster, a street
// sign, a page of a book, a menu - all of those already want exactly what the
// general prompt does (turn fragments into natural spoken-aloud prose), so
// giving "event poster" its own classification would pick a differently-named
// branch that produces the same output as general - a distinction with no
// difference. Add a new entry here only when a document type needs a
// genuinely different voice, not just a genuinely different subject.
//
// Order matters: each test runs against the same text, and the first match
// wins, so the more specific, rarer signal (a phone number AND an email, for a
// business card) is checked before the more common one (currency amounts,
// which a poster's ticket price can also trigger).
const DOCUMENT_TYPES = [
  {
    name: "business-card",
    // An email address alongside a phone number is a strong, fairly rare
    // combination that plain prose (a poster, a receipt) doesn't produce.
    test: (text) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) && /\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text),
  },
  {
    name: "receipt",
    // Currency plus a "total" line plus more short lines than prose would
    // produce - a single signal (e.g. just a dollar amount) is too common to
    // trust alone, since a poster can quote a ticket price too.
    test: (text) => /\$\s?\d|\btotal\b|\bsubtotal\b/i.test(text) && text.split("\n").filter(Boolean).length > 4,
  },
];

// -> one of DOCUMENT_TYPES' `name`s, or "general" if nothing matched. "general"
// is not a failure case - most scans (a page of a book, a sign, a paragraph of
// notes) genuinely are general prose, and the default prompt is written for
// exactly that.
export function classifyDocument(filteredText) {
  const text = filteredText || "";
  return DOCUMENT_TYPES.find((type) => type.test(text))?.name ?? "general";
}
