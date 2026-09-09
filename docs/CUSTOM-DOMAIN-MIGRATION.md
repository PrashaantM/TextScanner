# Custom domain migration — prepared, blocked on the domain

**Phase 5 of `TEXTSCANNER-HARDENING-PLAN.md`.** P1.

**Status: BLOCKED, and the blocker is not something I can clear.** Steps 1 and 3
need a DNS registrar login and the repository's GitHub Pages settings. Every
other step depends on knowing the actual hostname.

**What this document is for:** so that once the domain exists, the rest is
mechanical rather than a fresh piece of work. The audit is done, the exact copy
changes are written out below ready to paste, and the one thing that must *not*
be changed early is called out.

---

## Why this cannot be done ahead of time

The temptation is to write the `CNAME` file and update the copy now, so it is
ready. **Do not**, and the reason is the point of the whole phase.

The copy currently shown to users says the API key is readable by any other site
on the shared `github.io` origin. That statement is **true right now**, and it is
the honest disclosure the rest of the app's copy is held to. Replacing it with
the corrected, narrower claim before the app actually moves would make the app
tell users their key is safer than it is.

So the copy changes below land *with* the migration, not before it.

---

## What you have to do (steps 1 and 3)

1. **Acquire or choose a domain or subdomain you control**, then add a DNS record
   pointing it at GitHub Pages:
   - A subdomain (`textscanner.example.com`) — a **CNAME** record to
     `prashaantm.github.io`.
   - An apex domain (`example.com`) — four **A** records to `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
   - The subdomain route is simpler and is what the rest of this document
     assumes.

2. **Repository → Settings → Pages → Custom domain**: enter the domain, save,
   wait for the DNS check to pass, then tick **Enforce HTTPS** once the
   certificate provisions (usually minutes, occasionally up to 24 hours).

Then tell me the hostname and I will do the rest.

---

## What I have already verified

### Step 6 — no hardcoded `github.io` URL anywhere: **PASSES**

```
grep -rn "github\.io" js/ index.html style.css
```

Three matches, and **none is a URL**:

| Location | What it is |
|---|---|
| `js/coherenceClaude.js:22` | A comment explaining origin-scoped storage |
| `index.html:155` | An HTML comment explaining the caveat below it |
| `index.html:161` | The user-facing caveat copy itself |

Nothing constructs a link, an API endpoint, or an asset path from a hardcoded
origin, so **no code change is needed for the app to work on a new domain**. The
three matches are all prose, and all three are the prose this migration exists
to correct.

### There is no `CNAME` file yet

Correct for the current state — adding one now would point Pages at a domain
that does not resolve.

---

## The changes that land with the migration

### 1. Add `CNAME` at the repository root

One line, the bare hostname, no scheme and no trailing slash, with a trailing
newline:

```
textscanner.example.com
```

GitHub Pages also writes this file itself when you set the domain in Settings —
committing it keeps the setting in version control so a re-deploy cannot silently
drop it.

### 2. Replace the shared-origin caveat (`index.html`, `#coherence-disclosure-origin`)

The corrected claim is **narrower but not "safe"**: the key still lives in
browser storage, still readable by script on that origin — the difference is
that the origin is now this app alone rather than every project published under
the account.

Replace the paragraph with:

```html
<p id="coherence-disclosure-origin" class="coherence-panel__disclosure coherence-panel__disclosure--caveat hidden">
  Your key is stored in this browser, scoped to this site alone &mdash; no other
  site can read it back. It is still browser storage rather than a secret vault,
  so a key scoped and budget-limited to this use is still the right kind of key
  to paste here, and &ldquo;Change key&rdquo; removes it when you're done.
</p>
```

And update the HTML comment above it, which currently explains the *old* reason:

```html
<!-- The app moved to its own domain, so browser storage is no longer shared
     with every other project under the account. The caveat stays, narrowed:
     origin-scoped storage is still script-readable storage, and saying so is
     the same standard the rest of this app's copy holds itself to. Shown only
     when the Claude tier is actually in play. -->
```

### 3. Update the comment in `js/coherenceClaude.js:22`

Currently: *"storage is scoped to the whole shared github.io origin, not to this
app."* That becomes wrong on migration day. Replace with a note that storage is
origin-scoped and the origin is now this app's own domain.

### 4. Add the re-entry notice (step 5)

**Browser storage does not survive an origin change.** Anyone who saved a key on
the `github.io` origin will find it gone, with no explanation, and the empty
state will simply look like they never saved one.

Add to the empty-state copy shown when no key is stored:

```html
<p class="coherence-panel__disclosure">
  Used TextScanner at its old <code>github.io</code> address? Keys are stored per
  site, so a key saved there won't have followed the move &mdash; enter it once
  more here.
</p>
```

Worth keeping for a few months, then removing — it is migration scaffolding, not
permanent copy.

### 5. Re-verify the CSP on the new origin (step 6)

The CSP is a `<meta>` tag in `index.html` and contains no origin literals, so it
should carry over unchanged. Confirm after the move that the Coherence Filter and
translation still reach `api.anthropic.com` — a CSP `connect-src` problem shows
up exactly there and nowhere else.

### 6. Update `docs/PRIVACY-DECISIONS.md` (step 7)

`ANALYSIS.md` §4.3 is the finding this closes. Record it as closed, with the
narrowed claim rather than as "resolved" — the key is still in browser storage.

---

## Acceptance

Straight from the plan's "Done when", none of which can be ticked yet:

- [ ] The app is reachable at the custom domain over HTTPS
- [ ] The shared-origin caveat is replaced with the corrected claim
- [ ] The re-entry notice is present
- [ ] No hardcoded `github.io` URL remains — **already true**, verified above
