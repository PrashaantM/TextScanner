# TextScanner

Extract text from any image, right in your browser. Drag in a photo, screenshot, or scan, and TextScanner reads the text out for you, no upload, no server, no account.

**Live app:** https://prashaantm.github.io/TextScanner/

## Features

- Drag and drop, click to browse, paste from clipboard, or capture a photo on mobile
- Optical character recognition powered by [Tesseract.js](https://github.com/naptha/tesseract.js), running fully client-side via WebAssembly
- Three result views:
  - **Text**: the extracted text in a plain, copyable box
  - **Image format**: each word placed where it appeared in the source image, as editable and copyable text on a plain background instead of the image itself
  - **Full image**: the actual image shown as is, with the same editable, copyable text laid over it. Untouched words stay invisible against the photo so nothing looks duplicated; a word only becomes visible once you interact with it or actually change it, and a patch sampled from the surrounding image covers its old spot if you move it
- Select multiple words at once in either image-based view, by shift-clicking or dragging a selection box, so Copy and Download work on just the words you pick
- A **Move components** mode, available from Full image, for moving and resizing the text and the image itself, freely and independently, with Undo and Redo for every move and resize
- Download the current view as a PNG from Image format or Full image, alongside the plain-text download
- Live progress feedback while the OCR engine loads and processes the image
- Copy the extracted text to your clipboard or download it as a `.txt` file, from any view
- A built-in sample image so you can try it out with no image of your own
- Works entirely offline after the first load, since your images never leave the browser
- Responsive layout with automatic light and dark themes

## How it works

1. Choose or drop an image containing text.
2. Click **Scan text**. Tesseract.js downloads its OCR engine and language data the first time, then recognizes text directly in your browser.
3. Read the result in **Text**, reposition-edit each word over a plain background in **Image format**, or work directly on the photo in **Full image**. In any of the two image-based views, shift-click or drag to select several words, then copy or download just that selection, as text or as a PNG.
4. From **Full image**, click **Move components** to drag and resize the text and the image freely. Undo and Redo step back and forward through those changes.

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
