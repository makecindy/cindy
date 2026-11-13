const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist');
const { withXcodeProject } = require('@expo/config-plugins');

const TARGET = 'CindyNotificationContent';
/** Alerts under this category open the custom view; see docs/product-rules/notification-actions.md. */
const CATEGORY = 'cindy.question.card';

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
      NSExtensionAttributes: {
        UNNotificationExtensionCategory: [CATEGORY],
        // The view draws the task and the whole question itself.
        UNNotificationExtensionDefaultContentHidden: true,
        UNNotificationExtensionInitialContentSizeRatio: 0.4,
        UNNotificationExtensionUserInteractionEnabled: false,
      },
      NSExtensionPointIdentifier: 'com.apple.usernotifications.content-extension',
      NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationViewController',
    },
  };
}

function configureProject(project, config, platformRoot) {
  const bundleId = `${config.ios.bundleIdentifier}.${TARGET}`;
  const directory = path.join(platformRoot, TARGET);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'notification-content/NotificationViewController.swift'), path.join(directory, 'NotificationViewController.swift'));
  fs.writeFileSync(path.join(directory, 'Info.plist'), plist.default.build(extensionInfo()));
  let target = Object.entries(project.pbxNativeTargetSection())
    .find(([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === TARGET);
  if (!target) {
    const added = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);
    target = [added.uuid, added.pbxNativeTarget];
    project.addBuildPhase([`${TARGET}/NotificationViewController.swift`], 'PBXSourcesBuildPhase', 'Sources', added.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', added.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', added.uuid);
  }
  const [, nativeTarget] = target;
  const configurations = project.pbxXCConfigurationList()[nativeTarget.buildConfigurationList].buildConfigurations;
  for (const item of configurations) {
    const settings = project.pbxXCBuildConfigurationSection()[item.value].buildSettings;
    Object.assign(settings, {
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}"`,
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      CODE_SIGN_STYLE: 'Automatic',
      SWIFT_VERSION: '5.0',
      IPHONEOS_DEPLOYMENT_TARGET: '15.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CURRENT_PROJECT_VERSION: `"${config.ios.buildNumber ?? '1'}"`,
      MARKETING_VERSION: `"${config.version ?? '1.0'}"`,
      GENERATE_INFOPLIST_FILE: 'NO',
      // The extension context class lives in UserNotificationsUI. The Swift source only adopts
      // its protocol, which references no symbol, so the framework must be linked explicitly
      // or the extension stops at launch ("Unable to find NSExtensionContextClass").
      OTHER_LDFLAGS: '"-framework UserNotificationsUI -framework UserNotifications"',
      ...(config.ios.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
    });
  }
  return project;
}

/** Generates the notification content extension that shows a question with its options. */
module.exports = function withNotificationContent(config) {
  // EAS needs extension credentials before prebuild creates the native target.
  const experimental = config.extra?.eas?.build?.experimental ?? {};
  config.extra = { ...config.extra, eas: { ...config.extra?.eas, build: {
    ...config.extra?.eas?.build,
    experimental: { ...experimental, ios: {
      ...experimental.ios,
      appExtensions: [
        ...(experimental.ios?.appExtensions ?? []).filter(item => item.targetName !== TARGET),
        { targetName: TARGET, bundleIdentifier: `${config.ios.bundleIdentifier}.${TARGET}` },
      ],
    } },
  } } };
  return withXcodeProject(config, mod => {
    configureProject(mod.modResults, mod, mod.modRequest.platformProjectRoot);
    return mod;
  });
};
module.exports.configureProject = configureProject;
module.exports.extensionInfo = extensionInfo;
module.exports.CATEGORY = CATEGORY;
