//
//  MainViewController.swift
//  TextScanner
//
//  Exists for exactly one reason: to register TextCoherencePlugin.
//
//  Capacitor auto-registers plugins listed in the generated
//  ios/App/App/capacitor.config.json "packageClassList", which `cap sync`
//  rebuilds from the installed npm packages every time it runs. An app-target
//  plugin (see TextCoherencePlugin.swift for why this one is in-app rather than
//  an npm package) can never appear in that list, so it has to be registered by
//  hand - and capacitorDidLoad() is the documented hook for it, called after the
//  bridge exists but before the web view loads, which is early enough that the
//  plugin is present the first time page JS asks for it.
//
//  Base.lproj/Main.storyboard points its root view controller at this class
//  instead of CAPBridgeViewController. If that ever gets reset (a fresh
//  `cap add ios`, say), the symptom is silent: the app runs fine, but
//  window.Capacitor.Plugins.TextCoherence is undefined and js/coherence.js
//  quietly falls back to the BYOK Claude path as though the device were
//  ineligible.
//

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(TextCoherencePlugin())
    }
}
