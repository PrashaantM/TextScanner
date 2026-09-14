# TextScanner

![CI](https://github.com/PrashaantM/TextScanner/actions/workflows/ci.yml/badge.svg)

Scan documents, take notes, and translate text — all on your device. No upload, no server, no account.

**Live app:** https://prashaantm.github.io/TextScanner/

TextScanner is three things that share one document library:

- **A document scanner.** Multi-page scans with automatic edge detection, six page filters, rotation, reordering, and export to searchable PDF.
- **A notes app.** Rich text, checklists, folders, tags, pinning, and full-text search that reaches inside your scanned pages.
- **An image text editor.** Every recognized word becomes an object you can retype, move, resize or delete — with the pixels underneath repaired.

## Why not just use Notes, Google Lens, Adobe Scan, or CamScanner?

Because they each do one of those three and hand you off for the rest. Scan a receipt in one app, retype it into another, translate it in a third.

The specific thing none of them do: **edit the text on the image itself.** Google Lens, Adobe Scan and Live Text are all built to help you *read* text in a photo — select it, copy it, translate it. TextScanner turns every recognized word into an independent object: retype it, move it, resize it, or delete it — and a deleted word's old spot gets properly repaired underneath (real inpainting, not a visible gap or a smudge). So you can genuinely edit text on a photographed sign, screenshot, or poster and export the result.

And the thing none of the scanner apps do: **no account, no subscription, no cloud.** CamScanner wants a login and uploads your documents. This stores everything in your browser's own database, on your device, and there is no server to upload to.

A few other gaps this fills:

- **Graduated output, not one fixed guess** — Raw, Filtered Text, or an optional LLM-based Coherence Filter rewrite, chosen per scan instead of handed to you as a single take-it-or-leave-it result.
- **Visible confidence flagging** on uncertain words, instead of every recognized word presented with the same, potentially false, authority.
- **No account, no subscription, no upload** — recognition runs fully on-device/in-browser. The one opt-in exception (Coherence Filter) is disclosed every time you use it.

What this doesn't claim: better raw recognition accuracy than those tools on hard, cluttered, or decorative photos. See Features below for an honest account of where recognition quality stands today.

## Features

### Library

- **Documents, folders and tags.** Everything you scan or write lands in one library, sorted by recency with pinned items first.
- **Search that reaches inside your scans.** Every page's recognized text is indexed, so searching "deductible" finds the insurance policy you photographed months ago — and the result shows the matching passage, not just the title.
- **Recently Deleted.** Deletion is two-stage: documents sit in the trash for 30 days and nothing is actually destroyed until they are purged. A scan's pages are megabytes each, so an undo that could not restore them would be a lie.
- **Everything is local.** IndexedDB, on your device. No sync, no account, no server. Settings shows exactly how much space it uses and can delete all of it.
- **Back up everything, to one file.** Because there is no server, the browser's storage is the only copy - and browsers do delete storage. Settings exports every document, page, image and folder as a single JSON file and reads it back. It deliberately does **not** contain your API key: a backup is exactly the file you email yourself or drop in a synced folder.
- **What "stored on your device" actually guarantees, per browser.** Settings now says which situation you are in, because it differs:
  - **Installed to the home screen or desktop** (any browser): storage is persistent and will not be evicted automatically. Install it from your browser's menu, or Share → Add to Home Screen on iOS.
  - **Chrome, Edge, Firefox in a normal tab:** persistence is usually granted once you have used the site a little; until then storage can be cleared under disk pressure, which is rare in practice.
  - **Safari in a normal tab:** storage is deleted after about **7 days** without a visit. This is Safari's policy for every site that is not installed, not something this app can opt out of. Install it to the home screen, or keep a backup.
  - **Private / incognito windows:** nothing is kept after the window closes, in any browser.

### Scanning

- **Automatic edge detection.** Point at a receipt on a desk and the page boundary is found and cropped out. It deliberately declines to guess when it cannot find a page — a wrong crop silently removes part of your document, so it prefers to hand you the corners instead.
- **Four-corner adjustment with a magnifier**, because a fingertip covers the corner it is placing. Keyboard adjustment too (Tab cycles corners, arrows nudge).
- **Six page filters** — auto enhance, magic colour, greyscale, soft and hard black & white, original — applied per page or to the whole document at once. Filters always work from the original capture, so switching between them never compounds and never degrades the page.
- **Multi-page documents** with drag reordering (and Alt+arrow keys, so it works with a screen reader), rotation, and per-page or whole-document OCR.
- **Export to searchable PDF.** The recognized text is laid invisibly over the page image, so the file looks like a scan and its text can still be searched, selected and copied. Also exports plain images or plain text.
- **Signatures and markup** — pen, highlighter and redaction, stored as vectors so they can be undone, and burned into the pixels only at export. Redaction genuinely destroys what it covers in the exported file rather than laying a removable box over it.

### Notes

- **Rich text** — headings, bold/italic/underline/strikethrough, bulleted and numbered lists, quotes, code blocks, links and inline images.
- **Checklists** that tick when you tap them.
- **Scan straight into a note.** Recognized text becomes a note in one tap; a captured image becomes a page in a scan document in one tap.
- **Autosave**, with pasted content sanitized on the way in.

### Recognition and editing

- Drag and drop, click to browse, paste from clipboard, or capture a photo on mobile
- Optical character recognition powered by [Tesseract.js](https://github.com/naptha/tesseract.js), running fully client-side via WebAssembly, and served from this origin rather than a CDN (see [`vendor/tesseract/`](vendor/tesseract)). The iOS app uses Google's ML Kit instead, on the same code path - see `js/recognize.js`
- Before recognition, each image is auto-deskewed and, when it looks like it would help (low OCR confidence on the raw image), also run through contrast-normalizing preprocessing, to cut down on the garbled/junk characters that plain OCR produces on low-contrast, uneven-lighting, skewed, or busy-background photos. Preprocessing is only kept when it actually scores better than the raw image, so it never makes a clean image worse
- Beyond that whole-image pass, each recognized text block that scored poorly is individually re-cropped and re-recognized with settings tuned to that block alone (its own local contrast, its own upscale, and - for a text-over-photo/textured background - an edge-based binarization candidate as well), rather than treating a poster's title, body copy, and fine print identically. A block whose own line geometry shows a consistent keystone (shallow-angle-photo) tilt is corrected before that re-recognition; detecting the physical edges of a photographed page/sign in a cluttered photo and fully flattening it is not attempted, since that's a much harder problem this project doesn't tackle
- Handwriting recognition is weak, especially cursive - Tesseract.js is a print-text engine and this project doesn't change that
- Words Tesseract recognizes with low confidence are flagged with a subtle underline in Image format / Full image, rather than silently trusted or hidden, so you know what to double-check. ML Kit (the iOS engine) reports no confidence at all, and rather than let an absent underline read as "every word is fine", the app says so in one line above the result
- Edited and added text takes its colour from the source image rather than one fixed theme colour, sampled from the pixels around each word before they're covered, with a legibility fallback when the sampled colour would be too close to its background. Font *family* is deliberately not guessed - see below
- Three filter levels, in every result view:
  - **Raw**: every character/word the engine detected as text-like, unfiltered
  - **Filtered Text**: the same output with OCR noise, garbage tokens, and misrecognized artifacts stripped out - a cleanup pass, not a rewrite, so a real price, phone number, or initial is kept
  - **Coherence Filter**: rewrites Filtered Text as grammatically correct, readable prose (an event poster's scattered name/location/time becomes a sentence describing the event). This is generative, not extraction. On an iPhone with Apple Intelligence it runs entirely on-device: no API key, no network request, nothing leaves the phone. Everywhere else - including the web version - it needs your own Anthropic API key (stored only in this browser) and sends the extracted text to Claude, which the app discloses every time the panel is open. The panel always states which of the two just ran
- Three result views:
  - **Text**: the extracted text in a plain, copyable box
  - **Image format**: each word placed where it appeared in the source image, as editable and copyable text on a plain background instead of the image itself
  - **Full image**: the actual image shown as is, with the same editable, copyable text laid over it. Untouched words stay invisible against the photo so nothing looks duplicated; a word only becomes visible once you interact with it or actually change it. Deleting a word properly inpaints its old spot from the surrounding image rather than leaving a gap, and moving one does the same for the spot it vacated. On a plain or gently shaded background the repair is exact; on a patterned one - lined paper, a grid, wood - the pattern is synthesized back from the surrounding pixels rather than smoothed away. A random texture like wood grain comes back convincing but not identical, which is the honest limit of the technique
- Font matching is partial and honestly so: size comes from the recognized bounding box and colour is sampled from the image, but the typeface is always the same neutral stack, and bold-vs-regular is **not** detected. Ink coverage was measured as a weight proxy against `test/render-fidelity.js` and does not separate weights - in a heavy display face, bold text covers *less* of its box than medium does - so the app doesn't guess
- **Translate in place**: the target language is suggested from the recognized text (reported with a confidence, so it hedges rather than asserts — "Cyrillic script - probably Russian"), and the recognized text is replaced with its translation *at the same position on the image*, then exported as a PNG. Every translation is remembered locally so the same text does not have to be translated — or, on the Claude tier, billed — twice; history is capped, and Settings can clear it. Other tools help you read a foreign menu; this hands the menu back in your language. Runs on Apple's on-device model on eligible iPhones (no key, no network) and falls back to Claude with your own API key, the same two tiers as the Coherence Filter. Translation works line by line rather than word by word, since word order and agreement change between languages
- Select multiple words at once in either image-based view, by shift-clicking or dragging a selection box - or, on touch, by switching on "Select multiple", since a phone has no shift key and a plain finger drag belongs to scrolling the page
- A **Move components** mode, available from Full image, for moving and resizing the text and the image itself, freely and independently, with Undo and Redo for every move and resize
- Download the current view as a PNG from Image format or Full image, alongside the plain-text download
- Live progress feedback while the OCR engine loads and processes the image
- Copy the extracted text to your clipboard or download it as a `.txt` file, from any view
- A built-in sample image so you can try it out with no image of your own
- Everything runs on-device, and **recognition needs no network at all, ever** - not even the first time: Tesseract.js, its worker, its WebAssembly core and its English language data are all served from this repository rather than a CDN, so nothing is fetched from a third party at scan time. To be precise about what that does *not* mean: the page itself is still loaded over the network like any website, so opening the app with no connection at all does not currently work - there is no service worker yet. Once the tab is open, no network is needed to scan, edit or export. The precise, honest claim is that **your image is never uploaded** - recognition happens on the device and the picture itself goes nowhere. The app is not, however, wholly silent on the network: Coherence Filter makes an opt-in call to Claude's API with your extracted text (disclosed every time the panel is open), and the iOS build links Google's ML Kit, which performs its own usage logging (see `ios/` notes and the App Store readiness work)
- Responsive layout with automatic light and dark themes

## How it works

1. Choose or drop an image containing text.
2. Click **Scan text**. Tesseract.js downloads its OCR engine and language data the first time, then recognizes text directly in your browser.
3. Read the result in **Text**, reposition-edit each word over a plain background in **Image format**, or work directly on the photo in **Full image**. In any of the two image-based views, shift-click or drag to select several words, then copy or download just that selection, as text or as a PNG.
4. From **Full image**, click **Move components** to drag and resize the text and the image freely. Undo and Redo step back and forward through those changes.

Your image is never sent anywhere - recognition, editing, and export all happen locally in the tab. The one exception is Coherence Filter (see Features above), which sends the already-extracted text (not the image) to Anthropic's API, only when you explicitly generate it.

## Running locally

This is a static site with no build step. Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Project structure

The web app has no build step: `index.html` loads `js/main.js` as an ES module and
the browser resolves the rest. 44 modules, grouped by what they own.

```
index.html            Markup and layout. Every view's markup is present at all
                      times, hidden with a class - see js/views.js for why
style.css             Styling, light/dark themes, and the --motion-* tokens a
                      single prefers-reduced-motion block zeroes

Shell and navigation
  js/app.js           The app shell: five views, settings, storage, wiring
  js/views.js         View switching and pushState routing
  js/dom.js           Every shared DOM element reference, looked up once.
                      Its ids are a contract - test/dom-contract.js gates them
  js/state.js         Shared app/editor state and tunable constants
  js/theme.js         System / light / dark, remembered in localStorage
  js/toast.js         Transient messages, including delete-with-Undo

Library and persistence
  js/store.js         IndexedDB: documents, pages, blobs, folders, settings
  js/documents.js     The document model over that store
  js/library.js       The library view: search, folders, tags, trash, gestures

Notes
  js/notesEditor.js   Rich text, checklists, inline images, autosave, paste
                      sanitization

Scanned documents
  js/scanDoc.js       Multi-page documents, reordering, export
  js/cropView.js      Four-corner adjustment with a magnifier
  js/edgeDetect.js    Automatic page-boundary detection
  js/scanFilters.js   The six page filters
  js/annotate.js      Pen, highlighter and redaction, stored as vectors
  js/pdf.js           Hand-written PDF writer with an invisible OCR text layer

Recognition
  js/recognize.js     The single engine seam: Tesseract.js on web, ML Kit native
  js/ocrEngine.js     Tesseract.js worker lifecycle, page segmentation,
                      auto-deskew, confidence-based raw-vs-preprocessed
                      selection, per-region block reprocessing
  js/mlkitEngine.js   The native path, including the cornerPoints geometry
  js/preprocess.js    Canvas preprocessing, whole-image and per-region
  js/perspective.js   Keystone correction and the perspective warp beneath it
  js/filter.js        Raw / Filtered Text level logic

Image-text editor
  js/main.js          Bootstrap: file handling, drag and drop, Scan/Copy/Download
  js/editorObjects.js Renders each recognized word as an editable object
  js/editorInteractions.js  Select, drag, resize, marquee, undo/redo
  js/editorExport.js  PNG export and writing translations back onto the image
  js/inpaint.js       Repairs the pixels under a deleted or moved word

Coherence Filter and translation (two tiers: on-device, or BYOK Claude)
  js/coherence.js     Tier dispatch
  js/coherenceClaude.js     API key storage and the Claude call
  js/coherenceOnDevice.js   Apple Foundation Models, via the native plugin
  js/coherenceRouter.js     Receipt / business-card prompt specialization
  js/coherenceGate.js       Offers "Reconstruct anyway" on already-clean text
  js/factCheck.js     Flags a rewrite that dropped a price, date, time or number
  js/translate.js     Translation tier dispatch
  js/translateClaude.js     The Claude tier
  js/translateOnDevice.js   The on-device tier
  js/translateLanguages.js  Target language list
  js/translateHistory.js    Local, capped history so nothing is billed twice
  js/langDetect.js    Script and language detection, reported with a confidence

Interaction layer (see 06-INTERACTION-MODEL-SPEC.md)
  js/radialMenu.js    One press-drag-release primitive, three call sites
  js/commandPalette.js  Cmd/Ctrl+K
  js/haptics.js       Native-only, silent no-op on the web

Other
  js/tts.js           Read the recognized text aloud
  js/diagnostics.js   User-triggered, opt-in diagnostic export

vendor/tesseract/     Tesseract.js 5.1.1, its worker, wasm cores and English
                      language data, served from this origin instead of a CDN
                      (see its README)
docs/PRIVACY-DECISIONS.md
                      What leaves the device and what doesn't, the ML Kit
                      telemetry decision, and how each claim was verified
docs/origins/         Early OpenCV exploration scripts from this project's
                      origins, plus the sample media they read (history, not a
                      dependency)
test/                 The CI gates: the CER/WER benchmark harness
                      (Playwright-driven), unit tests for the pure pipeline
                      functions, the browser gates, and the two browser-free
                      contract gates (test/dom-contract.js,
                      test/motion-contract.js). The benchmark image corpus is
                      test/images/ and its ground truth test/groundtruth/
```

## Origins

TextScanner started as a set of Python and OpenCV exercises exploring computer vision fundamentals like grayscale conversion and image I/O. Those original scripts are kept in [`docs/origins/`](docs/origins) for reference. The project has since been rebuilt as a browser-based OCR tool so it is something you can actually open and use.

## Tech stack

- HTML, CSS, and vanilla JavaScript
- [Tesseract.js](https://github.com/naptha/tesseract.js) for in-browser OCR, vendored locally rather than loaded from a CDN
- [GitHub Pages](https://pages.github.com/) for hosting

## License

No license has been set for this project. All rights reserved by the author unless stated otherwise.
