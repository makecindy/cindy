import ExpoModulesCore
import UIKit
import AVFoundation
import UniformTypeIdentifiers

public class CindyRemotePresentationModule: Module {
  private var previousAudio: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  public func definition() -> ModuleDefinition {
    Name("CindyRemotePresentation")
    AsyncFunction("clipboardVersion") { () -> String in
      try RemoteClipboard.foreground()
      return String(UIPasteboard.general.changeCount)
    }.runOnQueue(.main)
    AsyncFunction("syncClipboard") { (json: String, version: String) -> String in
      try RemoteClipboard.foreground()
      guard String(UIPasteboard.general.changeCount) == version else {
        throw RemoteClipboard.failure("CLIPBOARD_CHANGED")
      }
      try RemoteClipboard.write(json, expectedVersion: version)
      return String(UIPasteboard.general.changeCount)
    }.runOnQueue(.main)
    AsyncFunction("readClipboard") { () -> String in
      try RemoteClipboard.read()
    }.runOnQueue(.main)
    AsyncFunction("writeClipboard") { (json: String) in
      try RemoteClipboard.write(json)
    }.runOnQueue(.main)
    AsyncFunction("rotate") { (landscape: Bool, promise: Promise) in
      guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive }) else {
        promise.reject("NO_SCENE", "No active screen"); return
      }
      scene.windows.first(where: { $0.isKeyWindow })?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
      var settled = false
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscapeRight : .portrait)) { error in
        if !settled { settled = true; promise.reject("ROTATION_FAILED", error.localizedDescription) }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        if !settled {
          settled = true
          if scene.interfaceOrientation.isLandscape == landscape { promise.resolve(nil) }
          else { promise.reject("ROTATION_FAILED", "Screen orientation did not change") }
        }
      }
    }.runOnQueue(.main)
    AsyncFunction("playback") { (enabled: Bool) in
      let session = AVAudioSession.sharedInstance()
      if enabled {
        if self.previousAudio == nil { self.previousAudio = (session.category, session.mode, session.categoryOptions) }
        try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try session.setActive(true)
      } else if let previous = self.previousAudio {
        // Do not overwrite a newer voice/audio owner's category.
        if session.category == .playback && session.mode == .moviePlayback
          && session.categoryOptions == [.mixWithOthers] {
          // Release playback before restoring a potentially non-mixing category.
          try session.setActive(false, options: .notifyOthersOnDeactivation)
          try session.setCategory(previous.0, mode: previous.1, options: previous.2)
        }
        self.previousAudio = nil
      }
    }.runOnQueue(.main)
  }
}

/** One atomic portable item; never dereference clipboard file URLs. */
enum RemoteClipboard {
  static let limit = RemoteClipboardSize.limit
  static func failure(_ code: String) -> NSError {
    NSError(domain: "CindyClipboard", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }
  static func foreground() throws {
    guard UIApplication.shared.applicationState == .active else { throw failure("DESKTOP_LEASE_EXPIRED") }
  }
  static func read() throws -> String {
    try foreground()
    let board = UIPasteboard.general
    let version = board.changeCount
    let items = board.items
    guard !items.isEmpty else { throw failure("CLIPBOARD_EMPTY") }
    guard items.count == 1 else { throw failure("CLIPBOARD_UNSUPPORTED") }
    let item = items[0]
    // UIKit resolves the source app's alternative image representations. Do not
    // guess an encoding by sorting UTIs, or reject a real image merely because
    // the same item includes its source URL. Never dereference those URLs here.
    let image = board.image
    if image == nil && item.keys.contains(where: { UTType($0)?.conforms(to: .fileURL) == true }) {
      throw failure("CLIPBOARD_UNSUPPORTED")
    }
    var result: [String: String] = [:]
    func string(_ type: String) throws -> String? {
      if let string = item[type] as? String {
        guard RemoteClipboardSize.accepts(string) else { throw failure("CLIPBOARD_TOO_LONG") }
        return string.isEmpty ? nil : string
      }
      if let data = item[type] as? Data {
        guard RemoteClipboardSize.acceptsUTF8Bytes(data) else { throw failure("CLIPBOARD_TOO_LONG") }
        guard let string = String(data: data, encoding: .utf8) else { throw failure("CLIPBOARD_UNSUPPORTED") }
        guard RemoteClipboardSize.accepts(string) else { throw failure("CLIPBOARD_TOO_LONG") }
        return string.isEmpty ? nil : string
      }
      return nil
    }
    for type in ["public.utf8-plain-text", "public.text", "public.plain-text"] {
      if let text = try string(type) { result["text"] = text; break }
    }
    result["html"] = try string("public.html")
    result["rtf"] = try string("public.rtf")
    if let raw = item["public.url"] {
      let url = (raw as? URL) ?? (raw as? String).flatMap(URL.init(string:))
      if let url = url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        result["url"] = url.absoluteString
      } else if image == nil {
        throw failure("CLIPBOARD_UNSUPPORTED")
      }
    }
    if let image = image {
      guard (image.images?.count ?? 1) <= 1 else { throw failure("CLIPBOARD_UNSUPPORTED") }
      guard image.size.width * image.scale * image.size.height * image.scale <= 64_000_000 else {
        throw failure("CLIPBOARD_TOO_LONG")
      }
      guard let png = image.pngData() else { throw failure("CLIPBOARD_UNSUPPORTED") }
      guard png.count <= limit * 3 / 4 else { throw failure("CLIPBOARD_TOO_LONG") }
      result["png"] = png.base64EncodedString()
    }
    guard !result.isEmpty else { throw failure("CLIPBOARD_UNSUPPORTED") }
    try foreground()
    guard version == board.changeCount else { throw failure("CLIPBOARD_CHANGED") }
    let data = try JSONSerialization.data(withJSONObject: result)
    let json = String(data: data, encoding: .utf8)!
    guard RemoteClipboardSize.accepts(json) else { throw failure("CLIPBOARD_TOO_LONG") }
    return json
  }

  static func write(_ json: String, expectedVersion: String? = nil) throws {
    try foreground()
    guard RemoteClipboardSize.accepts(json) else { throw failure("CLIPBOARD_TOO_LONG") }
    guard let data = json.data(using: .utf8),
      let content = try JSONSerialization.jsonObject(with: data) as? [String: String],
      !content.isEmpty,
      content.keys.allSatisfy({ ["text", "html", "rtf", "url", "png"].contains($0) })
    else { throw failure("CLIPBOARD_UNSUPPORTED") }
    var item: [String: Any] = [:]
    if let text = content["text"] { item["public.utf8-plain-text"] = text }
    if let html = content["html"] { item["public.html"] = Data(html.utf8) }
    if let rtf = content["rtf"] { item["public.rtf"] = Data(rtf.utf8) }
    if let string = content["url"] {
      guard let url = URL(string: string), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
        throw failure("CLIPBOARD_UNSUPPORTED")
      }
      item["public.url"] = url
    }
    if let encoded = content["png"] {
      guard let png = Data(base64Encoded: encoded), png.count >= 24,
        Array(png.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] else { throw failure("CLIPBOARD_UNSUPPORTED") }
      let width = png[16..<20].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
      let height = png[20..<24].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
      guard width > 0, height > 0, width * height <= 64_000_000,
        UIImage(data: png) != nil else { throw failure("CLIPBOARD_UNSUPPORTED") }
      item["public.png"] = png
    }
    try foreground()
    if let expectedVersion = expectedVersion, String(UIPasteboard.general.changeCount) != expectedVersion {
      throw failure("CLIPBOARD_CHANGED")
    }
    UIPasteboard.general.setItems([item], options: [:])
  }
}
