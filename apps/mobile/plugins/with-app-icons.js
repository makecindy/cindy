const fs = require("node:fs");
const path = require("node:path");
const {
  withDangerousMod,
  withXcodeProject,
  IOSConfig,
} = require("@expo/config-plugins");

// The icon choices and their 1024px artwork are shared with Desktop; see
// packages/maker-shared/app-icons/README.md.
const SOURCE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "maker-shared",
  "app-icons",
);

/** Alternate icons to compile: every manifest entry that has artwork. */
function readAlternateIcons(sourceDir = SOURCE_DIR) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8"),
  );
  return manifest.icons
    .filter((icon) => icon.artwork)
    .map((icon) => ({
      // Must match appIconAlternateName() in @cindy/maker-shared.
      name: `AppIcon-${icon.id}`,
      light: path.join(sourceDir, icon.artwork.light),
      dark: icon.artwork.dark ? path.join(sourceDir, icon.artwork.dark) : null,
    }));
}

function iconSetContents(icon) {
  const image = (filename, appearances) => ({
    ...(appearances ? { appearances } : {}),
    filename,
    idiom: "universal",
    platform: "ios",
    size: "1024x1024",
  });
  return {
    images: [
      image("light.png"),
      // iOS 18+ shows this when the home screen is dark; older systems ignore it.
      ...(icon.dark
        ? [image("dark.png", [{ appearance: "luminosity", value: "dark" }])]
        : []),
    ],
    info: { author: "expo", version: 1 },
  };
}

/** Write one .appiconset per alternate icon into the app's asset catalog. */
function writeIconSets(catalogDir, icons) {
  for (const icon of icons) {
    const setDir = path.join(catalogDir, `${icon.name}.appiconset`);
    fs.rmSync(setDir, { recursive: true, force: true });
    fs.mkdirSync(setDir, { recursive: true });
    fs.copyFileSync(icon.light, path.join(setDir, "light.png"));
    if (icon.dark) fs.copyFileSync(icon.dark, path.join(setDir, "dark.png"));
    fs.writeFileSync(
      path.join(setDir, "Contents.json"),
      `${JSON.stringify(iconSetContents(icon), null, 2)}\n`,
    );
  }
}

/**
 * iOS alternate app icons for Settings > Appearance > App icon. actool only
 * compiles icon sets named in ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES,
 * and then adds CFBundleAlternateIcons to the built Info.plist itself.
 */
function withAppIcons(config) {
  const icons = readAlternateIcons();
  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(
        mod.modRequest.projectRoot,
      );
      writeIconSets(
        path.join(
          mod.modRequest.platformProjectRoot,
          projectName,
          "Images.xcassets",
        ),
        icons,
      );
      return mod;
    },
  ]);
  return withXcodeProject(config, (mod) => {
    const names = icons.map((icon) => icon.name).join(" ");
    const configurations = mod.modResults.pbxXCBuildConfigurationSection();
    for (const entry of Object.values(configurations)) {
      // Only the app target has a primary icon; extensions are left alone.
      if (entry?.buildSettings?.ASSETCATALOG_COMPILER_APPICON_NAME === undefined)
        continue;
      entry.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${names}"`;
    }
    return mod;
  });
}

module.exports = withAppIcons;
module.exports.readAlternateIcons = readAlternateIcons;
module.exports.writeIconSets = writeIconSets;
