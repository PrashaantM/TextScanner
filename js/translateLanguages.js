// translateLanguages.js: the target languages translate-in-place offers, and
// nothing else. Split out so js/translate.js's dispatch stays about dispatch,
// and so the list has one home rather than being duplicated between the two
// implementations and the UI.
//
// Codes are ISO 639-1, which is what Apple's SystemLanguageModel.supportedLanguages
// reports back through the native plugin (see TextCoherencePlugin.swift), so the
// two lists can be intersected directly. `label` is what the user picks from and
// `name` is what gets put in front of the model, spelled out in English because
// "translate into Spanish" is a far more reliable instruction than "translate
// into es".
//
// Deliberately a short, curated list rather than everything either backend can
// do. This feature exists for menus, signage and packaging while travelling;
// a hundred-entry dropdown would be worse at that job, not better.

export const TARGET_LANGUAGES = [
  { code: "en", label: "English", name: "English" },
  { code: "es", label: "Spanish", name: "Spanish" },
  { code: "fr", label: "French", name: "French" },
  { code: "de", label: "German", name: "German" },
  { code: "it", label: "Italian", name: "Italian" },
  { code: "pt", label: "Portuguese", name: "Portuguese" },
  { code: "nl", label: "Dutch", name: "Dutch" },
  { code: "pl", label: "Polish", name: "Polish" },
  { code: "tr", label: "Turkish", name: "Turkish" },
  { code: "ja", label: "Japanese", name: "Japanese" },
  { code: "ko", label: "Korean", name: "Korean" },
  { code: "zh", label: "Chinese (Simplified)", name: "Simplified Chinese" },
  { code: "hi", label: "Hindi", name: "Hindi" },
  { code: "ar", label: "Arabic", name: "Arabic" },
  { code: "ru", label: "Russian", name: "Russian" },
];

export function findLanguage(code) {
  return TARGET_LANGUAGES.find((l) => l.code === code) || null;
}

// A caveat worth stating where the languages live, because it is a real limit
// of this feature and not a bug to be fixed later: translating INTO a
// non-Latin script (Japanese, Korean, Chinese, Hindi, Arabic, Russian) renders
// correctly on screen and in the PNG export, but scanning such an image back in
// will not work on the native build - mlkitEngine.js requests ML Kit's Latin
// script model only. Translating INTO those scripts is fine; reading them back
// is not.
export const NON_LATIN_TARGETS = new Set(["ja", "ko", "zh", "hi", "ar", "ru"]);
