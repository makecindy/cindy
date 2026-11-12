const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, IOSConfig } = require("@expo/config-plugins");

// UIImage(named:) resolves these assets for the existing native UIMenu bridge.
function withMessageMenuIcons(config) {
  return withDangerousMod(config, [
    "ios",
    async (mod) => {
      const projectRoot = mod.modRequest.projectRoot;
      const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
      const source = path.join(projectRoot, "assets", "message-menu");
      const destination = path.join(
        mod.modRequest.platformProjectRoot,
        projectName,
        "Images.xcassets",
      );
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".imageset")) continue;
        fs.cpSync(
          path.join(source, entry.name),
          path.join(destination, entry.name),
          { recursive: true },
        );
      }
      return mod;
    },
  ]);
}

module.exports = withMessageMenuIcons;
