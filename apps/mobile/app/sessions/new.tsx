import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { formatMobileBuildLabel, normalizeBuildInfo } from '@/config/buildInfo';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScreenBackButton } from '@/components/MobilePrimitives';
import { PaperPlaneIcon } from '@/components/PaperPlaneIcon';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type {
  MobileAgentSkillListResult,
  MobileAtResourceItem,
  MobileSlashCommand,
  RemoteDirectoryEntry,
} from '@/device-link/mobileMakerTransport';
import { describeAgentAuthError, formatRemoteError } from '@/device-link/remoteStatus';
import { agentAuthGateHint, agentAuthGateVerdict } from '@/session/agentAuthGate';
import { connectedProvidersForAgent, getModel } from '@cindy/model-providers/registry';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
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
  validateNewSessionDraft,
  type NewSessionAgentKind,
  type NewSessionDraft,
  type NewSessionDeviceOption,
  type NewSessionStoredPreferences,
} from '@/session/newSession';
import { newSessionText } from '@/session/newSessionMessages';
import { i18n } from '@/i18n';
import { useTranslation } from 'react-i18next';
import {
  createNewSessionId,
  drainStashedNewSessionDraft,
  startNewSessionCreation,
} from '@/session/newSessionCreation';
import { prepareMobileQueuedSessionReferences } from '@/session/sessionReferences';
import {
  readNewSessionPreferences,
  saveNewSessionPreferences,
} from '@/session/newSessionPreferenceStore';
import { remoteSessionStore, useRemoteSessions } from '@/session/remoteSessionStore';
import { buildSessionComposerLayout } from '@/session/sessionComposerLayout';
import { keyboardAvoidingBehaviorForPlatform } from '@/session/mobileNativeShellLayout';
import type { RemoteSerializedAttachment, RemoteSession } from '@/session/types';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import { confirmFullAccessChange } from '@/session/fullAccessConfirmation';
import { MobileVendorIcon } from '@/components/MobileVendorIcon';
import { PlanModeChip } from '@/session/PlanModeChip';
import {
  ComposerResizeGrabber,
  ComposerToolbarSpacer,
  ComposerToolbarVoiceSlot,
  MOBILE_COMPOSER_CONTROL_SIZE,
  MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
  MOBILE_COMPOSER_INPUT_MAX_HEIGHT,
  MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
  MOBILE_COMPOSER_INPUT_VERTICAL_PADDING,
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
  resolveRowSelection,
  type ProviderModelRow,
} from '@/session/providerModelSections';
import { ModelPickerSheet } from '@/session/ModelPickerSheet';
import { MobileModelIconMark } from '@/session/MobileProviderMark';
import { draftModelMemoryFor, hydrateDraftModelMemory } from '@/session/draftModelMemory';
import { rowFastEditable } from '@/session/modelPickerRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

// 一等公民两个 agent(DEFAULT_MODELS 两者都有);无"某 agent 不可用"信号时都展示。
const AGENT_OPTIONS: readonly { kind: NewSessionAgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
];
const COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD = 34;
const COMPOSER_VOICE_CARET_GAP = 2;
// composer 除输入区外的 chrome 高度估算（输入行上下 padding + 边框），
// 只用于给拖拽调高的上限留余量，与会话页同量级。
const COMPOSER_RESIZE_CHROME_HEIGHT = 34;
// 聚焦卡片形态的 chrome:paddingTop 26 + paddingBottom 8 + 层间 gap 8 + 工具排 ~36。
const COMPOSER_CARD_CHROME_HEIGHT = 78;
// Android 的 SafeAreaView 已经包含状态栏顶部 inset，不能再叠加一档顶部留白。
const NEW_SESSION_SCREEN_TOP_PADDING = Platform.OS === 'android' ? 0 : spacing.xl;

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
  const { invoke, openLink, subscribe } = useDeviceLink();
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
  // 模型 + 权限浮窗(ContextSheet 同款 Modal,含二级「模型选项 / 权限」叠层)。
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<RemoteSerializedAttachment[]>([]);
  // create() 里 await 在途图片上传后闭包里的 attachments 已是旧值,经 ref 读最新列表。
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 乐观创建失败后「返回编辑」的草稿回填:会话页 stash → 跳回本页 → 挂载时 drain。
  // 附件是已上传完成的引用,原样回列即可继续使用。
  useEffect(() => {
    const stashed = drainStashedNewSessionDraft();
    if (!stashed) return;
    setDraft(stashed.draft);
    setAttachments([...stashed.attachments]);
    if (stashed.deviceId) {
      setSelectedDeviceId(stashed.deviceId);
      setSelectedDeviceName(stashed.deviceName || stashed.deviceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时领取一次信箱
  }, []);
  // 相册资产 → 已上传附件 id 的映射(缩略图勾选态真相)。
  const [mediaAssetAttachments, setMediaAssetAttachments] = useState<Record<string, string>>({});
  // 待选相册资产(按选中顺序;Cursor 式两段提交,底部「加入对话」统一上传)。
  const [pendingMediaAssets, setPendingMediaAssets] = useState<ContextSheetMediaAsset[]>([]);
  // 本机图片附件的本地预览 uri(attachmentId → file://),composer 托盘缩略图 / 全图查看用。
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  // composer 托盘里正被全屏查看的图片附件 id(null = 关闭)。
  const [composerPreviewAttachmentId, setComposerPreviewAttachmentId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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
  // 自动默认运行配置(跟随最近会话 / 列表最上面)的守卫:用户一旦手动选过模型,就不再自动覆盖;
  // 记录已自动应用过的设备,切设备时(未手动选过)按新设备重算。
  const userTouchedRuntimeRef = useRef(false);
  // 只保护当前页面刚从 provider 目录显式选中的模型，避免旧 capabilities 在途结果误回退；
  // 持久草稿不会写入该 ref，因此已下架模型仍走 mobile 的首项降级。
  const explicitProviderModelSelectionRef = useRef<string | null>(null);
  const autoDefaultDeviceRef = useRef<string | null>(null);
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
  // fail-open 返回 false 放行(review P2:不把空回包升级成硬拦截)。
  const confirmAgentUnauthenticated = useCallback(async (agentKind: NewSessionAgentKind) => {
    try {
      const fresh = await maker.listProviders();
      return fresh.providers.length > 0
        && connectedProvidersForAgent(fresh.providers, agentKind).length === 0;
    } catch {
      return false;
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
    const rows = flattenProviderSections(
      buildMobileModelSections({
        providers: deviceProviders.providers,
        agentKind: storedAgentKind,
        visibilityOverrides: deviceProviders.modelVisibilityOverrides,
      }).sections,
    );
    const rememberedPermissionMode =
      newSessionPreferences?.permissionModeByAgent[storedAgentKind] ??
      defaultPermissionModeForNewSessionAgent(storedAgentKind);
    let cancelled = false;
    void (async () => {
      const confirmed = await confirmFullAccessChange(draft.permissionMode, rememberedPermissionMode);
      if (cancelled) return;
      setDraft((current) => {
        const next = pickAgentDefaultRuntime({
          agentKind: storedAgentKind,
          sessions,
          deviceId: selectedDeviceId || undefined,
          modelRows: rows,
          currentEffort: current.effort,
        });
        return {
          ...current,
          agentKind: next.agentKind,
          model: next.model,
          effort: next.effort,
          // 记忆的 Full access 必须经过一次明确确认；取消时保留当前安全档。
          permissionMode: confirmed ? rememberedPermissionMode : current.permissionMode,
          providerId: null,
        };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    confirmFullAccessChange,
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
    void confirmFullAccessChange(draft.permissionMode, remembered).then((confirmed) => {
      if (cancelled || !confirmed) return;
      setDraft((current) => ({ ...current, permissionMode: remembered }));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.agentKind, draft.permissionMode, newSessionPreferences, newSessionPreferencesLoaded]);

  // 新建对话默认运行配置 = 跟随最近一次会话(整套 agent+model+effort,按所选设备 scope);没有最近会话则用
  // 模型列表最上面那个(列表异步就绪后再设)。一旦用户手动选过模型即不再覆盖;切设备(未手动选过)按新设备重算。
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
      currentEffort: draft.effort,
    });
    if (!result) return;
    autoDefaultDeviceRef.current = result.appliedDeviceId;
    const nextAgentKind = result.patch.agentKind ?? draft.agentKind;
    const rememberedPermissionMode =
      appliedPermissionMemoryRef.current
        ? draft.permissionMode
        : newSessionPreferences?.permissionModeByAgent[nextAgentKind] ??
          defaultPermissionModeForNewSessionAgent(nextAgentKind);
    let cancelled = false;
    void confirmFullAccessChange(draft.permissionMode, rememberedPermissionMode).then((confirmed) => {
      if (cancelled || userTouchedRuntimeRef.current) return;
      setDraft((current) => ({
        ...current,
        ...result.patch,
        // 自动恢复历史 Full access 也必须经过明确确认；取消时保留当前档位。
        permissionMode: confirmed ? rememberedPermissionMode : current.permissionMode,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [draft.effort, draft.permissionMode, draft.agentKind, modelRows, newSessionPreferences, newSessionPreferencesLoaded, selectedDeviceId, sessions]);
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
  const agentLabel = draft.agentKind === 'codex' ? 'Codex' : 'Claude';
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
    && !voiceIsProcessing;
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
  // 聚焦 / 面板打开 / 语音中呈现卡片形态（输入区全宽 + 底部工具排），其余保持单行简洁态。
  // 语音结束后草稿仍有内容时经 hold 保持展开(一行文字也不收),
  // 不随 voiceIsBusy 归零塌回简洁态。
  const composerVoiceHoldActive = resolveComposerVoiceHoldActive({
    armed: composerVoiceHoldArmed,
    draftText: draft.firstMessage,
  });
  const composerCardActive = firstMessageInputFocused
    || modelSheetOpen
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
        workingDir
          ? maker.listAgentSkills(agentKind, {
              workingDir,
              forceReload: false,
            })
          : Promise.resolve({ success: true, skills: [] } satisfies MobileAgentSkillListResult),
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
    setModelSheetOpen(true);
  }, []);

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
      accessibilityHint={createValidation ?? undefined}
      accessibilityRole="button"
      accessibilityState={{ busy: creating || voiceIsProcessing || undefined, disabled: !canCreate || undefined }}
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
  const renderComposerToolbar = () => (
    <>
      {renderAttachmentToggleButton()}
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
      contentContainerStyle={styles.voiceDraftOverlayContent}
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
  // 同时 reconcile effort、清来源(默认路由)。手动切 agent = 手动选运行配置 → 之后自动默认不再覆盖。
  const switchAgent = useCallback((nextKind: NewSessionAgentKind) => {
    setAgentPickerOpen(false);
    if (draft.agentKind === nextKind) return;
    userTouchedRuntimeRef.current = true;
    explicitProviderModelSelectionRef.current = null;
    void saveNewSessionPreferences({ agentKind: nextKind });
    // 取目标 agent 自己的模型列表(providers 已加载时同步可得),用于"列表最上面"兜底 + effort reconcile。
    const rows = flattenProviderSections(
      buildMobileModelSections({
        providers: deviceProviders.providers,
        agentKind: nextKind,
        visibilityOverrides: deviceProviders.modelVisibilityOverrides,
      }).sections,
    );
    const rememberedPermissionMode =
      newSessionPreferences?.permissionModeByAgent[nextKind] ??
      defaultPermissionModeForNewSessionAgent(nextKind);
    void confirmFullAccessChange(draft.permissionMode, rememberedPermissionMode).then((confirmed) => {
      setDraft((current) => {
        const next = pickAgentDefaultRuntime({
          agentKind: nextKind,
          sessions,
          deviceId: selectedDeviceId || undefined,
          modelRows: rows,
          currentEffort: current.effort,
        });
        return {
          ...current,
          agentKind: next.agentKind,
          model: next.model,
          effort: next.effort,
          // 目标 agent 的记忆档若是 Full access，先经过明确确认；取消时保留当前档。
          permissionMode: confirmed ? rememberedPermissionMode : current.permissionMode,
          providerId: null,
        };
      });
    });
  }, [draft.agentKind, draft.permissionMode, deviceProviders.providers, deviceProviders.modelVisibilityOverrides, newSessionPreferences, sessions, selectedDeviceId]);

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
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    // 乐观交接标记:startNewSessionCreation + router.replace 成功后本页即将
    // unmount,但导航过渡帧内页面仍可交互——finally 立刻复位锁会给快速双击
    // 「创建」留出重入窗口,第二次点击会用同一份草稿再预生成一个 sessionId、
    // 建出重复会话(codex review P2)。交接成功后锁保持到组件销毁;「返回编辑」
    // 回来的是新 mount,creatingRef 天然复位。
    let handedOff = false;
    try {
      let effectiveDraft = draft;
      if (voiceRecordingActiveRef.current || voiceState === 'listening') {
        const latestDraftText = await finishVoiceRecording();
        if (latestDraftText === null) return;
        effectiveDraft = { ...draft, firstMessage: latestDraftText };
      }
      // 拍照 / 选图后立刻点创建是常见路径:等在途图片上传落定(乐观托盘)。
      // 有失败就中止创建——错误文案已由上传回调写入 attachmentError,让用户处理;
      // 此时不该带着残缺附件去开新会话。
      const { failedCount } = await waitForPendingUploads();
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
        if (await confirmAgentUnauthenticated(effectiveDraft.agentKind)) {
          setError(agentAuthGateHint(effectiveDraft.agentKind));
          return;
        }
        evictDeviceProviders(selectedDeviceId);
      }
      void saveNewSessionPreferences({
        agentKind: effectiveDraft.agentKind,
        device: {
          deviceId: selectedDeviceId,
          name: selectedDeviceName || selectedDeviceId,
        },
      });
      // —— 乐观创建:sessionId 手机端预生成(被控端 createSession 对 provided id
      // 幂等),点创建**立即**进入会话页;openLink / 鉴权 revalidate / createSession
      // / 首条消息 enqueue 全部由 newSessionCreation 模块级后台管线完成(本页
      // unmount 不终止),失败重试面在会话页(横幅:重试 / 返回编辑)。
      const sessionId = createNewSessionId();
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
      startNewSessionCreation({
        sessionId,
        deviceId: deviceIdSnapshot,
        deviceName: selectedDeviceName,
        draft: effectiveDraft,
        attachments: sendAttachments,
        planModeArm: planModeCapability && planModeDraftOn,
        legacyPlanRestore,
        // stale-ready 防护(review P1):缓存判 ready/unknown 也可能已过期。管线内
        // 与建链并行 revalidate;verdict 已是 unauthenticated 时上面刚现拉确认过,跳过。
        confirmUnauthenticated: agentAuthVerdict === 'unauthenticated'
          ? () => Promise.resolve(false)
          : () => confirmAgentUnauthenticated(agentKindSnapshot),
        authGateHint: agentAuthGateHint(agentKindSnapshot),
        onUnauthenticated: () => evictDeviceProviders(deviceIdSnapshot),
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
      // agent 未鉴权(电脑端没配 key / 没登录)是新会话失败的高频原因,
      // 换成带引导的中文提示;其它错误维持原文。
      const raw = formatRemoteError(err);
      setError(describeAgentAuthError(raw) ?? raw);
    } finally {
      if (!handedOff) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  }, [
    agentAuthVerdict,
    confirmAgentUnauthenticated,
    selectedDeviceId,
    selectedDeviceName,
    draft,
    finishVoiceRecording,
    maker,
    openLink,
    planModeCapability,
    planModeDraftOn,
    router,
    runtimeOptions,
    subscribe,
    voiceIsProcessing,
    voiceState,
    waitForPendingUploads,
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
    creatingRef.current = true;
    setCreating(true);
    setGoalBusy(true);
    setGoalError(null);
    try {
      // 鉴权门禁(review P2:goal 模式与普通创建同屏同 agent,同样要拦):goal.set 会吞掉
      // fireTurn 的鉴权失败,用户会被带进一个永远跑不起来的目标会话——比普通路径更需要
      // 提前拦截。判定与 create() 完全同款:缓存判死先现拉确认;ready/unknown 与建链并行重验。
      if (agentAuthVerdict === 'unauthenticated') {
        if (await confirmAgentUnauthenticated(draft.agentKind)) {
          setGoalError(agentAuthGateHint(draft.agentKind));
          return;
        }
        evictDeviceProviders(selectedDeviceId);
      }
      const freshUnauthenticated: Promise<boolean> = agentAuthVerdict === 'unauthenticated'
        ? Promise.resolve(false)
        : confirmAgentUnauthenticated(draft.agentKind);
      void saveNewSessionPreferences({
        agentKind: draft.agentKind,
        device: {
          deviceId: selectedDeviceId,
          name: selectedDeviceName || selectedDeviceId,
        },
      });
      const createOpts = buildRemoteCreateSessionOptions(draft);
      await withTransientRemoteRetry(async () => {
        await openLink(selectedDeviceId);
        await subscribe(`new-session:${selectedDeviceId}`, selectedDeviceId, ['sessions']);
      });
      if (await freshUnauthenticated) {
        evictDeviceProviders(selectedDeviceId);
        setGoalError(agentAuthGateHint(draft.agentKind));
        return;
      }
      const created = await maker.createSession(createOpts);
      const result = normalizeCreateSessionResult(created);
      if (!result) {
        throw new Error(t('session.new.noSessionIdReturned'));
      }
      await subscribe(`session:${result.sessionId}`, selectedDeviceId, ['sessions', `session:${result.sessionId}`]).catch(() => undefined);
      let session: RemoteSession;
      try {
        session = await maker.getSession(result.sessionId);
      } catch {
        session = sessionFromCreateResult(result, draft);
      }
      remoteSessionStore.upsertDeviceSession(selectedDeviceId, selectedDeviceName, session);
      await maker.goal.set({ sessionId: result.sessionId, objective: input.objective, ...(input.limits ? { limits: input.limits } : {}) });
      // 目标流不带 composer 附件(与桌面一致),跳转即丢引用:已上传的中转对象在此
      // best-effort 回收,否则成为 OSS 孤儿直到桶生命周期清理(codex review #504)。
      // 先等在途乐观上传落定,否则「回收后才落地」的图会漏出这轮清理。
      await waitForPendingUploads();
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
        params: { sessionId: result.sessionId, deviceId: selectedDeviceId, deviceName: selectedDeviceName },
      });
    } catch (err) {
      setGoalError(formatRemoteError(err));
    } finally {
      creatingRef.current = false;
      setCreating(false);
      setGoalBusy(false);
    }
  }, [agentAuthVerdict, auth, confirmAgentUnauthenticated, draft, goalBusy, maker, openLink, patchDraft, router, selectedDeviceId, selectedDeviceName, subscribe, t, waitForPendingUploads]);

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
                  <MobileVendorIcon vendor={draft.agentKind === 'codex' ? 'codex' : 'cc'} size={iconSize.lg} />
                  <Text style={styles.selectorText} numberOfLines={1}>{agentLabel}</Text>
                  <ChevronsUpDown color={colors.borderStrong} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </Pressable>
                {agentPickerOpen ? (
                  <View style={styles.agentPickerPanel} testID="newSession.agentPickerPanel">
                    {AGENT_OPTIONS.map((option) => {
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
                            vendor={option.kind === 'codex' ? 'codex' : 'cc'}
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

            {error ? <Text style={styles.errorText}>{error}</Text> : null}
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
                  leading={renderComposerCollapsedAttachmentBadge()}
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
            error={goalError}
            initial={draft.firstMessage.trim() ? { objective: draft.firstMessage.trim() } : undefined}
            onSetGoal={(input) => void createGoalSession(input)}
            testID="newSession.contextSheetGoalView"
          />
        )}
      </ContextSheet>
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
        onClose={() => setModelSheetOpen(false)}
        onSelectFlatModel={selectFlatModel}
        onSelectPermissionMode={(mode) => {
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
        }}
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
    paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING,
    paddingVertical: MOBILE_COMPOSER_INPUT_VERTICAL_PADDING,
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
  voiceDraftListeningText: {
    color: colors.statusReady,
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
