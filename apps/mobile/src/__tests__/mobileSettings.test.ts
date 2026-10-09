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
  it('surfaces durable logout failures instead of dropping the promise', () => {
    const settingsSource = readTextLf(
      resolve(process.cwd(), 'app/settings.tsx'),
      'utf8',
    );
    const logoutStart = settingsSource.indexOf('const logout = useCallback');
    const logoutBody = settingsSource.slice(
      logoutStart,
      settingsSource.indexOf('const switchDevServerEnvironment', logoutStart),
    );

    expect(logoutBody).toContain('await auth.logout();');
    expect(logoutBody).toContain("t('devices.list.alert.actionFailed')");
    expect(logoutBody).toContain('formatRemoteError(error)');
  });

  it('renders language as one expandable picker instead of a fixed option list', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');

    expect(source).toContain('testID="settings.language.picker"');
    expect(source).toContain('<SheetModal');
    expect(source).toContain('<MobileChoicePickerList');
    expect(source).not.toContain('LanguageOptionRow');
  });

  it('keeps Android debug disclosure synchronous so repeated toggles cannot retain exiting rows', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');

    expect(source).toContain("const debugDisclosureMotionEnabled = Platform.OS !== 'android';");
    expect(source).toContain([
      'useListDisclosureTransition({',
      '    motionEnabled: debugDisclosureMotionEnabled,',
      '  })',
    ].join('\n'));
    expect(source).toContain([
      '<ListDisclosureScope',
      '          controller={debugDisclosure.controller}',
      '          motionEnabled={debugDisclosureMotionEnabled}',
    ].join('\n'));
    expect(source).toContain('runDebugDisclosure(() => setDebugExpanded((value) => !value));');
  });

  it('shows the server switch only in CindyDev and clears the old session before reloading', () => {
    const settingsSource = readTextLf(
      resolve(process.cwd(), 'app/settings.tsx'),
      'utf8',
    );
    const environmentSource = readTextLf(
      resolve(process.cwd(), 'src/config/devServerEnvironment.ts'),
      'utf8',
    );
    const switchStart = settingsSource.indexOf(
      'const switchDevServerEnvironment = useCallback(',
    );
    const logoutIndex = settingsSource.indexOf(
      'await auth.logout();',
      switchStart,
    );
    const reloadUnavailableIndex = settingsSource.indexOf(
      'if (!reload) {',
      switchStart,
    );
    const transactionalReloadIndex = settingsSource.indexOf(
      'await switchDevServerEnvironmentAndReload({',
      switchStart,
    );
    const reloadIndex = settingsSource.indexOf(
      '? () => DevSettings.reload()',
      switchStart,
    );

    expect(settingsSource).toContain(
      '...(DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED',
    );
    expect(settingsSource).toContain(
      'testID="settings.devServerEnvironment"',
    );
    expect(environmentSource).toContain(
      "process.env.EXPO_PUBLIC_CINDY_AUTH_REGION === 'dev'",
    );
    expect(environmentSource).not.toContain('TextInput');
    expect(switchStart).toBeGreaterThan(-1);
    expect(reloadUnavailableIndex).toBeGreaterThan(switchStart);
    expect(reloadUnavailableIndex).toBeLessThan(logoutIndex);
    expect(logoutIndex).toBeGreaterThan(switchStart);
    expect(transactionalReloadIndex).toBeGreaterThan(logoutIndex);
    expect(reloadIndex).toBeGreaterThan(switchStart);
    expect(reloadIndex).toBeLessThan(reloadUnavailableIndex);
    expect(settingsSource).not.toContain(
      'settings.devServerEnvironment.restartRequired',
    );
  });

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
      detail: '显示在电脑的授权列表中',
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

  it('lets users rename this phone on a real stack page with an explicit save (back discards)', () => {
    const settings = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');
    const directory = readTextLf(resolve(process.cwd(), 'src/session/settingsDeviceDirectory.ts'), 'utf8');
    const editor = readTextLf(resolve(process.cwd(), 'app/settings/device-name.tsx'), 'utf8');

    // 设置页只负责入口:子页是独立路由,系统返回只退回设置。
    expect(settings).toContain('testID="settings.selfDeviceNameRow"');
    expect(settings).toContain("push('/settings/device-name')");
    expect(settings).not.toContain('function RenameSelfDeviceScreen');
    expect(settings).not.toContain('selfDeviceNameEditing');
    // 名称正本仍是 device-link 设备清单。
    expect(directory).toContain("auth.apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices'");
    expect(directory).toContain('const self = res.devices.find((device) => device.deviceId === selfDeviceId);');
    expect(directory).toContain('export function publishSavedSelfDeviceName');
    // 共享名称按「账号代次 + deviceId」隔离:同一台手机换账号不串名。
    expect(directory).toContain('return `${accountGeneration}:${deviceId}`;');
    // 读取发起后若已有新保存,旧快照不覆盖刚存的名称。
    expect(directory).toContain('if (selfDeviceNameWrites === writesAtStart) publish(');

    expect(editor).toContain('testID="settings.renameSelfDevice.screen"');
    expect(editor).toContain('backTestID="settings.renameSelfDevice.backButton"');
    expect(editor).toContain('testID="settings.renameSelfDevice.input"');
    expect(editor).toContain('testID="settings.renameSelfDevice.clear"');
    expect(editor).toContain("testID: 'settings.renameSelfDevice.save'");
    expect(editor).toContain("testID: 'settings.renameSelfDevice.reset'");
    expect(editor).toContain("title={t('settings.deviceNameEditor.screenTitle')}");
    expect(editor).toContain('`/api/device-link/devices/${encodeURIComponent(deviceId)}`');
    expect(editor).toContain("method: 'PATCH'");
    expect(editor).toContain("body: kind === 'reset' ? { name: null } : { name: trimmedDraft }");
    expect(editor).toContain('publishSavedSelfDeviceName(selfDeviceNameKey(accountGeneration, deviceId), res.name);');
    // 保存按钮只在有改动且非空时可用;离开时不再静默保存,有改动先确认放弃。
    expect(editor).toContain('const canSave = dirty && trimmedDraft.length > 0 && !saving;');
    // 写入进行中不能离开(已发出的 PATCH 撤不回,「放弃」名不副实)。
    expect(editor).toContain('usePreventRemove(saving || (dirty && !leaveAfterSave)');
    expect(editor).toContain('if (saving) return;');
    expect(editor).toContain("t('settings.deviceNameEditor.discardTitle')");
    expect(editor).not.toContain('setTimeout(() => {');
    expect(editor).not.toContain('acceptClosedDraft');
    expect(editor).not.toContain('clearManualName');
  });

  it('hydrates the voice dictionary page after the async desktop list arrives', () => {
    const settings = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');
    const source = readTextLf(resolve(process.cwd(), 'app/settings/voice-dictionary.tsx'), 'utf8');
    const dictionaryEffectIndex = source.indexOf(
      'if (desktopDevices.length === 0) return;',
    );
    const hydrateIndex = source.indexOf(
      'Promise.all(desktopDevices.map((host) => hydrateMobileVoiceDictionary(host.deviceId)))',
      dictionaryEffectIndex,
    );

    expect(settings).toContain("push('/settings/voice-dictionary')");
    expect(settings).not.toContain('function VoiceDictionaryScreen');
    expect(source).toContain('testID="settings.voiceDictionary.screen"');
    expect(source).toContain('backTestID="settings.voiceDictionary.backButton"');
    expect(dictionaryEffectIndex).toBeGreaterThan(-1);
    expect(hydrateIndex).toBeGreaterThan(dictionaryEffectIndex);
    expect(source).toContain('[desktopDevices, refreshVoiceDictionary]');
    expect(source).toContain('[desktopDevices, invoke]');
    expect(source).not.toContain('[desktopDevices, deviceLink]');
    expect(source).toContain('subscribeMobileVoiceDictionaryCache(() => {');
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
    expect(source).toContain('...(IS_OTA_SELFHOST');
    expect(source).toContain('withOtaClient: (operation) => runSelfHostedOtaRequest(');
    expect(source).toContain(': { isConsented: hasPrivacyConsent })');
    expect(source).toContain('isTestFlightBuild: IS_TESTFLIGHT_BUILD');
    expect(source).toContain('const updateCheckEnabled = bundleCheckEnabled || updatesEnabled');
    expect(source).toContain('checkBundleUpdate: bundleCheckEnabled ? checkBundleUpdate : undefined');
    expect(source).toContain('const [updateOutcome, setUpdateOutcome] = useState<ManualUpdateCheckOutcome | null>(null);');
    expect(source).toContain('manualUpdateCheckMessage(updateOutcome, {');
    expect(source).toContain('setUpdateOutcome(outcome);');
    expect(source).not.toContain('const [updateMessage, setUpdateMessage]');
    expect(source).not.toContain('setUpdateMessage(');
    expect(source).toContain("'settings.version.testFlightCheckAction'");
    expect(source).toContain("'settings.version.testFlightCheckingAccessibility'");
    expect(source).toContain("testID=\"settings.testFlightUpdateHint\"");
    expect(source).toContain("{t('settings.version.testFlightUpdateManaged')}");
    // 版本卡片面向用户:「版本 x.y.z」+ 更新方式说明;热更版本等技术细节在调试分组。
    expect(source).toContain("{t('settings.version.appVersion', { version: appVersion })}");
    expect(source).toContain('testID="settings.updateMethod"');
    expect(source).toContain("tone: 'secondary',");
    expect(source).toContain('const showBetaBadge = betaReady && betaEnabled;');
    expect(source).toContain('testID="settings.betaChannelBadge"');
    expect(source).toContain("{t('settings.betaChannel.badge')}");
    expect(source).toContain('backgroundColor: colors.betaChannelBadgeBackground');
    expect(source).toContain('color: colors.betaChannelBadgeForeground');
    expect(source).toContain("label={t('settings.updateInfo.otaVersion')}");
    expect(source).toContain('testID="settings.otaVersion"');
    expect(source).toContain(
      "testID=\"settings.desktopVersion\">{t('settings.version.pairedDesktopVersion', { version: DESKTOP_PACKAGE_VERSION })}",
    );
    expect(source).not.toContain("'settings.version.desktopVersion'");
    expect(i18n.t('settings.version.pairedDesktopVersion', { version: '0.1.18' }))
      .toBe('配套桌面版本 0.1.18');
  });

  it('整包版本读原生真值 APP_BINARY_VERSION,不读会被 OTA 覆盖的 expoConfig.version', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/settings.tsx'), 'utf8');

    // 整包版本必须取原生烧进的 CFBundleShortVersionString / versionName(APP_BINARY_VERSION),
    // 热更后不漂移;绝不能读 Constants.expoConfig.version —— 它会被 OTA manifest 内嵌的
    // expoClient.version(打热更时主仓 app.json 的旧值)覆盖,导致整包版本回退。
    expect(source).toContain("const appVersion = APP_BINARY_VERSION || '0.0.0';");
    expect(source).not.toContain("const appVersion = Constants.expoConfig?.version");
  });
});
