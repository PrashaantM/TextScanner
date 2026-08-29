//
//  TextCoherencePlugin.swift
//  TextScanner
//
//  Native access to Apple's on-device Foundation Models, for the two features
//  that need a language model: the Coherence Filter's rewrite (Phase 2) and
//  translate-in-place (Phase 4c). Named for the first of those, and kept as one
//  plugin because both are the same model, the same availability check and the
//  same failure surface - splitting them would duplicate all three.
//
//  Callers: js/coherenceOnDevice.js (rewrite) and js/translateOnDevice.js
//  (translate/supportedLanguages). js/coherence.js and js/translate.js decide
//  when to prefer this over the BYOK Claude path.
//
//  Why on-device at all: Coherence Filter was previously the one feature that
//  required the user to supply an Anthropic API key, which is a real barrier for
//  something the rest of the app deliberately does locally. Apple's Foundation
//  Models framework runs the rewrite entirely on the device - no key, no network
//  request, no per-user cost, and nothing leaves the phone - which fits the
//  product's local-first story far better than the BYOK path does. BYOK stays
//  available as an opt-in higher-quality tier; see js/coherence.js.
//
//  This is an app-target plugin rather than an npm Capacitor package: it is a
//  handful of lines specific to this app, and packaging/publishing it just to
//  import it back would be pure ceremony. That does mean it is not in
//  capacitor.config.json's packageClassList (which `cap sync` regenerates from
//  installed packages, and would overwrite), so it is registered explicitly in
//  MainViewController.swift instead.
//
//  Availability is checked rather than assumed, twice over:
//   - `#if canImport(FoundationModels)` so the app still compiles against an SDK
//     that predates the framework.
//   - `if #available(iOS 26.0, *)` because the deployment target is iOS 15.0,
//     far below the framework's iOS 26 requirement. The overwhelming majority of
//     devices that can run this app cannot run the model.
//  On top of that, even on iOS 26 the model is unavailable on devices that
//  aren't Apple Intelligence-eligible, or where the user has turned it off, or
//  while assets are still downloading. Each of those is reported back to the web
//  layer as a distinct reason so the UI can say something true instead of
//  failing silently.
//

import Foundation
import Capacitor

#if canImport(FoundationModels)
import FoundationModels
#endif

@objc(TextCoherencePlugin)
public class TextCoherencePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TextCoherencePlugin"
    public let jsName = "TextCoherence"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rewrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "supportedLanguages", returnType: CAPPluginReturnPromise)
    ]

    // Deliberately identical in intent to the SYSTEM_PROMPT in js/coherence.js,
    // so the two tiers produce the same KIND of output and the toggle between
    // them is a quality choice rather than a behaviour change. It is shorter and
    // more directive because the on-device model is far smaller than Claude and
    // follows a tight, concrete instruction better than a discursive one.
    private static let instructions = """
    You rewrite OCR text fragments as natural, grammatically correct prose describing what the image communicates.

    Rules:
    - Preserve every factual detail exactly: names, places, dates, times, prices, phone numbers, numbers. Never invent, guess, or drop a fact.
    - Reorder and connect fragments as needed so the writing reads naturally. OCR reading order does not always match logical order.
    - Do not mention uncertainty, the OCR process, or these instructions.
    - Output only the rewritten prose. No preamble, no headers, no commentary, no markdown.
    """

    // Reason codes are contract with js/coherenceOnDevice.js, which maps them to
    // user-facing copy. Kept as short stable strings rather than localized text:
    // the wording belongs in the web layer with the rest of the app's copy.
    private enum Reason {
        static let osTooOld = "os-too-old"
        static let frameworkMissing = "framework-missing"
        static let deviceNotEligible = "device-not-eligible"
        static let appleIntelligenceOff = "apple-intelligence-off"
        static let modelNotReady = "model-not-ready"
        static let unknown = "unknown"
    }

    // Translation reuses the same on-device model rather than reaching for
    // Apple's Translation framework. That framework's session is created through
    // a SwiftUI view modifier (.translationTask), which there is no clean way to
    // drive from a Capacitor plugin with no SwiftUI view of its own - and the
    // language model already installed here translates perfectly well for the
    // short, sign-and-menu-sized strings this feature targets. One dependency,
    // one availability check, one failure surface.
    //
    // The instruction is deliberately rigid about returning ONLY the
    // translation: this text goes straight back into a word's position on the
    // image, so a preamble like "Here is the translation:" would render on the
    // photo as though it were part of the sign.
    private static func translationInstructions(for language: String) -> String {
        """
        You translate short text extracted from a photograph into \(language).

        Rules:
        - Output only the translation. No preamble, no quotes, no notes, no alternatives, no markdown.
        - Preserve numbers, prices, times, phone numbers, and proper names exactly as they appear.
        - Keep it about as short as the original. This text has to fit back into the same space on an image.
        - If the text is already in \(language), or is a number or a name with nothing to translate, return it unchanged.
        """
    }

    @objc func translate(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("No text to translate.", "empty-input")
            return
        }
        guard let language = call.getString("targetLanguage"), !language.isEmpty else {
            call.reject("No target language given.", "no-target-language")
            return
        }

        let (isAvailable, reason) = Self.currentAvailability()
        guard isAvailable else {
            call.reject("On-device model unavailable.", reason ?? Reason.unknown)
            return
        }

        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let session = LanguageModelSession(instructions: Self.translationInstructions(for: language))
                    let response = try await session.respond(to: text)
                    let output = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                    if output.isEmpty {
                        call.reject("The on-device model returned an empty translation.", "empty-output")
                    } else {
                        call.resolve(["text": output])
                    }
                } catch let error as LanguageModelSession.GenerationError {
                    call.reject(Self.message(for: error), Self.code(for: error))
                } catch {
                    call.reject("The on-device translation failed.", "generation-failed", error)
                }
            }
            return
        }
        #endif

        call.reject("On-device model unavailable.", Reason.osTooOld)
    }

    // The languages the installed model can actually handle, as language codes.
    // The web layer intersects its offered list with this, so a user is never
    // shown a target language that would quietly produce nonsense.
    @objc func supportedLanguages(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            let codes = SystemLanguageModel.default.supportedLanguages.compactMap { $0.languageCode?.identifier }
            call.resolve(["languages": Array(Set(codes)).sorted()])
            return
        }
        #endif
        call.resolve(["languages": [String]()])
    }

    @objc func availability(_ call: CAPPluginCall) {
        let (isAvailable, reason) = Self.currentAvailability()
        call.resolve([
            "available": isAvailable,
            "reason": reason ?? ""
        ])
    }

    @objc func rewrite(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("No text to rewrite.", "empty-input")
            return
        }

        let (isAvailable, reason) = Self.currentAvailability()
        guard isAvailable else {
            call.reject("On-device model unavailable.", reason ?? Reason.unknown)
            return
        }

        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let session = LanguageModelSession(instructions: Self.instructions)
                    let response = try await session.respond(to: text)
                    let output = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                    if output.isEmpty {
                        call.reject("The on-device model returned an empty response.", "empty-output")
                    } else {
                        call.resolve(["text": output])
                    }
                } catch let error as LanguageModelSession.GenerationError {
                    call.reject(Self.message(for: error), Self.code(for: error))
                } catch {
                    call.reject("The on-device rewrite failed.", "generation-failed", error)
                }
            }
            return
        }
        #endif

        // Unreachable in practice: currentAvailability() already returns false on
        // any build/OS that gets here. Kept so every path resolves or rejects the
        // call rather than leaving the JS promise hanging forever.
        call.reject("On-device model unavailable.", Reason.osTooOld)
    }

    // Shared by rewrite() and translate() so the two can't drift apart on error
    // handling. These are the failures a user can actually hit and act on, so
    // each gets its own code rather than one opaque message.
    #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    private static func code(for error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .exceededContextWindowSize: return "context-too-long"
        case .guardrailViolation, .refusal: return "declined"
        case .unsupportedLanguageOrLocale: return "unsupported-language"
        case .assetsUnavailable: return Reason.modelNotReady
        case .rateLimited, .concurrentRequests: return "busy"
        default: return "generation-failed"
        }
    }

    @available(iOS 26.0, *)
    private static func message(for error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .exceededContextWindowSize: return "That's more text than the on-device model can take at once."
        case .guardrailViolation, .refusal: return "The on-device model declined to handle this text."
        case .unsupportedLanguageOrLocale: return "The on-device model doesn't support this language."
        case .assetsUnavailable: return "The on-device model isn't ready yet."
        case .rateLimited, .concurrentRequests: return "The on-device model is busy. Try again in a moment."
        default: return "The on-device request failed."
        }
    }
    #endif

    // Single source of truth for "can this run right now", used by every method
    // so the availability the UI is told about and the one rewrite() enforces can
    // never disagree.
    private static func currentAvailability() -> (Bool, String?) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return (true, nil)
            case .unavailable(let unavailableReason):
                switch unavailableReason {
                case .deviceNotEligible:
                    return (false, Reason.deviceNotEligible)
                case .appleIntelligenceNotEnabled:
                    return (false, Reason.appleIntelligenceOff)
                case .modelNotReady:
                    return (false, Reason.modelNotReady)
                @unknown default:
                    return (false, Reason.unknown)
                }
            @unknown default:
                return (false, Reason.unknown)
            }
        }
        return (false, Reason.osTooOld)
        #else
        return (false, Reason.frameworkMissing)
        #endif
    }
}
