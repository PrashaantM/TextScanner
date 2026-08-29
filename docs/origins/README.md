# Origins

TextScanner started as a set of Python/OpenCV exercises exploring computer
vision fundamentals (image I/O, grayscale conversion, keypress-driven saving).
Those original scripts live here, unchanged, alongside the sample media they
read and write:

- `read image.py` / `WaitKey to Save Image.py` — the two exercises. Both read
  `hazard10.jpg` from this directory and write `grayhazard.jpg` /
  `grayhazard1.jpg` next to it, so they still run as-is from here.
- Everything else (`lena.jpg`, `sudoku.png`, `opencv-logo.png`, `pic1-6.png`,
  `ellipses.jpg`, `gradient.png`, `vtest.avi`) is stock OpenCV tutorial sample
  media kept from the same period. Nothing in the app or in `test/` reads any
  of it.

This folder is history, not a dependency. The project's real benchmark corpus
lives in [`test/images/`](../../test/images) with ground truth in
[`test/groundtruth/`](../../test/groundtruth); it used to sit in a folder named
`legacy-opencv-scripts/` next to these scripts, which made the test data
needlessly hard to find.
