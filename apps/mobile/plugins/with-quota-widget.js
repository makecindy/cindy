const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const { withEntitlementsPlist, withInfoPlist, withXcodeProject, withAndroidManifest } = require('@expo/config-plugins');

const TARGET = 'CindySubscriptionWidget';
function identity(config) {
  const bundle = config.ios?.bundleIdentifier;
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;
  if (!bundle || !scheme || !/^[a-z][a-z0-9+.-]*$/i.test(scheme)) throw new Error('Quota widget requires the resolved app identity');
  return { bundle: `${bundle}.quota-widget`, group: `group.${bundle}.quota`, scheme };
}

function configureProject(project, platformRoot, config) {
  const ids = identity(config);
  const source = path.join(__dirname, '../modules/cindy-quota-widget');
  const destination = path.join(platformRoot, TARGET);
  fs.mkdirSync(destination, { recursive: true });
  const files = ['QuotaSnapshot.swift', 'QuotaWidgetResources.swift', 'CindySubscriptionWidget.swift'];
  for (const file of files) fs.copyFileSync(path.join(source, file === 'QuotaSnapshot.swift' ? 'ios' : 'widget', file), path.join(destination, file));
  fs.copyFileSync(path.join(source, 'widget/Provider-Artwork-NOTICE.txt'), path.join(destination, 'Provider-Artwork-NOTICE.txt'));
  fs.cpSync(path.join(source, 'widget/Assets.xcassets'), path.join(destination, 'Assets.xcassets'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'Info.plist'), plist.build({
    CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
    CFBundleDisplayName: 'Cindy',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: config.version ?? '1.0.0',
    CFBundleVersion: config.ios?.buildNumber ?? '1',
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
    CindyQuotaAppGroup: ids.group,
    CindyQuotaScheme: ids.scheme,
  }));
  fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), plist.build({ 'com.apple.security.application-groups': [ids.group] }));
  // xcode.addTargetDependency silently skips projects whose template has no dependency sections.
  project.hash.project.objects.PBXTargetDependency ??= {};
  project.hash.project.objects.PBXContainerItemProxy ??= {};
  const existing = Object.entries(project.pbxNativeTargetSection()).find(([, target]) => typeof target === 'object' && target.name?.replace(/"/g, '') === TARGET);
  const target = existing ? { uuid: existing[0], pbxNativeTarget: existing[1] } : project.addTarget(TARGET, 'app_extension', TARGET, ids.bundle);
  if (!existing) {
    project.addBuildPhase(files.map(file => `${TARGET}/${file}`), 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    project.addBuildPhase([`${TARGET}/Assets.xcassets`, `${TARGET}/Provider-Artwork-NOTICE.txt`], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    const group = project.addPbxGroup(files.map(file => `${TARGET}/${file}`), TARGET, ".");
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  }
  for (const group of Object.values(project.hash.project.objects.PBXGroup)) {
    if (typeof group === 'object' && String(group.name).replace(/"/g, '') === TARGET) group.path = '"."';
  }
  // Upgrade a previously generated target too, without duplicating its resource entry.
  const resourcePhase = project.buildPhaseObject('PBXResourcesBuildPhase', 'Resources', target.uuid);
  if (resourcePhase && !resourcePhase.files.some(ref => ref.comment?.includes('Assets.xcassets'))) {
    project.addResourceFile(`${TARGET}/Assets.xcassets`, { target: target.uuid });
  }
  if (resourcePhase && !resourcePhase.files.some(ref => ref.comment?.includes('Provider-Artwork-NOTICE.txt'))) {
    project.addResourceFile(`${TARGET}/Provider-Artwork-NOTICE.txt`, { target: target.uuid });
  }
  const host = project.getFirstTarget();
  const dependencies = project.hash.project.objects.PBXTargetDependency;
  if (!host.firstTarget.dependencies.some(ref => dependencies[ref.value]?.target === target.uuid)) {
    project.addTargetDependency(host.uuid, [target.uuid]);
  }
  const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  for (const { value } of list.buildConfigurations) {
    const settings = project.pbxXCBuildConfigurationSection()[value].buildSettings;
    Object.assign(settings, {
      PRODUCT_BUNDLE_IDENTIFIER: `"${ids.bundle}"`,
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      SWIFT_VERSION: '5.9',
      IPHONEOS_DEPLOYMENT_TARGET: '16.4',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      SKIP_INSTALL: 'YES',
      GENERATE_INFOPLIST_FILE: 'NO',
    });
  }
  // No signing team/profile provisioning or production release settings are changed here.
  return project;
}

function withQuotaWidget(config) {
  const ids = identity(config);
  config = withEntitlementsPlist(config, mod => {
    mod.modResults['com.apple.security.application-groups'] = [...new Set([...(mod.modResults['com.apple.security.application-groups'] ?? []), ids.group])];
    return mod;
  });
  config = withInfoPlist(config, mod => {
    mod.modResults.CindyQuotaAppGroup = ids.group;
    mod.modResults.CindyQuotaScheme = ids.scheme;
    return mod;
  });
  config = withXcodeProject(config, mod => {
    configureProject(mod.modResults, mod.modRequest.platformProjectRoot, mod);
    return mod;
  });
  return withAndroidManifest(config, mod => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Missing Android application');
    const metadata = application['meta-data'] ?? [];
    application['meta-data'] = [...metadata.filter(item => item.$?.['android:name'] !== 'cindy.quota.scheme'), { $: { 'android:name': 'cindy.quota.scheme', 'android:value': ids.scheme } }];
    return mod;
  });
}
module.exports = withQuotaWidget;
module.exports.configureProject = configureProject;
module.exports.identity = identity;
