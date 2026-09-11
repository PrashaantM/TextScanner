# Removing the API key requirement — a hosted allowance, not a subscription

## The problem, stated plainly

Right now, anyone who isn't on Apple Intelligence-eligible hardware sees this
before Coherence Filter or translation will do anything: "needs an Anthropic
API key on this device," a text field, and a link to go generate one on a
developer console. You're right that this is a real problem, not a nitpick —
it assumes the user knows what an API key is, is willing to create a
developer account, and is comfortable pasting a credential into a productivity
app. That's a fine ask for the audience `js/coherenceClaude.js`'s own code
comments are clearly written for (developers, the kind of person who'd read
"anthropic-dangerous-direct-browser-access" and nod), and a genuinely bad ask
for someone who just wants to clean up a photo of a flyer.

The reason it's built this way is architectural, not a choice someone made
carelessly: TextScanner has no backend. It's a static site plus a Capacitor
shell, on purpose, and BYOK is the only way to call a paid API from an app
with no server to hold the key server-side. Fixing the professionalism problem
without adding a backend isn't possible — the fix below adds one, on purpose,
scoped as tightly as it can be.

## The fix: a hosted allowance, funded by the one-time purchase, not a subscription

Three tiers instead of two, in priority order:

1. **On-device (Apple Foundation Models)** — free, no key, no network, no
   change from today. Covers eligible iPhones.
2. **Hosted (new)** — free to try, then a bounded monthly allowance included
   with the one-time Pro purchase. No key, no account beyond the purchase
   itself. This is what closes the gap for everyone who isn't on eligible
   Apple hardware.
3. **BYOK Claude (existing, unchanged)** — stays exactly as it is today, as an
   optional escape hatch for people who want unlimited use or their own model
   choice. Nobody is required to touch it anymore; it moves from "the only
   option" to "the power-user option."

This keeps Option A's shape (one-time purchase, no subscription) intact. What
it costs you is real infrastructure and a real, ongoing, usage-linked expense
— small, bounded, and controllable, but not zero, and not something to treat
as a pure win. The rest of this document is the honest version of that
tradeoff, not just the pitch for it.

## The constraint this surfaces that wasn't visible before: web and iOS need different answers

Apple's in-app purchase APIs are iOS-only — there's no App Store on the web
build hosted at `prashaantm.github.io`. So "funded by the Pro purchase" only
works as stated on iOS. Three honest options for the web build, worth a real
decision rather than an afterthought:

- **Web build keeps BYOK only.** Simplest, no new payment infrastructure for
  a build that was always the "for developers" version anyway (it already
  discloses the shared-origin key-exposure caveat that the native app doesn't
  have). The free hosted allowance becomes an iOS-Pro-purchase perk
  specifically, not a whole-product feature.
- **Add a small web payment (Stripe Checkout, one-time)** gating the same
  hosted allowance for web users. More consistent experience across both
  builds, more surface area to build and maintain.
- **Give the web build a small no-purchase-required free allowance** (e.g., 5
  hosted runs, no payment at all, then BYOK or nothing), funded as a
  marketing/acquisition cost rather than tied to a purchase. Cheapest to
  reason about, easiest to abuse (see rate-limiting below), and the cost is
  yours regardless of whether the visitor ever buys anything.

My recommendation is the first option — leave the web build BYOK-only for
now, ship the hosted allowance on iOS only where the Pro purchase can actually
fund and gate it, and revisit the web build once you have real usage data
from iOS. Building a second payment system before you know whether the first
one's economics hold up is the kind of scope creep that turns a one-feature
fix into a much bigger project.

## Architecture

New tier in the existing dispatcher shape — `js/coherence.js` already has the
right pattern (`TIER.ON_DEVICE`, `TIER.CLAUDE`, `TIER.NONE`), this adds one
more and reorders the priority:

```js
export const TIER = {
  ON_DEVICE: "on-device",
  HOSTED: "hosted",     // new
  CLAUDE: "claude",
  NONE: "none",
};

export async function resolveTier(preferOnDevice = true) {
  const onDevice = await getOnDeviceAvailability();
  if (preferOnDevice && onDevice.available) return { tier: TIER.ON_DEVICE, reason: null };

  const hosted = await getHostedAvailability(); // has Pro + allowance remaining?
  if (hosted.available) return { tier: TIER.HOSTED, reason: null };

  if (hasStoredApiKey()) return { tier: TIER.CLAUDE, reason: null };
  if (onDevice.available) return { tier: TIER.ON_DEVICE, reason: null };

  return { tier: TIER.NONE, reason: /* unchanged */ };
}
```

A new `js/coherenceHosted.js`, deliberately mirroring `coherenceClaude.js`'s
shape (same function signature, same "throw an Error with a UI-safe message"
contract) so `coherence.js`'s dispatch logic barely changes:

```js
const RELAY_URL = "https://api.yourdomain.com/v1/coherence";

export async function rewriteHosted(filteredText, entitlementToken) {
  const response = await fetch(RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: filteredText, entitlement: entitlementToken }),
  });

  if (response.status === 429) throw new Error("You've used this month's included AI cleanups. Add your own Anthropic key for unlimited use, or wait until next month.");
  if (!response.ok) throw new Error("Couldn't reach the hosted service. Try again shortly.");

  const data = await response.json();
  return data.text;
}
```

**The relay itself** — a Cloudflare Worker is the right scale for this, not a
full server: near-zero cold start, a free tier that covers this comfortably,
and it holds exactly one secret (your Anthropic key) and does exactly one
job.

```js
// Cloudflare Worker — pseudocode, the shape that matters
export default {
  async fetch(request, env) {
    const { text, entitlement } = await request.json();

    // 1. Verify the entitlement server-side. For iOS, this means validating
    //    against Apple's App Store Server API that this device/account
    //    actually purchased Pro — never trust a client-supplied "I paid" flag.
    const valid = await verifyEntitlement(entitlement, env);
    if (!valid) return new Response("Invalid entitlement", { status: 403 });

    // 2. Enforce the allowance server-side, in a Workers KV or D1 record
    //    keyed by a hash of the entitlement, not by anything the client
    //    controls. This is the step that actually bounds your cost — skip
    //    it and a single purchase can generate unlimited API spend.
    const used = await getMonthlyUsage(entitlement, env);
    if (used >= env.MONTHLY_ALLOWANCE) return new Response("Allowance exhausted", { status: 429 });

    // 3. Call Claude with YOUR key, never the client's.
    const result = await callClaude(text, env.ANTHROPIC_API_KEY);
    await incrementUsage(entitlement, env);
    return Response.json({ text: result });
  },
};
```

**Model choice matters for cost control.** `coherenceClaude.js` uses
`claude-opus-5` today, which is the right call when the user is paying for
their own usage and wants the best quality. For a hosted tier you're funding
out of a one-time purchase, default to a cheaper model — Claude Sonnet 5 is
the sensible middle: materially cheaper than Opus, and this task (turning
short OCR fragments into a paragraph) doesn't need Opus-level reasoning to do
well. Keep Opus available as what BYOK users get if they bring their own key,
since that's their cost to bear, not yours.

## Cost math, with real numbers

Current published Anthropic API list prices (checked, not recalled): Claude
Sonnet 5 is $2 input / $10 output per million tokens, Claude Opus 5 is $5/$25.
A Coherence Filter call is small — the system prompt plus a scan's worth of
OCR fragments is realistically 800-2,000 input tokens, and the rewritten
output is a short paragraph, 100-400 tokens. Padding generously for margin:

- **Sonnet 5, 2,000 input + 400 output tokens:** input $0.004 + output $0.004
  ≈ **$0.008 per call**, call it a full cent with overhead.
- **50 hosted runs/month allowance** ≈ 50¢/month for a user who actually
  exhausts it every single month — which most won't; most people clean up
  text occasionally, not daily.
- Against a $6.99-$9.99 one-time Pro price, a user would need to max the
  allowance every month for well over a year before your API cost for them
  alone matched the purchase price.

**This is real math on real current prices, not a promise about your actual
margin.** It assumes typical usage, not worst-case usage, and it doesn't
account for a purchaser who never uses the feature at all (pure margin for
you) averaging against one who somehow finds a way to hammer it. Two things
that turn this from "probably fine" into "actually controlled":

- **The allowance and the monthly reset live in a config value you can tune
  after launch**, not a number hardcoded and forgotten — watch real usage for
  the first few hundred purchasers and adjust before it's a problem, not
  after.
- **Server-side enforcement is non-negotiable.** The Worker code above checks
  usage before calling Claude, every time, on infrastructure the client can't
  touch. A client-side-only "you've used 50 this month" counter is not a cost
  control, it's a suggestion, and a jailbroken or reverse-engineered client
  can ignore it entirely.

## What this changes about the privacy story, and why you have to say so

Today's copy is accurate and specific: on-device runs stay on-device, and the
Claude tier is disclosed as "the only thing in TextScanner that leaves your
device," sent directly from the user's browser to Anthropic's API using their
own key and their own account. Once a hosted relay exists, that's no longer
true for hosted-tier users — their scanned text now goes to your relay first,
then to Anthropic, using your account. The relay should be stateless (don't
log or store the text beyond what's needed to make the single call and return
a response), and the in-app copy needs a plain, accurate rewrite for this
tier specifically: something like "the hosted AI tier sends your extracted
text to our server, which forwards it to Anthropic's API and doesn't store
it — nothing else about the app changes." Same standard the rest of this
app's copy already holds itself to, applied to a genuinely new fact rather
than glossed over.

## What I'd explicitly weigh against this before building it

- **New ongoing engineering surface.** Receipt validation against Apple's
  server API, a usage-tracking store, a deployed and monitored Worker — this
  is real, ongoing maintenance for a project that currently has none, on top
  of everything else already tracked as open work.
- **Abuse surface.** Entitlement tokens that get shared or extracted become a
  way to get free API calls on your dime; rate-limit per-entitlement
  aggressively and expect to iterate on this after real-world abuse patterns
  show up, not before.
- **The lighter alternative, for comparison.** If you'd rather not take on a
  backend at all: leave BYOK as the only AI path, but make it fully optional
  and low-pressure in the UI — no nag, a clearly-labeled "power user" section,
  never blocking the core scan-and-edit flow that doesn't need AI at all.
  This solves "feels unprofessional and pushy" without solving "available to
  people who don't want to deal with AI setup at all" — those users simply
  don't get Coherence Filter, which for a lot of receipt-and-poster scanning
  is a perfectly fine outcome. Cheaper and lower-risk than the relay, but it
  doesn't fully satisfy what you asked for, which is why it's the fallback
  here rather than the plan.

## Rollout order

1. Ship the relay for iOS only, gated on the Pro purchase, defaulting to
   Sonnet 5, with a conservative allowance (start low, e.g. 20/month — easier
   to raise a limit that's too tight than to claw back one that's too
   generous).
2. Update the in-app disclosure copy and the privacy nutrition label
   (`docs/APP-STORE-SUBMISSION.md` §3) to reflect the new data path
   accurately before this ships, not after.
3. Watch real usage for 4-6 weeks before deciding whether to build the web
   equivalent — you'll have actual numbers instead of my estimates by then.
