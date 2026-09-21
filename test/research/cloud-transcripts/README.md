# cloud-transcripts — recorded model transcripts for the hybrid path

What `node test/run-benchmark.js --cloud` replays in place of a live call to
`api.anthropic.com`. One `<image>.txt` per corpus image, holding exactly what the
vision model returned for that image under the system prompt in
[`js/cloudVision.js`](../../../js/cloudVision.js).

**Nothing here is imported by `js/`, wired into `ci.yml`, or reachable from the
app.** `--cloud` is a measurement flag; the gated benchmark is still the local
path, which is what every user who has not opted in gets.

---

## Why a recording and not a live call

The same three reasons `test/web-tier-smoke.js` states, and one more:

1. A live call needs a real API key in CI.
2. It bills the account on every push.
3. It fails whenever a third party has an outage.
4. **It is not reproducible.** A recording scores the same transcript every run,
   so a change in the number means a change in `js/transcriptAlign.js` or
   `js/ocrEngine.js` and never a change in the weather.

Everything downstream of the transcript is real: the real `js/ocrEngine.js` runs
for geometry, the real alignment places the text on its boxes, and the score is
read off the real `#result-text`.

## How these were produced, and the limit that puts on them

**Recorded 2026-09-21.** There was no API key available in the environment where
this work was done — `ANTHROPIC_API_KEY` unset, no `ant` CLI — so **no live call
to `api.anthropic.com` was ever made.** Each transcript was produced by putting
the image in front of the same model family the app calls (`claude-opus-5`),
under the production system prompt, and recording what came back.

**What that does establish:** these are a real vision model's readings of these
images under this prompt, and every number measured through them exercises the
shipped alignment, the shipped geometry and the shipped scoring.

**What it does NOT establish, and this is the hard limit:**

- **Run-to-run variance is not in the loop.** A fixed recording cannot tell you
  how much the transcript would move between two live calls on the same image.
- **The request itself is unexercised end to end.** `transcribeImage`'s real
  headers, image encoding and error mapping are covered by mocked responses in
  the gates, not by a call that actually reached Anthropic.
- **Latency and token cost of a real call are unmeasured.** The per-image cost
  figures in the report are computed from image dimensions and transcript
  length, not read off a `usage` block from a live response.

Anyone with a key should re-run this against the live API before trusting the
accuracy numbers as a product claim rather than as a pipeline measurement.

## The reading-order correction, recorded because it moved the numbers a lot

Three of these were re-recorded after the prompt's reading-order rule changed
from "top to bottom, and within a horizontal band, left to right" to the
group-complete rule now in `js/cloudVision.js`. The effect was not marginal:

| image | CER before | CER after | what changed |
|---|---|---|---|
| complexPic3 | 57.6% | **4.3%** | nine-panel mockup read band-wise instead of panel by panel |
| complexPic10 | 122.0% | **0.0%** | five TV boxes read as five bands instead of five boxes |
| complexPic11 | 291.3% | 156.3% | store aisle, same correction; still dominated by partial ground truth |

complexPic3's bag-of-words WER was **6.2%** while its in-order WER was 67.3% —
the model had read 93.8% of the words correctly and serialized them unusably.
That diagnosis is what identified the prompt rule as the cause rather than
recognition quality.

**The circularity is real and is disclosed here as well as in the report:** the
defect was found by scoring against the same eight images that set every
threshold in this pipeline, and the fix's benefit is measured on those same
eight. The *justification* for the rule is independent of the corpus — it is the
reading-order contract `js/ocrEngine.js`'s `orderRegionsForReading` already
implements, for the reason its own comment gives — but the evidence that it
mattered is not.
