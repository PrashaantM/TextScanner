# WEB-COMPLETION-PLAN.md — what stands between the web app and shippable

**Written 2026-09-13, against `1e27c5d` on `main`.** Scope is the **web build only**:
`index.html`, `style.css`, `js/`, `vendor/tesseract/`, `test/`, `.github/workflows/ci.yml`,
and the GitHub Pages deployment at <https://prashaantm.github.io/TextScanner/>.

Nothing about the iOS build, ML Kit, Capacitor, the App Store, the device pass, or
the `www/`/`ios/App/App/public/` generated trees is a task in this file. Where one of
those already-tracked items also blocks the web app, it appears under
[§4 Not solvable by you](#4-not-solvable-by-you) rather than being quietly restated
as engineering work.

This started as a map, not a diff. **Tasks marked DONE below have since been
built**; everything else is still untouched. The status of each is stated in its
own section rather than in a separate tracker that could drift from it.

---

## 0. Where the web build actually stands

**Standing rule, added after this section's own numbers drifted three
separate times in three separate sessions.** Whichever commit touches
`EXPECTED_ID_COUNT` in `test/dom-contract.js`, adds a `node` step to
`ci.yml`'s per-push job, or otherwise moves the id count, the module/line
count or the CI-gate count this section states, updates this section's
numbers **in that same commit** - not in a follow-up doc pass, which is
exactly how they drifted every time so far: a doc-accuracy commit is only
accurate as of the moment it lands, and every commit after it in the same
session is a chance to move a number the doc just fixed. Say in one sentence
in the commit message whether the commit touches any of the three; if it
does, the same commit carries the doc update.

**Three of those numbers are now gated rather than promised, in three
documents.** `node test/repo-contract.js` (gate 4) parses the module count,
the line count and the CI-gate count back OUT of this section - and out of
`README.md` and `ANALYSIS.md` - and fails if any disagrees with the tree - so the standing rule above is now enforced for them by CI instead
of by whoever remembers it. The counts are parsed, not duplicated in the test
file: this section stays the single source and the gate only checks it. Every
place §0 states one of the three is checked, not just the fact table, so a
restatement in prose cannot drift away from the table above it - which had
already happened: the "unbundled ES modules" line below was one behind the
fact table above it, and gate 4 failed on that line before it failed on
anything else. The id count is deliberately NOT handled this way;
`EXPECTED_ID_COUNT` in `test/dom-contract.js` stays a hand-edited number,
because changing the id contract SHOULD cost a deliberate edit.

**A number that is deliberately history says so, in the document.** Extending
the gate past this section meant deciding, per number, whether a document was
making a live claim or recording what was true at some past revision -
`ANALYSIS.md` does both. Inferring that from context is what the first version
did (it treated a markdown blockquote as meaning "historical", which is not
what a blockquote means), and it is unreviewable. So the document declares it:
`<!-- count-snapshot: why -->` at the end of a line, or a
`<!-- count-snapshot-begin: why -->` / `<!-- count-snapshot-end -->` pair
around a fenced block where an inline comment would render instead of hiding.
Marked numbers are never checked; unmarked ones must be true now. The marker
carries a reason rather than being a bare flag, and a marker sitting over text
that no longer states a count is itself a failure. It is a declaration, not a
proof: someone can freeze a live number with it, exactly as someone can add a
wrong entry to `EXEMPT_HELPERS`. The reason text in the diff is what makes
that reviewable.

**Two further checks live in the same gate, both about the suite rather than
this section.** No file in `test/` may bind a fixed TCP port - 28 files were
sharing 20 numbers and eight pairs collided, and a fixed port also means two
runs of the SAME gate collide, which renumbering cannot fix. And every browser
gate must be able to see *handled* console errors, not only uncaught ones: 25
gates installed `page.on("pageerror")` and none watched the console, so every
`console.error` inside a `catch` - `withBusy` in `js/scanDoc.js` catches, logs
and alerts - was invisible to the whole suite.

Checked today rather than carried forward from `HANDOFF.md`:

| Fact | How it was checked |
|---|---|
| Live, HTTPS enforced, built from `main` at `/` by **legacy Jekyll**, no CNAME, `custom_404: false` | `gh api repos/PrashaantM/TextScanner/pages` |
| Every runtime asset resolves on the live origin | `curl` for `/`, `/js/main.js`, `/js/radialMenu.js`, `/style.css`, `/vendor/tesseract/tesseract.min.js`, `/vendor/tesseract/worker.min.js`, `/vendor/tesseract/tessdata/eng.traineddata.gz`, `/vendor/tesseract/core/tesseract-core-{simd-,}lstm.wasm.js` — all 200 |
| Served over HTTP/2, gzipped, `cache-control: max-age=600` | `curl -I` on `/js/main.js`: 47 KB → 15.6 KB on the wire |
| 81 unit tests pass | `node --test test/unit/*.test.js` — 81 pass, 0 fail |
| The newest browser gate passes | `node test/font-match.js` — all 7 checks green |
| Last CI run on `main` green | run `34673998815`, 3m30s |
| 50 modules, 17,689 lines in `js/` | `wc -l js/*.js`, `ls js/*.js \| wc -l` |
| 33 gates in `ci.yml`'s per-push `test:` job | `awk '/^  test:/,/^  cross-browser:/' .github/workflows/ci.yml \| grep -c '^      - run: node'` |
| Tracked repo 8.87 MiB; `vendor/tesseract` is 11 MB of it on disk | `git count-objects -vH`, `du` |

**Jekyll is not eating anything.** Its default excludes cover `vendor/bundle`,
`vendor/cache`, `vendor/gems`, `vendor/ruby` — not `vendor/tesseract`. Confirmed
empirically by the 200s above, so no `.nojekyll` is needed.

> **The module and line counts above were stale when this line was added, which
> is what the standing rule exists to prevent.** They read 47/15,983 while the
> tree held 48/16,419: the F4 interaction-model commit added
> `js/reducedTransparency.js` and did not bring this section with it. Corrected
> to 49/17,394 in the same commit that added `js/fontMatch.js` — the rule
> applied, one commit late for the module before it.

**50 unbundled ES modules over HTTP/2 is not a load problem.** 736 KB raw across
`js/`, gzipped per-file, multiplexed on one connection. Don't add a bundler; the
no-build-step property is worth more than the milliseconds.

### The "72 DOM ids" number is stale — it is **71**

`js/dom.js` resolves 71 ids today, and all 71 exist in `index.html` (verified by
`node test/dom-contract.js`, not by eye).

| Commit | ids in `dom.js` | What moved |
|---|---|---|
| `4ae7cfd`, `ca341d7` | 68 | the number every doc still quotes |
| `8d37a35` | 70 | `clean-up-text-btn`, `view-on-photo-btn` |
| `e181738` | 71 | `coherence-gate-hint` |
| `a511ac0` | 72 | `footer-version` (W12) |
| UI-REDESIGN-PLAN.md §2.1-§2.5 | 71 | removed `download-image-btn`, `clean-up-text-btn`, `view-on-photo-btn`, `select-multi-btn`, `editor-mode-btn` (merged into other controls or converted to gestures); added `paste-btn`, `download-menu`, `download-menu-backdrop`, `move-handle`. Net −1. |
| F4 interaction-model rewrite (this session), Phases 1-3 | 71 | Phase 2 removed `copy-btn`, `paste-btn` (deleted outright - Ctrl/Cmd+C/V and a touch long-press menu trigger copy/paste now) and added `text-clipboard-menu`, `text-clipboard-menu-backdrop` (the touch menu's own markup). Phase 3 removed `new-text-btn` (deleted outright, along with the addTextMode plumbing only it drove) and added `filter-toggle-row` (Text-mode-only visibility needed an id to hide/inert as a unit). Net −3, +3 = 0, landing back on 71 again - a third coincidence of arithmetic, not a third instance of nothing changing. Phases 4 and 5 added/removed no ids at all (drag-and-drop and the glass-token migration are both markup-id-neutral). |

Treat **71** as the invariant from here on. `index.html` carries **161** ids in
total (163 before this session's Phase 3, which additionally deleted
`add-to-doc-btn` and `save-note-btn` outright rather than moving them - both
actions live only inside `#download-menu` now, addressed by `data-menu-action`
rather than an id each, so neither is a "behaves like the contract in
practice" honourable mention any more the way this section used to describe
them). The other 90 are resolved locally by `app.js`, `library.js`,
`scanDoc.js` etc. and are not the protected contract.

**`EXPECTED_ID_COUNT` did not move for the PII-detection work either, for the
same reason as the redaction ids above.** "Find PII" added five ids
(`scan-pii-panel`, `scan-pii-summary`, `scan-pii-list`, `scan-pii-redact-selected`,
and the button carrying `data-scan-action="pii-scan"` needs none of its own) -
all resolved by `js/scanDoc.js`, not `js/dom.js`. The total moved 160 → 164;
the protected 72 did not.

**`EXPECTED_ID_COUNT` did not move for the redaction work, and that is correct.**
The six ids that commit added (`scan-redact-panel`, `scan-redact-overlay`,
`scan-redact-count`, `scan-redact-apply`, `scan-redact-undo`,
`scan-redact-cancel`) are resolved by `js/scanDoc.js`, exactly like every other
scan-document control — `scan-doc-title`, `scan-page-info`, `scan-paper-size`
and the rest. They are in the 88, not the 72. Moving `EXPECTED_ID_COUNT` would
have meant hoisting a scan-doc-local control into `js/dom.js` purely to make a
number change, which is the opposite of what that gate is for. The figure that
moved is the total: 154 → 160.

### The 33 CI gates, and which ones a change can actually break

`.github/workflows/ci.yml` runs gates 1-4 immediately (none of them needs a
browser or an `npm install` - see their own comments), then `npm ci` +
`playwright-core install chromium`, then the rest, in the order the workflow
file actually runs them:

| # | Gate | Drives the app through element ids? |
|---|---|---|
| 1 | `dom-contract.js` — **added by W3** | It *is* the id contract |
| 2 | `motion-contract.js` | No — also browser-free, greps `style.css` |
| 3 | `site-metadata.js` — **added by W12/W11** | No — also browser-free, checks the version stamp and og:/404 metadata as text |
| 4 | `repo-contract.js` — **added by this change** | No — browser-free. Parses this section's own counts out of the markdown and checks every `test/*.js` gate is wired into the workflow |
| 5 | `node --test test/unit/*.test.js` | No — pure functions |
| 6 | `run-benchmark.js --check-regression --baseline test/baseline-2026-08-28.json --tolerance 2.0` | Yes, the scan flow |
| 7 | `region-coverage.js` | Yes, the same scan flow, scored area by area |
| 8 | `touch-interactions.js` | Yes — **and CDP-only, see W2** |
| 9 | `malformed-input.js` | Yes |
| 10 | `exif-orientation.js` | Yes |
| 11 | `move-inpaint.js` | Yes |
| 12 | `guided-path.js` | Yes — the buttons the UI itself points people at, not the raw mode toggles |
| 13 | `editor-delete.js` | Yes |
| 14 | `replacement-size.js` | Yes |
| 15 | `font-match.js` — **added by the per-word font-matching change** | Yes — draws words in a known face, hands the pixels to the real matcher and scores what comes back |
| 16 | `chrome-reorganization.js` — **added by F4, and gated nothing for a full commit cycle** | Yes — the filter row's Text-mode-only inertness, the corner download menu's anchoring under scroll, and the move handle |
| 17 | `paste-placement.js` — **written in `b823567`, wired into CI by this change** | Yes — Ctrl/Cmd+C/V clone a word's resolved font/size/colour, in-place editing is left to the browser, and a touch long-press reaches the same two actions |
| 18 | `not-text-warning.js` | Yes |
| 19 | `render-fidelity.js` | Yes, plus `import("/js/dom.js")` directly |
| 20 | `non-latin-limitation.js` | Yes |
| 21 | `heic-input.js` | Yes |
| 22 | `web-tier-smoke.js` | Yes, plus `import("/js/dom.js")` |
| 23 | `pdf-export.js` | Partly; `qlmanage` leg is macOS-only and skipped on CI |
| 24 | `library-documents.js` | **Mostly no** — imports `/js/documents.js` and drives the model |
| 25 | `document-creation.js` | Yes, through the real nav/action sheet |
| 26 | `interaction-layer.js` | Yes |
| 27 | `destructive-actions.js` | Yes, through the real dialog-gated controls |
| 28 | `redaction-destroys-original.js` — **added by the redaction change** | Yes — the real Redact button, a real drag, and both confirms; asserts against `STORES.BLOBS` directly |
| 29 | `pii-redaction.js` — **added by the PII-detection change** | Yes — the real "Find PII"/"Redact selected" buttons, plus one real OCR pass on the corpus and two on synthetic-but-real-OCR fixtures |
| 30 | `radial-call-sites.js` | Yes |
| 31 | `inpaint-fidelity.js` | No — imports `/js/inpaint.js` and drives the algorithm directly |
| 32 | `backup-roundtrip.js` | Partly - mostly imports `/js/store.js`, `/js/documents.js` and `/js/backup.js` directly, but "Delete all local data" goes through the real `#settings-delete-all` button |
| 33 | `offline.js` — **added by W1** | Partly — drives the real `#file-input`/`#scan-btn` and reads the rendered Library, but its subject is `sw.js`: the two cache buckets, the precache manifest against `ls js/*.js` in both directions, and the registration escape hatch |

This table drifted every time a gate was added, and it moved six times in
six sessions before the count became a gate. The 33 above is the literal
output of
(`awk '/^  test:/,/^  cross-browser:/' .github/workflows/ci.yml | grep -c
'^      - run: node'`), not 30 plus two, and gate 4 now fails if it is ever
anything else - including if someone edits this heading without touching the
workflow. It counts gate 5 (`node --test test/unit/*.test.js`) as a gate,
which is what this table has always done.

**The ROWS are still hand-maintained, and the gate does not check them.** It
pins the count, not the descriptions, so a 33rd gate added without a row here
fails the count and tells you to write one - but a row whose description goes
stale is still only caught by reading it. Two rows were missing entirely when
the count was gated: `font-match.js` and `chrome-reorganization.js` had been
running in CI with no row at all, which is how the heading said 28 while the
workflow ran 30.

**§1's risk notes name gate FILES, not table positions, and that is
deliberate.** They used to read "gates 12, 13 and 14" (W5), "gate 12" (W7) and
"gate 8" (W14), anchored to the table as it stood in `b57854c` - and they had
already drifted seven places by the time anyone noticed, because a row
inserted anywhere above shifts every number below it. Renumbering them would
have bought one correct revision and the same drift again at the next insert;
leaving them stale was honest but useless. Resolving them against `b57854c`
(`git show b57854c:WEB-COMPLETION-PLAN.md`) gives `pdf-export.js`,
`library-documents.js`, `document-creation.js` and `render-fidelity.js`, and a
filename cannot drift. W7's claim that its gate "leans on `js/store.js`
hardest" is reproduced as the author wrote it: the archaeology settles WHICH
gate was meant, not whether that was the right thing to say about it, and
re-deciding that would be the guessing this replacement exists to end.

**What gate 29 is protecting.** PII detection runs over `page.words` (a scan
document page's real OCR result), not `state.editorObjects` (the separate,
disconnected OCR/image-format editor in `js/main.js`'s VIEWS.SCAN) - the two
were checked, not assumed, to have no existing bridge between them at all
(`js/piiDetect.js`'s header has the full reasoning). A detected candidate's
OCR bbox and a hand-drawn redaction box already share the same coordinate
space because `rebuildPage` bakes crop/rotation/filter into a page's pixels
before anything OCRs them - so the bridge is one division, not a transform -
and the gate proves that against a page that has actually been rotated, using
an independent pixel-darkness scan as ground truth rather than checking the
code against its own output. Selected candidates are converted to boxes and
handed to the EXISTING `applyRedaction` draft/confirm/destroy path (gate 28);
this gate does not re-prove destruction, only that the bridge reaches it.

**What gate 28 is protecting, since it is a contract change rather than a new
feature.** Redaction used to keep the page's untouched original in IndexedDB
under `originalBlobKey`, deliberately, so the person who drew it could undo it -
`js/annotate.js` said so in as many words. That made the "redacted" badge true
of the exported JPEG and false of the device, because `rebuildPage` re-derives
the page from that original on every filter, rotate and crop. Applying a
redaction now destroys it, in the same action, behind two confirms; a tombstone
in `js/store.js` stops a restore putting it back; and the gate reads
`STORES.BLOBS` directly rather than trusting a flag on the page record.

**Until W3 landed, nothing in that table asserted that the 72 ids resolve.**
`getElementById` returns `null`, it does not throw, so `js/dom.js` imports cleanly
with a missing element and the failure surfaces later as a `TypeError` at the first
use — and only if a gate happens to touch that particular control. Renaming an id
that no gate exercised was a silent, green-CI regression. Gate 1 closes that.

---

## 1. Tasks

Ordering is suggested in §3. Each task states the files, a definition of done you
can check yourself without taking my word for it, and what it risks.

---

### W1 — Make the offline claim true, or stop making it — **DONE (built, not reworded), 3 findings, and one check still owed**

**What was built.** `sw.js` at the repo root, registered from
`js/serviceWorkerRegistration.js` (loaded by `index.html` as its own module), and
`test/offline.js` wired in as gate 33. The claim is now true: with the network
off, a full load of the app URL renders the Library and scanning a local image
completes end to end, both asserted in CI.

**Two buckets, and the split is the whole design.** `vendor/tesseract` is 11 MB;
precaching it at install would mean every first visit pays for 11 MB before the
app is usable, including visits that never scan. So:

- **Eager, precached at install (1.07 MB as stored):** `./` and `index.html` (both keys —
  a reload of the deployed URL asks for the directory, not the filename),
  `style.css`, all 50 `js/*.js`, `manifest.webmanifest`, the four `icons/` PNGs,
  `vendor/tesseract/tesseract.min.js` (which *must* be eager: `index.html` loads
  it in a blocking classic `<script>`, so the page cannot boot without it), and
  the 47 KB `RobotoCondensed-Regular.ttf`. Deliberately excluded: `404.html`
  (offline, an unknown path falls back to the cached shell, which is better) and
  the two `.LICENSE.txt` files, never requested at runtime.
- **Lazy, cached on the first successful scan (6.69 MB as stored):**
  `worker.min.js`, `tessdata/eng.traineddata.gz`, and **one** core `.wasm.js` —
  whichever the worker's own runtime SIMD detection asks for, rather than both.
  This needs no message plumbing: the first scan *is* what requests these three,
  so the cache fills as a side effect of requests the scan already makes.

**Stale-cache lockout is designed against, not merely noted.** Navigations are
**network-first**, so an online user always gets the deployed build. The shell
assets are network-first **too**, which is the less obvious half: this repo has
no build step and therefore no content hashes, so cache-first on `js/*.js` would
pin last week's modules under a freshly fetched `index.html` — a version skew
presenting as an app broken in a way no single file explains. The cache is a
genuine offline *fallback* and never a source of skew. Only the recognition
payload is cache-first, because revalidating 6.7 MB on every scan is the hostile
behaviour this is all trying to avoid; the price is a coupling, stated in
`sw.js`: **bumping tesseract.js means bumping `SW_VERSION` in the same commit.**
`skipWaiting()` + `clients.claim()` are deliberate for the same reason — a new
worker parked in "waiting" behind an always-open tab is the classic way a new
build never reaches anyone. And `?nosw` is a real recovery path, not a test hook:
it unregisters and purges the caches without touching IndexedDB.

**The escape hatch: opt-IN, and the two candidates are not equivalent.** §W1
originally offered `location.protocol === "https:"` **or** a `?nosw` parameter.
`?nosw` is opt-**out**: the worker would register everywhere unless a page said
otherwise, so making the suite safe would mean appending `?nosw` to the URL in
all 32 existing gates — and the 34th gate, the one nobody has written, would
silently inherit a worker answering its requests from a cache. That is the same
shape of defect as the console-capture blind spot `test/browser.js` exists to
centralise: coverage believed rather than real, with the newest gate the least
protected. So registration happens only over `https:` or on an explicit `?sw`,
and `test/offline.js` asserts **both** halves — a plain `http://` load leaves the
page uncontrolled with no registration and no cache, and `?sw=1` produces a
controlled page. It falls out of this that the iOS build never registers either
(Capacitor serves the WKWebView over `capacitor://localhost`), which matters
because `scripts/sync-web-assets.sh` copies `js/` but not the root-level `sw.js`;
an `isNativePlatform` guard states that intent rather than leaving it resting on
a scheme comparison. **Not device-verified** — see "still owed" below.

**CSP needed no change, and that was checked rather than assumed.**
`index.html:55` literally carries `worker-src 'self' blob:` and
`default-src 'self'`. But the same CSP forced one real design decision: it is
`script-src 'self' 'wasm-unsafe-eval'` with **no `'unsafe-inline'`**, so the
registration cannot be the inline `<script>` this section's "Files" note
originally implied — an inline block would be refused outright. Hence a module.

**Three findings from building it.**

1. **A service worker *does* see the requests made by Tesseract's `blob:`
   Worker.** The whole lazy-caching design rests on this and it was not safe to
   guess: two of the three payload files are fetched by the worker, not the page,
   and that worker is created from a Blob URL. A recording worker plus a real
   scan settled it — `worker.min.js` (`mode=no-cors`),
   `core/tesseract-core-simd-lstm.wasm.js` (`mode=no-cors`) and
   `tessdata/eng.traineddata.gz` (`mode=cors`) were all intercepted on chromium.
   Had they not been, lazy caching could never have served them back offline.
2. **`context.setOffline(true)` does not block Chromium's service-worker script
   update check.** `/sw.js` still reached the static server during the offline
   steps, with no `?sw` in the URL and nothing in the repo fetching that path —
   it is the navigation-triggered soft update the spec requires, issued outside
   Playwright's context-level emulation, and it arrives a beat late, so it first
   surfaced in the window for the step *after* the one that caused it. Allowed as
   one exact path, never a category, and the socket-closed step covers the case
   where even that cannot succeed. It is also the mechanism that keeps the app
   updatable, so suppressing it would be undesirable even if it were possible.
3. **Every gate's static server mislabels the directory URL.** They map `/` to
   `index.html`'s bytes while taking the MIME type from `extname("/")`, which is
   `""` — so `/` is served as `application/octet-stream`. No existing gate
   notices, because every one of them navigates to `/index.html` explicitly.
   `test/offline.js` navigates to the bare URL a bookmark opens, the worker
   precached that octet-stream response, and replaying it offline made Chromium
   *download* the app instead of rendering it (`page.goto: Download is
   starting`). The deployment is fine — Pages returns `text/html` for
   `/TextScanner/` — so this is the test server being less faithful than the real
   one. Fixed in `test/offline.js` only; **the other 32 servers still have it**,
   latent until another gate asks for a directory URL.

**What is still owed, and it is part of this task's own definition of done.**
The live redeploy check: push to `main`, wait for Pages, reload twice, confirm
the **new** build arrives. That cannot be done from this session, so it was
simulated faithfully against a local server instead — a changed asset, served to
an already-controlled client, must appear on the next load. The simulation is
evidence that the strategy is right; it is **not** the real check, and the real
one is still outstanding. Also still owed: real Safari with Wi-Fi genuinely off
(a different code path from DevTools offline, and §4.3's hardware limit), and the
`capacitor://` non-registration reasoned above.

**The problem, as originally recorded.** `README.md` said *"the web app works
offline outright."* It did not. There was no service worker anywhere in the repo
(`grep -rn "serviceWorker" index.html js/` returned nothing), so opening the app
with the network off gave the browser's own error page. What was actually true was
the narrower claim the same sentence went on to make: no network round trip is
needed *for recognition*, because Tesseract's worker, wasm core and
`eng.traineddata.gz` are vendored. For a local-first document scanner whose whole
pitch is "no server," that was the gap most worth closing rather than rewording —
and it was closed rather than reworded.

---

### W2 — Cross-browser CI — **DONE, 3 findings, and one prediction that didn't hold**

**What was built.** `test/browser.js` is now the single place that picks an
engine; every gate imports `launchBrowser` from it and honours `BROWSER=`
(default `chromium`, so nothing about the existing signal changed). 15 gates
rewired.

`test/touch-interactions.js` stays **chromium-pinned on purpose** and now says so
in ten lines of comment: it exists because the app once handled `pointerdown` but
not `touchstart`, and Playwright's own mouse/touchscreen APIs synthesize events
that would have passed against that broken code. Its value is entirely that
`cdp.send("Input.dispatchTouchEvent", …)` emits *genuine, trusted* touch at the
protocol level. CDP is Chromium-only; `page.touchscreen.tap()` is exactly the
synthesized input the gate was written to rule out, so swapping to it would keep
the gate green on three engines while destroying the property it pins. On the
other two it skips with a stated reason and exit 0.

**CI structure — per the override, not the original plan.** Per-push stays
chromium-only and unchanged. `webkit` and `firefox` run as a separate
`cross-browser` matrix job on a nightly `schedule` (04:20 UTC) plus
`workflow_dispatch`, gated `if: github.event_name == 'schedule' || …
'workflow_dispatch'` so it never fires on a push or a PR; the per-push job carries
`if: github.event_name != 'schedule'` so the two never double-run. The reasoning
is in the workflow itself: a per-push gate that goes red for reasons nobody can
act on teaches everyone to re-run until green, which costs the per-push signal the
meaning it exists to have.

**Firefox: 12 of 12 green.** No findings at all.

**WebKit: 3 findings.** All three are reported, none is fixed — that was the
instruction, and it matches the W9 precedent.

---

#### X1 — HEIC scans fail, and this is the device checklist's open question answered

`test/heic-input.js` was written as half a case: *"CI has no codec, so this
asserts the failure is graceful; the other half — it must SUCCEED on device,
where WKWebView does have the codec — is in the device checklist."*

**Playwright's WebKit has the codec, so the other half finally ran. It fails.**

```
This browser can decode HEIC: true
outcome=categorized-error
message="Something went wrong while scanning this image. ..."
uncaught page errors: 1  ->  Error: Error attempting to read image.
```

**Root cause, and it is one line.** `js/ocrEngine.js:389` starts recognition with
`runPass(previewImg, …)` — the raw `<img>` element. Tesseract.js, handed an
`HTMLImageElement`, re-reads the bytes behind its `src` in its worker and decodes
them with its own bundled decoders. It has no HEIC decoder, and the error string
comes from `vendor/tesseract/worker.min.js`. The *browser* decoded the file
perfectly — which is why the preview renders correctly and only the scan dies,
with a generic message that points nowhere near the cause.

**Who this hits:** anyone on iOS Safari scanning an unconverted photo straight
from the camera roll, which is the iPhone default format. The native build
dispatches to ML Kit and is unaffected.

**The fix is already in the file.** The *second* pass hands Tesseract a canvas
(`preprocessImage` → `drawToCanvas`). Drawing the first pass through a canvas too
makes the decode the browser's job in every case. Not applied here.

---

#### X2 — WebKit cannot store a Blob in IndexedDB, and it masks half a gate

`test/library-documents.js` dies at line 248 with
`UnknownError: Error preparing Blob/File data to be stored in object store`,
and `test/destructive-actions.js` with the same. Isolated to a 40-line repro on a
real origin, across all three engines:

| | chromium | webkit | firefox |
|---|---|---|---|
| plain `Blob` into IDB | ok | **fails** | ok |
| canvas `toBlob` JPEG into IDB | ok | **fails** | ok |
| same bytes as `ArrayBuffer` | ok | **ok** | ok |
| read the blob back | ok, 1470 bytes | **record present, blob missing** | ok |
| `canvas.toBlob` itself | ok | **ok** | ok |

Two things worth separating out. **`canvas.toBlob` is not the problem** — it works
on all three, so the flakiness this plan and the override both expected there is
not where the risk actually is. And **`ArrayBuffer` round-trips fine on WebKit**,
which is what makes this actionable rather than merely alarming: `js/store.js`'s
`putBlob`/`getBlob` are already the single chokepoint for every image byte in the
app, so storing `{ buffer, type }` and reconstructing the Blob on read would work
identically on all three engines.

**Honest limit on this finding: I cannot tell from here whether real Safari does
this.** Safari has shipped Blob-in-IndexedDB for years, so this is most likely a
limitation of Playwright's WebKit build rather than a bug users hit — but this
harness cannot distinguish "Playwright's WebKit" from "Safari", and that
distinction is exactly §4.3, which needs a real browser on a real machine. Do not
act on this as though it were confirmed; do note that the ArrayBuffer change would
make the question moot.

**Blast radius while it stands:** everything after `library-documents.js:248` —
scan filters, edge detection, annotations, translation history, library UI and
note sanitization — never executes on WebKit. Those were run separately to get
coverage (see below); they are not covered by the nightly job until this is
resolved.

---

#### X3 — Turning on Reduce Motion while the app is open does nothing, on WebKit

`js/radialMenu.js:16` caches the MediaQueryList at module load:

```js
const PREFERS_REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
```

and reads `.matches` later. Measured against the real app, opening a radial menu:

| | preference set **before** load | toggled **after** load |
|---|---|---|
| chromium | `--instant` applied | `--instant` applied |
| firefox | `--instant` applied | `--instant` applied |
| **webkit** | `--instant` applied | **not applied**, while a fresh `matchMedia(...).matches` reads `true` |

So on WebKit the cached list goes stale: a person who turns on Reduce Motion in
System Settings while TextScanner is open keeps getting the bloom animation until
they reload. iOS is both where that preference matters most and where the
WKWebView build runs.

This is the only `matchMedia` call in the app, and the fix is to read
`matchMedia(...).matches` fresh at the point of use (or listen for `change`)
rather than caching the list. Not applied here.

---

#### The prediction that didn't hold, recorded because null results are findings

**`notesEditor.js`'s `execCommand` output is near-identical across all three
engines.** The override expected this to be a problem area. Driven against a
*visible* editor — the first attempt no-op'd on all three because `execCommand`
silently does nothing on a hidden `contenteditable`, which would have reported
"all identical" for entirely the wrong reason:

```
bold/italic/underline/strike/h2/link/removeFormat   identical on all three
insertUnorderedList   chromium & firefox: <ul><li>hello world</li></ul>
                      webkit:             <ul><li>hello world<br></li></ul>
```

One trailing `<br>` inside `<li>`, cosmetic, survives `sanitizeHtml` harmlessly.
And **note sanitization is identical and clean on all three** — all 8 checks,
including `<script>`, event handlers, `javascript:` hrefs and `<iframe>`.

---

**X2 is resolved as a build limitation and skipped with a probe** (see below).
**X1 and X3 are fixed.** What remains red is X4, which is new and real.

---

#### X4 — Edge detection hallucinates a page in pure noise, on every engine but Chromium

Surfaced only because X2's skip let `library-documents.js` run past line 248 on
WebKit for the first time. Measured over 40 uniform-noise frames per engine:

| engine | spurious "page" detected |
|---|---|
| chromium | **0 / 40** |
| webkit | **14 / 40** |
| firefox | **17 / 40** |

**Mechanism.** `js/edgeDetect.js:88-97` downscales to ~240px with
`imageSmoothingQuality = "high"` before looking for edges, and every engine
implements "high" with a different resampling kernel. Chromium's smooths uniform
noise into near-flat grey with nothing to find; WebKit's and Firefox's leave
enough residual structure for the flood fill to percolate into a quad that then
passes the area and aspect checks. So the solidity requirement that fixed this
originally (`ANALYSIS.md` §8.3, bug 3) was tuned against one engine's resampler.

**User impact:** point the camera at a cluttered desk or a textured wall with no
page in frame, and on Safari or Firefox the app confidently crops to nonsense
about 40% of the time — the exact behaviour `README.md` promises against
("it deliberately declines to guess when it cannot find a page").

**The test was also lying about it.** That assertion drew fresh `Math.random()`
noise every run, so on Firefox it passed roughly three runs in five — passing by
luck, which is worse than failing because it hides the defect *and* cannot be
reproduced. It is now seeded (inline mulberry32, four lines, no dependency), so
the result is stable per engine and the number means something.

**Left as a hard failure on purpose.** Unlike X2 this is a real defect, so
nightly *should* be red on it. Fixing it is a threshold change and belongs under
`test/TUNING-2.md`'s merge rule, not a quick tighten — and the honest fix is
probably to stop depending on the engine's resampler at all (a box downscale
written in JS would be identical everywhere), which is a change worth measuring
rather than assuming.

---

### W3 — A gate for the `dom.js` id contract — **DONE**

**The problem.** §0 above. The id set was called the app's public interface in three
documents and enforced by nothing.

**Files.** `test/dom-contract.js` (new); `.github/workflows/ci.yml`.

**What was built.** A text-parsing gate — no browser, no server, no npm install, so
it runs in well under a second and is CI's *first* step rather than its last. Four
assertions: every `getElementById("…")` literal in `js/dom.js` exists as an
`id="…"` in `index.html`; the count equals `EXPECTED_ID_COUNT = 71`; no id is
resolved twice in `dom.js`; no id is declared twice in `index.html` (a duplicate
makes `getElementById` silently take the first, which is its own class of bug).
Failures name the exact `js/dom.js` line, not just the id.

**Proved it gates, both halves:**

```
$ sed -i '' 's/ id="coherence-gate-hint"//' index.html && node test/dom-contract.js
FAILED:
  - js/dom.js:37 resolves id="coherence-gate-hint", which does not exist in index.html
exit=1

$ # (restored) then delete the dom.js line instead:
FAILED:
  - js/dom.js resolves 70 ids, expected 71. An id was removed. If that is intended,
    update EXPECTED_ID_COUNT in this file in the same commit - and the count quoted
    in HANDOFF.md §0 and ANALYSIS.md §8.2 with it.
exit=1
```

Both restorations returned to green with a clean `git diff`.

**Scope, deliberately narrow.** `js/dom.js` only. `index.html` carries 164 ids;
widening this to all of them trades a precise contract for a noisy one. The gate's
header names `add-to-doc-btn` and `save-note-btn` (`js/main.js:1141-1142`) as
honourable mentions — `main.js` queries them directly and treats them like the
contract — without asserting them.

**Risk.** None realized. Adds a gate, touches no app code, touches no ids.

---

### W4 — The `prefers-reduced-motion` invariant broke again — **DONE**

**The problem.** `ANALYSIS.md` §3.7 established this greppable invariant:

```
grep -E '^\s*(transition|animation):' style.css | grep -v 'var(--motion-'
```

It was supposed to return nothing. It returned five lines. One was a genuine
regression: **`style.css:405`, `.radial-menu__item`**, hardcoding
`140ms / 100ms / 120ms / 120ms`, added by the interaction layer in `e181738`.
Behaviour was not broken — `js/radialMenu.js:82` adds `.radial-menu--instant`
under `PREFERS_REDUCED_MOTION.matches` — but reduced motion was working there by a
*second* mechanism, not by the single block, and the grep that was supposed to
prove the whole stylesheet had become noise nobody ran.

**What was built.**

*Tokenized `style.css:405`.* The 140ms travel is now `--motion-bloom`, a new token
zeroed in the same block as the other three. It is its own token rather than
rounded onto `--motion-fast` for a non-aesthetic reason: `js/radialMenu.js:18`'s
`CLOSE_TRANSITION_MS = 140` has to equal it or the menu is removed from the DOM
mid-close. Both sides now name the coupling. `box-shadow` and `background` were
already exactly 120ms = `--motion-fast`. **`opacity` moved 100ms → 120ms** — a
real 20ms change, stated in the CSS comment and here rather than smuggled in; it
still completes well inside the 140ms travel.

*The other three lines, decided explicitly:*

| Line | Verdict |
|---|---|
| `style.css:439` `.radial-menu--instant { transition: none }` | **Legitimate.** No duration exists to tokenize. Kept as belt-and-braces now that `--motion-bloom` also zeroes it — the repo's own preference after the `views.js` double-fix |
| `style.css:1773` `.doc-card.is-swiping { transition: none }` | **Legitimate.** Same category: a swipe must track the finger 1:1 |
| `style.css:2323` `.scan-busy__spinner { animation: scan-spin 700ms … infinite }` | **Must NOT be tokenized.** A zeroed `animation-duration` on an infinite animation *freezes* the spinner rather than calming it — a busy indicator that has stopped reads as a hung app. The reduced-motion block already substitutes a slower pulse. This is the single allowlist entry |
| `style.css:2337` `animation: scan-pulse 1.4s` | **Legitimate.** It is inside the reduced-motion block — it *is* the reduced path |

*Replaced the grep with `test/motion-contract.js`,* CI's second step, before any
browser is installed. **The one-liner could not be the gate**, and finding out why
was most of the work: it cannot distinguish any of the four rows above (row 4
needs block structure, which line matching does not have), and its `^\s*` anchor
is a hole — a rule written on one line, `.thing { transition: opacity 200ms; }`,
never matches it. The script strips comments (style.css's own prose discusses
`transition: none`), tracks brace depth, covers the `-duration` longhands, and
asserts the allowlist entry still matches something so a stale exemption cannot
become a silent hole.

**Proved it gates, six ways.** Seeded regressions, all caught: a single-line
hardcoded rule; the exact `e181738` multi-line partly-tokenized case; a single-line
`animation`; a `transition-duration` longhand; a duration in seconds (`.3s`) rather
than ms; and a renamed spinner leaving the allowlist entry stale. The first and
third are the two the old grep would have missed. Output on a clean tree:

```
Checked 25 transition/animation declarations in style.css:
  21 fully tokenized, 4 exempt, 0 violating.
```

The denominator is reported because a gate that says "checked 4" while the file
has 25 is describing its own blind spot as a result.

**Re-ran `test/interaction-layer.js`:** all 24 checks green, including
*"a radial menu opened under reduced motion carries the instant class"* and
*"selecting a spoke still works under reduced motion, just without the bloom."*

`ANALYSIS.md` §3.7 carries a dated correction saying the invariant broke again and
that its own proposed grep was insufficient — corrected in place, which is that
document's stated standard for its own history.

---

### W5 — Eleven dialog-gated paths, none of them ever run in CI — **DONE**

**The problem.** Playwright auto-dismisses any dialog nothing is listening for,
and no test file had ever installed a `page.on("dialog", …)` handler. So in every
CI run to date `window.confirm(...)` returned **false** and all eleven handlers
took their early-return branch. The suite had been exercising *"the user pressed
Cancel"* eleven times over and reporting it as coverage.
`test/library-documents.js` does test deletion — by importing `/js/documents.js`
and calling `purgeDocument()` directly, which is the model, not the button.

**What was built.** `test/destructive-actions.js`, 46 assertions, driving every
row through its **real UI control** and asserting the store afterwards. Three
assertions per path, not one:

1. **Accept** — the action happens, and the row counts show it.
2. **Dismiss** — it does *not*. This is the branch CI was taking by accident;
   asserting it deliberately is what turns an accident into a contract, and it is
   the half that catches an inverted `if (!confirm(...))`.
3. **The message** — a confirm that quietly stopped asking would still pass an
   accept/dismiss test, so each check pins the text it answered.

| Path | Covered by |
|---|---|
| `library.js:460` create folder (nav) | cancel / accept / whitespace-only name refused |
| `library.js:467` rename folder | cancel / accept, and the prompt offers both options |
| `library.js:467,471` delete folder | cancel / accept, the "N documents moved out" alert, documents kept |
| `library.js:629` create folder (picker) | creates **and** moves the document into it |
| `notesEditor.js:575` insert link | cancel / safe URL / **`javascript:` rejected** |
| `library.js:422` purge from trash | cancel / accept, confirm names the document, blobs go too |
| `library.js:743` empty trash | button appears only when non-empty, cancel / accept |
| `scanDoc.js:337` apply filter to all | cancel / accept, on pages whose filters actually differ |
| `scanDoc.js:367` delete page | cancel / accept, exactly one page, blobs go too |
| `app.js:503` clear history + saved | the *pair*: "Clear history" spares the saved row, this one takes it |
| `app.js:512-513` **delete all local data** | populated store → both confirms → every store at zero |

**Proved it gates, three ways.**

*The plan's first probe* — make `app.js:513`'s second confirm unconditional-true.
The plan predicted "nothing changes", and pre-gate that was right; it is now the
demonstration of the hole that was filled:

```
With the probe applied:
  GREEN (blind)  dom-contract · motion-contract · library-documents
                 document-creation · interaction-layer · unit tests
  RED  (caught)  destructive-actions.js
                 FAIL cancelling the SECOND confirm also deletes nothing
                      -> {"documents":0,"pages":0,...}  the store was wiped on Cancel
```

*The plan's second probe* — delete the handler body: 8 failures, exit 1, naming
every store that should have emptied and did not.

*A third, unasked-for, because two probes of the same handler prove less than two
handlers* — invert `library.js:422`'s purge confirm. Caught by the **dismiss**
assertion: `FAIL cancelling the purge keeps the document in the trash`. Cancel
deleted it.

**One thing found while proving it, and fixed in the gate rather than the app.**
The first two probe runs *crashed* after their first failure instead of reporting:
the cancel half failing means the accept half's target is already gone, so the
next `page.click()` threw 30s later and took the remaining forty assertions with
it. A `clickChecked()` helper and a `gotoSettings()` guard now turn that into a
named failure. One real bug must not cost the rest of the file.

---

#### F4 — `"All local data deleted."` was not true — **FIXED**

`clearAll()` reached IndexedDB and nothing else, so after pressing **Delete all
local data** and being told **"All local data deleted."**, a saved Anthropic API
key was still sitting in `localStorage`, readable by the next person to open that
browser profile — and on the shared `github.io` origin, readable by any other site
on that origin too (§4.1). Measured with a canary before the fix:

```
localStorage before: ["textscanner.anthropicApiKey"]
localStorage after:  ["textscanner.anthropicApiKey"]
API KEY SURVIVES: YES -> sk-ant-canary-value
```

**The fix is a layering change, not a line.** `js/store.js` now owns the *names*
of every `localStorage` key the app persists — the API key, the theme choice and
the command palette's usage counts — because a module cannot honestly promise to
delete "all local data" from a position where it does not know what "all" is. The
three owning modules (`coherenceClaude.js`, `theme.js`, `commandPalette.js`) import
those names from there, so there is one definition and it cannot drift from what
gets cleared. `clearAll()` clears them before the IndexedDB transaction,
deliberately: the synchronous part cannot fail in a way worth aborting over, so an
interrupted wipe leaves documents behind rather than a secret.

All three are cleared, not just the key. The theme and the usage counts are not
secrets, but the alert says **ALL**, and a half-true version of that sentence is
what this whole finding was about. The cost is re-picking light/dark after an
action that was double-confirmed as "delete everything".

The gate's tripwire is **inverted from what it pinned before**: it now asserts the
key is GONE, that the other two are gone, and that no `textscanner.*` key survives
at all. Proved it gates — removing `clearAll()`'s localStorage pass turns all four
assertions red, naming each surviving key.

No copy change was needed in the end: `index.html`'s hint and `js/app.js`'s alert
are both true now that the code does what they say.

---

### W6 — Replace the native dialogs with in-app UI *(product polish — real, but optional)*

**The problem.** Same 19 call sites. `window.prompt` is how you name a folder,
rename a folder and insert a link. It is unstyled, it ignores the app's theme and
safe areas, it blocks the main thread, and it looks like 2004 next to a radial menu
and a command palette. This is a quality gap, not a correctness one.

**Files.** `index.html` (a dialog/prompt component next to the existing
`#folder-picker` at line 173 and `#shortcut-sheet`), `style.css`, `js/library.js`,
`js/notesEditor.js`, `js/scanDoc.js`, `js/app.js`, `js/toast.js`.

**Definition of done.** No `window.alert|confirm|prompt` remains in `js/` (one
grep proves it), every replaced flow is keyboard-operable with Tab/Enter/Escape and
returns focus to its trigger, and W5's gate still passes after being rewritten
against the new controls.

**Risk.** **This is the highest-risk item on the list for the id contract.** It adds
ids to `index.html` and rewires handlers in four modules that `pdf-export.js`,
`library-documents.js` and `document-creation.js` drive. Do W3 and W5 first: W3 turns an accidental id rename into a red build, and
W5 gives you a test of the old behaviour to port. The existing `#folder-picker`
markup is the pattern to copy — it already exists and already works.

---

### W7 — No web app manifest, so the app cannot be installed — **DONE**

**What was built, verified against the tree rather than carried forward.**
`manifest.webmanifest` (name, short_name, description, `start_url`/`scope` both
`./` so the project-path deployment resolves, `display: standalone`, three icon
entries) plus `icons/` holding all four PNGs — checked to be real PNGs at their
declared sizes by reading their IHDR chunks: `icon-192.png` 192x192,
`icon-512.png` 512x512, `icon-maskable-512.png` 512x512 (`purpose: maskable`),
and `apple-touch-icon.png` 180x180. Wired up at `index.html:92`
(`<link rel="manifest">`) and `index.html:95` (`<link rel="apple-touch-icon">`),
with the `apple-mobile-web-app-*` meta tags beside them for the pre-16.4
home-screen path. The paragraph below describing the gap is the ORIGINAL finding,
kept as the record; its `grep` no longer returns nothing.

**The problem, as originally recorded.** `grep -rn "manifest\|apple-touch-icon" index.html` returns nothing.
There is a lovely inline SVG favicon (`index.html:62`) and nothing else. Consequences,
in order of how much they matter:

1. **It feeds W8.** Browsers grant `navigator.storage.persist()` far more readily to
   installed apps. `js/app.js:305` calls `requestPersistence()` (`js/store.js:317`) on every launch and, on a
   plain Safari tab, is simply told no.
2. On iOS, "Add to Home Screen" produces a screenshot icon and a browser-chrome
   launch instead of a standalone app.
3. On Android/desktop Chrome there is no install affordance at all.

**Files.** New `manifest.webmanifest`; new PNG icons (192, 512, and a 180 maskable
`apple-touch-icon.png`) — derivable from the existing SVG mark, same viewfinder +
cursor design as `ios/App/App/Assets.xcassets/AppIcon.appiconset`; `index.html`
`<head>`.

**Definition of done.** Chrome DevTools → Application → Manifest reports no errors
and offers Install; installing gives a standalone window with the right icon; iOS
Safari → Share → Add to Home Screen shows the real mark, and launching from the
home screen opens without browser chrome. Then re-check Application → Storage:
"persistent" should now be achievable where it was not.

**Risk.** None to gates or ids. CSP needs no change — `default-src 'self'` covers
`manifest-src` and the icons are same-origin. Do not set `"display": "fullscreen"`;
`"standalone"` is what you want given the app bar already handles its own chrome.

---

### W8 — Storage durability: a local-first app whose storage the browser may delete — **DONE**

**What was built, verified against the tree rather than carried forward.**
Persistence is requested at launch, fire-and-forget, from `js/app.js:363`
(`requestPersistence()` in `js/store.js:409`, which returns early if the browser
has already granted it) — so the claim in `index.html:87` that the app asks on
every launch is accurate. Settings carries `#settings-persist` ("Keep storage
permanently", `index.html:798`) and a three-part status line rather than a
boolean: `#settings-persist-status` (:799), `#settings-persist-state` (:804) and
`#settings-persist-explain` (:805), which distinguish "granted", "not granted"
and "this browser won't say" in plain language. Backup is
`#settings-backup-export` ("Back up everything", :816) and
`#settings-backup-import` ("Restore from a backup", :817). `test/backup-roundtrip.js`
is gate 32 and passes, including its API-key canary — which is a genuine negative
assertion searched in the RAW serialized bytes (`!exported.text.includes(CANARY_KEY)`),
not inferred from intent, plus a companion check that the export copied the key
rather than clearing it. The paragraph below is the ORIGINAL finding, kept as the
record.

**The problem, as originally recorded.** This is the one I would rank as the biggest *product* risk in the
web build, and it is not on any existing list. The app's premise is "everything is
local, there is no server." On the web that means:

- **Safari deletes it.** ITP purges all script-writable storage — IndexedDB
  included — after **7 days** without user interaction with the site, for
  non-installed sites. A scan taken today can be gone next week with no warning and
  no recovery. `requestPersistence()` is already called and is the right call, but
  Safari effectively grants it only to home-screen-installed apps (hence W7).
- **There is no backup.** `grep` for a library-wide export finds nothing. You can
  export one document as PDF/JPG/TXT (`js/scanDoc.js:479-508`); you cannot export
  the library. With no sync and no account, a wiped origin is total loss.
- **The app never says so.** Settings → Storage shows usage and a "delete
  everything" button, and nothing about eviction.

**Files.** `js/store.js` (surface the result of `persisted()`, not just request it),
`js/app.js` (Settings → Storage group, around line 487), `index.html:629-678`,
`js/documents.js` + `js/store.js` (a library export/import), `README.md`.

**Definition of done.** Three separable pieces, each independently checkable:
1. Settings → Storage states whether storage is persistent on *this* browser, in
   plain language, and says what happens if it is not. Verify: Chrome reports
   persistent after install; a fresh Safari tab reports not, and says why.
2. A "Back up everything" action produces one file containing every document, page
   blob and folder, and an import restores it into an empty profile with page
   images and OCR text intact. Verify: back up, Settings → Delete all local data,
   import, confirm the library and a full-text search for a word inside a scanned
   page both come back.
3. `README.md` says what persistence actually guarantees per browser.

**Risk.** Medium. It touches `js/store.js`, which `pdf-export.js` leans on hardest, and it
adds Settings ids (mitigated by W3). The export format is the decision worth making
deliberately — a single JSON with base64 page images is simplest and roughly
inflates blobs by a third; a zip needs a vendored library, which this repo has
consistently and correctly refused. Note this work has an iOS payoff too:
`HANDOFF.md` §5.0 lists IndexedDB quota under iOS eviction as an open device-pass
question, and a backup path is the honest answer to it.

---

### W9 — Run the 17 web checks in `TEXTSCANNER-HARDENING-PLAN.md` §1 — **DONE, 3 findings**

**Method.** All 17 driven against `http://localhost:8199` serving the repo, through
a real headless Chromium (`playwright-core`), at a 430×900 touch viewport with
real touch-typed `PointerEvent`s — plus a 1280×900 pass where width mattered.
Screenshots captured and looked at for the checks that are visual judgements
rather than assertions. The harness was a throwaway; it is **not** committed, since
these are manual checks and turning them into a gate was not the task.

**Result: 64 assertions pass, 3 fail, 2 deferred. Zero uncaught page errors.**
Checks 1, 2, 3, 4, 8, 9, 10, 11, 12, 14, 15, 16 and 17 pass outright — including
every eager-document-creation repro, the whole interaction layer's create menu,
card long-press/swipe/right-click, the folder picker, the command palette from
three views, and both `[`/`]` mode steps.

Findings below are **reported, not fixed**, as asked. None is a crash; all three
are judgement calls that belong to you.

---

#### F1 — Check 5: the guided buttons are the *smallest* text on the result panel

The check expects *"'Clean up this text' / 'View on photo →' prominently, with the
original Raw/Filtered/Text/Image controls still present underneath, just smaller."*
Measured, identically at 430px and 1280px:

| Control | Size | Font |
|---|---|---|
| Text / Image format / Full image | 26px tall | **13.6px** |
| Filter: Raw / Filtered / Coherence | 25px tall | **12.8px** |
| **Clean up this text** | **20px** tall | **12px** |
| **View on photo →** | **22px** tall | **12px** |

So the literal expectation is inverted twice over: the guided buttons are the
smallest type in the panel, and the mode control sits **above** them, not
underneath.

**Looking at it rather than only measuring it, the intent is partly carried
anyway:** "Clean up this text" is the only *filled accent-coloured* button in the
panel, and colour is doing the prominence work that size and position are not.
That is a legitimate strategy, which is why this is a finding and not a bug.

**The decision is yours** and it is one of two: resize/reorder so the guided pair
actually leads, or amend the check to describe what shipped. What should not
happen is leaving a check that anyone walking the list will mark failed.

**Should a gate have caught it?** No, and it should not try. "Prominent" is a
visual judgement; pinning font sizes in CI would gate styling, not behaviour.

> **Correction, 2026-09-13.** The sentence that used to sit here — "`test/
> document-creation.js` asserts the buttons exist and drive the right filter/
> mode, which is the testable part" — was **false when written**. That file
> never touched either guided button, and neither did anything else in CI: a
> grep for `view-on-photo` across `test/` returned only `dom-contract.js`, which
> counts the id and never presses it.
>
> It cost something. **"View on photo →" called `modeImageBtn.click()`** — Image
> format, the view that lays the words out on a *blank canvas*, with no photo
> and (because `setMode` only shows `#editor-toolbar` in `full`) no "Move
> components" button. The app's own guided route to the photo editor landed in
> the one view where nothing on the image can be moved, and it reached a device
> that way. `test/move-inpaint.js` stayed green throughout because it, like
> every other browser gate, clicks `#mode-full-btn` directly.
>
> Fixed, and now actually gated by **`test/guided-path.js`**, which presses the
> guided button and asserts the observable result — the photo is showing and
> "Move components" is reachable — at both sides of the 600px breakpoint. The
> lesson is narrower than "write more tests": a claim that a gate covers
> something is worth exactly as much as a grep, and this one was never grepped.

---

#### F2 — Check 13: the theme radial menu does not exist on any phone

`style.css`'s `@media (max-width: 600px)` block sets `.app-bar__actions #theme-btn
{ display: none }`, with a comment explaining the trade honestly: the bar cannot
hold four controls and a title, and Theme is the one that drops.

That is a reasonable call for the *button*. Its consequence for the **radial
picker** is the finding: `06-INTERACTION-MODEL-SPEC.md` names the theme button as
**call site 3**, and its rollout order puts it *first* — "smallest surface area,
cheapest to verify the primitive works before depending on it elsewhere." Measured:

| Context | Theme button visible | Long-press opens the radial |
|---|---|---|
| 1280px, mouse | yes | **yes** |
| 1280px, touch | yes | **yes** |
| 430px, touch | **no** | **no** |

So a press-drag-release gesture designed for a thumb is available on desktop and
absent on every phone. Not broken — but the call site is doing none of the work it
was added for, and check 13 cannot be performed as written on a phone at all. (The
check also says the button is "bottom-right of the nav bar area"; it is in the top
app bar.)

**Should a gate have caught it?** **Yes.** See F3.

---

#### F3 — The two radial call sites disagreed about the mouse — **FIXED**

`js/app.js:374` gates `#nav-add`'s radial on `pointerType` touch/pen, with a
stated reason: a mouse's click is not suppressed by `pointerdown`'s
`preventDefault` the way touch's is, so every mouse press would have opened the
radial *and* fired the plain click afterwards. `js/main.js`'s theme handler
applied no such filter, so a 420ms mouse press-and-hold opened a radial there.
One primitive, two answers to "is this gesture for a mouse?", and a desktop user
who happened to hold the button got a gesture menu they did not ask for and could
not discover.

Call site 3 now carries the identical guard. The plain click still cycles the
theme for everyone.

#### F2 — The theme radial does not exist on any phone — **YOUR DECISION, not auto-fixed**

`style.css`'s `@media (max-width: 600px)` sets
`.app-bar__actions #theme-btn { display: none }`, with an honest comment: the bar
cannot hold four controls and a title, and Theme is the one that drops.

That is defensible for the *button*. Its consequence for the **gesture** is the
open question: `06-INTERACTION-MODEL-SPEC.md` names the theme button as call
site 3 and its rollout order puts it **first**, as "the smallest surface area,
cheapest to verify the primitive works before depending on it elsewhere". A
press-drag-release gesture designed for a thumb is now reachable only on screens
that mostly do not have one.

**The two ways out, and it is genuinely a spec-vs-implementation call:**

1. **Accept it** — the theme radial is a desktop/tablet affordance, the spec's
   rollout order was about build sequence rather than shipped reach, and phones
   get theme switching through Settings. Costs nothing; means call site 3 does
   none of the work it was added for.
2. **Show `#theme-btn` on phones** — which needs somewhere for it to go, since
   the comment above is correct that four controls and a title do not fit.
   Moving it into Settings-as-a-row, or into the "+" sheet, are both real
   options and both change the nav design.

`test/radial-call-sites.js` **pins the current behaviour rather than demanding
either**: it asserts `#theme-btn` is hidden below the breakpoint and prints the
decision alongside. If it ever becomes visible on a phone the gate fails and
names this section, so the choice gets made deliberately instead of drifting.

#### The gate that closes both — **BUILT**

`test/radial-call-sites.js`, in both CI jobs. Drives all three call sites at
430px and 1280px — the two sides of the 600px breakpoint `interaction-layer.js`
had never seen, because it sets no viewport and runs at Playwright's 1280x720
default. Green on chromium, webkit and firefox.

Proved it gates: reverting the one-line `pointerType` guard in `js/main.js` turns
it red on exactly the right assertion — *"a 420ms mouse hold opened a radial menu
- call site 3 is not gating pointerType the way call site 1 does"*.

#### Deferred, with reasons

- **Check 6, second half.** The Coherence router *was* verified: it distinguishes a
  receipt and a business card from prose. Whether the **output reads** as an
  itemized list or contact fields needs a real Anthropic call on a real receipt
  photo — no key was used here, and CI mocks the endpoint.
- **Checks 10, 12, 13 — how the gesture feels.** Synthetic `PointerEvent`s prove the
  state machine fires; they cannot tell you whether a press-drag-release reads
  naturally under a thumb. `TEXTSCANNER-HARDENING-PLAN.md` §5.1 already has this
  as a device-pass item and is right that CI cannot settle it.

#### One thing that looked like a failure and is not

Pressing `?` on the **Library** does not open the shortcut sheet — it types a `?`
into the search box. That is correct: the Library auto-focuses its search input on
arrival, so `?` there is inside a text field and the `inTextField` guard fires by
design (`test/interaction-layer.js` goes to Settings first for exactly this reason,
with a comment saying so). Check 15 says "outside a text field" without noting that
the default view puts you inside one — **worth a parenthesis in the check**, because
anyone walking the list literally will land on the Library first and record a
failure.

---

### W10 — Documentation accuracy pass — **DONE**

**The problem.** Three concrete errors, found while mapping; a fourth surfaced
while fixing them.

**1. `README.md` documented `js/editor.js`, which does not exist** and has not
since the editor split into `editorObjects.js` / `editorInteractions.js` /
`editorExport.js`. The Project structure block listed 12 modules out of 44 and
omitted the entire document layer — no `store.js`, `documents.js`, `library.js`,
`notesEditor.js`, `scanDoc.js`, `pdf.js`, `views.js`, `app.js`, `radialMenu.js`,
`commandPalette.js`. Its `js/coherence.js` description was stale too: that module
is the tier dispatcher now; the key storage and Claude call it described live in
`coherenceClaude.js`.

Rewritten as all 44 modules grouped by what they own. **Every path in the block
was then verified to resolve — 55 of 55**, by extracting them from the rendered
block and stat-ing each one, not by reading.

**2. The "68 ids" count**, in `ANALYSIS.md` §8.2 and `HANDOFF.md` §0. Both were
correct at `ca341d7` and both are corrected in place with the current number
(71) and what moved it, rather than silently overwritten — these are historical
documents and that is their stated standard. The more useful half of each
correction is the *reason* the drift went unnoticed: the contract was enforced by
nothing until W3.

**3. The offline claim.** `README.md` said the web app "works offline outright."
It does not — there is no service worker, so opening the app with no connection
gives the browser's error page. Reworded to the claim that is true and is
actually the stronger one for this project: **recognition needs no network at
all, ever, not even the first time**, because nothing is fetched from a third
party at scan time — followed by an explicit statement that the page itself is
still loaded over the network and that offline *launch* does not work yet.

`vendor/tesseract/README.md` carried the same overreach ("making the offline
claim true") and is corrected the same way: vendoring makes the **scan**
offline-capable, not the **app**.

**This closes the claim, not the gap.** W1 above — build the service worker — is
still open, and rewording does not advance it. What it does is stop the README
promising something the app cannot do while W1 waits.

**4. Found while fixing the above: `HANDOFF.md`'s "CI: 6 test gates → 12"** was
stale before this work (`8d37a35` and `e181738` made it 14) and would have been
made staler by it. Corrected to 16, with what each addition was.

**Verify it yourself.** Every path in README's structure block resolves:

```
grep -oE '(js|test|docs|vendor)/[A-Za-z0-9_./-]*' README.md | sort -u | while read p; do
  [ -e "$p" ] || echo "MISSING $p"; done
```

`grep -rn "works offline outright" .` returns nothing, and `grep -c getElementById
js/dom.js` agrees with every count quoted in prose — which `test/dom-contract.js`
now enforces rather than leaving to the next person to notice.

---

### W11 — Link previews, and a 404

**The problem.** No `og:` or `twitter:` meta, so sharing the URL anywhere renders a
bare link. `custom_404: false`, so a mistyped path gets GitHub's generic page. The
404 matters less than it looks: routing is hash-based (`js/views.js:160`
`buildHash`), so every deep link is `…/#document/<id>` and resolves against
`index.html` — there is no SPA-rewrite problem to solve.

**Files.** `index.html` `<head>`; new `og-image.png` (1200×630); new `404.html`.

**Definition of done.** Paste the URL into iMessage/Slack/a tweet composer and get
a card with title, description and image. `…/TextScanner/nope` renders your page,
not GitHub's.

**Risk.** None. No ids, no gates.

---

### W12 — No version anywhere

**The problem.** Settings → About (`index.html:679-688`) shows the engine name and
a source link, no version. `js/diagnostics.js:26-45` builds a report with
timestamp, engine, platform, `lastScanError` and user agent — and **no app
version**, which makes any report someone sends you unattributable to a build.

**Files.** `js/state.js` (a `VERSION` constant next to `MAX_FILE_BYTES`),
`index.html:679-688`, `js/diagnostics.js:26`.

**Definition of done.** Settings → About shows a version and the short commit sha;
an exported diagnostic JSON contains the same. One id added, so W3 first.

**Risk.** Low. One new id.

---

### W13 — Web recognition is English-only, and that is a *web* limitation with a *web* fix

**Worth separating from the ML Kit story, because the documents conflate them.**
`test/non-latin-limitation.js`'s own header gets this right and it is the only
place that does: the native gap is `script: "LATIN"` in ML Kit, which needs the
Vision migration. **The web gap is simply that `js/ocrEngine.js:368` calls
`createWorker("eng", 1, …)` and only `eng.traineddata.gz` is vendored.** Tesseract
supports 100+ languages. Adding Spanish, French, German or a CJK model to the web
build is vendoring files and a language picker — no migration, no blocker.

**Files.** `vendor/tesseract/tessdata/` (new `.traineddata.gz` per language),
`vendor/tesseract/README.md`, `js/ocrEngine.js:66-75` and `:368`, a picker in
`index.html` + `js/main.js`, `test/non-latin-limitation.js`.

**Definition of done.** Pick a language, scan `test/images/non-latin/` sample in
that script, get real text. `test/non-latin-limitation.js` is updated so the
tripwire fires for the scripts still unsupported and *asserts success* for the ones
now shipped — otherwise the gate that exists to catch "it started working" fails
the moment you make it work.

**Risk.** Medium, mostly on size and on `render-fidelity.js`. `eng` alone is 2.9 MB;
`chi_sim` is larger. GitHub Pages' published-site soft limit is 1 GB so there is
headroom, but each language is a real first-scan download for every user. A
language picker adds ids (W3 first). **Scope decision, not a defect** — I am
listing it because the docs currently read as though non-Latin is blocked on the
Vision migration, and on the web it is not.

---

## 2. Risk summary

| Task | Touches the 72 ids | Can turn CI red | Effort |
|---|---|---|---|
| ~~W1 offline / service worker~~ **done, live redeploy check still owed** | No | Gate 33 `offline.js`; the SW does not intercept the other gates, and that is now asserted rather than hoped | M |
| ~~W2 cross-browser CI~~ **done** | No | Nightly red on WebKit: X1, X2, X3 | M–L |
| ~~W3 dom-id gate~~ **done** | No (protects them) | New gate only | S |
| ~~W4 motion invariant~~ **done** | No | New gate only | S |
| ~~W5 dialog-path coverage~~ **done** | No | Found F4 (copy, not a broken path) | S–M |
| W6 replace native dialogs | **Yes** | Gates 12, 13, 14 | L |
| ~~W7 web app manifest~~ **done** | No | No | S |
| ~~W8 storage durability + backup~~ **done** | Adds Settings ids | Gate 12 | L |
| ~~W9 run the 17 checks~~ **done** | No | Found 3 (F1-F3), none fixed | S |
| ~~W10 doc accuracy~~ **done** | No | No | S |
| W11 og: + 404 | No | No | S |
| W12 version stamp | One new id | No | S |
| W13 more languages | Adds picker ids | Gate 8 | M |

---

## 3. Suggested order

**~~First, because they are cheap and they protect everything after them:~~
~~W3 (id gate) → W4 (motion gate) → W10 (docs) → W9 (run the 17 checks).~~ Done.**
W9 left three findings (F1-F3) that are unassigned; **F3 is the one to pick up**,
since a gate covering the interaction spec's call site 3 at a phone width would
have caught two of the three by itself.

**~~Then the two that decide what "shippable web app" even means:~~**
~~W2 (cross-browser — do this before building anything new, so you are not
debugging new code and a WebKit divergence at once) → W1 (offline).~~ Both done.
W1's one outstanding piece is a live redeploy check that needs a push to `main`,
not more engineering.

**Then the product gaps, in dependency order:**
~~W7 (manifest)~~ → ~~W8 (storage durability, which depends on W7 for persistence)~~ →
~~W5 (cover the dialog paths)~~ all done → W6 (replace them, now that a test of the old behaviour exists to port).

**Last, optional:** W11, W12, W13.

~~If you only do four: **W3, W2, W1, W8.**~~ All four are done — respectively the
invariant you asked about, the browsers you had never tested, the claim you were
making that wasn't true, and the data your users could lose. What is left in §1 is
W6 (replace the native dialogs), W11, W12 and W13.

---

## 4. Not solvable by you

*"You" here means me.* Each of these is a real blocker on the web version and none
of it closes with code in this repo. Stop expecting them from me.

### 4.1 The API key on a shared origin — needs a registrar and money

Every other site on `*.github.io` shares this origin, so any of them can read the
Anthropic key `js/coherenceClaude.js:117` puts in `localStorage`. This is a
property of the hosting origin, not of the code, and **only a custom domain closes
it.** `docs/CUSTOM-DOMAIN-MIGRATION.md` has the DNS records, the `CNAME` content,
the replacement copy and the key-re-entry notice already written. It needs you to
buy or point a domain and log into a registrar.

Already confirmed today so you do not have to re-check it: `gh api …/pages` shows
`"cname": null`, and no hardcoded `github.io` URL exists in `js/` or `index.html`,
so the app needs no code change to move.

**And the copy must not change before the move.** The current caveat is true right
now; pre-applying the replacement would tell users their key is safer than it is.

### 4.2 A no-key AI tier on the web — needs a Cloudflare account and your money

Coherence Filter and translate-in-place require a BYOK Anthropic key on every web
browser, because there is no on-device model in a browser — Apple's Foundation
Models tier exists only in the native build. Making it keyless means a relay
holding *your* API key and *your* bill. `TEXTSCANNER-HARDENING-PLAN.md` §4.3 has the
design. Two things there do not apply to the web: Apple IAP is iOS-only, so there
is no entitlement to validate a web caller against, and without one you are funding
an unauthenticated public endpoint. I can write the Worker; I cannot open the
account, hold the secret, or decide to pay for strangers' requests. **On the web
this is not "deferred," it is unsolved** — the plan's own answer is "leave the web
build BYOK-only."

### 4.3 Real Safari, as opposed to Playwright WebKit — needs your machines

W2 gets you Playwright's WebKit build, which is a real and large improvement over
nothing. It is **not** Safari: it does not carry Apple's ITP storage policy (the
thing W8 exists because of), its PWA install behaviour, its home-screen storage
grants, or iOS Safari's canvas memory ceiling. Confirming those needs you opening
the live URL in Safari on a Mac and on an iPhone. Small, but nothing in CI
substitutes for it.


**The manual checklist, as of 2026-09-15.** Three things the nightly job
explicitly cannot settle, all needing nothing more than Safari (or, for #3,
an iPhone) and a few minutes:

1. **Store a scanned page and reopen it, then restore a backup.** Scan or add any image as a document
   page in Safari, close the tab, reopen the app, and confirm the page image is
   still there. This is the one assertion the nightly *skips* on WebKit —
   `test/browser.js` documents why that skip is a Playwright build limitation
   (`structuredClone(new Blob())` and `postMessage(new Blob())` both work in that
   build, `ArrayBuffer` into IndexedDB works, and the transaction aborts with a
   **null** `tx.error` rather than a named `DOMException`, which is an unwired
   backend rather than a spec-defined rejection). Safari has shipped
   Blob-in-IndexedDB since Safari 10, so this is expected to pass — but "expected"
   is not "checked", and if it fails, `js/store.js`'s `putBlob`/`getBlob` are a
   single chokepoint that could store `{ buffer, type }` instead.
   **`test/backup-roundtrip.js` skips entirely on WebKit for this reason**, so
   the whole backup/restore path — the one thing standing between a Safari user
   and total loss — is unverified on the engine Safari users actually run. Doing
   this by hand is: Settings → **Back up everything**, then **Delete all local
   data**, then **Restore from a backup**, and confirm the library and a search
   for a word inside a scanned page both come back.
2. **Point the camera at a textured surface with no page in frame** and confirm
   the app declines to crop rather than guessing. See X4 below — this one is
   *expected to fail*, and confirming it on real Safari is what turns a
   Playwright measurement into a user-facing bug report.
3. **The UI-REDESIGN-PLAN.md §2.3 gesture pass, still outstanding since the
   redesign merged to `main` on 2026-09-15.** `test/touch-interactions.js`
   drives the tap-select/move-handle/resize-handle/marquee mechanics with
   real CDP touch events, but that is Chromium's touch pipeline — it has
   never run against WKWebView's, which is what both mobile Safari and the
   iOS app actually use. On a real iPhone, confirm: a quick tap still edits
   a word with no perceptible delay (not a beat late, the way a naive
   long-press/tap disambiguation would feel), and a full press-hold-drag-
   release completes reliably across several trials on both move-handle and
   empty canvas (for marquee). No physical device was reachable when the
   redesign was built or merged (`xcrun devicectl` showed the paired device
   as `unavailable` throughout both sessions) — this is not a hedge, it is
   the one check that was never actually possible to run. If it contradicts
   what shipped, UI-REDESIGN-PLAN.md §2.3's own fallback (keep a toggle-
   button alternative, ship only the parts that check out, or neither) is
   still live.

### 4.4 Recognition accuracy — needs 14 photographs only you can take

Unchanged from `HANDOFF.md` §5.2 and the hardening plan §2, and it gates the web
build exactly as much as the native one: the current baseline is 11 images, three
with deliberately partial transcriptions, and the threshold sweep stays unrun
because re-tuning against the images that produced the thresholds is circular. A
synthesized image has no sensor noise, motion blur, rolling-shutter skew or lens
geometry, so generating them would measure the generator. **If you ask me to
improve OCR quality on the web, the honest answer is that I cannot measure whether
I did.**

### 4.5 Legal and identity — needs a lawyer or your decision, not an engineer

- **The licence.** `README.md:148` says no licence, all rights reserved, while the
  entire source is publicly served from the app's own origin (Jekyll even renders
  `docs/*.md` to HTML — `https://…/docs/PRIVACY-DECISIONS.html` returns 200). That
  combination is a choice you should make on purpose. Note the vendored Tesseract.js
  is Apache-2.0 and its LICENSE files are already committed.
- **A user-facing privacy policy.** `docs/PRIVACY-DECISIONS.md` is an excellent
  engineering document and is not a privacy policy, is not linked from the app, and
  I should not be the one drafting the legal instrument. The app sends user text to
  a third party (`api.anthropic.com`) on an opt-in path, which is the part a policy
  has to address.
- **The rename to "Inplace."** Hardening plan §4.2. Two informal searches are not a
  trademark clearance.

### 4.6 What I could do but shouldn't decide alone

Not blocked — just yours to choose, and I will not pick for you: whether W1 builds
a service worker or reworders the claim; W8's backup format; whether W6 is worth
its risk; which languages W13 ships, given each is a multi-megabyte download for
every user.

---

## 5. Deliberately out of scope

Listed so their absence is not mistaken for an oversight:

- **Everything iOS.** The device pass, ML Kit, the Vision migration, StoreKit, App
  Store submission, screenshots, the archive/validate step.
- **The `www/` and `ios/App/App/public/` sync gate.** `HANDOFF.md` §5.5 and
  `ANALYSIS.md` §1.2 both call it a cheap ungated hazard, and they are right — but
  it is a *native build* hazard. `www/` is gitignored, regenerated by
  `scripts/sync-web-assets.sh`, and no part of the Pages deployment reads it. It is
  currently stale (`www/index.html` is 38 KB against the root's 46 KB) and that
  costs the web build nothing.
- **Bundling or a build step.** §0: 46 modules over HTTP/2 with gzip is fine, and
  the zero-build property is load-bearing for the CSP, for reviewability and for
  every gate that does `import("/js/dom.js")` against the live source.
- **Adding a `.nojekyll`.** Verified unnecessary — every vendored asset serves 200.
- **The benchmark baseline file.** `test/baseline-2026-08-28.json` stays valid
  exactly as long as the corpus does not change, which is §4.4's problem.
