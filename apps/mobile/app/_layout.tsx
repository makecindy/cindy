import {
  DarkTheme as NavigationDarkTheme,
  DefaultTheme as NavigationLightTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
  useRouter,
  useSegments,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import {
  fontWeight,
  radius,
  spacing,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { useLoginFirstLaunchLight } from '@/auth/loginFirstLaunchGate';
import { loginText } from '@/auth/loginMessages';
import { resolveStartupSplashHandoff } from '@/auth/startupSplashContinuity';
import {
  MobileLoginHandoffProvider,
  useLoginHandoff,
} from '@/auth/MobileLoginHandoffContext';
import {
  DeviceLinkProvider,
  useDeviceLink,
} from '@/device-link/DeviceLinkContext';
import { PushNotificationsBridge } from '@/notifications/PushNotificationsBridge';
import { GestureHandlerRootView } from '@/platform/gestureHandler';
// import 即同步完成 i18next init;必须先于任何 t() 消费方挂载。
import '@/i18n';
import { LocaleProvider } from '@/i18n/useLocale';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { createNavigationTheme } from '@/theme/navigationTheme';
import { MobileLoginHandoffStage } from '@/components/MobileLoginHandoffStage';
import {
  StartupSplashOverlay,
  useStartupSplash,
} from '@/components/StartupSplashOverlay';
import { registerDevCacheMenu } from '@/debug/devCacheMenu';
import { startJsStallWatchdog } from '@/debug/jsStallWatchdog';
import { initMobileTapdb } from '@/analytics/mobileTapdb';
import {
  openBundleInstall,
  useBundleUpdatePrompt,
} from '@/update/useBundleUpdatePrompt';
import {
  useForcedUpdate,
  type ForcedUpdateTarget,
} from '@/update/forcedUpdateStore';
import { useForcedUpdateRecheck } from '@/update/useForcedUpdateRecheck';
import { useResumeUpdateCheck } from '@/update/useResumeUpdateCheck';
import {
  markStartupOtaLaunchSuccess,
  useStartupOtaGate,
} from '@/update/useStartupOtaGate';
import { useUpdateChannelGate } from '@/update/useUpdateChannelGate';
import type { UpdateChannel } from '@cindy/maker-shared/update-channel';
import { useStartupEndpointGate } from '@/config/useStartupEndpointGate';
import { IS_OTA_SELFHOST } from '@/config/env';
import { getNewSessionCreationTask } from '@/session/newSessionCreation';
import { isExactRemoteSessionClaimed } from '@/session/newSessionWorktree';
import {
  isPrecreatedWorktreeRegistrationInFlight,
  recoverPendingPrecreatedWorktrees,
} from '@/session/precreatedWorktreeRecovery';

function NavigationGate() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const { mode, colors } = useTheme();
  const { releaseSplash, splashActive } = useStartupSplash();
  // iOS 状态栏样式走 react-native-screens 的 VC-based 通道(Info.plist 已翻
  // UIViewControllerBasedStatusBarAppearance=YES):iOS 27 起 UIKit 不再接受
  // RN StatusBar 依赖的废弃全局 API(setStatusBarStyle),expo-status-bar 组件
  // 在 iOS 上已失效且会触发 RCTLogError,iOS 侧不得再挂载。Android 老链路正常,
  // 继续用组件式 StatusBar(含 Stack 未挂载的启动闸门期),不走 RNS 双轨。
  // splash 覆盖层是登录品牌舞台(首启亮色门可能强制 light):覆盖期间随舞台
  // 有效主题,释放后随系统主题;首启门 pending 时舞台不渲染品牌,跟系统即可。
  const firstLaunchGate = useLoginFirstLaunchLight();
  const stageTheme =
    resolveStartupSplashHandoff(firstLaunchGate, mode).targetTheme ?? mode;
  const statusBarTheme = splashActive ? stageTheme : mode;
  const navigationTheme = useMemo(
    () =>
      createNavigationTheme(
        mode === 'dark' ? NavigationDarkTheme : NavigationLightTheme,
        colors,
      ),
    [mode, colors],
  );

  // auth 恢复是启动闸门链的最后一道门:这里统一释放根部常驻 splash。
  // 放在 NavigationGate 而不是具体页面,是为了深链冷启动(首屏不是 index)也能释放。
  useEffect(() => {
    if (auth.initialized) releaseSplash();
  }, [auth.initialized, releaseSplash]);

  // 启动链走完 = 本次热更 reload(如果有)确实落地:清掉 reload 闸门记录。
  // 只在目标 update 已成为当前运行版本时才清,判定在 markStartupOtaLaunchSuccess 内。
  useEffect(() => {
    if (auth.initialized) markStartupOtaLaunchSuccess();
  }, [auth.initialized]);

  useEffect(() => {
    if (!auth.initialized) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!auth.isAuthenticated && !inAuthGroup) {
      router.replace('/login');
      return;
    }
    if (auth.isAuthenticated && inAuthGroup) {
      router.replace('/');
    }
  }, [auth.initialized, auth.isAuthenticated, router, segments]);

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.accountDeletionRestored) return;
    auth.consumeAccountDeletionRestored();
    Alert.alert(
      loginText('accountDeletionRestoredTitle'),
      loginText('accountDeletionRestoredCopy'),
    );
  }, [
    auth.accountDeletionRestored,
    auth.consumeAccountDeletionRestored,
    auth.isAuthenticated,
  ]);

  return (
    <NavigationThemeProvider value={navigationTheme}>
      {/* Android 专用:splash 覆盖层仍在时状态栏保持浅色;淡出开始后切回主题样式 */}
      {Platform.OS === 'android' ? (
        <StatusBar
          style={splashActive || mode === 'dark' ? 'light' : 'dark'}
        />
      ) : null}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
          ...(Platform.OS === 'ios'
            ? { statusBarStyle: statusBarTheme === 'dark' ? 'light' : 'dark' }
            : null),
          // iOS 26 起 react-native-screens 的返回手势默认全屏识别(fullScreenSwipe 默认 true),
          // 判定范围过大:会与消息内表格/代码块的横向 ScrollView 抢手势,拖动内容时还会误触返回。
          // 限定手势起始点在屏幕前缘 44pt 内(end = 距前缘最大 x),恢复经典边缘返回的判定范围;
          // iOS < 26 默认就是边缘返回,本配置不改变其行为;Android 返回手势不走这条路径,不受影响。
          gestureResponseDistance: { end: 44 },
        }}
      >
        {/* 设置从左侧抽屉进入:接着抽屉方向从左边推出,不要默认从右边盖上来。 */}
        <Stack.Screen name="settings" options={{ animation: 'slide_from_left' }} />
        <Stack.Screen
          name="add-account"
          options={{ animation: 'fade', gestureEnabled: false }}
        />
      </Stack>
    </NavigationThemeProvider>
  );
}

/**
 * handoff reporter 桥(PR4b Step 5b WHAT2,reporter 拓扑写死):
 * endpoint gate 在 root 层直接上报——挂在 Provider 内、随 status 变化派发
 * (pending→error→retry(pending)→ready 全程可上报,reducer 侧 ready 后单向锁定)。
 */
function EndpointHandoffBridge({
  status,
}: {
  status: 'pending' | 'ready' | 'error';
}) {
  const handoff = useLoginHandoff();
  const dispatch = handoff.dispatch;
  useEffect(() => {
    dispatch({ type: 'endpoint', status });
  }, [dispatch, status]);
  return null;
}

/** auth-init 上报桥(挂 AuthProvider 内;initialized 置位即上报含登录态)。 */
function AuthHandoffBridge() {
  const auth = useAuth();
  const handoff = useLoginHandoff();
  const dispatch = handoff.dispatch;
  useEffect(() => {
    if (!auth.initialized) return;
    dispatch({ type: 'auth-init', authenticated: auth.isAuthenticated });
  }, [auth.initialized, auth.isAuthenticated, dispatch]);
  return null;
}

/**
 * 预创建 worktree 恢复桥：
 * 手机在 worktree:create 前已持久化 recoveryKey reservation；进程可能在 create
 * 或 create-session 回包前被系统杀掉，这时页面 task 已不存在，不能等用户再次
 * 进入新建页才补偿。根部在同账号链路上线 / 回前台时读取小型恢复账本；当前
 * 进程仍有创建 task 的记录先跳过，避免与正常管线竞争，冷启动后再由被控端的
 * 登记匹配与 ownership guard 做最后裁决。
 */
function PrecreatedWorktreeRecoveryBridge() {
  const auth = useAuth();
  const {
    status: deviceLinkStatus,
    connectionEpoch,
    openLink,
    invoke,
  } = useDeviceLink();
  const inFlightRef = useRef<{
    accountId: string;
    promise: Promise<void>;
  } | null>(null);
  const accountId = auth.user?.id?.trim() ?? '';
  const ownerGenerationRef = useRef({ accountId: '', generation: 0 });
  if (ownerGenerationRef.current.accountId !== accountId) {
    ownerGenerationRef.current = {
      accountId,
      generation: ownerGenerationRef.current.generation + 1,
    };
  }
  const ownerGeneration = ownerGenerationRef.current.generation;

  const runRecovery = useCallback(async () => {
    if (
      !auth.initialized
      || !auth.isAuthenticated
      || !accountId
      || deviceLinkStatus !== 'online'
    ) {
      return;
    }
    // 连接重建与账号切换可能在同一时间触发多个恢复请求。相同账号复用
    // 当前运行；切换账号则等待旧账本完成后再处理新账号，不能因为一次
    // 竞态把新账号的恢复永久跳过。
    while (inFlightRef.current) {
      const previous = inFlightRef.current;
      await previous.promise;
      if (previous.accountId === accountId) return;
      if (inFlightRef.current === previous) {
        inFlightRef.current = null;
      }
    }
    const run = recoverPendingPrecreatedWorktrees(accountId, {
      openLink,
      discardPrecreated: (deviceId, input) => invoke(
        deviceId,
        'worktree:discard-precreated',
        [input],
      ),
      isSessionClaimed: (deviceId, sessionId) => isExactRemoteSessionClaimed(
        sessionId,
        (id) => invoke(deviceId, 'local-db:sessions:get', [id]),
      ),
      shouldDefer: (record) => (
        getNewSessionCreationTask(record.sessionId) !== null
        || isPrecreatedWorktreeRegistrationInFlight(record.sessionId)
      ),
      // Account selection updates user/token while the AuthProvider stays mounted.
      // Fence this run against that owner generation so stable Device Link callbacks
      // cannot retarget an old account's recovery to the new client.
      isCurrent: () => (
        ownerGenerationRef.current.accountId === accountId
        && ownerGenerationRef.current.generation === ownerGeneration
      ),
    });
    const tracked = {
      accountId,
      promise: run.then(() => undefined, () => undefined),
    };
    inFlightRef.current = tracked;
    await tracked.promise;
    if (inFlightRef.current === tracked) {
      inFlightRef.current = null;
    }
  }, [
    accountId,
    auth.initialized,
    auth.isAuthenticated,
    connectionEpoch,
    deviceLinkStatus,
    invoke,
    openLink,
    ownerGeneration,
  ]);

  useEffect(() => {
    void runRecovery();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void runRecovery();
    });
    return () => subscription.remove();
  }, [runRecovery]);

  return null;
}

function RootAfterUpdateChannel({ channel }: { channel: UpdateChannel }) {
  // 自建变体:启动即生效的 JS 热更门(冷启动 check→fetch→reload,本次启动就跑上最新 JS)。
  // 内部 gate 自建 + 非 dev + updates 可用,其余直接 ready=true 不阻塞。见 useStartupOtaGate。
  const otaReady = useStartupOtaGate(channel);
  // handoff reporter:OTA 门就绪在本层上报(reload 期间保持 pending,readiness 不推进)
  const handoff = useLoginHandoff();
  const dispatchHandoff = handoff.dispatch;
  useEffect(() => {
    if (otaReady) dispatchHandoff({ type: 'ota-ready' });
  }, [otaReady, dispatchHandoff]);
  // 符合整包分发策略的自建变体:启动时检查整包更新(runtimeVersion 变化 → 引导安装)。
  // TestFlight / 审核 / EAS 包为 no-op。JS 热更由上面的门 + expo-updates 处理,与此互补。
  useBundleUpdatePrompt({ auto: true, channel });
  // 自建变体:后台切回前台时静默补一次检查(OTA 静默 fetch 不 reload、整包仅强更提示)。
  // TestFlight 保留 OTA、跳过整包分支；非自建为 no-op。见 useResumeUpdateCheck。
  useResumeUpdateCheck(channel);
  // 热更门未就绪(自建变体冷启动正在 check/fetch/reload)时不挂载业务树,避免闪旧 UI;
  // 期间根部常驻 splash 覆盖层在上面顶着,这里返回 null 即可。
  if (!otaReady) {
    return null;
  }
  return (
    <AuthProvider>
      <AuthHandoffBridge />
      {/* 任务完成推送:注册同步 + 通知点击路由 + 前台横幅压制(不渲染 UI) */}
      <PushNotificationsBridge />
      <DeviceLinkProvider>
        <PrecreatedWorktreeRecoveryBridge />
        <NavigationGate />
      </DeviceLinkProvider>
    </AuthProvider>
  );
}

/**
 * 端点闸门之后的应用主体:OTA 检查更新与业务树都在这里——保证「拉端点清单」
 * 严格先于「检查更新」(本组件只在端点闸门 ready 后才挂载)。
 */
function RootAfterEndpoints() {
  // 更新检查早于 AuthProvider，必须先恢复上次登录同步到本机的 canary 快照 + 设备 beta 开关。
  // 未持久化/读取失败一律 release；读取完成前不允许发任何 /manifest 或 /latest 请求。
  const channelGate = useUpdateChannelGate(IS_OTA_SELFHOST);
  // 未就绪期间由根部常驻 splash 覆盖层顶着,不再各自渲染 splash 实例(避免交接闪帧)。
  if (!channelGate.ready) return null;
  return <RootAfterUpdateChannel channel={channelGate.channel} />;
}

function RootLayout() {
  // Dev-only:注册开发者菜单的"清缓存 + reload"项(内部 __DEV__ gate,生产为 no-op)。
  useEffect(() => {
    registerDevCacheMenu();
  }, []);
  // Dev-only:JS 停摆探测器,把 JS 线程忙死的时间边界钉进 Metro 日志流(内部 __DEV__ gate)。
  useEffect(() => startJsStallWatchdog(), []);
  // 使用统计(TapDB):这里只是"尝试"初始化——用户没同意过《隐私政策》时同意闸会
  // 直接挡回 not_consented,原生 SDK 一个字节都不会读写(见 analytics/mobileTapdb)。
  useEffect(() => {
    void initMobileTapdb();
  }, []);
  // 远程端点清单闸门(阻断式):冷启动第一步、先于 OTA 检查更新拉取 OSS 清单,
  // 回写 env live binding。拉不到 / 清单非法 → 错误屏等用户重试,无缓存与超时兜底;
  // __DEV__ 直接放行。ready 前 RootAfterEndpoints(含 OTA 门与业务树)不挂载。
  const endpointGate = useStartupEndpointGate();
  // 强更阻断态(自建线整包更新命中 minVersion 门槛):模块级 store,启动检查 / 设置页手动
  // 检查 / resume 静默检查三条路径中任一命中即置位。置位后整棵业务树不挂载。
  const forcedUpdate = useForcedUpdate();
  // 所有 hook 已在上方调用,下面条件返回不违反 hooks 规则。
  // GestureHandlerRootView 必须在根部常驻(RNGH 官方要求;缺失时 Android 手势整体不响应)。
  // 各分支都包同一层,避免闸门状态切换时 root 重挂。
  let body: ReactElement | null;
  if (endpointGate.status === 'error') {
    // 白底体系(PR4a):错误屏包 MobileLoginHandoffStage(品牌显示),阻断内容层
    // 透明置于其上——阻断语义不变:没有"跳过 / 稍后再说",只有重试。
    body = (
      <MobileLoginHandoffStage>
        <StartupGateBlockedContent
          title={loginText('endpointGateTitle')}
          subtitle={loginText('endpointGateSubtitle').replace(
            '{reason}',
            endpointGate.reason ?? 'unknown',
          )}
          actionLabel={loginText(
            endpointGate.canResetToDev ? 'endpointGateResetToDev' : 'retry',
          )}
          onAction={
            endpointGate.canResetToDev
              ? endpointGate.resetToDev
              : endpointGate.retry
          }
        />
      </MobileLoginHandoffStage>
    );
  } else if (forcedUpdate) {
    // 强更闸门:与端点错误屏同一套阻断体系(白底品牌宿主 + 唯一出口),没有"稍后 / 跳过"
    // ——点「去更新」跳出去安装,回到 App 仍是这一屏,直到装上不低于门槛的版本。
    // 业务树整体不挂载,含 AuthProvider / DeviceLinkProvider / 预创建 worktree 恢复桥:
    // 强更期间不该发起任何 Device Link 调用;恢复账本是持久化的,阻断解除后下次启动照常补偿。
    body = (
      <MobileLoginHandoffStage>
        <ForcedUpdateGateContent target={forcedUpdate} />
      </MobileLoginHandoffStage>
    );
  } else if (endpointGate.status === 'pending') {
    // pending 期间由 StartupSplashOverlay 顶着,不渲染业务内容。
    body = null;
  } else {
    body = <RootAfterEndpoints />;
  }
  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaProvider>
        <ThemeProvider>
          {/* 语言 Provider 常驻 root:恢复持久化 override,覆盖含 (auth) 在内的全部屏幕 */}
          <LocaleProvider>
            {/* handoff Provider 常驻 root(PR4b):闸门屏切换不重置衔接状态机 */}
            <MobileLoginHandoffProvider>
              <EndpointHandoffBridge status={endpointGate.status} />
              {/* 启动闸门全程共用这一个 splash 实例;需要用户交互的闸门屏
                  (端点错误 / 强更阻断)才隐藏它 */}
              <StartupSplashOverlay
                hidden={endpointGate.status === 'error' || forcedUpdate !== null}
              >
                {body}
              </StartupSplashOverlay>
            </MobileLoginHandoffProvider>
          </LocaleProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * 启动闸门阻断内容层(StartupBlockedScreen 的白底体系消费变体,PR4a):
 * 品牌视觉由 MobileLoginHandoffStage 宿主拥有,本层背景透明、内容沉到下半屏
 * (避开品牌三要素),仅承载标题/说明/唯一动作。端点闸门与强更闸门共用本层
 * ——阻断语义一致:没有"跳过 / 稍后再说",只有一个出口。端点错误屏的文案 key 化
 * Release 覆盖失败时唯一动作改为返回 Dev；其它失败仍为 retry。
 */
function StartupGateBlockedContent({
  title,
  subtitle,
  actionLabel,
  onAction,
}: {
  title: string;
  subtitle?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const gateStyles = useThemedStyles(makeGateStyles);
  return (
    <View style={gateStyles.root}>
      <Text style={gateStyles.title}>{title}</Text>
      {subtitle ? <Text style={gateStyles.subtitle}>{subtitle}</Text> : null}
      <Pressable
        accessibilityRole="button"
        onPress={onAction}
        style={({ pressed }) => [
          gateStyles.retryButton,
          pressed && gateStyles.retryButtonPressed,
        ]}
      >
        <Text style={gateStyles.retryLabel}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

/**
 * 强更闸门内容层:命中 minVersion 门槛时的阻断屏,唯一出口是「去更新」
 * (iOS 跳 itms-services / App Store,Android 跳应用商店或 APK 直下)。
 * 复用既有 update.* 文案(forcedTitle / bundleAvailableBody / releaseNotes / goUpdate),
 * 不新增术语;t() 在此消费,保证语言切换即时生效。
 */
function ForcedUpdateGateContent({ target }: { target: ForcedUpdateTarget }) {
  const { t } = useTranslation();
  // 阻断期间业务树不挂载 → useResumeUpdateCheck 也停了,本进程不会再拉 /latest。
  // 所以阻断屏自带一次"回前台重新核对":服务端撤回误下发的门槛后,用户切出去再回来
  // 即自动解除,不必杀进程冷启动。拉取失败一律维持阻断(不能靠断网绕过)。
  useForcedUpdateRecheck();
  const notes = target.releaseNotes?.trim();
  const subtitle = [
    t('update.bundleAvailableBody'),
    notes ? t('update.releaseNotes', { notes }) : '',
  ].join('');
  return (
    <StartupGateBlockedContent
      title={t('update.forcedTitle')}
      subtitle={subtitle}
      actionLabel={t('update.goUpdate')}
      onAction={() => openBundleInstall(target)}
    />
  );
}

const makeGateStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      // 背景透明:品牌层(立绘/字标/渐变)由宿主渲染,本层只放阻断内容
      flex: 1,
      gap: spacing.sm,
      justifyContent: 'flex-end',
      padding: spacing.xl,
      paddingBottom: spacing.xxl * 3,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.medium,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.body,
      textAlign: 'center',
    },
    retryButton: {
      backgroundColor: colors.textPrimary,
      borderRadius: radius.control,
      marginTop: spacing.md,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.sm,
    },
    retryButtonPressed: {
      opacity: 0.7,
    },
    retryLabel: {
      color: colors.surface,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
  });

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
});

export default RootLayout;
