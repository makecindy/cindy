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
  it.each(['com.xd.cindy', 'com.xd.cindycn', 'org.example.selfhost'])('embeds one extension with the actual %s identity', async (bundleIdentifier) => {
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
    expect(pbx.hasFile('CindyNotificationService/NotificationRetirement.swift')).toBeTruthy();
    expect(readFileSync(path.join(root, 'CindyNotificationService/NotificationRetirement.swift'), 'utf8')).toContain('enum NotificationRetirement');
    expect(readFileSync(path.join(root, 'CindyNotificationService/teammate-cindy.png')).length).toBeGreaterThan(0);
    // Regression: Xcode rejects Communication Notifications on the NSE target;
    // the containing application must still request it (unit, actual plugin mods).
    const extensionEntitlements = plist.parse(readFileSync(path.join(root, 'CindyNotificationService/CindyNotificationService.entitlements'), 'utf8'));
    expect(extensionEntitlements).not.toHaveProperty('com.apple.developer.usernotifications.communication');
    const configured = plugin(config);
    const mainInfo = await configured.mods.ios.infoPlist({ ...configured, modResults: {}, modRequest: { introspect: true } });
    expect(mainInfo.modResults.UIBackgroundModes).toContain('remote-notification');
    const mainEntitlements = await configured.mods.ios.entitlements({ ...configured, modResults: {}, modRequest: { introspect: true } });
    expect(mainEntitlements.modResults['com.apple.developer.usernotifications.communication']).toBe(true);
    expect(configured.extra.eas.build.experimental.ios.appExtensions).toEqual([{
      targetName: 'CindyNotificationService', bundleIdentifier: `${bundleIdentifier}.CindyNotificationService`,
      entitlements: { 'keychain-access-groups': [`$(AppIdentifierPrefix)${bundleIdentifier}.agent-net-notifications`] },
    }]);
  });
});

// 提问卡片的通知内容扩展(docs/product-rules/notification-actions.md「提问」)。入口是真实的 configureProject。
// 回归:扩展只采用协议、不引用框架符号,不显式链接 UserNotificationsUI 就会在启动时因找不到扩展上下文类而退出,
// 展开的通知是一块空白(2026-11-12 模拟器实测)。类别名是与手机端登记、服务端下发的三方契约。
describe('notification content extension', () => {
  it('embeds one extension bound to the question card category and links its UI framework', async () => {
    const content = require('../../plugins/with-notification-content');
    const { QUESTION_CARD_CATEGORY } = await import('@/notifications/notificationActionIds');
    const root = mkdtempSync(path.join(tmpdir(), 'cindy-notification-content-'));
    roots.push(root);
    const pbx = project();
    const config = { name: 'Cindy', slug: 'cindy', version: '2.3.4', ios: { bundleIdentifier: 'com.xd.cindycn', buildNumber: '123' } };
    content.configureProject(pbx, config, root);
    content.configureProject(pbx, config, root);
    const targets = Object.values(pbx.pbxNativeTargetSection()).filter((item: any) => item?.isa === 'PBXNativeTarget') as any[];
    expect(targets).toHaveLength(2);
    const extension = targets.find(item => item.name === '"CindyNotificationContent"');
    for (const entry of pbx.pbxXCConfigurationList()[extension.buildConfigurationList].buildConfigurations) {
      const settings = pbx.pbxXCBuildConfigurationSection()[entry.value].buildSettings;
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('"com.xd.cindycn.CindyNotificationContent"');
      expect(settings.OTHER_LDFLAGS).toContain('-framework UserNotificationsUI');
    }
    const info = plist.parse(readFileSync(path.join(root, 'CindyNotificationContent/Info.plist'), 'utf8'));
    expect(info.NSExtension.NSExtensionPointIdentifier).toBe('com.apple.usernotifications.content-extension');
    expect(info.NSExtension.NSExtensionAttributes.UNNotificationExtensionCategory).toEqual([QUESTION_CARD_CATEGORY]);
    expect(content(config).extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: 'CindyNotificationContent', bundleIdentifier: 'com.xd.cindycn.CindyNotificationContent' },
    ]);
  });
});
