import { isInFlightDeviceLinkError } from '@cindy/device-link';
import {
  ArrowDown,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Folder,
  Hand,
  Image,
  List,
  ListTodo,
  Menu,
  Mic,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Scan,
  Search,
  Settings,
  Square,
  Sparkles,
  Target,
  Zap,
  X,
} from 'lucide-react-native';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import {
  addScreenshotListener,
  conversationShareNativeRendererAvailable,
  renderConversationShareHtmlToPng,
} from 'xdt-screenshot-monitor';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject, type SetStateAction } from 'react';
import {
  ActivityIndicator,
  AccessibilityInfo,
  Alert,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  findNodeHandle,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type TextInputContentSizeChangeEvent,
  type TextLayoutEvent,
  type ViewStyle,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { MobileAgentMark } from '@/components/MobileAgentMark';
import type { TextInput as NativeTextInput } from 'react-native';
import { ScreenBackButton } from '@/components/MobilePrimitives';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthContext';
import { useGuardedBack } from '@/utils/useGuardedBack';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { DEVICE_LINK_API_BASE_URL, MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { ConnectionBanner, useShowConnectionBanner } from '@/components/ConnectionBanner';
import { resolveEffectiveConnectionError } from '@/components/connectionBannerVisibility';
import { PaperPlaneIcon } from '@/components/PaperPlaneIcon';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import {
  describeRemoteError,
  formatRemoteError,
  humanizeRemoteError,
  isPreconditionFailedRemoteError,
} from '@/device-link/remoteStatus';
import { agentAuthGateHint, agentAuthGateVerdict } from '@/session/agentAuthGate';
import { isTransientRemoteError, withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useRemoteSyncCoordinator, type RemoteSyncRun } from '@/device-link/remoteSyncTask';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { InteractionPanel, type MobilePlanViewerState } from '@/session/InteractionPanel';
import {
  MessageRenderer,
  type MobileMessageActionBusyKind,
  type MobileMessageDraft,
  type ShareableMessageViewport,
} from '@/session/MessageRenderer';
import {
  ConversationShareWebView,
  bundledAssetToDataUri,
  deleteConversationSharePngTemp,
  writeConversationSharePngTemp,
  type ConversationShareWebViewHandle,
} from '@/session/ConversationShareWebView';
import {
  buildConversationShareHtml,
  type ConversationShareMessage,
} from '@/session/conversationShareWebViewHtml';
import {
  collectConversationShareBlockIds,
  collectConversationShareMessages,
} from '@/session/conversationShareMessages';
import {
  isFoldableBlockExpanded,
  useFoldableExpandedBlocksSnapshot,
} from '@/session/expandedBlockMemory';
import { ShareSelectionBar } from '@/session/ShareSelectionBar';
import {
  shareSelectionStore,
  useShareSelectionActive,
  useShareSelectionCount,
  useShareSelectionRevision,
} from '@/session/shareSelectionStore';
import { ComposerRichInput, type ComposerRichInputHandle } from '@/session/ComposerRichInput';
import { InlineQueueSection } from '@/session/InlineQueueSection';
import { inputProjectionErrorI18nKey } from '@/session/inputProjectionError';
import { RewindPreviewPanel } from '@/session/RewindPreviewPanel';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { SheetModal } from '@/session/SheetModal';
import { SheetGrabber, SheetSurface } from '@/session/SheetSurface';
import { MobilePermissionPickerList } from '@/session/MobilePermissionPickerList';
import { PiSessionTreeSheet } from '@/session/PiSessionTreeSheet';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import {
  SessionMenuSheet,
  type SessionExtraDirBrowserState,
} from '@/session/SessionMenuSheet';
import type { SessionMenuView } from '@/session/sessionMenu';
import {
  interactionKind,
  isPendingInteractionCollapsed,
  pendingInteractionsBlockRemoteComposer,
  readRequestId,
  selectPendingInteractionByRequestId,
  shouldUseFullHeightPendingInteractionSurface,
} from '@/session/interactionModel';
import {
  prunePendingInteractionCollapse,
  togglePendingInteractionCollapse,
  useCollapsedPendingRequestIds,
} from '@/session/pendingInteractionCollapseStore';
import {
  buildSessionRuntimeOptions,
  normalizeMobileAgentCapabilities,
  type MobileAgentCapabilities,
  type MobileModelOption,
  type MobileSessionRuntimeOptions,
} from '@/session/agentCapabilities';
import { useDeviceProviders } from '@/device-link/useDeviceProviders';
import { useDeviceApiKeyStatus, useDeviceModelPricing } from '@/device-link/useDeviceModelMeta';
import type { DeviceApiKeyStatus } from '@/device-link/deviceModelMetaCache';
import type { MobileModelMemoryAccessors } from '@/session/draftModelMemory';
import { ModelPickerSheet } from '@/session/ModelPickerSheet';
import { MobileModelIconMark } from '@/session/MobileProviderMark';
import { getModel } from '@cindy/model-providers/registry';
import { clearSessionMirror, makeSessionMirrorAccessors } from '@/session/sessionModelMirror';
import { rowFastEditable } from '@/session/modelPickerRows';
import {
  buildMobileModelSections,
  isSelectedSourceDisconnected,
  resolveRowSelection,
  type ProviderModelRow,
} from '@/session/providerModelSections';
import {
  MOBILE_MAX_ATTACHMENTS,
  attachmentDisplayLabel,
  mergeAttachmentsWithinLimit,
} from '@/session/attachments';
import {
  ContextSheet,
  ContextSheetFooterButton,
  ContextSheetGroup,
  ContextSheetRow,
} from '@/session/ContextSheet';
import { RecentPhotosStrip, ScreenshotsGrid } from '@/session/ContextSheetMediaViews';
import { ContextSheetGoalView, goalStatusLabel } from '@/session/ContextSheetGoalView';
import { parseGoalLimitsRouteParam } from '@/session/goalLimitsRouteParam';
import { ComposerAttachmentCollapsedBadge, ComposerAttachmentTray } from '@/session/ComposerAttachmentTray';
import { PlanModeChip } from '@/session/PlanModeChip';
import { ImageLightbox } from '@/session/ImageLightbox';
import { pickWriteFields, retryPatchWhileLatest, writeGuardFields } from '@/session/swipeRowRegistry';
import {
  dismissNewSessionCreation,
  prepareNewSessionCreationForEdit,
  getNewSessionCreationTask,
  retryNewSessionCreation,
  shouldBlockSessionSync,
  stashNewSessionDraftForEdit,
  useNewSessionCreationTask,
} from '@/session/newSessionCreation';
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
  sessionCollaborationComposerReadOnlyReason,
  sessionCollaborationLabel,
  sessionCollaborationReadOnlyReason,
} from '@/session/collaboration';
import {
  agentKindForSession,
  detectComposerTrigger,
  filterAtResources,
  filterSlashCommands,
  mergeSlashCommands,
} from '@/session/composerPalette';
import { buildComposerTouchLayout } from '@/session/composerTouchLayout';
import {
  flushComposerDraftWrites,
  readComposerDocumentDraft,
  readComposerDocumentDraftSync,
  readComposerDraft,
  readComposerDraftSync,
  saveComposerDocumentDraft,
  saveComposerDraft,
} from '@/session/composerDraftStore';
import {
  appendComposerNode,
  composerDocumentsEqual,
  composerDocumentHasContent,
  composerDocumentFromEncodedMessage,
  composerDocumentProjectedText,
  composerDocumentQuotes,
  emptyComposerDocument,
  hydrateComposerMessageReferenceBodies,
  mentionComposerNode,
  migrateLegacyComposerDraft,
  normalizeComposerDocument,
  reconcileComposerProjectedText,
  replaceComposerTextRange,
  serializeComposerDocument,
  sessionLinkComposerNode,
  slashCommandTextNode,
  textComposerDocument,
  type ComposerDocument,
} from '@/session/composerDocument';
import { boundAgentReferenceText } from '@cindy/maker-shared/agent-input-projection';
import {
  appendQuote,
  clearQuotes,
  getQuotes,
  hydrateQuotes,
  resolveOrderedQuoteDraft,
  truncateQuoteText,
  useSessionQuotes,
} from '@/session/chatQuoteStore';
import { QuoteCapsule } from '@/session/QuoteCapsule';
import { formatQuotesForSend, stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { confirmFullAccessChange } from '@/session/fullAccessConfirmation';
import { confirmMobileSessionAgentSwitch } from '@/session/sessionAgentSwitchConfirmation';
import {
  mobileAgentLabel,
  normalizeSessionAgentSwitchIntent,
  sessionAgentKind as resolveSessionAgentKind,
  supportsMobileSessionAgentSwitch,
  type MobileSessionAgentKind,
} from '@/session/sessionAgentSwitch';
import {
  drainComposerAnnotationSubmissions,
  drainComposerAttachments,
  queueComposerAnnotationSubmission,
} from '@/session/composerAttachmentInbox';
import {
  buildQueuedTextMessage,
  buildQueueRowPresentation,
  createQueueEditTextState,
  queuedMessageHasEncodedQuotes,
  resolveQueueEditTextSubmission,
  stopOptionsForProjection,
  type QueueEditTextState,
} from '@/session/inputProjection';
import {
  buildPendingSendItems,
  type MobilePendingSendActions,
} from '@/session/pendingSendItems';
import type { PendingSendBubbleActions } from '@/session/PendingSendBubble';
import {
  acquireQueueEditLock,
  commitQueueEdit,
  releaseQueueEditLockAfter,
  type QueueEditLockOwner,
} from '@/session/queueEditLifecycle';
import { findErrorTailClientId, isContinuationQueueItem, resolveSessionTailBanner } from '@/session/sessionTailBannerModel';
import { SessionTailBanner } from '@/session/SessionTailBanner';
import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '@cindy/maker-shared/synthetic-trigger';
import {
  ComposerResizeGrabber,
  ComposerToolbarSpacer,
  ComposerToolbarVoiceSlot,
  MOBILE_COMPOSER_CONTROL_SIZE,
  MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
  MOBILE_COMPOSER_INPUT_MAX_HEIGHT,
  MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT,
  MOBILE_COMPOSER_MIN_TOUCH_TARGET,
  MOBILE_COMPOSER_TOOL_GAP,
  MobileComposerInputRow,
  VoiceMicWaveCaret,
  resolveMobileComposerVoiceButtonPlacement,
} from '@/session/MobileComposerInputRow';
import { VoiceRecordingPillContent, useMobileVoiceRecordingTimer } from '@/session/VoiceRecordingPill';
import { useComposerCardTransition } from '@/session/useComposerCardTransition';
import { useComposerResize } from '@/session/useComposerResize';
import { useMobileKeyboardState } from '@/session/useMobileKeyboardState';
import { buildSessionComposerLayout } from '@/session/sessionComposerLayout';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';
import { buildMobileImageAttachmentCandidate } from '@/session/mobileImageAttachment';
import { useMobileLocalAttachments } from '@/session/useMobileLocalAttachments';
import {
  buildOutboxItem,
  createOutboxClientId,
  outboxDisplayItem,
  outboxItemAttachments,
  outboxItemReady,
  outboxItemRetrying,
  outboxItemWithEnqueueFailure,
  outboxWithUploadResult,
  recoverOutboxItemsToComposerDraft,
  replaceOutboxItem,
  type MobileOutboxItem,
  type MobileRecoverableDraftItem,
} from '@/session/sessionOutbox';
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
  hasOlderMessagesAfterReopen,
  hasOlderMessagesByServerCount,
  listMessagesWithPayloadRetry,
  oldestMessageCursor,
  shouldRefreshLatestMessageWindowOnReopen,
  shouldKeepOlderMessagesAffordance,
} from '@/session/messagePaging';
import {
  HISTORY_BACKFILL_MAX_GAPS_PER_VISIT,
  HISTORY_GAP_MAX_CONSIDERED_PER_VISIT,
  HISTORY_GAP_PROBE_LIMIT,
  backfillHistoryWindowGap,
  findHistoryWindowGap,
  historyWindowGapKey,
} from '@/session/historyWindowGap';
import {
  buildMobileMessageRenderItems,
  insertMobileForkOriginItem,
  type MobileMessageRenderItem,
} from '@/session/messageRenderModel';
import { reconcileMobileMessageRenderItems } from '@/session/messageRenderReconcile';
import { shouldSuppressEmptyMessageState } from '@/session/sessionEmptyState';
import { deferScheduleIndexHydration } from '@/session/scheduleIndexDefer';
import { markSessionScheduleRunsRead, unreadRunIdFromProjection } from '@/session/scheduleRunRead';
import { useRemoteScheduleEventSnapshot } from '@/scheduler/remoteScheduleEvents';
import { buildSessionNativeShellLayout } from '@/session/mobileNativeShellLayout';
import { buildWideSessionNavLayout } from '@/session/wideSessionNav';
import { SessionListDrawer } from '@/session/SessionListDrawer';
import {
  switchDrawerSessionInPlace,
  type SessionRouteParamsNavigation,
} from '@/session/sessionDrawerNavigation';
import type { RemoteSessionListItem } from '@/session/sessionList';
import {
  findMobileMessageSearchHits,
  nextMessageSearchIndex,
  normalizeMessageSearchIndex,
  type MobileMessageSearchHit,
} from '@/session/messageSearch';
import {
  buildSearchLoadEarlierAction,
  findMobileRenderItemKeyByClientId,
} from '@/session/messageScroll';
import { countMobileRenderItemDiffs } from '@/session/messagePresentation';
import {
  buildMobileSessionMessageDeepLink,
  parseSessionDeepLinkUrl,
} from '@/session/sessionLinks';
import {
  extractMobileSessionReferences,
  prepareMobileQueuedSessionReferences,
  prepareMobileQueuedSessionReferencesForSteer,
} from '@/session/sessionReferences';
import { compactSessionMessageLabel, mobileSessionMessageDisplayText } from '@/session/sessionMessageText';
import { copyMessageText } from '@/session/messageActions';
import {
  remoteSessionStore,
  sessionMetaWriteGuard,
  sessionMetaWriteQueue,
  sessionPendingWrites,
  type RemoteSessionRunStatus,
  useRemoteSessions,
  useSessionGoalStatus,
  useSessionInputProjection,
  useSessionMessages,
  useSessionPendingInteractions,
  useSessionPendingInteractionsAuthoritative,
  useSessionRunStatus,
  useSessionMakerTurnRunning,
  useSessionRunning,
  useSessionTaskUpdates,
} from '@/session/remoteSessionStore';
import type {
  MobileGoalLimitsInput,
  MobileGoalStatusPayload,
  MobileSessionAgentSwitchIntent,
} from '@cindy/maker-shared/device-link-contract';
import {
  REMOTE_MEDIA_NEVER_EXPIRES,
  localCopyResolvedMedia,
  resolveMobileRemoteMedia,
  type MobileRemoteMediaPresignResult,
  type MobileResolvedRemoteMedia,
} from '@/session/remoteMedia';
import {
  createRemoteMediaResolveQueue,
  type RemoteMediaRequest,
  type RemoteMediaRequestOptions,
  type RemoteMediaResolveHooks,
} from '@/session/remoteMediaResolveQueue';
import { ChatFilePathContext, type ChatFilePathContextValue, type ChatFilePathTarget } from '@/session/chatFilePathContext';
import { pathDisplayName } from '@/session/chatPathCandidate';
import { fetchRemoteAbsFileToUrl } from '@/session/remoteAbsFileFetch';
import { ChatFileChipMenuSheet } from '@/session/ChatFileChipMenuSheet';
import type { ChatFileChipMenuActionKey } from '@/session/chatFileChipMenuModel';
import { mergePathIntoComposerDraft, shareMimeForFileName } from '@/session/fileBrowserActions';
import { exportRemoteFileToUrl } from '@/session/fileBrowserExport';
import { normalizeRemoteOpDirEntries, parentRelPath } from '@/session/fileBrowserGrid';
import * as Clipboard from 'expo-clipboard';
import { createRemoteMediaDiskCache, imageMimeFromUrl, type RemoteMediaDiskCache } from '@/session/remoteMediaDiskCache';
import { createExpoRemoteMediaDiskCacheIO, downloadRemoteMediaShareTemp } from '@/session/remoteMediaDiskCacheExpo';
import {
  buildRewindPreviewState,
  isCommitReadyRewindState,
  type RewindPreviewState,
} from '@/session/rewindPreview';
import { projectMobileSessionActions } from '@/session/sessionActionProjection';
import {
  buildContextUsageCreateOpts,
  canUseLocalCodexRateLimitControl,
  shouldFallbackToLegacyCodexUsage,
} from '@/session/sessionControls';
import { buildSessionOperationLayout, composerDisabledReasonI18nKey } from '@/session/sessionOperationLayout';
import { computeVanishedQueueItems, mergeSettlingItems } from '@/session/queueSettling';
import {
  summarizeSessionOverview,
  type SessionActionStripActionId,
} from '@/session/sessionOverview';
import {
  buildMobileSystemCardData,
  commandNeedsRemoteSession,
  mergeMobileLocalSlashCommands,
  parseMobileLocalSystemCommand,
} from '@/session/systemCard';
import {
  buildLearnCardData,
  buildLearnStartRequest,
  filterMobileDesktopCommands,
  parseMobileDesktopCommand,
} from '@/session/desktopSlashCommands';
import type {
  InputProjection,
  QueuedRemoteMessage,
  RemoteMessage,
  RemoteSerializedAttachment,
  RemoteSession,
} from '@/session/types';
import type {
  MobileAtResourceItem,
  MobileDesktopCommandListResult,
  MobileModelPricingMap,
  MobileSlashCommand,
  RemoteDirectoryEntry,
} from '@/device-link/mobileMakerTransport';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

const SESSION_ACTION_TEST_IDS = {
  files: 'session.filesButton',
  queue: 'session.queueButton',
  search: 'session.searchToggleButton',
  settings: 'session.controlsToggle',
  usage: 'session.usageButton',
} satisfies Record<SessionActionStripActionId, string>;
const COMPOSER_CONTROL_HIT_SLOP = { bottom: 8, left: 8, right: 8, top: 8 };
const COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT = MOBILE_COMPOSER_INPUT_SINGLE_LINE_HEIGHT;
const COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD = 34;
const COMPOSER_INPUT_LINE_HEIGHT = MOBILE_COMPOSER_INPUT_LINE_HEIGHT;
const COMPOSER_INPUT_MAX_CONTENT_HEIGHT = MOBILE_COMPOSER_INPUT_MAX_HEIGHT;
const COMPOSER_VERTICAL_PADDING_HEIGHT = 12;
const COMPOSER_STATUS_ROW_RESERVED_HEIGHT = 28;
const COMPOSER_STACK_GAP_HEIGHT = 4;
const COMPOSER_INPUT_ROW_CHROME_HEIGHT = 22;
// 聚焦卡片形态的 row chrome:paddingTop 26 + paddingBottom 8 + 层间 gap 8 + 工具排 ~36。
const COMPOSER_CARD_ROW_CHROME_HEIGHT = 78;
const COMPOSER_VOICE_CARET_GAP = 2;
// 重开且检测到有新内容时,只拉最新小窗对账(比首开整窗 80 便宜很多);payload 过大再逐档退。
const REOPEN_MESSAGE_WINDOW_LIMITS = [20, 10, 5, 1] as const;
// session-tail-banner「重试」短窗口隐藏的超时兜底(接管信号全部丢失时恢复错误入口);
// 覆盖 settling 窗口上限(10s)之后仍无任何在途证据的场景。
const TAIL_RETRY_HIDE_TIMEOUT_MS = 15_000;
const SCREENSHOT_SHARE_ACTIVATION_DEBOUNCE_MS = 1_200;

// 分享图页脚资源转成 data URI 后再交给 WebView，避免 foreignObject 导出空白。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareCharacterAsset = require('../../assets/share/cindy-share-character.jpg');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareLogoLightAsset = require('../../assets/login/login-wordmark.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareLogoDarkAsset = require('../../assets/login/login-wordmark-dark.png');

/**
 * 排队消息「复用 composer 编辑」的会话内状态:clientId 定位队列条目,
 * stashed* 暂存进入编辑前用户的草稿与附件托盘(保存/放弃/条目消失时恢复)。
 */
interface QueueEditingState {
  clientId: string;
  stashedDraft: string;
  stashedDocument: ComposerDocument;
  stashedAttachments: RemoteSerializedAttachment[];
  textState: QueueEditTextState;
}

interface ComposerRuntimeSummary {
  modelSummary: string;
  permissionLabel: string;
  permissionMode: string;
}

function buildComposerRuntimeSummary(
  session: RemoteSession,
  runtime: MobileSessionRuntimeOptions,
): ComposerRuntimeSummary {
  const modelLabel = runtime.currentModel?.label ?? session.model;
  const effortLabel = choiceLabel(runtime.effortOptions, session.effort);
  return {
    modelSummary: [modelLabel, effortLabel].filter(Boolean).join(' · '),
    permissionLabel: choiceLabel(runtime.permissionOptions, session.permissionMode),
    permissionMode: session.permissionMode,
  };
}

function choiceLabel(options: readonly { id: string; label: string }[], value: string | null | undefined): string {
  if (!value) return '';
  return options.find((option) => option.id === value)?.label ?? value;
}

function measureViewInWindow(view: View | null): Promise<{
  height: number;
  width: number;
  x: number;
  y: number;
} | null> {
  return new Promise((resolve) => {
    if (!view) {
      resolve(null);
      return;
    }
    view.measureInWindow((x, y, width, height) => {
      if (![x, y, width, height].every(Number.isFinite)) {
        resolve(null);
        return;
      }
      resolve({ height, width, x, y });
    });
  });
}

/** 会话已读回执的驻留门槛:聚焦本会话且消息已渲染后停满这段时间才算「真实看到」。 */
const SESSION_READ_ACK_DWELL_MS = 1_200;

/** 旧被控端没有 update-content 通道时的降级判定(与 mobileVoiceInput 同款字符串匹配)。 */
function isChannelNotAllowedError(err: unknown): boolean {
  const formatted = formatRemoteError(err);
  return formatted.includes('CHANNEL_NOT_ALLOWED') || formatted.includes('DEVICE_LINK_CHANNEL_NOT_ALLOWED');
}

/**
 * enqueue 可自动重试的瞬时传输错误。NOT_CONNECTED **不保证请求未送达**:多数来自发送前的本地拒绝
 * (未连接 / 有界等待超时),但断连瞬间 in-flight 的 invoke 也会被 failAllPending
 * 批量 reject 成 NOT_CONNECTED——请求可能已出、只是 ack 丢了。因此命中它只代表
 * 「值得评估自动重试」,仍必须同时通过 inFlight 守卫。BACKPRESSURE 要么发生在本地
 * 发送前,要么是被控端 admission 明确拒绝执行,可直接进入同一退避重试路径。
 */
function isRetryableEnqueueTransportError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'NOT_CONNECTED' || code === 'BACKPRESSURE') return true;
  const formatted = formatRemoteError(err);
  return (
    formatted.includes('[NOT_CONNECTED]')
    || formatted.includes('[DEVICE_LINK_NOT_CONNECTED]')
    || formatted.includes('[BACKPRESSURE]')
  );
}

/** enqueue 对可安全重发的瞬时传输错误做有界退避。 */
const ENQUEUE_RECONNECT_RETRIES = 3;
const ENQUEUE_RECONNECT_BACKOFF_MS = 300;

/**
 * composer 活动条(「思考中 · 0s · N tokens」)的下降沿去抖窗口。
 *
 * 运行信号由 sending / 队列可停 / 远端 run status / turn streaming 四路拼成,交接时会
 * 漏出一两帧「都不为真」的空隙(实测新建会话日志 streaming 1→0→1),活动条会在那里
 * 闪一下、计时还被重置回 0s。真停了推迟这点时间熄灭无感,交接空隙则被吃掉。
 */
const COMPOSER_ACTIVITY_SETTLE_MS = 600;

/** 落定集合 / 基线的空值(模块级常量:引用稳定,不让 memo 每帧失效)。 */
const EMPTY_SETTLING_ITEMS: readonly QueuedRemoteMessage[] = [];
const EMPTY_SETTLING_BASELINE: {
  sessionId: string;
  queue: readonly QueuedRemoteMessage[];
  steeringSource: readonly string[];
  steeringClientIds: ReadonlySet<string>;
} = { sessionId: '', queue: [], steeringSource: [], steeringClientIds: new Set() };

/**
 * 「这个会话在被控端还不存在」——所有**需要远端会话**的入口共用的唯一判据。
 *
 * 新建乐观管线的合成会话行在 create 成功前带 `pendingLocalCreation`,此刻任何以
 * sessionId 打过去的 RPC 都会失败。三类入口都要看它(review 收敛检查点:这个语义
 * 原先只在会话设置那一处写了,slash 命令那条路漏了,于是创建窗口内发 `/context`
 * 会消费掉草稿再糊一张错误卡):
 *  - 消息派发:由 outboxDispatchBlockedNow 复合(它还要求字段权威、管线已收口);
 *  - 会话设置类 RPC(model / effort / fast / permission / plan);
 *  - 需要远端的 slash 命令(/context 取用量、/learn 打蒸馏)。
 *
 * 行不存在也算「不存在」:那种状态下这些 RPC 同样无处可去。
 */
function isRemoteSessionMissing(row: RemoteSession | null | undefined): boolean {
  return !row || row.pendingLocalCreation === true;
}

/** 恢复进「只有一个输入框」的新建页时,气泡文本要剥掉产品私有 marker。 */
function outboxItemDraftText(item: MobileOutboxItem): string {
  return (item.quotesEncoded ? stripChatQuoteMarkerLines(item.text) : item.text).trim();
}

/** 编辑保存的降级判定:附件集合(按 id,顺序不敏感)未变时可退回 update-text。 */
function attachmentIdSetsEqual(
  a: readonly { id: string }[] | undefined,
  b: readonly { id: string }[] | undefined,
): boolean {
  const idsA = (a ?? []).map((item) => item.id).sort();
  const idsB = (b ?? []).map((item) => item.id).sort();
  return idsA.length === idsB.length && idsA.every((id, index) => id === idsB[index]);
}

/**
 * 将无法继续派发的 outbox 条目按会话恢复为可见草稿 + 引用 store。
 * marker-bearing body 只留作未编辑重发的隐藏顺序基线，绝不写进输入框。
 */
function restoreOutboxItemsToDraft(items: readonly MobileOutboxItem[]): void {
  const itemsBySession = new Map<string, MobileOutboxItem[]>();
  for (const item of items) {
    const sessionItems = itemsBySession.get(item.sessionId) ?? [];
    sessionItems.push(item);
    itemsBySession.set(item.sessionId, sessionItems);
  }
  for (const [draftSessionId, sessionItems] of itemsBySession) {
    restoreRecoverableItemsToDraft(draftSessionId, sessionItems);
  }
}

/**
 * 把一组待发条目按给定顺序合并回某个会话的草稿。
 *
 * 显式收 sessionId(而不是从条目上读)是为了让**不属于 outbox 的消息**也能参与同一次
 * 合并:新建会话 enqueue 失败时,首条消息来自 creationTask.draft,必须排在创建期间攒下
 * 的后续消息前面,否则用户无法恢复原始顺序(重试后续会超到首条前面)。
 */
function restoreRecoverableItemsToDraft(
  draftSessionId: string,
  sessionItems: readonly MobileRecoverableDraftItem[],
): void {
  {
    const existingVisibleText = readComposerDraftSync(draftSessionId)?.trim() ?? '';
    const existingQuotes = [...getQuotes(draftSessionId)];
    const existingOrderedDraft = resolveOrderedQuoteDraft(
      draftSessionId,
      existingVisibleText,
      existingQuotes,
    );
    const existingDocument = readComposerDocumentDraftSync(draftSessionId)
      ?? migrateLegacyComposerDraft(existingVisibleText, existingQuotes, existingOrderedDraft?.encodedBody);
    const existingEncodedBody = serializeComposerDocument(existingDocument).text;
    const recovery = recoverOutboxItemsToComposerDraft(sessionItems, {
      visibleText: existingVisibleText,
      encodedBody: existingEncodedBody,
      quotes: existingQuotes,
      document: existingDocument,
    });
    if (recovery.visibleText || recovery.quotes.length > 0) {
      saveComposerDraft(draftSessionId, recovery.visibleText);
      saveComposerDocumentDraft(
        draftSessionId,
        recovery.document,
      );
      clearQuotes(draftSessionId);
    }
  }
}

interface ImmediateComposerDraftScope {
  document: ComposerDocument;
  ordered: ReturnType<typeof resolveOrderedQuoteDraft>;
  quotes: ReturnType<typeof getQuotes>;
}

/**
 * 当前任务首帧可同步取得的 composer 真相。AsyncStorage 尚未 hydrate 时宁可返回
 * 当前任务空态，也不能让复用的 SessionScreen 把上一任务文档交给新任务编辑器。
 */
function readImmediateComposerDraftScope(
  sessionId: string,
  routeDraft: string | null,
): ImmediateComposerDraftScope {
  const visibleText = readComposerDraftSync(sessionId) ?? routeDraft ?? '';
  const quotes = getQuotes(sessionId);
  const ordered = resolveOrderedQuoteDraft(sessionId, visibleText, quotes);
  const storedDocument = readComposerDocumentDraftSync(sessionId);
  let document = storedDocument
    ?? migrateLegacyComposerDraft(visibleText, quotes, ordered?.encodedBody);
  if (storedDocument) {
    for (const quote of quotes) {
      document = appendComposerNode(document, { type: 'quote', quote });
    }
  }
  return { document, ordered, quotes };
}

function composerDraftScopeKey(sessionId: string, routeDraft: string | null): string {
  return JSON.stringify([sessionId, routeDraft ?? '']);
}

export default function SessionScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors, mode } = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  const params = useLocalSearchParams<{
    sessionId: string;
    deviceId?: string;
    deviceName?: string;
    draft?: string;
    goalError?: string;
    goalObjective?: string;
    goalLimits?: string;
    focusClientId?: string;
    focusComposerRequestKey?: string;
    focusRequestKey?: string;
    visualFocusComposer?: string;
    visualOpenSearch?: string;
    visualSearchQuery?: string;
  }>();
  const sessionId = readRouteParam(params.sessionId) ?? '';
  const shareSelectionActive = useShareSelectionActive(sessionId);
  const shareSelectionCount = useShareSelectionCount();
  const shareSelectionRevision = useShareSelectionRevision();
  const deviceId = readRouteParam(params.deviceId) ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  // 回撤 preview/commit 的「请求代际」。每次发起 +1、每次切 session 也 +1(见下方 reset effect),
  // 异步返回后代际已变则丢弃。比只比较 sessionId 更严谨:仅比 sessionId 无法失效「A 发起 → 切到 B →
  // 请求返回前又切回 A」期间的 stale 请求(切回后 sessionId 再次相等会误放行,导致确认框在 A 复活或
  // 覆盖切回后新发起的预览);代际每次 session 变化都递增,能正确作废这类请求,也能让同一 session 内
  // 新发起的请求作废旧请求。
  const rewindRequestSeqRef = useRef(0);
  const deviceName = readRouteParam(params.deviceName) ?? deviceId;
  const routeDraft = readRouteParam(params.draft);
  const routeFocusClientId = readRouteParam(params.focusClientId);
  const routeFocusComposerRequestKey = readRouteParam(params.focusComposerRequestKey);
  const routeFocusRequestKey = readRouteParam(params.focusRequestKey);
  const visualFocusComposer = MOBILE_VISUAL_MOCK_ENABLED && readRouteParam(params.visualFocusComposer) === '1';
  const visualOpenSearch = MOBILE_VISUAL_MOCK_ENABLED && readRouteParam(params.visualOpenSearch) === '1';
  const visualSearchQuery = MOBILE_VISUAL_MOCK_ENABLED ? readRouteParam(params.visualSearchQuery) : null;
  const navigation = useNavigation<SessionRouteParamsNavigation & { isFocused(): boolean }>();
  const router = useRouter();
  const auth = useAuth();
  const windowDimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardState = useMobileKeyboardState();
  const {
    connectionEpoch,
    connectionIssue,
    invoke,
    lastPresenceSnapshot,
    openLink,
    status,
    subscribe,
    unsubscribe,
  } = useDeviceLink();
  const revokedDevices = useRevokedDevices();
  const unresponsiveDevices = useUnresponsiveDevices();
  const maker = useMobileMakerTransport(deviceId);
  const sessions = useRemoteSessions();
  const messages = useSessionMessages(sessionId, deviceId);
  const pending = useSessionPendingInteractions(sessionId);
  // pending 列表是否已被被控端的全量快照确认过(空列表能不能当「都处理完了」用)。
  const pendingInteractionsAuthoritative = useSessionPendingInteractionsAuthoritative(sessionId);
  const inputProjection = useSessionInputProjection(sessionId);
  const remoteSessionRunning = useSessionRunning(sessionId);
  const makerTurnRunning = useSessionMakerTurnRunning(sessionId);
  const remoteSessionRunStatus = useSessionRunStatus(sessionId);
  const taskUpdates = useSessionTaskUpdates(sessionId);
  const activeComposerDraftScopeKey = composerDraftScopeKey(sessionId, routeDraft);
  const [composerDraftStateKey, setComposerDraftStateKey] = useState(activeComposerDraftScopeKey);
  const [composerDocument, setComposerDocumentState] = useState<ComposerDocument>(
    () => readImmediateComposerDraftScope(sessionId, routeDraft).document,
  );
  const [draft, setDraft] = useState(() => composerDocumentProjectedText(composerDocument));
  const [composerDraftHydrated, setComposerDraftHydrated] = useState(false);
  const appliedRouteDraftRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  const composerDocumentRef = useRef<ComposerDocument>(composerDocument);
  // replaceParams 复用同一 SessionScreen。任务参数变化的这次 render 仍拿着 A 的
  // state；若直接让 key={sessionId} 子树挂载，B 编辑器会先用 A 文档初始化，再等
  // 被动 effect 水合纠正。沿本页 read-ack 的 render-phase 换代模式同步种入 B 的
  // 内存快照（冷缓存未 hydrate 时为空），React 会丢弃本次旧输出后重渲。
  if (composerDraftStateKey !== activeComposerDraftScopeKey) {
    const nextScope = readImmediateComposerDraftScope(sessionId, routeDraft);
    const nextDraft = composerDocumentProjectedText(nextScope.document);
    setComposerDraftStateKey(activeComposerDraftScopeKey);
    setComposerDocumentState(nextScope.document);
    setDraft(nextDraft);
    setComposerDraftHydrated(false);
    // 旧 A 的 AsyncStorage promise 可能在 effect cleanup 前落定；先让它的 key 失配。
    // 保持 null 也确保 B 的 effect 仍会继续异步 hydrate 磁盘草稿与冷启动引用。
    appliedRouteDraftRef.current = null;
    composerDocumentRef.current = nextScope.document;
    draftRef.current = nextDraft;
  }
  const conversationShareWebViewRef = useRef<ConversationShareWebViewHandle | null>(null);
  const topOverlayRef = useRef<View>(null);
  const bottomOverlayRef = useRef<View>(null);
  const visibleShareableMessageIdsReaderRef = useRef<(
    (viewport: ShareableMessageViewport) => Promise<readonly string[]>
  ) | null>(null);
  const screenshotBlockedByOverlayRef = useRef(false);
  const [messageBlockingOverlay, setMessageBlockingOverlay] = useState(false);
  const shareSelectionActiveRef = useRef(shareSelectionActive);
  shareSelectionActiveRef.current = shareSelectionActive;
  const shareSelectionRevisionRef = useRef(shareSelectionRevision);
  shareSelectionRevisionRef.current = shareSelectionRevision;
  const lastScreenshotActivationAtRef = useRef(0);
  const shareOperationSeqRef = useRef(0);
  const [conversationShareBusy, setConversationShareBusy] = useState(false);
  const [shareSelectionTriggeredByScreenshot, setShareSelectionTriggeredByScreenshot] = useState(false);
  const [shareCharacterSrc, setShareCharacterSrc] = useState<string | null>(null);
  const [shareLogoSrc, setShareLogoSrc] = useState<string | null>(null);
  const shareLogoModeRef = useRef<string | null>(null);
  // chat-text-quote:待随下一条消息发送的选中文字引用(全局 store,消息流选区
  // 按钮 / 文件预览页写入;发送时拼进正文,命中本地命令时保留)。
  const quotes = useSessionQuotes(sessionId);
  // 采集回调必须 memoize:内联箭头每次渲染换新引用,会让 MessageRenderer 的
  // SelectionQuoteContext value 重建,FlatList 里所有可见 MarkdownSelectableText
  // 跟着重渲(打字等无关 state 变化都触发),长转录会话开销明显(review P2)。
  const handleQuoteSelection = useCallback((quote: { text: string }) => {
    appendQuote(sessionId, { text: truncateQuoteText(quote.text) });
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [sessionId]);
  const handleVisibleShareableMessageIdsReaderChange = useCallback((
    reader: ((viewport: ShareableMessageViewport) => Promise<readonly string[]>) | null,
  ) => {
    visibleShareableMessageIdsReaderRef.current = reader;
  }, []);
  const handleMessageBlockingOverlayChange = useCallback((blocked: boolean) => {
    setMessageBlockingOverlay(blocked);
  }, []);
  useEffect(() => {
    shareOperationSeqRef.current += 1;
    lastScreenshotActivationAtRef.current = 0;
    setConversationShareBusy(false);
    setShareSelectionTriggeredByScreenshot(false);
    shareSelectionStore.exitIfNotSession(sessionId);
    return () => {
      shareOperationSeqRef.current += 1;
      if (shareSelectionStore.getActiveSessionId() === sessionId) shareSelectionStore.exit();
    };
  }, [sessionId]);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'ios' || !sessionId) return undefined;
      let cancelled = false;
      const subscription = addScreenshotListener(() => {
        if (
          AppState.currentState !== 'active'
          || shareSelectionActiveRef.current
          || screenshotBlockedByOverlayRef.current
        ) return;
        const now = Date.now();
        if (now - lastScreenshotActivationAtRef.current < SCREENSHOT_SHARE_ACTIVATION_DEBOUNCE_MS) return;
        lastScreenshotActivationAtRef.current = now;
        void (async () => {
          const [topOverlayFrame, bottomOverlayFrame] = await Promise.all([
            measureViewInWindow(topOverlayRef.current),
            measureViewInWindow(bottomOverlayRef.current),
          ]);
          if (
            cancelled
            || AppState.currentState !== 'active'
            || shareSelectionActiveRef.current
            || screenshotBlockedByOverlayRef.current
          ) return;
          const reader = visibleShareableMessageIdsReaderRef.current;
          if (!topOverlayFrame || !bottomOverlayFrame || !reader) return;
          const measuredClientIds = await reader({
            visibleBottom: bottomOverlayFrame.y,
            visibleTop: topOverlayFrame.y + topOverlayFrame.height,
          });
          if (
            cancelled
            || AppState.currentState !== 'active'
            || shareSelectionActiveRef.current
            || screenshotBlockedByOverlayRef.current
          ) return;
          const visibleClientIds = [...new Set(measuredClientIds)];
          if (visibleClientIds.length === 0) return;
          Keyboard.dismiss();
          setShareSelectionTriggeredByScreenshot(true);
          shareSelectionStore.enter(sessionId);
          shareSelectionStore.setSelection(visibleClientIds);
        })();
      });
      return () => {
        cancelled = true;
        subscription?.remove();
      };
    }, [sessionId]),
  );
  useEffect(() => {
    if (!shareSelectionActive) return undefined;
    let cancelled = false;
    const logoNeedsLoad = shareLogoModeRef.current !== mode || !shareLogoSrc;
    void Promise.all([
      shareCharacterSrc
        ? Promise.resolve(shareCharacterSrc)
        : bundledAssetToDataUri(shareCharacterAsset, 'image/jpeg'),
      logoNeedsLoad
        ? bundledAssetToDataUri(
            mode === 'dark' ? shareLogoDarkAsset : shareLogoLightAsset,
            'image/png',
          )
        : Promise.resolve(shareLogoSrc),
    ]).then(([character, logo]) => {
      if (cancelled) return;
      shareLogoModeRef.current = mode;
      setShareCharacterSrc(character);
      setShareLogoSrc(logo);
    });
    return () => { cancelled = true; };
  }, [mode, shareCharacterSrc, shareLogoSrc, shareSelectionActive]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerInputContentHeight, setComposerInputContentHeight] = useState(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT);
  const [voiceDraftCaretFrame, setVoiceDraftCaretFrame] = useState({ left: 0, top: 0 });
  // Context 面板(+ 号弹出的可拖动 sheet):open + 面板内子视图(主视图 / 截图列表 / 目标模式)。
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const [contextSheetView, setContextSheetView] = useState<'main' | 'screenshots' | 'goal'>('main');
  // 模型 + 权限浮窗(ContextSheet 同款 Modal,含二级「模型选项 / 权限」叠层)。
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // 权限模式独立浮窗(composer 左侧图标钮点开,与模型浮窗同属 composer 激活态)。
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);
  const [permissionSheetSnap, setPermissionSheetSnap] = useState<ContextSheetSnap>('half');
  const permissionSheetHeights = useMemo(
    () => computeContextSheetSnapHeights({
      safeAreaTopInset: insets.top,
      screenHeight: windowDimensions.height,
    }),
    [insets.top, windowDimensions.height],
  );
  // 已建会话的模型浮窗可先浏览另一 Agent；只改此浏览态不触碰会话，选模型才登记 intent。
  const [modelSheetAgentKind, setModelSheetAgentKind] = useState<MobileSessionAgentKind>('claude-code');
  const [attachments, setAttachments] = useState<RemoteSerializedAttachment[]>([]);
  // send() 里 await 在途图片上传后闭包里的 attachments 已是旧值,经 ref 读最新列表。
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 相册资产 → 已上传附件 id 的映射(缩略图勾选态真相);发送/清空附件时一并重置。
  const [mediaAssetAttachments, setMediaAssetAttachments] = useState<Record<string, string>>({});
  // 待选相册资产(按选中顺序;Cursor 式两段提交,底部「加入对话」统一上传)。
  const [pendingMediaAssets, setPendingMediaAssets] = useState<ContextSheetMediaAsset[]>([]);
  // 本机图片附件的本地预览 uri(attachmentId → file://),composer 托盘缩略图 / 全图查看用。
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  // composer 托盘里正被全屏查看的图片附件 id(null = 关闭)。
  const [composerPreviewAttachmentId, setComposerPreviewAttachmentId] = useState<string | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  // 新建页 goal.set 失败接回时经路由参数带入(见 new.tsx 创建流程);
  // 平时无参 → null,与旧行为一致。
  const [goalError, setGoalError] = useState<string | null>(() => readRouteParam(params.goalError));
  // 新建页 goal.set 失败接回时经路由参数带入的完整 Goal 输入(codex review P2):
  // objective 原样、limits 经 parseGoalLimitsRouteParam 严格解析(坏参数忽略整个
  // limits,不改写为 null——改写会让 limitsTouched=true 显式提交「全部无限」覆盖
  // 被控端默认;独立审核者 P2)。平时无参 → null,与旧行为一致(表单仍从 composer
  // 文字初始化)。
  const [goalRestore, setGoalRestore] = useState<{ sessionId: string; objective: string; limits?: MobileGoalLimitsInput } | null>(() => {
    const objective = readRouteParam(params.goalObjective);
    if (!objective) return null;
    const limits = parseGoalLimitsRouteParam(readRouteParam(params.goalLimits));
    return { sessionId: readRouteParam(params.sessionId) ?? '', objective, ...(limits ? { limits } : {}) };
  });
  // 渲染期按当前 sessionId 过滤恢复值:非当前任务的接回值立即失效(不依赖换代
  // effect 的 commit 后清理时序),新任务表单不会用旧 objective/limits 初始化。
  const goalRestoreForSession =
    goalRestore && goalRestore.sessionId === sessionId ? goalRestore : undefined;
  // goal.set 失败接回(codex review P2):仅初始化 error 不打开面板,用户跳转后
  // 看不到目标设置失败——带入错误时自动打开 Goal 视图,让失败提示可见。
  useEffect(() => {
    if (goalError) {
      setContextSheetView('goal');
      setContextSheetOpen(true);
    }
  }, [goalError]);
  // goal 接回载荷按任务换代清理(codex review P2):任务抽屉 replaceParams 原地
  // 更新同一 SessionScreen 实例,goalRestore/goalError 只在首次挂载初始化——切
  // 任务后残留会让新任务的 Goal 表单预填旧任务的 objective/limits,甚至把旧目标
  // 提交到新任务。prevSessionIdRef 与当前 sessionId 同步初始化:首次挂载
  // (prev===cur)不触发清理,保留路由带入的接回值;同一任务内 router.setParams
  // 清参由 handleSetGoal 成功路径处理,不依赖本 effect。
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      setGoalRestore(null);
      setGoalError(null);
    }
  }, [sessionId]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // 圈点标注接线 api 的 ref 中转:hook 实例声明在 removeRemoteFileAttachment 之后
  // (依赖它做再编辑替换),而 onUploaded 闭包在此之前就要引用 decorate——回调
  // 均为延迟执行,经 ref 读最新实例即可。
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
    discardAllPendingUploadsForScopeChange,
    waitForPendingUploads,
    claimActiveUploads,
    releaseClaimedUploads,
    waitForPastePlaceholdersSettled,
    hasPastePlaceholders,
    getPendingUploadCount,
  } = useMobileLocalAttachments({
    attachmentScopeKey: sessionId,
    getAccessToken: () => auth.getAccessToken(),
    getAttachmentCount: () => attachmentsRef.current.length,
    onUploaded: (rawAttachment, candidate, localId) => {
      // 标注类 candidate:记录「矢量笔迹 + 原图」再编辑真相并打 annotated wire 标。
      const attachment = composerAnnotationsRef.current
        ?.decorateUploadedAttachment(rawAttachment, candidate) ?? rawAttachment;
      // outbox 域:任务已随乐观消息发出——附件填回对应消息的槽位,不进 composer
      // 托盘;再编辑真相同步 forget(消息已离开 composer,与发送成功后的清理同语义)。
      if (routeUploadToOutboxRef.current(localId, { attachment })) {
        composerAnnotationsRef.current?.forgetAttachment(attachment.id);
        return;
      }
      // send() 在 waitForPendingUploads 落定后同步读 ref,而 setState 到 commit 有
      // 微任务延迟——这里派发时同步镜像,保证「上传完成→立即发送」不丢刚落定的附件。
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
    onError: (message, context) => {
      // outbox 域任务的失败路由给对应消息气泡(标失败可重试),不落 composer 错误条。
      const uploadLocalId = context?.uploadLocalId;
      if (uploadLocalId && routeUploadToOutboxRef.current(uploadLocalId, { failed: true })) return;
      setAttachmentError(message);
    },
    onPicked: () => {
      setContextSheetOpen(false);
      requestAnimationFrame(() => composerInputRef.current?.focus());
    },
  });
  // 换会话与退屏的 outbox 回收:未派发条目的文字合并回草稿库(用户已「发出」的文字
  // 不能静默蒸发,回来时出现在输入框里),在途上传任务丢弃(与托盘退出语义一致,
  // controller 会中止传输并回收已完成的 OSS 对象),已就绪附件回收中转对象。
  // 已交接进 pendingQueue / enqueue 在途的消息不在 outbox,不受影响。
  // deps 安全性:removePendingUpload 是 controller.remove 的稳定引用(controller
  // useMemo([]) 单例),不会让本 effect 每 render 重建;auth 经 remoteMediaDepsRef 读最新。
  useEffect(() => {
    outboxSessionAliveRef.current = sessionId;
    return () => {
      // 先撤存活标记:此后到达的派发失败回插 / 上传结果一律走 salvage 降级,
      // 不会再写进即将清空的 ref 或下一个会话的 outbox。
      outboxSessionAliveRef.current = null;
      const items = outboxRef.current;
      if (items.length === 0) return;
      outboxRef.current = [];
      setOutboxItems([]);
      // 草稿按条目自身归属写回(而非本 effect 捕获的 sessionId):防御性一致。
      // 引用正文同步恢复 quote store，输入框只接收剥过 marker 的可见文字。
      restoreOutboxItemsToDraft(items);
      for (const item of items) {
        for (const localId of [...item.waitingIds, ...item.failedIds]) removePendingUpload(localId);
        for (const attachment of outboxItemAttachments(item)) {
          discardMobileUploadedAttachment(attachment, {
            getToken: () => remoteMediaDepsRef.current.auth.getAccessToken(),
          });
        }
      }
    };
  }, [sessionId, removePendingUpload]);
  const [voiceState, setVoiceStateInternal] = useState<MobileVoiceState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceReleaseToSendActive, setVoiceReleaseToSendActive] = useState(false);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuInitialView, setMenuInitialView] = useState<SessionMenuView>('menu');
  const [sessionTreeOpen, setSessionTreeOpen] = useState(false);
  const [sessionTreePendingOpen, setSessionTreePendingOpen] = useState(false);
  // inline 排队区:展开操作行的条目(同时只展开一条;null=全收起)。
  const [queueSelectedClientId, setQueueSelectedClientId] = useState<string | null>(null);
  // 排队消息「复用 composer 编辑」态:进入时把队列条目的文本/附件载入 composer,
  // 暂存(stash)用户原本的草稿与附件托盘,退出(保存/放弃/条目消失)时恢复。
  // ref 镜像供 send() 等异步闭包读最新值。
  const [queueEditing, setQueueEditing] = useState<QueueEditingState | null>(null);
  const queueEditingRef = useRef<QueueEditingState | null>(null);
  // 会话切换 cleanup(声明在前)引用组件后段的回收函数,经 ref 断开声明顺序依赖。
  const discardQueueEditTransientAttachmentResourcesRef = useRef<
    ((editing: QueueEditingState, attachmentsAtExit: readonly RemoteSerializedAttachment[]) => void) | null
  >(null);
  // 排队编辑保存(update-content RPC)在途 promise:会话切换 cleanup 据此把解锁
  // 排到保存落定之后,防止 device-link 并发下解锁超车、桌面端用旧内容抢先派发。
  const queueEditSaveInFlightRef = useRef<Promise<void> | null>(null);
  // 保存中的排队编辑切任务时，composer 必须立即清空，但附件回收不能抢在
  // update-content 落定前。先保存 A 的托盘快照，交给 A 的 cleanup 延后判断。
  const queueEditScopeExitAttachmentsRef = useRef<{
    clientId: string;
    attachments: RemoteSerializedAttachment[];
  } | null>(null);
  // 当前 session 的 composer 附件是页面实例级 state；replaceParams 原地切任务不会
  // 自动卸载它们。状态 / OSS 回收走 ref 读取最新快照；上传代际封口必须由调用方
  // 使用旧 session render 捕获的方法执行，不能在 cleanup 时误封新 session。
  const discardSessionComposerAttachmentStateRef = useRef<() => void>(() => undefined);
  discardSessionComposerAttachmentStateRef.current = () => {
    // 排队编辑时 composer 正展示队列条目的 files，用户原本未发送的附件在 stash。
    // 两批都属于 A；切到 B 时都不能恢复或复用。对非 OSS 的队列文件 discard 是 no-op。
    const editing = queueEditingRef.current;
    const currentAttachments = [...attachmentsRef.current];
    const deferQueueEditAttachments = !!editing && !!queueEditSaveInFlightRef.current;
    if (editing && deferQueueEditAttachments && currentAttachments.length > 0) {
      queueEditScopeExitAttachmentsRef.current = {
        clientId: editing.clientId,
        attachments: currentAttachments,
      };
    }
    const attachmentsById = new Map<string, RemoteSerializedAttachment>();
    // 保存中的当前托盘可能马上成为队列条目的正式 files；由旧 session cleanup
    // 等保存落定后再区分“已保存”与“编辑期临时新增”，这里不能提前 DELETE。
    if (!deferQueueEditAttachments) {
      for (const attachment of currentAttachments) attachmentsById.set(attachment.id, attachment);
    }
    for (const attachment of editing?.stashedAttachments ?? []) {
      attachmentsById.set(attachment.id, attachment);
    }
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentPreviews({});
    setMediaAssetAttachments({});
    setPendingMediaAssets([]);
    setComposerPreviewAttachmentId(null);
    setAttachmentError(null);
    composerAnnotationsRef.current?.forgetAllAttachments();
    for (const attachment of attachmentsById.values()) {
      discardMobileUploadedAttachment(attachment, { getToken: () => auth.getAccessToken() });
    }
  };
  // 抽屉入口会在 replaceParams 前同步调用；这里仍保留 sessionId / 卸载兜底，覆盖
  // 其它原地换代入口。effect 捕获本次 render 的 scope-change 方法，A cleanup 只封 A。
  useEffect(() => () => {
    discardAllPendingUploadsForScopeChange();
    discardSessionComposerAttachmentStateRef.current();
  }, [discardAllPendingUploadsForScopeChange, sessionId]);
  const queueEditLockOwnerRef = useRef<QueueEditLockOwner | null>(null);
  const queueEditSaveOwnerRef = useRef<QueueEditLockOwner | null>(null);
  // 「已出队、消息尚未回流」的落定中条目:桌面端 drain 会先从 pendingQueue 摘除、
  // 后落库推送,device-link 下两者相隔可感知——此间继续渲染半透明气泡(转圈徽标),
  // 消息回流(clientId 进入 queueHiddenClientIds)或超时后移除,保证「原位变实」
  // 不闪断。用户主动删除的条目经 locallyRemoved 集合排除,不产生幽灵气泡。
  // 状态本体带归属会话:同一个 SessionScreen 实例会原地从会话 A 切到 B,而清理是**被动**
  // effect(layout effect 先跑、它后跑),清理落地前 B 的首帧会照着 A 的残留画气泡 ——
  // 用户会在 B 里看到一瞬间 A 的消息内容(review P1)。带上 sessionId 后读侧一律先核身份,
  // 不匹配即视为空,时序不再影响正确性;被动清理只剩释放内存的作用。
  const [settlingState, setSettlingState] = useState<{
    sessionId: string;
    items: readonly QueuedRemoteMessage[];
  }>(() => ({ sessionId, items: [] }));
  const settlingQueueItems = settlingState.sessionId === sessionId ? settlingState.items : EMPTY_SETTLING_ITEMS;
  /** 更新本会话的落定集合;跨会话残留一律先丢掉再算(不把 A 的条目并进 B)。 */
  const setSettlingQueueItems = useCallback((
    updater: (current: readonly QueuedRemoteMessage[]) => readonly QueuedRemoteMessage[],
  ) => {
    setSettlingState((current) => {
      const base = current.sessionId === sessionId ? current.items : EMPTY_SETTLING_ITEMS;
      const next = updater(base);
      if (next === base && current.sessionId === sessionId) return current;
      return { sessionId, items: next };
    });
  }, [sessionId]);
  const settlingAddedAtRef = useRef<Map<string, number>>(new Map());
  /**
   * 「附件 ossRef → 发送时刻的本地预览 file://」。
   *
   * 排队气泡里的图不能等 sentAttachmentThumbStore 那条链(上传落定 → 拷进自有目录 →
   * AsyncStorage hydrate)——期间查询一律返回 null,气泡只能画空占位格。发送时手边就有
   * 预览,记下来直接用;store 仍是重开会话 / 预览失效后的后备。
   * 上限防无界:窗口本来就短(消息回流即不再需要),留 64 条覆盖极端连发。
   */
  const sentPreviewByOssRefRef = useRef<Map<string, string>>(new Map());
  const rememberSentAttachmentPreviews = useCallback((
    attachments: readonly RemoteSerializedAttachment[],
    previewOf: (attachment: RemoteSerializedAttachment) => string | null | undefined,
  ) => {
    const map = sentPreviewByOssRefRef.current;
    for (const attachment of attachments) {
      const ossRef = attachment.url ?? attachment.path;
      const preview = previewOf(attachment);
      if (!ossRef || !preview) continue;
      map.set(ossRef, preview);
    }
    while (map.size > 64) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }, []);
  // 「乐观气泡已上屏、enqueue RPC 尚未落定」的 clientId:这段窗口消息是否真的发出
  // 还没有答案(弱网可达数秒,且失败会回滚摘除气泡),徽标必须是转圈而不是「排入
  // 队尾」——后者是已确认入队的语义。成功 / 回滚 / 转失败任一落定即移除。
  const [sendingQueueClientIds, setSendingQueueClientIds] = useState<ReadonlySet<string>>(new Set());
  const markQueueItemSending = useCallback((clientId: string) => {
    setSendingQueueClientIds((current) => {
      if (current.has(clientId)) return current;
      const next = new Set(current);
      next.add(clientId);
      return next;
    });
  }, []);
  const clearQueueItemSending = useCallback((clientId: string) => {
    setSendingQueueClientIds((current) => {
      if (!current.has(clientId)) return current;
      const next = new Set(current);
      next.delete(clientId);
      return next;
    });
  }, []);
  /**
   * 落定判定的基线:上一帧的 pendingQueue 与插队标记。
   *
   * 必须是 state,不能是 ref(review P1)。render 阶段的现算(derivedSettlingItems)拿它
   * 当输入,而 useMemo 只在**列出的依赖**变化时重算——基线放 ref 时它推进不触发重算,
   * memo 就带着「上一次转移」的答案继续活着:队首被其它控制端删除 / 被 /clear 消化、
   * 消息永不回流时,10s 超时把条目从 settlingQueueItems 移除后,过期缓存又把它加回来,
   * 转圈永不停。放 state 后 memo 的依赖 = 它的全部输入,这类错误在结构上不可能再出现。
   * 存 projection 的原数组引用(不拷贝)是为了让「本帧是否已处理过」可用身份判定。
   */
  const [settlingBaselineState, setSettlingBaseline] = useState<{
    sessionId: string;
    queue: readonly QueuedRemoteMessage[];
    steeringSource: readonly string[];
    steeringClientIds: ReadonlySet<string>;
  }>(() => ({ sessionId, queue: [], steeringSource: [], steeringClientIds: new Set() }));
  // 基线同样按会话核身份:切到 B 的首帧若拿 A 的队列当基线,A 里有、B 里没有的条目会被
  // 判成「刚出队」,当场把 A 的消息画进 B(review P1)。不匹配 → 空基线 = 判不出消失。
  const settlingBaseline = settlingBaselineState.sessionId === sessionId
    ? settlingBaselineState
    : EMPTY_SETTLING_BASELINE;
  /** 用户本地主动删除的排队条目(同上:落定判定的输入,必须对 memo 可见)。 */
  const [locallyRemovedQueueClientIds, setLocallyRemovedQueueClientIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingHistoryExpanded, setPendingHistoryExpanded] = useState(false);
  const [pendingInteractionActiveRequestId, setPendingInteractionActiveRequestId] = useState<string | null>(null);
  /**
   * 用户主动收起的待处理请求(按 requestId),来自模块级 store。
   *
   * 不能是本组件的 state:契约是「只有该请求被回答 / 撤销才失效」,而离开任务会卸载本页,
   * 组件 state 随之丢失——再进来同一条仍在 pending 的请求又会展开占满屏(#1493 review)。
   * store 按 sessionId 隔离,切换会话不串状态。
   */
  const collapsedPendingRequestIds = useCollapsedPendingRequestIds(sessionId);
  const [pendingPlanViewerState, setPendingPlanViewerState] = useState<MobilePlanViewerState>('half');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [routeFocusedClientId, setRouteFocusedClientId] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<MobileSlashCommand[]>([]);
  const [slashPaletteLoading, setSlashPaletteLoading] = useState(false);
  const [slashPaletteError, setSlashPaletteError] = useState<string | null>(null);
  const [atResources, setAtResources] = useState<MobileAtResourceItem[]>([]);
  const [atPaletteLoading, setAtPaletteLoading] = useState(false);
  const [atPaletteError, setAtPaletteError] = useState<string | null>(null);
  const [atResourcesTruncated, setAtResourcesTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  // send() 的同步重入锁:sending state 要等 re-render 提交才可见,主线程卡顿时
  // 连点发送会在同一拍里多次穿过 state 守卫,把同一条消息重复 enqueue(issue #755)。
  // ref 在 send() 同步段立即置位,后续点击当场拦下(同 new.tsx creatingRef /
  // voiceStopInFlightRef 的既有模式)。
  const sendInFlightRef = useRef(false);
  // 本地待发队列(outbox):附件仍在上传时点发送,消息立即以待发气泡上屏并入此队,
  // 附件落定后按 FIFO 逐条真正 enqueue(状态机纯函数在 sessionOutbox.ts)。ref 是
  // 同步真源(上传回调 / 派发循环 / send 同步段都要读最新值),state 只驱动渲染。
  const [outboxItems, setOutboxItems] = useState<readonly MobileOutboxItem[]>([]);
  const outboxRef = useRef<readonly MobileOutboxItem[]>([]);
  // 派发循环重入锁 + 路由函数的 ref 中转(onUploaded 闭包声明在组件前部,实际
  // 路由/派发逻辑声明在 send() 附近,经 ref 断开声明顺序依赖,同 composerAnnotationsRef)。
  const outboxPumpBusyRef = useRef(false);
  const routeUploadToOutboxRef = useRef<
    (localId: string, result: { attachment: RemoteSerializedAttachment } | { failed: true }) => boolean
  >(() => false);
  // outbox 宿主存活标记:值 = 当前有 outbox 回收责任的 sessionId,cleanup(切会话
  // 收尸 / 卸载)时置 null。dispatch 失败回插与上传结果路由据此判断条目所属会话
  // 是否还在场——不在场就降级 salvage,绝不写进别的会话或没人消费的 ref。
  const outboxSessionAliveRef = useRef<string | null>(sessionId);
  // 原地切 session(实例复用)时 render 阶段同步清渲染 state,不闪现旧会话的待发
  // 气泡;ref 此刻不清——sessionId 键控的 cleanup effect(下方)还要读它做回收。
  const [prevOutboxSessionId, setPrevOutboxSessionId] = useState(sessionId);
  if (prevOutboxSessionId !== sessionId) {
    setPrevOutboxSessionId(sessionId);
    setOutboxItems([]);
  }
  const [messageListFollowLatestRequestKey, setMessageListFollowLatestRequestKey] = useState(0);
  const [bottomOverlayContentHeight, setBottomOverlayContentHeight] = useState(0);
  const [topOverlayHeight, setTopOverlayHeight] = useState(0);
  const composerResizeDraggingRef = useRef(false);
  const pendingBottomOverlayHeightRef = useRef<number | null>(null);
  const [composerActivityStartedAt, setComposerActivityStartedAt] = useState<number | null>(null);
  const lastPendingPlanRequestIdRef = useRef<string | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [messageActionBusy, setMessageActionBusy] = useState<{
    clientId: string;
    kind: MobileMessageActionBusyKind;
  } | null>(null);
  const [rewindState, setRewindState] = useState<RewindPreviewState>({ kind: 'idle' });
  // 切 session 时同步(render 阶段)重置回撤确认框 / busy / loading 态并递增「请求代际」。SessionScreen 切
  // session 复用实例、不 remount,这些本地 UI state 不会自动重置,残留会让确认框跨 session 出现且
  // 无法自愈(messageActionBusy 残留还会置灰目标 session 的消息操作栏)。用 React 官方「prop 变化时
  // 调整 state」的 render 阶段模式而非 useEffect:同步生效,既无切换首帧的残留闪帧,也不留「路由已切、
  // passive effect 未跑」的窗口——那个窗口里 in-flight preview/commit 返回会用旧代际误判为未过期,把
  // stale UI 写到当前在屏 session(代际递增同理必须同步,否则请求返回时读到的还是旧代际)。
  const [prevRewindSessionId, setPrevRewindSessionId] = useState(sessionId);
  if (prevRewindSessionId !== sessionId) {
    setPrevRewindSessionId(sessionId);
    setRewindState({ kind: 'idle' });
    setMessageActionBusy(null);
    setLoading(false);
    rewindRequestSeqRef.current += 1;
  }
  const [contextLoading, setContextLoading] = useState(false);
  const [contextUsage, setContextUsage] = useState<unknown>(null);
  // 账号级限额快照(`maker:usage:account` 原始返回):账号级数据本身跨会话共享,但
  // 会话 agentKind 不同时语义不同(只对 codex 会话拉取/展示),随 sessionId 一起清。
  const [accountUsage, setAccountUsage] = useState<unknown>(null);
  // Codex app-server 权威额度 + reset credit 快照。单独保留完整 DTO,同时把其中
  // rateLimits 投影到 accountUsage,复用已有窗口 UI 并兼容老被控端只读通道。
  const [codexRateLimits, setCodexRateLimits] = useState<MobileCodexRateLimitsResult | null>(null);
  const [codexResetBusy, setCodexResetBusy] = useState(false);
  // consume 回包丢失时保留本次 UUID;即使面板重新拉取额度,重试也不能换 key。
  const [codexResetRetryKey, setCodexResetRetryKey] = useState<string | null>(null);
  // contextUsage 的归属会话号:同屏 sessionId 变化(深链 setParams 等原地切换路径)时
  // 清空缓存并作废在途请求,防止上一会话的用量数据在新会话的「会话信息」里串档。
  const contextUsageSessionRef = useRef(sessionId);
  useEffect(() => {
    if (contextUsageSessionRef.current === sessionId) return;
    contextUsageSessionRef.current = sessionId;
    setContextUsage(null);
    setContextLoading(false);
    setAccountUsage(null);
    setCodexRateLimits(null);
    setCodexResetBusy(false);
    setCodexResetRetryKey(null);
  }, [sessionId]);
  const [capabilities, setCapabilities] = useState<MobileAgentCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [alternateCapabilities, setAlternateCapabilities] = useState<MobileAgentCapabilities | null>(null);
  const [alternateCapabilitiesAgentKind, setAlternateCapabilitiesAgentKind] = useState<MobileSessionAgentKind | null>(null);
  const [alternateCapabilitiesLoading, setAlternateCapabilitiesLoading] = useState(false);
  const [alternateCapabilitiesError, setAlternateCapabilitiesError] = useState<string | null>(null);
  const [extraDirBrowseOpen, setExtraDirBrowseOpen] = useState(false);
  const [extraDirBrowsePath, setExtraDirBrowsePath] = useState('');
  const [extraDirBrowseParent, setExtraDirBrowseParent] = useState<string | null>(null);
  const [extraDirBrowseEntries, setExtraDirBrowseEntries] = useState<RemoteDirectoryEntry[]>([]);
  const [extraDirBrowseLoading, setExtraDirBrowseLoading] = useState(false);
  const [extraDirBrowseError, setExtraDirBrowseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // 会话已读回执的同步门槛 key:`${sessionId}:${connectionEpoch}`,由 syncSession 尾部写入。
  // 与 lastSyncedAt 不同,它按 session + 连接代区分——屏实例复用、原地切 session 时
  // lastSyncedAt 不会归零,不能用来判断「当前会话本次连接已同步」。epoch 经 ref 读取,
  // 避免把 connectionEpoch 加进 syncSession deps 引发额外整窗重拉。
  const [readAckSyncedKey, setReadAckSyncedKey] = useState<string | null>(null);
  const readAckEpochRef = useRef(connectionEpoch);
  readAckEpochRef.current = connectionEpoch;
  // 门槛代号:每次「作废门槛」(原地切 session / liveAttention 上升沿)都递增。
  // sync 尾部只有代号与自己启动时一致才允许落 key——否则 A→B→A 场景下,visit-1
  // 的在途旧 load 会在重置之后用**相同的** `${sessionId}:${connectionEpoch}` 把门槛
  // 重新写开(旧 load 的数据不含离开期间的新内容),抢在本次访问排队的 load 之前
  // 放行回执。代号一变,旧 load 的尾部写入直接作废。
  const readAckGateGenRef = useRef(0);
  // 原地切 session(实例复用)时 render 阶段同步清掉门槛:A→B→A 在同一连接代内,
  // A 上次访问落的 key 仍等于 `${sessionId}:${connectionEpoch}`,若不清,回到 A 会在
  // 新一轮 load() 拉到最新窗口前就凭缓存消息放行回执(离开期间只有轻 topic 在走,
  // 缓存未必含新完成 turn 的内容)。每次切换都强制等本次访问的 sync 重新落 key。
  const [prevReadAckSessionId, setPrevReadAckSessionId] = useState(sessionId);
  if (prevReadAckSessionId !== sessionId) {
    setPrevReadAckSessionId(sessionId);
    setReadAckSyncedKey(null);
    readAckGateGenRef.current += 1;
  }
  // 远程媒体取件队列:屏实例级缓存 + 同 url 去重 + 并发上限(每次取件都让桌面端
  // 真实上传一次 OSS,列表缩略图懒取件后必须收敛)。deps 经 ref 透传保持队列实例稳定;
  // 队列生命周期 = 单个会话:切 sessionId / 退屏时 releaseAll + 补删 + 换新实例
  // (见下方 sessionId 键控的清理 effect),上一会话的 OSS 对象不跨会话累积。
  const remoteMediaDepsRef = useRef({ auth, maker });
  // useLayoutEffect 而非 useEffect:子组件(MediaPreview)的取件是被动 effect,
  // 会晚于父层 layout effect、早于父层被动 effect——切会话首批取件必须已看到
  // 新 deps,否则会拿旧 maker/auth 向上一台设备取件。
  useLayoutEffect(() => {
    remoteMediaDepsRef.current = { auth, maker };
  }, [auth, maker]);
  // 图片磁盘缓存(跨会话屏 / 跨启动):命中直接回本地 file://,零取件零桌面上传;
  // 未命中取件成功后后台落盘。forceRefresh(skipCache)时绕过并覆盖写自愈。
  const remoteMediaDiskCacheRef = useRef<RemoteMediaDiskCache | null>(null);
  remoteMediaDiskCacheRef.current ??= createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO());
  // 磁盘缓存源键加设备命名空间:缓存跨账号/设备存续,不同被控端可能产生相同的
  // xdt-image:// url 字符串,裸 url 作键会把上一账号/设备的缓存文件当命中返回
  // (隐私 + 内容错乱)。经 ref 读当前 deviceId,队列工厂闭包不依赖它重建。
  const deviceIdRef = useRef(deviceId);
  // 同上:layout effect 保证子组件被动 effect 起跑前命名空间已切到新设备,
  // 首批 lookup/store 不会落进上一设备的键空间。
  useLayoutEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);
  // 命名空间同时含账号与设备:桌面 deviceId 是跨登录存续的机器 id,登出也不清
  // remote-media 缓存目录——同一台手机 + 同一台桌面换账号,仅设备命名空间仍会
  // 命中上一账号的缓存文件。账号 id 经 deps ref 读(layout effect 已同步刷新)。
  const diskCacheSourceOf = useCallback(
    (url: string) => {
      const userId = remoteMediaDepsRef.current.auth.user?.id || 'unknown-user';
      return `${userId}\u0000${deviceIdRef.current || 'unknown-device'}\u0000${url}`;
    },
    [],
  );
  // 后台落盘中的 ossKey → store promise:DELETE 该 key 前先等对应落盘结束,
  // 避免「离开前最后取件成功的图」store 下载撞上 DELETE 404、白丢缓存下次又要桌面端重传。
  const pendingDiskStoresRef = useRef(new Map<string, Promise<unknown>>());
  // DELETE 一个已取件的 OSS 对象;若其字节仍在后台落盘,等落盘结束(成败皆可)再删。
  const deleteRemoteMediaObject = useCallback((media: MobileResolvedRemoteMedia) => {
    if (!media.ossKey) return; // 磁盘缓存命中的条目没有在世 OSS 对象
    const doDelete = (): void => {
      void remoteMediaDepsRef.current.auth.apiFetch('/api/device-link/media', {
        baseUrl: DEVICE_LINK_API_BASE_URL,
        method: 'DELETE',
        body: { key: media.ossKey },
      }).catch(() => undefined);
    };
    const pending = pendingDiskStoresRef.current.get(media.ossKey);
    if (pending) void pending.then(doDelete, doDelete);
    else doDelete();
  }, []);
  const remoteMediaQueueRef = useRef<ReturnType<typeof createRemoteMediaResolveQueue> | null>(null);
  // 队列工厂:本屏切 sessionId 不重挂载,换会话时旧队列 releaseAll 后必须换全新
  // 实例(released 标志一次性,释放过的队列不再回填缓存)。
  const createRemoteMediaQueue = useCallback(() => createRemoteMediaResolveQueue({
      resolve: async (
        media: RemoteMediaRequest,
        opts?: { skipCache?: boolean },
        hooks?: RemoteMediaResolveHooks,
      ) => {
        const deps = remoteMediaDepsRef.current;
        const diskCache = remoteMediaDiskCacheRef.current;
        // 命名空间键与 deps 同一时刻捕获(首个 await 之前):切设备/账号时在飞的
        // 取件按旧 deps 取到的字节必须落进旧命名空间,await 之后再算键会把上一
        // 设备/账号的图写进新命名空间、之后被当命中返回。
        // 缩略图与原图是同 url 的不同产物,磁盘键同样分离(与取件队列的分键一致);
        // 但「回落原图」(gif/svg/老被控端缩不了图)一律落裸键(见下),因此缩略图
        // 查找带裸键兜底——原图字节既已在盘上,缩略图直接用它,不再二次下载。
        const bareDiskSource = diskCacheSourceOf(media.url);
        const diskSource = (media.thumbnail ? 'thumb\u0000' : '') + bareDiskSource;
        if (media.kind === 'image' && !opts?.skipCache && diskCache) {
          const hit = await diskCache.lookup(diskSource).catch(() => null)
            ?? (media.thumbnail ? await diskCache.lookup(bareDiskSource).catch(() => null) : null);
          if (hit) {
            return {
              url: hit.uri,
              // 本地缓存命中没有对应的在世 OSS 对象;空 ossKey 让退屏清理跳过 DELETE。
              ossKey: '',
              mimeType: hit.mimeType,
              size: hit.size,
              // 本地文件不过期;若被 LRU/OS 清掉,Image onError → forceRefresh 重取自愈。
              expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
              previewable: hit.mimeType.startsWith('image/'),
            };
          }
        }
        const resolved = await resolveMobileRemoteMedia(media, {
          fetchRemoteMedia: deps.maker.fetchRemoteMedia,
          presignGet: (ossKey) => deps.auth.apiFetch<MobileRemoteMediaPresignResult>(
            '/api/device-link/media/presign-get',
            { baseUrl: DEVICE_LINK_API_BASE_URL, method: 'POST', body: { key: ossKey } },
          ),
        }, { ...opts, ...(media.thumbnail ? { thumbnail: true } : {}) });
        // inline 缩略图:字节已随回包到手(data URI 可直接渲染),落盘后换 file://
        // 引用(data URI 常驻队列缓存吃内存,且 RN Image 对超长 uri 不友好)。
        // 无在世 OSS 对象,不进 pendingDiskStores 的 DELETE 编排。
        if (resolved.inlineBase64 && diskCache) {
          await diskCache.storeBytes(diskSource, resolved.inlineBase64, resolved.mimeType).catch(() => undefined);
          const hit = await diskCache.lookup(diskSource).catch(() => null);
          return {
            // 落盘成功换 file://;失败回退 data URI 仍可渲染。剥掉 inlineBase64,
            // 队列缓存不用常驻一份 base64 大字符串。
            url: hit?.uri ?? resolved.url,
            ossKey: '',
            mimeType: resolved.mimeType,
            size: hit?.size ?? resolved.size,
            expiresAt: resolved.expiresAt,
            previewable: resolved.previewable,
          };
        }
        if (media.kind === 'image' && resolved.previewable && diskCache) {
          // 登记落盘 promise(按 ossKey):退屏 DELETE 会先等它结束再删对象。
          // 传 size:超出缓存预算的对象直接跳过落盘,不白下载整个对象。
          // 走到这里的都是完整原图字节(inline 缩略图已在上面 return):即便请求方
          // 要的是缩略图(被控端缩不了回落原图),也落**裸键**——lightbox 后续按裸键
          // 取原图直接磁盘命中,不再对同一张原图二次下载、双份落盘。
          const store = diskCache.store(bareDiskSource, resolved.url, resolved.mimeType, resolved.size)
            .catch(() => false);
          if (resolved.ossKey) {
            const key = resolved.ossKey;
            pendingDiskStoresRef.current.set(key, store.finally(() => {
              pendingDiskStoresRef.current.delete(key);
            }));
          }
          // 落盘成功后把队列缓存条目升级成本地 file://:presign 地址会被队列当 fresh
          // 结果缓存,在有效期内同键请求一律直接命中它、再也不会重进磁盘 lookup,
          // 于是「已经打开过的原图,关掉再打开又从 OSS 重下一整张」,盘上那份副本
          // 永远轮不到用(用户实测 + PR #1125 review)。
          // 这里刻意**不同步等待**落盘:调用方立即拿到可渲染的 presign 地址。取件队列
          // maxConcurrent=2 且看不到 front,同步等待会让 lightbox 的相邻页预取同样
          // 占住槽位,把用户正在看的那张排到已翻过去的图的后台下载之后。
          // store 的返回值是「本次是否真的写入了新字节」:超预算跳过 / 下载失败(现存
          // 同名旧文件被刻意保留)/ 落成 0 字节都为 false,此时绝不能改用本地文件——
          // 否则会把**已被 onError 证伪的旧文件**当本次结果并标成永不过期。
          void store
            .then(async (stored) => {
              if (!stored) return;
              const hit = await diskCache.lookup(bareDiskSource).catch(() => null);
              const local = localCopyResolvedMedia(resolved, hit);
              if (local) hooks?.onLocalCopy(local);
            })
            .catch(() => undefined);
        }
        return resolved;
      },
      // 退屏后才完成的 in-flight 取件:缓存已被 releaseAll 清空接管不到,这里直接
      // 补 DELETE,避免「退出时正在取件」的对象漏出退屏统一清理悬到生命周期兜底。
      onOrphanResolved: (media) => deleteRemoteMediaObject(media),
    }), [deleteRemoteMediaObject]);
  remoteMediaQueueRef.current ??= createRemoteMediaQueue();
  const voiceRecordingActiveRef = useRef(false);
  const voicePermissionRequestInFlightRef = useRef(false);
  const voicePermissionRequestSeqRef = useRef(0);
  const voicePermissionRequestAbortRef = useRef<AbortController | null>(null);
  const voiceStartupInFlightRef = useRef(false);
  // Increments whenever a startup is superseded (screen unmount / session
  // switch). startVoiceRecording re-checks it after each await so a startup
  // that resumes on a dead screen tears down the resources it acquired
  // (claimed prewarmed ASR connection, controller/mic) instead of leaking them.
  const voiceStartupSeqRef = useRef(0);
  const voiceStopInFlightRef = useRef(false);
  const voiceLongPressActiveRef = useRef(false);
  const voiceSuppressNextPressRef = useRef(false);
  const voiceStopAfterStartRef = useRef(false);
  const finishVoiceRecordingRef = useRef<(() => void) | null>(null);
  const composerInputRef = useRef<ComposerRichInputHandle | null>(null);
  const composerScrollViewRef = useRef<ScrollView>(null);
  const composerScrollEnabledRef = useRef(false);
  const voiceDraftScrollRef = useRef<ScrollView>(null);
  const voiceControllerSessionRef = useRef<MobileVoiceControllerSession | null>(null);
  const voiceDictionaryLearningTrackerRef = useRef<MobileVoiceDictionaryLearningTracker | null>(null);
  const sendLatestRef = useRef<((options?: {
    draftOverride?: string;
    documentOverride?: ComposerDocument;
  }) => Promise<void>) | null>(null);
  const sendButtonRef = useRef<View>(null);
  const sendButtonFrameRef = useRef<{ height: number; width: number; x: number; y: number } | null>(null);
  const slashLoadSeqRef = useRef(0);
  const atLoadSeqRef = useRef(0);
  const capabilitiesLoadSeqRef = useRef(0);
  const alternateCapabilitiesLoadSeqRef = useRef(0);
  const agentSwitchIntentLoadSeqRef = useRef(0);
  const agentSwitchWriteSeqRef = useRef(0);
  // palette 点选的 agent-skill 名字(含 sessionId 绑定):保留到下次发送或再次打开
  // palette;sessionId 绑定防止切换会话时旧点选污染新会话的 dispatch。
  // 发送侧在 slashCommands=[] 时仍能区分「点选了 skill」与「直接手输」,确保
  // 点选的 skill 不被白名单拦截误分流到 learn:start。
  const pendingSkillSelectionRef = useRef<{ name: string; sid: string } | null>(null);
  const extraDirBrowseSeqRef = useRef(0);
  const autoRetrySyncKeyRef = useRef<string | null>(null);
  const loadedRouteFocusKeyRef = useRef<string | null>(null);
  const appliedRouteFocusKeyRef = useRef<string | null>(null);
  const appliedRouteComposerFocusKeyRef = useRef<string | null>(null);
  const targetAvailableRef = useRef<boolean | null>(null);
  // 记录已为哪个连接 epoch 触发过 resync;初值 = 首渲染时的 epoch,使首开由 mount effect 单独负责,
  // 这个 epoch effect 只在真正重连(epoch 变化)时再同步,避免首开连环重 sync 导致列表重排跳动。
  const syncedConnectionEpochRef = useRef(connectionEpoch);
  const currentSession = useMemo(
    () => sessions.find((item) => item.id === sessionId) ?? null,
    [sessionId, sessions],
  );
  const localCodexRateLimitControl = canUseLocalCodexRateLimitControl(currentSession);
  const isDeviceAccessRevoked = !!deviceId && revokedDevices.has(deviceId);
  // 熔断 open:被控电脑「进程活着但不回包」的半死态;relay status 恒 online,必须单独入参。
  const isDeviceUnresponsive = !!deviceId && unresponsiveDevices.has(deviceId);
  // 熔断已关后残留的 DEVICE_UNRESPONSIVE 错误按陈旧丢弃,且必须一次性解析、
  // 两个消费方共用(review P1):banner 用它,下面的 remoteUnavailableReason 也
  // 用它——否则恢复后横幅消失了,composer 却仍被 stale 快照锁在不可用态,
  // 直到手动同步才解开。
  const connectionError = resolveEffectiveConnectionError(
    isDeviceAccessRevoked ? '[ACCESS_REVOKED] access revoked by target device' : error,
    isDeviceUnresponsive,
  );
  // 弱网普通断线也要有可见信号(消息流静默停更没有任何提示),经防闪延迟后显示
  const showConnectionBanner = useShowConnectionBanner(status, connectionError, connectionIssue, isDeviceUnresponsive);
  const hasCurrentSession = currentSession !== null;
  const currentAgentKind = useMemo(
    () => currentSession ? agentKindForSession(currentSession) : null,
    [currentSession?.agentKind, currentSession?.id],
  );
  // —— 自动化 run「激活即已读」(对齐桌面端 CCAgentSidebarUpper):打开会话读完报告后,
  // 把该会话名下未读 run 在被控端标已读;host 随之广播 read 事件,首页 / 设备列表红点自动清除。
  const scheduleEventSnapshot = useRemoteScheduleEventSnapshot(deviceId);
  const completedRunId = unreadRunIdFromProjection(scheduleEventSnapshot.lastProjection, sessionId);
  // 开会话路径:延后一小段再拉 schedule index,把该会话未读 run 标已读。不限定 scheduler 生成的
  // 会话——显式绑定普通会话(targetSessionId)的 run 同样会在列表挂未读徽标,冷启动后无事件投影可依,
  // 只能靠 index 探测。无 schedule 的用户只多一次轻量 schedule.list;延后是避开首开关键读抢 WS 管道(#324)。
  // 瞬态失败兜底:短暂抖动走 withTransientRemoteRetry 原地重试;冷启动首开时 device-link 可能尚未
  // 就绪且失败被吞,依赖 connectionEpoch 在重连后重跑一次探测,用户停在会话里红点也能自愈。
  // unreadVersion 依赖:store 只存最近一条事件投影,completed 被紧随的事件覆盖时下面的快路径会漏;
  // 任何影响未读的事件都 bump unreadVersion(累计计数不丢),据此重跑延后探测兜底。标已读后广播回来的
  // read 事件会再触发一轮探测,发现无未读即收敛;800ms defer + effect cleanup 会把连续事件合并成一次。
  useEffect(() => {
    if (!sessionId) return;
    return deferScheduleIndexHydration(() => {
      void withTransientRemoteRetry(() => markSessionScheduleRunsRead(maker, sessionId))
        .catch(() => undefined);
    });
  }, [connectionEpoch, maker, scheduleEventSnapshot.unreadVersion, sessionId]);
  // 会话开着时报告刚完成:事件投影直接给出绑定到本会话的 runId,单次标已读、免拉 index。
  useEffect(() => {
    if (!completedRunId) return;
    void maker.schedule.markRunRead(completedRunId).catch(() => undefined);
  }, [completedRunId, maker]);
  // —— 会话未读「真实展示即已读」回执 ——
  // 手机端打开会话且**本次连接代已完成整窗同步**后,驻留满 dwell 把被控端该会话的
  // 未读态(灵动岛 / Dock 角标 / 桌面侧栏红绿点)清掉;被控端清完经 sessions relay
  // 推回 attention=false,手机端列表绿/红点自动收敛。intent 用 'explicit':用户主动点进
  // 会话且最新内容已渲染,等价于桌面「报错 UI 真实展示」,可清 error 未读。触发面:
  //  - 打开 / 重连(connectionEpoch),整窗同步完成且消息已渲染(空拉取不算已读);
  //  - 会话开着时 turn 刚跑完翻未读(liveAttention 翻 true)——用户正注视,补一次回执。
  // 同步门槛(readAckSyncedKey):屏实例复用、原地切 session 时,store 里可能先渲染出
  // 缓存 / 上一窗口的旧消息——只凭 messages.length 就发回执,会把用户尚未看到的新内容
  // 标成已读。sync 尾部记录「哪个 session 在哪个连接代完成过整窗同步」,回执 effect
  // 校验其等于当前 `${sessionId}:${connectionEpoch}` 才起计时;切会话 / 断线重连后都要
  // 等新一轮同步落地。in-flight 旧 sync 写的是旧 sessionId 的 key,不会误放行。
  // liveAttention 回落(true→false,通常是本回执生效后 relay 推回)不重发:lastAckKeyRef
  // 记录本 epoch 已回执过,避免每个 turn 结束多打一次无谓 invoke。key **只在结果落定后**
  // 写入:成功或永久失败(如老被控端 CHANNEL_NOT_ALLOWED,重试无意义)才记;瞬态失败
  // (DEVICE_LINK_TIMEOUT 等)先走 withTransientRemoteRetry 原地退避重试,重试耗尽仍不记
  // key——留给下一次依赖变化(重连 connectionEpoch / liveAttention 翻转)自然补发,
  // 不让一次超时把回执永久吞掉。
  // useFocusEffect 保证仅前台聚焦本会话时计时,驻留期内离开则取消(没看完不算已读)。
  const liveAttention = useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionLiveActivity(sessionId)?.attention === true,
  );
  const hasRenderedMessages = messages.length > 0;
  const lastAckKeyRef = useRef<string | null>(null);
  // AppState 门槛:锁屏 / 切后台时导航焦点不变,useFocusEffect 的 cleanup 不会跑,
  // 驻留计时器可能在没有真实前台展示的情况下(甚至后台恢复补跑时)发出 explicit
  // 回执。把 AppState 作为回执 effect 的重算信号:离开 active 立刻取消未到期的
  // 计时,回到 active 重新起满一轮 dwell。
  const [appStateActive, setAppStateActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppStateActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!appStateActive || !deviceId || !sessionId || !hasRenderedMessages) return undefined;
      if (readAckSyncedKey !== `${sessionId}:${connectionEpoch}`) return undefined;
      const ackKey = `${deviceId}:${sessionId}:${connectionEpoch}`;
      if (!liveAttention && lastAckKeyRef.current === ackKey) return undefined;
      const timer = setTimeout(() => {
        // 门槛代号快照:退避重试期间 liveAttention 上升沿会递增代号——旧回执不得在
        // 重试成功时清掉重试窗口内新完成 turn 的未读,每次尝试前核对,不一致即中止
        // (抛非瞬态标记终止退避);中止后不落 ack key,等新一轮门槛 + dwell 重新回执。
        const gateGenAtFire = readAckGateGenRef.current;
        void withTransientRemoteRetry(() => {
          if (readAckGateGenRef.current !== gateGenAtFire) {
            throw new Error('RECEIPT_SUPERSEDED');
          }
          return maker.clearSessionAttention(sessionId, 'explicit');
        })
          .then(() => {
            if (readAckGateGenRef.current === gateGenAtFire) lastAckKeyRef.current = ackKey;
          })
          .catch((err) => {
            if (String(err).includes('RECEIPT_SUPERSEDED')) return;
            if (!isTransientRemoteError(err)) lastAckKeyRef.current = ackKey;
          });
      }, SESSION_READ_ACK_DWELL_MS);
      return () => clearTimeout(timer);
    }, [appStateActive, connectionEpoch, deviceId, hasRenderedMessages, liveAttention, maker, readAckSyncedKey, sessionId]),
  );
  // 写编排只读 reason(fork/rewind、队列编辑、会话设置写、pending interaction):对 lead + worker 都返回。
  const collaborationReadOnlyReason = useMemo(
    () => sessionCollaborationReadOnlyReason(currentSession),
    [currentSession?.orcaRole],
  );
  // composer(发消息)只读 reason:仅非 lead 的协作角色只读;Lead 返回 null → 可在手机上发文字消息。
  const composerReadOnlyReason = useMemo(
    () => sessionCollaborationComposerReadOnlyReason(currentSession),
    [currentSession?.orcaRole],
  );
  const activePendingInteraction = useMemo(() => {
    return selectPendingInteractionByRequestId(pending, pendingInteractionActiveRequestId);
  }, [pending, pendingInteractionActiveRequestId]);
  const activePendingRequestId = activePendingInteraction
    ? readRequestId(activePendingInteraction)
    : null;
  const activePendingKind = activePendingInteraction
    ? interactionKind(activePendingInteraction)
    : null;
  const activePendingCollapsed = isPendingInteractionCollapsed(
    collapsedPendingRequestIds,
    activePendingRequestId,
  );
  const pendingInteractionFullHeight = shouldUseFullHeightPendingInteractionSurface({
    activeKind: activePendingKind,
    collapsed: activePendingCollapsed,
    planViewerState: pendingPlanViewerState,
  });
  const toggleCollapsedPendingRequest = useCallback((requestId: string) => {
    togglePendingInteractionCollapse(sessionId, requestId);
  }, [sessionId]);
  // 状态与回调成对下发:Panel 的 collapse prop 是整组给或整组不给,只给一半会得到
  // 「显示为收起但点不开」的死界面(#1493 review)。
  const pendingInteractionCollapse = useMemo(
    () => ({ requestIds: collapsedPendingRequestIds, onToggle: toggleCollapsedPendingRequest }),
    [collapsedPendingRequestIds, toggleCollapsedPendingRequest],
  );
  const hasActivePendingInteraction = activePendingInteraction !== null;
  // 只有手机能终结的卡才允许接管输入框。plugin_setup 这类必须回电脑端完成的
  // 请求若也顶掉 composer,用户既处理不了卡、又发不出消息,会话在手机上被彻底
  // 锁死(线上已复现);它们改为贴在输入框上方,聊天不受影响。
  // 判据是整个 pending 集合而非当前查看的卡:队列里还有权限 / 提问 / 计划卡在等
  // 回答时,切到 plugin_setup 只是换了查看对象,不能就此放开 composer 让用户绕过
  // 那张仍待处理的阻塞交互(#530 review P1)。
  const pendingInteractionBlocksComposer = pendingInteractionsBlockRemoteComposer(pending);
  const remoteUnavailableReason = useMemo(
    () => describeRemoteError(connectionError),
    [connectionError],
  );
  // 缓存种入的会话行只是首屏骨架:字段经瘦身/截断(240 字符),不能作为发送参数
  // (buildQueuedTextMessage 会把 workingDir / model / permission 复制进队列请求)。
  const cacheSeededReason = currentSession?.cacheSeeded
    ? t('session.screen.composerSyncing')
    : null;
  // 新建会话乐观管线在途:合成行(pendingLocalCreation)期间会话可能还没在被控端建成,
  // 且首条 enqueue 落定前抢发的消息 sendAtMs 会早于首条、被排到它前面
  // (newSessionCreation.ts 的 sendAtMs 顺序注释)。
  const pendingCreationReason = currentSession?.pendingLocalCreation
    ? t('session.screen.composerCreating')
    : null;
  // 会话设置类动作(model / effort / fast / permission / plan)在会话建成前不可用:
  // 它们是打到被控端会话的 RPC。cacheSeeded 不锁——那种会话在被控端是存在的,只是
  // 本地行还是瘦身缓存。硬门在 runControlAction 里,这里供按钮表达灰态。
  // 判据与命令式路径共用 isRemoteSessionMissing(见其注释):这里是渲染需要的
  // reactive 形态,send / runControlAction 用读 store 的 Now 形态。
  const sessionSettingsLocked = isRemoteSessionMissing(currentSession);
  // 这两条理由**不再**进 composer 的 readOnlyReason:共享模型会据此把整个输入框换成
  // 「只读模式」卡片,而它们表达的只是「会话参数还没就绪」——每次新建会话都必然经过,
  // 用户看到的是「刚发出消息就变只读」。改为:composer 全程正常,这期间发出的消息压进
  // 本地 outbox(转圈气泡上屏),就绪后由 pumpOutbox 按 FIFO 自动派发(sendAtMs 在
  // dispatch 时才生成,顺序天然正确)。判据见 outboxDispatchBlockedNow。
  const sessionOperationLayout = useMemo(
    () => buildSessionOperationLayout({
      hasCurrentSession,
      hasActivePendingInteraction,
      pendingInteractionBlocksComposer,
      remoteUnavailableReason,
      // composer 用 composer-only reason:Lead → editable(可发消息),worker → read-only。
      readOnlyReason: composerReadOnlyReason,
    }),
    [composerReadOnlyReason, hasActivePendingInteraction, hasCurrentSession, pendingInteractionBlocksComposer, remoteUnavailableReason],
  );
  useEffect(() => {
    if (!pendingInteractionActiveRequestId) return;
    if (!pending.some((item) => readRequestId(item) === pendingInteractionActiveRequestId)) {
      setPendingInteractionActiveRequestId(null);
    }
  }, [pending, pendingInteractionActiveRequestId]);
  // 卡被回答 / 被撤后清掉它的收起记录,否则同一 requestId 万一复现会直接以收起态出现。
  // 只在 pending 列表**权威**时清:短暂离线会按设计清空这份投影(markDeviceOffline),
  // 那种空列表不代表请求已终结(#1493 review)。prune 无变化时返回原数组,不会自触发。
  useEffect(() => {
    prunePendingInteractionCollapse(sessionId, pending, {
      authoritative: pendingInteractionsAuthoritative,
    });
  }, [pending, pendingInteractionsAuthoritative, sessionId]);
  useEffect(() => {
    if (
      sessionOperationLayout.composerSlot !== 'pending-interaction'
      || activePendingKind !== 'plan_review'
    ) {
      setPendingPlanViewerState('half');
      lastPendingPlanRequestIdRef.current = null;
      return;
    }
    if (lastPendingPlanRequestIdRef.current !== activePendingRequestId) {
      lastPendingPlanRequestIdRef.current = activePendingRequestId;
      setPendingPlanViewerState('half');
    }
  }, [activePendingKind, activePendingRequestId, sessionOperationLayout.composerSlot]);
  const canUseComposer = sessionOperationLayout.canUseComposer;
  // 共享模型自造的那两条禁发理由是中文直出,而它会经 composer 与队列行的
  // accessibility hint 读给用户 —— 按 locale 翻译后再用,否则读屏在 en / ja / ko
  // 下念混语(#530 review)。调用方自己传进去的理由(离线 / 只读 / 同步中)已本地化,
  // 此时 key 为 null,原样使用。
  const composerDisabledReasonKey = composerDisabledReasonI18nKey(
    sessionOperationLayout.composerDisabledReasonSource,
  );
  const composerDisabledReason = composerDisabledReasonKey
    ? t(composerDisabledReasonKey)
    : sessionOperationLayout.composerDisabledReason;
  // inline 队列操作可用性:旧队列弹层由 showQueue 整体隐藏(离线/被撤销、pending
  // interaction 等),inline 化后气泡必须留在消息流里,故改为保留渲染、按同一规则
  // 禁用操作(取消/编辑/插话/重试/恢复),禁用理由沿用 composerDisabledReason。
  // 会话参数未就绪(缓存种入 / 新建在途)时队列行仍只读:取消 / 编辑 / 插队都是打到
  // 被控端队列的 RPC,会话在那边可能还不存在。composer 已按乐观语义放开,只有这些
  // 队列操作留在禁用档。
  const queueInlineReadOnlyReason = collaborationReadOnlyReason
    ?? cacheSeededReason
    ?? pendingCreationReason
    ?? (sessionOperationLayout.showQueue ? null : composerDisabledReason);
  const showMessageHistory = sessionOperationLayout.messageHistoryMode === 'visible'
    || (sessionOperationLayout.messageHistoryMode === 'collapsed' && pendingHistoryExpanded);
  // 冷开即出壳:session 元信息还没回来,但不是真正不可用(离线/被撤销,看 remoteUnavailableReason)——
  // 立即渲染真壳(标题乐观显示、消息区骨架、输入框可编辑、发送禁用),而不是阻塞式占位。
  const showSyncingShell = sessionOperationLayout.composerSlot === 'missing-session'
    && !remoteUnavailableReason;
  // 同步/加载期消息区不显示「暂无消息」(会话其实在加载、不是空),改为渲染「正在同步」
  // loading 占位(MessageRenderer 的 SyncingMessages,延迟显形防快速路径闪烁);看过的会话
  // 此时已被本地缓存(②)填充正常渲染,不进 empty 分支。还包含冷开首帧:currentSession 立即
  // 就有但消息未到、loading 尚未翻 true 的窗口(本次打开未同步过)。只有同步完成过
  // (lastSyncedAt 有值)且确实 0 条时才显示「暂无消息」;离线/被撤销(remoteUnavailableReason)
  // 不进此分支,保留原占位。判定见 shouldSuppressEmptyMessageState。
  const syncingWhileEmpty = shouldSuppressEmptyMessageState({
    loading,
    showSyncingShell,
    messageCount: messages.length,
    hasSyncedThisOpen: lastSyncedAt !== null,
    remoteUnavailable: !!remoteUnavailableReason,
  });
  const composerTrigger = useMemo(() => detectComposerTrigger(draft), [draft]);
  const visibleSlashCommands = useMemo(
    () => canUseComposer && composerTrigger.kind === 'slash'
      ? filterSlashCommands(mergeMobileLocalSlashCommands(slashCommands), composerTrigger.query, 5)
      : [],
    [canUseComposer, composerTrigger, slashCommands],
  );
  const visibleAtResources = useMemo(
    () => canUseComposer && composerTrigger.kind === 'at'
      ? filterAtResources(atResources, composerTrigger.query, 5)
      : [],
    [atResources, canUseComposer, composerTrigger],
  );
  const voiceUiAvailable = shouldShowMobileVoiceUi(Platform.OS);
  const voiceIsListening = voiceState === 'listening';
  const voiceIsProcessing = voiceState === 'submitting' || voiceState === 'refining';
  const voiceIsBusy = voiceIsListening || voiceIsProcessing;
  // 手机语音只保留官方托管路径,错误引导仅剩系统麦克风权限一条。
  const canOpenVoiceSettings = isMobileVoiceMicPermissionError(voiceError);
  const composerHasText = draft.trim().length > 0;
  const canStopQueue = !!stopOptionsForProjection(inputProjection)
    && !inputProjection.queuePaused
    && !inputProjection.queueAbortPending;
  const currentTurnStreaming = useMemo(
    () => currentTurnHasStreamingAssistant(messages),
    [messages],
  );
  const canStopCurrentRun = (remoteSessionRunning || currentTurnStreaming)
    && !inputProjection.queueAbortPending;
  const canStopComposer = canStopQueue || canStopCurrentRun;
  const sessionAgentKind: MobileSessionAgentKind = currentSession
    ? resolveSessionAgentKind(currentSession)
    : 'claude-code';
  const agentSwitchIntent = currentSession?.agentSwitchIntent ?? null;
  const sessionAgentSwitchSupported = !!currentSession
    && supportsMobileSessionAgentSwitch(currentSession, capabilities);
  const runtimeOptions = useMemo(
    () => currentSession ? buildSessionRuntimeOptions(currentSession, capabilities) : null,
    [capabilities, currentSession],
  );
  // pending intent 只覆盖 composer / selector 的展示，不改 RemoteSession 的真实 DB 字段；
  // main 在下一条消息发送时提交切换，sessions:patched 回流后展示自然交回真实行。
  const composerDisplaySession = useMemo(() => {
    if (!currentSession || !agentSwitchIntent) return currentSession;
    return {
      ...currentSession,
      model: agentSwitchIntent.model,
      providerId: agentSwitchIntent.providerId,
      effort: agentSwitchIntent.effort ?? currentSession.effort,
      fastMode: agentSwitchIntent.fastMode ?? false,
    };
  }, [agentSwitchIntent, currentSession]);
  const composerDisplayCapabilities = !agentSwitchIntent
    || agentSwitchIntent.targetAgentKind === sessionAgentKind
    ? capabilities
    : alternateCapabilitiesAgentKind === agentSwitchIntent.targetAgentKind
      ? alternateCapabilities
      : null;
  const composerDisplayRuntimeOptions = useMemo(
    () => composerDisplaySession
      ? buildSessionRuntimeOptions(composerDisplaySession, composerDisplayCapabilities)
      : null,
    [composerDisplayCapabilities, composerDisplaySession],
  );
  const composerRuntimeSummary = useMemo(
    () => composerDisplaySession && composerDisplayRuntimeOptions
      ? buildComposerRuntimeSummary(composerDisplaySession, composerDisplayRuntimeOptions)
      : null,
    [composerDisplayRuntimeOptions, composerDisplaySession],
  );
  // 被控端供应商目录 → provider-aware 模型分段(与新建会话页同逻辑;0 供应商回退扁平 modelOptions)。
  const composerDeviceProviders = useDeviceProviders(deviceId || undefined);
  const composerModelSections = useMemo(
    () => currentSession
      ? buildMobileModelSections({
          providers: composerDeviceProviders.providers,
          agentKind: sessionAgentKind,
          selectedModelId: currentSession.model,
          selectedProviderId: currentSession.providerId ?? null,
          visibilityOverrides: composerDeviceProviders.modelVisibilityOverrides,
          // 已建会话:实际路由口径(运行中会话跟真实扣费路由,含停用拷贝)。
          existingSessionRoute: true,
        })
      : null,
    [composerDeviceProviders.providers, composerDeviceProviders.modelVisibilityOverrides, currentSession],
  );
  // 模型列表元信息(单价 / 折扣版 key presence)—— 与新建会话页同一套隧道缓存 hook。
  const deviceModelPricing = useDeviceModelPricing(deviceId || undefined);
  const deviceApiKeyStatus = useDeviceApiKeyStatus(deviceId || undefined);
  // 会话「非选中模型」effort/fast 的镜像 accessors:乐观写本地镜像 + 双写穿被控端
  // (set-session-model-pref 写真实会话记忆 / apply-new-maker-draft-pref 同步草稿默认,
  // 对齐桌面 CCAgentSessionView 的 device-link 分支;旧被控端 CHANNEL_NOT_ALLOWED 静默降级)。
  // 发送前鉴权提示(对齐 new.tsx 的门禁判定,但不拦截发送:会话内消息走排队,
  // 用户在电脑端配好 key 后可直接「重试发送」,拦死反而丢掉这条恢复路径)。
  const composerAgentAuthHint = useMemo(() => {
    const verdict = agentAuthGateVerdict({
      providers: composerDeviceProviders.providers,
      loading: composerDeviceProviders.loading,
      error: composerDeviceProviders.error,
      agentKind: sessionAgentKind,
      // 已建会话:suspended 来源计入(停用不打断运行中会话,门禁只看凭证连接态)。
      existingSessionRoute: true,
    });
    return verdict === 'unauthenticated' ? agentAuthGateHint(sessionAgentKind) : null;
  }, [
    composerDeviceProviders.providers,
    composerDeviceProviders.loading,
    composerDeviceProviders.error,
    sessionAgentKind,
  ]);
  const sessionMirrorAccessors = useMemo(
    () => makeSessionMirrorAccessors(sessionId, (agent, providerId, model, patch) => {
      void maker.setSessionModelPref({ sessionId, agent, providerId, model, ...patch }).catch(() => undefined);
      void maker.applyNewMakerDraftPref({ agent, providerId, modelId: model, active: false, ...patch }).catch(() => undefined);
    }),
    [maker, sessionId],
  );
  useEffect(() => () => clearSessionMirror(sessionId), [sessionId]);
  const modelSheetUsesIntent = agentSwitchIntent?.targetAgentKind === modelSheetAgentKind;
  const modelSheetCapabilities = modelSheetAgentKind === sessionAgentKind
    ? capabilities
    : alternateCapabilitiesAgentKind === modelSheetAgentKind
      ? alternateCapabilities
      : null;
  const modelSheetCapabilitiesLoading = modelSheetAgentKind === sessionAgentKind
    ? capabilitiesLoading
    : alternateCapabilitiesLoading;
  const modelSheetCapabilitiesError = modelSheetAgentKind === sessionAgentKind
    ? capabilitiesError
    : alternateCapabilitiesError;
  const modelSheetSelection = currentSession
    ? {
        model: modelSheetUsesIntent ? agentSwitchIntent.model : (
          modelSheetAgentKind === sessionAgentKind ? currentSession.model : ''
        ),
        providerId: modelSheetUsesIntent ? agentSwitchIntent.providerId : (
          modelSheetAgentKind === sessionAgentKind ? currentSession.providerId ?? null : null
        ),
        effort: modelSheetUsesIntent ? agentSwitchIntent.effort ?? '' : (
          modelSheetAgentKind === sessionAgentKind ? currentSession.effort : ''
        ),
        fastMode: modelSheetUsesIntent ? agentSwitchIntent.fastMode ?? false : (
          modelSheetAgentKind === sessionAgentKind ? currentSession.fastMode : false
        ),
      }
    : null;
  const modelSheetRuntimeOptions = useMemo(
    () => modelSheetSelection
      ? buildSessionRuntimeOptions(modelSheetSelection, modelSheetCapabilities)
      : null,
    [modelSheetCapabilities, modelSheetSelection],
  );
  // composer 模型药丸(对齐桌面 trigger):当前来源官方 mark + 「模型 · effort」+ Fast 闪电。
  const composerActiveSourceProvider = useMemo(
    () => composerModelSections
      ? composerModelSections.connected.find((p) => p.id === composerModelSections.activeSourceId) ?? null
      : null,
    [composerModelSections],
  );
  // 会话持久化的显式来源可能在电脑端被断开。此时不能把 activeSourceId 的默认回退
  // 画成真实来源，否则手机会显示「默认来源 Logo」，发送却仍按已断开的 providerId 路由。
  // provider 列表加载期间不判，避免首帧短暂闪出断开态。
  const composerSelectedSourceDisconnected = useMemo(() => {
    if (!currentSession) return false;
    return isSelectedSourceDisconnected({
      providers: composerDeviceProviders.providers,
      providerId: currentSession.providerId,
      modelId: currentSession.model,
      agentKind: sessionAgentKind,
      loading: composerDeviceProviders.loading,
      error: composerDeviceProviders.error,
    });
  }, [
    composerDeviceProviders.error,
    composerDeviceProviders.loading,
    composerDeviceProviders.providers,
    currentSession,
    sessionAgentKind,
  ]);
  const composerPillSourceProvider = useMemo(() => {
    if (!composerSelectedSourceDisconnected) return composerActiveSourceProvider;
    return composerDeviceProviders.providers.find(
      (provider) => provider.id === currentSession?.providerId,
    ) ?? null;
  }, [
    composerActiveSourceProvider,
    composerDeviceProviders.providers,
    composerSelectedSourceDisconnected,
    currentSession?.providerId,
  ]);
  const composerPillSourceId = composerSelectedSourceDisconnected
    ? currentSession?.providerId ?? null
    : composerPillSourceProvider?.id ?? null;
  const composerPillFastOn = agentSwitchIntent
    ? agentSwitchIntent.fastMode === true
    : !composerSelectedSourceDisconnected && !!currentSession?.fastMode
      && rowFastEditable({
        provider: composerActiveSourceProvider ?? undefined,
        modelId: currentSession?.model ?? '',
        agentKind: sessionAgentKind,
        hasFastModeCap: capabilities?.hasFastMode === true,
      });
  const composerRuntimeLabel = composerRuntimeSummary
    ? agentSwitchIntent
      ? t('session.screen.nextAgentSwitch', { agent: mobileAgentLabel(agentSwitchIntent.targetAgentKind), model: composerRuntimeSummary.modelSummary })
      : composerRuntimeSummary.modelSummary
    : '';
  const composerSendUnavailableReason = canUseComposer ? null : composerDisabledReason;
  // 引用已是 ComposerDocument 内的 atom；排队编辑同样可能只有引用而没有可见
  // 文本，因此必须计入 payload，否则「保存修改」会被错误禁用。
  const composerQuoteCount = composerDocumentQuotes(composerDocument).length;
  // Context 面板是 Modal sheet,不再有内联附件面板 → attachmentPickerOpen 恒 false。
  const composerLayout = useMemo(() => buildSessionComposerLayout({
    attachmentBusy: false,
    // pending(乐观上传中)计入:拍完照 / 选完文件立即可点发送,send() 内部会等落定。
    attachmentCount: attachments.length + pendingUploads.length,
    attachmentPickerOpen: false,
    canStop: canUseComposer && canStopComposer,
    draftText: draft,
    queueBusy,
    quoteCount: composerQuoteCount,
    sendUnavailableReason: composerSendUnavailableReason,
    sending,
    voiceState,
  }), [
    attachments.length,
    pendingUploads.length,
    canStopComposer,
    canUseComposer,
    composerQuoteCount,
    composerSendUnavailableReason,
    draft,
    queueBusy,
    sending,
    voiceState,
  ]);
  const compactComposer = composerLayout.density === 'compact';
  // 「按下即录」的乐观反馈(对齐桌面 activeRecording = listening || longPressActive):
  // pressIn 发起启动的同时置 pending,胶囊立刻展开计时,不等 ASR/权限链路把 state
  // 翻到 listening——否则启动慢时按钮有一段「按了没反应」。启动完成(成功进
  // listening / 失败报错)后由 finally 收回;成功路径收回时 listening 已为 true,
  // 计时输入保持连续,不会闪断重置。声明在槽位 flags 之前:pending 期就要占住发送槽。
  const [voiceStartPending, setVoiceStartPending] = useState(false);
  // pending 的世代号:本组件会随 sessionId 复用,上一个会话的启动收尾不能把
  // 当前会话刚展开的乐观胶囊收掉——finally 只在世代未前进时清 pending。
  const voiceStartPendingSeqRef = useRef(0);
  // pressIn 已起录的标记:同一次手势的松手(onPress)不能再被当作「再点一下停止」。
  const voiceStartedOnPressInRef = useRef(false);
  // 发送槽双语义(对齐桌面 ChatInput 的主槽判定,voice busy = listening|submitting|refining):
  // 任务执行中且发送不可用、又没有语音在进行时,停止任务顶替发送位;语音一旦开始,
  // 发送键回到发送位(录音期=「结束并发送」,润色期=禁用态占位),停止任务退到
  // 语音按钮**左边**的独立槽。语音按钮由此永远是发送槽的左邻,右缘位置与是否有
  // 草稿/是否录音/任务是否执行全部无关——录音胶囊只向左生长,「原地再点一下」
  // 永远是停止录音,不会误停任务。
  const composerSendSlotIsStop = composerLayout.stop.visible
    && composerLayout.send.disabled
    && !sending
    && !voiceIsBusy
    && !voiceStartPending;
  // 降级 composer(未同步/离线):输入框可编辑并持续保存草稿,但发送禁用,
  // 直到 currentSession 和远端连接恢复后自动恢复可发送。
  const composerSendDisabled = composerLayout.send.disabled;
  const composerShowInlineStop = composerLayout.stop.visible && !composerSendSlotIsStop && !sending;
  const composerHasPayload = composerHasText || attachments.length > 0 || pendingUploads.length > 0 || composerQuoteCount > 0;
  // send.visible 在语音生命周期内恒 true(sessionOperation.ts),这里不再按
  // voiceIsListening 二次过滤——那正是「首段转写落地瞬间发送键冒出来」的跳变源。
  // 乐观 pending 期(state 还是 idle)同样要占住发送槽:否则空草稿按下语音时
  // 胶囊先在 12pt 档展开,listening 一到发送键出现又整体跳到 52pt 档。
  const composerShowSendButton = composerLayout.send.visible || voiceStartPending;
  const composerVoicePlacement = voiceUiAvailable
    ? resolveMobileComposerVoiceButtonPlacement({
      // 行尾有发送或占发送位的停止按钮时让位;附件-only(无文字)同样命中。
      hasTrailingAction: composerSendSlotIsStop || composerShowSendButton,
    })
    : undefined;
  // 录音计时(红点+m:ss 胶囊);pillWidth 同时驱动语音按钮与工具排占位 slot,
  // 胶囊展开时把左邻的停止任务按钮推开,而不是盖住它。expanded 含乐观 pending
  // (按下即展开),counting 只认真实采集(listening)——启动链路(权限弹窗等)
  // 不计入录音时长,pending 期显示静止的 0:00。
  const voiceRecordingTimer = useMobileVoiceRecordingTimer({
    expanded: voiceIsListening || voiceStartPending,
    counting: voiceIsListening,
  });
  const composerEffectiveContentHeight = composerInputContentHeight;
  const voiceDraftShowsListeningPrompt = voiceIsListening && draft.length === 0;
  // 状态行只承载错误信息;「正在听 / 转写中」不再占一行,对齐桌面版——
  // 录音状态由输入框内的语音按钮形态(Mic / 红点计时胶囊 / spinner)表达。
  const voiceStatusVisible = voiceUiAvailable && Boolean(voiceError);
  const nativeShellLayout = useMemo(() => buildSessionNativeShellLayout({
    attachmentPickerOpen: false,
    keyboardHeight: keyboardState.height,
    keyboardVisible: keyboardState.visible,
    paletteOpen: composerTrigger.kind === 'slash' || composerTrigger.kind === 'at',
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    safeAreaBottomInset: insets.bottom,
    screenHeight: windowDimensions.height,
    screenWidth: windowDimensions.width,
  }), [
    composerTrigger.kind,
    insets.bottom,
    keyboardState.height,
    keyboardState.visible,
    windowDimensions.height,
    windowDimensions.width,
  ]);
  const composerTouchLayout = useMemo(() => buildComposerTouchLayout({
    screenWidth: windowDimensions.width,
  }), [windowDimensions.width]);
  // 宽屏导航形态(iPad / 安卓折叠屏与横屏大屏机):左上角三条杠 + 任务列表抽屉,
  // 原地替换当前路由参数切任务;窄屏保持传统返回键。断点与按平台分闸(iOS 仅 iPad,
  // iPhone 不发)见 wideSessionNav.ts。
  const wideSessionNav = useMemo(() => buildWideSessionNavLayout({
    iosPad: Platform.OS === 'ios' && Platform.isPad,
    platform: Platform.OS,
    windowHeight: windowDimensions.height,
    windowWidth: windowDimensions.width,
  }), [windowDimensions.height, windowDimensions.width]);
  const [sessionListDrawerOpen, setSessionListDrawerOpen] = useState(false);
  // 父级镜像 overlay 的真实存续期:打开时立即 true,退场动画完成 + native 子树卸载后的
  // onClosed 才 false。它同时保证退场期 TalkBack 背景隔离,以及旋转/收窄退出宽屏时
  // 不会提前卸载 Drawer 而吞掉 pending 导航。
  const [sessionListDrawerOverlayMounted, setSessionListDrawerOverlayMounted] = useState(false);
  // 退出宽屏后 layout.drawerWidth 会变 0;退场期间继续用最后一个有效宽度,避免面板几何跳变。
  const sessionListDrawerWidthRef = useRef(wideSessionNav.drawerWidth);
  if (wideSessionNav.enabled) sessionListDrawerWidthRef.current = wideSessionNav.drawerWidth;
  // 抽屉里的导航动作必须等退场动画结束、GestureDetector/Reanimated overlay 真正
  // 卸载后再执行。Android 原生 Screen 换页与该子树卸载同帧存在 native crash 竞态。
  const pendingDrawerNavigationRef = useRef<(() => void) | null>(null);
  // pending 只能拦住「首击本身就是导航」的连点;遮罩/back/左滑/当前任务先关闭时 pending
  // 仍为空。closing 从任一关闭入口同步置 true,完整覆盖退场 commit 前的快速二次点击。
  const sessionListDrawerClosingRef = useRef(false);
  // 非导航关闭的焦点归还必须晚于父级 overlayMounted=false commit:否则按钮仍在
  // no-hide-descendants 子树里,VoiceOver/TalkBack 会忽略聚焦并丢失焦点。
  const returnDrawerFocusAfterCloseRef = useRef(false);
  const sessionListButtonRef = useRef<View>(null);
  const closeSessionListDrawer = useCallback(() => {
    if (sessionListDrawerClosingRef.current) return;
    sessionListDrawerClosingRef.current = true;
    setSessionListDrawerOpen(false);
  }, []);
  // 旋转 / 分屏收窄回到窄屏形态时,抽屉没有入口也没有意义,直接关掉。
  useEffect(() => {
    if (!wideSessionNav.enabled && sessionListDrawerOverlayMounted) closeSessionListDrawer();
  }, [closeSessionListDrawer, sessionListDrawerOverlayMounted, wideSessionNav.enabled]);
  // 抽屉打开时由 SessionListDrawer 消费 Android back 并发起关闭;open=false 后该监听会
  // 卸载,但 overlay 仍要退场约 motionDuration.exit。这个窗口临时吞掉 back,避免原生
  // Screen 返回与 GestureDetector/Reanimated 子树卸载再次挤进同一帧。onClosed 提交
  // overlayMounted=false 后自动移除,正常返回链(含 useGuardedBack)随即恢复。
  useEffect(() => {
    if (Platform.OS !== 'android' || !sessionListDrawerOverlayMounted || sessionListDrawerOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [sessionListDrawerOpen, sessionListDrawerOverlayMounted]);
  const openSessionListDrawer = useCallback(() => {
    pendingDrawerNavigationRef.current = null;
    sessionListDrawerClosingRef.current = false;
    returnDrawerFocusAfterCloseRef.current = false;
    Keyboard.dismiss();
    setSessionListDrawerOverlayMounted(true);
    setSessionListDrawerOpen(true);
  }, []);
  const queueDrawerNavigation = useCallback((action: () => void) => {
    // closing 覆盖所有关闭来源,包括 pending 为空的纯关闭;首个意图获胜。
    if (sessionListDrawerClosingRef.current || pendingDrawerNavigationRef.current) return;
    sessionListDrawerClosingRef.current = true;
    pendingDrawerNavigationRef.current = action;
    setSessionListDrawerOpen(false);
  }, []);
  const handleSessionListDrawerClosed = useCallback(() => {
    const action = pendingDrawerNavigationRef.current;
    sessionListDrawerClosingRef.current = false;
    if (!action) returnDrawerFocusAfterCloseRef.current = true;
    setSessionListDrawerOverlayMounted(false);
    if (!action) return;
    pendingDrawerNavigationRef.current = null;
    action();
  }, []);
  useEffect(() => {
    if (sessionListDrawerOverlayMounted || !returnDrawerFocusAfterCloseRef.current) return;
    returnDrawerFocusAfterCloseRef.current = false;
    // 导航型关闭不会登记归还请求;外部导航已让本页失焦时也不抢新屏焦点。
    if (!navigation.isFocused()) return;
    const returnNode = sessionListButtonRef.current ? findNodeHandle(sessionListButtonRef.current) : null;
    if (returnNode != null) AccessibilityInfo.setAccessibilityFocus(returnNode);
  }, [navigation, sessionListDrawerOverlayMounted]);
  const handleDrawerSelectSession = useCallback((item: RemoteSessionListItem) => {
    const targetSession = item.session as RemoteSession;
    if (targetSession.id === sessionId) {
      closeSessionListDrawer();
      return;
    }
    // 可达优先,与首页 openSession 同口径:被认领的 stale 会话优先 canonicalDeviceId,
    // 回退物理 id / store 索引。校验先于关闭动画:失败时保持抽屉打开 + Alert 反馈
    // (文案与首页同键)——先关再弹会让 200ms 后的读屏焦点归还从错误弹窗手里抢焦点,
    // 且抽屉留在原地,用户可直接改选别的任务。
    const targetDeviceId = targetSession.canonicalDeviceId
      ?? targetSession.deviceLinkDeviceId
      ?? remoteSessionStore.getSessionDeviceId(targetSession.id);
    if (!targetDeviceId) {
      Alert.alert(t('devices.list.error.sessionDeviceNotFound'));
      return;
    }
    // 不派发 NativeStack REPLACE:它会创建新 route key 并走 Android 原生 Screen 替换，
    // 上次仅延后到抽屉卸载后仍未消除 crash / 白屏。当前 SessionScreen 已完整支持
    // sessionId 原地换代，replaceParams 保持栈与 native Screen 不动，并整包替换 params
    // 以清掉旧任务的 draft / goal / focus 等一次性参数。
    queueDrawerNavigation(() => {
      // 必须早于 replaceParams：同一同步段先清 A 的附件与在途上传，再让页面看到 B。
      // 否则上传完成回调会经 optionsRef 的最新闭包把 A 的产物追加进 B 的 composer。
      discardAllPendingUploadsForScopeChange();
      discardSessionComposerAttachmentStateRef.current();
      switchDrawerSessionInPlace(navigation, {
        deviceId: targetDeviceId,
        deviceName: targetSession.deviceLinkDeviceName ?? targetDeviceId,
        sessionId: targetSession.id,
      });
    });
  }, [closeSessionListDrawer, navigation, queueDrawerNavigation, sessionId, t]);
  // 前进导航防连点:快速双击「新建」会把 /sessions/new 压栈两层(返回要退两次),
  // 与首页各入口同一把 guardedPush 锁。
  const guardedPush = useGuardedPush();
  const handleDrawerNewSession = useCallback(() => {
    queueDrawerNavigation(() => {
      guardedPush({ pathname: '/sessions/new', params: { deviceId, deviceName } });
    });
  }, [deviceId, deviceName, guardedPush, queueDrawerNavigation]);
  // 抽屉「主页」是显式的去处承诺,不是「返回」:从设备详情/自动化页进来时 back 只退一层,
  // 会落在中间页。dismissTo 沿当前栈一路退到根页,栈里没有根页(深链冷启动)则推入。
  const handleDrawerGoHome = useCallback(() => {
    queueDrawerNavigation(() => router.dismissTo('/'));
  }, [queueDrawerNavigation, router]);
  // 聚焦 / 面板打开 / 语音中呈现卡片形态（输入区全宽 + 底部工具排），其余保持单行简洁态。
  // 注意不看 composerLayout.density：有草稿 / 会话运行中未聚焦时也应收回简洁态，
  // 否则「拖回单行退出激活态」永远收不回去。
  // 语音结束后草稿仍有内容时经 hold 保持展开(一行文字也不收),
  // 不随 voiceIsBusy 归零塌回简洁态。
  const composerVoiceHoldActive = resolveComposerVoiceHoldActive({
    armed: composerVoiceHoldArmed,
    draftText: draft,
  });
  const composerCardActive = (canUseComposer && composerFocused)
    || modelSheetOpen
    || permissionSheetOpen
    || voiceIsBusy
    || composerVoiceHoldActive;
  useComposerCardTransition(composerCardActive);
  const composerChromeHeight = useMemo(() => {
    const statusReserve = voiceStatusVisible
      ? COMPOSER_STATUS_ROW_RESERVED_HEIGHT + COMPOSER_STACK_GAP_HEIGHT
      : 0;
    const rowChrome = composerCardActive
      ? COMPOSER_CARD_ROW_CHROME_HEIGHT
      : COMPOSER_INPUT_ROW_CHROME_HEIGHT;
    return COMPOSER_VERTICAL_PADDING_HEIGHT + statusReserve + rowChrome;
  }, [composerCardActive, voiceStatusVisible]);
  const composerInputMaxContentHeight = useMemo(() => {
    const availableHeight = nativeShellLayout.composerMaxHeight - composerChromeHeight;
    return Math.min(
      COMPOSER_INPUT_MAX_CONTENT_HEIGHT,
      Math.max(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT, availableHeight),
    );
  }, [composerChromeHeight, nativeShellLayout.composerMaxHeight]);
  // 下拉收起 = 退出聚焦激活态(模型浮窗已是独立 Modal,拖拽手势够不到它,无需在此关闭)。
  // 语音结束 hold 态未聚焦,blur 是 no-op,需显式解除 hold 才能收回简洁态。
  const handleComposerSnapToAuto = useCallback(() => {
    setComposerVoiceHoldArmed(false);
    composerInputRef.current?.blur();
  }, []);
  // grabber touch-down 同步关掉外壳滚动(setNativeProps 直改原生属性)。这里
  // 绝不能走 setState:本页 re-render 很重,touch-down 触发渲染会阻塞 JS 线程,
  // 手势 move 事件被合并延后,位移在 PanResponder grant 重置 dx/dy 前全部丢失,
  // 拖拽调高变成「没反应」(实测第一个 move 到达时位移已累计 -180px)。
  const handleGrabberTouchActiveChange = useCallback((active: boolean) => {
    composerScrollViewRef.current?.setNativeProps({
      scrollEnabled: active ? false : composerScrollEnabledRef.current,
    });
  }, []);
  const composerResize = useComposerResize({
    autoMaxContentHeight: composerInputMaxContentHeight,
    // 简洁态一律收到单行(下拉收起和点别处收键盘的结果一致);
    // auto / manual 记忆保留,重新聚焦后恢复。
    collapsed: !composerCardActive,
    composerChromeHeight,
    contentHeight: composerEffectiveContentHeight,
    keyboardHeight: keyboardState.visible ? keyboardState.height : 0,
    onGrabberTouchActiveChange: handleGrabberTouchActiveChange,
    onSnapToAuto: handleComposerSnapToAuto,
    singleLineContentHeight: COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT,
    windowHeight: windowDimensions.height,
  });
  composerResizeDraggingRef.current = composerResize.dragging;
  // manual 高度跨聚焦/失焦、键盘开合保留(用户拖出的高度是显式意图);
  // 唯一自然失效点:草稿清空(发送成功/删光)回 auto,避免空输入框残留定高。
  const composerResizeReset = composerResize.reset;
  useEffect(() => {
    if (draft.length === 0) {
      composerResizeReset();
      // 草稿清空(发送成功/删光)后语音结束 hold 也失去意义,一并解除。
      setComposerVoiceHoldArmed(false);
    }
  }, [draft, composerResizeReset]);
  const composerInputIsMultiline = composerResize.dragging
    || composerResize.mode === 'manual'
    || (draft.length > 0
      && (draft.includes('\n') || composerEffectiveContentHeight > COMPOSER_INPUT_MULTILINE_CONTENT_THRESHOLD));
  const composerInputVisibleHeight = composerResize.visibleContentHeight;
  const composerInputScrollEnabled = composerResize.scrollEnabled;
  const composerShellHasScrollableContent = attachments.length > 0
    || pendingUploads.length > 0
    || attachmentError !== null
    || composerTrigger.kind === 'slash'
    || composerTrigger.kind === 'at';
  // 外壳滚动只在真有可滚内容(附件托盘/附件面板/触发面板)时启用:输入区自增长
  // 本来就被 cap 在容器内,没有附件时启用滚动只会让原生滚动手势与 grabber 拖拽
  // 竞争、吞掉 move 事件。有可滚内容时由 handleGrabberTouchActiveChange 在
  // touch-down 同步关闸(见上),这里只维护声明式的目标值。
  const composerScrollEnabled = nativeShellLayout.composerScrollEnabled
    && !composerResize.dragging
    && composerShellHasScrollableContent;
  composerScrollEnabledRef.current = composerScrollEnabled;
  const handleComposerInputContentSizeChange = useCallback((event: TextInputContentSizeChangeEvent) => {
    const nextHeight = Math.max(
      COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT,
      Math.ceil(event.nativeEvent.contentSize.height),
    );
    setComposerInputContentHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
    ));
  }, []);
  const handleComposerRichInputHeight = useCallback((height: number) => {
    const nextHeight = Math.max(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT, Math.ceil(height));
    setComposerInputContentHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
    ));
  }, []);
  const handleComposerInputPressIn = useCallback(() => {
    if (voiceRecordingActiveRef.current || voiceState === 'listening') {
      finishVoiceRecordingRef.current?.();
    }
  }, [voiceState]);
  const handleVoiceDraftTextLayout = useCallback((event: TextLayoutEvent) => {
    const lines = event.nativeEvent.lines;
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return;
    const nextFrame = {
      left: Math.max(0, Math.round(lastLine.x + lastLine.width + COMPOSER_VOICE_CARET_GAP)),
      top: Math.max(0, Math.round(lastLine.y + ((lastLine.height - COMPOSER_INPUT_LINE_HEIGHT) / 2))),
    };
    setVoiceDraftCaretFrame((currentFrame) => (
      currentFrame.left === nextFrame.left && currentFrame.top === nextFrame.top
        ? currentFrame
        : nextFrame
    ));
  }, []);
  const openSessionMenu = useCallback((view: SessionMenuView = 'menu') => {
    setMenuInitialView(view);
    setSettingsOpen(true);
  }, []);
  const openSessionTreeAfterMenu = useCallback(() => {
    setSessionTreePendingOpen(true);
    setSettingsOpen(false);
  }, []);
  const handleSessionMenuClosed = useCallback(() => {
    if (!sessionTreePendingOpen) return;
    setSessionTreePendingOpen(false);
    setSessionTreeOpen(true);
  }, [sessionTreePendingOpen]);
  const renderComposerResizeHandle = () => (
    <ComposerResizeGrabber
      onAdjust={composerResize.adjustByLine}
      panHandlers={composerResize.panHandlers}
      testID="session.composerResizeGrabber"
      visible
    />
  );
  // 聚焦卡片形态的底部工具排:[+][模型] …… [语音][停止/发送]。
  // + 号打开 Context 面板(附件 / 计划模式 / 目标模式收在面板内);权限模式入口收进会话设置。
  // 权限模式图标钮(2026-07-29 用户裁决,对齐 Codex,与新建页同位同款):
  // 只显示档位图标,不带文字;危险档(auto / bypass)只染图标色。
  const renderSessionPermissionButton = () => {
    const presentation = permissionPresentation(displayPermissionMode, displayPermissionLabel);
    const accent = presentation.accent !== 'neutral'
      ? permissionAccentColor(presentation.accent, colors)
      : null;
    return (
      <RouteActionButton
        accessibilityLabel={t('models.picker.permissionModeAccessibility', { mode: presentation.label })}
        active={permissionSheetOpen}
        disabled={controlBusy || !canUseComposer}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
        onPress={() => {
          setModelSheetOpen(false);
          setPermissionSheetSnap('half');
          setPermissionSheetOpen(true);
        }}
        style={[
          styles.composerInlineToolButton,
          permissionSheetOpen && styles.composerToolButtonActive,
        ]}
        testID="session.permissionIndicator"
      >
        <presentation.Icon
          color={accent ?? colors.textSecondary}
          size={iconSize.sm}
          strokeWidth={iconStroke.regular}
        />
      </RouteActionButton>
    );
  };

  // 工具条布局(对齐 Codex):左 = [+][权限图标][计划 chip];右 = [模型][语音][动作]。
  const renderComposerToolbar = () => (
    <>
      {renderComposerAttachmentButton()}
      {renderSessionPermissionButton()}
      {planModeOn ? (
        <PlanModeChip
          disabled={!canUseComposer || controlBusy || sessionSettingsLocked}
          onExit={() => togglePlanMode(false)}
          testID="session.planModeChip"
        />
      ) : null}
      <ComposerToolbarSpacer />
      {composerRuntimeSummary ? (
        <ComposerRuntimePill
          fastOn={composerPillFastOn}
          label={composerRuntimeLabel}
          leading={agentSwitchIntent ? (
            <MobileAgentMark
              agentKind={agentSwitchIntent.targetAgentKind}
              color={colors.textSecondary}
              size={iconSize.sm}
            />
          ) : composerPillSourceId ? (
            // 正常态显示真正生效来源；断开态显示 DB 中的真实来源并使用状态色，
            // 不静默换成 activeSourceId 的默认回退 Logo。
            <MobileModelIconMark
              color={composerSelectedSourceDisconnected ? colors.statusError : undefined}
              icon={currentSession && composerPillSourceProvider
                ? getModel(composerPillSourceProvider, currentSession.model, sessionAgentKind)?.icon
                : undefined}
              name={composerPillSourceProvider?.name ?? composerPillSourceId}
              providerId={composerPillSourceId}
              routing={composerPillSourceProvider?.routing}
              logoKind={composerPillSourceProvider?.logoKind}
            />
          ) : null}
          onPress={toggleComposerModelPicker}
          testID="session.composerModelButton"
        />
      ) : null}
      {/* 工具排右段顺序:[模型][停止任务][语音占位][发送槽](spacer 已在模型左侧,
          模型右对齐对齐 Codex)。停止任务在语音左边(对齐桌面),语音占位宽度随录音
          胶囊(红点+计时)展开,把停止任务推开——语音右缘与发送槽的邻接关系全程不变。 */}
      {renderComposerInlineStop()}
      {composerVoicePlacement?.inline || composerVoicePlacement?.floating
        ? <ComposerToolbarVoiceSlot width={voiceRecordingTimer.pillWidth} />
        : null}
      {renderComposerSendSlot()}
    </>
  );
  const renderComposerInputOverlay = () => voiceIsListening ? (
    // 「点输入区 = 想打字 → 停止听写」由这层 RN 覆盖层承接。听写期间真正盖在输入区上的
    // 就是它;底下的富文本 WebView 此刻是 hidden(opacity 0),iOS hitTest 会跳过 alpha≈0
    // 的 view,它根本收不到触摸——把停听写挂在 WebView 的 focus / touch 上都不成立
    // (focus 还会被 WKWebView 自己恢复焦点误触发,掐断刚开始的听写)。
    <Pressable
      accessibilityLabel={t('session.common.voiceStopRecording')}
      accessibilityRole="button"
      // onPressIn 给手指「触摸即停」的即时手感;onPress 是无障碍激活(VoiceOver /
      // TalkBack 的 activate 只走 onPress,不会派发 onPressIn)的唯一入口,两者都要挂。
      // handler 幂等:finishVoiceRecording 有 voiceStopInFlight 门,重复调用是 no-op。
      onPress={handleComposerInputPressIn}
      onPressIn={handleComposerInputPressIn}
      style={styles.voiceDraftOverlay}
      testID="session.voiceDraftOverlay"
    >
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
        style={styles.voiceDraftScroll}
      >
        {voiceDraftShowsListeningPrompt ? (
          <View style={styles.voiceDraftListeningPrompt}>
            <VoiceMicWaveCaret color={colors.textPrimary} testID="session.voiceMicCaret" />
            <Text style={styles.voiceDraftListeningText}>{composerLayout.input.placeholder}</Text>
          </View>
        ) : (
          <View style={styles.voiceDraftMeasuredBlock}>
            <Text
              onTextLayout={handleVoiceDraftTextLayout}
              style={styles.voiceDraftText}
            >
              {draft}
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
              <VoiceMicWaveCaret color={colors.textPrimary} testID="session.voiceMicCaret" />
            </View>
          </View>
        )}
      </ScrollView>
    </Pressable>
  ) : null;
  const measureSendButtonTarget = useCallback(() => {
    sendButtonRef.current?.measureInWindow((x, y, width, height) => {
      sendButtonFrameRef.current = { x, y, width, height };
    });
  }, []);
  const isPointInsideSendButton = useCallback((event: GestureResponderEvent) => {
    const frame = sendButtonFrameRef.current;
    if (!composerShowSendButton || !frame || composerLayout.send.disabled || !canUseComposer) return false;
    const { pageX, pageY } = event.nativeEvent;
    const pad = 10;
    return pageX >= frame.x - pad
      && pageX <= frame.x + frame.width + pad
      && pageY >= frame.y - pad
      && pageY <= frame.y + frame.height + pad;
  }, [canUseComposer, composerLayout.send.disabled, composerShowSendButton]);
  const updateVoiceReleaseToSendTarget = useCallback((event: GestureResponderEvent): boolean => {
    const active = voiceLongPressActiveRef.current && isPointInsideSendButton(event);
    setVoiceReleaseToSendActive(active);
    return active;
  }, [isPointInsideSendButton]);
  // Bottom padding the message list needs to clear the composer = the composer's own height only.
  // The keyboard lift is already applied once by the KeyboardAvoidingView (iOS behavior="padding"),
  // so ALSO adding keyboardBottomInset here double-counted the keyboard and shoved the conversation
  // up (badly visible once the list bottom-anchors its content). Keyboard-closed is unchanged —
  // keyboardBottomInset is 0 then, so this matches the previous value.
  const bottomOverlayHeight = useMemo(
    () => Math.ceil(bottomOverlayContentHeight),
    [bottomOverlayContentHeight],
  );

  const applyComposerDocument = useCallback((
    value: ComposerDocument,
    options?: { persist?: boolean },
  ) => {
    composerDocumentRef.current = value;
    setComposerDocumentState(value);
    const projected = composerDocumentProjectedText(value);
    draftRef.current = projected;
    setDraft(projected);
    voiceDictionaryLearningTrackerRef.current?.inspectDraft(projected);
    if (options?.persist !== false) {
      saveComposerDocumentDraft(sessionId, value);
      // Keep the legacy string mirror during the one-way migration window so
      // older builds do not turn a rich draft into an empty composer.
      saveComposerDraft(sessionId, projected);
    }
  }, [sessionId]);

  const applyComposerDraft = useCallback((value: string, options?: { persist?: boolean }) => {
    const document = reconcileComposerProjectedText(composerDocumentRef.current, value);
    applyComposerDocument(document, options);
  }, [applyComposerDocument]);

  const replaceComposerDraft = useCallback((value: string, options?: { persist?: boolean }) => {
    applyComposerDocument(textComposerDocument(value), options);
  }, [applyComposerDocument]);

  const applyRichComposerChange = useCallback((value: ComposerDocument) => {
    applyComposerDocument(value, queueEditingRef.current ? { persist: false } : undefined);
  }, [applyComposerDocument]);

  const setComposerDraft = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    // 排队编辑模式下 composer 内容是临时编辑文本,一律不写草稿库(对所有调用方
    // 生效:键入 / 语音 / 面板插入 / send 的乐观清空与失败恢复)。草稿库全程保留
    // 进入编辑前的原草稿,中途导航离开 / 杀进程后恢复的是用户自己的未发送草稿
    // (PR#709 review P1);退出编辑时 cancelQueueEdit 先清 ref 再回填 stash,
    // 那一拍恢复正常持久化,草稿库与内存重新对齐。
    applyComposerDraft(value, queueEditingRef.current ? { persist: false } : undefined);
  }, [applyComposerDraft]);

  // 听写期间只滚动覆盖层跟随最新文字,**不碰隐藏编辑器的 caret**(2026-07-28):
  // 旧实现每段转写都把选区挪到末尾,而富文本编辑器的选区操作底层是 WebView
  // 程序化 focus,配合 keyboardDisplayRequiresUserAction={false} 会在点语音的
  // 同时弹出软键盘。#551 之前这个 focus 表现为「听写刚开始就被掐断」(focus 即
  // 停听写),#551 修掉掐断后它幸存为弹键盘。听写中输入框本就隐藏(覆盖层渲染
  // 草稿),caret 无意义;落焦统一放在听写结束点(finishVoiceRecording)。
  useEffect(() => {
    if (!voiceIsListening) return undefined;
    const frame = requestAnimationFrame(() => {
      voiceDraftScrollRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerInputContentHeight, composerInputVisibleHeight, draft, voiceIsListening]);

  useEffect(() => {
    if (voiceIsListening && draft.length > 0) return;
    setVoiceDraftCaretFrame({ left: 0, top: 0 });
  }, [draft.length, voiceIsListening]);

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
  const extraDirBrowser = useMemo<SessionExtraDirBrowserState | null>(() => {
    if (!currentSession || currentSession.workspaceKind !== 'project') return null;
    return {
      entries: extraDirBrowseEntries,
      error: extraDirBrowseError,
      loading: extraDirBrowseLoading,
      open: extraDirBrowseOpen,
      parent: extraDirBrowseParent,
      path: extraDirBrowsePath,
    };
  }, [
    currentSession,
    extraDirBrowseEntries,
    extraDirBrowseError,
    extraDirBrowseLoading,
    extraDirBrowseOpen,
    extraDirBrowseParent,
    extraDirBrowsePath,
  ]);

  // 切会话时清掉上一个会话的排队交互态。
  //
  // 必须跳过首次挂载(实测 P1):React 的提交顺序是「先所有 layout effect,再所有 effect」,
  // 而 settling 的 vanish 检测是 layout effect —— 首帧它已经先记下「进入会话时队列长什么
  // 样」,这里紧接着把落定基线擦成空,首条消息被 drain 时就拿 [] 比 [],判不出
  // 「落定中」,排队气泡凭空消失只剩「正在同步」骨架(新建会话 100% 命中:进入会话页时首条
  // 消息就在队列里;打开已有会话时队列本就是空的,所以看不出来)。
  // 真正切会话才需要清:那时旧会话的队列快照对新会话没有意义。
  const resetForSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (resetForSessionIdRef.current === sessionId) return;
    resetForSessionIdRef.current = sessionId;
    setSettingsOpen(false);
    setQueueSelectedClientId(null);
    // ref 与 state 同步清:解锁已由下方 cleanup effect(旧 sessionId 闭包)在本
    // effect body 之前完成,这里再清 ref 是幂等的,保证两者时刻一致。
    queueEditingRef.current = null;
    setQueueEditing(null);
    setSettlingQueueItems(() => EMPTY_SETTLING_ITEMS);
    settlingAddedAtRef.current.clear();
    setSettlingBaseline({ ...EMPTY_SETTLING_BASELINE, sessionId });
    setLocallyRemovedQueueClientIds(new Set());
  }, [sessionId]);

  // 切会话 / 卸载时收尾上一个会话的排队编辑态:cleanup 闭包持旧 sessionId,
  // best-effort 解锁 + 回收编辑期新增附件(失败无碍,条目被消费/删除时桌面端会
  // 自行清锁)。草稿是 per-session 的,stash 不跨会话恢复;编辑文本从未写入草稿
  // 库(见 setComposerDraft 的编辑态 persist:false),原草稿天然保留。回收函数
  // 声明在组件后段,经 ref 引用避免 TDZ。
  useEffect(() => () => {
    const editing = queueEditingRef.current;
    if (editing) {
      queueEditingRef.current = null;
      const currentLockOwner = queueEditLockOwnerRef.current;
      const idleLockOwner = currentLockOwner?.clientId === editing.clientId
        ? currentLockOwner
        : null;
      const currentSaveOwner = queueEditSaveOwnerRef.current;
      const saveLockOwner = currentSaveOwner?.clientId === editing.clientId
        ? currentSaveOwner
        : null;
      const lockOwner = saveLockOwner ?? idleLockOwner;
      if (idleLockOwner) queueEditLockOwnerRef.current = null;
      if (saveLockOwner) queueEditSaveOwnerRef.current = null;
      // 保存(update-content)在途时,解锁与附件回收都不抢跑:解锁超车会让桌面端
      // 用旧内容抢先派发该行;立即回收则可能删掉桌面端正在物化的 OSS 对象,保存
      // 成功却拿到残缺附件(review P2 两条)。统一排到保存落定之后——保存成功时
      // 这些附件已属于队列条目(id 相同,回收自动跳过)且 OSS 对象已被物化消费,
      // 回收是 no-op;失败时才真正清理。附件快照在此刻捕获:落定回调执行时
      // attachmentsRef 可能已属于新会话。
      const inFlightSave = queueEditSaveInFlightRef.current;
      const scopeExitSnapshot = queueEditScopeExitAttachmentsRef.current;
      if (scopeExitSnapshot?.clientId === editing.clientId) {
        queueEditScopeExitAttachmentsRef.current = null;
      }
      const attachmentsSnapshot = scopeExitSnapshot?.clientId === editing.clientId
        ? scopeExitSnapshot.attachments
        : [...attachmentsRef.current];
      // ref 会在 B 的 effect 中更新成 B session 的实现；延迟回调必须捕获 A 的
      // 资源回收函数值，否则保存落定后会拿 B 的 pendingQueue 判断 A 的附件归属。
      // 这里只回收 A 的附件快照：A 的 pending uploads 已由 replaceParams 前的
      // scope-change 封口清掉，迟到 finalize 绝不能再碰组件级 controller 或 B state。
      const discardQueueEditTransientAttachmentResources =
        discardQueueEditTransientAttachmentResourcesRef.current;
      const finalize = () => {
        discardQueueEditTransientAttachmentResources?.(editing, attachmentsSnapshot);
      };
      if (lockOwner) void releaseQueueEditLockAfter(lockOwner, inFlightSave).catch(() => undefined);
      if (inFlightSave) void inFlightSave.then(finalize, finalize);
      else finalize();
      // 托盘不是 per-session 状态：编辑中切会话时既不能让队列条目的 files 跟进
      // 新任务，也不能把 A 的 stash 恢复到 B。A 的两批附件由统一换代入口回收，
      // 这里仅保持共享托盘为空。
      attachmentsRef.current = [];
      setAttachments([]);
    }
  }, [sessionId]);

  useEffect(() => {
    if (canUseComposer) return;
    setModelSheetOpen(false);
    setPermissionSheetOpen(false);
  }, [canUseComposer]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') void flushComposerDraftWrites();
    });
    return () => {
      subscription.remove();
      void flushComposerDraftWrites();
    };
  }, []);

  useEffect(() => {
    extraDirBrowseSeqRef.current += 1;
    setExtraDirBrowseOpen(false);
    setExtraDirBrowsePath('');
    setExtraDirBrowseParent(null);
    setExtraDirBrowseEntries([]);
    setExtraDirBrowseLoading(false);
    setExtraDirBrowseError(null);
  }, [sessionId]);

  useEffect(() => {
    if (sessionOperationLayout.messageHistoryMode !== 'collapsed') {
      setPendingHistoryExpanded(false);
    }
  }, [sessionId, sessionOperationLayout.messageHistoryMode]);

  useEffect(() => {
    if (!composerShowSendButton) sendButtonFrameRef.current = null;
  }, [composerShowSendButton]);

  useEffect(() => {
    const key = activeComposerDraftScopeKey;
    if (appliedRouteDraftRef.current === key) return;
    appliedRouteDraftRef.current = key;
    setComposerDraftHydrated(false);
    let cancelled = false;
    const immediateScope = readImmediateComposerDraftScope(sessionId, routeDraft);
    const immediateQuotes = immediateScope.quotes;
    const immediateDocument = immediateScope.document;
    const immediateOrdered = immediateScope.ordered;
    applyComposerDocument(immediateDocument, { persist: false });
    const immediateDocumentSnapshot = immediateDocument;
    // Synchronously consumed quote-store items are already in the first paint.
    // Clear them before the async hydration window so a concurrent user edit
    // cannot append the same quote a second time when Promise.all settles.
    if (immediateQuotes.length > 0) clearQuotes(sessionId);
    // Memory is the source of truth once quotes were synchronously consumed.
    // Skipping storage hydration makes it explicit that hydratedQuotes below
    // can only contain cold-start quotes or quotes arriving after this point.
    const quoteHydration = immediateQuotes.length > 0
      ? Promise.resolve()
      : hydrateQuotes(sessionId);

    void Promise.all([
      quoteHydration,
      readComposerDocumentDraft(sessionId),
      readComposerDraft(sessionId),
    ]).then(([, storedDocument, storedDraft]) => {
      if (cancelled || appliedRouteDraftRef.current !== key) return;
      const hydratedQuotes = [...getQuotes(sessionId)];
      const fallbackText = storedDraft ?? routeDraft ?? '';
      const ordered = resolveOrderedQuoteDraft(sessionId, fallbackText, hydratedQuotes);
      let nextDocument: ComposerDocument;
      let hydratedQuotesIncluded = false;
      if (storedDocument) {
        nextDocument = storedDocument;
        for (const quote of immediateQuotes) {
          nextDocument = appendComposerNode(nextDocument, { type: 'quote', quote });
        }
      } else if (immediateQuotes.length > 0) {
        nextDocument = migrateLegacyComposerDraft(
          fallbackText,
          immediateQuotes,
          immediateOrdered?.encodedBody,
        );
      } else {
        nextDocument = migrateLegacyComposerDraft(fallbackText, hydratedQuotes, ordered?.encodedBody);
        hydratedQuotesIncluded = true;
      }
      if (!hydratedQuotesIncluded) {
        for (const quote of hydratedQuotes) {
          nextDocument = appendComposerNode(nextDocument, { type: 'quote', quote });
        }
      }
      // User typing during AsyncStorage hydration wins. Newly arrived quote
      // inbox items are still appended to that live document before clearing.
      if (!composerDocumentsEqual(composerDocumentRef.current, immediateDocumentSnapshot)) {
        nextDocument = composerDocumentRef.current;
        for (const quote of hydratedQuotes) {
          nextDocument = appendComposerNode(nextDocument, { type: 'quote', quote });
        }
      }
      clearQuotes(sessionId);
      applyComposerDocument(nextDocument);
      setComposerDraftHydrated(true);
    });
    return () => {
      cancelled = true;
      void flushComposerDraftWrites(sessionId);
    };
  }, [activeComposerDraftScopeKey, applyComposerDocument, routeDraft, sessionId]);

  useEffect(() => {
    if (!composerDraftHydrated || quotes.length === 0) return;
    let next = composerDocumentRef.current;
    for (const quote of quotes) next = appendComposerNode(next, { type: 'quote', quote });
    clearQuotes(sessionId);
    applyComposerDocument(next, queueEditingRef.current ? { persist: false } : undefined);
  }, [applyComposerDocument, composerDraftHydrated, quotes, sessionId]);

  // 点选意图的有效性跟随草稿前缀与会话:一旦草稿不再以点选的 `/name` 开头
  // (清空、整段替换、改名)或切换了会话,点选立即作废——覆盖「清稿/替换后手输
  // /learn 被旧点选绑架」与「跨会话残留」两类误让行(review P1/P2)。
  // 在 `/name` 后继续追加参数属于同一次点选的自然延续,保留。
  useEffect(() => {
    const pending = pendingSkillSelectionRef.current;
    if (!pending) return;
    if (pending.sid !== sessionId) {
      pendingSkillSelectionRef.current = null;
      return;
    }
    const head = /^\/([a-z][\w-]*)/i.exec(draft.trimStart());
    if (!head || head[1].toLowerCase() !== pending.name.toLowerCase()) {
      pendingSkillSelectionRef.current = null;
    }
  }, [draft, sessionId]);

  useEffect(() => {
    if (!canUseComposer || composerTrigger.kind !== 'slash' || !currentSession || !deviceId) {
      slashLoadSeqRef.current += 1;
      setSlashCommands([]);
      setSlashPaletteLoading(false);
      setSlashPaletteError(null);
      return;
    }
    // palette 重新打开:之前的点选意图作废,以本次新选择为准。
    pendingSkillSelectionRef.current = null;
    const seq = ++slashLoadSeqRef.current;
    const agentKind = agentKindForSession(currentSession);
    const paletteCacheKey = buildComposerPaletteCacheKey(deviceId, agentKind, currentSession.workingDir ?? '');
    const cachedCommands = readSlashCommandCache(paletteCacheKey);
    if (cachedCommands) {
      // 任意年龄的缓存先画(重开面板不闪 spinner),后台静默刷新覆盖(规则 7)。
      // loading 必须同时清掉:上一轮无缓存请求可能把它置了 true 还没回来(如切会话 /
      // 切 workdir 时面板未关),不清的话 ComposerPaletteFrame 的 spinner 会盖住刚画的缓存行。
      setSlashCommands([...cachedCommands]);
      setSlashPaletteLoading(false);
    } else {
      setSlashPaletteLoading(true);
    }
    setSlashPaletteError(null);
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      const [builtins, skills, desktop] = await Promise.all([
        maker.listAgentCommands(agentKind),
        maker.listAgentSkills(agentKind, {
          ...(currentSession.workingDir ? { workingDir: currentSession.workingDir } : {}),
          forceReload: false,
        }),
        // desktop 命令是 additive 展示(白名单分流不依赖此清单,清单只参与同名 skill
        // 让行仲裁,见 desktopSlashCommands):拉取失败(含老被控端无此通道)静默降级
        // 为不展示,不能拖垮 builtin/skill 两路。
        maker.listDesktopCommands().catch(
          () => ({ success: false } satisfies MobileDesktopCommandListResult),
        ),
      ]);
      return { builtins, skills, desktop };
    })
      .then(({ builtins, skills, desktop }) => {
        if (slashLoadSeqRef.current !== seq) return;
        const builtinCommands = builtins.success && Array.isArray(builtins.commands)
          ? builtins.commands
          : [];
        const skillCommands = skills.success && Array.isArray(skills.skills)
          ? skills.skills
          : [];
        const desktopCommands = desktop.success && Array.isArray(desktop.commands)
          ? filterMobileDesktopCommands(desktop.commands)
          : [];
        const merged = mergeSlashCommands(builtinCommands, skillCommands, desktopCommands);
        // 刷新失败(整体或部分)且缓存已画:保留缓存行、不置 error——
        // ComposerPaletteFrame 的 errorText 渲染在 children 之前,会把刚画的缓存
        // 整体盖住,可用面板被错误文案顶掉正是本 PR 要消除的体验(codex review R18)。
        const partialError = !builtins.success ? (builtins.error ?? 'slash command list failed')
          : !skills.success ? (skills.error ?? 'skill list failed')
            : null;
        if (!partialError) {
          setSlashCommands(merged);
          // desktop 命令(kind === 'desktop')不写入共享缓存:缓存被 new.tsx 等
          // 没有 desktop 命令分流逻辑的页面共读,写入会导致它们展示 /learn 但发送
          // 时走普通文本透传给 agent(静默失效)。
          writeSlashCommandCache(paletteCacheKey, merged.filter((c) => c.kind !== 'desktop'));
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
  }, [canUseComposer, composerTrigger.kind, currentSession, deviceId, maker, openLink]);

  useEffect(() => {
    if (!canUseComposer || composerTrigger.kind !== 'at' || !currentSession?.workingDir || !deviceId) {
      atLoadSeqRef.current += 1;
      setAtResources([]);
      setAtPaletteLoading(false);
      setAtPaletteError(null);
      setAtResourcesTruncated(false);
      return;
    }
    // 旧行为是把 query 透传远端逐键扫描(每键一次 device-link 往返)。本地渲染层已有
    // filterAtResources 打分过滤,远端逐键只在结果被 cap 截断时才有增量价值,所以:
    //   - 打开面板拉一次全量并写缓存;全量未截断 → 逐键纯本地过滤,零远端流量;
    //   - 截断仓库 → 先画缓存,query 变化 debounce 后带 query 补搜(不进缓存);
    //   - TTL 内重开面板直接命中缓存不重拉。
    const agentKind = agentKindForSession(currentSession);
    const paletteCacheKey = buildComposerPaletteCacheKey(deviceId, agentKind, currentSession.workingDir);
    const query = composerTrigger.query.trim();
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
        await openLink(deviceId);
        return maker.scanAtResources(agentKind, {
          workingDir: currentSession.workingDir!,
          cap: 2000,
          query: remoteQuery,
        });
      })
        .then((result) => {
          if (atLoadSeqRef.current !== seq) return;
          if (!result.success) {
            // 缓存已画时保留旧列表且不置 error——ComposerPaletteFrame 的 errorText
            // 渲染在 children 之前,会把刚画的缓存整体盖住(codex review R18);
            // 无缓存可画才清空并显示错误。
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
          // 只缓存全量扫描;带 query 的截断补搜是局部结果,不能当全量复用。
          if (!remoteQuery) {
            writeAtResourceScanCache(paletteCacheKey, { items, truncated });
            // 首拉即截断且用户已在输入:全量结果对该 query 的本地过滤不完整,而
            // effect 依赖不含缓存写入、不会自动重跑,这里立即链式补搜一次(不进缓存)。
            if (truncated && query) {
              void withTransientRemoteRetry(async () => {
                await openLink(deviceId);
                return maker.scanAtResources(agentKind, {
                  workingDir: currentSession.workingDir!,
                  cap: 2000,
                  query,
                });
              })
                .then((followup) => {
                  if (atLoadSeqRef.current !== seq) return;
                  if (!followup.success) return; // 补搜失败保留全量结果,不降级
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
  }, [canUseComposer, composerTrigger, currentSession, deviceId, maker, openLink]);

  useEffect(() => {
    if (!currentAgentKind || !deviceId) {
      capabilitiesLoadSeqRef.current += 1;
      setCapabilities(null);
      setCapabilitiesLoading(false);
      setCapabilitiesError(null);
      return;
    }
    const seq = ++capabilitiesLoadSeqRef.current;
    let cancelled = false;
    // 能力表按 (设备, agent) 基本不变:缓存命中先画(选择器立即可用、不闪「正在读取
    // 远程运行能力」),后台静默刷新覆盖;miss 才走 loading 态。
    const capabilitiesCacheKey = buildAgentCapabilitiesCacheKey(deviceId, currentAgentKind);
    const generation = getAgentCapabilitiesGeneration(deviceId);
    const unsubscribe = subscribeAgentCapabilities(deviceId, currentAgentKind, (next) => {
      if (cancelled) return;
      setCapabilities(next);
      setCapabilitiesLoading(false);
      setCapabilitiesError(null);
    });
    const cachedCapabilities = getCachedAgentCapabilities(capabilitiesCacheKey);
    if (cachedCapabilities) {
      setCapabilities(cachedCapabilities);
      setCapabilitiesLoading(false);
    } else {
      setCapabilitiesLoading(true);
    }
    setCapabilitiesError(null);
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      return maker.getCapabilities(currentAgentKind);
    })
      .then((result) => {
        if (capabilitiesLoadSeqRef.current !== seq) return;
        const normalized = normalizeMobileAgentCapabilities(result);
        if (normalized) {
          // state 只经当前代际 commit 的订阅通知更新；revision 前旧请求晚到不会覆盖新快照。
          commitAgentCapabilities(deviceId, currentAgentKind, generation, normalized);
        } else {
          if (!isAgentCapabilitiesGenerationCurrent(deviceId, generation)) return;
          if (!cachedCapabilities) setCapabilities(null);
          setCapabilitiesError(t('session.common.capabilitiesUnsupported'));
        }
      })
      .catch((err) => {
        if (capabilitiesLoadSeqRef.current !== seq) return;
        if (!isAgentCapabilitiesGenerationCurrent(deviceId, generation)) return;
        // 缓存已画时保留旧能力表,只报错——静默刷新失败不该把可用面板打回空白。
        if (!cachedCapabilities) setCapabilities(null);
        setCapabilitiesError(formatRemoteError(err));
      })
      .finally(() => {
        if (
          capabilitiesLoadSeqRef.current === seq
          && isAgentCapabilitiesGenerationCurrent(deviceId, generation)
        ) setCapabilitiesLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentAgentKind, deviceId, maker, openLink]);

  useEffect(() => {
    if (
      !deviceId
      || !currentSession
      || !capabilities
      || agentSwitchIntent === null
      || supportsMobileSessionAgentSwitch(currentSession, capabilities)
    ) return;
    // 被控端降级到旧版本，或该行后来变成 SSH / Orca 时，不保留本机缓存里的
    // 旧 pending 展示；这些场景没有合法的权威查询 / 应用入口。
    remoteSessionStore.applySessionPatch(deviceId, sessionId, { agentSwitchIntent: null });
  }, [agentSwitchIntent, capabilities, currentSession, deviceId, sessionId]);

  useEffect(() => {
    if (!deviceId || !sessionAgentSwitchSupported) {
      alternateCapabilitiesLoadSeqRef.current += 1;
      setAlternateCapabilities(null);
      setAlternateCapabilitiesAgentKind(null);
      setAlternateCapabilitiesLoading(false);
      setAlternateCapabilitiesError(null);
      return;
    }
    // 三 Agent 不能再用“当前 / 另一侧”的二元缓存。面板打开时跟随正在浏览的
    // agent；面板关闭但已有 pending intent 时继续保有目标 agent 的能力快照。
    const targetAgentKind = modelSheetOpen && modelSheetAgentKind !== sessionAgentKind
      ? modelSheetAgentKind
      : agentSwitchIntent?.targetAgentKind !== sessionAgentKind
        ? agentSwitchIntent?.targetAgentKind ?? null
        : null;
    if (!targetAgentKind) {
      alternateCapabilitiesLoadSeqRef.current += 1;
      setAlternateCapabilities(null);
      setAlternateCapabilitiesAgentKind(null);
      setAlternateCapabilitiesLoading(false);
      setAlternateCapabilitiesError(null);
      return;
    }
    const seq = ++alternateCapabilitiesLoadSeqRef.current;
    let cancelled = false;
    setAlternateCapabilitiesAgentKind(targetAgentKind);
    // 跨 Agent 面板打开前就静默预取另一侧能力；缓存命中时当帧可浏览，miss 才显示
    // loading。与当前 Agent 共用同一代际缓存，登出 / device revision 后不会复活旧快照。
    const cacheKey = buildAgentCapabilitiesCacheKey(deviceId, targetAgentKind);
    const generation = getAgentCapabilitiesGeneration(deviceId);
    const unsubscribe = subscribeAgentCapabilities(deviceId, targetAgentKind, (next) => {
      if (cancelled) return;
      setAlternateCapabilitiesAgentKind(targetAgentKind);
      setAlternateCapabilities(next);
      setAlternateCapabilitiesLoading(false);
      setAlternateCapabilitiesError(null);
    });
    const cached = getCachedAgentCapabilities(cacheKey);
    if (cached) {
      setAlternateCapabilities(cached);
      setAlternateCapabilitiesLoading(false);
    } else {
      setAlternateCapabilities(null);
      setAlternateCapabilitiesLoading(true);
    }
    setAlternateCapabilitiesError(null);
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      return maker.getCapabilities(targetAgentKind);
    })
      .then((result) => {
        if (alternateCapabilitiesLoadSeqRef.current !== seq) return;
        const normalized = normalizeMobileAgentCapabilities(result);
        if (normalized) {
          commitAgentCapabilities(deviceId, targetAgentKind, generation, normalized);
        } else {
          if (!isAgentCapabilitiesGenerationCurrent(deviceId, generation)) return;
          if (!cached) setAlternateCapabilities(null);
          setAlternateCapabilitiesError(t('session.common.capabilitiesUnsupported'));
        }
      })
      .catch((err) => {
        if (alternateCapabilitiesLoadSeqRef.current !== seq) return;
        if (!isAgentCapabilitiesGenerationCurrent(deviceId, generation)) return;
        if (!cached) setAlternateCapabilities(null);
        setAlternateCapabilitiesError(formatRemoteError(err));
      })
      .finally(() => {
        if (
          alternateCapabilitiesLoadSeqRef.current === seq
          && isAgentCapabilitiesGenerationCurrent(deviceId, generation)
        ) setAlternateCapabilitiesLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    agentSwitchIntent?.targetAgentKind,
    deviceId,
    maker,
    modelSheetAgentKind,
    modelSheetOpen,
    openLink,
    sessionAgentKind,
    sessionAgentSwitchSupported,
  ]);

  useEffect(() => {
    if (!deviceId || !sessionAgentSwitchSupported) {
      agentSwitchIntentLoadSeqRef.current += 1;
      return;
    }
    const seq = ++agentSwitchIntentLoadSeqRef.current;
    let cancelled = false;
    // intent 活在 desktop main 内存，不属于 SQLite session 行。进入页面、重连以及
    // getSession 全量对账完成后都回读一次，修复断线期间其它控制端的改选 / 取消。
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      return maker.getSessionAgentSwitchIntent(sessionId);
    })
      .then((result) => {
        if (cancelled || agentSwitchIntentLoadSeqRef.current !== seq) return;
        remoteSessionStore.applySessionPatch(deviceId, sessionId, {
          agentSwitchIntent: normalizeSessionAgentSwitchIntent(result),
        });
      })
      .catch((err) => {
        // intent 是增强态；短暂离线保留现有镜像，下一连接 epoch / sync 尾自动补读。
        // 落一条 debug:区分不了「瞬时离线可自愈」与「sessionId 非法 / 协议不匹配」等永久性
        // 错误,后者会让镜像长期过期到下次重连才补读——留痕便于排查 device-link 兼容回归。
        console.debug('[agent-switch] getSessionAgentSwitchIntent 读回失败,保留现有镜像', err);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionEpoch, deviceId, lastSyncedAt, maker, openLink, sessionAgentSwitchSupported, sessionId]);

  const syncSession = useCallback(async (syncRun: Pick<RemoteSyncRun, 'isStale' | 'replaceMessages'>) => {
    const options = { replaceMessages: syncRun.replaceMessages };
    if (!deviceId || !sessionId || syncRun.isStale()) return;
    // 新建会话乐观管线在途(running / create-failed):被控端可能还没有这个会话,
    // getSession 会 NOT_FOUND 报错横幅。统一在这里挡掉全部 load 触发点;管线完成
    // (task 移除)后由下方 effect 触发一轮真正的同步。
    if (shouldBlockSessionSync(sessionId)) {
      if (!syncRun.isStale()) setLoading(false);
      return;
    }
    // 已读回执门槛的 epoch 必须在 sync **开始**时捕获:重连时 connectionEpoch 先行推进,
    // 旧连接代的 in-flight load 若在尾部读 ref 的最新值,会把旧窗口数据标成新代已同步,
    // 抢在排队的 resync 之前放行回执。开始时捕获则旧 load 落的是旧代 key,门槛不放行。
    const readAckEpochAtStart = readAckEpochRef.current;
    // 门槛代号同理在开始时捕获:切会话 / attention 上升沿会递增代号,启动更早的
    // in-flight load 在尾部发现代号已变,放弃落 key(它的数据不含触发点之后的内容)。
    const readAckGateGenAtStart = readAckGateGenRef.current;
    // 重开判定:store 已有该会话消息 + currentSession(返回再点进,内存没清)→ 走"廉价校验、按
    // updatedAt/_count/消息窗口同步标记决定是否重拉消息";首开(store 无消息)保持 A1 全量并行不回退;
    // replaceMessages(rewind 提交)强制整窗替换。imperative 读 store,避免给 syncSession 加 deps。
    const storedMessagesAtStart = remoteSessionStore.getMessages(sessionId);
    const storedSessionAtStart = remoteSessionStore.getSessions().find((item) => item.id === sessionId) ?? null;
    const isReopen = !options.replaceMessages
      && storedMessagesAtStart.length > 0
      && storedSessionAtStart !== null;
    const openAndSubscribe = async () => {
      await openLink(deviceId);
      // subscribe 只负责之后的实时推送,不该挡数据读;失败不影响 open,重连 rehydration 会补订阅。
      void subscribe(`session:${sessionId}`, deviceId, ['sessions']).catch(() => undefined);
    };
    const fetchActiveSessionSnapshot = async () => {
      // Capture immediately before every request. Because this helper is invoked inside
      // withTransientRemoteRetry, each retry receives a fresh fence as well.
      const activityEpochAtFetchStart = remoteSessionStore.captureActiveSessionSnapshotEpoch();
      const activeSessions = await maker.listActiveSessions().catch(() => []);
      return { activeSessions, activityEpochAtFetchStart };
    };
    const fetchProjection = async () => {
      // Capture immediately before every request. Because this helper is invoked inside
      // withTransientRemoteRetry, each retry receives a fresh projection authority fence.
      const authorityEpochAtStart =
        remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
      const projection = await maker.input.getProjection(sessionId);
      return { projection, authorityEpochAtStart };
    };
    if (syncRun.isStale()) return;
    setLoading(true);
    setError(null);
    try {
      if (!isReopen) {
        // 首开 / 强制替换:A1 全量并行(含整窗 listMessages),不回退。
        const [sessionMeta, history, pendingInteractions, projectionResult, activeSessionSnapshot] = await withTransientRemoteRetry(async () => {
          await openAndSubscribe();
          return Promise.all([
            maker.getSession(sessionId),
            listMessagesWithPayloadRetry((limit) => maker.listMessages(sessionId, { limit })),
            maker.getPendingInteractions(sessionId),
            fetchProjection(),
            fetchActiveSessionSnapshot(),
          ]);
        });
        if (syncRun.isStale()) return;
        remoteSessionStore.upsertDeviceSession(deviceId, deviceName, sessionMeta);
        remoteSessionStore.setActiveSessionSnapshots(
          deviceId,
          Array.isArray(activeSessionSnapshot.activeSessions)
            ? activeSessionSnapshot.activeSessions
            : [],
          activeSessionSnapshot.activityEpochAtFetchStart,
        );
        const historyPage: RemoteMessage[] = Array.isArray(history.messages) ? history.messages : [];
        // moreBeyondWindow:本页上沿之外服务端还有历史(满页 / 被裁行)。为真时 store 不保留早于
        // 本页的缓存段 —— 它与本页之间可能隔着从未加载的行,保留就是孤岛(#1222)。判据与
        // 「加载更早」入口同源,两者本就该一致。
        const moreBeyondWindow = shouldKeepOlderMessagesAffordance(history);
        if (options.replaceMessages) {
          remoteSessionStore.setMessages(sessionId, historyPage);
        } else {
          remoteSessionStore.setLatestMessageWindow(sessionId, historyPage, { moreBeyondWindow });
        }
        remoteSessionStore.markSessionMessagesSynced(sessionId, sessionMeta);
        setHasOlderMessages(moreBeyondWindow);
        remoteSessionStore.setPendingInteractions(sessionId, Array.isArray(pendingInteractions) ? pendingInteractions : []);
        remoteSessionStore.setInputProjectionIfCurrent(
          sessionId,
          projectionResult.projection,
          projectionResult.authorityEpochAtStart,
        );
      } else {
        // 重开:便宜并行(不含整窗 listMessages)拿 meta + pending + projection + active。
        const [sessionMeta, pendingInteractions, projectionResult, activeSessionSnapshot] = await withTransientRemoteRetry(async () => {
          await openAndSubscribe();
          return Promise.all([
            maker.getSession(sessionId),
            maker.getPendingInteractions(sessionId),
            fetchProjection(),
            fetchActiveSessionSnapshot(),
          ]);
        });
        // 廉价对账:updatedAt 主信号(任何消息变化都会 bump),_count 仅在两侧都有时作辅助;
        // 另外要求消息窗口已被详情页同步到当前 meta,避免首页先刷新 session preview 后,
        // 详情页把旧消息缓存误判成最新。任一变化 → 拉取权威最新窗口并对账;
        // 都没变 → 跳过整窗重拉(内容已是最新,新消息由 live subscribe 推送)。
        const freshCount = sessionMeta._count?.messages;
        const metaChanged = shouldRefreshLatestMessageWindowOnReopen({
          freshSession: sessionMeta,
          messageWindowSynced: remoteSessionStore.isSessionMessageWindowSynced(sessionId, sessionMeta),
          storedSession: storedSessionAtStart,
        });
        if (syncRun.isStale()) return;
        remoteSessionStore.setActiveSessionSnapshots(
          deviceId,
          Array.isArray(activeSessionSnapshot.activeSessions)
            ? activeSessionSnapshot.activeSessions
            : [],
          activeSessionSnapshot.activityEpochAtFetchStart,
        );
        if (metaChanged) {
          const history = await withTransientRemoteRetry(() =>
            listMessagesWithPayloadRetry(
              (limit) => maker.listMessages(sessionId, { limit }),
              REOPEN_MESSAGE_WINDOW_LIMITS,
            ),
          );
          if (syncRun.isStale()) return;
          const historyPage: RemoteMessage[] = Array.isArray(history.messages) ? history.messages : [];
          // 同首开路径:上沿之外还有历史时不保留更早的缓存段(#1222)。
          const moreBeyondWindow = shouldKeepOlderMessagesAffordance(history);
          remoteSessionStore.setLatestMessageWindow(sessionId, historyPage, { moreBeyondWindow });
          remoteSessionStore.markSessionMessagesSynced(sessionId, sessionMeta);
          setHasOlderMessages(moreBeyondWindow);
        } else {
          // 回归修复:没新内容也要补设 hasOlderMessages —— 屏幕重开把该 state 重置为 false,跳过整窗
          // 重拉时若不补设,「加载更早」入口会消失、往上拖刷不出老消息。用服务端总数 vs in-store 已加载
          // 真实消息数推断(getSession 没给总数时退化为窗口启发式)。
          setHasOlderMessages(hasOlderMessagesAfterReopen(freshCount, remoteSessionStore.getMessages(sessionId)));
        }
        remoteSessionStore.upsertDeviceSession(deviceId, deviceName, sessionMeta);
        remoteSessionStore.setPendingInteractions(sessionId, Array.isArray(pendingInteractions) ? pendingInteractions : []);
        remoteSessionStore.setInputProjectionIfCurrent(
          sessionId,
          projectionResult.projection,
          projectionResult.authorityEpochAtStart,
        );
      }
      // 不变量:上面 setHasOlderMessages 的校正(:806/:841/:846)与这里的 setLastSyncedAt 之间必须保持
      // 同步尾、无 await —— 否则乐观点亮 effect(依赖 lastSyncedAt===null)会在 await 间隙把刚校正成 false
      // 的「加载更早」入口重新点亮。将来切勿在两者之间插入 await。
      if (syncRun.isStale()) return;
      setLastSyncedAt(Date.now());
      // 已读回执门槛:本会话在当前连接代完成过整窗同步。sessionId / epoch / 门槛代号
      // 都取 sync 开始时的快照——原地切 session、重连、attention 上升沿之后,启动更早
      // 的 in-flight sync 一律放弃落 key,只有触发点之后启动的 sync 才能重新写开门槛。
      if (readAckGateGenRef.current === readAckGateGenAtStart) {
        setReadAckSyncedKey(`${sessionId}:${readAckEpochAtStart}`);
      }
    } catch (err) {
      if (!syncRun.isStale()) setError(formatRemoteError(err));
    } finally {
      if (!syncRun.isStale()) setLoading(false);
    }
  }, [deviceId, deviceName, maker, openLink, sessionId, subscribe]);
  const requestSync = useRemoteSyncCoordinator(
    (run) => syncSession(run),
    `${deviceId}:${sessionId}`,
  );
  const load = useCallback(
    () => requestSync({ reason: 'passive-refresh' }),
    [requestSync],
  );

  /** 恢复路径里装不下的附件:中转对象回收,不留无人认领的已上传对象。 */
  const discardRecoveredAttachments = (attachments: readonly RemoteSerializedAttachment[]) => {
    for (const attachment of attachments) {
      discardMobileUploadedAttachment(attachment, { getToken: () => auth.getAccessToken() });
    }
  };

  /**
   * 把创建失败交还的附件并入 composer 托盘(enqueue-failed 的两条分支共用一条收尾)。
   *
   * 一条草稿只能带 MOBILE_MAX_ATTACHMENTS 个附件,而恢复的可能是 N 条消息的附件之和,
   * 溢出无法避免。取舍顺序:**托盘里已有的**(用户正拿着、屏幕上看得见)> 首条消息 >
   * 后续消息;溢出的回收中转对象 + 明确告知。两条铁律(review P1 收敛检查点):
   *  - 不静默丢:装不下就说出来,绝不无声消失;
   *  - 不删活的:discard 只会落在没进托盘的附件上,不碰用户正在编辑的东西。
   */
  const adoptRecoveredAttachments = (
    firstMessageAttachments: readonly RemoteSerializedAttachment[],
    followUps: readonly MobileOutboxItem[],
  ) => {
    const followUpAttachments = followUps.flatMap(outboxItemAttachments);
    if (firstMessageAttachments.length === 0 && followUpAttachments.length === 0) return;
    const withFirst = mergeAttachmentsWithinLimit(attachmentsRef.current, firstMessageAttachments);
    const withFollowUps = mergeAttachmentsWithinLimit(withFirst.merged, followUpAttachments);
    // 托盘缩略图:恢复的图片带上发送时刻记下的本地预览,否则回到托盘退化成无图 chip
    // (内容在、但用户看不出是哪张图)。
    const previewByAttachmentId: Record<string, string> = {};
    for (const item of followUps) {
      item.attachmentSlots.forEach((slot, index) => {
        const previewUri = item.slotMeta[index]?.previewUri;
        if (slot && previewUri) previewByAttachmentId[slot.id] = previewUri;
      });
    }
    if (Object.keys(previewByAttachmentId).length > 0) {
      // 已有映射优先:同 id 的现有预览是用户此刻正看着的那张。
      setAttachmentPreviews((current) => ({ ...previewByAttachmentId, ...current }));
    }
    attachmentsRef.current = withFollowUps.merged;
    setAttachments(withFollowUps.merged);
    const dropped = [...withFirst.dropped, ...withFollowUps.dropped];
    discardRecoveredAttachments(dropped);
    if (dropped.length > 0) {
      setAttachmentError(t('session.screen.attachmentsNotCarriedBack', { count: dropped.length }));
    }
  };

  // 新建会话乐观管线的收口响应:
  //  - running → task 移除(成功):守卫解除,补一轮完整同步(权威 meta / 交互 / projection);
  //  - create-failed:Alert 重试面(重试 = 同 id 重跑管线,幂等安全;返回编辑 = 草稿
  //    stash 回新建页并移除合成行)+ 常驻错误条兜底(Alert 被系统关掉时仍有指引);
  //  - enqueue-failed:会话已建成,首条消息文本 / 附件回填 composer,用户走正常发送
  //    (新桌面有 clientId 幂等去重,重复风险已兜)。
  const creationTask = useNewSessionCreationTask(sessionId);
  const prevCreationStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevCreationStatusRef.current;
    const status = creationTask?.status ?? null;
    prevCreationStatusRef.current = status;
    if (status === prev) return;
    if (status === null) {
      if (prev === 'running') {
        setError(null);
        void load();
      }
      return;
    }
    if (status === 'create-failed') {
      const message = creationTask?.error ?? t('session.screen.createFailedDefault');
      setError(t('session.screen.createFailedNotice', { message }));
      Alert.alert(t('session.screen.createFailedTitle'), message, [
        {
          text: t('session.screen.backToEdit'),
          style: 'cancel',
          onPress: () => {
            if (!creationTask) return;
            void prepareNewSessionCreationForEdit(sessionId)
              .then((prepared) => {
                if (!prepared) return;
                // 创建期间发出的后续消息必须一起带回新建页(review P1):它们此刻在 outbox 里,
                // 而下一行 dismiss 会连同合成会话行一起删掉——会话页 unmount 时 cleanup 会把它们
                // 写进那个已经不存在的会话的草稿,用户在新建页看不到、也再也找不回来。
                // 新建页只有一个首条消息输入框,所以按序拼成文本、附件按 id 去重合并后一起 stash。
                // 上传任务保不住:本页(连同 upload controller)马上要销毁,只能取消
                // 并回收,再把「没能带回多少」告知用户(review P1:静默丢等于偷走内容)。
                const { items: followUps, cancelledUploadCount } = takeOutboxForSession(sessionId, 'cancel');
                if (followUps.length > 0) {
                  const { merged, dropped } = mergeAttachmentsWithinLimit(
                    prepared.attachments,
                    followUps.flatMap(outboxItemAttachments),
                  );
                  // 装不下的中转对象在这里回收:草稿带不走它们,留着就是没人认领的垃圾。
                  discardRecoveredAttachments(dropped);
                  const unrecoveredCount = dropped.length + cancelledUploadCount;
                  stashNewSessionDraftForEdit(prepared, {
                    draft: {
                      ...prepared.draft,
                      firstMessage: [
                        prepared.draft.firstMessage,
                        ...followUps.map(outboxItemDraftText),
                      ].filter(Boolean).join('\n\n'),
                    },
                    attachments: merged,
                    notice: unrecoveredCount > 0
                      ? t('session.screen.attachmentsNotCarriedBack', { count: unrecoveredCount })
                      : null,
                  });
                } else {
                  stashNewSessionDraftForEdit(prepared);
                }
                dismissNewSessionCreation(sessionId, { removeSyntheticRow: true });
                router.replace({ pathname: '/sessions/new', params: { deviceId, deviceName } });
              })
              .catch((err: unknown) => {
                // 补偿回收失败时保留 task + 合成行，绝不先跳回表单再创建第二个孤儿
                // worktree。用户可取消等待连接恢复，或直接复用同 sessionId 重试创建。
                const cleanupError = formatRemoteError(err);
                setError(t('session.screen.createFailedNotice', { message: cleanupError }));
                Alert.alert(t('session.screen.createFailedTitle'), cleanupError, [
                  {
                    text: t('session.common.cancel'),
                    style: 'cancel',
                  },
                  {
                    text: t('session.screen.retry'),
                    onPress: () => {
                      setError(null);
                      retryNewSessionCreation(sessionId);
                    },
                  },
                ]);
              });
          },
        },
        {
          text: t('session.screen.retry'),
          onPress: () => {
            setError(null);
            retryNewSessionCreation(sessionId);
          },
        },
      ]);
      return;
    }
    if (status === 'enqueue-failed') {
      // 首条消息没发出,而创建期间用户可能已经发了后续消息(composer 全程可用)。
      //
      // 「首条回输入框 + 后续留在 outbox」是不可恢复的:重试失败的 outbox 条目会把后续
      // 消息发到首条前面,而重发首条又会追加到失败条目之后被挡住,原始顺序无论怎么操作
      // 都拼不回来(review P1)。所以两者必须一起交回 —— 全部按序合并进同一份草稿,
      // 首条在前,用户重发一次即恢复原顺序。
      // 留在本页:在途 / 失败的上传任务交还托盘,继续跑完就落进附件托盘(review P1)。
      const { items: followUps } = takeOutboxForSession(sessionId, 'release-to-tray');
      if (creationTask) {
        // 等待窗口内用户可能已经打了下一段草稿 / 加了新附件——回填不能覆盖(codex review
        // P2)。文本:首条 + 后续消息按序前置到现有草稿之前(引用块与富文本结构由
        // recoverOutboxItemsToComposerDraft 保留);附件走 adoptRecoveredAttachments。
        const restoredText = creationTask.draft.firstMessage;
        const recoverables: MobileRecoverableDraftItem[] = [
          ...(restoredText
            ? [{
                text: restoredText,
                // draft.firstMessage 是发送文本,可能含产品引用 marker:剥离前后不同即说明有。
                quotesEncoded: stripChatQuoteMarkerLines(restoredText) !== restoredText,
                pastedTextRanges: [],
                slashCommandRanges: [],
                agentReferences: [],
              }]
            : []),
          ...followUps,
        ];
        if (recoverables.length > 0) restoreRecoverableItemsToDraft(sessionId, recoverables);
        adoptRecoveredAttachments(creationTask.attachments, followUps);
      } else if (followUps.length > 0) {
        // task 已被消费(极端竞态):后续消息仍然要回草稿,不能随 outbox 清空蒸发。
        // 附件走同一条收尾(这条分支原先只恢复文本,附件连带丢掉)。
        restoreRecoverableItemsToDraft(sessionId, followUps);
        adoptRecoveredAttachments([], followUps);
      }
      setError(creationTask?.error ?? t('session.screen.firstMessageNotSent'));
      dismissNewSessionCreation(sessionId);
      void load();
    }
  }, [creationTask, deviceId, deviceName, load, router, sessionId, setComposerDraft]);

  // 排队行里该显示「在途转圈」的 clientId:本页 enqueue 在途的条目,加上新建会话
  // 乐观管线仍在跑(create + 首条 enqueue 都还没确认)时的首条消息——它同样是
  // 「已上屏但没确认发出」,不能画排队 icon。
  const sendingQueueBadgeClientIds = useMemo(() => {
    const creationPendingClientId = creationTask?.status === 'running'
      ? creationTask.firstMessageClientId
      : null;
    if (!creationPendingClientId || sendingQueueClientIds.has(creationPendingClientId)) {
      return sendingQueueClientIds;
    }
    return new Set([...sendingQueueClientIds, creationPendingClientId]);
  }, [creationTask, sendingQueueClientIds]);

  // 已读回执:liveActivity **签名变化且 attention=true**(会话开着时新 turn 完成翻
  // 未读,或 attention 一直为 true 但内容更新——新 turn 完成会经 completed→running→
  // completed,签名必变,仅凭 false→true 上升沿会漏)时作废同步门槛并触发一轮 load
  // ——turn 终帧可能在重 topic 上丢失 / 延迟,必须等**变化点之后**完成的同步重新落
  // key(reopen 廉价路径也会经远程 getSession 校验缓存是否已含新内容),回执才基于
  // 「已包含本 turn 内容」的窗口发出。attention 回落不触发(那是回执生效后 relay 推回
  // 的收尾)。放在 load 定义之后:effect 依赖里引用 load,先声明会踩 TDZ。
  const liveActivitySig = useSyncExternalStore(remoteSessionStore.subscribe, () => {
    const activity = remoteSessionStore.getSessionLiveActivity(sessionId);
    if (!activity) return 'none';
    return `${activity.phase}|${activity.attention === true ? 1 : 0}|${activity.compactDetail}`;
  });
  const prevLiveActivitySigRef = useRef<string | null>(null);
  useEffect(() => {
    const prevSig = prevLiveActivitySigRef.current ?? liveActivitySig;
    if (liveAttention && liveActivitySig !== prevSig) {
      setReadAckSyncedKey(null);
      // 代号递增:变化点之前启动的 in-flight load / 在飞重试(数据不含本 turn 终帧)
      // 不得重新落 key / 不得继续发送。
      readAckGateGenRef.current += 1;
      void load();
    }
    prevLiveActivitySigRef.current = liveActivitySig;
  }, [liveActivitySig, liveAttention, load]);

  // 领取其它路由(文件浏览器「发送到会话」等)投递的 composer 附件:会话页在
  // 栈下层保持挂载,返回不会重新 mount,靠 focus 时机领取信箱。
  useFocusEffect(
    useCallback(() => {
      let composerFocusFrame: number | null = null;
      const pending = drainComposerAttachments(sessionId);
      if (pending.length > 0) {
        // 判据与创建失败恢复共用同一个 helper(去重 + 上限 + 溢出显式返回):同一语义
        // 分散实现过三处,其中两处会静默丢弃溢出附件(review 收敛检查点)。
        // 走 ref 而不是 setAttachments 更新器:更新器必须是纯函数,不能顺手把溢出条数
        // 写出来(ref 是本文件既有的同步真源,onUploaded 同样先写 ref 再镜像 state)。
        const { merged, dropped } = mergeAttachmentsWithinLimit(attachmentsRef.current, pending);
        attachmentsRef.current = merged;
        setAttachments(merged);
        // 中转对象的生命周期归投递方(文件浏览器把桌面端文件送进来),这里只负责不静默。
        if (dropped.length > 0) {
          setAttachmentError(t('session.common.maxAttachments', { max: MOBILE_MAX_ATTACHMENTS }));
        }
      }
      // 文件浏览器 lightbox 画笔投递的标注提交:交给标注管线烧录 + 上传进托盘
      // (与聊天 lightbox 直发同链路,annotated 标 / 再编辑真相一致)。
      // handler 就位才 drain(review P1):虽然 ref 在首次 render 就已赋值、focus
      // 回调必然晚于它,但这是脆弱的时序耦合——ref 为空时把信箱留到下次 focus,
      // 提交永不静默丢失。
      const annotationsApi = composerAnnotationsRef.current;
      if (annotationsApi) {
        const submissions = drainComposerAnnotationSubmissions(sessionId);
        if (submissions.length > 0) {
          // 串行逐条 await(review P1):并发 void 发起会让多条提交在各自第一个
          // await 之前同步读到同一份"入队前"剩余槎位数,绕过附件上限;串行后
          // 每条都等前一条真正落定(含槎位占用生效)才开始,不再有这个窗口。
          void (async () => {
            for (const submission of submissions) {
              try {
                await annotationsApi.submitExternalAnnotation(
                  submission.displayUri,
                  submission.strokes,
                  submission.mimeType,
                );
              } catch {
                // 失败(槽满 / 读源失败 / 烧录失败,Alert 已由标注管线弹出)回投
                // 信箱,下次 focus 重试——用户画的笔迹不静默丢(review P1);
                // 回投一次为限,二次失败视为确定性原因放弃(防每次 focus 反复
                // 弹同一个错)。
                const retryCount = (submission.retryCount ?? 0) + 1;
                if (retryCount < 2) {
                  queueComposerAnnotationSubmission(sessionId, { ...submission, retryCount });
                }
              }
            }
          })();
        }
      }
      if (
        canUseComposer
        && routeFocusComposerRequestKey
        && appliedRouteComposerFocusKeyRef.current !== routeFocusComposerRequestKey
      ) {
        appliedRouteComposerFocusKeyRef.current = routeFocusComposerRequestKey;
        composerFocusFrame = requestAnimationFrame(() => composerInputRef.current?.focus());
      }
      return () => {
        if (composerFocusFrame !== null) cancelAnimationFrame(composerFocusFrame);
      };
    }, [canUseComposer, routeFocusComposerRequestKey, sessionId]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!deviceId || !sessionId) return undefined;
      return startFocusedTopicSubscription({
        deviceId,
        owner: `session:${sessionId}`,
        subscribe,
        topic: `session:${sessionId}`,
        unsubscribe,
      });
    }, [deviceId, sessionId, subscribe, unsubscribe]),
  );

  useEffect(() => {
    void load();
    return () => {
      void unsubscribe(`session:${sessionId}`, deviceId, ['sessions', `session:${sessionId}`]).catch(() => undefined);
    };
  }, [deviceId, load, sessionId, unsubscribe]);

  // 乐观点亮「加载更早」入口:缓存消息 hydrate 后(messages 已有内容),不等首开那次慢 listMessages(A1,
  // device-link 往返可能数秒)回来,就用已存 session 的 _count.messages 与 in-store 已加载真实条数比较,
  // 立即让入口可见,避免"先拉没反应、慢拉取回来才出现入口、再拉才加载"。仅在本次打开尚未同步过
  // (lastSyncedAt 为空)、入口当前不可见、且 _count 已知且 > 已加载时乐观置 true;A1 / reopen 回来后仍按
  // shouldKeepOlderMessagesAffordance / hasOlderMessagesAfterReopen 校正(:806/:846)。_count 未知不凭空点亮。
  useEffect(() => {
    if (lastSyncedAt !== null || hasOlderMessages || messages.length === 0) return;
    if (hasOlderMessagesByServerCount(currentSession?._count?.messages, messages)) {
      setHasOlderMessages(true);
    }
  }, [currentSession?._count?.messages, hasOlderMessages, lastSyncedAt, messages]);

  // 在线时按 connectionEpoch 去重:每个连接 epoch 只 resync 一次。首开同步由上面的 mount effect 负责
  // (此处 epoch == 初值 → skip);仅在 epoch 变化(真正重连 / 回前台 connectNow→online)时再 resync,
  // 消掉正常首开里 connecting→online + 首次 rehydrate 把 load() 连打多次造成的"开会话跳几次"。
  useEffect(() => {
    if (status !== 'online') return;
    if (syncedConnectionEpochRef.current === connectionEpoch) return;
    syncedConnectionEpochRef.current = connectionEpoch;
    void load();
  }, [connectionEpoch, load, status]);

  useEffect(() => {
    if (!lastPresenceSnapshot || lastPresenceSnapshot.deviceId !== deviceId) return;
    const available = lastPresenceSnapshot.online && lastPresenceSnapshot.remoteControlEnabled;
    const wasAvailable = targetAvailableRef.current;
    targetAvailableRef.current = available;
    if (available && wasAvailable === false && status === 'online') void load();
  }, [deviceId, lastPresenceSnapshot, load, status]);

  useEffect(() => {
    if (currentSession || !deviceId || !sessionId || loading || status !== 'online') return;
    const timer = setTimeout(() => {
      void load();
    }, 1500);
    return () => clearTimeout(timer);
  }, [currentSession, deviceId, load, loading, sessionId, status]);

  // 熔断恢复沿补全量同步(review P1):connectionError 已按陈旧过滤,恢复后为
  // null,下面按 error 驱动的自动重试不会再触发;而探测关熔断不会给本页任何
  // 其它信号(rehydrate 只补消息/交互,不刷 session 元数据与 lastSyncedAt),
  // cacheSeeded 会话的 composer 会永远停在 syncing。在 open→closed 翻转沿
  // 直接补一次 load;换设备不算恢复沿(路由复用同一挂载实例时)。
  const prevBreakerStateRef = useRef({ deviceId, unresponsive: isDeviceUnresponsive });
  useEffect(() => {
    const prev = prevBreakerStateRef.current;
    prevBreakerStateRef.current = { deviceId, unresponsive: isDeviceUnresponsive };
    if (prev.deviceId !== deviceId) return;
    if (!prev.unresponsive || isDeviceUnresponsive) return;
    if (!deviceId || !sessionId || status !== 'online') return;
    void load();
  }, [deviceId, isDeviceUnresponsive, load, sessionId, status]);

  useEffect(() => {
    if (!connectionError) {
      if (!loading) autoRetrySyncKeyRef.current = null;
      return;
    }
    if (
      isDeviceAccessRevoked
      || !currentSession
      || !deviceId
      || !sessionId
      || loading
      || status !== 'online'
    ) {
      return;
    }
    const retryKey = `${deviceId}:${sessionId}:${connectionEpoch}:${connectionError}`;
    if (autoRetrySyncKeyRef.current === retryKey) return;
    const timer = setTimeout(() => {
      autoRetrySyncKeyRef.current = retryKey;
      void load();
    }, 900);
    return () => clearTimeout(timer);
  }, [
    connectionError,
    currentSession,
    deviceId,
    isDeviceAccessRevoked,
    load,
    loading,
    connectionEpoch,
    sessionId,
    status,
  ]);

  // 监听 error-persisted 脏信号:被控端落库完成后通知控制端,保留了缓存消息但失效了 sync marker。
  // 收到后调 load() → syncSession reopen 路径 → isSessionMessageWindowSynced=false → 整窗刷新,
  // error 行浮现,避免先 delete 消息造成的空白帧。
  const hasPendingRefresh = useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.hasPendingRefresh(sessionId ?? ''),
  );
  useEffect(() => {
    if (!hasPendingRefresh || loading || !deviceId || !sessionId) return;
    remoteSessionStore.consumePendingRefresh(sessionId);
    void load();
  }, [hasPendingRefresh, load, loading, deviceId, sessionId]);

  const isSessionStreaming = useMemo(
    () => sending || canStopQueue || remoteSessionRunning || currentTurnStreaming,
    [canStopQueue, currentTurnStreaming, remoteSessionRunning, sending],
  );
  // 活动条信号去抖:isSessionStreaming 由四个来源(sending / canStopQueue /
  // remoteSessionRunning / currentTurnStreaming)拼成,它们交接时会漏出一两帧空隙
  // ——实测日志里 streaming 1→0→1,活动条跟着闪一下、计时还被重置回 0s。
  // 上升沿立即生效(「跑起来了」要第一时间说),下降沿延后熄灭:真停了这点延迟无感,
  // 交接空隙则被吃掉。换会话立即复位,不让上一会话的粘滞态泄漏过来。
  // 粘滞态绑定它属于哪个会话:切会话若正好落在去抖窗口内,清零要等提交后的 effect 才跑,
  // 新会话首帧会顶着上一个会话残留的「思考中」(review P2)。带上 sessionId 后,渲染阶段
  // 直接判定粘滞态是否属于当前会话,不依赖 effect 的执行时机。
  const [streamingSticky, setStreamingSticky] = useState<string | null>(null);
  useEffect(() => {
    if (isSessionStreaming) {
      setStreamingSticky(sessionId);
      return undefined;
    }
    const timer = setTimeout(() => setStreamingSticky(null), COMPOSER_ACTIVITY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [isSessionStreaming, sessionId]);
  const showComposerActivity = isSessionStreaming || streamingSticky === sessionId;
  useEffect(() => {
    // 计时起点跟着去抖后的信号走:否则空隙一过 startedAt 被重置,活动条从 0s 重新数。
    setComposerActivityStartedAt(showComposerActivity ? Date.now() : null);
  }, [showComposerActivity, sessionId]);
  const composerActivityStartedAtMs = remoteSessionRunStatus.startedAt ?? composerActivityStartedAt;
  const composerActivityTokenUsage = remoteSessionRunStatus.tokenUsage;
  const forkOrigin = useMemo(
    () => (
      currentSession?.parentSessionId && currentSession.forkedAtMessageId
        ? {
            parentSessionId: currentSession.parentSessionId,
            forkedAtMessageId: currentSession.forkedAtMessageId,
            forkedSessionCreatedAt: currentSession.createdAt,
          }
        : null
    ),
    [currentSession?.createdAt, currentSession?.forkedAtMessageId, currentSession?.parentSessionId],
  );
  // inline 排队区去重集:已回流进消息流的 clientId 不再渲染排队气泡(排队气泡消失的
  // 同帧正式气泡已在流里,视觉上原位变实心,无跳变)。
  const queueHiddenClientIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.clientId) ids.add(message.clientId);
    }
    return ids;
  }, [messages]);
  // 落定中条目跟踪(见 settlingQueueItems 声明处注释):
  // 1) pendingQueue diff——只把「像被派发」的消失当作落定中:drain 恒从队首连续
  //    消费,steer 按 steeringQueueClientIds 标记;两者都不沾的中段消失是远端删除
  //    (桌面端/其它控制端取消),直接放行不渲染转圈幽灵(review P2)。队首的远端
  //    删除无法与派发区分,靠回流判定 + 30s 超时兜底。
  //
  // useLayoutEffect 而非 useEffect(实测 P1):pendingQueue 减少与 settling 建立必须落在
  // 同一帧。用 useEffect 时两者跨帧,中间会漏出「queue=0 settling=0 msgs=0」——首条消息
  // 刚被 drain、消息还没回流,屏幕上气泡凭空消失、只剩「正在同步」骨架,新建会话每次
  // 都能看到。layout effect 在绘制前同步 flush 这次 setState,那一帧不会被用户看见。
  useLayoutEffect(() => {
    // 本帧的 projection 已经推进过基线 → 这次转移处理完了,直接返回(否则 setState 会
    // 让本 effect 依赖再次变化,自激成无限循环)。
    if (
      settlingBaseline.queue === inputProjection.pendingQueue
      && settlingBaseline.steeringSource === inputProjection.steeringQueueClientIds
    ) {
      return;
    }
    const previous = settlingBaseline.queue;
    const previousSteering = settlingBaseline.steeringClientIds;
    const currentIds = new Set(inputProjection.pendingQueue.map((item) => item.clientId));
    const currentSteering = new Set(inputProjection.steeringQueueClientIds);
    setSettlingBaseline({
      sessionId,
      queue: inputProjection.pendingQueue,
      steeringSource: inputProjection.steeringQueueClientIds,
      steeringClientIds: currentSteering,
    });
    const vanished = computeVanishedQueueItems({
      previous,
      current: inputProjection.pendingQueue,
      previousSteeringClientIds: previousSteering,
      currentSteeringClientIds: currentSteering,
      hiddenClientIds: queueHiddenClientIds,
      locallyRemovedClientIds: locallyRemovedQueueClientIds,
    });
    const now = Date.now();
    for (const item of vanished) settlingAddedAtRef.current.set(item.clientId, now);
    // 「条目回到队列」(派发失败被塞回队首等)的摘除必须无条件执行,不能只在有
    // 新消失时才跑,否则回归行会以排队气泡 + 落定转圈双份渲染到超时(review P2)。
    setSettlingQueueItems((current) => {
      const kept = current.filter((item) => !currentIds.has(item.clientId));
      for (const item of current) {
        if (currentIds.has(item.clientId)) settlingAddedAtRef.current.delete(item.clientId);
      }
      const added = vanished.filter((item) => !kept.some((existing) => existing.clientId === item.clientId));
      if (added.length === 0 && kept.length === current.length) return current;
      return [...kept, ...added];
    });
  }, [
    inputProjection.pendingQueue,
    inputProjection.steeringQueueClientIds,
    locallyRemovedQueueClientIds,
    queueHiddenClientIds,
    sessionId,
    setSettlingQueueItems,
    settlingBaseline,
  ]);
  // 「这一条不该再画落定气泡」的唯一判据:已回流(正式消息进流里)或用户本地删除。
  // render 过滤与 effect 摘除共用它,不再各写一份。
  const settlingRetired = useCallback(
    (clientId: string) => queueHiddenClientIds.has(clientId)
      || locallyRemovedQueueClientIds.has(clientId),
    [locallyRemovedQueueClientIds, queueHiddenClientIds],
  );
  // 2) 回流 / 本地删除即移除(排队气泡消失的同帧正式气泡已在流里,原位变实);
  //    同样用 layout effect:跨帧会让「落定转圈气泡 + 已回流正式消息」双显一帧
  //    (实测日志里的 msgs=1 settling=1 那帧),视觉上是同一句话闪成两条。
  //    本地删除也在这里摘:删除标记与队列出队现在都是 state,谁先落地不确定,标记晚
  //    一帧到达时上面那个 effect 可能已经把条目记成落定中了——这里无条件复检,让顺序
  //    不再影响结果(ref 版靠同步写规避,state 版靠自愈)。
  useLayoutEffect(() => {
    setSettlingQueueItems((current) => {
      const next = current.filter((item) => !settlingRetired(item.clientId));
      if (next.length === current.length) return current;
      for (const item of current) {
        if (settlingRetired(item.clientId)) settlingAddedAtRef.current.delete(item.clientId);
      }
      return next;
    });
  }, [setSettlingQueueItems, settlingRetired]);
  // render 阶段现算的落定项:上面那个 layout effect 的 setState 要多走一次 render 才落地
  // (RN 下不保证在绘制前 flush,实测 trace 里 queue=0 settling=0 会先亮一帧),队列减少的
  // 同一帧屏幕上就没有气泡了。这里用同一份纯判定在 render 时直接算出来补上,与 state 版
  // 按 clientId 去重。基线推进后(effect 已把这次转移落进 settlingQueueItems)它自然回到
  // 空集——依赖里列的就是它读的全部输入,不存在「缓存答的是上一次转移」的可能。
  const derivedSettlingItems = useMemo(
    () => computeVanishedQueueItems({
      previous: settlingBaseline.queue,
      current: inputProjection.pendingQueue,
      previousSteeringClientIds: settlingBaseline.steeringClientIds,
      currentSteeringClientIds: new Set(inputProjection.steeringQueueClientIds),
      hiddenClientIds: queueHiddenClientIds,
      locallyRemovedClientIds: locallyRemovedQueueClientIds,
    }),
    [
      inputProjection.pendingQueue,
      inputProjection.steeringQueueClientIds,
      locallyRemovedQueueClientIds,
      queueHiddenClientIds,
      settlingBaseline,
    ],
  );
  // state 版的落定项也在 render 阶段按「已回流」过滤:等 effect 移除会多亮一帧
  // 「落定气泡 + 正式消息」双显(实测 trace 的 msgs=1 settling=1 那帧),同一句话看着像
  // 出现了两条。渲染口径统一为「render 现算优先,effect 只负责持久化与超时兜底」。
  const settlingItemsForRender = useMemo(
    () => mergeSettlingItems(
      settlingQueueItems.filter((item) => !settlingRetired(item.clientId)),
      derivedSettlingItems,
    ),
    [derivedSettlingItems, settlingQueueItems, settlingRetired],
  );

  // 3) 超时兜底:被 /clear、队首远端删除等消化而永不回流的条目清除,不留幽灵。
  //    正常派发的「出队→落库回流」在 device-link 上通常亚秒到数秒,10s 已是宽裕
  //    上界;线协议今天没有 accepted/draining 信号,队首远端删除的残余幽灵由此
  //    上界压缩到最多 10s(review 讨论过的边界取舍)。
  useEffect(() => {
    if (settlingQueueItems.length === 0) return undefined;
    const SETTLE_TIMEOUT_MS = 10_000;
    const timer = setTimeout(() => {
      const cutoff = Date.now() - SETTLE_TIMEOUT_MS;
      setSettlingQueueItems((current) => current.filter((item) => {
        const addedAt = settlingAddedAtRef.current.get(item.clientId) ?? 0;
        if (addedAt > cutoff) return true;
        settlingAddedAtRef.current.delete(item.clientId);
        return false;
      }));
    }, SETTLE_TIMEOUT_MS + 500);
    return () => clearTimeout(timer);
  }, [setSettlingQueueItems, settlingQueueItems]);
  // session-tail-banner「忽略」过的错误行(本地乐观集合;持久化 dismiss 另发,老被控端
  // 降级本视图隐藏)。声明在 renderItems 之前——errorTailClientId 过滤要用;banner 相关
  // 的其余状态与 handler 在下方 queue handler 区。
  const [dismissedTailErrorClientIds, setDismissedTailErrorClientIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setDismissedTailErrorClientIds(new Set());
  }, [sessionId]);
  // 尾部未忽略 error 行由 SessionTailBanner 独家承载,消息流里滤掉对应错误卡
  // (对齐桌面 MessageStream 返回 null);dismissed / 有后续消息时判定不命中,回流照常。
  // 本视图刚点过「忽略」的行同样回流(持久化 dismiss 落库前内存 content 未变,只滤
  // messages 会让 banner 和错误卡同时消失、错误信息无处可见,review P2)。协同只读
  // (worker)会话不渲染 banner,错误卡必须留在消息流(同一 review P2)。
  const errorTailClientId = useMemo(() => {
    if (collaborationReadOnlyReason) return null;
    const id = findErrorTailClientId(messages);
    return id && !dismissedTailErrorClientIds.has(id) ? id : null;
  }, [collaborationReadOnlyReason, messages, dismissedTailErrorClientIds]);
  const previousRenderItemsRef = useRef<{
    sessionId: string;
    items: readonly MobileMessageRenderItem[];
  } | null>(null);
  const renderItems = useMemo(
    () => {
      let items = insertMobileForkOriginItem(
        // 孤儿 agent_task 兜底用 maker status 驱动的权威 turn 边界 gate,与 store 的
        // turn-start 清理同源闭环——渲染开启时 map 必已清过 stale。不用 isSessionStreaming
        // (含本地 sending / canStopQueue,发送→status 间隙会闪现残留),也不用
        // remoteSessionRunning(activity 推送 / 活跃快照会先置 true,重连场景渲染先于清理)。
        buildMobileMessageRenderItems(
          messages,
          { autoResumePending: inputProjection.autoResumePending, isSessionStreaming, renderOrphanTaskUpdates: makerTurnRunning, sessionId },
          taskUpdates,
        ),
        forkOrigin,
      );
      if (errorTailClientId) {
        items = items.filter(
          (item) => !(item.type === 'message' && item.message.source.clientId === errorTailClientId),
        );
      }
      const previous = previousRenderItemsRef.current?.sessionId === sessionId
        ? previousRenderItemsRef.current.items
        : [];
      const reconciled = reconcileMobileMessageRenderItems(previous, items);
      return reconciled;
    },
    [errorTailClientId, forkOrigin, inputProjection.autoResumePending, isSessionStreaming, makerTurnRunning, messages, sessionId, taskUpdates],
  );
  // 只在本次 render 真正 commit 后更新 reconcile 基准。写入 useMemo/ref 会让
  // Concurrent Mode 下被丢弃的 render 泄漏成下一轮的 previous,破坏尾行 memo 的稳定性。
  useLayoutEffect(() => {
    previousRenderItemsRef.current = { sessionId, items: renderItems };
  }, [renderItems, sessionId]);
  // 后台静默刷新:仅在首次加载、还没有任何内容(messages 为空)时显示"正在同步";已有内容
  // (重开已看过的会话,messages 还在内存)时后台对账一律静默,不再弹同步提示打扰用户。
  const showSyncingIndicator = loading && messages.length === 0;
  const diffCount = useMemo(
    () => countMobileRenderItemDiffs(renderItems),
    [renderItems],
  );
  const searchHits = useMemo(
    () => findMobileMessageSearchHits(renderItems, searchQuery),
    [renderItems, searchQuery],
  );
  const activeSearchHit = activeSearchIndex >= 0 ? searchHits[activeSearchIndex] ?? null : null;
  const routeFocusedItemKey = useMemo(
    () => findMobileRenderItemKeyByClientId(renderItems, routeFocusedClientId),
    [renderItems, routeFocusedClientId],
  );
  const focusedMessageItemKey = activeSearchHit?.itemKey ?? routeFocusedItemKey;
  const routeFocusKey = routeFocusClientId
    ? `${sessionId}:${routeFocusClientId}:${routeFocusRequestKey ?? 'default'}`
    : null;
  const focusedMessageRequestKey = activeSearchHit
    ? `search:${searchQuery}:${activeSearchIndex}`
    : routeFocusedItemKey && routeFocusKey
      ? `route:${routeFocusKey}`
      : null;

  useEffect(() => {
    if (!routeFocusClientId || !routeFocusKey || !deviceId || !sessionId) {
      setRouteFocusedClientId(null);
      loadedRouteFocusKeyRef.current = null;
      appliedRouteFocusKeyRef.current = null;
      return;
    }

    const existingItemKey = findMobileRenderItemKeyByClientId(renderItems, routeFocusClientId);
    if (existingItemKey) {
      if (appliedRouteFocusKeyRef.current !== routeFocusKey) {
        appliedRouteFocusKeyRef.current = routeFocusKey;
        setRouteFocusedClientId(routeFocusClientId);
      }
      return;
    }

    setRouteFocusedClientId((current) => (current === routeFocusClientId ? current : null));
    if (loadedRouteFocusKeyRef.current === routeFocusKey) return;
    loadedRouteFocusKeyRef.current = routeFocusKey;

    let cancelled = false;
    void withTransientRemoteRetry(() =>
      maker.aroundMessagesByClientId(sessionId, routeFocusClientId, { radius: 60 }),
    )
      .then((list) => {
        if (cancelled) return;
        remoteSessionStore.mergeMessages(sessionId, Array.isArray(list) ? list : []);
        if (!Array.isArray(list) || list.length === 0) {
          setError(t('session.screen.locateMessageNotFound'));
          return;
        }
        appliedRouteFocusKeyRef.current = routeFocusKey;
        setRouteFocusedClientId(routeFocusClientId);
      })
      .catch((err) => {
        if (!cancelled) setError(formatRemoteError(err));
      });

    return () => {
      cancelled = true;
    };
  }, [deviceId, maker, renderItems, routeFocusClientId, routeFocusKey, sessionId]);

  useEffect(() => {
    if (!routeFocusedItemKey || !routeFocusKey) return;
    const timer = setTimeout(() => {
      if (appliedRouteFocusKeyRef.current === routeFocusKey) {
        setRouteFocusedClientId(null);
      }
    }, 2200);
    return () => clearTimeout(timer);
  }, [routeFocusedItemKey, routeFocusKey]);

  useEffect(() => {
    setActiveSearchIndex(searchQuery.trim() && searchHits.length > 0 ? 0 : -1);
  }, [searchQuery, searchHits.length]);

  useEffect(() => {
    setActiveSearchIndex((index) => normalizeMessageSearchIndex(searchHits.length, index));
  }, [searchHits.length]);

  useEffect(() => {
    if (!visualOpenSearch) return;
    setSearchOpen(true);
    if (visualSearchQuery !== null) setSearchQuery(visualSearchQuery);
  }, [visualOpenSearch, visualSearchQuery]);

  const moveSearchHit = useCallback((direction: 'previous' | 'next') => {
    setActiveSearchIndex((index) => nextMessageSearchIndex(searchHits.length, index, direction));
  }, [searchHits.length]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setActiveSearchIndex(-1);
  }, []);

  // 换会话会换队列实例,消费方一律从 ref 实时取,避免闭包捏着已 release 的旧队列。
  const resolveRemoteMedia = useCallback(
    (media: RemoteMediaRequest, opts?: RemoteMediaRequestOptions) =>
      (remoteMediaQueueRef.current ??= createRemoteMediaQueue()).request(media, opts),
    [createRemoteMediaQueue],
  );

  // 仅 video/audio 仍走「查看器关闭即删」;image 缩略图常驻列表,缓存保留到退屏统一清理。
  const releaseRemoteMedia = useCallback((
    sourceUrl: string,
    media: MobileResolvedRemoteMedia,
  ) => {
    remoteMediaQueueRef.current?.evict(sourceUrl);
    void auth.apiFetch('/api/device-link/media', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'DELETE',
      body: { key: media.ossKey },
    }).catch(() => undefined);
  }, [auth]);

  // 全屏查看器的分享:确保拿到本地 file://(磁盘缓存命中或先落盘)再唤起系统分享单。
  // 分享失败静默提示——旧 dev client 未包含 expo-sharing 原生模块时也走这条兜底。
  const shareLightboxImage = useCallback(async (
    media: { kind: 'image' | 'video' | 'audio'; url: string; previewable: boolean },
    displayUri: string,
    mimeType?: string,
    sizeBytes?: number,
  ) => {
    try {
      // direct http 图没有 resolved 记录、mimeType 通常缺失:从 url 扩展名推断,
      // 避免一律按 .jpg 落地导致分享目标按扩展名误判 PNG/WebP/GIF。
      const effectiveMime = mimeType ?? imageMimeFromUrl(displayUri) ?? undefined;
      let localUri = displayUri.startsWith('file://') ? displayUri : null;
      const diskCache = remoteMediaDiskCacheRef.current;
      if (!localUri && diskCache) {
        // 与取件落盘共用设备命名空间键:裸 url 键会命中不了既有缓存(白下载),
        // 更会重新引入跨账号/设备串味(裸键写入被下一账号同名 url 命中)。
        const cached = await diskCache.lookup(diskCacheSourceOf(media.url)).catch(() => null);
        if (cached) {
          localUri = cached.uri;
        } else if (displayUri.startsWith('http')) {
          if (media.previewable) {
            // direct http(s) 图不属于桌面媒体取件链路:size 未知(lightbox 只对
            // resolved 桌面媒体有 size),store 进 LRU 只会无谓搅动缓存——超大图
            // 还会先逐出别人的条目再落空。直接走一次性临时文件。
            localUri = await downloadRemoteMediaShareTemp(displayUri, effectiveMime ?? 'image/jpeg');
          } else {
            // 带 sizeBytes:超预算对象 store 直接跳过——不白下载整个对象,也不
            // 冲刷 LRU 里的既有条目(此前无 size 时会先下载、逐出老条目、再被删)。
            await diskCache.store(diskCacheSourceOf(media.url), displayUri, effectiveMime ?? 'image/jpeg', sizeBytes);
            localUri = (await diskCache.lookup(diskCacheSourceOf(media.url)).catch(() => null))?.uri ?? null;
            if (!localUri) {
              // store 被跳过(超预算)/ 落盘失败,lookup 拿不到:绕开 LRU 下到
              // 一次性临时文件,只为本次分享。
              localUri = await downloadRemoteMediaShareTemp(displayUri, effectiveMime ?? 'image/jpeg');
            }
          }
        }
      }
      if (!localUri) throw new Error(t('session.screen.shareNoLocalImage'));
      // 动态 import:expo-sharing 在模块顶层 requireNativeModule('ExpoSharing'),
      // 旧构建(未含该原生模块)静态 import 会直接崩屏;延迟到点击时加载,缺模块走兜底提示。
      const sharing = await import('expo-sharing');
      await sharing.shareAsync(localUri, effectiveMime ? { mimeType: effectiveMime } : undefined);
    } catch {
      Alert.alert(t('session.screen.shareFailedTitle'), t('session.screen.shareUnsupported'));
    }
  }, [diskCacheSourceOf, t]);

  // 换会话与退屏共用一套清理:本屏切 sessionId 不重挂载,若只在 unmount 清理,
  // 连续浏览多个多图会话会让上一会话的 OSS 对象一路累积。cleanup 在 sessionId
  // 变化与 unmount 时都执行:releaseAll + 补删(fire-and-forget;App 被杀等不触发
  // cleanup 的情况由 OSS 生命周期规则兜底),并换上全新队列实例(released 标志
  // 一次性,释放过的队列不能复用;unmount 分支多建一个空队列无害)。
  useEffect(() => () => {
    const released = remoteMediaQueueRef.current?.releaseAll() ?? [];
    for (const media of released) {
      // 仍在后台落盘的对象等落盘结束再删,避免 DELETE 抢先把落盘下载打成 404;
      // 磁盘缓存命中的空 ossKey 条目在 deleteRemoteMediaObject 内跳过。
      deleteRemoteMediaObject(media);
    }
    remoteMediaQueueRef.current = createRemoteMediaQueue();
  }, [sessionId, createRemoteMediaQueue, deleteRemoteMediaObject]);

  /** 单调递增的补齐轮次计数器;`latest` 是本屏最新那一轮的序号(旧轮据此自我作废)。 */
  const backfillRunSeqRef = useRef(0);
  const backfillLatestRunSeqRef = useRef(0);
  /**
   * 作废在飞的那一轮补齐:占掉一个序号但不启动任何轮,于是它在下一次 isCancelled 上收手。
   *
   * 走单调序号而不是在 isCancelled 里比"当前会话 id / loadingEarlier 是否变了":那类判据会随
   * 状态摆回而把取消撤销掉(#1210 review 的 P1);序号只增不减,作废是终态。
   */
  const abandonInFlightBackfill = useCallback(() => {
    backfillRunSeqRef.current += 1;
    backfillLatestRunSeqRef.current = backfillRunSeqRef.current;
  }, []);
  // 会话切走、或连接代变化(重连)时作废:用户已经离开的会话不值得继续花翻页请求;换连接后在飞的
  // 请求走的是旧连接,让它早点收手比等它超时干净。
  //
  // 手动「加载更早」的作废**不在这里**:effect 是被动的,而 loadEarlierMessages 在
  // setLoadingEarlier(true) 之后同步就发请求 —— 若自动补齐在这个 effect 跑之前返回,它仍会通过
  // isCancelled、merge 并继续下一页,两条分页流程短暂并发(#1210 review)。所以那条路在手动入口的
  // **同步路径**里直接调 abandonInFlightBackfill。
  useEffect(() => {
    abandonInFlightBackfill();
  }, [abandonInFlightBackfill, sessionId, connectionEpoch]);

  const loadEarlierMessages = useCallback(async () => {
    if (!deviceId || !sessionId || loadingEarlier || !hasOlderMessages) return;
    const before = oldestMessageCursor(messages);
    if (!before) {
      setHasOlderMessages(false);
      return;
    }
    // 同步作废在飞的自动补齐:两者都按 before 游标翻页,并发只会重复拉取、反复 merge。必须在
    // 发请求**之前**同步做掉,不能只靠依赖 loadingEarlier 的 effect —— 那是被动的,自动补齐可能
    // 在它执行前就返回并继续下一页(#1210 review)。
    abandonInFlightBackfill();
    setLoadingEarlier(true);
    setError(null);
    try {
      const page = await withTransientRemoteRetry(() =>
        listMessagesWithPayloadRetry((limit) => maker.listMessages(sessionId, { limit, before })),
      );
      const pageList = Array.isArray(page.messages) ? page.messages : [];
      // 用 mergeEarlierMessages 而不是 mergeMessages:这一页是沿 before 从窗口最旧端**连续**取的,
      // 登记进「已验证连续」区间后,后续满页的最新窗口同步才不会把用户一路翻出来的历史当成来源
      // 不明的缓存丢掉(#1210 review)。
      remoteSessionStore.mergeEarlierMessages(sessionId, pageList);
      setHasOlderMessages(shouldKeepOlderMessagesAffordance(page));
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setLoadingEarlier(false);
    }
  }, [abandonInFlightBackfill, deviceId, hasOlderMessages, loadingEarlier, maker, messages, sessionId]);

  /**
   * 历史窗口空洞的自动补齐(见 `historyWindowGap.ts` 的文件头)。
   *
   * 缓存旧页 + 最新页拼接、断连期间漏收 push,都会让窗口出现"首段 + 尾段"的孤岛,中间几百行
   * 从未加载 —— 手机上看起来就是"中间掉了一大段"。这里在窗口就位后检测最靠尾部的一处跳变,
   * 先花一次 `limit=1` 探测确认服务端两行是否本来就相邻(正常的隔夜会话不该白翻页),确认有洞
   * 才沿 `before` 游标补齐。
   *
   * 后台跑、不阻塞首屏,也不写 `error` / `loadingEarlier`:补齐是静默自愈,失败时渲染层的
   * `HISTORY_GAP_SPLIT_MS` 守卫兜底(不谎报时长),用户仍可用「加载更早」自己往上翻。
   */
  /**
   * 本次访问考察过的空洞,按**结局**分三类 —— 它们的"遗忘条件"和"是否消耗额度"都不同,合成
   * 一个集合会同时踩两个坑(#1210 review):
   *
   *  - `contiguous`:探测确认服务端两行本来就相邻(隔夜等正常停顿)。这是**事实**,与连接状态
   *    无关,所以本次访问内永久跳过;但它一个请求的翻页都没花,**不占额度** —— 否则窗口里
   *    只要有三处正常停顿,更早处的真实缺行就永远排不到探测。
   *  - `backfilled`:真的翻过页(covered / budget / exhausted)。跳过 + **占额度**,额度限制的
   *    正是"一次访问最多翻多少段历史"。
   *  - `failed`:请求异常(断线等)。跳过是为了防抖(messages 每变一次就重试会打成请求风暴),
   *    但**绑在连接代上**:`connectionEpoch` 变化即清空,重连后同一处可以再试。不占额度。
   *    `cancelled` 也归这里 —— 会话切走 / 锚点行被 /clear、rewind 拿掉,都属于"这次没做成"。
   *
   * 检测的跳过表是三者的并集;额度只看 `backfilled`。
   */
  const backfillGapStateRef = useRef<{
    sid: string;
    epoch: number;
    contiguous: Set<string>;
    backfilled: Set<string>;
    failed: Set<string>;
  } | null>(null);
  /**
   * 飞行中的那一轮补齐:会话 id + **单调递增的运行序号**。
   *
   * 为什么必须有 seq、且一切判据都对着它比:所有"当前状态是否仍等于启动时状态"的判据都不可靠,
   * 因为会话 id 会**摆回来** —— A 的补齐在飞时切到 B 再快速切回 A,`sessionId === 'A'` 会重新
   * 成立,于是旧那一轮的取消被撤销、effect 又放行一轮新的 A,同一会话并发翻页;旧轮收尾时还会
   * 按 sid 把新轮的飞行标记误清,继续放行更多轮(#1210 review 的 P1)。seq 只增不减,"我还是不是
   * 本会话最新那一轮"是单调判据,撤销不了。
   *
   * 用 state 而不是 ref 的理由不变:ref 在 `finally` 里改写不触发重渲染,那样本次访问里就不会
   * 再检测下一处空洞,要等新消息或重开会话。互斥仍只按 `sid` 判 —— 别的会话残留的那一轮不连坐
   * 当前会话(它自己会在下一次 isCancelled 上收手)。
   */
  const [backfillInFlightRun, setBackfillInFlightRun] = useState<{ sid: string; seq: number } | null>(null);
  useEffect(() => {
    if (!deviceId || !sessionId) return;
    // 同步门槛必须按 **session + 连接代** 判定,不能用 lastSyncedAt:屏实例复用、原地从会话 A
    // 切到有缓存消息的 B 时,lastSyncedAt 仍是 A 留下的非空值,补齐会在 B 的 listMessages 对账
    // 完成前就基于旧缓存快照动手 —— 而空洞 key 在请求前已记为已考察,那一处从此不再重试
    // (#1210 review)。readAckSyncedKey 正是「本会话在当前连接代完成过整窗同步」这个判据的
    // 既有单一来源(见它的声明处),这里直接复用。
    if (readAckSyncedKey !== `${sessionId}:${connectionEpoch}`) return;
    // 与「加载更早」互斥:两者都按 before 游标翻页,同时跑只会让窗口反复 merge、白拉页。
    // 飞行判定只挡**同一会话**,别的会话残留的那一轮不连坐(见 backfillInFlightRun)。
    if (loading || loadingEarlier || backfillInFlightRun?.sid === sessionId) return;
    // 换会话时整体重置;同一会话内换了连接代只清 failed —— 断线那次不该把这处空洞永久钉死,
    // 重连并重新同步后要能再试(#1210 review)。contiguous / backfilled 是与连接无关的结论,
    // 重连后不必重来。
    const existingState = backfillGapStateRef.current;
    const gapState = existingState?.sid === sessionId
      ? existingState
      : {
        sid: sessionId,
        epoch: connectionEpoch,
        contiguous: new Set<string>(),
        backfilled: new Set<string>(),
        failed: new Set<string>(),
      };
    if (gapState.epoch !== connectionEpoch) {
      gapState.epoch = connectionEpoch;
      gapState.failed.clear();
    }
    backfillGapStateRef.current = gapState;
    // 跳过表是三类的并集:contiguous 那种"不 merge、跳变留在窗口里"的结局若不跳过,检测会永远
    // 返回同一处,更早处的真实缺行进不了探测。
    const consideredKeys = new Set<string>([
      ...gapState.contiguous,
      ...gapState.backfilled,
      ...gapState.failed,
    ]);
    // 两道闸各管一件事,都不能省(常量注释里有完整理由):
    //  - 翻页额度只算真花了翻页请求的结局 —— 正常停顿不该把它吃光,否则更早的真实缺行排不到;
    //  - 考察总闸管住探测本身 —— 跨数百天的会话可能有上百处正常停顿,只有翻页额度的话会串行
    //    发出上百次 limit=1 探测。
    if (gapState.backfilled.size >= HISTORY_BACKFILL_MAX_GAPS_PER_VISIT) return;
    if (consideredKeys.size >= HISTORY_GAP_MAX_CONSIDERED_PER_VISIT) return;
    const gap = findHistoryWindowGap(messages, consideredKeys);
    if (!gap) return;
    const gapKey = historyWindowGapKey(gap);
    const sessionIdAtStart = sessionId;
    const epochAtStart = connectionEpoch;
    // 本轮的身份:单调序号。启动即成为"最新一轮",此前还在飞的那一轮由此自我作废。
    const runSeq = backfillRunSeqRef.current + 1;
    backfillRunSeqRef.current = runSeq;
    backfillLatestRunSeqRef.current = runSeq;
    setBackfillInFlightRun({ sid: sessionIdAtStart, seq: runSeq });
    void backfillHistoryWindowGap(gap, {
      listPage: async (before, limit) => {
        const page = await listMessagesWithPayloadRetry(
          (retryLimit) => maker.listMessages(sessionIdAtStart, { limit: retryLimit, before }),
          // 探测页只要一行,不能沿用默认阶梯(它从 80 起降,第一枪就是满页,探测的成本优势没了);
          // 翻页页照常走默认阶梯,帧超限时要能降级重试,否则大 tool 输出的会话一枪就 failed。
          limit === HISTORY_GAP_PROBE_LIMIT ? [HISTORY_GAP_PROBE_LIMIT] : undefined,
        );
        return Array.isArray(page.messages) ? page.messages : [];
      },
      merge: (rows) => {
        if (rows.length > 0) remoteSessionStore.mergeMessages(sessionIdAtStart, rows);
      },
      // 两个收手条件:
      //  - **我不再是最新那一轮** —— 屏幕已经为别的会话(或切回来后的同一会话)起了新的一轮。
      //    判据必须是单调的 seq,不能比"当前会话 id 是否仍等于启动时的":会话切走再切回时后者会
      //    重新成立,取消被撤销、同一会话并发翻页(#1210 review 的 P1)。
      //  - 空洞较新一侧那行已不在窗口里 —— /clear、rewind 或整窗替换把它拿掉了,继续 merge 会
      //    把刚被移除的历史(甚至 clearedAt 之前的消息)塞回窗口。锚点没了就等于这处空洞不存在了。
      isCancelled: () => backfillLatestRunSeqRef.current !== runSeq
        || !remoteSessionStore.getMessages(sessionIdAtStart).some((row) => row.id === gap.newerId),
    }).then((outcome) => {
      // 按结局归类(容器的三类语义见 backfillGapStateRef 的注释)。归类发生在**收尾**而不是发起
      // 前:发起期间的重入由飞行标记挡住,不需要预先占位。切会话 / 换连接代之后落地的旧结局
      // 一律丢弃 —— 它属于上一个容器,写进新容器会污染当前会话的判断。
      // 已被新一轮取代的旧轮不写结论:它看到的窗口已经不是当前的了。
      if (backfillLatestRunSeqRef.current !== runSeq) return;
      const state = backfillGapStateRef.current;
      if (!state || state.sid !== sessionIdAtStart || state.epoch !== epochAtStart) return;
      // cancelled 刻意**不记**:它的两个触发条件本身就不会招来立刻重试 —— 会话切走时当前会话
      // 的检测看的是另一个窗口,回到这个会话时理应重新考察;锚点行被 /clear、rewind 拿掉时那处
      // 跳变也随之消失,检测不会再返回它。记下来只会让"切走再回来"白白丢掉一次自愈机会。
      if (outcome === 'contiguous') state.contiguous.add(gapKey);
      else if (outcome === 'failed') state.failed.add(gapKey);
      else if (outcome !== 'cancelled') state.backfilled.add(gapKey);
    }).finally(() => {
      // 按 **seq** 精确匹配再清:切会话(甚至切回同一会话)后可能已经起了新的一轮,按 sid 比会把
      // 新轮的标记误清、于是又放行一轮,越滚越多(#1210 review 的 P1)。
      setBackfillInFlightRun((current) => (current?.seq === runSeq ? null : current));
    });
  }, [
    backfillInFlightRun,
    connectionEpoch,
    deviceId,
    loading,
    loadingEarlier,
    maker,
    messages,
    readAckSyncedKey,
    sessionId,
  ]);

  const selectSlashCommand = useCallback((command: MobileSlashCommand) => {
    // 点选 agent-skill 时记录名字+会话 id:palette 关闭后 slashCommands 被清,发送侧
    // 凭此 ref 识别「用户明确选中的 skill」;sid 绑定防止切换会话后旧点选残留。
    pendingSkillSelectionRef.current = command.kind === 'agent-skill'
      ? { name: command.name, sid: sessionId }
      : null;
    const trigger = detectComposerTrigger(draftRef.current);
    if (trigger.kind !== 'slash') return;
    const nextDocument = replaceComposerTextRange(
      composerDocumentRef.current,
      trigger.from,
      draftRef.current.length,
      [slashCommandTextNode(command.name), { type: 'text', text: ' ' }],
    );
    applyComposerDocument(
      nextDocument,
      queueEditingRef.current ? { persist: false } : undefined,
    );
    composerInputRef.current?.applyDocumentAndSetSelectionToEnd(nextDocument);
  }, [applyComposerDocument, sessionId]);

  const selectAtResource = useCallback((item: MobileAtResourceItem) => {
    const trigger = detectComposerTrigger(draftRef.current);
    if (trigger.kind !== 'at') return;
    const nextDocument = replaceComposerTextRange(
      composerDocumentRef.current,
      trigger.from,
      draftRef.current.length,
      [mentionComposerNode(item), { type: 'text', text: ' ' }],
    );
    applyComposerDocument(
      nextDocument,
      queueEditingRef.current ? { persist: false } : undefined,
    );
    composerInputRef.current?.applyDocumentAndSetSelectionToEnd(nextDocument);
  }, [applyComposerDocument]);

  const startVoiceRecording = useCallback(async () => {
    if (
      voicePermissionRequestInFlightRef.current
      || voiceStartupInFlightRef.current
      || voiceStopInFlightRef.current
      || voiceRecordingActiveRef.current
      || voiceState === 'listening'
      || voiceIsProcessing
    ) return;
    voiceStopAfterStartRef.current = false;
    setVoiceError(null);
    setVoiceReleaseToSendActive(false);
    let claimedPrewarm: PrewarmedMobileVoiceAsr | null = null;
    let permissionRequestSeq: number | null = null;
    let permissionRequestAbortController: AbortController | null = null;
    let startupSeq: number | null = null;
    let audioModeEnabled = false;
    // The controller THIS startup created. Stale-teardown paths must only touch
    // this one: by the time a superseded continuation resumes, the shared ref
    // may already point at a newer session's live recording. Read through the
    // function where TS cannot see the assignment inside startController.
    let createdController: MobileVoiceControllerSession | null = null;
    const getCreatedController = (): MobileVoiceControllerSession | null => createdController;
    try {
      if (!deviceId) {
        setVoiceState('error');
        setVoiceError(t('session.screen.voiceNoRemoteDevice'));
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
        voiceRecordingActiveRef.current = false;
        voiceStopAfterStartRef.current = false;
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
      // link (only submitting the composed message later does). Awaiting it used
      // to add 0.6–4.4s before the mic could open.
      void openLink(deviceId).catch(() => undefined);
      // Claim the connection prewarmed at pressIn (if any): its credential is
      // already resolved and its ASR WebSocket already connecting, so the
      // handshake overlaps the press gesture instead of following it.
      // 词典快照拉取不进 await:它只影响润色提示的丰富度,拉不到(桌面离线、老版本
      // 被控端)就用上次缓存,绝不为它推迟开麦。本次拉到的内容供下一次润色使用。
      void refreshMobileVoiceDictionary(deviceId, () => maker.getVoiceDictionary());
      const [prewarmedVoice, localVoiceInputHistory] = await Promise.all([
        takePrewarmedMobileVoiceAsr(deviceId) ?? Promise.resolve(null),
        getMobileVoiceInputHistoryForHost(deviceId),
        hydrateMobileVoiceDictionary(deviceId),
      ]);
      claimedPrewarm = prewarmedVoice;
      const credential = prewarmedVoice?.credential
        ?? createMobileCindyVoiceCredential(deviceId);
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
        // The startup was superseded while we awaited: close the claimed
        // connection instead of opening a mic for a dead run. Session switches
        // supersede IN PLACE here (the cleanup effect keys on [sessionId], no
        // unmount), so a NEWER voice run may already be starting or live — and
        // audio mode is app-global. Only undo the recording mode this startup
        // enabled when no newer run is active, otherwise the reset could land
        // after the new run's native capture started and silently kill it.
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
      const startController = async () => {
        const controller = createMobileVoiceControllerSession({
          credential,
          ...(prewarmedVoice ? { asr: prewarmedVoice.asr } : {}),
          connectionProvider: (providerId: string) => voiceContext.createAsrConnection(providerId),
          refinerTargetProvider: (providerId: string, options?: { refreshAccessToken?: boolean }) =>
            voiceContext.createRefinerTarget(providerId, options),
          warmRefiner: (input: { system: string; user: unknown; promptCacheKey: string }) =>
            voiceContext.warmRefiner(input),
          initialDraft: draft,
          refinementContext: buildMobileVoiceSessionRefinementContext(draft, renderItems),
          localVoiceInputHistory,
          readCurrentDraft: () => draftRef.current,
          onDraftChanged: setComposerDraft,
          onStateChanged: setVoiceState,
          onError: (message) => {
            setVoiceState('error');
            setVoiceError(message);
          },
          // No start cue on mobile: playing a cue via expo-audio during capture
          // re-activates the AVAudioSession and stalls the record tap (see
          // mobileVoiceCue.ts). Only the end cue, which plays after capture
          // stops, is wired.
          onReadyForEndCue: credential.settings?.playInteractionSound ? playMobileVoiceInputEndCue : undefined,
          recordHistory: (text) => recordMobileVoiceInputHistoryForHost(deviceId, text),
          updateHistoryEntry: (entryId, text) => updateMobileVoiceInputHistoryEntryForHost(deviceId, entryId, text),
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
        voiceStartupInFlightRef.current = false;
      };
      await startController();
      if (voiceStartupSeqRef.current !== startupSeq) {
        // Unmounted while controller.start() was in flight: tear down the run
        // that just came up on a dead screen (mic + claimed ASR connection).
        // Only touch the controller THIS startup created — the shared ref may
        // already belong to a newer session's recording.
        const created = getCreatedController();
        if (created) {
          if (voiceControllerSessionRef.current === created) {
            voiceControllerSessionRef.current = null;
            voiceRecordingActiveRef.current = false;
            voiceStopInFlightRef.current = false;
            await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
          }
          await created.cancel().catch(() => undefined);
        }
        return;
      }
      if (voiceStopAfterStartRef.current && finishVoiceRecordingRef.current) {
        voiceStopAfterStartRef.current = false;
        finishVoiceRecordingRef.current();
      }
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
        // Superseded: tear down only what THIS startup created; the shared ref
        // may already belong to a newer session's recording.
        const created = getCreatedController();
        if (created) {
          if (voiceControllerSessionRef.current === created) {
            voiceControllerSessionRef.current = null;
            voiceRecordingActiveRef.current = false;
          }
          await created.cancel().catch(() => undefined);
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
      voiceLongPressActiveRef.current = false;
      voiceStopAfterStartRef.current = false;
      setVoiceState('error');
      setVoiceError(formatRemoteError(err));
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  }, [deviceId, draft, openLink, renderItems, t, voiceIsProcessing, voiceState]);

  const cancelVoiceForAppBackground = useCallback(() => {
    const controller = voiceControllerSessionRef.current;
    const ownsActiveRun = shouldCancelMobileVoiceForBackground({
      startupInFlight: voiceStartupInFlightRef.current,
      recordingActive: voiceRecordingActiveRef.current,
      hasController: Boolean(controller),
    });
    if (!ownsActiveRun) {
      // pressIn may have opened a speculative ASR connection without creating
      // a controller yet; backgrounding must not leave that parked connection.
      discardPendingPrewarm();
      return;
    }

    voiceStartupSeqRef.current += 1;
    voiceControllerSessionRef.current = null;
    voiceStartupInFlightRef.current = false;
    voiceStopInFlightRef.current = false;
    voiceRecordingActiveRef.current = false;
    voiceLongPressActiveRef.current = false;
    voiceSuppressNextPressRef.current = false;
    voiceStopAfterStartRef.current = false;
    setVoiceReleaseToSendActive(false);
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
      cancelVoiceForAppBackground();
    });
    return () => subscription.remove();
  }, [cancelVoiceForAppBackground]);

  // 手势被系统/滚动终止时的撤销:比 app 后台版多一步——同时作废还开着的麦克风
  // 权限请求。后台版必须让权限弹窗存活(见上方 AppState 注释:权限弹窗会短暂
  // 触发 background),手势取消恰相反:首次使用时按下即录会先弹权限,此时
  // startupInFlight/controller 都还是 false,只作废预热不够——权限批准归来后
  // 启动会继续、麦克风开录,而那次按下早已被取消(review P1)。
  const cancelVoiceForGestureTermination = useCallback(() => {
    voicePermissionRequestSeqRef.current += 1;
    voicePermissionRequestAbortRef.current?.abort();
    voicePermissionRequestAbortRef.current = null;
    voicePermissionRequestInFlightRef.current = false;
    cancelVoiceForAppBackground();
  }, [cancelVoiceForAppBackground]);

  useEffect(() => {
    return () => {
      const controller = voiceControllerSessionRef.current;
      voiceControllerSessionRef.current = null;
      // Supersede any in-flight startup so its post-await re-checks tear down
      // the resources it acquired for this now-dead screen.
      voicePermissionRequestSeqRef.current += 1;
      voicePermissionRequestAbortRef.current?.abort();
      voicePermissionRequestAbortRef.current = null;
      voicePermissionRequestInFlightRef.current = false;
      voiceStartupSeqRef.current += 1;
      voiceStartupInFlightRef.current = false;
      voiceStopInFlightRef.current = false;
      voiceRecordingActiveRef.current = false;
      voiceLongPressActiveRef.current = false;
      voiceSuppressNextPressRef.current = false;
      voiceStopAfterStartRef.current = false;
      voiceDictionaryLearningTrackerRef.current?.dispose();
      // 语音结束 hold 属于上一个会话的输入现场;切会话时连同迁移基点一并复位,
      // 被 cancel 的 run 迟到的状态回调不会在新会话上误布防。
      voiceStateTransitionRef.current = 'idle';
      setComposerVoiceHoldArmed(false);
      if (controller) void controller.cancel().catch(() => undefined);
      discardPendingPrewarm();
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };
  }, [sessionId]);

  const finishVoiceRecording = useCallback(async (options: { sendAfterTranscribe?: boolean } = {}) => {
    if (voiceStopInFlightRef.current) return;
    const controller = voiceControllerSessionRef.current;
    if (!controller) return;
    if (!voiceRecordingActiveRef.current && voiceState !== 'listening') return;
    voiceStopInFlightRef.current = true;
    voiceControllerSessionRef.current = null;
    voiceStopAfterStartRef.current = false;
    voiceStartupInFlightRef.current = false;
    voiceLongPressActiveRef.current = false;
    voiceSuppressNextPressRef.current = false;
    voiceRecordingActiveRef.current = false;
    setVoiceReleaseToSendActive(false);
    setVoiceState('submitting');
    setVoiceError(null);
    try {
      // stop() can deliver an empty final transcript through onDraftChanged before
      // resolving. Capture the rich document first so quote/reference atoms survive.
      const documentBeforeStop = composerDocumentRef.current;
      const latestDraft = await controller.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      setVoiceState('done');
      // 听写结束落焦(既有行为,显式 focus 承担弹键盘语义):focus 的 web 侧
      // 实现即 placeCaretAtEnd,caret 落在转写文字末尾。听写**进行中**禁止任何
      // 程序化 focus(见 voiceIsListening 滚动效应的注释)。
      requestAnimationFrame(() => {
        composerInputRef.current?.focus();
      });
      // chat-text-quote:纯引用(无转写文字、无附件)也要发出去——发送按钮在
      // quote-only 时可见,漏了引用会变成「点发送只停了录音、消息没发」。
      const latestDocument = latestDraft.trim()
        ? reconcileComposerProjectedText(documentBeforeStop, latestDraft)
        : documentBeforeStop;
      if (options.sendAfterTranscribe && (composerDocumentHasContent(latestDocument) || attachments.length > 0)) {
        const sendLatest = sendLatestRef.current;
        if (!sendLatest) throw new Error(t('session.screen.voiceSenderNotReady'));
        await sendLatest({ documentOverride: latestDocument });
      }
    } catch (err) {
      voiceControllerSessionRef.current = null;
      voiceRecordingActiveRef.current = false;
      setVoiceState('error');
      setVoiceError(formatRemoteError(err));
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    } finally {
      voiceStopInFlightRef.current = false;
    }
  }, [attachments.length, t, voiceState]);

  const openVoiceSettings = useCallback(() => {
    void Linking.openSettings().catch((err) => {
      setVoiceError(formatRemoteError(err));
    });
  }, []);

  useEffect(() => {
    finishVoiceRecordingRef.current = () => {
      void finishVoiceRecording();
    };
  }, [finishVoiceRecording]);

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
  // 2026-07-27 定案):按下瞬间起录,开头一个字不丢;松手 <320ms 视为「点击开始」
  // (录音继续),≥320ms(onLongPress 成立)后松手走停止/拖发。预热(audio session
  // + ASR connect)仍在最前,与启动重叠。Skipped when the tap will stop the
  // current recording rather than start a new one.
  const handleVoiceButtonPressIn = useCallback(() => {
    voiceStartedOnPressInRef.current = false;
    if (voiceIsProcessing) return;
    if (voiceRecordingActiveRef.current || voiceState === 'listening') return;
    if (!deviceId || !isMobileRealtimeAudioAvailable()) return;
    // Keep the native audio-session warmup on the synchronous press-down path
    // (prewarmMobileVoiceStart re-runs it idempotently below).
    prewarmMobileRealtimeAudio();
    // 托管预热:凭登录态提前拿 voice-server 票据并开 ASR WebSocket。
    prewarmMobileVoiceStart(deviceId, {
      getAccessToken: () => auth.getAccessToken(),
      refreshAccessToken: () => auth.refreshAccessToken(),
      apiFetch: auth.apiFetch,
    });
    // 启动已在途/停止在途时不重复发起,也不把这次按下标成「已起录」——
    // 否则松手的 onPress 会被吞掉,用户失去 toggle 能力。
    if (voiceStartupInFlightRef.current || voiceStopInFlightRef.current) return;
    voiceStartedOnPressInRef.current = true;
    const pendingSeq = ++voiceStartPendingSeqRef.current;
    setVoiceStartPending(true);
    void startVoiceRecording()
      .catch(() => undefined)
      .finally(() => {
        // 只收自己世代的 pending:切会话后旧启动的收尾不能塌掉新录音的胶囊。
        if (voiceStartPendingSeqRef.current === pendingSeq) setVoiceStartPending(false);
      });
  }, [deviceId, startVoiceRecording, voiceIsProcessing, voiceState]);

  const renderComposerVoiceButton = (buttonStyle?: StyleProp<ViewStyle>) => (
    <RouteActionButton
      accessibilityLabel={voiceIsListening ? t('session.common.voiceStopRecording') : t('session.screen.voiceStartInput')}
      accessibilityHint={composerLayout.voice.disabledReason ?? composerSendUnavailableReason ?? undefined}
      active={composerLayout.voice.active}
      busy={voiceIsProcessing}
      disabled={composerLayout.voice.disabled || (!canUseComposer && !voiceIsBusy)}
      delayLongPress={320}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPressIn={handleVoiceButtonPressIn}
      onLongPress={() => {
        voiceLongPressActiveRef.current = true;
        voiceSuppressNextPressRef.current = true;
        measureSendButtonTarget();
        // 录音已在 pressIn 起了;这里只兜 pressIn 守卫路径没起成的边缘
        // (startVoiceRecording 自带重入守卫,重复调用无害)。
        if (!voiceRecordingActiveRef.current) void startVoiceRecording();
      }}
      onPress={() => {
        if (voiceSuppressNextPressRef.current) {
          voiceSuppressNextPressRef.current = false;
          return;
        }
        if (voiceStartedOnPressInRef.current) {
          // 本次按下已在 pressIn 起录:这次松手属于同一手势,不再当作
          // 「再点一下停止」;下一次完整点击才会 toggle 停止。
          voiceStartedOnPressInRef.current = false;
          return;
        }
        toggleVoiceRecording();
      }}
      onPressOut={(event) => {
        if (!voiceLongPressActiveRef.current) return;
        // 长按路径在此收尾,本次按下的生命周期结束;标记同步清掉,
        // 手势取消(onTouchCancel)不再重复处理。
        voiceStartedOnPressInRef.current = false;
        const shouldSend = updateVoiceReleaseToSendTarget(event);
        voiceLongPressActiveRef.current = false;
        voiceSuppressNextPressRef.current = true;
        setVoiceReleaseToSendActive(false);
        if (!voiceRecordingActiveRef.current) {
          voiceStopAfterStartRef.current = true;
          return;
        }
        void finishVoiceRecording({ sendAfterTranscribe: shouldSend });
      }}
      onResponderMove={updateVoiceReleaseToSendTarget}
      onTouchCancel={() => {
        // 手势被系统/滚动打断(responder termination):撤销这次按下误触发的
        // 录音——用户本意是滚动列表,不能留下一个还在采集的麦克风(review P1)。
        // 正常松手(含拖出按钮后松开)不走这里,对齐桌面「pointercancel 才撤销」。
        if (!voiceStartedOnPressInRef.current) return;
        voiceStartedOnPressInRef.current = false;
        cancelVoiceForGestureTermination();
      }}
      style={[
        styles.composerInlineToolButton,
        buttonStyle,
        // 胶囊底色跟随计时内容(含 pressIn 乐观 pending 期),不只 listening——
        // 否则按下瞬间胶囊已展开、底色却要等 ASR 连上才变,闪一次半成品态。
        voiceRecordingTimer.label !== null && styles.composerToolButtonPrimary,
        voiceRecordingTimer.label !== null && { width: voiceRecordingTimer.pillWidth },
      ]}
      testID="session.voiceButton"
    >
      {voiceIsProcessing ? (
        <ActivityIndicator color={colors.textSecondary} size="small" />
      ) : voiceRecordingTimer.label !== null ? (
        // 录音中:胶囊展开为脉冲红点 + 计时(对齐桌面 activeRecording 形态),
        // 点胶囊任意位置停止录音;右缘锚定不动,只向左生长。
        <VoiceRecordingPillContent label={voiceRecordingTimer.label} testID="session.voiceRecordingPill" />
      ) : (
        <Mic color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      )}
    </RouteActionButton>
  );

  const removeRemoteFileAttachment = useCallback((id: string) => {
    // 已上传中转区的对象移除时 best-effort 回收,避免未发送附件在 OSS 留孤儿(codex review #504)。
    const removed = attachments.find((item) => item.id === id);
    if (removed) discardMobileUploadedAttachment(removed, { getToken: () => auth.getAccessToken() });
    // ref 与 setState 同步镜像(与本文件其它 ref 改动点一致):再编辑替换在
    // onUploaded 里同步走「remove 旧 → append 新」,若只改 state,发送抢在下次
    // render 前读 ref 会把已被替换的旧附件连同新图一起发出(review P2)。
    attachmentsRef.current = attachmentsRef.current.filter((item) => item.id !== id);
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentPreviews((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    // 同步清掉指向该附件的相册映射:悬空的 asset.id → attachment.id 会让同一张图
    // 在面板里第一次点选被「已附加」分支吞掉(只删映射不入待选)。
    setMediaAssetAttachments((current) => {
      const entries = Object.entries(current).filter(([, attachmentId]) => attachmentId !== id);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    // 标注附件退场时同步清「矢量笔迹 + 原图副本」的再编辑真相。
    composerAnnotationsRef.current?.forgetAttachment(id);
    setAttachmentError(null);
  }, [attachments, auth]);

  // 圈点标注(聊天 lightbox 发送到对话 / 托盘再编辑)与附件管线的接线。
  const composerAnnotations = useComposerImageAnnotations({
    getAccessToken: () => auth.getAccessToken(),
    enqueueUploads,
    removeAttachment: removeRemoteFileAttachment,
    // pending 计数读 controller 同步真源(getPendingUploadCount)而非 React state:
    // 标注信箱串行 drain 的连续提交只隔 microtask,state commit(macrotask)来不及
    // 生效,读 state 会拿到「入队前」旧值绕过上限(review P1)。
    getRemainingAttachmentSlots: () =>
      MOBILE_MAX_ATTACHMENTS - attachmentsRef.current.length - getPendingUploadCount(),
  });
  composerAnnotationsRef.current = composerAnnotations;

  const requestMessageListFollowLatest = useCallback(() => {
    setMessageListFollowLatestRequestKey((key) => key + 1);
  }, []);

  // 拖拽调高进行中 composer 每帧变高，onLayout 也每帧触发；此时冻结 state 更新
  // 避免整页 re-render 风暴，只记录最后一次高度，松手后一次性补同步。
  const handleBottomOverlayLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    if (composerResizeDraggingRef.current) {
      pendingBottomOverlayHeightRef.current = nextHeight;
      return;
    }
    pendingBottomOverlayHeightRef.current = null;
    setBottomOverlayContentHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight
    ));
  }, []);

  // 顶部 chrome(半透明工具栏)是绝对定位浮层:量出实高喂给消息列表做顶部让位
  // (滚到历史最顶端时第一条消息不被工具栏盖住),与 bottomOverlayHeight 同款模式。
  const handleTopOverlayLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    setTopOverlayHeight((currentHeight) => (
      Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight
    ));
  }, []);

  useEffect(() => {
    if (composerResize.dragging) return;
    const pendingHeight = pendingBottomOverlayHeightRef.current;
    if (pendingHeight === null) return;
    pendingBottomOverlayHeightRef.current = null;
    setBottomOverlayContentHeight((currentHeight) => (
      Math.abs(currentHeight - pendingHeight) > 1 ? pendingHeight : currentHeight
    ));
  }, [composerResize.dragging]);

  // ————— 本地待发队列(outbox):附件上传中消息先上屏 —————
  // 状态机纯函数在 sessionOutbox.ts;这里只做 React 接线与 enqueue 派发。
  // 所有更新经此单点:ref(同步真源)与 state(渲染)一起写。
  const updateOutbox = (updater: (items: readonly MobileOutboxItem[]) => readonly MobileOutboxItem[]) => {
    const next = updater(outboxRef.current);
    if (next === outboxRef.current) return;
    outboxRef.current = next;
    setOutboxItems(next);
  };

  /**
   * 无法回插 outbox 时的兜底(所属会话已离场 / 屏已卸载):文字合并回**条目所属
   * 会话**的草稿库与引用 store(持久化,不静默蒸发),已就绪附件回收 OSS
   * 中转对象。派发失败才会走到这里,此时附件必然已全部落定(ready 才派发),
   * 没有在途任务要清。
   */
  const salvageOutboxItem = (item: MobileOutboxItem) => {
    restoreOutboxItemsToDraft([item]);
    for (const attachment of outboxItemAttachments(item)) {
      discardMobileUploadedAttachment(attachment, {
        getToken: () => remoteMediaDepsRef.current.auth.getAccessToken(),
      });
    }
  };

  /**
   * 派发一条就绪的 outbox 条目:构建 queued(权限档用发送时刻快照,model / effort
   * 等跟随会话最新值)→ 乐观进本地 pendingQueue(待发气泡原位变为排队气泡,同帧
   * 无跳变)→ enqueue RPC(弱网重试 + 对账,同原发送路径口径)。enqueue 确认未
   * 应用时条目回 outbox 队首标失败,气泡保留可重试——不恢复草稿(消息还在屏上)。
   * 全程使用 item.sessionId(而非闭包 sessionId):dispatch 在途窗口用户可能原地
   * 切会话,消息必须始终发进它所属的会话(review P1)。
   */
  const dispatchOutboxItem = async (item: MobileOutboxItem) => {
    const failItem = (message: string) => {
      // 归属校验:条目所属会话已离场(切会话 cleanup 已跑 / 屏已卸载)时不回插
      // 共享 ref——那会把 A 会话的失败气泡画进 B,或写进没人消费的 ref 让文字
      // 蒸发(review P1)。降级为草稿写回 + 附件回收。
      if (outboxSessionAliveRef.current !== item.sessionId) {
        salvageOutboxItem(item);
        return;
      }
      updateOutbox((items) => (
        items.some((existing) => existing.clientId === item.clientId)
          ? replaceOutboxItem(items, outboxItemWithEnqueueFailure(item, message))
          : [outboxItemWithEnqueueFailure(item, message), ...items]
      ));
    };
    const sessionNow = remoteSessionStore.getSessions().find((entry) => entry.id === item.sessionId);
    if (!sessionNow) {
      failItem(t('session.screen.sessionNotFoundResync'));
      return;
    }
    if (!sessionNow.workingDir) {
      failItem(t('session.screen.missingWorkingDir'));
      return;
    }
    const sessionAtSend = { ...sessionNow, permissionMode: item.permissionModeAtSend };
    const queuedDraft = {
      ...buildQueuedTextMessage(sessionAtSend, item.text, new Date(), item.clientId, {
        attachments: outboxItemAttachments(item),
        quotesEncoded: item.quotesEncoded,
        agentReferences: item.agentReferences,
        pastedTextRanges: item.pastedTextRanges,
        slashCommandRanges: item.slashCommandRanges,
      }),
      ...(item.sessionRefs && item.sessionRefs.length > 0
        ? { sessionRefs: [...item.sessionRefs] }
        : {}),
    };
    let queued: QueuedRemoteMessage;
    try {
      queued = await prepareMobileQueuedSessionReferences(
        queuedDraft,
        invoke,
        remoteSessionStore.getSessionDeviceId,
        deviceId,
      );
    } catch (err) {
      failItem(formatRemoteError(err));
      return;
    }
    // 乐观交接:进本地 pendingQueue 的同一同步段把条目移出 outbox,气泡原位从
    // 「发送中」变「排队中」不闪断;enqueue 成功后用权威 projection 覆盖 reconcile。
    const projectionBeforeSend = remoteSessionStore.getInputProjection(item.sessionId);
    remoteSessionStore.setInputProjection(item.sessionId, {
      ...projectionBeforeSend,
      sessionId: projectionBeforeSend.sessionId || item.sessionId,
      pendingQueue: [...projectionBeforeSend.pendingQueue, queued],
    });
    updateOutbox((items) => items.filter((entry) => entry.clientId !== item.clientId));
    // outbox 条目的槽位预览接着给排队气泡用:交接后图不能因为换了数据源就消失。
    rememberSentAttachmentPreviews(
      outboxItemAttachments(item),
      (attachment) => {
        const slotIndex = item.attachmentSlots.findIndex((slot) => slot?.id === attachment.id);
        return slotIndex >= 0 ? item.slotMeta[slotIndex]?.previewUri : null;
      },
    );
    // outbox 气泡本来就在转圈:交接进 pendingQueue 后 enqueue 仍在途,徽标继续转圈,
    // 不要在这一帧闪成排队 icon 再回来(也不能谎报「已入队」)。
    markQueueItemSending(queued.clientId);
    try {
      // 弱网重试与写序边界同 send() 原路径(仅明确可安全重发的瞬时传输错误)。
      const projectionEpochAtRequestStart =
        remoteSessionStore.captureInputProjectionAuthorityEpoch(item.sessionId);
      let projection: InputProjection | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          projection = await maker.input.enqueue(item.sessionId, queued, { sendAtMs: Date.now() });
          break;
        } catch (err) {
          if (
            attempt >= ENQUEUE_RECONNECT_RETRIES
            || !isRetryableEnqueueTransportError(err)
            || isInFlightDeviceLinkError(err)
          ) throw err;
          await new Promise((resolve) => setTimeout(resolve, ENQUEUE_RECONNECT_BACKOFF_MS * 2 ** attempt));
        }
      }
      remoteSessionStore.setInputProjectionIfCurrent(
        item.sessionId,
        projection,
        projectionEpochAtRequestStart,
      );
    } catch (err) {
      // 与原路径同口径:先对账分辨「确实没应用」vs「已应用但响应丢了」。
      const applied = await (async () => {
        try {
          const projectionEpochAtRequestStart =
            remoteSessionStore.captureInputProjectionAuthorityEpoch(item.sessionId);
          const fresh = await maker.input.getProjection(item.sessionId);
          const accepted = remoteSessionStore.setInputProjectionIfCurrent(
            item.sessionId,
            fresh,
            projectionEpochAtRequestStart,
          );
          const current = accepted ? fresh : remoteSessionStore.getInputProjection(item.sessionId);
          return current.pendingQueue.some((entry) => entry.clientId === queued.clientId);
        } catch {
          return remoteSessionStore.getInputProjection(item.sessionId).pendingQueue
            .some((entry) => entry.clientId === queued.clientId);
        }
      })();
      if (!applied) {
        const current = remoteSessionStore.getInputProjection(item.sessionId);
        remoteSessionStore.setInputProjection(item.sessionId, {
          ...current,
          pendingQueue: current.pendingQueue.filter((entry) => entry.clientId !== queued.clientId),
        });
        failItem(formatRemoteError(err));
      }
      // applied:消息已在桌面队列,按成功继续(不回滚、不报错)。
    } finally {
      // 落定(入队确认 / 回 outbox 标失败)后收掉转圈:失败条目的气泡由 outbox 侧
      // 重新持有(它自己画错误徽标),排队行里不该留下悬空的在途标记。
      clearQueueItemSending(queued.clientId);
    }
  };

  /** 会话行的同步真源(store);命令式路径不能读可能落后一帧的 render 快照。 */
  const readSessionRowNow = () => remoteSessionStore.getSessions().find((item) => item.id === sessionId) ?? null;

  /**
   * 「会话参数还没就绪,现在不能 enqueue」——outbox 只排队不派发的判据。
   *
   * 这三种状态下消息仍然照常上屏(乐观语义,composer 不进只读档),只是派发要等:
   *  - 会话行还没到:没有任何可用的发送参数;
   *  - 缓存种入行:字段经瘦身 / 截断(240 字符),不能当发送参数;
   *  - 新建在途 / 创建管线未收口:会话可能还没在被控端建成,且首条 enqueue 落定前
   *    抢发的消息 sendAtMs 会早于首条、被排到它前面(newSessionCreation.ts 注释)。
   *
   * 读 store 而非 render 快照:pump 是异步循环,每轮都要看当下的真相。
   */
  const outboxDispatchBlockedNow = () => {
    const row = readSessionRowNow();
    // 「会话在被控端还不存在」是子集;派发还额外要求字段权威、创建管线已收口。
    if (isRemoteSessionMissing(row)) return true;
    if (row?.cacheSeeded) return true;
    return getNewSessionCreationTask(sessionId) !== null;
  };

  /** FIFO 派发循环:队首就绪(附件齐、无失败)才派发;失败条目留在队首阻塞后续保顺序。 */
  const pumpOutbox = async () => {
    if (outboxPumpBusyRef.current) return;
    outboxPumpBusyRef.current = true;
    try {
      for (;;) {
        const head = outboxRef.current[0];
        if (!head || !outboxItemReady(head)) return;
        // 会话未就绪:条目原样留在 outbox(气泡继续转圈,不标失败),就绪时由
        // 下方的解禁 effect 重新 pump。
        if (outboxDispatchBlockedNow()) return;
        updateOutbox((items) => replaceOutboxItem(items, { ...head, phase: 'dispatching' }));
        await dispatchOutboxItem({ ...head, phase: 'dispatching' });
      }
    } finally {
      outboxPumpBusyRef.current = false;
    }
  };

  // 上传结果路由(hook 的 onUploaded/onError 经 ref 调到最新闭包):localId 属于
  // outbox 条目 → 填槽/标失败并驱动派发,返回 true;否则返回 false 走 composer 托盘。
  routeUploadToOutboxRef.current = (localId, result) => {
    const owner = outboxRef.current.find((item) => item.slotByLocalId[localId] !== undefined);
    if (!owner) return false;
    const next = outboxWithUploadResult(outboxRef.current, localId, result);
    if (next !== outboxRef.current) outboxRef.current = next;
    // 归属校验:条目属于已离场会话(原地切 session 后 cleanup 尚未跑的一帧窗口)
    // 时只写 ref 等 cleanup 收尸——不 setState(不把旧会话气泡画进新会话)、不
    // pump(不派发离场条目);成功产物已填进槽位,cleanup 会统一回收(review P1)。
    if (owner.sessionId !== sessionId) return true;
    setOutboxItems(outboxRef.current);
    void pumpOutbox();
    return true;
  };

  /** 重试失败条目:失败附件任务重跑(取新鲜 token),enqueue 失败型直接重新派发。 */
  const retryOutboxItem = (clientId: string) => {
    const item = outboxRef.current.find((entry) => entry.clientId === clientId);
    if (!item || item.phase !== 'failed') return;
    setQueueSelectedClientId(null);
    for (const localId of item.failedIds) retryPendingUpload(localId);
    updateOutbox((items) => replaceOutboxItem(items, outboxItemRetrying(item)));
    void pumpOutbox();
  };

  /** 删除待发条目:在途上传取消(controller 会回收已完成的 OSS 对象),就绪附件回收。 */
  const removeOutboxItem = (clientId: string) => {
    const item = outboxRef.current.find((entry) => entry.clientId === clientId);
    if (!item) return;
    setQueueSelectedClientId(null);
    updateOutbox((items) => items.filter((entry) => entry.clientId !== clientId));
    for (const localId of [...item.waitingIds, ...item.failedIds]) removePendingUpload(localId);
    for (const attachment of outboxItemAttachments(item)) {
      discardMobileUploadedAttachment(attachment, { getToken: () => auth.getAccessToken() });
    }
    // 队首失败条目被删除后,后面的条目可能已就绪。
    void pumpOutbox();
  };

  const outboxDisplayItems = useMemo(() => outboxItems.map(outboxDisplayItem), [outboxItems]);

  /**
   * 取出并清空某会话的 outbox 条目(创建失败的两条收尾路径都要用)。
   *
   * 必须同步取走:调用方紧接着会 dismiss task / 删合成会话行,留在 ref 里的条目会被
   * unmount cleanup 写进一个即将消失的会话草稿里,等于丢消息。
   *
   * `uploads` 决定在途 / 失败上传任务的归宿——两条收尾路径的答案不同(review P1):
   *  - `release-to-tray`:交还 composer 托盘(留在本页时的正解)。任务继续跑,落定后
   *    routeUploadToOutbox 找不到归属条目、产物回落托盘;失败卡也回托盘可重试。取消
   *    重传是错的:用户已经等过一次上传,粘贴来源的本地文件此时可能已被回收,连重选
   *    都做不到。
   *  - `cancel`:取消并回收中转对象,返回未能保住的条数。跨页导航(返回新建页)时
   *    上传 controller 随会话页销毁,保不住,只能取消 + 由调用方告知用户。
   */
  const takeOutboxForSession = (
    targetSessionId: string,
    uploads: 'release-to-tray' | 'cancel',
  ): { items: MobileOutboxItem[]; cancelledUploadCount: number } => {
    const taken = outboxRef.current.filter((item) => item.sessionId === targetSessionId);
    if (taken.length === 0) return { items: [], cancelledUploadCount: 0 };
    updateOutbox((items) => items.filter((item) => item.sessionId !== targetSessionId));
    const pendingLocalIds = taken.flatMap((item) => [...item.waitingIds, ...item.failedIds]);
    if (uploads === 'release-to-tray') {
      // 已就绪附件的中转对象由调用方决定是否随草稿保留,不在这里回收。
      releaseClaimedUploads(pendingLocalIds);
      return { items: taken, cancelledUploadCount: 0 };
    }
    for (const localId of pendingLocalIds) removePendingUpload(localId);
    return { items: taken, cancelledUploadCount: pendingLocalIds.length };
  };

  // 待发送气泡(排队 / 落定 / 本地 outbox)作为消息流末尾的渲染项。
  //
  // 它们过去挂在列表 footer,消息回流时要跨 footer↔data 搬家:位置从「footer 落点」跳到
  // 「列表末项」,空会话时还会被撑满高度的居中同步占位顶到屏幕中间——用户看到的就是
  // 「气泡在中间 → 消失 → 在底部重新出现」。进 data 后与正式消息同容器、同 key,回流即
  // 原地变实(见 pendingSendItems.ts)。只喂给消息列表,不进 renderItems——搜索 / 相册 /
  // diff 计数只认已落库的消息。
  const pendingSendItems = useMemo(
    () => {
      const presentationByClientId = new Map<
        string,
        { actions: MobilePendingSendActions; hint: string | null }
      >();
      inputProjection.pendingQueue.forEach((item, index) => {
        const presentation = buildQueueRowPresentation({
          busy: queueBusy,
          item,
          originalIndex: index,
          projection: inputProjection,
          queueLength: inputProjection.pendingQueue.length,
          readOnlyReason: queueInlineReadOnlyReason,
        });
        presentationByClientId.set(item.clientId, {
          actions: presentation.actions,
          hint: presentation.hint,
        });
      });
      return buildPendingSendItems({
        queue: inputProjection.pendingQueue,
        settling: settlingItemsForRender,
        outbox: outboxDisplayItems,
        hiddenClientIds: queueHiddenClientIds,
        sendingClientIds: sendingQueueBadgeClientIds,
        editingClientId: queueEditing?.clientId ?? null,
        steeringClientIds: new Set(inputProjection.steeringQueueClientIds),
        presentationByClientId,
        previewByOssRef: sentPreviewByOssRefRef.current,
      });
    },
    [
      inputProjection,
      outboxDisplayItems,
      queueBusy,
      queueEditing?.clientId,
      queueHiddenClientIds,
      queueInlineReadOnlyReason,
      sendingQueueBadgeClientIds,
      settlingItemsForRender,
    ],
  );
  const messageListItems = useMemo(
    () => (pendingSendItems.length === 0 ? renderItems : [...renderItems, ...pendingSendItems]),
    [pendingSendItems, renderItems],
  );
  const shareExpandableBlockIds = useMemo(
    () => (shareSelectionActive ? collectConversationShareBlockIds(messageListItems) : []),
    [messageListItems, shareSelectionActive],
  );
  const shareExpansionSnapshot = useFoldableExpandedBlocksSnapshot(shareExpandableBlockIds);
  const shareMessages = useMemo(() => {
    if (!shareSelectionActive) return [];
    return collectConversationShareMessages(
      messageListItems,
      isFoldableBlockExpanded,
      (origin) => origin.scheduleName
        ? t('message.renderer.automationOriginNamed', { name: origin.scheduleName })
        : t('message.renderer.automationOrigin'),
    );
  }, [
    i18nInstance.language,
    messageListItems,
    shareExpansionSnapshot,
    shareSelectionActive,
  ]);
  const shareMessageById = useMemo(
    () => new Map(shareMessages.map((message) => [message.clientId, message])),
    [shareMessages],
  );
  const allShareableIds = useMemo(
    () => shareMessages.map((message) => message.clientId),
    [shareMessages],
  );
  useEffect(() => {
    if (!shareSelectionActive) return;
    const exposedSelectedIds = shareSelectionStore.getSelectedIdsInOrder(allShareableIds);
    if (exposedSelectedIds.length === shareSelectionStore.count()) return;
    shareSelectionStore.setSelection(exposedSelectedIds);
  }, [allShareableIds, shareSelectionActive]);
  const selectedShareMessages = useMemo(() => {
    if (!shareSelectionActive) return [];
    return shareSelectionStore
      .getSelectedIdsInOrder(allShareableIds)
      .map((clientId) => shareMessageById.get(clientId))
      .filter((message): message is ConversationShareMessage => message !== undefined);
  }, [allShareableIds, shareMessageById, shareSelectionActive, shareSelectionRevision]);
  const conversationShareHtml = useMemo(() => {
    if (!shareSelectionActive || selectedShareMessages.length === 0) return '';
    return buildConversationShareHtml({
      allShareableIds,
      characterSrc: shareCharacterSrc ?? undefined,
      colors: {
        background: colors.surface,
        border: colors.border,
        codeSurface: colors.chatCodeSurface,
        inlineCode: colors.chatInlineCodeText,
        surfaceChip: colors.surfaceChip,
        surfaceElevated: colors.surfaceElevated,
        syntax: {
          comment: colors.syntaxComment,
          function: colors.syntaxFunction,
          keyword: colors.syntaxKeyword,
          number: colors.syntaxNumber,
          property: colors.syntaxProperty,
          string: colors.syntaxString,
        },
        textPrimary: colors.textPrimary,
        textSecondary: colors.textSecondary,
        textTertiary: colors.textTertiary,
        dark: mode === 'dark',
      },
      contentWidth: windowDimensions.width,
      logoSrc: shareLogoModeRef.current === mode ? shareLogoSrc ?? undefined : undefined,
      selectedMessages: selectedShareMessages,
    });
  }, [
    allShareableIds,
    colors,
    mode,
    selectedShareMessages,
    shareCharacterSrc,
    shareLogoSrc,
    shareSelectionActive,
    windowDimensions.width,
  ]);
  const enterShareSelection = useCallback((clientId: string) => {
    Keyboard.dismiss();
    setShareSelectionTriggeredByScreenshot(false);
    shareSelectionStore.enter(sessionId, clientId);
  }, [sessionId]);
  const cancelShareSelection = useCallback(() => {
    shareOperationSeqRef.current += 1;
    setConversationShareBusy(false);
    setShareSelectionTriggeredByScreenshot(false);
    shareSelectionStore.exit();
  }, []);
  const exportConversationSharePng = useCallback(async (scale = 2) => {
    if (!conversationShareHtml) throw new Error('conversation share html is empty');
    const nativeBase64 = await renderConversationShareHtmlToPng({
      html: conversationShareHtml,
      scale,
      width: windowDimensions.width,
    });
    if (nativeBase64) return nativeBase64;
    const webView = conversationShareWebViewRef.current;
    if (!webView) throw new Error('conversation share renderer is unavailable');
    return webView.exportPng({ scale });
  }, [conversationShareHtml, windowDimensions.width]);
  const shareSelectedConversation = useCallback(async () => {
    if (
      conversationShareBusy
      || !shareSelectionActive
      || selectedShareMessages.length === 0
    ) return;
    const operationSeq = shareOperationSeqRef.current + 1;
    shareOperationSeqRef.current = operationSeq;
    const operationSelectionRevision = shareSelectionRevisionRef.current;
    const isShareOperationActive = () =>
      shareOperationSeqRef.current === operationSeq
      && shareSelectionActiveRef.current
      && shareSelectionRevisionRef.current === operationSelectionRevision;
    let localUri: string | null = null;
    setConversationShareBusy(true);
    try {
      if (!isShareOperationActive()) return;
      const base64 = await exportConversationSharePng();
      if (!isShareOperationActive()) return;
      localUri = await writeConversationSharePngTemp(base64);
      if (!isShareOperationActive()) return;
      if (!localUri) throw new Error(t('session.screen.shareNoLocalImage'));
      const sharing = await import('expo-sharing');
      if (!isShareOperationActive()) return;
      await sharing.shareAsync(localUri, { mimeType: 'image/png' });
      if (!isShareOperationActive()) return;
      setShareSelectionTriggeredByScreenshot(false);
      shareSelectionStore.exit();
    } catch (error) {
      if (!isShareOperationActive()) return;
      console.warn('[conversation-share] failed to generate or open share image', error);
      Alert.alert(t('session.screen.shareFailedTitle'), t('session.screen.shareImageFailed'));
    } finally {
      if (localUri && Platform.OS !== 'android') {
        await deleteConversationSharePngTemp(localUri);
      }
      if (shareOperationSeqRef.current === operationSeq) setConversationShareBusy(false);
    }
  }, [conversationShareBusy, conversationShareHtml, exportConversationSharePng, selectedShareMessages.length, shareSelectionActive, shareSelectionRevision, t]);
  // 解禁唤醒:会话参数就绪(fresh 元数据到达 / 新建管线收口)的那一帧重新 pump,把
  // 未就绪期间攒下的待发消息按 FIFO 发出去。渲染态判据与 outboxDispatchBlockedNow
  // 同构(那个读 store,供异步循环用;这个供 effect 依赖比较用)。
  // 声明位置在创建管线收口 effect 之后:enqueue-failed 那一帧要先把 outbox 条目标成
  // 失败挡住队首,再轮到这里 pump,否则后续消息会超车到首条消息前面。
  const outboxDispatchBlocked = !currentSession
    || currentSession.cacheSeeded === true
    || currentSession.pendingLocalCreation === true
    || creationTask !== null;
  useEffect(() => {
    if (outboxDispatchBlocked) return;
    void pumpOutbox();
    // pumpOutbox 是每 render 重建的普通闭包,不入依赖(入了会每帧重跑);它内部读
    // outboxRef / store 的最新真相,不依赖捕获值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outboxDispatchBlocked]);

  async function send(options: {
    draftOverride?: string;
    documentOverride?: ComposerDocument;
  } = {}) {
    if (
      voiceState === 'listening' &&
      options.draftOverride === undefined &&
      options.documentOverride === undefined
    ) {
      await finishVoiceRecording({ sendAfterTranscribe: true });
      return;
    }
    const documentAtSend = options.documentOverride
      ?? (options.draftOverride === undefined
        ? composerDocumentRef.current
        : reconcileComposerProjectedText(composerDocumentRef.current, options.draftOverride));
    const visibleDraft = composerDocumentProjectedText(documentAtSend);
    const body = visibleDraft.trim();
    const serializedAtSend = serializeComposerDocument(documentAtSend);
    const queueEditAtSendStart = queueEditingRef.current;
    const queueEditSubmission = queueEditAtSendStart
      ? resolveQueueEditTextSubmission(queueEditAtSendStart.textState, documentAtSend)
      : null;
    const queueEditPreservesEncodedQuotes = queueEditSubmission?.quotesEncoded === true;
    const text = queueEditSubmission?.text ?? serializedAtSend.text;
    const quotesEncodedAtSend = queueEditSubmission?.quotesEncoded ?? serializedAtSend.quotesEncoded;
    let agentReferencesAtSend = queueEditSubmission?.agentReferences ?? serializedAtSend.agentReferences;
    const pastedTextRangesAtSend = queueEditSubmission?.pastedTextRanges ?? serializedAtSend.pastedTextRanges;
    const slashCommandRangesAtSend = queueEditSubmission?.slashCommandRanges ?? serializedAtSend.slashCommandRanges;
    if (!canUseComposer) {
      if (options.documentOverride) applyComposerDocument(options.documentOverride);
      else if (options.draftOverride !== undefined) setComposerDraft(options.draftOverride);
      return;
    }
    if (
      (!text && attachments.length === 0 && pendingUploads.length === 0) ||
      sendInFlightRef.current ||
      sending ||
      !deviceId
    ) {
      if (options.documentOverride) applyComposerDocument(options.documentOverride);
      return;
    }
    if (!currentSession) {
      setError(t('session.screen.sessionNotFoundResync'));
      if (options.documentOverride) applyComposerDocument(options.documentOverride);
      return;
    }
    sendInFlightRef.current = true;
    setSending(true);
    setError(null);
    const outboxEligible = !queueEditAtSendStart;
    const uploadsInFlight = outboxEligible ? getPendingUploadCount() : 0;
    const willHaveAttachments = attachmentsRef.current.length > 0 || uploadsInFlight > 0;
    const earlyLocalCommand = willHaveAttachments ? null : parseMobileLocalSystemCommand(body);
    const pendingSkillAtSend = pendingSkillSelectionRef.current;
    const parsedDesktopCommandAtSend = willHaveAttachments
      ? null
      : parseMobileDesktopCommand(body, slashCommands);
    const earlyDesktopCommand =
      parsedDesktopCommandAtSend
      && pendingSkillAtSend?.sid === sessionId
      && pendingSkillAtSend.name === parsedDesktopCommandAtSend.name
        ? null
        : parsedDesktopCommandAtSend;
    // 需要远端会话的命令在会话建成前必须挡住(review P1)。
    //
    // 命令走的是下方「豁免 outbox」的原路径:/context 直接向被控端取用量、/learn 直接
    // 打蒸馏管线。合成行此刻在被控端还不存在,执行的唯一结果是把草稿消费掉、再糊一张
    // 错误卡。排队也不成立——outbox 的派发动作是「enqueue 一条消息」,命令原样入队
    // agent 只会当普通文本忽略。所以挡住 + 明说:草稿此刻还没被乐观清空(清空在下面
    // 几行),原文留在输入框,几秒后重试即可。纯本地卡不受影响(判据见
    // commandNeedsRemoteSession)。
    if (
      commandNeedsRemoteSession(earlyLocalCommand, earlyDesktopCommand)
      && isRemoteSessionMissing(readSessionRowNow())
    ) {
      setError(t('session.screen.commandWaitsForSession'));
      sendInFlightRef.current = false;
      setSending(false);
      return;
    }
    const sessionRefsAtSend = outboxEligible && !earlyLocalCommand && !earlyDesktopCommand
      ? extractMobileSessionReferences(text, remoteSessionStore.getSessionDeviceId)
      : [];
    pendingSkillSelectionRef.current = null;
    // 乐观第一拍:点发送立刻清空输入框并跟到底部,不等任何网络往返(enqueue 是
    // device-link 远程调用,弱网下数秒;文字已捕获进 text)。失败时若输入框仍为空
    // 则恢复原文——用户可能在 await 期间又打了字,不能覆盖。
    const documentBeforeSend = documentAtSend;
    // 本地命令只消费命令文本,不消费不可见的 quote atom。其它消息仍整份离开
    // composer。排队编辑不走命令分流,保存时按整条临时文档处理。
    const documentAfterOptimisticClear =
      outboxEligible && (earlyLocalCommand || earlyDesktopCommand)
        ? normalizeComposerDocument({
            version: 1,
            nodes: documentAtSend.nodes.filter((node) => node.type === 'quote'),
          })
        : emptyComposerDocument();
    const restoreDraftAfterFailure = () => {
      // 走持久化写回(setComposerDraft 而非 restoreComposerDraft):乐观清空那拍已把
      // 草稿库删除并打了 cleared 标,只回内存的话 remount 后草稿读到 null、原文丢失
      // (codex review R16)。restoreComposerDraft 的 persist:false 语义只适用于
      // 「从草稿库读出来回填」的初始化路径。
      if (composerDocumentsEqual(composerDocumentRef.current, documentAfterOptimisticClear)) {
        applyComposerDocument(documentBeforeSend);
      }
    };
    if (text) applyComposerDocument(documentAfterOptimisticClear);
    // A pasted message link is committed to the editor synchronously, while
    // its readable body is fetched from the source device asynchronously.
    // The optimistic clear above preserves the existing "tap sends this
    // snapshot" boundary; await the body on that captured document so a fast
    // send still carries semantic content without consuming later typing.
    const hydratedDocumentAtSend = await hydrateComposerMessageReferenceBodies(
      documentAtSend,
      resolvePastedSessionLinkLabel,
    );
    if (!composerDocumentsEqual(hydratedDocumentAtSend, documentAtSend)) {
      agentReferencesAtSend = queueEditAtSendStart
        ? resolveQueueEditTextSubmission(
            queueEditAtSendStart.textState,
            hydratedDocumentAtSend,
          ).agentReferences
        : serializeComposerDocument(hydratedDocumentAtSend).agentReferences;
    }
    // 排队编辑保存的编辑态快照:下方 waitForPendingUploads 可能耗时数秒,期间用户
    // 可能点 × 放弃或切换编辑目标——等待结束后以快照与最新 ref 比对,不一致则中止
    // 保存,防止编辑文本被当成一条全新消息发出(PR#709 review P1)。
    requestMessageListFollowLatest();
    // —— 乐观 outbox 路径:附件仍在上传(或 outbox 已有排队消息,保 FIFO)时不再
    // 原地等待,消息立即以待发气泡上屏,附件落定后由派发循环真正入队。豁免场景走
    // 下方原路径:排队编辑保存(语义是改队列原条目)、纯文本本地命令(/context 等,
    // 本地卡片无顺序问题;此时 composer 域无在途上传,waitForPendingUploads 秒回)。
    // 粘贴占位窗口(uploadsInFlight 计入占位数)同样走本分支:先等占位落定再划归,
    // 见分支内注释——不豁免,否则占位窗口内的发送会经原路径直接 enqueue 超车
    // outbox 在途消息(greptile review P1)。除占位等待外判断与划归全程同步,无竞态窗。
    // outboxPumpBusyRef 也算「outbox 在途」:派发起点条目即移出 outbox,enqueue
    // 弱网重试窗内 outbox 可能为空——此时新消息若走原路径会并发 enqueue 超车
    // 在途消息,破坏 FIFO(review P1);计入 pump busy 让它同样进 outbox 排队。
    // 会话参数未就绪(缓存种入 / 新建在途)同样走本分支:此刻 enqueue 不可用,但消息
    // 照常上屏,由派发循环在就绪后按序发出——composer 不再为此进只读档。
    const dispatchBlockedAtSend = outboxDispatchBlockedNow();
    if (outboxEligible && !earlyLocalCommand && !earlyDesktopCommand
      && (uploadsInFlight > 0 || outboxRef.current.length > 0 || outboxPumpBusyRef.current
        || dispatchBlockedAtSend)) {
      try {
        // workingDir 校验只对「此刻就能派发」的消息前置:dialogue 会话的工作目录由
        // 被控端在创建时分配,合成行此刻本就为空,而 dispatchOutboxItem 会在真正派发
        // 时重读 store 拿权威值并自行校验。
        if (!dispatchBlockedAtSend && !currentSession.workingDir) {
          setError(t('session.screen.missingWorkingDir'));
          restoreDraftAfterFailure();
          return;
        }
        // 粘贴占位窗口:任务尚未入队、无法划归——只等占位落定(兑现的同步段任务
        // 已入 controller;失败 / 超时 60s 兜底后同样放行,错误 toast 已由占位路径
        // 给出),不等上传本身。等待通常数百 ms(本机剪贴板),极端跨设备剪贴板由
        // 发送按钮转圈承载;等待期间 sendInFlightRef 挡住重入。
        if (hasPastePlaceholders()) await waitForPastePlaceholdersSettled();
        // 划归:当前全部未 claim 上传任务(active + 失败卡)随本条消息走——离开
        // composer 托盘与限额,产物经 onUploaded/onError 的 localId 路由回填。
        const claimedUploads = claimActiveUploads();
        const readyAttachments = attachmentsRef.current;
        // 本地预览快照(必须在下方清理 previews 映射之前取):outbox 气泡从第一帧
        // 就以图片形态渲染,不做「附件行→图片」的形态跳变;缺失时渲染层按 ossRef
        // 查 sentAttachmentThumbStore 兜底。
        const readyPreviews = readyAttachments.map((attachment) => attachmentPreviews[attachment.id] ?? null);
        // 本批映射清理(与原发送成功路径同口径):附件已随消息离开 composer 域。
        const sentAttachmentIds = new Set(readyAttachments.map((attachment) => attachment.id));
        setMediaAssetAttachments((current) => Object.fromEntries(
          Object.entries(current).filter(([, attachmentId]) => !sentAttachmentIds.has(attachmentId)),
        ));
        setAttachmentPreviews((current) => Object.fromEntries(
          Object.entries(current).filter(([attachmentId]) => !sentAttachmentIds.has(attachmentId)),
        ));
        for (const attachmentId of sentAttachmentIds) {
          composerAnnotationsRef.current?.forgetAttachment(attachmentId);
        }
        setAttachments([]);
        attachmentsRef.current = [];
        setAttachmentError(null);
        // plan 一次性语义:权限档快照进条目(派发按快照发),chip 立即恢复——
        // 不等附件上传完,与「消息已发出」的乐观语义一致。
        const permissionModeAtSend = permissionModeOrAsk(currentSession.permissionMode);
        if (permissionModeAtSend === 'plan') {
          const fallback = runtimeOptions?.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask';
          const remembered = prePlanPermissionModeRef.current;
          const restored = remembered && remembered !== 'plan' ? remembered : fallback;
          void maker.setPermissionMode(sessionId, restored).catch(() => undefined);
        }
        updateOutbox((items) => [...items, buildOutboxItem({
          clientId: createOutboxClientId(),
          sessionId,
          text,
          quotesEncoded: quotesEncodedAtSend,
          sessionRefs: sessionRefsAtSend,
          agentReferences: agentReferencesAtSend,
          pastedTextRanges: pastedTextRangesAtSend,
          slashCommandRanges: slashCommandRangesAtSend ?? [],
          permissionModeAtSend,
          readyAttachments,
          readyPreviews,
          claimedUploads,
        })]);
        voiceDictionaryLearningTrackerRef.current?.flush();
        requestMessageListFollowLatest();
        void pumpOutbox();
      } finally {
        sendInFlightRef.current = false;
        setSending(false);
      }
      return;
    }
    try {
      // 拍照 / 选图后立刻点发送是常见路径:等在途图片上传落定(乐观托盘)。
      // 有失败就中止发送——错误文案已由上传回调写入 attachmentError,让用户处理。
      const { failedCount } = await waitForPendingUploads();
      if (failedCount > 0) {
        restoreDraftAfterFailure();
        return;
      }
      // await 之后闭包里的 attachments 是旧值,经 ref 拿含刚落定图片的最新列表。
      const sendAttachments = attachmentsRef.current;
      // currentSession 同理是等待前的快照:上传等待期间(sending 不锁控制面板)用户
      // 可能已切 model / effort / permission / fast,重读 store 拿最新会话字段,
      // 排队消息与 UI 显示的运行时保持一致(codex review R19)。
      const sessionAtSend = remoteSessionStore.getSessions().find((item) => item.id === sessionId)
        ?? currentSession;
      const hasAttachments = sendAttachments.length > 0;
      if (!text && !hasAttachments) return;
      // 排队消息编辑态:发送按钮语义变为「保存修改」——整条内容(文本+附件)替换回
      // 队列原条目,不入队新消息。保存成功后恢复进入编辑前的草稿与附件托盘。
      // 以 send 起点的快照为准:等待上传期间编辑被取消/切换则中止(取消路径已恢复
      // stash,这里不再动 composer,也绝不落成新消息)。
      const editingQueueItem = queueEditAtSendStart;
      if (editingQueueItem && queueEditingRef.current?.clientId !== editingQueueItem.clientId) {
        return;
      }
      if (editingQueueItem) {
        const original = remoteSessionStore.getInputProjection(sessionId).pendingQueue
          .find((entry) => entry.clientId === editingQueueItem.clientId);
        if (!original) {
          // 条目已被远端发出/删除(vanish effect 与本次点击竞态):原文不可改,放弃保存。
          setError(t('session.screen.queueMessageGone'));
          cancelQueueEdit();
          return;
        }
        const updatedDraft = {
          ...buildQueuedTextMessage(sessionAtSend, text, new Date(), editingQueueItem.clientId, {
            attachments: sendAttachments,
            quotesEncoded: queueEditPreservesEncodedQuotes,
            agentReferences: agentReferencesAtSend,
            pastedTextRanges: pastedTextRangesAtSend,
            slashCommandRanges: slashCommandRangesAtSend,
          }),
          ...(original.sessionRefs && original.sessionRefs.length > 0
            ? { sessionRefs: [...original.sessionRefs] }
            : {}),
        };
        let updated: QueuedRemoteMessage;
        try {
          updated = await prepareMobileQueuedSessionReferences(
            updatedDraft,
            invoke,
            remoteSessionStore.getSessionDeviceId,
            deviceId,
          );
        } catch (err) {
          restoreDraftAfterFailure();
          throw err;
        }
        // 引用解析会跨设备等待；期间用户可能切换或放弃编辑，落库前再次确认仍持有同一行。
        // (取消 / 切换路径已按 lock owner 排队释放锁,这里不再直发解锁 RPC。)
        if (queueEditingRef.current?.clientId !== editingQueueItem.clientId) {
          return;
        }
        // 保存必须等加锁落定,并在 update-content / update-text 完成后再解锁。
        // owner 在交给 commitQueueEdit 后由它独占,避免取消 / 卸载重复解锁。
        const currentLockOwner = queueEditLockOwnerRef.current;
        const lockOwner = currentLockOwner?.clientId === editingQueueItem.clientId
          ? currentLockOwner
          : acquireQueueEditLock(null, editingQueueItem.clientId, setQueueEditLock);
        queueEditLockOwnerRef.current = null;
        queueEditSaveOwnerRef.current = lockOwner;
        let lockReady = false;
        let editSaved = false;
        const restoreQueueEditDraftAfterFailure = () => {
          if (queueEditingRef.current?.clientId === editingQueueItem.clientId) {
            restoreDraftAfterFailure();
          }
        };
        const save = (async () => {
          await lockOwner.ready;
          lockReady = true;
          editSaved = await commitQueueEdit(lockOwner, async () => {
            try {
              const projectionEpochAtRequestStart =
                remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
              const projection = await maker.input.updateContent(sessionId, editingQueueItem.clientId, updated);
              applyProjectionIfCurrent(projection, projectionEpochAtRequestStart);
            } catch (err) {
              if (
                isChannelNotAllowedError(err)
                && text.trim().length > 0
                && attachmentIdSetsEqual(original.files, sendAttachments)
                && queuedMessageHasEncodedQuotes(original) === queueEditPreservesEncodedQuotes
              ) {
                // 旧被控端无 update-content:附件与 quote metadata 都不变、文本非空时
                // 才退回 update-text。空文本不降级——旧端 update-text 对空文本静默 no-op,会造成"看似
                // 保存成功、队列还是旧文案"的假成功(review P2)。降级本身失败(弱网两次
                // RPC 之间断连)与其余失败分支对称:先还原编辑文本再抛,不许静默丢字
                // (review P1)。
                try {
                  const projectionEpochAtRequestStart =
                    remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
                  const projection = await maker.input.updateText(
                    sessionId,
                    editingQueueItem.clientId,
                    text,
                    updated.sessionRefs,
                    updated.trustedSessionReferenceContexts,
                  );
                  applyProjectionIfCurrent(projection, projectionEpochAtRequestStart);
                } catch (fallbackErr) {
                  restoreQueueEditDraftAfterFailure();
                  throw fallbackErr;
                }
              } else if (isChannelNotAllowedError(err)) {
                setError(t('session.screen.editQueueUnsupported'));
                restoreQueueEditDraftAfterFailure();
                return false;
              } else {
                restoreQueueEditDraftAfterFailure();
                throw err;
              }
            }
            return true;
          });
        })();
        queueEditSaveInFlightRef.current = save;
        try {
          await save;
        } catch (err) {
          restoreQueueEditDraftAfterFailure();
          if (
            queueEditSaveOwnerRef.current === lockOwner
            && queueEditingRef.current?.clientId === editingQueueItem.clientId
          ) {
            queueEditSaveOwnerRef.current = null;
            queueEditLockOwnerRef.current = lockReady
              ? lockOwner
              : acquireQueueEditLock(null, editingQueueItem.clientId, setQueueEditLock);
          }
          throw err;
        } finally {
          if (queueEditSaveInFlightRef.current === save) queueEditSaveInFlightRef.current = null;
        }
        if (!editSaved) {
          if (
            queueEditSaveOwnerRef.current === lockOwner
            && queueEditingRef.current?.clientId === editingQueueItem.clientId
          ) {
            queueEditSaveOwnerRef.current = null;
            queueEditLockOwnerRef.current = lockOwner;
          }
          return;
        }
        if (queueEditSaveOwnerRef.current === lockOwner) {
          queueEditSaveOwnerRef.current = null;
        }
        // 已保存进队列的附件从相册勾选/预览映射摘除(同正常发送路径的差集清理),
        // 否则恢复 stash 后相册面板仍显示"已附加"角标。
        const savedAttachmentIds = new Set(sendAttachments.map((attachment) => attachment.id));
        setMediaAssetAttachments((current) => Object.fromEntries(
          Object.entries(current).filter(([, attachmentId]) => !savedAttachmentIds.has(attachmentId)),
        ));
        setAttachmentPreviews((current) => Object.fromEntries(
          Object.entries(current).filter(([attachmentId]) => !savedAttachmentIds.has(attachmentId)),
        ));
        // 成功:锁已由 commitQueueEdit 释放,退出编辑态并恢复 stash。
        if (queueEditingRef.current?.clientId === editingQueueItem.clientId) {
          cancelQueueEdit();
        }
        voiceDictionaryLearningTrackerRef.current?.flush();
        return;
      }
      // 命令判定用 body(不含引用块):带引用时 /context 等本地命令仍生效,且不消费引用。
      const localSystemCommand = hasAttachments ? null : earlyLocalCommand;
      // desktop 命令(/learn)按名字白名单分流;同名 agent-skill 优先让行(对齐桌面
      // dispatch 语义),清单未加载时白名单兜底拦截。
      // slashCommands 在 palette 打开时含已加载清单(同名 skill 让行);palette
      // 关闭时被清为[],退回白名单。例外:用户从 palette 点选了 agent-skill
      // (pendingSkillSelectionRef 有值)时,即使 slashCommands 已清也应让行——
      // 点选意图明确,不应被白名单覆盖。点选后再次打开 palette 或发送后 ref 清零。
      const desktopCommand = hasAttachments ? null : earlyDesktopCommand;
      if (!sessionAtSend.workingDir && !localSystemCommand && !desktopCommand) {
        setError(t('session.screen.missingWorkingDir'));
        restoreDraftAfterFailure();
        return;
      }
      if (desktopCommand?.name === 'learn') {
        // /learn 是被控端宿主功能:直调 learn:start(execute-desktop-command 被
        // allowlist 永久禁止),绝不进 agent 队列——原样 enqueue 的话 agent 只会当
        // 普通文本忽略。蒸馏在被控端后台跑,这里以本地系统卡反馈启动结果。
        let cardData: Record<string, unknown>;
        try {
          const { runId } = await maker.learnStart(
            buildLearnStartRequest(desktopCommand.args, sessionId),
          );
          cardData = buildLearnCardData({ runId });
        } catch (err) {
          cardData = buildLearnCardData({ errorMessage: formatRemoteError(err) });
          // 启动失败(LEARN_BUSY / CHANNEL_NOT_ALLOWED 等):恢复草稿供用户重试。
          restoreDraftAfterFailure();
        }
        remoteSessionStore.appendLocalSystemCard(sessionId, 'learn', cardData);
        voiceDictionaryLearningTrackerRef.current?.flush();
        // 成功时草稿已在乐观第一拍清空;失败时上方已恢复——两路都跟到底部。
        requestMessageListFollowLatest();
        return;
      }
      if (localSystemCommand) {
        let data: Record<string, unknown>;
        if (localSystemCommand === 'context') {
          setContextLoading(true);
          try {
            const usage = await maker.getContextUsage(
              sessionId,
              buildContextUsageCreateOpts(sessionAtSend),
            );
            setContextUsage(usage);
            data = buildMobileSystemCardData(localSystemCommand, {
              contextUsage: usage,
              projection: inputProjection,
              remoteCommands: slashCommands,
              session: sessionAtSend,
            });
          } catch (err) {
            data = buildMobileSystemCardData(localSystemCommand, {
              contextError: formatRemoteError(err),
              projection: inputProjection,
              remoteCommands: slashCommands,
              session: sessionAtSend,
            });
          } finally {
            setContextLoading(false);
          }
        } else {
          data = buildMobileSystemCardData(localSystemCommand, {
            projection: inputProjection,
            remoteCommands: slashCommands,
            session: sessionAtSend,
          });
        }
        remoteSessionStore.appendLocalSystemCard(sessionId, localSystemCommand, data);
        voiceDictionaryLearningTrackerRef.current?.flush();
        // 草稿已在乐观第一拍清空,这里只需跟到底部。
        requestMessageListFollowLatest();
        return;
      }
      const queuedDraft = buildQueuedTextMessage(sessionAtSend, text, new Date(), undefined, {
        attachments: sendAttachments,
        quotesEncoded: quotesEncodedAtSend,
        agentReferences: agentReferencesAtSend,
        pastedTextRanges: pastedTextRangesAtSend,
        slashCommandRanges: slashCommandRangesAtSend,
      });
      let queued: QueuedRemoteMessage;
      try {
        queued = await prepareMobileQueuedSessionReferences(
          queuedDraft,
          invoke,
          remoteSessionStore.getSessionDeviceId,
          deviceId,
        );
      } catch (err) {
        restoreDraftAfterFailure();
        throw err;
      }
      // 乐观第二拍:附件落定后立即把 queued 追加进本地 projection,消息气泡当帧上屏、
      // 托盘同帧清空;enqueue 成功后用权威 projection 覆盖 reconcile。
      // previews / mediaAssetAttachments 映射保留到成功后再清:它们不入消息体,失败
      // 恢复 attachments 时缩略图能原样回来。
      const projectionBeforeSend = remoteSessionStore.getInputProjection(sessionId);
      remoteSessionStore.setInputProjection(sessionId, {
        ...projectionBeforeSend,
        sessionId: projectionBeforeSend.sessionId || sessionId,
        pendingQueue: [...projectionBeforeSend.pendingQueue, queued],
      });
      // 排队气泡的图立刻可见(先记预览,再让 projection 变化触发重算)。
      rememberSentAttachmentPreviews(
        sendAttachments,
        (attachment) => attachmentPreviews[attachment.id],
      );
      // 乐观气泡此刻还没有「已入队」这个事实:徽标先给转圈,enqueue 落定后才交给
      // 排队 icon(或随回滚一起消失)。
      markQueueItemSending(queued.clientId);
      setAttachments([]);
      attachmentsRef.current = [];
      // 标注再编辑真相(矢量笔迹 + 原图副本)不在乐观段清:enqueue 失败回滚恢复
      // 托盘后,标注附件必须还能继续编辑/撤销(review P2);成功收尾按本批精确清。
      setAttachmentError(null);
      requestMessageListFollowLatest();
      try {
        // 弱网重试:切基站 / 短暂断连时自动补发,不让用户为一次抖动手动重发。
        // 写序边界(codex review P1 + auto-review P1):只有「保证未发出」的
        // NOT_CONNECTED 仅在 inFlight 未置位时允许自动重发——
        // in-flight 被断连批量 reject 的 NOT_CONNECTED 可能已送达(ack 丢失),
        // 且 projection 无法证明未入队(空闲 agent 下消息瞬间进 activeTurn、
        // 不在 pendingQueue 里),盲重会双入队;这类歧义失败直接交给下方 catch
        // 的回滚/报错路径。BACKPRESSURE 在本地发送前或被控端 admission 拒绝
        // 执行时产生,可安全重发。被控端 enqueue 侧另有 clientId 幂等去重兜底。
        const projectionEpochAtRequestStart =
          remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
        let projection: InputProjection | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            projection = await maker.input.enqueue(sessionId, queued, { sendAtMs: Date.now() });
            break;
          } catch (err) {
            if (
              attempt >= ENQUEUE_RECONNECT_RETRIES
              || !isRetryableEnqueueTransportError(err)
              || isInFlightDeviceLinkError(err)
            ) throw err;
            await new Promise((resolve) => setTimeout(resolve, ENQUEUE_RECONNECT_BACKOFF_MS * 2 ** attempt));
          }
        }
        remoteSessionStore.setInputProjectionIfCurrent(
          sessionId,
          projection,
          projectionEpochAtRequestStart,
        );
      } catch (err) {
        // 回滚前先分辨「确实没应用」vs「已应用但响应丢了」:弱网下 enqueue 的 invoke
        // 响应可能超时丢失而桌面端已入队——此时摘除气泡会让手机隐藏一条桌面将处理的
        // 消息,用户重发即重复(codex review R19)。优先 refetch 权威 projection 判断,
        // refetch 也失败再退回本地 store(订阅推送在此窗口内可能已带回该 clientId)。
        const applied = await (async () => {
          try {
            const projectionEpochAtRequestStart =
              remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
            const fresh = await maker.input.getProjection(sessionId);
            const accepted = remoteSessionStore.setInputProjectionIfCurrent(
              sessionId,
              fresh,
              projectionEpochAtRequestStart,
            );
            // If a newer push/terminal boundary won the fence, the fetched value is
            // stale for both the mirror and the applied decision; consult current state.
            const current = accepted ? fresh : remoteSessionStore.getInputProjection(sessionId);
            return current.pendingQueue.some((item) => item.clientId === queued.clientId);
          } catch {
            return remoteSessionStore.getInputProjection(sessionId).pendingQueue
              .some((item) => item.clientId === queued.clientId);
          }
        })();
        if (!applied) {
          // 回滚:按 clientId 精确摘除乐观气泡(期间 projection 可能已被其他事件更新,
          // 不能整体还原快照),并恢复草稿与附件托盘。
          const current = remoteSessionStore.getInputProjection(sessionId);
          remoteSessionStore.setInputProjection(sessionId, {
            ...current,
            pendingQueue: current.pendingQueue.filter((item) => item.clientId !== queued.clientId),
          });
          // 合并而非替换(与成功路径的差集清理对称,codex review R11):enqueue 在途期间
          // 新落定的附件已进 attachments / ref,整体覆盖会把它从托盘丢掉且预览映射残留、
          // OSS 中转对象失去 UI 移除路径;恢复本批的同时保留期间新增。
          const restoredIds = new Set(sendAttachments.map((attachment) => attachment.id));
          const mergeRestored = (current: RemoteSerializedAttachment[]) => [
            ...sendAttachments,
            ...current.filter((attachment) => !restoredIds.has(attachment.id)),
          ];
          attachmentsRef.current = mergeRestored(attachmentsRef.current);
          setAttachments(mergeRestored);
          restoreDraftAfterFailure();
          throw err;
        }
        // applied:消息已在桌面队列(权威 / 推送 projection 已含该 clientId),
        // 按成功继续——不回滚、不报错,后续收尾(plan 恢复 / 映射清理)照常执行。
      } finally {
        // 成功、对账认定已入队、回滚 throw 三条路径都算「不再在途」:转圈必须收掉,
        // 否则回滚后集合残留、同 clientId 重发时首帧仍是转圈。
        clearQueueItemSending(queued.clientId);
      }
      if (sessionAtSend.permissionMode === 'plan') {
        // 一次性语义(对齐桌面 PR#494 / 产品决策):计划模式只对本条消息生效,发送后
        // 自动恢复进入前的权限档;本条消息通常已按 plan 派发,切换只影响后续消息。
        // best-effort:失败不打断发送流程,chip 会保留、用户可手动退出。
        const fallback = runtimeOptions?.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask';
        const remembered = prePlanPermissionModeRef.current;
        const restored = remembered && remembered !== 'plan' ? remembered : fallback;
        void maker.setPermissionMode(sessionId, restored).catch(() => undefined);
      }
      voiceDictionaryLearningTrackerRef.current?.flush();
      // 只清本次实际发出那批(sendAttachments)的映射:enqueue 在途期间(弱网数秒)
      // composer 全程可交互,期间新落定的附件已写进这两个映射——全量清空会把它们的
      // 托盘缩略图与相册面板勾选角标误清掉,而附件本身还留在 attachments 里随下一条
      // 消息发出,状态与实际不符(codex review R9)。
      const sentAttachmentIds = new Set(sendAttachments.map((attachment) => attachment.id));
      setMediaAssetAttachments((current) => Object.fromEntries(
        Object.entries(current).filter(([, attachmentId]) => !sentAttachmentIds.has(attachmentId)),
      ));
      setAttachmentPreviews((current) => Object.fromEntries(
        Object.entries(current).filter(([attachmentId]) => !sentAttachmentIds.has(attachmentId)),
      ));
      // 标注再编辑真相同口径按本批清(而非全量):在途期间新标注的附件仍可编辑。
      for (const attachmentId of sentAttachmentIds) {
        composerAnnotationsRef.current?.forgetAttachment(attachmentId);
      }
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  // Keep the latest send available to imperative callers (voice release-to-send, long-press)
  // without mutating a ref during render — update it after commit instead.
  useEffect(() => {
    sendLatestRef.current = send;
  });

  const applyProjectionIfCurrent = useCallback((projection: InputProjection, expectedEpoch: number) => {
    remoteSessionStore.setInputProjectionIfCurrent(sessionId, projection, expectedEpoch);
  }, [sessionId]);

  const runQueueAction = useCallback(async (
    action: () => Promise<InputProjection | boolean>,
  ) => {
    if (queueBusy) return;
    setQueueBusy(true);
    setError(null);
    const projectionEpochAtRequestStart =
      remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
    try {
      const result = await action();
      if (typeof result !== 'boolean') {
        applyProjectionIfCurrent(result, projectionEpochAtRequestStart);
      }
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setQueueBusy(false);
    }
  }, [applyProjectionIfCurrent, queueBusy, sessionId]);

  /**
   * 乐观队列操作(remove / move 这类纯队列变换):先本地改 pendingQueue 当帧给反馈,
   * RPC 返回后用权威 projection 覆盖;失败按 rollback 精确还原(不能整体还原快照——
   * 期间 projection 可能已被其他事件更新)。queueBusy 仍串行化并发操作,只是行内
   * 视觉反馈不再等 device-link 往返。
   */
  const runOptimisticQueueAction = useCallback(async (opts: {
    optimistic: (current: InputProjection) => InputProjection;
    rollback: (current: InputProjection) => InputProjection;
    action: () => Promise<InputProjection | boolean>;
  }) => {
    if (queueBusy) return;
    setQueueBusy(true);
    setError(null);
    remoteSessionStore.setInputProjection(
      sessionId,
      opts.optimistic(remoteSessionStore.getInputProjection(sessionId)),
    );
    const projectionEpochAtRequestStart =
      remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
    try {
      const result = await opts.action();
      if (typeof result !== 'boolean') {
        applyProjectionIfCurrent(result, projectionEpochAtRequestStart);
      }
    } catch (err) {
      remoteSessionStore.setInputProjection(
        sessionId,
        opts.rollback(remoteSessionStore.getInputProjection(sessionId)),
      );
      setError(formatRemoteError(err));
    } finally {
      setQueueBusy(false);
    }
  }, [applyProjectionIfCurrent, queueBusy, sessionId]);

  // stop 的视觉状态派生自 run status / projection,只有往返后才变;这里补一个本地
  // pending 态让按钮当帧转圈,消除「点了没反应」的歧义。
  const [stopPending, setStopPending] = useState(false);
  const stopSession = () => {
    if (queueBusy) return;
    setStopPending(true);
    void runQueueAction(() => maker.input.stop(sessionId, stopOptionsForProjection(inputProjection)))
      .finally(() => setStopPending(false));
  };

  const renderComposerAttachmentButton = () => (
    <RouteActionButton
      accessibilityLabel={composerLayout.attachment.active ? composerLayout.attachment.label : t('session.common.openContextPanel')}
      accessibilityHint={composerLayout.attachment.disabledReason ?? composerSendUnavailableReason ?? undefined}
      active={composerLayout.attachment.active}
      disabled={composerLayout.attachment.disabled || (!canUseComposer && !composerLayout.attachment.active)}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={() => {
        setModelSheetOpen(false);
        setContextSheetView('main');
        setContextSheetOpen(true);
      }}
      style={[
        styles.composerInlineToolButton,
        composerLayout.attachment.active && styles.composerToolButtonActive,
      ]}
      testID="session.attachmentToggleButton"
    >
      <Plus
        color={composerLayout.attachment.active ? colors.textPrimary : colors.textSecondary}
        size={iconSize.sm}
        strokeWidth={iconStroke.regular}
      />
    </RouteActionButton>
  );

  // 展开(card)态输入卡内的附件缩略图托盘(对照 Cursor,图片在输入卡里、文字上方)。
  const renderComposerAttachmentTray = () => (
    <ComposerAttachmentTray
      attachments={attachments}
      onPreview={setComposerPreviewAttachmentId}
      onRemove={removeRemoteFileAttachment}
      onRemovePending={removePendingUpload}
      onRetryPending={retryPendingUpload}
      pastePlaceholderCount={pastePlaceholderCount}
      pendingUploads={pendingUploads}
      previews={attachmentPreviews}
      removeDisabled={composerLayout.attachment.remove.disabled}
      removeDisabledReason={composerLayout.attachment.remove.disabledReason ?? undefined}
      testIDPrefix="session"
    />
  );

  // 收起态附件徽标(leading 仅在非 card 态渲染);点击聚焦输入框展开完整托盘。
  const renderComposerCollapsedAttachmentBadge = () => (attachments.length > 0 || pendingUploads.length > 0 || pastePlaceholderCount > 0 ? (
    <ComposerAttachmentCollapsedBadge
      attachments={attachments}
      onPress={() => composerInputRef.current?.focus()}
      pastePlaceholderCount={pastePlaceholderCount}
      pendingUploads={pendingUploads}
      previews={attachmentPreviews}
      testID="session.attachmentCollapsedBadge"
    />
  ) : null);

  // 停止任务按钮(实心中性方块)。两处使用:语音/发送左边的独立槽(inline)、
  // 发送位顶替(sendSlotIsStop);同一颗按钮的两个宿主位置,样式与行为一致。
  const renderComposerStopButton = () => (
    <RouteActionButton
      accessibilityLabel={t('session.screen.stopSession')}
      accessibilityHint={composerLayout.stop.disabledReason ?? undefined}
      disabled={composerLayout.stop.disabled}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={stopSession}
      pressedStyle={styles.sendButtonPressed}
      style={[
        styles.sendButton,
        composerLayout.stop.disabled && styles.sendButtonInactive,
      ]}
      testID="session.stopButton"
    >
      {stopPending ? (
        <ActivityIndicator color={composerLayout.stop.disabled ? colors.textSecondary : colors.ctaText} size="small" />
      ) : (
        <Square
          color={composerLayout.stop.disabled ? colors.textSecondary : colors.ctaText}
          // 停止钮实心 Square:10px 填充块语义(非阶梯图标),零描边即语义本身
          // (designTokenDiscipline ALLOWLIST 登记豁免)。
          size={10}
          strokeWidth={0}
          fill={composerLayout.stop.disabled ? colors.textSecondary : colors.ctaText}
        />
      )}
    </RouteActionButton>
  );

  // 停止任务次槽:渲染在语音按钮**左边**(对齐桌面 2026-07-25 定案),不夹在
  // 语音与发送之间——右对齐按钮组里语音永远是发送槽的左邻,录音胶囊只向左
  // 生长,「原地再点一下」永远是停止录音,不会误停任务。
  const renderComposerInlineStop = () => composerShowInlineStop ? renderComposerStopButton() : null;

  const renderComposerSendSlot = () => (
    <>
      {composerSendSlotIsStop ? (
        renderComposerStopButton()
      ) : composerShowSendButton ? (
        <RouteActionButton
          ref={sendButtonRef}
          accessibilityLabel={voiceIsListening ? t('session.screen.voiceStopAndSend') : t('session.screen.sendMessage')}
          accessibilityHint={composerLayout.send.disabledReason ?? composerLayout.guidanceText}
          disabled={composerSendDisabled}
          hitSlop={COMPOSER_CONTROL_HIT_SLOP}
          onLayout={measureSendButtonTarget}
          onPress={send}
          pressedStyle={styles.sendButtonPressed}
          style={[
            styles.sendButton,
            voiceReleaseToSendActive && styles.sendButtonVoiceTarget,
            composerSendDisabled && styles.sendButtonInactive,
          ]}
          testID="session.sendButton"
        >
          {sending ? (
            <ActivityIndicator color={colors.textSecondary} size="small" />
          ) : (
            <PaperPlaneIcon
              color={composerSendDisabled ? colors.textSecondary : colors.ctaText}
              size={iconSize.lg}
            />
          )}
        </RouteActionButton>
      ) : null}
    </>
  );

  // 简洁态(非卡片)输入行行尾的按钮组:[停止任务][语音占位][发送槽]。
  // 语音按钮本体是 absolute 锚点浮标(右缘 52pt 档),占位 slot 在 flex 流里
  // 为它留出与发送槽相邻的位置,停止任务被推到占位左边,不落进语音的命中带。
  const renderComposerTrailingActions = () => (
    <>
      {renderComposerInlineStop()}
      {composerShowInlineStop && composerVoicePlacement?.floating
        ? <ComposerToolbarVoiceSlot width={voiceRecordingTimer.pillWidth} />
        : null}
      {renderComposerSendSlot()}
    </>
  );

  const resumeQueue = () => {
    void runQueueAction(() => maker.input.resume(sessionId));
  };

  const steerQueueItem = (item: QueuedRemoteMessage) => {
    void runQueueAction(async () => {
      // Projections omit trusted bodies. Prefer fresh source data, while allowing the
      // target to restore its main-owned snapshot when the source is unavailable.
      const prepared = await prepareMobileQueuedSessionReferencesForSteer(
        item,
        invoke,
        remoteSessionStore.getSessionDeviceId,
        deviceId,
      );
      const accepted = await maker.input.steer(sessionId, prepared, { removeFromQueue: true, touchUserSend: true });
      const projectionEpochAtRequestStart =
        remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
      const projection = await maker.input.getProjection(sessionId);
      remoteSessionStore.setInputProjectionIfCurrent(
        sessionId,
        projection,
        projectionEpochAtRequestStart,
      );
      return accepted;
    });
  };

  const setQueueEditLock = useCallback((clientId: string, locked: boolean) => {
    const projectionEpochAtRequestStart =
      remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
    return maker.input.setEditLock(sessionId, clientId, locked)
      .then((projection) => applyProjectionIfCurrent(projection, projectionEpochAtRequestStart))
      .catch((err) => {
        if (queueEditingRef.current?.clientId === clientId) {
          setError(formatRemoteError(err));
        }
        throw err;
      });
  }, [applyProjectionIfCurrent, maker, sessionId]);

  const removeQueueItem = (clientId: string) => {
    const before = remoteSessionStore.getInputProjection(sessionId);
    const index = before.pendingQueue.findIndex((item) => item.clientId === clientId);
    const removed = index >= 0 ? before.pendingQueue[index] : undefined;
    // 用户主动删除:标记进 locallyRemoved,settling 跟踪不再把这次出队当成
    // "派发中"渲染幽灵气泡;回滚(删除失败)时撤销标记。
    setLocallyRemovedQueueClientIds((current) => {
      if (current.has(clientId)) return current;
      const next = new Set(current);
      next.add(clientId);
      return next;
    });
    if (!removed) {
      void runQueueAction(() => maker.input.remove(sessionId, clientId));
      return;
    }
    void runOptimisticQueueAction({
      optimistic: (current) => ({
        ...current,
        pendingQueue: current.pendingQueue.filter((item) => item.clientId !== clientId),
      }),
      rollback: (current) => {
        setLocallyRemovedQueueClientIds((current) => {
          if (!current.has(clientId)) return current;
          const next = new Set(current);
          next.delete(clientId);
          return next;
        });
        const next = [...current.pendingQueue];
        next.splice(Math.min(index, next.length), 0, removed);
        return { ...current, pendingQueue: next };
      },
      action: () => maker.input.remove(sessionId, clientId),
    });
  };

  /**
   * 回收某次排队编辑期间"新增"的附件(不在 stash、也不是该队列条目自身 files):
   * OSS 中转对象 best-effort 删除 + 预览/相册勾选映射清理,避免 UI 不可达的孤儿
   * 引用。保存/放弃/切换编辑目标/会话切换四条退出路径共用(PR#709 review P1/P2)。
   * 队列条目自身 files 不回收——仍被条目引用,且 enqueue 时已物化为被控端本地
   * 路径,discard 对非 OSS 引用本就是 no-op,双保险。
   */
  const discardQueueEditTransientAttachmentResources = useCallback((
    editing: QueueEditingState,
    attachmentsAtExit: readonly RemoteSerializedAttachment[],
  ) => {
    const stashedIds = new Set(editing.stashedAttachments.map((item) => item.id));
    const entryFileIds = new Set(
      (remoteSessionStore.getInputProjection(sessionId).pendingQueue
        .find((item) => item.clientId === editing.clientId)?.files ?? [])
        .map((item) => item.id),
    );
    const discardedIds = new Set<string>();
    for (const attachment of attachmentsAtExit) {
      if (stashedIds.has(attachment.id) || entryFileIds.has(attachment.id)) continue;
      discardMobileUploadedAttachment(attachment, { getToken: () => auth.getAccessToken() });
      discardedIds.add(attachment.id);
    }
    return discardedIds;
  }, [auth, sessionId]);

  const discardQueueEditTransientAttachments = useCallback((
    editing: QueueEditingState,
    attachmentsAtExit: readonly RemoteSerializedAttachment[] = attachmentsRef.current,
  ) => {
    // 同 session 的正常退出要同步丢弃编辑期在途上传：进入编辑有 pendingUploads
    // 为空的门槛，因此此刻的任务必然是编辑期新增。会话切换的迟到 finalize 不走
    // 这里，避免旧 A 回调清掉复用 controller 上 B 刚开始的上传。
    discardAllPendingUploads();
    const discardedIds = discardQueueEditTransientAttachmentResources(editing, attachmentsAtExit);
    if (discardedIds.size > 0) {
      setAttachmentPreviews((current) => Object.fromEntries(
        Object.entries(current).filter(([attachmentId]) => !discardedIds.has(attachmentId)),
      ));
      setMediaAssetAttachments((current) => Object.fromEntries(
        Object.entries(current).filter(([, attachmentId]) => !discardedIds.has(attachmentId)),
      ));
    }
  }, [discardAllPendingUploads, discardQueueEditTransientAttachmentResources]);
  useEffect(() => {
    discardQueueEditTransientAttachmentResourcesRef.current =
      discardQueueEditTransientAttachmentResources;
  }, [discardQueueEditTransientAttachmentResources]);

  /**
   * 进入排队消息编辑:把条目的文本/附件载入底部 composer(复用其全部编辑能力),
   * 暂存用户原本的草稿与附件托盘;桌面端同步加编辑锁,期间该条不会被自动派发。
   * 已在编辑另一条时切换目标:沿用最初的 stash(用户真正的草稿),旧条目解锁,
   * 且旧条目编辑期间新增的附件先回收再覆写托盘(否则成为 OSS 孤儿,review P2)。
   */
  const beginQueueEdit = (item: QueuedRemoteMessage) => {
    if (queueInlineReadOnlyReason || queueBusy) return;
    // 上一条的保存(update-content)在途时不允许进入/切换编辑:切换路径会立即解锁
    // 旧条目并回收其编辑期附件,与在途 RPC 竞争——桌面端可能用旧内容抢先派发,或
    // OSS 引用在物化完成前被删(review P2)。编辑生命周期的全部入口/出口由此都被
    // in-flight promise 串行化。
    if (queueEditSaveInFlightRef.current) {
      setError(t('session.screen.savingPreviousQueueEdit'));
      return;
    }
    // 托盘里还有在途上传时不进入编辑:上传完成回调会把文件追加进当前托盘,编辑中
    // 落定会把用户的草稿附件误挂到队列条目上、取消时又会被当作编辑期新增而回收
    // (review P1)。等待落定后再编辑,错误文案给出下一步。
    if (pendingUploads.length > 0) {
      setError(t('session.screen.attachmentsUploadingBeforeEdit'));
      return;
    }
    const previous = queueEditingRef.current;
    if (previous?.clientId === item.clientId) return;
    if (previous) {
      discardQueueEditTransientAttachments(previous);
    }
    const textState = createQueueEditTextState(item);
    const next: QueueEditingState = previous
      ? {
          clientId: item.clientId,
          stashedDraft: previous.stashedDraft,
          stashedDocument: previous.stashedDocument,
          stashedAttachments: previous.stashedAttachments,
          textState,
        }
      : {
          clientId: item.clientId,
          stashedDraft: draftRef.current,
          stashedDocument: composerDocumentRef.current,
          stashedAttachments: [...attachmentsRef.current],
          textState,
        };
    queueEditingRef.current = next;
    setQueueEditing(next);
    setQueueSelectedClientId(null);
    applyComposerDocument(textState.document, { persist: false });
    const files = item.files ? [...item.files] : [];
    attachmentsRef.current = files;
    setAttachments(files);
    setAttachmentError(null);
    queueEditLockOwnerRef.current = acquireQueueEditLock(
      queueEditLockOwnerRef.current,
      item.clientId,
      setQueueEditLock,
    );
    composerInputRef.current?.applyDocumentAndSetSelectionToEnd(textState.document);
  };

  /** 放弃排队消息编辑:解锁 + 回收编辑期新增附件 + 恢复进入前的草稿与附件托盘。 */
  const pendingSendActions = useMemo<PendingSendBubbleActions>(
    () => ({
      busy: queueBusy,
      selectedClientId: queueSelectedClientId,
      onSelect: setQueueSelectedClientId,
      onRemove: (clientId: string) => {
        setQueueSelectedClientId(null);
        removeQueueItem(clientId);
      },
      onBeginEdit: (clientId: string) => {
        const target = remoteSessionStore.getInputProjection(sessionId).pendingQueue
          .find((entry) => entry.clientId === clientId);
        if (target) beginQueueEdit(target);
      },
      onSteer: (clientId: string) => {
        const target = remoteSessionStore.getInputProjection(sessionId).pendingQueue
          .find((entry) => entry.clientId === clientId);
        if (!target) return;
        setQueueSelectedClientId(null);
        steerQueueItem(target);
      },
      onRetryOutbox: retryOutboxItem,
      onRemoveOutbox: removeOutboxItem,
    }),
    [beginQueueEdit, queueBusy, queueSelectedClientId, removeQueueItem, removeOutboxItem, retryOutboxItem, sessionId, steerQueueItem],
  );

  // ⚠️ 临时取证(定位「气泡凭空消失」,定位完成后删):会话页实例身份 + 挂载/卸载。
  // settlingDiag 只在两次「首帧」打出 prev=0,之后再没跑过 —— 强烈指向组件被换了实例
  // (整棵树重建会清掉 settling / outbox / 落定基线等全部本地状态)。
  const cancelQueueEdit = useCallback(() => {
    const editing = queueEditingRef.current;
    if (!editing) return;
    queueEditingRef.current = null;
    setQueueEditing(null);
    const currentLockOwner = queueEditLockOwnerRef.current;
    const idleLockOwner = currentLockOwner?.clientId === editing.clientId
      ? currentLockOwner
      : null;
    const currentSaveOwner = queueEditSaveOwnerRef.current;
    const saveLockOwner = currentSaveOwner?.clientId === editing.clientId
      ? currentSaveOwner
      : null;
    if (idleLockOwner) queueEditLockOwnerRef.current = null;
    if (saveLockOwner) queueEditSaveOwnerRef.current = null;
    const lockOwner = saveLockOwner ?? idleLockOwner;
    const inFlightSave = saveLockOwner ? queueEditSaveInFlightRef.current : null;
    if (lockOwner) {
      void releaseQueueEditLockAfter(lockOwner, inFlightSave)
        .catch(() => undefined);
    }
    if (inFlightSave) {
      const attachmentsSnapshot = [...attachmentsRef.current];
      const discard = () => discardQueueEditTransientAttachments(editing, attachmentsSnapshot);
      void inFlightSave.then(discard, discard);
    } else {
      discardQueueEditTransientAttachments(editing);
    }
    applyComposerDocument(editing.stashedDocument);
    attachmentsRef.current = [...editing.stashedAttachments];
    setAttachments([...editing.stashedAttachments]);
  }, [applyComposerDocument, discardQueueEditTransientAttachments]);

  // 编辑中的条目从队列消失(被远端发出/删除)→ 原文已不可改,自动退出编辑并恢复
  // stash。即便加锁请求仍在途也要排队释放,避免留下孤儿锁。
  useEffect(() => {
    const editing = queueEditing;
    if (!editing) return;
    if (!inputProjection.pendingQueue.some((item) => item.clientId === editing.clientId)) {
      cancelQueueEdit();
    }
  }, [cancelQueueEdit, inputProjection.pendingQueue, queueEditing]);

  const retryQueueError = () => {
    void runQueueAction(() => maker.input.retryLastError(sessionId));
  };

  const clearQueueError = () => {
    void runQueueAction(() => maker.input.clearError(sessionId));
  };

  // --- session-tail-banner:error-tail / interrupted 收尾提示(对齐桌面两套 banner)---
  // dismissedTailErrorClientIds 声明在上方 renderItems 区(errorTailClientId 过滤要用);
  // acked = interrupted 已操作或本窗口内会话跑起来过(对齐桌面「跑起来即熄灭」锁存)。
  //
  // retryHiddenTailClientId:「重试」的短窗口本地隐藏(对齐桌面 errorTailBannerHiddenFor
  // 的完整交棒语义,三轮 review P1 收敛):
  //  - 为什么需要:空闲会话点重试时 coordinator 会立即 drain,enqueue 返回的
  //    pendingQueue 为空,queued 抑制从未生效——第一个接管信号到达前,旧 error 行
  //    仍是尾部,没有本地隐藏会让 banner 重现并允许对同一失败重复续跑;
  //  - 交棒释放(hidden 只覆盖「点击 → 第一个接管信号」的窗口,任一信号到达即释放,
  //    缺一个都会留死锁):
  //     a. 续跑项出现在 pendingQueue → queued 抑制接管;用户随后取消续跑,banner 恢复;
  //     b. 会话跑起来(isSessionStreaming)→ streaming 抑制接管;续跑 turn 若被停止
  //        且未产生新消息,streaming 结束后 banner 恢复;
  //     c. live 错误出现(projection.error,续跑发送在 coordinator 内失败)→ 错误框
  //        接管;用户清除该错误后 banner 恢复,不会两处皆不可见(review P1 第三轮:
  //        只认 a 会在立即 drain + 发送失败且无新 error 行时永久压住 banner)。
  //    合成行落库后旧行不再是尾部,判定自然不命中;本地隐藏按错误行 clientId 归属,
  //    同会话再次以新错误行收尾时不匹配新行,新 banner 正常浮现。
  const [tailInterruptAcked, setTailInterruptAcked] = useState(false);
  const [tailBannerBusy, setTailBannerBusy] = useState(false);
  const [retryHiddenTailClientId, setRetryHiddenTailClientId] = useState<string | null>(null);
  useEffect(() => {
    setTailInterruptAcked(false);
    setTailBannerBusy(false);
    setRetryHiddenTailClientId(null);
  }, [sessionId]);
  // 在途续跑判定同时看 pendingQueue 与 settling 窗口(排队项被 drain 出队、合成行
  // 尚未落库回流的间隙):只看队列会在 settling 间隙让 banner 重现、允许对同一失败
  // 重复续跑(review P1)。该值**同时**是 hidden 释放信号与 resolveSessionTailBanner
  // 的抑制输入(continuationInFlight)——单点判定,两处各算一遍曾造成错位(第五轮)。
  // 用 render 合并后的落定集合(含本帧现算项):否则续跑项被 drain 的那一帧这里会短暂
  // 判成「不在途」,banner 闪回来一下。
  const tailContinuationInFlight = useMemo(
    () => inputProjection.pendingQueue.some(isContinuationQueueItem)
      || settlingItemsForRender.some(isContinuationQueueItem),
    [inputProjection.pendingQueue, settlingItemsForRender],
  );
  useEffect(() => {
    if (retryHiddenTailClientId === null) return;
    if (tailContinuationInFlight || isSessionStreaming || inputProjection.error) {
      setRetryHiddenTailClientId(null);
    }
  }, [tailContinuationInFlight, isSessionStreaming, inputProjection.error, retryHiddenTailClientId]);
  // 超时兜底:上面的接管信号都是瞬态观测,跨设备事件流可能整段跳过(续跑在 enqueue
  // 返回前被 drain、又在本视图观测到任何中间态之前结束且未落新行,review P1 第四轮)。
  // 超时无任何信号到达即释放——此时旧 error 若仍是尾部,说明续跑没有产生可见进展,
  // 恢复重试/忽略入口是正确行为;正常路径信号亚秒级到达,不会开重复续跑窗口。
  useEffect(() => {
    if (retryHiddenTailClientId === null) return undefined;
    const timer = setTimeout(() => setRetryHiddenTailClientId(null), TAIL_RETRY_HIDE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [retryHiddenTailClientId]);
  // sessionId 必须在 deps 里(对齐桌面同款注释):running→running 切会话时布尔值不变,
  // 只依赖 isSessionStreaming 会漏掉新会话的锁存,stop 瞬间双时间戳短暂成立会闪横幅。
  useEffect(() => {
    if (isSessionStreaming) setTailInterruptAcked(true);
  }, [sessionId, isSessionStreaming]);
  // banner 的隐藏集合 = 「忽略」集合 ∪ 「重试」短窗口 hidden;消息流错误卡回流的
  // 过滤(errorTailClientId)只看「忽略」集合——重试窗口内错误行保持消息流 null,
  // 对齐桌面「重试后错误行不回流,直到被续跑行挤出尾部」。
  const tailHiddenForBanner = useMemo(() => {
    if (!retryHiddenTailClientId) return dismissedTailErrorClientIds;
    return new Set([...dismissedTailErrorClientIds, retryHiddenTailClientId]);
  }, [dismissedTailErrorClientIds, retryHiddenTailClientId]);
  const tailBannerState = useMemo(() => resolveSessionTailBanner({
    messages,
    session: currentSession,
    projection: inputProjection,
    isSessionStreaming,
    continuationInFlight: tailContinuationInFlight,
    interruptAcked: tailInterruptAcked,
    hiddenErrorClientIds: tailHiddenForBanner,
  }), [messages, currentSession, inputProjection, isSessionStreaming, tailContinuationInFlight, tailInterruptAcked, tailHiddenForBanner]);

  // 主按钮(重试 / 继续任务):发隐藏续跑指令(带 [UI_ACTION_TRIGGER] 前缀,消息流
  // 不渲染;排队区显示「继续未完成的任务(系统指令)」遮蔽气泡)。planMode 强制 false:
  // 会话若开着计划模式,隐藏指令会被路由进计划评审而不是立刻续跑(对齐桌面 sendUiTrigger)。
  // error-tail 不做本地乐观隐藏:busy 挡住点击窗口,enqueue 成功后 projection 里的
  // 续跑项接管抑制;这样续跑被取消 / 落库失败时 banner 自动恢复,错误入口不丢(review P1)。
  const continueTailBanner = useCallback(async () => {
    const state = tailBannerState;
    const sessionAtSend = currentSession;
    if (!state || tailBannerBusy || !sessionId) return;
    if (!sessionAtSend || sessionAtSend.cacheSeeded) {
      setError(t('session.screen.sessionNotSyncedRetry'));
      return;
    }
    const interrupted = state.kind === 'interrupted' || state.continueKind === 'interrupted';
    const prompt = interrupted ? CONTINUE_AFTER_APP_EXIT_PROMPT : CONTINUE_AFTER_ERROR_PROMPT;
    setTailBannerBusy(true);
    // 乐观熄灭:error-tail 走短窗口 hidden(交棒释放见上方声明处注释);interrupted
    // 乐观 acked,「继续」不写 ack RPC(对齐桌面:续跑在排队期丢失时标记必须还在,
    // 重启才会再提示;真正跑起来后 turn 时间戳演进就是权威状态)。
    if (state.kind === 'error-tail') {
      setRetryHiddenTailClientId(state.clientId);
    } else {
      setTailInterruptAcked(true);
    }
    try {
      const queued = buildQueuedTextMessage(sessionAtSend, prompt);
      queued.createOpts = { ...queued.createOpts, planMode: false };
      const projectionEpochAtRequestStart =
        remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
      const projection = await maker.input.enqueue(sessionId, queued, { sendAtMs: Date.now() });
      remoteSessionStore.setInputProjectionIfCurrent(
        sessionId,
        projection,
        projectionEpochAtRequestStart,
      );
    } catch (err) {
      if (state.kind === 'error-tail') {
        setRetryHiddenTailClientId((current) => (current === state.clientId ? null : current));
      } else {
        setTailInterruptAcked(false);
      }
      setError(formatRemoteError(err));
    } finally {
      setTailBannerBusy(false);
    }
  }, [currentSession, maker, sessionId, t, tailBannerBusy, tailBannerState]);

  //「忽略」:error-tail 持久化 dismiss(被控端 merge dismissed:true,重拉不复活),
  // 本地 dismissed 集合乐观熄灭 banner,同时错误卡回流消息流(errorTailClientId 排除
  // dismissed 行,对齐桌面「忽略后错误卡回到消息流」的语义);interrupted 写 ack
  // (被控端补 ended 时间戳,跨重启不再提示)。老被控端无对应 channel → 吞掉降级
  // 为本视图内存隐藏。
  const dismissTailBanner = useCallback(() => {
    const state = tailBannerState;
    if (!state || !sessionId) return;
    if (state.kind === 'error-tail') {
      setDismissedTailErrorClientIds((prev) => new Set([...prev, state.clientId]));
      void maker.dismissErrorMessage(sessionId, state.clientId).catch(() => undefined);
    } else {
      setTailInterruptAcked(true);
      void maker.ackInterruptedTurn(sessionId).catch(() => undefined);
    }
  }, [maker, sessionId, tailBannerState]);

  /**
   * 控制切换(model / permission / plan / effort / fast):选中态派生自 currentSession,
   * 原本要等 RPC + sessions:patched 回流才动。传 optimisticPatch 时先把本地 session
   * 打上新值当帧反馈(权威 patch 回流后覆盖同值,无跳变);失败按 recover 策略收敛:
   *  - 'rollback'(默认,单 RPC 原子动作):恢复旧值——远端要么全成要么全没动,回滚即真相;
   *  - 'refetch'(多步 RPC 动作):部分成功时远端已经变了,本地回滚会与之脱节(如
   *    setModel 成了、setEffort 挂了,回滚让手机显示旧模型、后续发送按旧字段组装),
   *    改为回读权威会话收敛乐观维度;回读也失败(多半同一网络故障)才退回本地回滚。
   */
  const runControlAction = useCallback(async (
    action: () => Promise<void>,
    optimisticPatch?: Partial<RemoteSession>,
    opts?: { recover?: 'rollback' | 'refetch' },
  ) => {
    if (controlBusy) return;
    // 新建会话在途:会话可能还没在被控端建成,setModel / setPlanMode 这类 RPC 必然
    // 失败并弹错,把「一切正常」的乐观观感打碎。静默忽略(不发 RPC、不写乐观 patch、
    // 不报错),对应入口的按钮同期也是灰的;窗口只有几秒。
    // composer 与发送不受此限:那条路径改走 outbox 排队(见 outboxDispatchBlockedNow)。
    // 判据与 send 里的命令门同源(sessionSettingsLocked = isRemoteSessionMissing);
    // 这里用 reactive 形态就够:按钮就是按这一帧的快照渲染的,点击不跨帧竞争。
    if (sessionSettingsLocked) return;
    setControlBusy(true);
    setError(null);
    let rollbackPatch: Partial<RemoteSession> | null = null;
    if (optimisticPatch && deviceId && currentSession) {
      const rollback: Record<string, unknown> = {};
      for (const key of Object.keys(optimisticPatch)) {
        rollback[key] = currentSession[key as keyof RemoteSession];
      }
      rollbackPatch = rollback as Partial<RemoteSession>;
      remoteSessionStore.applySessionPatch(deviceId, sessionId, optimisticPatch);
    }
    try {
      await action();
    } catch (err) {
      if (rollbackPatch && optimisticPatch && deviceId) {
        let recovered = false;
        if (opts?.recover === 'refetch') {
          try {
            const readsAgentSwitchIntent = Object.prototype.hasOwnProperty.call(
              optimisticPatch,
              'agentSwitchIntent',
            );
            const [fresh, freshAgentSwitchIntent] = await Promise.all([
              maker.getSession(sessionId),
              readsAgentSwitchIntent
                ? maker.getSessionAgentSwitchIntent(sessionId)
                : Promise.resolve(undefined),
            ]);
            const reconcile: Record<string, unknown> = {};
            for (const key of Object.keys(optimisticPatch)) {
              reconcile[key] = key === 'agentSwitchIntent'
                ? normalizeSessionAgentSwitchIntent(freshAgentSwitchIntent)
                : fresh[key as keyof RemoteSession];
            }
            remoteSessionStore.applySessionPatch(deviceId, sessionId, reconcile as Partial<RemoteSession>);
            recovered = true;
          } catch {
            // 回读失败退回本地回滚(下方兜底)。
          }
        }
        if (!recovered) {
          remoteSessionStore.applySessionPatch(deviceId, sessionId, rollbackPatch);
        }
      }
      setError(formatRemoteError(err));
    } finally {
      setControlBusy(false);
    }
  }, [controlBusy, currentSession, deviceId, maker, sessionId, sessionSettingsLocked]);

  const writeSessionAgentSwitchIntent = useCallback(async (
    nextIntent: NonNullable<RemoteSession['agentSwitchIntent']>,
  ): Promise<boolean> => {
    if (!deviceId || controlBusy) return false;
    // 会话建成前不写切换意图:被控端的 switch handler 要求会话行已存在,合成行阶段
    // 一律 NOT_FOUND。这里是**全部** agent-switch 写入的唯一出口(换模型 / 换 effort /
    // 换 fast 三条路都经它),门放在这里而不是各调用点,新增入口不会漏(review P1:
    // 换模型那条路不走 runControlAction,只在那儿加锁就漏了它)。
    if (sessionSettingsLocked) return false;
    const seq = ++agentSwitchWriteSeqRef.current;
    const previousIntent = normalizeSessionAgentSwitchIntent(
      remoteSessionStore.getSessions().find((item) => item.id === sessionId)?.agentSwitchIntent,
    );
    setControlBusy(true);
    setError(null);
    remoteSessionStore.applySessionPatch(deviceId, sessionId, { agentSwitchIntent: nextIntent });
    try {
      const result = await maker.switchSessionAgent(
        sessionId,
        nextIntent.targetAgentKind,
        nextIntent.model,
        nextIntent.providerId,
        nextIntent.effort,
        nextIntent.fastMode,
      );
      if (agentSwitchWriteSeqRef.current !== seq) return true;
      // 正常跨引擎写入应返回 deferred。若另一控制端已先完成真实切换，desktop
      // 会把这次调用视为同引擎 no-op；此时立即回读，不能继续显示虚假的 pending chip。
      if (result.deferred !== true) {
        let authoritative: RemoteSession['agentSwitchIntent'] = null;
        try {
          authoritative = normalizeSessionAgentSwitchIntent(
            await maker.getSessionAgentSwitchIntent(sessionId),
          );
        } catch {
          // 写已成功且 desktop 明确返回非 deferred = 当前已无待切意图；补做列表
          // reseed 让真实 agentKind/model 收敛，不把只读回查失败误报成写失败。
          remoteSessionStore.requestReseed(deviceId);
        }
        if (agentSwitchWriteSeqRef.current === seq) {
          remoteSessionStore.applySessionPatch(deviceId, sessionId, {
            agentSwitchIntent: authoritative,
          });
        }
      }
      return true;
    } catch (err) {
      if (agentSwitchWriteSeqRef.current === seq) {
        let authoritative = previousIntent;
        try {
          authoritative = normalizeSessionAgentSwitchIntent(
            await maker.getSessionAgentSwitchIntent(sessionId),
          );
        } catch {
          // 结果未知时回到本次写入前的本地镜像；重连 / sync 尾会再次权威回读。
        }
        if (agentSwitchWriteSeqRef.current === seq) {
          remoteSessionStore.applySessionPatch(deviceId, sessionId, {
            agentSwitchIntent: authoritative,
          });
          setError(formatRemoteError(err));
        }
      }
      return false;
    } finally {
      if (agentSwitchWriteSeqRef.current === seq) setControlBusy(false);
    }
  }, [controlBusy, deviceId, maker, sessionId, sessionSettingsLocked]);

  // Context 面板「计划模式」开关,双路径(#494 迁移):
  //  - 新协议(capabilities.planMode.supported):maker:set-plan-mode 开关一级 flag,
  //    状态读 session.planModeEnabled;一次性消耗由被控端执行(下一 turn 消耗武装态,
  //    plan_mode_changed → planModeEnabled=false 经 sessions:patched 回流),手机端不做本地恢复。
  //  - 老被控端兼容(permissionModes 仍含 'plan'):沿用 permissionMode 切换 + 发送后本地恢复。
  const prePlanPermissionModeRef = useRef<string | null>(null);
  const planModeCapability = runtimeOptions?.planModeSupported === true;
  const legacyPlanSupported = runtimeOptions?.permissionOptions.some((option) => option.id === 'plan') ?? false;
  const planModeSupported = planModeCapability || legacyPlanSupported;
  const legacyPlanModeOn = currentSession?.permissionMode === 'plan';
  const planModeOn = planModeCapability ? currentSession?.planModeEnabled === true : legacyPlanModeOn;
  const togglePlanMode = useCallback((next: boolean) => {
    // sessionSettingsLocked:会话建成前不动权限档(老协议分支还会写
    // prePlanPermissionModeRef,提前 return 免得留下没生效的「进入前档位」记录)。
    if (!canUseComposer || sessionSettingsLocked || !currentSession) return;
    if (planModeCapability) {
      void runControlAction(() => maker.setPlanMode(sessionId, next), { planModeEnabled: next });
      return;
    }
    if (next) {
      prePlanPermissionModeRef.current = currentSession.permissionMode ?? null;
      void runControlAction(() => maker.setPermissionMode(sessionId, 'plan'), { permissionMode: 'plan' });
      return;
    }
    const fallback = runtimeOptions?.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask';
    const remembered = prePlanPermissionModeRef.current;
    const restored = remembered && remembered !== 'plan' ? remembered : fallback;
    void runControlAction(() => maker.setPermissionMode(sessionId, restored), { permissionMode: restored });
  }, [canUseComposer, currentSession, maker, planModeCapability, runControlAction, runtimeOptions, sessionId, sessionSettingsLocked]);
  // 权限位置(设置面板下拉)不体现 plan(对齐桌面 PR#494 / Cursor):新协议下 permissionMode
  // 本就与 plan 正交,直接展示;仅老被控端 permissionMode='plan' 时替换为进入前的底层权限档
  // (无记录时回退首个非 plan 档),激活态由 composer 的 PlanModeChip 表达。
  const displayPermissionMode = legacyPlanModeOn
    ? ((prePlanPermissionModeRef.current && prePlanPermissionModeRef.current !== 'plan')
      ? prePlanPermissionModeRef.current
      : runtimeOptions?.permissionOptions.find((option) => option.id !== 'plan')?.id ?? 'ask')
    : currentSession?.permissionMode ?? 'ask';
  // 权限模式独立浮窗(2026-07-29 用户裁决,对齐 Codex 与新建页):composer 左侧图标钮
  // 点开;选择走既有 confirmFullAccessChange + maker:set-permission-mode 链路。
  const displayPermissionLabel =
    runtimeOptions?.permissionOptions.find((option) => option.id === displayPermissionMode)?.label
      ?? displayPermissionMode;
  const selectSessionPermissionMode = useCallback((mode: string) => {
    void (async () => {
      if (!currentSession) return;
      if (!await confirmFullAccessChange(currentSession.permissionMode, mode)) return;
      await runControlAction(
        () => maker.setPermissionMode(sessionId, mode),
        { permissionMode: mode },
      );
    })();
  }, [currentSession, maker, runControlAction, sessionId]);

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
      removeRemoteFileAttachment(attachedId);
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
  }, [attachments.length, getPendingUploadCount, mediaAssetAttachments, pendingMediaAssets, removeRemoteFileAttachment, t, uploadingMediaAssetIds]);
  // 底部「加入对话」:点击当帧把待选照片同步入队(缩略图立即进托盘)并关面板;token 传
  // Promise 由任务自行等待(codex review R8:先 await token 再 enqueue 的等待窗里,面板可被
  // 背板关掉、send() 的 waitForPendingUploads 看不到任务,文字消息会丢下刚选的图先发出去)。
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
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [auth, enqueueUploads, pendingMediaAssets]);
  // 勾选态按「映射的附件仍在列表里」现算,附件被单独移除 / 发送清空后角标自动消失。
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
  // 标注附件点开显示**原图**(叠矢量笔迹,可继续编辑/撤销)而非烧录预览图,
  // 与桌面「矢量是唯一事实源」语义一致;meta 与 attachments 同批落定,依赖足够。
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
    // (images 引用变化会重置 lightbox 里正在画的笔迹,review P1)。
  }, [attachments, attachmentPreviews, composerAnnotations.trayImageSourceUri]);
  const composerPreviewUrl = composerPreviewAttachmentId
    ? (composerGalleryImages.find((image) => image.key === composerPreviewAttachmentId)?.url ?? null)
    : null;
  // 面板关闭即丢弃未提交的待选(不产生任何上传副作用)。
  useEffect(() => {
    if (!contextSheetOpen) setPendingMediaAssets([]);
  }, [contextSheetOpen]);
  // 进页面就静默预取最近照片(仅已授权时),打开 + 面板即刻出图。
  useEffect(() => {
    void prefetchContextSheetMediaAssets('recent');
  }, []);

  // 目标模式:面板打开时拉一次快照(push 只送变更);动作后再拉一次收敛,避免依赖单一 push。
  const goalStatus = useSessionGoalStatus(sessionId);
  useEffect(() => {
    if (!contextSheetOpen || !deviceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await maker.goal.getStatus(sessionId);
        if (!cancelled) remoteSessionStore.setGoalStatus(sessionId, status ?? null);
      } catch {
        // 老被控端没有 goal 通道(CHANNEL_NOT_ALLOWED):保持未知,提交时再显式报错。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contextSheetOpen, deviceId, maker, sessionId]);
  // 暂停 / 继续 / 结束目标:先乐观切本地状态镜像(面板当帧反馈,不等往返),
  // RPC 后台;成功回读权威收敛(既有语义)。失败时报错并还原:优先回读权威状态,
  // 回读也失败(离线 / 超时,与 action 同因高概率连败)则还原到乐观前的快照——
  // 不能让「已暂停 / 已结束」的假状态一直挂在面板上(codex review P1)。
  // goalBusy 仍互斥并发点击。
  const runGoalAction = useCallback(async (
    action: () => Promise<void>,
    optimistic?: MobileGoalStatusPayload | null,
  ) => {
    if (goalBusy) return;
    setGoalBusy(true);
    setGoalError(null);
    const previous = goalStatus;
    if (optimistic !== undefined) remoteSessionStore.setGoalStatus(sessionId, optimistic);
    try {
      await action();
      const status = await maker.goal.getStatus(sessionId).catch(() => null);
      remoteSessionStore.setGoalStatus(sessionId, status ?? null);
    } catch (err) {
      setGoalError(formatRemoteError(err));
      if (optimistic !== undefined) {
        const status = await maker.goal.getStatus(sessionId).catch(() => undefined);
        if (status !== undefined) {
          remoteSessionStore.setGoalStatus(sessionId, status ?? null);
        } else if (previous !== undefined) {
          remoteSessionStore.setGoalStatus(sessionId, previous);
        }
        // previous 也是 undefined(镜像从未拉取)时保持现值,等面板重开的快照
        // 拉取收敛——setGoalStatus 没有「回到未知」的入参形态。
      }
    } finally {
      setGoalBusy(false);
    }
  }, [goalBusy, goalStatus, maker, sessionId]);
  // 对齐桌面 NewGoalDialog:setGoal 在被控端落目标消息并自动开跑第一轮,创建成功后
  // 关面板、清空 composer(目标默认文字来自 composer,已被吸收为目标)并跟到最新消息。
  const handleSetGoal = useCallback((input: { objective: string; limits?: MobileGoalLimitsInput }) => {
    void (async () => {
      if (goalBusy) return;
      setGoalBusy(true);
      setGoalError(null);
      try {
        // 状态镜像还是 unknown(首次快照未返回 / 拉取失败)时先补一次权威查询,防止把
        // 被控端已有目标静默覆盖;已有目标 → 镜像落库(视图自动切到状态页)并提示。
        // 查询抛错(老被控端无 goal 通道等)沿用下面的显式报错路径。
        if (goalStatus === undefined) {
          const current = await maker.goal.getStatus(sessionId);
          remoteSessionStore.setGoalStatus(sessionId, current ?? null);
          if (current) {
            setGoalError(t('session.screen.goalAlreadyActive'));
            return;
          }
        }
        await maker.goal.set({ sessionId, ...input });
        const status = await maker.goal.getStatus(sessionId).catch(() => null);
        remoteSessionStore.setGoalStatus(sessionId, status ?? null);
        setComposerDraft('');
        setContextSheetOpen(false);
        setContextSheetView('main');
        requestMessageListFollowLatest();
        // 失败接回的恢复载荷一次性消费(独立审核者 P2):成功后清除 state 与路由
        // 参数——否则以后清掉该 Goal 重新挂载表单,仍会用第一次失败时的旧
        // objective/limits;路由参数未消费也会在页面重挂载时再次恢复旧值。
        setGoalRestore(null);
        router.setParams({
          goalObjective: undefined,
          goalLimits: undefined,
          goalError: undefined,
        });
      } catch (err) {
        setGoalError(formatRemoteError(err));
      } finally {
        setGoalBusy(false);
      }
    })();
  }, [goalBusy, goalStatus, maker, requestMessageListFollowLatest, router, sessionId, setComposerDraft, t]);
  const handlePauseGoal = useCallback(() => {
    void runGoalAction(
      () => maker.goal.pause(sessionId),
      goalStatus ? { ...goalStatus, status: 'paused' } : undefined,
    );
  }, [goalStatus, maker, runGoalAction, sessionId]);
  const handleResumeGoal = useCallback(() => {
    void runGoalAction(
      () => maker.goal.resume(sessionId),
      goalStatus ? { ...goalStatus, status: 'active' } : undefined,
    );
  }, [goalStatus, maker, runGoalAction, sessionId]);
  const handleClearGoal = useCallback(() => {
    void runGoalAction(() => maker.goal.clear(sessionId), null);
  }, [maker, runGoalAction, sessionId]);

  // 选行 = 原子切「来源 + 模型 + effort + fast」(effort 优先级与桌面同源:该 (来源,模型) 的
  // 会话镜像记忆 → 沿用当前档 → 模型默认;同模型换来源不沿用;fast 按镜像恢复、fastEditable 门控)。
  const selectComposerModelRow = useCallback((row: ProviderModelRow) => {
    setModelSheetOpen(false);
    if (!canUseComposer || !currentSession || !modelSheetSelection) return;
    const next = resolveRowSelection({
      row,
      agentKind: modelSheetAgentKind,
      currentModelId: modelSheetSelection.model,
      currentProviderId: modelSheetSelection.providerId,
      currentEffort: modelSheetSelection.effort,
      hasFastModeCap: modelSheetCapabilities?.hasFastMode === true,
      memory: sessionMirrorAccessors,
    });
    if (modelSheetAgentKind !== sessionAgentKind) {
      void writeSessionAgentSwitchIntent({
        targetAgentKind: modelSheetAgentKind,
        model: next.model,
        providerId: next.providerId,
        ...(next.effort ? { effort: next.effort } : {}),
        fastMode: next.fastMode,
      });
      return;
    }
    void runControlAction(async () => {
      await maker.setModel(sessionId, next.model, next.providerId);
      if (next.effort && next.effort !== modelSheetSelection.effort) {
        await maker.setEffort(sessionId, next.effort);
      }
      // 只按值变化写穿,不做 fastEditable 门控:切到不支持 fast 的模型时
      // resolveRowSelection 已算出 fastMode=false,门控会跳过清零、让服务端残留 true。
      if (next.fastMode !== modelSheetSelection.fastMode) {
        await maker.setFastMode(sessionId, next.fastMode);
      }
    }, {
      // 乐观 patch:原子切换的三个维度一次上屏。
      model: next.model,
      providerId: next.providerId,
      ...(next.effort ? { effort: next.effort } : {}),
      fastMode: next.fastMode,
      ...(agentSwitchIntent ? { agentSwitchIntent: null } : {}),
      // 多步 RPC(setModel → setEffort → setFastMode)可能部分成功,失败时回读权威
      // 会话收敛而非本地回滚,避免手机显示与远端已生效状态脱节(codex review R16)。
    }, { recover: 'refetch' });
  }, [
    agentSwitchIntent,
    canUseComposer,
    currentSession,
    maker,
    modelSheetAgentKind,
    modelSheetCapabilities,
    modelSheetSelection,
    runControlAction,
    sessionAgentKind,
    sessionId,
    sessionMirrorAccessors,
    writeSessionAgentSwitchIntent,
  ]);
  const selectComposerFlatModel = useCallback((option: MobileModelOption) => {
    setModelSheetOpen(false);
    if (!canUseComposer || modelSheetAgentKind !== sessionAgentKind) return;
    void runControlAction(() => maker.setModel(sessionId, option.id), {
      model: option.id,
      ...(agentSwitchIntent ? { agentSwitchIntent: null } : {}),
    });
  }, [agentSwitchIntent, canUseComposer, maker, modelSheetAgentKind, runControlAction, sessionAgentKind, sessionId]);
  const browseComposerModelAgent = useCallback(async (next: MobileSessionAgentKind) => {
    if (next === modelSheetAgentKind) return true;
    if (next !== sessionAgentKind) {
      if (!sessionAgentSwitchSupported) return false;
      const confirmed = await confirmMobileSessionAgentSwitch(next, !!agentSwitchIntent);
      if (!confirmed) return false;
    }
    setModelSheetAgentKind(next);
    return true;
  }, [agentSwitchIntent, modelSheetAgentKind, sessionAgentKind, sessionAgentSwitchSupported]);
  const changeComposerSelectedEffort = useCallback((effort: string) => {
    if (
      modelSheetAgentKind !== sessionAgentKind
      && agentSwitchIntent?.targetAgentKind === modelSheetAgentKind
    ) {
      void writeSessionAgentSwitchIntent({ ...agentSwitchIntent, effort });
      return;
    }
    if (modelSheetAgentKind === sessionAgentKind) {
      void runControlAction(() => maker.setEffort(sessionId, effort), { effort });
    }
  }, [agentSwitchIntent, maker, modelSheetAgentKind, runControlAction, sessionAgentKind, sessionId, writeSessionAgentSwitchIntent]);
  const changeComposerSelectedFastMode = useCallback((enabled: boolean) => {
    if (
      modelSheetAgentKind !== sessionAgentKind
      && agentSwitchIntent?.targetAgentKind === modelSheetAgentKind
    ) {
      void writeSessionAgentSwitchIntent({ ...agentSwitchIntent, fastMode: enabled });
      return;
    }
    if (modelSheetAgentKind === sessionAgentKind) {
      void runControlAction(() => maker.setFastMode(sessionId, enabled), { fastMode: enabled });
    }
  }, [agentSwitchIntent, maker, modelSheetAgentKind, runControlAction, sessionAgentKind, sessionId, writeSessionAgentSwitchIntent]);
  const toggleComposerModelPicker = useCallback(() => {
    if (!canUseComposer) {
      setModelSheetOpen(false);
      return;
    }
    if (modelSheetOpen) {
      setModelSheetOpen(false);
      return;
    }
    setModelSheetAgentKind(agentSwitchIntent?.targetAgentKind ?? sessionAgentKind);
    setModelSheetOpen(true);
  }, [agentSwitchIntent, canUseComposer, modelSheetOpen, sessionAgentKind]);

  const refreshContextUsage = useCallback(async () => {
    if (!currentSession || contextLoading) return;
    setContextLoading(true);
    setError(null);
    try {
      const usage = await maker.getContextUsage(
        sessionId,
        buildContextUsageCreateOpts(currentSession),
      );
      // 会话已原地切换 → 丢弃迟到结果,归属校验见 contextUsageSessionRef 注释。
      if (contextUsageSessionRef.current !== sessionId) return;
      setContextUsage(usage);
    } catch (err) {
      if (contextUsageSessionRef.current === sessionId) setError(formatRemoteError(err));
    } finally {
      if (contextUsageSessionRef.current === sessionId) setContextLoading(false);
    }
  }, [contextLoading, currentSession, maker, sessionId]);

  // 账号限额按需拉取(会话信息面板打开时):优先走 Codex app-server 权威控制面,
  // 同时拿窗口和 reset credits。老被控端没有新通道时回退既有只读 usage channel;
  // 两条都失败则静默保留当前快照——限额是补充信息,不打断会话操作。
  const refreshAccountUsage = useCallback(async () => {
    if (!localCodexRateLimitControl) {
      setAccountUsage(null);
      setCodexRateLimits(null);
      setCodexResetRetryKey(null);
      return;
    }
    try {
      const snapshot = await maker.getCodexRateLimits();
      // 迟到结果归属校验,同 contextUsage(见 contextUsageSessionRef 注释)。
      if (contextUsageSessionRef.current !== sessionId) return;
      setCodexRateLimits(snapshot);
      setAccountUsage(snapshot.rateLimits);
    } catch (err) {
      if (contextUsageSessionRef.current !== sessionId) return;
      // 权威控制面读取失败后只能降级为只读用量；旧 offer / retry key 不得继续可消费。
      setCodexRateLimits(null);
      setCodexResetRetryKey(null);
      if (!shouldFallbackToLegacyCodexUsage(err)) {
        // 账号切换期间 legacy cache 仍可能属于旧 workspace；等待下一次权威读取。
        setAccountUsage(null);
        return;
      }
      try {
        const snapshot = await maker.getAccountUsage('codex');
        if (contextUsageSessionRef.current !== sessionId) return;
        setAccountUsage(snapshot);
      } catch {
        // 静默:通道不支持 / 网络瞬断都不打扰用户。
      }
    }
  }, [localCodexRateLimitControl, maker, sessionId]);

  // reset 只接受 desktop read 签发的 UUID。网络等结果不明的失败保留同一幂等键；
  // Desktop 明确拒绝的 stale offer 则立即作废并刷新，避免反复提交已失效凭证。
  const resetCodexRateLimits = useCallback(async () => {
    const offer = codexRateLimits?.resetOffer;
    const idempotencyKey = codexResetRetryKey ?? offer?.idempotencyKey;
    if (!idempotencyKey || codexResetBusy) return;
    // Offer TTL 只由签发它的 Desktop 时钟判定，避免手机/桌面时钟偏差误杀有效凭证。
    // refresh 已明确换 key 时仍先刷新并要求用户重新确认当前 credit。
    if (!offer
      || (codexResetRetryKey !== null && offer.idempotencyKey !== codexResetRetryKey)) {
      setCodexResetRetryKey(null);
      await refreshAccountUsage();
      if (contextUsageSessionRef.current !== sessionId) return;
      Alert.alert(t('session.screen.resetReconfirmTitle'), t('session.screen.resetOfferExpired'));
      return;
    }
    setCodexResetRetryKey(idempotencyKey);
    setCodexResetBusy(true);
    try {
      const result = await maker.resetCodexRateLimits(idempotencyKey);
      if (contextUsageSessionRef.current !== sessionId) return;
      setCodexResetRetryKey(null);
      if (result.rateLimits) {
        setCodexRateLimits(result.rateLimits);
        setAccountUsage(result.rateLimits.rateLimits);
      } else {
        await refreshAccountUsage();
        if (contextUsageSessionRef.current !== sessionId) return;
      }
      const message = {
        reset: t('session.screen.resetOutcomeReset'),
        nothingToReset: t('session.screen.resetOutcomeNothing'),
        noCredit: t('session.screen.resetOutcomeNoCredit'),
        alreadyRedeemed: t('session.screen.resetOutcomeAlready'),
      }[result.outcome];
      Alert.alert(result.outcome === 'reset' ? t('session.screen.resetDoneTitle') : t('session.screen.resetResultTitle'), message);
    } catch (err) {
      if (contextUsageSessionRef.current === sessionId) {
        if (isPreconditionFailedRemoteError(err)) {
          setCodexResetRetryKey(null);
          setCodexRateLimits((current) => current ? { ...current, resetOffer: null } : null);
          await refreshAccountUsage();
          if (contextUsageSessionRef.current === sessionId) {
            Alert.alert(t('session.screen.resetReconfirmTitle'), humanizeRemoteError(err));
          }
        } else {
          Alert.alert(t('session.screen.resetFailedTitle'), humanizeRemoteError(err));
        }
      }
    } finally {
      if (contextUsageSessionRef.current === sessionId) setCodexResetBusy(false);
    }
  }, [codexRateLimits, codexResetBusy, codexResetRetryKey, maker, refreshAccountUsage, sessionId]);

  const loadExtraDirBrowsePath = useCallback(async (targetPath: string) => {
    if (!deviceId || !currentSession || currentSession.workspaceKind !== 'project') return;
    const seq = ++extraDirBrowseSeqRef.current;
    setExtraDirBrowseLoading(true);
    setExtraDirBrowseError(null);
    try {
      const result = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        return maker.fs.listDir(targetPath.trim() || '~');
      });
      if (seq !== extraDirBrowseSeqRef.current) return;
      setExtraDirBrowsePath(result.resolvedPath);
      setExtraDirBrowseParent(result.parent);
      setExtraDirBrowseEntries(result.entries);
    } catch (err) {
      if (seq !== extraDirBrowseSeqRef.current) return;
      setExtraDirBrowseEntries([]);
      setExtraDirBrowseError(formatRemoteError(err));
    } finally {
      if (seq === extraDirBrowseSeqRef.current) setExtraDirBrowseLoading(false);
    }
  }, [currentSession, deviceId, maker, openLink]);

  const toggleExtraDirBrowser = useCallback(() => {
    if (!currentSession || currentSession.workspaceKind !== 'project') return;
    const nextOpen = !extraDirBrowseOpen;
    setExtraDirBrowseOpen(nextOpen);
    if (nextOpen) {
      void loadExtraDirBrowsePath(currentSession.workingDir?.trim() || '~');
    }
  }, [currentSession, extraDirBrowseOpen, loadExtraDirBrowsePath]);

  // 自愈返回:canGoBack 与真实栈不一致时(reload 恢复深路由 / 重复压栈残留),
  // GO_BACK 会被静默吞掉,生产表现为"点返回永远没反应"——校验兜底见 useGuardedBack。
  const goBackToHome = useGuardedBack();

  // chip「打开」:文件 → Quick Look 预览页(带行号),目录 → 文件浏览器定位。
  // 点击与长按菜单的「快速预览 / 打开文件浏览器」共用这一条。
  // workdir 外文件(relPath 为 null)预览页走 absPath 单文件模式(被控端
  // absPath 取件通道,无同目录翻页);workdir 外目录在 chip 层就不点亮,
  // 不会走到这里(canOpenChatPathChip)。
  const openChatPathTarget = useCallback((target: ChatFilePathTarget) => {
    if (target.kind === 'directory') {
      if (target.relPath === null) return;
      router.push({
        pathname: '/files/[sessionId]',
        params: { sessionId, deviceId, deviceName, relPath: target.relPath },
      });
      return;
    }
    router.push({
      pathname: '/files/preview/[sessionId]',
      params: {
        sessionId,
        deviceId,
        deviceName,
        ...(target.relPath !== null
          ? { relPath: target.relPath }
          : { absPath: target.absPath }),
        ...(target.line !== undefined ? { line: String(target.line) } : {}),
      },
    });
  }, [deviceId, deviceName, router, sessionId]);

  // chip 长按菜单(浮动面板,ContextSheet/模型选择面板同款):target 即开关。
  const [chipMenuTarget, setChipMenuTarget] = useState<ChatFilePathTarget | null>(null);
  const [chipShareBusy, setChipShareBusy] = useState(false);
  screenshotBlockedByOverlayRef.current = Boolean(
    settingsOpen
    || searchOpen
    || (sessionTreeOpen && currentSession?.agentKind === 'pi')
    || contextSheetOpen
    || chipMenuTarget !== null
    || (modelSheetOpen && canUseComposer)
    || (permissionSheetOpen && canUseComposer)
    || composerPreviewAttachmentId !== null
    || sessionListDrawerOverlayMounted
    || messageBlockingOverlay
  );

  // 聊天正文文件 chip 上下文(消息树内 inline chip 经 context 消费,不走多层 prop):
  // stat 走被控端 fs:stat-path(失败由 verdict 层归为 unknown 乐观点亮)。
  // openLink 握手按 context 生命周期收敛为一次:一条长转录可触发上百次 stat,
  // 每次 stat 前都完整握手会以 2 倍往返打满 device-link 通道,把用户操作挤在
  // 队尾(2026-07 线上实捉:整机点按延迟秒级)。任一 stat 失败(多半是链路掉了)
  // 即作废缓存的握手,下一次验证重新握手,断链自愈语义不变。
  // connectionEpoch 在 deps 里确保同 deviceId 断线重连时 memo 重建、linkReady 作废,
  // 避免复用旧 transport epoch 上已 resolve 的握手 promise。
  const chatFilePathContextValue = useMemo<ChatFilePathContextValue | null>(() => {
    const workdir = currentSession?.workingDir?.trim();
    if (!deviceId || !workdir) return null;
    let linkReady: Promise<void> | null = null;
    const ensureLink = () => {
      if (!linkReady) {
        linkReady = openLink(deviceId).then(() => undefined);
        linkReady.catch(() => {
          linkReady = null;
        });
      }
      return linkReady;
    };
    return {
      deviceId,
      sessionId,
      workdir,
      ...(currentSession?.remoteHostId?.trim()
        ? { remoteHostId: currentSession.remoteHostId.trim() }
        : {}),
      statPath: async (absPath: string) => {
        await ensureLink();
        try {
          return await maker.fs.statPath(absPath);
        } catch (err) {
          linkReady = null;
          throw err;
        }
      },
      onOpenPath: openChatPathTarget,
      onLongPressPath: setChipMenuTarget,
    };
  }, [
    connectionEpoch,
    currentSession?.remoteHostId,
    currentSession?.workingDir,
    deviceId,
    maker,
    openChatPathTarget,
    openLink,
    sessionId,
  ]);

  /** chip 菜单「导出 / 分享」:两段式导出 → 系统分享单(与文件浏览器同链路);
   *  mtime 先列一拍父目录拿真实值(导出 URL 缓存 key 依赖),拿不到用当前时间
   *  兜底——宁可多导出一次也不复用同路径被覆写前的旧文件。
   *  workdir 外文件(relPath 为 null)改走被控端 media:fetch 绝对路径取件
   *  (xdt-file://open?path=…,与文件浏览器 gallery / 预览页 absPath 模式同一通道)。 */
  const shareChipFile = useCallback(async (target: ChatFilePathTarget) => {
    const workdir = currentSession?.workingDir?.trim();
    if (!deviceId || !workdir || chipShareBusy) return;
    setChipShareBusy(true);
    try {
      const name = pathDisplayName(target.relPath ?? target.absPath);
      const presignGet = (ossKey: string) => auth.apiFetch<MobileRemoteMediaPresignResult>(
        '/api/device-link/media/presign-get',
        { baseUrl: DEVICE_LINK_API_BASE_URL, method: 'POST', body: { key: ossKey } },
      );
      let url: string;
      if (target.relPath === null) {
        url = await fetchRemoteAbsFileToUrl(
          { maker, deviceId, openLink, presignGet },
          target.absPath,
        );
      } else {
        let mtimeMs = Date.now();
        try {
          const raw = await withTransientRemoteRetry(async () => {
            await openLink(deviceId);
            return maker.fileBrowser.listDir(workdir, parentRelPath(target.relPath ?? '') ?? '');
          });
          const entry = normalizeRemoteOpDirEntries(raw).find((item) => item.relPath === target.relPath);
          if (entry) mtimeMs = entry.mtimeMs;
        } catch {
          /* 列目录失败不阻断分享,退当前时间 key */
        }
        url = await exportRemoteFileToUrl(
          { maker, deviceId, openLink, presignGet },
          workdir,
          target.relPath,
          mtimeMs,
        );
      }
      const mime = shareMimeForFileName(name);
      const localUri = await downloadRemoteMediaShareTemp(url, mime, name);
      if (!localUri) throw new Error(t('session.screen.downloadFailed'));
      const sharing = await import('expo-sharing');
      await sharing.shareAsync(localUri, { mimeType: mime });
      // 只关本次分享对应的菜单:分享期间用户可能已关闭并长按另一 chip 打开新菜单
      setChipMenuTarget((prev) => (prev?.absPath === target.absPath ? null : prev));
    } catch (err) {
      Alert.alert(t('session.screen.shareFailedTitle'), formatRemoteError(err));
    } finally {
      setChipShareBusy(false);
    }
  }, [auth, chipShareBusy, currentSession?.workingDir, deviceId, maker, openLink]);

  /** chip 长按菜单动作分发。除「分享」(异步、行内 busy)外均即时执行并关面板。 */
  const handleChipMenuAction = useCallback((key: ChatFileChipMenuActionKey, target: ChatFilePathTarget) => {
    switch (key) {
      case 'open':
        setChipMenuTarget(null);
        openChatPathTarget(target);
        return;
      case 'revealInBrowser':
        // workdir 外文件没有该菜单项(chatFileChipMenuRows 已裁),这里仅类型收窄。
        if (target.relPath === null) return;
        setChipMenuTarget(null);
        router.push({
          pathname: '/files/[sessionId]',
          params: { sessionId, deviceId, deviceName, relPath: parentRelPath(target.relPath) ?? '' },
        });
        return;
      case 'sendToSession': {
        // 与文件浏览器「发送到会话」同一实现:@ 引用合入 store 草稿(merge 内已
        // 持久化),再走统一 draft setter 同步回本屏 state + draftRef——裸 setState
        // 会漏更 draftRef,语音输入 readCurrentDraft 读到旧值时会覆盖掉 @ 引用。
        // workdir 外文件没有 relPath,@ 引用直接给被控端绝对路径(agent 可消费)。
        const merged = mergePathIntoComposerDraft(
          sessionId,
          target.relPath ?? target.absPath,
          target.kind === 'directory' ? 'dir' : 'file',
        );
        const mergedDocument = readComposerDocumentDraftSync(sessionId);
        if (mergedDocument) {
          applyComposerDocument(mergedDocument, { persist: false });
          composerInputRef.current?.applyDocumentAndSetSelectionToEnd(mergedDocument);
        } else {
          applyComposerDraft(merged, { persist: false });
          composerInputRef.current?.applyDocumentAndSetSelectionToEnd(composerDocumentRef.current);
        }
        setChipMenuTarget(null);
        return;
      }
      case 'copyPath':
        // 对齐桌面「复制文件路径」:保留远端原始绝对路径,不换算本机形态。
        void Clipboard.setStringAsync(target.absPath).catch(() => undefined);
        setChipMenuTarget(null);
        return;
      case 'share':
        void shareChipFile(target);
        return;
    }
  }, [applyComposerDocument, applyComposerDraft, deviceId, deviceName, openChatPathTarget, router, sessionId, shareChipFile]);

  // 会话菜单元数据操作(重命名 / 置顶 / 归档 / 删除 / 恢复)乐观写:与首页
  // patchHomeSession 同一写序契约——守卫 / 队列 / 在途登记用 app 级单例
  //(sessionMetaWriteGuard / sessionMetaWriteQueue / sessionPendingWrites),
  // 首页与本页是同组元数据写的两个入口,写序必须跨页面共享(review P1:首页
  // 置顶在退避中,本页取消置顶——实例级守卫感知不到对方,退避恢复后旧写覆盖
  // 新写)。点击当帧 applySessionPatch 即时生效,归档 / 删除立即退回首页,RPC
  // 经共享队列串行出网;成功仅在本笔仍是最新写时用回包对账,失败时最新写整体
  // 还原会话对象(归档 / 删除把行移出了列表,反向 patch 复活不了)、非最新写
  // requestReseed 收敛,并 Alert 提示(人可能已回到首页,会话页 error 条看不见)。
  const patchSessionMeta = useCallback((
    patch: Parameters<typeof maker.patchSessionMeta>[1],
  ) => {
    const session = currentSession;
    if (!deviceId || !session) return;
    if (patch.status === 'archived' || patch.status === 'deleted') {
      goBackToHome();
    }
    // 写序登记、出网链路、对账/回滚全部对齐首页字段级契约(review P1/P2 多轮:守卫
    // 是跨页面单例,粒度必须与首页一致):writeGuardFields 登记(delete/archive 移行
    // 写取代全字段),retryPatchWhileLatest 让位屏障 + preSend 发送点断言 + 瞬时重试,
    // pickWriteFields 字段级对账/回滚。
    const fields = Object.keys(patch);
    const write = sessionMetaWriteGuard.begin(sessionId, writeGuardFields(patch));
    remoteSessionStore.applySessionPatch(deviceId, sessionId, patch as Partial<RemoteSession>);
    // 在途登记 + 共享队列:本页写同样遮蔽 push 回流 / 全量对账,并与首页写同字段串行。
    const releasePending = sessionPendingWrites.track(sessionId, fields);
    void (async () => {
      try {
        const updated = await sessionMetaWriteQueue.enqueue(sessionId, fields, () => retryPatchWhileLatest(
          write.isLatest,
          // preSend:重连等待(最长 1.5s)之后、真正出网之前再查一次让位——本页同
          // 字段连续两次操作时,前笔在等待中被取代不得再发出(review P2)。
          (assertStillLatest) => invoke<RemoteSession>(
            deviceId,
            'local-db:sessions:patch-meta',
            [sessionId, patch],
            { preSend: assertStillLatest },
          ),
        ));
        if (updated && write.isLatest()) {
          // 字段级对账 + updatedAt 单调下限(同首页):整对象覆盖会冲掉其它字段
          // 上并发写的乐观值。
          const currentUpdatedAt = remoteSessionStore.getSessions()
            .find((s) => s.id === sessionId)?.updatedAt ?? null;
          remoteSessionStore.applySessionPatch(
            deviceId,
            sessionId,
            pickWriteFields(updated, fields, currentUpdatedAt),
          );
          // 与首页成功分支同口径(review P1):在途期间被遮的同字段外部更新可能晚于
          // 本机写落库——回包是旧值,命中遮蔽留痕即 reseed 收敛。
          if (sessionPendingWrites.consumeMaskedPush(sessionId, fields)) {
            remoteSessionStore.requestReseed(deviceId);
          }
        }
      } catch (err) {
        if (write.isLatest()) {
          if (fields.includes('status')) {
            // 归档/删除/恢复失败:行可能已被移出列表,反向 patch 复活不了,整对象
            // 插回。回滚设备名优先取 shard 当前值(同首页 review P2 教训):用旧
            // stamp 会把整台设备改名。
            const shardName = remoteSessionStore.getSessions()
              .find((s) => s.deviceLinkDeviceId === deviceId)?.deviceLinkDeviceName
              ?? session.deviceLinkDeviceName
              ?? deviceId;
            remoteSessionStore.upsertDeviceSession(deviceId, shardName, session);
          } else {
            // 置顶/重命名失败:只还原本笔字段,不整对象覆盖其它字段的并发写。
            const currentUpdatedAt = remoteSessionStore.getSessions()
              .find((s) => s.id === sessionId)?.updatedAt ?? null;
            remoteSessionStore.applySessionPatch(
              deviceId,
              sessionId,
              pickWriteFields(session, fields, currentUpdatedAt),
            );
          }
        }
        // 无论是否最新写都 reseed:回滚可能吞并行结果 / 被遮的外部值 / 被让位前笔
        // 污染的快照值(与首页失败分支同口径);离线时 reseed 失败无害。
        remoteSessionStore.requestReseed(deviceId);
        // 与首页同款人话文案(review P2):不把 [NOT_CONNECTED] 原始错误码怼给用户。
        Alert.alert(t('session.screen.operationFailed'), humanizeRemoteError(err));
      } finally {
        releasePending();
      }
    })();
  }, [currentSession, deviceId, goBackToHome, invoke, maker, sessionId]);

  const previewRewindAtMessage = useCallback(async (clientId: string, draft: MobileMessageDraft) => {
    if (messageActionBusy) return;
    const seq = ++rewindRequestSeqRef.current;
    setMessageActionBusy({ clientId, kind: 'rewind' });
    setError(null);
    setRewindState({
      kind: 'loading',
      clientId,
      draftText: draft.text,
      draftQuotes: draft.quotes,
      draftDocument: draft.document,
      ...(draft.orderedBody ? { draftOrderedBody: draft.orderedBody } : {}),
    });
    try {
      const preview = await maker.rewindPreview(sessionId, clientId);
      // 请求往返期间切走 session(甚至切走又切回)或另发起了新请求 → 代际已变,丢弃这个 stale 预览,
      // 别把它画到当前在屏的 session 上。
      if (rewindRequestSeqRef.current !== seq) return;
      setRewindState(buildRewindPreviewState(
        clientId,
        draft.text,
        preview,
        draft.quotes,
        draft.orderedBody,
        draft.document,
      ));
    } catch (err) {
      if (rewindRequestSeqRef.current !== seq) return;
      setRewindState({
        kind: 'error',
        clientId,
        draftText: draft.text,
        draftQuotes: draft.quotes,
        draftDocument: draft.document,
        ...(draft.orderedBody ? { draftOrderedBody: draft.orderedBody } : {}),
        errorText: formatRemoteError(err),
      });
    } finally {
      // 仅当代际未变(仍是本次请求)才清 busy,避免误清切走 / 新发起后的 busy。
      if (rewindRequestSeqRef.current === seq) setMessageActionBusy(null);
    }
  }, [maker, messageActionBusy, sessionId]);

  const performForkAtMessage = useCallback(async (clientId: string, draft?: MobileMessageDraft) => {
    if (!deviceId || messageActionBusy) return;
    setMessageActionBusy({ clientId, kind: 'fork' });
    setError(null);
    try {
      const forked = await maker.fork(sessionId, clientId);
      remoteSessionStore.upsertDeviceSession(deviceId, deviceName, forked);
      const forkDocument = draft?.document ?? migrateLegacyComposerDraft(
        draft?.text,
        draft?.quotes ?? [],
        draft?.orderedBody,
      );
      saveComposerDocumentDraft(forked.id, forkDocument);
      saveComposerDraft(forked.id, composerDocumentProjectedText(forkDocument));
      clearQuotes(forked.id);
      router.push({
        pathname: '/sessions/[sessionId]',
        params: { sessionId: forked.id, deviceId, deviceName },
      });
    } catch (err) {
      const detail = formatRemoteError(err);
      const projectionKey = inputProjectionErrorI18nKey(detail);
      setError(projectionKey ? t(projectionKey) : detail);
    } finally {
      setMessageActionBusy(null);
    }
  }, [deviceId, deviceName, maker, messageActionBusy, router, sessionId, t]);

  const forkAtMessage = useCallback((clientId: string, draft?: MobileMessageDraft) => {
    if (!deviceId || messageActionBusy) return;
    // 文案走 i18n(与本页其它 Alert 同规):mobile 支持 en / ja / ko,硬编码中文会让
    // 非中文环境看到中文弹窗。四语措辞与 desktop 的 chat.messageActionBar.fork* 对齐。
    Alert.alert(
      t('session.screen.forkConfirmTitle'),
      t('session.screen.forkConfirmDescription'),
      [
        { text: t('session.screen.forkCancel'), style: 'cancel' },
        {
          text: t('session.screen.forkConfirm'),
          onPress: () => void performForkAtMessage(clientId, draft),
        },
      ],
    );
  }, [deviceId, messageActionBusy, performForkAtMessage, t]);

  const openForkOrigin = useCallback(() => {
    const parentSessionId = currentSession?.parentSessionId;
    const forkedAtMessageId = currentSession?.forkedAtMessageId;
    if (!deviceId || !parentSessionId || !forkedAtMessageId) return;
    router.push({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId: parentSessionId,
        deviceId,
        deviceName,
        focusClientId: forkedAtMessageId,
        focusRequestKey: String(Date.now()),
      },
    });
  }, [
    currentSession?.forkedAtMessageId,
    currentSession?.parentSessionId,
    deviceId,
    deviceName,
    router,
  ]);

  // 正文里会话深链 chip(xdt-maker://session/<id>[?message=<clientId>])点击:
  // 同会话带锚点 → setParams 原地定位(不 push 同页新栈帧);跨会话 → 反查所属
  // 设备后 push,锚点透传给目标屏的 focusClientId 流程。
  const openSessionLink = useCallback((url: string) => {
    const target = parseSessionDeepLinkUrl(url);
    if (!target) return;
    if (target.sessionId === sessionId) {
      if (target.messageClientId) {
        router.setParams({
          focusClientId: target.messageClientId,
          focusRequestKey: String(Date.now()),
        });
      }
      return;
    }
    // 设备口径与 devices/index openSession 一致:可达优先(canonical → 物理 → 注册表)。
    const targetSession = remoteSessionStore.getSessions().find((item) => item.id === target.sessionId);
    const targetDeviceId = targetSession?.canonicalDeviceId
      ?? targetSession?.deviceLinkDeviceId
      ?? remoteSessionStore.getSessionDeviceId(target.sessionId);
    if (!targetDeviceId) {
      setError(t('session.screen.sessionDeviceNotFound'));
      return;
    }
    router.push({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId: target.sessionId,
        deviceId: targetDeviceId,
        deviceName: targetSession?.deviceLinkDeviceName ?? targetDeviceId,
        ...(target.messageClientId
          ? {
              focusClientId: target.messageClientId,
              focusRequestKey: String(Date.now()),
            }
          : {}),
      },
    });
  }, [router, sessionId]);

  // 长按/操作条「复制消息链接」:复制带消息锚点的会话深链,可跨端粘贴跳转。
  const copyMessageLink = useCallback((clientId: string) => {
    if (!sessionId) return;
    void copyMessageText(buildMobileSessionMessageDeepLink(sessionId, clientId));
  }, [sessionId]);

  const resolvePastedSessionLinkLabel = useCallback(async (href: string) => {
    const target = parseSessionDeepLinkUrl(href);
    if (!target) return null;
    const targetSession = remoteSessionStore.getSessions().find((item) => (
      item.id === target.sessionId
    ));
    const targetDeviceId = targetSession?.canonicalDeviceId
      ?? targetSession?.deviceLinkDeviceId
      ?? remoteSessionStore.getSessionDeviceId(target.sessionId);
    const targetMaker = targetDeviceId
      ? (targetDeviceId === deviceId
          ? maker
          : createMobileMakerTransport({ deviceId: targetDeviceId, invoke }))
      : null;

    try {
      if (target.messageClientId) {
        let targetMessage = remoteSessionStore.getMessages(target.sessionId).find((message) => (
          message.clientId === target.messageClientId || message.id === target.messageClientId
        ));
        if (!targetMessage && targetMaker && targetDeviceId) {
          await openLink(targetDeviceId);
          const around = await targetMaker.aroundMessagesByClientId(
            target.sessionId,
            target.messageClientId,
            { radius: 1 },
          );
          remoteSessionStore.mergeMessages(target.sessionId, around);
          targetMessage = around.find((message) => (
            message.clientId === target.messageClientId || message.id === target.messageClientId
          ));
        }
        const text = targetMessage ? mobileSessionMessageDisplayText(targetMessage) : null;
        if (!text) return null;
        const bounded = boundAgentReferenceText(text);
        return {
          label: compactSessionMessageLabel(text),
          agentText: bounded.text,
          ...(bounded.truncated ? { agentTextTruncated: true } : {}),
        };
      }

      const knownTitle = targetSession?.title?.trim();
      if (knownTitle) return { label: compactSessionMessageLabel(knownTitle) };
      if (!targetMaker || !targetDeviceId) return null;
      await openLink(targetDeviceId);
      const fresh = await targetMaker.getSession(target.sessionId);
      const title = fresh.title?.trim();
      return title ? { label: compactSessionMessageLabel(title) } : null;
    } catch {
      return null;
    }
  }, [deviceId, invoke, maker, openLink]);

  const addMessageToComposer = useCallback((clientId: string) => {
    if (!sessionId || !canUseComposer) return;
    const target = messages.find((message) => (
      message.clientId === clientId || message.id === clientId
    ));
    const summary = target ? mobileSessionMessageDisplayText(target) : null;
    const bounded = summary ? boundAgentReferenceText(summary) : null;
    const node = sessionLinkComposerNode({
      href: buildMobileSessionMessageDeepLink(sessionId, clientId),
      label: compactSessionMessageLabel(summary ?? clientId),
      titled: true,
      ...(bounded?.text ? { agentText: bounded.text } : {}),
      ...(bounded?.truncated ? { agentTextTruncated: true } : {}),
    });
    const editor = composerInputRef.current;
    if (editor) editor.insertNode(node);
    else applyComposerDocument(appendComposerNode(composerDocumentRef.current, node));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [applyComposerDocument, canUseComposer, messages, sessionId]);

  const deleteMessage = useCallback((clientId: string) => {
    if (!deviceId || messageActionBusy) return;
    Alert.alert(t('session.screen.deleteMessageTitle'), t('session.screen.deleteMessageBody'), [
      { text: t('session.common.cancel'), style: 'cancel' },
      {
        text: t('session.screen.deleteMessageAction'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setMessageActionBusy({ clientId, kind: 'delete' });
            setError(null);
            try {
              const result = await maker.deleteMessage(sessionId, clientId);
              const returnedClientIds = Array.isArray(result.clientIds)
                ? result.clientIds.filter((value): value is string =>
                    typeof value === 'string' && value.length > 0,
                  )
                : [];
              remoteSessionStore.removeMessages(
                sessionId,
                returnedClientIds.length > 0 ? returnedClientIds : [clientId],
                deviceId,
              );
            } catch (err) {
              setError(formatRemoteError(err));
            } finally {
              setMessageActionBusy(null);
            }
          })();
        },
      },
    ]);
  }, [deviceId, maker, messageActionBusy, sessionId]);

  const confirmRewind = useCallback(async () => {
    if (!deviceId || messageActionBusy || !isCommitReadyRewindState(rewindState)) return;
    const state = rewindState;
    const seq = ++rewindRequestSeqRef.current;
    setMessageActionBusy({ clientId: state.clientId, kind: 'rewind' });
    setError(null);
    try {
      const updated = await maker.rewindCommit(sessionId, state.clientId);
      // applySessionPatch 按显式 sessionId 写目标 session 的分片,与当前浏览无关,即使用户已切走
      // 也必须执行,否则该 session 的回撤结果丢失——不受下面 guard 影响。
      remoteSessionStore.applySessionPatch(deviceId, sessionId, updated);
      if (rewindRequestSeqRef.current !== seq) {
        // 代际已变(切走 / 切走又切回 / 另发起新请求):不碰当前在屏 session 的 UI,但仍要把目标
        // session 的消息 store 整窗刷新到 rewind 后。commit 已返回 = 服务端已截断历史,这里直接
        // session-scoped 写 store(不经 syncSession,不写 loading/error 等当前 UI state),避免
        // 「confirm 后立刻切走又切回」竞态下 reopen 抢在 commit 前用旧 meta 判定「已同步」而残留
        // rewind 前的旧消息。失败不阻断:下次进入该会话的 reopen 会据过期的 sync 标记兜底重拉。
        const refreshSeq = rewindRequestSeqRef.current;
        const history = await listMessagesWithPayloadRetry((limit) => maker.listMessages(sessionId, { limit })).catch(() => null);
        // fetch 往返期间代际又变(用户再次切换,或在该会话又完成了一次更新的 rewind)→ 这页已 stale。
        // 丢弃:否则旧页会覆盖更新的消息 store,并用旧 meta 误标记已同步,导致已删消息重现,直到下次
        // resync。交给下次进入该会话的 reopen 兜底重拉。
        if (rewindRequestSeqRef.current !== refreshSeq) return;
        if (history) {
          remoteSessionStore.setMessages(sessionId, Array.isArray(history.messages) ? history.messages : []);
          remoteSessionStore.markSessionMessagesSynced(sessionId, updated);
        }
        return;
      }
      applyComposerDocument(state.draftDocument ?? migrateLegacyComposerDraft(
        state.draftText,
        state.draftQuotes,
        state.draftOrderedBody,
      ));
      clearQuotes(sessionId);
      setRewindState({ kind: 'idle' });
      await requestSync({ reason: 'rewind-commit', replaceMessages: true });
    } catch (err) {
      if (rewindRequestSeqRef.current !== seq) return;
      setError(formatRemoteError(err));
      setRewindState({
        kind: 'error',
        clientId: state.clientId,
        draftText: state.draftText,
        draftQuotes: state.draftQuotes,
        ...(state.draftDocument ? { draftDocument: state.draftDocument } : {}),
        ...(state.draftOrderedBody ? { draftOrderedBody: state.draftOrderedBody } : {}),
        errorText: formatRemoteError(err),
      });
    } finally {
      if (rewindRequestSeqRef.current === seq) setMessageActionBusy(null);
    }
  }, [applyComposerDocument, deviceId, maker, messageActionBusy, requestSync, rewindState, sessionId]);

  return (
    <View style={styles.safeArea} testID="session.screen">
      <KeyboardAvoidingView
        // 抽屉开着时把背后内容从读屏树里摘掉:iOS 用 accessibilityElementsHidden
        // (与抽屉侧 accessibilityViewIsModal 配对),Android 用 importantForAccessibility
        // ——后者才对 TalkBack 生效(与 ComposerRichInput 的双平台配对惯例一致)。
        accessibilityElementsHidden={sessionListDrawerOverlayMounted}
        behavior={nativeShellLayout.keyboardAvoidingBehavior}
        importantForAccessibility={sessionListDrawerOverlayMounted ? 'no-hide-descendants' : 'auto'}
        keyboardVerticalOffset={nativeShellLayout.keyboardVerticalOffset}
        style={styles.keyboard}
      >
        <View ref={topOverlayRef} onLayout={handleTopOverlayLayout} pointerEvents="box-none" style={styles.sessionChrome} testID="session.chrome">
          <TranslucentBackdrop />
          <View style={[styles.sessionChromeContent, { paddingTop: insets.top }]}>
            <SessionHeaderBar
              currentSession={currentSession}
              diffCount={diffCount}
              isDeviceAccessRevoked={isDeviceAccessRevoked}
              syncing={showSyncingIndicator}
              messageCount={Math.max(messages.length, currentSession?._count?.messages ?? 0)}
              onBack={goBackToHome}
              onOpenSessionList={wideSessionNav.enabled ? openSessionListDrawer : undefined}
              sessionListButtonRef={sessionListButtonRef}
              onOpenFiles={() => {
                if (!currentSession?.workingDir) return;
                router.push({
                  pathname: '/files/[sessionId]',
                  params: { sessionId, deviceId, deviceName },
                });
              }}
              onOpenSettings={() => openSessionMenu('menu')}
              onOpenUsage={() => openSessionMenu('info')}
              onToggleSearch={() => {
                if (searchOpen) closeSearch();
                else setSearchOpen(true);
              }}
              pendingCount={pending.length}
              queueCount={inputProjection?.pendingQueue.length ?? 0}
              queuePaused={inputProjection?.queuePaused ?? false}
              readOnlyReason={composerReadOnlyReason}
              remoteUnavailableReason={remoteUnavailableReason}
              searchOpen={searchOpen}
              title={isDeviceAccessRevoked
                ? t('session.screen.accessRevokedShort')
                // 哨兵先过投影再进兜底链:会话头是发出第一句话后停留最久的位置,
                // 原样显示会把内部哨兵 "New Maker" 摆在标题栏上。
                : projectDraftSessionTitle(currentSession?.title, t('session.menu.unnamedTitle'))
                  || currentSession?.workingDir
                  || (connectionError ? t('session.screen.sessionNotSynced') : (deviceName || t('session.screen.conversationFallback')))}
            />

            {showConnectionBanner ? (
              <ConnectionBanner
                density="compact"
                deviceUnresponsive={isDeviceUnresponsive}
                error={connectionError}
                issue={connectionIssue}
                lastSyncedAt={lastSyncedAt}
                loading={loading}
                onSync={() => void requestSync({ reason: 'manual', replaceMessages: false })}
                status={status}
                variant="inline"
              />
            ) : null}
          </View>
        </View>
        {currentSession ? (
          <SessionMenuSheet
            accountUsage={localCodexRateLimitControl ? accountUsage : null}
            busy={controlBusy}
            codexRateLimits={localCodexRateLimitControl ? codexRateLimits : null}
            codexResetBusy={codexResetBusy}
            contextLoading={contextLoading}
            contextUsage={contextUsage}
            extraDirBrowser={extraDirBrowser}
            initialView={menuInitialView}
            keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
            onArchive={() => patchSessionMeta({ status: 'archived' })}
            onClose={() => setSettingsOpen(false)}
            onClosed={handleSessionMenuClosed}
            onDelete={() => patchSessionMeta({ status: 'deleted' })}
            onLoadExtraDirPath={(path) => void loadExtraDirBrowsePath(path)}
            onRefreshAccountUsage={() => void refreshAccountUsage()}
            onRefreshContextUsage={() => void refreshContextUsage()}
            onResetCodexRateLimits={() => void resetCodexRateLimits()}
            onOpenWorkspace={() => {
              if (!currentSession.workingDir) return;
              setSettingsOpen(false);
              router.push({
                pathname: '/files/[sessionId]',
                params: { sessionId, deviceId, deviceName },
              });
            }}
            onOpenSessionTree={currentSession.agentKind === 'pi'
              ? openSessionTreeAfterMenu
              : undefined}
            onRegenerateTitle={() => maker.regenerateSessionTitle(sessionId)}
            onRename={(title) => patchSessionMeta({ title })}
            onRestore={() => patchSessionMeta({ status: 'active' })}
            onSetExtraDirs={(dirs) => void runControlAction(
              // 乐观 patch 让 session.extraDirs 立即反映本次写入:连续增删时下一次操作
              // 基于最新列表计算,不会拿远端回流前的旧值互相覆盖;失败 refetch 收敛回被控端真相。
              () => maker.setExtraDirs(sessionId, dirs),
              { extraDirs: dirs },
              { recover: 'refetch' },
            )}
            onToggleExtraDirBrowser={toggleExtraDirBrowser}
            onTogglePinned={() => patchSessionMeta({ pinnedAt: currentSession.pinnedAt ? null : new Date().toISOString() })}
            readOnlyReason={collaborationReadOnlyReason}
            session={currentSession}
            visible={settingsOpen}
          />
        ) : null}
        <PiSessionTreeSheet
          disabledReason={remoteSessionRunning
            ? t('session.menu.branchRunningBlocked')
            : collaborationReadOnlyReason}
          maker={maker}
          onClose={() => setSessionTreeOpen(false)}
          onNavigated={async (draftText) => {
            if (draftText) applyComposerDocument(textComposerDocument(draftText));
            setSessionTreeOpen(false);
            await requestSync({ reason: 'session-tree-navigate', replaceMessages: true });
          }}
          sessionId={sessionId}
          visible={sessionTreeOpen && currentSession?.agentKind === 'pi'}
        />
        <SessionSearchSheet
          activeHit={activeSearchHit}
          activeIndex={activeSearchIndex}
          hasOlderMessages={hasOlderMessages}
          hitCount={searchHits.length}
          loadingEarlier={loadingEarlier}
          onChangeQuery={setSearchQuery}
          onClose={closeSearch}
          onLoadEarlier={() => void loadEarlierMessages()}
          onMove={moveSearchHit}
          query={searchQuery}
          sheetMaxHeight={nativeShellLayout.sheetMaxHeight}
          keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
          visible={searchOpen}
        />
        <ChatFileChipMenuSheet
          keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
          onAction={handleChipMenuAction}
          onClose={() => setChipMenuTarget(null)}
          shareBusy={chipShareBusy}
          target={chipMenuTarget}
        />
        <ContextSheet
          footer={contextSheetView !== 'goal' && pendingMediaAssets.length > 0 ? (
            <ContextSheetFooterButton
              disabled={!canUseComposer}
              label={t('session.common.joinConversation', { num: pendingMediaAssets.length })}
              onPress={() => void commitPendingMediaAssets()}
              testID="session.contextSheetCommitMedia"
            />
          ) : undefined}
          keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
          onBack={contextSheetView !== 'main' ? () => setContextSheetView('main') : undefined}
          onClose={() => setContextSheetOpen(false)}
          testID="session.contextSheet"
          title={contextSheetView === 'screenshots' ? t('session.common.screenshot') : contextSheetView === 'goal' ? t('session.common.goalMode') : t('session.common.context')}
          visible={contextSheetOpen}
        >
          {contextSheetView === 'main' ? (
            <>
              <RecentPhotosStrip
                busyAssetIds={uploadingMediaAssetIds}
                disabled={!canUseComposer}
                enabled={contextSheetOpen}
                onToggleAsset={toggleMediaAssetAttachment}
                pendingOrder={pendingMediaOrder}
                selectedAssetIds={selectedMediaAssetIds}
                testID="session.contextSheetPhotos"
              />
              <ContextSheetGroup label={t('session.common.groupMode')}>
                {planModeSupported ? (
                  // 点击即切换计划模式并关面板(产品决策,不做开关);已开启时显示 ✓,再点退出。
                  <ContextSheetRow
                    accessibilityHint={composerSendUnavailableReason ?? undefined}
                    disabled={!canUseComposer || controlBusy}
                    icon={<ListTodo color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                    label={t('session.common.planMode')}
                    onPress={() => {
                      togglePlanMode(!planModeOn);
                      setContextSheetOpen(false);
                    }}
                    testID="session.contextSheetPlanRow"
                    trailing={planModeOn ? <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.bold} /> : null}
                  />
                ) : null}
                <ContextSheetRow
                  icon={<Target color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.goalMode')}
                  onPress={() => setContextSheetView('goal')}
                  testID="session.contextSheetGoalRow"
                  trailing={goalStatus ? (
                    <>
                      <Text style={{ color: colors.textTertiary, fontSize: typeScale.footnote }}>
                        {goalStatusLabel(goalStatus.status, goalStatus.lastReason)}
                      </Text>
                      <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                    </>
                  ) : 'chevron'}
                />
              </ContextSheetGroup>
              <ContextSheetGroup label={t('session.common.groupAdd')}>
                <ContextSheetRow
                  accessibilityHint={composerSendUnavailableReason ?? undefined}
                  disabled={!canUseComposer}
                  icon={<Image color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.photo')}
                  onPress={() => void addLocalImageAttachments('library')}
                  testID="session.contextSheetPhotoRow"
                />
                <ContextSheetRow
                  disabled={!canUseComposer}
                  icon={<Scan color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.screenshot')}
                  onPress={() => setContextSheetView('screenshots')}
                  testID="session.contextSheetScreenshotsRow"
                  trailing="chevron"
                />
                <ContextSheetRow
                  accessibilityHint={composerSendUnavailableReason ?? undefined}
                  disabled={!canUseComposer}
                  icon={<Camera color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.takePhoto')}
                  onPress={() => void addLocalImageAttachments('camera')}
                  testID="session.contextSheetCameraRow"
                />
                <ContextSheetRow
                  accessibilityHint={composerSendUnavailableReason ?? undefined}
                  disabled={!canUseComposer}
                  icon={<Folder color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.file')}
                  onPress={() => void addLocalFileAttachment()}
                  testID="session.contextSheetFileRow"
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
              contentWidth={Math.min(windowDimensions.width, nativeShellLayout.contentMaxWidth) - 40}
              disabled={!canUseComposer}
              enabled={contextSheetOpen && contextSheetView === 'screenshots'}
              onToggleAsset={toggleMediaAssetAttachment}
              pendingOrder={pendingMediaOrder}
              selectedAssetIds={selectedMediaAssetIds}
              testID="session.contextSheetScreenshotsGrid"
            />
          ) : (
            // goal 接回载荷按 sessionId 归属、渲染时同步过滤(codex review P1):
            // key={sessionId} 重挂载发生在渲染新 sessionId 的瞬间,此时 goalRestore
            // 仍是旧任务的残留值——新表单会先用旧 objective/limits 初始化,换代
            // effect 在 commit 后才清空、晚于那次挂载。渲染时按 sessionId 过滤:
            // 旧任务的值立即失效(不依赖 effect 时序),新表单从 composer 初始化。
            <ContextSheetGoalView
              key={sessionId}
              busy={goalBusy}
              error={goalError}
              goal={goalStatus}
              initial={goalRestoreForSession}
              initialObjective={goalRestoreForSession ? undefined : (draft.trim() || undefined)}
              onClearGoal={handleClearGoal}
              onPauseGoal={handlePauseGoal}
              onResumeGoal={handleResumeGoal}
              onSetGoal={handleSetGoal}
              testID="session.contextSheetGoalView"
            />
          )}
        </ContextSheet>
        {currentSession && runtimeOptions && modelSheetSelection && modelSheetRuntimeOptions ? (
          <ModelPickerSheet
            activeModelId={modelSheetSelection.model}
            existingSessionRoute

            activePermissionMode={displayPermissionMode ?? currentSession.permissionMode}
            agentKind={modelSheetAgentKind}
            agentSwitch={sessionAgentSwitchSupported ? {
              browsingAgentKind: modelSheetAgentKind,
              currentAgentKind: sessionAgentKind,
              disabled: controlBusy || !canUseComposer,
              onBrowseAgent: browseComposerModelAgent,
            } : undefined}
            apiKeyStatus={deviceApiKeyStatus}
            capabilities={modelSheetCapabilities}
            disabled={controlBusy || !canUseComposer}
            emptyHint={modelSheetCapabilitiesError ?? undefined}
            flatOptions={modelSheetRuntimeOptions.modelOptions}
            modelVisibilityOverrides={composerDeviceProviders.modelVisibilityOverrides}
            keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
            loading={composerDeviceProviders.loading || modelSheetCapabilitiesLoading}
            loadingHint={modelSheetCapabilitiesLoading
              ? t('session.screen.readingCapabilities', { agent: mobileAgentLabel(modelSheetAgentKind) })
              : undefined}
            modelMemory={sessionMirrorAccessors}
            onChangeSelectedEffort={changeComposerSelectedEffort}
            onChangeSelectedFastMode={changeComposerSelectedFastMode}
            onClose={() => setModelSheetOpen(false)}
            onSelectFlatModel={selectComposerFlatModel}
            hidePermissionTrigger
            onSelectPermissionMode={selectSessionPermissionMode}
            onSelectProviderRow={selectComposerModelRow}
            permissionDisabled={controlBusy || !canUseComposer}
            permissionOptions={runtimeOptions.permissionOptions}
            pricing={deviceModelPricing}
            providers={composerDeviceProviders.providers}
            selectedEffort={modelSheetSelection.effort}
            selectedFastMode={modelSheetSelection.fastMode}
            selectedProviderId={modelSheetSelection.providerId}
            testID="session.modelSheet"
            visible={modelSheetOpen && canUseComposer}
          />
        ) : null}
        {/* 权限模式独立浮窗(composer 权限图标钮点开;列表复用 MobilePermissionPickerList,
            选择走 confirmFullAccessChange + maker:set-permission-mode 后关浮窗)。 */}
        {currentSession && runtimeOptions ? (
          <SheetModal
            backdropTestID="session.permissionSheet.backdrop"
            onBackdropPress={() => setPermissionSheetOpen(false)}
            onRequestClose={() => setPermissionSheetOpen(false)}
            visible={permissionSheetOpen && canUseComposer}
          >
            <SheetSurface
              bottomInset={insets.bottom}
              heights={permissionSheetHeights}
              onClose={() => setPermissionSheetOpen(false)}
              onSnapChange={setPermissionSheetSnap}
              snap={permissionSheetSnap}
              testID="session.permissionSheet"
              title={t('models.picker.permissionTitle')}
            >
              <MobilePermissionPickerList
                activeMode={displayPermissionMode}
                disabled={controlBusy || !canUseComposer}
                onSelect={(mode) => {
                  selectSessionPermissionMode(mode);
                  setPermissionSheetOpen(false);
                }}
                options={runtimeOptions.permissionOptions}
                testID="session.permissionSheet.option"
              />
            </SheetSurface>
          </SheetModal>
        ) : null}
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
        <View style={styles.sessionMainLayer} testID="session.mainLayer">
          {sessionOperationLayout.composerSlot === 'missing-session' && remoteUnavailableReason ? (
            // 设备真不可用(离线/被撤销):消息区保留阻塞占位和重试入口;底部 composer 仍可编辑草稿。
            <SessionSyncPlaceholder
              loading={loading}
              onSync={() => void requestSync({ reason: 'manual', replaceMessages: false })}
            />
          ) : (
            <>
              <RewindPreviewPanel
                committing={!!messageActionBusy && isCommitReadyRewindState(rewindState)}
                onCancel={() => setRewindState({ kind: 'idle' })}
                onConfirm={() => void confirmRewind()}
                state={rewindState}
              />

              {sessionOperationLayout.messageHistoryMode === 'collapsed' ? (
                <MessageHistoryToggle
                  expanded={pendingHistoryExpanded}
                  onToggle={() => setPendingHistoryExpanded((value) => !value)}
                />
              ) : null}

              {/* showSyncingShell:session 还没回来但在同步,消息区先出骨架(走 MessageRenderer 的 loading 态)。 */}
              {showMessageHistory || showSyncingShell ? (
                <ChatFilePathContext.Provider value={chatFilePathContextValue}>
                  <MessageRenderer
                    bottomOverlayHeight={bottomOverlayHeight}
                    topOverlayHeight={topOverlayHeight}
                    busyAction={messageActionBusy?.kind ?? null}
                    busyClientId={messageActionBusy?.clientId ?? null}
                    canLoadEarlier={hasOlderMessages && messages.length > 0}
                    emptyTestID="session.messageList.empty"
                    focusedItemKey={focusedMessageItemKey ?? null}
                    focusedRequestKey={focusedMessageRequestKey}
                    followLatestRequestKey={messageListFollowLatestRequestKey}
                    isSessionStreaming={isSessionStreaming}
                    makerTurnRunning={makerTurnRunning}
                    continuationTurnClientId={inputProjection.continuationTurnClientId}
                    continuationInFlightProjectionCapability={
                      inputProjection.continuationInFlightProjectionCapability
                    }
                    items={messageListItems}
                    pendingSend={pendingSendActions}
                    loadingEarlier={loadingEarlier}
                    onCopyMessageLink={copyMessageLink}
                    onAddMessageToComposer={canUseComposer ? addMessageToComposer : undefined}
                    onDeleteMessage={collaborationReadOnlyReason ? undefined : deleteMessage}
                    onForkMessage={collaborationReadOnlyReason ? undefined : forkAtMessage}
                    onLoadEarlier={loadEarlierMessages}
                    onOpenForkOrigin={forkOrigin ? openForkOrigin : undefined}
                    onBlockingOverlayChange={handleMessageBlockingOverlayChange}
                    onOpenSessionLink={openSessionLink}
                    onPreviewRewind={collaborationReadOnlyReason ? undefined : previewRewindAtMessage}
                    onEnterShareSelection={enterShareSelection}
                    onVisibleShareableMessageIdsReaderChange={handleVisibleShareableMessageIdsReaderChange}
                    shareSelectionActive={shareSelectionActive}
                    shareSelectionBusy={conversationShareBusy}
                    // chat-text-quote:选中消息文字 → 引用进本会话草稿(截断后写
                    // chatQuoteStore,composer 胶囊即时刷新)。Composer 不可用态不启用;
                    // 回调已 memoize,保持 SelectionQuoteContext value 稳定。
                    onQuoteSelection={canUseComposer ? handleQuoteSelection : undefined}
                    onReadTextFilePreview={maker.fs.readTextFilePreview}
                    onReleaseRemoteMedia={releaseRemoteMedia}
                    onResolveRemoteMedia={resolveRemoteMedia}
                    onShareImage={shareLightboxImage}
                    imageAnnotation={collaborationReadOnlyReason ? undefined : composerAnnotations.chatAnnotation}
                    queueFooter={(
                      <>
                        {/* error-tail / interrupted 收尾提示:live 错误与队列区互斥
                            (resolveSessionTailBanner 内部已按 projection.error 抑制)。
                            协同只读会话(worker):error-tail 不渲染(错误卡已回流
                            消息流,信息可见);interrupted 渲染只读信息版——它没有
                            任何消息行可回落,不显示会让用户不知道任务为何停了
                            (review P2),操作行按只读隐藏。 */}
                        {tailBannerState
                          && (!collaborationReadOnlyReason || tailBannerState.kind === 'interrupted') ? (
                          <SessionTailBanner
                            busy={tailBannerBusy}
                            onContinue={() => void continueTailBanner()}
                            onDismiss={dismissTailBanner}
                            readOnly={!!collaborationReadOnlyReason}
                            state={tailBannerState}
                          />
                        ) : null}
                        {/* 队列状态横幅(错误 / 凭证等待 / 停止确认 / 暂停)。待发送气泡
                            不在这里,它们是消息流里的 pending_send 项。 */}
                        <InlineQueueSection
                          busy={queueBusy}
                          onClearError={clearQueueError}
                          onResume={resumeQueue}
                          onRetryError={retryQueueError}
                          projection={inputProjection}
                          readOnlyReason={queueInlineReadOnlyReason}
                        />
                      </>
                    )}
                    scrollResetKey={sessionId}
                    syncingWhileEmpty={syncingWhileEmpty}
                    testID="session.messageList"
                  />
                </ChatFilePathContext.Provider>
              ) : null}

            </>
          )}
        </View>

        <View
          ref={bottomOverlayRef}
          onLayout={handleBottomOverlayLayout}
          pointerEvents="box-none"
          style={[
            styles.sessionBottomLayer,
            shareSelectionActive && { overflow: 'visible' },
            { bottom: nativeShellLayout.keyboardBottomInset },
          ]}
          testID="session.bottomLayer"
        >
          <View
            pointerEvents="box-none"
            style={[
              styles.sessionBottomContent,
              // 待处理面板把 safe-area 收进自身 root，让问答 surface 延伸到
              // 屏幕底部且内容仍避开 home indicator；composer 继续由外层留 inset。
              {
                paddingBottom: sessionOperationLayout.composerSlot === 'pending-interaction'
                  ? 0
                  : insets.bottom,
              },
              nativeShellLayout.wideViewport && { maxWidth: nativeShellLayout.contentMaxWidth },
            ]}
            testID="session.bottomContent"
          >
          {!shareSelectionActive && canUseComposer && composerTrigger.kind === 'slash' ? (
            <ComposerPaletteFrame
              emptyText={t('session.common.noMatchingCommands')}
              errorText={slashPaletteError}
              loading={slashPaletteLoading}
              maxHeight={nativeShellLayout.paletteMaxHeight}
              testID="session.slashPalette"
            >
              {visibleSlashCommands.map((command) => (
                <ComposerPaletteRow
                  accessibilityLabel={t('session.common.insertCommand', { name: command.name })}
                  key={`${command.kind}:${command.name}`}
                  onPress={() => selectSlashCommand(command)}
                  primary={`/${command.name}`}
                  secondary={
                    command.kind === 'agent-skill'
                      ? command.source
                      : command.kind === 'desktop'
                        ? 'desktop'
                        : 'agent-cmd'
                  }
                  testID="session.slashCommandRow"
                />
              ))}
            </ComposerPaletteFrame>
          ) : null}

          {!shareSelectionActive && canUseComposer && composerTrigger.kind === 'at' ? (
            <ComposerPaletteFrame
              emptyText={atResourcesTruncated ? t('session.common.keepTypingToNarrow') : t('session.common.noMatchingResources')}
              errorText={atPaletteError}
              loading={atPaletteLoading}
              maxHeight={nativeShellLayout.paletteMaxHeight}
              testID="session.atPalette"
            >
              {visibleAtResources.map((item) => (
                <ComposerPaletteRow
                  accessibilityLabel={t('session.common.insertResource', { name: item.name })}
                  key={`${item.type}:${item.relPath}`}
                  onPress={() => selectAtResource(item)}
                  primary={item.type === 'dir' ? `${item.name}/` : item.name}
                  secondary={item.type === 'agent' ? 'Agent' : item.relPath}
                  testID="session.atResourceRow"
                />
              ))}
            </ComposerPaletteFrame>
          ) : null}

          {/*
            手机端终结不了的请求(plugin_setup 等)只贴在输入框上方:能看清电脑端
            在等什么、能取消,但不吃掉 composer —— 否则用户既处理不了这张卡又发不
            出消息。高度按 palette 量级收紧,内容超出走内部滚动。
          */}
          {!shareSelectionActive && sessionOperationLayout.pendingInteractionPlacement === 'above-composer' ? (
            <View
              style={[
                styles.pendingInteractionSurface,
                { maxHeight: nativeShellLayout.paletteMaxHeight },
              ]}
              testID="interaction.aboveComposerSurface"
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                testID="interaction.aboveComposerScroll"
              >
                {/* 这张卡本来就只占 palette 量级高度、且手机上答不了(只能取消 / 回电脑端),
                    不给收起入口:收起态的文案与 a11y 都是「先不答、稍后回答」,套在它身上是
                    错的语义。 */}
                <InteractionPanel
                  deviceId={deviceId}
                  sessionId={sessionId}
                  interactions={pending}
                  activeRequestId={pendingInteractionActiveRequestId}
                  onActiveRequestIdChange={setPendingInteractionActiveRequestId}
                  onError={setError}
                  readOnlyReason={collaborationReadOnlyReason}
                />
              </ScrollView>
            </View>
          ) : null}

          {shareSelectionActive ? null : sessionOperationLayout.composerSlot === 'pending-interaction' ? (
            <View
              style={[
                styles.pendingInteractionSurface,
                pendingInteractionFullHeight
                  ? {
                    height: nativeShellLayout.pendingSurfaceExpandedHeight,
                    maxHeight: nativeShellLayout.pendingSurfaceExpandedHeight,
                  }
                  : { maxHeight: nativeShellLayout.pendingSurfaceMaxHeight },
              ]}
              testID="interaction.bottomSurface"
            >
              {pendingInteractionFullHeight ? (
                <View
                  style={[
                    styles.pendingInteractionFullContent,
                    { height: nativeShellLayout.pendingSurfaceExpandedHeight },
                  ]}
                  testID="interaction.bottomScroll"
                >
                  <InteractionPanel
                    safeAreaBottomInset={insets.bottom}
                    collapse={pendingInteractionCollapse}
                    deviceId={deviceId}
                    fillAvailableHeight
                    sessionId={sessionId}
                    interactions={pending}
                    activeRequestId={pendingInteractionActiveRequestId}
                    onActiveRequestIdChange={setPendingInteractionActiveRequestId}
                    planViewerState={pendingPlanViewerState}
                    onPlanViewerStateChange={setPendingPlanViewerState}
                    onError={setError}
                    readOnlyReason={collaborationReadOnlyReason}
                  />
                </View>
              ) : (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  testID="interaction.bottomScroll"
                >
                <InteractionPanel
                  safeAreaBottomInset={insets.bottom}
                  collapse={pendingInteractionCollapse}
                  deviceId={deviceId}
                  sessionId={sessionId}
                  interactions={pending}
                  activeRequestId={pendingInteractionActiveRequestId}
                  onActiveRequestIdChange={setPendingInteractionActiveRequestId}
                  planViewerState={pendingPlanViewerState}
                  onPlanViewerStateChange={setPendingPlanViewerState}
                  onError={setError}
                  readOnlyReason={collaborationReadOnlyReason}
                />
                </ScrollView>
              )}
            </View>
          ) : sessionOperationLayout.composerSlot === 'read-only' ? (
            <View style={styles.readOnlyComposer} testID="session.collaborationReadOnlyComposer">
              <Text style={styles.collaborationTitle}>{t('session.screen.readOnlyMode')}</Text>
              <Text style={styles.collaborationText}>
                {composerDisabledReason}
              </Text>
            </View>
          ) : (
            <>
              {/* 消息区还在「正在同步」占位(新建会话第一帧 / 冷开首屏)时不谈运行状态:
                  「正在同步 + 思考中 + 0s · 0 tokens」三件事同时铺开,反倒像出错,而且
                  紧接着消息落屏时这条又要重排一次。等有内容了再显示活动条。
                  判据必须带 messageCount:syncingWhileEmpty 只要 loading 就为真,而收口后
                  还会再来几轮 load(实测日志),只看它会让已有消息的会话反复熄灭活动条。 */}
              {showComposerActivity && !(syncingWhileEmpty && messages.length === 0) ? (
                <View
                  style={[
                    styles.composerActivityFrame,
                    { paddingHorizontal: composerTouchLayout.composerPaddingHorizontal },
                  ]}
                >
                  <ComposerActivityStatus
                    reconnectAttempt={remoteSessionRunStatus.reconnectAttempt}
                    sideTaskRunning={remoteSessionRunStatus.sideTaskRunning}
                    startedAt={composerActivityStartedAtMs}
                    tokenUsage={composerActivityTokenUsage}
                    visible={showComposerActivity}
                  />
                </View>
              ) : null}
              {queueEditing ? (
                <View
                  style={[
                    styles.queueEditBar,
                    { marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                  ]}
                  testID="session.queueEditBar"
                >
                  <Pencil color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={styles.queueEditBarText}>
                    {(() => {
                      const index = inputProjection.pendingQueue
                        .findIndex((item) => item.clientId === queueEditing.clientId);
                      return index >= 0 ? t('session.screen.editingQueueMessageNumbered', { index: index + 1 }) : t('session.screen.editingQueueMessage');
                    })()}
                  </Text>
                  <RouteActionButton
                    accessibilityLabel={t('session.screen.discardQueueEdit')}
                    accessibilityHint={sending ? t('session.screen.savingHint') : undefined}
                    // 保存(updateContent RPC)在途时禁用:此刻放弃会在编辑已派发的
                    // 同时恢复 stash + 解锁,桌面端仍会应用修改,状态与 UI 脱节(review P2)。
                    disabled={sending}
                    hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                    onPress={() => cancelQueueEdit()}
                    style={styles.queueEditBarClose}
                    testID="session.queueEditCancel"
                  >
                    <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  </RouteActionButton>
                </View>
              ) : null}
              {composerAgentAuthHint ? (
                <View
                  style={[
                    styles.queueEditBar,
                    { marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                  ]}
                  testID="session.agentAuthGateHint"
                >
                  <Text style={styles.queueEditBarText}>{composerAgentAuthHint}</Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.composer,
                  {
                    // manual 拖高时容器上限放开到拖拽上限（bounds 已保证不顶穿屏幕），
                    // 否则输入区超过 auto 上限后容器从底部裁剪掉发送按钮 trailing 行。
                    maxHeight: composerResize.dragging || composerResize.mode === 'manual'
                      ? composerResize.maxFrameHeight + composerChromeHeight
                      : nativeShellLayout.composerMaxHeight,
                    paddingHorizontal: composerTouchLayout.composerPaddingHorizontal,
                  },
                ]}
                testID="session.composer"
              >
                {voiceStatusVisible ? (
                  <View style={styles.voiceStatusRow}>
                    <Text style={styles.voiceStatusText} testID="session.voiceStatus">
                      {voiceError}
                    </Text>
                    {canOpenVoiceSettings ? (
                      <RouteActionButton
                        accessibilityLabel={t('session.common.openMicPermission')}
                        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                        onPress={openVoiceSettings}
                        style={styles.voiceCancelButton}
                        testID="session.voiceSettingsButton"
                      >
                        <Settings color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                      </RouteActionButton>
                    ) : null}
                  </View>
                ) : null}
                <ScrollView
                  ref={composerScrollViewRef}
                  contentContainerStyle={styles.composerScrollContent}
                  keyboardShouldPersistTaps="handled"
                  scrollEnabled={composerScrollEnabled}
                  showsVerticalScrollIndicator={composerScrollEnabled}
                  style={styles.composerScroll}
                  testID="session.composerScroll"
                >

                {attachmentError ? (
                  <Text style={styles.attachmentErrorText} testID="session.attachmentStatus">
                    {attachmentError}
                  </Text>
                ) : null}

                <View style={[
                  styles.composerSurface,
                  compactComposer && !composerCardActive && styles.composerSurfaceCompact,
                ]}>
                  <MobileComposerInputRow
                    key={sessionId}
                    accessibilityLabel={t('session.screen.composerPlaceholder')}
                    accessibilityHint={composerLayout.input.disabledReason ?? undefined}
                    accessoryAbove={attachments.length > 0 || pendingUploads.length > 0 || pastePlaceholderCount > 0 ? renderComposerAttachmentTray() : null}
                    autoFocus={visualFocusComposer}
                    cardActive={composerCardActive}
                    caretHidden={voiceIsListening}
                    compact={compactComposer && !composerCardActive}
                    editable={!composerLayout.input.disabled}
                    floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}
                    cursorColor={colors.inputCaret}
                    inputFrameHeight={composerResize.frameHeight}
                    // 听写期间把输入区撑到 44pt 触控目标:命中层盖在 inputFrame 上,
                    // hitSlop 越不过父边界(见常量注释)。
                    inputFrameMinHeight={voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined}
                    inputElement={(
                      <ComposerRichInput
                        ref={composerInputRef}
                        accessibilityHint={composerLayout.input.disabledReason ?? undefined}
                        accessibilityLabel="输入远程消息"
                        document={composerDocument}
                        editable={!composerLayout.input.disabled}
                        height={composerInputVisibleHeight}
                        hidden={voiceIsListening}
                        maxHeight={composerResize.inputMaxHeight}
                        onBlur={() => {
                          setComposerFocused(false);
                          setComposerVoiceHoldArmed(false);
                        }}
                        onChangeDocument={applyRichComposerChange}
                        onFocus={() => setComposerFocused(true)}
                        onHeightChange={handleComposerRichInputHeight}
                        onPasteImages={(uris) => void addPastedImageAttachments(uris)}
                        onPasteImagesLoading={beginPastePlaceholders}
                        onPasteImagesLoadFailed={failPastePlaceholders}
                        placeholder={voiceIsListening ? '' : composerLayout.input.placeholder}
                        resolveSessionLinkLabel={resolvePastedSessionLinkLabel}
                        testID="session.composerRichInput"
                        theme={{
                          background: colors.chatCodeSurface,
                          border: colors.border,
                          chip: colors.surfaceChip,
                          focus: colors.inputCaret,
                          placeholder: colors.textTertiary,
                          text: colors.textPrimary,
                          textSecondary: colors.textSecondary,
                        }}
                      />
                    )}
                    inputOverlay={renderComposerInputOverlay()}
                    inputStyle={voiceIsListening ? styles.inputVoiceHidden : undefined}
                    inputTestID="session.composerInput"
                    leading={renderComposerCollapsedAttachmentBadge()}
                    maxHeight={composerResize.inputMaxHeight}
                    multilineShape={!composerCardActive && composerInputIsMultiline}
                    onBlur={() => {
                      setComposerFocused(false);
                      // 失焦收起与「点别处收键盘」同语义:语音结束 hold 一并解除。
                      setComposerVoiceHoldArmed(false);
                    }}
                    onChangeText={setComposerDraft}
                    onContentSizeChange={handleComposerInputContentSizeChange}
                    onFocus={() => {
                      setComposerFocused(true);
                      handleComposerInputPressIn();
                    }}
                    onPasteImages={(uris) => void addPastedImageAttachments(uris)}
                    onPasteImagesLoading={beginPastePlaceholders}
                    onPasteImagesLoadFailed={failPastePlaceholders}
                    onPressIn={handleComposerInputPressIn}
                    placeholder={voiceIsListening ? '' : composerLayout.input.placeholder}
                    placeholderTextColor={colors.textTertiary}
                    resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}
                    scrollEnabled={composerInputScrollEnabled}
                    selectionColor={colors.inputCaret}
                    testID="session.composerInputRow"
                    toolbar={renderComposerToolbar()}
                    trailing={composerCardActive ? null : renderComposerTrailingActions()}
                    value={draft}
                    voicePlacement={composerVoicePlacement}
                  />
                </View>
                </ScrollView>
              </View>
            </>
        )}
          {shareSelectionActive ? (
            <ShareSelectionBar
              busy={conversationShareBusy}
              count={shareSelectionCount}
              shareableIds={allShareableIds}
              screenshotTriggered={shareSelectionTriggeredByScreenshot}
              onCancel={cancelShareSelection}
              onShare={() => void shareSelectedConversation()}
            />
          ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
      {shareSelectionActive && conversationShareHtml && !conversationShareNativeRendererAvailable ? (
        <ConversationShareWebView
          html={conversationShareHtml}
          key={conversationShareHtml}
          ref={conversationShareWebViewRef}
        />
      ) : null}
      {wideSessionNav.enabled || sessionListDrawerOverlayMounted ? (
        // 树内 overlay(zIndex 40)盖住顶部 chrome 与底部 composer;树内层叠而非 Modal 的
        // 取舍见 SessionListDrawer 头注释。退出宽屏时也保留到 onClosed,否则退场期旋转/
        // 收窄会直接卸载组件并吞掉已登记的导航动作。
        <SessionListDrawer
          currentSessionId={sessionId}
          onClose={closeSessionListDrawer}
          onClosed={handleSessionListDrawerClosed}
          onGoHome={handleDrawerGoHome}
          onNewSession={handleDrawerNewSession}
          onSelectSession={handleDrawerSelectSession}
          open={sessionListDrawerOpen}
          width={sessionListDrawerWidthRef.current}
        />
      ) : null}
    </View>
  );
}

type SessionHeaderIcon = typeof Folder;

function TranslucentBackdrop() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return <BlurBackdrop intensity={40} overlayColor={colors.chatHeaderSurface} style={styles.translucentBackdrop} />;
}

function SessionHeaderBar({
  currentSession,
  diffCount,
  isDeviceAccessRevoked,
  syncing,
  messageCount,
  onBack,
  onOpenFiles,
  onOpenSessionList,
  onOpenSettings,
  onOpenUsage,
  onToggleSearch,
  pendingCount,
  queueCount,
  queuePaused,
  readOnlyReason,
  remoteUnavailableReason,
  searchOpen,
  sessionListButtonRef,
  title,
}: {
  currentSession: RemoteSession | null;
  diffCount: number;
  isDeviceAccessRevoked: boolean;
  syncing: boolean;
  messageCount: number;
  onBack(): void;
  /** 宽屏导航形态下提供:左上角改为三条杠,点击拉出任务列表抽屉(替代返回)。 */
  onOpenSessionList?: () => void;
  /** 三条杠按钮 ref:抽屉关闭后读屏焦点归还的锚点。 */
  sessionListButtonRef?: RefObject<View | null>;
  onOpenFiles(): void;
  onOpenSettings(): void;
  onOpenUsage(): void;
  onToggleSearch(): void;
  pendingCount: number;
  queueCount: number;
  queuePaused: boolean;
  readOnlyReason?: string | null;
  remoteUnavailableReason?: string | null;
  searchOpen: boolean;
  title: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const overview = currentSession
    ? summarizeSessionOverview({
        diffCount,
        messageCount,
        pendingCount,
        queueCount,
        queuePaused,
        readOnlyReason,
        remoteUnavailableReason,
        searchOpen,
        session: currentSession,
      })
    : null;
  const actionProjection = overview ? projectMobileSessionActions(overview.actions) : null;
  // queue 入口已退役:排队消息 inline 到消息流(InlineQueueSection),不再有独立面板。
  const headerActions = (actionProjection?.primaryActions ?? [])
    .filter((action) => action.id !== 'settings' && action.id !== 'queue');
  const actionHandlers = {
    files: onOpenFiles,
    queue: () => undefined,
    search: onToggleSearch,
    settings: onOpenSettings,
    usage: onOpenUsage,
  } satisfies Record<SessionActionStripActionId, () => void>;
  const notice = compactSessionHeaderNotice({
    isDeviceAccessRevoked,
    syncing,
    pendingCount,
    queuePaused,
    readOnlyReason,
    session: currentSession,
  });

  return (
    <View style={styles.sessionHeaderBar} testID="session.summary">
      {onOpenSessionList ? (
        // 宽屏(iPad / 折叠屏展开 / 横屏手机):三条杠拉任务列表抽屉,返回语义由抽屉里的
        // 「主页」项与系统返回手势承担。
        <SessionHeaderIconButton
          accessibilityLabel={t('home.drawer.openA11y')}
          active={false}
          buttonRef={sessionListButtonRef}
          hitSlop={4}
          icon={Menu}
          onPress={onOpenSessionList}
          testID="session.sessionListButton"
        />
      ) : (
        <ScreenBackButton
          hitSlop={4}
          onPress={onBack}
          style={styles.sessionHeaderBackButton}
          testID="session.backButton"
        />
      )}

      <View style={styles.sessionHeaderTextBlock}>
        <View style={styles.sessionHeaderTitleRow}>
          {currentSession?.pinnedAt ? (
            <Pin
              color={colors.textTertiary}
              size={iconSize.sm}
              strokeWidth={iconStroke.regular}
            />
          ) : null}
          <Text numberOfLines={1} style={styles.sessionHeaderTitle} testID="session.title">
            {title}
          </Text>
        </View>
        {notice ? (
          <Text numberOfLines={1} style={styles.sessionHeaderNotice} testID="session.headerNotice">
            {notice}
          </Text>
        ) : null}
      </View>

      <View style={styles.sessionHeaderActions}>
        {headerActions.map((action) => (
          <SessionHeaderIconButton
            accessibilityHint={action.disabledReason ?? undefined}
            accessibilityLabel={action.accessibilityLabel}
            active={action.active}
            attention={action.attention}
            disabled={action.disabled}
            icon={sessionHeaderActionIcon(action.id)}
            key={action.id}
            onPress={action.disabled ? undefined : actionHandlers[action.id]}
            testID={SESSION_ACTION_TEST_IDS[action.id]}
          />
        ))}
        <SessionHeaderIconButton
          accessibilityLabel={t('session.screen.openSessionMenu')}
          active={false}
          disabled={!currentSession}
          icon={Ellipsis}
          onPress={currentSession ? onOpenSettings : undefined}
          testID="session.controlsToggle"
        />
      </View>
    </View>
  );
}

function SessionHeaderIconButton({
  accessibilityHint,
  accessibilityLabel,
  active,
  attention = false,
  buttonRef,
  disabled,
  hitSlop,
  icon: Icon,
  onPress,
  testID,
}: {
  accessibilityHint?: string;
  accessibilityLabel: string;
  active?: boolean;
  attention?: boolean;
  /** 需要外部定位本钮时传入(如三条杠:抽屉关闭后读屏焦点归还锚点)。 */
  buttonRef?: RefObject<View | null>;
  disabled?: boolean;
  /** 38×38 可见钮低于 44 触控底线时用它补热区(如左上角三条杠)。 */
  hitSlop?: PressableProps['hitSlop'];
  icon: SessionHeaderIcon;
  onPress?: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const color = colors.textPrimary;
  return (
    <RouteActionButton
      ref={buttonRef}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      active={active}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      pressedStyle={styles.sessionHeaderIconPressed}
      style={[
        styles.sessionHeaderIconButton,
        active && styles.sessionHeaderIconButtonActive,
      ]}
      testID={testID}
    >
      <Icon color={color} size={iconSize.action} strokeWidth={iconStroke.regular} />
      {attention ? (
        <View style={styles.sessionHeaderIconDot} />
      ) : null}
    </RouteActionButton>
  );
}

function sessionHeaderActionIcon(actionId: SessionActionStripActionId): SessionHeaderIcon {
  if (actionId === 'files') return Folder;
  if (actionId === 'queue') return List;
  if (actionId === 'search') return Search;
  return Ellipsis;
}

function compactSessionHeaderNotice({
  isDeviceAccessRevoked,
  syncing,
  pendingCount,
  queuePaused,
  readOnlyReason,
  session,
}: {
  isDeviceAccessRevoked: boolean;
  syncing: boolean;
  pendingCount: number;
  queuePaused: boolean;
  readOnlyReason?: string | null;
  session: RemoteSession | null;
}): string | null {
  if (isDeviceAccessRevoked) return i18n.t('session.screen.accessRevoked');
  if (!session) return syncing ? i18n.t('session.screen.syncingSession') : null;
  if (syncing) return i18n.t('session.screen.syncing');
  if (pendingCount > 0) return i18n.t('session.screen.pendingCount', { num: pendingCount });
  // readOnlyReason 现在传入的是 composer 只读 reason:worker(只读)→「只读模式」;Lead(可聊天)→ 不显示。
  if (readOnlyReason) return i18n.t('session.screen.readOnlyMode');
  // 协作角色会话(Lead 等可聊天的角色)显示协作标签而非「只读模式」,标明其协作身份。
  const collaborationLabel = sessionCollaborationLabel(session);
  if (collaborationLabel) return collaborationLabel;
  if (session.status === 'archived') return i18n.t('session.screen.archived');
  if (queuePaused) return i18n.t('session.screen.queuePausedNotice');
  return null;
}

function SessionSearchSheet({
  activeHit,
  activeIndex,
  hasOlderMessages,
  hitCount,
  keyboardAvoidingBehavior,
  loadingEarlier,
  onChangeQuery,
  onClose,
  onLoadEarlier,
  onMove,
  query,
  sheetMaxHeight,
  visible,
}: {
  activeHit: MobileMessageSearchHit | null;
  activeIndex: number;
  hasOlderMessages: boolean;
  hitCount: number;
  keyboardAvoidingBehavior: 'height' | 'padding' | undefined;
  loadingEarlier: boolean;
  onChangeQuery(value: string): void;
  onClose(): void;
  onLoadEarlier(): void;
  onMove(direction: 'previous' | 'next'): void;
  query: string;
  sheetMaxHeight: number;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const normalizedQuery = query.trim();
  const hasHits = hitCount > 0;
  const loadEarlierAction = buildSearchLoadEarlierAction({
    hasHits,
    hasOlderMessages,
    loading: loadingEarlier,
    query,
  });
  return (
    <SheetModal
      backdropTestID="search.backdrop"
      keyboardAvoiding
      keyboardAvoidingBehavior={keyboardAvoidingBehavior}
      onBackdropPress={onClose}
      onRequestClose={onClose}
      visible={visible}
    >
      <SafeAreaView
        style={[styles.adhocSheet, { maxHeight: sheetMaxHeight }]}
        testID="search.sheet"
      >
        <BlurBackdrop intensity={32} overlayColor={colors.surfaceGlassPanel} />
        {/* 把手仅作视觉暗示(SheetSurface 同款 SheetGrabber);本 ad-hoc 面板不接拖动手势,点背板即可关。 */}
        <SheetGrabber style={styles.adhocSheetGrabber} />
        <View style={styles.adhocSheetHeader}>
          <View style={styles.adhocSheetHeaderText}>
            <Text style={styles.adhocSheetTitle}>{t('session.screen.searchTitle')}</Text>
          </View>
        </View>
        <View style={styles.searchPanel} testID="session.searchPanel">
          <TextInput
            accessibilityLabel={t('session.screen.searchPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={MOBILE_VISUAL_MOCK_ENABLED && visible}
            onChangeText={onChangeQuery}
            placeholder={t('session.screen.searchPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            style={styles.searchInput}
            testID="session.searchInput"
            value={query}
          />
          <View style={styles.searchToolbar}>
            <Text style={styles.searchCounter} testID="session.searchCounter">
              {normalizedQuery
                ? hasHits ? `${activeIndex + 1}/${hitCount}` : '0/0'
                : t('session.screen.searchEnterKeyword')}
            </Text>
            <View style={styles.searchButtons}>
              <RouteActionButton
                accessibilityLabel={t('session.screen.searchPrevious')}
                disabled={!hasHits}
                onPress={() => onMove('previous')}
                style={styles.searchNavButton}
                testID="session.searchPreviousButton"
              >
                <ChevronUp color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
              </RouteActionButton>
              <RouteActionButton
                accessibilityLabel={t('session.screen.searchNext')}
                disabled={!hasHits}
                onPress={() => onMove('next')}
                style={styles.searchNavButton}
                testID="session.searchNextButton"
              >
                <ChevronDown color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
              </RouteActionButton>
            </View>
          </View>
          {activeHit ? (
            <Text style={styles.searchPreview} numberOfLines={2} testID="session.searchPreview">
              {activeHit.label}: {activeHit.preview}
            </Text>
          ) : normalizedQuery ? (
            <Text style={styles.searchPreview} testID="session.searchPreview">{t('session.screen.searchNoMatch')}</Text>
          ) : null}
          {loadEarlierAction.visible ? (
            <RouteActionButton
              accessibilityLabel={loadEarlierAction.accessibilityLabel}
              disabled={loadEarlierAction.disabled}
              onPress={onLoadEarlier}
              style={styles.searchLoadEarlierButton}
              testID="session.searchLoadEarlierButton"
            >
              <Text style={styles.searchLoadEarlierText}>{loadEarlierAction.label}</Text>
            </RouteActionButton>
          ) : null}
        </View>
      </SafeAreaView>
    </SheetModal>
  );
}

function SessionSyncPlaceholder({
  loading,
  onSync,
}: {
  loading: boolean;
  onSync(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
      <View style={styles.sessionSyncPlaceholder} testID="session.unsyncedState">
      <View style={styles.sessionSyncRow}>
        <Text style={styles.sessionSyncTitle}>{loading ? t('session.screen.syncingSession') : t('session.screen.awaitingSync')}</Text>
        <RouteActionButton
          accessibilityLabel={t('session.screen.resync')}
          disabled={loading}
          onPress={onSync}
          style={styles.sessionSyncButton}
          testID="session.unsyncedSyncButton"
        >
          {loading ? (
            <ActivityIndicator color={colors.textSecondary} size="small" />
          ) : (
            <RefreshCw color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          )}
        </RouteActionButton>
      </View>
    </View>
  );
}

function MessageHistoryToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <RouteActionButton
      accessibilityLabel={expanded ? t('session.screen.collapseHistory') : t('session.screen.expandHistory')}
      onPress={onToggle}
      style={styles.historyToggle}
      testID="session.pendingHistoryToggle"
    >
      <Text style={styles.historyToggleTitle}>{expanded ? t('session.screen.collapseHistory') : t('session.screen.expandHistory')}</Text>
    </RouteActionButton>
  );
}

function readRouteParam(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function isRemoteMessageStreaming(message: RemoteMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.agentMeta?.isStreaming === true || message.agentMeta?.streaming === true) return true;
  const content = readRecord(message.content);
  return content?.isStreaming === true || content?.streaming === true;
}

function currentTurnHasStreamingAssistant(messages: readonly RemoteMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') return false;
    if (isRemoteMessageStreaming(message)) return true;
  }
  return false;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildMobileVoiceSessionRefinementContext(
  draftText: string,
  items: readonly MobileMessageRenderItem[],
) {
  const selectionBefore = truncateMobileVoiceContext(draftText, 1200);
  const replyToMessage = findLastAssistantMessageText(items);
  return {
    selectionBefore: selectionBefore || undefined,
    replyToMessage: replyToMessage || undefined,
  };
}

function findLastAssistantMessageText(items: readonly MobileMessageRenderItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.type === 'message' && item.message.kind === 'assistant' && !item.message.isStreaming) {
      return truncateMobileVoiceContext(item.message.body, 500);
    }
    if (item.type === 'work_group') {
      const nested = findLastAssistantMessageText(item.children);
      if (nested) return nested;
    }
    // 子 agent 卡的内层也要纳入语音"回复上一条"上下文:最新 assistant 内容可能在子 agent 卡尾部。
    if (item.type === 'subagent_group') {
      const nested = findLastAssistantMessageText(item.childItems);
      if (nested) return nested;
    }
  }
  return '';
}

function truncateMobileVoiceContext(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars).trim();
}

interface RouteActionButtonProps {
  accessibilityHint?: string;
  accessibilityLabel: string;
  active?: boolean;
  busy?: boolean;
  children: ReactNode;
  delayLongPress?: number;
  disabled?: boolean;
  disabledStyle?: StyleProp<ViewStyle>;
  hitSlop?: PressableProps['hitSlop'];
  onLayout?: PressableProps['onLayout'];
  onLongPress?: () => void;
  onPress?: () => void;
  onPressIn?: PressableProps['onPressIn'];
  onPressOut?: PressableProps['onPressOut'];
  onResponderMove?: PressableProps['onResponderMove'];
  /** responder 被系统/滚动终止时的回调(正常松手不触发);语音按钮用它撤销按下即录。 */
  onTouchCancel?: PressableProps['onTouchCancel'];
  pressedStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const RouteActionButton = forwardRef<View, RouteActionButtonProps>(function RouteActionButton({
  accessibilityHint,
  accessibilityLabel,
  active = false,
  busy = false,
  children,
  delayLongPress,
  disabled = false,
  disabledStyle,
  hitSlop,
  onLayout,
  onLongPress,
  onPress,
  onPressIn,
  onPressOut,
  onResponderMove,
  onTouchCancel,
  pressedStyle,
  style,
  testID,
}, ref) {
  const styles = useThemedStyles(makeStyles);
  const resolvedDisabledStyle = disabledStyle === undefined ? styles.sendButtonDisabled : disabledStyle;
  const resolvedPressedStyle = pressedStyle === undefined ? styles.routeButtonPressed : pressedStyle;
  const interactionDisabled = disabled || busy || !onPress;
  return (
    <Pressable
      ref={ref}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        busy: busy || undefined,
        disabled: interactionDisabled,
        selected: active || undefined,
      }}
      delayLongPress={delayLongPress}
      disabled={interactionDisabled}
      hitSlop={hitSlop}
      onLayout={onLayout}
      onLongPress={interactionDisabled ? undefined : onLongPress}
      onPress={interactionDisabled ? undefined : onPress}
      onPressIn={interactionDisabled ? undefined : onPressIn}
      onPressOut={interactionDisabled ? undefined : onPressOut}
      onResponderMove={interactionDisabled ? undefined : onResponderMove}
      onTouchCancel={interactionDisabled ? undefined : onTouchCancel}
      style={({ pressed }) => [
        style,
        pressed && resolvedPressedStyle,
        interactionDisabled && resolvedDisabledStyle,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
});

function ComposerRuntimePill({
  icon: Icon,
  fastOn = false,
  label,
  leading,
  onPress,
  testID,
  tone,
}: {
  icon?: typeof Hand;
  /** Fast 已生效 → label 后缀 Zap 闪电(对齐桌面 trigger)。 */
  fastOn?: boolean;
  label: string;
  /** 前缀节点(模型药丸传来源官方 mark);与 icon 二选一。 */
  leading?: ReactNode;
  onPress(): void;
  testID: string;
  tone?: 'bypassPermissions';
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const color = tone === 'bypassPermissions' ? colors.statusAccent : colors.textSecondary;
  return (
    <RouteActionButton
      accessibilityLabel={label}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={onPress}
      style={styles.composerRuntimePill}
      testID={testID}
    >
      {leading ?? null}
      {Icon ? <Icon color={color} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
      <Text
        style={[
          styles.composerRuntimePillText,
          tone === 'bypassPermissions' && styles.composerRuntimePillTextRisky,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {fastOn ? <Zap color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
      <ChevronDown color={color} size={iconSize.sm} strokeWidth={iconStroke.regular} />
    </RouteActionButton>
  );
}

function ComposerActivityStatus({
  reconnectAttempt,
  sideTaskRunning,
  startedAt,
  tokenUsage,
  visible,
}: {
  reconnectAttempt: RemoteSessionRunStatus['reconnectAttempt'];
  sideTaskRunning: boolean;
  startedAt: number | null;
  tokenUsage: number;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!visible || !startedAt) {
      setElapsed(0);
      return undefined;
    }
    const updateElapsed = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [startedAt, visible]);

  if (!visible) return null;

  const elapsedText = formatComposerActivityElapsed(elapsed);
  const tokenText = formatComposerActivityTokens(tokenUsage);
  // 三类进度共用这一个 attempt 字段, 但说法必须分开: 模型容量、请求限流与传输层重连
  // 的用户含义不同，混用会把用户引向错误的排查方向。
  const activityText = reconnectAttempt
    ? t(
        reconnectAttempt.kind === 'overload'
          ? 'session.screen.modelBusyRetrying'
          : reconnectAttempt.kind === 'rate-limit'
            ? 'session.screen.rateLimitRetrying'
            : 'session.screen.networkReconnecting',
      )
    : t('session.screen.thinking');

  return (
    <View
      pointerEvents="none"
      style={styles.composerActivityStatus}
      testID="session.composerActivityStatus"
    >
      <View style={styles.composerActivityPrimary}>
        <Sparkles color={colors.statusAccent} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        <Text numberOfLines={1} style={styles.composerActivityStatusText}>{activityText}</Text>
        {reconnectAttempt ? (
          <Text style={[styles.composerActivityStatusText, styles.composerActivityProgressText]}>
            {reconnectAttempt.attempt}/{reconnectAttempt.maxAttempts}
          </Text>
        ) : null}
      </View>
      <View style={styles.composerActivityMeta}>
        <Text style={styles.composerActivityMetaText}>{elapsedText}</Text>
        {!sideTaskRunning ? (
          <>
            <Text style={styles.composerActivityMetaText}>·</Text>
            <ArrowDown color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
            <Text style={styles.composerActivityMetaText}>{tokenText}</Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

function formatComposerActivityElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function formatComposerActivityTokens(tokenUsage: number): string {
  const safeTokens = Math.max(0, Math.round(tokenUsage));
  if (safeTokens >= 1000) return `${(safeTokens / 1000).toFixed(1)}k tokens`;
  return `${safeTokens} tokens`;
}

function ComposerPaletteRow({
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
    <RouteActionButton
      accessibilityLabel={accessibilityLabel}
      disabledStyle={undefined}
      onPress={onPress}
      pressedStyle={styles.paletteRowPressed}
      style={styles.paletteRow}
      testID={testID}
    >
      <Text style={styles.palettePrimary} numberOfLines={1}>{primary}</Text>
      <Text style={styles.paletteSecondary} numberOfLines={1}>{secondary}</Text>
    </RouteActionButton>
  );
}

function ComposerPaletteFrame({
  children,
  emptyText,
  errorText,
  loading,
  maxHeight,
  testID,
}: {
  children: ReactNode;
  emptyText: string;
  errorText: string | null;
  loading: boolean;
  maxHeight: number;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <View style={[styles.palettePanel, { maxHeight }]} testID={testID}>
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

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  keyboard: { flex: 1 },
  sessionChrome: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
  },
  sessionChromeContent: {
    width: '100%',
  },
  sessionMainLayer: {
    flex: 1,
    minHeight: 0,
  },
  sessionBottomLayer: {
    backgroundColor: colors.surface,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
  sessionBottomContent: {
    alignSelf: 'center',
    width: '100%',
  },
  translucentBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  // 排队消息编辑提示条(composer 上方):✎ + 「正在编辑第 N 条排队消息」 + × 放弃。
  queueEditBar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  queueEditBarText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.footnote,
    minWidth: 0,
  },
  queueEditBarClose: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 26,
    justifyContent: 'center',
    width: 26,
  },
  sessionHeaderBar: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderBottomColor: colors.chatHeaderDivider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 50,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  sessionHeaderBackButton: {
    flexShrink: 0,
  },
  sessionHeaderTextBlock: {
    flex: 1,
    minWidth: 0,
    paddingLeft: spacing.xs,
  },
  sessionHeaderTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minWidth: 0,
  },
  sessionHeaderTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  sessionHeaderNotice: {
    color: colors.textSecondary,
    fontSize: typeScale.micro,
    lineHeight: lineHeight.micro,
    marginTop: 2,
  },
  sessionHeaderActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  sessionHeaderIconButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 38,
    justifyContent: 'center',
    position: 'relative',
    width: 38,
  },
  sessionHeaderIconButtonActive: {
    backgroundColor: colors.surfaceChip,
  },
  sessionHeaderIconPressed: {
    backgroundColor: colors.surfaceChip,
  },
  sessionHeaderIconDot: {
    backgroundColor: colors.statusAccent,
    borderRadius: radius.pill,
    height: 6,
    position: 'absolute',
    right: 6,
    top: 6,
    width: 6,
  },
  // 队列 / 搜索共用的 ad-hoc sheet 面板样式(仅视觉暗示的把手走 SheetSurface 的 SheetGrabber)。
  // ad-hoc 面板的 paddingTop 由把手容器自带(SheetSurface 里由 dragZone 提供)。
  adhocSheetGrabber: {
    paddingTop: spacing.sm,
  },
  adhocSheet: {
    backgroundColor: 'transparent',
    borderTopColor: colors.border,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  adhocSheetHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  adhocSheetHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  adhocSheetTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',

  },
  searchPanel: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  searchInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    minHeight: 42,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  searchToolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  searchCounter: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  searchButtons: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  searchNavButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  searchPreview: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  searchLoadEarlierButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  searchLoadEarlierText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  collaborationTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  collaborationText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  sessionSyncPlaceholder: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  sessionSyncRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  sessionSyncTitle: {
    alignSelf: 'center',
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.regular,
  },
  sessionSyncButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    height: 30,
    width: 30,
  },
  historyToggle: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'center',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  historyToggleTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  pendingInteractionSurface: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    maxHeight: '62%',
  },
  pendingInteractionFullContent: {
    flexGrow: 1,
    minHeight: 0,
  },
  readOnlyComposer: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  composer: {
    backgroundColor: 'transparent',
    gap: spacing.xs,
    paddingBottom: spacing.xs,
    paddingTop: spacing.sm,
  },
  composerScroll: {
    flexShrink: 1,
    maxHeight: '100%',
  },
  composerScrollContent: {
    gap: spacing.sm,
  },
  composerSurface: {
    gap: 6,
  },
  composerSurfaceCompact: {
    gap: 0,
  },
  composerActivityFrame: {
    alignSelf: 'stretch',
    marginTop: spacing.lg,
  },
  composerActivityStatus: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 25,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  composerActivityPrimary: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    marginRight: spacing.sm,
    minWidth: 0,
  },
  composerActivityStatusText: {
    color: colors.statusAccent,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  composerActivityProgressText: {
    flexShrink: 0,
  },
  composerActivityMeta: {
    alignItems: 'center',
    flexShrink: 0,
    flexDirection: 'row',
    gap: 4,
    minWidth: 0,
  },
  composerActivityMetaText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  // 不设 maxWidth 硬上限:模型名尽量显示全,只在工具排空间不足时才收缩截断
  // (flexShrink + 文本 numberOfLines,剩余空间归 toolbarSpacer)。
  composerRuntimePill: {
    alignItems: 'center',
    backgroundColor: colors.sheetActionSurface,
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xs,
    minHeight: 34,
    minWidth: 0,
    paddingHorizontal: spacing.md,
  },
  composerRuntimePillText: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.semibold,
    minWidth: 0,
  },
  composerRuntimePillTextRisky: {
    color: colors.statusAccent,
  },
  attachmentErrorText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.xs,
  },
  voiceStatusRow: {
    alignItems: 'center',
    flexShrink: 0,
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
  voiceCancelButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  composerInlineToolButton: {
    alignItems: 'center',
    backgroundColor: colors.sheetActionSurface,
    borderColor: colors.sheetActionBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    justifyContent: 'center',
    height: 34,
    width: 34,
  },
  composerToolButtonActive: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.borderStrong,
  },
  composerToolButtonPrimary: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.borderStrong,
  },
  voiceDraftOverlay: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  // 草稿滚动层填满外层触摸区(外层负责「点输入区停听写」,自身 pointerEvents 关闭)。
  voiceDraftScroll: {
    flex: 1,
  },
  // 内边距与真实输入框同源:差一点就会让听写文字与非听写文字左右错位、换行位置不同。
  voiceDraftOverlayContent: {
    paddingBottom: COMPOSER_TEXT_PADDING_BOTTOM,
    paddingHorizontal: COMPOSER_TEXT_HORIZONTAL_PADDING,
    paddingTop: COMPOSER_TEXT_PADDING_TOP,
  },
  voiceDraftMeasuredBlock: {
    minHeight: COMPOSER_INPUT_LINE_HEIGHT,
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
    minHeight: COMPOSER_INPUT_LINE_HEIGHT,
  },
  // 语音态占位文案渲染的就是普通态 TextInput 的 placeholder,颜色必须同源
  // (placeholderTextColor 也是 textTertiary),否则一进语音态这行字会变色。
  voiceDraftListeningText: {
    color: colors.textTertiary,
    ...MOBILE_COMPOSER_DRAFT_TEXT_STYLE,
  },
  palettePanel: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    maxHeight: 260,
    padding: spacing.sm,
  },
  paletteRow: {
    alignItems: 'center',
    borderRadius: radius.container,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 42,
    paddingHorizontal: spacing.md,
  },
  paletteRowPressed: { backgroundColor: colors.surfaceChip },
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
  inputVoiceHidden: {
    color: 'transparent',
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderColor: colors.cta,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 34,
    width: 34,
    justifyContent: 'center',
  },
  sendButtonInactive: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
  },
  sendButtonVoiceTarget: {
    borderColor: colors.borderStrong,
  },
  sendButtonPressed: { opacity: 0.86 },
  sendButtonDisabled: { opacity: 0.45 },
  routeButtonPressed: { opacity: 0.72 },
});
