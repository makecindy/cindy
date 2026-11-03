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
}
enum ShareType { case text, url, image, video, audio, file }
struct SharePayload { let type: ShareType; let value: String; let mimeType: String?; let metadata: String? }
final class Adapter {
  var requireProviderCallback = false
  func parse(_ provider: NSItemProvider) async -> SharePayload? { await parseProvider(provider) }
  func copyAndProcessFile(url: URL, type: ShareType) -> SharePayload? {
    precondition(!requireProviderCallback || Thread.current.threadDictionary["owning-provider-callback"] as? Bool == true, "URL escaped provider callback")
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
      for (bytes, type) in [(png, UTType.png), (gif, UTType.gif)] {
        let provider = NSItemProvider()
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
