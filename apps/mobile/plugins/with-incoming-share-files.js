const fs = require('node:fs');
const path = require('node:path');
const { withXcodeProject } = require('@expo/config-plugins');

// expo-sharing 57 copies files to AppGroup/<basename>, overwriting same-name
// files even within one share. Keep each input in its own directory, retaining
// the basename for display. Do not modify the installed dependency/template.
function patchShareExtension(source) {
  const replace = (from, to, count) => {
    if (source.split(from).length - 1 !== count) {
      throw new Error('expo-sharing template changed; review incoming-file ownership patch');
    }
    source = source.split(from).join(to);
  };
  replace('  private func handleShare() {',
    '  private var shareStarted = false\n\n  private func handleShare() {\n    guard !shareStarted else { return }\n    shareStarted = true', 1);
  replace('    let destinationURL = containerURL.appendingPathComponent(fileName)',
    '    let directory = containerURL.appendingPathComponent("cindy-share-" + UUID().uuidString, isDirectory: true)\n    let destinationURL = directory.appendingPathComponent(fileName)', 2);
  replace('      if FileManager.default.fileExists(atPath: destinationURL.path) {\n        try FileManager.default.removeItem(at: destinationURL)\n      }',
    '      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)', 1);
  replace('      try data.write(to: destinationURL)',
    '      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)\n      try data.write(to: destinationURL)', 1);
  return source;
}

module.exports = config => withXcodeProject(config, mod => {
  // Xcode mods run after expo-sharing's dangerous mod writes the fresh template.
  const file = path.join(mod.modRequest.platformProjectRoot, 'expo-sharing-extension', 'ShareIntoViewController.swift');
  fs.writeFileSync(file, patchShareExtension(fs.readFileSync(file, 'utf8')));
  return mod;
});
module.exports.patchShareExtension = patchShareExtension;
