// Appended to Expo's generated controller by with-incoming-share-files.js.
//
// Files shared by another app must be copied with loadFileRepresentation: the
// system then hands the extension a copy inside its own temporary directory, so
// the extension never reads the vending app's container. That URL is only valid
// until the callback returns, which is why the copy happens inside the callback.
// loadItem stays as the fallback for providers that only vend an image object or
// a raw file URL; a URL provided that way belongs to the other app and needs a
// security scope around the copy.
//
// Failures are recorded without file names or paths: the shared diagnostic keeps
// only the failing step, the provider's type identifiers and the error domain and
// code, so a field report can be diagnosed from the app's debug log.
struct IncomingShareFailure {
  var step: String
  var types: [String]
  var error: String?

  var json: Data? {
    var object: [String: Any] = ["step": step, "types": types]
    if let error {
      object["error"] = error
    }
    return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }
}

private extension ShareIntoViewController {
  func loadFilePayload(_ provider: NSItemProvider, identifier: String, type: ShareType) async -> SharePayload? {
    if let payload = await loadFileRepresentation(provider, identifier: identifier, type: type) {
      return payload
    }
    return await loadItem(provider, identifier: identifier, type: type)
  }

  private func loadFileRepresentation(_ provider: NSItemProvider, identifier: String, type: ShareType) async -> SharePayload? {
    return await withCheckedContinuation { (continuation: CheckedContinuation<SharePayload?, Never>) in
      provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
        guard let url else {
          self.recordShareFailure(step: "file-representation", types: [identifier], error: error)
          continuation.resume(returning: nil)
          return
        }
        let result = self.copyAndProcessFile(url: url, type: type)
        if result == nil {
          self.recordShareFailure(step: "file-representation-copy", types: [identifier])
        }
        continuation.resume(returning: result)
      }
    }
  }

  private func loadItem(_ provider: NSItemProvider, identifier: String, type: ShareType) async -> SharePayload? {
    return await withCheckedContinuation { (continuation: CheckedContinuation<SharePayload?, Never>) in
      provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, error in
        if let url = item as? URL {
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          let result = self.copyAndProcessFile(url: url, type: type)
          if result == nil {
            self.recordShareFailure(step: "copy", types: [identifier])
          }
          continuation.resume(returning: result)
          return
        }

        if let data = item as? Data {
          let fileName = UUID().randomFilename(forTypeIdentifier: identifier)
          let result = self.saveDataToAppGroup(
            data: data,
            fileName: fileName,
            type: type,
            mimeType: UTType(identifier)?.preferredMIMEType
          )
          if result == nil {
            self.recordShareFailure(step: "write-data", types: [identifier])
          }
          continuation.resume(returning: result)
          return
        }

        if type == .image, let image = item as? UIImage, let data = image.pngData() {
          let fileName = UUID().uuidString + ".png"
          let result = self.saveDataToAppGroup(data: data, fileName: fileName, type: .image, mimeType: "image/png")
          if result == nil {
            self.recordShareFailure(step: "write-image", types: [identifier])
          }
          continuation.resume(returning: result)
          return
        }

        self.recordShareFailure(step: "load-item", types: [identifier], error: error)
        continuation.resume(returning: nil)
      }
    }
  }

  func recordShareFailure(step: String, types: [String] = [], error: Error? = nil) {
    var failure = shareFailure ?? IncomingShareFailure(step: step, types: [], error: nil)
    failure.step = step
    for type in types where !failure.types.contains(type) {
      failure.types.append(type)
    }
    if let error {
      let error = error as NSError
      failure.error = "\(error.domain):\(error.code)"
    }
    shareFailure = failure
  }

  /// Best effort: a failed slot write is exactly what leaves no diagnostic
  /// behind, so a missing record is expected and never shown to the user.
  func writeShareDiagnostic() {
    guard let data = shareFailure?.json else { return }
    try? IncomingShareSlot.writeDiagnostic(data, group: appGroupId)
  }
}
