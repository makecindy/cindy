const fs = require('node:fs');
const path = require('node:path');

// Keep Expo's app-group/launch contract; format policy lives in one Swift unit.
function patchIncomingShareFormats(source) {
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('expo-sharing input contract changed');
    return source.replace(from, to);
  };
  source = replace('import UniformTypeIdentifiers', 'import UniformTypeIdentifiers\nimport ImageIO');
  const start = source.indexOf('  private func parseProvider(');
  const end = source.indexOf('  // MARK: - File Management', start);
  if (start < 0 || end < 0) throw new Error('expo-sharing provider contract changed');
  source = source.slice(0, start) + fs.readFileSync(path.join(__dirname, 'incoming-share-formats.swift'), 'utf8') + '\n' + source.slice(end);
  source = replace('    Task {', `    guard items.reduce(0, { $0 + ($1.attachments?.count ?? 0) }) <= 20 else {
      showShareFeedback(received: false, tooMany: true)
      return
    }
    Task {`);
  source = replace('      guard let attachments = item.attachments else { continue }', `      let attachments = item.attachments ?? []
      let firstResult = results.count`);
  source = replace('    }\n\n    return results', `      if let text = item.attributedContentText?.string, !text.isEmpty,
         !results.dropFirst(firstResult).contains(where: { $0.value == text || $0.value.components(separatedBy: "\\n").contains(text) }) {
        results.append(SharePayload(type: .text, value: text, mimeType: "text/plain", metadata: nil))
      }
    }

    return results`);
  source = replace('          results.append(payload)\n        }', `          results.append(payload)
        } else {
          // Do not silently deliver a subset. The source app still owns the inputs.
          for payload in results where payload.type != .text && payload.type != .url && payload.value.hasPrefix("file://") {
            if let url = URL(string: payload.value), url.deletingLastPathComponent().lastPathComponent.hasPrefix("cindy-share-") {
              try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            }
          }
          return []
        }`);
  source = replace('    let fileName = url.lastPathComponent.isEmpty', `    guard url.isFileURL else { return nil }
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
    if values?.isDirectory == true {
      var result: SharePayload?
      var error: NSError?
      NSFileCoordinator().coordinate(readingItemAt: url, options: .forUploading, error: &error) { archive in
        result = self.copyAndProcessFile(url: archive, type: .file)
      }
      return error == nil ? result : nil
    }
    guard values?.isRegularFile == true else { return nil }
    let fileName = url.lastPathComponent.isEmpty`);
  return source;
}
module.exports = { patchIncomingShareFormats };
