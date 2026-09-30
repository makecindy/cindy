const fs = require("node:fs");
const path = require("node:path");
const strings = require("./incoming-share-strings.json");

// Runs after the file-ownership patch. Keep the upstream launch strategy, but
// never finish the extension before knowing whether it opened the containing app.
function patchShareFeedback(source) {
  const replace = (from, to, count = 1) => {
    if (source.split(from).length - 1 !== count) {
      throw new Error(
        "expo-sharing template changed; review incoming-share feedback patch",
      );
    }
    source = source.split(from).join(to);
  };
  replace(
    "  private var shareStarted = false",
    "  private var shareStarted = false\n  private var shareClosed = false\n  private var openResultHandled = false",
  );
  // Alerts need a presenter that is already on screen (including very fast failures).
  replace("viewWillAppear", "viewDidAppear", 3);
  replace(
    "    handleShare()\n    super.viewDidAppear(animated)",
    "    super.viewDidAppear(animated)\n    handleShare()",
  );
  replace(
    "      self.extensionContext?.completeRequest(returningItems: nil)",
    "      showShareFeedback(received: false)",
  );
  replace(
    "      if !payload.isEmpty {",
    "      guard !shareClosed else { return }\n      if !payload.isEmpty {",
  );
  replace(
    "          self.close()\n          return",
    "          showShareFeedback(received: false)\n          return",
  );
  replace(
    "        self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)",
    "        showShareFeedback(received: false)",
  );
  replace(
    "    openURL(url)\n    self.close()",
    `    // Some hosts never call the open completion. Bound the wait without retrying.
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      self?.finishOpening(opened: false)
    }
    openURL(url)`,
  );
  replace(
    "        application.open(url, options: [:], completionHandler: nil)",
    `        application.open(url, options: [:]) { [weak self] opened in
          DispatchQueue.main.async { self?.finishOpening(opened: opened) }
        }
        return`,
  );
  replace(
    "      responder = responder?.next\n    }\n  }",
    "      responder = responder?.next\n    }\n    finishOpening(opened: false)\n  }",
  );
  replace(
    "  private func close() {",
    `  override func didSelectCancel() {
    close()
  }

  private func close() {
    guard !shareClosed else { return }
    shareClosed = true`,
  );
  const swiftStrings = Object.entries(strings)
    .map(
      ([locale, values]) =>
        `    ${JSON.stringify(locale)}: [${Object.entries(values)
          .map(
            ([key, value]) =>
              `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
          )
          .join(", ")}]`,
    )
    .join(",\n");
  return (
    source +
    "\n" +
    fs
      .readFileSync(
        path.join(__dirname, "incoming-share-feedback.swift"),
        "utf8",
      )
      .replace("/* LOCALIZED_STRINGS */", swiftStrings)
  );
}

module.exports = { patchShareFeedback };
