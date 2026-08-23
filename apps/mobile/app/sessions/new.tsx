import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { formatMobileBuildLabel, normalizeBuildInfo } from '@/config/buildInfo';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextInputContentSizeChangeEvent,
  type TextLayoutEvent,
  type ViewStyle,
} from 'react-native';
import { Text } from '@/components/AppText';
import type { TextInput as NativeTextInput } from 'react-native';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  FolderPlus,
  GitBranch,
  Image,
  Laptop,
  ListTodo,
  MessageCircle,
  Mic,
  Plus,
  Scan,
  Settings,
  Target,
  X,
  Zap,
} from 'lucide-react-native';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenBackButton } from '@/components/MobilePrimitives';
import { PaperPlaneIcon } from '@/components/PaperPlaneIcon';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type {
  MobileAtResourceItem,
  MobileSlashCommand,
  RemoteDirectoryEntry,
} from '@/device-link/mobileMakerTransport';
import { describeAgentAuthError, formatRemoteError } from '@/device-link/remoteStatus';
import { agentAuthGateHint, agentAuthGateVerdict } from '@/session/agentAuthGate';
import { connectedProvidersForAgent, getModel } from '@cindy/model-providers/registry';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { fetchDeviceProvidersFresh, getCachedDeviceProviders, getDeviceProvidersGen, type DeviceProvidersPayload } from '@/device-link/deviceProvidersCache';
import { evictDeviceProviders, useDeviceProviders } from '@/device-link/useDeviceProviders';
import { useDeviceApiKeyStatus, useDeviceModelPricing } from '@/device-link/useDeviceModelMeta';
import {
  buildSessionRuntimeOptions,
  normalizeMobileAgentCapabilities,
  reconcileRuntimeDraftWithCapabilities,
  type MobileAgentCapabilities,
  type MobileModelOption,
  type MobileSessionRuntimeOptions,
} from '@/session/agentCapabilities';
import {
  MOBILE_MAX_ATTACHMENTS,
  attachmentDisplayLabel,
} from '@/session/attachments';
import { useAuth } from '@/auth/AuthContext';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';
import { goBackGuarded } from '@/utils/backGuard';
import { buildMobileImageAttachmentCandidate } from '@/session/mobileImageAttachment';
import { useMobileLocalAttachments } from '@/session/useMobileLocalAttachments';
import {
  AT_RESOURCE_QUERY_DEBOUNCE_MS,
  buildComposerPaletteCacheKey,
  readAtResourceScanCache,
  readSlashCommandCache,
  writeAtResourceScanCache,
  writeSlashCommandCache,
} from '@/session/composerPaletteCache';
import {
  buildAgentCapabilitiesCacheKey,
  commitAgentCapabilities,
  getAgentCapabilitiesGeneration,
  getCachedAgentCapabilities,
  isAgentCapabilitiesGenerationCurrent,
  subscribeAgentCapabilities,
} from '@/session/agentCapabilitiesCache';
import {
  ContextSheet,
  ContextSheetFooterButton,
  ContextSheetGroup,
  ContextSheetRow,
} from '@/session/ContextSheet';
import { RecentPhotosStrip, ScreenshotsGrid } from '@/session/ContextSheetMediaViews';
import { ContextSheetGoalCreateForm } from '@/session/ContextSheetGoalView';
import type { MobileGoalLimitsInput } from '@cindy/maker-shared/device-link-contract';
import { ComposerAttachmentCollapsedBadge, ComposerAttachmentTray } from '@/session/ComposerAttachmentTray';
import { ImageLightbox } from '@/session/ImageLightbox';
import {
  useComposerImageAnnotations,
  type UseComposerImageAnnotationsResult,
} from '@/session/useComposerImageAnnotations';
import { buildMediaPayload } from '@/session/messagePayload';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import {
  prefetchContextSheetMediaAssets,
  resolveContextSheetMediaAssetForUpload,
  type ContextSheetMediaAsset,
} from '@/session/useContextSheetMediaAssets';
import {
  detectComposerTrigger,
  filterAtResources,
  filterSlashCommands,
  insertAtResource,
  insertSlashCommand,
  mergeSlashCommands,
} from '@/session/composerPalette';
import {
  DEFAULT_NEW_SESSION_DRAFT,
  NEW_SESSION_AGENT_OPTIONS,
  availableNewSessionAgentOptions,
  defaultPermissionModeForNewSessionAgent,
  buildRemoteCreateSessionOptions,
  buildRecentWorkspaceOptions,
  filterRemoteDirectoryEntries,
  normalizeCreateSessionResult,
  isNewSessionDraftMissingPayloadOnly,
  parseNewSessionDeviceOptions,
  pickAgentDefaultRuntime,
  pickInitialNewSessionWorkspace,
  pickNewSessionDefaultDevice,
  resolveNewSessionAutoDefault,
  sessionFromCreateResult,
  compensatePrecreatedWorktree,
  reconcileEffortAfterFallback,
  resolveRecentModelAndProvider,
  resolveStartedDowngradeOrCommit,
  resolveSubmitGuardCatalog,
  validateNewSessionDraft,
  type NewSessionAgentKind,
  type NewSessionDraft,
  type NewSessionDeviceOption,
  type NewSessionStoredPreferences,
} from '@/session/newSession';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { newSessionText } from '@/session/newSessionMessages';
import { i18n } from '@/i18n';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from '@/auth/authOwnerGeneration';
import { useTranslation } from 'react-i18next';
import {
  createNewSessionId,
  drainStashedNewSessionDraft,
  getNewSessionCreationTask,
  startNewSessionCreation,
} from '@/session/newSessionCreation';
import {
  forgetPendingPrecreatedWorktree,
  holdPrecreatedWorktreeRegistration,
  isPrecreatedWorktreeRegistrationInFlight,
  parseDiscardPrecreatedAck,
  recoverPendingPrecreatedWorktrees,
  registerPendingPrecreatedWorktree,
} from '@/session/precreatedWorktreeRecovery';
import { prepareMobileQueuedSessionReferences } from '@/session/sessionReferences';
import {
  readNewSessionPreferences,
  saveNewSessionPreferences,
} from '@/session/newSessionPreferenceStore';
import {
  remoteSessionStore,
  useRemoteNewMakerWorktreeBranchPreference,
  useRemoteNewMakerWorktreePreference,
  useRemoteSessions,
} from '@/session/remoteSessionStore';
import { buildSessionComposerLayout } from '@/session/sessionComposerLayout';
import { keyboardAvoidingBehaviorForPlatform } from '@/session/mobileNativeShellLayout';
import type { RemoteSerializedAttachment, RemoteSession } from '@/session/types';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import { confirmFullAccessChange } from '@/session/fullAccessConfirmation';
import { MobileVendorIcon } from '@/components/MobileVendorIcon';
import { PlanModeChip } from '@/session/PlanModeChip';
import {
  ComposerResizeGrabber,
  ComposerToolbarLeftGroup,
  ComposerToolbarSpacer,
  ComposerToolbarVoiceSlot,
  MOBILE_COMPOSER_CONTROL_SIZE,
  MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
  MOBILE_COMPOSER_INPUT_MAX_HEIGHT,
  MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
  MOBILE_COMPOSER_MIN_TOUCH_TARGET,
  MobileComposerInputRow,
  VoiceMicWaveCaret,
  resolveMobileComposerVoiceButtonPlacement,
} from '@/session/MobileComposerInputRow';
import { VoiceRecordingPillContent, useMobileVoiceRecordingTimer } from '@/session/VoiceRecordingPill';
import { useComposerCardTransition } from '@/session/useComposerCardTransition';
import { useComposerResize } from '@/session/useComposerResize';
import { useMobileKeyboardState } from '@/session/useMobileKeyboardState';
import {
  isMobileVoiceMicPermissionError,
  mobileVoiceMicPermissionError,
  mobileVoiceRealtimeAudioUnavailableError,
  type MobileVoiceState,
} from '@/session/mobileVoiceInput';
import {
  resolveComposerVoiceHoldActive,
  shouldArmComposerVoiceHold,
} from '@/session/composerVoiceHold';
import { COMPOSER_TEXT_HORIZONTAL_PADDING } from '@/session/composerTextMetrics';
import {
  COMPOSER_TEXT_GEOMETRIC_PADDING_BOTTOM,
  COMPOSER_TEXT_GEOMETRIC_PADDING_TOP,
  COMPOSER_TEXT_PADDING_BOTTOM,
  COMPOSER_TEXT_PADDING_TOP,
} from '@/session/composerTextPlatformMetrics';
import {
  isMobileRealtimeAudioAvailable,
  prewarmMobileRealtimeAudio,
  shouldShowMobileVoiceUi,
} from '@/session/mobileRealtimeAudio';
import {
  discardPendingPrewarm,
  prewarmMobileVoiceStart,
  takePrewarmedMobileVoiceAsr,
  type PrewarmedMobileVoiceAsr,
} from '@/session/mobileVoicePrewarm';
import {
  resolveMobileVoiceRecordingPermission,
  shouldCancelMobileVoiceForBackground,
  waitForMobileVoiceAppActive,
} from '@/session/mobileVoiceStartup';
import {
  CINDY_MANAGED_REFINER_PROVIDER,
  createMobileCindyVoiceCredential,
  MobileCindyVoiceRunContext,
} from '@/session/mobileCindyVoiceSession';
import {
  currentMobileVoiceUiLanguage,
  resolveMobileVoiceRefinementSourceLanguage,
} from '@/session/mobileVoiceLanguage';
import {
  getMobileVoiceInputHistoryForHost,
  recordMobileVoiceInputHistoryForHost,
  updateMobileVoiceInputHistoryEntryForHost,
} from '@/session/mobileVoiceHistoryStore';
import {
  hydrateMobileVoiceDictionary,
  refreshMobileVoiceDictionary,
} from '@/session/mobileVoiceDictionaryCache';
import {
  playMobileVoiceInputEndCue,
} from '@/session/mobileVoiceCue';
import {
  createMobileVoiceControllerSession,
  type MobileVoiceControllerSession,
} from '@/session/mobileVoiceController';
import {
  createMobileVoiceDictionaryLearningTracker,
  type MobileVoiceDictionaryLearningTracker,
} from '@/session/mobileVoiceDictionaryLearning';
import {
  buildMobileModelSections,
  flattenProviderSections,
  isFastRestorable,
  resolveRowSelection,
  type ProviderModelRow,
} from '@/session/providerModelSections';
import { ModelPickerSheet } from '@/session/ModelPickerSheet';
import { MobileChoicePickerList } from '@/session/MobileChoicePickerList';
import { MobilePermissionPickerList } from '@/session/MobilePermissionPickerList';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import {
  applyWorktreePreferenceOnHost,
  buildWorktreeCreateRequest,
  classifyWorktreePreferenceSeed,
  formatWorktreeCreateFailure,
  isExactRemoteSessionClaimed,
  isValidWorktreeBranchPreferenceSnapshot,
  isWorktreeChannelNotAllowedError,
  parseWorktreeCreateResult,
  resolveWorktreeEligibility,
  shouldAcceptWorktreeBranchListResult,
  shouldBlockNewSessionCreateForWorktree,
  shouldShowWorktreeToggle,
  worktreeEligibilityForTarget,
  worktreeEligibilityCaptionKey,
  worktreeEligibilityFromError,
  worktreeSourceBranchFromPreference,
  type NewSessionWorktreeEligibility,
  type NewSessionWorktreeProbeSnapshot,
} from '@/session/newSessionWorktree';
import { mobileAgentLabel, mobileAgentVendor } from '@/session/sessionAgentSwitch';
import { MobileModelIconMark } from '@/session/MobileProviderMark';
import { draftModelMemoryFor, hydrateDraftModelMemory } from '@/session/draftModelMemory';
import { rowFastEditable } from '@/session/modelPickerRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

const COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD = 34;
const COMPOSER_VOICE_CARET_GAP = 2;
// composer 除输入区外的 chrome 高度估算（输入行上下 padding + 边框），
// 只用于给拖拽调高的上限留余量，与会话页同量级。
const COMPOSER_RESIZE_CHROME_HEIGHT = 34;
// 聚焦卡片形态的 chrome:paddingTop 26 + paddingBottom 8 + 层间 gap 8 + 工具排 ~36。
const COMPOSER_CARD_CHROME_HEIGHT = 78;
// Android 的 SafeAreaView 已经包含状态栏顶部 inset，不能再叠加一档顶部留白。
const NEW_SESSION_SCREEN_TOP_PADDING = Platform.OS === 'android' ? 0 : spacing.xl;

/**
 * 目标 agent 的 Fast 能力门控取值:只认按 (设备, agent) 键控的缓存能力表——
 * 切/恢复 agent 瞬间闭包里的 capabilities 属于切换前 agent(冷启动时为 null),
 * 用它门控会把记忆 Fast 恢复给不支持的 agent、或把合法记忆永久清掉(codex
 * review P1)。未就绪返回 false(保守):恢复点先置 false,由延迟恢复 effect 在
 * 目标 caps 就绪后补评。
 */
function targetAgentHasFast(deviceId: string, agentKind: NewSessionAgentKind): boolean {
  return getCachedAgentCapabilities(buildAgentCapabilitiesCacheKey(deviceId, agentKind))?.hasFastMode === true;
}

interface WorktreeBranchListSnapshot {
  target: { deviceId: string; workingDir: string };
  branches: string[];
  loading: boolean;
  failed: boolean;
}

interface WorktreePreferenceWriteTransaction {
  seq: number;
  deviceId: string;
  enabled: boolean;
  revisionAtStart: number;
  status: 'writing' | 'reconciling' | 'committed';
}

interface PendingWorktreePreferenceAuthority {
  enabled: boolean;
  revisionAtStart: number;
}

interface WorktreeBranchPreferenceWriteTransaction {
  seq: number;
  key: string;
  sourceBranch: string;
  revisionAtStart: number;
  status: 'writing' | 'unknown' | 'committed';
}

interface WorktreeBranchCompatibilitySelection {
  key: string;
  sourceBranch: string;
}

interface WorktreeCreateIntentSnapshot {
  applicable: boolean;
  enabled: boolean;
  target: { deviceId: string; workingDir: string };
  eligibility: NewSessionWorktreeEligibility;
  sourceBranch: string;
  preferenceSyncKey: string;
  branchPreferenceKey: string;
  branchPreferenceSyncKey: string;
}

export default function NewRemoteSessionScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // Dev-only:把构建信息从全局浮层挪到这里的顶部展示(试 Fast Refresh)。
  const buildLabel = __DEV__
    ? formatMobileBuildLabel(normalizeBuildInfo({
        source: process.env.EXPO_PUBLIC_XDT_GIT_SOURCE,
        branch: process.env.EXPO_PUBLIC_XDT_GIT_BRANCH,
        commit: process.env.EXPO_PUBLIC_XDT_GIT_COMMIT,
        version: Constants.nativeAppVersion ?? Constants.expoConfig?.version,
        buildNumber: Constants.nativeBuildVersion ?? Constants.expoConfig?.ios?.buildNumber,
        metroHost: (Constants.expoConfig as { hostUri?: string } | null)?.hostUri,
      }))
    : null;
  const params = useLocalSearchParams<{
    deviceId?: string;
    deviceName?: string;
    deviceOptions?: string;
    workingDir?: string;
    deviceExplicit?: string;
    visualFocusComposer?: string;
    visualDraft?: string;
  }>();
  const routeDeviceId = String(params.deviceId ?? '');
  const routeDeviceName = String(params.deviceName ?? routeDeviceId);
  const initialWorkingDir = readRouteString(params.workingDir);
  const visualFocusComposer = MOBILE_VISUAL_MOCK_ENABLED && readRouteString(params.visualFocusComposer) === '1';
  const visualInitialDraft = MOBILE_VISUAL_MOCK_ENABLED ? readRouteString(params.visualDraft) : null;
  const router = useRouter();
  const auth = useAuth();
  const {
    getPresenceAvailability,
    invoke,
    openLink,
    subscribe,
    status: deviceLinkStatus,
    connectionEpoch,
    presenceVersion,
  } = useDeviceLink();
  const deviceLinkStatusRef = useRef(deviceLinkStatus);
  deviceLinkStatusRef.current = deviceLinkStatus;
  const routeDeviceFallback = useMemo<NewSessionDeviceOption | null>(
    () => routeDeviceId ? { deviceId: routeDeviceId, name: routeDeviceName || routeDeviceId } : null,
    [routeDeviceId, routeDeviceName],
  );
  const deviceOptions = useMemo(
    () => parseNewSessionDeviceOptions(params.deviceOptions, routeDeviceFallback),
    [params.deviceOptions, routeDeviceFallback],
  );
  // 路由设备何时算"显式指定"(盖过上次选择的记忆):项目入口(带 workingDir)、只有一台
  // 可选电脑,或入口明确带 deviceExplicit 标记(首页列表正筛选某台电脑时新建跟随它)。
  const routeDeviceExplicit = !!routeDeviceId
    && (readRouteString(params.deviceExplicit) === '1' || !!initialWorkingDir || deviceOptions.length <= 1);
  const [selectedDeviceId, setSelectedDeviceId] = useState(routeDeviceId);
  const [selectedDeviceName, setSelectedDeviceName] = useState(routeDeviceName);
  const [newSessionPreferences, setNewSessionPreferences] = useState<NewSessionStoredPreferences | null>(null);
  const [newSessionPreferencesLoaded, setNewSessionPreferencesLoaded] = useState(false);
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const preferredDefaultDevice = useMemo(
    () => pickNewSessionDefaultDevice({
      deviceOptions,
      preferredDeviceId: newSessionPreferences?.device?.deviceId,
      routeDevice: routeDeviceFallback,
      routeDeviceExplicit,
    }),
    [deviceOptions, newSessionPreferences?.device?.deviceId, routeDeviceExplicit, routeDeviceFallback],
  );
  const selectedDeviceOption = useMemo(
    () => deviceOptions.find((option) => option.deviceId === selectedDeviceId) ?? routeDeviceFallback,
    [deviceOptions, routeDeviceFallback, selectedDeviceId],
  );
  const selectedDeviceLabel = selectedDeviceOption?.name || selectedDeviceName || selectedDeviceId || t('session.new.selectDevice');
  const maker = useMobileMakerTransport(selectedDeviceId);
  const worktreePreference = useRemoteNewMakerWorktreePreference(selectedDeviceId);
  const worktreeEnabled = worktreePreference.enabled;
  const sessions = useRemoteSessions();
  const recentWorkspaces = useMemo(
    () => buildRecentWorkspaceOptions(
      sessions.filter((session) => session.deviceLinkDeviceId === selectedDeviceId),
      selectedDeviceId,
    ),
    [selectedDeviceId, sessions],
  );
  const [draft, setDraft] = useState<NewSessionDraft>({
    ...DEFAULT_NEW_SESSION_DRAFT,
    firstMessage: visualInitialDraft ?? DEFAULT_NEW_SESSION_DRAFT.firstMessage,
    // 默认进入「对话」(无项目),对齐桌面;只有从项目入口带了 workingDir 才默认项目模式。
    workspaceKind: initialWorkingDir ? 'project' : 'dialogue',
    workingDir: initialWorkingDir ?? '',
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<MobileAgentCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [, setCapabilitiesError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseEntries, setBrowseEntries] = useState<RemoteDirectoryEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false);
  // Context 面板(+ 号弹出的可拖动 sheet):open + 子视图(主视图 / 截图列表 / 目标草稿)。
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const [contextSheetView, setContextSheetView] = useState<'main' | 'screenshots' | 'goal'>('main');
  // 目标模式(对齐桌面 NewMakerDraftRoute.handleCreateGoal):填完表单直接建会话 + setGoal,
  // 被控端落目标消息并自动开跑第一轮,成功后跳转会话页。
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  // 模型浮窗(ContextSheet 同款 Modal;新建页权限已提为独立选择器,浮窗只留模型)。
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // 权限模式独立浮窗(composer 工具条权限药丸点开;列表复用 MobilePermissionPickerList)。
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);
  const [permissionSheetSnap, setPermissionSheetSnap] = useState<ContextSheetSnap>('half');
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  // 被控端 runtime 已注册的 agent 集合(null = 未拉到 → fail-open 不过滤入口)。据此过滤新建
  // agent 选项:被控端 Pi 二进制缺失时其 agent map 无 pi,但模型目录仍投影 Pi,不过滤会让用户
  // 建出最终 requireAgent 报 not-registered 的会话(codex review P2)。
  const [availableAgentKinds, setAvailableAgentKinds] =
    useState<ReadonlySet<NewSessionAgentKind> | null>(null);
  // worktree 开关(project 模式 + 已选目录时显示):勾选值存工作端(get-new-maker-defaults
  // 播种 / 显式点击写穿),资格由 worktree:detect-cwd 探测(目录变化即重探,seq 防竞态)。
  const [worktreeProbe, setWorktreeProbe] = useState<NewSessionWorktreeProbeSnapshot | null>(null);
  const [worktreeDetectRetryNonce, setWorktreeDetectRetryNonce] = useState(0);
  const [worktreeBranchList, setWorktreeBranchList] =
    useState<WorktreeBranchListSnapshot | null>(null);
  const [worktreeBranchSheetOpen, setWorktreeBranchSheetOpen] = useState(false);
  const [worktreeBranchSheetSnap, setWorktreeBranchSheetSnap] =
    useState<ContextSheetSnap>('half');
  const [worktreeBranchPreferenceSavingKey, setWorktreeBranchPreferenceSavingKey] =
    useState<string | null>(null);
  const [worktreeBranchPreferenceReadyKey, setWorktreeBranchPreferenceReadyKey] =
    useState<string | null>(null);
  const [worktreeBranchPreferencePullRetryNonce, setWorktreeBranchPreferencePullRetryNonce] =
    useState(0);
  const [worktreeBranchPreferenceErrorKey, setWorktreeBranchPreferenceErrorKey] =
    useState<string | null>(null);
  const [worktreeBranchCompatibilitySelection, setWorktreeBranchCompatibilitySelection] =
    useState<WorktreeBranchCompatibilitySelection | null>(null);
  const worktreeDetectSeqRef = useRef(0);
  const worktreeBranchListSeqRef = useRef(0);
  const worktreeBranchPreferencePullSeqRef = useRef(0);
  const worktreeBranchPreferenceWriteSeqRef = useRef(0);
  const worktreeBranchPreferenceWriteTargetRef = useRef<string | null>(null);
  const worktreeBranchPreferenceReadyKeyRef = useRef<string | null>(null);
  const worktreeBranchPreferenceSyncKeyRef = useRef('');
  const worktreeBranchPreferenceAuthorityReadRef = useRef<{
    syncKey: string;
    ignoredSnapshot: unknown;
  } | null>(null);
  const worktreeBranchPreferenceTransactionRef =
    useRef<WorktreeBranchPreferenceWriteTransaction | null>(null);
  const worktreeBranchRenderedRef = useRef({ key: '', sourceBranch: '' });
  const worktreeBranchTargetRef = useRef({ deviceId: '', workingDir: '' });
  const worktreeEligibilityRef = useRef<NewSessionWorktreeEligibility>({ status: 'probing' });
  const worktreeSourceBranchRef = useRef('HEAD');
  const worktreeSeedSeqRef = useRef(0);
  const [worktreeSeedRetryNonce, setWorktreeSeedRetryNonce] = useState(0);
  const [worktreePreferenceReadyKey, setWorktreePreferenceReadyKey] = useState<string | null>(null);
  const worktreePreferenceReadyKeyRef = useRef<string | null>(null);
  const worktreePreferenceSyncKeyRef = useRef('');
  const worktreePreferenceAuthorityReadRef = useRef<{ syncKey: string; revision: number } | null>(
    null,
  );
  const worktreePreferenceWriteSeqRef = useRef(0);
  // State updates are batched; this synchronous target fence closes the
  // OFF→ON/ON→OFF then immediate Create gap before React renders the spinner.
  const worktreePreferenceWriteTargetRef = useRef<string | null>(null);
  const [worktreePreferenceSavingDeviceId, setWorktreePreferenceSavingDeviceId] =
    useState<string | null>(null);
  const worktreePreferenceTransactionRef = useRef<WorktreePreferenceWriteTransaction | null>(null);
  const worktreePreferenceRenderedRef = useRef({
    deviceId: selectedDeviceId,
    enabled: worktreeEnabled,
    revision: worktreePreference.revision,
  });
  const worktreePreferenceAuthorityUnknownByDeviceRef = useRef(
    new Map<string, PendingWorktreePreferenceAuthority>(),
  );
  const [, setWorktreePreferenceAuthorityVersion] = useState(0);
  const [attachments, setAttachments] = useState<RemoteSerializedAttachment[]>([]);
  // create() 里 await 在途图片上传后闭包里的 attachments 已是旧值,经 ref 读最新列表。
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 相册资产 → 已上传附件 id 的映射(缩略图勾选态真相)。
  const [mediaAssetAttachments, setMediaAssetAttachments] = useState<Record<string, string>>({});
  // 待选相册资产(按选中顺序;Cursor 式两段提交,底部「加入对话」统一上传)。
  const [pendingMediaAssets, setPendingMediaAssets] = useState<ContextSheetMediaAsset[]>([]);
  // 本机图片附件的本地预览 uri(attachmentId → file://),composer 托盘缩略图 / 全图查看用。
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  // composer 托盘里正被全屏查看的图片附件 id(null = 关闭)。
  const [composerPreviewAttachmentId, setComposerPreviewAttachmentId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // 乐观创建失败后「返回编辑」的草稿回填:会话页 stash → 跳回本页 → 挂载时 drain。
  // 附件是已上传完成的引用,原样回列即可继续使用;notice 是「有内容没能带回」的告知
  // (创建期间发出的消息可能超出单条上限,装不下的只能丢,但不能静默丢,review P1)。
  // 声明在 attachmentError 之后:notice 就落在附件错误行上。
  useEffect(() => {
    const stashed = drainStashedNewSessionDraft();
    if (!stashed) return;
    setDraft(stashed.draft);
    setAttachments([...stashed.attachments]);
    if (stashed.notice) setAttachmentError(stashed.notice);
    if (stashed.deviceId) {
      setSelectedDeviceId(stashed.deviceId);
      setSelectedDeviceName(stashed.deviceName || stashed.deviceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时领取一次信箱
  }, []);
  // 圈点标注接线 api 的 ref 中转(同会话页):hook 实例声明在 removeAttachment
  // 之后,onUploaded 等回调延迟执行经 ref 读最新实例。
  const composerAnnotationsRef = useRef<UseComposerImageAnnotationsResult | null>(null);
  // 本机附件(相册 / 拍照 / 文件)乐观上传:picker 一返回即进托盘,上传转后台。
  const {
    pendingUploads,
    pastePlaceholderCount,
    beginPastePlaceholders,
    failPastePlaceholders,
    addImages: addLocalImageAttachments,
    addDocument: addLocalFileAttachment,
    addPastedImages: addPastedImageAttachments,
    enqueueUploads,
    removePendingUpload,
    retryPendingUpload,
    discardAllPendingUploads,
    waitForPendingUploads,
    getPendingUploadCount,
  } = useMobileLocalAttachments({
    getAccessToken: () => auth.getAccessToken(),
    getAttachmentCount: () => attachmentsRef.current.length,
    onUploaded: (rawAttachment, candidate) => {
      // 标注类 candidate:记录「矢量笔迹 + 原图」再编辑真相并打 annotated wire 标。
      const attachment = composerAnnotationsRef.current
        ?.decorateUploadedAttachment(rawAttachment, candidate) ?? rawAttachment;
      // create() 在 waitForPendingUploads 落定后同步读 ref,而 setState 到 commit 有
      // 微任务延迟——这里派发时同步镜像,保证「上传完成→立即创建」不丢刚落定的附件。
      attachmentsRef.current = [...attachmentsRef.current, attachment];
      if (candidate.kind === 'image') {
        setAttachmentPreviews((current) => ({ ...current, [attachment.id]: candidate.uri }));
      }
      if (candidate.sourceId) {
        // 相册面板来源:asset.id → attachment.id 映射,驱动面板勾选角标。
        const sourceId = candidate.sourceId;
        setMediaAssetAttachments((current) => ({ ...current, [sourceId]: attachment.id }));
      }
      setAttachments((current) => [...current, attachment]);
    },
    onError: setAttachmentError,
    onPicked: () => setContextSheetOpen(false),
  });
  const [slashCommands, setSlashCommands] = useState<MobileSlashCommand[]>([]);
  const [slashPaletteLoading, setSlashPaletteLoading] = useState(false);
  const [slashPaletteError, setSlashPaletteError] = useState<string | null>(null);
  const [atResources, setAtResources] = useState<MobileAtResourceItem[]>([]);
  const [atPaletteLoading, setAtPaletteLoading] = useState(false);
  const [atPaletteError, setAtPaletteError] = useState<string | null>(null);
  const [atResourcesTruncated, setAtResourcesTruncated] = useState(false);
  const [voiceState, setVoiceStateInternal] = useState<MobileVoiceState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // 「语音结束保持展开」hold:语音真实收尾(busy → done/error)时布防,草稿仍有
  // 内容即生效、一行文字也不收(composerVoiceHoldActive);下拉收起 / 失焦 / 草稿清空解除。
  const [composerVoiceHoldArmed, setComposerVoiceHoldArmed] = useState(false);
  // 所有语音收尾路径(finish 主路径、controller onStateChanged、各错误分支)都经
  // setVoiceState 落状态,布防收敛在这一个包装里;与 voiceState 同一批 setState
  // 提交,语音结束瞬间卡片不会先塌一帧再弹开。
  const voiceStateTransitionRef = useRef<MobileVoiceState>('idle');
  const setVoiceState = useCallback((next: MobileVoiceState) => {
    if (shouldArmComposerVoiceHold(voiceStateTransitionRef.current, next)) {
      setComposerVoiceHoldArmed(true);
    }
    voiceStateTransitionRef.current = next;
    setVoiceStateInternal(next);
  }, []);
  const browseSeqRef = useRef(0);
  const capabilitiesSeqRef = useRef(0);
  const slashLoadSeqRef = useRef(0);
  const atLoadSeqRef = useRef(0);
  const initialWorkspaceKeyRef = useRef<string | null>(null);
  const appliedDefaultDeviceKeyRef = useRef<string | null>(null);
  const appliedStoredAgentRef = useRef<NewSessionAgentKind | null>(null);
  // 权限记忆只在偏好加载后恢复一次(之后由用户选择 / 切 agent 驱动),防止重复覆盖。
  const appliedPermissionMemoryRef = useRef(false);
  const userTouchedDeviceRef = useRef(false);
  const firstMessageRef = useRef(draft.firstMessage);
  const firstMessageInputRef = useRef<NativeTextInput>(null);
  const voiceDraftScrollRef = useRef<ScrollView>(null);
  const voiceRecordingActiveRef = useRef(false);
  const voicePermissionRequestInFlightRef = useRef(false);
  const voicePermissionRequestSeqRef = useRef(0);
  const voicePermissionRequestAbortRef = useRef<AbortController | null>(null);
  const voiceStartupInFlightRef = useRef(false);
  const voiceStopInFlightRef = useRef(false);
  const voiceStartupSeqRef = useRef(0);
  const voiceControllerSessionRef = useRef<MobileVoiceControllerSession | null>(null);
  const voiceDictionaryLearningTrackerRef = useRef<MobileVoiceDictionaryLearningTracker | null>(null);
  const creatingRef = useRef(false);
  const [firstMessageInputContentHeight, setFirstMessageInputContentHeight] = useState(MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT);
  const [firstMessageInputFocused, setFirstMessageInputFocused] = useState(false);
  const [voiceDraftCaretFrame, setVoiceDraftCaretFrame] = useState({ left: 0, top: 0 });
  // 自动默认运行配置(跟随最近会话 / 区域默认 / 列表最上面)的守卫:用户一旦手动选过模型,就不再自动覆盖;
  // 记录已自动应用过的设备,切设备时(未手动选过)按新设备重算。
  const userTouchedRuntimeRef = useRef(false);
  // 只保护当前页面刚从 provider 目录显式选中的模型，避免旧 capabilities 在途结果误回退；
  // 持久草稿不会写入该 ref，因此已下架模型仍走 mobile 的首项降级。
  const explicitProviderModelSelectionRef = useRef<string | null>(null);
  const autoDefaultDeviceRef = useRef<string | null>(null);
  // selectedDeviceId 的渲染期镜像:异步回调(权限确认 .then)提交前比对触发时捕获的设备,
  // 不一致即放弃写入 —— 防止确认弹窗期间用户切了设备,回调把旧设备的来源/配置写进草稿
  // (Greptile review P1:异步切换写入旧设备来源)。
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  // 运行配置操作的代际计数:switchAgent / 恢复 agent / 手动选行每次触发 +1,
  // 异步回调(权限确认 .then)提交前比对触发时捕获的代际,不等即放弃写入 ——
  // 同一设备上的连续操作也是最新者胜(Greptile review P1:旧确认回调覆盖新选择)。
  const runtimeActionSeqRef = useRef(0);
  const runtimeOptions = useMemo(
    () => buildSessionRuntimeOptions(draft, capabilities),
    [capabilities, draft.model],
  );
  // 被控端供应商目录 → provider-aware 模型分段(对齐桌面)。0 供应商 / 旧被控端 → 回退扁平列表。
  const deviceProviders = useDeviceProviders(selectedDeviceId || undefined);
  // 模型列表元信息(单价 / 折扣版 key presence)+ 草稿 per-(agent,来源,模型) 记忆(对齐桌面)。
  const deviceModelPricing = useDeviceModelPricing(selectedDeviceId || undefined);
  const deviceApiKeyStatus = useDeviceApiKeyStatus(selectedDeviceId || undefined);
  const draftMemory = useMemo(() => draftModelMemoryFor(selectedDeviceId), [selectedDeviceId]);
  useEffect(() => {
    void hydrateDraftModelMemory();
  }, []);
  const modelSections = useMemo(
    () => buildMobileModelSections({
      providers: deviceProviders.providers,
      agentKind: draft.agentKind,
      selectedModelId: draft.model,
      selectedProviderId: draft.providerId,
      visibilityOverrides: deviceProviders.modelVisibilityOverrides,
    }),
    [deviceProviders.providers, deviceProviders.modelVisibilityOverrides, draft.agentKind, draft.model, draft.providerId],
  );
  const modelRows = useMemo(
    () => flattenProviderSections(modelSections.sections),
    [modelSections.sections],
  );
  // modelRows / 目录就绪信号的渲染期镜像:create / createGoalSession 是长依赖数组的
  // useCallback,闭包可能停在旧渲染——提交点终检必须读最新值,否则目录从未就绪变为
  // 就绪后,旧回调仍以 catalogReady=false 放行已失效来源(Greptile review P1:
  // 旧目录快照绕过终检)。
  const modelRowsRef = useRef(modelRows);
  modelRowsRef.current = modelRows;
  const catalogReadyRef = useRef(deviceProviders.ready);
  catalogReadyRef.current = deviceProviders.ready;
  // 供应商目录本身的渲染期镜像:异步回调(权限确认 .then)提交时用它现场重建目标
  // agent 的 rows——确认弹窗期间目录可能从未就绪变为就绪或同设备刷新,触发时捕获的
  // rows 与最新 ready 不同代会误判/抄旧首项(codex review P2)。
  const deviceProvidersRef = useRef(deviceProviders);
  deviceProvidersRef.current = deviceProviders;
  // 发送前鉴权门禁(对齐桌面 useVendorAuthGate):选中 agent 在被控端没有已连接
  // 供应商时提前提示 + 拦截创建,不让用户发出注定失败的首条消息。unknown 不拦截。
  const agentAuthVerdict = useMemo(
    () => agentAuthGateVerdict({
      providers: deviceProviders.providers,
      loading: deviceProviders.loading,
      error: deviceProviders.error,
      agentKind: draft.agentKind,
    }),
    [deviceProviders.providers, deviceProviders.loading, deviceProviders.error, draft.agentKind],
  );
  // 创建前的 fresh 鉴权确认(绕过缓存现拉):true = 确认无已连接供应商,应拦截。
  // 空目录 / 拉取失败(旧被控端 / 瞬断)与 agentAuthGateVerdict 的 unknown 同语义,
  // fail-open 返回 unauthenticated=false 放行(review P2:不把空回包升级成硬拦截)。
  // fresh = 本次现拉的工作站目录(管线鉴权后联合校验用,codex review P2)。
  const confirmAgentUnauthenticated = useCallback(async (agentKind: NewSessionAgentKind, deviceId: string) => {
    try {
      // 经 fetchDeviceProvidersFresh 拉取(codex review P2:将最终鉴权目录同步回
      // 供应商缓存)——直接 listProviders 只把响应交给管线,不更新/驱逐缓存:提交
      // guard 已缓存来源 A、建链后鉴权终检看到 B 并用 B 创建时,跳转后
      // useDeviceProviders 命中仍为 A 的缓存并标记 ready:true,UI 与后续选择与
      // 实际创建脱节。fresh 拉取会按设备与代际写回同一缓存并通知订阅者。
      const fresh = await fetchDeviceProvidersFresh(deviceId, () => maker.listProviders());
      // 丢弃已换代的最终目录响应(codex review P2):fresh 在途期间若收到
      // provider-changed / 登出驱逐 / 重连驱逐,代际变化只让它跳过缓存回写,
      // Promise 仍正常返回旧响应——核对响应是否被采纳(被采纳 ⟺ 缓存就是该
      // 响应对象;fresh 成功且 isCurrent 时 cache.set 的就是这个 payload)。
      // 未采纳 → 目录已失效,按 unknown 处理(不交给 revalidateDraftAfterAuth,
      // 避免普通创建管线按已删除来源 A 创建;下一轮 guard/重连会取最新目录)。
      if (getCachedDeviceProviders(deviceId) !== fresh) {
        return { unauthenticated: false, fresh: null };
      }
      return {
        unauthenticated: fresh.providers.length > 0
          && connectedProvidersForAgent(fresh.providers, agentKind).length === 0,
        fresh: {
          providers: fresh.providers,
          ...(fresh.modelVisibilityOverrides !== undefined
            ? { modelVisibilityOverrides: fresh.modelVisibilityOverrides }
            : {}),
        },
      };
    } catch {
      return { unauthenticated: false, fresh: null };
    }
  }, [maker]);
  // setDraft 函数式更新里拿不到最新 modelSections —— 用 ref 镜像当前高亮来源 id。
  const activeSourceIdRef = useRef<string | null>(null);
  activeSourceIdRef.current = modelSections.activeSourceId;
  // trigger 药丸展示(对齐桌面):当前来源官方 mark + 「模型 · effort」+ Fast 闪电 + Chevron。
  const activeSourceProvider = useMemo(
    () => modelSections.connected.find((p) => p.id === modelSections.activeSourceId) ?? null,
    [modelSections],
  );
  const triggerFastOn =
    draft.fastMode &&
    rowFastEditable({
      provider: activeSourceProvider ?? undefined,
      modelId: draft.model,
      agentKind: draft.agentKind,
      hasFastModeCap: capabilities?.hasFastMode === true,
    });
  useEffect(() => {
    let cancelled = false;
    setNewSessionPreferencesLoaded(false);
    void readNewSessionPreferences()
      .then((preferences) => {
        if (!cancelled) setNewSessionPreferences(preferences);
      })
      .finally(() => {
        if (!cancelled) setNewSessionPreferencesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!newSessionPreferencesLoaded) return;
    if (userTouchedDeviceRef.current) return;
    const key = [
      routeDeviceId,
      routeDeviceName,
      initialWorkingDir ?? '',
      routeDeviceExplicit ? 'explicit' : 'default',
      newSessionPreferences?.device?.deviceId ?? '',
      deviceOptions.map((option) => option.deviceId).join(','),
    ].join('|');
    if (appliedDefaultDeviceKeyRef.current === key) return;
    appliedDefaultDeviceKeyRef.current = key;
    setSelectedDeviceId(preferredDefaultDevice?.deviceId ?? '');
    setSelectedDeviceName(preferredDefaultDevice?.name ?? preferredDefaultDevice?.deviceId ?? '');
    setDevicePickerOpen(false);
  }, [
    deviceOptions,
    initialWorkingDir,
    newSessionPreferences?.device?.deviceId,
    newSessionPreferencesLoaded,
    preferredDefaultDevice?.deviceId,
    preferredDefaultDevice?.name,
    routeDeviceExplicit,
    routeDeviceId,
    routeDeviceName,
  ]);

  useEffect(() => {
    const storedAgentKind = newSessionPreferences?.agentKind;
    if (!newSessionPreferencesLoaded || !storedAgentKind) return;
    if (appliedStoredAgentRef.current === storedAgentKind) return;
    const expectedDeviceId = preferredDefaultDevice?.deviceId ?? '';
    if (expectedDeviceId && selectedDeviceId !== expectedDeviceId) return;
    if (selectedDeviceId && deviceProviders.loading && deviceProviders.providers.length === 0) return;
    appliedStoredAgentRef.current = storedAgentKind;
    // 该路径同时负责恢复 agent 权限，下面的通用权限记忆 effect 不再重复弹框。
    appliedPermissionMemoryRef.current = true;
    if (selectedDeviceId) autoDefaultDeviceRef.current = selectedDeviceId;
    const storedPermissionMode = newSessionPreferences?.permissionModeByAgent[storedAgentKind];
    const nextPermissionMode =
      storedPermissionMode ??
      defaultPermissionModeForNewSessionAgent(storedAgentKind);
    let cancelled = false;
    const deviceAtTrigger = selectedDeviceId;
    const seqAtTrigger = ++runtimeActionSeqRef.current;
    void (async () => {
      const confirmed = await confirmFullAccessChange(draft.permissionMode, nextPermissionMode, {
        restoringRememberedChoice: storedPermissionMode !== undefined,
      });
      if (cancelled) return;
      // 确认期间设备已切换 → 放弃本次写入,新设备自己的恢复/自动默认 effect 会接管。
      if (deviceAtTrigger !== selectedDeviceRef.current) return;
      // 确认期间用户又切了 agent / 手动选了模型 → 旧回调不得覆盖新选择。
      if (seqAtTrigger !== runtimeActionSeqRef.current) return;
      setDraft((current) => {
        // rows 与 ready 必须同一代(codex review P2):提交时用最新目录现场重建,
        // 不用触发时捕获的旧 rows。
        const rowsNow = flattenProviderSections(
          buildMobileModelSections({
            providers: deviceProvidersRef.current.providers,
            agentKind: storedAgentKind,
            visibilityOverrides: deviceProvidersRef.current.modelVisibilityOverrides,
          }).sections,
        );
        const next = pickAgentDefaultRuntime({
          agentKind: storedAgentKind,
          sessions,
          deviceId: selectedDeviceId || undefined,
          modelRows: rowsNow,
          currentEffort: current.effort,
          catalogReady: catalogReadyRef.current,
        });
        return {
          ...current,
          agentKind: next.agentKind,
          model: next.model,
          effort: next.effort,
          // 上次明确选择过的权限直接沿用；内置默认若升级到 Full access 仍需确认。
          permissionMode: confirmed ? nextPermissionMode : current.permissionMode,
          providerId: next.providerId,
          // fast 按 (agent, 来源, 模型) 记忆恢复,无记忆置 false;恢复前过与手动选行
          // 同款的 fastEditable 门控(codex review P2:目录/能力变化后不得恢复出
          // UI 显示关、实际发 true 的矛盾态)。agent 级门控只认目标 agent 的缓存
          // 能力表(codex review P1:此刻闭包里的 capabilities 属于切换前 agent 或
          // 为 null);目标 caps 未就绪 → false,由延迟恢复 effect 就绪后补评。
          fastMode: next.providerId
            && isFastRestorable(next.agentKind, next.providerId, next.model, rowsNow, targetAgentHasFast(selectedDeviceId, next.agentKind))
            ? (draftMemory.getFast(next.agentKind, next.providerId, next.model) ?? false)
            : false,
        };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    draft.permissionMode,
    deviceProviders.loading,
    deviceProviders.providers,
    deviceProviders.modelVisibilityOverrides,
    newSessionPreferences,
    newSessionPreferences?.agentKind,
    newSessionPreferencesLoaded,
    preferredDefaultDevice?.deviceId,
    selectedDeviceId,
    sessions,
  ]);

  // 权限记忆恢复:偏好加载后按当前 agent 恢复上次选过的档(一次;对齐桌面 lastByVendor)。
  // storedAgentKind 路径由上面的 effect 覆盖;这里兜住「没存过 agent 但存过权限」的场景。
  useEffect(() => {
    if (!newSessionPreferencesLoaded || appliedPermissionMemoryRef.current) return;
    appliedPermissionMemoryRef.current = true;
    // 有存储的 agent 时由上面的 agent 恢复 effect 统一处理，避免同一轮出现两个确认框。
    if (newSessionPreferences?.agentKind) return;
    const remembered = newSessionPreferences?.permissionModeByAgent[draft.agentKind];
    if (!remembered || remembered === draft.permissionMode) return;
    let cancelled = false;
    void confirmFullAccessChange(draft.permissionMode, remembered, {
      restoringRememberedChoice: true,
    }).then((confirmed) => {
      if (cancelled || !confirmed) return;
      setDraft((current) => ({ ...current, permissionMode: remembered }));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.agentKind, draft.permissionMode, newSessionPreferences, newSessionPreferencesLoaded]);

  // 新建任务默认运行配置 = 跟随最近一次会话(整套 agent+model+effort,按所选设备 scope);没有最近会话则
  // 优先区域默认、再用模型列表最上面那个。一旦用户手动选过模型即不再覆盖;切设备(未手动选过)按新设备重算。
  // 决策逻辑全在纯函数 resolveNewSessionAutoDefault 里(便于单测);此 effect 只负责"调纯函数 → setDraft + 更新 ref"。
  // 最近会话路径同步可得(sessions 在内存);列表最上面依赖 providers 异步,故 modelRows 就绪后此 effect 再触发。
  useEffect(() => {
    if (!newSessionPreferencesLoaded) return;
    const result = resolveNewSessionAutoDefault({
      userTouched: userTouchedRuntimeRef.current,
      appliedDeviceId: autoDefaultDeviceRef.current,
      selectedDeviceId,
      sessions,
      modelRows,
      // modelRows 按当前 draft.agentKind 构建;最近会话若是另一个 agent,纯函数内不做来源校验。
      rowsAgentKind: draft.agentKind,
      catalogReady: deviceProviders.ready,
      // 目录明确不可用(error 非空,旧被控端无 provider:list 通道等)→ 放行扁平回退
      // (codex review P2);加载中/切设备间隙 error 为空,维持既有「不动等重算」语义。
      providersUnavailable: deviceProviders.error != null,
      // provider-aware 模式只用经过可见性过滤的 rows;目录确实不可用时才回退
      // capabilities(上游 main 移植,merge 2026-08-07)。
      availableModels: !deviceProviders.loading && modelSections.connected.length === 0
        ? capabilities?.availableModels
        : undefined,
      currentEffort: draft.effort,
    });
    if (!result) return;
    autoDefaultDeviceRef.current = result.appliedDeviceId;
    const nextAgentKind = result.patch.agentKind ?? draft.agentKind;
    const storedPermissionMode = appliedPermissionMemoryRef.current
      ? undefined
      : newSessionPreferences?.permissionModeByAgent[nextAgentKind];
    const nextPermissionMode = appliedPermissionMemoryRef.current
      ? draft.permissionMode
      : storedPermissionMode ?? defaultPermissionModeForNewSessionAgent(nextAgentKind);
    let cancelled = false;
    void confirmFullAccessChange(draft.permissionMode, nextPermissionMode, {
      restoringRememberedChoice: storedPermissionMode !== undefined,
    }).then((confirmed) => {
      if (cancelled || userTouchedRuntimeRef.current) return;
      setDraft((current) => {
        // 自动默认重算(设备切换/最近会话变化)改了 (agent, model, providerId) 组合 →
        // fastMode 按新组合重验(Codex review P2):A 设备记忆恢复的 fastMode:true 不得
        // 随 `...current` 带进 B 的组合(若 B 的模型行不支持 Fast,终检/延迟恢复/能力
        // 协调三条路径都不会处理它)。组合变化时保守关闭,由延迟恢复 effect 在 B 的
        // 组合 + 能力就绪后按记忆重评(手动关过 → 记忆为 false,不会重新打开)。
        const nextModel = result.patch.model ?? current.model;
        // providerId 用 `!== undefined` 而非 `??`:patch 显式带 providerId:null(来源
        // 切回默认路由)是真实的组合变化,`??` 会取回旧值抹掉该变化(Codex review P2)。
        const nextProviderId = result.patch.providerId !== undefined
          ? result.patch.providerId
          : current.providerId;
        const nextAgentKind = result.patch.agentKind ?? current.agentKind;
        const comboChanged = nextModel !== current.model
          || nextProviderId !== current.providerId
          || nextAgentKind !== current.agentKind;
        return {
          ...current,
          ...result.patch,
          ...(comboChanged ? { fastMode: false } : {}),
          // 自动恢复上次明确选择的权限不再重复确认；内置默认仍按升级规则确认。
          permissionMode: confirmed ? nextPermissionMode : current.permissionMode,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [capabilities?.availableModels, deviceProviders.loading, draft.effort, draft.permissionMode, draft.agentKind, modelRows, deviceProviders.ready, modelSections.connected.length, newSessionPreferences, newSessionPreferencesLoaded, selectedDeviceId, sessions]);

  // 目录就绪后的来源终检(codex review P1):自动默认/恢复在目录加载期信任的来源可能已失效
  // (provider 被删/断开/模型下架),就绪后必须复核——联合回退整对 (model, providerId)
  // (其他来源顶替 / 首项 / 内置默认),不留裸模型回落默认网关(codex review P2)。
  // 无变化时返回原引用,不触发额外渲染。
  useEffect(() => {
    if (!deviceProviders.ready) return;
    setDraft((current) => {
      if (!current.providerId) return current;
      const resolved = resolveRecentModelAndProvider(
        modelRows,
        { model: current.model, providerId: current.providerId },
        current.agentKind,
        true,
      );
      const pairChanged = resolved.model !== current.model || resolved.providerId !== current.providerId;
      if (!pairChanged) return current;
      // 组合变化时同步校准 effort(codex review P2)、fastMode 保守置 false(可手动重开)。
      return {
        ...current,
        model: resolved.model,
        providerId: resolved.providerId,
        effort: reconcileEffortAfterFallback(modelRows, resolved, current.effort),
        ...(current.fastMode ? { fastMode: false } : {}),
      };
    });
  }, [deviceProviders.ready, modelRows]);
  const draftContent = useMemo(
    // pending(乐观上传中)也算数:拍完照立刻点创建是常见路径,create() 里会等它们落定。
    () => ({ attachmentCount: attachments.length + pendingUploads.length }),
    [attachments.length, pendingUploads.length],
  );
  const runtimeSummary = useMemo(
    () => buildDraftRuntimeSummary(draft, runtimeOptions),
    [draft, runtimeOptions],
  );
  // 权限按钮 / 权限下拉不体现 plan(对齐桌面 PR#494 / Cursor):计划模式激活时展示
  // 进入前的底层权限档(无记录时回退首个非 plan 档),激活态由 composer 的 PlanModeChip 表达。
  const prePlanPermissionModeRef = useRef<string | null>(null);
  const displayPermissionMode = draft.permissionMode === 'plan'
    ? ((prePlanPermissionModeRef.current && prePlanPermissionModeRef.current !== 'plan')
      ? prePlanPermissionModeRef.current
      : runtimeOptions.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask')
    : draft.permissionMode;
  const displayPermissionLabel = runtimeOptions.permissionOptions
    .find((option) => option.id === displayPermissionMode)?.label ?? runtimeSummary.permissionLabel;
  // 对齐桌面 getProjectPickerDisplayName/empty-label:对话→「对话」、选了项目→项目名、
  // project 模式但没目录→「选择项目」(而非泛化的「选择工作区」)。
  const workspaceLabel = useMemo(
    () => draft.workspaceKind === 'dialogue'
      ? t('session.new.workspaceDialogue')
      : draft.workingDir.trim()
        ? formatWorkingDirLabel(draft.workingDir)
        : t('session.new.selectProject'),
    [draft.workspaceKind, draft.workingDir, t],
  );
  const WorkspaceIcon = draft.workspaceKind === 'dialogue' ? MessageCircle : Folder;
  const agentLabel = mobileAgentLabel(draft.agentKind);
  // effect 在 commit 后才会把旧探测结果重置为 probing；render 期先按设备 + cwd +
  // 连接代次同步对齐 target，切项目/设备或同目标重连后立即创建也拿不到旧结果。
  const worktreeTarget = {
    deviceId: selectedDeviceId ?? '',
    workingDir: draft.workspaceKind === 'project' ? draft.workingDir.trim() : '',
    probeGeneration: `${connectionEpoch}\u0000${presenceVersion}`,
  };
  worktreeBranchTargetRef.current = worktreeTarget;
  const worktreeEligibility = worktreeEligibilityForTarget(worktreeProbe, worktreeTarget);
  worktreeEligibilityRef.current = worktreeEligibility;
  const worktreeHostSupportsRecoveryKeyDiscard = worktreeProbe
    && worktreeProbe.target.deviceId === worktreeTarget.deviceId
    && worktreeProbe.target.workingDir.trim() === worktreeTarget.workingDir.trim()
    ? worktreeProbe.supportsRecoveryKeyDiscard
    : undefined;
  const worktreeBranchBaseRepo = worktreeEligibility.status === 'eligible'
    ? worktreeEligibility.baseRepo
    : '';
  const worktreeBranchPreferenceKey = selectedDeviceId && worktreeBranchBaseRepo
    ? `${selectedDeviceId}\u0000${worktreeBranchBaseRepo}`
    : '';
  const remoteWorktreeBranchPreference = useRemoteNewMakerWorktreeBranchPreference(
    selectedDeviceId,
    worktreeBranchBaseRepo,
  );
  const authoritativeWorktreeSourceBranch = worktreeSourceBranchFromPreference(
    remoteWorktreeBranchPreference,
    worktreeEligibility,
  );
  const worktreeSourceBranch = worktreeBranchCompatibilitySelection?.key
    === worktreeBranchPreferenceKey
    ? worktreeBranchCompatibilitySelection.sourceBranch
    : authoritativeWorktreeSourceBranch;
  worktreeSourceBranchRef.current = worktreeSourceBranch;
  const worktreeBranchListMatchesTarget = worktreeBranchList != null
    && worktreeBranchList.target.deviceId === worktreeTarget.deviceId
    && worktreeBranchList.target.workingDir.trim() === worktreeTarget.workingDir.trim();
  const worktreeBranchOptions = useMemo(
    () => worktreeBranchListMatchesTarget
      ? worktreeBranchList.branches.map((branch) => ({ id: branch, label: branch }))
      : [],
    [worktreeBranchList, worktreeBranchListMatchesTarget],
  );
  // 老被控端通常隐藏开关；若工作端旧镜像仍为 ON，则保留显式关闭入口，避免
  // fail-closed 后既不能创建、也不能解除状态。
  const worktreeRowVisible = shouldShowWorktreeToggle({
    workspaceKind: draft.workspaceKind,
    workingDir: draft.workingDir,
    eligibility: worktreeEligibility,
    enabled: worktreeEnabled,
  });
  const worktreePreferenceSaving =
    selectedDeviceId != null && (
      worktreePreferenceSavingDeviceId === selectedDeviceId
      || worktreePreferenceWriteTargetRef.current === selectedDeviceId
    );
  const worktreePreferenceSyncKey = selectedDeviceId
    ? `${selectedDeviceId}\u0000${connectionEpoch}\u0000${presenceVersion}`
    : '';
  worktreePreferenceSyncKeyRef.current = worktreePreferenceSyncKey;
  const worktreePreferenceReady = worktreePreferenceSyncKey.length > 0
    && worktreePreferenceReadyKey === worktreePreferenceSyncKey
    && worktreePreferenceReadyKeyRef.current === worktreePreferenceSyncKey;
  const worktreePreferenceAuthorityUnknown = selectedDeviceId != null
    && worktreePreferenceAuthorityUnknownByDeviceRef.current.has(selectedDeviceId);
  const worktreeApplicable = draft.workspaceKind === 'project'
    && draft.workingDir.trim().length > 0;
  // ineligible(2026-08-07 裁决):确认目录不合格时无需等偏好就绪——反正不会
  // 创建 worktree,GET 在途不应卡住普通会话创建。
  const worktreePreferenceCreateBlocked = worktreeApplicable
    && selectedDeviceId != null
    && worktreeEligibility.status !== 'ineligible'
    && (
      worktreePreferenceSaving
      || worktreePreferenceAuthorityUnknown
      || !worktreePreferenceReady
    );
  // host preference 虽然持久化，连接代次仍属于权威读取 identity：桌面重启/重连后
  // 即使 deviceId/repo 没变，也重新 GET，不能只相信手机内存里的旧快照。
  const worktreeBranchPreferenceSyncKey = worktreeBranchPreferenceKey
    ? `${worktreeBranchPreferenceKey}\u0000${connectionEpoch}\u0000${presenceVersion}`
    : '';
  worktreeBranchPreferenceSyncKeyRef.current = worktreeBranchPreferenceSyncKey;
  const worktreeBranchPreferenceReady = worktreeBranchPreferenceSyncKey.length > 0
    && worktreeBranchPreferenceReadyKey === worktreeBranchPreferenceSyncKey
    && worktreeBranchPreferenceReadyKeyRef.current === worktreeBranchPreferenceSyncKey;
  const worktreeBranchPreferenceError = worktreeBranchPreferenceKey.length > 0
    && worktreeBranchPreferenceErrorKey === worktreeBranchPreferenceKey;
  const worktreeBranchPreferenceSaving = worktreeBranchPreferenceKey.length > 0
    && (
      worktreeBranchPreferenceSavingKey === worktreeBranchPreferenceKey
      || worktreeBranchPreferenceWriteTargetRef.current === worktreeBranchPreferenceKey
    );
  const worktreeToggleDisabled =
    creating
    || worktreePreferenceSaving
    || (!worktreePreferenceReady && !worktreePreferenceAuthorityUnknown)
    || (worktreeEligibility.status !== 'eligible' && !worktreeEnabled);
  // 分支区与 checkbox 是两条独立轴：OFF 时也可先选源分支；保存 checkbox 偏好在途
  // 同样不影响只读的分支枚举。只有目标尚不具备 worktree 资格或创建在途时禁用。
  const worktreeBranchDisabled = creating
    || worktreeBranchPreferenceSaving
    || worktreeEligibility.status !== 'eligible'
    || (!worktreeBranchPreferenceReady && !worktreeBranchPreferenceError);
  const worktreeBranchSheetVisible = worktreeBranchSheetOpen
    && worktreeEligibility.status === 'eligible'
    && worktreeBranchListMatchesTarget;
  // 勾选展示 = 工作端记忆**原样直出**(2026-07-29 用户裁决:状态只属于用户,系统不做
  // 视觉折叠);项目目标资格不满足时显示 caption 并阻止创建，不能静默降级普通目录。
  const worktreeChecked = worktreeEnabled;
  const worktreeCaptionKey = worktreeEligibilityCaptionKey(worktreeEligibility);
  const worktreeCreateBlocked = shouldBlockNewSessionCreateForWorktree({
    applicable: worktreeApplicable,
    enabled: worktreeEnabled,
    eligibility: worktreeEligibility,
    preferenceSaving: worktreePreferenceSaving,
  })
    || worktreePreferenceCreateBlocked
    || (worktreeEnabled && worktreeBranchPreferenceSaving)
    || (worktreeEnabled
      && worktreeEligibility.status === 'eligible'
      && (!worktreeBranchPreferenceReady || worktreeBranchPreferenceError));
  const worktreeControlCaptionKey = worktreeCaptionKey
    ?? (worktreeBranchPreferenceError ? 'session.new.worktreeBranchSyncFailed' : null);

  useLayoutEffect(() => {
    worktreePreferenceRenderedRef.current = {
      deviceId: selectedDeviceId,
      enabled: worktreePreference.enabled,
      revision: worktreePreference.revision,
    };
    const transaction = worktreePreferenceTransactionRef.current;
    if (
      !transaction
      || (transaction.status !== 'reconciling' && transaction.status !== 'committed')
      || transaction.deviceId !== selectedDeviceId
      || worktreePreference.enabled !== transaction.enabled
      || worktreePreference.revision <= transaction.revisionAtStart
    ) return;
    worktreePreferenceTransactionRef.current = null;
    if (worktreePreferenceWriteTargetRef.current === transaction.deviceId) {
      worktreePreferenceWriteTargetRef.current = null;
    }
    setWorktreePreferenceSavingDeviceId(null);
  }, [selectedDeviceId, worktreePreference.enabled, worktreePreference.revision]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    const transaction = worktreePreferenceTransactionRef.current;
    if (
      transaction?.deviceId === selectedDeviceId
      && transaction.status === 'reconciling'
      && worktreePreference.revision > transaction.revisionAtStart
      && worktreePreference.enabled !== transaction.enabled
    ) {
      // The host echoed a different authoritative value. Do not silently use
      // it for this Create attempt: release the active spinner, retain the
      // user's requested value as an unknown obligation, and allow a retry.
      worktreePreferenceAuthorityUnknownByDeviceRef.current.set(selectedDeviceId, {
        enabled: transaction.enabled,
        revisionAtStart: transaction.revisionAtStart,
      });
      worktreePreferenceTransactionRef.current = null;
      if (worktreePreferenceWriteTargetRef.current === selectedDeviceId) {
        worktreePreferenceWriteTargetRef.current = null;
      }
      setWorktreePreferenceSavingDeviceId(null);
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
    }
    const pending = worktreePreferenceAuthorityUnknownByDeviceRef.current.get(selectedDeviceId);
    if (
      !pending
      || worktreePreference.revision <= pending.revisionAtStart
      || worktreePreference.enabled !== pending.enabled
    ) return;
    worktreePreferenceAuthorityUnknownByDeviceRef.current.delete(selectedDeviceId);
    setWorktreePreferenceAuthorityVersion((value) => value + 1);
  }, [selectedDeviceId, worktreePreference.enabled, worktreePreference.revision]);

  const settleRenderedWorktreeBranchTransaction = useCallback((
    key: string,
    sourceBranch: string,
    syncKey: string,
  ) => {
    const transaction = worktreeBranchPreferenceTransactionRef.current;
    if (
      !transaction
      || transaction.status !== 'committed'
      || transaction.key !== key
      || transaction.sourceBranch !== sourceBranch
    ) return false;
    worktreeBranchPreferenceTransactionRef.current = null;
    if (worktreeBranchPreferenceWriteTargetRef.current === transaction.key) {
      worktreeBranchPreferenceWriteTargetRef.current = null;
    }
    setWorktreeBranchPreferenceSavingKey(null);
    setWorktreeBranchPreferenceErrorKey(null);
    worktreeBranchPreferenceReadyKeyRef.current = syncKey;
    setWorktreeBranchPreferenceReadyKey(syncKey);
    return true;
  }, []);

  useLayoutEffect(() => {
    worktreeBranchRenderedRef.current = {
      key: worktreeBranchPreferenceKey,
      sourceBranch: worktreeSourceBranch,
    };
    settleRenderedWorktreeBranchTransaction(
      worktreeBranchPreferenceKey,
      worktreeSourceBranch,
      worktreeBranchPreferenceSyncKey,
    );
  }, [
    settleRenderedWorktreeBranchTransaction,
    worktreeBranchPreferenceKey,
    worktreeBranchPreferenceSyncKey,
    worktreeSourceBranch,
  ]);

  const captureWorktreeCreateIntent = useCallback((): WorktreeCreateIntentSnapshot => {
    const target = { ...worktreeBranchTargetRef.current };
    const eligibility = worktreeEligibilityRef.current;
    const branchPreferenceKey = target.deviceId && eligibility.status === 'eligible'
      ? `${target.deviceId}\u0000${eligibility.baseRepo}`
      : '';
    return {
      applicable: target.deviceId.length > 0 && target.workingDir.trim().length > 0,
      enabled: target.deviceId
        ? remoteSessionStore.getNewMakerWorktreePreference(target.deviceId).enabled
        : false,
      target,
      eligibility,
      sourceBranch: worktreeSourceBranchRef.current,
      preferenceSyncKey: worktreePreferenceSyncKeyRef.current,
      branchPreferenceKey,
      branchPreferenceSyncKey: worktreeBranchPreferenceSyncKeyRef.current,
    };
  }, []);

  const isWorktreeCreateIntentCurrent = useCallback((
    intent: WorktreeCreateIntentSnapshot,
  ): boolean => {
    if (!intent.applicable) return true;
    const currentTarget = worktreeBranchTargetRef.current;
    if (
      deviceLinkStatusRef.current !== 'online'
      || currentTarget.deviceId !== intent.target.deviceId
      || currentTarget.workingDir.trim() !== intent.target.workingDir.trim()
    ) return false;
    // ineligible 目标不创建 worktree,无需等偏好同步/就绪——提前返回,
    // 避免偏好 GET 在途时被下方偏好守卫拦截;与 enabled 无关(2026-08-07 裁决)。
    // 但快照不能替代实时状态:await 期间同目标可能被重探回 probing/eligible/
    // detect-failed,旧 ineligible 快照必须复核 live ref 仍为 ineligible 才放行,
    // 否则回到 fail closed(探测未定不等于确认不合格)。
    if (intent.eligibility.status === 'ineligible') {
      return worktreeEligibilityRef.current.status === 'ineligible';
    }
    if (
      worktreePreferenceSyncKeyRef.current !== intent.preferenceSyncKey
      || worktreePreferenceReadyKeyRef.current !== intent.preferenceSyncKey
      || worktreePreferenceWriteTargetRef.current === intent.target.deviceId
      || worktreePreferenceAuthorityUnknownByDeviceRef.current.has(intent.target.deviceId)
    ) return false;
    const currentEnabled = remoteSessionStore
      .getNewMakerWorktreePreference(intent.target.deviceId).enabled;
    if (currentEnabled !== intent.enabled) return false;
    if (!intent.enabled) return true;
    // ineligible 已在前面提前返回,此处只可能是 eligible(2026-08-07 裁决)。
    if (intent.eligibility.status !== 'eligible') return false;
    // 与 ineligible 快照同理:eligible 快照也必须复核 live 资格仍是同一 repo 的
    // eligible,await 期间被重探成别的状态或换了 repo 都不能继续建 worktree。
    const currentEligibility = worktreeEligibilityRef.current;
    if (
      currentEligibility.status !== 'eligible'
      || currentEligibility.baseRepo !== intent.eligibility.baseRepo
    ) return false;
    const currentStoredBranch = remoteSessionStore.getNewMakerWorktreeBranchPreference(
      intent.target.deviceId,
      currentEligibility.baseRepo,
    );
    const currentSourceBranch = isValidWorktreeBranchPreferenceSnapshot(
      currentStoredBranch,
      currentEligibility.baseRepo,
    )
      ? currentStoredBranch.sourceBranch
      : worktreeSourceBranchRef.current;
    if (currentSourceBranch !== intent.sourceBranch) return false;
    const branchTransaction = worktreeBranchPreferenceTransactionRef.current;
    return worktreeBranchPreferenceSyncKeyRef.current === intent.branchPreferenceSyncKey
      && worktreeBranchPreferenceReadyKeyRef.current === intent.branchPreferenceSyncKey
      && worktreeBranchPreferenceWriteTargetRef.current !== intent.branchPreferenceKey
      && !(
        branchTransaction?.key === intent.branchPreferenceKey
        && (branchTransaction.status === 'writing' || branchTransaction.status === 'unknown')
      );
  }, []);
  const createValidation = useMemo(
    () => validateNewSessionDraft(draft, draftContent),
    [draft, draftContent],
  );
  const composerHasMessage = draft.firstMessage.trim().length > 0;
  // 「按下即录」的乐观反馈(与会话页/桌面同款,详见 [sessionId].tsx 同名状态注释)。
  // 声明在 composerShowCreateButton 之前:pending 期就要占住创建槽。
  const [voiceStartPending, setVoiceStartPending] = useState(false);
  const voiceStartPendingSeqRef = useRef(0);
  const voiceStartedOnPressInRef = useRef(false);
  // 语音生命周期内创建按钮常驻(与会话页发送槽同理,对齐桌面):录音中点创建
  // = 结束录音并用转写创建(create() 已有 listening 分支);否则首段转写落地的
  // 瞬间按钮冒出来,右对齐工具排会把语音胶囊整格推左。乐观 pending 期同理占位,
  // 避免胶囊先在 12pt 档展开、listening 一到又跳 52pt 档。voiceIsBusy 在下方
  // 声明,这里直接展开同一表达式,避免声明顺序对调。
  const composerShowCreateButton = composerHasMessage
    || attachments.length > 0
    || pendingUploads.length > 0
    || voiceStartPending
    || voiceState === 'listening'
    || voiceState === 'submitting'
    || voiceState === 'refining';
  const voiceUiAvailable = shouldShowMobileVoiceUi(Platform.OS);
  const voiceIsListening = voiceState === 'listening';
  const voiceIsProcessing = voiceState === 'submitting' || voiceState === 'refining';
  // 只有一台可选设备时无可切换项:禁用下拉、隐藏 ⇕(用户反馈:单选项不要出选框)。
  const deviceHasChoices = deviceOptions.length > 1;
  const deviceSelectorDisabled = creating || voiceIsProcessing || !deviceHasChoices;
  // 上传中不再挡创建:附件走乐观管线(pendingUploads),create() 内部会 await 全部
  // 在途上传落定后再组首条消息,抢点创建不会丢图(#589 的 attachmentBusy 门由此取代)。
  // listening 时**只**豁免「缺正文/附件」这一条校验:此刻点创建 = 结束录音并用
  // 转写创建(create() 的 listening 分支),最终转写在 create() 内部重新校验;
  // 不豁免的话空草稿录音期间创建按钮永远按不动。缺项目路径/模型等其它校验不
  // 豁免——那些不会被转写补上,放行只会「可点但必失败」(review 二轮收窄)。
  // validateNewSessionDraft 的校验顺序是 路径→模型→正文,命中缺正文文案即代表
  // 前两项都已通过。
  // 结构化判定,不比对本地化文案:locale 异步恢复(如深链直达后语言落地)时
  // memo 住的旧语言校验文案与新 t() 输出不等,字符串比对会让豁免静默失效
  // (review 三轮收口)。
  const createValidationIsMissingPayload = useMemo(
    () => isNewSessionDraftMissingPayloadOnly(draft, draftContent),
    [draft, draftContent],
  );
  const canCreate = (!createValidation || (voiceIsListening && createValidationIsMissingPayload))
    && !creating
    && !voiceIsProcessing
    && !worktreeCreateBlocked;
  const voiceIsBusy = voiceIsListening || voiceIsProcessing;
  // 录音计时(红点+m:ss 胶囊,与会话页/桌面同形态);pillWidth 同步驱动工具排占位。
  // counting 只认真实采集,启动链路(权限弹窗等)不计入时长,pending 期显示 0:00。
  const voiceRecordingTimer = useMobileVoiceRecordingTimer({
    expanded: voiceIsListening || voiceStartPending,
    counting: voiceIsListening,
  });
  // 手机语音只保留官方托管路径,错误引导仅剩系统麦克风权限一条。
  const canOpenVoiceSettings = isMobileVoiceMicPermissionError(voiceError);
  // 状态行只承载错误信息;「正在听 / 转写中」不再占一行,对齐桌面版——
  // 录音状态由输入框内的语音按钮形态(Mic / 红点计时胶囊 / spinner)表达。
  const voiceStatusVisible = voiceUiAvailable && Boolean(voiceError);
  const composerVoicePlacement = voiceUiAvailable
    ? resolveMobileComposerVoiceButtonPlacement({
      // 行尾有创建按钮时让位;附件-only(无文字)同样命中(composerShowCreateButton 含附件判定)。
      hasTrailingAction: composerShowCreateButton,
    })
    : undefined;
  const composerInputContentHeight = firstMessageInputContentHeight;
  const keyboardState = useMobileKeyboardState();
  const windowDimensions = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  // 权限独立浮窗的档位高度(与模型浮窗同一套 sheet 高度模型;useMemo 保持身份稳定)。
  const permissionSheetHeights = useMemo(
    () => computeContextSheetSnapHeights({
      safeAreaTopInset: safeAreaInsets.top,
      screenHeight: windowDimensions.height,
    }),
    [safeAreaInsets.top, windowDimensions.height],
  );
  // 聚焦 / 面板打开 / 语音中呈现卡片形态（输入区全宽 + 底部工具排），其余保持单行简洁态。
  // 语音结束后草稿仍有内容时经 hold 保持展开(一行文字也不收),
  // 不随 voiceIsBusy 归零塌回简洁态。
  const composerVoiceHoldActive = resolveComposerVoiceHoldActive({
    armed: composerVoiceHoldArmed,
    draftText: draft.firstMessage,
  });
  const composerCardActive = firstMessageInputFocused
    || modelSheetOpen
    || permissionSheetOpen
    || voiceIsBusy
    || composerVoiceHoldActive;
  useComposerCardTransition(composerCardActive);
  // 下拉收起 = 退出聚焦激活态(模型浮窗已是独立 Modal,拖拽手势够不到它,无需在此关闭)。
  // 语音结束 hold 态未聚焦,blur 是 no-op,需显式解除 hold 才能收回简洁态。
  const handleComposerSnapToAuto = useCallback(() => {
    setComposerVoiceHoldArmed(false);
    firstMessageInputRef.current?.blur();
  }, []);
  const composerResize = useComposerResize({
    autoMaxContentHeight: MOBILE_COMPOSER_INPUT_MAX_HEIGHT,
    // 简洁态一律收到单行(下拉收起和点别处收键盘的结果一致);
    // auto / manual 记忆保留,重新聚焦后恢复。
    collapsed: !composerCardActive,
    composerChromeHeight: composerCardActive ? COMPOSER_CARD_CHROME_HEIGHT : COMPOSER_RESIZE_CHROME_HEIGHT,
    contentHeight: composerInputContentHeight,
    keyboardHeight: keyboardState.visible ? keyboardState.height : 0,
    onSnapToAuto: handleComposerSnapToAuto,
    singleLineContentHeight: MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
    windowHeight: windowDimensions.height,
  });
  // manual 高度跨聚焦/失焦、键盘开合保留(用户拖出的高度是显式意图);
  // 唯一自然失效点:草稿清空(发送成功/删光)回 auto,避免空输入框残留定高。
  const composerResizeReset = composerResize.reset;
  useEffect(() => {
    if (draft.firstMessage.length === 0) {
      composerResizeReset();
      // 草稿清空(创建成功/删光)后语音结束 hold 也失去意义,一并解除。
      setComposerVoiceHoldArmed(false);
    }
  }, [draft.firstMessage, composerResizeReset]);
  const composerInputIsMultiline = composerResize.dragging
    || composerResize.mode === 'manual'
    || (draft.firstMessage.length > 0
      && (draft.firstMessage.includes('\n') || composerInputContentHeight > COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD));
  const composerInputScrollEnabled = composerResize.scrollEnabled;
  const voiceDraftShowsListeningPrompt = voiceIsListening && draft.firstMessage.length === 0;
  // 对齐桌面新建会话输入框默认占位(newChat.chatInput.defaultPlaceholder 的 zh-CN 值)。
  const composerPlaceholder = t('session.new.composerPlaceholder');
  const composerListeningPlaceholder = buildSessionComposerLayout({
    attachmentBusy: false,
    attachmentCount: attachments.length + pendingUploads.length,
    attachmentPickerOpen: false,
    canStop: false,
    draftText: draft.firstMessage,
    queueBusy: false,
    sending: creating,
    voiceState,
  }).input.placeholder;
  const composerTrigger = useMemo(() => detectComposerTrigger(draft.firstMessage), [draft.firstMessage]);
  const composerAtQuery = composerTrigger.kind === 'at' ? composerTrigger.query : '';
  const visibleSlashCommands = useMemo(
    () => composerTrigger.kind === 'slash'
      ? filterSlashCommands(slashCommands, composerTrigger.query, 5)
      : [],
    [composerTrigger, slashCommands],
  );
  const visibleAtResources = useMemo(
    () => composerTrigger.kind === 'at'
      ? filterAtResources(atResources, composerTrigger.query, 5)
      : [],
    [atResources, composerTrigger],
  );
  const visibleBrowseEntries = useMemo(
    () => filterRemoteDirectoryEntries(browseEntries, showHiddenDirectories),
    [browseEntries, showHiddenDirectories],
  );

  const patchDraft = useCallback((patch: Partial<NewSessionDraft>) => {
    if (patch.firstMessage !== undefined) {
      firstMessageRef.current = patch.firstMessage;
      voiceDictionaryLearningTrackerRef.current?.inspectDraft(patch.firstMessage);
    }
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const setFirstMessageDraft = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === 'function' ? next(firstMessageRef.current) : next;
    firstMessageRef.current = value;
    setDraft((current) => ({ ...current, firstMessage: value }));
    voiceDictionaryLearningTrackerRef.current?.inspectDraft(value);
  }, []);

  const handleFirstMessageInputContentSizeChange = useCallback((event: TextInputContentSizeChangeEvent) => {
    const nextHeight = Math.max(
      MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
      Math.ceil(event.nativeEvent.contentSize.height),
    );
    setFirstMessageInputContentHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
    ));
  }, []);

  const handleVoiceDraftTextLayout = useCallback((event: TextLayoutEvent) => {
    const lines = event.nativeEvent.lines;
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return;
    const nextFrame = {
      left: Math.max(0, Math.round(lastLine.x + lastLine.width + COMPOSER_VOICE_CARET_GAP)),
      top: Math.max(0, Math.round(lastLine.y + ((lastLine.height - MOBILE_COMPOSER_INPUT_LINE_HEIGHT) / 2))),
    };
    setVoiceDraftCaretFrame((currentFrame) => (
      currentFrame.left === nextFrame.left && currentFrame.top === nextFrame.top
        ? currentFrame
        : nextFrame
    ));
  }, []);

  const cancelVoiceForDeviceSwitch = useCallback(() => {
    voicePermissionRequestSeqRef.current += 1;
    voicePermissionRequestAbortRef.current?.abort();
    voicePermissionRequestAbortRef.current = null;
    voicePermissionRequestInFlightRef.current = false;
    voiceStartupSeqRef.current += 1;
    const controller = voiceControllerSessionRef.current;
    voiceControllerSessionRef.current = null;
    voiceStartupInFlightRef.current = false;
    voiceStopInFlightRef.current = false;
    voiceRecordingActiveRef.current = false;
    setComposerVoiceHoldArmed(false);
    setVoiceState('idle');
    setVoiceError(null);
    discardPendingPrewarm();
    if (controller) void controller.cancel().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, [setVoiceState]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      // iOS permission sheets and Control Center can briefly report `inactive`.
      // Android permission sheets can report `background`, but permission
      // resolution has not claimed audio resources and must survive that event.
      if (nextState !== 'background') return;
      if (shouldCancelMobileVoiceForBackground({
        startupInFlight: voiceStartupInFlightRef.current,
        recordingActive: voiceRecordingActiveRef.current,
        hasController: Boolean(voiceControllerSessionRef.current),
      })) {
        cancelVoiceForDeviceSwitch();
      } else {
        // pressIn may have opened a speculative ASR connection without creating
        // a controller yet; backgrounding must not leave that parked connection.
        discardPendingPrewarm();
      }
    });
    return () => subscription.remove();
  }, [cancelVoiceForDeviceSwitch]);

  const selectDevice = useCallback((option: NewSessionDeviceOption) => {
    if (creating) return;
    if (
      voicePermissionRequestInFlightRef.current
      || voiceStopInFlightRef.current
      || voiceIsProcessing
    ) return;
    if (voiceStartupInFlightRef.current || voiceRecordingActiveRef.current || voiceState === 'listening') {
      cancelVoiceForDeviceSwitch();
    }
    userTouchedDeviceRef.current = true;
    explicitProviderModelSelectionRef.current = null;
    setSelectedDeviceId(option.deviceId);
    setSelectedDeviceName(option.name || option.deviceId);
    void saveNewSessionPreferences({
      device: {
        deviceId: option.deviceId,
        name: option.name || option.deviceId,
      },
    });
    setDevicePickerOpen(false);
    setError(null);
    setCapabilities(null);
    setBrowseOpen(false);
    setShowHiddenDirectories(false);
    setBrowsePath('');
    setBrowseParent(null);
    setBrowseEntries([]);
    setBrowseError(null);
    setContextSheetOpen(false);
    // 切换电脑丢弃草稿附件前 best-effort 回收已上传的中转对象(codex review #504)。
    for (const attachment of attachments) {
      discardMobileUploadedAttachment(attachment, { getToken: () => auth.getAccessToken() });
    }
    // 在途上传同样作废(codex review R10):不取消的话它们完成后会经 onUploaded 把
    // 上一台电脑期间选的附件塞进新电脑的草稿;丢弃后由控制器在完成时回收 OSS 对象。
    discardAllPendingUploads();
    setAttachments([]);
    setMediaAssetAttachments({});
    setAttachmentPreviews({});
    composerAnnotationsRef.current?.forgetAllAttachments();
    setAttachmentError(null);
    initialWorkspaceKeyRef.current = null;
    setDraft((current) =>
      current.workspaceKind === 'project'
        ? { ...current, workingDir: '' }
        : current);
  }, [attachments, auth, cancelVoiceForDeviceSwitch, creating, discardAllPendingUploads, voiceIsProcessing, voiceState]);

  const handleBack = useCallback(() => {
    // 弹栈返回,保留首页已挂载的状态(设备筛选等)。此前用 replace('/devices') 会重挂载
    // 首页:筛选状态从"所有对话"起步、等 AsyncStorage 异步恢复后才跳回筛选电脑,产生
    // 一次可见闪跳(规则 7)。无栈可退(深链直达)时 goBackGuarded 回落 replace。
    goBackGuarded(router, '/devices');
  }, [router]);

  useEffect(() => {
    if (!selectedDeviceId) {
      capabilitiesSeqRef.current += 1;
      setCapabilities(null);
      setCapabilitiesLoading(false);
      setCapabilitiesError(null);
      return;
    }
    const seq = ++capabilitiesSeqRef.current;
    let cancelled = false;
    const agentKind = draft.agentKind;
    // 能力表按 (设备, agent) 基本不变:缓存命中先画(选择器立即可用),后台静默刷新。
    const capabilitiesCacheKey = buildAgentCapabilitiesCacheKey(selectedDeviceId, agentKind);
    const generation = getAgentCapabilitiesGeneration(selectedDeviceId);
    const applyCapabilities = (next: MobileAgentCapabilities): void => {
      if (cancelled) return;
      setCapabilities(next);
      setCapabilitiesLoading(false);
      setCapabilitiesError(null);
      setDraft((current) => current.agentKind === agentKind
        ? reconcileRuntimeDraftWithCapabilities(current, next, {
          preserveUnknownModel: explicitProviderModelSelectionRef.current === current.model,
        })
        : current);
    };
    const unsubscribe = subscribeAgentCapabilities(selectedDeviceId, agentKind, applyCapabilities);
    const cachedCapabilities = getCachedAgentCapabilities(capabilitiesCacheKey);
    if (cachedCapabilities) {
      setCapabilities(cachedCapabilities);
      setCapabilitiesLoading(false);
      setDraft((current) => current.agentKind === agentKind
        ? reconcileRuntimeDraftWithCapabilities(current, cachedCapabilities, {
          preserveUnknownModel: explicitProviderModelSelectionRef.current === current.model,
        })
        : current);
    } else {
      setCapabilitiesLoading(true);
    }
    setCapabilitiesError(null);
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.getCapabilities(agentKind);
    })
      .then((result) => {
        if (capabilitiesSeqRef.current !== seq) return;
        const normalized = normalizeMobileAgentCapabilities(result);
        if (normalized) {
          // state/draft 只经当前代际 commit 的订阅通知更新，旧请求无法覆盖 revision 新快照。
          commitAgentCapabilities(selectedDeviceId, agentKind, generation, normalized);
          return;
        }
        if (!isAgentCapabilitiesGenerationCurrent(selectedDeviceId, generation)) return;
        if (!normalized && cachedCapabilities) {
          // 缓存已画时保留旧能力表,只报错。
          setCapabilitiesError(t('session.common.capabilitiesUnsupported'));
          return;
        }
        setCapabilities(normalized);
        setCapabilitiesError(normalized ? null : t('session.common.capabilitiesUnsupported'));
      })
      .catch((err) => {
        if (capabilitiesSeqRef.current !== seq) return;
        if (!isAgentCapabilitiesGenerationCurrent(selectedDeviceId, generation)) return;
        if (cachedCapabilities) {
          setCapabilitiesError(formatRemoteError(err));
          return;
        }
        setCapabilities(null);
        setCapabilitiesError(formatRemoteError(err));
      })
      .finally(() => {
        if (
          capabilitiesSeqRef.current === seq
          && isAgentCapabilitiesGenerationCurrent(selectedDeviceId, generation)
        ) setCapabilitiesLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedDeviceId, draft.agentKind, maker, openLink]);

  // Fast 记忆延迟恢复(codex review P1):切/恢复 agent 的瞬间,目标 agent 的能力表
  // 尚未到达(或残留着切换前 agent 的),恢复点只能保守置 false;真正的恢复在这里——
  // 目标 agent 的 capabilities 就绪后,按 (agent, 来源, 模型) 记忆 + 与手动选行同款的
  // fastEditable 门控重评一次,通过才把 fastMode 打开。手动开关会写 draftMemory:
  // 用户主动关过 → 记忆为 false → 本 effect 不会重新打开;创建路径拿到的 fastMode
  // 永远已过目标 agent 门控,不会发出目标不支持的 fastMode:true。
  // 关闭方向(codex review P2):已开启的 fastMode 在 (provider, model) 组合失去
  // Fast 支持(provider revision 下架 / caps 撤销 hasFastMode)时必须同步关闭——
  // 否则 UI 的 rowFastEditable 已显示关、创建仍发 fastMode:true 被拒。仅能力表
  // 与目录均就绪时判定(缓存缺失/加载中不动作,避免切设备瞬间误关)。
  useEffect(() => {
    if (!selectedDeviceId) return;
    // 来源 id 与 changeSelectedFastMode 同口径:显式选了来源用 providerId,默认路由
    // (null)草稿可用推断来源(activeSourceIdRef)开启 Fast——撤销检查不得漏掉它
    // (codex review P2:目录 revision 改变默认来源/移除 Fast 支持时,null-provider
    // 草稿仍在发 fastMode:true)。
    const pid = draft.providerId ?? activeSourceIdRef.current;
    if (!pid) return;
    const capsKnown = getCachedAgentCapabilities(buildAgentCapabilitiesCacheKey(selectedDeviceId, draft.agentKind)) !== undefined;
    if (draft.fastMode) {
      if (
        capsKnown
        && catalogReadyRef.current
        && !isFastRestorable(
          draft.agentKind,
          pid,
          draft.model,
          modelRowsRef.current,
          targetAgentHasFast(selectedDeviceId, draft.agentKind),
        )
      ) {
        setDraft((current) => (
          current.fastMode
          && current.agentKind === draft.agentKind
          && current.model === draft.model
          && current.providerId === draft.providerId
            ? { ...current, fastMode: false }
            : current
        ));
      }
      return;
    }
    if (draftMemory.getFast(draft.agentKind, pid, draft.model) !== true) return;
    if (!isFastRestorable(
      draft.agentKind,
      pid,
      draft.model,
      modelRowsRef.current,
      targetAgentHasFast(selectedDeviceId, draft.agentKind),
    )) return;
    setDraft((current) => (
      !current.fastMode
      && current.agentKind === draft.agentKind
      && current.model === draft.model
      && current.providerId === draft.providerId
        ? { ...current, fastMode: true }
        : current
    ));
    // capabilities / modelRows / deviceProviders.ready 是触发信号(能力表或目录变化
    // 都重评);目标归属由 targetAgentHasFast 的 (设备, agent) 键控缓存校验,不靠
    // state 身份判断。判定体内经 catalogReadyRef 读最新就绪态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, draft.agentKind, draft.model, draft.providerId, draft.fastMode, selectedDeviceId, draftMemory, modelRows, deviceProviders.ready]);

  // 拉被控端 runtime 已注册的 agent 集合(过滤新建 agent 入口)。fail-open:失败/无设备时置 null
  // (不过滤),真正的兜底是被控端 requireAgent。窗口/设备切换重拉,让按需下载补齐的 Pi 及时出现。
  useEffect(() => {
    if (!selectedDeviceId) {
      setAvailableAgentKinds(null);
      return;
    }
    let cancelled = false;
    setAvailableAgentKinds(null);
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.listAvailableAgents();
    })
      .then((agents) => {
        if (cancelled) return;
        setAvailableAgentKinds(
          new Set(
            (Array.isArray(agents) ? agents : []).filter(
              (a): a is NewSessionAgentKind => a === 'claude-code' || a === 'codex' || a === 'pi',
            ),
          ),
        );
      })
      .catch(() => {
        /* fail-open:拉取失败不过滤入口(不因一次隧道抖动抹掉合法 agent)。 */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDeviceId, maker, openLink]);

  useEffect(() => {
    if (!selectedDeviceId || composerTrigger.kind !== 'slash') {
      slashLoadSeqRef.current += 1;
      setSlashCommands([]);
      setSlashPaletteLoading(false);
      setSlashPaletteError(null);
      return;
    }
    const seq = ++slashLoadSeqRef.current;
    const agentKind = draft.agentKind;
    const workingDir = draft.workspaceKind === 'project' ? draft.workingDir.trim() : '';
    const paletteCacheKey = buildComposerPaletteCacheKey(selectedDeviceId, agentKind, workingDir);
    const cachedCommands = readSlashCommandCache(paletteCacheKey);
    if (cachedCommands) {
      // 任意年龄的缓存先画(重开面板不闪 spinner),后台静默刷新覆盖(规则 7)。
      // loading 必须同时清掉:上一轮无缓存请求可能把它置了 true 还没回来(如切设备 /
      // 切 workdir 时面板未关),不清的话 ComposerPaletteFrame 的 spinner 会盖住刚画的缓存行。
      setSlashCommands([...cachedCommands]);
      setSlashPaletteLoading(false);
    } else {
      setSlashPaletteLoading(true);
    }
    setSlashPaletteError(null);
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      const [builtins, skills] = await Promise.all([
        maker.listAgentCommands(agentKind),
        maker.listAgentSkills(agentKind, {
          ...(workingDir ? { workingDir } : {}),
          forceReload: false,
        }),
      ]);
      return { builtins, skills };
    })
      .then(({ builtins, skills }) => {
        if (slashLoadSeqRef.current !== seq) return;
        const builtinCommands = builtins.success && Array.isArray(builtins.commands)
          ? builtins.commands
          : [];
        const skillCommands = skills.success && Array.isArray(skills.skills)
          ? skills.skills
          : [];
        const merged = mergeSlashCommands(builtinCommands, skillCommands);
        // 刷新失败(整体或部分)且缓存已画:保留缓存行、不置 error——
        // ComposerPaletteFrame 的 errorText 渲染在 children 之前,会把刚画的缓存
        // 整体盖住,可用面板被错误文案顶掉正是本 PR 要消除的体验(codex review R18)。
        const partialError = !builtins.success ? (builtins.error ?? 'slash command list failed')
          : !skills.success ? (skills.error ?? 'skill list failed')
            : null;
        if (!partialError) {
          setSlashCommands(merged);
          writeSlashCommandCache(paletteCacheKey, merged);
          setSlashPaletteError(null);
        } else if (!cachedCommands) {
          setSlashCommands(merged);
          setSlashPaletteError(partialError);
        }
      })
      .catch((err) => {
        if (slashLoadSeqRef.current !== seq) return;
        // 同上:缓存已画时保留旧列表且不置 error;无缓存可画才显示错误。
        if (!cachedCommands) {
          setSlashCommands([]);
          setSlashPaletteError(formatRemoteError(err));
        }
      })
      .finally(() => {
        if (slashLoadSeqRef.current === seq) setSlashPaletteLoading(false);
      });
  }, [composerTrigger.kind, selectedDeviceId, draft.agentKind, draft.workingDir, draft.workspaceKind, maker, openLink]);

  useEffect(() => {
    const workingDir = draft.workspaceKind === 'project' ? draft.workingDir.trim() : '';
    if (!selectedDeviceId || composerTrigger.kind !== 'at' || !workingDir) {
      atLoadSeqRef.current += 1;
      setAtResources([]);
      setAtPaletteLoading(false);
      setAtPaletteError(null);
      setAtResourcesTruncated(false);
      return;
    }
    // 与会话页同款(见 [sessionId].tsx @ 面板 effect 的注释):打开拉一次全量进缓存,
    // 未截断 → 逐键纯本地过滤;截断 → 先画缓存,debounce 后带 query 补搜。
    const agentKind = draft.agentKind;
    const paletteCacheKey = buildComposerPaletteCacheKey(selectedDeviceId, agentKind, workingDir);
    const query = composerAtQuery.trim();
    const cachedScan = readAtResourceScanCache(paletteCacheKey);
    if (cachedScan) {
      setAtResources([...cachedScan.result.items]);
      setAtResourcesTruncated(cachedScan.result.truncated);
      setAtPaletteError(null);
      if (cachedScan.fresh && !cachedScan.result.truncated) {
        // 先作废在途请求再早退:切换会话 / workingDir 时上一个 scan 可能仍在天上,
        // 不递增 seq 它就仍匹配当前代,回来会用旧目录的结果覆盖刚画的缓存。
        atLoadSeqRef.current += 1;
        setAtPaletteLoading(false);
        return;
      }
    }
    const remoteQuery = cachedScan?.result.truncated ? (query || undefined) : undefined;
    const seq = ++atLoadSeqRef.current;
    // 缓存已画时 loading 置 false(而非跳过):ComposerPaletteFrame 的 spinner 会整体
    // 顶掉 children,置 true 会把刚画的缓存闪成「读取中」,而上一轮无缓存请求残留的
    // true 不清掉同样会盖住缓存行(与 slash 的缓存命中清 loading 同口径)。
    setAtPaletteLoading(!cachedScan);
    setAtPaletteError(null);
    const timer = setTimeout(() => {
      void withTransientRemoteRetry(async () => {
        await openLink(selectedDeviceId);
        return maker.scanAtResources(agentKind, {
          workingDir,
          cap: 2000,
          query: remoteQuery,
        });
      })
        .then((result) => {
          if (atLoadSeqRef.current !== seq) return;
          if (!result.success) {
            // 缓存已画时保留旧列表且不置 error——errorText 会盖住已画的缓存行
            // (codex review R18);无缓存可画才清空并显示错误。
            if (!cachedScan) {
              setAtResources([]);
              setAtResourcesTruncated(false);
              setAtPaletteError(result.error ?? 'resource scan failed');
            }
            return;
          }
          const items = Array.isArray(result.items) ? result.items : [];
          const truncated = result.truncated === true;
          setAtResources(items);
          setAtResourcesTruncated(truncated);
          setAtPaletteError(null);
          if (!remoteQuery) {
            writeAtResourceScanCache(paletteCacheKey, { items, truncated });
            // 同会话页:首拉即截断且已有 query 时立即链式补搜一次(不进缓存)。
            if (truncated && query) {
              void withTransientRemoteRetry(async () => {
                await openLink(selectedDeviceId);
                return maker.scanAtResources(agentKind, {
                  workingDir,
                  cap: 2000,
                  query,
                });
              })
                .then((followup) => {
                  if (atLoadSeqRef.current !== seq) return;
                  if (!followup.success) return;
                  setAtResources(Array.isArray(followup.items) ? followup.items : []);
                  setAtResourcesTruncated(followup.truncated === true);
                })
                .catch(() => undefined);
            }
          }
        })
        .catch((err) => {
          if (atLoadSeqRef.current !== seq) return;
          // 同上:缓存已画时不清列表、不置 error;无缓存可画才显示错误。
          if (!cachedScan) {
            setAtResources([]);
            setAtResourcesTruncated(false);
            setAtPaletteError(formatRemoteError(err));
          }
        })
        .finally(() => {
          if (atLoadSeqRef.current === seq) setAtPaletteLoading(false);
        });
    }, query === '' ? 0 : AT_RESOURCE_QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    composerTrigger.kind,
    composerAtQuery,
    selectedDeviceId,
    draft.agentKind,
    draft.workingDir,
    draft.workspaceKind,
    maker,
    openLink,
  ]);

  const loadBrowsePath = useCallback(async (targetPath: string) => {
    if (!selectedDeviceId) return;
    const seq = ++browseSeqRef.current;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await withTransientRemoteRetry(async () => {
        await openLink(selectedDeviceId);
        return maker.fs.listDir(targetPath.trim() || '~');
      });
      if (seq !== browseSeqRef.current) return;
      setBrowsePath(result.resolvedPath);
      setBrowseParent(result.parent);
      setBrowseEntries(result.entries);
    } catch (err) {
      if (seq !== browseSeqRef.current) return;
      setBrowseEntries([]);
      setBrowseError(formatRemoteError(err));
    } finally {
      if (seq === browseSeqRef.current) setBrowseLoading(false);
    }
  }, [selectedDeviceId, maker, openLink]);

  const selectWorkingDir = useCallback((workingDir: string) => {
    patchDraft({ workingDir });
    setBrowseOpen(false);
    setBrowseError(null);
    setShowHiddenDirectories(false);
  }, [patchDraft]);

  const selectDialogueWorkspace = useCallback(() => {
    patchDraft({ workspaceKind: 'dialogue', workingDir: '' });
    setWorkspacePickerOpen(false);
    setBrowseOpen(false);
    setShowHiddenDirectories(false);
  }, [patchDraft]);

  const selectRecentProject = useCallback((workingDir: string) => {
    patchDraft({ workspaceKind: 'project', workingDir });
    setWorkspacePickerOpen(false);
    setBrowseOpen(false);
    setShowHiddenDirectories(false);
  }, [patchDraft]);

  const openProjectBrowse = useCallback(() => {
    patchDraft({ workspaceKind: 'project' });
    setWorkspacePickerOpen(false);
    setBrowseOpen(true);
    // 用户显式选择浏览时,消费初始工作区决策,避免 auto-select effect 关掉浏览改选最近项目。
    initialWorkspaceKeyRef.current = `${selectedDeviceId}:${initialWorkingDir ?? ''}`;
    void loadBrowsePath(draft.workingDir.trim() || '~');
  }, [draft.workingDir, loadBrowsePath, patchDraft, selectedDeviceId, initialWorkingDir]);

  // 选「供应商 + 模型」(provider-aware):resolveRowSelection 原子落 model + providerId +
  // effort + fast 四件套(effort 优先级与桌面同源:该来源记忆 → 沿用当前档 → 模型默认;
  // 同模型换来源不沿用当前档;fast 按 (来源, 模型) 记忆恢复,fastEditable 门控)。
  const selectProviderModelRow = useCallback((row: ProviderModelRow) => {
    userTouchedRuntimeRef.current = true; // 用户手动选了模型 → 不再自动覆盖运行配置
    runtimeActionSeqRef.current += 1; // 使在途的切 agent/恢复回调失效(最新者胜)
    setDraft((current) => {
      const next = resolveRowSelection({
        row,
        agentKind: current.agentKind,
        currentModelId: current.model,
        currentProviderId: current.providerId,
        currentEffort: current.effort,
        hasFastModeCap: capabilities?.hasFastMode === true,
        memory: draftMemory,
      });
      explicitProviderModelSelectionRef.current = next.model;
      // 选定即记忆该 (来源, 模型) 的 effort(对齐桌面「选定后写记忆」),下次选回可恢复。
      if (next.effort) draftMemory.setEffort(current.agentKind, next.providerId, next.model, next.effort);
      return {
        ...current,
        model: next.model,
        providerId: next.providerId,
        effort: next.effort,
        fastMode: next.fastMode,
      };
    });
    setModelSheetOpen(false);
  }, [capabilities, draftMemory]);

  // 扁平回退(被控端 0 供应商):只落 model、清来源(默认路由),effort 跟随 capabilities reconcile。
  const selectFlatModel = useCallback((option: MobileModelOption) => {
    userTouchedRuntimeRef.current = true; // 用户手动选了模型 → 不再自动覆盖运行配置
    runtimeActionSeqRef.current += 1; // 使在途的切 agent/恢复回调失效(最新者胜)
    explicitProviderModelSelectionRef.current = null;
    setDraft((current) =>
      reconcileRuntimeDraftWithCapabilities({ ...current, model: option.id, providerId: null }, capabilities));
    setModelSheetOpen(false);
  }, [capabilities]);

  // 选中行的 effort/fast 变更:落 draft(live 真相)+ 写草稿记忆(下次选回恢复)。
  // 记忆槽的来源 id:显式选中的来源,未显式选时用当前高亮的默认来源(activeSourceIdRef)。
  const changeSelectedEffort = useCallback((effort: string) => {
    userTouchedRuntimeRef.current = true;
    setDraft((current) => {
      const pid = current.providerId ?? activeSourceIdRef.current;
      if (effort && pid) draftMemory.setEffort(current.agentKind, pid, current.model, effort);
      return { ...current, effort };
    });
  }, [draftMemory]);
  const changeSelectedFastMode = useCallback((enabled: boolean) => {
    userTouchedRuntimeRef.current = true;
    setDraft((current) => {
      const pid = current.providerId ?? activeSourceIdRef.current;
      if (pid) draftMemory.setFast(current.agentKind, pid, current.model, enabled);
      return { ...current, fastMode: enabled };
    });
  }, [draftMemory]);

  const toggleModelPicker = useCallback(() => {
    setWorkspacePickerOpen(false);
    setAgentPickerOpen(false);
    setPermissionSheetOpen(false);
    setWorktreeBranchSheetOpen(false);
    setModelSheetOpen(true);
  }, []);

  const openPermissionPicker = useCallback(() => {
    setDevicePickerOpen(false);
    setWorkspacePickerOpen(false);
    setAgentPickerOpen(false);
    setModelSheetOpen(false);
    setWorktreeBranchSheetOpen(false);
    setPermissionSheetSnap('half');
    setPermissionSheetOpen(true);
  }, []);

  // 选权限档(独立选择器与模型浮窗共用同一语义):Full access 升级先过确认弹层,
  // 非 plan 档写 per-agent 记忆(内存 + 落盘;对齐桌面 lastByVendor)。
  const selectPermissionMode = useCallback((mode: string) => {
    void (async () => {
      if (!await confirmFullAccessChange(draft.permissionMode, mode)) return;
      patchDraft({ permissionMode: mode });
      if (mode === 'plan') return; // 老被控端兼容档,不入记忆
      // 同步进本地 state:本次会话内切走再切回也能拿到最新记忆(落盘不回写 state)。
      setNewSessionPreferences((prev) => prev
        ? {
            ...prev,
            permissionModeByAgent: { ...prev.permissionModeByAgent, [draft.agentKind]: mode },
          }
        : prev);
      void saveNewSessionPreferences({
        permissionModeForAgent: { agentKind: draft.agentKind, mode },
      });
    })();
  }, [draft.agentKind, draft.permissionMode, patchDraft]);

  // —— worktree 资格探测:目录 / 设备 / 链路变化即重探(seq 防竞态,旧结果作废)。
  // CHANNEL_NOT_ALLOWED(老被控端)→ unsupported；OFF 时隐藏，旧 ON 镜像保留关闭
  // 入口；其余失败保留行但禁用。
  useEffect(() => {
    const cwd = draft.workspaceKind === 'project' ? draft.workingDir.trim() : '';
    const seq = ++worktreeDetectSeqRef.current;
    const target = {
      deviceId: selectedDeviceId ?? '',
      workingDir: cwd,
      probeGeneration: `${connectionEpoch}\u0000${presenceVersion}`,
    };
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const probingEligibility: NewSessionWorktreeEligibility = { status: 'probing' };
    worktreeEligibilityRef.current = probingEligibility;
    setWorktreeProbe({ target, eligibility: probingEligibility });
    // Relay 离线时不把预期的 NOT_CONNECTED 固化成 detect-failed；online /
    // connectionEpoch / presenceVersion 变化后自动重探，覆盖手机重连和工作端
    // 重新上线两种路径。
    if (!selectedDeviceId || !cwd || deviceLinkStatus !== 'online') return undefined;
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.worktree.detectCwd(cwd);
    }, { maxAttempts: 2 })
      .then((result) => {
        if (cancelled || seq !== worktreeDetectSeqRef.current) return;
        const eligibility = resolveWorktreeEligibility(result, cwd);
        worktreeEligibilityRef.current = eligibility;
        setWorktreeProbe({
          target,
          eligibility,
          supportsRecoveryKeyDiscard: result.supportsRecoveryKeyDiscard === true,
        });
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== worktreeDetectSeqRef.current) return;
        const eligibility = worktreeEligibilityFromError(err);
        worktreeEligibilityRef.current = eligibility;
        setWorktreeProbe({
          target,
          eligibility,
          ...(eligibility.status === 'unsupported'
            ? { supportsRecoveryKeyDiscard: false }
            : {}),
        });
        if (eligibility.status === 'recovering') {
          // 换网后 relay 可能已 online，但旧 peer link 仍在 ACK/握手恢复窗口；连接
          // epoch/presence 未必再次变化，不能要求用户重选目录才能触发下一轮探测。
          retryTimer = setTimeout(() => {
            if (!cancelled) setWorktreeDetectRetryNonce((value) => value + 1);
          }, 1_500);
        }
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    connectionEpoch,
    deviceLinkStatus,
    presenceVersion,
    worktreeDetectRetryNonce,
    selectedDeviceId,
    draft.workspaceKind,
    draft.workingDir,
    maker,
    openLink,
  ]);

  // 换设备 / 工作目录 = 换 branch target：关闭旧 sheet，作废旧 pull/write，并清列表。
  // 创建时直接从 repo-scoped host store 取分支，不保留组件内 selection 副本。
  useEffect(() => {
    worktreeBranchListSeqRef.current += 1;
    worktreeBranchPreferencePullSeqRef.current += 1;
    worktreeBranchPreferenceWriteSeqRef.current += 1;
    worktreeBranchPreferenceWriteTargetRef.current = null;
    worktreeBranchPreferenceTransactionRef.current = null;
    worktreeBranchPreferenceAuthorityReadRef.current = null;
    worktreeBranchPreferenceReadyKeyRef.current = null;
    setWorktreeBranchPreferenceReadyKey(null);
    setWorktreeBranchPreferenceSavingKey(null);
    setWorktreeBranchPreferenceErrorKey(null);
    setWorktreeBranchCompatibilitySelection(null);
    setWorktreeBranchSheetOpen(false);
    setWorktreeBranchList(null);
  }, [selectedDeviceId, draft.workspaceKind, draft.workingDir]);

  // Host 是 repo-scoped sourceBranch 的单一真相。先按 canonical baseRepo pull，随后
  // maker:new-maker-worktree-branch:changed push 会更新同一 store 镜像；旧 pull 由
  // host revision + 本地 target/seq 双重 fence 拒绝，不能盖过桌面端较新的选择。
  useEffect(() => {
    const seq = ++worktreeBranchPreferencePullSeqRef.current;
    if (
      !selectedDeviceId
      || deviceLinkStatus !== 'online'
      || worktreeEligibility.status !== 'eligible'
    ) return;
    const target = {
      deviceId: selectedDeviceId,
      workingDir: draft.workspaceKind === 'project' ? draft.workingDir.trim() : '',
    };
    const baseRepo = worktreeEligibility.baseRepo;
    const syncKey = worktreeBranchPreferenceSyncKey;
    const key = worktreeBranchPreferenceKey;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const currentRead = worktreeBranchPreferenceAuthorityReadRef.current;
    if (currentRead?.syncKey !== syncKey) {
      // A new host process may restart its repo revision from one. Suppress the
      // snapshot rendered from the previous connection, clear it from the store,
      // and require a fresh GET/push object for this connection generation.
      worktreeBranchPreferenceAuthorityReadRef.current = {
        syncKey,
        ignoredSnapshot: remoteSessionStore.getNewMakerWorktreeBranchPreference(
          selectedDeviceId,
          baseRepo,
        ),
      };
      worktreeBranchPreferenceReadyKeyRef.current = null;
      setWorktreeBranchPreferenceReadyKey(null);
      setWorktreeBranchPreferenceErrorKey(null);
      remoteSessionStore.clearNewMakerWorktreeBranchPreference(selectedDeviceId, baseRepo);
    } else if (worktreeBranchPreferenceReadyKeyRef.current === syncKey) {
      return undefined;
    }
    const markReady = () => {
      worktreeBranchPreferenceReadyKeyRef.current = syncKey;
      setWorktreeBranchPreferenceReadyKey(syncKey);
      setWorktreeBranchPreferenceErrorKey(null);
    };
    const markUnavailable = () => {
      worktreeBranchPreferenceReadyKeyRef.current = null;
      setWorktreeBranchPreferenceReadyKey(null);
      setWorktreeBranchPreferenceErrorKey(key);
    };
    const scheduleRetry = () => {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        if (
          !cancelled
          && worktreeBranchPreferenceReadyKeyRef.current !== syncKey
        ) {
          setWorktreeBranchPreferencePullRetryNonce((value) => value + 1);
        }
      }, 1_500);
    };
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.getNewMakerWorktreeBranchPref(baseRepo);
    }, { maxAttempts: 2 })
      .then((snapshot) => {
        const latestTarget = worktreeBranchTargetRef.current;
        if (!shouldAcceptWorktreeBranchListResult({
          requestSeq: seq,
          latestSeq: worktreeBranchPreferencePullSeqRef.current,
          requestTarget: target,
          latestTarget,
        })) return;
        if (snapshot === null) {
          // GET(null) 可能落在更晚的 branch push 之后。clear-at-start 已经
          // 丢弃了旧 host revision；此时仍有 snapshot 就说明 push 属于当前
          // connection epoch，不能让迟到的 null 擦掉它。
          const newerPush = remoteSessionStore.getNewMakerWorktreeBranchPreference(
            selectedDeviceId,
            baseRepo,
          );
          if (newerPush !== null) return;
          const transaction = worktreeBranchPreferenceTransactionRef.current;
          if (transaction?.key === key && transaction.status === 'unknown') {
            // A lost APPLY acknowledgement means null is not enough to prove
            // whether the write committed before this read raced it. Keep ON
            // closed, but leave the branch picker interactive for an explicit retry.
            markUnavailable();
            scheduleRetry();
            return;
          }
          remoteSessionStore.clearNewMakerWorktreeBranchPreference(selectedDeviceId, baseRepo);
          setWorktreeBranchCompatibilitySelection(null);
          markReady();
          return;
        }
        if (!isValidWorktreeBranchPreferenceSnapshot(snapshot, baseRepo)) {
          const newerPush = remoteSessionStore.getNewMakerWorktreeBranchPreference(
            selectedDeviceId,
            baseRepo,
          );
          if (newerPush !== null) return;
          markUnavailable();
          scheduleRetry();
          return;
        }
        setWorktreeBranchCompatibilitySelection(null);
        // The hook-backed snapshot must reach a committed render before the
        // ready fence opens. The observer below performs that final step.
        remoteSessionStore.setNewMakerWorktreeBranchPreference(selectedDeviceId, snapshot);
      })
      .catch((err: unknown) => {
        const latestTarget = worktreeBranchTargetRef.current;
        if (!shouldAcceptWorktreeBranchListResult({
          requestSeq: seq,
          latestSeq: worktreeBranchPreferencePullSeqRef.current,
          requestTarget: target,
          latestTarget,
        })) return;
        // 只有明确的旧端 channel 不支持才允许兼容 fallback。超时、断链和
        // 未知错误必须保持未就绪，避免创建读取旧 branch 状态。
        if (isWorktreeChannelNotAllowedError(err)) {
          const transaction = worktreeBranchPreferenceTransactionRef.current;
          if (transaction?.key === key && transaction.status === 'unknown') {
            transaction.status = 'committed';
            setWorktreeBranchCompatibilitySelection({
              key,
              sourceBranch: transaction.sourceBranch,
            });
            return;
          }
          markReady();
          return;
        }
        markUnavailable();
        scheduleRetry();
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    connectionEpoch,
    deviceLinkStatus,
    presenceVersion,
    worktreeBranchPreferencePullRetryNonce,
    selectedDeviceId,
    draft.workspaceKind,
    draft.workingDir,
    maker,
    openLink,
    worktreeEligibility,
    worktreeBranchPreferenceKey,
    worktreeBranchPreferenceSyncKey,
  ]);

  // A fresh, valid host snapshot can arrive either as the GET result above or
  // as a push after GET timed out. This effect runs after the hook value has
  // committed, so it is also the render fence for branch APPLY completion.
  useEffect(() => {
    const read = worktreeBranchPreferenceAuthorityReadRef.current;
    if (
      !read
      || !worktreeBranchPreferenceKey
      || !worktreeBranchPreferenceSyncKey
      || read.syncKey !== worktreeBranchPreferenceSyncKey
      || remoteWorktreeBranchPreference === null
      || remoteWorktreeBranchPreference === read.ignoredSnapshot
      || !isValidWorktreeBranchPreferenceSnapshot(
        remoteWorktreeBranchPreference,
        worktreeBranchBaseRepo,
      )
    ) return;
    const transaction = worktreeBranchPreferenceTransactionRef.current;
    if (transaction?.key === worktreeBranchPreferenceKey) {
      if (
        remoteWorktreeBranchPreference.revision <= transaction.revisionAtStart
        || remoteWorktreeBranchPreference.sourceBranch !== transaction.sourceBranch
      ) return;
      transaction.status = 'committed';
      settleRenderedWorktreeBranchTransaction(
        worktreeBranchPreferenceKey,
        remoteWorktreeBranchPreference.sourceBranch,
        worktreeBranchPreferenceSyncKey,
      );
      return;
    }
    setWorktreeBranchCompatibilitySelection(null);
    setWorktreeBranchPreferenceErrorKey(null);
    worktreeBranchPreferenceReadyKeyRef.current = worktreeBranchPreferenceSyncKey;
    setWorktreeBranchPreferenceReadyKey(worktreeBranchPreferenceSyncKey);
  }, [
    remoteWorktreeBranchPreference,
    settleRenderedWorktreeBranchTransaction,
    worktreeBranchBaseRepo,
    worktreeBranchPreferenceKey,
    worktreeBranchPreferenceSyncKey,
  ]);

  // —— worktree 源分支：列表只属于当前设备 + cwd；OFF 也允许打开和选择。
  // seq + render 期 target ref 防止切项目/设备时旧请求晚到覆盖新目标。
  const loadWorktreeBranches = useCallback((force = false) => {
    if (!selectedDeviceId || worktreeEligibility.status !== 'eligible') return;
    const target = {
      deviceId: selectedDeviceId,
      workingDir: draft.workingDir.trim(),
    };
    const currentMatches = worktreeBranchList != null
      && worktreeBranchList.target.deviceId === target.deviceId
      && worktreeBranchList.target.workingDir.trim() === target.workingDir;
    if (
      !force
      && currentMatches
      && !worktreeBranchList.loading
      && !worktreeBranchList.failed
    ) return;

    const seq = ++worktreeBranchListSeqRef.current;
    setWorktreeBranchList({ target, branches: [], loading: true, failed: false });
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.worktree.listBranches(worktreeEligibility.baseRepo);
    }, { maxAttempts: 2 })
      .then((result) => {
        const latestTarget = worktreeBranchTargetRef.current;
        if (!shouldAcceptWorktreeBranchListResult({
          requestSeq: seq,
          latestSeq: worktreeBranchListSeqRef.current,
          requestTarget: target,
          latestTarget,
        })) return;
        const branches = Array.from(new Set(
          (result.branches ?? [])
            .filter((branch): branch is string => typeof branch === 'string')
            .map((branch) => branch.trim())
            .filter(Boolean),
        ));
        setWorktreeBranchList({ target, branches, loading: false, failed: false });
      })
      .catch(() => {
        const latestTarget = worktreeBranchTargetRef.current;
        if (!shouldAcceptWorktreeBranchListResult({
          requestSeq: seq,
          latestSeq: worktreeBranchListSeqRef.current,
          requestTarget: target,
          latestTarget,
        })) return;
        setWorktreeBranchList({ target, branches: [], loading: false, failed: true });
      });
  }, [
    draft.workingDir,
    maker,
    openLink,
    selectedDeviceId,
    worktreeBranchList,
    worktreeEligibility,
  ]);

  const openWorktreeBranchPicker = useCallback(() => {
    if (creatingRef.current || worktreeBranchDisabled) return;
    setDevicePickerOpen(false);
    setWorkspacePickerOpen(false);
    setAgentPickerOpen(false);
    setModelSheetOpen(false);
    setPermissionSheetOpen(false);
    setContextSheetOpen(false);
    setBrowseOpen(false);
    setWorktreeBranchSheetSnap('half');
    setWorktreeBranchSheetOpen(true);
    loadWorktreeBranches(false);
  }, [loadWorktreeBranches, worktreeBranchDisabled]);

  const selectWorktreeSourceBranch = useCallback((sourceBranch: string) => {
    if (
      creatingRef.current
      || !selectedDeviceId
      || worktreeEligibility.status !== 'eligible'
    ) return;
    const target = { ...worktreeBranchTargetRef.current };
    const baseRepo = worktreeEligibility.baseRepo;
    const normalizedSourceBranch = sourceBranch.trim();
    if (!normalizedSourceBranch) return;
    const key = `${selectedDeviceId}\u0000${baseRepo}`;
    if (
      worktreeBranchPreferenceSaving
      || worktreeBranchPreferenceWriteTargetRef.current === key
    ) return;
    const writeSeq = worktreeBranchPreferenceWriteSeqRef.current + 1;
    worktreeBranchPreferenceWriteSeqRef.current = writeSeq;
    const revisionAtStart = remoteSessionStore.getNewMakerWorktreeBranchPreference(
      selectedDeviceId,
      baseRepo,
    )?.revision ?? -1;
    const transaction: WorktreeBranchPreferenceWriteTransaction = {
      seq: writeSeq,
      key,
      sourceBranch: normalizedSourceBranch,
      revisionAtStart,
      status: 'writing',
    };
    worktreeBranchPreferenceTransactionRef.current = transaction;
    // State 要到下一次 render 才可见；同步 ref 关闭“选择后立刻创建”读取旧 branch 的窗口。
    worktreeBranchPreferenceWriteTargetRef.current = key;
    setWorktreeBranchPreferenceSavingKey(key);
    setWorktreeBranchPreferenceErrorKey(null);
    setWorktreeBranchCompatibilitySelection({ key, sourceBranch: normalizedSourceBranch });
    setWorktreeBranchSheetOpen(false);
    // 选择分支只写 repo-scoped branch pref，绝不调用 checkbox 的 apply channel。
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.applyNewMakerWorktreeBranchPref(baseRepo, normalizedSourceBranch);
    }, { maxAttempts: 2 })
      .then((snapshot) => {
        if (writeSeq !== worktreeBranchPreferenceWriteSeqRef.current) return;
        const latestTarget = worktreeBranchTargetRef.current;
        if (
          latestTarget.deviceId !== target.deviceId
          || latestTarget.workingDir.trim() !== target.workingDir.trim()
        ) return;
        if (
          !isValidWorktreeBranchPreferenceSnapshot(snapshot, baseRepo)
          || snapshot.sourceBranch !== normalizedSourceBranch
          || snapshot.revision <= revisionAtStart
        ) {
          throw new Error('Invalid worktree branch preference response');
        }
        transaction.status = 'committed';
        remoteSessionStore.setNewMakerWorktreeBranchPreference(selectedDeviceId, snapshot);
        const accepted = remoteSessionStore.getNewMakerWorktreeBranchPreference(
          selectedDeviceId,
          baseRepo,
        );
        if (!accepted || accepted.revision <= revisionAtStart) {
          throw new Error('Worktree branch preference was not accepted');
        }
        transaction.sourceBranch = accepted.sourceBranch;
        const rendered = worktreeBranchRenderedRef.current;
        if (rendered.key === key && rendered.sourceBranch === accepted.sourceBranch) {
          settleRenderedWorktreeBranchTransaction(
            key,
            accepted.sourceBranch,
            worktreeBranchPreferenceSyncKeyRef.current,
          );
        }
      })
      .catch((err: unknown) => {
        if (writeSeq !== worktreeBranchPreferenceWriteSeqRef.current) return;
        const latestTarget = worktreeBranchTargetRef.current;
        if (
          latestTarget.deviceId === target.deviceId
          && latestTarget.workingDir.trim() === target.workingDir.trim()
        ) {
          const current = remoteSessionStore.getNewMakerWorktreeBranchPreference(
            selectedDeviceId,
            baseRepo,
          );
          if (
            isValidWorktreeBranchPreferenceSnapshot(current, baseRepo)
            && current.revision > revisionAtStart
            && current.sourceBranch === normalizedSourceBranch
          ) {
            transaction.status = 'committed';
            transaction.sourceBranch = current.sourceBranch;
            const rendered = worktreeBranchRenderedRef.current;
            if (rendered.key === key && rendered.sourceBranch === current.sourceBranch) {
              settleRenderedWorktreeBranchTransaction(
                key,
                current.sourceBranch,
                worktreeBranchPreferenceSyncKeyRef.current,
              );
            }
            return;
          }
          if (isWorktreeChannelNotAllowedError(err)) {
            // Old hosts cannot persist this axis. Keep the explicit selection in
            // this draft only; it still must not toggle the Worktree checkbox.
            transaction.status = 'committed';
            setWorktreeBranchCompatibilitySelection({
              key,
              sourceBranch: normalizedSourceBranch,
            });
            return;
          }
          // APPLY may have committed while its ACK was lost. A newer snapshot
          // for a different branch does not satisfy this user's request: keep
          // their branch visible for retry and leave Worktree ON fail-closed
          // until the exact branch is echoed by the host.
          transaction.status = 'unknown';
          worktreeBranchPreferenceReadyKeyRef.current = null;
          setWorktreeBranchPreferenceReadyKey(null);
          setWorktreeBranchPreferenceErrorKey(key);
          setWorktreeBranchCompatibilitySelection({
            key,
            sourceBranch: normalizedSourceBranch,
          });
          if (worktreeBranchPreferenceWriteTargetRef.current === key) {
            worktreeBranchPreferenceWriteTargetRef.current = null;
          }
          setWorktreeBranchPreferenceSavingKey(null);
          setError(formatRemoteError(err));
          setWorktreeBranchPreferencePullRetryNonce((value) => value + 1);
        }
      });
  }, [
    maker,
    openLink,
    selectedDeviceId,
    settleRenderedWorktreeBranchTransaction,
    worktreeBranchPreferenceSaving,
    worktreeEligibility,
  ]);

  // —— worktree 勾选播种:选中设备后读工作端 get-new-maker-defaults 的 worktreeEnabled
  // (vendor 无关,agentKind 只是通道入参,经 ref 读当前值,不因切 agent 重播)。
  // 设备切换 / 链路重连重新播种;老被控端 / 缺字段 / 拉取失败只保留当前镜像。
  // 全新设备在 store 中没有镜像时本来就是默认未勾选,无需失败路径代替宿主写值。
  const worktreeSeedAgentKindRef = useRef(draft.agentKind);
  worktreeSeedAgentKindRef.current = draft.agentKind;
  useEffect(() => {
    const seq = ++worktreeSeedSeqRef.current;
    const syncKey = worktreePreferenceSyncKey;
    const previousRead = worktreePreferenceAuthorityReadRef.current;
    if (previousRead?.syncKey !== syncKey) {
      worktreePreferenceReadyKeyRef.current = null;
      setWorktreePreferenceReadyKey(null);
    }
    if (!selectedDeviceId || !syncKey || deviceLinkStatus !== 'online') return undefined;
    const preferenceRevisionAtStart =
      remoteSessionStore.getNewMakerWorktreePreference(selectedDeviceId).revision;
    worktreePreferenceAuthorityReadRef.current = {
      syncKey,
      revision: preferenceRevisionAtStart,
    };
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const markReady = () => {
      worktreePreferenceReadyKeyRef.current = syncKey;
      setWorktreePreferenceReadyKey(syncKey);
    };
    const scheduleRetry = () => {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        if (!cancelled) setWorktreeSeedRetryNonce((value) => value + 1);
      }, 1_500);
    };
    // 与上面 detect effect 同款:先建链再拉,包瞬态重试——app 后台恢复时 relay 常在
    // 重连窗口,裸调会抛 NOT_CONNECTED 并把工作端持久化的勾选偏好静默播种成未勾。
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      return maker.getNewMakerDefaults(worktreeSeedAgentKindRef.current);
    }, { maxAttempts: 2 })
      .then((defaults) => {
        if (
          cancelled
          || seq !== worktreeSeedSeqRef.current
          || worktreePreferenceSyncKeyRef.current !== syncKey
        ) return;
        // 请求发出后若已收到更晚的 push / 用户点击，旧 pull 不再有覆盖权。
        if (
          remoteSessionStore.getNewMakerWorktreePreference(selectedDeviceId).revision
          !== preferenceRevisionAtStart
        ) return;
        const classification = classifyWorktreePreferenceSeed(defaults);
        if (classification.status === 'ready') {
          // Store revision + committed render jointly release the ready gate via
          // the observer below; do not expose the old checkbox value in-between.
          remoteSessionStore.setNewMakerWorktreePreference(
            selectedDeviceId,
            classification.enabled,
          );
          return;
        }
        if (
          classification.status === 'missing'
          && worktreeHostSupportsRecoveryKeyDiscard === false
        ) {
          // Old hosts cannot persist this preference and also lack the recovery
          // capability marker. A new host can transiently return `{}` before its
          // renderer cache arrives, so missing alone must never authorize OFF.
          markReady();
          return;
        }
        scheduleRetry();
      })
      .catch((error: unknown) => {
        if (
          cancelled
          || seq !== worktreeSeedSeqRef.current
          || worktreePreferenceSyncKeyRef.current !== syncKey
        ) return;
        if (isWorktreeChannelNotAllowedError(error)) {
          markReady();
          return;
        }
        // Timeout/offline/unknown failures cannot authorize the default OFF.
        // Keep both Create and Goal fail-closed and retry on this same link.
        scheduleRetry();
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    connectionEpoch,
    deviceLinkStatus,
    presenceVersion,
    selectedDeviceId,
    worktreeHostSupportsRecoveryKeyDiscard,
    worktreePreferenceSyncKey,
    worktreeSeedRetryNonce,
    maker,
    openLink,
  ]);

  // A same-value push is still authoritative: the store deliberately advances
  // revision for it. Only an observation newer than this connection/read start
  // may release the initial checkbox authority gate.
  useEffect(() => {
    const read = worktreePreferenceAuthorityReadRef.current;
    if (
      !read
      || !worktreePreferenceSyncKey
      || read.syncKey !== worktreePreferenceSyncKey
      || worktreePreference.revision <= read.revision
    ) return;
    worktreePreferenceReadyKeyRef.current = worktreePreferenceSyncKey;
    setWorktreePreferenceReadyKey(worktreePreferenceSyncKey);
  }, [worktreePreference.revision, worktreePreferenceSyncKey]);

  // 用户显式点击开关:先写工作端,工作端接受后才更新手机内存镜像。
  // 资格不满足导致的禁用不会走到这里 —— 环境因素不抹掉用户偏好;
  // 写入失败也不在手机上制造一份假的持久状态。
  const toggleWorktree = useCallback(() => {
    const pendingAuthority = selectedDeviceId
      ? worktreePreferenceAuthorityUnknownByDeviceRef.current.get(selectedDeviceId)
      : undefined;
    if (
      creatingRef.current
      || !selectedDeviceId
      || worktreePreferenceSaving
      || worktreePreferenceWriteTargetRef.current === selectedDeviceId
      || (
        worktreePreferenceReadyKeyRef.current !== worktreePreferenceSyncKeyRef.current
        && !pendingAuthority
      )
    ) return;
    const targetDeviceId = selectedDeviceId;
    const next = pendingAuthority?.enabled
      ?? !remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId).enabled;
    // 播种在途回包不得覆盖用户显式选择(seq 作废旧回包)。
    worktreeSeedSeqRef.current += 1;
    const preferenceRevisionAtStart =
      remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId).revision;
    const writeSeq = worktreePreferenceWriteSeqRef.current + 1;
    worktreePreferenceWriteSeqRef.current = writeSeq;
    if (worktreePreferenceAuthorityUnknownByDeviceRef.current.delete(targetDeviceId)) {
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
    }
    const transaction: WorktreePreferenceWriteTransaction = {
      seq: writeSeq,
      deviceId: targetDeviceId,
      enabled: next,
      revisionAtStart: preferenceRevisionAtStart,
      status: 'writing',
    };
    worktreePreferenceTransactionRef.current = transaction;
    // Set before the first await so an immediate Create/Goal press cannot read
    // the previous checkbox state from a stale render closure.
    worktreePreferenceWriteTargetRef.current = targetDeviceId;
    setWorktreePreferenceSavingDeviceId(targetDeviceId);
    const releaseWrite = () => {
      if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
      if (worktreePreferenceTransactionRef.current?.seq === writeSeq) {
        worktreePreferenceTransactionRef.current = null;
      }
      if (worktreePreferenceWriteTargetRef.current === targetDeviceId) {
        worktreePreferenceWriteTargetRef.current = null;
      }
      setWorktreePreferenceSavingDeviceId(null);
    };
    const markAuthorityUnknown = () => {
      if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
      worktreePreferenceAuthorityUnknownByDeviceRef.current.set(targetDeviceId, {
        enabled: next,
        revisionAtStart: preferenceRevisionAtStart,
      });
      setWorktreePreferenceAuthorityVersion((value) => value + 1);
      releaseWrite();
      setWorktreeSeedRetryNonce((value) => value + 1);
    };
    const armCommittedRender = () => {
      if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
      transaction.status = 'committed';
      const rendered = worktreePreferenceRenderedRef.current;
      if (
        rendered.deviceId === targetDeviceId
        && rendered.enabled === next
        && rendered.revision > preferenceRevisionAtStart
      ) releaseWrite();
    };
    void (async () => {
      try {
        const outcome = await applyWorktreePreferenceOnHost({
          enabled: next,
          apply: maker.applyNewMakerWorktreePref,
          // unsupported 可能是“有偏好写穿、缺安全 worktree 能力”，也可能是最老端
          // 连偏好 channel 都没有：先写 host；只有后者且用户明确点 OFF 时才清手机
          // 保留的旧 ON 镜像。断连/超时不降级，仍保留 ON + fail closed。
          allowUnsupportedDisableFallback:
            !next && worktreeEligibility.status === 'unsupported',
          mirror: (enabled) => {
            if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
            const current = remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId);
            if (current.revision === preferenceRevisionAtStart) {
              remoteSessionStore.setNewMakerWorktreePreference(targetDeviceId, enabled);
            }
            const accepted = remoteSessionStore.getNewMakerWorktreePreference(targetDeviceId);
            if (
              accepted.revision > preferenceRevisionAtStart
              && accepted.enabled === enabled
            ) {
              armCommittedRender();
            } else {
              markAuthorityUnknown();
            }
          },
        });
        if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
        if (outcome === 'accepted') {
          // Main only acknowledged the broadcast. Keep both Create paths
          // closed until renderer persistence returns through push or GET.
          transaction.status = 'reconciling';
          setWorktreeSeedRetryNonce((value) => value + 1);
        }
      } catch (error) {
        if (worktreePreferenceWriteSeqRef.current !== writeSeq) return;
        if (isWorktreeChannelNotAllowedError(error)) {
          // Explicit old-channel rejection proves this ON request did not
          // commit. Keep the rendered value and let the user continue.
          releaseWrite();
          return;
        }
        // Lost ACK / disconnect may have committed remotely. Reconcile via
        // push/GET; both Create and Goal remain blocked, while checkbox retry
        // stays available once the active write spinner is released.
        markAuthorityUnknown();
      }
    })();
  }, [
    maker,
    selectedDeviceId,
    worktreeEnabled,
    worktreePreferenceSaving,
    worktreeEligibility.status,
  ]);

  useEffect(() => {
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit: (request) => maker.recordVoiceDictionaryLearning(request),
    });
    voiceDictionaryLearningTrackerRef.current = tracker;
    return () => {
      tracker.dispose();
      if (voiceDictionaryLearningTrackerRef.current === tracker) {
        voiceDictionaryLearningTrackerRef.current = null;
      }
    };
  }, [maker]);

  const startVoiceRecording = useCallback(async () => {
    if (
      voicePermissionRequestInFlightRef.current
      || voiceStartupInFlightRef.current
      || voiceStopInFlightRef.current
      || voiceRecordingActiveRef.current
      || voiceState === 'listening'
      || voiceIsProcessing
    ) return;
    setVoiceError(null);
    let permissionRequestSeq: number | null = null;
    let permissionRequestAbortController: AbortController | null = null;
    let startupSeq: number | null = null;
    let claimedPrewarm: PrewarmedMobileVoiceAsr | null = null;
    let audioModeEnabled = false;
    let createdController: MobileVoiceControllerSession | null = null;
    try {
      if (!selectedDeviceId) {
        setVoiceState('error');
        setVoiceError(t('session.new.voiceSelectDeviceFirst'));
        return;
      }
      if (!isMobileRealtimeAudioAvailable()) {
        setVoiceState('error');
        setVoiceError(mobileVoiceRealtimeAudioUnavailableError());
        return;
      }
      permissionRequestSeq = voicePermissionRequestSeqRef.current + 1;
      voicePermissionRequestSeqRef.current = permissionRequestSeq;
      const currentPermissionAbortController = new AbortController();
      permissionRequestAbortController = currentPermissionAbortController;
      voicePermissionRequestAbortRef.current = currentPermissionAbortController;
      voicePermissionRequestInFlightRef.current = true;
      let permissionResult: Awaited<ReturnType<typeof resolveMobileVoiceRecordingPermission>>;
      try {
        permissionResult = await resolveMobileVoiceRecordingPermission({
          getPermission: getRecordingPermissionsAsync,
          requestPermission: requestRecordingPermissionsAsync,
          isRequestCurrent: () => voicePermissionRequestSeqRef.current === permissionRequestSeq,
          isAppActive: () => AppState.currentState === 'active',
          subscribeToAppState: (listener) => {
            const subscription = AppState.addEventListener('change', listener);
            return () => subscription.remove();
          },
          signal: currentPermissionAbortController.signal,
          waitForAppActive: () => waitForMobileVoiceAppActive({
            isAppActive: () => AppState.currentState === 'active',
            subscribe: (listener) => {
              const subscription = AppState.addEventListener('change', listener);
              return () => subscription.remove();
            },
            signal: currentPermissionAbortController.signal,
          }),
        });
      } finally {
        if (voicePermissionRequestSeqRef.current === permissionRequestSeq) {
          voicePermissionRequestInFlightRef.current = false;
        }
        if (voicePermissionRequestAbortRef.current === permissionRequestAbortController) {
          voicePermissionRequestAbortRef.current = null;
        }
      }
      if (permissionResult === 'cancelled') return;
      if (permissionResult === 'denied') {
        voiceStopInFlightRef.current = false;
        voiceRecordingActiveRef.current = false;
        setVoiceState('error');
        setVoiceError(mobileVoiceMicPermissionError());
        return;
      }
      if (
        voicePermissionRequestSeqRef.current !== permissionRequestSeq
        || AppState.currentState !== 'active'
      ) return;
      startupSeq = voiceStartupSeqRef.current + 1;
      voiceStartupSeqRef.current = startupSeq;
      voiceStartupInFlightRef.current = true;
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      audioModeEnabled = true;
      // Open the device link in the background: voice dictation writes into the
      // local composer via the cloud ASR proxy and does not need the mobile↔desktop
      // link (only submitting the composed message later does). Awaiting it here
      // used to add 0.6–4.4s before the mic could open.
      void openLink(selectedDeviceId).catch(() => undefined);
      const currentDraft = firstMessageRef.current;
      // Claim the connection prewarmed at pressIn (if any): its credential is
      // already resolved and its ASR WebSocket already connecting, so the
      // handshake overlaps the press gesture instead of following it.
      // 词典快照拉取不进 await:它只影响润色提示的丰富度,拉不到(桌面离线、老版本
      // 被控端)就用上次缓存,绝不为它推迟开麦。
      void refreshMobileVoiceDictionary(selectedDeviceId, () => maker.getVoiceDictionary());
      const [prewarmedVoice, localVoiceInputHistory] = await Promise.all([
        takePrewarmedMobileVoiceAsr(selectedDeviceId) ?? Promise.resolve(null),
        getMobileVoiceInputHistoryForHost(selectedDeviceId),
        hydrateMobileVoiceDictionary(selectedDeviceId),
      ]);
      claimedPrewarm = prewarmedVoice;
      const credential = prewarmedVoice?.credential
        ?? createMobileCindyVoiceCredential(selectedDeviceId);
      // 官方托管路径:ASR/refine 都经 voice-server 一次性票据,润色 provider
      // 固定 'auto'(服务端 failover)。
      const voiceContext = prewarmedVoice
        ? prewarmedVoice.voiceContext
        : new MobileCindyVoiceRunContext(
          () => auth.getAccessToken(),
          () => auth.refreshAccessToken(),
          auth.apiFetch,
          credential.settings?.language,
          CINDY_MANAGED_REFINER_PROVIDER,
        );
      if (voiceStartupSeqRef.current !== startupSeq) {
        // Superseded while we awaited: close the claimed connection, and undo
        // the recording audio mode this startup enabled — but audio mode is
        // app-global, so leave it alone if a newer voice run (possibly on
        // another screen after this one unmounted) is already starting/live.
        void prewarmedVoice?.asr.stop().catch(() => undefined);
        if (
          !voiceControllerSessionRef.current
          && !voiceStartupInFlightRef.current
          && !voiceRecordingActiveRef.current
        ) {
          await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        }
        return;
      }
      const selectionBefore = currentDraft.trim() ? currentDraft.slice(-1200) : undefined;
      const controller = createMobileVoiceControllerSession({
        credential,
        ...(prewarmedVoice ? { asr: prewarmedVoice.asr } : {}),
        connectionProvider: (providerId: string) => voiceContext.createAsrConnection(providerId),
        refinerTargetProvider: (providerId: string, options?: { refreshAccessToken?: boolean }) =>
          voiceContext.createRefinerTarget(providerId, options),
        warmRefiner: (input: { system: string; user: unknown; promptCacheKey: string }) =>
          voiceContext.warmRefiner(input),
        initialDraft: currentDraft,
        refinementContext: selectionBefore ? { selectionBefore } : undefined,
        localVoiceInputHistory,
        readCurrentDraft: () => firstMessageRef.current,
        onDraftChanged: setFirstMessageDraft,
        onStateChanged: setVoiceState,
        onError: (message) => {
          setVoiceState('error');
          setVoiceError(message);
        },
        // No start cue on mobile: playing a cue via expo-audio during capture
        // re-activates the AVAudioSession and stalls the record tap (see
        // mobileVoiceCue.ts). Only the end cue, which plays after capture stops,
        // is wired.
        onReadyForEndCue: credential.settings?.playInteractionSound ? playMobileVoiceInputEndCue : undefined,
        recordHistory: (text) => recordMobileVoiceInputHistoryForHost(selectedDeviceId, text),
        updateHistoryEntry: (entryId, text) => updateMobileVoiceInputHistoryEntryForHost(selectedDeviceId, entryId, text),
        onRefinementApplied: (input) => {
          const uiLanguage = currentMobileVoiceUiLanguage();
          voiceDictionaryLearningTrackerRef.current?.captureRefinedInsertion({
            ...input,
            uiLanguage,
            sourceLanguage: resolveMobileVoiceRefinementSourceLanguage(
              credential.settings?.language,
              uiLanguage,
            ),
          });
        },
      });
      createdController = controller;
      voiceControllerSessionRef.current = controller;
      voiceRecordingActiveRef.current = true;
      await controller.start();
      if (voiceStartupSeqRef.current !== startupSeq) {
        if (voiceControllerSessionRef.current === controller) {
          voiceControllerSessionRef.current = null;
          voiceRecordingActiveRef.current = false;
          voiceStopInFlightRef.current = false;
          await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        }
        await controller.cancel().catch(() => undefined);
        return;
      }
      voiceStartupInFlightRef.current = false;
    } catch (err) {
      // A claimed prewarmed connection may not have reached the controller yet
      // (e.g. session construction threw); closing it again after the
      // controller's own teardown is harmless — provider stop is idempotent.
      void claimedPrewarm?.asr.stop().catch(() => undefined);
      if (
        startupSeq === null
        && permissionRequestSeq !== null
        && voicePermissionRequestSeqRef.current !== permissionRequestSeq
      ) return;
      if (startupSeq !== null && voiceStartupSeqRef.current !== startupSeq) {
        if (createdController) {
          if (voiceControllerSessionRef.current === createdController) {
            voiceControllerSessionRef.current = null;
            voiceRecordingActiveRef.current = false;
          }
          await createdController.cancel().catch(() => undefined);
        }
        if (
          audioModeEnabled
          && !voiceControllerSessionRef.current
          && !voiceStartupInFlightRef.current
          && !voiceRecordingActiveRef.current
        ) {
          await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        }
        return;
      }
      const controller = voiceControllerSessionRef.current;
      voiceControllerSessionRef.current = null;
      await controller?.cancel().catch(() => undefined);
      voiceStartupInFlightRef.current = false;
      voiceStopInFlightRef.current = false;
      voiceRecordingActiveRef.current = false;
      setVoiceState('error');
      setVoiceError(formatRemoteError(err));
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  }, [openLink, selectedDeviceId, setFirstMessageDraft, voiceIsProcessing, voiceState]);

  const finishVoiceRecording = useCallback(async (): Promise<string | null> => {
    if (voiceStopInFlightRef.current) return null;
    const controller = voiceControllerSessionRef.current;
    if (!controller) return null;
    if (!voiceRecordingActiveRef.current && voiceState !== 'listening') return null;
    voiceStartupSeqRef.current += 1;
    voiceStartupInFlightRef.current = false;
    voiceStopInFlightRef.current = true;
    voiceControllerSessionRef.current = null;
    voiceRecordingActiveRef.current = false;
    setVoiceState('submitting');
    setVoiceError(null);
    try {
      const latestDraft = await controller.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      setVoiceState('done');
      requestAnimationFrame(() => {
        const end = latestDraft.length;
        firstMessageInputRef.current?.setNativeProps({ selection: { start: end, end } });
      });
      return latestDraft;
    } catch (err) {
      voiceControllerSessionRef.current = null;
      voiceRecordingActiveRef.current = false;
      setVoiceState('error');
      setVoiceError(formatRemoteError(err));
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      return null;
    } finally {
      voiceStopInFlightRef.current = false;
    }
  }, [voiceState]);

  const openVoiceSettings = useCallback(() => {
    void Linking.openSettings().catch((err) => {
      setVoiceError(formatRemoteError(err));
    });
  }, []);

  const toggleVoiceRecording = useCallback(() => {
    if (voiceRecordingActiveRef.current || voiceState === 'listening') {
      void finishVoiceRecording();
      return;
    }
    if (voiceState === 'idle' || voiceState === 'done' || voiceState === 'error') {
      void startVoiceRecording();
    }
  }, [finishVoiceRecording, startVoiceRecording, voiceState]);

  // Touch-down of the mic button = start recording (desktop pointerdown 同款,
  // 2026-07-27 定案):按下瞬间起录,开头一个字不丢;松手属于同一手势,由
  // voiceStartedOnPressInRef 吞掉 onPress 的 toggle。预热仍在最前,与启动重叠。
  // Skipped when the tap will stop the current recording rather than start a new one.
  const handleVoiceButtonPressIn = useCallback(() => {
    voiceStartedOnPressInRef.current = false;
    if (creating || voiceIsProcessing) return;
    if (voiceRecordingActiveRef.current || voiceState === 'listening') return;
    if (!selectedDeviceId || !isMobileRealtimeAudioAvailable()) return;
    // Keep the native audio-session warmup on the synchronous press-down path
    // (prewarmMobileVoiceStart re-runs it idempotently below).
    prewarmMobileRealtimeAudio();
    // 托管预热:凭登录态提前拿 voice-server 票据并开 ASR WebSocket。
    prewarmMobileVoiceStart(selectedDeviceId, {
      getAccessToken: () => auth.getAccessToken(),
      refreshAccessToken: () => auth.refreshAccessToken(),
      apiFetch: auth.apiFetch,
    });
    // 启动已在途/停止在途时不重复发起,也不把这次按下标成「已起录」。
    if (voiceStartupInFlightRef.current || voiceStopInFlightRef.current) return;
    voiceStartedOnPressInRef.current = true;
    const pendingSeq = ++voiceStartPendingSeqRef.current;
    setVoiceStartPending(true);
    void startVoiceRecording()
      .catch(() => undefined)
      .finally(() => {
        // 只收自己世代的 pending(与会话页同款守卫)。
        if (voiceStartPendingSeqRef.current === pendingSeq) setVoiceStartPending(false);
      });
  }, [creating, selectedDeviceId, startVoiceRecording, voiceIsProcessing, voiceState]);

  useEffect(() => {
    return () => {
      const controller = voiceControllerSessionRef.current;
      voiceControllerSessionRef.current = null;
      voicePermissionRequestSeqRef.current += 1;
      voicePermissionRequestAbortRef.current?.abort();
      voicePermissionRequestAbortRef.current = null;
      voicePermissionRequestInFlightRef.current = false;
      voiceStartupSeqRef.current += 1;
      voiceStartupInFlightRef.current = false;
      voiceStopInFlightRef.current = false;
      voiceRecordingActiveRef.current = false;
      if (controller) void controller.cancel().catch(() => undefined);
      discardPendingPrewarm();
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!voiceIsListening) return undefined;
    const frame = requestAnimationFrame(() => {
      const end = firstMessageRef.current.length;
      firstMessageInputRef.current?.setNativeProps({ selection: { start: end, end } });
      voiceDraftScrollRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerInputContentHeight, draft.firstMessage, voiceIsListening]);

  useEffect(() => {
    if (voiceIsListening && draft.firstMessage.length > 0) return;
    setVoiceDraftCaretFrame({ left: 0, top: 0 });
  }, [draft.firstMessage.length, voiceIsListening]);

  const renderComposerResizeHandle = () => (
    <ComposerResizeGrabber
      onAdjust={composerResize.adjustByLine}
      panHandlers={composerResize.panHandlers}
      testID="newSession.composerResizeGrabber"
      visible
    />
  );
  const renderAttachmentToggleButton = () => (
    <Pressable
      accessibilityLabel={t('session.common.openContextPanel')}
      accessibilityRole="button"
      disabled={creating}
      hitSlop={10}
      onPress={() => {
        setModelSheetOpen(false);
        setAgentPickerOpen(false);
        setPermissionSheetOpen(false);
        setWorktreeBranchSheetOpen(false);
        setContextSheetView('main');
        setContextSheetOpen(true);
      }}
      style={({ pressed }) => [
        styles.composerIconButton,
        contextSheetOpen && styles.composerIconButtonActive,
        pressed && styles.pressed,
      ]}
      testID="newSession.attachmentToggleButton"
    >
      <Plus
        color={contextSheetOpen ? colors.textPrimary : colors.textSecondary}
        size={iconSize.sm}
        strokeWidth={iconStroke.regular}
      />
    </Pressable>
  );
  const renderCreateButton = () => (
    <Pressable
      accessibilityLabel={creating ? t('session.new.creatingSession') : t('session.new.createAndSend')}
      accessibilityHint={createValidation
        ?? (worktreePreferenceSaving
          ? t('session.new.worktreeSettingsSaving')
          : worktreeBranchPreferenceSaving
            ? t('session.new.worktreeBranchSaving')
            : worktreeCreateBlocked && worktreeControlCaptionKey
              ? t(worktreeControlCaptionKey)
              : undefined)}
      accessibilityRole="button"
      accessibilityState={{
        busy: creating
          || voiceIsProcessing
          || worktreePreferenceSaving
          || worktreeBranchPreferenceSaving
          || undefined,
        disabled: !canCreate || undefined,
      }}
      disabled={!canCreate}
      hitSlop={10}
      onPress={() => void create()}
      style={({ pressed }) => [
        styles.sendButton,
        !canCreate && styles.sendButtonDisabled,
        pressed && canCreate && styles.sendButtonPressed,
      ]}
      testID="newSession.createButton"
    >
      {creating ? (
        <ActivityIndicator color={colors.textSecondary} size="small" />
      ) : (
        <PaperPlaneIcon
          color={canCreate ? colors.ctaText : colors.textSecondary}
          size={iconSize.lg}
        />
      )}
    </Pressable>
  );
  // 聚焦卡片形态的底部工具排:[+][权限][模型] …… [语音][创建]。
  // 权限 / 模型即原「输入行上方常驻 expandedTools」的内容,收进底排后未聚焦时不再占布局。
  // 权限模式独立入口(2026-07-29 用户裁决,对齐 Codex):工具条左侧只显示档位图标的
  // 圆钮,不带文字——档名留给浮窗与无障碍标签;危险档(auto / bypass)只染图标色。
  const renderPermissionIconButton = () => {
    const presentation = permissionPresentation(displayPermissionMode, displayPermissionLabel);
    const accent = presentation.accent !== 'neutral'
      ? permissionAccentColor(presentation.accent, colors)
      : null;
    return (
      <Pressable
        accessibilityLabel={t('models.picker.permissionModeAccessibility', { mode: presentation.label })}
        accessibilityRole="button"
        accessibilityState={{ expanded: permissionSheetOpen || undefined }}
        hitSlop={10}
        onPress={openPermissionPicker}
        style={({ pressed }) => [styles.composerIconButton, pressed && styles.pressed]}
        testID="newSession.permissionIndicator"
      >
        <presentation.Icon
          color={accent ?? colors.textSecondary}
          size={iconSize.sm}
          strokeWidth={iconStroke.regular}
        />
      </Pressable>
    );
  };

  // 工具条布局:左 = [+][权限][计划 chip][模型];右 = [语音][创建]。
  // 模型放左侧组,不随创建按钮出现而横向跳动。
  const renderComposerToolbar = () => (
    <>
      <ComposerToolbarLeftGroup testID="newSession.composerToolbarLeft">
        {renderAttachmentToggleButton()}
        {renderPermissionIconButton()}
        {planModeOn ? (
          <PlanModeChip
            disabled={creating}
            onExit={() => togglePlanMode(false)}
            testID="newSession.planModeChip"
          />
        ) : null}
        <Pressable
          accessibilityLabel={t('session.new.modelAccessibility', { model: runtimeSummary.modelSummary })}
          accessibilityRole="button"
          accessibilityState={{ expanded: modelSheetOpen || undefined }}
          hitSlop={10}
          onPress={toggleModelPicker}
          style={({ pressed }) => [styles.modelPill, pressed && styles.pressed]}
          testID="newSession.modelIndicator"
        >
          {activeSourceProvider ? (
            // 图标统一规则(桌面同源):模型条目 icon(AI Gateway 设定)优先,缺省回落来源标。
            <MobileModelIconMark
              color={colors.textSecondary}
              icon={getModel(activeSourceProvider, draft.model, draft.agentKind)?.icon}
              name={activeSourceProvider.name}
              providerId={activeSourceProvider.id}
              routing={activeSourceProvider.routing}
              logoKind={activeSourceProvider.logoKind}
            />
          ) : null}
          <Text style={styles.modelPillText} numberOfLines={1}>{runtimeSummary.modelSummary}</Text>
          {triggerFastOn ? <Zap color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
          <ChevronDown color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        </Pressable>
      </ComposerToolbarLeftGroup>
      <ComposerToolbarSpacer />
      {composerVoicePlacement?.inline || composerVoicePlacement?.floating
        ? <ComposerToolbarVoiceSlot width={voiceRecordingTimer.pillWidth} />
        : null}
      {composerShowCreateButton ? renderCreateButton() : null}
    </>
  );
  const renderComposerInputOverlay = () => voiceIsListening ? (
    <ScrollView
      ref={voiceDraftScrollRef}
      contentContainerStyle={[
        styles.voiceDraftOverlayContent,
        !composerCardActive && styles.voiceDraftOverlayContentGeometric,
      ]}
      onContentSizeChange={() => {
        requestAnimationFrame(() => {
          voiceDraftScrollRef.current?.scrollToEnd({ animated: false });
        });
      }}
      onLayout={() => {
        requestAnimationFrame(() => {
          voiceDraftScrollRef.current?.scrollToEnd({ animated: false });
        });
      }}
      pointerEvents="none"
      scrollEnabled={composerInputScrollEnabled}
      showsVerticalScrollIndicator={false}
      style={styles.voiceDraftOverlay}
    >
      {voiceDraftShowsListeningPrompt ? (
        <View style={styles.voiceDraftListeningPrompt}>
          <VoiceMicWaveCaret color={colors.textPrimary} testID="newSession.voiceMicCaret" />
          <Text style={styles.voiceDraftListeningText}>{composerListeningPlaceholder}</Text>
        </View>
      ) : (
        <View style={styles.voiceDraftMeasuredBlock}>
          <Text
            onTextLayout={handleVoiceDraftTextLayout}
            style={styles.voiceDraftText}
          >
            {draft.firstMessage}
          </Text>
          <View
            pointerEvents="none"
            style={[
              styles.voiceDraftCaretOverlay,
              {
                left: voiceDraftCaretFrame.left,
                top: voiceDraftCaretFrame.top,
              },
            ]}
          >
            <VoiceMicWaveCaret color={colors.textPrimary} testID="newSession.voiceMicCaret" />
          </View>
        </View>
      )}
    </ScrollView>
  ) : null;

  const renderComposerVoiceButton = (buttonStyle?: StyleProp<ViewStyle>) => (
    <Pressable
      accessibilityLabel={voiceIsListening ? t('session.common.voiceStopRecording') : t('session.new.voiceInput')}
      accessibilityRole="button"
      accessibilityState={{ busy: voiceIsProcessing || undefined, disabled: creating || undefined }}
      disabled={creating || voiceIsProcessing}
      hitSlop={10}
      onPress={() => {
        if (voiceStartedOnPressInRef.current) {
          // 本次按下已在 pressIn 起录:松手不当作「再点一下停止」。
          voiceStartedOnPressInRef.current = false;
          return;
        }
        toggleVoiceRecording();
      }}
      onPressIn={handleVoiceButtonPressIn}
      onTouchCancel={() => {
        // 手势被系统/滚动打断:撤销这次按下误触发的录音(与会话页同语义,
        // 正常松手不触发;cancelVoiceForDeviceSwitch 会作废在途启动并释放音频)。
        if (!voiceStartedOnPressInRef.current) return;
        voiceStartedOnPressInRef.current = false;
        cancelVoiceForDeviceSwitch();
      }}
      style={({ pressed }) => [
        styles.composerIconButton,
        buttonStyle,
        // 胶囊底色跟随计时内容(含 pressIn 乐观 pending 期),不只 listening。
        voiceRecordingTimer.label !== null && styles.composerIconButtonActive,
        voiceRecordingTimer.label !== null && { width: voiceRecordingTimer.pillWidth },
        (creating || voiceIsProcessing) && styles.disabled,
        pressed && styles.pressed,
      ]}
      testID="newSession.voiceButton"
    >
      {voiceIsProcessing ? (
        <ActivityIndicator color={colors.textSecondary} size="small" />
      ) : voiceRecordingTimer.label !== null ? (
        // 录音中:胶囊展开为脉冲红点 + 计时(对齐桌面/会话页),点胶囊任意位置停止。
        <VoiceRecordingPillContent label={voiceRecordingTimer.label} testID="newSession.voiceRecordingPill" />
      ) : (
        <Mic color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      )}
    </Pressable>
  );

  // 切 agent:跟随该 agent 的最近会话 → 否则该 agent 列表最上面 → 否则内置默认(见 pickAgentDefaultRuntime),
  // 同时 reconcile effort、来源跟随 model 同源(最近会话来源校验后继承 / 首项行 provider / 兜底 null)。
  // 手动切 agent = 手动选运行配置 → 之后自动默认不再覆盖。
  const switchAgent = useCallback((nextKind: NewSessionAgentKind) => {
    setAgentPickerOpen(false);
    if (draft.agentKind === nextKind) return;
    userTouchedRuntimeRef.current = true;
    explicitProviderModelSelectionRef.current = null;
    const seqAtTrigger = ++runtimeActionSeqRef.current;
    void saveNewSessionPreferences({ agentKind: nextKind });
    const storedPermissionMode = newSessionPreferences?.permissionModeByAgent[nextKind];
    const nextPermissionMode =
      storedPermissionMode ??
      defaultPermissionModeForNewSessionAgent(nextKind);
    void confirmFullAccessChange(draft.permissionMode, nextPermissionMode, {
      restoringRememberedChoice: storedPermissionMode !== undefined,
    }).then((confirmed) => {
      // 确认期间设备已切换 → 放弃本次写入,新设备自己的 effect 会接管(Greptile P1)。
      if (selectedDeviceId !== selectedDeviceRef.current) return;
      // 确认期间用户又切了 agent / 手动选了模型 → 旧回调不得覆盖新选择(Greptile P1)。
      if (seqAtTrigger !== runtimeActionSeqRef.current) return;
      setDraft((current) => {
        // rows 与 ready 必须同一代(codex review P2):提交时用最新目录现场重建目标
        // agent 的 rows,不用触发时捕获的旧 rows。
        const rowsNow = flattenProviderSections(
          buildMobileModelSections({
            providers: deviceProvidersRef.current.providers,
            agentKind: nextKind,
            visibilityOverrides: deviceProvidersRef.current.modelVisibilityOverrides,
          }).sections,
        );
        const next = pickAgentDefaultRuntime({
          agentKind: nextKind,
          sessions,
          deviceId: selectedDeviceId || undefined,
          modelRows: rowsNow,
          currentEffort: current.effort,
          catalogReady: catalogReadyRef.current,
        });
        return {
          ...current,
          agentKind: next.agentKind,
          model: next.model,
          effort: next.effort,
          // 切到该 agent 时沿用其上次明确选择；无记忆的内置默认仍按升级规则确认。
          permissionMode: confirmed ? nextPermissionMode : current.permissionMode,
          providerId: next.providerId,
          // fast 按 (agent, 来源, 模型) 记忆恢复,无记忆置 false;恢复前过与手动选行
          // 同款的 fastEditable 门控(codex review P2:目录/能力变化后不得恢复出
          // UI 显示关、实际发 true 的矛盾态)。agent 级门控只认目标 agent 的缓存
          // 能力表(codex review P1:此刻闭包里的 capabilities 属于切换前 agent 或
          // 为 null);目标 caps 未就绪 → false,由延迟恢复 effect 就绪后补评。
          fastMode: next.providerId
            && isFastRestorable(next.agentKind, next.providerId, next.model, rowsNow, targetAgentHasFast(selectedDeviceId, next.agentKind))
            ? (draftMemory.getFast(next.agentKind, next.providerId, next.model) ?? false)
            : false,
        };
      });
    });
  }, [draft.agentKind, draft.permissionMode, deviceProviders.providers, deviceProviders.modelVisibilityOverrides, newSessionPreferences, sessions, selectedDeviceId]);

  // 选中的 agent 在被控端未注册(如 Pi 二进制缺失)时,coerce 到首个可用来源,避免用户停在
  // 被隐藏的选项、并防止创建出注定 requireAgent 报错的会话。仅在已拉到可用集后收敛一次。
  useEffect(() => {
    if (!availableAgentKinds) return;
    if (availableAgentKinds.has(draft.agentKind)) return;
    const fallback = NEW_SESSION_AGENT_OPTIONS.find((option) => availableAgentKinds.has(option.kind));
    if (fallback && fallback.kind !== draft.agentKind) switchAgent(fallback.kind);
  }, [availableAgentKinds, draft.agentKind, switchAgent]);

  useEffect(() => {
    if (!selectedDeviceId || draft.workspaceKind !== 'project' || draft.workingDir.trim()) return;

    const key = `${selectedDeviceId}:${initialWorkingDir ?? ''}`;
    if (initialWorkspaceKeyRef.current === key) return;
    initialWorkspaceKeyRef.current = key;

    const initialWorkspace = pickInitialNewSessionWorkspace(draft.workingDir, recentWorkspaces);
    if (initialWorkspace) {
      selectWorkingDir(initialWorkspace);
      return;
    }

    setBrowseOpen(true);
    void loadBrowsePath('~');
  }, [
    selectedDeviceId,
    draft.workspaceKind,
    draft.workingDir,
    initialWorkingDir,
    loadBrowsePath,
    recentWorkspaces,
    selectWorkingDir,
  ]);

  const selectSlashCommand = useCallback((command: MobileSlashCommand) => {
    setFirstMessageDraft((current) => insertSlashCommand(current, detectComposerTrigger(current), command));
  }, [setFirstMessageDraft]);

  const selectAtResource = useCallback((item: MobileAtResourceItem) => {
    setFirstMessageDraft((current) => insertAtResource(current, detectComposerTrigger(current), item));
  }, [setFirstMessageDraft]);

  const removeAttachment = useCallback((id: string) => {
    // 已上传中转区的对象移除时 best-effort 回收,避免未发送附件在 OSS 留孤儿(同会话页)。
    const removed = attachments.find((item) => item.id === id);
    if (removed) discardMobileUploadedAttachment(removed, { getToken: () => auth.getAccessToken() });
    // ref 与 setState 同步镜像(同会话页 removeRemoteFileAttachment):再编辑
    // 替换的「remove 旧 → append 新」同步流程里,create() 抢跑读 ref 不能回带
    // 已被替换的旧附件(review P2)。
    attachmentsRef.current = attachmentsRef.current.filter((item) => item.id !== id);
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentPreviews((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    // 同步清掉指向该附件的相册映射(悬空映射会吞掉同一张图的下一次点选,同会话页)。
    setMediaAssetAttachments((current) => {
      const entries = Object.entries(current).filter(([, attachmentId]) => attachmentId !== id);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    // 标注附件退场时同步清「矢量笔迹 + 原图副本」的再编辑真相。
    composerAnnotationsRef.current?.forgetAttachment(id);
  }, [attachments, auth]);

  // 圈点标注(托盘再编辑)与附件管线的接线(新建会话页无聊天场景,chat 配置不用)。
  const composerAnnotations = useComposerImageAnnotations({
    getAccessToken: () => auth.getAccessToken(),
    enqueueUploads,
    removeAttachment,
    // pending 计数读 controller 同步真源(getPendingUploadCount)而非 React state:
    // 标注信箱串行 drain 的连续提交只隔 microtask,state commit(macrotask)来不及
    // 生效,读 state 会拿到「入队前」旧值绕过上限(review P1)。
    getRemainingAttachmentSlots: () =>
      MOBILE_MAX_ATTACHMENTS - attachmentsRef.current.length - getPendingUploadCount(),
  });
  composerAnnotationsRef.current = composerAnnotations;

  // 「已提交、仍在上传」的相册资产:pendingUploads 携带 sourceId(相册来源才有)。
  // 重开面板时这些格子标 busy(spinner + 禁点),onUploaded 落定后自然转为勾选态,
  // 防止上传窗口内同一张照片被再次点选重复入队(codex review R14)。
  const uploadingMediaAssetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const pending of pendingUploads) {
      if (pending.sourceId) ids.add(pending.sourceId);
    }
    return ids;
  }, [pendingUploads]);
  // Context 面板媒体缩略图点选(Cursor 式两段提交):已附加 → 立即移除;
  // 待选 → 取消待选;其余 → 加入待选,由底部「加入对话」按钮统一上传提交。
  const toggleMediaAssetAttachment = useCallback((asset: ContextSheetMediaAsset) => {
    const attachedId = mediaAssetAttachments[asset.id];
    if (attachedId) {
      // 复用统一移除路径:除清 attachments/previews/映射外,还会 best-effort 回收
      // 已上传的 OSS 中转对象(codex review #504,缩略图取消与 X 按钮同语义)。
      removeAttachment(attachedId);
      setAttachmentError(null);
      return;
    }
    if (pendingMediaAssets.some((item) => item.id === asset.id)) {
      setPendingMediaAssets(pendingMediaAssets.filter((item) => item.id !== asset.id));
      return;
    }
    // 上传中的资产不可再选(UI 已标 busy 禁点,这里是防御兜底),落定后转勾选态。
    if (uploadingMediaAssetIds.has(asset.id)) return;
    // 在途占坑读 getPendingUploadCount 同步真源(上传中 + 粘贴占位):粘贴占位
    // 窗口(原生还在读剪贴板)任务未入队也未进 pendingUploads state,不计入的话
    // 这里会放行超额选图,占位兑现时轮到粘贴图自己撞上限被丢(review P2)。
    if (attachments.length + pendingMediaAssets.length + getPendingUploadCount() >= MOBILE_MAX_ATTACHMENTS) {
      setAttachmentError(t('session.common.maxAttachments', { max: MOBILE_MAX_ATTACHMENTS }));
      return;
    }
    setAttachmentError(null);
    setPendingMediaAssets([...pendingMediaAssets, asset]);
  }, [attachments.length, getPendingUploadCount, mediaAssetAttachments, pendingMediaAssets, removeAttachment, uploadingMediaAssetIds]);
  // 底部「加入对话」:点击当帧把待选照片同步入队(缩略图立即进托盘)并关面板;token 传
  // Promise 由任务自行等待(codex review R8:先 await token 再 enqueue 的等待窗里,面板可被
  // 背板关掉、create() 的 waitForPendingUploads 看不到任务,首条消息会丢下刚选的图先发出去)。
  // 全程同步也天然免疫双击重入与限额竞态:批次即时计入 pendingUploads,不再需要
  // in-flight 门 / 限额预留 / enqueue 前复查那套等待窗补丁。解析(ph://→file://、HEIC
  // 转码缩边)+ 降采样 + 上传全部在后台管线并发跑,单张失败经 onFailed 报错(含登录过期)。
  const commitPendingMediaAssets = useCallback(() => {
    const assets = pendingMediaAssets;
    if (assets.length === 0) return;
    setPendingMediaAssets([]);
    setAttachmentError(null);
    enqueueUploads(assets.map((asset, index) => ({
      kind: 'image' as const,
      uri: asset.uri,
      name: asset.filename,
      size: 0,
      sourceId: asset.id,
      resolve: async () => {
        const resolved = await resolveContextSheetMediaAssetForUpload(asset);
        const candidate = buildMobileImageAttachmentCandidate({
          fileName: resolved.filename,
          uri: resolved.uri,
        }, index);
        return {
          uri: candidate.uri,
          name: candidate.name,
          mimeType: candidate.mimeType,
          width: resolved.width,
          height: resolved.height,
          // HEIC 已在 resolve 阶段一次性转码 + 缩边,跳过 preprocess 防二次有损。
          skipPreprocess: resolved.optimized === true,
        };
      },
    })), { token: auth.getAccessToken() });
    setContextSheetOpen(false);
  }, [auth, enqueueUploads, pendingMediaAssets]);
  const selectedMediaAssetIds = useMemo(() => {
    const attachmentIds = new Set(attachments.map((item) => item.id));
    return new Set(
      Object.entries(mediaAssetAttachments)
        .filter(([, attachmentId]) => attachmentIds.has(attachmentId))
        .map(([assetId]) => assetId),
    );
  }, [attachments, mediaAssetAttachments]);
  // 待选序号角标(从 1 起,按选中顺序)。
  const pendingMediaOrder = useMemo(
    () => new Map(pendingMediaAssets.map((item, index) => [item.id, index + 1])),
    [pendingMediaAssets],
  );
  // composer 托盘图片附件 → 全屏查看器图集(本地 file:// 直接可显示,不走远端取件)。
  // 标注附件点开显示**原图**(叠矢量笔迹可继续编辑/撤销)而非烧录预览图,同会话页。
  const composerGalleryImages = useMemo<MobileMessageGalleryImage[]>(() => {
    const images: MobileMessageGalleryImage[] = [];
    for (const attachment of attachments) {
      const preview = attachment.category === 'image' ? attachmentPreviews[attachment.id] : undefined;
      if (!preview) continue;
      const src = composerAnnotations.trayImageSourceUri(attachment.id, preview);
      const payload = buildMediaPayload({
        kind: 'image',
        previewable: true,
        title: attachment.name,
        url: src,
      }, attachment.name);
      if (payload.kind === 'media') {
        images.push({ key: attachment.id, payload, title: attachment.name, url: src });
      }
    }
    return images;
    // 依赖具体的稳定回调而非整个 hook 对象:烧录 host 挂载/卸载不应重建图集
    // (images 引用变化会重置 lightbox 里正在画的笔迹,review P1;同会话页)。
  }, [attachments, attachmentPreviews, composerAnnotations.trayImageSourceUri]);
  const composerPreviewUrl = composerPreviewAttachmentId
    ? (composerGalleryImages.find((image) => image.key === composerPreviewAttachmentId)?.url ?? null)
    : null;
  // 展开(card)态输入卡内的附件缩略图托盘(对照 Cursor,图片在输入卡里、文字上方)。
  const renderComposerAttachmentTray = () => (
    <ComposerAttachmentTray
      attachments={attachments}
      onPreview={setComposerPreviewAttachmentId}
      onRemove={removeAttachment}
      onRemovePending={removePendingUpload}
      onRetryPending={retryPendingUpload}
      pastePlaceholderCount={pastePlaceholderCount}
      pendingUploads={pendingUploads}
      previews={attachmentPreviews}
      removeDisabled={creating}
      testIDPrefix="newSession"
    />
  );
  // 收起态附件徽标(leading 仅在非 card 态渲染);点击聚焦输入框展开完整托盘。
  const renderComposerCollapsedAttachmentBadge = () => (attachments.length > 0 || pendingUploads.length > 0 || pastePlaceholderCount > 0 ? (
    <ComposerAttachmentCollapsedBadge
      attachments={attachments}
      onPress={() => firstMessageInputRef.current?.focus()}
      pastePlaceholderCount={pastePlaceholderCount}
      pendingUploads={pendingUploads}
      previews={attachmentPreviews}
      testID="newSession.attachmentCollapsedBadge"
    />
  ) : null);

  // 收起态把附件 + 号放在输入框左侧，避免用户必须先聚焦才能打开附件面板；
  // 卡片态仍由 renderComposerToolbar() 渲染同一入口。
  const renderComposerCompactLeading = () => (
    <View style={styles.composerCompactLeading}>
      <Pressable
        accessibilityLabel={t('session.common.openContextPanel')}
        accessibilityRole="button"
        disabled={creating}
        onPress={() => {
          setModelSheetOpen(false);
          setAgentPickerOpen(false);
          setPermissionSheetOpen(false);
          setWorktreeBranchSheetOpen(false);
          setContextSheetView('main');
          setContextSheetOpen(true);
        }}
        style={({ pressed }) => [
          styles.composerCompactAttachmentHit,
          pressed && styles.pressed,
        ]}
        testID="newSession.attachmentToggleButton"
      >
        <View
          pointerEvents="none"
          style={[
            styles.composerIconButton,
            contextSheetOpen && styles.composerIconButtonActive,
          ]}
        >
          <Plus
            color={contextSheetOpen ? colors.textPrimary : colors.textSecondary}
            size={iconSize.sm}
            strokeWidth={iconStroke.regular}
          />
        </View>
      </Pressable>
      {renderComposerCollapsedAttachmentBadge()}
    </View>
  );
  // 面板关闭即丢弃未提交的待选(不产生任何上传副作用)。
  useEffect(() => {
    if (!contextSheetOpen) setPendingMediaAssets([]);
  }, [contextSheetOpen]);
  // 进页面就静默预取最近照片(仅已授权时),打开 + 面板即刻出图。
  useEffect(() => {
    void prefetchContextSheetMediaAssets('recent');
  }, []);

  // Context 面板「计划模式」入口,双路径(#494 迁移):
  //  - 新协议(capabilities.planMode.supported):本地布尔草稿态,创建会话后经
  //    maker:set-plan-mode 武装首条消息,消耗由被控端执行;不污染 draft.permissionMode。
  //  - 老被控端兼容(permissionModes 仍含 'plan'):沿用草稿 permissionMode 切换 + 创建后恢复。
  // prePlanPermissionModeRef 声明在 displayPermissionMode 计算处(权限按钮展示需要)。
  const planModeCapability = runtimeOptions.planModeSupported;
  const legacyPlanSupported = runtimeOptions.permissionOptions.some((option) => option.id === 'plan');
  const planModeSupported = planModeCapability || legacyPlanSupported;
  const [planModeDraftOn, setPlanModeDraftOn] = useState(false);
  const planModeOn = planModeCapability ? planModeDraftOn : draft.permissionMode === 'plan';
  const togglePlanMode = useCallback((next: boolean) => {
    if (planModeCapability) {
      setPlanModeDraftOn(next);
      return;
    }
    if (next) {
      prePlanPermissionModeRef.current = draft.permissionMode;
      patchDraft({ permissionMode: 'plan' });
      return;
    }
    const fallback = runtimeOptions.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask';
    const remembered = prePlanPermissionModeRef.current;
    patchDraft({ permissionMode: remembered && remembered !== 'plan' ? remembered : fallback });
  }, [draft.permissionMode, patchDraft, planModeCapability, runtimeOptions.permissionOptions]);

  const create = useCallback(async () => {
    if (
      creatingRef.current
      || voicePermissionRequestInFlightRef.current
      || voiceStartupInFlightRef.current
      || voiceStopInFlightRef.current
      || voiceIsProcessing
    ) return;
    if (!selectedDeviceId) {
      setError(t('session.new.selectDeviceError'));
      return;
    }
    // 旧协议 Plan 依赖会话级 permissionMode，不能安全进入断线创建 / 离线 FIFO。
    // 保留草稿与 Plan 选择，等 relay 和目标电脑恢复后再走原有在线兼容路径。
    if (
      !planModeCapability
      && draft.permissionMode === 'plan'
      && (
        deviceLinkStatus !== 'online'
        || getPresenceAvailability(selectedDeviceId) === false
      )
    ) {
      setError(t('session.menu.aiRenameOffline'));
      return;
    }
    if (
      worktreeApplicable
      && worktreeEligibility.status !== 'ineligible'
      && (
        worktreePreferenceWriteTargetRef.current === selectedDeviceId
        || worktreePreferenceAuthorityUnknownByDeviceRef.current.has(selectedDeviceId)
        || worktreePreferenceReadyKeyRef.current !== worktreePreferenceSyncKeyRef.current
      )
    ) {
      setError(t('session.new.worktreeSettingsSaving'));
      return;
    }
    if (
      worktreeEnabled
      && (
        worktreeBranchPreferenceWriteTargetRef.current === worktreeBranchPreferenceKey
        || (
          worktreeEligibility.status === 'eligible'
          && worktreeBranchPreferenceReadyKeyRef.current !== worktreeBranchPreferenceSyncKey
        )
      )
    ) {
      setError(t('session.new.worktreeBranchSaving'));
      return;
    }
    if (worktreeCreateBlocked) {
      setError(worktreeCaptionKey
        ? t(worktreeCaptionKey)
        : t('session.new.worktreeSettingsSaving'));
      return;
    }
    const worktreeIntent = captureWorktreeCreateIntent();
    if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
      setError(t('session.new.worktreeSettingsSaving'));
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    // 乐观交接标记:startNewSessionCreation + router.replace 成功后本页即将
    // unmount,但导航过渡帧内页面仍可交互——finally 立刻复位锁会给快速双击
    // 「创建」留出重入窗口,第二次点击会用同一份草稿再预生成一个 sessionId、
    // 建出重复会话(codex review P2)。交接成功后锁保持到组件销毁;「返回编辑」
    // 回来的是新 mount,creatingRef 天然复位。
    let handedOff = false;
    let releasePrecreatedRegistration: (() => void) | null = null;
    const accountIdAtCreate = auth.user?.id?.trim() ?? '';
    const authOwnerAtCreate = getMobileAuthOwner();
    const isCurrentOwner = () => (
      authOwnerAtCreate.accountId === accountIdAtCreate
      && isMobileAuthOwnerCurrent(authOwnerAtCreate)
    );
    try {
      if (!isCurrentOwner()) return;
      let effectiveDraft = draft;
      // ㉙ 设备守卫全程化(独立 review P1-1/P1-2):设备快照必须取自**闭包**
      // selectedDeviceId(真正会创建会话的目标设备)——selectedDeviceRef 是渲染后
      // 的最新值,若用户在渲染与点击之间切了设备,ref 已属新设备而闭包 maker/目录
      // 仍属旧设备,用它当快照会让守卫全程失明。入口立即与 ref 核对:已切走 → 放弃。
      const deviceAtCreate = selectedDeviceId;
      if (selectedDeviceRef.current !== deviceAtCreate) return;
      const ensureDeviceAlive = (): boolean => selectedDeviceRef.current === deviceAtCreate;
      if (voiceRecordingActiveRef.current || voiceState === 'listening') {
        const latestDraftText = await finishVoiceRecording();
        if (!isCurrentOwner()) return;
        if (!ensureDeviceAlive()) return;
        if (latestDraftText === null) return;
        effectiveDraft = { ...draft, firstMessage: latestDraftText };
      }
      // 拍照 / 选图后立刻点创建是常见路径:等在途图片上传落定(乐观托盘)。
      // 有失败就中止创建——错误文案已由上传回调写入 attachmentError,让用户处理;
      // 此时不该带着残缺附件去开新会话。
      const { failedCount } = await waitForPendingUploads();
      if (!isCurrentOwner()) return;
      if (!ensureDeviceAlive()) return;
      if (failedCount > 0) return;
      // await 之后闭包里的 attachments 是旧值,经 ref 拿含刚落定图片的最新列表。
      const sendAttachments = attachmentsRef.current;
      const validation = validateNewSessionDraft(effectiveDraft, { attachmentCount: sendAttachments.length });
      if (validation) {
        setError(validation);
        return;
      }
      // 鉴权门禁:已知无已连接供应商时不发起创建(创建即失败,还会白跑一个往返)。
      // 目录缓存可能过期(用户刚在电脑端配好 key):拦截前现拉一遍确认;确认不了
      // (已连接 / 空目录 / 拉失败)时缓存判死已不可信,清掉重取并放行。
      if (agentAuthVerdict === 'unauthenticated') {
        if ((await confirmAgentUnauthenticated(effectiveDraft.agentKind, selectedDeviceId)).unauthenticated) {
          if (!isCurrentOwner()) return;
          if (!ensureDeviceAlive()) return;
          setError(agentAuthGateHint(effectiveDraft.agentKind));
          return;
        }
        if (!isCurrentOwner()) return;
        // 确认期间切设备 → 不再驱逐(驱逐的是旧设备缓存,继续创建也无意义)。
        if (!ensureDeviceAlive()) return;
        evictDeviceProviders(selectedDeviceId);
      }
      if (!isCurrentOwner()) return;
      if (!ensureDeviceAlive()) return;
      void saveNewSessionPreferences({
        agentKind: effectiveDraft.agentKind,
        device: {
          deviceId: selectedDeviceId,
          name: selectedDeviceName || selectedDeviceId,
        },
      });
      const worktreeAccountId = authOwnerAtCreate.accountId;
      if (
        worktreeIntent.applicable
        && worktreeIntent.enabled
        && worktreeIntent.eligibility.status === 'eligible'
      ) {
        // 两步创建必须先有可归属的账号账本。不能先在工作端落盘，再发现本地
        // 无法按账号持久化 cleanup obligation。
        if (!worktreeAccountId) {
          setError(t('session.new.worktreeRecoveryStateFailed'));
          return;
        }
        const obligationOwnedByLiveTask = (sessionId: string) => (
          getNewSessionCreationTask(sessionId) !== null
          || isPrecreatedWorktreeRegistrationInFlight(sessionId)
        );
        // 本设备上一次未完成的 obligation 先恢复。其它设备记录、仍被正常创建
        // task 认领的记录不参与本次阻塞；只有无 owner 且无法回收/确认的旧目录
        // 会阻止继续创建第二份。
        const recovery = await recoverPendingPrecreatedWorktrees(worktreeAccountId, {
          openLink,
          discardPrecreated: async (_deviceId, input) => (
            maker.worktree.discardPrecreated(input)
          ),
          isSessionClaimed: async (_deviceId, pendingSessionId) => (
            isExactRemoteSessionClaimed(
              pendingSessionId,
              (id) => maker.getSession(id),
            )
          ),
          shouldDefer: (record) => (
            record.deviceId !== selectedDeviceId
            || obligationOwnedByLiveTask(record.sessionId)
          ),
          isCurrent: isCurrentOwner,
        });
        if (!isCurrentOwner()) return;
        // ㉙ recovery await 期间切设备 → 放弃(独立 review P1-4:create 的 recovery 后漏 ensure)。
        if (!ensureDeviceAlive()) return;
        if (
          !recovery.storageReadable
          || recovery.retained > 0
        ) {
          setError(t('session.new.worktreeCleanupPending'));
          return;
        }
        if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
          setError(t('session.new.worktreeSettingsSaving'));
          return;
        }
      }
      // —— 乐观创建:sessionId 手机端预生成(被控端 createSession 对 provided id
      // 幂等),点创建**立即**进入会话页;openLink / 鉴权 revalidate / createSession
      // / 首条消息 enqueue 全部由 newSessionCreation 模块级后台管线完成(本页
      // unmount 不终止),失败重试面在会话页(横幅:重试 / 返回编辑)。
      const sessionId = createNewSessionId();
      let precreatedWorktree: {
        path: string;
        recoveryKey: string;
        originalWorkingDir: string;
        createdAt?: number;
      } | undefined;
      // ㉙ 设备切换中止助手(独立 review P1-2/P1-3):检测到设备已切换 → 已产生远端
      // 副作用(precreated)走 compensatePrecreatedWorktree——**先 discardPrecreated
      // 获严格 ACK 才 forget**(forget 删唯一账本,未 discard 就删 = 永久孤儿),
      // ACK 失败/未知保留 ledger 交 recovery;返回 true 供调用方 return。
      const abortIfDeviceSwitched = async (): Promise<boolean> => {
        if (ensureDeviceAlive()) return false;
        if (precreatedWorktree) {
          const pwt = precreatedWorktree;
          await compensatePrecreatedWorktree({
            sessionId,
            recoveryKey: pwt.recoveryKey,
            createdAt: pwt.createdAt ?? Date.now(),
            phase: 'precreated',
            discard: () => maker.worktree.discardPrecreated({
              sessionId,
              recoveryKey: pwt.recoveryKey,
            }),
            parseAck: parseDiscardPrecreatedAck,
            forget: () => forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey: pwt.recoveryKey,
              createdAt: pwt.createdAt ?? Date.now(),
            }),
            release: releasePrecreatedRegistration,
          });
        }
        return true;
      };
      // —— worktree 两步流第一步(对齐桌面远程流程 NewMakerDraftRoute:远程没有改已建
      // 会话 workingDir 的通道,顺序反过来 —— 先同步等工作端建好 worktree 拿路径,再以
      // 该路径 + 同一预生成 sessionId 走乐观管线)。worktree:create 对同 sessionId 重跑
      // 不幂等,不能放进管线的重试面 —— 失败(业务 {ok:false} / invoke 抛错)一律留在
      // 表单展示错误,不建会话(草稿原地保留,与桌面远程失败语义一致)。
      if (
        worktreeIntent.applicable
        && worktreeIntent.enabled
        && worktreeIntent.eligibility.status === 'eligible'
      ) {
        try {
          // suggest-name 失败不阻断:走 auto- 兜底名(对齐桌面 :1316)。
          if (!isCurrentOwner()) return;
          let suggested: string | null = null;
          try {
            suggested = await maker.worktree
              .suggestName(worktreeIntent.eligibility.baseRepo)
              .then((result) => result.name);
          } catch {
            suggested = null;
          }
          if (!isCurrentOwner()) return;
          if (!ensureDeviceAlive()) return;
          if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
            setError(t('session.new.worktreeSettingsSaving'));
            return;
          }
          const recoveryKey = createNewSessionId();
          const createdAt = Date.now();
          releasePrecreatedRegistration = holdPrecreatedWorktreeRegistration(sessionId);
          // reservation 必须先于远端副作用持久化。首次写盘失败时绝不调用
          // worktree:create；volatile 镜像只负责阻止本进程继续制造第二个孤儿，
          // 不能冒充跨进程保证。
          const reservationRecorded = await registerPendingPrecreatedWorktree(
            worktreeAccountId,
            {
              sessionId,
              deviceId: selectedDeviceId,
              recoveryKey,
              createdAt,
              phase: 'reserved',
            },
          );
          if (!isCurrentOwner()) return;
          // ㉙ 写盘 reservation 后切设备 → 清掉这份 obligation(reserved 无远端
          // 目录,不产生孤儿,但会阻塞同设备下次创建的 recovery 直到被回收)。
          if (!ensureDeviceAlive()) {
            await forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey,
              createdAt,
            }).catch(() => undefined);
            return;
          }
          if (!reservationRecorded) {
            setError(t('session.new.worktreeRecoveryStateFailed'));
            return;
          }
          if (!isCurrentOwner()) return;
          if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
            await forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey,
              createdAt,
            });
            setError(t('session.new.worktreeSettingsSaving'));
            return;
          }
          const createRequest = buildWorktreeCreateRequest({
            sessionId,
            eligibility: worktreeIntent.eligibility,
            sourceBranch: worktreeIntent.sourceBranch,
            suggestedName: suggested,
            recoveryKey,
          });
          const resp = parseWorktreeCreateResult(
            await maker.worktree.create(createRequest),
            createRequest,
          );
          if (!isCurrentOwner()) return;
          if (!resp) {
            setError(t('session.new.worktreeCleanupPending'));
            return;
          }
          if (!resp.ok) {
            await forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey,
              createdAt,
            });
            if (!isCurrentOwner()) return;
            setError(formatWorktreeCreateFailure(resp.error));
            return;
          }
          precreatedWorktree = {
            path: resp.meta.path,
            recoveryKey,
            originalWorkingDir: effectiveDraft.workingDir,
            createdAt,
          };
          // ㉙ 远端目录已产生 → 切设备必须走 ledger 补偿(forget + 释放内存持有,
          // 远端目录留给下次 recovery 对账回收)。
          if (await abortIfDeviceSwitched()) return;
          // 回包后尽力把 path 补到账本；即使这次更新失败，首次已确认落盘的
          // recoveryKey reservation 仍足够让重启后的进程从被控端解析真实路径。
          await registerPendingPrecreatedWorktree(worktreeAccountId, {
            sessionId,
            deviceId: selectedDeviceId,
            path: precreatedWorktree.path,
            recoveryKey,
            createdAt,
            phase: 'precreated',
          });
          if (!isCurrentOwner()) return;
          if (await abortIfDeviceSwitched()) return;
          effectiveDraft = { ...effectiveDraft, workingDir: resp.meta.path };
        } catch {
          if (!isCurrentOwner()) return;
          // invoke 抛错时无法判断工作端是否已经完成创建；保留 reservation，
          // 交给当前进程重连或下次冷启动按 recoveryKey 精确对账。
          setError(t('session.new.worktreeCleanupPending'));
          return;
        }
      }
      // 提交点联合终检(Greptile/Codex review P1):目录就绪后的清理 effect 跑在渲染后,
      // 用户可能在清理生效前点创建——创建路径自身必须守卫;来源失效时 model 随之一并
      // 回退(其他来源顶替 / 首项 / 内置默认),并同步校准 effort、组合变化时 fastMode
      // 保守置 false(codex review P2)。代际安全版(独立 review P1-1):唯一数据源 =
      // 设备缓存 + 代际,不再读渲染期 rows(catalogReadyRef 是渲染镜像,驱逐窗口内
      // 不可信);缓存命中即当前代已确认目录;未命中且曾驱逐 → join 在途重拉,await
      // 前后核对代际,换代即弃用旧返回值 join 新代;拉失败 → 未知 → 信任。
      // 设备/代际复核均已完成(abort 前置),循环后同步 ensureDeviceAlive 兜底——
      // 已切换则放弃,precreated ledger 保留交 recovery(不做 ACK 补偿)。
      {
        // 独立 review round-21 Spec P1:所有可取消 await(abort)前置到终检循环之前;
        // 终检循环每轮 await 返回后**同步**核对 genAt;最后一次核对后零 await 直至
        // handoff(同一 turn)——杜绝「核对后让出微任务期间换代,再按旧目录应用」。
        if (await abortIfDeviceSwitched()) return;
        const guardDeviceId = deviceAtCreate;
        const guardSelected = () => ({
          model: effectiveDraft.model,
          providerId: effectiveDraft.providerId,
        });
        const runGuard = () => resolveSubmitGuardCatalog({
          cached: () => getCachedDeviceProviders(guardDeviceId),
          gen: () => getDeviceProvidersGen(guardDeviceId),
          // 强制刷新(codex review P2):fetchDeviceProviders 缓存命中直接返回旧目录,
          // revalidate 拿不到工作站真相——必须绕过缓存读,成功后缓存层回写。
          fetch: () => fetchDeviceProvidersFresh(guardDeviceId, () => maker.listProviders()),
          buildRows: (payload) => flattenProviderSections(buildMobileModelSections({
            providers: payload.providers,
            agentKind: effectiveDraft.agentKind,
            visibilityOverrides: payload.modelVisibilityOverrides,
            // 选中行豁免与渲染期口径一致(独立 review P2)。
            selectedModelId: effectiveDraft.model,
            selectedProviderId: effectiveDraft.providerId,
          }).sections),
        });
        const applyGuard = (g: { rows: readonly ProviderModelRow[]; catalogKnown: boolean }): void => {
          const resolved = resolveRecentModelAndProvider(
            g.rows,
            guardSelected(),
            effectiveDraft.agentKind,
            g.catalogKnown,
          );
          const pairChanged = resolved.model !== effectiveDraft.model || resolved.providerId !== effectiveDraft.providerId;
          // 目录就绪时**始终**按 fresh 精确行校准(codex review P2:来源未变时也按
          // 新目录校准运行选项)——provider revision 可能只改能力不删行(撤销 effort
          // 档位 / Fast 支持),组合不变沿用旧 effort/fastMode 会发送目录已不支持的
          // 参数被被控端拒绝。fail-open(catalogKnown=false)时 rows 不可信,保持
          // 信任语义(不校准,仅组合变化保守关 fast)。
          effectiveDraft = {
            ...effectiveDraft,
            ...resolved,
            ...(g.catalogKnown ? {
              effort: reconcileEffortAfterFallback(g.rows, resolved, effectiveDraft.effort),
              ...(effectiveDraft.fastMode && (
                pairChanged
                || !resolved.providerId
                || !isFastRestorable(
                  effectiveDraft.agentKind,
                  resolved.providerId,
                  resolved.model,
                  g.rows,
                  targetAgentHasFast(guardDeviceId, effectiveDraft.agentKind),
                )
              ) ? { fastMode: false } : {}),
            } : pairChanged ? {
              ...(effectiveDraft.fastMode ? { fastMode: false } : {}),
            } : {}),
          };
        };
        // 有界稳定循环:每轮 await 返回后同步核对 genAt,稳定才退出(≤3)。
        // 哨兵初值必被首轮循环覆盖(for 循环体至少执行一次),消除 null 收窄。
        let guardResult: { rows: readonly ProviderModelRow[]; catalogKnown: boolean; genAt: number } = {
          rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
        };
        for (let pass = 0; pass < 3; pass += 1) {
          guardResult = await runGuard();
          if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
        }
        if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
          // 耗尽仍不稳定(独立 review round-22 Spec P1):不得采信最后已知 rows——
          // 显式降为 unknown/fail-open(rows 空 + catalogKnown=false,信任既有绑定)。
          guardResult = {
            rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
          };
        }
        // 循环后同步设备复核(不让出微任务):已切换则放弃,precreated ledger 保留交
        // recovery(不做 ACK 补偿,避免在循环末尾再引入可取消 await)。
        if (!ensureDeviceAlive()) return;
        applyGuard(guardResult);
      }
      const agentKindSnapshot = effectiveDraft.agentKind;
      const deviceIdSnapshot = selectedDeviceId;
      // 老协议 plan 一次性语义(对齐桌面 PR#494):入队后恢复进入前的底层权限档。
      const legacyPlanRestore = effectiveDraft.permissionMode === 'plan'
        ? (() => {
          const fallback = runtimeOptions.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask';
          const remembered = prePlanPermissionModeRef.current;
          return remembered && remembered !== 'plan' ? remembered : fallback;
        })()
        : null;
      if (!isCurrentOwner()) return;
      startNewSessionCreation({
        sessionId,
        deviceId: deviceIdSnapshot,
        deviceName: selectedDeviceName,
        draft: effectiveDraft,
        attachments: sendAttachments,
        planModeArm: planModeCapability && planModeDraftOn,
        legacyPlanRestore,
        precreatedWorktree,
        precreatedWorktreeAccountId: worktreeAccountId,
        // stale-ready 防护(review P1):缓存判 ready/unknown 也可能已过期。管线内
        // 与建链并行 revalidate。无条件让管线自做 fresh 检查(codex review P2):
        // 表单内预检放行(新来源已连接/空响应/瞬断)后还要经历 worktree、目录
        // guard、建链、订阅多个 await,期间来源可能再变——verdict 分支若把管线
        // fresh 替换成 null 会绕过最后的联合终检。
        confirmUnauthenticated: () => confirmAgentUnauthenticated(agentKindSnapshot, deviceIdSnapshot),
        // 鉴权 fresh 之后联合校验 (model, providerId)(codex review P2):建链/鉴权
        // 期间工作站可能已替换 provider——patch 覆盖本次创建,不再向已删除来源发。
        revalidateDraftAfterAuth: async (fresh) => {
          const rows = flattenProviderSections(buildMobileModelSections({
            providers: fresh.providers,
            agentKind: effectiveDraft.agentKind,
            visibilityOverrides: fresh.modelVisibilityOverrides,
            selectedModelId: effectiveDraft.model,
            selectedProviderId: effectiveDraft.providerId,
          }).sections);
          const resolved = resolveRecentModelAndProvider(
            rows,
            { model: effectiveDraft.model, providerId: effectiveDraft.providerId },
            effectiveDraft.agentKind,
            true,
          );
          const pairChanged = resolved.model !== effectiveDraft.model
            || resolved.providerId !== effectiveDraft.providerId;
          // codex review P2:来源未变也按 fresh 精确行校准——fresh 目录就绪时始终
          // 重校准 effort + Fast 支持(provider revision 只改能力不删行:撤销档位/
          // Fast 时组合不变也要关),不得因 pairChanged=false 提前返回发旧参数。
          return {
            ...resolved,
            effort: reconcileEffortAfterFallback(rows, resolved, effectiveDraft.effort),
            ...(effectiveDraft.fastMode && (
              pairChanged
              || !resolved.providerId
              || !isFastRestorable(
                effectiveDraft.agentKind,
                resolved.providerId,
                resolved.model,
                rows,
                targetAgentHasFast(selectedDeviceId, effectiveDraft.agentKind),
              )
            ) ? { fastMode: false } : {}),
          };
        },
        authGateHint: agentAuthGateHint(agentKindSnapshot),
        onUnauthenticated: () => evictDeviceProviders(deviceIdSnapshot),
        isCurrentOwner,
        transport: {
          maker,
          openLink,
          subscribe,
          prepareQueuedMessage: (item) => prepareMobileQueuedSessionReferences(
            item,
            invoke,
            remoteSessionStore.getSessionDeviceId,
            deviceIdSnapshot,
          ),
        },
      });
      if (!isCurrentOwner()) return;
      if (planModeCapability) {
        // 一次性语义:chip 状态只影响这一次创建,创建后复位草稿态。
        setPlanModeDraftOn(false);
      }
      voiceDictionaryLearningTrackerRef.current?.flush();
      // 本页即将 unmount 跳转会话页,标注私有缓存(源图 / 烧录图副本)清一遍
      // (review P2——此前只有目标流有这行,首条消息发送成功路径漏了,标注
      // 缓存文件永久留在本地)。
      composerAnnotationsRef.current?.forgetAllAttachments();
      handedOff = true;
      router.replace({
        pathname: '/sessions/[sessionId]',
        params: { sessionId, deviceId: deviceIdSnapshot, deviceName: selectedDeviceName },
      });
    } catch (err) {
      if (!isCurrentOwner()) return;
      // agent 未鉴权(电脑端没配 key / 没登录)是新任务失败的高频原因。
      // state 保留结构化原文，渲染时再按当前语言生成引导，避免切换语言后缓存旧文案。
      const raw = formatRemoteError(err);
      setError(raw);
    } finally {
      releasePrecreatedRegistration?.();
      if (!handedOff) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  }, [
    agentAuthVerdict,
    auth.user?.id,
    confirmAgentUnauthenticated,
    deviceLinkStatus,
    selectedDeviceId,
    selectedDeviceName,
    draft,
    finishVoiceRecording,
    getPresenceAvailability,
    maker,
    openLink,
    planModeCapability,
    planModeDraftOn,
    router,
    runtimeOptions,
    subscribe,
    t,
    voiceIsProcessing,
    voiceState,
    waitForPendingUploads,
    worktreeEligibility,
    worktreeCreateBlocked,
    worktreeApplicable,
    worktreeBranchPreferenceKey,
    worktreeBranchPreferenceSyncKey,
    worktreeCaptionKey,
    worktreeEnabled,
    captureWorktreeCreateIntent,
    isWorktreeCreateIntentCurrent,
  ]);

  // 目标模式建会话(对齐桌面 handleCreateGoal):createSession → goal.set(被控端落
  // 目标消息 + 自动开跑第一轮)→ 跳转会话页。不走普通首条消息发送,目标文案即对话起点;
  // composer 附件不随目标带入(与桌面一致)。goal.set 失败时报错留在面板,会话已创建,
  // 用户可进会话重设目标,重试本表单会新建会话。
  const createGoalSession = useCallback(async (input: { objective: string; limits?: MobileGoalLimitsInput }) => {
    if (creatingRef.current || goalBusy) return;
    if (!selectedDeviceId) {
      setGoalError(t('session.new.selectDeviceError'));
      return;
    }
    if (draft.workspaceKind === 'project' && !draft.workingDir.trim()) {
      setGoalError(t('session.new.enterProjectPath'));
      return;
    }
    if (!draft.model.trim()) {
      setGoalError(t('session.new.enterModel'));
      return;
    }
    if (
      worktreeApplicable
      && worktreeEligibility.status !== 'ineligible'
      && (
        worktreePreferenceWriteTargetRef.current === selectedDeviceId
        || worktreePreferenceAuthorityUnknownByDeviceRef.current.has(selectedDeviceId)
        || worktreePreferenceReadyKeyRef.current !== worktreePreferenceSyncKeyRef.current
      )
    ) {
      setGoalError(t('session.new.worktreeSettingsSaving'));
      return;
    }
    if (
      worktreeEnabled
      && (
        worktreeBranchPreferenceWriteTargetRef.current === worktreeBranchPreferenceKey
        || (
          worktreeEligibility.status === 'eligible'
          && worktreeBranchPreferenceReadyKeyRef.current !== worktreeBranchPreferenceSyncKey
        )
      )
    ) {
      setGoalError(t('session.new.worktreeBranchSaving'));
      return;
    }
    // Goal 与普通创建共享同一 Worktree 门禁。分支偏好和 checkbox 仍是
    // 独立轴：OFF 时直接走 base repo，ON 时必须等偏好/资格确认完成。
    if (worktreeCreateBlocked) {
      setGoalError(worktreeCaptionKey
        ? t(worktreeCaptionKey)
        : t('session.new.worktreeSettingsSaving'));
      return;
    }
    const worktreeIntent = captureWorktreeCreateIntent();
    if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
      setGoalError(t('session.new.worktreeSettingsSaving'));
      return;
    }
    // ㉙ 设备守卫入口(独立 review P1-1 + busy 泄漏):快照取自闭包 selectedDeviceId,
    // 入口与 ref 核对必须发生在**加锁之前**——加锁后 return 会绕过 finally,busy
    // 状态永久泄漏(独立 review round-20 Standards P1)。
    const deviceAtCreate = selectedDeviceId;
    if (selectedDeviceRef.current !== deviceAtCreate) return;
    creatingRef.current = true;
    setCreating(true);
    setGoalBusy(true);
    setGoalError(null);
    let releasePrecreatedRegistration: (() => void) | null = null;
    let precreatedWorktree: {
      sessionId: string;
      path: string;
      recoveryKey: string;
      originalWorkingDir: string;
      createdAt?: number;
    } | undefined;
    let sessionId = '';
    let sessionClaimed = false;
    let sessionCreateStarted = false;
    const accountIdAtCreate = auth.user?.id?.trim() ?? '';
    const authOwnerAtCreate = getMobileAuthOwner();
    const worktreeAccountId = authOwnerAtCreate.accountId;
    const isCurrentOwner = () => (
      authOwnerAtCreate.accountId === accountIdAtCreate
      && isMobileAuthOwnerCurrent(authOwnerAtCreate)
    );
    // ㉙ 设备守卫全程化(独立 review P1-1/P1-2):此后每次 await 后、每个 device-scoped
    // 副作用前、最终 createSession 前复核。
    const ensureDeviceAlive = (): boolean => selectedDeviceRef.current === deviceAtCreate;
    // ㉙ 设备切换中止助手(独立 review P1-3):precreated 阶段先 discardPrecreated 获
    // 严格 ACK 才 forget(forget 删唯一账本,未 discard 就删 = 永久孤儿);ACK 失败/
    // 未知保留 ledger 交 recovery。reserved 阶段由各写盘点的内联 forget 处理。
    const abortIfDeviceSwitched = async (): Promise<boolean> => {
      if (ensureDeviceAlive()) return false;
      if (precreatedWorktree) {
        const pwt = precreatedWorktree;
        await compensatePrecreatedWorktree({
          sessionId: pwt.sessionId,
          recoveryKey: pwt.recoveryKey,
          createdAt: pwt.createdAt ?? Date.now(),
          phase: 'precreated',
          discard: () => maker.worktree.discardPrecreated({
            sessionId: pwt.sessionId,
            recoveryKey: pwt.recoveryKey,
          }),
          parseAck: parseDiscardPrecreatedAck,
          forget: () => forgetPendingPrecreatedWorktree(worktreeAccountId, {
            sessionId: pwt.sessionId,
            recoveryKey: pwt.recoveryKey,
            createdAt: pwt.createdAt ?? Date.now(),
          }),
          release: releasePrecreatedRegistration,
        });
      }
      return true;
    };
    try {
      if (!isCurrentOwner()) return;
      // 鉴权门禁(review P2:goal 模式与普通创建同屏同 agent,同样要拦):goal.set 会吞掉
      // fireTurn 的鉴权失败,用户会被带进一个永远跑不起来的目标会话——比普通路径更需要
      // 提前拦截。判定与 create() 完全同款:缓存判死先现拉确认;ready/unknown 与建链并行重验。
      if (agentAuthVerdict === 'unauthenticated') {
        if ((await confirmAgentUnauthenticated(draft.agentKind, selectedDeviceId)).unauthenticated) {
          if (!isCurrentOwner()) return;
          if (!ensureDeviceAlive()) return;
          setGoalError(agentAuthGateHint(draft.agentKind));
          return;
        }
        if (!isCurrentOwner()) return;
        if (!ensureDeviceAlive()) return;
        evictDeviceProviders(selectedDeviceId);
      }
      const freshAuth: Promise<{ unauthenticated: boolean; fresh: DeviceProvidersPayload | null }> =
        agentAuthVerdict === 'unauthenticated'
          ? Promise.resolve({ unauthenticated: false, fresh: null })
          : confirmAgentUnauthenticated(draft.agentKind, selectedDeviceId);
      if (!isCurrentOwner()) return;
      // Resolve the fresh auth check before any worktree副作用. A Goal auth
      // rejection must not leave a managed directory behind just because its
      // session path performs precreation before createSession.
      const authResult = await freshAuth;
      if (authResult.unauthenticated) {
        if (!isCurrentOwner()) return;
        if (!ensureDeviceAlive()) return;
        evictDeviceProviders(selectedDeviceId);
        setGoalError(agentAuthGateHint(draft.agentKind));
        return;
      }
      if (!ensureDeviceAlive()) return;

      // Worktree 预创建与普通创建保持同一 recovery 账本语义：先恢复旧
      // obligation，再把 reservation 写盘，最后才产生 worktree:create 副作用。
      // Goal 不能因为走 goal.set 就绕过这道门，否则会把会话落回 base repo。
      if (
        worktreeIntent.applicable
        && worktreeIntent.enabled
        && worktreeIntent.eligibility.status === 'eligible'
      ) {
        if (!worktreeAccountId) {
          setGoalError(t('session.new.worktreeRecoveryStateFailed'));
          return;
        }
        const sessionIsClaimed = (pendingSessionId: string) => (
          getNewSessionCreationTask(pendingSessionId) !== null
          || isPrecreatedWorktreeRegistrationInFlight(pendingSessionId)
        );
        const recovery = await recoverPendingPrecreatedWorktrees(worktreeAccountId, {
          openLink,
          discardPrecreated: async (_deviceId, recoveryInput) => (
            maker.worktree.discardPrecreated(recoveryInput)
          ),
          isSessionClaimed: async (_deviceId, pendingSessionId) => (
            isExactRemoteSessionClaimed(
              pendingSessionId,
              (id) => maker.getSession(id),
            )
          ),
          shouldDefer: (record) => (
            record.deviceId !== selectedDeviceId
            || sessionIsClaimed(record.sessionId)
          ),
          isCurrent: isCurrentOwner,
        });
        if (!isCurrentOwner()) return;
        if (!ensureDeviceAlive()) return;
        if (!recovery.storageReadable || recovery.retained > 0) {
          setGoalError(t('session.new.worktreeCleanupPending'));
          return;
        }
        if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
          setGoalError(t('session.new.worktreeSettingsSaving'));
          return;
        }
      }

      sessionId = createNewSessionId();
      let effectiveDraft = draft;
      if (
        worktreeIntent.applicable
        && worktreeIntent.enabled
        && worktreeIntent.eligibility.status === 'eligible'
      ) {
        try {
          if (!isCurrentOwner()) return;
          let suggested: string | null = null;
          try {
            suggested = await maker.worktree
              .suggestName(worktreeIntent.eligibility.baseRepo)
              .then((result) => result.name);
          } catch {
            suggested = null;
          }
          if (!isCurrentOwner()) return;
          if (!ensureDeviceAlive()) return;
          if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
            setGoalError(t('session.new.worktreeSettingsSaving'));
            return;
          }
          const recoveryKey = createNewSessionId();
          const createdAt = Date.now();
          releasePrecreatedRegistration = holdPrecreatedWorktreeRegistration(sessionId);
          const reservationRecorded = await registerPendingPrecreatedWorktree(
            worktreeAccountId,
            {
              sessionId,
              deviceId: selectedDeviceId,
              recoveryKey,
              createdAt,
              phase: 'reserved',
            },
          );
          if (!isCurrentOwner()) return;
          // ㉙ 写盘 reservation 后切设备 → 清掉这份 obligation(reserved 无远端目录)。
          if (!ensureDeviceAlive()) {
            await forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey,
              createdAt,
            }).catch(() => undefined);
            return;
          }
          if (!reservationRecorded) {
            setGoalError(t('session.new.worktreeRecoveryStateFailed'));
            return;
          }
          if (!isWorktreeCreateIntentCurrent(worktreeIntent)) {
            await forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey,
              createdAt,
            });
            setGoalError(t('session.new.worktreeSettingsSaving'));
            return;
          }
          const createRequest = buildWorktreeCreateRequest({
            sessionId,
            eligibility: worktreeIntent.eligibility,
            sourceBranch: worktreeIntent.sourceBranch,
            suggestedName: suggested,
            recoveryKey,
          });
          const response = parseWorktreeCreateResult(
            await maker.worktree.create(createRequest),
            createRequest,
          );
          if (!isCurrentOwner()) return;
          if (!response) {
            setGoalError(t('session.new.worktreeCleanupPending'));
            return;
          }
          if (!response.ok) {
            await forgetPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId,
              recoveryKey,
              createdAt,
            });
            setGoalError(formatWorktreeCreateFailure(response.error));
            return;
          }
          precreatedWorktree = {
            sessionId,
            path: response.meta.path,
            recoveryKey,
            originalWorkingDir: draft.workingDir,
            createdAt,
          };
          await registerPendingPrecreatedWorktree(worktreeAccountId, {
            sessionId,
            deviceId: selectedDeviceId,
            path: response.meta.path,
            recoveryKey,
            createdAt,
            phase: 'precreated',
          });
          if (!isCurrentOwner()) return;
          // ㉙ 远端目录已产生 → 切设备走 ledger 补偿。
          if (await abortIfDeviceSwitched()) return;
          effectiveDraft = { ...draft, workingDir: response.meta.path };
        } catch {
          if (!isCurrentOwner()) return;
          // create 回包前工作端可能已经完成副作用；reservation 保留给下一次
          // recovery 对账，不能在这里静默当作普通目录继续创建。
          setGoalError(t('session.new.worktreeCleanupPending'));
          return;
        }
      }
      void saveNewSessionPreferences({
        agentKind: draft.agentKind,
        device: {
          deviceId: selectedDeviceId,
          name: selectedDeviceName || selectedDeviceId,
        },
      });
      // 提交点联合终检(同 create(),代际安全版独立 review P1-1/P1-2):唯一数据源 =
      // 设备缓存 + 代际;缓存命中即当前代已确认目录;未命中且曾驱逐 → join 在途重拉
      // (await 前后核对代际);拉失败 → 未知 → 信任。started 落账后设备切换 →
      // resolveStartedDowngradeOrCommit(降级成功 return / 失败恢复 volatile 后
      // 重跑 guard 继续 commit);apply 后零 await 至 createSession。
      if (!ensureDeviceAlive()) return;
      const guardDeviceId = deviceAtCreate;
      const guardSelected = () => ({
        model: effectiveDraft.model,
        providerId: effectiveDraft.providerId,
      });
      const runGuard = () => resolveSubmitGuardCatalog({
        cached: () => getCachedDeviceProviders(guardDeviceId),
        gen: () => getDeviceProvidersGen(guardDeviceId),
        // 强制刷新(同 create() 口径,codex review P2):revalidate 必须访问工作站。
        fetch: () => fetchDeviceProvidersFresh(guardDeviceId, () => maker.listProviders()),
        buildRows: (payload) => flattenProviderSections(buildMobileModelSections({
          providers: payload.providers,
          agentKind: effectiveDraft.agentKind,
          visibilityOverrides: payload.modelVisibilityOverrides,
          // 选中行豁免与渲染期口径一致(独立 review P2)。
          selectedModelId: effectiveDraft.model,
          selectedProviderId: effectiveDraft.providerId,
        }).sections),
      });
      const applyGuard = (g: { rows: readonly ProviderModelRow[]; catalogKnown: boolean }): void => {
        const resolved = resolveRecentModelAndProvider(
          g.rows,
          guardSelected(),
          effectiveDraft.agentKind,
          g.catalogKnown,
        );
        const pairChanged = resolved.model !== effectiveDraft.model || resolved.providerId !== effectiveDraft.providerId;
        // codex review P2:目录就绪时**始终**按 fresh 精确行校准(来源未变也按新
        // 目录校准运行选项)——provider revision 只改能力不删行(撤销 effort 档位
        // /Fast 支持)时,组合不变沿用旧 effort/fastMode 会发送目录已不支持的参数
        // 被被控端拒绝。fail-open(catalogKnown=false)时 rows 不可信,保持信任语义。
        effectiveDraft = {
          ...effectiveDraft,
          ...resolved,
          ...(g.catalogKnown ? {
            effort: reconcileEffortAfterFallback(g.rows, resolved, effectiveDraft.effort),
            ...(effectiveDraft.fastMode && (
              pairChanged
              || !resolved.providerId
              || !isFastRestorable(
                effectiveDraft.agentKind,
                resolved.providerId,
                resolved.model,
                g.rows,
                targetAgentHasFast(guardDeviceId, effectiveDraft.agentKind),
              )
            ) ? { fastMode: false } : {}),
          } : pairChanged ? {
            ...(effectiveDraft.fastMode ? { fastMode: false } : {}),
          } : {}),
        };
      };
      // ── prepare 段(可取消):连接 + abort 前置,终检循环每轮 await 后同步核对 genAt ──
      await withTransientRemoteRetry(async () => {
        if (!isCurrentOwner()) return;
        await openLink(selectedDeviceId);
        if (!isCurrentOwner()) return;
        await subscribe(`new-session:${selectedDeviceId}`, selectedDeviceId, ['sessions']);
        if (!isCurrentOwner()) return;
      });
      if (!isCurrentOwner()) return;
      if (await abortIfDeviceSwitched()) return; // 可取消 await 全部在此
      // 有界稳定循环(独立 review round-21 Spec P1):每轮 await 返回后**同步**核对
      // genAt,稳定才退出(≤3)。
      // 哨兵初值必被首轮循环覆盖(for 循环体至少执行一次),消除 null 收窄。
      let guardResult: { rows: readonly ProviderModelRow[]; catalogKnown: boolean; genAt: number } = {
        rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
      };
      for (let pass = 0; pass < 3; pass += 1) {
        guardResult = await runGuard();
        if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
      }
      if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
        // 耗尽仍不稳定(独立 review round-22 Spec P1):显式降为 unknown/fail-open,
        // 不采信最后已知 rows。
        guardResult = {
          rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
        };
      }
      // 终检刷新(await 网络往返)期间设备可能已切换:进入 commit 段前复核
      // (greptile P1:终检后遗漏设备复核)——precreatedWorktree 存在时补偿 ledger
      // 后中止;不存在(无 worktree 的 Goal 路径)时直接中止。避免闭包绑定的旧设备
      // 在界面已切换后仍创建当前界面未接管的会话。
      // 同步快路径(codex 独立审核者 P1):abortIfDeviceSwitched 是 async,设备未
      // 切换时 await 也会让出微任务——ref 更新排队时「复核通过 → 让出 → 设备切换 →
      // continuation 不再复核」竞态。先同步 ensureDeviceAlive,未切换零 await 直达
      // handoff(维持「最后核对后零 await」不变量);已切换才异步补偿并中止。
      if (!ensureDeviceAlive()) {
        await abortIfDeviceSwitched();
        return;
      }
      // Goal 最终创建前重新执行鉴权门禁(codex review P2):freshAuth 在 worktree
      // 创建/建链等异步步骤之前完成;guard 虽刷新目录却只校准草稿、不重算
      // connectedProvidersForAgent——来源在准备期间断开时,仍会在无可用来源时
      // 调用 createSession/goal.set。用最新目录行重验,目录就绪且无已连接来源 →
      // 中止(与 create() 的鉴权门禁同口径)。fail-open(catalogKnown=false)时
      // rows 不可信,保持信任语义不拦截。
      if (guardResult.catalogKnown) {
        // 用**未过滤**的原始目录计算连接数(codex review P2:用未过滤的目录执行
        // Goal 最终鉴权)——guardResult.rows 经 buildMobileModelSections 只保留
        // connectedProvidersForAgent 的供应商,来源全部断开时 rows 恰好为空,
        // 「rows.length > 0」条件会让零已连接来源场景漏过门禁。fetchDeviceProvidersFresh
        // 成功已按代际写回缓存,缓存即未过滤的原始 providers。
        const rawProviders = getCachedDeviceProviders(guardDeviceId)?.providers ?? [];
        if (rawProviders.length > 0
          && connectedProvidersForAgent(rawProviders, draft.agentKind).length === 0) {
          if (!isCurrentOwner()) return;
          if (!ensureDeviceAlive()) return;
          setGoalError(agentAuthGateHint(draft.agentKind));
          return;
        }
      }
      // ── commit 段:started 写盘(await)后同步核对 genAt;此后无裸 return ──
      if (precreatedWorktree) {
        const startedRecorded = await registerPendingPrecreatedWorktree(
          worktreeAccountId,
          {
            sessionId: precreatedWorktree.sessionId,
            deviceId: selectedDeviceId,
            path: precreatedWorktree.path,
            recoveryKey: precreatedWorktree.recoveryKey,
            createdAt: precreatedWorktree.createdAt ?? Date.now(),
            phase: 'session-create-started',
          },
        );
        if (!startedRecorded) {
          // 落账失败:register 在首个 await 前已把 volatile 升级为 started——
          // 降级回 precreated(可回收阶段),避免 retain-only 卡死 recovery
          // (独立 review round-21 Spec P1-3)。会话未创建,不得删账。
          await registerPendingPrecreatedWorktree(worktreeAccountId, {
            sessionId: precreatedWorktree.sessionId,
            deviceId: selectedDeviceId,
            path: precreatedWorktree.path,
            recoveryKey: precreatedWorktree.recoveryKey,
            createdAt: precreatedWorktree.createdAt ?? Date.now(),
            phase: 'precreated',
          }).catch(() => undefined);
          setGoalError(t('session.new.worktreeRecoveryStateFailed'));
          return;
        }
        sessionCreateStarted = true;
        // started await 期间可能换代 → 每轮 await 后同步核对(≤2);耗尽仍不稳定
        // → 显式降为 unknown/fail-open。
        for (let pass = 0; pass < 2; pass += 1) {
          if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
          guardResult = await runGuard();
          if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
        }
        if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
          guardResult = {
            rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
          };
        }
        // started 写盘后重跑 guard 拿到新目录 → 再次执行鉴权门禁(codex review P2:
        // 在 started 写盘后的目录重验中同步重跑鉴权)——供应商在前面的最终鉴权
        // 通过后、registerPendingPrecreatedWorktree(session-create-started) 等待
        // 期间可能全部断开,代际变化后这里重取到零已连接来源目录,但 4750 行门禁
        // 已执行过不会重跑。中止按 started 账本语义走 resolveStartedDowngradeOrCommit
        // (与下方设备切换同路径,不裸 return 留 retain-only)。
        if (guardResult.catalogKnown) {
          const rawProviders = getCachedDeviceProviders(guardDeviceId)?.providers ?? [];
          if (rawProviders.length > 0
            && connectedProvidersForAgent(rawProviders, draft.agentKind).length === 0) {
            const pwt = precreatedWorktree;
            const decision = await resolveStartedDowngradeOrCommit({
              downgrade: () => registerPendingPrecreatedWorktree(worktreeAccountId, {
                sessionId: pwt.sessionId,
                deviceId: selectedDeviceId,
                path: pwt.path,
                recoveryKey: pwt.recoveryKey,
                createdAt: pwt.createdAt ?? Date.now(),
                phase: 'precreated',
              }),
              restoreStarted: () => registerPendingPrecreatedWorktree(worktreeAccountId, {
                sessionId: pwt.sessionId,
                deviceId: selectedDeviceId,
                path: pwt.path,
                recoveryKey: pwt.recoveryKey,
                createdAt: pwt.createdAt ?? Date.now(),
                phase: 'session-create-started',
              }),
            });
            if (decision === 'downgraded') {
              setGoalError(agentAuthGateHint(draft.agentKind));
              return;
            }
            // 降级失败 → 继续 commit(与设备切换降级失败同语义:恢复 volatile 后
            // 用捕获设备完成创建;目录虽空但创建可能仍成功,由 goal.set/外层
            // catch 兜底呈现失败)。
            // 降级/恢复 await 窗口可能换代(codex review P2):重跑有界 guard,
            // 耗尽降 unknown/fail-open——来源恢复或替换为 B 时用新目录校准草稿,
            // 不再按等待前的空/旧目录回退默认路由或携带失效来源创建(与下方设备
            // 切换 commit 分支的 re-fence 同口径)。
            for (let pass = 0; pass < 2; pass += 1) {
              guardResult = await runGuard();
              // re-fence 的 runGuard await 期间设备切换:提前 break,立即交下方
              // 设备切换分支按 started 账本语义 resolveStartedDowngradeOrCommit
              // 降级(不裸 return 留 retain-only,也不继续向旧设备 commit)。
              if (!ensureDeviceAlive()) break;
              if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
            }
            if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
              guardResult = {
                rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
              };
            }
          }
        }
        // started 可靠落账后设备切换:不裸 return(会留 started retain-only,recovery
        // 对该 phase 拒绝 discard)——走 resolveStartedDowngradeOrCommit:
        // 降级成功 → return(recovery 可回收);降级失败 → 恢复 volatile 回 started
        // 后继续用捕获设备完成 commit(round-23 Spec P1-2:防 recovery 读到
        // precreated 对未知创建做 destructive discard;动态 clientRef 残余已声明)。
        if (!ensureDeviceAlive()) {
          const pwt = precreatedWorktree;
          const decision = await resolveStartedDowngradeOrCommit({
            downgrade: () => registerPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId: pwt.sessionId,
              deviceId: selectedDeviceId,
              path: pwt.path,
              recoveryKey: pwt.recoveryKey,
              createdAt: pwt.createdAt ?? Date.now(),
              phase: 'precreated',
            }),
            restoreStarted: () => registerPendingPrecreatedWorktree(worktreeAccountId, {
              sessionId: pwt.sessionId,
              deviceId: selectedDeviceId,
              path: pwt.path,
              recoveryKey: pwt.recoveryKey,
              createdAt: pwt.createdAt ?? Date.now(),
              phase: 'session-create-started',
            }),
          });
          if (decision === 'downgraded') return;
          // 降级失败 → commit;降级 await 窗口可能换代(round-23 Spec P1-1)→ 重跑
          // 有界 guard,耗尽降 unknown/fail-open;此后零 await 应用 + createSession。
          for (let pass = 0; pass < 2; pass += 1) {
            guardResult = await runGuard();
            if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
          }
          if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
            guardResult = {
              rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
            };
          }
        }
      }
      // 同一 turn:同步应用 + createSession,零 await 间隔(独立 review round-21 Spec P1)。
      // 注意:不用 authResult.fresh 再校验一次(codex review P2)——authResult 在
      // worktree 创建/建链/guard 之前取得,比守卫目录旧;guard 已用
      // fetchDeviceProvidersFresh 强制刷新(离创建最近的目录快照),旧快照只会把
      // guard 的新结果回退成旧来源。
      applyGuard(guardResult);
      const finalDraft = {
        ...effectiveDraft,
      };
      const createOpts = {
        ...buildRemoteCreateSessionOptions(finalDraft),
        // 与 worktree:create 共用预生成 id，确保被控端能把 managed path
        // 绑定到这一个 Goal session，而不是另起一条 base-repo 会话。
        id: sessionId,
      };
      const created = await maker.createSession(createOpts);
      const result = normalizeCreateSessionResult(created);
      if (!result) {
        throw new Error(t('session.new.noSessionIdReturned'));
      }
      if (result.sessionId !== sessionId) {
        throw new Error(t('session.new.sessionIdNotAdopted'));
      }
      sessionClaimed = true;
      // goal.set 前置(独立 review round-20 Spec P1-3):createSession 成功后立即完成
      // goal.set,不留「已创建但无目标」的远端会话;本地同步/UI 属 settle 段,排在其后。
      // 注(残余声明):maker 只绑定 deviceId 字符串,底层 invoke 每次读取
      // clientRef.current——飞行中跨账号/设备切换时 createSession 与 goal.set 可能
      // 落到不同 client,属已接受的传输层残余(host 原子 create-goal RPC 另列 issue)。
      // 不做自动重试(codex review P2):goal.set 非幂等(被控端无请求幂等键,二次
      // 调用进「编辑已有目标」分支会重落目标消息、停/重启轮次并重置计数)——仅
      // 当首次请求确认未执行才可重试,故失败直接进入接回:继续 settle 落账并跳转,
      // 目标未设置经 goalError 路由参数在会话页呈现,用户可在会话内重试设置目标。
      let goalSetError: string | null = null;
      try {
        await maker.goal.set({ sessionId: result.sessionId, objective: input.objective, ...(input.limits ? { limits: input.limits } : {}) });
      } catch (goalErr) {
        goalSetError = formatRemoteError(goalErr);
      }
      // ── settle 段(可降级):本地同步/UI,owner + 设备检查恢复正常语义 ──
      // 设备复核(greptile P1):goal.set 等待期间同账号可能切换设备——owner 检查
      // 拦不住,settle 若继续用旧 selectedDeviceId 会把设备 A 的会话写进当前
      // (设备 B)页面并跳转到设备 A 会话页,还可能让用户在 B 上重复创建;
      // 设备已切换则直接中止 settle(不跳转、不写错设备),createSession 已认领
      // worktree,无需 abortIfDeviceSwitched 补偿。
      if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      await subscribe(`session:${result.sessionId}`, selectedDeviceId, ['sessions', `session:${result.sessionId}`]).catch(() => undefined);
      if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      let session: RemoteSession;
      try {
        if (!isCurrentOwner() || !ensureDeviceAlive()) return;
        session = await maker.getSession(result.sessionId);
        if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      } catch {
        if (!isCurrentOwner() || !ensureDeviceAlive()) return;
        session = sessionFromCreateResult(result, {
          ...finalDraft,
          firstMessage: input.objective,
        });
      }
      if (isDefaultDraftSessionTitle(session.title)) {
        const titled = sessionFromCreateResult(result, {
          ...finalDraft,
          firstMessage: input.objective,
        });
        session = { ...session, title: titled.title };
      }
      if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      remoteSessionStore.upsertDeviceSession(selectedDeviceId, selectedDeviceName, session);
      if (session.title && !isDefaultDraftSessionTitle(session.title)) {
        remoteSessionStore.setPendingTitlePreview(result.sessionId, session.title);
      }
      if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      // 目标流不带 composer 附件(与桌面一致),跳转即丢引用:已上传的中转对象在此
      // best-effort 回收,否则成为 OSS 孤儿直到桶生命周期清理(codex review #504)。
      // 先等在途乐观上传落定,否则「回收后才落地」的图会漏出这轮清理。
      await waitForPendingUploads();
      if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      for (const attachment of attachmentsRef.current) {
        discardMobileUploadedAttachment(attachment, { getToken: () => auth.getAccessToken() });
      }
      setAttachments([]);
      setMediaAssetAttachments({});
      setAttachmentPreviews({});
      composerAnnotationsRef.current?.forgetAllAttachments();
      // 对齐桌面 onCreated:目标默认文字来自输入框,创建成功后清掉原文再跳转。
      patchDraft({ firstMessage: '' });
      router.replace({
        pathname: '/sessions/[sessionId]',
        params: {
          sessionId: result.sessionId,
          deviceId: selectedDeviceId,
          deviceName: selectedDeviceName,
          // goal.set 失败接回(codex review P2:保留失败 Goal 的表单内容):草稿已
          // 清空、目标页表单只从空 composer 初始化——把原输入经路由参数带到目标页,
          // 用户无需重填;limits 序列化为 JSON(目标页解析带防护,坏数据忽略)。
          ...(goalSetError ? {
            goalError: goalSetError,
            goalObjective: input.objective,
            ...(input.limits ? { goalLimits: JSON.stringify(input.limits) } : {}),
          } : {}),
        },
      });
    } catch (err) {
      if (!isCurrentOwner()) return;
      // 只有 session 尚未认领 worktree 时才补偿回收；Goal 已建成后 goal.set
      // 失败应保留会话和 managed path，不能误删用户正在使用的目录。
      if (precreatedWorktree && !sessionClaimed && worktreeAccountId) {
        try {
          // create-session may have committed remotely while its reply was
          // lost. Probe the exact pre-generated id before any destructive
          // discard; an unknown probe is treated as cleanup-pending.
          if (!isCurrentOwner()) return;
          await openLink(selectedDeviceId);
          if (!isCurrentOwner()) return;
          const claimedAfterError = await isExactRemoteSessionClaimed(
            precreatedWorktree.sessionId,
            (id) => maker.getSession(id),
          );
          if (!isCurrentOwner()) return;
          if (claimedAfterError) {
            sessionClaimed = true;
          }
          if (sessionClaimed) {
            setGoalError(formatRemoteError(err));
            return;
          }
          if (sessionCreateStarted) {
            // createSession crossed the durable retain-only fence. Even an
            // exact NOT_FOUND cannot rule out a malformed/wrong-id host result,
            // so neither retry nor destructive discard is safe.
            setGoalError(t('session.new.worktreeCleanupPending'));
            return;
          }
          if (!isCurrentOwner()) return;
          await withTransientRemoteRetry(async () => {
            if (!isCurrentOwner()) return;
            const discardResult = await maker.worktree.discardPrecreated({
              sessionId: precreatedWorktree!.sessionId,
              recoveryKey: precreatedWorktree!.recoveryKey,
            });
            if (!isCurrentOwner()) return;
            if (!parseDiscardPrecreatedAck(discardResult)) {
              throw new Error('Invalid pre-created worktree discard acknowledgement');
            }
          }, { maxAttempts: 2 });
          if (!isCurrentOwner()) return;
          await forgetPendingPrecreatedWorktree(worktreeAccountId, {
            sessionId: precreatedWorktree.sessionId,
            recoveryKey: precreatedWorktree.recoveryKey,
            ...(precreatedWorktree.createdAt !== undefined
              ? { createdAt: precreatedWorktree.createdAt }
              : {}),
          });
        } catch {
          if (!isCurrentOwner()) return;
          setGoalError(t('session.new.worktreeCleanupPending'));
          return;
        }
      }
      setGoalError(formatRemoteError(err));
    } finally {
      if (
        isCurrentOwner()
        && sessionClaimed
        && precreatedWorktree
        && worktreeAccountId
      ) {
        void forgetPendingPrecreatedWorktree(worktreeAccountId, {
          // The reservation is keyed by the pre-generated session id. It is
          // captured in the worktree request and remains stable for Goal.
          sessionId: precreatedWorktree.sessionId,
          recoveryKey: precreatedWorktree.recoveryKey,
          ...(precreatedWorktree.createdAt !== undefined
            ? { createdAt: precreatedWorktree.createdAt }
            : {}),
        }).catch(() => undefined);
      }
      releasePrecreatedRegistration?.();
      creatingRef.current = false;
      setCreating(false);
      setGoalBusy(false);
    }
  }, [
    agentAuthVerdict,
    auth,
    confirmAgentUnauthenticated,
    draft,
    goalBusy,
    maker,
    openLink,
    patchDraft,
    router,
    selectedDeviceId,
    selectedDeviceName,
    subscribe,
    t,
    waitForPendingUploads,
    worktreeBranchPreferenceKey,
    worktreeBranchPreferenceSyncKey,
    worktreeCaptionKey,
    worktreeCreateBlocked,
    worktreeApplicable,
    worktreeEligibility,
    worktreeEnabled,
    captureWorktreeCreateIntent,
    isWorktreeCreateIntentCurrent,
  ]);

  return (
    <SafeAreaView style={styles.safeArea} testID="newSession.screen">
      <KeyboardAvoidingView
        behavior={keyboardAvoidingBehaviorForPlatform(
          Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        )}
        style={styles.keyboard}
      >
        <View style={styles.screen}>
          <View style={styles.topBar}>
            <ScreenBackButton
              hitSlop={12}
              onPress={handleBack}
              style={styles.backButton}
              testID="newSession.backButton"
            />
            {buildLabel ? (
              <Text numberOfLines={1} style={styles.buildLabel}>{buildLabel}</Text>
            ) : null}
            {creating ? <ActivityIndicator color={colors.textSecondary} /> : null}
          </View>

          <View style={styles.bottomCluster}>
            <View style={styles.selectorStack}>
              <View style={styles.deviceSelectorWrap}>
              <Pressable
                accessibilityLabel={t('session.new.selectControlledDevice')}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: deviceSelectorDisabled || undefined,
                  expanded: devicePickerOpen || undefined,
                }}
                disabled={deviceSelectorDisabled}
                onPress={() => {
                  setWorkspacePickerOpen(false);
                  setModelSheetOpen(false);
                  setAgentPickerOpen(false);
                  setDevicePickerOpen((value) => !value);
                }}
                style={({ pressed }) => [styles.selectorRow, pressed && styles.pressed]}
                testID="newSession.deviceSelector"
              >
                <Laptop color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.thin} />
                <Text style={styles.selectorText} numberOfLines={1}>{selectedDeviceLabel}</Text>
                {deviceHasChoices ? (
                  <ChevronsUpDown color={colors.borderStrong} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                ) : null}
              </Pressable>
              {devicePickerOpen && deviceHasChoices ? (
                <View style={styles.devicePickerPanel} testID="newSession.devicePickerPanel">
                  {deviceOptions.map((option) => {
                    const selected = option.deviceId === selectedDeviceId;
                    return (
                      <Pressable
                        accessibilityLabel={t('session.new.selectDeviceNamed', { name: option.name || option.deviceId })}
                        accessibilityRole="button"
                        key={option.deviceId}
                        onPress={() => selectDevice(option)}
                        style={({ pressed }) => [styles.deviceOptionRow, pressed && styles.pressed]}
                        testID="newSession.deviceOption"
                      >
                        <Laptop
                          color={selected ? colors.textPrimary : colors.textTertiary}
                          size={iconSize.action}
                          strokeWidth={iconStroke.thin}
                        />
                        <Text style={styles.deviceOptionText} numberOfLines={1}>
                          {option.name || option.deviceId}
                        </Text>
                        {selected ? (
                          <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              </View>
              <View style={styles.agentSelectorWrap}>
                <Pressable
                  accessibilityLabel={t('session.new.selectAgent')}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: agentPickerOpen || undefined }}
                  disabled={creating}
                  onPress={() => {
                    setDevicePickerOpen(false);
                    setWorkspacePickerOpen(false);
                    setModelSheetOpen(false);
                    setAgentPickerOpen((value) => !value);
                  }}
                  style={({ pressed }) => [styles.selectorRow, pressed && styles.pressed]}
                  testID="newSession.agentSelector"
                >
                  <MobileVendorIcon vendor={mobileAgentVendor(draft.agentKind)} size={iconSize.lg} />
                  <Text style={styles.selectorText} numberOfLines={1}>{agentLabel}</Text>
                  <ChevronsUpDown color={colors.borderStrong} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </Pressable>
                {agentPickerOpen ? (
                  <View style={styles.agentPickerPanel} testID="newSession.agentPickerPanel">
                    {availableNewSessionAgentOptions(availableAgentKinds).map((option) => {
                      const selected = draft.agentKind === option.kind;
                      return (
                        <Pressable
                          accessibilityLabel={t('session.new.switchToAgent', { label: option.label })}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          disabled={creating}
                          key={option.kind}
                          onPress={() => switchAgent(option.kind)}
                          style={({ pressed }) => [styles.agentOptionRow, pressed && styles.pressed]}
                          testID="newSession.agentOption"
                        >
                          <MobileVendorIcon
                            vendor={mobileAgentVendor(option.kind)}
                            size={iconSize.action}
                          />
                          <Text style={styles.agentOptionText} numberOfLines={1}>{option.label}</Text>
                          {selected ? (
                            <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
              <View style={styles.workspaceSelectorWrap}>
                <Pressable
                  accessibilityLabel={t('session.new.selectWorkspace')}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: workspacePickerOpen || undefined }}
                  disabled={creating}
                  onPress={() => {
                    setDevicePickerOpen(false);
                    setModelSheetOpen(false);
                    setAgentPickerOpen(false);
                    setWorkspacePickerOpen((value) => !value);
                  }}
                  style={({ pressed }) => [styles.selectorRow, pressed && styles.pressed]}
                  testID="newSession.workspaceSelector"
                >
                  <WorkspaceIcon color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.thin} />
                  <Text style={styles.selectorText} numberOfLines={1}>{workspaceLabel}</Text>
                  <ChevronsUpDown color={colors.borderStrong} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </Pressable>
                {workspacePickerOpen ? (
                  <View style={styles.workspacePickerPanel} testID="newSession.workspacePickerPanel">
                    <Pressable
                      accessibilityLabel={t('session.new.dialogueNoProject')}
                      accessibilityRole="button"
                      accessibilityState={{ selected: draft.workspaceKind === 'dialogue' }}
                      onPress={selectDialogueWorkspace}
                      style={({ pressed }) => [styles.workspaceOptionRow, pressed && styles.pressed]}
                      testID="newSession.workspaceDialogueOption"
                    >
                      <MessageCircle color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
                      <Text style={styles.workspaceOptionText} numberOfLines={1}>{t('session.new.workspaceDialogue')}</Text>
                      {draft.workspaceKind === 'dialogue' ? (
                        <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
                      ) : null}
                    </Pressable>
                    <View style={styles.workspacePickerDivider} />
                    {recentWorkspaces.length > 0 ? (
                      <ScrollView
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                        style={styles.workspaceProjectList}
                      >
                        {recentWorkspaces.map((workspace) => {
                          const selected = draft.workspaceKind === 'project'
                            && draft.workingDir.trim() === workspace.workingDir;
                          return (
                            <Pressable
                              accessibilityLabel={t('session.new.selectProjectNamed', { title: workspace.title })}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              disabled={creating}
                              key={workspace.workingDir}
                              onPress={() => selectRecentProject(workspace.workingDir)}
                              style={({ pressed }) => [styles.workspaceProjectRow, pressed && styles.pressed]}
                              testID="newSession.workspaceProjectOption"
                            >
                              <Folder color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
                              <View style={styles.workspaceProjectText}>
                                <Text style={styles.workspaceProjectTitle} numberOfLines={1}>{workspace.title}</Text>
                                <Text style={styles.workspaceProjectPath} numberOfLines={1}>{workspace.workingDir}</Text>
                              </View>
                              {selected ? (
                                <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.medium} />
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    ) : (
                      <Text style={styles.workspaceEmptyText}>{t('session.new.noProjects')}</Text>
                    )}
                    <View style={styles.workspaceDivider} />
                    <Pressable
                      accessibilityLabel={t('session.new.chooseOtherFolder')}
                      accessibilityRole="button"
                      disabled={creating}
                      onPress={openProjectBrowse}
                      style={({ pressed }) => [styles.workspaceOptionRow, pressed && styles.pressed]}
                      testID="newSession.workspaceBrowseOption"
                    >
                      <FolderPlus color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
                      <Text style={styles.workspaceOptionText} numberOfLines={1}>{t('session.new.chooseOtherFolder')}</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
              {worktreeRowVisible ? (
                <View style={styles.worktreeToggleWrap}>
                  <View style={styles.worktreeControlTouchWrap}>
                    <View style={styles.worktreeControl} testID="newSession.branchWorktreeControl">
                      <View
                        pointerEvents="none"
                        style={[
                          styles.worktreeControlBackground,
                          worktreeChecked && styles.worktreeControlChecked,
                        ]}
                      />
                      <Pressable
                        accessibilityLabel={t('session.new.selectWorktreeBranchA11y', {
                          branch: worktreeSourceBranch,
                        })}
                        accessibilityRole="button"
                        accessibilityState={{
                          busy: worktreeBranchPreferenceSaving || undefined,
                          disabled: worktreeBranchDisabled || undefined,
                          expanded: worktreeBranchSheetVisible || undefined,
                        }}
                        disabled={worktreeBranchDisabled}
                        onPress={openWorktreeBranchPicker}
                        style={({ pressed }) => [
                          styles.worktreeBranchSegment,
                          pressed && styles.pressed,
                          worktreeBranchDisabled && styles.disabled,
                        ]}
                        testID="newSession.worktreeBranchPicker"
                      >
                        <GitBranch
                          color={worktreeChecked ? colors.textPrimary : colors.textTertiary}
                          size={iconSize.sm}
                          strokeWidth={iconStroke.regular}
                        />
                        <Text style={styles.worktreeBranchLabel} numberOfLines={1}>
                          {worktreeSourceBranch}
                        </Text>
                        {!worktreeBranchDisabled ? (
                          <ChevronDown
                            color={colors.textTertiary}
                            size={iconSize.xs}
                            strokeWidth={iconStroke.regular}
                          />
                        ) : null}
                      </Pressable>
                      <View style={styles.worktreeControlDivider} />
                      <Pressable
                        accessibilityLabel={t('session.new.useWorktree')}
                        accessibilityRole="checkbox"
                        accessibilityState={{
                          checked: worktreeChecked,
                          disabled: worktreeToggleDisabled || undefined,
                        }}
                        disabled={worktreeToggleDisabled}
                        onPress={toggleWorktree}
                        style={({ pressed }) => [
                          styles.worktreeToggleRow,
                          pressed && styles.pressed,
                          worktreeToggleDisabled && styles.disabled,
                        ]}
                        testID="newSession.worktreeToggle"
                      >
                        <View style={[
                          styles.worktreeCheckbox,
                          worktreeChecked && styles.worktreeCheckboxChecked,
                        ]}>
                          {worktreeChecked ? (
                            <Check color={colors.ctaText} size={iconSize.xs} strokeWidth={iconStroke.bold} />
                          ) : null}
                        </View>
                        <Text style={styles.worktreeToggleLabel} numberOfLines={1}>
                          {t('session.new.worktreeShortLabel')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  {worktreeControlCaptionKey ? (
                    <Text style={styles.worktreeCaption} testID="newSession.worktreeCaption">
                      {t(worktreeControlCaptionKey)}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>

            {browseOpen ? (
              <View style={styles.browsePanel} testID="newSession.remoteBrowsePanel">
                <View style={styles.browseHeader}>
                  <Text style={styles.browsePath} numberOfLines={1} testID="newSession.remoteBrowseCurrentPath">
                    {browsePath || t('session.new.readingRemoteDir')}
                  </Text>
                  {browseLoading ? <ActivityIndicator color={colors.textSecondary} size="small" /> : null}
                </View>
                {recentWorkspaces.length > 0 ? (
                  <ScrollView
                    horizontal
                    contentContainerStyle={styles.workspaceQuickPickRow}
                    keyboardShouldPersistTaps="handled"
                    showsHorizontalScrollIndicator={false}
                  >
                    {recentWorkspaces.map((workspace) => (
                      <Pressable
                        accessibilityLabel={t('session.new.selectProjectNamed', { title: workspace.title })}
                        accessibilityRole="button"
                        disabled={creating}
                        key={workspace.workingDir}
                        onPress={() => selectWorkingDir(workspace.workingDir)}
                        style={({ pressed }) => [styles.workspaceQuickPick, pressed && styles.pressed]}
                        testID="newSession.workspaceQuickPick"
                      >
                        <Text style={styles.workspaceQuickPickText} numberOfLines={1}>{workspace.title}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : null}
                <View style={styles.browseActions} testID="newSession.remoteBrowseActions">
                  <Pressable
                    accessibilityLabel={t('session.new.goParentDir')}
                    accessibilityRole="button"
                    disabled={!browseParent || browseLoading}
                    onPress={() => browseParent && void loadBrowsePath(browseParent)}
                    style={({ pressed }) => [
                      styles.browseActionButton,
                      (!browseParent || browseLoading) && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                    testID="newSession.remoteBrowseParentButton"
                  >
                    <Text style={styles.browseActionText}>{t('session.new.parentDir')}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={t('session.new.useCurrentRemoteDir')}
                    accessibilityRole="button"
                    disabled={!browsePath || browseLoading}
                    onPress={() => browsePath && selectWorkingDir(browsePath)}
                    style={({ pressed }) => [
                      styles.browseActionButton,
                      (!browsePath || browseLoading) && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                    testID="newSession.remoteBrowseSelectCurrent"
                  >
                    <Text style={styles.browseActionText}>{t('session.new.useCurrent')}</Text>
                  </Pressable>
                </View>
                <Pressable
                  accessibilityLabel={newSessionText('showHiddenDirectories')}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: showHiddenDirectories, disabled: creating || undefined }}
                  disabled={creating}
                  onPress={() => setShowHiddenDirectories((value) => !value)}
                  style={({ pressed }) => [
                    styles.browseHiddenToggle,
                    pressed && styles.pressed,
                    creating && styles.disabled,
                  ]}
                  testID="newSession.remoteBrowseShowHidden"
                >
                  <View style={[
                    styles.browseCheckbox,
                    showHiddenDirectories && styles.browseCheckboxChecked,
                  ]}>
                    {showHiddenDirectories ? (
                      <Check color={colors.ctaText} size={iconSize.xs} strokeWidth={iconStroke.bold} />
                    ) : null}
                  </View>
                  <Text style={styles.browseHiddenLabel}>
                    {newSessionText('showHiddenDirectories')}
                  </Text>
                </Pressable>
                {browseError ? <Text style={styles.errorText}>{browseError}</Text> : null}
                <FlatList
                  style={styles.browseList}
                  contentContainerStyle={styles.browseListContent}
                  data={visibleBrowseEntries}
                  keyExtractor={(entry) => entry.path}
                  renderItem={({ item }) => (
                    <RemoteDirectoryRow
                      disabled={creating || browseLoading}
                      entry={item}
                      onEnter={() => void loadBrowsePath(item.path)}
                      onSelect={() => selectWorkingDir(item.path)}
                    />
                  )}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator
                  ListEmptyComponent={!browseLoading && !browseError ? (
                    <Text style={styles.hint}>{newSessionText('emptyDirectory')}</Text>
                  ) : null}
                />
              </View>
            ) : null}

            {error ? (
              <Text style={styles.errorText}>{describeAgentAuthError(error) ?? error}</Text>
            ) : null}
            {/* 发送前鉴权提示:选中 agent 在被控端无已连接供应商时提前告知;
                error 已展示(含被门禁拦截的同款文案)时不重复出现。 */}
            {!error && agentAuthVerdict === 'unauthenticated' ? (
              <Text style={styles.errorText} testID="newSession.agentAuthGateHint">
                {agentAuthGateHint(draft.agentKind)}
              </Text>
            ) : null}

            <View style={styles.composerCard} testID="newSession.composer">
              {composerTrigger.kind === 'slash' ? (
                <NewComposerPaletteFrame
                  emptyText={t('session.common.noMatchingCommands')}
                  errorText={slashPaletteError}
                  loading={slashPaletteLoading}
                  testID="newSession.slashPalette"
                >
                  {visibleSlashCommands.map((command) => (
                    <NewComposerPaletteRow
                      accessibilityLabel={t('session.common.insertCommand', { name: command.name })}
                      key={`${command.kind}:${command.name}`}
                      onPress={() => selectSlashCommand(command)}
                      primary={`/${command.name}`}
                      secondary={command.kind === 'agent-skill' ? command.source : 'agent-cmd'}
                      testID="newSession.slashCommandRow"
                    />
                  ))}
                </NewComposerPaletteFrame>
              ) : null}
              {composerTrigger.kind === 'at' ? (
                <NewComposerPaletteFrame
                  emptyText={atResourcesTruncated ? t('session.common.keepTypingToNarrow') : t('session.common.noMatchingResources')}
                  errorText={atPaletteError}
                  loading={atPaletteLoading}
                  testID="newSession.atPalette"
                >
                  {visibleAtResources.map((item) => (
                    <NewComposerPaletteRow
                      accessibilityLabel={t('session.common.insertResource', { name: item.name })}
                      key={`${item.type}:${item.relPath}`}
                      onPress={() => selectAtResource(item)}
                      primary={item.type === 'dir' ? `${item.name}/` : item.name}
                      secondary={item.type === 'agent' ? 'Agent' : item.relPath}
                      testID="newSession.atResourceRow"
                    />
                  ))}
                </NewComposerPaletteFrame>
              ) : null}
              {attachmentError ? (
                <Text style={styles.errorText} testID="newSession.attachmentStatus">
                  {attachmentError}
                </Text>
              ) : null}
              {voiceStatusVisible ? (
                <View style={styles.voiceStatusRow}>
                  <Text style={styles.voiceStatusText} testID="newSession.voiceStatus">
                    {voiceError}
                  </Text>
                  {canOpenVoiceSettings ? (
                    <Pressable
                      accessibilityLabel={t('session.common.openMicPermission')}
                      accessibilityRole="button"
                      hitSlop={10}
                      onPress={openVoiceSettings}
                      style={({ pressed }) => [styles.voiceStatusButton, pressed && styles.pressed]}
                      testID="newSession.voiceSettingsButton"
                    >
                      <Settings color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              <View style={styles.composerToolbarWrap}>
                <MobileComposerInputRow
                  accessibilityLabel={t('session.new.firstMessagePlaceholder')}
                  accessoryAbove={attachments.length > 0 || pendingUploads.length > 0 || pastePlaceholderCount > 0 ? renderComposerAttachmentTray() : null}
                  autoFocus={visualFocusComposer}
                  cardActive={composerCardActive}
                  caretHidden={voiceIsListening}
                  cursorColor={colors.inputCaret}
                  inputRef={firstMessageInputRef}
                  leading={renderComposerCompactLeading()}
                  inputFrameHeight={composerResize.frameHeight}
                  // 听写期间把输入区撑到 44pt 触控目标:此时「点输入区停止听写」的命中层
                  // 是这层输入区自身(TextInput 的 onPressIn),单行时只有 28pt。
                  inputFrameMinHeight={voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined}
                  inputOverlay={renderComposerInputOverlay()}
                  inputStyle={voiceIsListening ? styles.inputVoiceHidden : undefined}
                  inputTestID="newSession.firstMessageInput"
                  maxHeight={composerResize.inputMaxHeight}
                  multilineShape={!composerCardActive && composerInputIsMultiline}
                  onBlur={() => {
                    setFirstMessageInputFocused(false);
                    // 失焦收起与「点别处收键盘」同语义:语音结束 hold 一并解除。
                    setComposerVoiceHoldArmed(false);
                  }}
                  onChangeText={setFirstMessageDraft}
                  onContentSizeChange={handleFirstMessageInputContentSizeChange}
                  onFocus={() => setFirstMessageInputFocused(true)}
                  onPasteImages={(uris) => void addPastedImageAttachments(uris)}
                  onPasteImagesLoading={beginPastePlaceholders}
                  onPasteImagesLoadFailed={failPastePlaceholders}
                  onPressIn={() => {
                    if (voiceIsListening) void finishVoiceRecording();
                  }}
                  placeholder={voiceIsListening ? '' : composerPlaceholder}
                  placeholderTextColor={colors.textTertiary}
                  resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}
                  scrollEnabled={composerInputScrollEnabled}
                  selectionColor={colors.inputCaret}
                  testID="newSession.actions"
                  toolbar={renderComposerToolbar()}
                  trailing={composerCardActive || !composerShowCreateButton ? null : renderCreateButton()}
                  value={draft.firstMessage}
                  voicePlacement={composerVoicePlacement}
                  floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}
                />
              </View>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ContextSheet
        footer={contextSheetView !== 'goal' && pendingMediaAssets.length > 0 ? (
          <ContextSheetFooterButton
            disabled={creating}
            label={t('session.common.joinConversation', { num: pendingMediaAssets.length })}
            onPress={() => void commitPendingMediaAssets()}
            testID="newSession.contextSheetCommitMedia"
          />
        ) : undefined}
        keyboardAvoidingBehavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        onBack={contextSheetView !== 'main' ? () => setContextSheetView('main') : undefined}
        onClose={() => setContextSheetOpen(false)}
        testID="newSession.contextSheet"
        title={contextSheetView === 'screenshots' ? t('session.common.screenshot') : contextSheetView === 'goal' ? t('session.common.goalMode') : t('session.common.context')}
        visible={contextSheetOpen}
      >
        {contextSheetView === 'main' ? (
          <>
            <RecentPhotosStrip
              busyAssetIds={uploadingMediaAssetIds}
              disabled={creating}
              enabled={contextSheetOpen}
              onToggleAsset={toggleMediaAssetAttachment}
              pendingOrder={pendingMediaOrder}
              selectedAssetIds={selectedMediaAssetIds}
              testID="newSession.contextSheetPhotos"
            />
            <ContextSheetGroup label={t('session.common.groupMode')}>
              {planModeSupported ? (
                // 点击即切换计划模式并关面板(产品决策,不做开关);已开启时显示 ✓,再点退出。
                <ContextSheetRow
                  disabled={creating}
                  icon={<ListTodo color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.planMode')}
                  onPress={() => {
                    togglePlanMode(!planModeOn);
                    setContextSheetOpen(false);
                  }}
                  testID="newSession.contextSheetPlanRow"
                  trailing={planModeOn ? <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.bold} /> : null}
                />
              ) : null}
              <ContextSheetRow
                disabled={creating}
                icon={<Target color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.goalMode')}
                onPress={() => setContextSheetView('goal')}
                testID="newSession.contextSheetGoalRow"
                trailing="chevron"
              />
            </ContextSheetGroup>
            <ContextSheetGroup label={t('session.common.groupAdd')}>
              <ContextSheetRow
                disabled={creating}
                icon={<Image color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.photo')}
                onPress={() => void addLocalImageAttachments('library')}
                testID="newSession.contextSheetPhotoRow"
              />
              <ContextSheetRow
                disabled={creating}
                icon={<Scan color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.screenshot')}
                onPress={() => setContextSheetView('screenshots')}
                testID="newSession.contextSheetScreenshotsRow"
                trailing="chevron"
              />
              <ContextSheetRow
                disabled={creating}
                icon={<Camera color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.takePhoto')}
                onPress={() => void addLocalImageAttachments('camera')}
                testID="newSession.contextSheetCameraRow"
              />
              <ContextSheetRow
                disabled={creating}
                icon={<Folder color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.file')}
                onPress={() => void addLocalFileAttachment()}
                testID="newSession.contextSheetFileRow"
              />
            </ContextSheetGroup>
            {attachmentError ? (
              <Text style={{ color: colors.errorText, fontSize: typeScale.footnote, paddingTop: 12 }}>
                {attachmentError}
              </Text>
            ) : null}
          </>
        ) : contextSheetView === 'screenshots' ? (
          <ScreenshotsGrid
            busyAssetIds={uploadingMediaAssetIds}
            contentWidth={windowDimensions.width - 40}
            disabled={creating}
            enabled={contextSheetOpen && contextSheetView === 'screenshots'}
            onToggleAsset={toggleMediaAssetAttachment}
            pendingOrder={pendingMediaOrder}
            selectedAssetIds={selectedMediaAssetIds}
            testID="newSession.contextSheetScreenshotsGrid"
          />
        ) : (
          <ContextSheetGoalCreateForm
            busy={goalBusy}
            disabled={worktreeCreateBlocked}
            disabledHint={worktreePreferenceSaving
              ? t('session.new.worktreeSettingsSaving')
              : worktreeBranchPreferenceSaving
                || (worktreeEnabled
                  && worktreeEligibility.status === 'eligible'
                  && !worktreeBranchPreferenceReady)
                ? t('session.new.worktreeBranchSaving')
                : worktreeControlCaptionKey
                  ? t(worktreeControlCaptionKey)
                  : undefined}
            error={goalError}
            initial={draft.firstMessage.trim() ? { objective: draft.firstMessage.trim() } : undefined}
            onSetGoal={(input) => void createGoalSession(input)}
            testID="newSession.contextSheetGoalView"
          />
        )}
      </ContextSheet>
      <SheetModal
        backdropTestID="newSession.worktreeBranchSheet.backdrop"
        onBackdropPress={() => setWorktreeBranchSheetOpen(false)}
        onRequestClose={() => setWorktreeBranchSheetOpen(false)}
        visible={worktreeBranchSheetVisible}
      >
        <SheetSurface
          bottomInset={safeAreaInsets.bottom}
          heights={permissionSheetHeights}
          onClose={() => setWorktreeBranchSheetOpen(false)}
          onSnapChange={setWorktreeBranchSheetSnap}
          snap={worktreeBranchSheetSnap}
          testID="newSession.worktreeBranchSheet"
          title={t('session.new.worktreeSourceBranch')}
        >
          {worktreeBranchList?.loading ? (
            <View style={styles.worktreeBranchStatusRow}>
              <ActivityIndicator color={colors.textSecondary} size="small" />
              <Text style={styles.worktreeBranchStatusText}>
                {t('session.new.worktreeBranchesLoading')}
              </Text>
            </View>
          ) : worktreeBranchList?.failed || worktreeBranchOptions.length === 0 ? (
            <Pressable
              accessibilityLabel={t('session.new.worktreeBranchesRetry')}
              accessibilityRole="button"
              onPress={() => loadWorktreeBranches(true)}
              style={({ pressed }) => [
                styles.worktreeBranchStatusRow,
                pressed && styles.pressed,
              ]}
              testID="newSession.worktreeBranchSheet.retry"
            >
              <Text style={styles.worktreeBranchStatusText}>
                {t('session.new.worktreeBranchesRetry')}
              </Text>
            </Pressable>
          ) : (
            <MobileChoicePickerList
              activeId={worktreeSourceBranch}
              disabled={creating}
              onSelect={selectWorktreeSourceBranch}
              options={worktreeBranchOptions}
              testID="newSession.worktreeBranchSheet.option"
            />
          )}
        </SheetSurface>
      </SheetModal>
      <ModelPickerSheet
        activeModelId={draft.model}
        activePermissionMode={displayPermissionMode}
        agentKind={draft.agentKind}
        apiKeyStatus={deviceApiKeyStatus}
        capabilities={capabilities}
        disabled={creating}
        emptyHint={selectedDeviceId ? t('session.new.noModelsAvailable') : t('session.new.selectDeviceFirst')}
        flatOptions={runtimeOptions.modelOptions}
        modelVisibilityOverrides={deviceProviders.modelVisibilityOverrides}
        keyboardAvoidingBehavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        loading={deviceProviders.loading || capabilitiesLoading}
        modelMemory={draftMemory}
        onChangeSelectedEffort={changeSelectedEffort}
        onChangeSelectedFastMode={changeSelectedFastMode}
        hidePermissionTrigger
        onClose={() => setModelSheetOpen(false)}
        onSelectFlatModel={selectFlatModel}
        onSelectPermissionMode={selectPermissionMode}
        onSelectProviderRow={selectProviderModelRow}
        permissionDisabled={creating}
        permissionOptions={runtimeOptions.permissionOptions}
        pricing={deviceModelPricing}
        providers={deviceProviders.providers}
        selectedEffort={draft.effort}
        selectedFastMode={draft.fastMode}
        selectedProviderId={draft.providerId}
        testID="newSession.modelSheet"
        visible={modelSheetOpen}
      />
      {/* 权限模式独立浮窗:composer 权限药丸点开;列表复用 MobilePermissionPickerList,
          选择走 selectPermissionMode(含 Full access 确认弹层 + per-agent 记忆)后关浮窗。 */}
      <SheetModal
        backdropTestID="newSession.permissionSheet.backdrop"
        onBackdropPress={() => setPermissionSheetOpen(false)}
        onRequestClose={() => setPermissionSheetOpen(false)}
        visible={permissionSheetOpen}
      >
        <SheetSurface
          bottomInset={safeAreaInsets.bottom}
          heights={permissionSheetHeights}
          onClose={() => setPermissionSheetOpen(false)}
          onSnapChange={setPermissionSheetSnap}
          snap={permissionSheetSnap}
          testID="newSession.permissionSheet"
          title={t('models.picker.permissionTitle')}
        >
          <MobilePermissionPickerList
            activeMode={displayPermissionMode}
            disabled={creating}
            onSelect={(mode) => {
              selectPermissionMode(mode);
              setPermissionSheetOpen(false);
            }}
            options={runtimeOptions.permissionOptions}
            testID="newSession.permissionSheet.option"
          />
        </SheetSurface>
      </SheetModal>
      {composerPreviewUrl && composerGalleryImages.length > 0 ? (
        // composer 托盘图片的全屏查看(沿用聊天消息同款 ImageLightbox;本地图无需远端取件)。
        // annotation:托盘图可圈点标注 / 再编辑,保存后烧录替换附件重新上传。
        <ImageLightbox
          annotation={composerAnnotations.trayAnnotation}
          images={composerGalleryImages}
          initialUrl={composerPreviewUrl}
          onClose={() => setComposerPreviewAttachmentId(null)}
        />
      ) : null}
      {composerAnnotations.host}
    </SafeAreaView>
  );
}

function RemoteDirectoryRow({
  disabled,
  entry,
  onEnter,
  onSelect,
}: {
  disabled: boolean;
  entry: RemoteDirectoryEntry;
  onEnter(): void;
  onSelect(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <View style={styles.browseRow} testID="newSession.remoteBrowseEntry">
      <Pressable
        accessibilityLabel={t('session.new.enterDir', { name: entry.name })}
        accessibilityRole="button"
        disabled={disabled}
        onPress={onEnter}
        style={({ pressed }) => [styles.browseEntryButton, pressed && styles.pressed]}
      >
        <Text style={styles.browseEntryName} numberOfLines={1}>{entry.name}</Text>
        <Text style={styles.browseEntryPath} numberOfLines={1}>
          {entry.kind === 'symlink' ? 'symlink · ' : ''}{entry.path}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={t('session.new.selectDir', { name: entry.name })}
        accessibilityRole="button"
        disabled={disabled}
        onPress={onSelect}
        style={({ pressed }) => [styles.browseSelectButton, disabled && styles.disabled, pressed && styles.pressed]}
        testID="newSession.remoteBrowseSelectEntry"
      >
        <Text style={styles.browseActionText}>{t('session.new.select')}</Text>
      </Pressable>
    </View>
  );
}

function NewComposerPaletteFrame({
  children,
  emptyText,
  errorText,
  loading,
  testID,
}: {
  children: ReactNode;
  emptyText: string;
  errorText: string | null;
  loading: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <View style={styles.palettePanel} testID={testID}>
      {loading ? (
        <View style={styles.paletteStatusRow}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.paletteStatusText}>{t('session.common.paletteLoading')}</Text>
        </View>
      ) : errorText ? (
        <Text style={styles.paletteStatusText}>{errorText}</Text>
      ) : hasRows ? (
        children
      ) : (
        <Text style={styles.paletteStatusText}>{emptyText}</Text>
      )}
    </View>
  );
}

function NewComposerPaletteRow({
  accessibilityLabel,
  onPress,
  primary,
  secondary,
  testID,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  primary: string;
  secondary: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.paletteRow, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.palettePrimary} numberOfLines={1}>{primary}</Text>
      <Text style={styles.paletteSecondary} numberOfLines={1}>{secondary}</Text>
    </Pressable>
  );
}

function readRouteString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

function buildDraftRuntimeSummary(
  draft: NewSessionDraft,
  runtime: MobileSessionRuntimeOptions,
): { modelSummary: string; permissionLabel: string } {
  const modelLabel = runtime.currentModel?.label ?? draft.model;
  const effortLabel = choiceLabel(runtime.effortOptions, draft.effort);
  return {
    modelSummary: [modelLabel, effortLabel].filter(Boolean).join(' · '),
    permissionLabel: choiceLabel(runtime.permissionOptions, draft.permissionMode),
  };
}

function choiceLabel(options: readonly { id: string; label: string }[], value: string | null | undefined): string {
  if (!value) return '';
  return options.find((option) => option.id === value)?.label ?? value;
}

function formatWorkingDirLabel(workingDir: string): string {
  const trimmed = workingDir.trim();
  if (!trimmed) return i18n.t('session.new.selectWorkspace');
  const normalized = stripTrailingPathSeparators(trimmed);
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  keyboard: { flex: 1 },
  screen: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: NEW_SESSION_SCREEN_TOP_PADDING,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 62,
  },
  buildLabel: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.micro,
    marginHorizontal: spacing.md,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  backButton: {
    flexShrink: 0,
  },
  bottomCluster: {
    flex: 1,
    gap: spacing.lg,
    justifyContent: 'flex-end',
    paddingBottom: spacing.md,
  },
  selectorStack: {
    gap: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  selectorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 42,
  },
  selectorText: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  deviceSelectorWrap: {
    position: 'relative',
    zIndex: 20,
  },
  devicePickerPanel: {
    // 悬浮下拉:绝对定位,从设备选择器上方浮出(drop-up),不挤占布局、不顶起按钮。
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: '100%',
    gap: spacing.xs,
    left: 0,
    marginBottom: spacing.xs,
    padding: spacing.xs,
    position: 'absolute',
    right: 0,
    zIndex: 20,
  },
  deviceOptionRow: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
  },
  deviceOptionText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  agentSelectorWrap: {
    position: 'relative',
    zIndex: 20,
  },
  agentPickerPanel: {
    // 悬浮下拉:从 agent 选择器上方浮出(drop-up),脱离布局流(同设备/工作区选择器)。
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: '100%',
    gap: spacing.xs,
    left: 0,
    marginBottom: spacing.xs,
    padding: spacing.xs,
    position: 'absolute',
    right: 0,
    zIndex: 20,
  },
  agentOptionRow: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  agentOptionText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  workspaceSelectorWrap: {
    position: 'relative',
    zIndex: 20,
  },
  workspacePickerPanel: {
    // 悬浮下拉:从工作区选择器上方浮出,脱离布局流(同设备选择器)。
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: '100%',
    left: 0,
    marginBottom: spacing.xs,
    padding: spacing.xs,
    position: 'absolute',
    right: 0,
    zIndex: 20,
  },
  workspacePickerDivider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.xs,
  },
  workspaceProjectList: {
    maxHeight: 220,
  },
  workspaceOptionRow: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  workspaceOptionText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  workspaceProjectRow: {
    alignItems: 'center',
    borderRadius: radius.container,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workspaceProjectText: {
    flex: 1,
    minWidth: 0,
  },
  workspaceProjectTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  workspaceProjectPath: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    marginTop: 1,
  },
  workspaceEmptyText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  workspaceDivider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.xs,
  },
  // 分支 + worktree 是两个独立点击区组成的一枚紧凑 pill。点击区实高 44；背景绝对
  // 内缩 5pt 后视觉高 34，既不牺牲触控面积，也不让「worktree」重新显得臃肿。
  worktreeToggleWrap: {
    gap: spacing.xs,
  },
  worktreeControlTouchWrap: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    justifyContent: 'center',
    maxWidth: '100%',
    minHeight: 44,
  },
  worktreeControl: {
    alignItems: 'stretch',
    flexDirection: 'row',
    height: 44,
    maxWidth: '100%',
    position: 'relative',
  },
  worktreeControlBackground: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 5,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 5,
  },
  worktreeControlChecked: {
    borderColor: colors.borderStrong,
  },
  worktreeBranchSegment: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xs,
    minHeight: 44,
    minWidth: 72,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
  },
  worktreeBranchLabel: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  worktreeControlDivider: {
    alignSelf: 'center',
    backgroundColor: colors.border,
    height: 16,
    width: StyleSheet.hairlineWidth,
  },
  worktreeToggleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 44,
    paddingLeft: spacing.xs,
    paddingRight: spacing.sm,
  },
  worktreeCheckbox: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  worktreeCheckboxChecked: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  worktreeToggleLabel: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  worktreeCaption: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    marginLeft: spacing.sm,
  },
  worktreeBranchStatusRow: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  worktreeBranchStatusText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  hint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  errorText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  browsePanel: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  browseHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  browsePath: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  workspaceQuickPickRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workspaceQuickPick: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: spacing.md,
  },
  workspaceQuickPickText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  browseActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  browseActionButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: spacing.md,
  },
  browseActionText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  browseHiddenToggle: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
  },
  browseCheckbox: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  browseCheckboxChecked: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  browseHiddenLabel: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  browseList: { maxHeight: 200 },
  browseListContent: { gap: spacing.sm },
  browseRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 42,
  },
  browseEntryButton: {
    flex: 1,
    minWidth: 0,
  },
  browseEntryName: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  browseEntryPath: { color: colors.textTertiary, fontSize: typeScale.micro, marginTop: 2 },
  browseSelectButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: spacing.md,
  },
  composerCard: {
    gap: 6,
  },
  palettePanel: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    maxHeight: 220,
    padding: spacing.sm,
  },
  paletteRow: {
    alignItems: 'center',
    borderBottomWidth: 0,
    borderRadius: radius.container,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 42,
    paddingHorizontal: spacing.md,
  },
  palettePrimary: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  paletteSecondary: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    maxWidth: 160,
  },
  paletteStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 40,
  },
  paletteStatusText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  composerIconButton: {
    alignItems: 'center',
    backgroundColor: colors.sheetActionSurface,
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: MOBILE_COMPOSER_CONTROL_SIZE,
    justifyContent: 'center',
    width: MOBILE_COMPOSER_CONTROL_SIZE,
  },
  composerCompactLeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    height: MOBILE_COMPOSER_MIN_TOUCH_TARGET,
    marginRight: spacing.xs,
    minWidth: MOBILE_COMPOSER_MIN_TOUCH_TARGET,
  },
  // 热区流内就是 44×44,祖先链不再靠负 margin / 溢出子节点。
  // 可见加号仍是 34pt,与文字 / 麦克风共中线。
  composerCompactAttachmentHit: {
    alignItems: 'center',
    height: MOBILE_COMPOSER_MIN_TOUCH_TARGET,
    justifyContent: 'center',
    width: MOBILE_COMPOSER_MIN_TOUCH_TARGET,
  },
  composerIconButtonActive: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.borderStrong,
  },
  voiceStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  voiceStatusText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  voiceStatusButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: MOBILE_COMPOSER_CONTROL_SIZE,
    justifyContent: 'center',
    width: MOBILE_COMPOSER_CONTROL_SIZE,
  },
  voiceDraftOverlay: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  // 内边距与真实输入框同源:差一点就会让听写文字与非听写文字左右错位、换行位置不同。
  voiceDraftOverlayContent: {
    paddingBottom: COMPOSER_TEXT_PADDING_BOTTOM,
    paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING,
    paddingTop: COMPOSER_TEXT_PADDING_TOP,
  },
  voiceDraftOverlayContentGeometric: {
    paddingBottom: COMPOSER_TEXT_GEOMETRIC_PADDING_BOTTOM,
    paddingTop: COMPOSER_TEXT_GEOMETRIC_PADDING_TOP,
  },
  voiceDraftMeasuredBlock: {
    minHeight: MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
    position: 'relative',
  },
  voiceDraftCaretOverlay: {
    position: 'absolute',
  },
  // 草稿层的文本档必须与真实 TextInput 完全一致,否则换行位置错开、超出的行被裁在
  // 框外(见 MOBILE_COMPOSER_DRAFT_TEXT_STYLE)。
  voiceDraftText: {
    color: colors.textPrimary,
    ...MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  },
  voiceDraftListeningPrompt: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
  },
  // 语音态占位文案渲染的就是普通态 TextInput 的 placeholder,颜色必须同源
  // (placeholderTextColor 也是 textTertiary),否则一进语音态这行字会变色。
  voiceDraftListeningText: {
    color: colors.textTertiary,
    ...MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  },
  composerToolbarWrap: {
    position: 'relative',
    zIndex: 30,
  },
  // 按内容自适应宽度(不 flexGrow,剩余空间归 toolbarSpacer),模型名尽量显示全,
  // 只在行宽不足时才收缩截断(flexShrink + 文本 numberOfLines)。
  modelPill: {
    alignItems: 'center',
    backgroundColor: colors.sheetActionSurface,
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xs,
    justifyContent: 'flex-start',
    minHeight: MOBILE_COMPOSER_CONTROL_SIZE,
    minWidth: 0,
    paddingHorizontal: spacing.md,
  },
  modelPillText: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  inputVoiceHidden: {
    color: 'transparent',
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderColor: colors.cta,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: MOBILE_COMPOSER_CONTROL_SIZE,
    justifyContent: 'center',
    width: MOBILE_COMPOSER_CONTROL_SIZE,
  },
  sendButtonDisabled: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
  },
  sendButtonPressed: { opacity: 0.86 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.44 },
});
