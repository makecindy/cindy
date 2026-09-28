// Appended to Expo's generated controller by with-incoming-share-feedback.js.
// UIKit's standard alert owns Light/Dark colors, Dynamic Type and accessibility.
private extension ShareIntoViewController {
  func finishOpening(opened: Bool) {
    guard !shareClosed, !openResultHandled else { return }
    openResultHandled = true
    if opened {
      close()
    } else {
      // The payload remains in the existing App Group slot for manual opening.
      showShareFeedback(received: true)
    }
  }

  func showShareFeedback(received: Bool) {
    guard !shareClosed else { return }
    let prefix = received ? "received" : "failed"
    let alert = UIAlertController(
      title: shareString(prefix + "Title"),
      message: shareString(prefix + "Message"),
      preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: shareString("done"), style: .default) { [weak self] _ in
      self?.close()
    })
    present(alert, animated: true)
  }

  func shareString(_ key: String) -> String {
    let locale = Bundle.preferredLocalizations(
      from: Self.shareStrings.keys.sorted(), forPreferences: Locale.preferredLanguages
    ).first ?? "en"
    return Self.shareStrings[locale]?[key] ?? Self.shareStrings["en"]![key]!
  }

  static let shareStrings: [String: [String: String]] = [
/* LOCALIZED_STRINGS */
  ]
}
