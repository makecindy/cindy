#if os(macOS)
import AppKit

struct CredentialLabels {
  private let values: [String: String]
  init(locale: String) throws {
    guard let url = Bundle.module.url(forResource: "credentials", withExtension: "json"),
      let catalog = try? JSONDecoder().decode([String: [String: String]].self, from: Data(contentsOf: url)),
      let values = catalog[locale] ?? catalog["en"] else { throw CredentialError.unavailable }
    self.values = values
  }
  subscript(_ key: String) -> String { values[key] ?? key }
}

/// AppKit owns the secure field and its lifetime. No password crosses stdio.
@MainActor
final class CredentialPasswordForm: NSObject, NSWindowDelegate {
  private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 220),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
  private let password = NSSecureTextField()
  private let completion: (Result<(Data, Bool), CredentialError>) -> Void
  private var finished = false
  init(labels: CredentialLabels, account: String, saveRequired: Bool,
    completion: @escaping (Result<(Data, Bool), CredentialError>) -> Void) {
    self.completion = completion
    super.init()
    panel.title = labels["title"]; panel.delegate = self; panel.isReleasedWhenClosed = false
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    let content = panel.contentView!; content.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
      stack.widthAnchor.constraint(equalToConstant: 312),
    ])
    let heading = NSStackView(); heading.spacing = 12; heading.alignment = .centerY
    let icon = NSImageView(image: NSImage(systemSymbolName: "lock.fill", accessibilityDescription: nil)!)
    icon.contentTintColor = .secondaryLabelColor
    icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 24, weight: .regular)
    icon.widthAnchor.constraint(equalToConstant: 32).isActive = true
    icon.setAccessibilityElement(false)
    let identity = NSStackView(); identity.orientation = .vertical; identity.alignment = .leading; identity.spacing = 4
    let title = NSTextField(wrappingLabelWithString: labels["title"])
    title.font = .systemFont(ofSize: 15, weight: .semibold)
    let accountLabel = NSTextField(wrappingLabelWithString: String(format: labels["accountFormat"], account))
    accountLabel.font = .systemFont(ofSize: 13); accountLabel.textColor = .secondaryLabelColor
    identity.addArrangedSubview(title); identity.addArrangedSubview(accountLabel)
    heading.addArrangedSubview(icon); heading.addArrangedSubview(identity)
    stack.addArrangedSubview(heading)
    heading.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    password.placeholderString = labels["password"]; password.setAccessibilityLabel(labels["password"])
    password.controlSize = .regular; password.font = .systemFont(ofSize: 13)
    stack.addArrangedSubview(password)
    password.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    // Keep the native cell and field editor at their intrinsic height. Stretching
    // the bezel leaves the secure glyphs and insertion caret aligned to its top.
    password.setContentHuggingPriority(.required, for: .vertical)
    stack.setCustomSpacing(8, after: password)
    let explanation = NSTextField(wrappingLabelWithString: labels["explanation"])
    explanation.font = .systemFont(ofSize: 12)
    explanation.textColor = .secondaryLabelColor; stack.addArrangedSubview(explanation)
    explanation.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    let buttons = NSStackView(); buttons.spacing = 8
    let spacer = NSView(); buttons.addArrangedSubview(spacer)
    let cancel = NSButton(title: labels["cancel"], target: self, action: #selector(cancelAction)); cancel.keyEquivalent = "\u{1b}"
    let verify = NSButton(title: labels["verify"], target: self, action: #selector(verifyAction)); verify.keyEquivalent = "\r"
    buttons.addArrangedSubview(cancel); buttons.addArrangedSubview(verify); stack.addArrangedSubview(buttons)
    buttons.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    for button in [cancel, verify] {
      button.controlSize = .regular
      button.setContentHuggingPriority(.required, for: .horizontal)
      button.setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    // Size to localized content instead of reserving an empty lower half.
    content.layoutSubtreeIfNeeded()
    panel.setContentSize(content.fittingSize)
  }
  func present(theme: String) {
    panel.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
    panel.center(); NSApp.activate(ignoringOtherApps: true); panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(password)
  }
  @objc private func verifyAction() {
    let data = Data(password.stringValue.utf8)
    guard !data.isEmpty, data.count <= 4096, !data.contains(0) else { NSSound.beep(); return }
    finish(.success((data, true)))
  }
  @objc private func cancelAction() { cancel() }
  func cancel() { finish(.failure(.cancelled)) }
  func windowShouldClose(_ sender: NSWindow) -> Bool { cancel(); return false }
  private func finish(_ result: Result<(Data, Bool), CredentialError>) {
    guard !finished else { return }; finished = true
    password.stringValue = ""; panel.orderOut(nil); panel.close(); completion(result)
  }
}
#endif
