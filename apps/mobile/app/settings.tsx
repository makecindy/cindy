import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import { useRouter } from 'expo-router';
import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  DevSettings,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@cindy/device-link';
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
import { configureCollapseAnimation } from '@/utils/collapseAnimation';
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  StatusDot,
} from '@/components/MobilePrimitives';
import {
  NativePullDownMenu,
  NativeSwitch,
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
  usesNativePullDownMenu,
} from '@/platform/chrome';
import {
  APP_BINARY_VERSION,
  AUTH_API_BASE_URL,
  AUTH_REGION,
  DESKTOP_PACKAGE_VERSION,
  DEVICE_LINK_API_BASE_URL,
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
  refreshMobileVoiceDictionary,
  subscribeMobileVoiceDictionaryCache,
} from '@/session/mobileVoiceDictionaryCache';
import {
  buildMobileVoiceDictionaryEntryViews,
  collectMobileVoiceDictionaryHosts,
  patchMobileVoiceDictionaryHosts,
  type MobileVoiceDictionaryEntryView,
  type MobileVoiceDictionaryHost,
} from '@/session/mobileVoiceDictionaryView';
import { DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL } from '@cindy/maker-shared/device-link-contract';
import type { MobileVoiceDictionarySnapshotResult } from '@cindy/maker-shared/device-link-contract';
import { buildMobileUpdateInfoRows, currentMobileOtaVersion } from '@/settings/updateInfo';
import { shouldCheckBundleUpdate } from '@/update/bundleUpdate';
import {
  manualUpdateCheckMessage,
  runManualUpdateCheck,
  type ManualUpdateCheckOutcome,
} from '@/update/manualUpdateCheck';
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useUpdateChannelGate } from '@/update/useUpdateChannelGate';
import { useBetaChannel } from '@/update/useBetaChannel';
import { probeBetaChannel } from '@/update/fetchLatestRelease';
import { MobileChoicePickerList } from '@/session/MobileChoicePickerList';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import type { MobileChoiceOption } from '@/session/agentCapabilities';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'uptodate' | 'error';
type SelfDeviceNameSaveOptions = { acceptClosedDraft?: boolean };
type SelfDeviceNameQueuedWrite =
  | { kind: 'rename'; name: string; options: SelfDeviceNameSaveOptions }
  | { kind: 'reset' };
const SETTINGS_DEVICE_TIMEOUT_MS = 12_000;
// 显示语言选项:「跟随系统」在前,英语作为第一个显式语言,其余语言按支持列表顺序排列。
const LANGUAGE_OPTIONS: readonly LocalePreference[] = [
  'system',
  'en',
  ...SUPPORTED_LOCALES.filter((locale) => locale !== 'en'),
];

export default function SettingsScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const auth = useAuth();
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const windowDimensions = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const { lastPresenceSnapshot, status, invoke } = useDeviceLink();
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountDeletionAvailable, setAccountDeletionAvailable] =
    useState(false);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [languagePickerSnap, setLanguagePickerSnap] = useState<ContextSheetSnap>('half');
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
  // 语音词典:手机只读展示被控桌面的词典快照(正本在桌面,手机不参与合并)。
  const [dictionaryScreenOpen, setDictionaryScreenOpen] = useState(false);
  const [desktopDevices, setDesktopDevices] = useState<readonly MobileVoiceDictionaryHost[]>([]);
  const [dictionaryRefreshing, setDictionaryRefreshing] = useState(false);
  /** 缓存在模块里,组件用这个计数强制重渲染(每次刷新完成 +1)。 */
  const [dictionaryRevision, setDictionaryRevision] = useState(0);
  const [selfDeviceName, setSelfDeviceName] = useState<string | null>(null);
  const [selfDeviceNameDraft, setSelfDeviceNameDraft] = useState('');
  const [selfDeviceNameEditing, setSelfDeviceNameEditing] = useState(false);
  const [selfDeviceNameSaving, setSelfDeviceNameSaving] = useState(false);
  const [selfDeviceNameMessage, setSelfDeviceNameMessage] = useState<string | null>(null);
  const selfDeviceNameDraftRef = useRef('');
  const selfDeviceNameSaveSeqRef = useRef(0);
  const selfDeviceNameWriteInFlightRef = useRef(false);
  const selfDeviceNameCurrentWriteRef = useRef<SelfDeviceNameQueuedWrite | null>(null);
  const selfDeviceNameQueuedWriteRef = useRef<SelfDeviceNameQueuedWrite | null>(null);
  const selfDeviceNameRunQueuedWriteRef = useRef<() => void>(() => {});

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
  const bundleCheckEnabled = shouldCheckBundleUpdate({
    isSelfHosted: IS_OTA_SELFHOST,
    isReviewMode: REVIEW_MODE,
    isTestFlightBuild: IS_TESTFLIGHT_BUILD,
  });
  const updateCheckEnabled = bundleCheckEnabled || updatesEnabled;
  // 保存未翻译的结果，语言切换触发重渲染时用当前 t() 重新生成提示。
  const updateMessage = useMemo(
    () => updateOutcome && manualUpdateCheckMessage(updateOutcome, {
      isTestFlightBuild: IS_TESTFLIGHT_BUILD,
      t,
    }),
    [t, updateOutcome],
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
  const languagePickerHeights = useMemo(
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

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.deviceId) {
      setSelfDeviceName(null);
      // 登出/未登录才清空电脑列表 —— 拉取失败不清(见下面 catch 的说明)。
      setDesktopDevices([]);
      return;
    }

    let cancelled = false;
    void auth.apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
    })
      .then((res) => {
        if (cancelled) return;
        const self = res.devices.find((device) => device.deviceId === auth.deviceId);
        setSelfDeviceName(self?.name?.trim() || null);
        // 同一份设备清单顺带筛出电脑:词典正本在电脑上,手机按电脑分别展示。
        setDesktopDevices(collectMobileVoiceDictionaryHosts(res.devices));
      })
      .catch(() => {
        if (cancelled) return;
        setSelfDeviceName(null);
        // 电脑列表刻意不清空:这只是一次拉取失败(断网、超时),不代表用户没有电脑。
        // 清掉的话词典页会显示成「还没有电脑」,连带 hydrate/refresh 也没有 host 可
        // 跑 —— 明明本地还有一份可用的离线缓存。真正该清空的时机是登出。
      });

    return () => {
      cancelled = true;
    };
  }, [auth]);

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
        // OTA 检查会携带 eas-client-id,须经隐私同意闸门(企业 SSO 豁免协议门,可能未
        // 同意;且检查进行中登出会撤销同意)。整包 /latest 为匿名请求,不在此列。动态
        // 判定而非调用瞬间快照,manifest 请求前与资源下载前各问一次。
        isConsented: hasPrivacyConsent,
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
    updateCheckEnabled,
    updatesEnabled,
  ]);

  const updateSelfDeviceNameDraft = useCallback((value: string) => {
    selfDeviceNameDraftRef.current = value;
    setSelfDeviceNameMessage(null);
    setSelfDeviceNameDraft(value);
  }, []);

  const saveSelfDeviceNameDraft = useCallback(async (rawName: string, options: SelfDeviceNameSaveOptions = {}) => {
    const name = rawName.trim();
    if (name.length === 0) {
      setSelfDeviceNameMessage(t('settings.deviceNameEditor.emptyError'));
      return;
    }
    if (!auth.deviceId) {
      setSelfDeviceNameMessage(t('settings.deviceNameEditor.deviceInitializing'));
      return;
    }
    if (selfDeviceNameWriteInFlightRef.current) {
      if (
        name === systemDeviceName.trim() &&
        (selfDeviceNameCurrentWriteRef.current?.kind === 'reset' ||
          selfDeviceNameQueuedWriteRef.current?.kind === 'reset')
      ) {
        return;
      }
      if (
        selfDeviceNameCurrentWriteRef.current?.kind === 'rename' &&
        selfDeviceNameCurrentWriteRef.current.name === name
      ) {
        return;
      }
      selfDeviceNameQueuedWriteRef.current = { kind: 'rename', name, options };
      setSelfDeviceNameMessage(t('settings.deviceNameEditor.saving'));
      return;
    }
    if (name === deviceName.trim()) {
      setSelfDeviceNameMessage(null);
      return;
    }

    const seq = selfDeviceNameSaveSeqRef.current + 1;
    selfDeviceNameSaveSeqRef.current = seq;
    selfDeviceNameWriteInFlightRef.current = true;
    selfDeviceNameCurrentWriteRef.current = { kind: 'rename', name, options };
    setSelfDeviceNameSaving(true);
    setSelfDeviceNameMessage(t('settings.deviceNameEditor.saving'));
    try {
      const res = await auth.apiFetch<{ deviceId: string; name: string }>(
        `/api/device-link/devices/${encodeURIComponent(auth.deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          body: { name },
          method: 'PATCH',
          timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
        },
      );
      const draftStillCurrent = options.acceptClosedDraft === true || selfDeviceNameDraftRef.current.trim() === name;
      if (selfDeviceNameSaveSeqRef.current === seq && draftStillCurrent) {
        setSelfDeviceName(res.name);
        setSelfDeviceNameMessage(t('settings.deviceNameEditor.saved'));
      }
    } catch (err) {
      if (selfDeviceNameSaveSeqRef.current === seq) setSelfDeviceNameMessage(formatRemoteError(err));
    } finally {
      if (selfDeviceNameSaveSeqRef.current === seq) {
        selfDeviceNameWriteInFlightRef.current = false;
        selfDeviceNameCurrentWriteRef.current = null;
        setSelfDeviceNameSaving(false);
        selfDeviceNameRunQueuedWriteRef.current();
      }
    }
  }, [auth, deviceName, systemDeviceName, t]);

  const resetSelfDeviceName = useCallback(async () => {
    if (!auth.deviceId) {
      setSelfDeviceNameMessage(t('settings.deviceNameEditor.deviceInitializing'));
      return;
    }
    if (selfDeviceNameWriteInFlightRef.current) {
      selfDeviceNameQueuedWriteRef.current = { kind: 'reset' };
      setSelfDeviceNameMessage(t('settings.deviceNameEditor.restoringDefault'));
      return;
    }

    const seq = selfDeviceNameSaveSeqRef.current + 1;
    selfDeviceNameSaveSeqRef.current = seq;
    selfDeviceNameWriteInFlightRef.current = true;
    selfDeviceNameCurrentWriteRef.current = { kind: 'reset' };
    setSelfDeviceNameSaving(true);
    setSelfDeviceNameMessage(t('settings.deviceNameEditor.restoringDefault'));
    try {
      const res = await auth.apiFetch<{ deviceId: string; name: string; manualName?: string | null }>(
        `/api/device-link/devices/${encodeURIComponent(auth.deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          body: { name: null },
          method: 'PATCH',
          timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
        },
      );
      if (selfDeviceNameSaveSeqRef.current === seq) {
        setSelfDeviceName(res.name);
        updateSelfDeviceNameDraft(res.name);
        setSelfDeviceNameMessage(t('settings.deviceNameEditor.restoredDefault'));
      }
    } catch (err) {
      if (selfDeviceNameSaveSeqRef.current === seq) setSelfDeviceNameMessage(formatRemoteError(err));
    } finally {
      if (selfDeviceNameSaveSeqRef.current === seq) {
        selfDeviceNameWriteInFlightRef.current = false;
        selfDeviceNameCurrentWriteRef.current = null;
        setSelfDeviceNameSaving(false);
        selfDeviceNameRunQueuedWriteRef.current();
      }
    }
  }, [auth, t, updateSelfDeviceNameDraft]);

  selfDeviceNameRunQueuedWriteRef.current = () => {
    const queued = selfDeviceNameQueuedWriteRef.current;
    if (!queued) return;
    selfDeviceNameQueuedWriteRef.current = null;
    if (queued.kind === 'reset') {
      void resetSelfDeviceName();
      return;
    }
    void saveSelfDeviceNameDraft(queued.name, queued.options);
  };

  useEffect(() => {
    if (!selfDeviceNameEditing) return;
    const name = selfDeviceNameDraft.trim();
    if (name.length === 0) {
      setSelfDeviceNameMessage(t('settings.deviceNameEditor.emptyError'));
      return;
    }
    if (name === deviceName.trim()) {
      return;
    }
    if (selfDeviceNameSaving) return;
    const timer = setTimeout(() => {
      void saveSelfDeviceNameDraft(name);
    }, 650);
    return () => clearTimeout(timer);
  }, [deviceName, saveSelfDeviceNameDraft, selfDeviceNameDraft, selfDeviceNameEditing, selfDeviceNameSaving, t]);

  const openSelfDeviceNameEditor = useCallback(() => {
    updateSelfDeviceNameDraft(deviceName);
    setSelfDeviceNameMessage(null);
    setSelfDeviceNameEditing(true);
  }, [deviceName, updateSelfDeviceNameDraft]);

  const closeSelfDeviceNameEditor = useCallback(() => {
    const name = selfDeviceNameDraftRef.current.trim();
    if (name.length === 0) {
      updateSelfDeviceNameDraft(deviceName);
      setSelfDeviceNameMessage(null);
      setSelfDeviceNameEditing(false);
      return;
    }
    if (name !== deviceName.trim()) {
      void saveSelfDeviceNameDraft(name, { acceptClosedDraft: true });
    }
    setSelfDeviceNameEditing(false);
  }, [deviceName, saveSelfDeviceNameDraft, updateSelfDeviceNameDraft]);

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

  const toggleDebug = useCallback(() => {
    configureCollapseAnimation();
    setDebugExpanded((value) => !value);
  }, []);

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

  // REST 设备清单是「打开设置页那一刻」的快照,之后电脑上线/下线不会反映进来。
  // 设置页可能开着很久,不跟 presence 的话:某台电脑上线了,这里仍认为全部离线,
  // 刷新按钮直接 return,用户只能退出重进才能拉词典。
  useEffect(() => {
    if (!lastPresenceSnapshot) return;
    setDesktopDevices((current) => patchMobileVoiceDictionaryHosts(current, lastPresenceSnapshot));
  }, [lastPresenceSnapshot]);

  /**
   * 向所有在线电脑各拉一次词典快照。
   *
   * 它们本来就该收敛到同一份内容,拉多台只是为了容错(某台是旧版本、某台正好断线)。
   * 失败一律静默:电脑离线、没开「允许被控」、老版本不认识这个 channel 都是常态,
   * 页面继续显示上次缓存,不弹错。
   */
  const refreshVoiceDictionary = useCallback(() => {
    const online = desktopDevices.filter((host) => host.online);
    if (online.length === 0) return;
    setDictionaryRefreshing(true);
    void Promise.all(
      online.map((host) => refreshMobileVoiceDictionary(
        host.deviceId,
        () => invoke<MobileVoiceDictionarySnapshotResult>(
          host.deviceId,
          DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL,
          [],
        ),
        { force: true },
      )),
    ).finally(() => {
      setDictionaryRefreshing(false);
      // 缓存写在模块里,组件靠这个计数触发重渲染。
      setDictionaryRevision((value) => value + 1);
    });
  }, [desktopDevices, invoke]);

  // 页面打开后再由 effect 读取缓存和刷新。设备清单本身是异步 REST 请求，不能只
  // 捕获点击瞬间的 desktopDevices=[]，否则清单稍后到达时历史缓存永远不会 hydrate。
  const openVoiceDictionary = useCallback(() => {
    setDictionaryScreenOpen(true);
  }, []);

  useEffect(() => {
    if (!dictionaryScreenOpen || desktopDevices.length === 0) return;
    let cancelled = false;
    // 进页面先把盘上缓存读进内存(离线也有内容可看),再拉一次最新的。这个 effect
    // 同时依赖 desktopDevices，因此设备清单在页面打开后才到达时也会走同一条路径。
    void Promise.all(desktopDevices.map((host) => hydrateMobileVoiceDictionary(host.deviceId)))
      .then(() => {
        if (!cancelled) setDictionaryRevision((value) => value + 1);
      })
      .catch(() => undefined);
    refreshVoiceDictionary();
    return () => {
      cancelled = true;
    };
  }, [desktopDevices, dictionaryScreenOpen, refreshVoiceDictionary]);

  useEffect(() => {
    if (!dictionaryScreenOpen) return;
    return subscribeMobileVoiceDictionaryCache(() => {
      setDictionaryRevision((value) => value + 1);
    });
  }, [dictionaryScreenOpen]);

  // dictionaryRevision 只作为依赖存在:缓存是模块级的,刷新完成后靠它触发重算。
  const dictionaryEntries = useMemo(
    () =>
      buildMobileVoiceDictionaryEntryViews(
        desktopDevices.map((host) => readCachedMobileVoiceDictionarySnapshot(host.deviceId)),
      ),
    [desktopDevices, dictionaryRevision],
  );

  const dictionaryStatus = desktopDevices.length === 0
    ? 'no-desktops'
    : desktopDevices.some((host) => host.online)
      ? 'ready'
      : 'all-offline';

  const avatarLabel = (overview.header.name.trim()[0] ?? '?').toUpperCase();
  const updateBusy = updatePhase === 'checking' || updatePhase === 'downloading';
  const updateButtonLabel = updatePhase === 'checking' ? t('settings.version.checking')
    : updatePhase === 'downloading' ? t('settings.version.updating')
    : t(
      IS_TESTFLIGHT_BUILD
        ? 'settings.version.testFlightCheckAction'
        : 'settings.version.checkAction',
    );

  if (dictionaryScreenOpen) {
    return (
      <VoiceDictionaryScreen
        entries={dictionaryEntries}
        onBack={() => setDictionaryScreenOpen(false)}
        onRefresh={refreshVoiceDictionary}
        refreshing={dictionaryRefreshing}
        status={dictionaryStatus}
      />
    );
  }

  if (selfDeviceNameEditing) {
    return (
      <RenameSelfDeviceScreen
        draft={selfDeviceNameDraft}
        message={selfDeviceNameMessage}
        onChangeDraft={updateSelfDeviceNameDraft}
        onDone={closeSelfDeviceNameEditor}
        onResetDefault={resetSelfDeviceName}
      />
    );
  }

  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.screen">
      <SimpleStackHeader
        backTestID="settings.backButton"
        onBack={() => goBackGuarded(router)}
        title={t('settings.title')}
        titleTestID="settings.title"
      />

      <ScrollView contentContainerStyle={styles.content} testID="settings.scroll">
        {/* 账号头部:身份 + 连接状态一次性呈现,下面分组不再重复 */}
        <View style={styles.headerCard} testID="settings.accountHeader">
          <View style={styles.avatar}>
            {auth.user?.avatar ? (
              <Image source={{ uri: auth.user.avatar }} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>{avatarLabel}</Text>
            )}
          </View>
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
                <Text style={styles.rowLabel}>{t('settings.version.currentLabel')}</Text>
                <View style={styles.versionValueRow}>
                  <Text style={styles.versionValue} numberOfLines={1}>{t('settings.version.bundleVersion', { version: appVersion })}</Text>
                  {showBetaBadge ? (
                    <View style={styles.betaChannelBadge} testID="settings.betaChannelBadge">
                      <Text style={styles.betaChannelBadgeText}>{t('settings.betaChannel.badge')}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.rowDetail} numberOfLines={1} testID="settings.otaVersion">{t('settings.version.otaVersion', { version: otaVersion })}</Text>
                {/* 二级版本号:自建线打包所配对的桌面产品线版本(0.0.x),不是在线电脑的实时版本;仅自建线且已注入时显示 */}
                {IS_OTA_SELFHOST && DESKTOP_PACKAGE_VERSION ? (
                  <Text style={styles.rowDetail} numberOfLines={1} testID="settings.desktopVersion">{t('settings.version.pairedDesktopVersion', { version: DESKTOP_PACKAGE_VERSION })}</Text>
                ) : null}
                {IS_TESTFLIGHT_BUILD ? (
                  <Text style={styles.rowDetail} numberOfLines={2} testID="settings.testFlightUpdateHint">
                    {t('settings.version.testFlightUpdateManaged')}
                  </Text>
                ) : null}
                {updateMessage ? (
                  <Text style={styles.rowDetail} numberOfLines={2} testID="settings.updateMessage">{updateMessage}</Text>
                ) : !REVIEW_MODE && !updatesEnabled ? (
                  <Text style={styles.rowDetail} numberOfLines={2}>
                    {t(
                      IS_TESTFLIGHT_BUILD
                        ? 'settings.version.testFlightContentUpdateUnavailable'
                        : 'settings.version.devNoOta',
                    )}
                  </Text>
                ) : null}
              </View>
              {/* 审核模式(清单 review 命中当前二进制版本):隐藏检查更新入口,版本号照常展示 */}
              {!REVIEW_MODE ? (
                <MainWindowActionButton
                  action={{
                    accessibilityLabel: updateBusy
                      ? t(
                        IS_TESTFLIGHT_BUILD
                          ? 'settings.version.testFlightCheckingAccessibility'
                          : 'settings.version.checkingAccessibility',
                      )
                      : t(
                        IS_TESTFLIGHT_BUILD
                          ? 'settings.version.testFlightCheckAction'
                          : 'settings.version.checkAction',
                      ),
                    busy: updateBusy,
                    disabled: !updateCheckEnabled,
                    label: updateButtonLabel,
                    onPress: () => void checkForUpdate(),
                    testID: 'settings.checkUpdateButton',
                    tone: 'primary',
                  }}
                  density="compact"
                  style={styles.versionButton}
                />
              ) : null}
            </View>,
          ]}
        </SettingsGroup>

        {/* 通知:任务完成推送(仅 iOS;Android 待 FCM/厂商通道) */}
        {isPushSupported() ? (
          <SettingsGroup title={t('settings.notifications.sectionTitle')}>
            {[
              <View key="push-toggle" style={styles.switchRow} testID="settings.pushToggleRow">
                <View style={styles.switchTexts}>
                  <Text style={styles.rowLabel}>{t('settings.notifications.taskDone')}</Text>
                  <Text style={styles.hint}>
                    {t('settings.notifications.taskDoneHint')}
                  </Text>
                  {pushMessage ? (
                    <Text style={styles.hint} testID="settings.pushMessage">{pushMessage}</Text>
                  ) : null}
                </View>
                <NativeSwitch
                  accessibilityLabel={t('settings.notifications.taskDone')}
                  disabled={pushBusy}
                  onValueChange={() => void togglePushNotifications()}
                  seedColor={colors.inputCaret}
                  testID="settings.pushToggle"
                  value={pushEnabled}
                />
              </View>,
            ]}
          </SettingsGroup>
        ) : null}

        {/* 语音词典:只读查看电脑上的词典(正本在电脑,增删改回电脑做) */}
        <SettingsGroup
          footer={t('settings.voiceDictionary.hint')}
          title={t('settings.voiceDictionary.sectionTitle')}
        >
          {[
            <ActionInfoRow
              accessibilityLabel={t('settings.voiceDictionary.openAccessibility')}
              key="voice-dictionary"
              label={t('settings.voiceDictionary.label')}
              onPress={openVoiceDictionary}
              testID="settings.voiceDictionary.row"
              value={t('settings.voiceDictionary.entryCount', { count: dictionaryEntries.length })}
            />,
          ]}
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
            <LanguagePickerRow
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
                  detail={selfDeviceNameMessage ?? row.detail}
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

        {/* 调试 / 开发者:默认折叠 */}
        {debugSection ? (
          <SettingsGroup
            onToggle={toggleDebug}
            title={debugSection.title}
            titleAccessory={groupChevron(debugExpanded, colors)}
          >
            {debugExpanded
              ? [
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
                <View key="beta-channel-toggle" style={styles.switchRow} testID="settings.betaChannelToggleRow">
                  <View style={styles.switchTexts}>
                    <Text style={styles.rowLabel}>{t('settings.betaChannel.title')}</Text>
                    <Text style={styles.hint}>{t('settings.betaChannel.description')}</Text>
                  </View>
                  <NativeSwitch
                    accessibilityLabel={t('settings.betaChannel.title')}
                    disabled={betaBusy || !betaReady}
                    onValueChange={() => void toggleBeta()}
                    seedColor={colors.inputCaret}
                    testID="settings.betaChannelToggle"
                    value={betaEnabled}
                  />
                </View>,
                ...updateInfoRows.map((row) => (
                  <InfoRow key={row.id} label={row.label} testID={`settings.updateInfo.${row.id}`} value={row.value} />
                )),
              ]
              : []}
          </SettingsGroup>
        ) : null}

        {/* 法律信息:隐私政策/用户协议始终显示(链接区域分流走 legalLinks 单点);
            使用统计开关与它们同组(合规要求关闭途径可被找到);
            App 备案号仅国内版显示。 */}
        <SettingsGroup title={t('settings.legal.sectionTitle')}>
          <View key="analytics-toggle" style={styles.switchRow} testID="settings.analyticsToggleRow">
            <View style={styles.switchTexts}>
              <Text style={styles.rowLabel}>{t('settings.legal.analytics')}</Text>
              <Text style={styles.hint}>{t('settings.legal.analyticsHint')}</Text>
              {analyticsMessage ? (
                <Text style={styles.hint} testID="settings.analyticsMessage">{analyticsMessage}</Text>
              ) : null}
            </View>
            <NativeSwitch
              accessibilityLabel={t('settings.legal.analytics')}
              disabled={analyticsBusy || !analyticsReady}
              onValueChange={() => void toggleAnalytics()}
              seedColor={colors.inputCaret}
              testID="settings.analyticsToggle"
              value={analyticsEnabled}
            />
          </View>
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

        {/* 账号操作:退出保持明确；注销账号仅保留低调的次要文字入口。 */}
        <View style={styles.dangerArea} testID="settings.accountActions">
          <Text style={styles.dangerHint}>
            {t('settings.account.logoutHint')}
          </Text>
          <MainWindowActionGroup
            dangerActions={[
              {
                accessibilityLabel: loggingOut ? t('settings.account.loggingOutAccessibility') : t('settings.account.logout'),
                busy: loggingOut,
                disabled: loggingOut,
                label: loggingOut ? t('settings.account.loggingOut') : t('settings.account.logout'),
                onPress: () => void logout(),
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
        </View>
      </ScrollView>
      <SheetModal
        backdropTestID="settings.languagePicker.backdrop"
        onBackdropPress={() => setLanguagePickerOpen(false)}
        onRequestClose={() => setLanguagePickerOpen(false)}
        visible={languagePickerOpen}
      >
        <SheetSurface
          bottomInset={safeAreaInsets.bottom}
          heights={languagePickerHeights}
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

/** 可折叠分组标题右侧的展开/收起指示箭头。 */
function groupChevron(expanded: boolean, colors: ThemeColors): ReactNode {
  return expanded
    ? <ChevronDown color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
    : <ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />;
}

/**
 * iOS 风格分组:组标题在外侧 gutter,组内一块统一卡片,行间用 inset 分隔线。
 * 标题可点(onToggle)时承担折叠开关。rows 为空则不渲染卡片(折叠态)。
 * footer 为卡片下方 gutter 里的弱说明文字(iOS 分组 footer 惯例)。
 */
function SettingsGroup({
  children,
  footer,
  onToggle,
  title,
  titleAccessory,
}: {
  children: ReactNode;
  footer?: string;
  onToggle?: () => void;
  title: string;
  titleAccessory?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  // Children.toArray 会丢弃 null/false 并给每个 child 赋稳定 key(沿用元素自身 key),
  // 比 key={index} 更稳:后续插入/重排调试行时不会让无关行 remount。
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          onPress={onToggle}
          style={({ pressed }) => [styles.groupTitleRow, pressed && styles.pressed]}
        >
          <Text style={styles.groupTitle}>{title}</Text>
          {titleAccessory}
        </Pressable>
      ) : (
        <View style={styles.groupTitleRow}>
          <Text style={styles.groupTitle}>{title}</Text>
          {titleAccessory}
        </View>
      )}
      {rows.length > 0 ? (
        <View style={styles.card}>
          {rows.map((row, index) => (
            <Fragment key={isValidElement(row) && row.key != null ? row.key : index}>
              {index > 0 ? <View style={styles.divider} /> : null}
              {row}
            </Fragment>
          ))}
        </View>
      ) : null}
      {footer && rows.length > 0 ? (
        <Text style={styles.groupFooter}>{footer}</Text>
      ) : null}
    </View>
  );
}

/** 显示语言下拉入口:标签左、当前值右;选项在底部 sheet 中单选。 */
function LanguagePickerRow({
  expanded,
  label,
  onPress,
  testID,
  value,
}: {
  expanded: boolean;
  label: string;
  onPress(): void;
  testID?: string;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${label}: ${value}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
        <ChevronDown color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
    </Pressable>
  );
}

/** 单行信息:标签左、值右;可选 detail 另起一行(较弱)。 */
function InfoRow({
  detail,
  label,
  testID,
  value,
}: {
  detail?: string;
  label: string;
  testID?: string;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
      </View>
      {detail ? <Text style={styles.rowDetail} numberOfLines={2}>{detail}</Text> : null}
    </View>
  );
}

/** 可点击信息行:用于轻量编辑或打开外部信息。 */
function ActionInfoRow({
  accessibilityLabel,
  accessibilityRole = 'button',
  detail,
  label,
  onPress,
  testID,
  value,
}: {
  accessibilityLabel: string;
  accessibilityRole?: 'button' | 'link';
  detail?: string;
  label: string;
  onPress(): void;
  testID?: string;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
        <ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
      {detail ? <Text style={styles.rowDetail} numberOfLines={2}>{detail}</Text> : null}
    </Pressable>
  );
}

/**
 * 语音词典查看页(只读)。
 *
 * 词典对用户是**一份**:同账号下所有开启同步的电脑收敛到同一份内容,「这条词来自
 * 哪台电脑」是实现细节,不该出现在界面上 —— 同一台机器换名或重装就会多出一个分组,
 * 列表立刻没法看。所以这里把所有电脑的快照合并成单一列表。
 *
 * 正本在电脑上,手机只拉快照用于润色,因此没有任何编辑入口:增删改一律回电脑做,
 * 避免手机维护一份会分叉的副本。
 */
function VoiceDictionaryScreen({
  entries,
  onBack,
  onRefresh,
  refreshing,
  status,
}: {
  entries: readonly MobileVoiceDictionaryEntryView[];
  onBack(): void;
  onRefresh(): void;
  refreshing: boolean;
  status: 'ready' | 'no-desktops' | 'all-offline';
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const footer = status === 'no-desktops'
    ? t('settings.voiceDictionary.noDesktops')
    : status === 'all-offline'
      ? t('settings.voiceDictionary.offlineHint')
      : t('settings.voiceDictionary.readOnlyHint');

  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.voiceDictionary.screen">
      <SimpleStackHeader
        backTestID="settings.voiceDictionary.backButton"
        onBack={onBack}
        title={t('settings.voiceDictionary.screenTitle')}
      />
      {/*
        词典上限是 1000 条,用 ScrollView 会把每一行都实例化出来 —— 低端机上首屏卡顿
        且常驻内存。这里换成虚拟化列表,只挂载可见行;卡片视觉靠 header/item/footer
        三段样式拼出来(FlatList 没法在外面包一层带圆角的 View 还保持自身滚动)。
      */}
      <FlatList
        ListFooterComponent={
          <>
            <View style={styles.listCardBottom} />
            <Text style={styles.groupFooter}>{footer}</Text>
          </>
        }
        ListHeaderComponent={
          <>
            <View style={styles.groupTitleRow}>
              <Text style={styles.groupTitle}>{t('settings.voiceDictionary.sectionTitle')}</Text>
            </View>
            <View style={styles.listCardTop}>
              <Pressable
                accessibilityLabel={t('settings.voiceDictionary.refreshAccessibility')}
                accessibilityRole="button"
                onPress={onRefresh}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                testID="settings.voiceDictionary.refresh"
              >
                <View style={styles.rowLine}>
                  <Text style={styles.rowLabel}>
                    {t('settings.voiceDictionary.entryCount', { count: entries.length })}
                  </Text>
                  <Text style={styles.rowValue} numberOfLines={1}>
                    {refreshing
                      ? t('settings.voiceDictionary.refreshing')
                      : t('settings.voiceDictionary.refresh')}
                  </Text>
                </View>
              </Pressable>
            </View>
          </>
        }
        contentContainerStyle={styles.listContent}
        data={entries}
        keyExtractor={(entry) => entry.key}
        renderItem={({ item }) => (
          <View style={styles.listCardMiddle}>
            <View style={styles.divider} />
            <View style={styles.row} testID={`settings.voiceDictionary.entry.${item.key}`}>
              <View style={styles.rowLine}>
                <Text style={styles.rowLabel} numberOfLines={2}>{item.text}</Text>
              </View>
              {item.aliases.length > 0 ? (
                <Text style={styles.rowDetail} numberOfLines={2}>
                  {t('settings.voiceDictionary.aliases', {
                    aliases: item.aliases.join(t('settings.voiceDictionary.aliasSeparator')),
                  })}
                </Text>
              ) : null}
            </View>
          </View>
        )}
        testID="settings.voiceDictionary.scroll"
      />
    </SafeAreaView>
  );
}

function RenameSelfDeviceScreen({
  draft,
  message,
  onChangeDraft,
  onDone,
  onResetDefault,
}: {
  draft: string;
  message: string | null;
  onChangeDraft(value: string): void;
  onDone(): void;
  onResetDefault(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.renameSelfDevice.screen">
      <SimpleStackHeader
        backTestID="settings.renameSelfDevice.backButton"
        onBack={onDone}
        title={t('settings.deviceNameEditor.screenTitle')}
      />
      <View style={styles.nameEditorContent}>
        <View style={styles.nameEditorInputRow}>
          <TextInput
            autoFocus
            maxLength={64}
            onChangeText={onChangeDraft}
            onSubmitEditing={onDone}
            placeholder={t('settings.deviceNameEditor.placeholder')}
            placeholderTextColor={colors.textTertiary}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.nameEditorInput}
            testID="settings.renameSelfDevice.input"
            value={draft}
          />
          {draft.length > 0 ? (
            <Pressable
              accessibilityLabel={t('settings.deviceNameEditor.resetAccessibility')}
              accessibilityRole="button"
              hitSlop={8}
              onPress={onResetDefault}
              style={({ pressed }) => [styles.nameEditorClearButton, pressed && styles.pressed]}
              testID="settings.renameSelfDevice.clear"
            >
              <X color={colors.surfaceElevated} size={iconSize.sm} strokeWidth={iconStroke.bold} />
            </Pressable>
          ) : null}
        </View>
        {message ? <Text style={styles.nameEditorMessage} numberOfLines={2}>{message}</Text> : null}
      </View>
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
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 56,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 56,
  },
  avatarImage: { height: 56, width: 56 },
  avatarText: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.semibold },
  headerTexts: { flex: 1, gap: 3, minWidth: 0 },
  headerName: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.semibold },
  headerEmail: { color: colors.textSecondary, fontSize: typeScale.footnote },
  headerStatusRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, marginTop: 1 },
  headerStatusText: { color: colors.textSecondary, flex: 1, fontSize: typeScale.footnote, minWidth: 0 },
  // —— 分组 ——
  group: { gap: spacing.sm },
  groupTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 24,
    paddingHorizontal: spacing.md,
  },
  groupTitle: { color: colors.textTertiary, flex: 1, fontSize: typeScale.footnote, fontWeight: fontWeight.medium },
  groupFooter: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
  // —— 虚拟化列表拼出的卡片三段 ——
  listContent: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  listCardTop: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  listCardMiddle: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  listCardBottom: {
    backgroundColor: colors.surfaceElevated,
    borderBottomLeftRadius: radius.container,
    borderBottomRightRadius: radius.container,
    borderColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    height: radius.container,
    marginBottom: spacing.sm,
  },
  // —— 行 ——
  row: { gap: 3, justifyContent: 'center', minHeight: 52, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  rowLabel: { color: colors.textSecondary, flexShrink: 0, fontSize: typeScale.code },
  rowValue: { color: colors.textPrimary, flex: 1, fontSize: typeScale.code, textAlign: 'right' },
  rowDetail: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  switchTexts: { flex: 1, gap: spacing.xs },
  hint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  // —— 版本行 ——
  versionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  versionTexts: { flex: 1, gap: 2, minWidth: 0 },
  versionValueRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  versionValue: { color: colors.textPrimary, flexShrink: 1, fontSize: typeScale.body, fontWeight: fontWeight.semibold },
  betaChannelBadge: {
    backgroundColor: colors.betaChannelBadgeBackground,
    borderRadius: radius.pill,
    flexShrink: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  betaChannelBadgeText: {
    color: colors.betaChannelBadgeForeground,
    fontSize: typeScale.micro,
    fontWeight: fontWeight.semibold,
  },
  versionButton: { flexShrink: 0, minWidth: 84 },
  // —— 可复制行 ——
  copyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  copyText: { flex: 1, gap: 2, minWidth: 0 },
  copyLabel: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  copyValue: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  copyButton: { flexShrink: 0, minWidth: 60 },
  // —— 退出 ——
  dangerArea: { gap: spacing.md, paddingTop: spacing.sm },
  dangerHint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, paddingHorizontal: spacing.md },
  accountDeletionLink: {
    alignItems: 'center',
    alignSelf: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  accountDeletionLinkText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  nameEditorContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  nameEditorInputRow: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    flexDirection: 'row',
    minHeight: 56,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
  },
  nameEditorInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    minWidth: 0,
    paddingVertical: spacing.md,
  },
  nameEditorClearButton: {
    alignItems: 'center',
    backgroundColor: colors.textTertiary,
    borderRadius: radius.pill,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  nameEditorMessage: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  pressed: { opacity: 0.6 },
});
