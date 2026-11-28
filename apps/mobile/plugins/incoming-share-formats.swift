  // Ordered semantic adapters. File-backed content wins over its text/URL preview.
  // Unknown exportable types use their original bytes; new formats normally need
  // no special handler. Add an adapter only when its representation needs decoding.
  private func parseProvider(_ provider: NSItemProvider) async -> SharePayload? {
    shareDiagnostic("provider", provider)
    if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier),
       let value = await loadShareItem(provider, identifier: UTType.propertyList.identifier) as? [String: Any],
       let page = value[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any],
       let url = page["url"] as? String {
      let text = [page["title"] as? String, url, page["selection"] as? String]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
      return SharePayload(type: .text, value: text, mimeType: "text/plain", metadata: nil)
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      if let file = await loadSharePayload(provider, identifier: UTType.fileURL.identifier) { return file }
      // Some hosts expose a URL they never grant read access to. A file representation
      // still hands over an owned copy inside the callback, so retry there before
      // failing the whole share.
      if let file = await loadFileRepresentation(provider, identifier: UTType.fileURL.identifier) { return file }
      shareDiagnostic("file URL unreadable", provider)
    }
    let formats: [(UTType, ShareType)] = [(.movie, .video), (.audio, .audio), (.directory, .file)]
    for (format, kind) in formats where provider.hasItemConformingToTypeIdentifier(format.identifier) {
      if let file = await loadShareFile(provider, format: format, kind: kind) { return file }
    }
    // Concrete exports (including ordinary property lists) win over previews.
    // Only the positively identified Safari envelope above is composer text.
    if let file = await loadShareFile(provider, format: .data, kind: .file, excludePlainText: true, excludeImages: true) { return file }
    // Concrete image files are primary exports; only abstract public.image
    // remains behind a source URL, where it commonly represents a thumbnail.
    if let image = await loadShareFile(provider, format: .image, kind: .image, includeAbstract: false) { return image }
    // Web links may also advertise a thumbnail; retain the actionable URL.
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
       let value = await loadShareItem(provider, identifier: UTType.url.identifier) {
      let text = (value as? String) ?? (value as? Data).flatMap { String(data: $0, encoding: .utf8) }
      let url = (value as? URL) ?? text.flatMap(URL.init(string:))
      if let url, !url.isFileURL {
        return SharePayload(type: .url, value: url.absoluteString, mimeType: "text/uri-list", metadata: nil)
      }
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
       let image = await loadShareFile(provider, format: .image, kind: .image) { return image }
    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
       let value = await loadShareItem(provider, identifier: UTType.plainText.identifier) {
      let text = (value as? String) ?? (value as? NSAttributedString)?.string
        ?? (value as? Data).flatMap { String(data: $0, encoding: .utf8) }
      if let text, !text.isEmpty {
        return SharePayload(type: .text, value: text, mimeType: "text/plain", metadata: nil)
      }
    }
    for identifier in provider.registeredTypeIdentifiers {
      guard let type = UTType(identifier), type.conforms(to: .plainText),
            let data = await loadShareData(provider, identifier: identifier) else { continue }
      let encoding: String.Encoding
      switch type {
      case .utf16PlainText:
        // Without a BOM, this representation uses the native iOS byte order.
        let hasBOM = data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff])
        encoding = hasBOM ? .utf16 : .utf16LittleEndian
      case .utf16ExternalPlainText:
        encoding = .utf16
      default:
        encoding = .utf8
      }
      if let text = String(data: data, encoding: encoding), !text.isEmpty {
        return SharePayload(type: .text, value: text, mimeType: "text/plain", metadata: nil)
      }
    }
    // PDF, Office, archives, vCard, calendar, HTML/RTF, models and custom exports.
    let fallback = await loadShareFile(provider, format: .data, kind: .file)
    if fallback == nil { shareDiagnostic("no representation accepted", provider) }
    return fallback
  }

  private func loadShareItem(_ provider: NSItemProvider, identifier: String) async -> NSSecureCoding? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: identifier, options: nil) { value, _ in
        continuation.resume(returning: value)
      }
    }
  }

  private func loadShareData(_ provider: NSItemProvider, identifier: String) async -> Data? {
    await withCheckedContinuation { continuation in
      provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in
        continuation.resume(returning: data)
      }
    }
  }

  private func loadFileRepresentation(_ provider: NSItemProvider, identifier: String) async -> SharePayload? {
    await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
        if let error { self.shareDiagnostic("file representation failed: \(error.localizedDescription)", provider) }
        // The host may recover an image (HEIC/TIFF/BMP or an extensionless
        // original) whose type cannot come from the unreadable source URL.
        // Classify the copy we actually receive so both copy paths keep the
        // conversion a readable image URL would have received.
        continuation.resume(returning: url.flatMap { self.copyShareFile(url: $0, type: self.fileShareType($0)) })
      }
    }
  }

  // Provider-owned URLs may omit resource values, so fall back to their bytes.
  private func copyShareFile(url: URL, type: ShareType) -> SharePayload? {
    let access = url.isFileURL && url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    if let file = copyAndProcessFile(url: url, type: type) { return file }
    guard url.isFileURL, let data = try? Data(contentsOf: url) else { return nil }
    let name = url.lastPathComponent.isEmpty ? UUID().uuidString : url.lastPathComponent
    return saveDataToAppGroup(
      data: data,
      fileName: name,
      type: type,
      mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
    )
  }

  // Console/Xcode only: names the representations a host actually exports, so a
  // rejected share can be diagnosed without guessing at its provider.
  private func shareDiagnostic(_ message: String, _ provider: NSItemProvider? = nil) {
    let types = provider?.registeredTypeIdentifiers.joined(separator: ",") ?? "-"
    print("[CindyShare] \(message) types=\(types) name=\(provider?.suggestedName ?? "-")")
  }

  private func loadShareFile(_ provider: NSItemProvider, format: UTType, kind: ShareType, excludePlainText: Bool = false, excludeImages: Bool = false, includeAbstract: Bool = true) async -> SharePayload? {
    // These exact representations are text previews. Concrete subtypes such as
    // Markdown and source code also conform to plainText, but remain files.
    let textPreviews = [UTType.plainText, .utf8PlainText, .utf16PlainText, .utf16ExternalPlainText]
      .map(\.identifier)
    let identifiers = provider.registeredTypeIdentifiers.filter {
      let type = UTType($0)
      return type?.conforms(to: format) == true && type?.conforms(to: .url) != true
        && (includeAbstract || $0 != format.identifier)
        && (!excludePlainText || !textPreviews.contains($0))
        && (!excludeImages || ($0 != UTType.data.identifier && type?.conforms(to: .image) != true))
    }
    for identifier in identifiers {
      // Copy inside the callback: provider-owned URLs expire when it returns.
      var file: SharePayload?
      // UIKit can serialize the abstract public.image representation as an
      // NSKeyedArchive, not image bytes. Decode its UIImage via loadItem below.
      if identifier != UTType.image.identifier {
        file = await withCheckedContinuation { continuation in
          provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
            continuation.resume(returning: url.flatMap { self.copyShareFile(url: $0, type: kind) })
          }
        }
      }
      if let file { return file }
      if let file = await loadSharePayload(provider, identifier: identifier, kind: kind) { return file }
    }
    return nil
  }

  private func loadSharePayload(_ provider: NSItemProvider, identifier: String, kind: ShareType? = nil) async -> SharePayload? {
    func receive(_ value: NSSecureCoding?) -> SharePayload? {
      // URL lifetime belongs to this callback, including loadItem fallbacks.
      // Only an explicitly advertised file-URL representation grants a data
      // value URL semantics; ordinary file/image bytes are never paths.
      // Hosts export a file URL as NSURL, Data-encoded UTF-8 or a bare path.
      var declaredURL: URL?
      if identifier == UTType.fileURL.identifier {
        let text = (value as? String) ?? (value as? Data).flatMap { String(data: $0, encoding: .utf8) }
        if let text, !text.isEmpty {
          declaredURL = text.hasPrefix("file://") ? URL(string: text) : URL(fileURLWithPath: text)
        }
      }
      if let url = (value as? URL) ?? declaredURL {
        return self.copyShareFile(url: url, type: kind ?? self.fileShareType(url))
      }
      guard let kind, let data = (value as? Data) ?? (value as? UIImage)?.pngData() else {
        return nil
      }
      let isRenderedImage = value is UIImage
      var type = isRenderedImage ? UTType.png : UTType(identifier)
      if !isRenderedImage, identifier == UTType.image.identifier {
        // UIKit can vend a keyed archive for public.image. Only save actual image bytes.
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let identifier = CGImageSourceGetType(source),
              let imageType = UTType(identifier as String), imageType.conforms(to: .image) else { return nil }
        type = imageType
      }
      let ext = type?.preferredFilenameExtension ?? "bin"
      let suggested = provider.suggestedName.map { URL(fileURLWithPath: $0).lastPathComponent } ?? UUID().uuidString
      let name = suggested.isEmpty || suggested == "." || suggested == ".." ? UUID().uuidString : suggested
      let filename = isRenderedImage ? (name as NSString).deletingPathExtension + ".png"
        : (name as NSString).pathExtension.isEmpty ? name + "." + ext : name
      return self.saveDataToAppGroup(data: data, fileName: filename, type: kind, mimeType: type?.preferredMIMEType)
    }
    let payload: SharePayload? = await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: identifier, options: nil) { value, _ in
        continuation.resume(returning: receive(value))
      }
    }
    if let payload { return payload }
    // The generic file pass can see media too. Keep these exports file-backed.
    guard let kind, let type = UTType(identifier), !type.conforms(to: .audiovisualContent),
          !type.conforms(to: .directory), !type.conforms(to: .url),
          let data = await loadShareData(provider, identifier: identifier) else { return nil }
    return receive(data as NSData)
  }

  private func fileShareType(_ url: URL) -> ShareType {
    guard url.isFileURL else { return .file }
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
      ?? UTType(filenameExtension: url.pathExtension)
    if type?.conforms(to: .image) == true { return .image }
    // Inspect only the original's image header, without decoding its pixels.
    // Other representations on the provider may be unrelated thumbnails.
    if url.pathExtension.isEmpty,
       let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
       let identifier = CGImageSourceGetType(source),
       UTType(identifier as String)?.conforms(to: .image) == true { return .image }
    return .file
  }
