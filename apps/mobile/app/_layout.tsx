import {
  DarkTheme as NavigationDarkTheme,
  DefaultTheme as NavigationLightTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
  useRouter,
  useSegments,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, type ReactElement } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
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
import { loginText } from '@/auth/loginMessages';
import {
  MobileLoginHandoffProvider,
  useLoginHandoff,
} from '@/auth/MobileLoginHandoffContext';
import { DeviceLinkProvider } from '@/device-link/DeviceLinkContext';
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
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useResumeUpdateCheck } from '@/update/useResumeUpdateCheck';
import { useStartupOtaGate } from '@/update/useStartupOtaGate';
import { useCanaryChannelGate } from '@/update/useCanaryChannelGate';
import { useStartupEndpointGate } from '@/config/useStartupEndpointGate';
import { IS_OTA_SELFHOST } from '@/config/env';

function NavigationGate() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const { mode, colors } = useTheme();
  const { releaseSplash, splashActive } = useStartupSplash();
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
      {/* splash 覆盖层仍在时状态栏保持浅色;淡出开始后切回主题样式 */}
      <StatusBar style={splashActive || mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
          // iOS 26 起 react-native-screens 的返回手势默认全屏识别(fullScreenSwipe 默认 true),
          // 判定范围过大:会与消息内表格/代码块的横向 ScrollView 抢手势,拖动内容时还会误触返回。
          // 限定手势起始点在屏幕前缘 44pt 内(end = 距前缘最大 x),恢复经典边缘返回的判定范围;
          // iOS < 26 默认就是边缘返回,本配置不改变其行为;Android 返回手势不走这条路径,不受影响。
          gestureResponseDistance: { end: 44 },
        }}
      />
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

function RootAfterUpdateChannel({ isCanary }: { isCanary: boolean }) {
  // 自建变体:启动即生效的 JS 热更门(冷启动 check→fetch→reload,本次启动就跑上最新 JS)。
  // 内部 gate 自建 + 非 dev + updates 可用,其余直接 ready=true 不阻塞。见 useStartupOtaGate。
  const otaReady = useStartupOtaGate(isCanary);
  // handoff reporter:OTA 门就绪在本层上报(reload 期间保持 pending,readiness 不推进)
  const handoff = useLoginHandoff();
  const dispatchHandoff = handoff.dispatch;
  useEffect(() => {
    if (otaReady) dispatchHandoff({ type: 'ota-ready' });
  }, [otaReady, dispatchHandoff]);
  // 符合整包分发策略的自建变体:启动时检查整包更新(runtimeVersion 变化 → 引导安装)。
  // TestFlight / 审核 / EAS 包为 no-op。JS 热更由上面的门 + expo-updates 处理,与此互补。
  useBundleUpdatePrompt({ auto: true, isCanary });
  // 自建变体:后台切回前台时静默补一次检查(OTA 静默 fetch 不 reload、整包仅强更提示)。
  // TestFlight 保留 OTA、跳过整包分支；非自建为 no-op。见 useResumeUpdateCheck。
  useResumeUpdateCheck(isCanary);
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
  // 更新检查早于 AuthProvider，必须先恢复上次登录同步到本机的 canary 快照。
  // 未持久化/读取失败一律 stable；读取完成前不允许发任何 /manifest 或 /latest 请求。
  const channel = useCanaryChannelGate(IS_OTA_SELFHOST);
  // 未就绪期间由根部常驻 splash 覆盖层顶着,不再各自渲染 splash 实例(避免交接闪帧)。
  if (!channel.ready) return null;
  return <RootAfterUpdateChannel isCanary={channel.isCanary} />;
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
          retryLabel={loginText('retry')}
          onRetry={endpointGate.retry}
        />
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
              {/* 启动闸门全程共用这一个 splash 实例;端点错误屏需要交互时才隐藏它 */}
              <StartupSplashOverlay hidden={endpointGate.status === 'error'}>
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
 * 端点闸门阻断内容层(StartupBlockedScreen 的白底体系消费变体,PR4a):
 * 品牌视觉由 MobileLoginHandoffStage 宿主拥有,本层背景透明、内容沉到下半屏
 * (避开品牌三要素),仅承载标题/原因/重试。文案 key 化契约不变
 * (endpointGateTitle / endpointGateSubtitle{reason} / retry)。
 */
function StartupGateBlockedContent({
  title,
  subtitle,
  retryLabel,
  onRetry,
}: {
  title: string;
  subtitle?: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  const gateStyles = useThemedStyles(makeGateStyles);
  return (
    <View style={gateStyles.root}>
      <Text style={gateStyles.title}>{title}</Text>
      {subtitle ? <Text style={gateStyles.subtitle}>{subtitle}</Text> : null}
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [
          gateStyles.retryButton,
          pressed && gateStyles.retryButtonPressed,
        ]}
      >
        <Text style={gateStyles.retryLabel}>{retryLabel}</Text>
      </Pressable>
    </View>
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
