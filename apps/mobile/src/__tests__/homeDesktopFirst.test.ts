import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { i18n } from '@/i18n';
import { startBoundedStartupRead } from '@/session/mobileHomeStartup';
import { resolveConnectionBannerSyncActionVisibility, resolveConnectionBannerVisibility, resolveHomeConnectionFeedback } from '@/components/connectionBannerVisibility';
import { connectionHealthCopy, describeRemoteError } from '@/device-link/remoteStatus';
import { isTaskSuggestionsSyncPending } from '@/session/useRemoteTaskSuggestionsPresentation';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

// Exercise Home's actual feedback expressions: literal-source assertions missed
// phone-wide outages and broke when the same shared policy gained that input.
const homeSource = ts.createSourceFile('HomeSurface.tsx', readSource('src/session/HomeSurface.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const feedbackExpressions = new Map<string, string>();
const feedbackNames = new Set(['homeListScopePending', 'initialHomeLoading', 'initialHomeError', 'healthCopy', 'showConnectionRow', 'showHomeSyncAction', 'showHomeRecoveryProgress', 'connectionTitle']);
let listScopeEffect = '';
function collectFeedback(node: ts.Node) {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(homeSource) === 'useLayoutEffect'
    && node.expression.arguments[0]?.getText(homeSource).includes('homeListFilterRef.current === requestedListFilter')) {
    listScopeEffect = ts.transpileModule(node.getText(homeSource), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  if (ts.isVariableDeclaration(node) && feedbackNames.has(node.name.getText(homeSource)) && node.initializer) {
    feedbackExpressions.set(node.name.getText(homeSource), ts.transpileModule(`const result = ${node.initializer.getText(homeSource)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  ts.forEachChild(node, collectFeedback);
}
collectFeedback(homeSource);
function homeFeedback(overrides: Record<string, unknown>) {
  const bindings: Record<string, unknown> = {
    network: 'available', networkUnavailable: false, status: 'online',
    selectedDeviceDisconnected: false, activeConnectionIssue: null,
    homeDeviceRecovery: false, homeDeviceUnresponsive: false, connectionError: null,
    initialHomeSettled: true, homeListFilterChanged: false, indexedSearch: { status: 'idle' },
    homeSyncDeviceIds: ['mac'], homeListOwnedDeviceIdsRef: { current: new Set(['mac']) },
    rawDeviceConnectionStates: { mac: 'idle' }, isTaskSuggestionsSyncPending,
    resolveConnectionBannerSyncActionVisibility, resolveConnectionBannerVisibility, connectionHealthCopy,
    t: (key: string) => i18n.t(key), homeConnectionTitle: () => 'online', ...overrides,
  };
  for (const name of feedbackNames) {
    const expression = feedbackExpressions.get(name);
    if (!expression) throw new Error(`Missing Home feedback: ${name}`);
    bindings[name] = new Function(...Object.keys(bindings), `${expression}\nreturn result;`)(...Object.values(bindings));
  }
  return bindings;
}

describe('mobile Home connection feedback', () => {
  // PR #6381: an error from A masked B's loading state. Existing feedback tests
  // never changed the selection after an error. Unit: run the production layout
  // effect with React's dependency comparison, before deriving the next frame.
  it('retires the previous computer error before painting a new selection', () => {
    let previousDeps: unknown[] = [];
    let error: string | null = null;
    const bindings = {
      useLayoutEffect: (effect: () => void, deps: unknown[]) => {
        if (deps.some((value, index) => value !== previousDeps[index])) effect();
        previousDeps = deps;
      },
      setError: (value: string | null) => { error = value; },
      homeListFilterRef: { current: 'active' }, requestedListFilter: 'active',
      selectedDeviceId: 'a', advanceHomeSyncGeneration: () => undefined,
    };
    const render = () => new Function(...Object.keys(bindings), listScopeEffect)(...Object.values(bindings));
    render();
    error = 'A failed';
    render();
    expect(error).toBe('A failed');
    bindings.selectedDeviceId = 'b';
    render();
    expect(homeFeedback({
      connectionError: error, homeListOwnedDeviceIdsRef: { current: new Set() },
    })).toMatchObject({ initialHomeLoading: true, initialHomeError: false });
  });

  // Unit regression for the reported active/archive flash: run Home's actual
  // presentation expressions after startup has already settled. Existing tests
  // only exercised connection banners and never a new list scope or search.
  it.each([
    { homeListFilterChanged: true },
    { homeListOwnedDeviceIdsRef: { current: new Set() } },
    { rawDeviceConnectionStates: { mac: 'syncing' } },
    { indexedSearch: { status: 'searching' } },
  ])('keeps an empty list loading during %o after the first sync', (state) => {
    expect(homeFeedback(state).initialHomeLoading).toBe(true);
  });

  it('shows a failed reload as an error instead of a successful empty result', () => {
    expect(homeFeedback({ connectionError: 'failed' })).toMatchObject({
      initialHomeLoading: false, initialHomeError: true,
    });
    expect(homeFeedback({})).toMatchObject({ initialHomeLoading: false, initialHomeError: false });
  });

  it('does not offer manual sync for the device-prefixed unresponsive error shown on Home', () => {
    expect(resolveConnectionBannerSyncActionVisibility({
      online: true,
      hasActiveIssue: false,
      deviceUnresponsive: true,
      hasRequestError: true,
      requestErrorAutoRecovering: false,
    })).toBe(false);
  });

  it('wires Home itself to the shared recovery indicator instead of an unconditional retry button', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    expect(source).toContain('resolveHomeConnectionFeedback(error, homeRecoveringDeviceIds, describeRemoteError)');
    expect(source).toContain('deviceUnresponsive: homeDeviceRecovery,');
    expect(source).toContain('deviceUnresponsive: homeDeviceUnresponsive,');
    expect(homeFeedback({})).toMatchObject({ showConnectionRow: false, showHomeSyncAction: false });
    expect(homeFeedback({ selectedDeviceDisconnected: true })).toMatchObject({
      showConnectionRow: true, connectionTitle: i18n.t('deviceLink.cachedHistory.title'),
    });
    expect(homeFeedback({ homeDeviceRecovery: true, homeDeviceUnresponsive: true })).toMatchObject({
      showConnectionRow: true, showHomeSyncAction: false, showHomeRecoveryProgress: true,
      connectionTitle: i18n.t('deviceLink.deviceUnresponsiveTitle'),
    });
    expect(homeFeedback({ connectionError: 'failed' })).toMatchObject({ showConnectionRow: true, showHomeSyncAction: true });
    expect(homeFeedback({ network: 'unavailable', networkUnavailable: true, connectionError: 'failed' })).toMatchObject({
      showConnectionRow: true, showHomeSyncAction: false, showHomeRecoveryProgress: false,
      connectionTitle: i18n.t('deviceLink.localNetwork.title'),
    });
    expect(source).toContain("recoveringDeviceIds.has(id) || rawDeviceConnectionStates[id] === 'syncing'");
    const hydrate = source.slice(source.indexOf('const hydrateDeviceSessions = useCallback('), source.indexOf('const probeRevokedDeviceAccess'));
    expect(hydrate.indexOf("updateDeviceConnectionState(device.deviceId, 'syncing')")).toBeLessThan(hydrate.indexOf('const promise = hydrateDeviceSessionsOnce('));
    expect(source).toContain('useDelayedConnectionNotice(showConnectionRow)');
    const row = source.slice(source.indexOf('{showConnectionNotice ? ('), source.indexOf('</ConnectionNoticeOverlay>'));
    expect(row).toMatch(/showHomeSyncAction\s*\?\s*<Pressable/);
    const progress = row.slice(row.indexOf(': showHomeRecoveryProgress ?'));
    expect(progress).toContain('<ConnectionRecoveryProgress');
    expect(progress).not.toContain('onPress');
    expect(progress).not.toContain('<Pressable');
  });
});

describe('Home recovery completion', () => {
  const stale = { deviceId: 'a', deviceName: 'MacBook', error: '[DEVICE_UNRESPONSIVE] circuit open' };
  const recovering = new Set(['a']);
  const recovered = new Set<string>();
  it('tracks ordinary failures through same-device and other-device circuit transitions', () => {
    const failure = { deviceId: 'a', deviceName: 'Same name', error: '[IPC_ERROR] failed' };
    const other = { deviceId: 'b', deviceName: 'Same name', error: '[REQUEST_TIMEOUT] failed' };
    for (const [ids, failures, expectedRecovery, expectedError] of [
      [[], [failure], false, 'Same name: [IPC_ERROR] failed'],
      [['a'], [failure], true, 'Same name: [IPC_ERROR] failed'],
      [['a'], [failure, other], false, 'Same name: [REQUEST_TIMEOUT] failed'],
      [['a', 'b'], [failure, other], true, 'Same name: [IPC_ERROR] failed；Same name: [REQUEST_TIMEOUT] failed'],
      [['b'], [failure, other], false, 'Same name: [IPC_ERROR] failed'],
      [[], [failure], false, 'Same name: [IPC_ERROR] failed'],
    ] as const) {
      const feedback = resolveHomeConnectionFeedback([...failures], new Set(ids));
      expect(feedback).toEqual({ error: expectedError, deviceRecovery: expectedRecovery });
      expect(resolveConnectionBannerSyncActionVisibility({ online: true, hasActiveIssue: false,
        deviceUnresponsive: feedback.deviceRecovery, hasRequestError: feedback.error !== null,
        requestErrorAutoRecovering: false,
      })).toBe(!expectedRecovery);
    }
  });
  it('expires a recovered device marker while another device is still probing', () => {
    expect(resolveHomeConnectionFeedback(stale, new Set(['b']))).toEqual({ error: null, deviceRecovery: true });
  });
  it('keeps page-level errors independent of a device circuit', () => {
    expect(resolveHomeConnectionFeedback('[NETWORK_UNAVAILABLE] failed', recovering))
      .toEqual({ error: '[NETWORK_UNAVAILABLE] failed', deviceRecovery: false });
  });
  it.each([
    [true, true, true],
    [false, true, true],
    [true, false, false],
    [false, false, false],
  ])('keeps mixed-device recovery independent (circuit=%s, manual=%s)', (circuit, manual, canSync) => {
    const ordinary = { deviceId: 'b', deviceName: 'Other', error: '[REQUEST_TIMEOUT] failed' };
    const feedback = resolveHomeConnectionFeedback(manual ? [stale, ordinary] : stale, circuit ? recovering : recovered);
    expect(feedback.error).toBe(manual ? 'Other: [REQUEST_TIMEOUT] failed' : circuit ? 'MacBook: [DEVICE_UNRESPONSIVE] circuit open' : null);
    expect(feedback.deviceRecovery).toBe(circuit && !manual);
    expect(resolveConnectionBannerSyncActionVisibility({ online: true, hasActiveIssue: false,
      deviceUnresponsive: feedback.deviceRecovery, hasRequestError: feedback.error !== null,
      requestErrorAutoRecovering: false,
    })).toBe(canSync);
  });
  it('shows background recovery even without a stored request error', () => {
    expect(resolveHomeConnectionFeedback(null, recovering)).toEqual({ error: null, deviceRecovery: true });
  });
  it('clears the stale circuit error once probing succeeds', () => {
    expect(resolveHomeConnectionFeedback(stale, recovering).error).toBe('MacBook: [DEVICE_UNRESPONSIVE] circuit open');
    expect(resolveHomeConnectionFeedback(stale, recovered).error).toBeNull();
  });
  it('preserves a different device failure in the joined error', () => {
    expect(resolveHomeConnectionFeedback([stale, { deviceId: 'b', deviceName: 'Other', error: 'denied' }], recovered).error).toBe('Other: denied');
  });
  it.each(['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE'])('keeps manual retry after %s exhausts bounded retries', (code) => {
    const error = resolveHomeConnectionFeedback(`[${code}] failed`, recovered).error;
    expect(resolveConnectionBannerSyncActionVisibility({ online: true, hasActiveIssue: false,
      deviceUnresponsive: false, hasRequestError: error !== null, requestErrorAutoRecovering: false,
    })).toBe(true);
  });
  it.each(['DEVICE_UNRESPONSIVE', '[DEVICE_UNRESPONSIVE]', 'Mac: [DEVICE_UNRESPONSIVE]；Other'])('never classifies the device name %s as an error code', (deviceName) => {
    const ordinary = { deviceId: 'b', deviceName, error: '[REQUEST_TIMEOUT] failed' };
    for (const ids of [recovered, recovering]) {
      const feedback = resolveHomeConnectionFeedback([stale, ordinary], ids, describeRemoteError);
      expect(feedback.error).toBe(`${deviceName}: ${describeRemoteError(ordinary.error)}`);
      expect(feedback.deviceRecovery).toBe(false);
    }
  });
  it('classifies all failures before limiting display to two entries', () => {
    expect(resolveHomeConnectionFeedback([stale, stale, { deviceId: 'c', deviceName: 'Third', error: 'denied' }], recovering).error).toBe('Third: denied');
  });
});

describe('mobile Home startup reads', () => {
  it('returns the local value when the read settles in time', async () => {
    const read = startBoundedStartupRead(Promise.resolve('cached'), 'fallback', 100);

    await expect(read.initial).resolves.toEqual({ timedOut: false, value: 'cached' });
  });

  it('falls back on read failure', async () => {
    const read = startBoundedStartupRead(Promise.reject(new Error('read failed')), 'fallback', 100);

    await expect(
      read.initial,
    ).resolves.toEqual({ timedOut: false, value: 'fallback' });
    await expect(read.completion).resolves.toEqual({ ok: false, value: 'fallback' });
  });

  it('falls back on timeout while preserving a late local value', async () => {
    vi.useFakeTimers();
    try {
      let finishRead: ((value: string) => void) | undefined;
      const pendingRead = new Promise<string>((resolveRead) => {
        finishRead = resolveRead;
      });
      const read = startBoundedStartupRead(pendingRead, 'fallback', 100);

      await vi.advanceTimersByTimeAsync(100);
      await expect(read.initial).resolves.toEqual({ timedOut: true, value: 'fallback' });

      finishRead?.('late-cache');
      await Promise.resolve();
      await expect(read.completion).resolves.toEqual({ ok: true, value: 'late-cache' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mobile home desktop-first surface', () => {
  it('surfaces durable logout failures from the home drawer', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const logoutStart = source.indexOf('const logout = useCallback');
    const logoutBody = source.slice(
      logoutStart,
      source.indexOf('const toggleProject', logoutStart),
    );

    expect(logoutBody).toContain('await auth.logout();');
    expect(logoutBody).toContain("t('devices.list.alert.actionFailed')");
    expect(logoutBody).toContain('formatRemoteError(error)');
  });

  it('uses the desktop-sidebar Home as the authenticated root instead of a device picker route', () => {
    const indexSource = readSource('app/index.tsx');
    const layoutSource = readSource('app/_layout.tsx');

    expect(indexSource).toContain("import HomeScreen from './devices';");
    expect(indexSource).toContain('return <HomeScreen />;');
    expect(indexSource).not.toContain("auth.isAuthenticated ? '/devices' : '/login'");
    expect(layoutSource).toContain("router.replace('/');");
    expect(layoutSource).not.toContain("router.replace('/devices');");
  });

  it('keeps the home list leaner than device detail surfaces', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const removedListTokenPrefix = 'home' + 'List';

    expect(source).toContain('export function MobileHome(props: MobileHomeProps)');
    expect(source).not.toContain('export default function DevicesScreen()');
    expect(source).not.toContain('styles.deviceChipBadge');
    expect(source).not.toContain('styles.worktreeBadge');
    expect(source).not.toContain('MonitorSmartphone');
    expect(source).not.toContain("title: 'Projects'");
    expect(source).not.toContain("title: 'Chats'");
    expect(source).not.toContain('placeholder="Search Chats"');
    expect(source).not.toContain('placeholder="搜索会话"');
    expect(source).not.toContain('testID="home.searchToggleButton"');
    expect(source).not.toContain('styles.bottomBar');
    expect(source).not.toContain('styles.newChatText');
    expect(source).not.toContain('home.projectNewSessionButton');
    expect(source).not.toContain('styles.projectActionButton');
    expect(source).not.toContain('relayStatusLabel');
    expect(source).not.toContain('relayStatusHint');
    expect(source).not.toContain('Relay 已连接');
    expect(source).not.toContain('Relay 未连接');
    expect(source).not.toContain('正在连接 Relay');
    expect(source).not.toContain('styles.connectionButton');
    expect(source).not.toContain('fontSize: 28');
    expect(source).not.toContain('height: 50');
    expect(source).not.toContain('width: 50');
    expect(source).toContain('RefreshCw');
    expect(source).toContain('homeConnectionTitle');
    expect(source).toContain("if (status === 'connecting') return t('devices.list.connection.connecting');");
    expect(source).toContain("if (status === 'stopped') return t('devices.list.connection.disconnected');");
    expect(source).toContain('styles.connectionIconButton');
    expect(source).toContain('const [deviceMenuOpen, setDeviceMenuOpen]');
    expect(source).toContain('const [groupByProject, setGroupByProject]');
    expect(source).toContain('testID="home.deviceMenu"');
    expect(source).toContain('testID="home.chromeMenu"');
    // The display-menu e2e anchor belongs to its extracted platform component;
    // nativeGlassControls.test.tsx checks it on the rendered menu.
    expect(source).toContain('<HomeChromeDrawer');
    expect(source).toContain('<HomeHeaderGlassButton');
    const headerGlass = readSource('src/session/HomeHeaderGlassButton.ios.tsx');
    expect(headerGlass).toContain('<NativeChromeButton');
    const nativeBack = readSource('src/platform/chrome/NativeChromeBackButton.ios.tsx');
    expect(nativeBack).toContain('<NativeChromeButton');
    const systemBack = readSource('src/platform/chrome/SystemNavigationBack.tsx');
    expect(systemBack).toContain('<Stack.Toolbar.Button');
    expect(systemBack).not.toContain('<Stack.Toolbar.View');
    expect(systemBack).not.toContain('<NativeChromeButton');
    expect(headerGlass).not.toContain('expo-glass-effect');
    expect(source).toContain('<HomeChromeFrost disabled={nativeHomeHeader} visible={headerFrosted}>');
    expect(source).toContain('</HomeChromeFrost>');
    expect(source).toContain('<HomeNativeStackHeader');
    expect(source).toContain('onProjectDragStart={displayedProjectOrder === \'custom\'');
    expect(source).toContain('projectOrder: displayedProjectOrder,');
    expect(source).toContain('resolveDisplayedProjectOrder(');
    expect(source).not.toContain('projectOrder={selectedDeviceId ? hostProjectOrder : projectOrder}');
    expect(source).toContain('<HomeGlassMenuPanel');
    expect(source).toContain('<HomeMenuScrim');
    const glassMenu = readSource('src/session/HomeGlassMenuPanel.tsx');
    expect(glassMenu).toContain('from \'expo-glass-effect\'');
    expect(glassMenu).toContain('<GlassView');
    expect(glassMenu).toContain('glassEffectStyle="regular"');
    expect(glassMenu).toContain('<View style={styles.body}>{children}</View>');
    expect(glassMenu).toContain('style={styles.glass}');
    expect(glassMenu).not.toMatch(/<GlassView[\s\S]*StyleSheet\.absoluteFill/);
    expect(source).toContain('onScroll={onListScroll}');
    const chromeFrost = readSource('src/session/HomeChromeFrost.tsx');
    expect(chromeFrost).toContain('overlayColor={colors.surfaceTranslucent}');
    expect(chromeFrost).toContain('intensity={50}');
    expect(chromeFrost).toContain('<View style={styles.body}>{children}</View>');
    expect(chromeFrost).not.toContain('expo-glass-effect');
    expect(source).not.toContain("import { BlurView } from 'expo-blur';");
    const chromeDrawer = readSource('src/session/HomeChromeDrawer.tsx');
    expect(chromeDrawer).toContain('testID="devices.settingsButton"');
    expect(chromeDrawer).toContain('testID="home.chromeDrawer.search"');
    expect(chromeDrawer).toContain('testID="home.chromeDrawer.account"');
    expect(chromeDrawer).toContain('testID="home.chromeDrawer.accounts"');
    expect(chromeDrawer).toContain('testID="home.chromeDrawer.logout"');
    expect(chromeDrawer.indexOf('testID="devices.settingsButton"'))
      .toBeLessThan(chromeDrawer.indexOf('testID="home.chromeDrawer.accounts"'));
    expect(chromeDrawer.indexOf('testID="home.chromeDrawer.accounts"'))
      .toBeLessThan(chromeDrawer.indexOf('testID="home.chromeDrawer.logout"'));
    expect(chromeDrawer).toContain('<View style={styles.menuDivider} />');
    expect(chromeDrawer.indexOf('<View style={styles.menuDivider} />'))
      .toBeLessThan(chromeDrawer.indexOf('testID="home.chromeDrawer.logout"'));
    expect(chromeDrawer.match(/onPress=\{onOpenAccounts\}/g)).toHaveLength(1);
    expect(chromeDrawer).toContain("t('settings.account.logout')");
    expect(chromeDrawer).toContain('openSettingsImmediately');
    expect(chromeDrawer).toContain('closeInstant');
    expect(chromeDrawer).toContain('FullWindowOverlay');
    expect(chromeDrawer).toContain('GestureHandlerRootView');
    expect(chromeDrawer).not.toContain('remoteSettings');
    expect(source).toContain("guardedPush('/settings')");
    expect(source).not.toContain('setChromeMenuCloseInstant');
    expect(source).toContain('onClosed={handleChromeMenuClosed}');
    for (const route of ['/settings', '/devices/manage', '/plugins']) {
      expect(source).not.toContain(`pendingMenuActionRef.current = () => guardedPush('${route}')`);
      expect(source).toContain(`setChromeMenuOpen(false);\n          guardedPush('${route}');`);
    }
    const rootLayout = readSource('app/_layout.tsx');
    expect(rootLayout).not.toContain("animation: 'slide_from_left'");
    expect(source).toContain("label={t('devices.list.allConversations')}");
    // 显示菜单只有一份菜单模型(homeChromeMenus),原生下拉 / 自绘兜底都消费它,不再有平行的自绘面板。
    expect(source).toContain('homeDisplayActionPatch(id, displayMenuState)');
    expect(source).not.toContain('HomeDisplaySettingsModal');
    expect(source).not.toContain('testID="home.deviceMenu.remoteSettings"');
    expect(source).not.toContain('onOpenRemoteSettings');
    // 注:首页分区构造逻辑(buildMixedHomeRows / buildGroupedHomeRows / buildHomeSections)
    // 已抽到 @/session/homeSections,并由 homeSections.test.ts 做行为测试,这里不再做源码字符串断言。
    expect(source).toContain('styles.sessionListRow');
    expect(source).not.toContain('styles.sessionCard');
    expect(source).not.toContain('styles.sessionBadge');
    expect(source).toContain('backgroundColor: colors.surface');
    expect(source).toContain('borderBottomColor: colors.border');
    expect(source).not.toContain('<GlassView');
    expect(source).toContain('<HomeHeaderGlassButton');
    const floatingAction = readSource('src/session/HomeNewTaskButton.tsx');
    expect(source).toContain('<HomeNewTaskButton');
    expect(floatingAction).toContain('prominent={!glass} size={HOME_NEW_TASK_SIZE} artworkSize={iconSize.xxl}');
    // Preserve SquarePen artwork while adopting the shared native action size.
    expect(floatingAction).toContain('SquarePen');
    // Untinted system glass with a primary icon; the solid filled circle is only the no-glass fallback.
    expect(floatingAction).toContain('<SquarePen color={glass ? colors.textPrimary : colors.ctaText} size={iconSize.xxl} strokeWidth={iconStroke.regular} />');
    expect(floatingAction).toContain('prominent={!glass}');
    expect(source).not.toContain('<Send');
    expect(source).not.toContain('function HomeNewChatGlyph');
    expect(source).not.toContain("import Svg, { Path } from 'react-native-svg';");
    expect(source).not.toContain(`colors.${removedListTokenPrefix}Background`);
    expect(source).not.toContain(`colors.${removedListTokenPrefix}Divider`);
    expect(source).not.toContain(`colors.${removedListTokenPrefix}Shadow`);
    expect(source).toContain('fontWeight: fontWeight.medium');
    expect(floatingAction).toContain('testID="home.newChatButton"');
    expect(floatingAction).toContain("position: 'absolute'");
    // The button sits on the composer's resting line so the circle can stretch into the pill.
    expect(floatingAction).toContain('bottom: bottomInset + composerGeometry.restingGap');
    expect(floatingAction).toContain('right: composerGeometry.horizontalInset');
    expect(floatingAction).toContain('HOME_NEW_TASK_SIZE = composerGeometry.pillHeight');
  });

  it('opens desktop-parity search filters from the search sliders, not display settings', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const searchBar = readSource('src/session/HomeSearchBar.tsx');
    const filterSheet = readSource('src/session/ConversationSearchFilterSheet.tsx');

    expect(searchBar).toContain('<NativePullDownMenu');
    expect(source).toContain('<HomeSearchBar');
    expect(source).toContain('onOpenFilter={() => setSearchFilterOpen(true)}');
    expect(source).not.toContain('onOpenFilter={openDisplaySettings}');
    expect(source).toContain('<ConversationSearchFilterSheet');
    expect(searchBar).toMatch(/testID=\{testIDs\?\.filter \?\? ['"]home\.searchFilterButton['"]\}/);
    expect(filterSheet).toContain('testID="home.searchFilter"');
    expect(filterSheet).toContain('devices.list.search.filter.sortHeading');
    expect(filterSheet).toContain('devices.list.search.filter.statusHeading');
    expect(filterSheet).toContain('devices.list.search.filter.projectsHeading');
    expect(filterSheet).toContain('devices.list.search.filter.agentHeading');
    expect(filterSheet).toContain('devices.list.search.filter.lastActivityHeading');
    expect(filterSheet).toContain('devices.list.search.filter.label');
    expect(filterSheet).toContain("'all', 'cc', 'codex', 'pi'");
    expect(source).toContain('conversationSearchOriginsFromDeviceModels');
    expect(source).toContain('setConversationSearchDeviceModels');
    expect(source).not.toContain(': deviceModels.filter((item) => item.canOpen);');
  });

  it('uses TapTap blue for the online dot treatment', () => {
    const homeSource = readSource('src/session/HomeSurface.tsx');
    const primitivesSource = readSource('src/components/MobilePrimitives.tsx');
    const tokenSource = readSource('src/theme/tokens.ts');
    const removedListTokenPrefix = 'home' + 'List';

    // E5M 状态色设计定稿(2026-07-17):teal 族 #00D9C5 → #19D2C1,statusReady 随 awaiting 同步。
    expect(tokenSource).toContain("statusReady: '#19D2C1'");
    expect(tokenSource).toContain("homeListFab: '#E6E6E6'");
    expect(tokenSource).not.toContain(`${removedListTokenPrefix}Background`);
    expect(tokenSource).not.toContain(`${removedListTokenPrefix}Divider`);
    expect(primitivesSource).toContain('tone === \'ready\' && styles.statusDotReady');
    expect(primitivesSource).toContain('backgroundColor: colors.statusReady');
    expect(primitivesSource).toContain('pulsing && {');
    expect(primitivesSource).toContain('scale: pulse.interpolate');
    expect(primitivesSource).not.toContain('statusDotReady: {\n    backgroundColor: colors.textPrimary');
    // 范围菜单已跟随 iOS 系统下拉,不再画设备在线点(见 DeviceMenuItem 断言)。
    expect(homeSource).not.toContain("tone={status === 'online' ? 'ready' : 'off'}");
  });

  it('mirrors the desktop sidebar Agent identity slot and running treatment', () => {
    const homeSource = readSource('src/session/HomeSurface.tsx') + readSource('src/session/HomeListVisuals.tsx');
    const vendorIconSource = readSource('src/components/MobileVendorIcon.tsx');
    const agentMarkSource = readSource('src/components/MobileAgentMark.tsx');
    const providerMarkSource = readSource('src/session/MobileProviderMark.tsx');
    // 品牌 path 常量已抽到 vendorIconPaths.ts(供 MobileVendorIcon 与 MobileProviderMark 共用)。
    const vendorPathsSource = readSource('src/components/vendorIconPaths.ts');
    const desktopVendorIconSource = readSource(
      '../../apps/desktop/src/renderer/components/sidebar/VendorIcon.tsx',
    );

    expect(desktopVendorIconSource).toContain(
      'VendorIcon — sidebar session 行的 Agent 身份 + running 状态指示器',
    );
    // 2026-07-20 双端 Agent mark 同步为 Claude Code 像素脸 / Codex CLI `>_` 花形。
    // ——箭头统一后依赖图标区分 agent 类型的场景(创建自动化 chips / 侧栏混排)全部失效。
    expect(desktopVendorIconSource).toContain('ClaudeMark');
    expect(desktopVendorIconSource).toContain('CodexMark');
    expect(desktopVendorIconSource).toContain("vendor === 'codex' ? (");
    expect(desktopVendorIconSource).toContain('<CodexMark size={size} />');
    expect(desktopVendorIconSource).toContain('<ClaudeMark size={size} />');
    expect(desktopVendorIconSource).toContain("export type VendorIconKind = 'cc' | 'codex' | 'pi'");
    expect(desktopVendorIconSource).toContain('vendor: VendorIconKind;');
    expect(desktopVendorIconSource).toContain('session-status-breathing');
    expect(vendorIconSource).not.toContain('XD_SYMBOL_PATHS');
    expect(vendorIconSource).not.toContain('XD_INC_MARK_ASPECT_RATIO');
    expect(vendorIconSource).not.toContain('iconWidth');
    expect(agentMarkSource).toContain('width={size}');
    expect(agentMarkSource).toContain('height={size}');
    expect(agentMarkSource).toContain('viewBox="0 0 24 24"');
    expect(vendorPathsSource).toContain('CLAUDE_AGENT_PATH');
    expect(vendorPathsSource).toContain('CODEX_AGENT_FLOWER_PATH');
    expect(vendorPathsSource).toContain('CODEX_AGENT_PROMPT_PATH');
    expect(agentMarkSource).not.toContain('ANTHROPIC_PROVIDER_PATH');
    expect(agentMarkSource).not.toContain('OPENAI_PROVIDER_PATH');
    expect(providerMarkSource).toContain('ANTHROPIC_PROVIDER_PATH');
    expect(providerMarkSource).toContain('OPENAI_PROVIDER_PATH');
    expect(providerMarkSource).not.toContain('CLAUDE_AGENT_PATH');
    expect(providerMarkSource).not.toContain('CODEX_AGENT_FLOWER_PATH');
    expect(vendorIconSource).toContain("import { MobileAgentMark } from './MobileAgentMark';");
    // vendor → Agent mark 的映射要带上 pi,不能把 π 吞成 Claude 脸。
    expect(vendorIconSource).toContain(
      "const agentKind: AgentMarkKind = vendor === 'codex' || vendor === 'pi' ? vendor : 'claude-code';",
    );
    expect(vendorIconSource).toContain('<MobileAgentMark agentKind={agentKind} color={color} size={size} />');
    expect(vendorIconSource).not.toContain('viewBox="136 137 282 158"');
    expect(vendorIconSource).not.toContain('transform="translate(');
    expect(vendorIconSource).toContain('Easing.inOut(Easing.ease)');
    // 行运行态经订阅获取(memo 化后命令式读取会 stale,2026-07-18 重渲染风暴修复)
    expect(homeSource).toContain('const sessionIsRunning = useSessionRunning(latestItem.session.id);');
    // 保鲜契约:项目/自动化折叠只订阅低频首页状态；消息预览下沉到 session 行。
    // 普通流式 token 不得再通过全局 storeVersion 唤醒整棵首页列表。
    expect(homeSource).not.toContain('useRemoteSessionStoreVersion();');
    expect((homeSource.match(/useRemoteHomeStatusVersion\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(homeSource).toContain('useRemoteSessionMessagePreview(item.session.id)');
    expect(homeSource).toContain('useRemoteMessageVersion(normalizedSearchQuery.length > 0)');
    expect(readSource('src/session/HomeSessionInfoMeta.tsx')).toContain('useMinuteNow();');
    expect(homeSource).toContain('<RadioTower');
    expect(homeSource).toContain('<UsersRound');
    expect(homeSource).not.toContain('<Puzzle');
    expect(homeSource).toContain('width: 24');
    expect(homeSource).toContain('width: iconSize.md');
    expect(homeSource).toContain('size={isClaudeCodeAgentKind(item.session.agentKind) ? 19 : iconSize.lg}');
    expect(homeSource).toContain("function isClaudeCodeAgentKind(agentKind: string): boolean");
    expect(homeSource).toContain("return agentKind === 'cc' || agentKind === 'claude-code';");
    expect(homeSource).not.toContain('sessionAttentionDot: {\n    backgroundColor: colors.statusAccent,\n    borderColor: colors.surface');
    expect(homeSource).not.toContain('sessionAttentionDot: {\n    backgroundColor: colors.statusAccent,\n    borderRadius: 3,\n    borderWidth: 1');
  });

  it('uses desktop-style attention dots for unread automation on the home list without extra row text', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const scheduleIndexSource = readSource('src/session/scheduleIndex.ts');

    expect(source).toContain('const [scheduleIndex, setScheduleIndex]');
    expect(source).toContain('useRemoteScheduleMirrorInvalidations()');
    expect(source).toContain('invalidateRunningSessionScheduleEntries(current, sessionIds)');
    expect(source).toContain('const [deviceIdentityCacheReady, setDeviceIdentityCacheReady]');
    expect(source).toContain('loadDeviceIdentityCache()');
    expect(source).toContain('reconcileDeviceIdentities(');
    expect(source).toContain('saveDeviceIdentityCache(result.cache)');
    expect(source).toContain('loadDeviceSessionScheduleIndex(deviceId, invoke,');
    expect(source).toContain('replaceSessionScheduleIndexEntries(');
    expect(source).toContain("invoke<unknown>(device.deviceId, 'maker:list-active', [");
    expect(source).toContain("{ summary: true, snapshotVersion: 2 }");
    expect(source).toContain('if (isOptionalActiveSessionSnapshotError(err)) return null;');
    expect(source).toContain('function isOptionalActiveSessionSnapshotError(error: unknown): boolean');
    expect(source).toContain('if (isAccessRevokedError(error) || isDeviceOfflineError(error)) return false;');
    expect(source).toContain("if (text.includes('REMOTE_DISABLED')) return false;");
    expect(source).toContain('return true;');
    expect(source).toContain('await runIndependentSnapshotReads([');
    expect(source).toContain('remoteSessionStore.captureActiveSessionSnapshotEpoch()');
    expect(source).toContain('return [active, epoch] as const;');
    expect(source).toContain('activeSessionSnapshotEpoch,');
    expect(source).toContain('remoteScheduleEventStore.subscribe(() => {');
    expect(source).toContain('const snapshot = remoteScheduleEventStore.getSnapshot(deviceId)');
    expect(source).toContain('const version = snapshot.version');
    expect(source).toContain('if (version === 0) {');
    expect(source).toContain('scheduleEventVersionsRef.current.delete(deviceId)');
    expect(source).toContain("projection?.refresh.sessionIndex !== true && projection?.runPatch.status !== 'running'");
    expect(source).toContain('refreshDeviceScheduleIndex(deviceId, sessionIds);');
    expect(source).not.toContain('force: projection.refresh.scheduleList');
    expect(source).toContain('scheduleIndex,');
    expect(source).toContain('const attention = item.pendingInteractionCount > 0');
    expect(source).toContain('|| (item.scheduleInfo?.unreadCount ?? 0) > 0');
    expect(source).toContain('|| item.liveActivity?.attention === true;');
    // 提醒点已从行首 icon 角标移到行右侧状态槽(替代时间位),五档判定与桌面
    // sidebarRightStatus 对齐:error 红 > awaiting TapTap 蓝 > running spinner > 完成绿 > 时间。
    expect(source).toContain('resolveMobileSessionRowStatus(item, sessionIsRunning, groupExpanded)');
    expect(source).toContain('styles.sessionRightDot');
    expect(source).toContain('<SessionRightSpinner');
    expect(source).not.toContain('sessionAttentionDot');
    expect(source).not.toContain('未读 {item.scheduleInfo');
    expect(scheduleIndexSource).toContain('buildSessionScheduleIndex');
    expect(scheduleIndexSource).toContain('SCHEDULE_INDEX_RUN_LIMIT = 50');
  });

  it('gives device chips stable per-device e2e anchors for multi-device local smoke', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const maestroSource = readSource('scripts/maestro-e2e.mjs');
    const localSmokeSource = readSource('scripts/local-device-link-smoke.mjs');
    const deviceDetailFlow = readSource('e2e/maestro/session_list_controls.yaml');

    expect(source).toContain('item.deviceId !== null && canBrowseMobileHomeDevice(item)');
    expect(source).toContain('`home.deviceChip.${sanitizeDeviceChipTestId(item.deviceId)}`');
    expect(source).toContain('function sanitizeDeviceChipTestId');
    expect(source).toContain("return value.replace(/[^A-Za-z0-9_-]/g, '_');");
    expect(source).not.toContain("const testID = item.deviceId ? 'home.deviceChip' : 'home.deviceChip.all';");
    expect(localSmokeSource).toContain('process.env.XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID = mockHostDeviceChipId;');
    expect(maestroSource).toContain('XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID=${hostDeviceChipId}');
    expect(deviceDetailFlow).toContain('id: "deviceManagement.open.${XDT_MOBILE_E2E_HOST_DEVICE_ID}"');
  });

  it('keeps device management in the drawer and scope selection direct', () => {
    const home = readSource('src/session/HomeSurface.tsx');
    const drawer = readSource('src/session/HomeChromeDrawer.tsx');
    const management = readSource('app/devices/manage.tsx');

    expect(drawer).toContain('testID="home.chromeDrawer.devices"');
    expect(home).toContain("guardedPush('/devices/manage')");
    expect(home).not.toContain('onRenameDevice=');
    expect(home).not.toContain('onOpenDevice=');
    expect(management).toContain('key={generation}');
    expect(management).toContain("pathname: '/devices/manage/[deviceId]'");
    expect(management).toContain('onRename={manager.openRename}');
  });

  it('scopes multi-device connection feedback to the affected device chip', () => {
    const source = readSource('src/session/HomeSurface.tsx');

    expect(source).toContain("type HomeDeviceConnectionState = 'idle' | 'syncing' | 'failed';");
    expect(source).toContain('const [rawDeviceConnectionStates, setDeviceConnectionStates]');
    // 熔断 open 的设备复用 failed 渲染路径:内部态映射(merged memo)覆盖在 hydrate 状态之上
    expect(source).toContain('const unresponsiveDevices = useUnresponsiveDevices();');
    expect(source).toContain("for (const deviceId of unresponsiveDevices) merged[deviceId] = 'failed';");
    expect(source).toContain("updateDeviceConnectionState(device.deviceId, 'syncing');");
    expect(source).toContain("updateDeviceConnectionState(device.deviceId, 'failed');");
    expect(source).toContain("updateDeviceConnectionState(device.deviceId, 'idle');");
    // Row visibility is exercised through Home's actual expressions above.
    expect(source).toContain('homeSyncDeviceIds.filter((id) => unresponsiveDevices.has(id)');
    expect(source).toContain('function DeviceMenuItem');
    expect(source).not.toContain('function DeviceConnectionSpinner');
    expect(source).not.toContain('deviceConnectionSpinner');
    // 范围菜单跟随 iOS 系统下拉:自绘回退也不画在线点 / 同步脉冲 / 失败圈。
    const deviceMenuItem = source.slice(
      source.indexOf('function DeviceMenuItem'),
      source.indexOf('function RevokedAccessTip'),
    );
    expect(deviceMenuItem).not.toContain('<StatusDot');
    expect(deviceMenuItem).not.toContain('connectionState');
    expect(source).not.toContain('connectionStates={deviceConnectionStates}');
    expect(source).not.toContain('deviceConnectionFailedRing');
  });

  it('keeps project and session rows at desktop sidebar information density', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const automationTimerSource = readSource('src/session/AutomationTimerIcon.tsx');
    const desktopProjectNode = readSource(
      '../../apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectNode.tsx',
    );
    const projectRowStart = source.indexOf('function ProjectRow');
    const projectRowEnd = source.indexOf('function HomeSessionRow', projectRowStart);
    const projectRowSource = source.slice(projectRowStart, projectRowEnd);
    const sessionRowStart = source.indexOf('function HomeSessionRow');
    const sessionRowEnd = source.indexOf('function SessionStatusMark', sessionRowStart);
    const sessionRowSource = source.slice(sessionRowStart, sessionRowEnd);
    const stylesStart = source.indexOf('const makeStyles');
    const stylesSource = source.slice(stylesStart) + readSource('src/session/HomeListVisuals.tsx');

    expect(desktopProjectNode).toContain('const Chevron = isCollapsed ? ChevronRight : ChevronDown;');
    expect(projectRowSource).toContain('project.title');
    // 折叠对齐桌面版:走共享 getRemoteSessionPreviewCollapse(24h 活动 / 需关注 / 运行中豁免),
    // 不再是 slice 硬截断。
    expect(projectRowSource).toContain('getRemoteSessionPreviewCollapse(');
    expect(projectRowSource).toContain('limit: showAll ? project.sessions.length : PROJECT_PREVIEW_LIMIT');
    expect(projectRowSource).not.toContain('project.sessions.slice(0, PROJECT_PREVIEW_LIMIT)');
    expect(projectRowSource).toContain('<Folder');
    expect(projectRowSource).toContain('project.sessionCount');
    expect(projectRowSource).toContain('home.projectViewAll');
    expect(projectRowSource).not.toContain('<SquarePen');
    expect(projectRowSource).not.toContain('<Ellipsis');
    expect(projectRowSource).not.toContain('project.pendingInteractionCount');
    // 收起组头汇总对齐桌面 ProjectNode:仅收起时计算,运行态走图标呼吸,右槽只放一颗点。
    expect(desktopProjectNode).toContain('isCollapsed && lamp?.running');
    expect(projectRowSource).toMatch(/collapsed\s*\?\s*resolveMobileCollapsedGroupStatus\(project\.sessions,/);
    expect(projectRowSource).toContain('<SessionStatusPulse running={!!collapsedStatus?.running}>');
    expect(projectRowSource).toContain('home.projectCollapsedStatus.');
    // 组头按钮是单个无障碍元素:汇总状态必须挂在按钮自身,读屏才能读出。
    expect(projectRowSource).toContain('accessibilityValue={collapsedStatusA11y ? { text: collapsedStatusA11y } : undefined}');
    expect(projectRowSource).not.toContain('project.subtitle');
    expect(sessionRowSource).toContain('titleTestIDPrefix = \'home.sessionRowTitle\'');
    expect(sessionRowSource).toContain('`home.sessionRowTitle.${item.session.id}`');
    // 标签色球紧跟标题(与桌面侧栏一致):标题与色球同在一组,标题只取文字宽度,
    // 不能再用 flex: 1 把色球挤到行尾贴着时间。
    const titleClusterStart = sessionRowSource.indexOf('<View style={[styles.sessionTitleCluster, groupChevronVisible && styles.sessionTitleClusterGroupHit]}>');
    expect(titleClusterStart).toBeGreaterThan(-1);
    const titleCluster = sessionRowSource.slice(titleClusterStart, sessionRowSource.indexOf('{sourceLabel ? (', titleClusterStart));
    expect(titleCluster).toMatch(/\{item\.title\}\s*<\/Text>\s*<TaskTagDots tags=\{item\.session\.tags\} surfaceColor=\{colors\.surface\} \/>\s*<\/View>/);
    // 自动化组展开箭头在标题组之外、作为标题行的不收缩子项:标签色球不收缩,放在组内会被挤出
    // 父容器边界导致 44×44 热区被截(#5909 review);热区靠自身尺寸,不靠 hitSlop。
    const groupChevron = titleCluster.slice(titleCluster.indexOf('</View>'));
    expect(groupChevron).toContain('testID={`${testID}.automationGroupChevron`}');
    expect(groupChevron).toContain('style={styles.sessionGroupChevronCell}');
    expect(groupChevron).not.toContain('hitSlop={');
    const listStyles = readSource('src/session/HomeListVisuals.tsx');
    const titleStyle = listStyles.slice(listStyles.indexOf('  sessionTitle: {'), listStyles.indexOf('},', listStyles.indexOf('  sessionTitle: {')));
    expect(titleStyle).toContain('flexShrink: 1');
    expect(titleStyle).not.toContain('flex: 1');
    expect(sessionRowSource).toContain('ellipsizeMode="tail"');
    expect(sessionRowSource).toContain('numberOfLines={1}');
    expect(sessionRowSource).toContain('buildRemoteSessionCardPreview(');
    expect(sessionRowSource).toContain('useRemoteSessionMessagePreview(item.session.id)');
    expect(sessionRowSource).toContain('testID={`home.sessionRowPreview.${item.session.id}`}');
    expect(sessionRowSource).toContain('const showPreviewLine = !textMode && (!!group || !!preview?.trim() || showSchedule || showPinned);');
    expect(sessionRowSource).toContain('!showPreviewLine && styles.sessionListRowSingleLine');
    expect(sessionRowSource).toContain('!showPreviewLine && styles.sessionIconCellSingleLine');
    expect(sessionRowSource).toContain('{showPreviewLine ? (');
    expect(sessionRowSource).not.toContain('numberOfLines={2}');
    // 相对时间下沉到独家订阅分钟心跳的叶子组件(行主体 memo 化后由它单独保鲜,风暴修复)
    // 时间槽改由「任务信息」渲染,时间仍是其中独家订阅分钟心跳的叶子组件。
    expect(sessionRowSource).toContain('<HomeSessionInfoMeta item={item} textStyle={styles.sessionTime} />');
    const infoMeta = readSource('src/session/HomeSessionInfoMeta.tsx');
    expect(infoMeta).toContain('<SessionRelativeTime lastActivityAt={item.lastActivityAt}');
    expect(infoMeta).toContain('formatRemoteSessionSidebarTime(lastActivityAt)');
    expect(sessionRowSource).toContain('item.pendingInteractionCount');
    expect(sessionRowSource).toContain('item.scheduleInfo?.unreadCount');
    expect(sessionRowSource).toContain('item.session.pinnedAt');
    expect(sessionRowSource).toContain('styles.sessionTrailingIcons');
    expect(sessionRowSource).toContain('<AutomationTimerIcon');
    expect(sessionRowSource).toContain('paused={scheduleStopped}');
    expect(sessionRowSource).toContain('item.scheduleInfo?.allSchedulesStopped === true');
    expect(source).not.toContain('Clock,');
    expect(automationTimerSource).toContain("import { Pause, Timer } from 'lucide-react-native';");
    expect(automationTimerSource).toContain('<Timer color={colors.textTertiary}');
    expect(automationTimerSource).toContain('<Pause color={colors.textTertiary}');
    expect(automationTimerSource).not.toContain('opacity: 0.6');
    expect(automationTimerSource).toContain('position: \'absolute\'');
    expect(automationTimerSource).toContain('backgroundColor: colors.surfaceChip');
    expect(automationTimerSource).toContain('borderColor: colors.border');
    expect(sessionRowSource).not.toContain('SessionBadge');
    expect(source).toContain('const HOME_SESSION_ROW_HEIGHT = 78;');
    expect(source).toContain('const HOME_SESSION_SINGLE_LINE_ROW_HEIGHT = 60;');
    // 列表行只保留通栏 legacy 一套皮,不再双轨 cindyList 变体。
    expect(source).not.toContain('variant="legacy"');
    expect(source).not.toContain('variant="cindyList"');
    expect(source).not.toContain('HomeSessionRowVariant');
    expect(source).not.toContain('const CINDY_LIST_ROW_HEIGHT');
    expect(stylesSource).toContain('height: HOME_SESSION_ROW_HEIGHT');
    expect(stylesSource).toContain('height: HOME_SESSION_SINGLE_LINE_ROW_HEIGHT');
    expect(stylesSource).not.toContain('height: CINDY_LIST_ROW_HEIGHT');
    // 通栏:项目子行回 surface 全宽底(用户改稿 2026-07-21)。
    expect(stylesSource).toContain('projectChildren: {\n    backgroundColor: colors.surface,');
    expect(stylesSource).not.toContain('sessionListRowIndentedCindy');
    expect(stylesSource).not.toContain('sessionListRowDeepIndentedCindy');
    expect(stylesSource).not.toContain('automationGroupChildrenCindy');
  });

  it('keeps presence global while reconnecting only the visible Home sync scope', () => {
    const source = readSource('src/session/HomeSurface.tsx');

    expect(source).toContain('void loadHome({ visible: false });');
    expect(source).toMatch(/startBoundedStartupRead\(\s*getCachedHomeListSnapshot\(homeCacheUserId\)/);
    expect(source).toContain('await syncInFlightRef.current;');
    expect(source).toMatch(/startBoundedStartupRead\(\s*loadDeviceIdentityCache\(\)/);
    expect(source).toMatch(/startBoundedStartupRead<HomeViewPreferences \| null>\(\s*readHomeViewPreferences\(preferenceOwnerRef\.current\)/);
    const preferenceHydration = source.slice(
      source.indexOf('// 冷启动恢复上次的首页视图偏好'),
      source.indexOf('// 卸载时取消所有延后中的 schedule-index hydration'),
    );
    expect(preferenceHydration).toContain('homeAccountGenerationRef.current !== expectedAccountGeneration');
    expect(preferenceHydration).toContain("if (!cancelled) { viewSession.write('preferencesHydrated', true); setHomeViewPreferencesHydrated(true); }");
    expect(source).toContain('const deviceIdentityCachePersistPendingRef = useRef(false);');
    // 重连(connectionEpoch 变化)必须无条件重拉全量设备 REST:presence 只在变化时广播、无全量重放,
    // 后台漏掉的上/下线事件只能靠重连快照兜底；每设备列表 fan-out 再按可见 scope 收窄。
    // homeListCacheHydrated 是一次性 gate(缓存种入完成后永久为 true,种入失败也置 true),
    // 只影响首次触发顺序(缓存先画、fresh 后覆盖),不会挡掉任何一次重连刷新。
    expect(source).not.toContain('homeSessionHydratedRef');
    expect(source).toContain('!homeViewPreferencesHydrated');
    expect(source).toContain('const startSilentHomeSync = useCallback(() => {');
    expect(source).toContain('}, [connectionEpoch, startSilentHomeSync]);');
    expect(source).toContain('resolveHomeDeviceSyncIds(');
    expect(source).toContain('reconcileHomeDeviceSyncScope(syncDeviceIds);');
    expect(source).toContain('runHomeDeviceSyncBatch(syncRows');
    expect(source).toContain('while (syncInFlightRef.current)');
    expect(source).toContain("unsubscribe(HOME_LIST_SUBSCRIPTION_OWNER, deviceId, ['sessions'])");
    expect(source).toContain('homeSyncGenerationByDeviceRef');
    expect(source).toContain('diffHomeDeviceSyncScope(homeSyncTargetDeviceIdsRef.current, desiredDeviceIds)');
    expect(source).toContain('isCurrentHomeSyncTarget(device.deviceId, expectedHomeSyncGeneration)');
    expect(source).toContain('homeHydrateInFlightByDeviceRef');
    expect(source).toContain('existing.homeSyncGeneration === expectedHomeSyncGeneration');
    expect(source).toContain('if (options.trailingIfInFlight) existing.rerunRequested = true;');
    expect(source).toContain('trailingIfInFlight: true');
    expect(source).toContain('captureDeviceSessionListMutationEpoch(');
    expect(source).toContain('isDeviceSessionListMutationEpochCurrent(');
    expect(source).toContain('needsRerun: true');
    expect(source).toContain('homeDeviceSyncLimiterRef.current.run');
    const hydrateSource = source.slice(
      source.indexOf('const hydrateDeviceSessions = useCallback'),
      source.indexOf('const probeRevokedDeviceAccess'),
    );
    expect(hydrateSource).not.toContain('releaseHomeListOwner(');
    expect(source).toContain('homeSyncGeneration: expectedHomeSyncGeneration');
    // REST 快照与飞行期间的 presence 补丁按新鲜度合并,防止过期快照把刚上线的设备改回离线。
    expect(source).toContain('mergeDeviceViewsWithFreshPresence(');
    expect(source).toContain('markPresenceFresh(presenceFreshnessRef.current, lastPresenceSnapshot.deviceId);');
    expect(source).toContain('collectFreshPresenceDeviceIds(presenceFreshnessRef.current, presenceEpochAtFetchStart)');
    expect(source).toContain('progressViewOffset={residentList.enabled ? 0 : chromeHeight}');
    // 下拉刷新与同步按钮都走可见的 loadHome,并一起刷新伙伴段。
    expect(source).toMatch(/const refreshHome = useCallback\(\(\) => \{\n    void loadHome\(\{ visible: true \}\);/);
    expect(source).toContain('onRefresh={refreshHome}');
    expect(source).toContain('onPress={refreshHome}');
    expect(source).toContain('patchDeviceViewsWithPresence(');
    expect(source).toContain('result.becameControllable');
    expect(source).toContain('remoteSessionStore.registerReseedHandler(item.device.deviceId');
    expect(source).toContain('syncInFlightRef');
    // Presence can refresh the pure project-icon projection. It must not
    // restart network hydration/silent sync for every heartbeat.
    expect(hydrateSource).not.toContain('presenceVersion');
    const silentSyncSource = source.slice(
      source.indexOf('const startSilentHomeSync = useCallback'),
      source.indexOf('// 把当前权威设备列表注入 remoteSessionStore'),
    );
    expect(silentSyncSource).not.toContain('presenceVersion');
    expect(source).not.toContain('refreshControl={<RefreshControl refreshing={loading}');
  });

  it('starts the silent list sync on Home focus and Android foreground activation', () => {
    const source = readSource('src/session/HomeSurface.tsx');
    const silentSync = source.slice(
      source.indexOf('const startSilentHomeSync = useCallback'),
      source.indexOf('// 把当前权威设备列表注入 remoteSessionStore'),
    );

    expect(silentSync).toContain('!deviceIdentityCacheReady');
    expect(silentSync).toContain('!homeListCacheHydrated');
    expect(silentSync).toContain('!homeViewPreferencesHydrated');
    expect(silentSync).toContain('void loadHome({ visible: false });');
    expect(silentSync).toContain('useFocusEffect(');
    expect(silentSync).toContain('startSilentHomeSync();');
    expect(silentSync).toContain("AppState.addEventListener('change'");
    expect(silentSync).toContain("if (nextState === 'active') startSilentHomeSync();");
    expect(silentSync).toContain('}, [connectionEpoch, startSilentHomeSync]);');
  });

  it('binds every Home device projection and async continuation to the active account generation', () => {
    const source = readSource('src/session/HomeSurface.tsx');

    // Home remains mounted across saved-account activation, so clearing the shared DeviceLink
    // stores is insufficient: page-local refs/state must disappear before the next paint too.
    expect(source).toContain('const accountGeneration = useRelayDataGeneration(auth.accountGeneration);');
    expect(source).toContain('return readDeviceList({ fresh: true });');
    expect(source).toContain('const homeAccountGenerationRef = useRef(accountGeneration);');
    expect(source).toContain('useLayoutEffect(() => {');
    expect(source).toContain('syncInFlightRef.current = null;');
    expect(source).toContain('devicesRef.current = [];');
    expect(source).toContain('setDevices([]);');
    expect(source).toContain('setDeviceConnectionStates({});');
    expect(source).toContain('setScheduleIndex(new Map());');

    // Both REST and per-device WS hydrations capture the owner generation and refuse every late
    // write. The old task's finally block must not drain a queue now owned by the next account.
    expect(source).toContain('const accountGenerationAtStart = accountGeneration;');
    expect(source).toContain('hydrateDeviceSessions(item.device, accountGenerationAtStart)');
    expect(source).toContain('homeAccountGenerationRef.current !== expectedAccountGeneration');
    expect(source).toContain('return { failure: null, offline: false, superseded: true };');
    expect(source).toContain('if (syncInFlightRef.current !== task) return;');

    // A late account-keyed startup cache read is another producer of the same projection and must
    // pass the identical owner fence before hydrating the shared session store.
    expect(source).toContain('const expectedAccountGeneration = accountGeneration;');
    expect(source).toMatch(/cancelled\s*\|\| homeAccountGenerationRef\.current !== expectedAccountGeneration/);
  });

  it('does not show the no-device empty state before startup sync settles', () => {
    const source = readSource('src/session/HomeSurface.tsx');

    expect(source).toContain('const initialHomeSettled = deviceIdentityCacheReady && lastSyncedAt !== null;');
    expect(homeFeedback({ initialHomeSettled: false })).toMatchObject({
      initialHomeLoading: true, initialHomeError: false,
    });
    expect(homeFeedback({ initialHomeSettled: false, connectionError: 'failed' })).toMatchObject({
      initialHomeLoading: false, initialHomeError: true,
    });
    expect(source).toContain('const hasOpenableLiveDevice = deviceModels.some((item) => item.canOpen);');
    // 首次 loadHome 落地前(含失败态)FAB 只认 live 设备:首页列表缓存画出的会话会合成出
    // 「可用」的 primaryDevice,但缓存设备不能当 live 设备开新会话(settle 后回归 primaryDevice 语义)。
    expect(source).toContain('const newSessionDisabled = !home.primaryDevice || (!initialHomeSettled && !hasOpenableLiveDevice);');
    expect(source).toContain("const emptyStateTitle = initialHomeError ? t('devices.list.syncFailed') : home.emptyTitle;");
    expect(source).toContain("testID={initialHomeError ? 'home.syncError' : 'home.empty'}");
    expect(source).toContain('testID="home.loading"');
    expect(source).toContain("t('devices.list.loading')");
  });

  it('renders the remote-access onboarding guide for the no-device empty state', () => {
    const source = readSource('src/session/HomeSurface.tsx');

    // 无可控制电脑时不再是一句话空态,而是产品模式引导(按 reason 分场景 + 云端 Cindy 预告);
    // 启动同步失败(initialHomeError)仍走同步失败空态,不冒充引导。
    expect(source).toContain('&& !initialHomeError');
    expect(source).toContain("&& home.emptyKind === 'noDevice'");
    expect(source).toContain('showRemoteGuide && home.emptyNoDevice ? (');
    expect(source).toContain('<RemoteAccessGuide');
    expect(source).toContain('testID="home.remoteAccessGuide"');
    // 引导态没有可筛选的对话:表头退化为纯品牌标题(无下拉菜单),新建 FAB 不渲染。
    expect(source).toContain('{showRemoteGuide ? (');
    expect(source).toContain("const newSessionEntryVisible = !showRemoteGuide && !taskSuggestionsPending && taskSuggestionsMode !== 'empty';");
    expect(source).toContain('{newSessionInSystemBar || newSessionInHeader || !newSessionEntryVisible ? null : (');
    // 临时任务列表抽屉不浮动新建按钮,新建放进抽屉顶栏;常驻列与首页不变。
    expect(source).toContain('const headerNewSession = newSessionInHeader && newSessionEntryVisible;');
    // 顶栏新建与浮动按钮走同一入口(openNewSession → guardedPush → 抽屉 runNavigation 先关再跳)。
    expect(source).toContain('onPress={() => openNewSession()} testID="home.headerNewSessionButton">');
    expect(source).toContain("if (run) run(() => push(href)); else push(href);");
    // 抽屉与首页左上角都只打开系统菜单(HomeChromeDrawer 自有渲染测试),不再有关闭分支。
    expect(source).toContain('onPress={openChromeMenu}\n          testID="home.chromeMenu"');
    expect(source).not.toContain('onDismiss');

    const guideSource = readSource('src/components/RemoteAccessGuide.tsx');
    // 文案已 i18n 化,断言改查 zh-CN catalog(单一事实源);源码只保留结构/交互契约。
    const t = i18n.getFixedT('zh-CN');
    // 步骤三的路径和开关名必须与桌面端设置页一致,避免用户按指引找不到开关。
    expect(t('deviceLink.connectStep1')).toBe('在电脑上安装并打开 Cindy');
    expect(t('deviceLink.connectStep2')).toBe('用与手机相同的账号登录');
    expect(t('deviceLink.connectStep3')).toContain('「设置 → 远程连接」');
    expect(t('deviceLink.connectStep3')).toContain('允许同账号设备控制本机');
    // 分场景交互:离线/开关未开可手动重新检查,被撤销访问有重试 CTA(Lock 图标对齐设备列表语义)。
    expect(guideSource).toContain("reason === 'firstRun'");
    expect(guideSource).toContain('home.remoteGuide.recheck');
    expect(guideSource).toContain('home.remoteGuide.retryAccess');
    expect(guideSource).toContain('<Lock');
    // 未来形态预告:云端 Cindy 上线后手机版可脱离电脑直接使用。
    expect(t('deviceLink.cloudTeaserTitle')).toBe('云端 Cindy 筹备中');
    expect(t('deviceLink.cloudTeaserCopy')).toBe('上线后无需电脑，手机版即可直接使用。');
  });
});

describe('home menu native header ownership', () => {
  it('hosts the Duo top-left menu inside the native bar instead of under its touch surface', () => {
    const home = readSource('src/session/HomeSurface.tsx');
    const header = readSource('src/platform/chrome/HomeStackHeader.tsx');
    expect(readSource('src/platform/chrome/HomeNativeStackHeader.tsx')).toContain('<HomeStackHeader');
    expect(home).toContain("nativeHomeHeader && homeGeometry.barEdge !== 'none'");
    expect(home).toContain('keepMenuTopLeft={keepMenuTopLeft}');
    expect(home).not.toContain('{keepMenuTopLeft ? (');
    const leftToolbar = header.split('<Stack.Toolbar placement="left">')[1].split('</Stack.Toolbar>')[0];
    expect(leftToolbar).toContain('<Stack.Toolbar.View hidesSharedBackground>');
    expect(leftToolbar).toContain('onPress={onOpenMenu}');
    expect(leftToolbar).toContain('testID={menuTestID}');
    expect(readSource('src/platform/chrome/HomeNativeStackHeader.tsx')).toContain('menuTestID="home.chromeMenu"');
    // Ordinary system toolbar actions keep their native adaptation.
    expect(leftToolbar).toContain('<Stack.Toolbar.Button');
  });
});

describe('home menu presentation', () => {
  it('keeps iOS on the left drawer instead of shadowing it with a bottom sheet', () => {
    expect(existsSync(resolve(process.cwd(), 'src/session/HomeChromeDrawer.ios.tsx'))).toBe(false);
    const drawer = readSource('src/session/HomeChromeDrawer.tsx');
    expect(drawer).toContain('translateX:');
    expect(drawer).toContain('FullWindowOverlay');
    expect(drawer).toContain('onPress={onClose}');
    expect(drawer).toContain('Gesture.Pan()');
    expect(drawer).not.toContain('ComposerSheet');
  });

  it('keeps the Android drawer in its own window above the resident home list', () => {
    const drawer = readSource('src/session/HomeChromeDrawer.tsx');
    // Wide layouts mount the home list in a root layer after the routes; an in-route
    // overlay cannot rise above it, so Android presents the drawer as a Dialog window.
    expect(drawer).not.toContain('if (Platform.OS !== "ios") return overlay;');
    expect(drawer).toMatch(/<Modal[\s\S]*?onRequestClose=\{requestClose\}[\s\S]*?transparent[\s\S]*?\{content\}\s*<\/Modal>/);
    expect(drawer).toContain('statusBarTranslucent');
    expect(drawer).toContain('navigationBarTranslucent');
    expect(drawer).not.toContain('BackHandler');
  });

  it('mounts the drawer search only after the Android dialog fully unmounts', () => {
    const home = readSource('src/session/HomeSurface.tsx');
    // 退场期间 Dialog 仍占着窗口焦点,搜索框 autoFocus 挂早了首次聚焦和软键盘
    // 会丢;搜索动作和其它菜单动作一样延后到 onClosed 再执行。
    expect(home).toContain('pendingMenuActionRef.current = () => setSearchOpen(true);');
  });
});

// Guard: remote-and-mobile-adaptation lifecycle/ownership contract. HomeSurface
// must coordinate freshness tokens, shared remote-store reseeds and schedule
// event generations; reordered commits can clear a newer request or miss rows
// while Home is covered. Unit planner/store behavior remains in homeListFreshness.
describe('Home list sync wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('keeps the visible-device sync scope while Home is covered', () => {
    const scope = source.slice(source.indexOf('const homeSyncDeviceIds = useMemo('), source.indexOf('const homeSyncDeviceIdSet'));
    expect(scope).toContain('resolveHomeDeviceSyncIds(');
    expect(scope).not.toContain('screenFocused');
    // Devices that stop being visible/usable are still released and unsubscribed.
    const reconcile = source.slice(source.indexOf('const reconcileHomeDeviceSyncScope'), source.indexOf('useEffect(() => () => {'));
    expect(reconcile).toMatch(/for \(const deviceId of diff\.release\) \{[\s\S]*homeListFreshnessRef\.current\.invalidate\(deviceId\);[\s\S]*releaseHomeListOwner\(deviceId\);/);
    expect(source).toContain("void unsubscribe(HOME_LIST_SUBSCRIPTION_OWNER, deviceId, ['sessions']).catch(() => undefined);");
  });

  it('records freshness only after a successful list pull and invalidates on failure', () => {
    const hydrate = source.slice(source.indexOf('const hydrateDeviceSessionsOnce = useCallback('), source.indexOf('const hydrateDeviceSessions = useCallback('));
    const capture = hydrate.indexOf('homeListFreshnessRef.current.capture(device.deviceId)');
    const subscribe = hydrate.indexOf("await subscribe(HOME_LIST_SUBSCRIPTION_OWNER, device.deviceId, ['sessions']);");
    const list = hydrate.indexOf("'local-db:sessions:list'");
    const applied = hydrate.indexOf('remoteSessionStore.setDeviceSessions(');
    const fresh = hydrate.indexOf('homeListFreshnessRef.current.markFresh(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(subscribe);
    expect(subscribe).toBeLessThan(list);
    expect(applied).toBeLessThan(fresh);
    expect(hydrate.slice(hydrate.indexOf('} catch (err) {'))).toContain('homeListFreshnessRef.current.invalidate(device.deviceId);');
  });

  it('refills only stale devices on focus return and keeps the full sync for other triggers', () => {
    const focus = source.slice(source.indexOf('const refillStaleHomeDevices = useCallback('), source.indexOf('// 把当前权威设备列表注入 remoteSessionStore'));
    expect(focus).toContain('screenFocusedRef.current = true;');
    expect(focus).toContain('const plan = planHomeListFocusReturn({');
    expect(focus).toMatch(/if \(plan\.kind === 'refill'\) \{\s*refillStaleHomeDevices\(plan\.deviceIds\);\s*if \(scheduleDirty\.size > 0\) refreshHomeScheduleIndexes\(scheduleDirty\);\s*return;\s*\}\s*refreshHomeScheduleIndexes\(\);\s*startSilentHomeSync\(\);/);
    expect(focus).toContain("if (nextState === 'background') homeListFreshnessRef.current.invalidateAll();");
    expect(focus).toContain("if (nextState === 'active') startSilentHomeSync();");
  });

  it('keeps a full-reload request from every full-sync trigger until a loadHome started after it commits', () => {
    // Invariant: any trigger needing a full sync (mount, foreground, reconnect, a full focus return,
    // dependency changes) leaves a request that only a later-started, committed loadHome clears.
    // A sync that fails, is skipped while covered or exits because Home blurred mid-flight keeps it,
    // so a quick return cannot downgrade to a device-row refill and miss bound/unbound computers.
    const silent = source.slice(source.indexOf('const startSilentHomeSync = useCallback(() => {'), source.indexOf('}, [deviceIdentityCacheReady, homeListCacheHydrated'));
    expect(silent.indexOf('requestHomeFullReload();')).toBeGreaterThan(-1);
    expect(silent.indexOf('requestHomeFullReload();')).toBeLessThan(silent.indexOf('if (!screenFocusedRef.current) return;'));
    // Single funnel: no other call site sets the request, nothing but a commit or account reset clears it.
    expect(source.match(/requestHomeFullReload\(\);/g)).toHaveLength(1);
    expect(source.match(/homeFullReloadOnFocusRef\.current = null/g)).toHaveLength(2);
    const focus = source.slice(source.indexOf('useFocusEffect(\n    useCallback(() => {\n      // The focus event'));
    const focusBody = focus.slice(0, focus.indexOf('}, [refillStaleHomeDevices'));
    expect(focusBody).toContain('const forceFull = homeFullReloadOnFocusRef.current !== null;');
    const load = source.slice(source.indexOf('const loadHome = useCallback('), source.indexOf('loadHomeRef.current = loadHome;'));
    expect(load.indexOf('const fullReloadRequestAtStart = homeFullReloadOnFocusRef.current;'))
      .toBeLessThan(load.indexOf('const rawTask = (async () => {'));
    // Blurring after the device-list read exits before the commit, leaving the request in place.
    expect(load.indexOf('if (!screenFocusedRef.current) return;')).toBeLessThan(load.indexOf('lastSyncedAtRef.current = now;'));
    const commit = load.slice(load.indexOf('lastSyncedAtRef.current = now;'));
    expect(commit).toContain('if (homeFullReloadOnFocusRef.current === fullReloadRequestAtStart) homeFullReloadOnFocusRef.current = null;');
  });

  it('refreshes automation badges on return only for devices that sent schedule events while away', () => {
    const events = source.slice(source.indexOf('useEffect(() => remoteScheduleEventStore.subscribe('), source.indexOf('const refreshHomeScheduleIndexes = useCallback('));
    expect(events).toMatch(/if \(!screenFocusedRef\.current\) \{\s*markHomeScheduleIndexDirty\(deviceId\);\s*continue;\s*\}\s*refreshDeviceScheduleIndex\(deviceId, sessionIds\);/);
    // The old unconditional "refresh every device on focus" effect is gone.
    expect(source).not.toContain('兜底刷新一次 scheduleIndex');
    const focus = source.slice(source.indexOf('useFocusEffect(\n    useCallback(() => {\n      // The focus event'));
    expect(focus.indexOf('screenFocusedRef.current = true;')).toBeLessThan(focus.indexOf('refreshHomeScheduleIndexes('));
    expect(focus).toContain('const scheduleDirty = new Set(homeScheduleIndexDirtyRef.current.keys());');
  });

  it('keeps automation badge refreshes pending until one is applied', () => {
    const refresh = source.slice(source.indexOf('const refreshDeviceScheduleIndex = useCallback('), source.indexOf('const hydrateDeviceSessionsOnce = useCallback('));
    // Recorded before the focus gate, so a skipped refresh or a dropped in-flight result is refilled on return.
    expect(refresh.indexOf('const pendingSeq = markHomeScheduleIndexDirty(deviceId);'))
      .toBeLessThan(refresh.indexOf("if (!screenFocusedRef.current || AppState.currentState !== 'active') return;"));
    const apply = refresh.slice(refresh.indexOf('setScheduleIndex((current) => replaceSessionScheduleIndexEntries('));
    expect(apply).toMatch(/if \(homeScheduleIndexDirtyRef\.current\.get\(deviceId\) === pendingSeq\) \{\s*homeScheduleIndexDirtyRef\.current\.delete\(deviceId\);/);
    const hydrate = source.slice(source.indexOf('const hydrateDeviceSessionsOnce = useCallback('), source.indexOf('const hydrateDeviceSessions = useCallback('));
    expect(hydrate.indexOf('markHomeScheduleIndexDirty(device.deviceId);'))
      .toBeLessThan(hydrate.indexOf('scheduleIndexDeferRegistryRef.current.schedule(device.deviceId'));
    expect(hydrate).toContain('nextSessions.length >= LIST_LIMIT');
    expect(hydrate).toContain('remoteSessionStore.captureDeviceSessionListMutationEpoch(device.deviceId)');
  });

  it('marks a device stale whenever its list asks for a reseed, even while Home is covered', () => {
    const reseed = source.slice(source.indexOf('remoteSessionStore.registerReseedHandler(item.device.deviceId'));
    expect(reseed.indexOf('homeListFreshnessRef.current.invalidate(item.device.deviceId);'))
      .toBeLessThan(reseed.indexOf('void hydrateDeviceSessions(item.device, accountGeneration'));
  });

  it('clears freshness with the rest of the account-owned Home state', () => {
    const reset = source.slice(source.indexOf('useLayoutEffect(() => {\n    syncInFlightRef.current = null;'), source.indexOf('}, [accountGeneration]);'));
    expect(reset).toContain('homeListFreshnessRef.current.clear();');
    expect(reset).toContain('homeFullReloadOnFocusRef.current = null;');
    expect(reset).toContain('homeScheduleIndexDirtyRef.current.clear();');
  });
});


// Guard: list projection and per-row usage subscriptions are one cross-file data contract.
describe('Home usage subscription contract', () => {
  const meta = readSource('src/session/HomeSessionInfoMeta.tsx');
  const store = readSource('src/session/remoteSessionStore.ts');
  it('reads token / cost per row because the Home projection strips usage fields', () => {
    // Home 列表投影刻意去掉用量(避免用量推送重排分组),行上的 Token / 费用必须单独订阅。
    expect(store).toContain('delete projected.totalTokenUsage;');
    expect(meta).toContain("taskInfoFields.includes('tokens') || taskInfoFields.includes('cost')");
    expect(meta.match(/useRemoteSessionUsage\(/g)?.length).toBe(2);
  });

});
