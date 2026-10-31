import { PluginUiEnablePrompt } from '@/plugins/PluginUiEnablePrompt';
import { deviceDisplayName } from '@/device-link/deviceName';
import {
  reconcileNewSessionCatalogDraft,
  reconcileNewSessionSubmitDraft,
  revalidateNewSessionDraftAfterAuth,
  restoreNewSessionFastPreference,
} from '@/session/newSessionRuntimeReconciliation';
import { useNewSessionWorktreeSync } from '@/session/useNewSessionWorktreeSync';
import {
  publishNewSessionVoiceDraft,
  changeNewSessionVoiceText,
  changeNewSessionVoiceSelection,
  finishNewSessionVoiceRecording,
  newSessionVoiceComposerProps,
} from '@/session/newSessionVoiceInput';
import { prepareNewSessionCreation } from '@/session/prepareNewSessionCreation';
import {
  appendNewSessionSharedText,
  openNewSessionPluginPalette,
  captureNewSessionOwner,
  createInitialNewSessionDraft,
  markNewSessionIncomingShare,
  patchNewSessionDraft,
  restoreNewSessionDraft,
  setNewSessionFirstMessage,
} from '@/session/newSessionForm';
import {
  useNewSessionStashedDraft,
  useNewSessionWorkspacePreferences,
  useNewSessionWorkspaceActions,
  useNewSessionInitialWorkspace,
} from '@/session/useNewSessionWorkspace';
import { useRemoteProjectAliases } from '@/session/useRemoteProjectAliases';
import { useIncomingShareComposer } from '@/session/useIncomingShareComposer';
import { ModelSpeedIcon } from '@/session/ModelSpeedIcon';
import { useNewSessionHostDefaults } from '@/session/useNewSessionHostDefaults';
import { ErrorNotice } from '@/components/ErrorNotice';
import { useNewSessionDefaultSelection } from '@/session/useNewSessionDefaultSelection';
import { parseGoalCommand } from '@cindy/maker-shared/goal-command';
import { mergeMobileGoalCommand, parseMobileDesktopCommand } from '@/session/desktopSlashCommands';
import { modelNeedsReselection } from '@/session/modelReselection';

import { completePrecreatedWorktreeRecovery } from '@/session/completePrecreatedWorktreeRecovery';

import { mobileDurableOutbox, getCurrentMobileOutboxRecords } from '@/session/mobileDurableOutbox';

import type { DurableOutboxRecord } from '@/session/durableOutbox';
import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import { workspacePathsEqual } from '@/session/workspaceSelection';
import { isSharedTaskPeer } from '@cindy/device-link';
import { takeRefinementContextTail } from '@cindy/voice-input-core';
import { Stack, useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { NewTaskSelectionSheet } from '@/session/NewTaskSelectionSheet';
import { resolveWorkspacePickerFrame, type WorkspacePickerFrame } from '@/session/workspacePickerPlacement';
import { simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { NativeChromeBackButton } from '@/platform/chrome/NativeChromeBackButton';
import { SystemNavigationBack, useSystemNavigationBack } from '@/platform/chrome/SystemNavigationBack';
import { NewSessionLayout } from '@/session/NewSessionLayout';
import { useSessionPaneLayout } from '@/session/ResidentHomeList';
import { readComposerEntry, useComposerDock } from '@/session/composerMorph';
import { useComposerPillOpen } from '@/session/useComposerPillOpen';
import { useComposerImageExpansion } from '@/session/useComposerImageExpansion';
import { DockKeyboardBottomSpacer } from '@/session/ComposerDockKeyboardFollow';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { composerGeometry } from '@/session/composerGeometry';
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
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextInputContentSizeChangeEvent,
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
  Settings,
  Target,
  UsersRound,
  X,
} from 'lucide-react-native';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenBackButton } from '@/components/MobilePrimitives';
import { PaperPlaneIcon } from '@/components/PaperPlaneIcon';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type {
  MobileAtResourceItem,
  MobileSlashCommand,
  RemoteDirectoryDrive,
  RemoteDirectoryEntry,
} from '@/device-link/mobileMakerTransport';
import { describeAgentAuthError, formatRemoteError, humanizeRemoteError } from '@/device-link/remoteStatus';
import { agentAuthGateHint, agentAuthGateVerdict } from '@/session/agentAuthGate';
import { connectedProvidersForAgent, getModel } from '@cindy/model-providers/registry';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
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
} from '@/session/attachments';
import { useAuth } from '@/auth/AuthContext';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';
import { clearNewSessionAttachmentsForDeviceChange, discardNewSessionUploadedAttachments } from '@/session/newSessionAttachmentCleanup';
import { useAutoResumeNewSessionDraft, useNewSessionDurableEdit } from '@/session/useNewSessionDraftRecovery';
import { goBackGuarded } from '@/utils/backGuard';
import { buildMobileImageAttachmentCandidate } from '@/session/mobileImageAttachment';
import { useMobileLocalAttachments } from '@/session/useMobileLocalAttachments';
import {
  useIncomingShareBatch,
} from '@/session/incomingShare';
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
  evictAgentCapabilitiesForDevice,
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
import { ComposerPluginPalette, ContextSheetPlugins } from '@/session/ContextSheetPlugins';
import { detectComposerPluginTrigger, placeComposerPlugin } from '@/session/composerPlugins';
import type { ComposerPlugin } from '@/session/remoteComposerPlugins';
import { textComposerDocument, composerDocumentProjectedText } from '@/session/composerDocument';
import { OrcaWorkerFormView } from '@/session/ContextSheetCollabView';
import { OrcaWorkerDirectoryPicker } from '@/session/OrcaWorkerDirectoryPicker';
import { useOrcaWorkerForm } from '@/session/useSessionOrcaCollab';
import {
  buildOrcaEnableOptions,
  describeOrcaError,
  enableOrcaTeam,
  isOrcaCollabEligible,
  orcaCollabEntryHint,
  narrowOrcaWorkerProvider,
  orcaCollabDraftTargetKey,
  readOrcaCollabEntryStatus,
  rememberOrcaStartFailure,
  type OrcaCollabEntryStatus,
  type OrcaWorkerFormValue,
} from '@/session/orcaTeam';
import { buildDraftWorkerInitialTask } from '@cindy/maker-shared/orca-team';
import { RecentPhotosStrip } from '@/session/ContextSheetMediaViews';
import { ContextSheetGoalCreateForm } from '@/session/ContextSheetGoalView';
import type { MobileGoalLimitsInput } from '@cindy/maker-shared/device-link-contract';
import { ComposerAttachmentCollapsedBadge, ComposerAttachmentTray } from '@/session/ComposerAttachmentTray';
import { useComposerPendingImagePreview } from '@/session/useComposerPendingImagePreview';
import { SlowSendNotice, type SlowSendPhase } from '@/session/SlowSendNotice';
import { useConfirmLeaveWhileUploading } from '@/session/useConfirmLeaveWhileUploading';
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
import { canBrowsePhotoLibraryDirectly } from '@/session/photoLibraryPolicy';
import {
  detectComposerTrigger,
  filterAtResources,
  filterSlashCommands,
  insertAtResource,
  insertSlashCommand,
  mergeSlashCommands,
} from '@/session/composerPalette';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import {
  applyRemoteAgentPick,
  NEW_SESSION_AGENT_OPTIONS,
  availableNewSessionAgentOptions,
  defaultPermissionModeForNewSessionAgent,
  buildRemoteCreateSessionOptions,
  buildRecentWorkspaceOptions,
  filterRemoteDirectoryEntries,
  isCurrentRemoteBrowseRequest,
  isNewSessionRuntimePending,
  normalizeRemoteDirectoryDrives,
  shouldRetryRemoteBrowseDrives,
  normalizeCreateSessionResult,
  isNewSessionDraftMissingPayloadOnly,
  parseNewSessionDeviceOptions,
  pickAgentDefaultRuntime,
  pickNewSessionDefaultDevice,
  sessionFromCreateResult,
  compensatePrecreatedWorktree,
  resolveStartedDowngradeOrCommit,
  resolveSubmitGuardCatalog,
  validateNewSessionDraft,
  type SubmitGuardCatalog,
  type NewSessionAgentKind,
  type NewSessionDraft,
  type NewSessionDeviceOption,
  type NewSessionRemoteAgentPick,
  type NewSessionStoredPreferences,
} from '@/session/newSession';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { newSessionText } from '@/session/newSessionMessages';

import { i18n } from '@/i18n';
import {
  getMobileAuthOwner,
  subscribeMobileAuthOwner,
} from '@/auth/authOwnerGeneration';
import { useTranslation } from 'react-i18next';
import {
  createNewSessionId,
  drainStashedNewSessionDraft,
  hasLiveNewSessionCreation,
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
  saveNewSessionPreferences,
} from '@/session/newSessionPreferenceStore';
import {
  remoteSessionStore,
  useRemoteNewMakerWorktreeBranchPreference,
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
import { VoicePillWidthFrame } from '@/session/voicePillWidthMotion';
import { useMobileVoiceProcessingIndicator } from '@/session/useMobileVoiceProcessingIndicator';
import { useComposerCardTransition } from '@/session/useComposerCardTransition';
import { ComposerKeyboardAvoidingView } from '@/session/ComposerKeyboardAvoidingView';
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
import { createMobileSpeakerGate, warmMobileSpeakerFilter } from '@/session/mobileSpeakerFilter';
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
import type { MobileModelConfiguration } from '@/session/unifiedMobileModels';
import { ModelPickerSheet } from '@/session/ModelPickerSheet';
import { MobileChoicePickerList } from '@/session/MobileChoicePickerList';
import { NativePermissionSheet } from '@/session/NativePermissionSheet';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import {
  buildWorktreeCreateRequest,
  formatWorktreeCreateFailure,
  isExactRemoteSessionClaimed,
  isValidWorktreeBranchPreferenceSnapshot,
  isWorktreeChannelNotAllowedError,
  parseWorktreeCreateResult,
  initialWorktreeProbeEligibility,
  resolveWorktreeEligibility,
  shouldAcceptWorktreeBranchListResult,
  settleWorktreeEligibilityForDisplay,
  shouldShowWorktreeToggle,
  worktreeEligibilityForTarget,
  worktreeEligibilityFromError,
  worktreeSourceBranchFromPreference,
  type NewSessionWorktreeEligibility,
  type NewSessionWorktreeProbeSnapshot,
  type NewSessionWorktreeSettledSnapshot,
} from '@/session/newSessionWorktree';
import { mobileAgentLabel, mobileAgentVendor } from '@/session/sessionAgentSwitch';
import { MobileModelIconMark } from '@/session/MobileProviderMark';
import { draftModelMemoryFor, hydrateDraftModelMemory } from '@/session/draftModelMemory';
import { effortLabelFromRuntime, rowFastEditable } from '@/session/modelPickerRows';
import { useRemoteAgentCatalogs, useRemoteAgentCatalogsWithStatus } from '@/session/useRemoteAgentCatalogs';
import { restoredRemoteAgentUnusable as restoredRemoteAgentUnusableCheck } from '@/session/remoteAgentCatalogs';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, navigationChrome, radius, spacing, typeScale } from '@/theme/tokens';

const COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD = 34;
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

/** 旧被控端(明确不支持 provider:list)才用能力表模型兜底选默认;支持目录的电脑一律走目录。 */
function flatModelsForUnsupportedHost(
  deviceId: string,
  agentKind: NewSessionAgentKind,
  providersUnsupported: boolean,
): readonly MobileModelOption[] | undefined {
  if (!providersUnsupported || !deviceId) return undefined;
  return getCachedAgentCapabilities(buildAgentCapabilitiesCacheKey(deviceId, agentKind))?.availableModels;
}

interface WorktreeBranchListSnapshot {
  target: { deviceId: string; workingDir: string };
  branches: string[];
  loading: boolean;
  failed: boolean;
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

export default function NewRemoteSessionScreen() {
  const creatingRef = useRef(false);
  return <NewSessionLayout creatingRef={creatingRef}><NewRemoteSessionContent creatingRef={creatingRef} /></NewSessionLayout>;
}

function NewRemoteSessionContent({ creatingRef }: { creatingRef: { current: boolean } }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  const paneLayout = useSessionPaneLayout();
  const systemBack = useSystemNavigationBack();
  const paneHeader = Platform.OS === 'ios' && paneLayout.persistent && !systemBack;
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
    composerMorph?: string;
    visualDraft?: string;
    suggestion?: string;
    draft?: string;
    recoverySessionId?: string;
    editSessionId?: string;
    creationError?: string;
  }>();
  const routeDeviceId = String(params.deviceId ?? '');
  const routeDeviceName = deviceDisplayName(routeDeviceId, typeof params.deviceName === 'string' ? params.deviceName : undefined);
  const initialWorkingDir = readRouteString(params.workingDir);
  const visualFocusComposer = MOBILE_VISUAL_MOCK_ENABLED && readRouteString(params.visualFocusComposer) === '1';
  // The home action lands in the compact pill; only a user's tap opens the card and keyboard.
  const [entryMorph] = useState(() => readComposerEntry(readRouteString(params.composerMorph) ?? undefined));
  const navigation = useNavigation();
  // The morph stood in for the push; leaving should still slide back normally.
  // Switch only after the entry transition: changing it on mount would make the
  // push itself slide in under the morph overlay.
  useEffect(() => {
    if (!entryMorph) return;
    const restore = () => navigation.setOptions({ animation: 'default' });
    const unsubscribe = navigation.addListener('transitionEnd' as never, restore);
    const fallback = setTimeout(restore, 1600);
    return () => { unsubscribe(); clearTimeout(fallback); };
  }, [entryMorph, navigation]);
  const composerDock = useComposerDock();
  const visualInitialDraft = MOBILE_VISUAL_MOCK_ENABLED ? readRouteString(params.visualDraft) : null;
  const router = useRouter();
  const nativeSelectionSheet = Platform.OS === 'ios' || Platform.OS === 'android';
  const auth = useAuth();
  const outboxOwner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner, getMobileAuthOwner);
  const {
    getPresenceAvailability,
    invoke,
    openLink,
    subscribe,
    unsubscribe,
    onAgentsChanged,
    status: deviceLinkStatus,
    connectionEpoch,
    presenceVersion,
  } = useDeviceLink();
  const deviceLinkStatusRef = useRef(deviceLinkStatus);
  deviceLinkStatusRef.current = deviceLinkStatus;
  const routeDeviceFallback = useMemo<NewSessionDeviceOption | null>(
    () => routeDeviceId ? { deviceId: routeDeviceId, name: deviceDisplayName(routeDeviceId, routeDeviceName) } : null,
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
  const workingDirPreferenceOverridesRef = useRef<Record<string, string>>({});
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
  const selectedDeviceLabel = selectedDeviceId ? deviceDisplayName(selectedDeviceId, selectedDeviceOption?.name || selectedDeviceName, deviceOptions) : t('session.new.selectDevice');
  const maker = useMobileMakerTransport(selectedDeviceId);
  const sessions = useRemoteSessions();
  const projectAliases = useRemoteProjectAliases([selectedDeviceId]);
  const recentWorkspaces = useMemo(
    () => buildRecentWorkspaceOptions(
      sessions.filter((session) => session.deviceLinkDeviceId === selectedDeviceId),
      selectedDeviceId,
      6,
      projectAliases,
    ),
    [selectedDeviceId, sessions, projectAliases],
  );
  const [draft, setDraft] = useState<NewSessionDraft>(() => createInitialNewSessionDraft({
    initialWorkingDir, visualInitialDraft, routeDraft: params.draft, suggestion: params.suggestion, t,
  }));
  const firstMessageRef = useRef(draft.firstMessage);
  const [planModeDraftOn, setPlanModeDraftOn] = useState(false);
  const prePlanPermissionModeRef = useRef<string | null>(null);
  const firstMessageSelectionRef = useRef({ start: draft.firstMessage.length, end: draft.firstMessage.length });
  const [firstMessageSelection, setFirstMessageSelection] = useState(firstMessageSelectionRef.current);
  const [creating, setCreating] = useState(false);
  const [createStartedAt, setCreateStartedAt] = useState<number | null>(null);
  const [createPhase, setCreatePhase] = useState<SlowSendPhase>('preparing');
  const waitForLeaveDecision = useConfirmLeaveWhileUploading(creating && createPhase === 'uploading');
  const [error, setError] = useState<string | null>(() => {
    const creationError = readRouteString(params.creationError);
    return creationError ? t('session.screen.createFailedNotice', { message: creationError }) : null;
  });
  const [capabilities, setCapabilities] = useState<MobileAgentCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [, setCapabilitiesError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseEntries, setBrowseEntries] = useState<RemoteDirectoryEntry[]>([]);
  // Windows 被控端的盘符切换项;读取失败时保留上一次的值,切到读不了的盘(空光驱)后还能切回。
  const [browseDrives, setBrowseDrives] = useState<RemoteDirectoryDrive[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false);
  // Context 面板(+ 号弹出的可拖动 sheet):open + 子视图(主视图 / 截图列表 / 目标草稿)。
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const [contextSheetView, setContextSheetView] = useState<'main' | 'goal' | 'collab'>('main');
  const contextSheetMediaLibraryEnabled = canBrowsePhotoLibraryDirectly(Platform.OS);
  // 新建即协同(对齐桌面 NewMakerDraftRoute 的协同草稿):确认后只武装草稿,发送首条消息 /
  // 建目标时在 createSession 之后开启(首轮 Lead 才有协同工具)。一次性:创建后复位。
  const [collabDraft, setCollabDraft] = useState<OrcaWorkerFormValue | null>(null);
  const [collabEntryStatus, setCollabEntryStatus] = useState<OrcaCollabEntryStatus>('loading');
  const executionMakerForDevice = useCallback(
    (targetDeviceId: string) => createMobileMakerTransport({ deviceId: targetDeviceId, invoke }),
    [invoke],
  );
  // 远程 Agent / 供应商分享(与已建任务、桌面新建同一套):选中另一台电脑或分享来的模型 = Agent
  // 在那里运行。单独存,不进草稿:草稿的模型 / 来源一直按被控电脑的目录校准,创建时再整体覆盖。
  const [remoteAgentChoice, setRemoteAgentChoice] = useState<{
    controlledDeviceId: string;
    pick: NewSessionRemoteAgentPick;
    /** 打开新建页时按记忆恢复的(不是本页刚选的):那台电脑 / 那个分享此刻用不了就退回被控电脑默认。 */
    restored?: true;
  } | null>(null);
  // 只对选它时的那台被控电脑与那个 Agent 成立:换了电脑、在别处换了 Agent 就不再生效(按条件
  // 判,不靠 effect 清——恢复草稿时电脑与草稿同一轮写入,effect 会把刚恢复的选择误清)。
  const remoteAgentPick = remoteAgentChoice
    && remoteAgentChoice.controlledDeviceId === selectedDeviceId
    && remoteAgentChoice.pick.agentKind === draft.agentKind
    ? remoteAgentChoice.pick
    : null;
  // 被控电脑支持给协同 Worker 单独选 Agent 所在电脑(远程供应商)时，Worker 与任务一样可以选其他
  // 电脑 / 分享的供应商，协同也不再与「任务的 Agent 在另一台电脑」互斥。
  const workerAgentLocationSupported = !!selectedDeviceId
    && !isSharedTaskPeer(selectedDeviceId)
    && capabilities?.supportsOrcaWorkerAgentDevice === true;
  const collabForm = useOrcaWorkerForm({
    maker,
    executionMakerForDevice,
    executionDevicesEnabled: true,
    // 按区域限定的账号键:Global 与中国大陆版同号不同人,记忆(含完全访问)不能串。
    prefsScope: outboxOwner.accountKey || null,
    taskHostDeviceId: selectedDeviceId,
    active: contextSheetOpen && contextSheetView === 'collab',
    setSheetOpen: setContextSheetOpen,
    connectionEpoch,
    // Worker 默认跟任务(Lead)的 Agent 所在电脑。
    leadAgentDeviceId: remoteAgentPick?.deviceId ?? null,
    agentLocationSelectable: workerAgentLocationSupported,
  });
  const collabTarget = useMemo(() => ({
    orcaRole: null,
    workspaceKind: draft.workspaceKind,
    workingDir: draft.workingDir || null,
    remoteHostId: null,
  }), [draft.workingDir, draft.workspaceKind]);
  // 旧被控电脑不支持给 Worker 选 Agent 位置：首个 Worker 只能从被控电脑的目录里选，与任务的
  // Agent 在另一台电脑运行对不上，两者仍互斥。
  const collabEligible = isOrcaCollabEligible(collabTarget)
    && (remoteAgentPick === null || workerAgentLocationSupported);
  // 换设备 / 换工作区后,草稿里的协同设置属于旧目标:丢弃,避免在新目标上静默开启。
  // 按草稿武装时的目标比对(而不是「目标一变就清」):返回编辑恢复草稿时目标与草稿一起回填,
  // 不会被这里误清。
  const collabTargetKey = orcaCollabDraftTargetKey(selectedDeviceId, draft.workspaceKind, draft.workingDir);
  const collabDraftTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (collabDraftTargetRef.current !== collabTargetKey) setCollabDraft(null);
  }, [collabTargetKey]);
  // 读入口状态;重连后重读:断线时读失败会落成「不可用」,不能让表单一直卡住。
  useEffect(() => {
    if (!contextSheetOpen || !collabEligible || !selectedDeviceId) return undefined;
    let cancelled = false;
    setCollabEntryStatus('loading');
    void readOrcaCollabEntryStatus(maker, collabTarget, draft.agentKind)
      .then((status) => { if (!cancelled) setCollabEntryStatus(status); });
    return () => { cancelled = true; };
  }, [collabEligible, collabTarget, connectionEpoch, contextSheetOpen, draft.agentKind, maker, selectedDeviceId]);
  const openCollabDraftForm = useCallback(() => {
    if (collabDraft) {
      collabForm.restore(collabDraft);
    } else {
      collabForm.reset();
    }
    setContextSheetView('collab');
  }, [collabDraft, collabForm]);
  // 目标模式(对齐桌面 NewMakerDraftRoute.handleCreateGoal):填完表单直接建会话 + setGoal,
  // 被控端落目标消息并自动开跑第一轮,成功后跳转会话页。
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const workspacePickerHostRef = useRef<View>(null);
  const workspacePickerAnchorRef = useRef<View>(null);
  const [workspacePickerFrame, setWorkspacePickerFrame] = useState<WorkspacePickerFrame | null>(null);
  const measureWorkspacePicker = useCallback(() => {
    if (nativeSelectionSheet || !workspacePickerOpen) return;
    workspacePickerAnchorRef.current?.measureInWindow((x, y, width, height) => {
      workspacePickerHostRef.current?.measureInWindow((hostX, hostY, hostWidth, hostHeight) => {
        setWorkspacePickerFrame(resolveWorkspacePickerFrame(
          { x, y, width, height },
          { x: hostX, y: hostY, width: hostWidth, height: hostHeight },
          spacing.xs,
        ));
      });
    });
  }, [nativeSelectionSheet, workspacePickerOpen]);
  useLayoutEffect(() => {
    if (workspacePickerOpen) measureWorkspacePicker();
    else setWorkspacePickerFrame(null);
  }, [workspacePickerOpen, measureWorkspacePicker]);
  // 模型浮窗(ContextSheet 同款 Modal;新建页权限已提为独立选择器,浮窗只留模型)。
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // 权限模式独立浮窗(composer 工具条权限药丸点开;面板自持档位,见 NativePermissionSheet)。
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  // 被控端 runtime 已注册的 agent 集合(null = 未拉到 → fail-open 不过滤入口)。据此过滤新建
  // agent 选项:被控端 Pi 二进制缺失时其 agent map 无 pi,但模型目录仍投影 Pi,不过滤会让用户
  // 建出最终 requireAgent 报 not-registered 的会话(codex review P2)。
  const [availableAgentKinds, setAvailableAgentKinds] =
    useState<ReadonlySet<NewSessionAgentKind> | null>(null);
  const [availableAgentRefreshNonce, setAvailableAgentRefreshNonce] = useState(0);
  const [availableAgentRosterRefreshNonce, setAvailableAgentRosterRefreshNonce] = useState(0);
  const rosterRecoveryIdentityRef = useRef<{
    deviceId: string;
    connectionEpoch: number;
    presenceVersion: number;
  } | null>(null);
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
  const worktreeSettledRef = useRef<NewSessionWorktreeSettledSnapshot | null>(null);
  const worktreeSourceBranchRef = useRef('HEAD');
  const [attachments, setAttachments] = useState<RemoteSerializedAttachment[]>([]);
  // create() 里 await 在途图片上传后闭包里的 attachments 已是旧值,经 ref 读最新列表。
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 相册资产 → 已上传附件 id 的映射(缩略图勾选态真相)。
  const [mediaAssetAttachments, setMediaAssetAttachments] = useState<Record<string, string>>({});
  // 待选相册资产(按选中顺序;Cursor 式两段提交,底部「加入对话」统一上传)。
  const mediaTapAcceptedRef = useRef(false);
  // 本机图片附件的本地预览 uri(attachmentId → file://),composer 托盘缩略图 / 全图查看用。
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  // composer 托盘里正被全屏查看的图片附件 id(null = 关闭)。
  const [composerPreviewAttachmentId, setComposerPreviewAttachmentId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // 创建失败后返回编辑；再次打开空白新建页时，继续同设备/项目的草稿。
  // 附件是已上传完成的引用,原样回列即可继续使用;notice 是「有内容没能带回」的告知
  // (创建期间发出的消息可能超出单条上限,装不下的只能丢,但不能静默丢,review P1)。
  // 声明在 attachmentError 之后:notice 就落在附件错误行上。
  const outboxRecoveryRef = useRef<DurableOutboxRecord | null>(null);
  const userTouchedDeviceRef = useRef(false);
  const restoreCreationDraft = useCallback((
    saved: NewSessionDraft,
    files: RemoteSerializedAttachment[],
    plan?: { enabled: boolean; restorePermissionMode: string | null },
    controlledDeviceId?: string,
  ) => {
    restoreNewSessionDraft(
      {
        setRemoteAgentChoice,
        userTouchedWorkspaceRef,
        userTouchedRuntimeRef,
        appliedPermissionMemoryRef,
        runtimeActionSeqRef,
        firstMessageRef,
        firstMessageSelectionRef,
        setFirstMessageSelection,
        attachmentsRef,
        setAttachments,
        setPlanModeDraftOn,
        prePlanPermissionModeRef,
        setDraft,
      },
      saved,
      files,
      plan,
      controlledDeviceId,
    );
  }, []);
  const leaveForeignOutboxRecovery = useCallback(() => {
    const record = outboxRecoveryRef.current;
    if (!record || record.accountId === getMobileAuthOwner().accountKey) return false;
    router.replace('/devices');
    return true;
  }, [router]);
  const hasRecoveryInput = () => !!(outboxRecoveryRef.current
    || firstMessageRef.current || attachmentsRef.current.length || hasAttachmentInput()
    || incomingShareReceivedRef.current || userTouchedDeviceRef.current
    || userTouchedRuntimeRef.current || userTouchedWorkspaceRef.current);
  const { edit: editRecoveredDraft, flush: flushRecoveredDraft } = useNewSessionDurableEdit({
    sessionId: String(params.recoverySessionId ?? ''), deviceId: routeDeviceId, owner: outboxOwner,
    getToken: auth.getAccessToken,
    hasInput: hasRecoveryInput,
    leaveForeignRecovery: leaveForeignOutboxRecovery,
    onError: error => setError(formatRemoteError(error)),
    onEdited: record => { outboxRecoveryRef.current = record; },
    onRestore: record => {
      outboxRecoveryRef.current = record;
      userTouchedDeviceRef.current = true;
      restoreCreationDraft(record.creation.draft,
        record.item.attachmentSlots.filter((a): a is RemoteSerializedAttachment => a !== null),
        { enabled: record.creation.planModeArm, restorePermissionMode: record.creation.restorePermissionMode },
        record.deviceId);
      if (record.creation.notice) setAttachmentError(record.creation.notice);
      if (record.error) setError(t('session.screen.createFailedNotice', { message: record.error }));
      setSelectedDeviceId(record.deviceId);
      setSelectedDeviceName(record.creation.deviceName);
    },
  });
  useNewSessionStashedDraft({
    sessionId: readRouteString(params.editSessionId) ?? undefined,
    deviceId: routeDeviceId,
    drainStashedNewSessionDraft,
    restoreCreationDraft,
    setAttachmentError,
    userTouchedDeviceRef,
    setSelectedDeviceId,
    setSelectedDeviceName,
    onRestoreCollab: (stashed) => {
      collabDraftTargetRef.current = orcaCollabDraftTargetKey(
        stashed.deviceId!,
        stashed.draft.workspaceKind,
        stashed.draft.workingDir,
      );
      setCollabDraft(stashed.collabDraft);
    },
  });
  // 圈点标注接线 api 的 ref 中转(同会话页):hook 实例声明在 removeAttachment
  // 之后,onUploaded 等回调延迟执行经 ref 读最新实例。
  const composerAnnotationsRef = useRef<UseComposerImageAnnotationsResult | null>(null);
  // 本机附件(相册 / 拍照 / 文件)乐观上传:picker 一返回即进托盘,上传转后台。
  const {
    pendingUploads,
    pastePlaceholderCount,
    imageSelectionRevision,
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
    hasAttachmentInput,
    getUploadedSource,
    insertUploadedAttachment,
    getUploadedAttachmentId,
    releaseUploadedSources,
  } = useMobileLocalAttachments({
    getAccessToken: () => auth.getAccessToken(),
    getAttachmentCount: () => attachmentsRef.current.length,
    onUploaded: (rawAttachment, candidate) => {
      // 标注类 candidate:记录「矢量笔迹 + 原图」再编辑真相并打 annotated wire 标。
      const attachment = composerAnnotationsRef.current
        ?.decorateUploadedAttachment(rawAttachment, candidate) ?? rawAttachment;
      // create() 在 waitForPendingUploads 落定后同步读 ref,而 setState 到 commit 有
      // 微任务延迟——这里派发时同步镜像,保证「上传完成→立即创建」不丢刚落定的附件。
      attachmentsRef.current = insertUploadedAttachment(attachmentsRef.current, attachment);
      if (candidate.kind === 'image') {
        setAttachmentPreviews((current) => ({ ...current, [attachment.id]: candidate.uri }));
      }
      if (candidate.sourceId) {
        // 相册面板来源:asset.id → attachment.id 映射,驱动面板勾选角标。
        const sourceId = candidate.sourceId;
        setMediaAssetAttachments((current) => ({ ...current, [sourceId]: attachment.id }));
      }
      setAttachments((current) => insertUploadedAttachment(current, attachment));
    },
    onError: setAttachmentError,
    onPicked: () => setContextSheetOpen(false),
  });
  useEffect(() => subscribeMobileAuthOwner(() => {
    // Switching accounts invalidates both queued uploads and already received
    // attachments, synchronously, before a new account can send this draft.
    discardNewSessionUploadedAttachments(attachmentsRef.current, auth.getAccessToken);
    discardAllPendingUploads();
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentPreviews({});
    setMediaAssetAttachments({});
    setAttachmentError(null);
  }), [auth.getAccessToken, discardAllPendingUploads]);
  const incomingShareBatch = useIncomingShareBatch();
  const incomingShareReceivedRef = useRef(false);
  markNewSessionIncomingShare(incomingShareBatch, incomingShareReceivedRef);
  const isShareTargetFocused = useIsFocused();
  useAutoResumeNewSessionDraft({
    enabled: !(params.recoverySessionId || params.editSessionId || params.draft || params.suggestion
      || visualInitialDraft || !newSessionPreferencesLoaded),
    deviceId: selectedDeviceId, workingDir: initialWorkingDir, owner: outboxOwner,
    hasInput: hasRecoveryInput,
    onResume: next => router.setParams(next),
  });
  const pendingGoalSkillRef = useRef<string | null>(null);
  useEffect(() => {
    pendingGoalSkillRef.current = null;
  }, [selectedDeviceId, draft.agentKind, draft.workspaceKind, draft.workingDir]);
  const [slashCommands, setSlashCommands] = useState<MobileSlashCommand[]>([]);
  const [slashPaletteLoading, setSlashPaletteLoading] = useState(false);
  const [slashPaletteError, setSlashPaletteError] = useState<string | null>(null);
  const [atResources, setAtResources] = useState<MobileAtResourceItem[]>([]);
  const [atPaletteLoading, setAtPaletteLoading] = useState(false);
  const [atPaletteError, setAtPaletteError] = useState<string | null>(null);
  const [atResourcesTruncated, setAtResourcesTruncated] = useState(false);
  const [voiceStartPending, setVoiceStartPending] = useState(false);
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
    // 首段音频到达时与 listening 同批交接;停止、取消和错误也在这里收回 pending。
    setVoiceStartPending(false);
  }, []);
  const browseSeqRef = useRef(0);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  selectedDeviceIdRef.current = selectedDeviceId;
  const capabilitiesSeqRef = useRef(0);
  const slashLoadSeqRef = useRef(0);
  const atLoadSeqRef = useRef(0);
  const initialWorkspaceKeyRef = useRef<string | null>(null);
  const appliedDefaultDeviceKeyRef = useRef<string | null>(null);
  // 权限记忆只在偏好加载后恢复一次(之后由用户选择 / 切 agent 驱动),防止重复覆盖。
  const appliedPermissionMemoryRef = useRef(false);
  const userTouchedWorkspaceRef = useRef(false);
  const firstMessageInputRef = useRef<NativeTextInput>(null);
  const composerPillOpen = useComposerPillOpen(composerDock.enabled, () => firstMessageInputRef.current?.focus());
  const voiceDraftScrollRef = useRef<ScrollView>(null);
  const voiceRecordingActiveRef = useRef(false);
  const voicePermissionRequestInFlightRef = useRef(false);
  const voicePermissionRequestSeqRef = useRef(0);
  const voicePermissionRequestAbortRef = useRef<AbortController | null>(null);
  const voiceStartupInFlightRef = useRef(false);
  const voiceStopInFlightRef = useRef(false);
  const voiceSelectionUserOwnedRef = useRef(false);
  const voicePendingSelectionEchoesRef = useRef<Array<{ start: number; end: number }>>([]);
  // The press that stops dictation can emit one native selection event of its
  // own. Consume that event before allowing a real user move to claim control.
  const voiceStopGestureSelectionGuardRef = useRef(false);
  const voiceStartupSeqRef = useRef(0);
  const voiceControllerSessionRef = useRef<MobileVoiceControllerSession | null>(null);
  const voiceDictionaryLearningTrackerRef = useRef<MobileVoiceDictionaryLearningTracker | null>(null);
  const [firstMessageInputContentHeight, setFirstMessageInputContentHeight] = useState(MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT);
  const [firstMessageInputFocused, setFirstMessageInputFocused] = useState(visualFocusComposer);
  const [voiceDraftCaretFrame, setVoiceDraftCaretFrame] = useState({ left: 0, top: 0 });
  const voiceDraftCaretRef = useRef<View>(null);
  const voiceDraftMeasuredBlockRef = useRef<View>(null);
  // 自动默认运行配置(跟随被控电脑新建任务默认 / 区域默认 / 列表最上面)的守卫:用户一旦手动选过模型,就不再自动覆盖;
  // 记录已自动应用过的设备,切设备时(未手动选过)按新设备重算。
  const userTouchedRuntimeRef = useRef(false);
  // 模型已按哪台电脑的真实数据落定(见 isNewSessionRuntimePending);切到别的电脑即重新等待,
  // 未落定时药丸显示读取中、不能创建。
  const [runtimeSettledDeviceId, setRuntimeSettledDeviceId] = useState<string | null>(null);
  const mountedAtRef = useRef(Date.now());
  const runtimeSettledSourceRef = useRef('');
  const settleRuntime = useCallback((source: string, deviceId: string) => {
    runtimeSettledSourceRef.current = source;
    setRuntimeSettledDeviceId(deviceId);
  }, []);
  // 只保护当前页面刚从 provider 目录显式选中的模型，避免旧 capabilities 在途结果误回退；
  // 持久草稿不会写入该 ref，因此已下架模型仍走 mobile 的首项降级。
  const explicitProviderModelSelectionRef = useRef<string | null>(null);
  const autoDefaultDeviceRef = useRef<string | null>(null);
  // 被控电脑的「新建任务默认」(与桌面远程新建同一读源 maker:get-new-maker-defaults):
  // 默认模型 = 那台电脑上新建任务时用户上次选的模型,不再从任务列表推断「最近使用」。
  // 同账号同设备先用跨页缓存,再后台读齐三个 agent;刷新不阻塞新建或覆盖手动选择。
  // 无缓存时才等待首读;旧被控端或重试后仍失败也算读完,回落目录默认,不无限等待。
  const { hostDraftDefaults, hostDefaultsSettled, hostRuntimeFor, waitHostDraftDefaults, requestHostChoiceWrite } = useNewSessionHostDefaults({
    selectedDeviceId, deviceLinkStatus, maker, openLink, outboxOwner, remoteAgentChoice, draft
  });
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
  const deviceProviders = useDeviceProviders(
    selectedDeviceId || undefined,
    modelSheetOpen,
  );
  // 模型列表元信息(单价 / 折扣版 key presence)+ 草稿 per-(agent,来源,模型) 记忆(对齐桌面)。
  const deviceModelPricing = useDeviceModelPricing(selectedDeviceId || undefined);
  const deviceApiKeyStatus = useDeviceApiKeyStatus(selectedDeviceId || undefined);
  const collabWorkerDeviceId = collabForm.form.executionDeviceId ?? selectedDeviceId;
  const collabDeviceProviders = useDeviceProviders(collabWorkerDeviceId || undefined, collabForm.modelPicker.open);
  const collabModelPricing = useDeviceModelPricing(collabWorkerDeviceId || undefined);
  const collabApiKeyStatus = useDeviceApiKeyStatus(collabWorkerDeviceId || undefined);
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
  // 被控电脑认得新建时的 agentDeviceId 才提供远程模型:它的目录带「允许被远程调用」标记
  // (与远程 Agent 同一版加入)。共享任务访客读到的是自己账号的设备,与这台电脑无关。
  const remoteAgentSupported = !!selectedDeviceId
    && !isSharedTaskPeer(selectedDeviceId)
    && deviceProviders.providers.some(
      (provider) => typeof (provider as { remoteInvocationEnabled?: unknown }).remoteInvocationEnabled === 'boolean',
    );
  const remoteAgentKeepDeviceIds = useMemo(
    () => (remoteAgentPick ? [remoteAgentPick.deviceId] : []),
    [remoteAgentPick],
  );
  const { catalogs: remoteAgentCatalogs, settled: remoteAgentCatalogsSettled } = useRemoteAgentCatalogsWithStatus({
    // 选择器打开时读其他电脑与分享;已选远程模型时还要按那份目录显示模型药丸。
    enabled: remoteAgentSupported && (modelSheetOpen || remoteAgentPick !== null),
    controlledDeviceId: selectedDeviceId,
    keepDeviceIds: remoteAgentKeepDeviceIds,
    keepOnly: !modelSheetOpen,
  });
  // 协同首个 Worker 的模型选择器:与任务模型列表同一份远程供应商，只在 Worker 选择器打开时读。
  const workerAgentKeepDeviceIds = useMemo(
    () => [...new Set([remoteAgentPick?.deviceId, collabForm.form.agentDeviceId]
      .filter((id): id is string => !!id))],
    [remoteAgentPick?.deviceId, collabForm.form.agentDeviceId],
  );
  const workerAgentCatalogs = useRemoteAgentCatalogs({
    enabled: remoteAgentSupported && collabForm.agentLocationSelectable && collabForm.modelPicker.open,
    controlledDeviceId: collabWorkerDeviceId,
    keepDeviceIds: workerAgentKeepDeviceIds,
  });
  const remoteAgentCatalog = remoteAgentPick
    ? remoteAgentCatalogs.find((catalog) => catalog.deviceId === remoteAgentPick.deviceId) ?? null
    : null;
  // 药丸用那台电脑目录里的来源与模型名;目录还没读到时退回模型 id、不画来源标。
  const remoteAgentPillProvider = useMemo(() => {
    if (!remoteAgentPick || !remoteAgentCatalog) return null;
    const sourceId = remoteAgentPick.providerId ?? buildMobileModelSections({
      providers: remoteAgentCatalog.providers,
      agentKind: remoteAgentPick.agentKind,
      selectedModelId: remoteAgentPick.model,
      selectedProviderId: null,
      visibilityOverrides: remoteAgentCatalog.modelVisibilityOverrides,
    }).activeSourceId;
    return remoteAgentCatalog.providers.find((provider) => provider.id === sourceId) ?? null;
  }, [remoteAgentCatalog, remoteAgentPick]);
  // 恢复上次在这台被控电脑上给当前 agent 选的另一台电脑 / 分享来的模型。每个(电脑, agent)只试一次,
  // 本页用户自己改过运行配置就不再恢复。
  const remoteAgentRestoreKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!newSessionPreferencesLoaded || !selectedDeviceId || userTouchedRuntimeRef.current) return;
    const key = JSON.stringify([selectedDeviceId, draft.agentKind]);
    if (remoteAgentRestoreKeyRef.current === key) return;
    remoteAgentRestoreKeyRef.current = key;
    const saved = newSessionPreferences?.remoteAgentByDevice[selectedDeviceId]?.[draft.agentKind];
    if (!saved || isSharedTaskPeer(selectedDeviceId)) return;
    setRemoteAgentChoice({ controlledDeviceId: selectedDeviceId, pick: saved, restored: true });
  }, [draft.agentKind, newSessionPreferences, newSessionPreferencesLoaded, selectedDeviceId]);
  // 恢复出来的选择此刻用不了(被控电脑不再提供远程模型、那台离线或读不到、模型已不在那份目录里)
  // → 退回被控电脑的默认;记忆保留,那台恢复后下次打开照样选回。
  const restoredRemoteAgentUnusable = !!remoteAgentChoice?.restored && !!remoteAgentPick && (
    (deviceProviders.ready && !remoteAgentSupported)
    || (remoteAgentSupported && restoredRemoteAgentUnusableCheck({
      pick: remoteAgentPick, catalog: remoteAgentCatalog ?? undefined, settled: remoteAgentCatalogsSettled,
    }))
  );
  useEffect(() => {
    if (restoredRemoteAgentUnusable) setRemoteAgentChoice(null);
  }, [restoredRemoteAgentUnusable]);
  const catalogReadyRef = useRef(deviceProviders.ready);
  catalogReadyRef.current = deviceProviders.ready;
  // 供应商目录本身的渲染期镜像:异步回调(权限确认 .then)提交时用它现场重建目标
  // agent 的 rows——确认弹窗期间目录可能从未就绪变为就绪或同设备刷新,触发时捕获的
  // rows 与最新 ready 不同代会误判/抄旧首项(codex review P2)。
  const deviceProvidersRef = useRef(deviceProviders);
  deviceProvidersRef.current = deviceProviders;
  // 发送前鉴权门禁(对齐桌面 useVendorAuthGate):选中 agent 在被控端没有已连接
  // 供应商时提前提示 + 拦截创建,不让用户发出注定失败的首条消息。unknown 不拦截。
  // 选了另一台电脑的模型时不按被控电脑判:那一行来自那台已连接的供应商,登录由那台核对。
  const agentAuthVerdict = useMemo(
    () => remoteAgentPick ? 'ready' as const : agentAuthGateVerdict({
      providers: deviceProviders.providers,
      loading: deviceProviders.loading,
      error: deviceProviders.error,
      agentKind: draft.agentKind,
    }),
    [deviceProviders.providers, deviceProviders.loading, deviceProviders.error, draft.agentKind, remoteAgentPick],
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
  useNewSessionWorkspacePreferences({
    newSessionPreferences,
    setNewSessionPreferences,
    newSessionPreferencesLoaded,
    setNewSessionPreferencesLoaded,
    workingDirPreferenceOverridesRef,
    initialWorkingDir,
    userTouchedWorkspaceRef,
    setDraft,
    userTouchedDeviceRef,
    routeDeviceId,
    routeDeviceName,
    routeDeviceExplicit,
    deviceOptions,
    appliedDefaultDeviceKeyRef,
    preferredDefaultDevice,
    setSelectedDeviceId,
    setSelectedDeviceName,
    setDevicePickerOpen,
  });

  useNewSessionDefaultSelection({
    newSessionPreferences,
    newSessionPreferencesLoaded,
    userTouchedRuntimeRef,
    preferredDefaultDevice,
    selectedDeviceId,
    hostDraftDefaults,
    hostDefaultsSettled,
    hostRuntimeFor,
    deviceProviders,
    deviceProvidersRef,
    catalogReadyRef,
    flatModelsForUnsupportedHost,
    targetAgentHasFast,
    draftMemory,
    autoDefaultDeviceRef,
    setDraft,
    settleRuntime,
    appliedPermissionMemoryRef,
    draft,
    runtimeActionSeqRef,
    selectedDeviceRef,
    capabilities,
    modelRows,
    modelSections,
  });

  // 目录就绪后的来源终检(codex review P1):自动默认/恢复在目录加载期信任的来源可能已失效
  // (provider 被删/断开/模型下架),就绪后必须复核——联合回退整对 (model, providerId)
  // (其他来源顶替 / 首项 / 留空),不留裸模型回落默认网关(codex review P2)。
  // 无变化时返回原引用,不触发额外渲染。
  useEffect(() => {
    if (!deviceProviders.ready) return;
    setDraft((current) => reconcileNewSessionCatalogDraft(current, modelRows, deviceProviders));
  }, [deviceProviders.ready, deviceProviders.providers, deviceProviders.modelVisibilityOverrides, modelRows]);
  const draftContent = useMemo(
    // pending(乐观上传中)也算数:拍完照立刻点创建是常见路径,create() 里会等它们落定。
    () => ({ attachmentCount: attachments.length + pendingUploads.length }),
    [attachments.length, pendingUploads.length],
  );
  const runtimePending = isNewSessionRuntimePending({
    settled: !!selectedDeviceId && runtimeSettledDeviceId === selectedDeviceId,
    userTouched: userTouchedRuntimeRef.current,
    remoteAgentPicked: !!remoteAgentPick,
    selectedDeviceId: selectedDeviceId ?? '',
    catalogReady: deviceProviders.ready,
    catalogFailed: deviceProviders.error !== null,
    modelRowCount: modelRows.length,
  });
  const runtimePendingRef = useRef(runtimePending);
  runtimePendingRef.current = runtimePending;
  useEffect(() => {
    if (!runtimeSettledDeviceId) return;
    // 诊断用:新建页的模型经哪条路径、多久后落定(只记 agent 与模型 id,不含正文)。
    mobileDebugLog('info', 'new-session', 'runtime settled', {
      source: runtimeSettledSourceRef.current,
      agentKind: draft.agentKind,
      model: draft.model,
      elapsedMs: Date.now() - mountedAtRef.current,
    });
    // 每台电脑落定那一刻记一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeSettledDeviceId]);
  const runtimeSummary = useMemo(
    () => buildDraftRuntimeSummary(draft, runtimeOptions),
    // effort / 权限标签按 app 语言解析,切换语言时必须重算,否则停留在上一语言。
    [draft, runtimeOptions, i18nInstance.language],
  );
  // 选了另一台电脑的模型:药丸写那台目录里的模型名与档位,读屏一并读出电脑名(与已建任务同口径)。
  const remoteAgentModelName = remoteAgentPick && remoteAgentPillProvider
    ? getModel(remoteAgentPillProvider, remoteAgentPick.model, remoteAgentPick.agentKind)?.name ?? null
    : null;
  const pillModelSummary = remoteAgentPick
    ? [
        remoteAgentModelName || remoteAgentPick.model,
        effortLabelFromRuntime({ currentModel: null, effortOptions: runtimeOptions.effortOptions }, remoteAgentPick.effort),
      ].filter(Boolean).join(' · ')
    : runtimePending
      ? t('session.new.modelLoading')
      : draft.model.trim()
        ? runtimeSummary.modelSummary
        : t('session.new.noModelSelected');
  const pillAccessibilityModel = remoteAgentCatalog?.name
    ? [pillModelSummary, remoteAgentCatalog.name].join(', ')
    : pillModelSummary;
  // 权限按钮 / 权限下拉不体现 plan(对齐桌面 PR#494 / Cursor):计划模式激活时展示
  // 进入前的底层权限档(无记录时回退首个非 plan 档),激活态由 composer 的 PlanModeChip 表达。
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
  // 开关行按「已有定论」显示：首次探测完成前不出现，重连重探沿用上次定论不闪。
  const worktreeSettled = settleWorktreeEligibilityForDisplay(
    worktreeEligibility,
    worktreeTarget,
    worktreeSettledRef.current,
  );
  // 只在提交后记录「已展示的定论」：被放弃的并发 render 不能污染它。
  useLayoutEffect(() => {
    worktreeSettledRef.current = worktreeSettled;
  }, [worktreeSettled]);
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
  const {
    worktreeEnabled,
    worktreeApplicable,
    worktreeToggleDisabled,
    worktreeCreateBlocked,
    worktreeCaptionKey,
    worktreeControlCaptionKey,
    resolveWorktreeCreateErrorKey,
    isWorktreeCreateIntentCurrent,
    toggleWorktree,
    prepareWorktreeCreateIntent,
  } = useNewSessionWorktreeSync({
    selectedDeviceId,
    connectionEpoch,
    presenceVersion,
    deviceLinkStatus,
    deviceLinkStatusRef,
    creating,
    creatingRef,
    draft,
    maker,
    openLink,
    worktreeEligibility,
    worktreeHostSupportsRecoveryKeyDiscard,
    worktreeBranchPreferenceSaving,
    worktreeBranchPreferenceReady,
    worktreeBranchPreferenceReadyKeyRef,
    worktreeBranchPreferenceError,
    worktreeBranchPreferenceKey,
    worktreeBranchPreferenceSyncKey,
    worktreeBranchPreferenceSyncKeyRef,
    worktreeBranchPreferenceWriteTargetRef,
    worktreeBranchPreferenceTransactionRef,
    worktreeBranchTargetRef,
    worktreeEligibilityRef,
    worktreeSourceBranchRef,
  });
  const worktreeRowVisible = shouldShowWorktreeToggle({
    workspaceKind: draft.workspaceKind,
    workingDir: draft.workingDir,
    eligibility: worktreeEligibility,
    settled: worktreeSettled?.eligibility ?? null,
    enabled: worktreeEnabled,
  });
  // 分支区与 checkbox 是两条独立轴：OFF 时也可先选源分支；保存 checkbox 偏好在途
  // 同样不影响只读的分支枚举。只有目标尚不具备 worktree 资格或创建在途时禁用。
  const worktreeBranchDisabled = creating
    || worktreeBranchPreferenceSaving
    || worktreeEligibility.status !== 'eligible'
    || (!worktreeBranchPreferenceReady && !worktreeBranchPreferenceError);
  const worktreeBranchSheetVisible = worktreeBranchSheetOpen
    && worktreeEligibility.status === 'eligible'
    && worktreeBranchListMatchesTarget;
  // 2026-09-11: show this draft's explicit choice, otherwise the last host mirror.
  // Eligibility failures still cannot silently downgrade an enabled worktree.
  const worktreeChecked = worktreeEnabled;

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
  const createValidation = useMemo(
    () => runtimePending ? t('session.new.modelLoading') : validateNewSessionDraft(draft, draftContent),
    [draft, draftContent, runtimePending, t],
  );
  const composerHasMessage = draft.firstMessage.trim().length > 0;
  // 「按下即录」的乐观反馈(与会话页/桌面同款,详见 [sessionId].tsx 同名状态注释)。
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
    && !runtimePending
    && !creating
    && !voiceIsProcessing
    && !worktreeCreateBlocked;
  const voiceIsBusy = voiceIsListening || voiceIsProcessing;
  // 停止后 150ms 内保持录音胶囊(仍禁止操作),超过才换处理转圈:快速收尾不闪转圈。
  const voiceProcessingIndicator = useMobileVoiceProcessingIndicator(voiceState);
  // 录音计时(红点+m:ss 胶囊,与会话页/桌面同形态);pillWidth 同步驱动工具排占位。
  // counting 只认真实采集,启动链路(权限弹窗等)不计入时长,pending 期显示 0:00。
  const voiceRecordingTimer = useMobileVoiceRecordingTimer({
    expanded: voiceIsListening || voiceStartPending || voiceProcessingIndicator.stopping,
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
  const composerIncomingImageCount = pendingUploads.filter((item) => item.kind === 'image').length + pastePlaceholderCount;
  const pendingImagePreview = useComposerPendingImagePreview({ attachments, previews: attachmentPreviews, pendingUploads, getUploadedAttachmentId });
  const composerImageCount = attachments.filter((item) => item.category === 'image').length + composerIncomingImageCount;
  const { active: composerImageHoldActive, collapse: collapseComposerImages } = useComposerImageExpansion(composerImageCount, imageSelectionRevision);
  const composerCardActive = firstMessageInputFocused || composerPillOpen.opening
    || composerImageHoldActive
    || modelSheetOpen
    || permissionSheetOpen
    || voiceStartPending
    || voiceIsBusy
    || composerVoiceHoldActive;
  useComposerCardTransition(composerCardActive, keyboardState);
  // 下拉收起 = 退出聚焦激活态(模型浮窗已是独立 Modal,拖拽手势够不到它,无需在此关闭)。
  // 语音结束 hold 态未聚焦,blur 是 no-op,需显式解除 hold 才能收回简洁态。
  const handleComposerSnapToAuto = useCallback(() => {
    collapseComposerImages();
    setComposerVoiceHoldArmed(false);
    firstMessageInputRef.current?.blur();
  }, [collapseComposerImages]);
  const [composerAttachmentTrayHeight, setComposerAttachmentTrayHeight] = useState(0);
  const composerCardMaxHeight = Math.max(COMPOSER_CARD_CHROME_HEIGHT + MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT, windowDimensions.height
    - (keyboardState.visible ? keyboardState.height : safeAreaInsets.bottom)
    - safeAreaInsets.top - navigationChrome.target - spacing.xl);
  // 附件托盘与文字同在卡片里:计入 chrome,文字超出时由输入框自己滚、裁掉上方文字。
  const composerChromeHeight = (composerCardActive ? COMPOSER_CARD_CHROME_HEIGHT : COMPOSER_RESIZE_CHROME_HEIGHT)
    + composerAttachmentTrayHeight;
  const composerResize = useComposerResize({
    autoMaxContentHeight: Math.max(
      MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
      Math.min(MOBILE_COMPOSER_INPUT_MAX_HEIGHT, composerCardMaxHeight - composerChromeHeight),
    ),
    // 简洁态一律收到单行(下拉收起和点别处收键盘的结果一致);
    // auto / manual 记忆保留,重新聚焦后恢复。
    collapsed: !composerCardActive,
    composerChromeHeight,
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
  const pluginPaletteVisible = useMemo(() => detectComposerPluginTrigger(draft.firstMessage) !== null, [draft.firstMessage]);
  const composerAtQuery = composerTrigger.kind === 'at' ? composerTrigger.query : '';
  const visibleSlashCommands = useMemo(
    () => composerTrigger.kind === 'slash'
      ? filterSlashCommands(mergeMobileGoalCommand(slashCommands, t('session.common.goalMode')), composerTrigger.query, 5)
      : [],
    [composerTrigger, slashCommands, t],
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
    patchNewSessionDraft(
      {
        firstMessageRef,
        creatingRef,
        editRecoveredDraft,
        voiceDictionaryLearningTrackerRef,
        setDraft,
      },
      patch,
    );
  }, [editRecoveredDraft]);

  const openPluginPalette = useCallback(() => {
    openNewSessionPluginPalette({
      firstMessageRef,
      patchDraft,
      firstMessageSelectionRef,
      setFirstMessageSelection,
      focusComposer: () => {
        if (composerPillOpen.onCollapsedPress) composerPillOpen.onCollapsedPress();
        else requestAnimationFrame(() => firstMessageInputRef.current?.focus());
      },
    });
  }, [composerPillOpen.onCollapsedPress, patchDraft]);

  const selectComposerPlugin = useCallback((plugin: ComposerPlugin, roster: ComposerPlugin[]) => {
    const document = textComposerDocument(firstMessageRef.current);
    const next = composerDocumentProjectedText(placeComposerPlugin(document, plugin, roster));
    patchDraft({ firstMessage: next });
    const selection = { start: next.length, end: next.length };
    firstMessageSelectionRef.current = selection;
    setFirstMessageSelection(selection);
    requestAnimationFrame(() => {
      firstMessageInputRef.current?.setNativeProps({ selection });
      firstMessageInputRef.current?.focus();
    });
  }, [patchDraft]);

  const setFirstMessageDraft = useCallback((next: SetStateAction<string>) => {
    setNewSessionFirstMessage(
      {
        firstMessageRef,
        creatingRef,
        editRecoveredDraft,
        voiceDictionaryLearningTrackerRef,
        setDraft,
      },
      next,
    );
  }, [editRecoveredDraft]);

  useIncomingShareComposer({
    destination: 'new', ready: isShareTargetFocused && newSessionPreferencesLoaded && !creating,
    appendText: text => appendNewSessionSharedText({ firstMessageRef, creatingRef, editRecoveredDraft,
      voiceDictionaryLearningTrackerRef, setDraft }, text),
    attachmentCount: attachments.length,
    enqueueUploads, getPendingUploadCount, onError: setAttachmentError,
  });

  const handleFirstMessageInputContentSizeChange = useCallback((event: TextInputContentSizeChangeEvent) => {
    const nextHeight = Math.max(
      MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
      Math.ceil(event.nativeEvent.contentSize.height),
    );
    setFirstMessageInputContentHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
    ));
  }, []);

  const handleVoiceDraftTextLayout = useCallback(() => {
    const block = voiceDraftMeasuredBlockRef.current;
    const caret = voiceDraftCaretRef.current;
    if (!block || !caret) return;
    caret.measureLayout(block, (x, y) => {
      if (caret !== voiceDraftCaretRef.current || block !== voiceDraftMeasuredBlockRef.current) return;
      const nextFrame = { left: Math.max(0, Math.round(x)), top: Math.max(0, Math.round(y)) };
      setVoiceDraftCaretFrame((current) => current.left === nextFrame.left && current.top === nextFrame.top ? current : nextFrame);
    }, () => undefined);
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
    browseSeqRef.current += 1;
    // 换了电脑且用户没手动选过模型:丢掉上一台电脑自动选出的模型并重新等待,由新电脑的
    // 最近任务 / 目录 / 能力表重新落定;都拿不到时留空让用户选,不拿旧电脑的模型去创建。
    const clearAutoRuntime = option.deviceId !== selectedDeviceIdRef.current && !userTouchedRuntimeRef.current;
    if (clearAutoRuntime) {
      autoDefaultDeviceRef.current = null;
      setRuntimeSettledDeviceId(null);
    }
    // A share can arrive before the first computer is selected. Its uploads
    // are not tied to a previous host; only a real host switch invalidates them.
    const previousDeviceId = selectedDeviceIdRef.current;
    selectedDeviceIdRef.current = option.deviceId;
    setSelectedDeviceId(option.deviceId);
    setSelectedDeviceName(deviceDisplayName(option.deviceId, option.name));
    void saveNewSessionPreferences({
      device: {
        deviceId: option.deviceId,
        name: deviceDisplayName(option.deviceId, option.name),
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
    setBrowseDrives([]);
    setBrowseLoading(false);
    setBrowseError(null);
    setContextSheetOpen(false);
    clearNewSessionAttachmentsForDeviceChange({
      previousDeviceId, nextDeviceId: option.deviceId, attachments,
      getToken: () => auth.getAccessToken(), discardAllPendingUploads, releaseUploadedSources,
      setAttachments, setMediaAssetAttachments, setAttachmentPreviews, setAttachmentError,
      forgetAllAnnotations: () => composerAnnotationsRef.current?.forgetAllAttachments(),
    });
    initialWorkspaceKeyRef.current = null;
    setDraft((current) => ({
      ...current,
      ...(current.workspaceKind === 'project' ? { workingDir: '' } : {}),
      ...(clearAutoRuntime ? { model: '', providerId: null, fastMode: false } : {}),
    }));
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
  }, [availableAgentRefreshNonce, selectedDeviceId, draft.agentKind, maker, openLink]);

  // Fast 记忆延迟恢复(codex review P1):切/恢复 agent 的瞬间,目标 agent 的能力表
  // 尚未到达(或残留着切换前 agent 的),恢复点只能保守置 false;真正的恢复在这里——
  // 目标 agent 的 capabilities 就绪后,按 (agent, 来源, 模型) 记忆 + 与手动选行同款的
  // fastEditable 门控重评一次,通过才把 fastMode 打开。手动开关会写 draftMemory:
  // 用户主动关过 → 记忆为 false → 本 effect 不会重新打开;创建路径拿到的 fastMode
  // 永远已按目标 agent、来源与速度档位门控,不会发出目标不支持的速度。
  // 关闭方向(codex review P2):已开启的 fastMode 在 (provider, model) 组合失去
  // Fast 支持(provider revision 下架 / caps 撤销 hasFastMode)时必须同步关闭——
  // 否则 UI 的 rowFastEditable 已显示关、创建仍发 fastMode:true 被拒。仅能力表
  // 与目录均就绪时判定(缓存缺失/加载中不动作,避免切设备瞬间误关)。
  useEffect(() => {
    restoreNewSessionFastPreference({
      selectedDeviceId, draft, activeSourceId: activeSourceIdRef.current,
      capabilitiesKnown: getCachedAgentCapabilities(buildAgentCapabilitiesCacheKey(selectedDeviceId, draft.agentKind)) !== undefined,
      catalogReady: catalogReadyRef.current, modelRows: modelRowsRef.current,
      hasFast: () => targetAgentHasFast(selectedDeviceId, draft.agentKind),
      draftMemory, setDraft,
    });
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
  }, [selectedDeviceId, maker, openLink, availableAgentRosterRefreshNonce]);

  useEffect(() => {
    if (!selectedDeviceId) {
      rosterRecoveryIdentityRef.current = null;
      return;
    }
    const previous = rosterRecoveryIdentityRef.current;
    rosterRecoveryIdentityRef.current = { deviceId: selectedDeviceId, connectionEpoch, presenceVersion };
    if (!previous || previous.deviceId !== selectedDeviceId) return;
    if (
      previous.connectionEpoch === connectionEpoch
      && previous.presenceVersion === presenceVersion
    ) return;
    // Roster pushes are edge-triggered and are not replayed by topic rehydration.
    // Refresh both the runtime roster and the selected agent capabilities after a
    // relay/target recovery, even when the screen stayed mounted and focused.
    setAvailableAgentRefreshNonce((value) => value + 1);
    setAvailableAgentRosterRefreshNonce((value) => value + 1);
  }, [connectionEpoch, presenceVersion, selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    let cancelled = false;
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      if (cancelled) return;
      await subscribe(`new-session:${selectedDeviceId}`, selectedDeviceId, ['sessions']);
    }).catch(() => {
      /* The existing roster fetch remains fail-open; the next focus/retry can resubscribe. */
    });
    return () => {
      cancelled = true;
      void unsubscribe(`new-session:${selectedDeviceId}`, selectedDeviceId, ['sessions']).catch(() => undefined);
    };
  }, [openLink, selectedDeviceId, subscribe, unsubscribe]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    let cancelled = false;
    void withTransientRemoteRetry(async () => {
      await openLink(selectedDeviceId);
      if (cancelled) return;
      await subscribe(`new-session:${selectedDeviceId}`, selectedDeviceId, ['sessions']);
    }).catch(() => {
      /* The mount-time owner remains held; the next connection/presence change retries. */
    });
    return () => {
      cancelled = true;
    };
  }, [connectionEpoch, openLink, presenceVersion, selectedDeviceId, subscribe]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    return onAgentsChanged((deviceId) => {
      if (deviceId !== selectedDeviceId) return;
      evictAgentCapabilitiesForDevice(deviceId);
      setAvailableAgentRefreshNonce((value) => value + 1);
      setAvailableAgentRosterRefreshNonce((value) => value + 1);
    });
  }, [onAgentsChanged, selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId || composerTrigger.kind !== 'slash') {
      slashLoadSeqRef.current += 1;
      setSlashCommands([]);
      setSlashPaletteLoading(false);
      setSlashPaletteError(null);
      return;
    }
    const seq = ++slashLoadSeqRef.current;
    pendingGoalSkillRef.current = null;
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

  const loadBrowsePath = useCallback(async (
    targetPath: string,
    driveRetryAttempt = 0,
    reuse?: { seq: number; deviceId: string },
  ) => {
    const deviceId = reuse?.deviceId ?? selectedDeviceId;
    if (!deviceId || selectedDeviceIdRef.current !== deviceId) return;
    const seq = reuse?.seq ?? ++browseSeqRef.current;
    const isCurrent = () => isCurrentRemoteBrowseRequest(
      { seq, deviceId },
      { seq: browseSeqRef.current, deviceId: selectedDeviceIdRef.current },
    );
    if (!reuse) {
      setBrowseLoading(true);
      setBrowseError(null);
    }
    try {
      const result = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        return maker.fs.listDir(targetPath.trim() || '~');
      });
      if (!isCurrent()) return;
      setBrowsePath(result.resolvedPath);
      setBrowseParent(result.parent);
      setBrowseEntries(result.entries);
      setBrowseDrives(normalizeRemoteDirectoryDrives(result.drives));
      if (!reuse) setBrowseLoading(false);
      if (shouldRetryRemoteBrowseDrives(result.drivesPending, driveRetryAttempt)) {
        void loadBrowsePath(result.resolvedPath, driveRetryAttempt + 1, { seq, deviceId });
      }
    } catch (err) {
      if (!isCurrent()) return;
      // 盘符补拉失败时保留已画出的目录;只有首次读取失败才清空并报错。
      if (reuse) return;
      setBrowseEntries([]);
      setBrowseError(formatRemoteError(err));
      setBrowseLoading(false);
    }
  }, [selectedDeviceId, maker, openLink]);

  const {
    selectWorkingDir,
    rememberWorkingDirForDevice,
    chooseWorkingDir,
    selectDialogueWorkspace,
    selectRecentProject,
    openProjectBrowse,
  } = useNewSessionWorkspaceActions({
    draft,
    selectedDeviceId,
    initialWorkingDir,
    patchDraft,
    setBrowseOpen,
    setBrowseError,
    setShowHiddenDirectories,
    workingDirPreferenceOverridesRef,
    setNewSessionPreferences,
    userTouchedWorkspaceRef,
    setWorkspacePickerOpen,
    initialWorkspaceKeyRef,
    loadBrowsePath,
  });

  // 选回被控电脑自己的模型:不再在下次打开时恢复这个 agent 选过的其他电脑 / 分享来的模型。
  const forgetRemoteAgentPick = useCallback((agentKind: NewSessionAgentKind) => {
    if (!selectedDeviceId) return;
    void saveNewSessionPreferences({ remoteAgentForDevice: { deviceId: selectedDeviceId, agentKind, pick: null } });
  }, [selectedDeviceId]);

  // 选「供应商 + 模型」(provider-aware):resolveRowSelection 原子落 model + providerId +
  // effort + fast 四件套(effort 优先级与桌面同源:该来源记忆 → 沿用当前档 → 模型默认;
  // 同模型换来源不沿用当前档;fast 按 (来源, 模型) 记忆恢复,fastEditable 门控)。
  const selectProviderModelRow = useCallback((row: ProviderModelRow) => {
    userTouchedRuntimeRef.current = true; // 用户手动选了模型 → 不再自动覆盖运行配置
    runtimeActionSeqRef.current += 1; // 使在途的切 agent/恢复回调失效(最新者胜)
    setRemoteAgentChoice(null);
    forgetRemoteAgentPick(draft.agentKind);
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
    requestHostChoiceWrite(true);
    setModelSheetOpen(false);
  }, [capabilities, draft.agentKind, draftMemory, forgetRemoteAgentPick, requestHostChoiceWrite]);

  // source.deviceId 非空 = 选的是另一台电脑(或分享来的)目录里的行:Agent 在那里运行。
  const selectUnifiedModel = useCallback(async (
    config: MobileModelConfiguration,
    source?: { deviceId: string | null },
  ): Promise<boolean> => {
    if (creating || !selectedDeviceId) return false;
    const remoteDeviceId = source?.deviceId ?? null;
    const deviceAtStart = selectedDeviceId;
    const sequence = ++runtimeActionSeqRef.current;
    const targetCapabilities = normalizeMobileAgentCapabilities(await maker.getCapabilities(config.agent));
    if (!targetCapabilities) return false;
    const storedPermission = newSessionPreferences?.permissionModeByAgent[config.agent];
    const permission = config.agent === draft.agentKind ? draft.permissionMode
      : storedPermission ?? defaultPermissionModeForNewSessionAgent(config.agent);
    if (config.agent !== draft.agentKind && !await confirmFullAccessChange(draft.permissionMode, permission, {
      restoringRememberedChoice: storedPermission !== undefined,
    })) return false;
    if (deviceAtStart !== selectedDeviceRef.current || sequence !== runtimeActionSeqRef.current) return false;
    userTouchedRuntimeRef.current = true;
    const fastMode = targetCapabilities.hasFastMode === true && config.fast;
    if (remoteDeviceId) {
      // 模型与来源属于那台电脑:单独记,草稿只跟着换 Agent 与权限(权限仍在被控电脑上生效)。
      setRemoteAgentChoice({
        controlledDeviceId: deviceAtStart,
        pick: { deviceId: remoteDeviceId, agentKind: config.agent, model: config.modelId,
          providerId: config.providerId, effort: config.effort, fastMode },
      });
      setDraft(current => ({ ...current, agentKind: config.agent, permissionMode: permission }));
    } else {
      explicitProviderModelSelectionRef.current = config.modelId;
      setRemoteAgentChoice(null);
      setDraft(current => ({ ...current, agentKind: config.agent, model: config.modelId,
        providerId: config.providerId, effort: config.effort, fastMode, permissionMode: permission }));
      requestHostChoiceWrite(true);
    }
    // 选其他电脑 / 分享来的模型就记下(下次打开新建页恢复);选回被控电脑自己的就清掉。
    void saveNewSessionPreferences({
      agentKind: config.agent,
      remoteAgentForDevice: {
        deviceId: deviceAtStart,
        agentKind: config.agent,
        pick: remoteDeviceId
          ? { deviceId: remoteDeviceId, agentKind: config.agent, model: config.modelId,
            providerId: config.providerId, effort: config.effort, fastMode }
          : null,
      },
    });
    return true;
  }, [creating, selectedDeviceId, maker, newSessionPreferences, draft.agentKind, draft.permissionMode, requestHostChoiceWrite]);

  // 扁平回退(被控端 0 供应商):只落 model、清来源(默认路由),effort 跟随 capabilities reconcile。
  const selectFlatModel = useCallback((option: MobileModelOption) => {
    userTouchedRuntimeRef.current = true; // 用户手动选了模型 → 不再自动覆盖运行配置
    runtimeActionSeqRef.current += 1; // 使在途的切 agent/恢复回调失效(最新者胜)
    setRemoteAgentChoice(null);
    forgetRemoteAgentPick(draft.agentKind);
    explicitProviderModelSelectionRef.current = null;
    setDraft((current) =>
      reconcileRuntimeDraftWithCapabilities({ ...current, model: option.id, providerId: null }, capabilities));
    requestHostChoiceWrite(true);
    setModelSheetOpen(false);
  }, [capabilities, draft.agentKind, forgetRemoteAgentPick, requestHostChoiceWrite]);

  // 选中行的 effort/fast 变更:落 draft(live 真相)+ 写草稿记忆(下次选回恢复)。
  // 记忆槽的来源 id:显式选中的来源,未显式选时用当前高亮的默认来源(activeSourceIdRef)。
  const changeSelectedEffort = useCallback((effort: string) => {
    userTouchedRuntimeRef.current = true;
    setDraft((current) => {
      const pid = current.providerId ?? activeSourceIdRef.current;
      if (effort && pid) draftMemory.setEffort(current.agentKind, pid, current.model, effort);
      return { ...current, effort };
    });
    requestHostChoiceWrite(false);
  }, [draftMemory, requestHostChoiceWrite]);
  const changeSelectedFastMode = useCallback((enabled: boolean) => {
    userTouchedRuntimeRef.current = true;
    setDraft((current) => {
      const pid = current.providerId ?? activeSourceIdRef.current;
      if (pid) draftMemory.setFast(current.agentKind, pid, current.model, enabled);
      return { ...current, fastMode: enabled };
    });
    requestHostChoiceWrite(false);
  }, [draftMemory, requestHostChoiceWrite]);

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
    // 起始状态由纯函数决定(#4046):设备与目录都已选、但链路不在 online(如完全断网)
    // 时直接进 recovering 而不是停在 probing —— 下面的提前返回不会进 catch,停在
    // probing 就是永久的「检测环境中…」。
    const initialEligibility: NewSessionWorktreeEligibility = initialWorktreeProbeEligibility({
      hasDevice: Boolean(selectedDeviceId),
      hasWorkingDir: cwd.length > 0,
      online: deviceLinkStatus === 'online',
    });
    worktreeEligibilityRef.current = initialEligibility;
    setWorktreeProbe({ target, eligibility: initialEligibility });
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

  const voiceSelectionInput = {
    voiceSelectionUserOwnedRef,
    voiceRecordingActiveRef,
    voiceStopInFlightRef,
    voiceStopGestureSelectionGuardRef,
    voicePendingSelectionEchoesRef,
    firstMessageRef,
    firstMessageSelectionRef,
    setFirstMessageSelection,
    setFirstMessageDraft,
  };

  const startVoiceRecording = useCallback(async () => {
    const requestedAt = Date.now();
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
      // The capture backend owns audio-session configuration and teardown.
      // Screen-level Expo mode changes also affect remote desktop PiP.
      // Open the device link in the background: voice dictation writes into the
      // local composer via the cloud ASR proxy and does not need the mobile↔desktop
      // link (only submitting the composed message later does). Awaiting it here
      // used to add 0.6–4.4s before the mic could open.
      void openLink(selectedDeviceId).catch(() => undefined);
      const currentDraft = firstMessageRef.current;
      const initialSelection = { ...firstMessageSelectionRef.current };
      // Claim the connection prewarmed at pressIn (if any): its credential is
      // already resolved and its ASR WebSocket already connecting, so the
      // handshake overlaps the press gesture instead of following it.
      // 词典快照拉取不进 await:它只影响润色提示的丰富度,拉不到(桌面离线、老版本
      // 被控端)就用上次缓存,绝不为它推迟开麦。
      void refreshMobileVoiceDictionary(selectedDeviceId, () => maker.getVoiceDictionary());
      const prewarmedVoice = await (takePrewarmedMobileVoiceAsr(selectedDeviceId) ?? Promise.resolve(null));
      // 语音历史与词典快照只丰富润色提示,润色请求在开麦之后才构建:本地存储读取
      // 放后台,不再挡在开麦之前;读失败同样不影响录音。
      let localVoiceInputHistory: readonly string[] | undefined;
      void getMobileVoiceInputHistoryForHost(selectedDeviceId, prewarmedVoice?.credential.settings?.voiceInputHistory)
        .then((history) => { localVoiceInputHistory = history; }, () => undefined);
      void hydrateMobileVoiceDictionary(selectedDeviceId).catch(() => undefined);
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
      const audioGate = createMobileSpeakerGate();
      if (voiceStartupSeqRef.current !== startupSeq) {
        // This run never opened the microphone; release only its claimed ASR.
        void prewarmedVoice?.asr.stop().catch(() => undefined);
        return;
      }
      const selectionBefore = takeRefinementContextTail(currentDraft.slice(0, initialSelection.start));
      const selectionAfter = currentDraft.slice(initialSelection.end, initialSelection.end + 1200);
      voiceStopGestureSelectionGuardRef.current = false;
      voiceSelectionUserOwnedRef.current = false;
      voicePendingSelectionEchoesRef.current = [];
      const controller = createMobileVoiceControllerSession({
        credential,
        // "Recognize my voice": undefined unless enabled, enrolled and the models are on disk.
        audioGate,
        requestedAt,
        ...(prewarmedVoice ? { asr: prewarmedVoice.asr } : {}),
        connectionProvider: (providerId: string) => voiceContext.createAsrConnection(providerId),
        refinerTargetProvider: (providerId: string, options?: { refreshAccessToken?: boolean }) =>
          voiceContext.createRefinerTarget(providerId, options),
        refineRequestBudget: () => voiceContext.refineRequestBudget(),
        warmRefiner: (input: { system: string; user: unknown; promptCacheKey: string }) =>
          voiceContext.warmRefiner(input),
        initialDraft: currentDraft,
        initialSelection,
        refinementContext: {
          selectionBefore: selectionBefore || undefined,
          selectedText: currentDraft.slice(initialSelection.start, initialSelection.end).slice(0, 1200) || undefined,
          selectionAfter: selectionAfter || undefined,
        },
        localVoiceInputHistory: () => localVoiceInputHistory,
        readCurrentDraft: () => firstMessageRef.current,
        onDraftChanged: (text, selection, replacement) => publishNewSessionVoiceDraft(voiceSelectionInput, text, selection, replacement),
        onStateChanged: (next) => {
          // 旧 controller 的取消可晚于新启动完成,只允许本次启动交接 UI 状态。
          if (voiceStartupSeqRef.current !== startupSeq) return;
          setVoiceState(next);
        },
        onError: (message) => {
          if (voiceStartupSeqRef.current !== startupSeq) return;
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
    }
  }, [openLink, selectedDeviceId, setFirstMessageDraft, voiceIsProcessing, voiceState]);

  const finishVoiceRecording = useCallback(async (): Promise<string | null> => {
    return finishNewSessionVoiceRecording({ voiceStopInFlightRef, voiceControllerSessionRef, voiceRecordingActiveRef, voiceState, voiceStartupSeqRef, voiceStartupInFlightRef, firstMessageSelectionRef, firstMessageInputRef, setVoiceState, setVoiceError, requestAnimationFrame, formatRemoteError });
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
    warmMobileSpeakerFilter();
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
        // start() 可早于首段 PCM 返回。已有录音时由 setVoiceState 接续胶囊,
        // 只有未起录的取消/失败才在这里收回,避免 pending → idle → listening 闪烁。
        if (voiceRecordingActiveRef.current) return;
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
    };
  }, []);

  useEffect(() => {
    if (!voiceIsListening) return undefined;
    const frame = requestAnimationFrame(() => {
      firstMessageInputRef.current?.setNativeProps({ selection: firstMessageSelectionRef.current });
      voiceDraftScrollRef.current?.scrollTo({ y: voiceDraftCaretFrame.top, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerInputContentHeight, draft.firstMessage, voiceDraftCaretFrame.top, voiceIsListening]);

  useEffect(() => {
    if (voiceIsListening && draft.firstMessage.length > 0) return;
    setVoiceDraftCaretFrame({ left: 0, top: 0 });
  }, [draft.firstMessage.length, voiceIsListening]);

  const renderComposerResizeHandle = () => (
    <ComposerResizeGrabber
      onAdjust={composerResize.adjustByLine}
      panHandlers={composerResize.panHandlers}
      gesture={composerResize.gesture}
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
        ?? (worktreeBranchPreferenceSaving
            ? t('session.new.worktreeBranchSaving')
            : worktreeCreateBlocked && worktreeControlCaptionKey
              ? t(worktreeControlCaptionKey)
              : undefined)}
      accessibilityRole="button"
      accessibilityState={{
        busy: creating
          || voiceIsProcessing
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
        {collabDraft ? (
          <PlanModeChip
            disabled={creating}
            exitAccessibilityLabel={t('session.collab.draftRemove')}
            icon={<UsersRound color={colors.textPrimary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
            label={t('session.collab.draftChip')}
            onExit={() => setCollabDraft(null)}
            onPress={() => {
              openCollabDraftForm();
              setContextSheetOpen(true);
            }}
            testID="newSession.collabChip"
          />
        ) : null}
        <Pressable
          accessibilityLabel={t('session.new.modelAccessibility', { model: pillAccessibilityModel })}
          accessibilityRole="button"
          accessibilityState={{ expanded: modelSheetOpen || undefined }}
          hitSlop={10}
          onPress={toggleModelPicker}
          style={({ pressed }) => [styles.modelPill, pressed && styles.pressed]}
          testID="newSession.modelIndicator"
        >
          {remoteAgentPick ? (
            // 另一台电脑上的模型:那台目录里的来源标,带远程标记。
            remoteAgentPillProvider ? (
              <MobileModelIconMark
                color={colors.textSecondary}
                icon={getModel(remoteAgentPillProvider, remoteAgentPick.model, remoteAgentPick.agentKind)?.icon}
                name={remoteAgentPillProvider.name}
                providerId={remoteAgentPillProvider.id}
                routing={remoteAgentPillProvider.routing}
                logoKind={remoteAgentPillProvider.logoKind}
                remote
              />
            ) : null
          ) : activeSourceProvider ? (
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
          <Text style={styles.modelPillText} numberOfLines={1}>{pillModelSummary}</Text>
          {(remoteAgentPick ? remoteAgentPick.fastMode : triggerFastOn)
            ? <ModelSpeedIcon mode={(remoteAgentPick ? remoteAgentPick.fastMode : draft.fastMode) ?? false} color={colors.textTertiary} size={iconSize.sm} />
            : null}
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
  const renderComposerInputOverlay = () => voiceIsListening && Platform.OS !== 'ios' ? (
    <ScrollView
      ref={voiceDraftScrollRef}
      contentContainerStyle={[
        styles.voiceDraftOverlayContent,
        !composerCardActive && styles.voiceDraftOverlayContentGeometric,
      ]}
      onContentSizeChange={() => {
        requestAnimationFrame(() => {
          voiceDraftScrollRef.current?.scrollTo({ y: voiceDraftCaretFrame.top, animated: false });
        });
      }}
      onLayout={() => {
        requestAnimationFrame(() => {
          voiceDraftScrollRef.current?.scrollTo({ y: voiceDraftCaretFrame.top, animated: false });
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
        <View ref={voiceDraftMeasuredBlockRef} collapsable={false} style={styles.voiceDraftMeasuredBlock}>
          <Text onTextLayout={handleVoiceDraftTextLayout} style={styles.voiceDraftText}>
            {draft.firstMessage.slice(0, firstMessageSelectionRef.current.end)}
            <VoiceMicWaveCaret color={colors.textPrimary} testID="newSession.voiceMicCaret" viewRef={voiceDraftCaretRef} />
            {draft.firstMessage.slice(firstMessageSelectionRef.current.end)}
          </Text>
        </View>
      )}
    </ScrollView>
  ) : null;

  const renderComposerVoiceButton = (buttonStyle?: StyleProp<ViewStyle>) => (
    <VoicePillWidthFrame hitSlop={10} width={voiceRecordingTimer.pillWidth}>
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
          // 宽度由外框 VoicePillWidthFrame 驱动(录音胶囊展开 / 收回的过渡),按钮撑满外框。
          styles.voicePillFill,
          (creating || (voiceIsProcessing && !voiceProcessingIndicator.stopping)) && styles.disabled,
          pressed && styles.pressed,
        ]}
        testID="newSession.voiceButton"
      >
        {voiceProcessingIndicator.showProcessing ? (
          <ActivityIndicator color={colors.textSecondary} size="small" />
        ) : voiceRecordingTimer.label !== null ? (
          // 录音中:胶囊展开为脉冲红点 + 计时(对齐桌面/会话页),点胶囊任意位置停止。
          <VoiceRecordingPillContent label={voiceRecordingTimer.label} testID="newSession.voiceRecordingPill" />
        ) : (
          <Mic color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        )}
      </Pressable>
    </VoicePillWidthFrame>
  );

  // 切 agent:跟随被控电脑该 agent 的新建任务默认 → 否则该 agent 列表最上面 → 否则留空由用户选(见 pickAgentDefaultRuntime),
  // 同时 reconcile effort、来源跟随 model 同源(被控电脑默认来源校验后继承 / 首项行 provider / 兜底 null)。
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
    }).then(async (confirmed) => {
      // 被控电脑默认还在读:等读完再选模型(切换已标记手动,之后自动默认不会再补)。
      await waitHostDraftDefaults(selectedDeviceId, nextKind);
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
          hostRuntime: hostRuntimeFor(nextKind),
          modelRows: rowsNow,
          providers: deviceProvidersRef.current.providers,
          currentEffort: current.effort,
          catalogReady: catalogReadyRef.current,
          visibilityOverrides: deviceProvidersRef.current.modelVisibilityOverrides,
          flatModels: flatModelsForUnsupportedHost(selectedDeviceId, nextKind, deviceProvidersRef.current.unsupported),
        });
        const rememberedFast = next.providerId
          ? draftMemory.getFast(next.agentKind, next.providerId, next.model) ?? false
          : false;
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
            && isFastRestorable(next.agentKind, next.providerId, next.model, rowsNow, targetAgentHasFast(selectedDeviceId, next.agentKind), rememberedFast)
            ? rememberedFast
            : false,
        };
      });
    });
  }, [draft.agentKind, draft.permissionMode, deviceProviders.providers, deviceProviders.modelVisibilityOverrides, hostRuntimeFor, newSessionPreferences, selectedDeviceId, waitHostDraftDefaults]);

  // 选中的 agent 在被控端未注册(如 Pi 二进制缺失)时,coerce 到首个可用来源,避免用户停在
  // 被隐藏的选项、并防止创建出注定 requireAgent 报错的会话。仅在已拉到可用集后收敛一次。
  useEffect(() => {
    if (!availableAgentKinds) return;
    if (availableAgentKinds.has(draft.agentKind)) return;
    const fallback = NEW_SESSION_AGENT_OPTIONS.find((option) => availableAgentKinds.has(option.kind));
    if (fallback && fallback.kind !== draft.agentKind) switchAgent(fallback.kind);
  }, [availableAgentKinds, draft.agentKind, switchAgent]);

  useNewSessionInitialWorkspace({
    selectedDeviceId,
    draft,
    newSessionPreferencesLoaded,
    userTouchedDeviceRef,
    preferredDefaultDevice,
    initialWorkingDir,
    initialWorkspaceKeyRef,
    recentWorkspaces,
    newSessionPreferences,
    selectWorkingDir,
    setBrowseOpen,
    loadBrowsePath,
  });

  const selectSlashCommand = useCallback((command: MobileSlashCommand) => {
    const current = firstMessageRef.current;
    pendingGoalSkillRef.current = command.kind === 'agent-skill' ? command.name : null;
    const next = insertSlashCommand(current, detectComposerTrigger(current), command);
    if (next === current) return;
    setFirstMessageDraft(next);
    const selection = { start: next.length, end: next.length };
    firstMessageSelectionRef.current = selection;
    setFirstMessageSelection(selection);
  }, [setFirstMessageDraft]);

  const selectAtResource = useCallback((item: MobileAtResourceItem) => {
    const current = firstMessageRef.current;
    const next = insertAtResource(current, detectComposerTrigger(current), item);
    if (next === current) return;
    setFirstMessageDraft(next);
    const selection = { start: next.length, end: next.length };
    firstMessageSelectionRef.current = selection;
    setFirstMessageSelection(selection);
  }, [setFirstMessageDraft]);

  const removeAttachment = useCallback((id: string) => {
    if (!creatingRef.current) editRecoveredDraft({ removeAttachmentId: id });
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
    releaseUploadedSources([id]);
  }, [attachments, auth, editRecoveredDraft]);

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
    getAttachment: (attachmentId) => attachmentsRef.current.find((item) => item.id === attachmentId),
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
  // 单张点按即同步入队，再关闭面板；不等待鉴权或上传才占用附件槽位。
  const toggleMediaAssetAttachment = useCallback((asset: ContextSheetMediaAsset) => {
    if (mediaTapAcceptedRef.current || mediaAssetAttachments[asset.id] || uploadingMediaAssetIds.has(asset.id)) return;
    if (attachments.length + getPendingUploadCount() >= MOBILE_MAX_ATTACHMENTS) {
      setAttachmentError(t('session.common.maxAttachments', { max: MOBILE_MAX_ATTACHMENTS }));
      return;
    }
    mediaTapAcceptedRef.current = true;
    setAttachmentError(null);
    enqueueUploads([{
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
        }, 0);
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
    }], { token: auth.getAccessToken() });
    setContextSheetOpen(false);
  }, [auth, enqueueUploads, attachments.length, getPendingUploadCount, mediaAssetAttachments, uploadingMediaAssetIds, t]);
  const selectedMediaAssetIds = useMemo(() => {
    const attachmentIds = new Set(attachments.map((item) => item.id));
    return new Set(
      Object.entries(mediaAssetAttachments)
        .filter(([, attachmentId]) => attachmentIds.has(attachmentId))
        .map(([assetId]) => assetId),
    );
  }, [attachments, mediaAssetAttachments]);
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
      onPreviewPending={pendingImagePreview.open}
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
  // 每次打开允许一次添加；同步门防止收起动画期间连续点按重复入队。
  useEffect(() => {
    if (contextSheetOpen) mediaTapAcceptedRef.current = false;
  }, [contextSheetOpen]);
  // iOS 进页面就静默预取最近照片(仅已授权时),打开 + 面板即刻出图;Android 统一走系统选择器。
  useEffect(() => {
    if (contextSheetMediaLibraryEnabled) {
      void prefetchContextSheetMediaAssets('recent');
    }
  }, [contextSheetMediaLibraryEnabled]);

  // Context 面板「计划模式」入口,双路径(#494 迁移):
  //  - 新协议(capabilities.planMode.supported):本地布尔草稿态,创建会话后经
  //    maker:set-plan-mode 武装首条消息,消耗由被控端执行;不污染 draft.permissionMode。
  //  - 老被控端兼容(permissionModes 仍含 'plan'):沿用草稿 permissionMode 切换 + 创建后恢复。
  // Plan 草稿与底层权限快照由恢复入口一并回填。
  const planModeCapability = runtimeOptions.planModeSupported;
  const legacyPlanSupported = runtimeOptions.permissionOptions.some((option) => option.id === 'plan');
  const planModeSupported = planModeCapability || legacyPlanSupported;
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

  const createMessageSession = useCallback(async () => {
    if (leaveForeignOutboxRecovery()) return;
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
    // 模型仍是占位(最近任务 / 目录未到):不创建,按钮此时本就不可点,这里兜住其它提交入口。
    if (runtimePendingRef.current) return;
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
    if (!remoteAgentPick && deviceProvidersRef.current.ready && modelNeedsReselection(
      deviceProvidersRef.current.modelVisibilityOverrides, draft.agentKind, draft.model, draft.providerId,
    )) {
      setError(t('session.common.modelHiddenReselect', { model: draft.model }));
      setModelSheetOpen(true);
      return;
    }
    const worktreeIntent = prepareWorktreeCreateIntent(key => setError(t(key)));
    if (!worktreeIntent) return;
    creatingRef.current = true;
    const startedAt = Date.now();
    setCreateStartedAt(startedAt);
    setCreatePhase('preparing');
    setCreating(true);
    setError(null);
    // 乐观交接标记:startNewSessionCreation + router.replace 成功后本页即将
    // unmount,但导航过渡帧内页面仍可交互——finally 立刻复位锁会给快速双击
    // 「创建」留出重入窗口,第二次点击会用同一份草稿再预生成一个 sessionId、
    // 建出重复会话(codex review P2)。交接成功后锁保持到组件销毁;「返回编辑」
    // 回来的是新 mount,creatingRef 天然复位。
    let handedOff = false;
    const creationLeases: { precreated: (() => void) | null; durable: (() => void) | null } = { precreated: null, durable: null };
    const accountIdAtCreate = auth.user?.id?.trim() ?? '';
    const authOwnerAtCreate = getMobileAuthOwner();
    const { isCurrentOwner, worktreeAccountId } = captureNewSessionOwner(authOwnerAtCreate, accountIdAtCreate);
    try {
      if (!isCurrentOwner()) return;
      // 选了另一台电脑的模型:模型 / 来源 / 档位与 Agent 所在电脑一起落进要创建的草稿。
      let effectiveDraft = applyRemoteAgentPick(draft, remoteAgentPick);
      // ㉙ 设备守卫全程化(独立 review P1-1/P1-2):设备快照必须取自**闭包**
      // selectedDeviceId(真正会创建会话的目标设备)——selectedDeviceRef 是渲染后
      // 的最新值,若用户在渲染与点击之间切了设备,ref 已属新设备而闭包 maker/目录
      // 仍属旧设备,用它当快照会让守卫全程失明。入口立即与 ref 核对:已切走 → 放弃。
      const deviceAtCreate = selectedDeviceId;
      if (selectedDeviceRef.current !== deviceAtCreate) return;
      const ensureDeviceAlive = (): boolean => selectedDeviceRef.current === deviceAtCreate;
      // A full submission below saves the current form again, so an earlier
      // incremental write failure must not permanently block another attempt.
      await flushRecoveredDraft().catch(() => undefined);
      if (!isCurrentOwner() || !ensureDeviceAlive()) return;
      if (voiceRecordingActiveRef.current || voiceState === 'listening') {
        const latestDraftText = await finishVoiceRecording();
        if (!isCurrentOwner()) return;
        if (!ensureDeviceAlive()) return;
        if (latestDraftText === null) return;
        effectiveDraft = { ...effectiveDraft, firstMessage: latestDraftText };
      }
      // 拍照 / 选图后立刻点创建是常见路径:等在途图片上传落定(乐观托盘)。
      // 有失败就中止创建——错误文案已由上传回调写入 attachmentError,让用户处理;
      // 此时不该带着残缺附件去开新会话。等待期间离开会先确认;确认离开后在途上传随页面丢弃,同样放弃。
      setCreatePhase('uploading');
      const { failedCount, abandoned } = await waitForPendingUploads();
      // 离开确认弹窗未决时,等用户选择:选「放弃发送」就不发,选「继续等待」照常创建。
      if (abandoned || await waitForLeaveDecision()) return;
      if (!isCurrentOwner()) return;
      if (!ensureDeviceAlive()) return;
      if (failedCount > 0) return;
      setCreatePhase('preparing');
      // await 之后闭包里的 attachments 是旧值,经 ref 拿含刚落定图片的最新列表。
      const sendAttachments = attachmentsRef.current;
      const validation = validateNewSessionDraft(effectiveDraft, { attachmentCount: sendAttachments.length });
      if (validation) {
        setError(validation);
        return;
      }
      // 鉴权和模型的网络终检集中在后台建链后执行，避免表单先等一轮、管线再等一轮。
      if (!isCurrentOwner()) return;
      if (!ensureDeviceAlive()) return;
      void saveNewSessionPreferences({
        agentKind: effectiveDraft.agentKind,
        workspaceKind: effectiveDraft.workspaceKind,
        device: {
          deviceId: selectedDeviceId,
          name: deviceDisplayName(selectedDeviceId, selectedDeviceName),
        },
      });
      const creatingWorktree = worktreeIntent.applicable
        && worktreeIntent.enabled
        && worktreeIntent.eligibility.status === 'eligible';
      if (creatingWorktree || outboxRecoveryRef.current) {
        // 两步创建必须先有可归属的账号账本。不能先在工作端落盘，再发现本地
        // 无法按账号持久化 cleanup obligation。
        if (!worktreeAccountId) {
          setError(t('session.new.worktreeRecoveryStateFailed'));
          return;
        }
        const obligationOwnedByLiveTask = (sessionId: string) => (
          hasLiveNewSessionCreation(sessionId)
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
          cancelPrecreated: maker.worktree.cancelPrecreated
            ? async (_deviceId, input) => maker.worktree.cancelPrecreated!(input)
            : undefined,
          onDiscarded: completePrecreatedWorktreeRecovery,
          isSessionClaimed: async (_deviceId, pendingSessionId) => (
            isExactRemoteSessionClaimed(
              pendingSessionId,
              (id) => maker.getSession(id),
            )
          ),
          shouldDefer: (record) => (
            record.deviceId !== selectedDeviceId
            || (!creatingWorktree && record.sessionId !== outboxRecoveryRef.current?.item.sessionId)
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
        if (creatingWorktree && !isWorktreeCreateIntentCurrent(worktreeIntent)) {
          setError(t(resolveWorktreeCreateErrorKey()));
          return;
        }
      }
      // —— 乐观创建:sessionId 手机端预生成(被控端 createSession 对 provided id
      // 幂等),点创建**立即**进入会话页;openLink / 鉴权 revalidate / createSession
      // / 首条消息 enqueue 全部由 newSessionCreation 模块级后台管线完成(本页
      // unmount 不终止),失败重试面在会话页(横幅:重试 / 返回编辑)。
      // Recovery may have cancelled this creation while the editor was already open.
      const prepared = await prepareNewSessionCreation({
        effectiveDraft,
        outboxRecoveryRef,
        selectedDeviceId,
        selectedDeviceName,
        authOwnerAtCreate,
        worktreeAccountId,
        creatingWorktree,
        worktreeIntent,
        isCurrentOwner,
        ensureDeviceAlive,
        isWorktreeCreateIntentCurrent,
        runtimeOptions,
        prePlanPermissionModeRef,
        planModeCapability,
        planModeDraftOn,
        sendAttachments,
        attachmentPreviews,
        getUploadedSource,
        releaseUploadedSources,
        maker,
        t,
        setError,
        setDraft,
        resolveWorktreeCreateErrorKey,
        onHoldDurableCreation: (release) => {
          creationLeases.durable = release;
        },
        onHoldPrecreatedRegistration: (release) => {
          creationLeases.precreated = release;
        },
      });
      if (!prepared) return;
      effectiveDraft = prepared.effectiveDraft;
      const { sessionId, agentKindSnapshot, deviceIdSnapshot, firstMessageClientId,
        legacyPlanRestore, useDurableCreation, precreatedWorktree, abortIfDeviceSwitched } = prepared;
      // 提交点联合终检(Greptile/Codex review P1):目录就绪后的清理 effect 跑在渲染后,
      // 用户可能在清理生效前点创建——创建路径自身必须守卫;来源失效时 model 随之一并
      // 回退(其他来源顶替 / 首项 / 留空),并同步校准 effort、组合变化时 fastMode
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
        // Agent 在另一台电脑运行:模型属于那台的目录,不按被控电脑的目录校准(由那台在运行时核对)。
        const runGuard = () => effectiveDraft.agentDeviceId ? Promise.resolve({
          rows: [] as readonly ProviderModelRow[], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
        }) : resolveSubmitGuardCatalog({
          deferRefreshToCreation: true,
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
        const applyGuard = (g: SubmitGuardCatalog): void => {
          effectiveDraft = reconcileNewSessionSubmitDraft(effectiveDraft, g,
            () => targetAgentHasFast(guardDeviceId, effectiveDraft.agentKind), t);
        };
        // 有界稳定循环:每轮 await 返回后同步核对 genAt,稳定才退出(≤3)。
        // 哨兵初值必被首轮循环覆盖(for 循环体至少执行一次),消除 null 收窄。
        let guardResult: SubmitGuardCatalog = {
          rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
        };
        for (let pass = 0; pass < 3; pass += 1) {
          guardResult = await runGuard();
          if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
        }
        if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
          // 耗尽仍不稳定(独立 review round-22 Spec P1):不得采信最后已知 rows——
          // 显式降为 unknown/fail-open(rows 空 + catalogKnown=false,信任既有绑定)。
          guardResult = {
            rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
          };
        }
        // 循环后同步设备复核(不让出微任务):已切换则放弃,precreated ledger 保留交
        // recovery(不做 ACK 补偿,避免在循环末尾再引入可取消 await)。
        if (!ensureDeviceAlive()) return;
        applyGuard(guardResult);
      }
      startNewSessionCreation({
        startedAt,
        sessionId,
        firstMessageClientId,
        deviceId: deviceIdSnapshot,
        deviceName: selectedDeviceName,
        draft: effectiveDraft,
        attachments: sendAttachments,
        planModeArm: planModeCapability && planModeDraftOn,
        legacyPlanRestore,
        // 首个 Worker 先于 Lead 首条消息创建:把待发送的 Lead 输入作为上下文附在 Worker
        // 任务后(与桌面控制端老被控端兼容路径同口径,见 buildDraftWorkerInitialTask)。
        ...(collabDraft ? {
          orcaEnable: buildOrcaEnableOptions(
            narrowOrcaWorkerProvider(collabDraft, collabDraft.executionDeviceId
              ? (collabDraft.executionDeviceId === collabWorkerDeviceId && collabDeviceProviders.ready ? collabDeviceProviders.providers : null)
              : (deviceProviders.ready ? deviceProviders.providers : null)),
            buildDraftWorkerInitialTask(collabDraft.initialTask, effectiveDraft.firstMessage),
          ),
          collabDraft,
        } : {}),
        precreatedWorktree,
        precreatedWorktreeAccountId: worktreeAccountId,
        // stale-ready 防护(review P1):缓存判 ready/unknown 也可能已过期。管线内
        // 与建链并行 revalidate。无条件让管线自做 fresh 检查(codex review P2):
        // 表单内预检放行(新来源已连接/空响应/瞬断)后还要经历 worktree、目录
        // guard、建链、订阅多个 await,期间来源可能再变——verdict 分支若把管线
        // fresh 替换成 null 会绕过最后的联合终检。
        // Agent 在另一台电脑运行时,被控电脑上没有这个 Agent 的登录也照样能建:登录在那台。
        confirmUnauthenticated: effectiveDraft.agentDeviceId
          ? async () => ({ unauthenticated: false, fresh: null })
          : () => confirmAgentUnauthenticated(agentKindSnapshot, deviceIdSnapshot),
        // 鉴权 fresh 之后联合校验 (model, providerId)(codex review P2):建链/鉴权
        // 期间工作站可能已替换 provider——patch 覆盖本次创建,不再向已删除来源发。
        revalidateDraftAfterAuth: async (fresh) => revalidateNewSessionDraftAfterAuth(effectiveDraft, fresh,
          () => targetAgentHasFast(selectedDeviceId, effectiveDraft.agentKind), t),
        authGateHint: agentAuthGateHint(agentKindSnapshot),
        onUnauthenticated: () => evictDeviceProviders(deviceIdSnapshot),
        isCurrentOwner,
        transport: {
          maker,
          handoffFirstMessage: useDurableCreation ? async (item) => {
            if (!isCurrentOwner()) throw new Error('OUTBOX_OWNER_CHANGED');
            const record = getCurrentMobileOutboxRecords().find((r) => r.item.sessionId === sessionId && r.item.clientId === firstMessageClientId);
            if (!record) throw new Error('OUTBOX_STALE_WRITE');
            await mobileDurableOutbox.update(record, { template: item, state: 'queued', suspended: false, error: undefined });
          } : undefined,
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
      setCollabDraft(null);
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
      creationLeases.precreated?.();
      creationLeases.durable?.();
      if (!handedOff) {
        creatingRef.current = false;
        setCreating(false);
        setCreateStartedAt(null);
      }
    }
  }, [
    agentAuthVerdict,
    auth.user?.id,
    collabDraft,
    collabWorkerDeviceId,
    collabDeviceProviders.providers,
    collabDeviceProviders.ready,
    deviceProviders.ready,
    deviceProviders.providers,
    confirmAgentUnauthenticated,
    deviceLinkStatus,
    selectedDeviceId,
    selectedDeviceName,
    draft,
    remoteAgentPick,
    finishVoiceRecording,
    flushRecoveredDraft,
    leaveForeignOutboxRecovery,
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
    prepareWorktreeCreateIntent,
    isWorktreeCreateIntentCurrent,
    resolveWorktreeCreateErrorKey,
  ]);

  // 目标模式建会话(对齐桌面 handleCreateGoal):createSession → goal.set(被控端落
  // 目标消息 + 自动开跑第一轮)→ 跳转会话页。不走普通首条消息发送,目标文案即对话起点;
  // composer 附件不随目标带入(与桌面一致)。goal.set 失败后进入同一任务恢复目标表单，
  // 不重放写入、不重复创建；成功交接后保留创建锁直到页面卸载。
  const createGoalSession = useCallback(async (input: { objective: string; limits?: MobileGoalLimitsInput }) => {
    if (leaveForeignOutboxRecovery()) return;
    if (creatingRef.current || goalBusy) return;
    // 与 create() 同一道门:模型仍在等这台电脑的数据时不创建(目标表单此时也是禁用的)。
    if (runtimePendingRef.current) return;
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
    if (!remoteAgentPick && deviceProvidersRef.current.ready && modelNeedsReselection(
      deviceProvidersRef.current.modelVisibilityOverrides, draft.agentKind, draft.model, draft.providerId,
    )) {
      setGoalError(t('session.common.modelHiddenReselect', { model: draft.model }));
      setModelSheetOpen(true);
      return;
    }
    const worktreeIntent = prepareWorktreeCreateIntent(key => setGoalError(t(key)));
    if (!worktreeIntent) return;
    // ㉙ 设备守卫入口(独立 review P1-1 + busy 泄漏):快照取自闭包 selectedDeviceId,
    // 入口与 ref 核对必须发生在**加锁之前**——加锁后 return 会绕过 finally,busy
    // 状态永久泄漏(独立 review round-20 Standards P1)。
    const deviceAtCreate = selectedDeviceId;
    if (selectedDeviceRef.current !== deviceAtCreate) return;
    creatingRef.current = true;
    setCreating(true);
    setGoalBusy(true);
    setGoalError(null);
    let handedOff = false;
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
    const { isCurrentOwner, worktreeAccountId } = captureNewSessionOwner(authOwnerAtCreate, accountIdAtCreate);
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
      // Agent 在另一台电脑运行时登录在那台:不按被控电脑的登录拦(agentAuthVerdict 此时恒为 ready)。
      const freshAuth: Promise<{ unauthenticated: boolean; fresh: DeviceProvidersPayload | null }> =
        agentAuthVerdict === 'unauthenticated' || remoteAgentPick
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
          hasLiveNewSessionCreation(pendingSessionId)
          || isPrecreatedWorktreeRegistrationInFlight(pendingSessionId)
        );
        const recovery = await recoverPendingPrecreatedWorktrees(worktreeAccountId, {
          openLink,
          discardPrecreated: async (_deviceId, recoveryInput) => (
            maker.worktree.discardPrecreated(recoveryInput)
          ),
          cancelPrecreated: maker.worktree.cancelPrecreated
            ? async (_deviceId, input) => maker.worktree.cancelPrecreated!(input)
            : undefined,
          onDiscarded: completePrecreatedWorktreeRecovery,
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
          setGoalError(t(resolveWorktreeCreateErrorKey()));
          return;
        }
      }

      sessionId = createNewSessionId();
      // 选了另一台电脑的模型:与普通创建同一份覆盖(模型、来源、档位与 Agent 所在电脑)。
      let effectiveDraft = applyRemoteAgentPick(draft, remoteAgentPick);
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
            setGoalError(t(resolveWorktreeCreateErrorKey()));
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
            setGoalError(t(resolveWorktreeCreateErrorKey()));
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
          effectiveDraft = { ...effectiveDraft, workingDir: response.meta.path };
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
        workspaceKind: draft.workspaceKind,
        device: {
          deviceId: selectedDeviceId,
          name: deviceDisplayName(selectedDeviceId, selectedDeviceName),
        },
      });
      // 提交点联合终检(同 create(),代际安全版独立 review P1-1/P1-2):唯一数据源 =
      // 设备缓存 + 代际;缓存命中即当前代已确认目录;未命中且曾驱逐 → join 在途重拉
      // (await 前后核对代际);拉失败 → 未知 → 信任。started 落账后设备切换 →
      // resolveStartedDowngradeOrCommit(降级成功 return / 失败恢复 volatile 后
      // 重跑 guard 继续 commit);apply 后零 await 至 createSession。
      if (!ensureDeviceAlive()) return;
      const guardDeviceId = deviceAtCreate;
      // Agent 在另一台电脑运行:不按被控电脑的目录校准,也不按它的来源判登录(同 create())。
      const runGuard = () => effectiveDraft.agentDeviceId ? Promise.resolve({
        rows: [] as readonly ProviderModelRow[], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
      }) : resolveSubmitGuardCatalog({
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
      const applyGuard = (g: SubmitGuardCatalog): void => {
        effectiveDraft = reconcileNewSessionSubmitDraft(effectiveDraft, g,
          () => targetAgentHasFast(guardDeviceId, effectiveDraft.agentKind), t);
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
      let guardResult: SubmitGuardCatalog = {
        rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
      };
      for (let pass = 0; pass < 3; pass += 1) {
        guardResult = await runGuard();
        if (getDeviceProvidersGen(guardDeviceId) === guardResult.genAt) break;
      }
      if (getDeviceProvidersGen(guardDeviceId) !== guardResult.genAt) {
        // 耗尽仍不稳定(独立 review round-22 Spec P1):显式降为 unknown/fail-open,
        // 不采信最后已知 rows。
        guardResult = {
          rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
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
            rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
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
                rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
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
              rows: [], providers: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),
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
      // 协同草稿:goal.set 之前开启,首轮目标 Lead 才有协同工具。失败不阻断目标,
      // 任务照单任务继续,原因带到会话页提示。
      let collabEnabled = false;
      if (collabDraft) {
        try {
          await enableOrcaTeam(maker, result.sessionId, buildOrcaEnableOptions(
            narrowOrcaWorkerProvider(collabDraft, collabDraft.executionDeviceId
              ? (collabDraft.executionDeviceId === collabWorkerDeviceId && collabDeviceProviders.ready ? collabDeviceProviders.providers : null)
              : (deviceProviders.ready ? deviceProviders.providers : null)),
            buildDraftWorkerInitialTask(collabDraft.initialTask, input.objective),
          ));
          collabEnabled = true;
        } catch (collabErr) {
          rememberOrcaStartFailure(result.sessionId, describeOrcaError(collabErr, null));
        }
      }
      let goalSetError: string | null = null;
      try {
        await maker.goal.set({ sessionId: result.sessionId, objective: input.objective, ...(input.limits ? { limits: input.limits } : {}) });
      } catch (goalErr) {
        goalSetError = humanizeRemoteError(goalErr);
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
      // 协同已开启:本地兜底(getSession 失败时由创建结果合成)不带 orcaRole,写入前补上 Lead
      // 身份,不让兜底行盖掉已收到的 Lead 标记(与普通新建管线同口径)。
      if (collabEnabled && session.orcaRole !== 'lead') session = { ...session, orcaRole: 'lead' };
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
      handedOff = true;
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
            setGoalError(humanizeRemoteError(err));
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
      setGoalError(humanizeRemoteError(err));
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
      if (!handedOff) {
        creatingRef.current = false;
        setCreating(false);
        setGoalBusy(false);
      }
    }
  }, [
    agentAuthVerdict,
    auth,
    collabDraft,
    collabWorkerDeviceId,
    collabDeviceProviders.providers,
    collabDeviceProviders.ready,
    deviceProviders.ready,
    deviceProviders.providers,
    confirmAgentUnauthenticated,
    draft,
    remoteAgentPick,
    goalBusy,
    leaveForeignOutboxRecovery,
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
    prepareWorktreeCreateIntent,
    isWorktreeCreateIntentCurrent,
    resolveWorktreeCreateErrorKey,
  ]);

  const create = useCallback(async () => {
    const parsed = parseMobileDesktopCommand(firstMessageRef.current, slashCommands);
    if (parsed?.name !== 'goal' || pendingGoalSkillRef.current === 'goal') {
      await createMessageSession();
      return;
    }
    if (creatingRef.current || voiceIsBusy) return;
    if (attachmentsRef.current.length > 0 || pendingUploads.length > 0) {
      setError(t('session.screen.goalCommandAttachments'));
      return;
    }
    const command = parseGoalCommand(parsed.args);
    if (command.action === 'clear') {
      setError(t('session.new.goalCommandNeedsSession'));
      return;
    }
    setGoalError(null);
    setContextSheetView('goal');
    setContextSheetOpen(true);
    if (command.action === 'set') await createGoalSession({ objective: command.objective });
  }, [attachmentsRef, createGoalSession, createMessageSession, pendingUploads.length, slashCommands, t, voiceIsBusy]);

  const goalDraftCommand = parseMobileDesktopCommand(draft.firstMessage, slashCommands);
  const goalDraftObjective = goalDraftCommand?.name === 'goal' && pendingGoalSkillRef.current !== 'goal'
    ? goalDraftCommand.args
    : draft.firstMessage.trim();

  return (
    <SafeAreaView edges={paneLayout.persistent
      ? (composerDock.enabled ? ['top'] : ['top', 'bottom'])
      : composerDock.enabled ? ['left', 'right'] : simpleScreenSafeAreaEdges()} style={styles.safeArea} testID="newSession.screen">
      {Platform.OS === 'ios' && paneLayout.persistent ? (
        <SystemNavigationBack label={t('shared.back')} onPress={handleBack} />
      ) : Platform.OS === 'ios' ? (
        <>
          <Stack.Screen options={{ headerShown: true, headerBackVisible: false, headerShadowVisible: false, title: '', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.textPrimary }} />
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon="chevron.backward" accessibilityLabel={t('shared.back')} onPress={handleBack} />
          </Stack.Toolbar>
        </>
      ) : null}
      <ComposerKeyboardAvoidingView
        keyboard={keyboardState}
        bottomInset={safeAreaInsets.bottom}
        // The dock spacer below follows the keyboard frame by frame instead.
        enabled={!composerDock.enabled}
        behavior={keyboardAvoidingBehaviorForPlatform(
          Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        )}
        style={styles.keyboard}
      >
        <View style={[styles.screen, paneHeader && styles.paneScreen, composerDock.enabled && { paddingHorizontal: composerGeometry.horizontalInset }]}>
          {Platform.OS !== 'ios' || paneHeader || buildLabel || creating ? <View style={[styles.topBar, paneHeader && styles.paneTopBar]}>
            {paneHeader ? <NativeChromeBackButton
              label={t('shared.back')} onPress={handleBack} testID="newSession.backButton"
            /> : Platform.OS !== 'ios' ? <ScreenBackButton
              hitSlop={12}
              onPress={handleBack}
              style={styles.backButton}
              testID="newSession.backButton"
            /> : null}
            {buildLabel ? (
              <Text numberOfLines={1} style={styles.buildLabel}>{buildLabel}</Text>
            ) : null}
            {creating ? <ActivityIndicator color={colors.textSecondary} /> : null}
          </View> : null}

          <View ref={workspacePickerHostRef} collapsable={false} onLayout={measureWorkspacePicker} style={{ flex: 1 }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.bottomCluster, composerDock.enabled && { paddingBottom: 0 }]}
            onScrollBeginDrag={() => setWorkspacePickerOpen(false)}
            keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
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
              {!nativeSelectionSheet && devicePickerOpen && deviceHasChoices ? (
                <View style={styles.devicePickerPanel} testID="newSession.devicePickerPanel">
                  {deviceOptions.map((option) => {
                    const selected = option.deviceId === selectedDeviceId;
                    return (
                      <Pressable
                        accessibilityLabel={t('session.new.selectDeviceNamed', { name: deviceDisplayName(option.deviceId, option.name, deviceOptions) })}
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
                          {deviceDisplayName(option.deviceId, option.name, deviceOptions)}
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
              {deviceProviders.unsupported ? (
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
              ) : null}
              <View ref={workspacePickerAnchorRef} collapsable={false} onLayout={measureWorkspacePicker} style={styles.workspaceSelectorWrap}>
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
              ) : (
                // 开关行不显示时占住同样高度：检测结果回来后开关出现，上方选择器
                // 也不会被顶起；同时作为选择器与输入框之间的留白。
                <View style={styles.worktreeSlotPlaceholder} testID="newSession.worktreeSlot" />
              )}
            </View>

            {!nativeSelectionSheet && browseOpen ? (
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
                        onPress={() => chooseWorkingDir(workspace.workingDir)}
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
                    onPress={() => browsePath && chooseWorkingDir(browsePath)}
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
                {browseDrives.length > 0 ? (
                  <View style={styles.browseDriveRow} testID="newSession.remoteBrowseDrives">
                    <Text style={styles.browseDriveLabel}>{t('session.new.drive')}</Text>
                    <ScrollView
                      horizontal
                      contentContainerStyle={styles.browseDriveOptions}
                      keyboardShouldPersistTaps="handled"
                      showsHorizontalScrollIndicator={false}
                    >
                      {browseDrives.map((drive) => (
                        <Pressable
                          accessibilityLabel={t('session.new.switchToDrive', { name: drive.name })}
                          accessibilityRole="button"
                          accessibilityState={{ selected: drive.current, disabled: browseLoading || drive.current }}
                          disabled={browseLoading || drive.current}
                          key={drive.path}
                          onPress={() => void loadBrowsePath(drive.path)}
                          style={({ pressed }) => [
                            styles.browseDriveHit,
                            browseLoading && !drive.current && styles.disabled,
                            pressed && styles.pressed,
                          ]}
                          testID="newSession.remoteBrowseDriveOption"
                        >
                          <View style={[styles.browseActionButton, drive.current && styles.browseDriveCurrent]}>
                            <Text style={[styles.browseActionText, drive.current && styles.browseDriveCurrentText]}>
                              {drive.name}
                            </Text>
                          </View>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                ) : null}
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
                {browseError ? <ErrorNotice message={browseError} /> : null}
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
                      onSelect={() => chooseWorkingDir(item.path)}
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
              <ErrorNotice message={describeAgentAuthError(error) ?? error} />
            ) : null}
            {/* 发送前鉴权提示:选中 agent 在被控端无已连接供应商时提前告知;
                error 已展示(含被门禁拦截的同款文案)时不重复出现。 */}
            {!error && agentAuthVerdict === 'unauthenticated' ? (
              <Text style={styles.errorText} testID="newSession.agentAuthGateHint">
                {agentAuthGateHint(draft.agentKind)}
              </Text>
            ) : null}

          </ScrollView>
            <View style={[styles.composerCard, {
              maxHeight: composerCardMaxHeight,
              paddingBottom: composerDock.enabled ? 0 : spacing.md,
            }]} testID="newSession.composer">
              <PluginUiEnablePrompt deviceId={selectedDeviceId || undefined} deviceName={selectedDeviceLabel}
                online={deviceLinkStatus === 'online' && !!selectedDeviceId && getPresenceAvailability(selectedDeviceId) !== false}
                active={isShareTargetFocused && !creating} />
              <ComposerPluginPalette
                deviceId={selectedDeviceId || undefined}
                workingDir={draft.workspaceKind === 'project' ? draft.workingDir.trim() : undefined}
                draft={draft.firstMessage}
                enabled={contextSheetOpen || pluginPaletteVisible}
                visible={pluginPaletteVisible}
                disabled={creating}
                onSelect={selectComposerPlugin}
                testID="newSession.pluginPalette"
              />
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
              <SlowSendNotice startedAt={creating ? createStartedAt : null} phase={createPhase} />
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
              <View style={[styles.composerToolbarWrap, composerCardActive && {
                minHeight: COMPOSER_CARD_CHROME_HEIGHT + MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
              }]}>
                <MobileComposerInputRow
                  accessibilityLabel={t('session.new.firstMessagePlaceholder')}
                  bodyScrollGesture={composerResize.scrollGesture}
                  bodyScrollEnabled={!composerResize.dragging}
                  accessoryAbove={attachments.length > 0 || pendingUploads.length > 0 || pastePlaceholderCount > 0 ? renderComposerAttachmentTray() : null}
                  onAccessoryAboveHeightChange={setComposerAttachmentTrayHeight}
                  autoFocus={visualFocusComposer}
                  entryTransitionId={entryMorph?.id}
                  collapsedHeight={composerDock.enabled ? composerDock.pillHeight : undefined}
                  onCollapsedPress={composerPillOpen.onCollapsedPress}
                  expandToken={composerPillOpen.expandToken}
                  cardActive={composerCardActive}

                  cursorColor={colors.inputCaret}
                  inputRef={firstMessageInputRef}
                  leading={renderComposerCompactLeading()}
                  inputFrameAnimatedStyle={composerResize.frameStyle}
                    collapseProgress={composerResize.collapseProgress}
                  // 听写期间把输入区撑到 44pt 触控目标:此时「点输入区停止听写」的命中层
                  // 是这层输入区自身(TextInput 的 onPressIn),单行时只有 28pt。
                  inputFrameMinHeight={Platform.OS !== 'ios' && voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined}
                  inputOverlay={renderComposerInputOverlay()}
                  {...newSessionVoiceComposerProps({ platform: Platform.OS, voiceIsListening, firstMessage: draft.firstMessage, firstMessageSelection, composerPlaceholder, voiceStopGestureSelectionGuardRef, voicePendingSelectionEchoesRef, finishVoiceRecording })}
                  inputTestID="newSession.firstMessageInput"
                  maxHeight={composerResize.inputMaxHeight}
                  multilineShape={!composerCardActive && composerInputIsMultiline}
                  onBlur={() => {
                    setFirstMessageInputFocused(false);
                    // 失焦收起与「点别处收键盘」同语义:语音结束 hold 一并解除。
                    setComposerVoiceHoldArmed(false);
                  }}
                  onChangeText={text => changeNewSessionVoiceText(voiceSelectionInput, text)}

                  onSelectionChange={event => changeNewSessionVoiceSelection(voiceSelectionInput, event.nativeEvent.selection)}
                  onContentSizeChange={handleFirstMessageInputContentSizeChange}
                  onFocus={() => setFirstMessageInputFocused(true)}
                  onPasteImages={(uris) => void addPastedImageAttachments(uris)}
                  onPasteImagesLoading={beginPastePlaceholders}
                  onPasteImagesLoadFailed={failPastePlaceholders}

                  placeholderTextColor={colors.textPlaceholder}
                  resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}
                  scrollEnabled={composerInputScrollEnabled}

                  selectionColor={colors.inputCaret}
                  testID="newSession.actions"
                  toolbar={renderComposerToolbar()}
                  trailing={composerCardActive || !composerShowCreateButton ? null : renderCreateButton()}

                  voicePlacement={composerVoicePlacement}
                  floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}
                />
              </View>
            </View>
          {composerDock.enabled ? (
            <DockKeyboardBottomSpacer restingBottom={composerDock.restingBottom} keyboardGap={composerDock.keyboardGap} />
          ) : null}
          {/* Keep the floating panel inside its native touch bounds on Android. */}
          {!nativeSelectionSheet && workspacePickerOpen && workspacePickerFrame ? (
            <View style={[styles.workspacePickerPanel, workspacePickerFrame]} testID="newSession.workspacePickerPanel">
              <ScrollView
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator
                style={styles.workspaceProjectList}
              >
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
                <View>
                  {recentWorkspaces.map((workspace) => {
                    const selected = draft.workspaceKind === 'project'
                      && workspacePathsEqual(draft.workingDir, workspace.workingDir);
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
                </View>
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
              </ScrollView>
            </View>
          ) : null}
          </View>
        </View>
      </ComposerKeyboardAvoidingView>
      <ContextSheet
        media={contextSheetView === 'main' && contextSheetMediaLibraryEnabled ? (
            <RecentPhotosStrip
              busyAssetIds={uploadingMediaAssetIds}
              disabled={creating}
              enabled={contextSheetOpen}
              onToggleAsset={toggleMediaAssetAttachment}

              selectedAssetIds={selectedMediaAssetIds}
              testID="newSession.contextSheetPhotos"
            />
          ) : null}
        error={contextSheetView === 'main' ? attachmentError : null}
        keyboardAvoidingBehavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        onBack={contextSheetView !== 'main' ? () => setContextSheetView('main') : undefined}
        onClose={() => setContextSheetOpen(false)}
        footer={contextSheetView === 'collab' ? (
          <ContextSheetFooterButton
            disabled={!collabForm.valid || collabEntryStatus !== 'ready' || creating}
            label={t('session.collab.draftSubmit')}
            onPress={() => {
              // 与桌面新建任务一样:确认协同草稿即记住这次的 Worker 选择。
              collabForm.remember(collabForm.form);
              collabDraftTargetRef.current = collabTargetKey;
              setCollabDraft(collabForm.form);
              setContextSheetView('main');
              setContextSheetOpen(false);
            }}
            testID="newSession.collabDraftSubmit"
          />
        ) : undefined}
        testID="newSession.contextSheet"
        title={contextSheetView === 'goal'
          ? t('session.common.goalMode')
          : contextSheetView === 'collab'
            ? t('session.collab.enableTitle')
            : t('session.common.context')}
        visible={contextSheetOpen}
      >
        {contextSheetView === 'main' ? (
          <>

            <ContextSheetGroup label={Platform.OS === 'ios' && contextSheetMediaLibraryEnabled ? '' : t('session.common.groupAdd')}>
              <ContextSheetRow
                disabled={creating}
                icon={<Image color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.photo')}
                onPress={() => void addLocalImageAttachments('library')}
                dismissBeforePress
                  testID="newSession.contextSheetPhotoRow"
              />
              <ContextSheetRow
                disabled={creating}
                icon={<Camera color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.takePhoto')}
                onPress={() => void addLocalImageAttachments('camera')}
                dismissBeforePress
                  testID="newSession.contextSheetCameraRow"
              />
              <ContextSheetRow
                disabled={creating}
                icon={<Folder color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                label={t('session.common.file')}
                onPress={() => void addLocalFileAttachment()}
                dismissBeforePress
                  testID="newSession.contextSheetFileRow"
              />
            </ContextSheetGroup>
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
                  trailingSize={iconSize.md}
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
              {collabEligible ? (
                <ContextSheetRow
                  accessibilityHint={orcaCollabEntryHint(collabEntryStatus) ?? undefined}
                  disabled={creating}
                  icon={<UsersRound color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.collab.modeLabel')}
                  onPress={openCollabDraftForm}
                  testID="newSession.contextSheetCollabRow"
                  trailing={collabDraft ? (
                    <>
                      <Text style={{ color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }}>
                        {t('session.collab.enabled')}
                      </Text>
                      <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                    </>
                  ) : 'chevron'}
                />
              ) : null}
            </ContextSheetGroup>
            <ContextSheetPlugins
              disabled={creating}
              onOpen={openPluginPalette}
              testID="newSession.contextSheetPlugins"
            />
          </>
        ) : contextSheetView === 'collab' ? (
          <>
            <OrcaWorkerFormView
              agents={collabForm.agents}
              executionDevices={collabForm.executionDevices}
              executionDevicesLoading={collabForm.executionDevicesLoading}
              executionDevicesError={collabForm.executionDevicesError}
              busy={creating}
              customRoleMode={collabForm.customRoleMode}
              form={collabForm.form}
              notice={orcaCollabEntryHint(collabEntryStatus)}
              onAgentChange={collabForm.changeAgent}
              onChange={collabForm.patch}
              onCustomRoleModeChange={collabForm.setCustomRoleMode}
              onPermissionChange={(mode) => void collabForm.changePermission(mode)}
              onPickModel={collabForm.modelPicker.openPicker}
              onPickDirectory={collabForm.directoryPicker.openPicker}
            />
            {collabDraft ? (
              <ContextSheetGroup label="">
                <ContextSheetRow
                  destructive
                  icon={<X color={colors.destructive} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.collab.draftRemove')}
                  onPress={() => {
                    setCollabDraft(null);
                    setContextSheetView('main');
                  }}
                  testID="newSession.collabDraftRemove"
                />
              </ContextSheetGroup>
            ) : null}
          </>
        ) : (
          <ContextSheetGoalCreateForm
            busy={goalBusy}
            disabled={worktreeCreateBlocked || runtimePending}
            disabledHint={runtimePending
              ? t('session.new.modelLoading')
              : worktreeCreateBlocked && worktreeControlCaptionKey
                ? t(worktreeControlCaptionKey)
                : undefined}
            error={goalError}
            initial={goalDraftObjective ? { objective: goalDraftObjective } : undefined}
            onSetGoal={(input) => void createGoalSession(input)}
            testID="newSession.contextSheetGoalView"
          />
        )}
      </ContextSheet>
      <OrcaWorkerDirectoryPicker picker={collabForm.directoryPicker}
        deviceId={collabForm.form.executionDeviceId} workingDir={collabForm.form.remoteDir} mode={collabForm.form.remoteDirMode} />
      {nativeSelectionSheet ? <NewTaskSelectionSheet
        page={browseOpen ? 'directory' : devicePickerOpen ? 'device' : workspacePickerOpen ? 'workspace' : null}
        busy={creating || voiceIsProcessing}
        devices={deviceOptions}
        selectedDeviceId={selectedDeviceId}
        workspaces={recentWorkspaces}
        workspaceKind={draft.workspaceKind}
        workingDir={draft.workingDir}
        path={browsePath}
        parent={browseParent}
        drives={browseDrives}
        entries={visibleBrowseEntries}
        loading={browseLoading}
        error={browseError}
        showHidden={showHiddenDirectories}
        onClose={() => { setDevicePickerOpen(false); setWorkspacePickerOpen(false); setBrowseOpen(false); }}
        onBack={() => { setBrowseOpen(false); setWorkspacePickerOpen(true); }}
        onDevice={(id) => { const option = deviceOptions.find(device => device.deviceId === id); if (option && !deviceSelectorDisabled) selectDevice(option); }}
        onDialogue={selectDialogueWorkspace}
        onProject={selectRecentProject}
        onBrowse={openProjectBrowse}
        onEnter={(path) => void loadBrowsePath(path)}
        onChoose={chooseWorkingDir}
        onShowHidden={setShowHiddenDirectories}
      /> : null}
      <SheetModal
        backdropTestID="newSession.worktreeBranchSheet.backdrop"
        nativePresentation
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
        unified={{
          scope: JSON.stringify([auth.user?.id, selectedDeviceId]),
          agents: availableNewSessionAgentOptions(availableAgentKinds).map(option => option.kind),
          loadCapabilities: async agent => {
            const result = normalizeMobileAgentCapabilities(await maker.getCapabilities(agent));
            if (!result) throw new Error('Capabilities unavailable');
            return result;
          },
          onSelect: selectUnifiedModel,
          // 远程 Agent / 供应商分享:其他电脑开放了远程调用的供应商与别人分享给这台电脑的供应商接在
          // 后面,每个供应商一段、标题带电脑名。旧被控电脑上协同草稿与它们互斥(见 collabEligible)。
          ...(remoteAgentSupported && (!collabDraft || workerAgentLocationSupported)
            ? {
              remote: {
                catalogs: remoteAgentCatalogs,
                selectedDeviceId: remoteAgentPick?.deviceId ?? null,
                // 供应商组:组里其他电脑收进组那一项,新任务开始后由组选一台(provider-groups.md §10)。
                hostDeviceId: selectedDeviceId,
              },
            }
            : {}),
        }}
        activeModelId={remoteAgentPick?.model ?? draft.model}
        activePermissionMode={displayPermissionMode}
        agentKind={draft.agentKind}
        apiKeyStatus={deviceApiKeyStatus}
        capabilities={capabilities}
        disabled={creating}
        emptyHint={deviceProviders.error && !deviceProviders.unsupported
          ? humanizeRemoteError(deviceProviders.error)
          : selectedDeviceId ? t('session.new.noModelsAvailable') : t('session.new.selectDeviceFirst')}
        flatOptions={runtimeOptions.modelOptions}
        providersReady={deviceProviders.ready}
        providersUnsupported={deviceProviders.unsupported}
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
        selectedEffort={remoteAgentPick?.effort ?? draft.effort}
        selectedFastMode={remoteAgentPick?.fastMode ?? draft.fastMode}
        selectedProviderId={remoteAgentPick ? remoteAgentPick.providerId : draft.providerId}
        testID="newSession.modelSheet"
        visible={modelSheetOpen}
      />
      {collabEligible ? (
        // 协同首个 Worker 的模型选择:只回写协同表单,不改新任务自己的模型。
        <ModelPickerSheet
          unified={{
            currentSelection: collabForm.form.model ? {
              agentKind: collabForm.form.agent,
              activeModelId: collabForm.form.model.id,
              selectedProviderId: collabForm.form.model.providerId,
              selectedEffort: collabForm.form.model.effort ?? '',
              selectedFastMode: collabForm.form.model.fast,
            } : undefined,
            scope: JSON.stringify([auth.user?.id, collabWorkerDeviceId, 'orca-worker']),
            agents: collabForm.pickerAgents,
            loadCapabilities: async agent => {
              const result = normalizeMobileAgentCapabilities(await collabForm.maker.getCapabilities(agent));
              if (!result) throw new Error('Capabilities unavailable');
              return result;
            },
            onSelect: collabForm.modelPicker.select,
            // 远程供应商:与任务模型列表同一套，选中 = Worker 的 Agent 在那台运行。
            ...(remoteAgentSupported && collabForm.agentLocationSelectable
              ? {
                  remote: {
                    catalogs: workerAgentCatalogs,
                    selectedDeviceId: collabForm.form.agentDeviceId ?? null,
                  },
                }
              : {}),
          }}
          activeModelId={collabForm.form.model?.id ?? ''}
          activePermissionMode=""
          agentKind={collabForm.form.agent}
          apiKeyStatus={collabApiKeyStatus}
          capabilities={null}
          emptyHint={collabDeviceProviders.error && !collabDeviceProviders.unsupported
            ? humanizeRemoteError(collabDeviceProviders.error)
            : undefined}
          flatOptions={collabForm.modelPicker.flatModelOptions}
          hidePermissionTrigger
          keyboardAvoidingBehavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          loading={collabDeviceProviders.loading}
          modelVisibilityOverrides={collabDeviceProviders.modelVisibilityOverrides}
          onClose={collabForm.modelPicker.close}
          onClosed={collabForm.modelPicker.closed}
          onSelectFlatModel={collabForm.modelPicker.selectFlatModel}
          onSelectPermissionMode={() => undefined}
          onSelectProviderRow={() => undefined}
          permissionOptions={[]}
          pricing={collabModelPricing}
          providers={collabDeviceProviders.providers}
          providersReady={collabDeviceProviders.ready}
          providersUnsupported={collabDeviceProviders.unsupported}
          selectedEffort={collabForm.form.model?.effort ?? ''}
          selectedFastMode={collabForm.form.model?.fast ?? false}
          selectedProviderId={collabForm.form.model?.providerId ?? null}
          testID="newSession.collabModelSheet"
          visible={collabForm.modelPicker.open}
        />
      ) : null}
      {/* 权限模式独立浮窗:composer 权限药丸点开。两端同一语义:点选先关浮窗,关闭完成后再走
          selectPermissionMode(含 Full access 确认弹层 + per-agent 记忆)。 */}
      <NativePermissionSheet
        visible={permissionSheetOpen}
        onClose={() => setPermissionSheetOpen(false)}
        activeMode={displayPermissionMode}
        disabled={creating}
        onSelect={selectPermissionMode}
        options={runtimeOptions.permissionOptions}
        testID="newSession.permissionSheet"
      />
      {pendingImagePreview.host}
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
    <ScrollView
      style={styles.palettePanel}
      contentContainerStyle={styles.paletteContent}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      testID={testID}
    >
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
    </ScrollView>
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
  const effortLabel = effortLabelFromRuntime(runtime, draft.effort);
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
  // Match the embedded Home header: safe area + lg, then a 44pt button and md below.
  paneScreen: {
    paddingTop: spacing.lg,
  },
  paneTopBar: {
    minHeight: navigationChrome.target + spacing.md,
    paddingBottom: spacing.md,
  },
  buildLabel: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.micro,
    lineHeight: lineHeight.micro,
    marginHorizontal: spacing.md,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  backButton: {
    flexShrink: 0,
  },
  bottomCluster: {
    flexGrow: 1,
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
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.regular,
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
    // Positioned within the visible content host, outside the page ScrollView.
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xs,
    position: 'absolute',
    zIndex: 20,
  },
  workspacePickerDivider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.xs,
  },
  workspaceProjectList: {
    flexShrink: 1,
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
    lineHeight: lineHeight.body,
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
    lineHeight: lineHeight.body,
    fontWeight: fontWeight.medium,
  },
  workspaceProjectPath: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    marginTop: 1,
  },
  // 成句说明:§3「说明、提示」档 13/18 · textSecondary。
  workspaceEmptyText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
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
  worktreeSlotPlaceholder: {
    height: 44,
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
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
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
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
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
    lineHeight: lineHeight.body,
    fontWeight: fontWeight.regular,
  },
  hint: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  errorText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
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
    fontWeight: fontWeight.regular,
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
    lineHeight: lineHeight.caption,
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
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium,
  },
  browseDriveRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  browseDriveLabel: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular,
  },
  browseDriveOptions: {
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
  // 可见 pill 仍是 34pt(与「上级 / 使用当前」同档);不可见外层把热区补到 44pt。
  browseDriveHit: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  // 当前盘用实心 cta 底色(与 browseCheckboxChecked 同色),浅色 / 深色都能一眼认出。
  browseDriveCurrent: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  browseDriveCurrentText: {
    color: colors.ctaText,
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
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular,
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
  browseEntryName: { color: colors.textPrimary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  browseEntryPath: { color: colors.textTertiary, fontSize: typeScale.micro, lineHeight: lineHeight.micro, marginTop: 2 },
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
    flexShrink: 1,
    maxHeight: 220,
  },
  paletteContent: {
    gap: spacing.xs,
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
    lineHeight: lineHeight.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  paletteSecondary: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
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
  // 语音按钮撑满 VoicePillWidthFrame,宽度由外框的过渡驱动;裁剪保证展开初段
  // 红点 + 计时尚未装下时不会溢出盖住左邻控件。
  voicePillFill: { overflow: 'hidden', width: '100%' },
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
    fontSize: typeScale.footnote,
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
  // (placeholderTextColor 也是 textPlaceholder),否则一进语音态这行字会变色。
  voiceDraftListeningText: {
    color: colors.textPlaceholder,
    ...MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  },
  composerToolbarWrap: {
    flexShrink: 1,
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
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    minWidth: 0,
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
  pressed: mobileInteractionStyles.pressed,
  disabled: { opacity: 0.44 },
});
