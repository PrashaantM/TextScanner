// The three images whose ground truth is deliberately incomplete: illegible
// fine print was left out of the transcription rather than guessed at (see
// test/images/README.md). Their CER/WER is directional only, and an engine
// that reads MORE of the real fine print scores WORSE on them - so they must
// never be averaged into a headline number, or a genuine improvement can
// register as a regression.
//
// Shared by test/run-benchmark.js and test/tune-thresholds.js so the set
// cannot drift between the gate and the tuning sweep - it used to be declared
// separately in each, and run-benchmark.js's copy never existed at all, which
// is how its gated average ended up including all eleven images.
//
// Adding a new image with necessarily-partial ground truth: add its name here,
// not in either caller.
export const PARTIAL_GROUND_TRUTH = new Set(["complexPic7", "complexPic10", "complexPic11"]);
