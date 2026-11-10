// Appended to Expo's generated controller by with-incoming-share-feedback.js.
// UIKit's standard alert owns Light/Dark colors, Dynamic Type and accessibility.
private extension ShareIntoViewController {
  func showShareProgress() {
    view.backgroundColor = .systemBackground
    let progress = UIActivityIndicatorView(style: .medium)
    progress.startAnimating()
    let label = UILabel()
    label.text = shareString("receiving")
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .label
    label.textAlignment = .center
    label.numberOfLines = 0
    let cancel = UIButton(configuration: .plain())
    cancel.setTitle(shareString("cancel"), for: .normal)
    cancel.addAction(UIAction { [weak self] _ in self?.didSelectCancel() }, for: .touchUpInside)
    cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    let content = UIStackView(arrangedSubviews: [progress, label, cancel])
    content.axis = .vertical
    content.alignment = .center
    content.spacing = 12
    content.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(content)
    NSLayoutConstraint.activate([
      content.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      content.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      content.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      content.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      label.widthAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.widthAnchor, constant: -48),
    ])
  }

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

  func showShareFeedback(received: Bool, tooMany: Bool = false) {
    guard !shareClosed else { return }
    let prefix = tooMany ? "tooMany" : received ? "received" : "failed"
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
