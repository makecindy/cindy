import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('mobile home desktop-first surface', () => {
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
    const source = readSource('app/devices/index.tsx');
    const removedListTokenPrefix = 'home' + 'List';

    expect(source).toContain('export default function HomeScreen()');
    expect(source).not.toContain('export default function DevicesScreen()');
    expect(source).not.toContain('styles.deviceChipBadge');
    expect(source).not.toContain('styles.worktreeBadge');
    expect(source).not.toContain('MonitorSmartphone');
    expect(source).not.toContain("title: 'Projects'");
    expect(source).not.toContain("title: 'Chats'");
    expect(source).not.toContain('placeholder="Search Chats"');
    expect(source).not.toContain('placeholder="搜索会话"');
    expect(source).not.toContain('home.searchInput');
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
    expect(source).not.toContain('Menu,');
    expect(source).not.toContain('icon={Menu}');
    expect(source).not.toContain('devices.menuButton');
    expect(source).not.toContain('打开菜单');
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
    expect(source).toContain("label={t('devices.list.allConversations')}");
    expect(source).toContain("label={t('devices.list.menu.groupByProject')}");
    // 注:首页分区构造逻辑(buildMixedHomeRows / buildGroupedHomeRows / buildHomeSections)
    // 已抽到 @/session/homeSections,并由 homeSections.test.ts 做行为测试,这里不再做源码字符串断言。
    expect(source).toContain('styles.sessionListRow');
    expect(source).not.toContain('styles.sessionCard');
    expect(source).not.toContain('styles.sessionBadge');
    expect(source).toContain('backgroundColor: colors.surface');
    expect(source).toContain('borderBottomColor: colors.border');
    expect(source).toContain('colors.homeListFab');
    // 2026-07-21 通栏回退:FAB 图标退回 XD-Maker 原版 SquarePen(用户定稿),尺寸/描边同回原档。
    expect(source).toContain('SquarePen,');
    expect(source).toContain('<SquarePen color={colors.ctaText} size={iconSize.xxl} strokeWidth={iconStroke.regular} />');
    expect(source).not.toContain('<Send');
    expect(source).not.toContain('function HomeNewChatGlyph');
    expect(source).not.toContain("import Svg, { Path } from 'react-native-svg';");
    expect(source).not.toContain(`colors.${removedListTokenPrefix}Background`);
    expect(source).not.toContain(`colors.${removedListTokenPrefix}Divider`);
    expect(source).not.toContain(`colors.${removedListTokenPrefix}Shadow`);
    expect(source).toContain('fontWeight: fontWeight.medium');
    expect(source).toContain('testID="home.newChatButton"');
    expect(source).toContain("position: 'absolute'");
    expect(source).toContain('bottom: CINDY_LIST_FAB_BOTTOM');
    expect(source).toContain('right: CINDY_LIST_GUTTER');
  });

  it('uses TapTap blue for the online dot treatment', () => {
    const homeSource = readSource('app/devices/index.tsx');
    const primitivesSource = readSource('src/components/MobilePrimitives.tsx');
    const tokenSource = readSource('src/theme/tokens.ts');
    const removedListTokenPrefix = 'home' + 'List';

    // E5M 状态色设计定稿(2026-07-17):teal 族 #00D9C5 → #19D2C1,statusReady 随 awaiting 同步。
    expect(tokenSource).toContain("statusReady: '#19D2C1'");
    expect(tokenSource).toContain("homeListFab: '#ECEDEF'");
    expect(tokenSource).not.toContain(`${removedListTokenPrefix}Background`);
    expect(tokenSource).not.toContain(`${removedListTokenPrefix}Divider`);
    expect(primitivesSource).toContain('tone === \'ready\' && styles.statusDotReady');
    expect(primitivesSource).toContain('backgroundColor: colors.statusReady');
    expect(primitivesSource).toContain('pulsing && {');
    expect(primitivesSource).toContain('scale: pulse.interpolate');
    expect(primitivesSource).not.toContain('statusDotReady: {\n    backgroundColor: colors.textPrimary');
    expect(homeSource).toContain("return item.available && (item.state === 'ready' || item.state === 'busy') ? 'online' : 'offline';");
    expect(homeSource).toContain("tone={status === 'online' ? 'ready' : 'off'}");
  });

  it('mirrors the desktop sidebar Agent identity slot and running treatment', () => {
    const homeSource = readSource('app/devices/index.tsx');
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
    expect(desktopVendorIconSource).toContain("vendor === 'codex' ? <CodexMark size={size} /> : <ClaudeMark size={size} />");
    expect(desktopVendorIconSource).toContain("vendor: 'cc' | 'codex'");
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
    expect(vendorIconSource).toContain("agentKind={vendor === 'codex' ? 'codex' : 'claude-code'}");
    expect(vendorIconSource).not.toContain('viewBox="136 137 282 158"');
    expect(vendorIconSource).not.toContain('transform="translate(');
    expect(vendorIconSource).toContain('Easing.inOut(Easing.ease)');
    // 行运行态经订阅获取(memo 化后命令式读取会 stale,2026-07-18 重渲染风暴修复)
    expect(homeSource).toContain('const sessionIsRunning = useSessionRunning(item.session.id);');
    // 保鲜契约:ProjectRow 与 AutomationGroupChildren 内的命令式运行态读取必须各挂一份
    // storeVersion 订阅(裸语句形态);行内相对时间靠分钟心跳订阅保鲜。丢任何一处都是 stale-UI。
    expect((homeSource.match(/^  useRemoteSessionStoreVersion\(\);$/gm) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(homeSource).toContain('useMinuteNow();');
    expect(homeSource).toContain('<RadioTower');
    expect(homeSource).toContain('width: 24');
    expect(homeSource).toContain('width: iconSize.md');
    expect(homeSource).toContain('size={cindyList ? iconSize.sm : isClaudeCodeAgentKind(item.session.agentKind) ? 19 : iconSize.lg}');
    expect(homeSource).toContain("function isClaudeCodeAgentKind(agentKind: string): boolean");
    expect(homeSource).toContain("return agentKind !== 'codex';");
    expect(homeSource).not.toContain('sessionAttentionDot: {\n    backgroundColor: colors.statusAccent,\n    borderColor: colors.surface');
    expect(homeSource).not.toContain('sessionAttentionDot: {\n    backgroundColor: colors.statusAccent,\n    borderRadius: 3,\n    borderWidth: 1');
  });

  it('uses desktop-style attention dots for unread automation on the home list without extra row text', () => {
    const source = readSource('app/devices/index.tsx');
    const scheduleIndexSource = readSource('src/session/scheduleIndex.ts');

    expect(source).toContain('const [scheduleIndex, setScheduleIndex]');
    expect(source).toContain('const [deviceIdentityCacheReady, setDeviceIdentityCacheReady]');
    expect(source).toContain('loadDeviceIdentityCache()');
    expect(source).toContain('reconcileDeviceIdentities(');
    expect(source).toContain('saveDeviceIdentityCache(result.cache)');
    expect(source).toContain('loadDeviceSessionScheduleIndex(deviceId, invoke)');
    expect(source).toContain('replaceSessionScheduleIndexEntries(');
    expect(source).toContain("invoke<unknown[]>(device.deviceId, 'maker:list-active', [])");
    expect(source).toContain('if (isOptionalActiveSessionSnapshotError(err)) return null;');
    expect(source).toContain('function isOptionalActiveSessionSnapshotError(error: unknown): boolean');
    expect(source).toContain('if (isAccessRevokedError(error) || isDeviceOfflineError(error)) return false;');
    expect(source).toContain("if (text.includes('REMOTE_DISABLED')) return false;");
    expect(source).toContain('return true;');
    expect(source).toContain('remoteSessionStore.setActiveSessionSnapshots(device.deviceId, activeSessions)');
    expect(source).toContain('remoteScheduleEventStore.subscribe(() => {');
    expect(source).toContain('const snapshot = remoteScheduleEventStore.getSnapshot(deviceId)');
    expect(source).toContain('const version = snapshot.version');
    expect(source).toContain('if (version === 0) {');
    expect(source).toContain('scheduleEventVersionsRef.current.delete(deviceId)');
    expect(source).toContain("projection?.refresh.sessionIndex !== true && projection?.runPatch.status !== 'running'");
    expect(source).toContain('force: projection.refresh.scheduleList === true');
    expect(source).toContain('scheduleIndex,');
    expect(source).toContain('const attention = item.pendingInteractionCount > 0');
    expect(source).toContain('|| (item.scheduleInfo?.unreadCount ?? 0) > 0');
    expect(source).toContain('|| item.liveActivity?.attention === true;');
    // 提醒点已从行首 icon 角标移到行右侧状态槽(替代时间位),五档判定与桌面
    // sidebarRightStatus 对齐:error 红 > awaiting TapTap 蓝 > running spinner > 完成绿 > 时间。
    expect(source).toContain('resolveMobileSessionRightStatus({');
    expect(source).toContain('styles.sessionRightDot');
    expect(source).toContain('<SessionRightSpinner');
    expect(source).not.toContain('sessionAttentionDot');
    expect(source).not.toContain('未读 {item.scheduleInfo');
    expect(scheduleIndexSource).toContain('buildSessionScheduleIndex');
    expect(scheduleIndexSource).toContain('SCHEDULE_INDEX_RUN_LIMIT = 50');
  });

  it('gives device chips stable per-device e2e anchors for multi-device local smoke', () => {
    const source = readSource('app/devices/index.tsx');
    const maestroSource = readSource('scripts/maestro-e2e.mjs');
    const localSmokeSource = readSource('scripts/local-device-link-smoke.mjs');
    const deviceDetailFlow = readSource('e2e/maestro/session_list_controls.yaml');

    expect(source).toContain('`home.deviceChip.${sanitizeDeviceChipTestId(item.deviceId)}`');
    expect(source).toContain('function sanitizeDeviceChipTestId');
    expect(source).toContain("return value.replace(/[^A-Za-z0-9_-]/g, '_');");
    expect(source).not.toContain("const testID = item.deviceId ? 'home.deviceChip' : 'home.deviceChip.all';");
    expect(localSmokeSource).toContain('process.env.XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID = mockHostDeviceChipId;');
    expect(maestroSource).toContain('XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID=${hostDeviceChipId}');
    expect(deviceDetailFlow).toContain('id: "${XDT_MOBILE_E2E_HOST_DEVICE_CHIP_ID}"');
  });

  it('lets mobile rename account devices through the authoritative device-link API', () => {
    const source = readSource('app/devices/index.tsx');

    expect(source).toContain('const [renameTarget, setRenameTarget]');
    expect(source).toContain('function RenameDeviceModal');
    expect(source).toContain('onRenameDevice={openRenameDevice}');
    expect(source).toContain('testID={testID ? `${testID}.rename` : undefined}');
    expect(source).toContain('testID="home.renameDevice.input"');
    expect(source).toContain("testID: 'home.renameDevice.save'");
    expect(source).toContain('`/api/device-link/devices/${encodeURIComponent(target.deviceId)}`');
    expect(source).toContain("method: 'PATCH'");
    expect(source).toContain('body: { name }');
    expect(source).toContain('remoteSessionStore.renameDevice(target.deviceId, nextName)');
    expect(source).not.toContain('clearManualName');
  });

  it('scopes multi-device connection feedback to the affected device chip', () => {
    const source = readSource('app/devices/index.tsx');

    expect(source).toContain("type HomeDeviceConnectionState = 'idle' | 'syncing' | 'failed';");
    expect(source).toContain('const [rawDeviceConnectionStates, setDeviceConnectionStates]');
    // 熔断 open 的设备复用 failed 渲染路径:内部态映射(merged memo)覆盖在 hydrate 状态之上
    expect(source).toContain('const unresponsiveDevices = useUnresponsiveDevices();');
    expect(source).toContain("for (const deviceId of unresponsiveDevices) merged[deviceId] = 'failed';");
    expect(source).toContain("updateDeviceConnectionState(device.deviceId, 'syncing');");
    expect(source).toContain("updateDeviceConnectionState(device.deviceId, 'failed');");
    expect(source).toContain("updateDeviceConnectionState(device.deviceId, 'idle');");
    expect(source).toContain("const showConnectionRow = !!connectionError || status !== 'online';");
    expect(source).toContain("connectionStates={deviceConnectionStates}");
    expect(source).toContain('function DeviceMenuItem');
    expect(source).toContain("tone={status === 'online' ? 'ready' : 'off'}");
    expect(source).not.toContain('function DeviceConnectionSpinner');
    expect(source).not.toContain("connectionState === 'syncing' ? <DeviceConnectionSpinner /> : null");
    expect(source).not.toContain('deviceConnectionSpinner');
    expect(source).toContain("connectionState === 'failed' ? <View style={styles.deviceConnectionFailedRing} /> : null");
  });

  it('keeps project and session rows at desktop sidebar information density', () => {
    const source = readSource('app/devices/index.tsx');
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
    const stylesSource = source.slice(stylesStart);

    expect(desktopProjectNode).toContain('const Chevron = isCollapsed ? ChevronRight : ChevronDown;');
    expect(projectRowSource).toContain('project.title');
    // 折叠对齐桌面版:走共享 getRemoteSessionPreviewCollapse(24h 活动 / 需关注 / 运行中豁免),
    // 不再是 slice 硬截断。
    expect(projectRowSource).toContain('getRemoteSessionPreviewCollapse(');
    expect(projectRowSource).toContain('limit: PROJECT_PREVIEW_LIMIT');
    expect(projectRowSource).not.toContain('project.sessions.slice(0, PROJECT_PREVIEW_LIMIT)');
    expect(projectRowSource).toContain('<Folder');
    expect(projectRowSource).toContain('project.sessionCount');
    expect(projectRowSource).toContain('home.projectViewAll');
    expect(projectRowSource).not.toContain('<SquarePen');
    expect(projectRowSource).not.toContain('<Ellipsis');
    expect(projectRowSource).not.toContain('project.pendingInteractionCount');
    expect(projectRowSource).not.toContain('project.subtitle');
    expect(sessionRowSource).toContain('testID={`home.sessionRowTitle.${item.session.id}`}');
    expect(sessionRowSource).toContain('ellipsizeMode="tail"');
    expect(sessionRowSource).toContain('numberOfLines={1}');
    expect(sessionRowSource).toContain('buildRemoteSessionCardPreview(item, { running })');
    expect(sessionRowSource).toContain('testID={`home.sessionRowPreview.${item.session.id}`}');
    expect(sessionRowSource).toContain('const showPreviewLine = !!preview?.trim() || showSchedule || showPinned;');
    expect(sessionRowSource).toContain('!showPreviewLine && styles.sessionListRowSingleLine');
    expect(sessionRowSource).toContain('!showPreviewLine && styles.sessionIconCellSingleLine');
    expect(sessionRowSource).toContain('{showPreviewLine ? (');
    expect(sessionRowSource).not.toContain('numberOfLines={2}');
    // 相对时间下沉到独家订阅分钟心跳的叶子组件(行主体 memo 化后由它单独保鲜,风暴修复)
    expect(sessionRowSource).toContain('<SessionRelativeTime lastActivityAt={item.lastActivityAt}');
    expect(source).toContain('formatRemoteSessionSidebarTime(lastActivityAt)');
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
    expect(source).toContain('const CINDY_LIST_ROW_HEIGHT = 60;');
    // 用户改稿 2026-07-21:列表首页回退 XD-MAKER 通栏样式(legacy 变体),色彩体系沿用 07-20 定稿。
    expect(source).toContain('variant="legacy"');
    expect(source).not.toContain('variant="cindyList"');
    expect(source).toContain("type HomeSessionRowVariant = 'legacy' | 'cindyList';");
    expect(stylesSource).toContain('height: HOME_SESSION_ROW_HEIGHT');
    expect(stylesSource).toContain('height: HOME_SESSION_SINGLE_LINE_ROW_HEIGHT');
    expect(stylesSource).toContain('height: CINDY_LIST_ROW_HEIGHT');
    expect(stylesSource).toContain('height: lineHeight.micro');
    // 通栏回退:项目子行回 surface 全宽底(用户改稿 2026-07-21)。
    expect(stylesSource).toContain('projectChildren: {\n    backgroundColor: colors.surface,');
    expect(stylesSource).toContain('sessionListRowIndentedCindy: {\n    backgroundColor: colors.surfaceListExpanded');
    expect(stylesSource).toContain('sessionListRowDeepIndentedCindy: {\n    backgroundColor: colors.surfaceListExpanded');
    expect(stylesSource).toContain('automationGroupChildrenCindy: {\n    backgroundColor: colors.surfaceListExpanded');
  });

  it('keeps presence updates local and refreshes full home sync on every reconnect', () => {
    const source = readSource('app/devices/index.tsx');

    expect(source).toContain('void loadHome({ visible: false });');
    // 重连(connectionEpoch 变化)必须无条件全量刷新:presence 只在变化时广播、无全量重放,
    // 后台漏掉的上/下线事件只能靠重连重拉 REST 快照兜底,不能再用 hydrated 标记门控挡掉。
    // homeListCacheHydrated 是一次性 gate(缓存种入完成后永久为 true,种入失败也置 true),
    // 只影响首次触发顺序(缓存先画、fresh 后覆盖),不会挡掉任何一次重连刷新。
    expect(source).not.toContain('homeSessionHydratedRef');
    expect(source).toContain('}, [connectionEpoch, deviceIdentityCacheReady, homeListCacheHydrated, loadHome]);');
    // REST 快照与飞行期间的 presence 补丁按新鲜度合并,防止过期快照把刚上线的设备改回离线。
    expect(source).toContain('mergeDeviceViewsWithFreshPresence(');
    expect(source).toContain('markPresenceFresh(presenceFreshnessRef.current, lastPresenceSnapshot.deviceId);');
    expect(source).toContain('collectFreshPresenceDeviceIds(presenceFreshnessRef.current, presenceEpochAtFetchStart)');
    expect(source).toContain('refreshControl={<RefreshControl refreshing={refreshing}');
    expect(source).toContain('onRefresh={() => void loadHome({ visible: true })}');
    expect(source).toContain('onPress={() => void loadHome({ visible: true })}');
    expect(source).toContain('patchDeviceViewsWithPresence(');
    expect(source).toContain('result.becameControllable');
    expect(source).toContain('remoteSessionStore.registerReseedHandler(item.device.deviceId');
    expect(source).toContain('syncInFlightRef');
    expect(source).not.toContain('presenceVersion');
    expect(source).not.toContain('refreshControl={<RefreshControl refreshing={loading}');
  });

  it('does not show the no-device empty state before startup sync settles', () => {
    const source = readSource('app/devices/index.tsx');

    expect(source).toContain('const initialHomeSettled = deviceIdentityCacheReady && lastSyncedAt !== null;');
    expect(source).toContain('const initialHomeLoading = !initialHomeSettled && !connectionError;');
    expect(source).toContain('const initialHomeError = !initialHomeSettled && !!connectionError;');
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
    const source = readSource('app/devices/index.tsx');

    // 无可控制电脑时不再是一句话空态,而是产品模式引导(按 reason 分场景 + 云端 Cindy 预告);
    // 启动同步失败(initialHomeError)仍走同步失败空态,不冒充引导。
    expect(source).toContain('&& !initialHomeError');
    expect(source).toContain("&& home.emptyKind === 'noDevice'");
    expect(source).toContain('showRemoteGuide && home.emptyNoDevice ? (');
    expect(source).toContain('<RemoteAccessGuide');
    expect(source).toContain('testID="home.remoteAccessGuide"');
    // 引导态没有可筛选的对话:表头退化为纯品牌标题(无下拉菜单),新建 FAB 不渲染。
    expect(source).toContain('{showRemoteGuide ? (');
    expect(source).toContain('{showRemoteGuide ? null : (');

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
