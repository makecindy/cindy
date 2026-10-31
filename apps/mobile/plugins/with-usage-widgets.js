const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist');
const { withXcodeProject } = require('@expo/config-plugins');

// iOS home-screen widgets (subscription quota and daily usage). The app writes the snapshot
// into the App Group expo-sharing already provisions (`group.<bundle id>`); the extension reads it.
const TARGET = 'CindyHomeWidgets';
const SOURCES = [
  'CindyUsageWidgets.swift',
  'UsageWidgetModel.swift',
  'WidgetPalette.swift',
  'QuotaWidgetViews.swift',
  'UsageWidgetViews.swift',
  'SingleSourceViews.swift',
  'ComputerIntent.swift',
];
// The edit sheet's "Data source" strings (App Intents metadata reads the Localizable table).
const LOCALIZATIONS = ['en.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj', 'ja.lproj', 'ko.lproj', 'de.lproj', 'es.lproj', 'fr.lproj', 'pt-BR.lproj', 'pt-PT.lproj'];
// Same number font as the macOS menu bar panel (OFL, shipped next to its helper).
const FONTS = ['BarlowCondensed-Medium.ttf', 'BarlowCondensed-SemiBold.ttf'];
const FONT_DIR = '../desktop/native/menubar';
const APP_GROUPS = 'com.apple.security.application-groups';

function appGroupOf(config) {
  return `group.${config.ios.bundleIdentifier}`;
}

function extensionInfo(config) {
  return {
    CFBundleDisplayName: 'Cindy',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    CindyAppGroupId: appGroupOf(config),
    CindyURLScheme: Array.isArray(config.scheme) ? config.scheme[0] : config.scheme,
    UIAppFonts: FONTS,
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
  };
}

function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(source, target);
    else fs.copyFileSync(source, target);
  }
}

function configureProject(project, config, platformRoot, projectRoot) {
  const bundleId = `${config.ios.bundleIdentifier}.${TARGET}`;
  const directory = path.join(platformRoot, TARGET);
  const assets = path.join(__dirname, 'usage-widgets');
  fs.mkdirSync(directory, { recursive: true });
  for (const file of SOURCES) fs.copyFileSync(path.join(assets, file), path.join(directory, file));
  for (const folder of ['Assets.xcassets', ...LOCALIZATIONS]) {
    fs.rmSync(path.join(directory, folder), { recursive: true, force: true });
    copyDirectory(path.join(assets, folder), path.join(directory, folder));
  }
  for (const font of FONTS) fs.copyFileSync(path.resolve(projectRoot, FONT_DIR, font), path.join(directory, font));
  fs.writeFileSync(path.join(directory, 'Info.plist'), plist.default.build(extensionInfo(config)));
  fs.writeFileSync(path.join(directory, `${TARGET}.entitlements`), plist.default.build({ [APP_GROUPS]: [appGroupOf(config)] }));

  let target = Object.entries(project.pbxNativeTargetSection())
    .find(([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === TARGET);
  if (!target) {
    const added = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);
    target = [added.uuid, added.pbxNativeTarget];
    project.addBuildPhase(SOURCES.map(file => `${TARGET}/${file}`), 'PBXSourcesBuildPhase', 'Sources', added.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', added.uuid);
    project.addBuildPhase(
      [`${TARGET}/Assets.xcassets`, ...FONTS.map(font => `${TARGET}/${font}`), ...LOCALIZATIONS.map(folder => `${TARGET}/${folder}`)],
      'PBXResourcesBuildPhase', 'Resources', added.uuid,
    );
    // Copied as folders, so each lands in the bundle as `<language>.lproj/Localizable.strings`.
    for (const [key, file] of Object.entries(project.pbxFileReferenceSection())) {
      if (!key.endsWith('_comment') && String(file.path ?? '').replaceAll('"', '').endsWith('.lproj')) {
        file.lastKnownFileType = 'folder';
      }
    }
  }
  const [, nativeTarget] = target;
  const configurations = project.pbxXCConfigurationList()[nativeTarget.buildConfigurationList].buildConfigurations;
  for (const item of configurations) {
    const settings = project.pbxXCBuildConfigurationSection()[item.value].buildSettings;
    Object.assign(settings, {
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}"`,
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      CODE_SIGN_STYLE: 'Automatic',
      SWIFT_VERSION: '5.0',
      // containerBackground and contentMarginsDisabled; older systems simply have no widgets.
      IPHONEOS_DEPLOYMENT_TARGET: '17.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: '""',
      CURRENT_PROJECT_VERSION: `"${config.ios.buildNumber ?? '1'}"`,
      MARKETING_VERSION: `"${config.version ?? '1.0'}"`,
      GENERATE_INFOPLIST_FILE: 'NO',
      ...(config.ios.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
    });
  }
  return project;
}

module.exports = function withUsageWidgets(config) {
  // EAS needs extension credentials before prebuild creates the native target.
  const experimental = config.extra?.eas?.build?.experimental ?? {};
  config.extra = { ...config.extra, eas: { ...config.extra?.eas, build: {
    ...config.extra?.eas?.build,
    experimental: { ...experimental, ios: {
      ...experimental.ios,
      appExtensions: [
        ...(experimental.ios?.appExtensions ?? []).filter(item => item.targetName !== TARGET),
        { targetName: TARGET, bundleIdentifier: `${config.ios.bundleIdentifier}.${TARGET}`, entitlements: { [APP_GROUPS]: [appGroupOf(config)] } },
      ],
    } },
  } } };
  return withXcodeProject(config, mod => {
    configureProject(mod.modResults, mod, mod.modRequest.platformProjectRoot, mod.modRequest.projectRoot);
    return mod;
  });
};
module.exports.configureProject = configureProject;
module.exports.extensionInfo = extensionInfo;
