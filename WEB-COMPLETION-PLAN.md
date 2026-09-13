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

Checked today rather than carried forward from `HANDOFF.md`:

| Fact | How it was checked |
|---|---|
| Live, HTTPS enforced, built from `main` at `/` by **legacy Jekyll**, no CNAME, `custom_404: false` | `gh api repos/PrashaantM/TextScanner/pages` |
| Every runtime asset resolves on the live origin | `curl` for `/`, `/js/main.js`, `/js/radialMenu.js`, `/style.css`, `/vendor/tesseract/tesseract.min.js`, `/vendor/tesseract/worker.min.js`, `/vendor/tesseract/tessdata/eng.traineddata.gz`, `/vendor/tesseract/core/tesseract-core-{simd-,}lstm.wasm.js` — all 200 |
| Served over HTTP/2, gzipped, `cache-control: max-age=600` | `curl -I` on `/js/main.js`: 47 KB → 15.6 KB on the wire |
| 60 unit tests pass | `node --test test/unit/*.test.js` — 60 pass, 0 fail |
| The newest browser gate passes | `node test/interaction-layer.js` — all 24 checks green |
| Last CI run on `main` green | run `34673998815`, 3m30s |
| 44 modules, 12,739 lines in `js/` | `wc -l js/*.js` |
| Tracked repo 8.87 MiB; `vendor/tesseract` is 11 MB of it on disk | `git count-objects -vH`, `du` |

**Jekyll is not eating anything.** Its default excludes cover `vendor/bundle`,
`vendor/cache`, `vendor/gems`, `vendor/ruby` — not `vendor/tesseract`. Confirmed
empirically by the 200s above, so no `.nojekyll` is needed.

**44 unbundled ES modules over HTTP/2 is not a load problem.** 584 KB raw across
`js/`, gzipped per-file, multiplexed on one connection. Don't add a bundler; the
no-build-step property is worth more than the milliseconds.

### The "68 DOM ids" number is stale — it is **71**

`js/dom.js` resolves 71 ids today, and all 71 exist in `index.html` (verified by
looping every `getElementById("…")` literal against the markup — zero missing).

| Commit | ids in `dom.js` | What moved |
|---|---|---|
| `4ae7cfd`, `ca341d7` | 68 | the number every doc still quotes |
| `8d37a35` | 70 | `clean-up-text-btn`, `view-on-photo-btn` |
| `e181738` | 71 | `coherence-gate-hint` |

Treat **71** as the invariant from here on. `index.html` carries 147 ids in total;
the other 76 are resolved locally by `app.js`, `library.js`, `scanDoc.js` etc. and
are *not* the protected contract — though `add-to-doc-btn` and `save-note-btn`
(queried directly in `js/main.js:1141-1142`) behave like it in practice.

### The 15 CI gates, and which ones a change can actually break

`.github/workflows/ci.yml` runs gate 1 immediately (it needs nothing), then
`npm ci` + `playwright-core install chromium`, then the rest:

| # | Gate | Drives the app through element ids? |
|---|---|---|
| 1 | `dom-contract.js` — **added by W3** | It *is* the id contract |
| 2 | `node --test test/unit/*.test.js` (60) | No — pure functions |
| 3 | `run-benchmark.js --check-regression --baseline test/baseline-2026-08-28.json --tolerance 2.0` | Yes, the scan flow |
| 4 | `touch-interactions.js` | Yes — **and CDP-only, see W2** |
| 5 | `malformed-input.js` | Yes |
| 6 | `exif-orientation.js` | Yes |
| 7 | `move-inpaint.js` | Yes |
| 8 | `render-fidelity.js` | Yes, plus `import("/js/dom.js")` directly |
| 9 | `non-latin-limitation.js` | Yes |
| 10 | `heic-input.js` | Yes |
| 11 | `web-tier-smoke.js` | Yes, plus `import("/js/dom.js")` |
| 12 | `pdf-export.js` | Partly; `qlmanage` leg is macOS-only and skipped on CI |
| 13 | `library-documents.js` | **Mostly no** — imports `/js/documents.js` and drives the model |
| 14 | `document-creation.js` | Yes, through the real nav/action sheet |
| 15 | `interaction-layer.js` | Yes |

**Until W3 landed, nothing in that table asserted that the 71 ids resolve.**
`getElementById` returns `null`, it does not throw, so `js/dom.js` imports cleanly
with a missing element and the failure surfaces later as a `TypeError` at the first
use — and only if a gate happens to touch that particular control. Renaming an id
that no gate exercised was a silent, green-CI regression. Gate 1 closes that.

---

## 1. Tasks

Ordering is suggested in §3. Each task states the files, a definition of done you
can check yourself without taking my word for it, and what it risks.

---

### W1 — Make the offline claim true, or stop making it

**The problem.** `README.md:81` says *"the web app works offline outright."* It
does not. There is no service worker anywhere in the repo (`grep -rn
"serviceWorker" index.html js/` returns nothing), so opening the app with the
network off gives the browser's own error page. What is actually true is the
narrower claim the same sentence goes on to make: no network round trip is needed
*for recognition*, because Tesseract's worker, wasm core and `eng.traineddata.gz`
are vendored. For a local-first document scanner whose whole pitch is "no server,"
this is the gap most worth closing rather than rewording.

**Files.**
- Build it: new `sw.js` at the repo root; registration in `index.html` (near the
  existing module `<script>` at line 698); new `test/offline.js`; `.github/workflows/ci.yml`.
- Or reword it: `README.md:81` only.

**Definition of done (build it).** With the app loaded once, then DevTools →
Network → **Offline** (and again with Wi-Fi genuinely off, which is a different
code path in Safari), a full reload of the live URL renders the Library, and
scanning a local image completes end to end. DevTools → Application → Cache
Storage lists `index.html`, `style.css`, all 44 `js/*.js`, `tesseract.min.js`,
`worker.min.js`, one core `.wasm.js`, and `eng.traineddata.gz`. A second check
that matters as much: push any change to `main`, wait for Pages, reload twice, and
confirm you get the **new** build — a service worker that pins `index.html`
forever is the classic way to ship an app that can never be updated again.

**Definition of done (reword).** `README.md:81` no longer contains "works offline
outright"; it says recognition needs no network once the page has loaded.

**Risk.** CSP needs no change — `worker-src 'self' blob:` already covers service
worker registration, and `default-src 'self'` covers the rest. No DOM ids touched.
Real hazards are (a) stale-cache lockout, which is why the redeploy check above is
part of "done", and (b) the 11 MB `vendor/tesseract` tree — precaching it wholesale
makes first load hostile, so cache the app shell eagerly and the tessdata/core on
first successful scan. Existing gates are indifferent unless the SW starts
intercepting during tests; register it behind a check for `location.protocol ===
"https:"` or a `?nosw` escape hatch so the Playwright gates keep seeing the network.

---

### W2 — Cross-browser CI: the app ships to Safari and Firefox, CI only tests Chromium

**The problem.** Every one of the 12 browser gates does `import { chromium } from
"playwright-core"` and `chromium.launch()`. Nothing has ever executed this app in
WebKit or Gecko. For a web app that is the largest unmeasured risk on the list —
larger than anything in the scan pipeline, which at least has a benchmark. And
WebKit coverage is worth double here, because it is the same engine family the iOS
WKWebView build runs on, so a WebKit failure is very likely an iOS failure you
would otherwise discover on the device pass.

The places I would expect it to bite, from reading the code:
- `js/notesEditor.js:242` — the whole rich-text editor is `document.execCommand`,
  whose output markup differs materially between Blink and WebKit/Gecko.
  `sanitizeHtml` and `stripMarkup` are written against what Chromium emits.
- `js/store.js` — IndexedDB transaction auto-commit timing is the classic
  Safari divergence; `withTransaction` resolves on `oncomplete`, which is the
  correct design, so this may well pass. Worth knowing rather than assuming.
- `canvas.toBlob` (6 call sites) and iOS Safari's canvas area ceiling.
- `js/library.js:187` `IntersectionObserver`, fine everywhere but untested.

**Files.** `test/touch-interactions.js`, `interaction-layer.js`, `heic-input.js`,
`exif-orientation.js`, `malformed-input.js`, `library-documents.js`,
`move-inpaint.js`, `non-latin-limitation.js`, `run-benchmark.js`,
`document-creation.js`, `render-fidelity.js`, `web-tier-smoke.js`, `pdf-export.js`;
`.github/workflows/ci.yml`; `test/package.json`.

**Definition of done.** A `BROWSER` env var (default `chromium`) selects the engine
in every gate, and `BROWSER=webkit node test/library-documents.js` and
`BROWSER=firefox node test/document-creation.js` run to completion locally. `ci.yml`
runs a matrix over chromium/webkit/firefox for at least gates 4, 10, 12, 13, 14, and
CI is green on all three. Every gate that genuinely cannot run on an engine says so
in a comment and skips with a stated reason rather than silently.

**Risk.** **This is the task most likely to go red, and that is the point** — a
failure here is a bug your users already have. No DOM ids touched. One gate cannot
be made portable as written: `test/touch-interactions.js` uses
`context.newCDPSession()` + `Input.dispatchTouchEvent` (lines 47-59) specifically
to get *genuine* touch events, and CDP is Chromium-only. Leave it Chromium-pinned
and document why, rather than downgrading it to `page.touchscreen` and losing the
fidelity it was built for. Also expect CI wall time to roughly triple — 3m30s → ~10m.

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

**Scope, deliberately narrow.** `js/dom.js` only. `index.html` carries 147 ids;
widening this to all of them trades a precise contract for a noisy one. The gate's
header names `add-to-doc-btn` and `save-note-btn` (`js/main.js:1141-1142`) as
honourable mentions — `main.js` queries them directly and treats them like the
contract — without asserting them.

**Risk.** None realized. Adds a gate, touches no app code, touches no ids.

---

### W4 — The `prefers-reduced-motion` invariant broke again, and its check still isn't in CI

**The problem.** `ANALYSIS.md` §3.7 established this greppable invariant:

```
grep -E '^\s*(transition|animation):' style.css | grep -v 'var(--motion-'
```

It was supposed to return nothing. It now returns five lines. Three are legitimate
— `style.css:415` and `:1749` are `transition: none` *inside* reduced-motion /
active-drag rules, and `:2299`/`:2313` are the deliberate spinner→pulse
substitution. One is a genuine regression: **`style.css:405`,
`.radial-menu__item`, hardcodes `140ms / 100ms / 120ms / 120ms`**, added by the
interaction layer in `e181738`.

The behaviour is *not* broken — `js/radialMenu.js:82` adds
`.radial-menu--instant` under `PREFERS_REDUCED_MOTION.matches`, and
`test/interaction-layer.js` covers it. But the invariant's whole value was that
one grep proved it for the entire stylesheet, and that grep now returns noise, so
the next genuinely-unguarded transition hides in it. §3.7's own lesson was that a
comment cannot fail; a check nobody runs cannot either.

**Files.** `style.css` (line 405, and decide explicitly about 1749/2299/2313);
`.github/workflows/ci.yml`.

**Definition of done.** The grep above returns **nothing**, with the legitimate
exceptions either tokenized or moved onto an explicit, commented allowlist inside
the CI step — and that step is a real job in `ci.yml` that goes red when you
re-add a hardcoded duration. Verify by adding `transition: opacity 200ms;` to any
rule and watching CI fail.

**Risk.** Low. `style.css` only. No ids. The one thing to be careful of: if you
tokenize `.radial-menu__item`, the reduced-motion path then has two mechanisms
zeroing it, which is harmless, but re-run `test/interaction-layer.js` — it asserts
the bloom animation is absent under emulated reduced motion.

---

### W5 — Eleven destructive or creative paths are behind native dialogs, and CI has never run one of them

**The problem.** There are 19 `window.alert` / `confirm` / `prompt` call sites, and
**no test file anywhere handles a Playwright `dialog` event** (`grep -rn
"page.on(\"dialog\"" test/` returns nothing). Playwright auto-dismisses unhandled
dialogs, so in every CI run `window.confirm(...)` returns `false` and these
handlers return early. `test/library-documents.js` does exercise deletion and
trash — but by importing `/js/documents.js` and calling `purgeDocument` directly
(line 197), which is the model, not the handler.

Uncovered by any gate today:

| Call site | Action gated |
|---|---|
| `js/library.js:422` | permanent delete from Recently Deleted |
| `js/library.js:743` | empty the trash |
| `js/library.js:460`, `:629` | create a folder |
| `js/library.js:467`, `:471` | rename or delete a folder |
| `js/notesEditor.js:575` | insert a link |
| `js/scanDoc.js:337` | apply a filter to all pages |
| `js/scanDoc.js:367` | delete a page |
| `js/app.js:503` | clear translation history + saved phrases |
| `js/app.js:512`, `:513` | **delete every document, page and image on the device** |

That last one is the most consequential button in the app and no automated test has
ever pressed it.

**Files.** `test/library-documents.js` or a new `test/destructive-actions.js`;
`.github/workflows/ci.yml`.

**Definition of done.** A gate that installs `page.on("dialog", d => d.accept(…))`
and drives each row above **through the real UI control**, asserting the effect on
the store afterwards — a purged document is gone from `getAllDocuments()`, "delete
everything" leaves `estimateStorage().usage` at the floor, a created folder appears
in the folder list. Verify it gates: make `js/app.js:513`'s second confirm
unconditional-true and watch nothing change; delete the handler's body and watch it
go red.

**Risk.** Low, and it is test-only — but it will very likely *find* something, which
is why it should land before W6 rather than after.

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
ids to `index.html` and rewires handlers in four modules that gates 12, 13 and 14
drive. Do W3 and W5 first: W3 turns an accidental id rename into a red build, and
W5 gives you a test of the old behaviour to port. The existing `#folder-picker`
markup is the pattern to copy — it already exists and already works.

---

### W7 — No web app manifest, so the app cannot be installed

**The problem.** `grep -rn "manifest\|apple-touch-icon" index.html` returns nothing.
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

### W8 — Storage durability: a local-first app whose storage the browser may delete

**The problem.** This is the one I would rank as the biggest *product* risk in the
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

**Risk.** Medium. It touches `js/store.js`, which gate 12 leans on hardest, and it
adds Settings ids (mitigated by W3). The export format is the decision worth making
deliberately — a single JSON with base64 page images is simplest and roughly
inflates blobs by a third; a zip needs a vendored library, which this repo has
consistently and correctly refused. Note this work has an iOS payoff too:
`HANDOFF.md` §5.0 lists IndexedDB quota under iOS eviction as an open device-pass
question, and a backup path is the honest answer to it.

---

### W9 — Run the 17 web checks in `TEXTSCANNER-HARDENING-PLAN.md` §1

**The problem.** Two same-day passes (`8d37a35`, `e181738`) landed the nav
redesign, the coherence router, the skip-the-call gate, the radial menus, the
command palette and the global shortcuts. All have automated gates and all are
green. **None has been looked at by a person in a real browser.** The hardening
plan already enumerates the 17 checks; they are not restated here.

**Files.** None — or whatever the checks turn up.

**Definition of done.** `python3 -m http.server 8080`, then all 17 checks pass or
are filed as issues. Checks 10-13 need touch: Chrome DevTools device toolbar with
touch simulation is the honest first pass, and the plan is right that it is not the
last word. Check 6 (receipt/business-card routing) needs an Anthropic key on the
web build — if you would rather not spend one on it, mark it deferred rather than
passed.

**Risk.** None; it is verification. But **a failure here almost certainly means a
gate is wrong too**, and the same "fix the gate, not just the symptom" rule the
device pass carries applies.

---

### W10 — Documentation accuracy pass

**The problem.** Three concrete errors, found while mapping:

1. **`README.md:111` documents `js/editor.js`, which does not exist.** It has not
   existed since the editor was split into `editorObjects.js` /
   `editorInteractions.js` / `editorExport.js`. The Project structure block lists
   12 modules out of 44 and omits the entire document layer — no `store.js`,
   `documents.js`, `library.js`, `notesEditor.js`, `scanDoc.js`, `pdf.js`,
   `views.js`, `app.js`, `radialMenu.js`, `commandPalette.js`.
2. **"68 ids" is wrong in `HANDOFF.md` §0 and `ANALYSIS.md` §8.2.** It is 71 (§0
   above).
3. **`README.md:81`'s offline claim** — W1.

**Files.** `README.md` (81, 103-134), `HANDOFF.md` §0, `ANALYSIS.md` §8.2.

**Definition of done.** Every path named in README's Project structure block
resolves (`ls` each one); the id count matches `grep -c getElementById js/dom.js`;
the offline sentence matches whatever W1 decided.

**Risk.** None. Docs only. Worth doing because this repo's documents are
unusually load-bearing, and a citation standard that cites a deleted file is
the failure mode `ANALYSIS.md` §1.3 is explicitly proud of avoiding.

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

**Risk.** Medium, mostly on size and on gate 8. `eng` alone is 2.9 MB;
`chi_sim` is larger. GitHub Pages' published-site soft limit is 1 GB so there is
headroom, but each language is a real first-scan download for every user. A
language picker adds ids (W3 first). **Scope decision, not a defect** — I am
listing it because the docs currently read as though non-Latin is blocked on the
Vision migration, and on the web it is not.

---

## 2. Risk summary

| Task | Touches the 71 ids | Can turn CI red | Effort |
|---|---|---|---|
| W1 offline / service worker | No | New gate; SW must not intercept existing gates | M |
| W2 cross-browser CI | No | **Yes, by design** | M–L |
| ~~W3 dom-id gate~~ **done** | No (protects them) | New gate only | S |
| W4 motion invariant | No | New gate only | S |
| W5 dialog-path coverage | No | Likely finds a real bug | S–M |
| W6 replace native dialogs | **Yes** | Gates 12, 13, 14 | L |
| W7 web app manifest | No | No | S |
| W8 storage durability + backup | Adds Settings ids | Gate 12 | L |
| W9 run the 17 checks | No | Only if it finds something | S |
| W10 doc accuracy | No | No | S |
| W11 og: + 404 | No | No | S |
| W12 version stamp | One new id | No | S |
| W13 more languages | Adds picker ids | Gate 8 | M |

---

## 3. Suggested order

**First, because they are cheap and they protect everything after them:**
W3 (id gate) → W4 (motion gate) → W10 (docs) → W9 (run the 17 checks).

**Then the two that decide what "shippable web app" even means:**
W2 (cross-browser — do this before building anything new, so you are not
debugging new code and a WebKit divergence at once) → W1 (offline).

**Then the product gaps, in dependency order:**
W7 (manifest) → W8 (storage durability, which depends on W7 for persistence) →
W5 (cover the dialog paths) → W6 (replace them).

**Last, optional:** W11, W12, W13.

If you only do four: **W3, W2, W1, W8.** Those are, respectively, the invariant you
asked about, the browsers you have never tested, the claim you are making that
isn't true, and the data your users could lose.

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
- **Bundling or a build step.** §0: 44 modules over HTTP/2 with gzip is fine, and
  the zero-build property is load-bearing for the CSP, for reviewability and for
  every gate that does `import("/js/dom.js")` against the live source.
- **Adding a `.nojekyll`.** Verified unnecessary — every vendored asset serves 200.
- **The benchmark baseline file.** `test/baseline-2026-08-28.json` stays valid
  exactly as long as the corpus does not change, which is §4.4's problem.
