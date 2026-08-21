// tts.js: thin wrapper around SpeechSynthesis/SpeechSynthesisUtterance for
// reading the active result text aloud. Owns nothing about which text to read
// (main.js passes in getActiveResultText()'s output) or when the toolbar
// should show its controls (also main.js) - just play/pause/stop and a small
// idle/speaking/paused state machine, reset from the utterance's own end/error
// events so the UI stays correct even when speech ends for reasons outside a
// direct stop() call (e.g. the text simply finishing).

export const TTS_STATE = { IDLE: "idle", SPEAKING: "speaking", PAUSED: "paused" };

let state = TTS_STATE.IDLE;
let onStateChange = null;
let currentUtterance = null;

export function isTTSSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

// Some engines populate getVoices() synchronously, others only after a
// voiceschanged event fires once - and a few (older Firefox, some Linux
// builds) never fire it and never return voices at all. Resolves with
// whatever's available after a short wait either way, so the caller can
// treat "still empty" as "no usable TTS" without hanging.
export function waitForVoices(timeoutMs = 1000) {
  if (!isTTSSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const existing = synth.getVoices();
  if (existing.length) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener("voiceschanged", onVoicesChanged);
      resolve(synth.getVoices());
    };
    const onVoicesChanged = () => finish();
    synth.addEventListener("voiceschanged", onVoicesChanged);
    setTimeout(finish, timeoutMs);
  });
}

export function setTTSStateChangeHandler(fn) {
  onStateChange = fn;
}

export function getTTSState() {
  return state;
}

function setState(next) {
  state = next;
  if (onStateChange) onStateChange(state);
}

export function speak(text) {
  if (!isTTSSupported() || !text) return;
  window.speechSynthesis.cancel(); // clear any prior utterance before starting fresh

  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance;
  const finish = () => {
    if (currentUtterance === utterance) setState(TTS_STATE.IDLE);
  };
  utterance.addEventListener("end", finish);
  utterance.addEventListener("error", finish);

  window.speechSynthesis.speak(utterance);
  setState(TTS_STATE.SPEAKING);
}

export function pause() {
  if (!isTTSSupported() || state !== TTS_STATE.SPEAKING) return;
  window.speechSynthesis.pause();
  setState(TTS_STATE.PAUSED);
}

export function resume() {
  if (!isTTSSupported() || state !== TTS_STATE.PAUSED) return;
  window.speechSynthesis.resume();
  setState(TTS_STATE.SPEAKING);
}

export function stop() {
  if (!isTTSSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
  setState(TTS_STATE.IDLE);
}
