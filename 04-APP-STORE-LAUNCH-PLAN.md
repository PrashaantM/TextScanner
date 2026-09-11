# App Store launch plan

## 0. The mechanical blockers, recapped

Your own `docs/APP-STORE-SUBMISSION.md` already has these nailed down; this is
just the checklist form so it's in one place with the rest of the launch plan:

1. Real app icon (currently the unmodified Capacitor template — automatic
   rejection under Guideline 4.0). §3 below gives you a direction.
2. Screenshots (blocked on #1 — the icon decision affects what the screenshots
   should show).
3. Custom domain, for the support/marketing URLs and to close the shared
   `github.io` API-key exposure disclosed in `ANALYSIS.md` §4.3.
4. Archive → Validate App, needs a real Apple Distribution certificate.

Nothing below changes those; they're still yours to clear before submission.

## 1. Pricing — the real tradeoff, not just a recommendation

**The structural fact that should drive this decision:** TextScanner has no
backend and no recurring cost per user. OCR runs on-device (Tesseract on web,
ML Kit on iOS), and the only thing that costs money per use — the Coherence
Filter's Claude tier — is already paid for by the user's own API key, not by
you. That's unusual, and it matters: most apps that reach for a subscription
are covering a real, recurring server bill. You aren't. A subscription here
would be charging recurring money for a cost structure that isn't recurring,
and users increasingly notice that mismatch and say so in reviews.

**Option A — one-time "Pro" unlock (my recommendation).**
Free tier: unlimited single-document scanning, all three views (Text/Image
format/Full image), translation and Coherence Filter via the user's own key,
text-to-speech, plain-text export. Paid unlock (single IAP, no subscription,
something in the $4.99-$9.99 range): unlimited multi-page documents and
folders (free tier capped, e.g., 3 open documents or 15 pages total),
searchable PDF export, batch "Recognize all pages."
*Why this split:* the free tier is a complete, genuinely useful product on its
own (this matters for App Store review and for word-of-mouth), and the paid
tier is gated on the feature that has real, ongoing engineering cost behind it
— the document/PDF layer — not on artificially crippling the core scan.
*Precedent:* I checked, and this exact shape — free tier "stays useful
forever," one-time purchase unlocks the advanced tier, no subscription — is
what a comparable on-device-OCR utility (Litho, screenshot-to-Markdown) is
doing on the App Store right now. Not proof it's optimal, but proof it's a
viable, currently-working model in this exact niche.
*Con, stated plainly:* one-time purchases mean no recurring revenue, so if you
want to keep improving this after launch, the incentive to do that work has to
come from somewhere other than the App Store payout. Worth being honest with
yourself about before picking this.

**Option B — subscription.**
*Pro:* materially better recurring revenue if you get real retention, and it's
the default App Store reviewers and analysts expect for anything billed as
"productivity."
*Con:* directly undercuts your own pitch. The privacy copy in your own
description — "on-device," "nothing is sent anywhere," "no account" — is a
trust argument, and asking for a recurring charge on top of an app that does
most of its work with zero ongoing cost to you is the kind of thing that shows
up as "why am I paying monthly for this" in your review section. Doable, but
you'd be fighting your own positioning to do it.

**Option C — paid upfront, no free tier.**
*Pro:* simplest, most honest, no IAP plumbing, matches the "no dark patterns"
feel of the rest of the app.
*Con:* in the actual competitive set I looked at while researching names
below, nearly every comparable app is free-with-IAP. A paid-upfront utility in
a market flooded with free alternatives has a real discoverability problem —
people don't pay $5 up front to find out if OCR quality is good enough for
their receipts when six free apps will let them try first.

I'd go with A. Not because B and C are wrong, they're legitimate choices with
real upside, but because A is the only one that doesn't require you to either
contradict your own privacy pitch (B) or fight the market's free-trial
expectation with zero data on your conversion rate (C). This is a business
call, though, not a technical one, and I'm not a financial advisor — treat
this as reasoning to weigh, not an answer to accept because I said so.

**Decision: Option A, confirmed.** One open problem with it as originally
scoped: putting "Coherence Filter and translation need your own Anthropic API
key" in front of a mainstream, non-technical free-tier user is a real
professionalism and usability problem — most people don't know what an API
key is, shouldn't have to, and a feature that only works after a trip to a
developer console isn't something you can put in a screenshot. `05-HOSTED-AI-
TIER-PLAN.md` in this set is the fix: a small hosted allowance, funded out of
the one-time Pro price, so nobody has to touch a key to get a working AI
feature, while BYOK survives as an optional unlimited tier for people who
want it. Read that document for the real cost math and the architecture,
since "just add a server" is not a decision to wave through without seeing
what it actually costs and what it changes about the app's privacy story.

## 2. Name

**Update — I went back and actually checked "Retext," my prior top pick, and
it doesn't hold up. Recommendation below has changed.**

**The problem with "TextScanner"** is unchanged from before: the current App
Store landscape is saturated with nearly-identical names — "Text Scanner OCR,"
"OCR Text Scanner and Reader," "OCR Scanner: Image to Text" — and genericness
costs you exactly where it matters, in search, against apps with the same
name pattern and years of reviews.

**What I actually checked this time**, since "I searched the web a bit" isn't
the same as a real clearance pass: App Store listings and developer pages for
each candidate, GitHub and general open-source namespaces (a real, common
collision source for short tech-sounding words that a plain App Store search
misses), and general web/trademark-adjacent search. What I did **not** do,
and what you still need before spending money on assets: a formal USPTO TESS
database query (it's an interactive session-based tool, not something I can
query through a web fetch) and a paid trademark-clearance search. One other
thing worth knowing going in: Apple doesn't enforce globally unique app names
the way a domain registrar enforces unique domains — two apps can legally
share a name. The real risks are App Review rejecting you for trading on an
existing trademark or causing user confusion, and the much more common
problem, your own listing getting buried by an existing similarly-named
product in search. Both of those are exactly what the check below is for.

**Retext — dropped.** "ReText" is an existing, actively maintained open-source
Markdown/reStructuredText editor (`retext-project/retext` on GitHub, ~2,000
stars, commits as recent as January 2026, its own wiki, a PyPI package, even
a "ReTextPortable" spinoff). Different platform and different specific niche
than your app, so it's probably not a hard trademark block by itself — but
it's a real, live, similarly-spelled project with genuine community presence,
which undercuts the entire reason I suggested the name: standing out. Anyone
searching "Retext app" today finds that project's GitHub page, not you. I
missed this the first time because I only checked App Store listings and a
generic web search, not the open-source namespace — worth knowing for any
future name check on this project, not just this one.

**Candidates, updated:**

| Name | Why | What I found |
|---|---|---|
| **Inplace** *(new top pick)* | Maximally literal: the whole feature is editing text *in place*. Clear in a store listing even before someone reads the subtitle. | Checked App Store listings, GitHub, and general web search — no consumer scanning/OCR/photo app using this name. The one real hit is "InPlace Editor," a B2B Confluence wiki plugin on the Atlassian Marketplace — different store, different market, low real-world collision risk. Still needs the formal USPTO/clearance pass before you commit. |
| **Litho** | Root of "lithograph" — printing, text pressed into an image. Short, brandable. | **Still deprioritize.** Existing App Store app called "Litho" (screenshot-to-Markdown tool). Different category, close enough to invite confusion. |
| **Verba** | Latin for "words." Pretty, short, brandable. | No direct collision found, but it doesn't communicate the in-place-editing differentiator at all — you'd rely entirely on the subtitle and screenshots to carry that. |
| ~~Retext~~ | ~~"Re-" + "text"~~ | **Drop.** Real, active open-source project with the same name — see above. |

**Revised recommendation: Inplace.** It's a plainer, less "branded" word than
Retext was, and that's a real, honest tradeoff to weigh, not a free upgrade —
you're trading distinctiveness for a clean search result. If you want, I can
run a few more candidate directions through the same check (App Store +
GitHub + web) before you commit to either one; this isn't an exhaustive list,
it's the two strongest ideas from the last pass, re-verified.

## 3. Logo concept

The core visual idea: **a word going from broken/pixelated to whole**, since
that's the actual product experience — you point a camera at imperfect text
and get back something clean and editable. A camera-shutter or photo-corner
shape with a crisp text cursor or letterform inside it reads as "photo +
editable text" at a glance, and stays legible at the small sizes an app icon
actually gets used at (which matters — a lot of scanner-app icons fail exactly
here, cramming a whole scene into a 60×60pt icon that reads as mud).

I sketched two directions as SVG concepts, shown alongside this response.
Concept 1: a photo-corner bracket with a text cursor / I-beam sitting inside
it, in your existing indigo-on-dark palette. Concept 2: a magnifying glass
where the lens is a text line transitioning from blurred to sharp left-to-
right. Both work at icon scale, both avoid any existing platform's icon
language (not a camera-app icon, not a Files-app icon), and both translate
cleanly to the 1024×1024-no-alpha requirement `docs/APP-STORE-SUBMISSION.md`
already documents.

## 4. Pitch

**Tagline:** *The scanner that lets you edit the photo, not just the text.*

**One paragraph:** Every OCR app gives you a block of text to copy and leaves
the photo behind. Inplace keeps them together — tap any recognized word and
correct it right where it sat in the original image, with the pixels around
it filled back in so the fix still looks like a photograph, not a photograph
with a text box glued on top. Recognition runs entirely on your device, there's
no account and nothing is uploaded, and when you want a cleaner reading of a
messy scan, the Coherence Filter can turn scattered fragments into a real
sentence, on-device on newer iPhones or with your own Claude key everywhere
else.

**Who it's actually for**, concretely, since "everyone who scans things" is
not a pitch: students correcting OCR'd lecture-slide photos before they paste
them into notes; anyone dealing with a stack of receipts who wants the total
right rather than a wall of raw OCR noise; people editing signage, menus, or
posters in a second language, where a mistranslated or garbled word is a real
problem and needing to retype the whole thing from scratch is annoying enough
that people just don't bother; and it's genuinely useful as a light
accessibility tool for anyone who wants text read aloud with the source image
still visible for context, which most competitors don't offer at all.
