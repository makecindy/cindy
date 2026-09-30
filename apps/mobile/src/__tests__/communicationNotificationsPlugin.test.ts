import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const plugin = require('../../plugins/with-communication-notifications');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// A minimal real node-xcode project, not mocks of the mutation API.
function project() {
  const result = xcode.project('unused.pbxproj');
  result.hash = { project: { rootObject: 'ROOT', objects: {
    PBXProject: { ROOT: { isa: 'PBXProject', targets: [{ value: 'APP', comment: 'App' }], mainGroup: 'GROUP', attributes: {} } },
    PBXNativeTarget: { APP: { isa: 'PBXNativeTarget', name: 'App', buildPhases: [], dependencies: [], buildConfigurationList: 'CONFIG' } },
    PBXGroup: { GROUP: { isa: 'PBXGroup', children: [], sourceTree: '"<group>"' }, PRODUCTS: { isa: 'PBXGroup', name: 'Products', children: [], sourceTree: '"<group>"' } },
    PBXFileReference: {}, PBXBuildFile: {}, PBXTargetDependency: {}, PBXContainerItemProxy: {},
    XCConfigurationList: { CONFIG: { buildConfigurations: [{ value: 'DEBUG', comment: 'Debug' }] } },
    XCBuildConfiguration: { DEBUG: { isa: 'XCBuildConfiguration', name: 'Debug', buildSettings: {} } },
  } } };
  return result;
}

describe('communication notification extension', () => {
  it.each(['com.xd.cindy', 'com.xd.cindycn', 'org.example.selfhost'])('embeds one extension with the actual %s identity', (bundleIdentifier) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cindy-notification-plugin-'));
    roots.push(root);
    const pbx = project();
    const config = { name: 'Cindy', slug: 'cindy', version: '2.3.4', ios: { bundleIdentifier, buildNumber: '123', appleTeamId: 'TESTTEAM' } };
    const mobile = path.resolve(import.meta.dirname, '../..');
    plugin.configureProject(pbx, config, root, mobile);
    plugin.configureProject(pbx, config, root, mobile);
    const targets = Object.values(pbx.pbxNativeTargetSection()).filter((item: any) => item?.isa === 'PBXNativeTarget') as any[];
    expect(targets).toHaveLength(2);
    const extension = targets.find(item => item.name === '"CindyNotificationService"');
    expect(extension.buildPhases).toHaveLength(3);
    expect(targets[0].dependencies).toHaveLength(1);
    const configs = pbx.pbxXCConfigurationList()[extension.buildConfigurationList].buildConfigurations;
    for (const entry of configs) {
      const settings = pbx.pbxXCBuildConfigurationSection()[entry.value].buildSettings;
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe(`"${bundleIdentifier}.CindyNotificationService"`);
      expect(settings.CURRENT_PROJECT_VERSION).toBe('"123"');
      expect(settings.DEVELOPMENT_TEAM).toBe('TESTTEAM');
      expect(settings.APPLICATION_EXTENSION_API_ONLY).toBe('YES');
    }
    const info = plist.parse(readFileSync(path.join(root, 'CindyNotificationService/Info.plist'), 'utf8'));
    expect(info.NSExtension.NSExtensionPointIdentifier).toBe('com.apple.usernotifications.service');
    expect(readFileSync(path.join(root, 'CindyNotificationService/teammate-cindy.png')).length).toBeGreaterThan(0);
    const configured = plugin(config);
    expect(configured.extra.eas.build.experimental.ios.appExtensions).toEqual([{
      targetName: 'CindyNotificationService', bundleIdentifier: `${bundleIdentifier}.CindyNotificationService`,
      entitlements: { 'com.apple.developer.usernotifications.communication': true },
    }]);
  });
});
