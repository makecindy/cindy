const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("@expo/config-plugins");
const { patchShareFeedback } = require("./with-incoming-share-feedback");

// expo-sharing 57 copies files to AppGroup/<basename>, overwriting same-name
// files even within one share. Keep each input in its own directory, retaining
// the basename for display. Do not modify the installed dependency/template.
//
// Upstream also enters the file branch only for `file-url`/PDF providers and
// copies with `loadItem` + `copyItem`, which keeps the vending app's container in
// the read path: providers that only vend `public.data` or a document UTI are
// dropped, and a source URL the extension may not read fails the copy. Both end
// in the same "no payload" feedback. The file branch therefore accepts any
// `public.data` item, loads it with `loadFileRepresentation` first (see
// incoming-share-loader.swift) and records why an attempt failed.
function patchShareExtension(source) {
  const replace = (from, to, count) => {
    if (source.split(from).length - 1 !== count) {
      throw new Error(
        "expo-sharing template changed; review incoming-file ownership patch",
      );
    }
    source = source.split(from).join(to);
  };
  replace(
    "  private func handleShare() {",
    "  private var shareStarted = false\n  private var shareFailure: IncomingShareFailure?\n\n  private func handleShare() {\n    guard !shareStarted else { return }\n    shareStarted = true",
    1,
  );
  // Upstream ends the chain at file URLs and PDFs, so anything else a host vends
  // (document UTIs, plain `public.data`) was dropped before it could be read.
  // The fallback sits after the text branch on purpose: `public.text` also
  // conforms to `public.data`, and a shared snippet must stay text. A provider
  // nothing matches records what it advertised before giving up.
  replace(
    "    if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {\n      return await handleText(provider)\n    }\n\n    return nil",
    '    if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {\n      return await handleText(provider)\n    }\n\n    if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {\n      return await handleFile(provider, type: .file, utType: .data)\n    }\n\n    recordShareFailure(step: "no-matching-type", types: provider.registeredTypeIdentifiers)\n    return nil',
    1,
  );
  // Upstream loads the item and copies it itself. Hand that to the loader, which
  // asks the system for a file representation inside the extension's container
  // first and only falls back to `loadItem`.
  replace(
    `  private func handleFile(_ provider: NSItemProvider, type: ShareType, utType: UTType) async -> SharePayload? {
    return await withCheckedContinuation { continuation in
      let identifier = provider.registeredTypeIdentifiers.first { providerIdentifier in
        UTType(providerIdentifier)?.conforms(to: utType) ?? false
      } ?? utType.identifier

      provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, _ in
        if let url = item as? URL {
          let result = self.copyAndProcessFile(url: url, type: type)
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
          continuation.resume(returning: result)
          return
        }

        if type == .image, let image = item as? UIImage, let data = image.pngData() {
          let fileName = UUID().uuidString + ".png"
          let result = self.saveDataToAppGroup(data: data, fileName: fileName, type: .image, mimeType: "image/png")
          continuation.resume(returning: result)
          return
        }

        continuation.resume(returning: nil)
      }
    }
  }
`,
    `  private func handleFile(_ provider: NSItemProvider, type: ShareType, utType: UTType) async -> SharePayload? {
    let identifier = provider.registeredTypeIdentifiers.first { providerIdentifier in
      UTType(providerIdentifier)?.conforms(to: utType) ?? false
    } ?? provider.registeredTypeIdentifiers.first ?? utType.identifier
    return await loadFilePayload(provider, identifier: identifier, type: type)
  }
`,
    1,
  );
  replace(
    "    let destinationURL = containerURL.appendingPathComponent(fileName)",
    '    let directory = containerURL.appendingPathComponent("cindy-share-" + UUID().uuidString, isDirectory: true)\n    let destinationURL = directory.appendingPathComponent(fileName)',
    2,
  );
  replace(
    "      if FileManager.default.fileExists(atPath: destinationURL.path) {\n        try FileManager.default.removeItem(at: destinationURL)\n      }",
    "      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)",
    1,
  );
  replace(
    "      try data.write(to: destinationURL)",
    "      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)\n      try data.write(to: destinationURL)",
    1,
  );
  replace(
    "      userDefaults.set(encoded, forKey: SHARE_INTO_DEFAULTS_KEY)\n      userDefaults.synchronize()",
    '      do {\n        try IncomingShareSlot.write(encoded, group: appGroupId)\n        return true\n      } catch {\n        print("Error: incoming share could not be saved")\n        recordShareFailure(step: "save-slot", error: error)\n        return false\n      }',
    1,
  );
  replace(
    "        saveToUserDefaults(payload)",
    "        guard saveToUserDefaults(payload) else {\n          self.close()\n          return\n        }",
    1,
  );
  replace(
    "  private func saveToUserDefaults(_ payload: [SharePayload]) {",
    "  private func saveToUserDefaults(_ payload: [SharePayload]) -> Bool {",
    1,
  );
  replace(
    '    guard let userDefaults = UserDefaults(suiteName: appGroupId) else {\n      print("Error: Expo-sharing could not initialize UserDefaults with group: \\(appGroupId)")\n      return\n    }',
    "",
    1,
  );
  replace(
    '      print("Error: Expo-sharing has failed to serialize shared data to JSON")',
    '      print("Error: Expo-sharing has failed to serialize shared data to JSON")\n      return false',
    1,
  );
  const appended = (relativePath) =>
    fs.readFileSync(path.join(__dirname, relativePath), "utf8");
  return (
    patchShareFeedback(source) +
    "\n" +
    appended("incoming-share-loader.swift") +
    "\n" +
    appended("../modules/cindy-incoming-share/ios/IncomingShareSlot.swift")
  );
}

module.exports = (config) =>
  withXcodeProject(config, (mod) => {
    // Xcode mods run after expo-sharing's dangerous mod writes the fresh template.
    const file = path.join(
      mod.modRequest.platformProjectRoot,
      "expo-sharing-extension",
      "ShareIntoViewController.swift",
    );
    fs.writeFileSync(file, patchShareExtension(fs.readFileSync(file, "utf8")));
    return mod;
  });
module.exports.patchShareExtension = patchShareExtension;
