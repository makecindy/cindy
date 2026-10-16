// Appended to Expo's generated controller by with-incoming-share-feedback.js.
// UIKit's standard alert owns Light/Dark colors, Dynamic Type and accessibility.
//
// A share can fail in two ways the user cannot tell apart from the alert alone:
// nothing was received at all, or the received item could not be stored for the
// app. Each keeps its own copy, and a failure also records the diagnostic the
// loader collected (see incoming-share-loader.swift).
enum ShareFeedback: String {
  case received
  case failed
  case saveFailed
}

private extension ShareIntoViewController {
  func finishOpening(opened: Bool) {
    guard !shareClosed, !openResultHandled else { return }
    openResultHandled = true
    if opened {
      close()
    } else {
      // The payload remains in the existing App Group slot for manual opening.
      showShareFeedback(.received)
    }
  }

  func showShareFeedback(_ outcome: ShareFeedback) {
    guard !shareClosed else { return }
    if outcome != .received {
      writeShareDiagnostic()
    }
    let prefix = outcome.rawValue
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
