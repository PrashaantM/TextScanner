# TextScanner

Extract text from any image, right in your browser. Drag in a photo, screenshot, or scan, and TextScanner reads the text out for you, no upload, no server, no account.

**Live app:** https://prashaantm.github.io/TextScanner/

## Features

- Drag and drop, click to browse, paste from clipboard, or capture a photo on mobile
- Optical character recognition powered by [Tesseract.js](https://github.com/naptha/tesseract.js), running fully client-side via WebAssembly
- Two result views: a plain **Text** view, and an **Image format** view that places each word in the same position it appeared in the source image, as editable, copyable text on a plain background instead of the image itself
- Live progress feedback while the OCR engine loads and processes the image
- Copy the extracted text to your clipboard or download it as a `.txt` file, from either view
- A built-in sample image so you can try it out with no image of your own
- Works entirely offline after the first load, since your images never leave the browser
- Responsive layout with automatic light and dark themes

## How it works

1. Choose or drop an image containing text.
2. Click **Scan text**. Tesseract.js downloads its OCR engine and language data the first time, then recognizes text directly in your browser.
3. Read the result in the **Text** view, or switch to **Image format** to see and edit each word laid out where it originally appeared, then copy or download it.

No image data is ever sent to a server. Everything happens locally in the tab.

## Running locally

This is a static site with no build step. Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Project structure

```
index.html   Markup and layout
style.css    Styling, including light/dark themes
script.js    File handling, drag and drop, and the Tesseract.js OCR pipeline
legacy-opencv-scripts/   Early OpenCV exploration scripts from this project's origins
```

## Origins

TextScanner started as a set of Python and OpenCV exercises exploring computer vision fundamentals like grayscale conversion and image I/O. Those original scripts are kept in [`legacy-opencv-scripts/`](legacy-opencv-scripts) for reference. The project has since been rebuilt as a browser-based OCR tool so it is something you can actually open and use.

## Tech stack

- HTML, CSS, and vanilla JavaScript
- [Tesseract.js](https://github.com/naptha/tesseract.js) for in-browser OCR
- [GitHub Pages](https://pages.github.com/) for hosting

## License

No license has been set for this project. All rights reserved by the author unless stated otherwise.
