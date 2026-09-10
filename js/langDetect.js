// langDetect.js: works out what language a piece of recognized text is in, so
// translation can offer a sensible default instead of making someone pick.
//
// Two-stage, because the two stages answer genuinely different questions and
// have very different reliability:
//
//   1. SCRIPT detection, from Unicode ranges. Essentially exact - a string
//      containing Hiragana is Japanese, and no statistical model is going to
//      improve on that. This alone resolves Chinese, Japanese, Korean, Arabic,
//      Hebrew, Greek, Cyrillic, Devanagari, Thai and more.
//   2. LANGUAGE detection within the Latin script, from function words and
//      diacritic frequency. This is genuinely a guess, and it is reported with a
//      confidence so callers can present it as a suggestion rather than a fact.
//
// Why not a library or an API: this runs on text the app already has, offline,
// in a few milliseconds. A CLD3/franc-style n-gram model is 200 KB+ of tables to
// improve on stage 2, which is only ever used to pre-select a dropdown that the
// person can change in one tap. An API call would send the document's text to a
// third party purely to fill in a form field, which contradicts everything else
// this app does about keeping content local.
//
// The honest framing throughout: this is a DEFAULT, never a decision. Anything
// consuming it should show what it picked and let it be overridden.
//
// One important limitation, stated here rather than discovered later: the
// current OCR engines only read Latin script (js/ocrEngine.js loads `eng`;
// js/mlkitEngine.js requests `script: "LATIN"`). So in practice stage 1 fires on
// text that arrived some other way - a translation result, pasted text, a note -
// rather than on a fresh scan of a Japanese sign. See
// test/non-latin-limitation.js.

// Ranges are ordered so that the most diagnostic script wins. Japanese is a
// genuine ambiguity: Japanese text mixes Han characters with Kana, so a string
// with any Kana is Japanese, while Han alone is Chinese. Checking Kana first is
// what makes that resolution correct rather than accidental.
// `name` is the LANGUAGE the code selects, not the script, because that is what
// the UI shows next to a language dropdown - saying "Detected: Cyrillic" while
// selecting "Russian" is an inconsistency the reader has to resolve themselves.
//
// `script` records what was actually observed, and `ambiguous` marks the scripts
// where the language is an inference rather than an observation: Cyrillic is
// also Ukrainian, Bulgarian and Serbian; Devanagari is also Marathi and Nepali;
// Arabic script is also Persian and Urdu. Those get a lower ceiling on
// confidence so the UI hedges ("Probably Russian") instead of asserting.
const SCRIPT_RANGES = [
  { code: "ja", name: "Japanese", script: "Kana", pattern: /[぀-ゟ゠-ヿ]/, diagnostic: true },
  { code: "ko", name: "Korean", script: "Hangul", pattern: /[가-힯ᄀ-ᇿ㄰-㆏]/, diagnostic: true },
  { code: "zh", name: "Chinese", script: "Han", pattern: /[一-鿿㐀-䶿]/ },
  { code: "ar", name: "Arabic", script: "Arabic", pattern: /[؀-ۿݐ-ݿ]/, ambiguous: true },
  { code: "he", name: "Hebrew", script: "Hebrew", pattern: /[֐-׿]/ },
  { code: "el", name: "Greek", script: "Greek", pattern: /[Ͱ-Ͽἀ-῿]/ },
  { code: "ru", name: "Russian", script: "Cyrillic", pattern: /[Ѐ-ӿ]/, ambiguous: true },
  { code: "hi", name: "Hindi", script: "Devanagari", pattern: /[ऀ-ॿ]/, ambiguous: true },
  { code: "bn", name: "Bengali", script: "Bengali", pattern: /[ঀ-৿]/ },
  { code: "ta", name: "Tamil", script: "Tamil", pattern: /[஀-௿]/ },
  { code: "th", name: "Thai", script: "Thai", pattern: /[฀-๿]/ },
  { code: "ka", name: "Georgian", script: "Georgian", pattern: /[Ⴀ-ჿ]/ },
  { code: "hy", name: "Armenian", script: "Armenian", pattern: /[԰-֏]/ },
];

// The most confidence a script match can carry when the script maps to more
// than one plausible language.
const AMBIGUOUS_SCRIPT_CEILING = 0.62;

// Function words are the right signal for short OCR output: they are the most
// frequent words in any language, so even a single recognized line usually
// contains several, and they are short enough to survive imperfect recognition.
// Content words would be more distinctive per hit and far rarer per sample.
const LATIN_MARKERS = {
  en: {
    name: "English",
    words: ["the", "and", "of", "to", "in", "is", "that", "for", "it", "with", "you", "this", "are", "on", "be"],
    chars: /[]/,
  },
  es: {
    name: "Spanish",
    words: ["de", "la", "que", "el", "en", "los", "por", "con", "para", "una", "del", "las", "es", "se", "un"],
    chars: /[ñáéíóúü¿¡]/i,
  },
  fr: {
    name: "French",
    words: ["le", "de", "la", "les", "des", "est", "et", "en", "un", "une", "du", "pour", "que", "dans", "qui"],
    chars: /[àâçéèêëîïôùûü œ]/i,
  },
  de: {
    name: "German",
    words: ["der", "die", "das", "und", "ist", "den", "von", "mit", "für", "auf", "ein", "eine", "nicht", "dem", "sich"],
    chars: /[äöüß]/i,
  },
  it: {
    name: "Italian",
    words: ["di", "il", "la", "che", "per", "una", "con", "del", "non", "sono", "come", "alla", "nel", "gli", "dei"],
    chars: /[àèéìòù]/i,
  },
  pt: {
    name: "Portuguese",
    words: ["de", "que", "para", "com", "uma", "não", "por", "dos", "como", "mais", "das", "ao", "seu", "pelo", "são"],
    chars: /[ãõçáâêé]/i,
  },
  nl: {
    name: "Dutch",
    words: ["de", "het", "een", "van", "en", "is", "op", "dat", "te", "voor", "met", "zijn", "niet", "aan", "er"],
    chars: /[ij]/,
  },
  pl: {
    name: "Polish",
    words: ["nie", "sie", "jest", "que", "na", "do", "to", "za", "od", "przez", "oraz", "jak", "ale", "juz", "tylko"],
    chars: /[ąćęłńóśźż]/i,
  },
  tr: {
    name: "Turkish",
    words: ["bir", "ve", "bu", "için", "ile", "olarak", "daha", "çok", "olan", "kadar", "sonra", "gibi"],
    chars: /[çğıöşü]/i,
  },
  sv: {
    name: "Swedish",
    words: ["och", "att", "det", "som", "en", "på", "är", "av", "för", "med", "till", "den", "inte", "om"],
    chars: /[åäö]/i,
  },
  vi: {
    name: "Vietnamese",
    words: ["và", "của", "có", "được", "trong", "là", "cho", "không", "với", "các", "một", "này"],
    chars: /[ăâđêôơư]/i,
  },
  id: {
    name: "Indonesian",
    words: ["yang", "dan", "di", "dengan", "untuk", "dari", "pada", "ini", "itu", "tidak", "dalam", "akan"],
    chars: /[]/,
  },
};

// Below this many usable characters, any Latin-language guess is noise. A
// four-word receipt heading is not enough evidence to switch someone's language.
const MIN_CHARS_FOR_LATIN_GUESS = 24;

export function detectScript(text) {
  if (!text) return null;

  // A diagnostic script wins outright - Kana settles Japanese even in a string
  // that is mostly Han.
  for (const script of SCRIPT_RANGES) {
    if (script.diagnostic && script.pattern.test(text)) {
      return { code: script.code, name: script.name, script: script.script, confidence: 0.98, basis: "script" };
    }
  }

  // Otherwise, score by how much of the text each script actually accounts for,
  // so a single stray character cannot decide it.
  let best = null;
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (!letters) return null;

  for (const script of SCRIPT_RANGES) {
    const global = new RegExp(script.pattern.source, "gu");
    const matches = (text.match(global) || []).length;
    if (!matches) continue;
    const share = matches / letters;
    if (share > 0.15 && (!best || share > best.share)) {
      // The script itself is certain; naming the language from it is not, when
      // several languages share the script.
      const ceiling = script.ambiguous ? AMBIGUOUS_SCRIPT_CEILING : 0.97;
      best = {
        code: script.code,
        name: script.name,
        script: script.script,
        ambiguous: !!script.ambiguous,
        confidence: Math.min(ceiling, 0.6 + share * 0.4),
        share,
        basis: "script",
      };
    }
  }

  return best;
}

export function detectLatinLanguage(text) {
  const cleaned = (text || "").toLowerCase();
  if (cleaned.replace(/[^a-zàâäåæçèéêëìíîïñòóôöøùúûüýÿœßğışžćčđęłńóśźż]/gi, "").length < MIN_CHARS_FOR_LATIN_GUESS) {
    return null;
  }

  const tokens = cleaned.match(/[\p{L}']+/gu) || [];
  if (tokens.length < 4) return null;

  const scores = new Map();

  for (const [code, marker] of Object.entries(LATIN_MARKERS)) {
    let score = 0;

    // Function-word hits, normalized by sample size so a long document does not
    // automatically outscore a short one.
    const wordSet = new Set(marker.words);
    let hits = 0;
    for (const token of tokens) if (wordSet.has(token)) hits++;
    score += (hits / tokens.length) * 100;

    // Diacritics are strong evidence. English has effectively none, so their
    // presence alone rules it out and their absence weakly supports it.
    if (marker.chars.source !== "[]") {
      const diacritics = (cleaned.match(new RegExp(marker.chars.source, "gi")) || []).length;
      score += Math.min(12, (diacritics / Math.max(1, cleaned.length)) * 400);
    }

    scores.set(code, score);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topCode, topScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;

  if (topScore < 3) return null;

  // Confidence is the margin over the runner-up, not the raw score. Spanish and
  // Portuguese share most of their function words; a high score for both means
  // low confidence in either, and saying so is more useful than picking one.
  const margin = topScore - runnerUp;
  const confidence = Math.max(0.25, Math.min(0.92, margin / Math.max(1, topScore)));

  return { code: topCode, name: LATIN_MARKERS[topCode].name, confidence, basis: "words" };
}

// The entry point. Always returns something for non-empty input, with an honest
// confidence attached; `null` only for input with no letters at all.
export function detectLanguage(text) {
  if (!text || !text.trim()) return null;

  const script = detectScript(text);
  // A non-Latin script is close to certain, so it wins immediately.
  if (script && script.confidence > 0.8) return script;

  const latin = detectLatinLanguage(text);
  if (latin) return latin;
  if (script) return script;

  // Latin letters, but too little of them or too ambiguous to name a language.
  // English is the sensible fallback for this app's corpus, flagged as a weak
  // guess rather than presented as a detection.
  if (/\p{Script=Latin}/u.test(text)) {
    return { code: "en", name: "English", confidence: 0.2, basis: "fallback" };
  }

  return null;
}

// How to phrase the result in the UI. Below ~0.5 the app should say it is
// unsure rather than assert - a confidently wrong language label is worse than
// an honest question.
export function describeDetection(detection) {
  if (!detection) return "";

  // For a shared script, name what was actually observed alongside the guess.
  // "Cyrillic - probably Russian" tells the reader exactly how much is known,
  // and makes it obvious why they might need to change it.
  if (detection.ambiguous && detection.script) {
    return `${detection.script} script - probably ${detection.name}`;
  }

  if (detection.confidence >= 0.8) return `Detected: ${detection.name}`;
  if (detection.confidence >= 0.5) return `Probably ${detection.name}`;
  return `Possibly ${detection.name}`;
}

export function isConfident(detection) {
  return !!detection && detection.confidence >= 0.5;
}
