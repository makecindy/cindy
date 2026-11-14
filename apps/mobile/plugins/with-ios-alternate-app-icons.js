const fs = require('node:fs');
const path = require('node:path');

const { IOSConfig, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const { findNativeTargetByName } = require('@expo/config-plugins/build/ios/Target');

/**
 * 备选应用图标（iOS Alternate App Icon）。
 *
 * 资源必须随包编译，运行时只能通过 `UIApplication.setAlternateIconName` 切换，
 * 因此这里在 prebuild 阶段把 1024 满幅 PNG 写进 `Images.xcassets`，并在 app target 上登记
 * `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`，由 actool 生成 `CFBundleAlternateIcons`。
 *
 * 资源来源：`apps/mobile/assets/app-icons/`（生成方式见 `scripts/generate-mobile-app-icons.mjs`）。
 */

/** 图标集名称同时是运行时名称，发布后不得改名。 */
const ALTERNATE_APP_ICONS = [
  {
    name: 'AppIcon-Wordmark',
    files: {
      light: 'wordmark-light.png',
      dark: 'wordmark-dark.png',
    },
  },
];

function buildContentsJson({ files }) {
  const images = [
    {
      filename: files.light,
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    },
  ];
  if (files.dark) {
    images.push({
      appearances: [{ appearance: 'luminosity', value: 'dark' }],
      filename: files.dark,
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
  }
  return {
    images,
    info: { author: 'xcode', version: 1 },
  };
}

function withAlternateAppIcons(config) {
  config = withDangerousMod(config, [
    'ios',
    async (mod) => {
      const projectRoot = mod.modRequest.projectRoot;
      const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
      const catalog = path.join(
        mod.modRequest.platformProjectRoot,
        projectName,
        'Images.xcassets',
      );

      for (const icon of ALTERNATE_APP_ICONS) {
        const target = path.join(catalog, `${icon.name}.appiconset`);
        fs.mkdirSync(target, { recursive: true });
        for (const file of Object.values(icon.files)) {
          const source = path.join(projectRoot, 'assets', 'app-icons', file);
          if (!fs.existsSync(source)) {
            throw new Error(
              `[alternate-app-icons] missing source asset: assets/app-icons/${file}`,
            );
          }
          fs.copyFileSync(source, path.join(target, file));
        }
        fs.writeFileSync(
          path.join(target, 'Contents.json'),
          `${JSON.stringify(buildContentsJson(icon), null, 2)}\n`,
        );
      }
      return mod;
    },
  ]);

  config = withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const projectName = mod.modRequest.projectName;
    const [, target] = findNativeTargetByName(project, projectName);
    const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    );
    const names = ALTERNATE_APP_ICONS.map((icon) => icon.name).join(' ');
    for (const [, buildConfiguration] of configurations) {
      buildConfiguration.buildSettings = buildConfiguration.buildSettings || {};
      buildConfiguration.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = names;
    }
    return mod;
  });

  return config;
}

module.exports = withAlternateAppIcons;
module.exports.ALTERNATE_APP_ICONS = ALTERNATE_APP_ICONS;
module.exports.buildContentsJson = buildContentsJson;
