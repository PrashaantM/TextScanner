# Applying the deterministic-agent idea to the Coherence Filter

## The direct answer first

It doesn't replace the LLM call, and I don't think it should. I read
`js/coherence.js`, `js/coherenceClaude.js`, and `js/coherenceOnDevice.js` before
writing this, so this isn't a guess about what the feature does.

The Coherence Filter's job is: take scattered OCR fragments (a poster's title,
a date, a location, a price, in whatever order the camera happened to read
them) and rewrite them as natural prose a person would say out loud. The
comment at the top of `coherence.js` already says why that needs a model:

> "This is a genuinely generative task ... that no rule-based approach
> generalizes past a handful of hardcoded cases."

That's not a hedge, it's correct, and it's the same conclusion your pasted
document reaches about its own approach:

> "If your application doesn't contain the knowledge and logic necessary to
> answer that, it can't magically generate an answer."

Turning "POPCICHAWK / POPSICLES & CHALK DRAWINGS / LOWER RESIDENT LANE / JULY
31ST / 5-7PM" into a grammatical sentence is exactly the open-ended case the
document itself carves out as needing an LLM. An intent-detection registry with
keyword scoring can route "what's my GPA" to a GPA function. It cannot decide
how to reorder eight unlabeled fragments from an arbitrary, previously-unseen
poster into prose — there's no finite intent list to match against, because
every scanned image is structurally different. So: I'm not going to hand you a
plan that quietly swaps the generative rewrite for a rule engine and calls it
done, because it would either not work or it would work only on inputs that
look like your test cases, and silently produce garbage on everything else.

## Where the idea genuinely does apply

Your pasted document isn't only "replace the LLM with rules." Read past the
headline case and it's really making three separable points: (1) route
requests deterministically where you can, (2) keep an explicit tool
registry so a caller doesn't need to know how a tool works internally, only
what it does, and (3) fall back to a generative model only for the part that
truly needs open-ended reasoning. Points 1 and 2 are already partly present in
your codebase and can be extended; point 3 is what the Claude call already is.
Four concrete additions, all deterministic, all sitting *around* the LLM call
rather than replacing it:

### 1. `coherence.js`'s tier dispatcher already *is* a deterministic agent — extend it, don't replace it

`resolveTier()` is, structurally, exactly the pattern in your pasted document:
a deterministic function that inspects state (`onDevice.available`,
`hasStoredApiKey()`) and picks which tool runs, with the caller
(`reconstructCoherentText`) never needing to know how either tool works
internally. That's the "tool registry" idea, already built, already correct.
Nothing to change here — worth naming explicitly so you can see the pattern is
already doing real work, and the additions below extend the same seam rather
than introducing a new one.

### 2. A deterministic content-type router in front of the prompt

Right now every input gets the same system prompt regardless of whether it's
an event poster, a receipt, a business card, or a street sign. A cheap,
keyword/pattern-based classifier — exactly the `INTENTS` scoring pattern from
your pasted doc — run on the *filtered text* before the API call, picking a
specialized instruction block:

```js
// coherenceRouter.js — deterministic, no model call
const DOCUMENT_TYPES = [
  {
    name: "receipt",
    // cheap, cascading signals: currency symbols/amounts, a "total" line,
    // a longer list of short line items than prose would produce
    test: (text) => /\$\s?\d|\btotal\b|\bsubtotal\b/i.test(text)
      && text.split("\n").filter(Boolean).length > 4,
  },
  {
    name: "event-poster",
    test: (text) => /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(text)
      && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text),
  },
  {
    name: "business-card",
    test: (text) => /@/.test(text) && /\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/.test(text),
  },
  // default falls through to the existing general-purpose prompt
];

export function classifyDocument(filteredText) {
  return DOCUMENT_TYPES.find((t) => t.test(filteredText))?.name ?? "general";
}
```

Then `coherenceClaude.js` picks a system-prompt variant by type — a receipt
should be rewritten as "itemized total," not "narrated as if spoken aloud,"
which is the right voice for a poster but a strange one for a receipt. This is
a real quality improvement, it's free (no extra API call, the classification
is local string matching), and it's exactly the "detect intent with keywords,
not ML" idea applied to the part of the problem that's actually enumerable —
*what kind of document is this* is a much smaller, closed space than *what
should the prose say*.

### 3. A deterministic fact-preservation checker, run after the model responds

This is the strongest application of the idea, because it directly serves a
rule the current prompt only *asks* the model to follow and never verifies:

> "Preserve every factual detail exactly: names, places, dates, times, prices,
> phone numbers, numbers. Never invent, guess, or drop a fact."

Right now that's enforced by hoping the model listens. A deterministic tool can
check it:

```js
// factCheck.js — deterministic, no model call
const FACT_PATTERNS = [
  /\$\s?\d[\d,]*\.?\d*/g,          // prices
  /\b\d{1,2}:\d{2}\s?(am|pm)?\b/gi, // times
  /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/gi, // dates
  /\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone numbers
  /\b\d+\b/g,                      // bare numbers, loosest net, checked last
];

export function checkFactPreservation(originalText, rewrittenText) {
  const missing = [];
  for (const pattern of FACT_PATTERNS) {
    const originalFacts = originalText.match(pattern) || [];
    for (const fact of originalFacts) {
      if (!rewrittenText.includes(fact)) missing.push(fact);
    }
  }
  return { ok: missing.length === 0, missing };
}
```

Wire it into `reconstructCoherentText` right after the model call returns.
When `missing.length > 0`, you have real options, and they're each cheap
because this check costs no tokens: show the result with a subtle "double check
the dates/numbers" flag, log it for your own quality tracking, or — the strong
version — retry once with an explicit correction ("you dropped: 5-7PM, July
31st — include them verbatim") before showing anything to the user. This is
the single highest-value piece of this whole plan: it turns "the model
promises not to hallucinate a fact" into "the app catches it when the model
hallucinates a fact anyway," without a second generative call in the common
case.

### 4. A deterministic skip-the-call gate

Some filtered text is already coherent prose — a single clean sentence with a
capital letter and terminal punctuation doesn't need rewriting. A cheap
heuristic (sentence count, presence of terminal punctuation, ratio of
dictionary words to fragments) can skip the API call entirely for that case,
saving the user a network round-trip, a few cents, and the tier-selection UI
flicker, for input that gains nothing from the model:

```js
export function looksAlreadyCoherent(filteredText) {
  const trimmed = filteredText.trim();
  const sentences = trimmed.split(/[.!?]+/).filter(Boolean);
  const hasTerminalPunctuation = /[.!?]\s*$/.test(trimmed);
  const isShort = trimmed.length < 200;
  return sentences.length <= 2 && hasTerminalPunctuation && isShort;
}
```

Treat this as a suggestion surfaced in the UI ("This already looks like a
sentence — reconstruct anyway?") rather than a silent skip, since false
positives here just cost a wasted click, while a silent skip that's wrong
costs the user a feature they asked for and didn't get.

## What this plan deliberately does not do

It does not try to make document-type classification, fact-checking, or the
coherent-text gate handle the actual rewrite. All three are strictly narrower
problems than "write natural prose from arbitrary fragments," which is why a
keyword/pattern approach works for them and doesn't for the rewrite itself.
If you ever find yourself writing a fourth deterministic rule to handle "what
if the poster has no date" or "what if the receipt has no total line," that's
the signal you've wandered from *routing/checking* into trying to replace
generation with rules again — worth stopping and asking whether the rule
belongs in the prompt instead.

## Rollout order

1. Fact-preservation checker (§3) first — highest value, zero cost, no UI
   changes needed beyond an optional flag/badge, and it's a pure addition that
   can't regress the existing `web-tier-smoke.js` mocked-API test since it runs
   on the response, not the request.
2. Content-type router (§2) second — needs new prompt variants written and
   tested per type, more design effort than §3, but still no architecture
   change.
3. Skip-the-call gate (§4) last, and only if you find in practice that a
   meaningful fraction of real scans are already clean prose. Cheap to build,
   but only worth it if the data supports it — don't build it speculatively.
