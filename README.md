# TextScanner

Extract text from any image, right in your browser. Drag in a photo, screenshot, or scan, and TextScanner reads the text out for you, no upload, no server, no account.

**Live app:** https://prashaantm.github.io/TextScanner/

## Why not just use Google Lens, Adobe Scan, or Live Text?

Those tools are all built to help you *read* text in a photo — select it, copy it, search it, translate it. None of them let you *edit* the image itself. TextScanner turns every recognized word into an independent object: retype it, move it, resize it, or delete it — deleted text's old spot gets properly repaired underneath (real inpainting, not a visible gap or a smudge) — so you can genuinely edit text on a photographed sign, screenshot, or poster and export the result, not just read it off.

A few other gaps this fills:

- **Graduated output, not one fixed guess** — Raw, Filtered Text, or an optional LLM-based Coherence Filter rewrite, chosen per scan instead of handed to you as a single take-it-or-leave-it result.
- **Visible confidence flagging** on uncertain words, instead of every recognized word presented with the same, potentially false, authority.
- **No account, no subscription, no upload** — recognition runs fully on-device/in-browser. The one opt-in exception (Coherence Filter) is disclosed every time you use it.

What this doesn't claim: better raw recognition accuracy than those tools on hard, cluttered, or decorative photos. See Features below for an honest account of where recognition quality stands today.

## Features

- Drag and drop, click to browse, paste from clipboard, or capture a photo on mobile
- Optical character recognition powered by [Tesseract.js](https://github.com/naptha/tesseract.js), running fully client-side via WebAssembly
- Before recognition, each image is auto-deskewed and, when it looks like it would help (low OCR confidence on the raw image), also run through contrast-normalizing preprocessing, to cut down on the garbled/junk characters that plain OCR produces on low-contrast, uneven-lighting, skewed, or busy-background photos. Preprocessing is only kept when it actually scores better than the raw image, so it never makes a clean image worse
- Beyond that whole-image pass, each recognized text block that scored poorly is individually re-cropped and re-recognized with settings tuned to that block alone (its own local contrast, its own upscale, and - for a text-over-photo/textured background - an edge-based binarization candidate as well), rather than treating a poster's title, body copy, and fine print identically. A block whose own line geometry shows a consistent keystone (shallow-angle-photo) tilt is corrected before that re-recognition; detecting the physical edges of a photographed page/sign in a cluttered photo and fully flattening it is not attempted, since that's a much harder problem this project doesn't tackle
- Handwriting recognition is weak, especially cursive - Tesseract.js is a print-text engine and this project doesn't change that
- Words Tesseract recognizes with low confidence are flagged with a subtle underline in Image format / Full image, rather than silently trusted or hidden, so you know what to double-check
- Three filter levels, in every result view:
  - **Raw**: every character/word the engine detected as text-like, unfiltered
  - **Filtered Text**: the same output with OCR noise, garbage tokens, and misrecognized artifacts stripped out - a cleanup pass, not a rewrite, so a real price, phone number, or initial is kept
  - **Coherence Filter**: sends Filtered Text to Claude to rewrite as grammatically correct, readable prose (an event poster's scattered name/location/time becomes a sentence describing the event). This is generative, not extraction, and it's the one feature that sends anything off your device - it's opt-in, requires your own Anthropic API key (stored only in this browser), and the app discloses this every time the panel is open
- Three result views:
  - **Text**: the extracted text in a plain, copyable box
  - **Image format**: each word placed where it appeared in the source image, as editable and copyable text on a plain background instead of the image itself
  - **Full image**: the actual image shown as is, with the same editable, copyable text laid over it. Untouched words stay invisible against the photo so nothing looks duplicated; a word only becomes visible once you interact with it or actually change it. Deleting a word properly inpaints its old spot from the surrounding image, rather than leaving a gap; moving a word does not yet clean up its vacated spot the same way (known limitation)
- Select multiple words at once in either image-based view, by shift-clicking or dragging a selection box, so Copy and Download work on just the words you pick
- A **Move components** mode, available from Full image, for moving and resizing the text and the image itself, freely and independently, with Undo and Redo for every move and resize
- Download the current view as a PNG from Image format or Full image, alongside the plain-text download
- Live progress feedback while the OCR engine loads and processes the image
- Copy the extracted text to your clipboard or download it as a `.txt` file, from any view
- A built-in sample image so you can try it out with no image of your own
- Everything runs on-device and works offline after the first load, except Coherence Filter, which needs a network call to Claude's API and is entirely opt-in - the rest of the app, including recognition itself, never sends anything anywhere
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

```
index.html           Markup and layout
style.css            Styling, including light/dark themes
js/main.js           Bootstrap: file handling, drag and drop, Scan/Copy/Download wiring
js/dom.js            Every DOM element reference, looked up once and shared
js/state.js          Shared app/editor state and tunable constants
js/editor.js         The Image format / Full image editing surface: render, select,
                      drag/resize, undo/redo, PNG export
js/ocrEngine.js      Tesseract.js worker lifecycle, page segmentation, auto-deskew,
                     confidence-based raw-vs-preprocessed selection, and per-region
                     block reprocessing
js/preprocess.js     Canvas-based image preprocessing, both whole-image and per-region
                     (grayscale, local contrast normalization, upscale, edge-based
                     binarization for textured/gradient backgrounds)
js/perspective.js    Keystone correction (line-geometry-based) and the generic
                     perspective warp it's built on
js/filter.js         Raw / Filtered Text level logic (noise stripping over OCR words)
js/coherence.js      Coherence Filter: API key storage and the Claude API call that
                     reconstructs Filtered Text into prose
docs/origins/        Early OpenCV exploration scripts from this project's origins,
                     plus the sample media they read (history, not a dependency)
test/                CER/WER benchmark harness (Playwright-driven), unit tests for the
                     pure pipeline functions, the benchmark image corpus (test/images/)
                     and its ground-truth transcriptions (test/groundtruth/)
```

## Origins

TextScanner started as a set of Python and OpenCV exercises exploring computer vision fundamentals like grayscale conversion and image I/O. Those original scripts are kept in [`docs/origins/`](docs/origins) for reference. The project has since been rebuilt as a browser-based OCR tool so it is something you can actually open and use.

## Tech stack

- HTML, CSS, and vanilla JavaScript
- [Tesseract.js](https://github.com/naptha/tesseract.js) for in-browser OCR
- [GitHub Pages](https://pages.github.com/) for hosting

## License

No license has been set for this project. All rights reserved by the author unless stated otherwise.
