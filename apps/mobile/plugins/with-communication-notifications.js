const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist');
const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');

const TARGET = 'CindyNotificationService';
const ENTITLEMENT = 'com.apple.developer.usernotifications.communication';

function extensionInfo() {
  return {
    CFBundleDisplayName: 'Cindy',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    NSExtension: {
      NSExtensionPointIdentifier: 'com.apple.usernotifications.service',
      NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationService',
    },
    NSUserActivityTypes: ['INSendMessageIntent'],
  };
}

function configureProject(project, config, platformRoot, projectRoot) {
  const bundleId = `${config.ios.bundleIdentifier}.${TARGET}`;
  const directory = path.join(platformRoot, TARGET);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'communication-notifications/NotificationService.swift'), path.join(directory, 'NotificationService.swift'));
  fs.writeFileSync(path.join(directory, 'Info.plist'), plist.default.build(extensionInfo()));
  fs.writeFileSync(path.join(directory, `${TARGET}.entitlements`), plist.default.build({ [ENTITLEMENT]: true }));
  const portraits = {
    cindy: '../desktop/src/renderer/assets/bot-presets/cindy.png',
    dash: '../desktop/resources/legacy-teammate-avatars/dash.png',
    lizi: '../desktop/resources/legacy-teammate-avatars/lizi.png',
  };
  for (const [name, file] of Object.entries(portraits)) {
    fs.copyFileSync(path.resolve(projectRoot, file), path.join(directory, `teammate-${name}.png`));
  }
  let target = Object.entries(project.pbxNativeTargetSection())
    .find(([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === TARGET);
  if (!target) {
    const added = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);
    target = [added.uuid, added.pbxNativeTarget];
    project.addBuildPhase([`${TARGET}/NotificationService.swift`], 'PBXSourcesBuildPhase', 'Sources', added.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', added.uuid);
    project.addBuildPhase(Object.keys(portraits).map(name => `${TARGET}/teammate-${name}.png`), 'PBXResourcesBuildPhase', 'Resources', added.uuid);
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
      IPHONEOS_DEPLOYMENT_TARGET: '15.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CURRENT_PROJECT_VERSION: `"${config.ios.buildNumber ?? '1'}"`,
      MARKETING_VERSION: `"${config.version ?? '1.0'}"`,
      GENERATE_INFOPLIST_FILE: 'NO',
      ...(config.ios.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
    });
  }
  return project;
}

module.exports = function withCommunicationNotifications(config) {
  config = withEntitlementsPlist(config, mod => {
    mod.modResults[ENTITLEMENT] = true;
    return mod;
  });
  config = withInfoPlist(config, mod => {
    mod.modResults.NSUserActivityTypes = [...new Set([...(mod.modResults.NSUserActivityTypes ?? []), 'INSendMessageIntent'])];
    return mod;
  });
  // EAS needs extension credentials before prebuild creates the native target.
  const experimental = config.extra?.eas?.build?.experimental ?? {};
  config.extra = { ...config.extra, eas: { ...config.extra?.eas, build: {
    ...config.extra?.eas?.build,
    experimental: { ...experimental, ios: {
      ...experimental.ios,
      appExtensions: [
        ...(experimental.ios?.appExtensions ?? []).filter(item => item.targetName !== TARGET),
        { targetName: TARGET, bundleIdentifier: `${config.ios.bundleIdentifier}.${TARGET}`, entitlements: { [ENTITLEMENT]: true } },
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
