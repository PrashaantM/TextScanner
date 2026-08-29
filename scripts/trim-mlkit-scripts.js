#!/usr/bin/env node
// trim-mlkit-scripts.js: removes four unused ML Kit script models from the
// installed @capacitor-mlkit/text-recognition package, as an npm postinstall
// step.
//
// Why: that package hard-depends on all five text-recognition models - Latin,
// Chinese, Devanagari, Japanese and Korean - and its Swift imports all five
// unconditionally, so every one is compiled into the app. js/mlkitEngine.js
// requests `script: "LATIN"` and nothing else, and always has, which leaves
// roughly 13 MB of models in the binary that no code path can reach.
//
// Why a patch rather than configuration: CocoaPods has no way to drop a
// transitive dependency, and both overrides are worse. A `:podspec` override
// makes CocoaPods treat the pod as remote and try to clone the upstream repo at
// a tag that doesn't exist; a `:path` override needs a directory containing the
// sources, meaning either vendor code duplicated into this repo or a symlink
// into node_modules - the exact fragility Phase 0 removed from test/.
//
// TWO files have to change together, which is the whole reason this is one
// script with a rollback rather than two edits: dropping the pods without
// dropping the imports fails the build outright (`unable to resolve module
// dependency: 'MLKitTextRecognitionChinese'`). So both are written only if both
// patches apply, and anything unexpected restores both. The failure mode is a
// larger binary, never a broken build.
//
// After patching, a request for a non-Latin script falls through to the Latin
// recognizer rather than failing - the plugin's own `default` branch. That is
// unchanged behaviour for this app, which never asks for anything else.
//
// TO RE-ADD A SCRIPT: delete its entry from SCRIPTS below, run `npm install`
// (which restores the package first), then `pod install` in ios/App, and pass
// the matching `script` value from mlkitEngine.js.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = join(ROOT, "node_modules/@capacitor-mlkit/text-recognition");
const PODSPEC = join(PKG, "CapacitorMlkitTextRecognition.podspec");
const SWIFT = join(PKG, "ios/Plugin/TextRecognition.swift");

const SCRIPTS = [
  { module: "MLKitTextRecognitionChinese", pod: "TextRecognitionChinese", caseValue: "CHINESE", options: "ChineseTextRecognizerOptions" },
  { module: "MLKitTextRecognitionDevanagari", pod: "TextRecognitionDevanagari", caseValue: "DEVANAGARI", options: "DevanagariTextRecognizerOptions" },
  { module: "MLKitTextRecognitionJapanese", pod: "TextRecognitionJapanese", caseValue: "JAPANESE", options: "JapaneseTextRecognizerOptions" },
  { module: "MLKitTextRecognitionKorean", pod: "TextRecognitionKorean", caseValue: "KOREAN", options: "KoreanTextRecognizerOptions" },
];

const MARKER = "trimmed by scripts/trim-mlkit-scripts.js";

function trimPodspec(source) {
  let out = source;
  let removed = 0;
  for (const { pod } of SCRIPTS) {
    const re = new RegExp(`^[ \\t]*s\\.dependency 'GoogleMLKit/${pod}'.*\\r?\\n`, "m");
    if (!re.test(out)) continue;
    out = out.replace(re, "");
    removed++;
  }
  if (removed !== SCRIPTS.length) return null;
  return `# ${MARKER}\n# Only the Latin model is ever requested (js/mlkitEngine.js). The other four\n# were about 13 MB of unreachable binary. Re-add them there and here together.\n${out}`;
}

function trimSwift(source) {
  let out = source;
  for (const { module, caseValue, options } of SCRIPTS) {
    const importRe = new RegExp(`^import ${module}\\r?\\n`, "m");
    const caseRe = new RegExp(`^[ \\t]*case "${caseValue}":\\r?\\n[ \\t]*return ${options}\\(\\)\\r?\\n`, "m");
    if (!importRe.test(out) || !caseRe.test(out)) return null;
    out = out.replace(importRe, "").replace(caseRe, "");
  }
  return `// ${MARKER}: imports and cases for the four non-Latin scripts removed,\n// along with their pods. A non-Latin script now falls through to the Latin\n// recognizer via the default branch below.\n${out}`;
}

async function main() {
  let podspecSource;
  let swiftSource;
  try {
    podspecSource = await readFile(PODSPEC, "utf8");
    swiftSource = await readFile(SWIFT, "utf8");
  } catch {
    // The plugin isn't installed yet, or its layout changed. Not worth failing
    // an install over.
    return;
  }

  if (podspecSource.includes(MARKER) && swiftSource.includes(MARKER)) return;
  // Half-applied (an interrupted run, or a partial reinstall). Leave it alone
  // and say so, rather than patching one side of a pair that must match.
  if (podspecSource.includes(MARKER) !== swiftSource.includes(MARKER)) {
    console.warn("ML Kit trim is half-applied; run `npm install` to restore the package, then retry.");
    return;
  }

  const podspecOut = trimPodspec(podspecSource);
  const swiftOut = trimSwift(swiftSource);
  if (!podspecOut || !swiftOut) {
    console.warn("ML Kit trim skipped: the plugin's podspec or Swift no longer matches the expected shape.");
    return;
  }

  await writeFile(PODSPEC, podspecOut);
  try {
    await writeFile(SWIFT, swiftOut);
  } catch (err) {
    // Never leave the podspec trimmed without the Swift: that combination does
    // not compile.
    await writeFile(PODSPEC, podspecSource);
    throw err;
  }

  console.log(`Trimmed ${SCRIPTS.length} unused ML Kit script models (~13 MB). Run \`pod install\` in ios/App to apply.`);
}

main().catch((err) => {
  console.warn("Could not trim ML Kit script models:", err.message);
});
