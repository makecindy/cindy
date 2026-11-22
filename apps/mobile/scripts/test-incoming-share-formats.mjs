// Execute the production adapter with real NSItemProvider and UTType behavior.
// UIKit image decoding and App Group destinations are outside these file tests.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.error('[share-formats] SKIP: Apple frameworks unavailable');
  process.exit(77);
}
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../plugins/incoming-share-formats.swift'), 'utf8');
const harness = `
import Foundation
import UniformTypeIdentifiers
import ImageIO
let testRoot = URL(fileURLWithPath: CommandLine.arguments[1])
let NSExtensionJavaScriptPreprocessingResultsKey = "NSExtensionJavaScriptPreprocessingResultsKey"
class UIImage: NSObject { func pngData() -> Data? { nil } }
final class EphemeralProvider: NSItemProvider {
  var url: URL!
  var encodedURL = false
  override func loadItem(forTypeIdentifier identifier: String, options: [AnyHashable: Any]? = nil, completionHandler: NSItemProvider.CompletionHandler? = nil) {
    Thread.current.threadDictionary["owning-provider-callback"] = true
    let value: NSSecureCoding = encodedURL ? NSData(data: Data(url.absoluteString.utf8)) : url as NSURL
    completionHandler?(value, nil)
    Thread.current.threadDictionary.removeObject(forKey: "owning-provider-callback")
    try? FileManager.default.removeItem(at: url)
  }
  // An ephemeral provider has no file representation. Fail fast instead of
  // leaking a continuation if a broken copy path falls through to it.
  override func loadFileRepresentation(forTypeIdentifier identifier: String, completionHandler: @escaping (URL?, Error?) -> Void) -> Progress {
    completionHandler(nil, CocoaError(.fileReadUnsupportedScheme))
    return Progress(totalUnitCount: 0)
  }
}
// A modern provider can vend bytes without implementing legacy loadItem
// or supplying a temporary file for loadFileRepresentation.
final class BytesProvider: NSItemProvider {
  override func loadItem(forTypeIdentifier identifier: String, options: [AnyHashable: Any]? = nil, completionHandler: NSItemProvider.CompletionHandler? = nil) {
    completionHandler?(nil, CocoaError(.fileReadUnsupportedScheme))
  }
  override func loadFileRepresentation(forTypeIdentifier identifier: String, completionHandler: @escaping (URL?, Error?) -> Void) -> Progress {
    completionHandler(nil, CocoaError(.fileReadUnsupportedScheme))
    return Progress(totalUnitCount: 0)
  }
}
// A host that advertises a file URL it never grants read access to, but still
// hands over an owned copy through loadFileRepresentation. loadItem must stay
// unreadable, otherwise the test silently exercises the direct-URL path.
final class UnreadableURLProvider: NSItemProvider {
  var unavailable: URL!
  var copy: URL!
  override func loadItem(forTypeIdentifier identifier: String, options: [AnyHashable: Any]? = nil, completionHandler: NSItemProvider.CompletionHandler? = nil) {
    completionHandler?(unavailable as NSURL, nil)
  }
  override func loadFileRepresentation(forTypeIdentifier identifier: String, completionHandler: @escaping (URL?, Error?) -> Void) -> Progress {
    completionHandler(copy, nil)
    return Progress(totalUnitCount: 0)
  }
}
enum ShareType { case text, url, image, video, audio, file }
struct SharePayload { let type: ShareType; let value: String; let mimeType: String?; let metadata: String? }
final class Adapter {
  var requireProviderCallback = false
  // A provider-owned URL can omit resource values: the ordinary copy fails
  // even though its bytes are still readable. This switch exercises the
  // byte-refetch success branch without making the bytes unreadable too.
  var simulateCopyFailure = false
  func parse(_ provider: NSItemProvider) async -> SharePayload? { await parseProvider(provider) }
  func copyAndProcessFile(url: URL, type: ShareType) -> SharePayload? {
    precondition(!requireProviderCallback || Thread.current.threadDictionary["owning-provider-callback"] as? Bool == true, "URL escaped provider callback")
    if simulateCopyFailure { return nil }
    guard url.isFileURL, let bytes = try? Data(contentsOf: url) else { return nil }
    return saveDataToAppGroup(data: bytes, fileName: url.lastPathComponent, type: type, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
  }
  func saveDataToAppGroup(data: Data, fileName: String, type: ShareType, mimeType: String?) -> SharePayload? {
    let folder = testRoot.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(fileName)
    try! data.write(to: url)
    return SharePayload(type: type, value: url.absoluteString, mimeType: mimeType, metadata: nil)
  }
  ${source}
}
@main struct FormatTests {
  static func main() async {
    let root = testRoot.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let adapter = Adapter()
    let selected = CommandLine.arguments[2]
    // The file URL owns the bytes; a separate image representation may be only
    // its thumbnail. Extensionless originals must not inherit that preview type.
    let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")!
    for (type, bytes, expected) in [(UTType.utf8PlainText, Data("备忘录文字".utf8), ShareType.text),
                                    (.png, png, .image), (.pdf, Data("%PDF-test".utf8), .file)] {
      let provider = BytesProvider()
      provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
        done(bytes, nil); return nil
      }
      guard let payload = await adapter.parse(provider), payload.type == expected else {
        fatalError("Missing data representation for " + type.identifier)
      }
      if expected == .text {
        precondition(payload.value == "备忘录文字")
      } else {
        let file = URL(string: payload.value)!
        precondition(try! Data(contentsOf: file) == bytes)
      }
    }
    print("PASS: text, photos and documents available only as data representations")
    // Byte-only providers bypass loadItem. Native UTF-16 accepts a BOM, while
    // the external representation defaults to big-endian without one.
    for (type, bytes) in [(UTType.utf16PlainText, Data([0x41, 0, 0x42, 0])),
                         (.utf16PlainText, Data([0xff, 0xfe, 0x41, 0, 0x42, 0])),
                         (.utf16ExternalPlainText, Data([0, 0x41, 0, 0x42]))] {
      let provider = BytesProvider()
      provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
        done(bytes, nil); return nil
      }
      guard let payload = await adapter.parse(provider), payload.type == .text, payload.value == "AB" else {
        fatalError("Incorrect byte order or BOM handling for " + type.identifier)
      }
    }
    // The generic file pass also sees audio and movie types. It must not ask
    // for their bytes after the file representation fails.
    for type in [UTType.mpeg4Movie, .mp3] {
      let provider = BytesProvider()
      provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { _ in
        fatalError("Requested in-memory media bytes for " + type.identifier)
      }
      let payload = await adapter.parse(provider)
      precondition(payload == nil, "Missing file should leave the media share unhandled")
    }
    if selected != "raw-image" {
      let url = root.appendingPathComponent("data encoded document.pdf")
      let bytes = Data("original file URL document".utf8)
      try! bytes.write(to: url)
      let provider = NSItemProvider()
      provider.registerDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier, visibility: .all) { done in
        done(Data(url.absoluteString.utf8), nil); return nil
      }
      guard let payload = await adapter.parse(provider), payload.type == .file,
            let result = URL(string: payload.value) else { fatalError("Missing Data-encoded file URL") }
      precondition(result.lastPathComponent == url.lastPathComponent && (try! Data(contentsOf: result)) == bytes)
      let ephemeral = EphemeralProvider()
      ephemeral.url = url; ephemeral.encodedURL = true
      ephemeral.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { _, _, _ in })
      adapter.requireProviderCallback = true
      guard let copied = await adapter.parse(ephemeral), let copy = URL(string: copied.value) else { fatalError("Missing temporary Data-encoded file URL") }
      precondition(try! Data(contentsOf: copy) == bytes)
      precondition(!FileManager.default.fileExists(atPath: url.path))
      adapter.requireProviderCallback = false
      print("PASS: Data-encoded file URLs preserve originals within provider callbacks")
    }
    if selected != "data-file-url" {
      let gif = Data(base64Encoded: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")!
      for (bytes, type, provider) in [(png, UTType.png, NSItemProvider()), (gif, UTType.gif, BytesProvider())] {
        provider.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
          done(bytes, nil); return nil
        }
        precondition(provider.suggestedName == nil)
        guard let payload = await adapter.parse(provider), payload.type == .image,
              let result = URL(string: payload.value) else { fatalError("Missing abstract image data") }
        precondition(result.pathExtension == type.preferredFilenameExtension && payload.mimeType == type.preferredMIMEType,
                     "Abstract image bytes lost their concrete format")
        precondition(try! Data(contentsOf: result) == bytes)
      }
      print("PASS: unnamed abstract image bytes preserve concrete extensions and MIME")
      // An abstract image provider can return an object archive when asked for
      // bytes. A keyed archive must not be delivered as an image attachment.
      let archive = try! NSKeyedArchiver.archivedData(withRootObject: png as NSData, requiringSecureCoding: true)
      let archiveProvider = BytesProvider()
      archiveProvider.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
        done(archive, nil); return nil
      }
      let payload = await adapter.parse(archiveProvider)
      precondition(payload == nil, "Object archive was accepted as an image")
    }
    for (name, bytes, kind) in [("extensionless-document", Data("original document bytes".utf8), ShareType.file),
                                ("extensionless-image", png, ShareType.image)] {
      let url = root.appendingPathComponent(name)
      try! bytes.write(to: url)
      let provider = EphemeralProvider()
      provider.url = url
      provider.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { _, _, _ in })
      provider.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
        done(png, nil); return nil
      }
      adapter.requireProviderCallback = true
      guard let payload = await adapter.parse(provider), payload.type == kind,
            let result = URL(string: payload.value) else { fatalError("Thumbnail retyped extensionless original: " + name) }
      precondition(result.lastPathComponent == name && (try! Data(contentsOf: result)) == bytes)
      precondition(!FileManager.default.fileExists(atPath: url.path))
      adapter.requireProviderCallback = false
    }
    print("PASS: extensionless file URLs use their original content, not thumbnails")
    for ext in ["md", "swift"] {
      let type = UTType(filenameExtension: ext)!
      precondition(type.conforms(to: .plainText))
      let url = root.appendingPathComponent("original." + ext)
      let bytes = Data("original file bytes".utf8)
      try! bytes.write(to: url)
      let provider = NSItemProvider()
      provider.suggestedName = url.lastPathComponent
      provider.registerFileRepresentation(forTypeIdentifier: type.identifier, fileOptions: [], visibility: .all) { completion in
        completion(url, false, nil); return nil
      }
      provider.registerDataRepresentation(forTypeIdentifier: UTType.plainText.identifier, visibility: .all) { completion in
        completion(Data("preview only".utf8), nil); return nil
      }
      precondition(!provider.registeredTypeIdentifiers.contains(UTType.fileURL.identifier))
      guard let payload = await adapter.parse(provider), payload.type == .file,
            let result = URL(string: payload.value) else { fatalError("Concrete text became preview: " + ext) }
      precondition(result.lastPathComponent == url.lastPathComponent)
      precondition(payload.mimeType == type.preferredMIMEType)
      precondition(try! Data(contentsOf: result) == bytes)
      try! FileManager.default.removeItem(at: result.deletingLastPathComponent())
    }
    for type in [UTType.plainText, .utf8PlainText, .utf16PlainText, .utf16ExternalPlainText] {
      let provider = NSItemProvider()
      provider.registerItem(forTypeIdentifier: type.identifier, loadHandler: { completion, _, _ in
        completion?("shared passage" as NSString, nil)
      })
      guard let payload = await adapter.parse(provider) else { fatalError("Missing text preview") }
      precondition(payload.type == .text && payload.value == "shared passage")
    }
    // A concrete property list is a document, not Safari's preprocessing envelope.
    for type in [UTType.propertyList, .xmlPropertyList, .binaryPropertyList] {
      let bytes = try! PropertyListSerialization.data(fromPropertyList: ["original": "document"], format: type == .binaryPropertyList ? .binary : .xml, options: 0)
      for preview in [UTType.image, .url, .plainText] {
        let provider = NSItemProvider()
        provider.suggestedName = "original.plist"
        provider.registerItem(forTypeIdentifier: preview.identifier, loadHandler: { done, _, _ in
          done?(preview == .url ? NSURL(string: "https://example.com/preview")! : NSData(data: Data("preview only".utf8)), nil)
        })
        provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in done(bytes, nil); return nil }
        guard let payload = await adapter.parse(provider), payload.type == .file,
              let url = URL(string: payload.value) else { fatalError("Preview replaced concrete property list: " + type.identifier + "/" + preview.identifier) }
        precondition(url.lastPathComponent == "original.plist" && payload.mimeType == type.preferredMIMEType)
        precondition(try! Data(contentsOf: url) == bytes)
      }
    }
    let safari = NSItemProvider()
    safari.registerItem(forTypeIdentifier: UTType.propertyList.identifier, loadHandler: { done, _, _ in
      done?([NSExtensionJavaScriptPreprocessingResultsKey: ["title": "Page title", "url": "https://example.com/page", "selection": "Selected text"]] as NSDictionary, nil)
    })
    guard let page = await adapter.parse(safari) else { fatalError("Missing Safari page") }
    precondition(page.type == .text && page.value == "Page title\\n\\nhttps://example.com/page\\n\\nSelected text")
    print("PASS: concrete property lists beat previews; Safari preprocessing remains text")
    // A concrete image export is the primary content even with a source URL.
    for type in [UTType.png, .jpeg, .heic] {
      let provider = NSItemProvider()
      let name = "original." + type.preferredFilenameExtension!
      let bytes = Data("original image export".utf8)
      provider.suggestedName = name
      provider.registerItem(forTypeIdentifier: UTType.url.identifier, loadHandler: { done, _, _ in
        done?(NSURL(string: "https://example.com/image-source")!, nil)
      })
      provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in done(bytes, nil); return nil }
      guard let payload = await adapter.parse(provider), payload.type == .image,
            let result = URL(string: payload.value) else { fatalError("Source URL replaced concrete image: " + type.identifier) }
      precondition(result.lastPathComponent == name && payload.mimeType == type.preferredMIMEType)
      precondition(try! Data(contentsOf: result) == bytes)
    }
    print("PASS: concrete images beat source URLs; abstract thumbnails remain previews")
    let link = NSItemProvider()
    let sharedURL = URL(string: "https://example.com/shared-page?source=provider")!
    link.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
      done(Data("link thumbnail".utf8), nil); return nil
    }
    link.registerItem(forTypeIdentifier: UTType.url.identifier, loadHandler: { completion, _, _ in
      completion?(sharedURL as NSURL, nil)
    })
    guard let linked = await adapter.parse(link) else { fatalError("Missing web URL") }
    precondition(linked.type == .url && linked.value == sharedURL.absoluteString && linked.mimeType == "text/uri-list", "Thumbnail replaced web URL")
    print("PASS: web URL survives its image thumbnail")
    if selected != "file-url" {
      for type in [UTType.pdf, .mpeg4Movie] {
        let provider = NSItemProvider()
        let name = "original." + type.preferredFilenameExtension!
        let bytes = Data("original document or movie".utf8)
        provider.suggestedName = name
        // Advertise the thumbnail first, as real source apps may do.
        provider.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
          done(Data("thumbnail".utf8), nil); return nil
        }
        provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
          done(bytes, nil); return nil
        }
        provider.registerItem(forTypeIdentifier: UTType.url.identifier, loadHandler: { completion, _, _ in
          completion?(sharedURL as NSURL, nil)
        })
        guard let payload = await adapter.parse(provider),
              payload.type == (type.conforms(to: .movie) ? .video : .file),
              let url = URL(string: payload.value) else { fatalError("Thumbnail replaced original export") }
        precondition(url.lastPathComponent == name && payload.mimeType == type.preferredMIMEType)
        precondition(try! Data(contentsOf: url) == bytes)
      }
      let image = NSItemProvider()
      image.suggestedName = "original.png"
      image.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in
        done(Data("image bytes".utf8), nil); return nil
      }
      guard let payload = await adapter.parse(image) else { fatalError("Missing image") }
      precondition(payload.type == .image && payload.mimeType == UTType.png.preferredMIMEType)
      print("PASS: original documents/videos beat thumbnails; real images remain images")
    }
    if selected != "thumbnails" {
      let url = root.appendingPathComponent("ephemeral.pdf")
      let bytes = Data("ephemeral bytes".utf8)
      try! bytes.write(to: url)
      let provider = EphemeralProvider()
      provider.url = url
      provider.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { _, _, _ in })
      adapter.requireProviderCallback = true
      guard let payload = await adapter.parse(provider), let result = URL(string: payload.value) else { fatalError("Missing ephemeral file") }
      precondition(try! Data(contentsOf: result) == bytes)
      precondition(!FileManager.default.fileExists(atPath: url.path))
      print("PASS: temporary file URL copied inside provider callback")
    }
    if selected != "provider-owned-url" {
      // A host may advertise a file URL it never grants read access to while its
      // file representation still hands over an owned copy inside the callback.
      // The copy's own name/header decides its type, so a recovered HEIC/TIFF/BMP
      // or extensionless image still reaches the same conversion as a readable one.
      // 测试价值
      // - 生产入口与可观察结果：parseProvider 的 file-URL 回退 → copyShareFile；
      //   分享消费者看到 .image 负载、原文件名与原字节，而不是被当成普通文件。
      // - Bug／规则依据：评审 thread PRRT_kwDOTgdRUs64TGjL（恢复的图片跳过转换）。
      // - 现有覆盖缺口：原用例只有 xlsx，回退路径固定 .file，图片格式从未走过分类。
      // - 最小失败输入：不可读 file URL + 返回 photo.heic 的 file representation；
      //   修复前得到 .file。tier：unit（适配器真实 NSItemProvider/UTType 行为）。
      // - 实测耗时：整份 Swift harness 约 5.4s（含两次 swiftc 编译，未新增文件）。
      for (name, bytes, expected) in [("季度报表.xlsx", Data("spreadsheet bytes".utf8), ShareType.file),
                                      ("photo.heic", png, ShareType.image),
                                      ("scan.tiff", png, ShareType.image),
                                      ("bitmap.bmp", png, ShareType.image),
                                      ("extensionless-image", png, ShareType.image)] {
        let unavailable = root.appendingPathComponent("closed-container/missing-" + name)
        let copy = root.appendingPathComponent(name)
        try! bytes.write(to: copy)
        let provider = UnreadableURLProvider()
        provider.unavailable = unavailable
        provider.copy = copy
        provider.suggestedName = name
        provider.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { _, _, _ in })
        adapter.requireProviderCallback = false
        guard let payload = await adapter.parse(provider), payload.type == expected,
              let result = URL(string: payload.value) else { fatalError("Unreadable provider URL lost " + name) }
        precondition(result.lastPathComponent == name, "Recovered copy lost its filename: " + name)
        precondition(try! Data(contentsOf: result) == bytes, "Recovered copy lost its bytes: " + name)
        try! FileManager.default.removeItem(at: copy)
      }
      print("PASS: unreadable provider file URLs fall back to their file representation")
      print("PASS: recovered HEIC/TIFF/BMP and extensionless images keep image classification")
    }
    if selected != "byte-refetch" {
      // A provider-owned URL can omit resource values: the ordinary copy fails
      // while its bytes remain readable. Simulate only the copy failure so the
      // byte-refetch success branch must produce the attachment itself.
      // 测试价值
      // - 生产入口与可观察结果：copyShareFile 的按字节重取分支；消费者看到
      //   原文件名、原字节与按 URL 判定的类型。
      // - Bug／规则依据：评审 thread PRRT_kwDOTgdRUs64TGjQ（重取成功路径未覆盖）。
      // - 现有覆盖缺口：替身只在 Data(contentsOf:) 失败时返回 nil，生产代码
      //   再读同一 URL 必失败，重取分支即使被删掉测试也照样通过。
      // - 最小失败输入：simulateCopyFailure = true 的可读临时文件；删除重取
      //   分支或改坏文件名/字节即失败。tier：unit（同上 harness）。
      for (name, bytes, expected) in [("refetch.xlsx", Data("byte refetch bytes".utf8), ShareType.file),
                                      ("refetch.heic", png, ShareType.image),
                                      ("extensionless-refetch", png, ShareType.image)] {
        let url = root.appendingPathComponent(name)
        try! bytes.write(to: url)
        let provider = EphemeralProvider()
        provider.url = url
        provider.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { _, _, _ in })
        adapter.requireProviderCallback = true
        adapter.simulateCopyFailure = true
        guard let payload = await adapter.parse(provider), payload.type == expected,
              let result = URL(string: payload.value) else { fatalError("Byte refetch lost " + name) }
        adapter.simulateCopyFailure = false
        adapter.requireProviderCallback = false
        precondition(result.lastPathComponent == name, "Byte refetch lost the filename: " + name)
        precondition(try! Data(contentsOf: result) == bytes, "Byte refetch lost the bytes: " + name)
        precondition(!FileManager.default.fileExists(atPath: url.path), "Byte refetch escaped the provider callback")
      }
      print("PASS: byte refetch keeps filename, bytes and type after a copy failure")
    }
    if selected != "provider-string-path" {
      // Some hosts export the file URL as a bare path string instead of NSURL.
      let bytes = Data("path encoded spreadsheet".utf8)
      let source = root.appendingPathComponent("path-export.xlsx")
      try! bytes.write(to: source)
      let provider = NSItemProvider()
      provider.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { completion, _, _ in
        completion?(source.path as NSString, nil)
      })
      adapter.requireProviderCallback = false
      guard let payload = await adapter.parse(provider), payload.type == .file,
            let result = URL(string: payload.value) else { fatalError("String file path was not accepted") }
      precondition(result.lastPathComponent == "path-export.xlsx")
      precondition(try! Data(contentsOf: result) == bytes)
      print("PASS: string file paths keep their original filename and bytes")
    }
    print("PASS: concrete Markdown/source files and plain text previews")
  }
}
`;
const dir = mkdtempSync(join(tmpdir(), 'cindy-share-formats-'));
try {
  const file = join(dir, 'Formats.swift');
  const binary = join(dir, 'formats');
  writeFileSync(file, harness);
  for (const [command, args, timeout] of [
    ['swiftc', ['-parse-as-library', file, '-o', binary], 60_000],
    [binary, [dir, process.argv[2] ?? "all"], 15_000],
    ['swiftc', [
      join(dirname(fileURLToPath(import.meta.url)), '../modules/cindy-incoming-share/ios/IncomingShareSlot.swift'),
      join(dirname(fileURLToPath(import.meta.url)), 'test-incoming-share-slot.swift'),
      '-o', join(dir, 'slot'),
    ], 30_000],
    [join(dir, 'slot'), [], 15_000],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout, killSignal: 'SIGKILL' });
    if (result.error?.code === 'ENOENT' && command === 'swiftc') process.exitCode = 77;
    else if (result.error) throw result.error;
    else if (result.status !== 0) process.exitCode = 1;
    if (process.exitCode) break;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
