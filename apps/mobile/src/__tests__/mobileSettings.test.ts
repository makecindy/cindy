import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import { buildMobileSettingsOverview, relayStatusTone } from '@/settings/mobileSettings';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile settings overview', () => {
  it('keeps the device-link hello name and settings device name on one source', () => {
    expect(buildMobileDeviceName({ constantsDeviceName: ' Carol iPhone ', platform: 'ios' })).toBe('Carol iPhone');
    expect(buildMobileDeviceName({ constantsDeviceName: '   ', platform: 'android' })).toBe('Cindy android');
  });

  it('projects an account header plus about and debug sections for the settings screen', () => {
    const overview = buildMobileSettingsOverview({
      authBaseUrl: 'https://auth-cn.example.com',
      authRegion: 'cn',
      deviceId: 'mobile-device-1',
      deviceName: 'Carol iPhone',
      lastSyncedAt: new Date(2026, 0, 1, 3, 4, 5).getTime(),
      platform: 'ios',
      relayStatus: 'online',
      userEmail: 'neo@example.com',
      userId: 'user-1',
      userName: 'Carol',
    });

    expect(overview.header).toMatchObject({
      deviceName: 'Carol iPhone',
      email: 'neo@example.com',
      name: 'Carol',
      relayDetail: '上次同步 03:04:05',
      relayLabel: 'Relay 已连接',
      relayTone: 'ready',
    });
    expect(overview.sections.map((section) => section.id)).toEqual(['about', 'debug']);
    // 「调试 / 开发者」默认折叠,普通用户不直面。
    expect(overview.sections.find((section) => section.id === 'debug')?.collapsible).toBe(true);
    expect(overview.sections.find((section) => section.id === 'about')?.collapsible).toBeUndefined();

    expect(overview.sections.find((section) => section.id === 'about')?.rows).toContainEqual({
      detail: '电脑端授权列表会显示这个名称。',
      id: 'about.deviceName',
      label: '设备名称',
      value: 'Carol iPhone',
    });
    expect(overview.sections.find((section) => section.id === 'about')?.rows).toContainEqual({
      id: 'about.platform',
      label: '平台',
      value: 'iOS',
    });
    expect(overview.sections.find((section) => section.id === 'debug')?.rows).toContainEqual({
      copyValue: 'user-1',
      id: 'debug.userId',
      label: '用户 ID',
      value: 'user-1',
    });
    expect(overview.sections.find((section) => section.id === 'debug')?.rows).toContainEqual({
      copyValue: 'mobile-device-1',
      id: 'debug.deviceId',
      label: '设备 ID',
      value: 'mobile-device-1',
    });
  });

  it('omits the redundant email line when display name equals the email', () => {
    const overview = buildMobileSettingsOverview({
      authBaseUrl: 'https://auth-global.example.com',
      authRegion: 'global',
      deviceId: null,
      deviceName: 'Local Phone',
      platform: 'android',
      relayStatus: 'stopped',
      userEmail: 'neo@example.com',
      userName: null,
    });
    // 没有展示名 → name 回退邮箱;此时 header.email 不再重复一行。
    expect(overview.header.name).toBe('neo@example.com');
    expect(overview.header.email).toBeUndefined();
  });

  it('keeps auth-server region and endpoint explicit in debug rows', () => {
    const overview = buildMobileSettingsOverview({
      authBaseUrl: 'https://auth-global.example.com',
      authRegion: 'global',
      deviceId: null,
      deviceName: 'Local Phone',
      platform: 'android',
      relayStatus: 'stopped',
    });

    const aboutRows = overview.sections.find((section) => section.id === 'about')?.rows;
    const debugRows = overview.sections.find((section) => section.id === 'debug')?.rows;

    expect(overview.header.name).toBe('未登录');
    expect(aboutRows?.find((row) => row.id === 'about.platform')?.value).toBe(
      'Android',
    );
    expect(debugRows?.find((row) => row.id === 'debug.userId')?.value).toBe(
      '未同步',
    );
    expect(debugRows?.find((row) => row.id === 'debug.deviceId')?.value).toBe(
      '初始化中',
    );
    expect(
      debugRows?.find((row) => row.id === 'debug.authBaseUrl')?.value,
    ).toBe('https://auth-global.example.com');
    expect(debugRows?.find((row) => row.id === 'debug.authRegion')?.value).toBe(
      'Global',
    );
  });

  it('maps relay status to stable mobile indicator tones', () => {
    expect(relayStatusTone('online')).toBe('ready');
    expect(relayStatusTone('connecting')).toBe('busy');
    expect(relayStatusTone('stopped')).toBe('off');
  });

  it('lets users rename this phone through the authoritative device-link device name', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');
    const inFlightQueueIndex = source.indexOf('if (selfDeviceNameWriteInFlightRef.current) {');
    const sameNameNoopIndex = source.indexOf('if (name === deviceName.trim()) {');

    expect(source).toContain('const [selfDeviceName, setSelfDeviceName]');
    expect(source).toContain("auth.apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices'");
    expect(source).toContain('const self = res.devices.find((device) => device.deviceId === auth.deviceId);');
    expect(source).toContain('testID="settings.selfDeviceNameRow"');
    expect(source).toContain('function RenameSelfDeviceScreen');
    expect(source).toContain('testID="settings.renameSelfDevice.screen"');
    expect(source).toContain('backTestID="settings.renameSelfDevice.backButton"');
    expect(source).toContain('testID="settings.renameSelfDevice.input"');
    expect(source).toContain('testID="settings.renameSelfDevice.clear"');
    expect(source).toContain("body: { name: null }");
    expect(source).toContain('setSelfDeviceName(res.name);');
    expect(source).toContain('updateSelfDeviceNameDraft(res.name);');
    expect(source).not.toContain('updateSelfDeviceNameDraft(systemDeviceName);');
    expect(source).not.toContain('setSelfDeviceName(systemDeviceName);');
    expect(source).toContain("title={t('settings.deviceNameEditor.screenTitle')}");
    expect(source).toContain('const selfDeviceNameWriteInFlightRef = useRef(false);');
    expect(source).toContain('const selfDeviceNameQueuedWriteRef = useRef<SelfDeviceNameQueuedWrite | null>(null);');
    expect(source).toContain("selfDeviceNameQueuedWriteRef.current = { kind: 'rename', name, options };");
    expect(source).toContain("selfDeviceNameQueuedWriteRef.current = { kind: 'reset' };");
    expect(source).toContain("selfDeviceNameQueuedWriteRef.current?.kind === 'reset'");
    expect(source).toContain('selfDeviceNameRunQueuedWriteRef.current();');
    expect(source).toContain('const timer = setTimeout(() => {');
    expect(source).toContain('if (selfDeviceNameSaving) return;');
    expect(source).toContain('void saveSelfDeviceNameDraft(name);');
    expect(source).toContain('setSelfDeviceNameMessage(null);\n    setSelfDeviceNameDraft(value);');
    expect(source).not.toContain('if (!selfDeviceNameSaving) setSelfDeviceNameMessage(null);');
    expect(source).toContain('if (name.length === 0) {');
    expect(source).toContain('updateSelfDeviceNameDraft(deviceName);');
    expect(source).toContain('setSelfDeviceNameEditing(false);');
    expect(source).toContain('`/api/device-link/devices/${encodeURIComponent(auth.deviceId)}`');
    expect(source).toContain("method: 'PATCH'");
    expect(source).toContain('body: { name }');
    expect(inFlightQueueIndex).toBeGreaterThan(-1);
    expect(sameNameNoopIndex).toBeGreaterThan(-1);
    expect(inFlightQueueIndex).toBeLessThan(sameNameNoopIndex);
    expect(source).not.toContain('settings.renameSelfDevice.save');
    expect(source).not.toContain('settings.renameSelfDevice.done');
    expect(source).not.toContain('clearManualName');
  });

  it('always shows privacy policy + user agreement (regional links via legalLinks) above the cn-only App filing number', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');
    const filingCardIndex = source.indexOf("<SettingsGroup title={t('settings.legal.sectionTitle')}>");
    const privacyRowIndex = source.indexOf('testID="settings.privacyPolicy"');
    const userAgreementRowIndex = source.indexOf('testID="settings.userAgreement"');
    const regionGuardIndex = source.indexOf("{AUTH_REGION === 'cn' ? (", userAgreementRowIndex);
    const filingNumberIndex = source.indexOf('testID="settings.appFilingNumber"');
    const accountActionsIndex = source.indexOf('testID="settings.accountActions"');

    // 链接不再本地写死:与登录页共用 legalLinks 区域分流单点(protocol.xd.cn/.com)
    expect(source).toContain("import { LEGAL_LINKS } from '@/config/legalLinks';");
    expect(source).toContain('Linking.openURL(LEGAL_LINKS.privacyPolicy)');
    expect(source).toContain('Linking.openURL(LEGAL_LINKS.termsOfService)');
    expect(source).not.toContain('PRIVACY_POLICY_URL');
    expect(source).not.toContain('cindy.cn/privacy');
    expect(source).not.toContain('cindy.app/privacy');
    expect(source).toContain("accessibilityLabel={t('settings.legal.openPrivacyPolicy')}");
    expect(source).toContain("accessibilityLabel={t('settings.legal.openUserAgreement')}");
    expect(source).toContain('accessibilityRole="link"');
    expect(source).toContain("label={t('settings.legal.privacyPolicy')}");
    expect(source).toContain("label={t('settings.legal.userAgreement')}");
    expect(source).toContain("label={t('settings.legal.appFilingNumber')}");
    expect(source).toContain('value="沪ICP备11033765号-89A"');
    expect(filingCardIndex).toBeGreaterThan(-1);
    expect(privacyRowIndex).toBeGreaterThan(filingCardIndex);
    expect(userAgreementRowIndex).toBeGreaterThan(privacyRowIndex);
    expect(regionGuardIndex).toBeGreaterThan(userAgreementRowIndex);
    expect(filingNumberIndex).toBeGreaterThan(regionGuardIndex);
    expect(accountActionsIndex).toBeGreaterThan(filingNumberIndex);
  });

  it('keeps one update action, scopes TestFlight checks to OTA, and shows both versions', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');

    expect(source.match(/testID: 'settings\.checkUpdateButton'/g)).toHaveLength(1);
    expect(source).not.toContain('settings.checkBundleUpdateButton');
    expect(source).not.toContain('testID="settings.bundleUpdate"');
    expect(source).toContain('runManualUpdateCheck({');
    expect(source).toContain('isTestFlightBuild: IS_TESTFLIGHT_BUILD');
    expect(source).toContain('const updateCheckEnabled = bundleCheckEnabled || updatesEnabled');
    expect(source).toContain('checkBundleUpdate: bundleCheckEnabled ? checkBundleUpdate : undefined');
    expect(source).toContain("'settings.version.testFlightCheckAction'");
    expect(source).toContain("'settings.version.testFlightCheckingAccessibility'");
    expect(source).toContain("'settings.version.testFlightNoContentUpdate'");
    expect(source).toContain("'settings.version.testFlightContentUpdateUnavailable'");
    expect(source).toContain("testID=\"settings.testFlightUpdateHint\"");
    expect(source).toContain("{t('settings.version.testFlightUpdateManaged')}");
    expect(source).toContain("{t('settings.version.bundleVersion', { version: appVersion })}");
    expect(source).toContain(
      "testID=\"settings.otaVersion\">{t('settings.version.otaVersion', { version: otaVersion })}",
    );
  });
});
