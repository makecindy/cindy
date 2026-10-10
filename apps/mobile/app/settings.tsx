import { diagnosticUploadConfigured, uploadMobileDiagnostics } from '@/debug/mobileDiagnosticUpload';
import { clearDiagnostics, diagnosticsEnabled, exportDiagnostics, hydrateDiagnostics, setDiagnosticsEnabled } from '@/debug/localDiagnostics';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  DevSettings,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/AppText';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ellipsis } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { loginText } from '@/auth/loginMessages';
import {
  clearAnalyticsEnabledOverride,
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
  setAnalyticsEnabled,
  subscribeAnalyticsConsent,
} from '@/analytics/analyticsConsentStore';
import { initMobileTapdb, setTapdbUser, stopMobileTapdbReporting } from '@/analytics/mobileTapdb';
import { hasPrivacyConsent } from '@/update/updateConsentGate';
import { SUPPORTED_LOCALES, type LocalePreference } from '@/i18n';
import { useLocale } from '@/i18n/useLocale';
import { goBackGuarded } from '@/utils/backGuard';
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  StatusDot,
} from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { MobileUserAvatar } from '@/components/MobileUserAvatar';
import {
  NativePullDownMenu,
  SimpleStackHeader,
  simpleScrollInsetProps,
  simpleScrollScreenSafeAreaEdges,
  usesNativePullDownMenu,
} from '@/platform/chrome';
import {
  APP_BINARY_VERSION,
  AUTH_API_BASE_URL,
  AUTH_REGION,
  DESKTOP_PACKAGE_VERSION,
  IS_OTA_SELFHOST,
  IS_TESTFLIGHT_BUILD,
  REVIEW_MODE,
} from '@/config/env';
import {
  DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED,
  switchDevServerEnvironmentAndReload,
  type DevServerEnvironment,
} from '@/config/devServerEnvironment';
import { useDevServerEnvironment } from '@/config/useDevServerEnvironment';
import { LEGAL_LINKS } from '@/config/legalLinks';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import { formatRemoteError } from '@/device-link/remoteStatus';
import {
  buildMobileSettingsOverview,
  type MobileSettingsRow,
} from '@/settings/mobileSettings';
import {
  isPushSupported,
  readPushEnabled,
  syncPushRegistration,
  writePushEnabled,
} from '@/notifications/pushNotifications';
import {
  hydrateMobileVoiceDictionary,
  readCachedMobileVoiceDictionarySnapshot,
  subscribeMobileVoiceDictionaryCache,
} from '@/session/mobileVoiceDictionaryCache';
import { buildMobileVoiceDictionaryEntryViews } from '@/session/mobileVoiceDictionaryView';
import { buildMobileUpdateInfoRows, currentMobileOtaVersion } from '@/settings/updateInfo';
import { shouldCheckBundleUpdate } from '@/update/bundleUpdate';
import { isGooglePlayInstallation } from '@/update/androidInstallSource';
import {
  manualUpdateCheckMessage,
  runManualUpdateCheck,
  type ManualUpdateCheckOutcome,
} from '@/update/manualUpdateCheck';
import { runSelfHostedOtaRequest } from '@/update/otaRequestCoordinator';
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useUpdateChannelGate } from '@/update/useUpdateChannelGate';
import { useBetaChannel } from '@/update/useBetaChannel';
import { probeBetaChannel } from '@/update/fetchLatestRelease';
import { MobileChoicePickerList } from '@/session/MobileChoicePickerList';
import { DisclosureItem, ListDisclosureScope, useListDisclosureTransition } from '@/session/listDisclosureTransition';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import type { MobileChoiceOption } from '@/session/agentCapabilities';
import {
  ActionInfoRow,
  ChoicePickerRow,
  InfoRow,
  SettingsDisclosureRow,
  SettingsGroup,
  SettingsSwitchRow,
} from '@/session/SettingsGroupRows';
import { useSettingsDeviceDirectory } from '@/session/settingsDeviceDirectory';
import { confirmLogout } from '@/session/confirmLogout';
import { THEME_PREFERENCES, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { useGuardedPush } from '@/utils/useGuardedPush';

type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'uptodate' | 'error';
// 显示语言选项:「跟随系统」在前,英语作为第一个显式语言,其余语言按支持列表顺序排列。
const LANGUAGE_OPTIONS: readonly LocalePreference[] = [
  'system',
  'en',
  ...SUPPORTED_LOCALES.filter((locale) => locale !== 'en'),
];

function hasRunningRemoteTasks(): boolean {
  return remoteSessionStore.getSessions().some((session) => remoteSessionStore.isSessionRunning(session.id));
}

/**
 * 设置页。二级页(语音词典、本机名称)是独立 stack 路由(app/settings/*),
 * 系统返回只退回这里。
 */
export default function SettingsScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors, preference: themePreference, setPreference: setThemePreference } = useTheme();
  const router = useRouter();
  const push = useGuardedPush();
  const auth = useAuth();
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const windowDimensions = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const { status } = useDeviceLink();
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [localLogsEnabled, setLocalLogsEnabled] = useState(false);
  const [localLogsReady, setLocalLogsReady] = useState(false);
  const [localLogsBusy, setLocalLogsBusy] = useState(false);
  const [localLogsConsent, setLocalLogsConsent] = useState(false);
  const [localLogUploadMessage, setLocalLogUploadMessage] = useState<string | null>(null);
  const localLogsLock = useRef(false);
  useEffect(() => {
    let mounted = true;
    void hydrateDiagnostics().then(() => {
      if (mounted) {
        setLocalLogsEnabled(diagnosticsEnabled());
        setLocalLogsReady(true);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);
  const runLocalLogAction = async (action: () => Promise<void>) => {
    if (localLogsLock.current) return;
    localLogsLock.current = true;
    setLocalLogsBusy(true);
    try {
      await action();
    } catch {
      Alert.alert(
        t('settings.localLogs.title'),
        t('settings.localLogs.failed'),
      );
    } finally {
      setLocalLogsEnabled(diagnosticsEnabled());
      setLocalLogsBusy(false);
      localLogsLock.current = false;
    }
  };
  const handleLocalLogOption = (id: string) => {
    if (!localLogsReady || localLogsBusy) return;
    if (id === 'clear') Alert.alert(t('settings.localLogs.clear'), t('settings.localLogs.clearHint'), [
      { text: t('settings.localLogs.cancel'), style: 'cancel' },
      { text: t('settings.localLogs.clear'), style: 'destructive', onPress: () => void runLocalLogAction(clearDiagnostics) },
    ]);
  };
  const [accountDeletionAvailable, setAccountDeletionAvailable] =
    useState(false);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [languagePickerSnap, setLanguagePickerSnap] = useState<ContextSheetSnap>('half');
  const [appearancePickerOpen, setAppearancePickerOpen] = useState(false);
  const [appearancePickerSnap, setAppearancePickerSnap] = useState<ContextSheetSnap>('half');
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle');
  const [updateOutcome, setUpdateOutcome] = useState<ManualUpdateCheckOutcome | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  // 使用统计(TapDB)开关。真相在 analyticsConsentStore,这里只是视图态。
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(true);
  const [analyticsCustomized, setAnalyticsCustomized] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  // hydration 完成前开关必须禁用:此时显示的是 fail-closed 默认值,可能与盘上
  // 相反;放行点击会让 toggleAnalytics 对着真值取反,做出与所见相反的动作。
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const [analyticsMessage, setAnalyticsMessage] = useState<string | null>(null);
  // beta 测试渠道(设备级)开关。真相在 betaChannelStore;hydrate 完成前禁用,避免对陈旧值取反。
  const { enabled: betaEnabled, ready: betaReady, setEnabled: setBetaEnabled } = useBetaChannel();
  const [betaBusy, setBetaBusy] = useState(false);
  const showBetaBadge = betaReady && betaEnabled;
  const {
    environment: devServerEnvironment,
    ready: devServerEnvironmentReady,
    setEnvironment: setDevServerEnvironment,
  } = useDevServerEnvironment();
  const [devServerEnvironmentBusy, setDevServerEnvironmentBusy] =
    useState(false);
  const updateCheckInFlightRef = useRef(false);
  // 语音词典:手机只读展示被控桌面的词典快照(正本在桌面,手机不参与合并)。查看页是独立路由。
  const { desktopDevices, selfDeviceName } = useSettingsDeviceDirectory();
  /** 缓存在模块里,组件用这个计数强制重渲染。 */
  const [dictionaryRevision, setDictionaryRevision] = useState(0);

  const systemDeviceName = buildMobileDeviceName({
    constantsDeviceName: Constants.deviceName,
    platform: Platform.OS,
  });
  const deviceName = selfDeviceName ?? systemDeviceName;
  const overview = useMemo(
    () => buildMobileSettingsOverview({
      authBaseUrl: AUTH_API_BASE_URL,
      authRegion: AUTH_REGION,
      deviceId: auth.deviceId,
      deviceName,
      platform: Platform.OS,
      relayStatus: status,
      userEmail: auth.user?.email,
      userId: auth.user?.id,
      userName: auth.user?.name,
    }),
    // t 依赖:buildMobileSettingsOverview 内部走 i18n.t,语言切换时(t 身份变化)重建展示模型。
    [auth.deviceId, auth.user?.email, auth.user?.id, auth.user?.name, deviceName, status, t],
  );

  // 整包版本必须读原生烧进的值(CFBundleShortVersionString / versionName):
  // OTA 热更会把 manifest 里内嵌的 expoClient.version 覆盖给 Constants.expoConfig.version,
  // 而热更不改原生包,若读 expoConfig 会在热更后回退成打热更时主仓 app.json 的旧值。
  // APP_BINARY_VERSION 优先取原生层、热更后不漂移(与 mobileTapdb / env 上报同口径)。
  const appVersion = APP_BINARY_VERSION || '0.0.0';
  const updatesEnabled = Updates.isEnabled;
  // 当前运行的 OTA bundle 信息(只读),折进「调试」分组,用于核验热更是否生效。
  const { currentlyRunning } = useUpdates();
  // t 依赖同 overview:行构造走 i18n.t,语言切换时重算。
  const updateInfoRows = useMemo(() => buildMobileUpdateInfoRows(currentlyRunning), [currentlyRunning, t]);
  const otaVersion = useMemo(() => currentMobileOtaVersion(currentlyRunning), [currentlyRunning, t]);
  const updateChannel = useUpdateChannelGate(IS_OTA_SELFHOST);
  // 允许整包分发时统一入口先查整包;TestFlight 等禁用整包的环境直接进入 JS OTA。
  const { checkNow: checkBundleUpdate } = useBundleUpdatePrompt({
    auto: false,
    channel: updateChannel.channel,
  });
  const playManagedUpdates = Platform.OS === 'android' && isGooglePlayInstallation();
  const bundleCheckEnabled = shouldCheckBundleUpdate({
    isSelfHosted: IS_OTA_SELFHOST,
    isReviewMode: REVIEW_MODE,
    isTestFlightBuild: IS_TESTFLIGHT_BUILD,
    isGooglePlayInstallation: playManagedUpdates,
  });
  const updateCheckEnabled = bundleCheckEnabled || updatesEnabled;
  // 保存未翻译的结果，语言切换触发重渲染时用当前 t() 重新生成提示。
  const updateMessage = useMemo(
    () => updateOutcome && manualUpdateCheckMessage(updateOutcome, {
      isTestFlightBuild: IS_TESTFLIGHT_BUILD,
      isGooglePlayInstallation: playManagedUpdates,
      t,
    }),
    [playManagedUpdates, t, updateOutcome],
  );

  const aboutSection = overview.sections.find((section) => section.id === 'about');
  const debugSection = overview.sections.find((section) => section.id === 'debug');
  const languagePickerOptions = useMemo<readonly MobileChoiceOption[]>(
    () => LANGUAGE_OPTIONS.map((option) => ({
      id: option,
      label: t(`settings.language.options.${option}`),
    })),
    [t],
  );
  const choicePickerHeights = useMemo(
    () => computeContextSheetSnapHeights({
      safeAreaTopInset: safeAreaInsets.top,
      screenHeight: windowDimensions.height,
    }),
    [safeAreaInsets.top, windowDimensions.height],
  );
  const openLanguagePicker = useCallback(() => {
    setLanguagePickerSnap('half');
    setLanguagePickerOpen(true);
  }, []);
  const selectLanguage = useCallback((next: string) => {
    const nextLocale = LANGUAGE_OPTIONS.find((option) => option === next);
    if (!nextLocale) return;
    setLocale(nextLocale);
    setLanguagePickerOpen(false);
  }, [setLocale]);
  const appearancePickerOptions = useMemo<readonly MobileChoiceOption[]>(
    () => THEME_PREFERENCES.map((option) => ({
      id: option,
      label: t(`settings.appearance.options.${option}`),
    })),
    [t],
  );
  const openAppearancePicker = useCallback(() => {
    setAppearancePickerSnap('half');
    setAppearancePickerOpen(true);
  }, []);
  const selectAppearance = useCallback((next: string) => {
    const nextPreference = THEME_PREFERENCES.find((option) => option === next);
    if (!nextPreference) return;
    setAppearancePickerOpen(false);
    // 本次会话已切换;只有本机存储写失败时提示下次启动会回到原设置。
    setThemePreference(nextPreference).catch(() => {
      Alert.alert(t('settings.appearance.modeLabel'), t('settings.appearance.saveFailed'));
    });
  }, [setThemePreference, t]);


  useEffect(() => {
    if (!auth.isAuthenticated) {
      setAccountDeletionAvailable(false);
      return;
    }
    let cancelled = false;
    setAccountDeletionAvailable(false);
    void auth
      .getAccountDeletionAvailability()
      .then((availability) => {
        if (!cancelled) {
          setAccountDeletionAvailable(availability.available);
        }
      })
      .catch(() => {
        if (!cancelled) setAccountDeletionAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.getAccountDeletionAvailability, auth.isAuthenticated]);

  const copyRow = useCallback(async (row: MobileSettingsRow) => {
    if (!row.copyValue) return;
    await Clipboard.setStringAsync(row.copyValue);
    setCopiedRowId(row.id);
  }, []);

  const openPrivacyPolicy = useCallback(() => {
    void Linking.openURL(LEGAL_LINKS.privacyPolicy).catch(() => undefined);
  }, []);

  const openUserAgreement = useCallback(() => {
    void Linking.openURL(LEGAL_LINKS.termsOfService).catch(() => undefined);
  }, []);

  const checkForUpdate = useCallback(async () => {
    // 审核模式:入口按钮已隐藏,这里再挡一层(状态由代码保证,不依赖 UI 层记得隐藏)。
    if (REVIEW_MODE || !updateCheckEnabled || updateCheckInFlightRef.current) return;
    updateCheckInFlightRef.current = true;
    setUpdateOutcome(null);
    try {
      const outcome = await runManualUpdateCheck({
        checkBundleUpdate: bundleCheckEnabled ? checkBundleUpdate : undefined,
        otaEnabled: updatesEnabled,
        // 自建线由事务协调器覆盖共享 UUID，因此不再借用 analytics consent；EAS /
        // TestFlight 仍保留原同意闸门，TapDB 的 consent 状态也完全不在这里修改。
        ...(IS_OTA_SELFHOST
          ? {
              withOtaClient: (operation) => runSelfHostedOtaRequest(
                updateChannel.channel,
                operation,
              ),
            }
          : { isConsented: hasPrivacyConsent }),
        checkOtaUpdate: () => Updates.checkForUpdateAsync(),
        fetchOtaUpdate: () => Updates.fetchUpdateAsync(),
        reload: () => Updates.reloadAsync(),
        isEmergencyLaunch: () => currentlyRunning.isEmergencyLaunch,
        onPhase: (phase) => setUpdatePhase(phase),
      });
      setUpdateOutcome(outcome);
      if (outcome.kind === 'bundle-update-available') {
        setUpdatePhase('idle');
      } else if (outcome.kind === 'up-to-date') {
        setUpdatePhase('uptodate');
      } else if (outcome.kind === 'ota-unavailable') {
        setUpdatePhase('uptodate');
      } else if (outcome.kind === 'reloading') {
        setUpdatePhase('downloading');
      } else if (outcome.kind === 'restart-required') {
        // 更新已经拿到了,只是本进程重启不了 —— 不是失败态,提示文案负责说明要手动重开。
        setUpdatePhase('uptodate');
      } else if (outcome.kind === 'busy') {
        setUpdatePhase('idle');
      } else {
        setUpdatePhase('error');
      }
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, [
    bundleCheckEnabled,
    checkBundleUpdate,
    currentlyRunning.isEmergencyLaunch,
    t,
    updateChannel.channel,
    updateCheckEnabled,
    updatesEnabled,
  ]);

  const openSelfDeviceNameEditor = useCallback(() => {
    push('/settings/device-name');
  }, [push]);

  const logout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await auth.logout();
      router.replace('/login');
    } catch (error) {
      Alert.alert(t('devices.list.alert.actionFailed'), formatRemoteError(error));
    } finally {
      setLoggingOut(false);
    }
  }, [auth, loggingOut, router, t]);

  // 退出登录先确认(与首页抽屉、伙伴页同一套 confirmLogout 文案):运行中任务要额外说明。
  const requestLogout = useCallback(() => {
    if (loggingOut) return;
    confirmLogout(t, hasRunningRemoteTasks(), () => void logout());
  }, [loggingOut, logout, t]);


  const switchDevServerEnvironment = useCallback(
    async (next: DevServerEnvironment) => {
      if (
        !DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED ||
        devServerEnvironmentBusy ||
        !devServerEnvironmentReady ||
        next === devServerEnvironment
      ) {
        return;
      }
      const reload = __DEV__
        ? () => DevSettings.reload()
        : Updates.isEnabled
          ? () => Updates.reloadAsync()
          : null;
      if (!reload) {
        Alert.alert(
          t('settings.devServerEnvironment.title'),
          t('settings.devServerEnvironment.switchFailed'),
        );
        return;
      }
      setDevServerEnvironmentBusy(true);
      try {
        // 旧环境的 push 注销、token 与账号缓存必须先在旧端点仍生效时清理。
        await auth.logout();
        await switchDevServerEnvironmentAndReload({
          current: devServerEnvironment,
          next,
          reload,
          setEnvironment: setDevServerEnvironment,
        });
      } catch {
        Alert.alert(
          t('settings.devServerEnvironment.title'),
          t('settings.devServerEnvironment.switchFailed'),
        );
      } finally {
        setDevServerEnvironmentBusy(false);
      }
    },
    [
      auth,
      devServerEnvironment,
      devServerEnvironmentBusy,
      devServerEnvironmentReady,
      setDevServerEnvironment,
      t,
    ],
  );

  const confirmDevServerEnvironmentSwitch = useCallback(() => {
    if (
      !DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED ||
      devServerEnvironmentBusy ||
      !devServerEnvironmentReady
    ) {
      return;
    }
    const next: DevServerEnvironment =
      devServerEnvironment === 'dev' ? 'release' : 'dev';
    Alert.alert(
      t('settings.devServerEnvironment.confirmTitle', {
        environment: t(`settings.devServerEnvironment.options.${next}`),
      }),
      t('settings.devServerEnvironment.confirmBody'),
      [
        { text: t('settings.devServerEnvironment.cancel'), style: 'cancel' },
        {
          text: t('settings.devServerEnvironment.switchAction'),
          style: 'destructive',
          onPress: () => void switchDevServerEnvironment(next),
        },
      ],
    );
  }, [
    devServerEnvironment,
    devServerEnvironmentBusy,
    devServerEnvironmentReady,
    switchDevServerEnvironment,
    t,
  ]);

  const openAccountDeletion = useCallback(() => {
    router.push('/account-deletion');
  }, [router]);

  // 任务完成通知开关:开 → 请求系统权限 + 注册 APNs token 到 device-link server;
  // 关 → 注销 token。开关状态本机持久化,server 注册表是唯一发送依据。
  useEffect(() => {
    let cancelled = false;
    void readPushEnabled().then((enabled) => {
      if (!cancelled) setPushEnabled(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 使用统计开关的当前值。store 是本机唯一真相,订阅它以免多个入口写入后本页陈旧。
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const snapshot = getAnalyticsConsentState();
      setLocalLogsConsent(snapshot.consent);
      setAnalyticsEnabledState(snapshot.enabled);
      setAnalyticsCustomized(snapshot.enabledCustomized);
    };
    void hydrateAnalyticsConsent()
      .then(sync)
      .catch(() => undefined)
      // 读失败也放开:store 已 fail closed 到已 hydrate 的默认态,此后的交互
      // 操作的是真值,不再有「对陈旧显示取反」的问题。
      .finally(() => {
        if (!cancelled) setAnalyticsReady(true);
      });
    const unsubscribe = subscribeAnalyticsConsent(sync);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const togglePushNotifications = useCallback(async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushMessage(null);
    const next = !pushEnabled;
    try {
      if (!next) {
        // 关闭是用户明确的 opt-out:先落盘生效(离线也不允许开关弹回),
        // 注销请求失败则排队补偿,下次联网启动自动补上。
        await writePushEnabled(false);
        setPushEnabled(false);
        try {
          await syncPushRegistration({ enabled: false, apiFetch: auth.apiFetch });
        } catch {
          setPushMessage(t('settings.notifications.unregisterQueued'));
        }
        return;
      }
      const result = await syncPushRegistration({ enabled: true, apiFetch: auth.apiFetch });
      if (result === 'permission-denied') {
        setPushMessage(t('settings.notifications.permissionDenied'));
        return; // 权限被拒:开关保持关闭,不落盘
      }
      await writePushEnabled(true);
      setPushEnabled(true);
    } catch (error) {
      setPushMessage(formatRemoteError(error));
    } finally {
      setPushBusy(false);
    }
  }, [auth.apiFetch, pushBusy, pushEnabled, t]);

  // Android 10 上快速反向切换这组父卡片 layout + 多行 exiting 时会出现重叠 / 空白。
  // 设置页在 Android 上同步重排,避免退出视图参与后续布局;保留 iOS 动画与原状态逻辑。
  const debugDisclosureMotionEnabled = Platform.OS !== 'android';
  const debugDisclosure = useListDisclosureTransition({
    motionEnabled: debugDisclosureMotionEnabled,
  });
  const runDebugDisclosure = debugDisclosure.run;
  const toggleDebug = useCallback(() => {
    runDebugDisclosure(() => setDebugExpanded((value) => !value));
  }, [runDebugDisclosure]);

  // beta 测试渠道开关:落盘即时生效,但 manifest 通道只在下次冷启动/后台轮询切换。
  // 打开后引导用户手动重启,让下次启动的更新检查前就切到 beta。
  const toggleBeta = useCallback(async () => {
    if (betaBusy) return;
    setBetaBusy(true);
    const next = !betaEnabled;
    try {
      if (next) {
        // 打开 beta 前预检(与桌面端 probeBetaManifest 对称):探测 /latest?channel=beta
        // 是否可达。服务端未部署 beta 时拒绝开启,避免设备静默收不到 OTA/整包/强更记录。
        const available = await probeBetaChannel(
          Platform.OS === 'android' ? 'android' : 'ios',
        );
        if (!available) {
          Alert.alert(t('settings.betaChannel.title'), t('settings.betaChannel.unavailable'));
          return; // 不落盘,开关保持关闭
        }
      }
      await setBetaEnabled(next);
      if (next) {
        Alert.alert(
          t('settings.betaChannel.title'),
          t('settings.betaChannel.restartHint'),
          [{ text: t('settings.betaChannel.ok'), style: 'default' }],
        );
      }
    } catch {
      // 只可能是本机存储异常;store 会回推真值,这里仅提示未保存成功。
      Alert.alert(t('settings.betaChannel.title'), t('settings.betaChannel.saveFailed'));
    } finally {
      setBetaBusy(false);
    }
  }, [betaBusy, betaEnabled, setBetaEnabled, t]);

  /* ── 使用统计(TapDB)开关 ──
     语义是 opt-out:用户在登录页同意《隐私政策》后默认开启,这里随时可关。
     关闭后立即解绑账号标识、不再主动上报;原生 SDK 不支持反初始化,本次进程内
     已初始化的实例要到下次冷启动才彻底不再初始化(见 analytics/mobileTapdb)。

     关闭路径**先停上报再落盘**:写盘失败时本次运行已经不再上报(偏安全的一侧),
     而开关值不变,如实反映「重启后仍是开启」。 */
  /* 重新开启统计时必须**重新绑定当前账号**。关闭路径已经调过 clearNativeTapdbUser(),
     而 AuthContext 里负责绑定的 effect 依赖 [initialized, user?.id] —— 拨开关不会
     让这两个值变化,所以它不会再跑。不补这一下的话,账号维度的用量会一直空到下次
     重启或下一次登录态变化。 */
  const resumeAnalyticsReporting = useCallback(async () => {
    const status = await initMobileTapdb();
    if (!status.ok) return;
    const userId = auth.user?.id;
    if (userId) await setTapdbUser(userId);
  }, [auth.user?.id]);

  const toggleAnalytics = useCallback(async () => {
    if (analyticsBusy) return;
    setAnalyticsBusy(true);
    setAnalyticsMessage(null);
    try {
      // 必须先 hydrate 再取反:AsyncStorage 读慢时 getAnalyticsConsentState() 返回的
      // 是 fail-closed 默认值,直接取反会算错方向,对着一个陈旧值执行 stop/start。
      await hydrateAnalyticsConsent();
      const next = !getAnalyticsConsentState().enabled;
      if (!next) await stopMobileTapdbReporting();
      await setAnalyticsEnabled(next);
      if (next) await resumeAnalyticsReporting();
    } catch {
      // 只可能是本机存储异常(无服务端往返)。开关值由 store 回推,保持落盘前的
      // 真值;这里显式告诉用户没存住,而不是让它看起来「点了没反应」。
      setAnalyticsMessage(t('settings.legal.analyticsSaveFailed'));
    } finally {
      setAnalyticsBusy(false);
    }
  }, [analyticsBusy, resumeAnalyticsReporting, t]);

  /* 恢复默认:只删掉开关 override 让它重新跟随版本默认值,同意事实不动
     (configuration-and-overrides §4)。仅在用户显式拨过开关时出现。 */
  const resetAnalytics = useCallback(async () => {
    if (analyticsBusy) return;
    setAnalyticsBusy(true);
    setAnalyticsMessage(null);
    try {
      await clearAnalyticsEnabledOverride();
      if (getAnalyticsConsentState().enabled) await resumeAnalyticsReporting();
      else await stopMobileTapdbReporting();
    } catch {
      setAnalyticsMessage(t('settings.legal.analyticsSaveFailed'));
    } finally {
      setAnalyticsBusy(false);
    }
  }, [analyticsBusy, resumeAnalyticsReporting, t]);

  // 词条数来自本机缓存:进入设置时先把盘上缓存读进内存,查看页刷新后经缓存订阅同步回来。
  useEffect(() => {
    if (desktopDevices.length === 0) return;
    let cancelled = false;
    void Promise.all(desktopDevices.map((host) => hydrateMobileVoiceDictionary(host.deviceId)))
      .then(() => {
        if (!cancelled) setDictionaryRevision((value) => value + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktopDevices]);

  useEffect(() => subscribeMobileVoiceDictionaryCache(() => {
    setDictionaryRevision((value) => value + 1);
  }), []);

  const openVoiceDictionary = useCallback(() => {
    push('/settings/voice-dictionary');
  }, [push]);

  // dictionaryRevision 只作为依赖存在:缓存是模块级的,刷新完成后靠它触发重算。
  const dictionaryEntries = useMemo(
    () =>
      buildMobileVoiceDictionaryEntryViews(
        desktopDevices.map((host) => readCachedMobileVoiceDictionarySnapshot(host.deviceId)),
      ),
    [desktopDevices, dictionaryRevision],
  );

  const updateBusy = updatePhase === 'checking' || updatePhase === 'downloading';
  const updateActionLabel = t(
    IS_TESTFLIGHT_BUILD || playManagedUpdates
      ? 'settings.version.testFlightCheckAction'
      : 'settings.version.checkAction',
  );
  // 面向用户的更新方式说明;OTA 版本号、运行来源等技术细节在「调试 / 开发者」里。
  const updateMethodHint = REVIEW_MODE
    ? null
    : IS_TESTFLIGHT_BUILD
      ? (updatesEnabled ? null : t('settings.version.testFlightContentUpdateUnavailable'))
      : playManagedUpdates
        ? (updatesEnabled ? null : t('settings.version.googlePlayContentUpdateUnavailable'))
        : updatesEnabled
          ? t('settings.version.updateMethodInApp')
          : bundleCheckEnabled
            ? t('settings.version.updateMethodPackage')
            : t('settings.version.updateMethodUnavailable');

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.backButton"
        onBack={() => goBackGuarded(router)}
        title={t('settings.title')}
        titleTestID="settings.title"
      />

      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content} testID="settings.scroll">
        <ListDisclosureScope
          controller={debugDisclosure.controller}
          motionEnabled={debugDisclosureMotionEnabled}
        >
          {/* 账号头部:身份 + 连接状态一次性呈现,下面分组不再重复 */}
          <View style={styles.headerCard} testID="settings.accountHeader">
            <MobileUserAvatar imageUrl={auth.user?.avatar} name={overview.header.name} size="large" />
            <View style={styles.headerTexts}>
              <Text style={styles.headerName} numberOfLines={1}>{overview.header.name}</Text>
              {overview.header.email ? (
                <Text style={styles.headerEmail} numberOfLines={1}>{overview.header.email}</Text>
              ) : null}
              <View style={styles.headerStatusRow}>
                <StatusDot tone={overview.header.relayTone} pulsing={status === 'connecting'} />
                <Text style={styles.headerStatusText} numberOfLines={1}>
                  {`${overview.header.relayLabel} · ${overview.header.relayDetail}`}
                </Text>
              </View>
            </View>
          </View>

          {/* 版本:只保留统一检查入口;允许整包分发时先查整包,否则直接查热更。 */}
          <SettingsGroup title={t('settings.version.sectionTitle')}>
            {[
              <View key="version" style={styles.versionRow} testID="settings.version">
                <View style={styles.versionTexts}>
                  <View style={styles.versionValueRow}>
                    <Text style={styles.versionLabel} testID="settings.appVersion">{t('settings.version.appVersion', { version: appVersion })}</Text>
                    {showBetaBadge ? (
                      <View style={styles.betaChannelBadge} testID="settings.betaChannelBadge">
                        <Text style={styles.betaChannelBadgeText}>{t('settings.betaChannel.badge')}</Text>
                      </View>
                    ) : null}
                  </View>
                  {/* 二级版本号:自建线打包所配对的桌面产品线版本(0.0.x),不是在线电脑的实时版本;仅自建线且已注入时显示 */}
                  {IS_OTA_SELFHOST && DESKTOP_PACKAGE_VERSION ? (
                    <Text style={styles.versionDetail} testID="settings.desktopVersion">{t('settings.version.pairedDesktopVersion', { version: DESKTOP_PACKAGE_VERSION })}</Text>
                  ) : null}
                  {IS_TESTFLIGHT_BUILD ? (
                    <Text style={styles.versionDetail} testID="settings.testFlightUpdateHint">
                      {t('settings.version.testFlightUpdateManaged')}
                    </Text>
                  ) : null}
                  {playManagedUpdates ? (
                    <Text style={styles.versionDetail} testID="settings.googlePlayUpdateHint">
                      {t('settings.version.googlePlayUpdateManaged')}
                    </Text>
                  ) : null}
                  {updateMessage ? (
                    <Text style={styles.versionDetail} testID="settings.updateMessage">{updateMessage}</Text>
                  ) : updateMethodHint ? (
                    <Text style={styles.versionDetail} testID="settings.updateMethod">{updateMethodHint}</Text>
                  ) : null}
                </View>
                {/* 审核模式(清单 review 命中当前二进制版本):隐藏检查更新入口,版本号照常展示。
                    次级按钮(描边 + 正文色),避免灰底读成禁用;加载时只转圈。 */}
                {!REVIEW_MODE ? (
                  <MainWindowActionButton
                    action={{
                      accessibilityLabel: updateBusy
                        ? t(
                          IS_TESTFLIGHT_BUILD || playManagedUpdates
                            ? 'settings.version.testFlightCheckingAccessibility'
                            : 'settings.version.checkingAccessibility',
                        )
                        : updateActionLabel,
                      busy: updateBusy,
                      disabled: !updateCheckEnabled,
                      label: updateActionLabel,
                      onPress: () => void checkForUpdate(),
                      testID: 'settings.checkUpdateButton',
                      tone: 'secondary',
                    }}
                    style={styles.versionButton}
                  />
                ) : null}
              </View>,
            ]}
          </SettingsGroup>

          {/* 通知:任务完成推送(仅 iOS;Android 待 FCM/厂商通道) */}
          {isPushSupported() ? (
            <SettingsGroup title={t('settings.notifications.sectionTitle')}>
              <SettingsSwitchRow
                accessibilityLabel={t('settings.notifications.taskDone')}
                disabled={pushBusy}
                hint={t('settings.notifications.taskDoneHint')}
                key="push-toggle"
                label={t('settings.notifications.taskDone')}
                messages={[pushMessage ? { text: pushMessage, testID: 'settings.pushMessage' } : null]}
                onValueChange={() => void togglePushNotifications()}
                switchTestID="settings.pushToggle"
                testID="settings.pushToggleRow"
                value={pushEnabled}
              />
            </SettingsGroup>
          ) : null}

          {/* 语音词典:只读查看电脑上的词典(正本在电脑,增删改回电脑做) */}
          <SettingsGroup
            footer={t('settings.voiceDictionary.hint')}
            title={t('settings.voiceDictionary.sectionTitle')}
          >
            <ActionInfoRow
              accessibilityLabel={t('settings.voiceDictionary.openAccessibility')}
              key="voice-dictionary"
              label={t('settings.voiceDictionary.label')}
              onPress={openVoiceDictionary}
              testID="settings.voiceDictionary.row"
              value={t('settings.voiceDictionary.entryCount', { count: dictionaryEntries.length })}
            />
          </SettingsGroup>

          <SettingsGroup title={t('sharedTask.title')}>
            <ActionInfoRow
              accessibilityLabel={t('sharedTask.manageSharing')}
              label={t('sharedTask.manageSharing')}
              value=""
              onPress={() => router.push({ pathname: '/shared-session', params: { mode: 'manage' } })}
              testID="settings.sharedTasks.row"
            />
          </SettingsGroup>

          {/* 显示模式:默认跟随系统,手动选择浅色 / 深色即持久化 override(恢复跟随系统 = 清除 override) */}
          <SettingsGroup title={t('settings.appearance.title')}>
            <NativePullDownMenu
              actions={THEME_PREFERENCES.map((option) => ({
                id: option,
                state: option === themePreference ? 'on' : 'off',
                title: t(`settings.appearance.options.${option}`),
              }))}
              onAction={selectAppearance}
            >
              <ChoicePickerRow
                expanded={appearancePickerOpen}
                label={t('settings.appearance.modeLabel')}
                onPress={usesNativePullDownMenu() ? () => undefined : openAppearancePicker}
                testID="settings.appearance.picker"
                value={t(`settings.appearance.options.${themePreference}`)}
              />
            </NativePullDownMenu>
          </SettingsGroup>

          {/* 显示语言:默认跟随系统,手动选择即持久化 override(恢复跟随系统 = 清除 override) */}
          <SettingsGroup
            footer={t('settings.language.hint')}
            title={t('settings.language.title')}
          >
            <NativePullDownMenu
              actions={LANGUAGE_OPTIONS.map((option) => ({
                id: option,
                state: option === locale ? 'on' : 'off',
                title: t(`settings.language.options.${option}`),
              }))}
              onAction={selectLanguage}
            >
              <ChoicePickerRow
                expanded={languagePickerOpen}
                label={t('settings.language.title')}
                onPress={usesNativePullDownMenu() ? () => undefined : openLanguagePicker}
                testID="settings.language.picker"
                value={t(`settings.language.options.${locale}`)}
              />
            </NativePullDownMenu>
          </SettingsGroup>

          {/* 关于这台手机 */}
          {aboutSection ? (
            <SettingsGroup title={aboutSection.title}>
              {aboutSection.rows.map((row) => (
                row.id === 'about.deviceName' ? (
                  <ActionInfoRow
                    accessibilityLabel={t('settings.about.editAccessibility', { label: row.label })}
                    detail={row.detail}
                    key={row.id}
                    label={row.label}
                    onPress={openSelfDeviceNameEditor}
                    testID="settings.selfDeviceNameRow"
                    value={row.value}
                  />
                ) : (
                  <InfoRow key={row.id} detail={row.detail} label={row.label} testID={`settings.row.${row.id}`} value={row.value} />
                )
              ))}
            </SettingsGroup>
          ) : null}

          {/* 调试 / 开发者:默认折叠;折叠开关是卡片里的第一行,展开的行接在同一张卡片里。 */}
          {debugSection ? (
            <SettingsGroup testID="settings.debugGroup">
              <SettingsDisclosureRow
                expanded={debugExpanded}
                key="debug-toggle"
                label={debugSection.title}
                onPress={toggleDebug}
                testID="settings.debugToggle"
              />
              {debugExpanded
                ? [
                    <SettingsSwitchRow
                      accessibilityLabel={t('settings.localLogs.record')}
                      accessory={(
                        <NativePullDownMenu
                          actions={[
                            { id: 'clear', title: t('settings.localLogs.clear'), destructive: true, disabled: !localLogsReady || localLogsBusy },
                          ]}
                          onAction={handleLocalLogOption}
                        >
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('settings.localLogs.options')}
                            disabled={!localLogsReady || localLogsBusy}
                            style={({ pressed }) => [styles.localLogOptions, pressed && styles.pressed]}
                            onPress={usesNativePullDownMenu() ? undefined : () => Alert.alert(t('settings.localLogs.options'), undefined, [
                              { text: t('settings.localLogs.clear'), style: 'destructive', onPress: () => handleLocalLogOption('clear') },
                              { text: t('settings.localLogs.cancel'), style: 'cancel' },
                            ])}
                          >
                            <Ellipsis color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
                          </Pressable>
                        </NativePullDownMenu>
                      )}
                      disabled={!localLogsReady || localLogsBusy}
                      hint={t('settings.localLogs.hint')}
                      key="local-logs-toggle"
                      label={t('settings.localLogs.title')}
                      onValueChange={(value) =>
                        void runLocalLogAction(() =>
                          setDiagnosticsEnabled(value),
                        )
                      }
                      testID="settings.localLogs"
                      value={localLogsEnabled}
                    />,
                    <ActionInfoRow
                      key="local-logs-export"
                      accessibilityLabel={t('settings.localLogs.export')}
                      label={t('settings.localLogs.export')}
                      detail={t('settings.localLogs.exportHint')}
                      disabled={!localLogsReady || localLogsBusy}
                      value={localLogsBusy ? t('settings.localLogs.busy') : ''}
                      onPress={() => void runLocalLogAction(exportDiagnostics)}
                    />,
                    <ActionInfoRow
                      key="local-logs-upload"
                      accessibilityLabel={t('settings.localLogs.upload')}
                      label={t('settings.localLogs.upload')}
                      disabled={!localLogsReady || localLogsBusy || !diagnosticUploadConfigured() || !localLogsConsent}
                      detail={!diagnosticUploadConfigured()
                        ? t('settings.localLogs.uploadResult.unavailable')
                        : !localLogsConsent ? t('settings.localLogs.uploadResult.consentRequired')
                        : localLogUploadMessage ?? t('settings.localLogs.uploadHint')}
                      value={
                        localLogsBusy ? t('settings.localLogs.busy') : ''
                      }
                      onPress={() =>
                        void runLocalLogAction(async () => {
                          const result = await uploadMobileDiagnostics();
                          if (result.kind === 'uploaded') {
                            let copied = false;
                            try { await Clipboard.setStringAsync(result.uploadCode); copied = true; } catch { /* upload already succeeded */ }
                            setLocalLogUploadMessage(t(copied ? 'settings.localLogs.uploadCopied' : 'settings.localLogs.uploadSucceeded', { code: result.uploadCode }));
                          } else setLocalLogUploadMessage(t(`settings.localLogs.uploadResult.${result.kind}`));
                        })
                      }
                    />,
                  ...(DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED
                    ? [
                        <ActionInfoRow
                          accessibilityLabel={t('settings.devServerEnvironment.accessibility')}
                          detail={t('settings.devServerEnvironment.description')}
                          key="dev-server-environment"
                          label={t('settings.devServerEnvironment.title')}
                          onPress={confirmDevServerEnvironmentSwitch}
                          testID="settings.devServerEnvironment"
                          value={
                            devServerEnvironmentBusy
                              ? t('settings.devServerEnvironment.switching')
                              : t(
                                  `settings.devServerEnvironment.options.${devServerEnvironment}`,
                                )
                          }
                        />,
                      ]
                    : []),
                  ...debugSection.rows.map((row) => (
                    row.copyValue ? (
                      <CopyRow copied={copiedRowId === row.id} key={row.id} onCopy={copyRow} row={row} />
                    ) : (
                      <InfoRow key={row.id} detail={row.detail} label={row.label} testID={`settings.row.${row.id}`} value={row.value} />
                    )
                  )),
                  <SettingsSwitchRow
                    accessibilityLabel={t('settings.betaChannel.title')}
                    disabled={betaBusy || !betaReady}
                    hint={t('settings.betaChannel.description')}
                    key="beta-channel-toggle"
                    label={t('settings.betaChannel.title')}
                    onValueChange={() => void toggleBeta()}
                    switchTestID="settings.betaChannelToggle"
                    testID="settings.betaChannelToggleRow"
                    value={betaEnabled}
                  />,
                  // 技术版本细节:当前运行的热更 bundle(从版本卡片移到这里)。
                  <InfoRow
                    key="ota-version"
                    label={t('settings.updateInfo.otaVersion')}
                    testID="settings.otaVersion"
                    value={otaVersion}
                  />,
                  ...updateInfoRows.map((row) => (
                    <InfoRow key={row.id} label={row.label} testID={`settings.updateInfo.${row.id}`} value={row.value} />
                  )),
                ]
                : null}
            </SettingsGroup>
          ) : null}

          {/* 法律信息:隐私政策/用户协议始终显示(链接区域分流走 legalLinks 单点);
              使用统计开关与它们同组(合规要求关闭途径可被找到);
              App 备案号仅国内版显示。 */}
          <SettingsGroup title={t('settings.legal.sectionTitle')}>
            <SettingsSwitchRow
              accessibilityLabel={t('settings.legal.analytics')}
              disabled={analyticsBusy || !analyticsReady}
              hint={t('settings.legal.analyticsHint')}
              key="analytics-toggle"
              label={t('settings.legal.analytics')}
              messages={[analyticsMessage ? { text: analyticsMessage, testID: 'settings.analyticsMessage' } : null]}
              onValueChange={() => void toggleAnalytics()}
              switchTestID="settings.analyticsToggle"
              testID="settings.analyticsToggleRow"
              value={analyticsEnabled}
            />
            {analyticsCustomized ? (
              <ActionInfoRow
                accessibilityLabel={t('settings.legal.analyticsReset')}
                key="analytics-reset"
                label={t('settings.legal.analyticsReset')}
                onPress={() => void resetAnalytics()}
                testID="settings.analyticsReset"
                value={t('settings.legal.analyticsResetAction')}
              />
            ) : null}
            <ActionInfoRow
              accessibilityLabel={t('settings.legal.openPrivacyPolicy')}
              accessibilityRole="link"
              key="privacy-policy"
              label={t('settings.legal.privacyPolicy')}
              onPress={openPrivacyPolicy}
              testID="settings.privacyPolicy"
              value={t('settings.legal.view')}
            />
            <ActionInfoRow
              accessibilityLabel={t('settings.legal.openUserAgreement')}
              accessibilityRole="link"
              key="user-agreement"
              label={t('settings.legal.userAgreement')}
              onPress={openUserAgreement}
              testID="settings.userAgreement"
              value={t('settings.legal.view')}
            />
            {AUTH_REGION === 'cn' ? (
              <InfoRow
                key="app-filing-number"
                label={t('settings.legal.appFilingNumber')}
                testID="settings.appFilingNumber"
                value="沪ICP备11033765号-89A"
              />
            ) : null}
          </SettingsGroup>

          {/* 账号操作:退出保持明确(先确认);注销账号仅保留低调的次要文字入口。 */}
          <DisclosureItem style={styles.dangerArea} testID="settings.accountActions">
            <Text style={styles.dangerHint}>
              {t('settings.account.logoutHint')}
            </Text>
            <MainWindowActionGroup
              dangerActions={[
                {
                  accessibilityLabel: loggingOut ? t('settings.account.loggingOutAccessibility') : t('settings.account.logout'),
                  busy: loggingOut,
                  label: t('settings.account.logout'),
                  onPress: requestLogout,
                  testID: 'settings.logoutButton',
                  tone: 'danger',
                },
              ]}
              testID="settings.logoutActions"
            />
            {accountDeletionAvailable ? (
              <Pressable
                accessibilityLabel={loginText('accountDeletionSettingsAction')}
                accessibilityRole="button"
                onPress={openAccountDeletion}
                style={({ pressed }) => [
                  styles.accountDeletionLink,
                  pressed && styles.pressed,
                ]}
                testID="settings.deleteAccountButton"
              >
                <Text style={styles.accountDeletionLinkText}>
                  {loginText('accountDeletionSettingsAction')}
                </Text>
              </Pressable>
            ) : null}
          </DisclosureItem>
        </ListDisclosureScope>
      </ScrollView>
      <SheetModal
        backdropTestID="settings.appearancePicker.backdrop"
        nativePresentation
        onBackdropPress={() => setAppearancePickerOpen(false)}
        onRequestClose={() => setAppearancePickerOpen(false)}
        visible={appearancePickerOpen}
      >
        <SheetSurface
          bottomInset={safeAreaInsets.bottom}
          heights={choicePickerHeights}
          onClose={() => setAppearancePickerOpen(false)}
          onSnapChange={setAppearancePickerSnap}
          snap={appearancePickerSnap}
          testID="settings.appearancePicker"
          title={t('settings.appearance.modeLabel')}
        >
          <MobileChoicePickerList
            activeId={themePreference}
            onSelect={selectAppearance}
            options={appearancePickerOptions}
            testID="settings.appearancePicker.option"
          />
        </SheetSurface>
      </SheetModal>
      <SheetModal
        backdropTestID="settings.languagePicker.backdrop"
        nativePresentation
        onBackdropPress={() => setLanguagePickerOpen(false)}
        onRequestClose={() => setLanguagePickerOpen(false)}
        visible={languagePickerOpen}
      >
        <SheetSurface
          bottomInset={safeAreaInsets.bottom}
          heights={choicePickerHeights}
          onClose={() => setLanguagePickerOpen(false)}
          onSnapChange={setLanguagePickerSnap}
          snap={languagePickerSnap}
          testID="settings.languagePicker"
          title={t('settings.language.title')}
        >
          <MobileChoicePickerList
            activeId={locale}
            onSelect={selectLanguage}
            options={languagePickerOptions}
            testID="settings.languagePicker.option"
          />
        </SheetSurface>
      </SheetModal>
    </SafeAreaView>
  );
}

/** 可复制行(长 ID / URL):标签 + 值堆叠在左,复制按钮在右。 */
function CopyRow({
  copied,
  onCopy,
  row,
}: {
  copied: boolean;
  onCopy(row: MobileSettingsRow): void;
  row: MobileSettingsRow;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <View style={styles.copyRow} testID={`settings.row.${row.id}`}>
      <View style={styles.copyText}>
        <Text style={styles.copyLabel}>{row.label}</Text>
        <Text selectable style={styles.copyValue} numberOfLines={2}>{row.value}</Text>
      </View>
      {row.copyValue ? (
        // 自守卫:没有 copyValue 就不渲染复制按钮,避免出现"按了没反应"的死按钮
        // (调用方虽已先判断,但组件自身也要自洽)。
        <MainWindowActionButton
          action={{
            accessibilityLabel: t('settings.copyRow.accessibility', { label: row.label }),
            label: copied ? t('settings.copyRow.done') : t('settings.copyRow.action'),
            onPress: () => onCopy(row),
            testID: `settings.copy.${row.id}`,
          }}
          density="compact"
          style={styles.copyButton}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: {
    gap: spacing.xl,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  // —— 账号头部 ——
  headerCard: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  headerTexts: { flex: 1, gap: spacing.xs, minWidth: 0 },
  headerName: { color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold },
  headerEmail: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  headerStatusRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  headerStatusText: { color: colors.textSecondary, flex: 1, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, minWidth: 0 },
  localLogOptions: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  // —— 版本行 ——
  versionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  versionTexts: { flex: 1, gap: spacing.xs, minWidth: 0 },
  versionValueRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  versionLabel: { color: colors.textPrimary, flexShrink: 1, fontSize: typeScale.body, fontWeight: fontWeight.medium, lineHeight: lineHeight.body },
  versionDetail: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  betaChannelBadge: {
    backgroundColor: colors.betaChannelBadgeBackground,
    borderRadius: radius.pill,
    flexShrink: 0,
    paddingHorizontal: spacing.sm,
  },
  betaChannelBadgeText: {
    color: colors.betaChannelBadgeForeground,
    fontSize: typeScale.micro,
    lineHeight: lineHeight.micro,
    fontWeight: fontWeight.semibold,
  },
  versionButton: { flexShrink: 0 },
  // —— 可复制行 ——
  copyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  copyText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  copyLabel: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  copyValue: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  copyButton: { flexShrink: 0, minWidth: 60 },
  // —— 退出 ——
  dangerArea: { gap: spacing.md, paddingTop: spacing.sm },
  dangerHint: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, paddingHorizontal: spacing.md },
  accountDeletionLink: {
    alignItems: 'center',
    alignSelf: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  accountDeletionLinkText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
  pressed: mobileInteractionStyles.pressed,
});
