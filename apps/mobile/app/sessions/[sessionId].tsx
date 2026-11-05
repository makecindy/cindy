Warning: truncated output (original token count: 183670)
Total output lines: 14213

import { ComposerAttachmentPreview } from "@/session/ComposerAttachmentPreview";
import { snapshotRichAnswerValues } from '@/session/RichAnswer';
import { PluginUiEnablePrompt } from '@/plugins/PluginUiEnablePrompt';
import { deviceDisplayName } from '@/device-link/deviceName';
import { SessionQuickSendProvider } from '@/session/SessionQuickSendContext';
import { incomingShareSlotOrder } from '@/session/mobileLocalAttachmentUpload';
import { useIncomingShareComposer } from '@/session/useIncomingShareComposer';
import { incomingShareDestination } from '@/session/incomingShare';
import { CompanionFollowUpInvitation } from '@/session/CompanionFollowUpInvitation';
import { ModelSpeedIcon } from '@/session/ModelSpeedIcon';
import { useSessionHistorySearch } from '@/session/useSessionHistorySearch';
import { useContentRecoveryDiagnostics } from '@/debug/useContentRecoveryDiagnostics';
import { modelNeedsReselection } from '@/session/modelReselection';
import { getCachedDeviceProviders } from '@/device-link/deviceProvidersCache';
import { MountOnFirstOpen } from '@/session/MountOnFirstOpen';
import { RunningTokenRatePopover } from '@/session/RunningTokenRatePopover';
import { companionProcessItems } from '@/session/companionConversationPresentation';
import { useRunningTokenRateHistory } from '@/session/useRunningTokenRateHistory';
import { HomeHeaderGlassButton } from '@/session/HomeHeaderGlassButton';
import { HomeNewTaskButton } from '@/session/HomeNewTaskButton';
import { RecentMessageHistories, MessageHistoryOverlay } from '@/session/RecentMessageHistories';
import { rememberRecentTask } from '@/session/recentTasks';
import { SystemNavigationBack, useSystemNavigationBack } from '@/platform/chrome/SystemNavigationBack';
import { keyboardControlRegion, sharedStatusRowDrawerTop, type LayoutRect } from '@/platform/windowGeometry';
import { useAdaptiveWindow, PaneViewportProvider } from '@/platform/AdaptiveWindowContext';
import { useSessionHeaderHeight } from '@/session/useSessionHeaderHeight';
import { useDoubleTap } from '@/session/useDoubleTap';
import { useSessionPaneLayout } from '@/session/ResidentHomeList';
import { ComposerExpandButton } from '@/session/ComposerExpandButton';
import { nativeComposerAvailable } from '@/session/ComposerNativeInput';
import { getActiveMobileSessionRealm } from '@/config/env';
import { FailedScheduleNotice } from '@/session/FailedScheduleNotice';
import { shouldShowFailedScheduleNotice, type FailedScheduleRunSnapshot } from '@cindy/maker-shared/schedule-model';
import type { TokenSpeedSnapshot } from '@cindy/maker-shared/usage-format';
import { CompanionThreadRoot, useCompanionThreads } from '@/session/CompanionThreads';
import { CompanionHeader } from '@/session/CompanionHeader';
import { CloudHomeUnreachableNotice, isMessageWaitingForCloudHome, useSustained } from '@/session/CloudHomeUnreachableNotice';
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { CHAT_HEADER_BLUR_FADE_INSIDE, ChatIdentityHeader } from '@/session/ChatIdentityHeader';
import { useHiddenHistoryChase } from '@/session/hiddenHistoryChase';
import { collectCompanionPluginInvocations, companionPluginSourceMessages } from '@/session/pluginInvocations';
import { COMPANION_STATUS_AVATAR_SIZE, CompanionWorkingStatus, useCompanionDisplayResource, useCompanionWorkingLabel } from '@/session/CompanionWorkingStatus';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useRemoteResourceSession } from '@/session/useRemoteResourceSession';
import { SharedTaskEndedState } from '@/session/SharedTaskEndedState';
import { useSessionResourceCards } from '@/session/useSessionResourceCards';
import { SessionResourceCards } from '@/session/SessionResourceCards';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { mobileDurableOutbox, durableOutboxDisplayItem, getCurrentMobileOutboxRecords, reconcileMobileOutboxDrafts } from '@/session/mobileDurableOutbox';
import { retainOutboxFile, durableOutboxUploadUri, removeOutboxFiles, outboxAttachmentNeedsLocalBytes } from '@/session/durableOutboxFiles';
import { isDurableOutboxSettled, observeDurableOutboxSending, type DurableOutboxRecord } from '@/session/durableOutbox';
import { isInFlightDeviceLinkError, isSharedTaskPeer, resolveRemoteText } from '@cindy/device-link';
import { takeRefinementContextTail, truncateRefinementReply } from '@cindy/voice-input-core';
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
  Monitor,
  Menu,
  MessagesSquare,
  Mic,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Target,
  UsersRound,
  Zap,
  X,
} from 'lucide-react-native';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { renderConversationShareHtmlToPng } from 'xdt-screenshot-monitor';
import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject, type SetStateAction } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PressableProps,
  type ScrollViewProps,
  type StyleProp,
  type TextInputContentSizeChangeEvent,
  type ViewStyle,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { usePendingQuestionScroll } from '@/session/usePendingQuestionScroll';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { MobileAgentMark } from '@/components/MobileAgentMark';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { SessionHeaderNativeBack, SessionHeaderNativeActions, SessionHeaderNativeTitle, SessionHeaderNativeBlur } from '@/session/SessionHeaderNativeControls';
import { TaskTagDots } from '@/session/TaskTags';
import type { TextInput as NativeTextInput } from 'react-native';
import { ScreenBackButton } from '@/components/MobilePrimitives';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthContext';
import { usePromptRecommendation } from '@/session/usePromptRecommendation';
import { PromptRecommendation } from '@/session/PromptRecommendation';
import { usePromptRecommendationVisibility } from '@/session/usePromptRecommendationVisibility';
import { useGuardedBack } from '@/utils/useGuardedBack';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useStableValue } from '@/utils/useStableValue';
import { sameArrayIdentity } from '@/utils/valueEquality';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { deviceLinkMediaApiBaseUrl } from '@/device-link/selfHostedRelayRouting';
import { ConnectionBanner, useShowConnectionBanner } from '@/components/ConnectionBanner';
import { QuietSyncIndicator } from '@/components/QuietSyncIndicator';
import { hasSessionEntryPreviewMismatch } from '@/session/sessionEntrySyncIndicator';
import { resolveEffectiveConnectionError } from '@/components/connectionBannerVisibility';
import { PaperPlaneIcon } from '@/components/PaperPlaneIcon';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useLocalNetworkStatus } from '@/device-link/localNetworkStatus';
import { subscribeCredentialSwitchOutcome } from '@/session/credentialSwitchOutcome';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { useSharedTaskAccess } from '@/device-link/useSharedTaskAccess';
import { useLeaveSharedTask } from '@/device-link/useLeaveSharedTask';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import {
  connectionRecoverySyncRetryDelayMs,
  connectionIssueHint,
  describeRemoteComposerBlockingError,
  describeRemoteError,
  formatRemoteError,
  humanizeRemoteError,
  isAutoRecoveringRemoteError,
  isPreconditionFailedRemoteError,
  isSessionRunningRemoteError,
} from '@/device-link/remoteStatus';
import { agentAuthGateHint, agentAuthGateVerdict } from '@/session/agentAuthGate';
import { isTransientRemoteError, withTransientRemoteRetry } from '@/device-link/remoteRetry';
import {
  createRemoteSyncReopenCoordinator,
  retryRemoteSyncRead,
  useRemoteSyncCoordinator,
  waitForCachedSubscription,
  type RemoteSyncRun,
} from '@/device-link/remoteSyncTask';
import {
  runConnectionScopedSessionMetadataRead,
  waitForIndependentSnapshotReads,
  runSessionMessagesSnapshotSingleFlight,
  runSessionPendingInteractionsSnapshotSingleFlight,
  runSessionProjectionSnapshotSingleFlight,
} from '@/device-link/sessionSnapshotSingleFlight';
import { syncSessionMessageWindow } from '@/session/sessionMessageWindowSync';
import { isExplicitRemoteNotFoundError } from '@/session/newSessionWorktree';
import { shouldClearOperationErrorAfterSync, type SessionOperationError } from '@/session/sessionSyncErrorRecovery';
import { createTransientTopicSubscriptionCoordinator } from '@/device-link/transientTopicSubscription';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { findRemoteHistoryView, useRemoteHistoryView } from '@/session/remoteHistoryView';
import { HistoryViewHandoff, historyAfter, isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import { SideChatsSheet } from '@/session/SideChatsSheet';
import { useSideChatCount } from '@/session/useSideChatCount';
import { SessionTaskLayout, type SessionTaskChrome } from '@/session/SessionTaskLayout';
import { buildMobileSessionRenderWindow } from '@/session/mobileHistoryRender';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { InteractionPanel, type MobilePlanViewerState } from '@/session/InteractionPanel';
import {
  COMPANION_AVATAR_SIZE,
  MessageRenderer,
  findLastUserMessageClientId,
  type CompanionQuoteOptions,
  type MobileMessageActionBusyKind,
  type MobileMessageDraft,
  type MobileMessageEditDraft,
} from '@/session/MessageRenderer';
import {
  buildMessageEditAttachments,
  commitMessageEditRewind,
  messageEditErrorText,
  mergeMessageEditDraft,
  messageEditRollbackHint,
  type MessageEditRollbackHint,
} from '@/session/messageEdit';
import { BotGroupQuote } from '@/session/BotGroupQuote';
import {
  clearSentCompanionReplyQuote,
  companionReplyQuoteDisplay,
  getPendingCompanionReplyQuote,
  setPendingCompanionReplyQuote,
  usePendingCompanionReplyQuote,
} from '@/session/companionReplyQuote';
import { useCompanionReplyTargetPreference } from '@/session/companionReplyTargetPreference';
import {
  bundledAssetToDataUri,
  cleanupConversationSharePngTemps,
  deleteConversationSharePngTemp,
  writeConversationSharePngTemp,
} from '@/session/ConversationShareWebView';
import {
  ConversationShareSvg,
  type ConversationShareSvgHandle,
} from '@/session/ConversationShareSvg';
import {
  buildConversationShareHtml,
  buildConversationShareContentWidth,
  type ConversationShareMessage,
  type ConversationShareWebViewColors,
} from '@/session/conversationShareWebViewHtml';
import {
  collectConversationShareBlockIds,
  collectConversationShareMessages,
} from '@/session/conversationShareMessages';
import { useConversationShareImages } from '@/session/useConversationShareImages';
import {
  isFoldableBlockExpanded,
  useFoldableExpandedBlocksSnapshot,
} from '@/session/expandedBlockMemory';
import { ShareSelectAllButton } from '@/session/ShareSelectAllButton';
import { ShareSelectionBar } from '@/session/ShareSelectionBar';
import {
  shareSelectionStore,
  useShareSelectionActive,
  useShareSelectionCount,
  useShareSelectionRevision,
} from '@/session/shareSelectionStore';
import { ComposerRichInput, type ComposerRichInputHandle } from '@/session/ComposerRichInput';
import { createComposerDraftSource, useComposerVoiceDraftWriter, type ComposerDraftSource } from '@/session/composerDraftSource';
import { InlineQueueSection } from '@/session/InlineQueueSection';
import { inputProjectionErrorI18nKey } from '@/session/inputProjectionError';
import { remoteActionErrorI18nKey } from '@/session/agentErrorI18n';
import { RewindPreviewPanel } from '@/session/RewindPreviewPanel';
import { BlurBackdrop, FLOATING_CHROME_BLUR_INTENSITY } from '@/session/BlurBackdrop';
import { SheetModal } from '@/session/SheetModal';
import { SheetGrabber, SheetSurface } from '@/session/SheetSurface';
import { NativePermissionSheet } from '@/session/NativePermissionSheet';
import { permissionAccentColor, permissionPresentation } from '@/session/permissionPresentation';
import {
  SessionMenuSheet,
  type SessionExtraDirBrowserState,
} from '@/session/SessionMenuSheet';
import { sessionMenuAllowsRename, type SessionMenuView } from '@/session/sessionMenu';
import { SessionSearchNative } from '@/session/SessionSearchNative';
import { useHostManagedSession } from '@/session/hostManagedSession';
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
  reconcileRuntimeDraftWithCapabilities,
  type MobileAgentCapabilities,
  type MobileModelOption,
  type MobileSessionRuntimeOptions,
} from '@/session/agentCapabilities';
import { useDeviceProviders } from '@/device-link/useDeviceProviders';
import { useDeviceApiKeyStatus, useDeviceModelPricing } from '@/device-link/useDeviceModelMeta';
import type { DeviceApiKeyStatus } from '@/device-link/deviceModelMetaCache';
import type { MobileModelMemoryAccessors } from '@/session/draftModelMemory';
import type { MobileModelConfiguration } from '@/session/unifiedMobileModels';
import { resolveAgentCapability } from '@cindy/model-providers';
import { ModelPickerSheet } from '@/session/ModelPickerSheet';
import { MobileModelIconMark } from '@/session/MobileProviderMark';
import { getModel, type ProviderView } from '@cindy/model-providers/registry';
import { shouldBlockLegacyRemoteModelWindowSwitch } from '@cindy/maker-shared/agent-capabilities';
import { clearSessionMirror, makeSessionMirrorAccessors } from '@/session/sessionModelMirror';
import { effortLabelFromRuntime, rowFastEditable } from '@/session/modelPickerRows';
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
import { ComposerPluginPalette, ContextSheetPlugins } from '@/session/ContextSheetPlugins';
import { appendComposerPluginTrigger, detectComposerPluginTrigger, placeComposerPlugin } from '@/session/composerPlugins';
import type { ComposerPlugin } from '@/session/remoteComposerPlugins';
import { OrcaTeamPanelView, OrcaWorkerFormView } from '@/session/ContextSheetCollabView';
import { OrcaWorkerDirectoryPicker } from '@/session/OrcaWorkerDirectoryPicker';
import { useSessionOrcaCollab } from '@/session/useSessionOrcaCollab';
import { orcaWorkerProvidersForLead, subscribeOrcaStartFailure, takeOrcaStartFailure } from '@/session/orcaTeam';
import { RecentPhotosStrip } from '@/session/ContextSheetMediaViews';
import { ContextSheetGoalView, goalStatusLabel } from '@/session/ContextSheetGoalView';
import { parseGoalLimitsRouteParam } from '@/session/goalLimitsRouteParam';
import { ComposerAttachmentCollapsedBadge, ComposerAttachmentTray } from '@/session/ComposerAttachmentTray';
import { useComposerPendingImagePreview } from '@/session/useComposerPendingImagePreview';
import { useSlowSendVisible, type SlowSendPhase } from '@/session/SlowSendNotice';
import { ComposerActivityPill, composerActivityPillOverlayColor, makeComposerActivityPillStyles } from '@/session/ComposerActivityPill';
import { PlanModeChip } from '@/session/PlanModeChip';
import { ImageLightbox } from '@/session/ImageLightbox';
import { pickWriteFields, retryPatchWhileLatest, writeGuardFields } from '@/session/swipeRowRegistry';
import { unarchiveSessionAfterSend } from '@/session/unarchiveAfterSend';
import {
  dismissNewSessionCreation,
  getNewSessionCreationTask,
  shouldBlockSessionSync,
  stashNewSessionDraftForEdit,
  useNewSessionCreationTask,
  withNewSessionCreationRemoval,
  appendNewSessionEditComposer,
} from '@/session/newSessionCreation';
import {
  useComposerImageAnnotations,
  type UseComposerImageAnnotationsResult,
} from '@/session/useComposerImageAnnotations';
import { buildMediaPayload } from '@/session/messagePayload';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import { canBrowsePhotoLibraryDirectly } from '@/session/photoLibraryPolicy';
import {
  prefetchContextSheetMediaAssets,
  resolveContextSheetMediaAssetForUpload,
  type ContextSheetMediaAsset,
} from '@/session/useContextSheetMediaAssets';
import { sessionCollaborationLabel } from '@/session/collaboration';
import {
  agentKindForSession,
  detectComposerTrigger,
  filterAtResources,
  filterSlashCommands,
  mergeSlashCommands,
} from '@/session/composerPalette';
import { buildComposerTouchLayout } from '@/session/composerTouchLayout';
import { useComposerPressFallback } from '@/session/composerPressFallback';
import { useComposerDock } from '@/session/composerMorph';
import { DockKeyboardLift, DockKeyboardViewportSpacer } from '@/session/ComposerDockKeyboardFollow';
import { useComposerPillOpen } from '@/session/useComposerPillOpen';
import { composerBottomContentPadding, composerGeometry } from '@/session/composerGeometry';
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
  reconcileComposerVoiceDraft,
  replaceComposerTextRange,
  serializeComposerDocument,
  sessionLinkComposerNode,
  todoReferenceComposerNode,
  slashCommandTextNode,
  textComposerDocument,
  type ComposerDocument,
  type ComposerVoiceDraftUpdate,
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
import {
  confirmAgentLocationForPick,
  confirmMobileSessionAgentSwitch,
} from '@/session/sessionAgentSwitchConfirmation';
import {
  effectiveAgentDeviceId,
  intentChangesAgentLocation,
  mobileAgentLabel,
  normalizeSessionAgentSwitchIntent,
  sessionAgentKind as resolveSessionAgentKind,
  sessionAgentRunsOnOtherComputer,
  supportsMobileSessionAgentSwitch,
  type MobileSessionAgentKind,
} from '@/session/sessionAgentSwitch';
import { formatProviderAccountLabel, resolveSessionUsageAccount } from '@/session/sessionUsageAccount';
import { useRemoteAgentCatalogs } from '@/session/useRemoteAgentCatalogs';
import { isProviderShareAgentDeviceId } from '@/session/providerShareAgentDevice';
import { useSessionProviderGroup } from '@/session/useSessionProviderGroup';
import {
  askMobileSessionRebalance,
  offerMobileSessionRebalance,
  useMobileSessionRebalancePrefetch,
} from '@/session/sessionRebalancePrompt';
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
  queuedMessageReplyQuote,
  resolveQueueEditTextSubmission,
  stopOptionsForProjection,
  type QueueEditTextState,
} from '@/session/inputProjection';
import {
  mergePendingSendItems,
  buildPendingSendItems,
  pendingSendItemKey,
  type MobilePendingSendActions,
  type MobilePendingSendWaitingFor,
} from '@/session/pendingSendItems';
import { noteLocalSend } from '@/session/localSendMotion';
import { isSourceDeviceRemoved } from '@/session/messageSourceLabels';
import {
  appendOptimisticUserMessage,
  confirmedHistoryUserClientIds,
  repliedHistoryUserClientIds,
  projectOptimisticUserMessages,
  reconcileOptimisticUserMessages,
  type OptimisticUserMessage,
} from '@/session/optimisticUserMessages';
import { usePendingOutboxActions, usePendingSendActions } from '@/session/usePendingSendActions';
import {
  acquireQueueEditLock,
  commitQueueEdit,
  releaseQueueEditLockAfter,
  type QueueEditLockOwner,
} from '@/session/queueEditLifecycle';
import { findErrorTailClientId, isContinuationQueueItem, resolveSessionTailBanner } from '@/session/sessionTailBannerModel';
import { SessionTailBanner } from '@/session/SessionTailBanner';
import { buildErrorDiagnosisPrompt, type ErrorDiagnosisSource } from '@/session/errorDiagnosisPrompt';
import { useHistoryRecoveryNavigation } from '@/session/useHistoryRecoveryNavigation';
import { useSessionActivityInvalidation } from '@/session/useSessionActivityInvalidation';
import { useSessionMessageHistoryRead } from '@/session/useSessionMessageHistoryRead';
import { canOfferCodexHistoryRecovery } from '@cindy/maker-shared/error-redaction';
import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
  canContinueFailedTurn,
} from '@cindy/maker-shared/synthetic-trigger';
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
  MOBILE_COMPOSER_TOOL_GAP,
  MobileComposerInputRow,
  VoiceMicWaveCaret,
  resolveMobileComposerVoiceButtonPlacement,
} from '@/session/MobileComposerInputRow';
import { ComposerFrame, nativeComposerFrameAvailable } from '@/session/ComposerFrame';
import { VoiceRecordingPillContent, useMobileVoiceRecordingTimer } from '@/session/VoiceRecordingPill';
import { VoicePillWidthFrame } from '@/session/voicePillWidthMotion';
import { useMobileVoiceProcessingIndicator } from '@/session/useMobileVoiceProcessingIndicator';
import { useComposerCardTransition } from '@/session/useComposerCardTransition';
import { ComposerKeyboardAvoidingView } from '@/session/ComposerKeyboardAvoidingView';
import { useComposerResize } from '@/session/useComposerResize';
import { ComposerPullThroughScrollView, useComposerPullThroughBridge, type ComposerPullThroughBridge } from '@/session/composerPullThrough';
import { useMobileKeyboardState } from '@/session/useMobileKeyboardState';
import { buildSessionComposerLayout } from '@/session/sessionComposerLayout';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';
import { buildMobileImageAttachmentCandidate } from '@/session/mobileImageAttachment';
import { useMobileLocalAttachments } from '@/session/useMobileLocalAttachments';
import {
  getSentMessageImagePreview,
  pruneSentMessageImagePreviews,
  rememberOutboxImagePreviews,
  rememberSentMessageImagePreviews,
  type SentMessageImagePreviews,
} from '@/session/sentMessageImagePreviews';
import {
  buildOutboxItem,
  createOutboxClientId,
  hasActiveOutboxHandoff,
  outboxDisplayItem,
  outboxItemAttachments,
  recoverOutboxItemsToComposerDraft,
  shouldHoldOutboxDispatchForConnection,
  type MobileOutboxConnectionState,
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
import { useSpeakerFilterNotice } from '@/session/useSpeakerFilterNotice';
import {
  createMobileVoiceDictionaryLearningTracker,
  type MobileVoiceDictionaryLearningTracker,
} from '@/session/mobileVoiceDictionaryLearning';
import {
  bridgeLatestMessagePage,
  hasOlderMessagesAfterReopen,
  hasOlderMessagesByServerCount,
  listMessagesWithPayloadRetry,
  oldestMessageCursor,
  projectLoadedMessageWindowIncrementally,
  type LoadedMessageWindowProjection,
  shouldKeepOlderMessagesAffordance,
} from '@/session/messagePaging';
import {
  fetchMobileToolInputDetail,
  type MobileToolInputDetail,
  type MobileToolInputProjection,
} from '@/session/messageToolPayloadProjection';
import {
  HISTORY_BACKFILL_MAX_GAPS_PER_VISIT,
  HISTORY_GAP_MAX_CONSIDERED_PER_VISIT,
  HISTORY_GAP_PROBE_LIMIT,
  backfillHistoryWindowGap,
  findHistoryWindowGap,
  historyWindowGapKey,
} from '@/session/historyWindowGap';
import type { MobileMessageRenderItem } from '@/session/messageRenderModel';
import {
  commitMobileStreamingPrefixItems,
  type MobileStreamingRenderPrefixCache,
} from '@/session/messageRenderStreamingCache';
import {
  resolveSessionMessageEmptyState,
  shouldShowCachedHistoryNotice,
} from '@/session/sessionEmptyState';
import { deferScheduleIndexHydration } from '@/session/scheduleIndexDefer';
import { sessionMayHaveScheduleRuns } from '@/session/scheduleIndex';
import { confirmArchiveWithSchedules, loadActiveBoundScheduleNames } from '@/session/archiveScheduleConfirm';
import { useSessionListActions } from '@/session/useSessionListActions';
import { markSessionScheduleRunsRead, unreadRunIdFromProjection } from '@/session/scheduleRunRead';
import { useRemoteScheduleEventSnapshot } from '@/scheduler/remoteScheduleEvents';
import { buildSessionNativeShellLayout } from '@/session/mobileNativeShellLayout';
import { buildWideSessionNavLayout } from '@/session/wideSessionNav';
import { SessionListDrawer } from '@/session/SessionListDrawer';
import {
  switchDrawerSessionInPlace,
  type SessionRouteParamsNavigation,
} from '@/session/sessionDrawerNavigation';
import {
  navigateToCollabSession,
  type CollabSessionStateLike,
} from '@/session/collabSessionNavigation';
import type { RemoteSessionListItem } from '@/session/sessionList';
import {
  findMobileMessageSearchHits,
  nextMessageSearchIndex,
  normalizeMessageSearchIndex,
} from '@/session/messageSearch';
import {
  buildSearchLoadEarlierAction,
  findMobileRenderItemKeyByClientId,
  MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
} from '@/session/messageScroll';
import {
  buildMobileSessionDeepLink,
  buildMobileSessionMessageDeepLink,
  parseSessionDeepLinkUrl,
  resolveSessionLinkDeviceId,
} from '@/session/sessionLinks';
import {
  extractMobileSessionReferences,
  MobileSessionReferenceError,
  prepareMobileQueuedSessionReferences,
  prepareMobileQueuedSessionReferencesForSteer,
} from '@/session/sessionReferences';
import { compactSessionMessageLabel, mobileSessionMessageDisplayText } from '@/session/sessionMessageText';
import { copyMessageText } from '@/session/messageActions';
import {
  remoteSessionStore,
  resolveSessionWriteDevices,
  sessionMetaWriteGuard,
  sessionMetaWriteQueue,
  sessionPendingWrites,
  type RemoteSessionRunStatus,
  useRemoteSessionDetail,
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
import { useFailedCreationReturnToEdit } from '@/session/useFailedCreationReturnToEdit';
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
import { showActionMenu, usesSystemActionMenu } from '@/platform/chrome';
import { ChatFileChipMenuSheet } from '@/session/ChatFileChipMenuSheet';
import { SessionTransientNotice, type SessionTransientNoticeValue } from '@/session/SessionTransientNotice';
import { formatLocalizedSeconds } from '@/session/sessionDurationFormat';
import {
  chatFileChipMenuRows,
  chatFileChipMenuTitle,
  type ChatFileChipMenuActionKey,
} from '@/session/chatFileChipMenuModel';
import { mergePathIntoComposerDraft, shareMimeForFileName } from '@/session/fileBrowserActions';
import { exportRemoteFileToUrl } from '@/session/fileBrowserExport';
import { normalizeRemoteOpDirEntries, parentRelPath } from '@/session/fileBrowserGrid';
import * as Clipboard from 'expo-clipboard';
import { createRemoteMediaDiskCache, imageMimeFromUrl, type RemoteMediaDiskCache } from '@/session/remoteMediaDiskCache';
import { createExpoRemoteMediaDiskCacheIO, downloadRemoteMediaShareTemp } from '@/session/remoteMediaDiskCacheExpo';
import { Paths } from 'expo-file-system';
import { PEER_FILE_DISK_RESERVE_BYTES } from '@/device-link/peerFileRegistry';
import {
  buildRewindPreviewState,
  isCommitReadyRewindState,
  rewindCommitBindOpts,
  type RewindPreviewState,
} from '@/session/rewindPreview';
import { projectMobileSessionActions } from '@/session/sessionActionProjection';
import {
  buildContextUsageCreateOpts,
  canUseLocalCodexRateLimitControl,
  shouldFallbackToLegacyCodexUsage,
} from '@/session/sessionControls';
import { buildSessionOperationLayout, composerDisabledReasonI18nKey } from '@/session/sessionOperationLayout';
import { computeVanishedQueueItems, mergeSettlingItems, settleEnqueueResult } from '@/session/queueSettling';
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
  executeMobileGoalCommand,
  mergeMobileGoalCommand,
  mergeMobileSideChatCommand,
  buildMobileSideChatDraft,
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
import { resolveMobileUserBubbleColors, useUserBubbleAppearance } from '@/theme/userBubblePreference';
import { isOwnUserBubble } from '@/session/userBubbleOwnership';
import { fontWeight, iconSize, iconStroke, lineHeight, navigationChrome, radius, spacing, typeScale } from '@/theme/tokens';

const SESSION_ACTION_TEST_IDS = {
  files: 'session.filesButton',
  queue: 'session.queueButton',
  search: 'session.searchToggleButton',
  settings: 'session.controlsToggle',
  usage: 'session.usageButton',
} satisfies Record<SessionActionStripActionId, string>;
const COMPOSER_CONTROL_HIT_SLOP = { bottom: 8, left: 8, right: 8, top: 8 };
/**
 * When the companion uses an in-content header row, hide the native bar the
 * task header may have configured while the entry was still resolving, so its title and sync
 * spinner never sit on top of the companion identity. Stable object: expo-router applies screen
 * options in a layout effect.
 */
const COMPANION_NATIVE_HEADER_OPTIONS = { headerShown: false, headerTitle: '' } as const;
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
// 重开且检测到有新内容时,只拉最新小窗对账(比首开整窗 80 便宜很多);payload 过大再逐档退。
const REOPEN_MESSAGE_WINDOW_LIMITS = [20, 10, 5, 1] as const;
// session-tail-banner「重试」短窗口隐藏的超时兜底(接管信号全部丢失时恢复错误入口);
// 覆盖 settling 窗口上限(10s)之后仍无任何在途证据的场景。
const TAIL_RETRY_HIDE_TIMEOUT_MS = 15_000;
const nativeConversationShareAvailable = Platform.OS === 'ios';

// 原生 WKWebView 只能稳定读取 data URI；SVG 兜底直接使用同一组 bundle asset。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareCharacterAsset = require('../../assets/share/cindy-share-character.jpg');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareLogoLightAsset = require('../../assets/login/login-wordmark.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shareLogoDarkAsset = require('../../assets/login/login-wordmark-dark.png');

/** 编辑最后一条用户消息:composer 暂时承载这条消息,stash 保存用户原本的草稿与附件。 */
interface MessageEditingState {
  clientId: string;
  stashedDocument: ComposerDocument;
  stashedAttachments: RemoteSerializedAttachment[];
  /** null = 预览尚未返回或失败(不提示、不阻塞发送)。 */
  rollbackHint: MessageEditRollbackHint;
}

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
  const effortLabel = effortLabelFromRuntime(runtime, session.effort);
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

/** 会话已读回执的驻留门槛:聚焦本会话且消息已渲染后停满这段时间才算「真实看到」。 */
const SESSION_READ_ACK_DWELL_MS = 200;

/** 旧被控端没有 update-content 通道时的降级判定(与 mobileVoiceInput 同款字符串匹配)。 */
function isChannelNotAllowedError(err: unknown): boolean {
  const formatted = formatRemoteError(err);
  return (
    formatted.includes('CHANNEL_NOT_ALLOWED') || formatted.includes('DEVICE_LINK_CHANNEL_NOT_ALLOWED')
  );
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

/** 引用 capability 查询是只读前置步骤，离线后可安全等待连接恢复再做。 */
function isAutoRecoveringSessionReferencePreparationError(err: unknown): boolean {
  return (
    isAutoRecoveringRemoteError(err)
    || (err instanceof MobileSessionReferenceError && err.code === 'SESSION_REFERENCE_OFFLINE')
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
/**
 * 打字预热提醒的最短间隔；被控端每次提醒都会顺延预热进程的空闲回收。换了模型、深度、
 * 权限、引擎或目录时被控端可能已关掉旧进程，下一次输入立即重新提醒。
 */
const MOBILE_AGENT_PREWARM_INTERVAL_MS = 30_000;
/** 另一台电脑的目录还没读到时的空供应商列表(稳定引用,不触发下游 memo 重算)。 */
const EMPTY_PROVIDER_VIEWS: readonly ProviderView[] = [];
const EMPTY_PLUGIN_SOURCE_MESSAGES: readonly RemoteMessage[] = [];

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
  return (
    idsA.length === idsB.length && idsA.every((id, index) => id === idsB[index])
  );
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
  return (
    <SessionTaskLayout>{(chrome) => <SessionScreenContent {...chrome} />}</SessionTaskLayout>
  );
}

function SessionScreenContent({ beforeSessionSwitchRef, newSessionActionRef }: SessionTaskChrome) {
  const styles = useThemedStyles(makeStyles);
  const composerPullThrough = useComposerPullThroughBridge();
  const renderMessageScroll = useCallback(
    (props: ScrollViewProps) => (
      <ComposerPullThroughScrollView {...props} bridge={composerPullThrough} />
    ),
    [composerPullThrough],
  );
  const { colors, mode } = useTheme();
  const { t, i18n: i18nInstance } = useTranslation();
  const params = useLocalSearchParams<{
    sessionId: string;
    notificationResponse?: string;
    resourceKind?: string;
    resourceCollectionId?: string;
    resourceId?: string;
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
    openSearch?: string;
    openSearchRequest?: string;
    visualOpenSearch?: string;
    visualSearchQuery?: string;
    /** Open the teammate's settings on this page (群设置 → 伙伴在本群 → 工具与授权). */
    companionSettings?: string;
  }>();
  const sessionId = readRouteParam(params.sessionId) ?? '';
  const notificationResponse = readRouteParam(params.notificationResponse);
  const syncedNotificationResponseRef = useRef<string | null>(null);
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
  const deviceName = deviceDisplayName(deviceId, readRouteParam(params.deviceName));
  useFocusEffect(useCallback(() => {
    rememberRecentTask({ pathname: '/sessions/[sessionId]', params: { deviceId, deviceName, sessionId } });
  }, [deviceId, deviceName, sessionId]));
  const routeDraft = readRouteParam(params.draft);
  const routeFocusClientId = readRouteParam(params.focusClientId);
  const routeFocusComposerRequestKey = readRouteParam(params.focusComposerRequestKey);
  const routeFocusRequestKey = readRouteParam(params.focusRequestKey);
  const visualFocusComposer = MOBILE_VISUAL_MOCK_ENABLED && readRouteParam(params.visualFocusComposer) === '1';
  const visualOpenSearch = MOBILE_VISUAL_MOCK_ENABLED && readRouteParam(params.visualOpenSearch) === '1';
  const visualSearchQuery = MOBILE_VISUAL_MOCK_ENABLED ? readRouteParam(params.visualSearchQuery) : null;
  const navigation = useNavigation<SessionRouteParamsNavigation & {
    isFocused(): boolean;
    // useNavigation 返回的 navigation 对象没有 getRootState(那是容器 ref 的方法),
    // 这里只需要本 route 所属 navigator 的 state —— session 路由直属 root stack。
    getState(): CollabSessionStateLike | undefined;
  }>();
  useEffect(() => subscribeCredentialSwitchOutcome((outcome) => {
    if (outcome.deviceId !== deviceId || outcome.sessionId !== sessionId || !navigation.isFocused()) return;
    Alert.alert(t(outcome.kind === 'applied' ? 'models.switchOutcome.applied' : 'models.switchOutcome.failed'));
  }), [deviceId, navigation, sessionId, t]);
  const router = useRouter();
  // 完整消息读取权限按「会话 + 单调代际」登记。focus 与 AppState 正交：后台时
  // 导航仍可能保持 focused，必须立即撤权；重新聚焦/回前台会生成新代际，使旧
  // listMessages 响应永久失效。
  const messageAuthorityRef = useRef<ReturnType<
    typeof remoteSessionStore.enterSessionMessageDetail
  > | null>(null);
  const messageScreenFocusedRef = useRef(false);
  const messageAppActiveRef = useRef(AppState.currentState === 'active');
  // Stable: MessageRenderer re-runs its companion read acknowledgement when this changes.
  const isReadingPositionActive = useCallback(
    () => messageScreenFocusedRef.current && messageAppActiveRef.current, []);
  const handledMessageReloadRevisionRef = useRef(0);
  const [messageReloadRevision, setMessageReloadRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      messageScreenFocusedRef.current = true;
      if (messageAppActiveRef.current) {
        messageAuthorityRef.current = remoteSessionStore.enterSessionMessageDetail(sessionId);
        // authority 是消息同步的前置条件。首次 focus 也必须在 enter 成功后触发 load；
        // 否则导航 focus 晚于 mount effect 时，首轮 sync 会因无 authority 被丢弃且不再补发。
        setMessageReloadRevision((value) => value + 1);
      }
      return () => {
        messageScreenFocusedRef.current = false;
        findRemoteHistoryView(deviceId, sessionId)?.setActive(false);
        const authority = messageAuthorityRef.current;
        messageAuthorityRef.current = null;
        if (authority) {
          remoteSessionStore.leaveSessionMessageDetail(sessionId, 'detail-blur', authority);
        }
      };
    }, [deviceId, notificationResponse, sessionId]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const active = nextState === 'active';
      messageAppActiveRef.current = active;
      if (!active) {
        findRemoteHistoryView(deviceId, sessionId)?.setActive(false);
        const authority = messageAuthorityRef.current;
        messageAuthorityRef.current = null;
        if (authority) {
          remoteSessionStore.leaveSessionMessageDetail(sessionId, 'app-background', authority);
        }
        return;
      }
      if (!messageScreenFocusedRef.current || messageAuthorityRef.current) return;
      messageAuthorityRef.current = remoteSessionStore.enterSessionMessageDetail(sessionId);
      findRemoteHistoryView(deviceId, sessionId)?.setActive(true);
      setMessageReloadRevision((value) => value + 1);
    });
    return () => subscription.remove();
  }, [deviceId, sessionId]);
  const auth = useAuth();
  const outboxOwner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner, getMobileAuthOwner);
  const windowDimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardState = useMobileKeyboardState();
  const {
    connectionEpoch,
    connectionIssue,
    getPresenceAvailability,
    getSubscriptionIdentity,
    invoke,
    openLink,
    reopenLink,
    status,
    subscribe,
    unsubscribe,
  } = useDeviceLink(deviceId);
  const revokedDevices = useRevokedDevices();
  const unresponsiveDevices = useUnresponsiveDevices();
  const maker = useMobileMakerTransport(deviceId);
  // A failed roster read leaves presence unknown after reconnect. Allow the
  // existing link/subscription path to establish reachability instead of
  // blocking both history and sync until a presence change happens to arrive.
  const remoteHistoryAvailable = status === 'online' && getPresenceAvailability(deviceId) !== false;
  // Unknown presence while connecting is loading, not evidence of a lost computer.
  const showCachedHistoryNotice = shouldShowCachedHistoryNotice(status, getPresenceAvailability(deviceId));
  const currentSession = useRemoteSessionDetail(deviceId, sessionId);
  const sideChatParent = useRemoteSessionDetail(deviceId, currentSession?.source === 'side-chat' ? (currentSession.parentSessionId ?? '')
      : '');
  const sideChatBoundary = currentSession?.source === 'side-chat' ? Date.parse(currentSession.createdAt) : undefined;
  const unfilteredHistoryView = useRemoteHistoryView(deviceId, sessionId, maker,
    () => messageScreenFocusedRef.current && messageAppActiveRef.current, remoteHistoryAvailable);
  const historyView = useMemo(() => ({ ...unfilteredHistoryView,
    snapshot: historyAfter(unfilteredHistoryView.snapshot, sideChatBoundary)!,
  }), [unfilteredHistoryView.view, unfilteredHistoryView.snapshot, sideChatBoundary]);
  useEffect(() => {
    if (messageScreenFocusedRef.current && messageAppActiveRef.current) historyView.view.setActive(true);
  }, [connectionEpoch, messageReloadRevision, historyView.view]);
  const inheritedMessages = useSessionMessages(sessionId, deviceId);
  const rawMessages = useMemo(() => sideChatBoundary === undefined ? inheritedMessages
    : inheritedMessages.filter(
            (message) => Date.parse(message.createdAt) >= sideChatBoundary), [inheritedMessages, sideChatBoundary]);
  const historyHandoff = useMemo(() => new HistoryViewHandoff<RemoteMessage>(
    (row) => row.agentMeta?.isStreaming === true,
  ), [historyView.view]);
  const handoff = useMemo(() => historyHandoff.reconcile(historyView.snapshot, rawMessages),
    [historyHandoff, rawMessages, historyView.snapshot]);
  const messages = handoff.messages;
  const messageStructureToken = remoteSessionStore.getSessionMessageStructureToken(sessionId);
  const filteredMessageIndexes = useMemo(() => new Set(sideChatBoundary === undefined ? [] : messages.keys()), [messages, sideChatBoundary]);
  const messageStructureChangedIndexes = sideChatBoundary === undefined ? remoteSessionStore
    .getSessionMessageStructureChangedIndexes(sessionId) : filteredMessageIndexes;
  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;
  const sessionRetention = useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionRetention(sessionId),
  );
  const isScheduleDetail = sessionRetention === 'schedule';
  const pending = useSessionPendingInteractions(sessionId);
  // pending 列表是否已被被控端的全量快照确认过(空列表能不能当「都处理完了」用)。
  const pendingInteractionsAuthoritative = useSessionPendingInteractionsAuthoritative(sessionId);
  const inputProjection = useSessionInputProjection(sessionId);
  const remoteSessionRunning = useSessionRunning(sessionId);
  const makerTurnRunning = useSessionMakerTurnRunning(sessionId);
  const recommendationSession = currentSession;
  const remoteSessionRunStatus = useSessionRunStatus(sessionId);
  // A terminal event carries the persisted identity; never guess from matching history text.
  const activeErrorClientId = inputProjection.error
    && remoteSessionRunStatus.terminalError?.message === inputProjection.error
    ? remoteSessionRunStatus.terminalError.clientId : null;
  const taskUpdates = useSessionTaskUpdates(sessionId);
  const activeComposerDraftScopeKey = composerDraftScopeKey(sessionId, routeDraft);
  const [composerDraftStateKey, setComposerDraftStateKey] = useState(activeComposerDraftScopeKey);
  const [composerDraftSource, setComposerDraftSource] = useState(() =>
    createComposerDraftSource(readImmediateComposerDraftScope(sessionId, routeDraft).document),
  );
  const [composerDraftHydrated, setComposerDraftHydrated] = useState(false);
  const appliedRouteDraftRef = useRef<string | null>(null);
  const draftRef = useRef(composerDraftSource.getSnapshot().draft);
  const composerDocumentRef = useRef<ComposerDocument>(composerDraftSource.getSnapshot().document);
  // replaceParams 复用同一 SessionScreen。任务参数变化的这次 render 仍拿着 A 的
  // state；若直接让 key={sessionId} 子树挂载，B 编辑器会先用 A 文档初始化，再等
  // 被动 effect 水合纠正。沿本页 read-ack 的 render-phase 换代模式同步种入 B 的
  // 内存快照（冷缓存未 hydrate 时为空），React 会丢弃本次旧输出后重渲。
  if (composerDraftStateKey !== activeComposerDraftScopeKey) {
    const nextScope = readImmediateComposerDraftScope(sessionId, routeDraft);
    const nextDraft = composerDocumentProjectedText(nextScope.document);
    setComposerDraftStateKey(activeComposerDraftScopeKey);
    setComposerDraftSource(createComposerDraftSource(nextScope.document));
    setComposerDraftHydrated(false);
    // 旧 A 的 AsyncStorage promise 可能在 effect cleanup 前落定；先让它的 key 失配。
    // 保持 null 也确保 B 的 effect 仍会继续异步 hydrate 磁盘草稿与冷启动引用。
    appliedRouteDraftRef.current = null;
    composerDocumentRef.current = nextScope.document;
    draftRef.current = nextDraft;
  }
  const conversationShareSvgRef = useRef<ConversationShareSvgHandle | null>(null);
  const topOverlayRef = useRef<View>(null);
  const bottomOverlayRef = useRef<View>(null);
  const shareSelectionActiveRef = useRef(shareSelectionActive);
  shareSelectionActiveRef.current = shareSelectionActive;
  const shareSelectionRevisionRef = useRef(shareSelectionRevision);
  shareSelectionRevisionRef.current = shareSelectionRevision;
  const shareOperationSeqRef = useRef(0);
  const [conversationShareBusy, setConversationShareBusy] = useState(false);
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
  useEffect(() => {
    shareOperationSeqRef.current += 1;
    setConversationShareBusy(false);
    shareSelectionStore.exitIfNotSession(sessionId);
    return () => {
      shareOperationSeqRef.current += 1;
      if (shareSelectionStore.getActiveSessionId() === sessionId) shareSelectionStore.exit();
    };
  }, [sessionId]);
  useEffect(() => {
    if (!nativeConversationShareAvailable || !shareSelectionActive) return undefined;
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
  // Context 面板(+ 号弹出的可拖动 sheet):open + 面板内子视图(主视图 / 截图列表 / 目标模式)。
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const [contextSheetView, setContextSheetView] = useState<'main' | 'goal' | 'collab' | 'collab-create'>('main');
  const contextSheetMediaLibraryEnabled = canBrowsePhotoLibraryDirectly(Platform.OS);
  // 模型 + 权限浮窗(ContextSheet 同款 Modal,含二级「模型选项 / 权限」叠层)。
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // 权限模式独立浮窗(composer 左侧图标钮点开,与模型浮窗同属 composer 激活态)。
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);
  // 已建会话的模型浮窗可先浏览另一 Agent；只改此浏览态不触碰会话，选模型才登记 intent。
  const [modelSheetAgentKind, setModelSheetAgentKind] = useState<MobileSessionAgentKind>('claude-code');
  const [attachments, setAttachments] = useState<RemoteSerializedAttachment[]>([]);
  // send() 里 await 在途图片上传后闭包里的 attachments 已是旧值,经 ref 读最新列表。
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 相册资产 → 已上传附件 id 的映射(缩略图勾选态真相);发送/清空附件时一并重置。
  const [mediaAssetAttachments, setMediaAssetAttachments] = useState<Record<string, string>>({});
  // 待选相册资产(按选中顺序;Cursor 式两段提交,底部「加入对话」统一上传)。
  const mediaTapAcceptedRef = useRef(false);
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
  const [goalRestore, setGoalRestore] = useState<{ sessionId: string; objective: string; limits?: MobileGoalLimitsInput;
  } | null>(() => {
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
    beginOutboxAttachmentHandoff,
    getUploadedSource,
    insertUploadedAttachment,
    getUploadedAttachmentId,
    releaseUploadedSources,
    waitForPastePlaceholdersSettled,
    hasPastePlaceholders,
    getPendingUploadCount,
    hasAttachmentInput,
  } = useMobileLocalAttachments({
    attachmentScopeKey: sessionId,
    deviceId,
    getAccessToken: () => auth.getAccessToken(),
    getAttachmentCount: () => attachmentsRef.current.length,
    onUploaded: (rawAttachment, candidate) => {
      // 标注类 candidate:记录「矢量笔迹 + 原图」再编辑真相并打 annotated wire 标。
      const attachment = composerAnnotationsRef.current
        ?.decorateUploadedAttachment(rawAttachment, candidate) ?? rawAttachment;
      // send() 在 waitForPendingUploads 落定后同步读 ref,而 setState 到 commit 有
      // 微任务延迟——这里派发时同步镜像,保证「上传完成→立即发送」不丢刚落定的附件。
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
    onError: (message) => {
      setAttachmentError(message);
    },
    onPicked: () => {
      setContextSheetOpen(false);
      requestAnimationFrame(() => composerInputRef.current?.focus());
    },
  });
  // The page only owns its composer. Accepted outbox records belong to the app bridge.
  useEffect(() => {
    outboxSessionAliveRef.current = sessionId;
    return () => { outboxSessionAliveRef.current = null; };
  }, [sessionId]);
  // 排队编辑复用 composer；推荐只属于用户的普通草稿。
  const [queueEditing, setQueueEditing] = useState<QueueEditingState | null>(null);
  // 编辑最后一条用户消息同样复用 composer(对齐桌面编辑框):发送 = rewind + 重发,
  // 取消原样恢复 stash。ref 镜像供 send() 等异步闭包读最新值。
  const [messageEditing, setMessageEditing] = useState<MessageEditingState | null>(null);
  const messageEditingRef = useRef<MessageEditingState | null>(null);
  const [messageEditSubmitting, setMessageEditSubmitting] = useState(false);
  const messageEditSubmittingRef = useRef(false);
  // 提交锁的代际:切任务时释放锁并推进代际,旧任务的迟到收尾只释放自己那一代,不动新任务的锁。
  const messageEditLockGenerationRef = useRef(0);
  // 进入 / 退出 / 切任务都推进代际,迟到的预览结果不落到别的编辑上。
  const messageEditSeqRef = useRef(0);
  const [voiceStartPending, setVoiceStartPending] = useState(false);
  const voiceStartPendingSeqRef = useRef(0);
  const voiceStartedOnPressInRef = useRef(false);
  const [voiceState, setVoiceStateInternal] = useState<MobileVoiceState>('idle');
  const { prompt: promptRecommendation, dismiss: dismissPromptRecommendation } = usePromptRecommendation({
    ownerId: auth.user?.id, deviceId, sessionId, maker,
    available: remoteHistoryAvailable && !revokedDevices.has(deviceId) && !unresponsiveDevices.has(deviceId),
    connectionEpoch,
    agentKind: recommendationSession ? agentKindForSession(recommendationSession) : null,
    revision: recommendationSession?.lastTurnEndedAt, running: remoteSessionRunning,
    composerSource: composerDraftSource,
    queueEditing: queueEditing !== null || messageEditing !== null,
    hasAttachments: attachments.length > 0 || pendingUploads.length > 0 || pastePlaceholderCount > 0,
    hasTerminalError: remoteSessionRunStatus.hasTerminalError === true,
    voiceIsBusy: voiceStartPending || voiceState === 'listening'
      || voiceState === 'submitting' || voiceState === 'refining',
  });
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const {
    visible: voiceSpeakerFiltered,
    show: showVoiceSpeakerFiltered,
    clear: clearVoiceSpeakerFiltered,
  } = useSpeakerFilterNotice();
  const [voiceReleaseToSendActive, setVoiceReleaseToSendActive] = useState(false);
  // 听写期间原生光标停在插入前的位置;停止后要等最终识别与润色完成才定位到插入末尾。
  // 这段时间继续隐藏光标,避免先在文字中间闪现再跳到末尾。
  const [voiceCaretPlacementPending, setVoiceCaretPlacementPending] = useState(false);
  // 隐藏光标属于发起停止的那个任务:切任务时作废,迟到的停止收尾不得改动新任务的标记。
  const voiceCaretPlacementSeqRef = useRef(0);
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
  const [searchOpen, setSearchOpen] = useSessionHistorySearch(
    readRouteParam(params.openSearch), readRouteParam(params.openSearchRequest));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuInitialView, setMenuInitialView] = useState<SessionMenuView>('menu');
  const [sideChatsOpen, setSideChatsOpen] = useState(false);
  const [sideChatsPendingOpen, setSideChatsPendingOpen] = useState(false);
  const sideChatCreatingRef = useRef(false);
  useEffect(() => {
    setSideChatsOpen(false);
    setSideChatsPendingOpen(false);
  }, [deviceId, sessionId]);
  const [sessionSearchPendingOpen, setSessionSearchPendingOpen] = useState(false);
  // inline 排队区:展开操作行的条目(同时只展开一条;null=全收起)。
  const [queueSelectedClientId, setQueueSelectedClientId] = useState<string | null>(null);
  // 排队消息「复用 composer 编辑」态:进入时把队列条目的文本/附件载入 composer,
  // 暂存(stash)用户原本的草稿与附件托盘,退出(保存/放弃/条目消失)时恢复。
  // ref 镜像供 send() 等异步闭包读最新值。
  const queueEditingRef = useRef<QueueEditingState | null>(null);
  // 会话切换 cleanup(声明在前)引用组件后段的回收函数,经 ref 断开声明顺序依赖。
  const discardQueueEditTransientAttachmentResourcesRef = useRef<
    | ((editing: QueueEditingState, attachmentsAtExit: readonly RemoteSerializedAttachment[]) => void) | null
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
    releaseUploadedSources([...attachmentsById.keys()]);
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentPreviews({});
    setMediaAssetAttachments({});
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
  useLayoutEffect(() => {
    const discard = () => {
      discardAllPendingUploadsForScopeChange();
      discardSessionComposerAttachmentStateRef.current();
    };
    beforeSessionSwitchRef.current = discard;
    return () => {
      if (beforeSessionSwitchRef.current === discard) beforeSessionSwitchRef.current = null;
    };
  }, [beforeSessionSwitchRef, discardAllPendingUploadsForScopeChange]);
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
   * 按任务、消息和图片顺序保存发送预览，跨桌面端媒体地址物化继续使用。
   *
   * 排队气泡里的图不能等 sentAttachmentThumbStore 那条链(上传落定 → 拷进自有目录 →
   * AsyncStorage hydrate)——期间查询一律返回 null,气泡只能画空占位格。发送时手边就有
   * 预览,记下来直接用;store 仍是重开会话 / 预览失效后的后备。
   * 活跃发送条目全部保留，另保留最近 64 条历史记录；正式内容还会核对图片指纹。
   */
  const sentImagePreviewsRef = useRef<SentMessageImagePreviews>(new Map());
  const liveImagePreviewClientIdsRef = useRef<ReadonlySet<string>>(new Set());
  const rememberSentAttachmentPreviews = useCallback((
    clientId: string,
    attachments: readonly RemoteSerializedAttachment[],
    previewOf: (attachment: RemoteSerializedAttachment) => string | null | undefined,
    galleryKeyOf?: (attachment: RemoteSerializedAttachment) => string | undefined,
  ) => {
    rememberSentMessageImagePreviews(sentImagePreviewsRef.current, sessionId, clientId, attachments,
      previewOf, galleryKeyOf, liveImagePreviewClientIdsRef.current);
  }, [sessionId]);
  const getSentImagePreview = useCallback((clientId: string, imageIndex: number, name: string, attachmentId?: string, sha256?: string, sourceRef?: string) =>
      getSentMessageImagePreview(sentImagePreviewsRef.current, sessionId, clientId, imageIndex, name, attachmentId, sha256, sourceRef,
      ), [sessionId]);
  // 「乐观气泡已上屏、enqueue RPC 尚未落定」的 clientId:这段窗口消息是否真的发出
  // 还没有答案(弱网可达数秒,且失败会回滚摘除气泡),徽标必须是转圈而不是「排入
  // 队尾」——后者是已确认入队的语义。成功 / 回滚 / 转失败任一落定即移除。
  const [sendingQueueClientIds, setSendingQueueClientIds] = useState<ReadonlySet<string>>(new Set());
  const [optimisticUserState, setOptimisticUserState] = useState<{
    sessionId: string;
    items: readonly OptimisticUserMessage[];
  }>(() => ({ sessionId, items: [] }));
  if (optimisticUserState.sessionId !== sessionId) {
    setOptimisticUserState({ sessionId, items: [] });
  }
  const markQueueItemSending = useCallback((queued: QueuedRemoteMessage) => {
    const clientId = queued.clientId;
    setLocallyRemovedQueueClientIds((current) => {
      if (!current.has(clientId)) return current;
      const next = new Set(current);
      next.delete(clientId);
      return next;
    });
    const projection = remoteSessionStore.getInputProjection(sessionId);
    const source = remoteSessionStore.getMessages(sessionId);
    // Capture at send time, not when React later runs the state updater.
    const observed = latestMessagesRef.current;
    // Match Desktop's idle-send placement. Busy follow-ups retain the existing
    // pending tail until authoritative history supplies their transcript row.
    const busy = projection.pendingQueue.length > 0 || projection.steeringQueueClientIds.length > 0
      || projection.queueAbortPending || remoteSessionStore.isSessionRunning(sessionId)
      || remoteSessionStore.getPendingInteractions(sessionId).length > 0
      || currentTurnHasStreamingAssistant(source);
    if (!busy) setOptimisticUserState((current) => current.sessionId !== sessionId ? current : {
      sessionId, items: appendOptimisticUserMessage(current.items, source, queued, sessionId, observed),
    });
    setSendingQueueClientIds((current) => {
      if (current.has(clientId)) return current;
      const next = new Set(current);
      next.add(clientId);
      return next;
    });
  }, [sessionId]);
  const clearQueueItemSending = useCallback((queued: QueuedRemoteMessage, accepted: boolean, before: InputProjection) => {
    const clientId = queued.clientId;
    setSendingQueueClientIds((current) => {
      if (!current.has(clientId)) return current;
      const next = new Set(current);
      next.delete(clientId);
      return next;
    });
    if (outboxSessionAliveRef.current !== sessionId) return;
    const projection = remoteSessionStore.getInputProjection(sessionId);
    const completed = settleEnqueueResult([], queued, accepted, {
      previous: [...before.pendingQueue, queued],
      current: projection.pendingQueue,
      previousSteeringClientIds: new Set(before.steeringQueueClientIds),
      currentSteeringClientIds: new Set(projection.steeringQueueClientIds),
      hiddenClientIds: confirmedHistoryUserClientIds(historyView.view.getSnapshot(), remoteSessionStore.getMessages(sessionId)),
      // Local cancellation is filtered by settlingRetired on the current render;
      // do not capture its pre-enqueue state across the asynchronous RPC.
      locallyRemovedClientIds: new Set(),
    });
    // The enqueue RPC can finish after drain but before any queued frame commits.
    // Transfer ownership in the same completion callback, including reconciled ACK loss.
    if (completed.length > 0) {
      if (!settlingAddedAtRef.current.has(clientId)) settlingAddedAtRef.current.set(clientId, Date.now());
    }
    if (!accepted) {
      settlingAddedAtRef.current.delete(clientId);
      setLocallyRemovedQueueClientIds((current) => new Set([...current, clientId]));
    }
    setSettlingQueueItems((current) => accepted ? mergeSettlingItems(current, completed)
      : current.filter((item) => item.clientId !== clientId));
  }, [sessionId, setSettlingQueueItems, historyView.view]);
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
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  // send() 的同步重入锁:sending state 要等 re-render 提交才可见,主线程卡顿时
  // 连点发送会在同一拍里多次穿过 state 守卫,把同一条消息重复 enqueue(issue #755)。
  // ref 在 send() 同步段立即置位,后续点击当场拦下(同 new.tsx creatingRef /
  // voiceStopInFlightRef 的既有模式)。
  const sendInFlightRef = useRef(false);
  const rawOutboxRecords = useSyncExternalStore(mobileDurableOutbox.subscribe, mobileDurableOutbox.getSnapshot);
  const durableOutboxRecords = useMemo(() => rawOutboxRecords.filter((record) => record.accountId === outboxOwner.accountKey && !isDurableOutboxSettled(record)), [rawOutboxRecords, outboxOwner]);
  const outboxItems = useMemo(() => durableOutboxRecords
    .filter((r) => r.deviceId === deviceId && r.item.sessionId === sessionId && r.accountId === getMobileAuthOwner().accountKey)
    .map(durableOutboxDisplayItem), [durableOutboxRecords, deviceId, sessionId]);
  const outboxRef = useRef<readonly MobileOutboxItem[]>(outboxItems);
  outboxRef.current = outboxItems;
  useEffect(() => observeDurableOutboxSending(mobileDurableOutbox, deviceId, sessionId, (record) => {
    markQueueItemSending(record.prepared!);
    rememberOutboxImagePreviews(sentImagePreviewsRef.current, sessionId, durableOutboxDisplayItem(record),
      liveImagePreviewClientIdsRef.current);
  }, (clientId) => {
    setSendingQueueClientIds((current) => {
      if (!current.has(clientId)) return current;
      const next = new Set(current);
      next.delete(clientId);
      return next;
    });
  }, outboxOwner.accountKey), [outboxOwner, deviceId, sessionId, markQueueItemSending]);
  const pageMessageWorkLeaseRef = useRef<ReturnType<
    typeof remoteSessionStore.acquireSessionMessageWork
  > | null>(null);
  const pageHasMessageWork = outboxItems.length > 0
    || pendingUploads.length > 0
    || pastePlaceholderCount > 0
    || getPendingUploadCount() > 0
    || sendInFlightRef.current
    || sending
    || sendingQueueClientIds.size > 0
    || settlingQueueItems.length > 0
    || attachments.length > 0;
  useLayoutEffect(() => {
    const lease = remoteSessionStore.acquireSessionMessageWork(sessionId, pageHasMessageWork);
    pageMessageWorkLeaseRef.current = lease;
    return () => {
      if (pageMessageWorkLeaseRef.current === lease) pageMessageWorkLeaseRef.current = null;
      lease.release();
    };
  }, [sessionId]);
  useLayoutEffect(() => {
    pageMessageWorkLeaseRef.current?.update(pageHasMessageWork);
  }, [pageHasMessageWork]);
  // Only pre-accept composer continuations belong to this page; delivery belongs to the app.
  const outboxSessionAliveRef = useRef<string | null>(sessionId);
  const [messageListFollowLatestRequestKey, setMessageListFollowLatestRequestKey] = useState(0);
  const [bottomOverlayContentHeight, setBottomOverlayContentHeight] = useState(0);
  // Where the input starts inside the bottom overlay. Status rows and bars
  // above it carry their own surfaces, so the edge blur starts at the input.
  const [composerInputTop, setComposerInputTop] = useState(0);
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
  // 账号级限额快照(`maker:usage:account` 原始返回):账号级数据本身跨会话共享,但
  // 会话 agentKind 不同时语义不同(只对 codex 会话拉取/展示),随 sessionId 一起清。
  const [accountUsage, setAccountUsage] = useState<unknown>(null);
  // Codex app-server 权威额度 + reset credit 快照。单独保留完整 DTO,同时把其中
  // rateLimits 投影到 accountUsage,复用已有窗口 UI 并兼容老被控端只读通道。
  const [codexRateLimits, setCodexRateLimits] = useState<MobileCodexRateLimitsResult | null>(null);
  const [codexResetBusy, setCodexResetBusy] = useState(false);
  // consume 回包丢失时保留本次 UUID;即使面板重新拉取额度,重试也不能换 key。
  const [codexResetRetryKey, setCodexResetRetryKey] = useState<string | null>(null);
  // 账号控制快照的归属会话号；上下文详情缓存由菜单自身管理。
  const contextUsageSessionRef = useRef(sessionId);
  useEffect(() => {
    if (contextUsageSessionRef.current === sessionId) return;
    contextUsageSessionRef.current = sessionId;
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
  const [operationError, setOperationError] = useState<SessionOperationError | null>(null);
  const operationErrorRef = useRef<SessionOperationError | null>(null);
  const setError = useCallback((message: string | null) => {
    const next = message === null ? null : { message };
    operationErrorRef.current = next;
    setOperationError(next);
  }, []);
  const error = operationError?.message ?? null;
  const [syncError, setSyncError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequestSeqRef = useRef(0);
  const historyRequestInFlightRef = useRef<number | null>(null);
  const messageWindowReconciledRef = useRef(false);
  const errorScopeKey = JSON.stringify([deviceId, sessionId]);
  const [errorScope, setErrorScope] = useState(errorScopeKey);
  if (errorScope !== errorScopeKey) {
    setErrorScope(errorScopeKey);
    setError(null);
    setSyncError(null);
    setHistoryError(null);
    setLoadingEarlier(false);
    historyRequestSeqRef.current += 1;
    historyRequestInFlightRef.current = null;
    messageWindowReconciledRef.current = false;
  }
  useEffect(() => () => { historyRequestSeqRef.current += 1; }, []);
  // UI 错误可被任意操作清掉；transport hold 独立锁存所有连接恢复来源，直到当前
  // 设备完成一次权威同步。error 可空：纯 relay / presence 断线未必产生请求错误。
  const [outboxTransportHold, setOutboxTransportHold] = useState<{
    deviceId: string;
    error: string | null;
  } | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // 会话已读回执的同步门槛 key:`${sessionId}:${connectionEpoch}`,由 syncSession 尾部写入。
  // 与 lastSyncedAt 不同,它按 session + 连接代区分——屏实例复用、原地切 session 时
  // lastSyncedAt 不会归零,不能用来判断「当前会话本次连接已同步」。epoch 经 ref 读取,
  // 避免把 connectionEpoch 加进 syncSession deps 引发额外整窗重拉。
  const [readAckSyncedKey, setReadAckSyncedKey] = useState<string | null>(null);
  const [contentSyncedKey, setContentSyncedKey] = useState<string | null>(null);
  const subscriptionAck = deviceId && sessionId
    ? (getSubscriptionIdentity?.(deviceId, ['sessions', `session:${sessionId}`]) ?? null)
      : null;
  const contentRecoveryKey = subscriptionAck === null ? null
    : JSON.stringify([deviceId, sessionId, connectionEpoch, subscriptionAck]);
  const contentRecoveryKeyRef = useRef(contentRecoveryKey);
  contentRecoveryKeyRef.current = contentRecoveryKey;
  // interrupted 只依赖 getSession 的权威时间戳；兄弟快照失败不能把这道门永久关住。
  // 已读回执仍继续使用上面的整窗门槛，避免消息未同步就提前清 attention。
  const [sessionMetadataSyncedKey, setSessionMetadataSyncedKey] = useState<string | null>(null);
  const readAckEpochRef = useRef(connectionEpoch);
  readAckEpochRef.current = connectionEpoch;
  // 后台订阅重试不能越过任务/设备/连接代切换，也不能在页面卸载后把已清理的 owner
  // 重新登记回来。render 阶段先发布最新 identity；旧 effect 的 cleanup 只清自己。
  const sessionSubscriptionIdentity = JSON.stringify([deviceId, sessionId, connectionEpoch]);
  const [messageHistoryRead, setMessageHistoryRead] = useSessionMessageHistoryRead({
    deviceId, sessionId, notificationResponse, subscriptionIdentity: sessionSubscriptionIdentity,
  });
  const sessionSubscriptionIdentityRef = useRef<string | null>(sessionSubscriptionIdentity);
  sessionSubscriptionIdentityRef.current = sessionSubscriptionIdentity;
  useEffect(() => () => {
    if (sessionSubscriptionIdentityRef.current === sessionSubscriptionIdentity) {
      sessionSubscriptionIdentityRef.current = null;
    }
  }, [sessionSubscriptionIdentity]);
  const sessionsSubscriptionCoordinatorRef = useRef<ReturnType<
    typeof createTransientTopicSubscriptionCoordinator
  > | null>(null);
  sessionsSubscriptionCoordinatorRef.current ??= createTransientTopicSubscriptionCoordinator();
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
  // A new push visit to the same route must also wait for its new message window.
  const readAckVisitKey = JSON.stringify([deviceId, sessionId, notificationResponse]);
  const [prevReadAckVisitKey, setPrevReadAckVisitKey] = useState(readAckVisitKey);
  if (prevReadAckVisitKey !== readAckVisitKey) {
    setPrevReadAckVisitKey(readAckVisitKey);
    setReadAckSyncedKey(null);
    setSessionMetadataSyncedKey(null);
    setContentSyncedKey(null);
    readAckGateGenRef.current += 1;
  }
  // 远程媒体取件队列:屏实例级缓存 + 同 url 去重 + 并发上限(每次取件都让桌面端
  // 真实上传一次 OSS,列表缩略图懒取件后必须收敛)。deps 经 ref 透传保持队列实例稳定;
  // 队列生命周期 = 单个会话:切 sessionId / 页面卸载时 releaseAll + 补删,
  // 下个会话首次取件再懒建新实例(见下方 sessionId 键控的清理 effect),
  // 上一会话的 OSS 对象不跨会话累积。
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
  remoteMediaDiskCacheRef.current ??= createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO(), {
    availableBytes: () => Paths.availableDiskSpace,
    reserveBytes: PEER_FILE_DISK_RESERVE_BYTES,
    // Preserve manual image retention; only the new regenerable video copies
    // join pressure cleanup, with mounted players holding a protection lease.
    canEvict: (mimeType) => mimeType.startsWith('video/'),
  });
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
        baseUrl: deviceLinkMediaApiBaseUrl(media.ossKey),
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
          const hit =
                (await diskCache.lookup(diskSource).catch(() => null))
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
          ...(diskCache ? { retainLocalVideo: async (video: MobileResolvedRemoteMedia) => {
            const stored = await diskCache.store(bareDiskSource, video.url, video.mimeType, video.size);
            const copy = stored ? await diskCache.lookup(bareDiskSource) : null;
            if (!copy) throw new Error('VIDEO_CACHE_FAILED');
            return { ...video, url: copy.uri, expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
              protectLocalFile: () => diskCache.protect(bareDiskSource) };
          } } : {}),
          presignGet: (ossKey) => deps.auth.apiFetch<MobileRemoteMediaPresignResult>(
            '/api/device-link/media/presign-get',
            { baseUrl: deviceLinkMediaApiBaseUrl(ossKey), method: 'POST', body: { key: ossKey } },
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
    }, {
      maxCacheBytes: 16 * 1024 * 1024,
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
  const finishVoiceRecordingRef = useRef<((options?: { focusInput?: boolean }) => void) | null>(null);
  const composerInputRef = useRef<ComposerRichInputHandle | null>(null);
  const voiceControllerSessionRef = useRef<MobileVoiceControllerSession | null>(null);
  const voiceDictionaryLearningTrackerRef = useRef<MobileVoiceDictionaryLearningTracker | null>(null);
  const sendLatestRef = useRef<
    | ((options?: {
    draftOverride?: string;
    documentOverride?: ComposerDocument;
  }) => Promise<boolean | void>) | null>(null);
  const sendButtonRef = useRef<View>(null);
  const composerSendTargetEnabledRef = useRef(false);
  // Match the keyed palette lifetime. Old requests/cleanup retain their old
  // reference and cannot affect command dispatch in the next draft scope.
  const slashCommandsRef = useMemo<RefObject<MobileSlashCommand[]>>(
    () => ({ current: [] }),
    [activeComposerDraftScopeKey],
  );
  const sendButtonFrameRef = useRef<{ height: number; width: number; x: number; y: number;
  } | null>(null);
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
  const autoRetrySyncStateRef = useRef<{ identity: string; attempt: number } | null>(null);
  const loadedRouteFocusKeyRef = useRef<string | null>(null);
  const appliedRouteFocusKeyRef = useRef<string | null>(null);
  const appliedRouteComposerFocusKeyRef = useRef<string | null>(null);
  const handleChipMenuActionRef = useRef<(key: ChatFileChipMenuActionKey, target: ChatFilePathTarget) => void>(() => {});
  const targetAvailableRef = useRef<boolean | null>(null);
  const targetAvailableDeviceRef = useRef<string | null>(null);
  // 记录已为哪个连接 epoch 触发过 resync;初值 = 首渲染时的 epoch,使首开由 mount effect 单独负责,
  // 这个 epoch effect 只在真正重连(epoch 变化)时再同步,避免首开连环重 sync 导致列表重排跳动。
  const syncedConnectionEpochRef = useRef(connectionEpoch);
  const sessionManagedByHost = useHostManagedSession(
    JSON.stringify([auth.accountGeneration, deviceId, sessionId]),
    currentSession,
  );
  // 协同(Orca):+ 面板「协同模式」二级视图 + Lead / Worker 导航。团队真身在被控端。
  // Lead <-> Worker 往返不能用 push:session 路由带 getId,同 id 的 PUSH 会被 StackRouter
  // 「复用 + 移到栈顶」,返回手势就落回 Worker,且每往返一次改写一次栈内 Screen 顺序
  // (Android 白屏)。已在栈里 → dismissTo 回退,不在栈里 → push。理由与不变量见
  // collabSessionNavigation.ts。
  const openCollabSession = useCallback((
    targetSessionId: string,
    target?: { deviceId: string; deviceName?: string | null },
  ) => {
    if (!deviceId || !targetSessionId) return;
    // 在另一台电脑运行的 Worker 打开那台上的真实任务；其余沿用当前电脑。
    const targetDeviceId = target?.deviceId ?? deviceId;
    const targetDeviceName = target
      ? (target.deviceName ?? t('session.collab.otherComputer'))
      : deviceName;
    navigateToCollabSession(
      {
        getState: () => navigation.getState(),
        push: (target) => router.push({
          pathname: '/sessions/[sessionId]',
          params: {
            sessionId: target.sessionId,
            deviceId: target.deviceId,
            deviceName: target.deviceName,
          },
        }),
        dismissTo: (target) => router.dismissTo({
          pathname: '/sessions/[sessionId]',
          params: {
            sessionId: target.sessionId,
            deviceId: target.deviceId,
            deviceName: target.deviceName,
          },
        }),
      },
      { sessionId: targetSessionId, deviceId: targetDeviceId, deviceName: targetDeviceName },
      sessionId,
    );
  }, [deviceId, deviceName, navigation, router, sessionId, t]);
  // 来源目录在协同 hook 之后才取得(它依赖 Worker 选择器是否打开),经 ref 在提交时读。
  const collabProvidersRef = useRef<readonly ProviderView[] | null>(null);
  const executionMakerForDevice = useCallback(
    (targetDeviceId: string) => createMobileMakerTransport({ deviceId: targetDeviceId, invoke }),
    [invoke],
  );
  const collab = useSessionOrcaCollab({
    maker,
    executionMakerForDevice,
    deviceId: deviceId || null,
    sessionId,
    session: currentSession,
    // 按区域限定的账号键:Global 与中国大陆版同号不同人,记忆(含完全访问)不能串。
    prefsScope: outboxOwner.accountKey || null,
    connectionEpoch,
    getProviders: () => collabProvidersRef.current,
    enabled: !isSharedTaskPeer(deviceId) && !sessionManagedByHost,
    sheetView: contextSheetView === 'collab' || contextSheetView === 'collab-create' ? contextSheetView : null,
    sheetOpen: contextSheetOpen,
    setSheetView: setContextSheetView,
    setSheetOpen: setContextSheetOpen,
    openSession: openCollabSession,
    // 远程供应商：被控电脑声明支持时，Worker 可以像任务一样选其他电脑 / 分享的供应商。
    workerAgentLocationSelectable: capabilities?.supportsOrcaWorkerAgentDevice === true,
  });
  const composerDeviceProviders = useDeviceProviders(
    deviceId || undefined,
    modelSheetOpen,
  );
  const collabWorkerDeviceId = collab.workerForm.form.executionDeviceId ?? deviceId;
  const collabDeviceProviders = useDeviceProviders(collabWorkerDeviceId || undefined, collab.workerForm.modelPicker.open);
  const collabModelPricing = useDeviceModelPricing(collabWorkerDeviceId || undefined);
  const collabApiKeyStatus = useDeviceApiKeyStatus(collabWorkerDeviceId || undefined);
  // SSH 远端 Lead 的 Worker 只能用远端可路由的来源(与桌面创建 Worker 面板同口径)。
  const collabWorkerProviders = useMemo(
    () => orcaWorkerProvidersForLead(collabDeviceProviders.providers, !!currentSession?.remoteHostId?.trim()),
    [collabDeviceProviders.providers, currentSession?.remoteHostId],
  );
  collabProvidersRef.current = collabDeviceProviders.ready ? collabWorkerProviders : null;
  // Worker 任务打开详情时刷新自身记录(焦点可能已在别处变化)。
  const refreshWorkerSelf = collab.refreshWorkerSelf;
  useEffect(() => {
    if (settingsOpen && collab.isWorker) void refreshWorkerSelf();
  }, [collab.isWorker, refreshWorkerSelf, settingsOpen]);
  // 新建任务页在后台开启协同失败时任务照单任务继续,提示在这里(跳转后的会话页)出现。
  useEffect(() => {
    const show = () => {
      const reason = takeOrcaStartFailure(sessionId);
      if (reason) setError(t('session.collab.startFailedContinue', { reason }));
    };
    show();
    return subscribeOrcaStartFailure((failedSessionId) => {
      if (failedSessionId === sessionId) show();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const accountProvider = composerDeviceProviders.ready
    ? composerDeviceProviders.providers.find((provider) => provider.id === currentSession?.providerId)
    : undefined;
  // Codex 限额读取 / 重置作用于被控电脑的账号:Agent 在另一台电脑运行时(远程 Agent)这一轮消耗的
  // 是那台的账号,被控电脑的控件与之无关(余量改由任务菜单读那台,见 sessionUsageAccount)。
  const localCodexRateLimitControl = !sessionAgentRunsOnOtherComputer(currentSession)
    && canUseLocalCodexRateLimitControl(currentSession, accountProvider);
  const accountProviderId = currentSession?.providerId ?? 'openai';
  const accountControlScope = `${deviceId}\0${sessionId}\0${accountProviderId}`;
  const accountControlScopeRef = useRef(accountControlScope);
  accountControlScopeRef.current = accountControlScope;
  const [storedAccountControlScope, setStoredAccountControlScope] = useState(accountControlScope);
  // Reset during render, before a menu or reset callback can receive another account's offer.
  // React rerenders this component before committing its children when its own state changes here.
  if (storedAccountControlScope !== accountControlScope) {
    setStoredAccountControlScope(accountControlScope);
    setAccountUsage(null);
    setCodexRateLimits(null);
    setCodexResetBusy(false);
    setCodexResetRetryKey(null);
  }
  const isDeviceAccessRevoked = !!deviceId && revokedDevices.has(deviceId);
  const isSharedTaskAccessRevoked = isDeviceAccessRevoked && isSharedTaskPeer(deviceId);
  // 熔断 open:被控电脑「进程活着但不回包」的半死态;relay status 恒 online,必须单独入参。
  const isDeviceUnresponsive = !!deviceId && unresponsiveDevices.has(deviceId);
  // 熔断已关后残留的 DEVICE_UNRESPONSIVE 错误按陈旧丢弃,且必须一次性解析、
  // 两个消费方共用(review P1):banner 用它,下面的 remoteUnavailableReason 也
  // 用它——否则恢复后横幅消失了,composer 却仍被 stale 快照锁在不可用态,
  // 直到手动同步才解开。
  const connectionError = resolveEffectiveConnectionError(
    isDeviceAccessRevoked ? '[ACCESS_REVOKED] access revoked by target device' : (syncError ?? error),
    isDeviceUnresponsive,
  );
  // dispatch / Stop 与恢复 edge 共用 Context 内随 connection epoch 重置的三态 verdict，
  // 不再拿跨 epoch 保留的旧 presence 快照作第二份可用性真源。
  const targetAvailableForDispatch = getPresenceAvailability(deviceId);
  const screenAutoRecoveringError = connectionError && isAutoRecoveringRemoteError(connectionError)
    ? connectionError
    : null;
  const hasLatchedOutboxTransportHold = outboxTransportHold?.deviceId === deviceId;
  const heldOutboxTransportError = hasLatchedOutboxTransportHold
    ? outboxTransportHold.error
    : null;
  const latchOutboxTransportHold = useCallback((nextError: string | null) => {
    if (!deviceId) return;
    setOutboxTransportHold((current) => {
      const currentError = current?.deviceId === deviceId ? current.error : null;
      const errorForHold = nextError ?? currentError;
      if (current?.deviceId === deviceId && current.error === errorForHold) return current;
      return { deviceId, error: errorForHold };
    });
  }, [deviceId]);
  // 当前 error 比旧 hold 更新：确定性错误出现时必须立即压过旧的断线提示；只有
  // 当前 error 已清空，才继续沿用 hold 等权威同步收口。
  const activeOutboxTransportError = connectionError === null
    ? heldOutboxTransportError
    : screenAutoRecoveringError;
  // 连接阻塞一旦出现就锁存。layout effect 早于下方 passive pump effect，保证同一
  // commit 的状态翻转也先关门；成功 sync 尾是唯一清门位置，失败（含 NOT_FOUND）
  // 都不能拿旧 session 行派发。
  useLayoutEffect(() => {
    const connectionBlocked = status !== 'online'
      || targetAvailableForDispatch === false
      || isDeviceUnresponsive
      || screenAutoRecoveringError !== null;
    if (!connectionBlocked) return;
    latchOutboxTransportHold(screenAutoRecoveringError);
  }, [
    isDeviceUnresponsive,
    latchOutboxTransportHold,
    screenAutoRecoveringError,
    status,
    targetAvailableForDispatch,
  ]);
  // 若 offline→online 被 React 合并进单次 render，旧连接代没有机会先锁存；render
  // 阶段直接比较 epoch / presence edge，挡住本帧 pump。对应 effect 随即锁存 hold
  // 并启动 sync，后续仍只由成功尾解除。
  const connectionEpochRecoverySyncPending = status === 'online'
    && syncedConnectionEpochRef.current !== connectionEpoch;
  const presenceRecoverySyncPending = status === 'online'
    && targetAvailableForDispatch === true
    && (
      targetAvailableDeviceRef.current !== deviceId
      || targetAvailableRef.current !== true
    );
  const outboxRecoverySyncHeld = hasLatchedOutboxTransportHold
    || connectionEpochRecoverySyncPending
    || presenceRecoverySyncPending;
  const hasRenderedMessages = historyView.snapshot.ready ? historyView.snapshot.items.length > 0 : messages.length > 0;
  const companionEntry = useRemoteResourceSession(deviceId, deviceName, sessionId,
    currentSession?.id === sessionId && hasRenderedMessages
      && readAckSyncedKey === `${sessionId}:${connectionEpoch}` &&
      // A pre-ACK snapshot may omit replies sent before the subscription took effect.
      contentRecoveryKey !== null && contentSyncedKey === contentRecoveryKey
      && !outboxRecoverySyncHeld && !loading,
    sessionMetadataSyncedKey === `${sessionId}:${connectionEpoch}`
      && (readRouteParam(params.resourceKind) !== 'bot' || currentSession?.source === 'bot'));
  const companionResource = companionEntry.resource;

  // 对齐 Desktop：输入与发送仍可排队，但模型、权限、Plan、停止等需要即时访问
  // 被控端的操作在明确断线时禁用。presence unknown 仍允许，避免旧缓存永久锁死入口。
  const remoteRealtimeControlsUnavailable = status !== 'online'
    || targetAvailableForDispatch === false
    || isDeviceUnresponsive
    || outboxRecoverySyncHeld || !companionEntry.ready;
  const remoteStopUnavailable = remoteRealtimeControlsUnavailable;
  const outboxConnectionState: MobileOutboxConnectionState = {
    relayOnline: status === 'online',
    targetAvailable: targetAvailableForDispatch,
    deviceUnresponsive: isDeviceUnresponsive,
    autoRecoveringError: outboxRecoverySyncHeld || !companionEntry.ready,
    syncInProgress: loading,
  };
  // pumpOutbox 是跨 render 的 async 循环，每轮必须读最新连接态；只捕获某一帧会在
  // 派发第一条期间掉线后继续把后续 FIFO 条目打进已经断开的链路。
  const outboxConnectionStateRef = useRef(outboxConnectionState);
  outboxConnectionStateRef.current = outboxConnectionState;
  const outboxConnectionDispatchBlocked = shouldHoldOutboxDispatchForConnection(
    outboxConnectionState,
  );
  // 待发气泡写「等…后发送」只看真正断开:只有系统确认手机没网才归因于网络(relay 连接中 /
  // 服务重连不算);电脑不可达或无响应归因于电脑;同步中、自动恢复中几秒就过去,不提示。
  const localNetworkStatus = useLocalNetworkStatus();
  const outboxWaitingFor: MobilePendingSendWaitingFor | null = localNetworkStatus === 'unavailable'
    ? 'network'
    : outboxConnectionState.relayOnline
      && (outboxConnectionState.targetAvailable === false || outboxConnectionState.deviceUnresponsive)
      ? 'computer'
      : null;
  // 弱网普通断线也要有可见信号(消息流静默停更没有任何提示),经防闪延迟后显示
  const connectionRecoveryError = companionEntry.error ?? activeOutboxTransportError ?? connectionError;
  const bannerError = connectionRecoveryError ?? historyError;
  const bannerRetriesHistory = connectionRecoveryError === null && historyError !== null;
  const contentRecoveryState = contentRecoveryKey !== null
    && contentSyncedKey === contentRecoveryKey
    && readAckSyncedKey === `${sessionId}:${connectionEpoch}`
    && !outboxRecoverySyncHeld
    ? 'recovered' : 'syncing';
  useContentRecoveryDiagnostics(contentRecoveryState, `${deviceId}:${sessionId}`);
  const showConnectionBanner = useShowConnectionBanner(
    status,
    bannerError,
    connectionIssue,
    isDeviceUnresponsive,
  );
  // A cloud companion on its main computer (cloud-companions.md §3.1): like an IM chat, a briefly
  // unreachable computer does not interrupt reading; only a message that cannot get through for a
  // while offers to continue on another computer.
  const cloudHome = useCloudCompanionHome(!!companionResource);
  const cloudHomeActor = cloudHome.supported && companionResource
    ? (cloudHome.actors.find(
          (actor) => actor.kind === 'bot' && actor.externalId === companionResource.ref.id && actor.homeDeviceId === deviceId) ?? null)
      : null;
  const cloudHomeUnreachable = useSustained(!!cloudHomeActor
    && isMessageWaitingForCloudHome(durableOutboxRecords, { deviceId, sessionId }, outboxConnectionState));
  const quietConnection = !!cloudHomeActor;
  const hasCurrentSession = currentSession !== null;
  const currentAgentKind = useMemo(
    () => (currentSession ? agentKindForSession(currentSession) : null),
    [currentSession?.agentKind, currentSession?.id],
  );
  // —— 自动化 run「激活即已读」(对齐桌面端 CCAgentSidebarUpper):打开会话读完报告后,
  // 把该会话名下未读 run 在被控端标已读;host 随之广播 read 事件,首页 / 设备列表红点自动清除。
  const scheduleEventSnapshot = useRemoteScheduleEventSnapshot(deviceId);
  const completedRunId = unreadRunIdFromProjection(scheduleEventSnapshot.lastProjection, sessionId);
  // 同一轻量索引同时提供历史失败提示和未读记录；已读不会消除历史失败。
  const scheduleNoticeSource = JSON.stringify([getActiveMobileSessionRealm(), auth.user?.id, deviceId, sessionId]);
  const sessionSourceForSchedule = currentSession?.source;
  const [scheduleFailure, setScheduleFailure] = useState<{ source: string; run?: FailedScheduleRunSnapshot;
  } | null>(null);
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
  const companionChat = useHostManagedSession(
    JSON.stringify([auth.accountGeneration, deviceId, sessionId]),
    companionResource?.ref.kind === 'bot' ? { source: 'bot' } : currentSession,
    false,
  );
  const lastAckKeyRef = useRef<string | null>(null);
  const sessionResourceCards = useSessionResourceCards(
    deviceId, deviceName, sessionId, currentSession?.source, remoteSessionRunning,
  );
  // Without a mounted input there is no marker; fall back to the whole bottom layer.
  const composerBackdropTop = sessionResourceCards.blocked ? 0 : composerInputTop;
  // AppState 门槛:锁屏 / 切后台时导航焦点不变,useFocusEffect 的 cleanup 不会跑,
  // 驻留计时器可能在没有真实前台展示的情况下(甚至后台恢复补跑时)发出 explicit
  // 回执。把 AppState 作为回执 effect 的重算信号:离开 active 立刻取消未到期的
  // 计时,回到 active 重新起满一轮 dwell。
  const [appStateActive, setAppStateActive] = useState(AppState.currentState === 'active');
  useSharedTaskAccess(deviceId, sessionId, appStateActive);
  const sharedTaskExit = useLeaveSharedTask({
    deviceId, enabled: settingsOpen && !isSharedTaskAccessRevoked,
    onLeft: () => { setSettingsOpen(false); router.replace('/devices'); },
    onError: (message) => { setSettingsOpen(false); setError(message); },
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppStateActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);
  useFocusEffect(useCallback(() => {
    if (!appStateActive || !deviceId || !sessionId || !remoteHistoryAvailable) return;
    let active = true;
    const isActive = () => active && messageScreenFocusedRef.current && messageAppActiveRef.current;
    const cancel = deferScheduleIndexHydration(() => {
      // An ordinary task has no automation runs to mark read or failures to show. Skip the
      // device-wide index scan when the current index already says this task is unbound.
      if (!sessionMayHaveScheduleRuns(deviceId, sessionId, sessionSourceForSchedule)) return;
      void withTransientRemoteRetry(() => markSessionScheduleRunsRead(maker, sessionId, deviceId, isActive, {
        onIndex: (index) => setScheduleFailure({ source: scheduleNoticeSource, run: index.get(sessionId)?.latestFailedRun }),
      })).catch(() => undefined);
    });
    return () => { active = false; cancel(); };
  }, [appStateActive, connectionEpoch, deviceId, invoke, maker, remoteHistoryAvailable, scheduleEventSnapshot.sessionIndexVersion, scheduleNoticeSource, sessionId, sessionSourceForSchedule]));
  useFocusEffect(useCallback(() => {
    if (!appStateActive || !remoteHistoryAvailable || !completedRunId) return;
    void maker.schedule.markRunRead(completedRunId).catch(() => undefined);
  }, [appStateActive, completedRunId, maker, remoteHistoryAvailable]));
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
  const activePendingInteraction = useMemo(() => {
    return selectPendingInteractionByRequestId(pending, pendingInteractionActiveRequestId);
  }, [pending, pendingInteractionActiveRequestId]);
  const activePendingRequestId = activePendingInteraction
    ? readRequestId(activePendingInteraction)
    : null;
  const activePendingKind = activePendingInteraction
    ? interactionKind(activePendingInteraction)
    : null;
  const pendingQuestionScroll = usePendingQuestionScroll(
    activePendingKind === 'ask_user_question' ? activePendingRequestId : null,
  );
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
    [connectionError, i18nInstance.language],
  );
  // 自动恢复类错误只影响 outbox 派发，不锁 composer；确定性错误（撤权、关闭远程
  // 控制、版本不兼容等）仍按原规则禁发。连接 issue 沿用 banner 的 active 判定，
  // unstable 属于自动恢复，其余需要用户先修复连接身份/版本。
  const activeComposerConnectionIssue = status !== 'online' || connectionIssue?.kind === 'unstable'
    ? connectionIssue
    : null;
  const composerRemoteUnavailableReason = activeComposerConnectionIssue
    && activeComposerConnectionIssue.kind !== 'unstable'
      ? connectionIssueHint(activeComposerConnectionIssue.kind)
      : describeRemoteComposerBlockingError(connectionError);
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
  // 会话尚未建成时，所有远端实时控制都不可用。cacheSeeded 不锁——那种会话在
  // 被控端是存在的，只是本地行还是瘦身缓存。断线门另由
  // remoteRealtimeControlsUnavailable 表达；两者在 canUseRemoteSessionControls
  // 汇合，但不影响 composer 输入和 outbox 排队。
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
      pendingInteractionBlocksComposer: pendingInteractionBlocksComposer && !isSharedTaskPeer(deviceId),
      remoteUnavailableReason: composerRemoteUnavailableReason,
    }),
    [composerRemoteUnavailableReason, hasActivePendingInteraction, hasCurrentSession, pendingInteractionBlocksComposer, deviceId],
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
  const creationTask = useNewSessionCreationTask(sessionId);
  // A failed chat is handing its composer to the editor. Running creation still
  // keeps the normal composer; stop further edits only during this handoff.
  const canUseComposer = sessionOperationLayout.canUseComposer && !sessionResourceCards.blocked && companionEntry.canCompose
    && creationTask?.status !== 'create-failed';
  const canUseRemoteSessionControls = canUseComposer
    && !sessionSettingsLocked
    && !remoteRealtimeControlsUnavailable;
  const canConfigureSessionModel = canUseRemoteSessionControls
    && !sessionManagedByHost
    && !isSharedTaskPeer(deviceId);
  // 共享模型自造的那两条禁发理由是中文直出,而它会经 composer 与队列行的
  // accessibility hint 读给用户 —— 按 locale 翻译后再用,否则读屏在 en / ja / ko
  // 下念混语(#530 review)。调用方自己传进去的理由(离线 / 只读 / 同步中)已本地化,
  // 此时 key 为 null,原样使用。
  const composerDisabledReasonKey = composerDisabledReasonI18nKey(
    sessionOperationLayout.composerDisabledReasonSource,
  );
  const composerDisabledReason = companionEntry.readOnly ? t('session.presentation.overview.readOnly')
    : !companionEntry.canCompose ? t('shared.syncing') : composerDisabledReasonKey
    ? t(composerDisabledReasonKey)
    : (sessionOperationLayout.composerDisabledReason
      ?? (sessionResourceCards.blocked
        ? (sessionResourceCards.blockedReason ?? t('shared.syncing'))
            : null));
  // inline 队列操作可用性:旧队列弹层由 showQueue 整体隐藏(离线/被撤销、pending
  // interaction 等),inline 化后气泡必须留在消息流里,故改为保留渲染、按同一规则
  // 禁用操作(取消/编辑/插话/重试/恢复),禁用理由沿用 composerDisabledReason。
  // 会话参数未就绪(缓存种入 / 新建在途)时队列行仍只读:取消 / 编辑 / 插队都是打到
  // 被控端队列的 RPC,会话在那边可能还不存在。暂时断线则与 Desktop 一致继续允许
  // 尝试,失败由 runQueueAction 报错,不把连接恢复职责转嫁给用户。
  const queueAvailabilityReason = cacheSeededReason
    ?? pendingCreationReason
    ?? (sessionOperationLayout.showQueue ? null : composerDisabledReason);
  // 代输入在伙伴对话里同样贴在输入框上方:它是一条入口,填写在原生表单里完成。
  const companionInlineInteraction = companionChat && pending.length > 0 && !pendingInteractionFullHeight
    && activePendingKind !== 'input_handoff';
  const showMessageHistory = companionInlineInteraction || sessionOperationLayout.messageHistoryMode === 'visible'
    || (sessionOperationLayout.messageHistoryMode === 'collapsed' && pendingHistoryExpanded);
  // 冷开即出壳:session 元信息还没回来,但不是真正不可用(离线/被撤销,看 remoteUnavailableReason)——
  // 立即渲染真壳(标题乐观显示、消息区骨架、输入框可编辑、发送禁用),而不是阻塞式占位。
  const showSyncingShell = sessionOperationLayout.composerSlot === 'missing-session'
    && !remoteUnavailableReason;
  // 无内容且读取结果未知时显示同步占位；已知远端不可用时解释历史未缓存。
  // 成功读取的历史（含恢复的空缓存）可以确认空态，新活动后的旧结果必须等待重读。
  const messageEmptyState = resolveSessionMessageEmptyState({
    loading,
    showSyncingShell,
    subscriptionIdentity: sessionSubscriptionIdentity,
    historyRead: messageHistoryRead,
    historySnapshot: historyView.snapshot,
    messageCount: messages.length,
    status,
    targetAvailable: targetAvailableForDispatch,
    remoteUnavailableReason,
    historyNotCachedMessage: t('message.renderer.historyNotCached'),
  });
  const { syncingWhileEmpty } = messageEmptyState;
  const voiceIsProcessing = voiceState === 'submitting' || voiceState === 'refining';
  const composerSendUnavailableReason = canUseComposer ? null : composerDisabledReason;
  // 手机语音只保留官方托管路径,错误引导仅剩系统麦克风权限一条。
  const canStopQueue = !!stopOptionsForProjection(inputProjection)
    && !inputProjection.queuePaused
    && !inputProjection.queueAbortPending;
  const currentTurnStreaming = useMemo(
    () => currentTurnHasStreamingAssistant(latestMessagesRef.current),
    [messageStructureToken],
  );
  // 任务空闲时预先问好要不要换号，点发送时不多等一次往返(provider-groups.md §6.2「任务进行中换号」)。
  useMobileSessionRebalancePrefetch({
    invoke,
    hostDeviceId: deviceId,
    sessionId,
    idle: status === 'online' && !remoteSessionRunning && !currentTurnStreaming,
  });
  const canStopCurrentRun = (remoteSessionRunning || currentTurnStreaming)
    && !inputProjection.queueAbortPending;
  const canStopComposer = canStopQueue || canStopCurrentRun;
  const sessionAgentKind: MobileSessionAgentKind = currentSession
    ? resolveSessionAgentKind(currentSession)
    : 'claude-code';
  const agentSwitchIntent = currentSession?.agentSwitchIntent ?? null;
  const composerDisplayAgentKind = agentSwitchIntent?.targetAgentKind ?? sessionAgentKind;
  const composerSwitchesAgent = composerDisplayAgentKind !== sessionAgentKind;
  const sessionAgentSwitchSupported = !!currentSession
    && supportsMobileSessionAgentSwitch(currentSession, capabilities);
  // Orca 的同引擎模型选择也只登记意图，保留当前执行单元直到下一次发送。
  const orcaModelSelectionUsesIntent = !!currentSession?.orcaRole && sessionAgentSwitchSupported;
  // 远程 Agent:模型列表在被控电脑自己的供应商之外,另列同账号其他电脑上开放了远程调用的供应商
  // (与桌面同一套,2026-10-07 产品裁决)。选另一台电脑的模型 = 把 Agent 挪过去,先二次确认;
  // 同一台电脑内换模型直接切。共享任务访客与 Orca 成员不能换电脑，SSH 不支持切换;
  // 旧被控端不投影 agentDeviceId 字段、也不认换位置参数,这些情况维持原有调用与展示。
  const agentLocationMovable = sessionAgentSwitchSupported
    && !isSharedTaskPeer(deviceId)
    && !!currentSession
    && !currentSession.orcaRole
    && !currentSession.orcaRemoteLead
    && Object.prototype.hasOwnProperty.call(currentSession, 'agentDeviceId');
  /** Agent 现在所在的电脑(null = 被控电脑)。 */
  const currentAgentDeviceId = sessionAgentRunsOnOtherComputer(currentSession)
    ? currentSession!.agentDeviceId!
    : null;
  // Orca 只禁换位置；Agent 已在其他电脑时，仍保留那台电脑的目录供原地选模。
  const orcaRemoteAgentDeviceId = currentSession?.orcaRole ? currentAgentDeviceId : null;
  /** 下一条消息时 Agent 所在的电脑(挂着换位置的意图就按意图)。 */
  const nextAgentDeviceId = effectiveAgentDeviceId(currentSession, agentSwitchIntent);
  const remoteAgentKeepDeviceIds = useMemo(
    () => [...new Set([currentAgentDeviceId, nextAgentDeviceId].filter((id): id is string => !!id))],
    [currentAgentDeviceId, nextAgentDeviceId],
  );
  const remoteAgentCatalogs = useRemoteAgentCatalogs({
    // 选择器打开时才读其他电脑;Agent 已在另一台电脑时还要按那台的目录显示模型药丸。
    // 共享任务访客读到的是自己账号的设备,与任务无关,不读。
    enabled: !!deviceId && !isSharedTaskPeer(deviceId) && (
      (agentLocationMovable && modelSheetOpen) || remoteAgentKeepDeviceIds.length > 0
    ),
    controlledDeviceId: deviceId,
    keepDeviceIds: remoteAgentKeepDeviceIds,
    keepOnly: !(agentLocationMovable && modelSheetOpen),
  });
  const modelSheetRemoteCatalogs = useMemo(
    () => orcaRemoteAgentDeviceId
      ? remoteAgentCatalogs.filter((catalog) => catalog.deviceId === orcaRemoteAgentDeviceId)
      : remoteAgentCatalogs,
    [orcaRemoteAgentDeviceId, remoteAgentCatalogs],
  );
  // `share:<id>` is a virtual catalog owned by the controlled computer; it is
  // not a device-link peer that the phone can open directly.
  const modelCapabilitiesDeviceId = orcaRemoteAgentDeviceId
    && !isProviderShareAgentDeviceId(orcaRemoteAgentDeviceId)
    ? orcaRemoteAgentDeviceId
    : deviceId;
  const loadComposerAgentCapabilities = useCallback(
    (agent: MobileSessionAgentKind, catalogDeviceId: string | null = orcaRemoteAgentDeviceId) =>
      (catalogDeviceId && !isProviderShareAgentDeviceId(catalogDeviceId)
        ? executionMakerForDevice(catalogDeviceId)
        : maker).getCapabilities(agent),
    [executionMakerForDevice, maker, orcaRemoteAgentDeviceId],
  );
  // 供应商组(provider-groups.md §10):这个任务此刻归哪个组,选择器每次打开问一次被控电脑。归组的任务在组那一项里
  // 选模型 = 留在此刻运行的那台只换模型(不弹换电脑确认);挂着换电脑的意图时下一条消息就不在原处,不按组显示。
  const currentProviderId = currentSession?.providerId ?? null;
  const sessionProviderGroup = useSessionProviderGroup({
    enabled: agentLocationMovable && modelSheetOpen && !intentChangesAgentLocation(agentSwitchIntent),
    hostDeviceId: deviceId,
    sessionId,
    routeKey: JSON.stringify([currentAgentDeviceId, currentProviderId]),
  });
  const remoteProviderGroup = useMemo(
    () => ({
      bound: sessionProviderGroup,
      running: { deviceId: currentAgentDeviceId, providerId: currentProviderId },
    }),
    [sessionProviderGroup, currentAgentDeviceId, currentProviderId],
  );
  // 协同 Worker 的模型选择器:与任务模型列表同一份远程供应商(其他电脑与分享)，Worker 的 Agent
  // 现在选的位置即使掉线也保留。只在 Worker 选择器打开时读。
  const workerAgentKeepDeviceIds = useMemo(
    () => [...new Set([currentAgentDeviceId, collab.workerForm.form.agentDeviceId]
      .filter((id): id is string => !!id))],
    [currentAgentDeviceId, collab.workerForm.form.agentDeviceId],
  );
  const workerAgentCatalogs = useRemoteAgentCatalogs({
    enabled: !!deviceId
      && !isSharedTaskPeer(deviceId)
      && collab.workerForm.agentLocationSelectable
      && collab.workerForm.modelPicker.open,
    controlledDeviceId: collabWorkerDeviceId,
    keepDeviceIds: workerAgentKeepDeviceIds,
  });
  // Agent 在另一台电脑时,模型 / 来源都属于那台的目录:展示与校验按那份,读不到时按加载中处理。
  const agentCatalogFor = useCallback((agentDeviceId: string | null) => {
    if (!agentDeviceId) return composerDeviceProviders;
    const catalog = remoteAgentCatalogs.find((item) => item.deviceId === agentDeviceId);
    return {
      providers: catalog?.providers ?? EMPTY_PROVIDER_VIEWS,
      modelVisibilityOverrides: catalog?.modelVisibilityOverrides,
      loading: !catalog || catalog.status === 'loading',
      // 读不到那台电脑的目录不等于来源被断开:不报错,药丸退回不带来源的写法。
      error: null,
    };
  }, [composerDeviceProviders, remoteAgentCatalogs]);
  const currentAgentCatalog = useMemo(
    () => agentCatalogFor(currentAgentDeviceId),
    [agentCatalogFor, currentAgentDeviceId],
  );
  const composerAgentCatalog = useMemo(
    () => agentCatalogFor(nextAgentDeviceId),
    [agentCatalogFor, nextAgentDeviceId],
  );
  // 任务菜单的账号余量读 Agent 现在所在那台(远程 Agent):手机直接经 device-link 读它,与读它的
  // 模型目录同一条路;分享来的供应商等读不到,只显示任务价值。任务价值与上下文仍读被控电脑。
  const usageAccount = resolveSessionUsageAccount({
    agentDeviceId: currentAgentDeviceId,
    providerId: currentSession?.providerId,
    sharedTaskGuest: isSharedTaskPeer(deviceId),
    remoteHostId: currentSession?.remoteHostId,
  });
  const agentAccountMaker = useMobileMakerTransport(
    usageAccount.kind === 'device' ? usageAccount.deviceId : deviceId,
  );
  const menuAccountReader = usageAccount.kind === 'host'
    ? maker
    : usageAccount.kind === 'device' ? agentAccountMaker : null;
  /** 菜单上的来源与登录身份:Agent 在另一台电脑时按那台的目录,不借被控电脑的同名来源。 */
  const menuAccountProvider = usageAccount.kind !== 'host'
    ? currentAgentCatalog.loading
        ? undefined
        : currentAgentCatalog.providers.find((provider) => provider.id === currentSession?.providerId,
          )
    : accountProvider;
  const runtimeOptions = useMemo(
    () => currentSession ? buildSessionRuntimeOptions(currentSession, capabilities) : null,
    [capabilities, currentSession],
  );
  // 任务菜单用量卡的模型名:能力目录 / 供应商目录里的展示名,找不到时由卡片自行兜底(不直接露原始 id)。
  const sessionModelDisplayName = useMemo((): string | null => {
    const model = currentSession?.model?.trim();
    if (!model) return null;
    const fromRuntime = runtimeOptions?.currentModel?.label?.trim();
    if (fromRuntime && fromRuntime !== model) return fromRuntime;
    const providers = currentAgentCatalog.providers;
    const ordered = currentSession?.providerId
      ? [...providers.filter((p) => p.id === currentSession.providerId), ...providers.filter((p) => p.id !== currentSession.providerId)]
      : providers;
    for (const provider of ordered) {
      const catalogs: ReadonlyArray<ReadonlyArray<{ id: string; name?: string }> | undefined> = Object.values(provider.models ?? {});
      for (const models of catalogs) {
        const match: { id: string; name?: string } | undefined = models?.find((item) => item.id === model);
        const name: string | undefined = match?.name?.trim();
        if (name && name !== model) return name;
      }
    }
    return null;
  }, [currentAgentCatalog.providers, currentSession?.model, currentSession?.providerId, runtimeOptions]);
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
    // effort / 权限标签按 app 语言解析,切换语言时必须重算,否则停留在上一语言。
    [composerDisplayRuntimeOptions, composerDisplaySession, i18nInstance.language],
  );
  // 被控端供应商目录 → provider-aware 模型分段(与新建会话页同逻辑;0 供应商回退扁平 modelOptions)。
  // Agent 下一条消息在另一台电脑运行时,模型与来源属于那台的目录。
  const composerModelSections = useMemo(
    () => composerDisplaySession
      ? buildMobileModelSections({
          providers: composerAgentCatalog.providers,
          agentKind: composerDisplayAgentKind,
          selectedModelId: composerDisplaySession.model,
          selectedProviderId: composerDisplaySession.providerId ?? null,
          visibilityOverrides: composerAgentCatalog.modelVisibilityOverrides,
          // 已建会话:实际路由口径(运行中会话跟真实扣费路由,含停用拷贝)。
          existingSessionRoute: true,
        })
      : null,
    [composerAgentCatalog.providers, composerAgentCatalog.modelVisibilityOverrides, composerDisplayAgentKind, composerDisplaySession],
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
    // Agent 在另一台电脑运行:凭证在那台,被控电脑没登录不影响发送。
    if (currentAgentDeviceId) return null;
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
    currentAgentDeviceId,
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
  // 打开选择器时先展示待生效的跨 Harness 配置；setState 更新 agentKind 前，
  // 也不能让当前运行模型覆盖这份 intent。
  const modelSheetUsesIntent = Boolean(
    agentSwitchIntent?.targetAgentKind
      && (agentSwitchIntent.targetAgentKind === modelSheetAgentKind
        || (modelSheetOpen && modelSheetAgentKind === sessionAgentKind)),
  );
  const modelSheetIntent = modelSheetUsesIntent ? agentSwitchIntent : null;
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
        model: modelSheetIntent ? modelSheetIntent.model : modelSheetAgentKind === sessionAgentKind ? currentSession.model : '',
        providerId: modelSheetIntent ? modelSheetIntent.providerId : modelSheetAgentKind === sessionAgentKind ? (currentSession.providerId ?? null)
            : null,
        effort: modelSheetIntent ? (modelSheetIntent.effort ?? '')
          : modelSheetAgentKind === sessionAgentKind ? currentSession.effort : '',
        fastMode: modelSheetIntent ? (modelSheetIntent.fastMode ?? false)
          : modelSheetAgentKind === sessionAgentKind ? currentSession.fastMode : false,
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
      ? (composerModelSections.connected.find((p) => p.id === composerModelSections.activeSourceId) ?? null)
        : null,
    [composerModelSections],
  );
  // 会话持久化的显式来源可能在电脑端被断开。此时不能把 activeSourceId 的默认回退
  // 画成真实来源，否则手机会显示「默认来源 Logo」，发送却仍按已断开的 providerId 路由。
  // provider 列表加载期间不判，避免首帧短暂闪出断开态。
  const composerSelectedSourceDisconnected = useMemo(() => {
    if (!composerDisplaySession) return false;
    return isSelectedSourceDisconnected({
      providers: composerAgentCatalog.providers,
      providerId: composerDisplaySession.providerId,
      modelId: composerDisplaySession.model,
      agentKind: composerDisplayAgentKind,
      loading: composerAgentCatalog.loading,
      error: composerAgentCatalog.error,
    });
  }, [
    composerAgentCatalog.error,
    composerAgentCatalog.loading,
    composerAgentCatalog.providers,
    composerDisplaySession,
    composerDisplayAgentKind,
  ]);
  const composerPillSourceProvider = useMemo(() => {
    if (!composerSelectedSourceDisconnected) return composerActiveSourceProvider;
    return (
      composerAgentCatalog.providers.find(
      (provider) => provider.id === composerDisplaySession?.providerId,
    ) ?? null
    );
  }, [
    composerActiveSourceProvider,
    composerAgentCatalog.providers,
    composerSelectedSourceDisconnected,
    composerDisplaySession?.providerId,
  ]);
  const composerPillSourceId = composerSelectedSourceDisconnected
    ? (composerDisplaySession?.providerId ?? null)
    : (composerPillSourceProvider?.id ?? null);
  const composerPillFastOn = agentSwitchIntent
    ? (agentSwitchIntent.fastMode ?? false)
    : !composerSelectedSourceDisconnected && rowFastEditable({
        provider: composerActiveSourceProvider ?? undefined,
        modelId: currentSession?.model ?? '',
        agentKind: sessionAgentKind,
        hasFastModeCap: capabilities?.hasFastMode === true,
      }) && (currentSession?.fastMode ?? false);
  const composerRuntimeLabel = composerRuntimeSummary
    ? agentSwitchIntent && composerSwitchesAgent
      ? `${mobileAgentLabel(agentSwitchIntent.targetAgentKind)} · ${composerRuntimeSummary.modelSummary}`
      : composerRuntimeSummary.modelSummary
    : '';
  // 按钮省去时机前缀，读屏仍说明待生效选择，避免被误认为当前运行配置。
  const composerRuntimeAccessibilitySummary = composerRuntimeSummary && agentSwitchIntent
    ? t(composerSwitchesAgent ? 'session.screen.nextAgentSwitch' : 'session.screen.nextModelSelection', {
        agent: mobileAgentLabel(agentSwitchIntent.targetAgentKind),
        model: composerRuntimeSummary.modelSummary,
      })
    : composerRuntimeLabel;
  // 下一条消息时 Agent 所在的另一台电脑名(药丸带远程标记,读屏一并读出);目录在缺名时以 deviceId
  // 兜底,那种情况不读出来。
  const nextAgentDeviceName = nextAgentDeviceId
    ? (remoteAgentCatalogs.find((item) => item.deviceId === nextAgentDeviceId)?.name ?? null)
    : null;
  const composerRuntimeAccessibilityLabel = nextAgentDeviceName && nextAgentDeviceName !== nextAgentDeviceId
    ? [composerRuntimeAccessibilitySummary, nextAgentDeviceName].filter(Boolean).join(', ')
    : composerRuntimeAccessibilitySummary;
  // 换电脑确认里的被控电脑名;路由参数缺设备名时会以 deviceId 兜底,那不是给人看的名字。
  const controlledComputerName = (() => {
    const name = currentSession?.deviceLinkDeviceName?.trim();
    return name && name !== deviceId ? name : null;
  })();
  const remoteAgentDeviceName = useCallback(
    (agentDeviceId: string) =>
      deviceDisplayName(agentDeviceId, undefined, remoteAgentCatalogs),
    [remoteAgentCatalogs],
  );
  const adaptiveWindow = useAdaptiveWindow();
  const paneLayout = useSessionPaneLayout();
  const horizontalSystemHeader = Platform.OS === 'ios' && adaptiveWindow.barEdge === 'none'
    && !paneLayout.persistent && !shareSelectionActive;
  const composerRegion = keyboardControlRegion(adaptiveWindow, keyboardState.height);
  const detailViewport = useMemo(() => ({ x: paneLayout.detail.x, y: paneLayout.detail.y, width: paneLayout.detail.width, height: windowDimensions.height }),
    [paneLayout.detail.x, paneLayout.detail.y, paneLayout.detail.width, windowDimensions.height]);
  const nativeShellLayout = useMemo(() => buildSessionNativeShellLayout({
    attachmentPickerOpen: false,
    keyboardHeight: keyboardState.height,
    keyboardVisible: keyboardState.visible,
    paletteOpen: false,
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    safeAreaBottomInset: insets.bottom,
    screenHeight: windowDimensions.height,
    screenWidth: detailViewport.width,
  }), [
    insets.bottom,
    keyboardState.height,
    keyboardState.visible,
    windowDimensions.height,
    detailViewport.width,
  ]);
  const composerDock = useComposerDock();
  const composerTouchLayout = useMemo(() => ({ ...buildComposerTouchLayout({ screenWidth: detailViewport.width }),
    ...(composerDock.enabled ? { composerPaddingHorizontal: composerGeometry.horizontalInset } : {}),
  }), [detailViewport.width, composerDock.enabled]);
  // Wide nonpersistent windows offer quick switching separately from back navigation.
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
  // iOS 系统导航栏在 RN 内容之上,临时抽屉的 zIndex 盖不住它:抽屉存续期间收起系统栏,
  // 抽屉自身的弹层(选项、改名、下拉菜单)仍在树内正常弹出。收起期间沿用打开前的顶栏
  // 高度,遮罩下的聊天内容不跳动。
  const nativeHeaderHeight = useSessionHeaderHeight(JSON.stringify([
    windowDimensions.width, windowDimensions.height, windowDimensions.fontScale,
    insets.top, insets.bottom, insets.left, insets.right, adaptiveWindow.barEdge,
  ]), sessionListDrawerOverlayMounted);
  // Duo shares the status area with its native toolbar. Its measured height
  // already includes that area; safeArea.top + 44 would count the toolbar twice.
  const topChromeHeight = Math.max(topOverlayHeight,
    horizontalSystemHeader ? nativeHeaderHeight : insets.top + navigationChrome.target);
  // The drawer hides that toolbar; put the drawer's own header in the same row instead of
  // below the whole status area.
  const sessionListDrawerTopInset = horizontalSystemHeader
    ? sharedStatusRowDrawerTop(nativeHeaderHeight, insets.top) : undefined;
  // 退出宽屏后 layout.drawerWidth 会变 0;退场期间继续用最后一个有效宽度,避免面板几何跳变。
  const sessionListDrawerWidthRef = useRef(wideSessionNav.drawerWidth);
  if (wideSessionNav.enabled) sessionListDrawerWidthRef.current = wideSessionNav.drawerWidth;
  // 抽屉里的导航动作必须等退场动画结束、GestureDetector/Reanimated overlay 真正
  // 卸载后再执行。Android 原生 Screen 换页与该子树卸载同帧存在 native crash 竞态。
  const pendingDrawerNavigationRef = useRef<(() => void) | null>(null);
  // pending 只能拦住「首击本身就是导航」的连点;遮罩/back/左滑/当前任务先关闭时 pending
  // 仍为空。closing 从任一关闭入口同步置 true,完整覆盖退场 commit 前的快速二次点击。
  const sessionListDrawerClosingRef = useRef(false);
  const openSessionListDrawer = useCallback(() => {
    if (!wideSessionNav.enabled || paneLayout.persistent || sessionListDrawerClosingRef.current) return;
    setSessionListDrawerOverlayMounted(true);
    setSessionListDrawerOpen(true);
  }, [paneLayout.persistent, wideSessionNav.enabled]);
  const closeSessionListDrawer = useCallback(() => {
    if (!sessionListDrawerOverlayMounted) return;
    if (sessionListDrawerClosingRef.current) return;
    sessionListDrawerClosingRef.current = true;
    setSessionListDrawerOpen(false);
  }, [sessionListDrawerOverlayMounted]);
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
  const queueDrawerNavigation = useCallback((action: () => void) => {
    // closing 覆盖所有关闭来源,包括 pending 为空的纯关闭;首个意图获胜。
    if (sessionListDrawerClosingRef.current || pendingDrawerNavigationRef.current) return;
    if (paneLayout.persistent && !sessionListDrawerOverlayMounted) { action(); return; }
    sessionListDrawerClosingRef.current = true;
    pendingDrawerNavigationRef.current = action;
    setSessionListDrawerOpen(false);
  }, [paneLayout.persistent, sessionListDrawerOverlayMounted]);
  const handleSessionListDrawerClosed = useCallback(() => {
    const action = pendingDrawerNavigationRef.current;
    sessionListDrawerClosingRef.current = false;
    setSessionListDrawerOverlayMounted(false);
    if (!action) return;
    pendingDrawerNavigationRef.current = null;
    action();
  }, []);
  useEffect(() => {
    if (!paneLayout.persistent || !sessionListDrawerOverlayMounted) return;
    setSessionListDrawerOpen(false);
    closeSessionListDrawer();
  }, [paneLayout.persistent, sessionListDrawerOverlayMounted, closeSessionListDrawer]);
  const handleDrawerSelectSession = useCallback((item: RemoteSessionListItem) => {
    const targetSession = item.session as RemoteSession;
    const focusClientId = 'searchFocusClientId' in item
      ? (item as { searchFocusClientId?: string }).searchFocusClientId
      : undefined;
    if (targetSession.id === sessionId && !focusClientId && !('searchLocallyCached' in item)) {
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
        deviceName: deviceDisplayName(targetDeviceId, targetSession.deviceLinkDeviceName),
        sessionId: targetSession.id,
        ...(focusClientId ? { focusClientId } : {}),
      });
    });
  }, [closeSessionListDrawer, navigation, queueDrawerNavigation, sessionId, t]);
  // 前进导航防连点:快速双击「新建」会把 /sessions/new 压栈两层(返回要退两次),
  // 与首页各入口同一把 guardedPush 锁。
  const guardedPush = useGuardedPush();
  const homeNewSessionActionRef = newSessionActionRef;
  const handleDrawerNewSession = useCallback(() => {
    if (homeNewSessionActionRef.current) { homeNewSessionActionRef.current(); return; }
    queueDrawerNavigation(() => {
      guardedPush({ pathname: '/sessions/new', params: { deviceId, deviceName } });
    });
  }, [deviceId, deviceName, guardedPush, queueDrawerNavigation]);
  // 诊断任务建在出错任务所在的电脑上，链接不带 device；共享任务的访客读不到原任务，不提供。
  const canDiagnoseError = !!deviceId && !!sessionId && !isSharedTaskPeer(deviceId);
  const handleDiagnoseError = useCallback((source: ErrorDiagnosisSource) => {
    if (!deviceId || !sessionId) return;
    guardedPush({
      pathname: '/sessions/new',
      params: {
        deviceId,
        deviceName,
        deviceExplicit: '1',
        draft: buildErrorDiagnosisPrompt(t, buildMobileSessionDeepLink(sessionId), source),
      },
    });
  }, [deviceId, deviceName, guardedPush, sessionId, t]);
  const handleComposerInputPressIn = useCallback(() => {
    if (voiceRecordingActiveRef.current || voiceState === 'listening') {
      // Tapping the input to stop dictation means the user wants to type.
      finishVoiceRecordingRef.current?.({ focusInput: true });
    }
  }, [voiceState]);
  const openSessionMenu = useCallback((view: SessionMenuView = 'menu') => {
    setMenuInitialView(view);
    setSettingsOpen(true);
  }, []);
  const handleSessionMenuClosed = useCallback(() => {
    if (sideChatsPendingOpen) {
      setSideChatsPendingOpen(false);
      setSideChatsOpen(true);
    }
    if (sessionSearchPendingOpen) {
      setSessionSearchPendingOpen(false);
      setSearchOpen(true);
    }
  }, [sessionSearchPendingOpen, sideChatsPendingOpen]);
  const measureSendButtonTarget = useCallback(() => {
    sendButtonRef.current?.measureInWindow((x, y, width, height) => {
      sendButtonFrameRef.current = { x, y, width, height };
    });
  }, []);
  const isPointInsideSendButton = useCallback((event: GestureResponderEvent) => {
    const frame = sendButtonFrameRef.current;
    if (!composerSendTargetEnabledRef.current || !frame || !canUseComposer) return false;
    const { pageX, pageY } = event.nativeEvent;
    const pad = 10;
    return (
        pageX >= frame.x - pad
      && pageX <= frame.x + frame.width + pad
      && pageY >= frame.y - pad
      && pageY <= frame.y + frame.height + pad
      );
  }, [canUseComposer]);
  const updateVoiceReleaseToSendTarget = useCallback((event: GestureResponderEvent): boolean => {
    const active = voiceLongPressActiveRef.current && isPointInsideSendButton(event);
    setVoiceReleaseToSendActive(active);
    return active;
  }, [isPointInsideSendButton]);
  // Bottom padding the message list needs to clear the composer = the composer's own height only.
  // The keyboard lift is already applied once by ComposerKeyboardAvoidingView,
  // so ALSO adding keyboardBottomInset here double-counted the keyboard and shoved the conversation
  // up (badly visible once the list bottom-anchors its content). Keyboard-closed is unchanged —
  // keyboardBottomInset is 0 then, so this matches the previous value.
  const bottomOverlayHeight = useMemo(
    () => Math.ceil(bottomOverlayContentHeight),
    [bottomOverlayContentHeight],
  );
  // Android 输入区与顶栏一样半透明:整块挂到根浮层盖在常驻消息层上。伙伴对话保持实底。
  const androidFrostedComposer = Platform.OS === 'android' && !companionChat;
  // 浮层不在键盘避让容器里,按容器缩高后的实际高度摆放,输入框才会被键盘照旧顶上去。
  const [keyboardAreaHeight, setKeyboardAreaHeight] = useState<number | null>(null);
  const handleKeyboardAreaLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height);
    setKeyboardAreaHeight((current) => (current === next ? current : next));
  }, []);

  const applyComposerDocument = useCallback((
    value: ComposerDocument,
    options?: { persist?: boolean },
  ) => {
    composerDocumentRef.current = value;
    const projected = composerDocumentProjectedText(value);
    draftRef.current = projected;
    const pendingSkill = pendingSkillSelectionRef.current;
    const head = /^\/([a-z][\w-]*)/i.exec(projected.trimStart());
    if (pendingSkill && (pendingSkill.sid !== sessionId || head?.[1].toLowerCase() !== pendingSkill.name.toLowerCase())) {
      pendingSkillSelectionRef.current = null;
    }
    composerDraftSource.setDocument(value);
    voiceDictionaryLearningTrackerRef.current?.inspectDraft(projected);
    if (options?.persist !== false) {
      saveComposerDocumentDraft(sessionId, value);
      // Keep the legacy string mirror during the one-way migration window so
      // older builds do not turn a rich draft into an empty composer.
      saveComposerDraft(sessionId, projected);
    }
  }, [composerDraftSource, sessionId]);

  const applyComposerDraft = useCallback((value: string, options?: { persist?: boolean }) => {
    const document = reconcileComposerProjectedText(composerDocumentRef.current, value);
    applyComposerDocument(document, options);
  }, [applyComposerDocument]);

  const replaceComposerDraft = useCallback((value: string, options?: { persist?: boolean }) => {
    applyComposerDocument(textComposerDocument(value), options);
  }, [applyComposerDocument]);

  const applyRichComposerChange = useCallback((value: ComposerDocument) => {
    applyComposerDocument(value, queueEditingRef.current || messageEditingRef.current ? { persist: false } : undefined);
  }, [applyComposerDocument]);

  const setComposerDraft = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    // 排队编辑模式下 composer 内容是临时编辑文本,一律不写草稿库(对所有调用方
    // 生效:键入 / 语音 / 面板插入 / send 的乐观清空与失败恢复)。草稿库全程保留
    // 进入编辑前的原草稿,中途导航离开 / 杀进程后恢复的是用户自己的未发送草稿
    // (PR#709 review P1);退出编辑时 cancelQueueEdit 先清 ref 再回填 stash,
    // 那一拍恢复正常持久化,草稿库与内存重新对齐。
    applyComposerDraft(value, queueEditingRef.current || messageEditingRef.current ? { persist: false } : undefined);
  }, [applyComposerDraft]);

  useIncomingShareComposer({
    destination: [incomingShareDestination(deviceId, sessionId), incomingShareDestination(deviceId, sessionId, {
      collectionId: readRouteParam(params.resourceCollectionId) ?? '',
      kind: readRouteParam(params.resourceKind) ?? '', id: readRouteParam(params.resourceId) ?? '',
    })],
    ready: composerDraftHydrated && canUseComposer && companionEntry.ready && !queueEditingRef.current && !messageEditingRef.current,
    appendText: (text) =>
      setComposerDraft((current) => [current, text].filter(Boolean).join('\n\n')),
    attachmentCount: attachments.length,
    enqueueUploads, getPendingUploadCount, onError: setAttachmentError,
  });

  // 开始打字（含粘贴）或开始语音输入时请被控端提前启动 Agent，把冷启动藏进输入时间。同一任务 30 秒最多提醒一次；
  // 任务在跑、在排队编辑或旧被控端不支持时什么都不做。
  const lastAgentPrewarmRef = useRef<{ at: number; settings: string } | null>(null);
  const prewarmAgentOnTyping = useCallback(() => {
    if (queueEditingRef.current) return;
    const session = remoteSessionStore.getSessions().find((item) => item.id === sessionId) ?? currentSession;
    if (!session?.workingDir || remoteSessionStore.isSessionRunning(sessionId)) return;
    const now = Date.now();
    const { createOpts } = buildQueuedTextMessage(session, '', new Date(now));
    const settings = JSON.stringify([
      createOpts.agentKind,
      createOpts.workingDir,
      createOpts.model,
      createOpts.providerId ?? null,
      createOpts.effort,
      createOpts.permissionMode,
      createOpts.fastMode ?? null,
    ]);
    const last = lastAgentPrewarmRef.current;
    if (last && last.settings === settings && now - last.at < MOBILE_AGENT_PREWARM_INTERVAL_MS) return;
    lastAgentPrewarmRef.current = { at: now, settings };
    void maker.prewarmSession(sessionId, createOpts).catch(() => undefined);
  }, [currentSession, maker, sessionId]);
  const applyTypedComposerChange = useCallback((value: ComposerDocument) => {
    applyRichComposerChange(value);
    prewarmAgentOnTyping();
  }, [applyRichComposerChange, prewarmAgentOnTyping]);
  const setTypedComposerDraft = useCallback((next: SetStateAction<string>) => {
    setComposerDraft(next);
    prewarmAgentOnTyping();
  }, [prewarmAgentOnTyping, setComposerDraft]);

  const writeVoiceDraft = useComposerVoiceDraftWriter(sessionId, (update: ComposerVoiceDraftUpdate) => {
    applyRichComposerChange(reconcileComposerVoiceDraft(composerDocumentRef.current, update));
  });

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
    setSessionSearchPendingOpen(false);
    setSettingsOpen(false);
    setQueueSelectedClientId(null);
    // ref 与 state 同步清:解锁已由下方 cleanup effect(旧 sessionId 闭包)在本
    // effect body 之前完成,这里再清 ref 是幂等的,保证两者时刻一致。
    queueEditingRef.current = null;
    setQueueEditing(null);
    // 消息编辑文本从未写入草稿库(persist:false),原草稿天然保留;stash 不跨任务恢复。
    messageEditSeqRef.current += 1;
    messageEditingRef.current = null;
    setMessageEditing(null);
    messageEditLockGenerationRef.current += 1;
    messageEditSubmittingRef.current = false;
    setMessageEditSubmitting(false);
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
    if (canUseRemoteSessionControls) return;
    setModelSheetOpen(false);
    setPermissionSheetOpen(false);
  }, [canUseRemoteSessionControls]);

  useEffect(() => {
    if (!canConfigureSessionModel) setModelSheetOpen(false);
  }, [canConfigureSessionModel]);

  useEffect(() => {
    if (!sessionManagedByHost) return;
    setSettingsOpen(false);
    setModelSheetOpen(false);
    if (contextSheetView !== 'main') {
      setContextSheetView('main');
      setContextSheetOpen(false);
    }
  }, [contextSheetView, sessionManagedByHost]);

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

    void reconcileMobileOutboxDrafts(sessionId).then(() => Promise.all([
      quoteHydration,
      readComposerDocumentDraft(sessionId),
      readComposerDraft(sessionId),
    ])).then(([, storedDocument, storedDraft]) => {
      if (cancelled || appliedRouteDraftRef.current !== key) return;
      const hydratedQuotes = [...getQuotes(sessionId)];
      const fallbackText = storedDraft ?? routeDraft ?? '';
      const ordered = resolveOrderedQuoteDraft…83670 tokens truncated…|| !forkedAtMessageId) return;
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

  // 「由任务「X」发送」来源标签:工具只在同一设备的任务之间投递,来源任务与当前任务同设备。
  const openOriginSession = useCallback((originSessionId: string) => {
    if (!deviceId || !originSessionId || originSessionId === sessionId) return;
    router.push({
      pathname: '/sessions/[sessionId]',
      params: { sessionId: originSessionId, deviceId, deviceName },
    });
  }, [deviceId, deviceName, router, sessionId]);

  // 「从手机 / 电脑「X」发送」设备标签点击:打开设备详情。设备清单已加载且不含该设备时
  // 直接提示已移除;清单还没拉到时照常进入详情页,由详情页给出「未找到」。
  const openSourceDevice = useCallback((sourceDeviceId: string) => {
    if (isSourceDeviceRemoved(sourceDeviceId, remoteSessionStore.getDeviceIdentity())) {
      Alert.alert(t('message.renderer.sourceDeviceRemoved'));
      return;
    }
    router.push({
      pathname: '/devices/manage/[deviceId]',
      params: { deviceId: sourceDeviceId },
    });
  }, [router, t]);

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
    // 设备口径与 devices/index openSession 一致:可达优先(canonical → 物理 → 注册表);
    // 列表里没有的(已归档 / 尚未同步)退回深链冻结设备、当前任务所在设备。
    const targetSession = remoteSessionStore.getSessions().find((item) => item.id === target.sessionId);
    const targetDeviceId = resolveSessionLinkDeviceId({
      listedDeviceId: targetSession?.canonicalDeviceId
        ?? targetSession?.deviceLinkDeviceId
        ?? remoteSessionStore.getSessionDeviceId(target.sessionId),
      linkedDeviceId: target.deviceId,
      currentDeviceId: deviceId,
    });
    if (!targetDeviceId) {
      setError(t('session.screen.sessionDeviceNotFound'));
      return;
    }
    router.push({
      pathname: '/sessions/[sessionId]',
      params: {
        sessionId: target.sessionId,
        deviceId: targetDeviceId,
        deviceName: targetSession?.deviceLinkDeviceName
          ?? (targetDeviceId === deviceId ? deviceName : undefined)
          ?? targetDeviceId,
        ...(target.messageClientId
          ? {
              focusClientId: target.messageClientId,
              focusRequestKey: String(Date.now()),
            }
          : {}),
      },
    });
  }, [deviceId, deviceName, router, sessionId, setError, t]);

  // 长按/操作条「复制消息链接」:复制带消息锚点的会话深链,可跨端粘贴跳转。
  // 冻结当前任务所在设备:目标归档 / 未同步后,从别的电脑的任务里点开也能找到它。
  const copyMessageLink = useCallback((clientId: string) => {
    if (!sessionId) return;
    void copyMessageText(buildMobileSessionMessageDeepLink(sessionId, clientId, { session: currentSession, deviceId }));
  }, [currentSession, deviceId, sessionId]);

  const resolvePastedSessionLinkLabel = useCallback(async (href: string) => {
    const target = parseSessionDeepLinkUrl(href);
    if (!target) return null;
    const targetSession = remoteSessionStore.getSessions().find((item) => item.id === target.sessionId);
    const targetDeviceId = resolveSessionLinkDeviceId({
      listedDeviceId: targetSession?.canonicalDeviceId
        ?? targetSession?.deviceLinkDeviceId
        ?? remoteSessionStore.getSessionDeviceId(target.sessionId),
      linkedDeviceId: target.deviceId,
      currentDeviceId: deviceId,
    });
    const targetMaker = targetDeviceId
      ? targetDeviceId === deviceId
          ? maker
          : createMobileMakerTransport({ deviceId: targetDeviceId, invoke })
      : null;

    try {
      if (target.messageClientId) {
        let targetMessage = remoteSessionStore.getMessages(target.sessionId).find((message) =>
                message.clientId === target.messageClientId || message.id === target.messageClientId,
            );
        if (!targetMessage && targetMaker && targetDeviceId) {
          await openLink(targetDeviceId);
          const around = await targetMaker.aroundMessagesByClientId(
            target.sessionId,
            target.messageClientId,
            { radius: 1 },
          );
          targetMessage = around.find((message) =>
                message.clientId === target.messageClientId || message.id === target.messageClientId,
            );
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

  // Read messages through the ref: this callback reaches every row via `actions`, so a
  // `messages` dependency would re-render all visible rows (Markdown included) on every
  // streaming flush. The lookup only needs the list as it is at tap time.
  const addMessageToComposer = useCallback((clientId: string) => {
    if (!sessionId || !canUseComposer) return;
    const target = latestMessagesRef.current.find((message) => message.clientId === clientId || message.id === clientId,
      );
    const summary = target ? mobileSessionMessageDisplayText(target) : null;
    const bounded = summary ? boundAgentReferenceText(summary) : null;
    const node = sessionLinkComposerNode({
      href: buildMobileSessionMessageDeepLink(sessionId, clientId, { session: currentSession, deviceId }),
      label: compactSessionMessageLabel(summary ?? clientId),
      titled: true,
      ...(bounded?.text ? { agentText: bounded.text } : {}),
      ...(bounded?.truncated ? { agentTextTruncated: true } : {}),
    });
    const editor = composerInputRef.current;
    if (editor) editor.insertNode(node);
    else applyComposerDocument(appendComposerNode(composerDocumentRef.current, node));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [applyComposerDocument, canUseComposer, currentSession, deviceId, sessionId]);

  // 伙伴近况里点一条待办：作为待办引用放进输入框，主人写一句话交代，伙伴按话更新它。
  const quoteTodoInComposer = useCallback((todo: { id: string; title: string }) => {
    if (!canUseComposer || !companionResource) return;
    const node = todoReferenceComposerNode({ botId: companionResource.ref.id, todoId: todo.id, title: todo.title });
    const editor = composerInputRef.current;
    if (editor) editor.insertNode(node);
    else applyComposerDocument(appendComposerNode(composerDocumentRef.current, node));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [applyComposerDocument, canUseComposer, companionResource]);

  // 伙伴近况里的「帮我查查」：输入框空着就作为主人的一句话直接发出（与手动发送同一条路径，带来源设备）；
  // 已有草稿或附件时不替主人连同草稿一起发，只把这句话放进输入框。
  const askCompanionInComposer = useCallback((text: string) => {
    if (!canUseComposer || !composerDraftHydrated) return;
    const idle = !composerDocumentHasContent(composerDocumentRef.current)
      && attachments.length === 0 && pendingUploads.length === 0 && !queueEditingRef.current;
    if (idle && sendLatestRef.current) {
      void sendLatestRef.current({ documentOverride: textComposerDocument(text) });
      return;
    }
    const node = { type: 'text' as const, text: composerDocumentHasContent(composerDocumentRef.current) ? `\n${text}` : text };
    const editor = composerInputRef.current;
    if (editor) editor.insertNode(node);
    else applyComposerDocument(appendComposerNode(composerDocumentRef.current, node));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [applyComposerDocument, attachments.length, canUseComposer, composerDraftHydrated, pendingUploads.length]);

  const deleteMessage = useCallback((clientId: string) => {
    if (!deviceId || messageActionBusy) return;
    // 运行中能否删由被控端判定:点停止后本地运行态可能晚于被控端收敛,
    // 不能拿它挡住已经停下的任务。被控端拒绝(SESSION_RUNNING)时再提示等回复结束。
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
              if (isSessionRunningRemoteError(err)) {
                Alert.alert(t('session.screen.deleteMessageBusy'));
              } else {
                setError(formatRemoteError(err));
              }
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
      const updated = await maker.rewindCommit(
        sessionId,
        state.clientId,
        rewindCommitBindOpts(state),
      );
      // applySessionPatch 按显式 sessionId 写目标 session 的分片,与当前浏览无关,即使用户已切走
      // 也必须执行,否则该 session 的回撤结果丢失——不受下面 guard 影响。
      remoteSessionStore.applySessionPatch(deviceId, sessionId, updated);
      if (rewindRequestSeqRef.current !== seq) {
        // 远端 rewind 已成功，但这个页面代际不再拥有目标会话的消息写权限。
        // 失效内存/磁盘窗口并登记刷新；当前若已切回会自动 load，否则下次打开重拉。
        remoteSessionStore.invalidateSessionMessageWindow(sessionId, deviceId);
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

  const pendingInteractionDock = sessionOperationLayout.composerSlot === 'pending-interaction';
  const dockKeyboardFollow = Platform.OS === 'ios' && composerDock.enabled && nativeComposerFrameAvailable
    && adaptiveWindow.regions.length === 0
    && (sessionOperationLayout.composerSlot === 'editable' || pendingInteractionDock)
    && !shareSelectionActive && !isSharedTaskAccessRevoked;
  const companionHeaderShown = companionChat && !!companionResource && !shareSelectionActive;
  const headerNode = (
    <>
    <Stack.Screen options={{ gestureEnabled: !sessionListDrawerOverlayMounted }} />
    {companionHeaderShown ? (
        <>
      {horizontalSystemHeader ? null : (
            <Stack.Screen options={COMPANION_NATIVE_HEADER_OPTIONS} />
          )}
      {companionEntry.threadRootSessionId ? (
            <ChatIdentityHeader nativeHeader={horizontalSystemHeader}
        testIDPrefix="companion.thread" mark={companionPortrait(32)} title={t('groupChat.thread.title')}
        subtitle={companionName} identityLabel={t('groupChat.thread.title')} onBack={goBackToHome} />
          ) : (
            <CompanionHeader key={`${auth.accountGeneration}:${deviceId}:${companionResource.ref.id}`}
        nativeHeader={horizontalSystemHeader}
        resource={companionResource} deviceId={deviceId} deviceName={deviceName} online={!remoteUnavailableReason} controlsReady={companionEntry.ready}
        settingsRequest={companionSettingsRequest?.sessionId === sessionId ? companionSettingsRequest : undefined}
        working={!!companionWorkingLabel}
        sessionId={sessionId ?? ''}
        onQuoteTodo={quoteTodoInComposer}
        onAskCompanion={askCompanionInComposer}
        askCompanionReady={canUseComposer && composerDraftHydrated}
        onSearch={() => setSearchOpen(true)}
        onBack={goBackToHome} />
          )}
    </>
      ) : (
        <SessionHeaderBar
              horizontalSystemHeader={horizontalSystemHeader}
              systemBarHidden={sessionListDrawerOverlayMounted}
              currentSession={currentSession}
              diffCount={diffCount}
              isDeviceAccessRevoked={isDeviceAccessRevoked}
              sharedTaskEnded={isSharedTaskAccessRevoked}
              shareSelectionLeadingInset={nativeShellLayout.wideViewport
                ? Math.max(0, (detailViewport.width - nativeShellLayout.contentMaxWidth) / 2)
                : 0}
              shareSelectAllNode={shareSelectionActive ? (
                <ShareSelectAllButton busy={conversationShareBusy} shareableIds={allShareableIds} />
              ) : undefined}
              syncing={showSyncingIndicator}
              syncingImmediately={showSyncingImmediately}
              messageCount={Math.max(messages.length, currentSession?._count?.messages ?? 0)}
              messageOnly={sessionManagedByHost}
              onBack={sessionListDrawerOverlayMounted ? closeSessionListDrawer : goBackToHome}
              noticeOverride={currentSession?.source === 'side-chat'
                ? t('session.sideChat.fromMain', { title: sideChatParent?.title || t('session.sideChat.mainTask') }) : undefined}
              onOpenSessionList={!paneLayout.persistent && wideSessionNav.enabled ? openSessionListDrawer : undefined}
              onNewSession={paneLayout.persistent ? handleDrawerNewSession : undefined}
              onOpenFiles={() => {
                if (!currentSession?.workingDir) return;
                guardedPush({
                  pathname: '/files/[sessionId]',
                  params: { sessionId, deviceId, deviceName },
                });
              }}
              onOpenSettings={() => openSessionMenu('menu')}
              onOpenUsage={() => openSessionMenu('info')}
              onTitleDoubleTap={currentSession && !isDeviceAccessRevoked
                && sessionMenuAllowsRename(currentSession, sessionManagedByHost)
                ? () => openSessionMenu('rename')
                : undefined}
              onOpenRemoteDesktop={() => {
                if (!deviceId) return;
                guardedPush({
                  pathname: '/devices/desktop/[deviceId]',
                  params: { deviceId, deviceName },
                });
              }}
              onToggleSearch={() => {
                if (searchOpen) closeSearch();
                else setSearchOpen(true);
              }}
              pendingCount={pending.length}
              queueCount={inputProjection?.pendingQueue.length ?? 0}
              queuePaused={inputProjection?.queuePaused ?? false}
              remoteUnavailableReason={remoteUnavailableReason}
              searchOpen={searchOpen}
              title={isDeviceAccessRevoked
                ? t('session.screen.accessRevokedShort')
                : currentSession?.source === 'side-chat' ? t('session.sideChat.title')
                : // 哨兵先过投影再进兜底链:会话头是发出第一句话后停留最久的位置,
                  // 原样显示会把内部哨兵 "New Maker" 摆在标题栏上。
                  projectDraftSessionTitle(currentSession?.title, t('session.menu.unnamedTitle'))
                  || currentSession?.workingDir
                  || (connectionError ? t('session.screen.sessionNotSynced') : deviceName || t('session.screen.conversationFallback'))
          }
        />
      )}
    </>
  );
  return (
    <View style={styles.safeArea} testID="session.screen">
      <PaneViewportProvider value={detailViewport}>
      <ComposerKeyboardAvoidingView
        keyboard={keyboardState}
        // iOS composer dock: the spacer / lift below follow the keyboard per frame instead.
        enabled={!dockKeyboardFollow}
        // 抽屉开着时把背后内容从读屏树里摘掉:iOS 用 accessibilityElementsHidden
        // (与抽屉侧 accessibilityViewIsModal 配对),Android 用 importantForAccessibility
        // ——后者才对 TalkBack 生效(与 ComposerRichInput 的双平台配对惯例一致)。
        accessibilityElementsHidden={sessionListDrawerOverlayMounted}
        behavior={nativeShellLayout.keyboardAvoidingBehavior}
        importantForAccessibility={sessionListDrawerOverlayMounted ? 'no-hide-descendants' : 'auto'}
        keyboardVerticalOffset={nativeShellLayout.keyboardVerticalOffset}
        style={[styles.keyboard, { marginLeft: paneLayout.detail.x, marginRight: Math.max(0, windowDimensions.width - paneLayout.detail.x - paneLayout.detail.width) }]}
      >
        {Platform.OS === 'ios' ? (
          <SessionHeaderNativeBlur height={topChromeHeight}
            fadeInside={companionHeaderShown ? CHAT_HEADER_BLUR_FADE_INSIDE : undefined} />
        ) : null}
        <SessionChromeLayer
          hiddenFromAccessibility={sessionListDrawerOverlayMounted}
          left={paneLayout.detail.x}
          viewport={detailViewport}
          width={paneLayout.detail.width}
        >
        <View ref={topOverlayRef} onLayout={handleTopOverlayLayout} pointerEvents="box-none" style={styles.sessionChrome} testID="session.chrome">
          {/* Android 顶栏与首页顶栏同一底:半透明 surface + 模糊,消息从下面滚过时能透出一点。 */}
          {Platform.OS !== 'ios' && !companionChat ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="session.chromeFrost">
              <BlurBackdrop intensity={50} overlayColor={colors.surfaceTranslucent} />
            </View>
          ) : null}
          {/* iOS chat headers sit on the task header's feathered blur; an opaque band left a hard edge. */}
          <View style={[styles.sessionChromeContent, { paddingTop: horizontalSystemHeader ? nativeHeaderHeight : insets.top + (paneLayout.persistent ? spacing.lg : 0) }, companionChat && Platform.OS !== 'ios' && { backgroundColor: colors.surface }]}>
            {headerNode}

            {cloudHomeActor && cloudHomeUnreachable ? (
              <CloudHomeUnreachableNotice deviceName={deviceName} onSwitch={() => router.push({
                pathname: '/companions/cloud/[actorId]',
                params: { actorId: cloudHomeActor.id, botId: cloudHomeActor.externalId, deviceId, deviceName,
                  title: resolveRemoteText(companionResource!.display.title, i18nInstance.language) },
              })} />
            ) : null}
            {!isSharedTaskAccessRevoked && !quietConnection && (showConnectionBanner || showCachedHistoryNotice) ? (
              <ConnectionBanner
                density="compact"
                cachedOnly={showCachedHistoryNotice}
                deviceUnresponsive={isDeviceUnresponsive}
                error={bannerError}
                requestErrorAutoRecovering={bannerRetriesHistory ? false : undefined}
                issue={connectionIssue}
                lastSyncedAt={lastSyncedAt}
                loading={loading || loadingEarlier}
                onSync={() => {
                  if (companionEntry.error) companionEntry.retry();
                  if (bannerRetriesHistory) void loadEarlierMessages();
                  else void requestSync({ reason: 'manual', replaceMessages: false });
                }}
                status={status}
                recovery={contentRecoveryState}
                variant="inline"
              />
            ) : null}
          </View>
        </View>
        </SessionChromeLayer>
        {sharedTaskExit.dialog}
        <MountOnFirstOpen open={settingsOpen}>{() =>
              currentSession ? (
          <SessionMenuSheet
            onOpenSideChats={canUseSideChats ? () => {
              setSideChatsPendingOpen(true);
              setSettingsOpen(false);
            } : undefined}
            tagDeviceId={deviceId}
            onLeaveSharing={() => void sharedTaskExit.leave()}
            leavingSharing={sharedTaskExit.busy}
            onOpenSharing={() => {
              setSettingsOpen(false);
              guardedPush({ pathname: '/shared-session', params: { sessionId, deviceId } });
            }}
            providerName={formatProviderAccountLabel(menuAccountProvider)}
            modelLabel={sessionModelDisplayName}
            messageOnly={sessionManagedByHost}
            onOpenSearch={() => {
              setSessionSearchPendingOpen(true);
              setSettingsOpen(false);
            }}
            usageReader={maker}
            accountUsageReader={menuAccountReader}
            accountProvider={menuAccountProvider}
            accountUsage={localCodexRateLimitControl ? accountUsage : null}
            busy={controlBusy}
            codexRateLimits={localCodexRateLimitControl ? codexRateLimits : null}
            codexResetBusy={codexResetBusy}
            onContextError={setError}
            extraDirBrowser={extraDirBrowser}
            initialView={menuInitialView}
            keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
            onArchive={(prepare) => { void patchSessionMeta({ status: 'archived' }, prepare); }}
            confirmArchive={async (isCurrent) => {
              const names = deviceId
                ? await loadActiveBoundScheduleNames({ deviceId, invoke, sessionId, source: sessionSourceForSchedule })
                : [];
              return isCurrent() && confirmArchiveWithSchedules(t, names);
            }}
            onClose={() => setSettingsOpen(false)}
            onClosed={handleSessionMenuClosed}
            onDelete={() => patchSessionMeta({ status: 'deleted' })}
            onLoadExtraDirPath={(path) => void loadExtraDirBrowsePath(path)}
            onRefreshAccountUsage={() => void refreshAccountUsage()}
            onResetCodexRateLimits={() => void resetCodexRateLimits()}
            onSaveCodexResetAutoUse={async (patch) => {
              const key = codexRateLimits?.autoUse?.accountKey;
              if (!key || !maker || !localCodexRateLimitControl) throw new Error('Account unavailable');
              const result = await maker.setCodexResetAutoUse(patch, key, accountProviderId);
              if (accountControlScopeRef.current !== accountControlScope) return;
              setCodexRateLimits(result);
              setAccountUsage(result.rateLimits);
            }}
            onOpenWorkspace={() => {
              if (!currentSession.workingDir) return;
              setSettingsOpen(false);
              guardedPush({
                pathname: '/files/[sessionId]',
                params: { sessionId, deviceId, deviceName },
              });
            }}
            worker={collab.isWorker ? {
              onArchive: collab.workerSelf ? (onConfirmed) => collab.confirmArchiveSelf(onConfirmed) : undefined,
            } : undefined}
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
            session={currentSession}
            visible={settingsOpen}
          />
        ) : null
            }</MountOnFirstOpen>
        {currentSession ? (
            <SideChatsSheet key={`${deviceId}:${sessionId}`} visible={sideChatsOpen}
          session={currentSession} maker={maker} onClose={() => setSideChatsOpen(false)}
          onCreate={() => createSideChat()} onSelect={openSideChat} />
          ) : null}
        <SessionSearchSheet
          activeIndex={activeSearchIndex}
          hasOlderMessages={hasOlderMessages && !isScheduleDetail}
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
        <MountOnFirstOpen open={contextSheetOpen}>{() => (
          <ContextSheet
        media={contextSheetView === 'main' && contextSheetMediaLibraryEnabled ? (
              <RecentPhotosStrip
                busyAssetIds={uploadingMediaAssetIds}
                disabled={!canUseComposer}
                enabled={contextSheetOpen}
                onToggleAsset={toggleMediaAssetAttachment}

                selectedAssetIds={selectedMediaAssetIds}
                testID="session.contextSheetPhotos"
              />
            ) : null}
        error={contextSheetView === 'main' ? attachmentError : null}
          keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
          onBack={contextSheetView === 'collab-create'
            ? () => setContextSheetView('collab')
            : contextSheetView !== 'main' ? () => setContextSheetView('main') : undefined}
          onClose={() => setContextSheetOpen(false)}
          footer={contextSheetView === 'collab' && !collab.isLead ? (
            <ContextSheetFooterButton
              busy={collab.busy}
              disabled={!collab.canSubmit || collab.entryBlocked}
              label={t('session.collab.enableSubmit')}
              onPress={() => void collab.submitEnable()}
              testID="session.collabEnableButton"
            />
          ) : contextSheetView === 'collab-create' ? (
            <ContextSheetFooterButton
              busy={collab.busy}
              disabled={!collab.canSubmit}
              label={t('session.collab.createWorkerSubmit')}
              onPress={() => void collab.submitCreate()}
              testID="session.collabCreateWorkerButton"
            />
          ) : undefined}
          testID="session.contextSheet"
          title={contextSheetView === 'goal'
            ? t('session.common.goalMode')
            : contextSheetView === 'collab'
              ? collab.isLead ? t('session.collab.title') : t('session.collab.enableTitle')
              : contextSheetView === 'collab-create'
                ? t('session.collab.createWorkerTitle')
                : t('session.common.context')}
          visible={contextSheetOpen}
        >
          {contextSheetView === 'main' ? (
            <>


              <ContextSheetGroup label={Platform.OS === 'ios' && contextSheetMediaLibraryEnabled ? '' : t('session.common.groupAdd')}>
                <ContextSheetRow
                  accessibilityHint={composerSendUnavailableReason ?? undefined}
                  disabled={!canUseComposer}
                  icon={<Image color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.photo')}
                  onPress={() => void addLocalImageAttachments('library')}
                  dismissBeforePress
                  testID="session.contextSheetPhotoRow"
                />
                <ContextSheetRow
                  accessibilityHint={composerSendUnavailableReason ?? undefined}
                  disabled={!canUseComposer}
                  icon={<Camera color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.takePhoto')}
                  onPress={() => void addLocalImageAttachments('camera')}
                  dismissBeforePress
                  testID="session.contextSheetCameraRow"
                />
                <ContextSheetRow
                  accessibilityHint={composerSendUnavailableReason ?? undefined}
                  disabled={!canUseComposer}
                  icon={<Folder color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.file')}
                  onPress={() => void addLocalFileAttachment()}
                  dismissBeforePress
                  testID="session.contextSheetFileRow"
                />
              </ContextSheetGroup>
              {!isSharedTaskPeer(deviceId) && !sessionManagedByHost ? (
                      <ContextSheetGroup label={t('session.common.groupMode')}>
                {planModeSupported ? (
                  // 点击即切换计划模式并关面板(产品决策,不做开关);已开启时显示 ✓,再点退出。
                  <ContextSheetRow
                    accessibilityHint={composerSendUnavailableReason ?? undefined}
                    disabled={!canUseRemoteSessionControls || controlBusy}
                    icon={<ListTodo color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                    label={t('session.common.planMode')}
                    onPress={() => {
                      togglePlanMode(!planModeOn);
                      setContextSheetOpen(false);
                    }}
                    testID="session.contextSheetPlanRow"
                    trailing={planModeOn ? (
                                <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.bold} />
                              ) : null}
                    trailingSize={iconSize.md}
                  />
                ) : null}
                <ContextSheetRow
                  icon={<Target color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                  label={t('session.common.goalMode')}
                  detail={goalStatus ? goalStatusLabel(goalStatus.status, goalStatus.lastReason) : undefined}
                  onPress={() => setContextSheetView('goal')}
                  testID="session.contextSheetGoalRow"
                  trailing="chevron"
                />
                {collab.eligible ? (
                  <ContextSheetRow
                    accessibilityHint={collab.entryHint ?? undefined}
                    icon={<UsersRound color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
                    label={t('session.collab.modeLabel')}
                    detail={collab.isLead ? t('session.collab.enabled') : undefined}
                    onPress={collab.openFromMain}
                    testID="session.contextSheetCollabRow"
                    trailing="chevron"
                  />
                ) : null}
              </ContextSheetGroup>
                    ) : null}
              {!isSharedTaskPeer(deviceId) ? (
                      <ContextSheetPlugins
                disabled={!canUseComposer}
                onOpen={openPluginPalette}
                testID="session.contextSheetPlugins"
              />
                    ) : null}
            </>
          ) : contextSheetView === 'collab' && collab.isLead ? (
            <OrcaTeamPanelView
              busy={collab.busy}
              error={collab.error ?? collab.team.error}
              loading={collab.team.loading}
              onCreateWorker={collab.openCreateWorker}
              onEndTeam={collab.confirmEndTeam}
              onWorkerLongPress={collab.showWorkerActions}
              onWorkerPress={collab.openWorker}
              settings={collab.team.settings}
              workers={collab.team.workers}
            />
          ) : contextSheetView === 'collab' || contextSheetView === 'collab-create' ? (
            <OrcaWorkerFormView
              agents={collab.workerForm.agents}
              executionDevices={collab.workerForm.executionDevices}
              executionDevicesLoading={collab.workerForm.executionDevicesLoading}
              executionDevicesError={collab.workerForm.executionDevicesError}
              busy={collab.busy}
              customRoleMode={collab.workerForm.customRoleMode}
              error={collab.error}
              form={collab.workerForm.form}
              notice={contextSheetView === 'collab' ? collab.entryHint : null}
              onAgentChange={collab.workerForm.changeAgent}
              onChange={collab.workerForm.patch}
              onCustomRoleModeChange={collab.workerForm.setCustomRoleMode}
              onPermissionChange={(mode) => void collab.workerForm.changePermission(mode)}
              onPickModel={collab.workerForm.modelPicker.openPicker}
              onPickDirectory={collab.workerForm.directoryPicker.openPicker}
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
              initialObjective={goalRestoreForSession ? undefined : (draftRef.current.trim() || undefined)}
              onClearGoal={handleClearGoal}
              onPauseGoal={handlePauseGoal}
              onResumeGoal={handleResumeGoal}
              onSetGoal={handleSetGoal}
              testID="session.contextSheetGoalView"
            />
          )}
        </ContextSheet>
        )}</MountOnFirstOpen>
        <MountOnFirstOpen open={modelSheetOpen && canConfigureSessionModel}>{() =>
              currentSession && canConfigureSessionModel && runtimeOptions && modelSheetSelection && modelSheetRuntimeOptions ? (
          <ModelPickerSheet
            unified={{
              currentSelection: { agentKind: sessionAgentKind, activeModelId: currentSession.model, selectedProviderId: currentSession.providerId ?? null, selectedEffort: currentSession.effort ?? '', selectedFastMode: currentSession.fastMode ?? false,
                    },
              scope: JSON.stringify([auth.user?.id, deviceId, orcaRemoteAgentDeviceId]),
              agents: sessionAgentSwitchSupported ? ['claude-code','codex','pi'] : [sessionAgentKind],
              loadCapabilities: async (agent) => {
                const result = normalizeMobileAgentCapabilities(await loadComposerAgentCapabilities(agent));
                if (!result) throw new Error('Capabilities unavailable');
                return result;
              },
              onSelect: selectUnifiedComposerModel,
              // 远程 Agent:其他电脑上开放了远程调用的供应商接在后面,每个供应商一段、标题带电脑名。
              ...(agentLocationMovable || orcaRemoteAgentDeviceId
                ? {
                  remote: {
                    catalogs: modelSheetRemoteCatalogs,
                    selectedDeviceId: nextAgentDeviceId,
                    // 供应商组:组里其他电脑收进组那一项;归组的任务在组那一项里选模型留在此刻运行的那台。
                    hostDeviceId: deviceId,
                    providerGroup: remoteProviderGroup,
                  },
                }
                : { remote: undefined }),
            }}
            activeModelId={modelSheetSelection.model}
            existingSessionRoute

            activePermissionMode={displayPermissionMode ?? currentSession.permissionMode}
            agentKind={modelSheetAgentKind}
            agentSwitch={sessionAgentSwitchSupported ? {
              browsingAgentKind: modelSheetAgentKind,
              currentAgentKind: sessionAgentKind,
              disabled: controlBusy || !canUseRemoteSessionControls,
              onBrowseAgent: browseComposerModelAgent,
            } : undefined}
            apiKeyStatus={deviceApiKeyStatus}
            capabilities={modelSheetCapabilities}
            disabled={controlBusy || !canUseRemoteSessionControls}
            emptyHint={!orcaRemoteAgentDeviceId && composerDeviceProviders.error && !composerDeviceProviders.unsupported
              ? humanizeRemoteError(composerDeviceProviders.error)
              : (modelSheetCapabilitiesError ?? undefined)
                  }
            flatOptions={orcaRemoteAgentDeviceId ? [] : modelSheetRuntimeOptions.modelOptions}
            providersReady={composerDeviceProviders.ready}
            providersUnsupported={orcaRemoteAgentDeviceId ? false : composerDeviceProviders.unsupported}
            modelVisibilityOverrides={composerDeviceProviders.modelVisibilityOverrides}
            keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
            loading={(orcaRemoteAgentDeviceId ? currentAgentCatalog.loading : composerDeviceProviders.loading) || modelSheetCapabilitiesLoading}
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
            permissionDisabled={controlBusy || !canUseRemoteSessionControls}
            permissionOptions={runtimeOptions.permissionOptions}
            pricing={deviceModelPricing}
            providers={orcaRemoteAgentDeviceId ? [] : composerDeviceProviders.providers}
            selectedEffort={modelSheetSelection.effort}
            selectedFastMode={modelSheetSelection.fastMode}
            selectedProviderId={modelSheetSelection.providerId}
            testID="session.modelSheet"
            visible={modelSheetOpen && canConfigureSessionModel}
          />
        ) : null
            }</MountOnFirstOpen>
        <OrcaWorkerDirectoryPicker picker={collab.workerForm.directoryPicker}
          deviceId={collab.workerForm.form.executionDeviceId} workingDir={collab.workerForm.form.remoteDir} mode={collab.workerForm.form.remoteDirMode} />
        <MountOnFirstOpen open={collab.workerForm.modelPicker.open}>{() => currentSession && collab.eligible ? (
          // 协同 Worker 的模型选择:与会话模型浮窗同一套统一模型目录,但只回写 Worker 表单,
          // 不触碰当前任务的模型。iOS 原生 sheet 不能叠开:打开前先收起 + 面板,关闭后再展开。
          <ModelPickerSheet
            unified={{
              currentSelection: collab.workerForm.form.model ? {
                agentKind: collab.workerForm.form.agent,
                activeModelId: collab.workerForm.form.model.id,
                selectedProviderId: collab.workerForm.form.model.providerId,
                selectedEffort: collab.workerForm.form.model.effort ?? '',
                selectedFastMode: collab.workerForm.form.model.fast,
              } : undefined,
              scope: JSON.stringify([auth.user?.id, collabWorkerDeviceId, 'orca-worker']),
              agents: collab.workerForm.pickerAgents,
              loadCapabilities: async (agent) => {
                const result = normalizeMobileAgentCapabilities(await collab.workerForm.maker.getCapabilities(agent));
                if (!result) throw new Error('Capabilities unavailable');
                return result;
              },
              onSelect: collab.workerForm.modelPicker.select,
              // 远程供应商:其他电脑上开放了远程调用的供应商与分享接在后面(与任务模型列表同一套)，
              // 选中 = Worker 的 Agent 在那台运行。
              ...(collab.workerForm.agentLocationSelectable
                ? {
                    remote: {
                      catalogs: workerAgentCatalogs,
                      selectedDeviceId: collab.workerForm.form.agentDeviceId ?? null,
                    },
                  }
                : { remote: undefined }),
            }}
            activeModelId={collab.workerForm.form.model?.id ?? ''}
            activePermissionMode=""
            agentKind={collab.workerForm.form.agent}
            apiKeyStatus={collabApiKeyStatus}
            capabilities={null}
            emptyHint={collabDeviceProviders.error && !collabDeviceProviders.unsupported
              ? humanizeRemoteError(collabDeviceProviders.error)
              : undefined}
            flatOptions={collab.workerForm.modelPicker.flatModelOptions}
            hidePermissionTrigger
            keyboardAvoidingBehavior={nativeShellLayout.keyboardAvoidingBehavior}
            loading={collabDeviceProviders.loading}
            modelVisibilityOverrides={collabDeviceProviders.modelVisibilityOverrides}
            onClose={collab.workerForm.modelPicker.close}
            onClosed={collab.workerForm.modelPicker.closed}
            onSelectFlatModel={collab.workerForm.modelPicker.selectFlatModel}
            onSelectPermissionMode={() => undefined}
            onSelectProviderRow={() => undefined}
            permissionOptions={[]}
            pricing={collabModelPricing}
            providers={collabWorkerProviders}
            providersReady={collabDeviceProviders.ready}
            providersUnsupported={collabDeviceProviders.unsupported}
            selectedEffort={collab.workerForm.form.model?.effort ?? ''}
            selectedFastMode={collab.workerForm.form.model?.fast ?? false}
            selectedProviderId={collab.workerForm.form.model?.providerId ?? null}
            testID="session.collabModelSheet"
            visible={collab.workerForm.modelPicker.open}
          />
        ) : null}</MountOnFirstOpen>
        {/* 权限模式独立浮窗(composer 权限图标钮点开)。两端同一语义:点选先关浮窗,关闭完成后
            再走 confirmFullAccessChange + maker:set-permission-mode。 */}
        {currentSession && runtimeOptions ? (
          <NativePermissionSheet
            visible={permissionSheetOpen && canUseRemoteSessionControls}
            onClose={() => setPermissionSheetOpen(false)}
            activeMode={displayPermissionMode}
            disabled={controlBusy || !canUseRemoteSessionControls}
            onSelect={selectSessionPermissionMode}
            options={runtimeOptions.permissionOptions}
            testID="session.permissionSheet"
          />
        ) : null}
        {pendingImagePreview.host}
          <ComposerAttachmentPreview
            attachments={attachments}
            images={composerGalleryImages}
            selectedId={composerPreviewAttachmentId}
            annotation={composerAnnotations.trayAnnotation}
            resolveRemoteMedia={resolveRemoteMedia}
            onSelect={setComposerPreviewAttachmentId}
            onClose={() => setComposerPreviewAttachmentId(null)}
          />
          {composerAnnotations.host}
        <View style={styles.sessionMainLayer} testID="session.mainLayer">
          {isSharedTaskAccessRevoked ? (
            <ScrollView contentContainerStyle={{ paddingTop: topOverlayHeight + spacing.lg, paddingHorizontal: spacing.lg }}>
              <SharedTaskEndedState onReturnToTasks={() => router.replace('/devices')} />
            </ScrollView>
          ) : sessionOperationLayout.composerSlot === 'missing-session' && remoteUnavailableReason ? (
            // 会话行尚未到达时保留状态占位；自动恢复类错误不再提供手动同步入口。
            <SessionSyncPlaceholder
              loading={loading}
              onSync={composerRemoteUnavailableReason
                ? () => void requestSync({ reason: 'manual', replaceMessages: false })
                : undefined}
            />
          ) : (
            <>
              <RewindPreviewPanel
                committing={!!messageActionBusy && isCommitReadyRewindState(rewindState)}
                onCancel={() => setRewindState({ kind: 'idle' })}
                onConfirm={() => void confirmRewind()}
                state={rewindState}
                bottomOverlayHeight={bottomOverlayHeight}
                topOverlayHeight={topOverlayHeight}
              />

              {!companionInlineInteraction && sessionOperationLayout.messageHistoryMode === 'collapsed' ? (
                <MessageHistoryToggle
                  expanded={pendingHistoryExpanded}
                  onToggle={() => setPendingHistoryExpanded((value) => !value)}
                />
              ) : null}

              {/* showSyncingShell:session 还没回来但在同步,消息区先出骨架(走 MessageRenderer 的 loading 态)。 */}
              {showMessageHistory || showSyncingShell ? (
                <RecentMessageHistories
                  key={auth.accountGeneration}
                  activeKey={JSON.stringify([deviceId, sessionId])}
                  ready={topOverlayHeight > 0 && (historyView.snapshot.ready || messageListItems.length > 0 || (!loading && !syncingWhileEmpty))}
                  // Android 的常驻消息层画在页面之上;顶栏经 SessionChromeLayer 盖在它上面,
                  // 所以消息层从顶部开始绘制,滚动时能透过半透明顶栏看到。
                  topInset={Platform.OS === 'android' ? 0 : topOverlayHeight}
                  bottomInset={androidFrostedComposer ? 0 : bottomOverlayHeight}
                  interactive={!sessionListDrawerOverlayMounted}>

                <SessionQuickSendProvider value={canUseComposer ? async (text) => (await send({ independentText: text })) === true : null}>
                <ChatFilePathContext.Provider value={chatFilePathContextValue}>
                  <MessageRenderer companion={companionChat} companionQuote={companionQuoteOptions}
                    companionThreads={companionThreads} conversationHeader={companionThreadRoot}
                    onOpenCompanionSettings={openCompanionSettings} onCompanionReadThrough={companionChat ? companionEntry.markReadThrough : undefined} companionWorkingLabel={companionWorkGroupLabel}
                    companionAttentionLabel={activePendingKind ? (companionWorkGroupLabel ?? undefined)
                              : undefined}
                    companionAvatar={companionReplyAvatar}
                    companionPluginInvocations={companionPluginInvocations}
                    remoteDeviceId={deviceId}
                    showPluginInvocations={!companionChat && Boolean(currentSession && currentSession.source !== 'bot')}
                    bottomOverlayHeight={bottomOverlayHeight}
                    renderScrollComponent={renderMessageScroll}
                    contentBottomInset={companionInlineInteraction && !shareSelectionActive
                      ? spacing.md
                      : nativeComposerFrameAvailable && sessionOperationLayout.composerSlot === 'editable' && !shareSelectionActive
                      ? bottomOverlayHeight > 0 ? bottomOverlayHeight : MOBILE_MESSAGE_LIST_BOTTOM_PADDING
                                : undefined}
                    topOverlayHeight={topOverlayHeight}
                    busyAction={messageActionBusy?.kind ?? null}
                    busyClientId={messageActionBusy?.clientId ?? null}
                    canLoadEarlier={canLoadEarlierHistory}
                    emptyTestID="session.messageList.empty"
                    emptyMessage={companionEntry.threadRootSessionId ? t('groupChat.thread.empty') : messageEmptyState.emptyMessage}
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
                    itemsStructureKey={messageListStructureKey}
                    pendingSend={pendingSendActions}
                    pendingSendGroupKeys={pendingSendGroupKeys}
                    getSentImagePreview={getSentImagePreview}
                    loadingEarlier={historyView.snapshot.ready ? historyView.view.isLoadingOlder() : loadingEarlier}
                    loadEarlierProgressKey={oldestLoadedMessageCursor}
                    onCopyMessageLink={copyMessageLink}
                    onAddMessageToComposer={canUseComposer ? addMessageToComposer : undefined}
                    onSideChatMessage={canUseSideChats && currentSession?.source !== 'side-chat' ? askInSideChat : undefined}
                    onDiagnoseError={canDiagnoseError ? handleDiagnoseError : undefined}
                    onDeleteMessage={isSharedTaskPeer(deviceId) ? undefined : deleteMessage}
                    onForkMessage={isSharedTaskPeer(deviceId) ? undefined : forkAtMessage}
                    onLoadEarlier={loadEarlierMessages}
                    onLoadToolInput={loadToolInput}
                    onRetryImageDelivery={isSharedTaskPeer(deviceId) ? undefined : retryImageDelivery}
                    onOpenForkOrigin={forkOrigin ? openForkOrigin : undefined}
                    onOpenOriginSession={openOriginSession}
                    // 设备来源标签只标别的设备发来的消息:本机发出的不标。
                    viewerDeviceId={auth.deviceId}
                    onOpenSourceDevice={openSourceDevice}
                    onOpenSessionLink={openSessionLink}
                    onPreviewRewind={isSharedTaskPeer(deviceId) ? undefined : previewRewindAtMessage}
                    onEditMessage={isSharedTaskPeer(deviceId) || !canUseComposer ? undefined : beginMessageEdit}
                    editingMessageClientId={messageEditing?.clientId ?? null}
                    onEnterShareSelection={enterShareSelection}
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
                    imageAnnotation={composerAnnotations.chatAnnotation}
                    queueFooter={
                            <>
                        {companionInlineInteraction && !shareSelectionActive ? (
                                <InteractionPanel
                          fileContext={chatFilePathContextValue}
                          embedded
                          companion={companionChat}
                          companionIdentity={companionInteractionIdentity}
                          hangFromAvatar
                          collapse={pendingInteractionCollapse} deviceId={deviceId} sessionId={sessionId}
                          interactions={pending} activeRequestId={pendingInteractionActiveRequestId}
                          onActiveRequestIdChange={setPendingInteractionActiveRequestId}
                          planViewerState={pendingPlanViewerState} onPlanViewerStateChange={setPendingPlanViewerState}
                          onError={setError}
                        />
                              ) : null}
                        {/* error-tail / interrupted 收尾提示:live 错误与队列区互斥
                            (resolveSessionTailBanner 内部已按 projection.error 抑制)。 */}
                        {tailBannerState ? (
                          <SessionTailBanner
                            busy={tailBannerBusy || historyRecoveryBusy}
                            onRecoverHistory={canRecoverHistory ? () => void recoverReadableHistory() : undefined}
                            onContinue={() => void continueTailBanner()}
                            onDismiss={dismissTailBanner}
                            onDiagnose={canDiagnoseError ? handleDiagnoseError : undefined}
                            state={tailBannerState}
                          />
                        ) : null}
                        {shouldShowFailedScheduleNotice({
                          latestFailedRun: scheduleFailure?.source === scheduleNoticeSource ? scheduleFailure.run : null,
                          readOnly: false,
                          tailError: !!errorTailClientId || !!retryHiddenTailClientId,
                          interrupted: tailBannerState?.kind === 'interrupted',
                          continuationPending: tailContinuationInFlight,
                          error: !!inputProjection.error, credentialWait: !!inputProjection.credentialSwitchWait,
                          streaming: isSessionStreaming, running: remoteSessionRunning,
                        }) && scheduleFailure?.run ? (
                          <FailedScheduleNotice key={scheduleNoticeSource}
                            source={scheduleNoticeSource} run={scheduleFailure.run}
                            onDiagnose={canDiagnoseError ? handleDiagnoseError : undefined} />
                        ) : null}
                        {/* 队列状态横幅(错误 / 凭证等待 / 停止确认 / 暂停)。待发送气泡
                            不在这里,它们是消息流里的 pending_send 项。 */}
                        <InlineQueueSection
                          busy={queueBusy || historyRecoveryBusy}
                          onRecoverHistory={canRecoverHistory ? () => void recoverReadableHistory() : undefined}
                          sessionSource={currentSession?.source}
                          onClearError={clearQueueError}
                          onDiscardBlockedQueueHead={removeQueueItem}
                          onCancelUsageLimitWait={cancelUsageLimitWait}
                          onResume={resumeQueue}
                          onRetryError={retryQueueError}
                          onContinueAfterError={canContinueError ? continueQueueError : undefined}
                          onDiagnose={canDiagnoseError ? handleDiagnoseError : undefined}
                          projection={inputProjection}
                          readOnlyReason={queueAvailabilityReason}
                        />
                      </>
                          }
                    scrollResetKey={sessionId}
                    isReadingPositionActive={isReadingPositionActive}
                    syncingWhileEmpty={syncingWhileEmpty || chasingHiddenHistory}
                    testID="session.messageList"
                  />
                </ChatFilePathContext.Provider>
                </SessionQuickSendProvider>
                </RecentMessageHistories>
              ) : null}

            </>
          )}
        </View>

        {!isSharedTaskAccessRevoked && nativeComposerFrameAvailable && sessionOperationLayout.composerSlot === 'editable' && !shareSelectionActive ? (
          <DockKeyboardLift active={dockKeyboardFollow} restingBottom={composerDock.restingBottom} keyboardGap={composerDock.keyboardGap}
            pointerEvents="none" style={StyleSheet.absoluteFill}>
            <SessionHeaderNativeBlur
              edge="bottom"
              height={Math.max(0, bottomOverlayHeight - composerBackdropTop)}
              inset={dockKeyboardFollow ? 0 : nativeShellLayout.keyboardBottomInset}
            />
          </DockKeyboardLift>
        ) : null}
        {Platform.OS === 'android' ? (
          // 量出键盘避让容器的实际可用高度,供挂到根浮层的输入区对齐(见 SessionChromeLayer)。
          <View onLayout={handleKeyboardAreaLayout} pointerEvents="none" style={StyleSheet.absoluteFill} />
        ) : null}
        <SessionChromeLayer
          enabled={androidFrostedComposer}
          height={keyboardAreaHeight ?? windowDimensions.height}
          hiddenFromAccessibility={sessionListDrawerOverlayMounted}
          left={paneLayout.detail.x}
          viewport={detailViewport}
          width={paneLayout.detail.width}
        >
        {!isSharedTaskAccessRevoked && (
              <DockKeyboardLift
          active={dockKeyboardFollow}
          restingBottom={pendingInteractionDock ? 0 : composerDock.restingBottom}
          keyboardGap={pendingInteractionDock ? 0 : composerDock.keyboardGap}
          pointerEvents="box-none"
          testID="session.bottomViewport"
          style={[
            StyleSheet.absoluteFill,
            { zIndex: 10 },
            // Clip the complete touch tree at the usable region, not at the
            // measured composer height. Held cards can extend above the input
            // while neither cards nor oversized inputs can cross a reservation.
            adaptiveWindow.regions.length > 0 && {
              left: Math.max(0, composerRegion.x - paneLayout.detail.x),
              right: Math.max(0, paneLayout.detail.x + paneLayout.detail.width - composerRegion.x - composerRegion.width),
              top: composerRegion.y,
              bottom: windowDimensions.height - composerRegion.y - composerRegion.height,
              overflow: 'hidden',
            },
          ]}
        ><View
          ref={bottomOverlayRef}
          onLayout={handleBottomOverlayLayout}
          pointerEvents="box-none"
          style={[
            styles.sessionBottomLayer,
            androidFrostedComposer && styles.sessionBottomFrosted,
            // The outer viewport owns reservation clipping; keep the held card
            // attached to its original responder for release/cancel delivery.
            sessionOperationLayout.composerSlot === 'editable' && { overflow: 'visible' },
            adaptiveWindow.regions.length > 0 && {
              maxHeight: composerRegion.height,
            },
            nativeComposerFrameAvailable && sessionOperationLayout.composerSlot === 'editable' && !shareSelectionActive
              && styles.sessionBottomFloating,
            shareSelectionActive && { overflow: 'visible' },
            // Region already excludes the keyboard. Its boundary clips only
            // the existing safe-area padding, without lifting the input twice.
            { bottom: adaptiveWindow.regions.length > 0
              ? -insets.bottom : dockKeyboardFollow ? 0 : nativeShellLayout.keyboardBottomInset },
          ]}
          testID="session.bottomLayer"
        >
          {androidFrostedComposer ? (
            // 与顶栏同一底:半透明 surface + 模糊,消息从输入区下面滚过时能透出一点。
            // 从输入框顶部起算:上方的状态胶囊自带底,再垫一层会叠成两层底。
            <View pointerEvents="none" style={[
              StyleSheet.absoluteFill,
              sessionOperationLayout.composerSlot === 'editable' && !shareSelectionActive && { top: composerBackdropTop },
            ]} testID="session.composerFrost">
              <BlurBackdrop intensity={50} overlayColor={colors.surfaceTranslucent} />
            </View>
          ) : null}
          <View
            pointerEvents="box-none"
            style={[
              styles.sessionBottomContent,
              // 待处理面板把 safe-area 收进自身 root，让问答 surface 延伸到
              // 屏幕底部且内容仍避开 home indicator；composer 继续由外层留 inset。
              {
                paddingBottom: sessionOperationLayout.composerSlot === 'pending-interaction'
                  ? 0
                  : dockKeyboardFollow
                              ? // Constant resting padding; DockKeyboardLift adds the keyboard part.
                                composerBottomContentPadding(composerDock.restingBottom, 0, spacing.xs)
                  : composerDock.enabled && sessionOperationLayout.composerSlot === 'editable'
                    ? keyboardState.visible
                                  ? // The existing native shell / reservation viewport owns
                                    // keyboard lift. Keep its safe-area compensation once.
                                    insets.bottom + composerDock.keyboardGap - spacing.xs
                      : composerBottomContentPadding(composerDock.restingBottom,
                      adaptiveWindow.regions.length > 0
                        ? windowDimensions.height - composerRegion.y - composerRegion.height - insets.bottom
                        : nativeShellLayout.keyboardBottomInset,
                      spacing.xs)
                    : insets.bottom,
              },
              nativeShellLayout.wideViewport && { maxWidth: nativeShellLayout.contentMaxWidth },
            ]}
            testID="session.bottomContent"
          >
          <SessionComposerPalette
            key={activeComposerDraftScopeKey}
            source={composerDraftSource}
            commandsRef={slashCommandsRef}
            pendingSkillSelectionRef={pendingSkillSelectionRef}
            canUseComposer={canUseComposer}
            canUseRemoteSessionControls={canUseRemoteSessionControls}
            canUseSideChats={canUseSideChats}
            currentSession={currentSession}
            deviceId={deviceId}
            maker={maker}
            openLink={openLink}
            shareSelectionActive={shareSelectionActive}
            nativeShellLayout={nativeShellLayout}
            contextSheetOpen={contextSheetOpen}
            composerHorizontalInset={composerTouchLayout.composerPaddingHorizontal}
            selectSlashCommand={selectSlashCommand}
            selectComposerPlugin={selectComposerPlugin}
            selectAtResource={selectAtResource}
          />
          {!shareSelectionActive && !isSharedTaskPeer(deviceId) && !sessionManagedByHost && goalStatus ? (
            <Pressable
              accessibilityLabel={`${t('session.common.goalMode')} · ${goalStatusLabel(goalStatus.status, goalStatus.lastReason)}`}
              accessibilityRole="button"
              onPress={() => {
                setModelSheetOpen(false);
                setContextSheetView('goal');
                setContextSheetOpen(true);
              }}
              style={({ pressed }) => [
                styles.queueEditBar,
                { minHeight: 44, marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                pressed && styles.collabBarPressed,
              ]}
              testID="session.goalStatusBar"
            >
              <Target color={goalStatus.status === 'active' ? colors.statusAccent : colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
              <Text numberOfLines={2} style={styles.queueEditBarText}>
                {t('session.common.goalMode')} ·{" "}
                          {goalStatusLabel(goalStatus.status, goalStatus.lastReason)}
              </Text>
              <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            </Pressable>
          ) : null}
          <PluginUiEnablePrompt deviceId={deviceId} deviceName={deviceName} sessionId={sessionId}
            online={!remoteRealtimeControlsUnavailable} active={creationScreenFocused && !shareSelectionActive} />
          {/*
            手机端终结不了的请求(plugin_setup 等)只贴在输入框上方:能看清电脑端
            在等什么、能取消,但不吃掉 composer —— 否则用户既处理不了这张卡又发不
            出消息。高度按 palette 量级收紧,内容超出走内部滚动。
          */}
          {!shareSelectionActive && !companionInlineInteraction && sessionOperationLayout.pendingInteractionPlacement === 'above-composer' ? (
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
                  fileContext={chatFilePathContextValue}
                  companion={companionChat}
                  companionIdentity={companionInteractionIdentity}
                  deviceId={deviceId}
                  sessionId={sessionId}
                  interactions={pending}
                  activeRequestId={pendingInteractionActiveRequestId}
                  onActiveRequestIdChange={setPendingInteractionActiveRequestId}
                  onError={setError}
                />
              </ScrollView>
            </View>
          ) : null}

          {shareSelectionActive ? null : sessionOperationLayout.composerSlot === 'pending-interaction' ? (
            companionInlineInteraction ? null : (
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
                    fileContext={chatFilePathContextValue}
                  companion={companionChat}
                  companionIdentity={companionInteractionIdentity}
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
                  />
                </View>
              ) : (
                <ScrollView
                  ref={pendingQuestionScroll.scrollRef}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  onFocus={pendingQuestionScroll.onFocus}
                  onBlur={pendingQuestionScroll.onBlur}
                  onLayout={pendingQuestionScroll.reveal}
                  onContentSizeChange={pendingQuestionScroll.reveal}
                  testID="interaction.bottomScroll"
                >
                <InteractionPanel
                  fileContext={chatFilePathContextValue}
                  companion={companionChat}
                  companionIdentity={companionInteractionIdentity}
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
                />
                </ScrollView>
              )}
            </View>
          )) : (
            <>
              {/* 消息区还在「正在同步」占位(新建会话第一帧 / 冷开首屏)时不谈运行状态:
                  「正在同步 + 思考中 + 0s · 0 tokens」三件事同时铺开,反倒像出错,而且
                  紧接着消息落屏时这条又要重排一次。等有内容了再显示活动条。
                  例外:新建任务慢发送时这一行要说明卡在哪一步,不能被同步占位藏掉。
                  判据必须带 messageCount:syncingWhileEmpty 只要 loading 就为真,而收口后
                  还会再来几轮 load(实测日志),只看它会让已有消息的会话反复熄灭活动条。 */}
              {/* 保留活动行的位置：提示出现、切换与结束不改变消息列表底部留白。 */}
              {!companionChat ? (
                <View
                  pointerEvents="box-none"
                  style={[
                    styles.composerActivityFrame,
                    {
                      paddingHorizontal: composerTouchLayout.composerPaddingHorizontal,
                      minHeight: 44,
                    },
                  ]}
                >
                  {(showComposerActivity || pendingRecoveryStatus) && (creationSlowPhase !== null || !(syncingWhileEmpty && !hasRenderedMessages)) ? (
                    <ComposerActivityStatus
                      availableRegion={composerRegion}
                      key={JSON.stringify([auth.accountGeneration, deviceId, sessionId])}
                      sessionKey={JSON.stringify([auth.accountGeneration, deviceId, sessionId])}
                      reconnectAttempt={remoteSessionRunStatus.reconnectAttempt}
                      pendingRecovery={pendingRecoveryStatus}
                      sideTaskRunning={remoteSessionRunStatus.sideTaskRunning}
                      startedAt={composerActivityStartedAtMs}
                      rateStartedAt={remoteSessionRunStatus.startedAt}
                      streaming={isSessionStreaming}
                      tokenUsage={composerActivityTokenUsage}
                      outputTokens={remoteSessionRunStatus.outputTokens}
                      generationDurationMs={remoteSessionRunStatus.generationDurationMs}
                      generationReliable={remoteSessionRunStatus.generationReliable}
                      tokenSpeed={remoteSessionRunStatus.tokenSpeed}
                      generationActive={remoteSessionRunStatus.generationActive}
                      visible={showComposerActivity}
                      slowSendPhase={creationSlowPhase}
                    />
                  ) : null}
                </View>
              ) : null}
              {companionChat && companionResource?.ref.id === 'cindy-default'
                && companionResource.links.some(
                          (link) => link.rel === 'conversation' && link.target.kind === 'session' && link.target.sessionId === sessionId)
                && followUpEngaged === followUpScope && !remoteSessionRunning && !isSessionStreaming
                && pending.length === 0 && !shareSelectionActive && !remoteUnavailableReason ? (
                <CompanionFollowUpInvitation key={followUpScope} deviceId={deviceId} deviceName={deviceName} botId="cindy-default" />
              ) : null}
              {/* Desktop BotWorkingStatus: a teammate's paced public status stays above the composer,
                  also while the user reads older messages. Interactions carry their own panel. */}
              {companionChat && companionWorkingLabel && !messageListItems.some(
                          (item) => item.type === 'work_group' && item.teammateJournal && item.isStreaming) && !companionInlineInteraction
                && !(syncingWhileEmpty && !hasRenderedMessages) ? (
                <View
                  style={[
                    styles.composerActivityFrame,
                    { paddingHorizontal: composerTouchLayout.composerPaddingHorizontal },
                  ]}
                >
                  <CompanionWorkingStatus
                    key={JSON.stringify([auth.accountGeneration, deviceId, sessionId])}
                    label={companionWorkingLabel}
                    avatar={companionPortrait(COMPANION_STATUS_AVATAR_SIZE)}
                  />
                </View>
              ) : null}
              {!shareSelectionActive && currentSession?.source === 'side-chat'
                && currentSession.parentSessionId ? (
                <Pressable accessibilityRole="button"
                  onPress={() => openCollabSession(currentSession.parentSessionId!)}
                  style={({ pressed }) => [styles.queueEditBar,
                    { marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                    pressed && styles.collabBarPressed]}
                  testID="session.sideChat.returnMain">
                  <MessagesSquare color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={styles.queueEditBarText}>{t('session.sideChat.returnMain')}</Text>
                  <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </Pressable>
              ) : null}
              {/* 协同状态条:Lead 显示 Worker 概况并打开协同面板;Worker 回到所属 Lead。 */}
              {!companionChat && !shareSelectionActive
                && (collab.isLead || (collab.isWorker && collab.workerLeadSessionId)) ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    if (!collab.isLead) {
                      collab.openLead();
                      return;
                    }
                    setModelSheetOpen(false);
                    collab.openFromMain();
                    setContextSheetOpen(true);
                  }}
                  style={({ pressed }) => [
                    styles.queueEditBar,
                    { marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                    pressed && styles.collabBarPressed,
                  ]}
                  testID="session.collabBar"
                >
                  <UsersRound color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={styles.queueEditBarText}>
                    {collab.isLead
                      ? t('session.collab.barLead', {
                        count: collab.team.workers.length,
                        running: collab.team.workers.filter((worker) => worker.status === 'running').length,
                      })
                      : t('session.collab.barWorker')}
                  </Text>
                  <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </Pressable>
              ) : null}
              {messageEditing && !queueEditing ? (
                <View
                  style={[
                    styles.queueEditBar,
                    { marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                  ]}
                  testID="session.messageEditBar"
                >
                  <Pencil color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  <View style={styles.messageEditBarBody}>
                    <Text numberOfLines={1} style={styles.messageEditBarText}>
                      {t('session.messageEdit.editing')}
                    </Text>
                    {messageEditing.rollbackHint ? (
                      <Text numberOfLines={2} style={styles.messageEditBarText} testID="session.messageEditRollbackHint">
                        {messageEditing.rollbackHint.kind === 'files'
                          ? t('session.messageEdit.rollbackHint', { count: messageEditing.rollbackHint.count })
                          : t('session.messageEdit.conversationOnlyHint')}
                      </Text>
                    ) : null}
                  </View>
                  <RouteActionButton
                    accessibilityLabel={t('session.messageEdit.discard')}
                    disabled={messageEditSubmitting || sending}
                    hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                    onPress={() => cancelMessageEdit()}
                    style={styles.queueEditBarClose}
                    testID="session.messageEditCancel"
                  >
                    <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  </RouteActionButton>
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
              {sideChatCount > 0 && !companionChat && !shareSelectionActive
                && sessionOperationLayout.composerSlot === 'editable' ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t('session.sideChat.summary', { count: sideChatCount })}
                  onPress={() => { Keyboard.dismiss(); setModelSheetOpen(false); setSideChatsOpen(true); }}
                  style={({ pressed }) => [styles.queueEditBar,
                    { marginHorizontal: composerTouchLayout.composerPaddingHorizontal },
                    pressed && styles.collabBarPressed]}
                  testID="session.sideChat.bar">
                  <MessagesSquare size={iconSize.sm} color={colors.textTertiary} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={styles.queueEditBarText}>{t('session.sideChat.summary', { count: sideChatCount })}</Text>
                  <ChevronRight size={iconSize.sm} color={colors.textTertiary} strokeWidth={iconStroke.regular} />
                </Pressable>
              ) : null}
              {companionChat && pendingCompanionReplyQuote && sessionId && !shareSelectionActive
                && sessionOperationLayout.composerSlot === 'editable' ? (
                <View
                  style={[styles.companionQuoteBar, { marginHorizontal: composerTouchLayout.composerPaddingHorizontal }]}
                  testID="session.companionQuoteBar"
                >
                  <View style={styles.companionQuoteBarBody}>
                    <BotGroupQuote display={companionReplyQuoteDisplay(pendingCompanionReplyQuote,
                      pendingCompanionQuoteOriginal, companionQuoteNames)} />
                  </View>
                  <RouteActionButton
                    accessibilityLabel={t('message.quote.remove')}
                    hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                    onPress={() => setPendingCompanionReplyQuote(sessionId, null)}
                    style={styles.queueEditBarClose}
                    testID="session.companionQuoteRemove"
                  >
                    <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  </RouteActionButton>
                </View>
              ) : null}
              <SessionResourceCards state={sessionResourceCards} />
              {!sessionResourceCards.blocked ? (
                          <SessionComposerInput
                promptRecommendation={promptRecommendation}
                onDismissPromptRecommendation={dismissPromptRecommendation}
                key={activeComposerDraftScopeKey}
                source={composerDraftSource}
                sessionId={sessionId}
                composerInputRef={composerInputRef}
                canUseComposer={canUseComposer}
                canStopComposer={canStopComposer}
                canUseRemoteSessionControls={canUseRemoteSessionControls}
                remoteUnavailableReason={remoteUnavailableReason}
                voiceState={voiceState}
                voiceStartPending={voiceStartPending}
                voiceCaretPlacementPending={voiceCaretPlacementPending}
                voiceError={voiceError}
                voiceSpeakerFiltered={voiceSpeakerFiltered}
                composerVoiceHoldArmed={composerVoiceHoldArmed}
                setComposerVoiceHoldArmed={setComposerVoiceHoldArmed}
                modelSheetOpen={modelSheetOpen}
                permissionSheetOpen={permissionSheetOpen}
                sending={sending || messageEditSubmitting}
                queueBusy={queueBusy}
                nativeShellLayout={nativeShellLayout}
                composerTouchLayout={composerTouchLayout}
                keyboardState={keyboardState}
                attachmentError={attachmentError}
                visualFocusComposer={visualFocusComposer}
                applyRichComposerChange={applyTypedComposerChange}
                setComposerDraft={setTypedComposerDraft}
                handleComposerInputPressIn={handleComposerInputPressIn}
                beginPastePlaceholders={beginPastePlaceholders}
                failPastePlaceholders={failPastePlaceholders}
                resolvePastedSessionLinkLabel={resolvePastedSessionLinkLabel}
                openVoiceSettings={openVoiceSettings}
                composerSendUnavailableReason={canUseComposer ? null : composerDisabledReason}
                attachmentCount={attachments.length}
                pendingUploadCount={pendingUploads.length}
                onPasteImages={(uris) => {
                  prewarmAgentOnTyping();
                  void addPastedImageAttachments(uris);
                }}
                onDragActiveChange={handleComposerDragActiveChange}
                onInputTopLayout={handleComposerInputTopLayout}
                composerPullThrough={composerPullThrough}
                renderControls={renderComposerControls}
              />
                        ) : null}
            </>
        )}
          {shareSelectionActive ? (
            <ShareSelectionBar
              busy={conversationShareBusy}
              count={shareSelectionCount}
              onCancel={cancelShareSelection}
              onShare={() => void shareSelectedConversation()}
            />
          ) : null}
          </View>
        </View>
        </DockKeyboardLift>
            )}
        </SessionChromeLayer>
        <DockKeyboardViewportSpacer active={dockKeyboardFollow} />
      </ComposerKeyboardAvoidingView>
      </PaneViewportProvider>

      {Platform.OS === 'ios' && adaptiveWindow.barEdge !== 'none' && paneLayout.persistent
        && !shareSelectionActive && !sessionListDrawerOverlayMounted ? (
        <HomeNewTaskButton bottomInset={insets.bottom} onPress={handleDrawerNewSession} />
      ) : null}

      {shareSelectionActive && selectedShareMessages.length > 0 ? (
        <ConversationShareSvg
          key={`${shareImages.revision}-${mode}`}
          allShareableIds={allShareableIds}
          colors={conversationShareColors}
          messages={shareImages.messages}
          ref={conversationShareSvgRef}
          width={conversationShareWidth}
        />
      ) : null}
      <MessageHistoryOverlay>
        <SessionTransientNotice
          notice={transientNotice}
          onDismiss={dismissTransientNotice}
          top={topChromeHeight + spacing.sm}
        />
      </MessageHistoryOverlay>
      <MessageHistoryOverlay>
        {/* The persistent panel belongs to SessionTaskLayout, outside this keyed
            task. Modal drawers keep their exit/navigation lifecycle here. */}
        {!paneLayout.persistent || sessionListDrawerOverlayMounted ? (
        <SessionListDrawer
          newSessionActionRef={homeNewSessionActionRef}
          newSessionInSystemBar={paneLayout.persistent && Platform.OS === 'ios' && adaptiveWindow.barEdge !== 'none'}
          currentSessionId={sessionId}
          onClose={closeSessionListDrawer}
          onClosed={handleSessionListDrawerClosed}
          runNavigation={queueDrawerNavigation}
          onSelectSession={handleDrawerSelectSession}
          open={sessionListDrawerOpen}
          topInset={sessionListDrawerTopInset}
          width={sessionListDrawerWidthRef.current}
        />
        ) : null}
      </MessageHistoryOverlay>
    </View>
  );
}

/**
 * 任务顶栏的挂载层。iOS 常驻消息挂在路由里,顶栏原地渲染即可。Android 的常驻消息层由根节点
 * 画在页面之上,顶栏要经 MessageHistoryOverlay 放到它上面(与任务抽屉同一通道),消息才能
 * 从半透明顶栏下面滚过;按详情区的横向位置对齐,抽屉打开时同样从读屏树里摘掉。
 * 底部输入区同理:外框高度取键盘避让容器的实际高度,键盘弹起时输入框照旧被顶上去。
 */
function SessionChromeLayer({
  children,
  enabled = true,
  height,
  hiddenFromAccessibility,
  left,
  viewport,
  width,
}: {
  children: ReactNode;
  /** 关掉时原地渲染(如伙伴对话的输入区保持实底,不需要盖在消息层上)。 */
  enabled?: boolean;
  /** 外框高度;底部输入区按键盘避让后的可用高度摆放,顶栏不传,由内容撑开。 */
  height?: number;
  hiddenFromAccessibility: boolean;
  left: number;
  viewport: { height: number; width: number; x: number; y: number };
  width: number;
}) {
  if (Platform.OS !== 'android' || !enabled) return <>{children}</>;
  return (
    <MessageHistoryOverlay>
      <View
        importantForAccessibility={hiddenFromAccessibility ? 'no-hide-descendants' : 'auto'}
        pointerEvents="box-none"
        style={{ height, left, position: 'absolute', top: 0, width }}
      >
        {/* 浮层挂在根节点,要把详情区的视口重新提供给顶栏。 */}
        <PaneViewportProvider value={viewport}>{children}</PaneViewportProvider>
      </View>
    </MessageHistoryOverlay>
  );
}

type SessionHeaderIcon = typeof Folder;

function SessionHeaderBar({
  horizontalSystemHeader,
  systemBarHidden = false,
  noticeOverride,
  currentSession,
  diffCount,
  isDeviceAccessRevoked,
  sharedTaskEnded = false,
  shareSelectionLeadingInset,
  shareSelectAllNode,
  syncing,
  syncingImmediately,
  messageCount,
  messageOnly,
  onBack,
  onNewSession,
  onOpenSessionList,
  onOpenFiles,
  onOpenSettings,
  onOpenUsage,
  onOpenRemoteDesktop,
  onTitleDoubleTap,
  onToggleSearch,
  pendingCount,
  queueCount,
  queuePaused,
  remoteUnavailableReason,
  searchOpen,
  title,
}: {
  horizontalSystemHeader: boolean;
  /** 临时任务列表抽屉存续期间收起系统栏,让抽屉顶部控件可见可点。 */
  systemBarHidden?: boolean;
  noticeOverride?: string;
  currentSession: RemoteSession | null;
  diffCount: number;
  isDeviceAccessRevoked: boolean;
  sharedTaskEnded?: boolean;
  /** 宽屏下与消息内容列共用的左侧 inset。 */
  shareSelectionLeadingInset: number;
  /** 分享选择模式下替换头部动作区。 */
  shareSelectAllNode?: ReactNode;
  syncing: boolean;
  syncingImmediately: boolean;
  messageCount: number;
  /** Host-managed canonical Sessions expose conversation controls only. */
  messageOnly: boolean;
  onBack(): void;
  onNewSession?: () => void;
  onOpenSessionList?: () => void;
  onOpenFiles(): void;
  onOpenSettings(): void;
  onOpenUsage(): void;
  onOpenRemoteDesktop(): void;
  /** 双击标题直接打开重命名;不可重命名时不传。 */
  onTitleDoubleTap?: () => void;
  onToggleSearch(): void;
  pendingCount: number;
  queueCount: number;
  queuePaused: boolean;
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
        remoteUnavailableReason,
        searchOpen,
        session: currentSession,
      })
    : null;
  const actionProjection = overview ? projectMobileSessionActions(overview.actions) : null;
  // queue 入口已退役:排队消息 inline 到消息流(InlineQueueSection),不再有独立面板。
  // 两端顶栏右侧同为「远程桌面、文件、更多」;搜索从「更多 → 任务详情」进入(ios-native-design §2、§4)。
  // 协同 Worker 任务在 Lead 的工作区里跑,不单独提供远程桌面 / 文件入口,只留「更多」。
  const workerHeader = currentSession?.orcaRole === 'worker' || currentSession?.source === 'side-chat';
  const headerActions = (actionProjection?.primaryActions ?? [])
    .filter((action) => action.id === 'files');
  const visibleHeaderActions = workerHeader ? [] : headerActions;
  const actionHandlers = {
    files: onOpenFiles,
    queue: () => undefined,
    search: onToggleSearch,
    settings: onOpenSettings,
    usage: onOpenUsage,
  } satisfies Record<SessionActionStripActionId, () => void>;
  const notice = sharedTaskEnded ? null : (noticeOverride ?? compactSessionHeaderNotice({
    isDeviceAccessRevoked,
    pendingCount,
    queuePaused,
    session: currentSession,
  }));
  const nativeHeader = Platform.OS === 'ios';
  const titleDoubleTap = sharedTaskEnded ? undefined : onTitleDoubleTap;
  const handleTitlePress = useDoubleTap(titleDoubleTap);
  const systemBack = useSystemNavigationBack();
  const headerWindow = useWindowDimensions();
  const headerInsets = useSafeAreaInsets();
  // Budget the title together with both toolbars; UIKit cannot shrink a
  // fixed-size React title's contents when the trailing glass capsule grows.
  const nativeTitleMaxWidth = Math.max(0, Math.min(240,
    headerWindow.width - headerInsets.left - headerInsets.right
      - (spacing.lg + spacing.xs) * 2 - navigationChrome.target * ((onOpenSessionList ? 5 : 4) - (workerHeader ? 2 : 0))
      - (onOpenSessionList ? spacing.sm : 0) - spacing.sm * 2,
  ));
  const sessionListButton = onOpenSessionList ? (
    <HomeHeaderGlassButton accessibilityLabel={t('home.drawer.openA11y')}
      onPress={onOpenSessionList} testID="session.sessionListButton">
      <Menu color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
    </HomeHeaderGlassButton>
  ) : null;

  // Let UINavigationBar align controls with the system status area, including Duo portrait.
  if (horizontalSystemHeader) {
    // Stack.Toolbar left/right forces headerShown: true; drop them while the bar is hidden.
    if (systemBarHidden) return <Stack.Screen options={{ headerShown: false }} />;
    const files = overview?.actions.find((action) => action.id === 'files');
    return (
      <>
      <Stack.Screen options={{ headerShown: true, headerTransparent: true,
        headerShadowVisible: false, headerBackVisible: false, headerTitleAlign: 'center',
        headerStyle: { backgroundColor: 'transparent' }, headerTintColor: colors.textPrimary,
        // Route-owned options survive the title component's unmount during a pop transition.
        headerTitle: () => (
          <View style={{ width: nativeTitleMaxWidth, height: navigationChrome.target,
            // Reserve the toolbar gaps in the width budget, outside the title.
            minWidth: 0, flexShrink: 1, overflow: 'hidden', justifyContent: 'center' }}>
            <SessionHeaderNativeTitle title={title} pinned={!messageOnly && !!currentSession?.pinnedAt}
              tags={isDeviceAccessRevoked ? undefined : currentSession?.tags} onTagsPress={onOpenSettings}
              onTitleDoubleTap={titleDoubleTap}
              syncing={syncing} syncingImmediately={syncingImmediately} notice={notice} />
          </View>
        ),
      }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <SessionHeaderNativeBack label={t('shared.back')} onPress={onBack} />
        </Stack.Toolbar.View>
        {sessionListButton ? <Stack.Toolbar.View hidesSharedBackground>{sessionListButton}</Stack.Toolbar.View> : null}
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.View hidesSharedBackground>
          <SessionHeaderNativeActions available={!!currentSession}
            desktopLabel={t('remoteDesktop.title')}
            filesLabel={t('session.presentation.overview.actions.files.a11y')}
            moreLabel={t('session.menu.details')} files={files} detailsOnly={workerHeader}
            onDetails={onOpenSettings} onDesktop={onOpenRemoteDesktop}
            onAction={(id) => actionHandlers[id]()} />
        </Stack.Toolbar.View>
      </Stack.Toolbar>
    </>
    );
  }

  // 分享选择模式只保留全选；底部关闭按钮负责退出。
  if (shareSelectAllNode) {
    return (
      <View
        style={[
          styles.sessionHeaderBar,
          nativeHeader && styles.sessionHeaderBarNative,
          { paddingLeft: shareSelectionLeadingInset + spacing.sm },
        ]}
        testID="session.summary"
      >
        <Stack.Screen options={{ headerShown: false }} />
        {shareSelectAllNode}
      </View>
    );
  }
  return (
    <View style={[styles.sessionHeaderBar, nativeHeader && styles.sessionHeaderBarNative]} testID="session.summary">
      <SystemNavigationBack label={t('shared.back')} onPress={onBack} />
      {sessionListButton}
      {systemBack ? (
        <Stack.Toolbar placement="right">
        {workerHeader ? null : (
            <Stack.Toolbar.Button icon={require('../../assets/navigation/monitor.png')} iconRenderingMode="template"
          accessibilityLabel={t('remoteDesktop.title')} disabled={!currentSession} onPress={onOpenRemoteDesktop} />
          )}
        {workerHeader ? null : (
            <Stack.Toolbar.Button icon={require('../../assets/navigation/folder.png')} iconRenderingMode="template"
          accessibilityLabel={t('session.presentation.overview.actions.files.a11y')}
          disabled={!currentSession || !overview?.actions.some(
                  (action) => action.id === 'files' && !action.disabled)}
          onPress={onOpenFiles} />
          )}
        <Stack.Toolbar.Button icon="ellipsis" accessibilityLabel={t('session.menu.details')}
          disabled={!currentSession} onPress={onOpenSettings} />
      </Stack.Toolbar>
      ) : null}
      {systemBack ? null : nativeHeader ? (
        <SessionHeaderNativeBack label={t('shared.back')} onPress={onBack} />
      ) : (
        <ScreenBackButton
          hitSlop={4}
          onPress={onBack}
          style={styles.sessionHeaderBackButton}
          testID="session.backButton"
        />
      )}

      {nativeHeader ? <SessionHeaderNativeTitle
        title={sharedTaskEnded ? t('sharedTask.ended') : title}
          tags={isDeviceAccessRevoked ? undefined : currentSession?.tags}
          onTagsPress={onOpenSettings}
          onTitleDoubleTap={titleDoubleTap}
        pinned={!messageOnly && !!currentSession?.pinnedAt}
        syncing={syncing}
        syncingImmediately={syncingImmediately}
        notice={notice}
      /> : (
      // 双击标题改名;不参与读屏焦点,读屏用户从「任务详情」进入重命名。
      <Pressable accessible={false} disabled={!titleDoubleTap} onPress={handleTitlePress}
        style={styles.sessionHeaderTextBlock} testID="session.titleArea">
        <View style={styles.sessionHeaderTitleRow}>
          {!messageOnly && currentSession?.pinnedAt ? (
            <Pin
              color={colors.textTertiary}
              size={iconSize.sm}
              strokeWidth={iconStroke.regular}
            />
          ) : null}
          <Text numberOfLines={1} style={styles.sessionHeaderTitle} testID="session.title">
            {sharedTaskEnded ? t('sharedTask.ended') : title}
          </Text>
          <TaskTagDots
              tags={isDeviceAccessRevoked ? undefined : currentSession?.tags}
              maxVisible={7}
              onPress={onOpenSettings}
            />
            <QuietSyncIndicator active={syncing} immediate={syncingImmediately} />
        </View>
        {notice ? (
          <Text numberOfLines={1} style={styles.sessionHeaderNotice} testID="session.headerNotice">
            {notice}
          </Text>
        ) : null}
      </Pressable>
      )}

      {sharedTaskEnded || systemBack ? null : nativeHeader ? (
        <SessionHeaderNativeActions
          available={!!currentSession}
          desktopLabel={t('remoteDesktop.title')}
          filesLabel={t('session.presentation.overview.actions.files.a11y')}
          moreLabel={t('session.menu.details')}
          files={overview?.actions.find((action) => action.id === 'files')}
          detailsOnly={workerHeader}
          onDetails={onOpenSettings}
          onDesktop={onOpenRemoteDesktop}
          onAction={(id) => actionHandlers[id]()}
        />
      ) : (
        <View style={styles.sessionHeaderActions}>
        {workerHeader ? null : (
          <SessionHeaderIconButton
            accessibilityLabel={t('remoteDesktop.title')}
            active={false}
            disabled={!currentSession}
            icon={Monitor}
            onPress={currentSession ? onOpenRemoteDesktop : undefined}
            testID="session.remoteDesktop"
          />
        )}
        {visibleHeaderActions.map((action) => (
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
          accessibilityLabel={t('session.menu.details')}
          active={false}
          disabled={!currentSession}
          icon={Ellipsis}
          onPress={currentSession ? onOpenSettings : undefined}
          testID="session.controlsToggle"
        />
      </View>
      )}
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
  pendingCount,
  queuePaused,
  session,
}: {
  isDeviceAccessRevoked: boolean;
  pendingCount: number;
  queuePaused: boolean;
  session: RemoteSession | null;
}): string | null {
  if (isDeviceAccessRevoked) return i18n.t('session.screen.accessRevoked');
  if (!session) return null;
  if (pendingCount > 0) return i18n.t('session.screen.pendingCount', { num: pendingCount });
  // 协同任务(Lead / Worker 等)显示协同标签,标明其协同身份。
  const collaborationLabel = sessionCollaborationLabel(session);
  if (collaborationLabel) return collaborationLabel;
  if (session.status === 'archived') return i18n.t('session.screen.archived');
  if (queuePaused) return i18n.t('session.screen.queuePausedNotice');
  return null;
}

interface SessionComposerPaletteProps {
  source: ComposerDraftSource;
  commandsRef: RefObject<MobileSlashCommand[]>;
  pendingSkillSelectionRef: RefObject<{ name: string; sid: string } | null>;
  canUseComposer: boolean;
  canUseRemoteSessionControls: boolean;
  canUseSideChats: boolean;
  currentSession: RemoteSession | null | undefined;
  deviceId: string;
  maker: ReturnType<typeof useMobileMakerTransport>;
  openLink: ReturnType<typeof useDeviceLink>['openLink'];
  shareSelectionActive: boolean;
  nativeShellLayout: ReturnType<typeof buildSessionNativeShellLayout>;
  contextSheetOpen: boolean;
  composerHorizontalInset: number;
  selectSlashCommand: (command: MobileSlashCommand) => void;
  selectComposerPlugin: (plugin: ComposerPlugin, roster: ComposerPlugin[]) => void;
  selectAtResource: (item: MobileAtResourceItem) => void;
}

/** Candidate filtering and remote query effects subscribe beside the editor. */
function SessionComposerPalette({
  source, commandsRef, pendingSkillSelectionRef, canUseComposer, canUseRemoteSessionControls, canUseSideChats,
  currentSession, deviceId, maker, openLink, shareSelectionActive, nativeShellLayout,
  contextSheetOpen, composerHorizontalInset, selectSlashCommand, selectComposerPlugin, selectAtResource,
}: SessionComposerPaletteProps) {
  const { draft } = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const { t } = useTranslation();
  const [slashCommands, setLocalSlashCommands] = useState<MobileSlashCommand[]>([]);
  const [slashPaletteLoading, setSlashPaletteLoading] = useState(false);
  const [slashPaletteError, setSlashPaletteError] = useState<string | null>(null);
  const [atResources, setAtResources] = useState<MobileAtResourceItem[]>([]);
  const [atPaletteLoading, setAtPaletteLoading] = useState(false);
  const [atPaletteError, setAtPaletteError] = useState<string | null>(null);
  const [atResourcesTruncated, setAtResourcesTruncated] = useState(false);

  const slashLoadSeqRef = useRef(0);
  const atLoadSeqRef = useRef(0);
  const setSlashCommands = useCallback((commands: MobileSlashCommand[]) => {
    commandsRef.current = commands;
    setLocalSlashCommands(commands);
  }, [commandsRef]);
  useEffect(() => () => {
    slashLoadSeqRef.current += 1;
    atLoadSeqRef.current += 1;
  }, []);
  const composerTrigger = useMemo(() => detectComposerTrigger(draft), [draft]);
  const pluginPaletteVisible = useMemo(() => detectComposerPluginTrigger(draft) !== null, [draft]);
  const visibleSlashCommands = useMemo(
    () => canUseComposer && composerTrigger.kind === 'slash'
      ? filterSlashCommands(mergeMobileLocalSlashCommands(mergeMobileGoalCommand(
        canUseSideChats ? mergeMobileSideChatCommand(slashCommands, t('session.sideChat.commandDescription'))
          : slashCommands.filter(
                      (command) => command.kind !== 'desktop' || command.name !== 'side'),
        t('session.common.goalMode'))), composerTrigger.query, 5)
      : [],
    [canUseComposer, canUseSideChats, composerTrigger, slashCommands, t],
  );
  const visibleAtResources = useMemo(
    () => canUseComposer && composerTrigger.kind === 'at'
      ? filterAtResources(atResources, composerTrigger.query, 5)
      : [],
    [atResources, canUseComposer, composerTrigger],
  );

  useEffect(() => {
    if (!canUseRemoteSessionControls || composerTrigger.kind !== 'slash' || !currentSession || !deviceId) {
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
    const paletteCacheKey = buildComposerPaletteCacheKey(
      deviceId,
      agentKind,
      currentSession.workingDir ?? '',
      currentSession.id,
    );
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
        maker.listAgentCommands(agentKind, { sessionId: currentSession.id }),
        maker.listAgentSkills(agentKind, {
          ...(currentSession.workingDir ? { workingDir: currentSession.workingDir } : {}),
          forceReload: false,
          sessionId: currentSession.id,
        }),
        // desktop 命令是 additive 展示(白名单分流不依赖此清单,清单只参与同名 skill
        // 让行仲裁,见 desktopSlashCommands):拉取失败(含老被控端无此通道)静默降级
        // 为不展示,不能拖垮 builtin/skill 两路。
        maker.listDesktopCommands().catch(
          () => ({ success: false }) satisfies MobileDesktopCommandListResult,
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
    return () => { slashLoadSeqRef.current += 1; };
  }, [canUseRemoteSessionControls, composerTrigger.kind, currentSession, deviceId, maker, openLink, setSlashCommands, pendingSkillSelectionRef]);

  useEffect(() => {
    if (!canUseRemoteSessionControls || composerTrigger.kind !== 'at' || !currentSession?.workingDir || !deviceId) {
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
    const remoteQuery = cachedScan?.result.truncated ? query || undefined
      : undefined;
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
    return () => { clearTimeout(timer); atLoadSeqRef.current += 1; };
  }, [canUseRemoteSessionControls, composerTrigger, currentSession, deviceId, maker, openLink]);


  return (
    <>
          {!shareSelectionActive && canUseComposer && !isSharedTaskPeer(deviceId) ? (
            <ComposerPluginPalette
              deviceId={deviceId}
              workingDir={currentSession?.workingDir ?? undefined}
              draft={draft}
              enabled={contextSheetOpen || pluginPaletteVisible}
              visible={pluginPaletteVisible}
              horizontalInset={composerHorizontalInset}
              maxHeight={nativeShellLayout.paletteMaxHeight}
              onSelect={selectComposerPlugin}
              testID="session.pluginPalette"
            />
          ) : null}
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


    </>
  );
}

interface SessionComposerControlState {
  composerLayout: ReturnType<typeof buildSessionComposerLayout>;
  composerSendUnavailableReason: string | null;
  composerStopDisabledReason: string | null | undefined;
  composerStopDisabled: boolean;
  composerShowInlineStop: boolean;
  composerSendSlotIsStop: boolean;
  composerShowSendButton: boolean;
  composerSendDisabled: boolean;
  voiceIsListening: boolean;
  voiceIsProcessing: boolean;
  voiceProcessingIndicator: ReturnType<typeof useMobileVoiceProcessingIndicator>;
  voiceIsBusy: boolean;
  voiceRecordingTimer: ReturnType<typeof useMobileVoiceRecordingTimer>;
  composerVoicePlacement: ReturnType<typeof resolveMobileComposerVoiceButtonPlacement> | undefined;
}
interface SessionComposerControls {
  toolbar: ReactNode;
  leading: ReactNode;
  trailing: ReactNode;
  attachmentTray: ReactNode;
  voiceButton: (style?: StyleProp<ViewStyle>) => ReactNode;
}
interface SessionComposerInputProps {
  promptRecommendation?: string | null;
  onDismissPromptRecommendation: () => void;
  source: ComposerDraftSource;
  sessionId: string;
  composerInputRef: RefObject<ComposerRichInputHandle | null>;
  canUseComposer: boolean;
  canStopComposer: boolean;
  canUseRemoteSessionControls: boolean;
  remoteUnavailableReason: string | null;
  composerSendUnavailableReason: string | null;
  voiceState: MobileVoiceState;
  voiceStartPending: boolean;
  voiceCaretPlacementPending: boolean;
  voiceError: string | null;
  /** The voiceprint filter just muted someone else's speech. */
  voiceSpeakerFiltered: boolean;
  composerVoiceHoldArmed: boolean;
  setComposerVoiceHoldArmed: (value: boolean) => void;
  modelSheetOpen: boolean;
  permissionSheetOpen: boolean;
  sending: boolean;
  queueBusy: boolean;
  nativeShellLayout: ReturnType<typeof buildSessionNativeShellLayout>;
  composerTouchLayout: ReturnType<typeof buildComposerTouchLayout>;
  keyboardState: ReturnType<typeof useMobileKeyboardState>;
  attachmentError: string | null;
  attachmentCount: number;
  pendingUploadCount: number;
  visualFocusComposer: boolean;
  applyRichComposerChange: (value: ComposerDocument) => void;
  setComposerDraft: (value: SetStateAction<string>) => void;
  handleComposerInputPressIn: () => void;
  onPasteImages: (uris: string[]) => void;
  beginPastePlaceholders: (count: number) => void;
  failPastePlaceholders: () => void;
  resolvePastedSessionLinkLabel: NonNullable<React.ComponentProps<typeof ComposerRichInput>['resolveSessionLinkLabel']>;
  openVoiceSettings: () => void;
  onDragActiveChange: (active: boolean) => void;
  /** Reports where the input itself starts in the bottom overlay (below any recommendation card). */
  onInputTopLayout: (event: LayoutChangeEvent) => void;
  /** 聊天记录往下拖到输入框顶边时接手这次拖动。 */
  composerPullThrough: ComposerPullThroughBridge;
  renderControls: (state: SessionComposerControlState) => SessionComposerControls;
}

/** High-frequency editor, dictation, timer and resize state stops at this boundary. */
function SessionComposerInput({
  promptRecommendation,
  onDismissPromptRecommendation,
  source, sessionId, composerInputRef, canUseComposer, canStopComposer, canUseRemoteSessionControls, remoteUnavailableReason, voiceState, voiceStartPending, voiceCaretPlacementPending, voiceError, voiceSpeakerFiltered, composerVoiceHoldArmed, setComposerVoiceHoldArmed, modelSheetOpen, permissionSheetOpen, sending, queueBusy, nativeShellLayout, composerTouchLayout, keyboardState, attachmentError, visualFocusComposer, applyRichComposerChange, setComposerDraft, handleComposerInputPressIn, beginPastePlaceholders, failPastePlaceholders, resolvePastedSessionLinkLabel, openVoiceSettings,
  composerSendUnavailableReason, attachmentCount, pendingUploadCount,
  onPasteImages, onDragActiveChange, onInputTopLayout, composerPullThrough, renderControls,
}: SessionComposerInputProps) {
  const { document: composerDocument, draft } = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const { t, i18n: i18nInstance } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const windowDimensions = useWindowDimensions();
  const composerDock = useComposerDock();
  const [composerFocused, setComposerFocused] = useState(false);
  const composerPillOpen = useComposerPillOpen(composerDock.enabled && canUseComposer, () => composerInputRef.current?.focus());
  const [composerInputContentHeight, setComposerInputContentHeight] = useState(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT);
  const [composerAttachmentTrayHeight, setComposerAttachmentTrayHeight] = useState(0);
  const [voiceDraftCaretFrame, setVoiceDraftCaretFrame] = useState({ left: 0, top: 0 });
  const voiceDraftCaretRef = useRef<View>(null);
  const voiceDraftMeasuredBlockRef = useRef<View>(null);
  const composerScrollViewRef = useRef<ScrollView>(null);
  const composerScrollEnabledRef = useRef(false);
  const voiceDraftScrollRef = useRef<ScrollView>(null);
  const composerTrigger = useMemo(() => detectComposerTrigger(draft), [draft]);
  const voiceUiAvailable = shouldShowMobileVoiceUi(Platform.OS);
  const voiceIsListening = voiceState === 'listening';
  const voiceIsProcessing = voiceState === 'submitting' || voiceState === 'refining';
  const voiceIsBusy = voiceIsListening || voiceIsProcessing;
  const canOpenVoiceSettings = isMobileVoiceMicPermissionError(voiceError);
  // 引用已是 ComposerDocument 内的 atom；排队编辑同样可能只有引用而没有可见
  // 文本，因此必须计入 payload，否则「保存修改」会被错误禁用。
  const composerQuoteCount = composerDocumentQuotes(composerDocument).length;
  // Context 面板是 Modal sheet,不再有内联附件面板 → attachmentPickerOpen 恒 false。
  const composerLayout = useMemo(() => buildSessionComposerLayout({
    attachmentBusy: false,
    // pending(乐观上传中)计入:拍完照 / 选完文件立即可点发送,send() 内部会等落定。
    attachmentCount: attachmentCount + pendingUploadCount,
    attachmentPickerOpen: false,
    // Stop 的可见性跟随真实运行 / 队列状态；断线时只单独禁用交互。
    canStop: canStopComposer,
    draftText: draft,
    queueBusy,
    quoteCount: composerQuoteCount,
    sendUnavailableReason: composerSendUnavailableReason,
    sending,
    voiceState,
  }), [
    attachmentCount,
    pendingUploadCount,
    canStopComposer,
    canUseComposer,
    composerQuoteCount,
    composerSendUnavailableReason,
    draft,
    i18nInstance.language,
    queueBusy,
    sending,
    voiceState,
  ]);
  const compactComposer = composerLayout.density === 'compact';
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
  // 只有确定性不可用(撤权 / 关闭远控等)才禁发送；普通断线与自动恢复状态仍可发，
  // 消息进入本地 outbox 等连接恢复。输入框在两类状态下都保持可编辑与持久化。
  const composerSendDisabled = composerLayout.send.disabled
    || (Platform.OS === 'ios' && !composerLayout.send.visible && !voiceStartPending);
  const composerStopDisabled = composerLayout.stop.disabled || !canUseRemoteSessionControls;
  const composerStopDisabledReason = !canUseRemoteSessionControls
    ? (remoteUnavailableReason ?? t('session.menu.aiRenameOffline'))
    : composerLayout.stop.disabledReason;
  const composerShowInlineStop = composerLayout.stop.visible && !composerSendSlotIsStop && !sending;
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
  // 停止后 150ms 内保持录音胶囊(仍禁止操作),超过才换处理转圈:快速收尾不闪转圈。
  const voiceProcessingIndicator = useMobileVoiceProcessingIndicator(voiceState);
  const voiceRecordingTimer = useMobileVoiceRecordingTimer({
    expanded: voiceIsListening || voiceStartPending || voiceProcessingIndicator.stopping,
    counting: voiceIsListening,
  });
  const composerEffectiveContentHeight = composerInputContentHeight;
  const voiceDraftShowsListeningPrompt = voiceIsListening && draft.length === 0;
  // 状态行只承载错误信息与声纹过滤提示(错误优先);「正在听 / 转写中」不再占一行,对齐桌面版——
  // 录音状态由输入框内的语音按钮形态(Mic / 红点计时胶囊 / spinner)表达。
  const voiceStatusText = voiceError ?? (voiceSpeakerFiltered ? t('composer.voice.speakerFiltered') : null);
  const voiceStatusVisible = voiceUiAvailable && Boolean(voiceStatusText);

  // 聚焦 / 面板打开 / 语音中呈现卡片形态（输入区全宽 + 底部工具排），其余保持单行简洁态。
  // 注意不看 composerLayout.density：有草稿 / 会话运行中未聚焦时也应收回简洁态，
  // 否则「拖回单行退出激活态」永远收不回去。
  // 语音结束后草稿仍有内容时经 hold 保持展开(一行文字也不收),
  // 不随 voiceIsBusy 归零塌回简洁态。
  const composerVoiceHoldActive = resolveComposerVoiceHoldActive({
    armed: composerVoiceHoldArmed,
    draftText: draft,
  });
  const composerCardActive = (canUseComposer && (composerFocused || composerPillOpen.opening))
    || modelSheetOpen
    || permissionSheetOpen
    || voiceStartPending
    || voiceIsBusy
    || composerVoiceHoldActive;
  const recommendationPresentation = usePromptRecommendationVisibility(sessionId, draft, composerCardActive);
  const visibleRecommendation = promptRecommendation && recommendationPresentation.visible
    && !composerQuoteCount && !attachmentCount && !pendingUploadCount
    && canUseComposer && !canStopComposer && !sending && !queueBusy
    && !voiceIsBusy && !voiceStartPending && !modelSheetOpen && !permissionSheetOpen
    ? promptRecommendation : null;
  const acceptRecommendation = useCallback(() => {
    if (!promptRecommendation) return;
    recommendationPresentation.hide();
    setComposerDraft((current) => current ? `${current}\n${promptRecommendation}` : promptRecommendation);
    composerInputRef.current?.focus();
  }, [promptRecommendation, recommendationPresentation.hide, setComposerDraft, composerInputRef]);
  useComposerCardTransition(composerCardActive, keyboardState);
  const composerChromeHeight = useMemo(() => {
    const statusReserve = voiceStatusVisible
      ? COMPOSER_STATUS_ROW_RESERVED_HEIGHT + COMPOSER_STACK_GAP_HEIGHT
      : 0;
    const rowChrome = composerCardActive
      ? COMPOSER_CARD_ROW_CHROME_HEIGHT
      : COMPOSER_INPUT_ROW_CHROME_HEIGHT;
    // 附件托盘与文字同在卡片里:计入 chrome,文字超出时由输入框自己滚、裁掉上方文字。
    return (
      COMPOSER_VERTICAL_PADDING_HEIGHT + statusReserve + rowChrome + composerAttachmentTrayHeight
    );
  }, [composerAttachmentTrayHeight, composerCardActive, voiceStatusVisible]);
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
  // Installed apps arbitrate grabber/scroll ownership on UI via Gesture.Native.
  // Retain the native scroll switch for Expo Go's PanResponder fallback.
  const handleGrabberTouchActiveChange = useCallback((active: boolean) => {
    onDragActiveChange(active);
    composerScrollViewRef.current?.setNativeProps({
      scrollEnabled: active ? false : composerScrollEnabledRef.current,
    });
  }, [onDragActiveChange]);
  const composerResize = useComposerResize({
    autoMaxContentHeight: composerInputMaxContentHeight,
    // 简洁态一律收到单行(下拉收起和点别处收键盘的结果一致);
    // auto / manual 记忆保留,重新聚焦后恢复。
    collapsed: !composerCardActive,
    minFrameHeight: Platform.OS !== 'ios' && voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined,
    composerChromeHeight,
    contentHeight: composerEffectiveContentHeight,
    keyboardHeight: keyboardState.visible ? keyboardState.height : 0,
    onGrabberTouchActiveChange: handleGrabberTouchActiveChange,
    onSnapToAuto: handleComposerSnapToAuto,
    pullThrough: composerPullThrough,
    singleLineContentHeight: COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT,
    windowHeight: windowDimensions.height,
  });
  // 只有展开卡片态（顶边热区可见）才接手聊天记录里的下拉。
  useEffect(() => {
    composerPullThrough.armed.value = composerCardActive;
    return () => { composerPullThrough.armed.value = false; };
  }, [composerCardActive, composerPullThrough]);
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
  const composerShellHasScrollableContent = attachmentCount > 0
    || pendingUploadCount > 0
    || attachmentError !== null
    || composerTrigger.kind === 'slash'
    || composerTrigger.kind === 'at';
  // Only enable shell scrolling when attachments or palettes can overflow.
  // Native gesture arbitration lets the grabber win without waiting for JS.
  const composerScrollEnabled = (nativeShellLayout.composerScrollEnabled || composerTrigger.kind !== 'none')
    && !composerResize.dragging
    && composerShellHasScrollableContent;
  composerScrollEnabledRef.current = composerScrollEnabled;
  const resizeActive = composerResize.active;
  const manualResize = composerResize.mode === 'manual';
  const expandedMaxHeight = composerResize.maxFrameHeight + composerChromeHeight;
  const autoMaxHeight = nativeShellLayout.composerMaxHeight;
  const composerContainerStyle = useAnimatedStyle(() => ({
    maxHeight: resizeActive.value || manualResize ? expandedMaxHeight : autoMaxHeight,
  }));
  const handleComposerInputContentSizeChange = useCallback((event: TextInputContentSizeChangeEvent) => {
    const nextHeight = Math.max(
      COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT,
      Math.ceil(event.nativeEvent.contentSize.height),
    );
    setComposerInputContentHeight((currentHeight) =>
        Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight
    );
  }, []);
  const handleComposerRichInputHeight = useCallback((height: number) => {
    const nextHeight = Math.max(COMPOSER_INPUT_SINGLE_LINE_CONTENT_HEIGHT, Math.ceil(height));
    setComposerInputContentHeight((currentHeight) =>
      Math.abs(currentHeight - nextHeight) < 1 ? currentHeight : nextHeight,
    );
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

  const renderComposerResizeHandle = () => (
    <ComposerResizeGrabber
      onAdjust={composerResize.adjustByLine}
      panHandlers={composerResize.panHandlers}
      gesture={composerResize.gesture}
      measureRef={composerPullThrough.grabberRef}
      testID="session.composerResizeGrabber"
      visible
    />
  );

  const voiceDraftInsertionEnd = composerInputRef.current?.getSelection(draft).end ?? draft.length;
  const renderComposerInputOverlay = () => voiceIsListening && nativeComposerAvailable ? (
    <Pressable accessibilityLabel={t('session.common.voiceStopRecording')} accessibilityRole="button" onPress={handleComposerInputPressIn} onPressIn={handleComposerInputPressIn} style={styles.voiceDraftOverlay} testID="session.voiceDraftOverlay" />
  ) : voiceIsListening ? (
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
        style={styles.voiceDraftScroll}
      >
        {voiceDraftShowsListeningPrompt ? (
          <View style={styles.voiceDraftListeningPrompt}>
            <VoiceMicWaveCaret color={colors.textPrimary} testID="session.voiceMicCaret" />
            <Text style={styles.voiceDraftListeningText}>{composerLayout.input.placeholder}</Text>
          </View>
        ) : (
          <View ref={voiceDraftMeasuredBlockRef} collapsable={false} style={styles.voiceDraftMeasuredBlock}>
            <Text onTextLayout={handleVoiceDraftTextLayout} style={styles.voiceDraftText}>
              {draft.slice(0, voiceDraftInsertionEnd)}
              <VoiceMicWaveCaret color={colors.textPrimary} testID="session.voiceMicCaret" viewRef={voiceDraftCaretRef} />
              {draft.slice(voiceDraftInsertionEnd)}
            </Text>
          </View>
        )}
      </ScrollView>
    </Pressable>
  ) : null;

  // 听写期间只滚动覆盖层跟随最新文字,**不碰隐藏编辑器的 caret**(2026-07-28):
  // 旧实现每段转写都把选区挪到末尾,而富文本编辑器的选区操作底层是 WebView
  // 程序化 focus,配合 keyboardDisplayRequiresUserAction={false} 会在点语音的
  // 同时弹出软键盘。#551 之前这个 focus 表现为「听写刚开始就被掐断」(focus 即
  // 停听写),#551 修掉掐断后它幸存为弹键盘。听写中输入框本就隐藏(覆盖层渲染
  // 草稿),caret 无意义;落焦统一放在听写结束点(finishVoiceRecording)。
  useEffect(() => {
    if (!voiceIsListening) return undefined;
    const frame = requestAnimationFrame(() => {
      voiceDraftScrollRef.current?.scrollTo({ y: voiceDraftCaretFrame.top, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerInputContentHeight, composerInputVisibleHeight, draft, voiceDraftCaretFrame.top, voiceIsListening]);

  useEffect(() => {
    if (voiceIsListening && draft.length > 0) return;
    setVoiceDraftCaretFrame({ left: 0, top: 0 });
  }, [draft.length, voiceIsListening]);


  const controls = renderControls({ composerLayout, composerSendUnavailableReason, composerStopDisabledReason, composerStopDisabled, composerShowInlineStop, composerSendSlotIsStop, composerShowSendButton, composerSendDisabled, voiceIsListening, voiceIsProcessing, voiceProcessingIndicator, voiceIsBusy, voiceRecordingTimer, composerVoicePlacement });
  return (
    <>
      {visibleRecommendation ? (
        <View style={{ paddingHorizontal: composerTouchLayout.composerPaddingHorizontal }}>
          <PromptRecommendation
            key={`${sessionId}:${visibleRecommendation}`}
            prompt={visibleRecommendation}
            onAccept={acceptRecommendation}
            onDismiss={onDismissPromptRecommendation}
          />
        </View>
      ) : null}
      {/* Zero-height marker: the edge backdrop starts at the input, not at cards above it. */}
      <View onLayout={onInputTopLayout} pointerEvents="none" testID="session.composerInputTop" />
              <Reanimated.View
                style={[
                  styles.composer,
                  composerContainerStyle,
                  {
                    paddingHorizontal: composerTouchLayout.composerPaddingHorizontal,
                  },
                ]}
                testID="session.composer"
              >
                {voiceStatusVisible ? (
                  <View style={styles.voiceStatusRow}>
                    <Text style={styles.voiceStatusText} testID="session.voiceStatus">
                      {voiceStatusText}
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
                {attachmentError ? (
                  <Text style={styles.attachmentErrorText} testID="session.attachmentStatus">
                    {attachmentError}
                  </Text>
                ) : null}
                {/* Keep UIKit's shadow outside the scrolling viewport's rectangular clip. */}
                <ComposerFrame
                  onTouchStart={recommendationPresentation.hide}
                  expanded={composerCardActive}
                  expandToken={composerPillOpen.expandToken}
                  unframed={!nativeComposerFrameAvailable}
                  style={styles.composerScrollFrame}
                >
                <View style={[
                  styles.composerSurface,
                  compactComposer && !composerCardActive && styles.composerSurfaceCompact,
                ]}>
                  <MobileComposerInputRow
                    key={sessionId}
                    frameOutside={nativeComposerFrameAvailable}
                    bodyScrollGesture={composerResize.scrollGesture}
                    bodyScrollRef={composerScrollViewRef}
                    bodyScrollTestID="session.composerScroll"
                    bodyScrollEnabled={composerScrollEnabled}
                    collapsedHeight={composerDock.enabled ? composerDock.pillHeight : undefined}
                    onCollapsedPress={composerPillOpen.onCollapsedPress}
                    accessibilityLabel={t('session.screen.composerPlaceholder')}
                    accessibilityHint={composerLayout.input.disabledReason ?? undefined}
                    accessoryAbove={controls.attachmentTray}
                    onAccessoryAboveHeightChange={setComposerAttachmentTrayHeight}
                    autoFocus={visualFocusComposer}
                    cardActive={composerCardActive}
                    caretHidden={voiceIsListening}
                    compact={compactComposer && !composerCardActive}
                    editable={!composerLayout.input.disabled}
                    floatingVoiceButton={voiceUiAvailable ? controls.voiceButton : undefined}
                    cursorColor={colors.inputCaret}
                    inputFrameAnimatedStyle={composerResize.frameStyle}
                    collapseProgress={composerResize.collapseProgress}
                    // 听写期间把输入区撑到 44pt 触控目标:命中层盖在 inputFrame 上,
                    // hitSlop 越不过父边界(见常量注释)。
                    inputFrameMinHeight={Platform.OS !== 'ios' && voiceIsListening ? MOBILE_COMPOSER_MIN_TOUCH_TARGET : undefined}
                    inputElement={
                <ComposerRichInput
                        ref={composerInputRef}
                        accessibilityHint={composerLayout.input.disabledReason ?? undefined}
                        accessibilityLabel={t('session.screen.composerPlaceholder')}
                        document={composerDocument}
                        editable={!composerLayout.input.disabled}
                        height={composerInputVisibleHeight}
                        animatedHeight={composerResize.contentHeight}
                        hidden={voiceIsListening && !nativeComposerAvailable}
                        caretHidden={voiceIsListening || voiceCaretPlacementPending}
                        maxHeight={composerResize.inputMaxHeight}
                        opticalPadding={composerCardActive}
                        onBlur={() => {
                          setComposerFocused(false);
                          setComposerVoiceHoldArmed(false);
                        }}
                        onChangeDocument={applyRichComposerChange}
                        onFocus={() => setComposerFocused(true)}
                        onHeightChange={handleComposerRichInputHeight}
                        onPasteImages={onPasteImages}
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
                          placeholder: colors.textPlaceholder,
                          text: colors.textPrimary,
                          textSecondary: colors.textSecondary,
                        }}
                      />
              }
                    inputOverlay={renderComposerInputOverlay()}
                    inputStyle={voiceIsListening ? styles.inputVoiceHidden : undefined}
                    inputTestID="session.composerInput"
                    leading={controls.leading}
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
                    onPasteImages={onPasteImages}
                    onPasteImagesLoading={beginPastePlaceholders}
                    onPasteImagesLoadFailed={failPastePlaceholders}
                    onPressIn={handleComposerInputPressIn}
                    placeholder={voiceIsListening ? '' : composerLayout.input.placeholder}
                    placeholderTextColor={colors.textPlaceholder}
                    resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}
                    scrollEnabled={composerInputScrollEnabled}
                    selectionColor={colors.inputCaret}
                    testID="session.composerInputRow"
                    toolbar={controls.toolbar}
                    trailing={composerCardActive ? null : controls.trailing}
                    value={draft}
                    voicePlacement={composerVoicePlacement}
                  />
                </View>
                </ComposerFrame>
              </Reanimated.View>
    </>

  );
}

function SessionSearchSheet({
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
  // 两端同一套计数文案；命中内容直接在原消息处定位，不再重复展示预览（ios-native-design §5）。
  const counter = normalizedQuery
    ? hasHits ? `${activeIndex + 1} / ${hitCount}` : '0 / 0'
    : t('session.screen.searchEnterKeyword');
  if (Platform.OS === 'ios') {
    return (
      <SessionSearchNative
      visible={visible}
      query={query}
      counter={counter}
      hasHits={hasHits}
      loadEarlier={loadEarlierAction}
      onChangeQuery={onChangeQuery}
      onClose={onClose}
      onMove={onMove}
      onLoadEarlier={onLoadEarlier}
    />
    );
  }
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
          {/* 单行搜索框统一胶囊:底色 / 描边 / 高度与首页 HomeSearchBar 对齐(HomeSearchBar 自带筛选钮,这里不需要,故只对齐样式)。 */}
          <View style={styles.searchInputPill}>
            <Search color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            <TextInput
              accessibilityLabel={t('session.screen.searchPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={visible}
              onChangeText={onChangeQuery}
              placeholder={t('session.screen.searchPlaceholder')}
              placeholderTextColor={colors.textPlaceholder}
              returnKeyType="search"
              style={styles.searchInput}
              testID="session.searchInput"
              value={query}
            />
            {query ? (
              <Pressable
                accessibilityLabel={t('devices.detail.search.clearA11y')}
                accessibilityRole="button"
                onPress={() => onChangeQuery('')}
                style={({ pressed }) => [styles.searchClearButton, pressed && mobileInteractionStyles.pressed]}
                testID="session.searchClearButton"
              >
                <X color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              </Pressable>
            ) : null}
          </View>
          <View style={styles.searchToolbar}>
            <Text style={styles.searchCounter} testID="session.searchCounter">
              {counter}
            </Text>
            <View style={styles.searchButtons}>
              <RouteActionButton
                accessibilityLabel={t('session.screen.searchPrevious')}
                disabled={!hasHits}
                onPress={() => onMove('previous')}
                hitSlop={5}
                style={styles.searchNavButton}
                testID="session.searchPreviousButton"
              >
                <ChevronUp color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
              </RouteActionButton>
              <RouteActionButton
                accessibilityLabel={t('session.screen.searchNext')}
                disabled={!hasHits}
                onPress={() => onMove('next')}
                hitSlop={5}
                style={styles.searchNavButton}
                testID="session.searchNextButton"
              >
                <ChevronDown color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
              </RouteActionButton>
            </View>
          </View>
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
  onSync?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
      <View style={styles.sessionSyncPlaceholder} testID="session.unsyncedState">
      <View style={styles.sessionSyncRow}>
        <Text style={styles.sessionSyncTitle}>{loading ? t('session.screen.syncingSession') : t('session.screen.awaitingSync')}</Text>
        {onSync ? (
          <RouteActionButton
            accessibilityLabel={t('session.screen.resync')}
            disabled={loading}
            hitSlop={7}
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
        ) : null}
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
    ? (value as Record<string, unknown>)
    : null;
}

function buildMobileVoiceSessionRefinementContext(
  draftText: string,
  items: readonly MobileMessageRenderItem[],
  selection: { start: number; end: number },
) {
  const selectionBefore = takeRefinementContextTail(draftText.slice(0, selection.start));
  const selectionAfter = draftText.slice(selection.end, selection.end + 1200);
  const replyToMessage = findLastAssistantMessageText(items);
  return {
    selectionBefore: selectionBefore || undefined,
    selectedText: draftText.slice(selection.start, selection.end).slice(0, 1200) || undefined,
    selectionAfter: selectionAfter || undefined,
    replyToMessage: replyToMessage || undefined,
  };
}

function findLastAssistantMessageText(items: readonly MobileMessageRenderItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.type === 'message' && item.message.kind === 'assistant' && !item.message.isStreaming) {
      return truncateRefinementReply(item.message.body);
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
  /**
   * 按下即生效的兜底(仅安卓启用):平台中途取消手势时 onPress 永不到达(按钮只闪
   * 一下就没了),宽限到期后照样触发。正常松手仍然立即触发。详见 composerPressFallback。
   */
  pressInFallback?: boolean;
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
  pressInFallback = false,
  pressedStyle,
  style,
  testID,
}, ref) {
  const styles = useThemedStyles(makeStyles);
  const resolvedDisabledStyle = disabledStyle === undefined ? styles.sendButtonDisabled : disabledStyle;
  const resolvedPressedStyle = pressedStyle === undefined ? styles.routeButtonPressed : pressedStyle;
  const interactionDisabled = disabled || busy || !onPress;
  const pressFallback = useComposerPressFallback({
    // 仅安卓启用:要修的是安卓中途取消手势;iOS 保持纯松手触发,长按不提前发送。
    enabled: Platform.OS === 'android' && pressInFallback && !interactionDisabled,
    onPress: () => onPress?.(),
  });
  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    pressFallback.beginPress(event.nativeEvent.pageX, event.nativeEvent.pageY);
    onPressIn?.(event);
  }, [onPressIn, pressFallback]);
  const handlePress = useCallback(() => {
    // 兜底已经先执行过动作:正常松手不再重复执行。
    if (pressFallback.finishPress()) return;
    onPress?.();
  }, [onPress, pressFallback]);
  // 漂移撤销必须走 Pressable 的官方 onPressMove 通道:RN 0.86.3 的 Pressable
  // 不解构 onResponderMove(落入 restProps),render 时 {...eventHandlers} 在后
  // 把它整个覆盖——挂 onResponderMove 的 move 处理器在真机上收不到事件,
  // 12pt 漂移兑底形同虚设(划过发送键 300ms 后会误发)。
  const handlePressMove = useCallback((event: GestureResponderEvent) => {
    pressFallback.movePress(event.nativeEvent.pageX, event.nativeEvent.pageY);
  }, [pressFallback]);
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
      onPress={interactionDisabled ? undefined : handlePress}
      onPressIn={interactionDisabled ? undefined : handlePressIn}
      onPressMove={interactionDisabled ? undefined : handlePressMove}
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
  accessibilityLabel,
  disabled = false,
  icon: Icon,
  fastOn = false,
  label,
  leading,
  onPress,
  testID,
  tone,
}: {
  /** 读屏标签;缺省 = 可见 label(远程 Agent 任务追加 Agent 位置说明)。 */
  accessibilityLabel?: string;
  disabled?: boolean;
  icon?: typeof Hand;
  /** Fast 已生效 → label 后缀 Zap 闪电(对齐桌面 trigger)。 */
  fastOn?: boolean | 'ultrafast';
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
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      onPress={onPress}
      pressInFallback
      style={styles.composerRuntimePill}
      testID={testID}
    >
      {leading ?? null}
      {Icon ? (
        <Icon color={color} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      ) : null}
      <Text
        style={[
          styles.composerRuntimePillText,
          tone === 'bypassPermissions' && styles.composerRuntimePillTextRisky,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {fastOn ? (
        <ModelSpeedIcon mode={fastOn} color={colors.textTertiary} size={iconSize.sm} />
      ) : null}
      <ChevronDown color={color} size={iconSize.sm} strokeWidth={iconStroke.regular} />
    </RouteActionButton>
  );
}

function ComposerActivityStatus({
  availableRegion,
  sessionKey,
  reconnectAttempt,
  pendingRecovery = null,
  sideTaskRunning,
  startedAt,
  rateStartedAt = startedAt,
  streaming = false,
  tokenUsage,
  outputTokens: reportedOutputTokens,
  generationDurationMs: reportedGenerationDurationMs,
  generationReliable: reportedGenerationReliable,
  tokenSpeed,
  generationActive,
  visible,
  slowSendPhase = null,
}: {
  availableRegion?: LayoutRect;
  sessionKey: string;
  reconnectAttempt: RemoteSessionRunStatus['reconnectAttempt'];
  /** 自愈 / 供应商组换电脑进行中：只显示这一行状态(与消息流里的进行中行同一个说法)。 */
  pendingRecovery?: { label: string; attempt?: number; maxAttempts?: number;
  } | null;
  sideTaskRunning: boolean;
  startedAt: number | null;
  rateStartedAt?: number | null;
  streaming?: boolean;
  tokenUsage: number;
  outputTokens: number;
  generationDurationMs: number;
  generationReliable: boolean;
  /** Host-measured live tok/s; replaces the usage-counter estimate when present. */
  tokenSpeed?: TokenSpeedSnapshot;
  generationActive: boolean;
  visible: boolean;
  /** Set once a new task's creation has waited past the slow-send delay. */
  slowSendPhase?: SlowSendPhase | null;
}) {
  // Host speed counts and times generation itself; usage counters stay the fallback.
  const outputTokens = tokenSpeed?.tokens ?? reportedOutputTokens;
  const generationDurationMs = tokenSpeed?.elapsedMs ?? reportedGenerationDurationMs;
  const generationReliable = tokenSpeed ? true : reportedGenerationReliable;
  const styles = useThemedStyles(makeStyles);
  const pillStyles = useThemedStyles(makeComposerActivityPillStyles);
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

  // Elapsed uses the local fallback. Sampling keeps the raw remote start so a
  // terminal null is not a new turn, and a local send is not the previous rate.
  const samplerStartedAt = rateStartedAt === undefined ? startedAt : rateStartedAt;
  const rateHistory = useRunningTokenRateHistory({
    sessionKey,
    startedAt: samplerStartedAt,
    outputTokens,
    generationDurationMs,
    generationReliable: generationReliable && visible && !reconnectAttempt && !sideTaskRunning,
    tokenSpeed,
    streaming,
  });

  if (pendingRecovery && !reconnectAttempt) {
    // 自愈 / 换电脑进行中：只显示这一行状态，不带耗时与速率(这一轮还没有结局)。
    return (
      <View
        pointerEvents="box-none"
        style={pillStyles.composerActivityStatus}
        testID="session.composerActivityStatus"
      >
        <ComposerActivityPill label={pendingRecovery.label}>
          {pendingRecovery.attempt !== undefined && pendingRecovery.maxAttempts !== undefined ? (
            <Text style={[pillStyles.composerActivityStatusText, pillStyles.composerActivityProgressText]}>
              {pendingRecovery.attempt}/{pendingRecovery.maxAttempts}
            </Text>
          ) : null}
        </ComposerActivityPill>
      </View>
    );
  }
  if (!visible) return null;

  const elapsedText = formatComposerActivityElapsed(elapsed);
  const tokenCount = formatComposerActivityTokenCount(tokenUsage);
  const tokenText = t('session.screen.tokenCount', { tokens: tokenCount });
  const tokenA11yText = t('session.screen.tokenCountFull', { tokens: tokenCount });
  const showElapsedOnly = sideTaskRunning || Boolean(reconnectAttempt);
  const rateValue = formatComposerActivityRateValue(showElapsedOnly ? null : rateHistory.latestRate);
  const canShowRateDetails = !showElapsedOnly
    && generationReliable
    && outputTokens > 0
    && Number.isFinite(outputTokens)
    && Number.isFinite(generationDurationMs)
    && generationDurationMs > 0;
  const rateText = rateValue
    ? t('session.screen.tokenRate', { rate: rateValue })
    : null;
  const showUsageMeta = !showElapsedOnly && (Boolean(rateText) || tokenUsage > 0);
  const usageMeta = (
    <View style={[pillStyles.composerActivityPill, styles.composerActivityMeta]}>
      <BlurBackdrop intensity={FLOATING_CHROME_BLUR_INTENSITY} overlayColor={composerActivityPillOverlayColor(colors)} style={pillStyles.composerActivityPillBackdrop} />
      <Text style={styles.composerActivityMetaText}>{elapsedText}</Text>
      {showUsageMeta ? (
        <>
          <Text style={styles.composerActivityMetaText}>·</Text>
          {rateText ? (
            <Text
              accessibilityLabel={rateText}
              style={styles.composerActivityMetaText}
            >
              {rateText}
            </Text>
          ) : (
            <>
              <ArrowDown color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
              <Text
                accessibilityLabel={tokenA11yText}
                style={styles.composerActivityMetaText}
              >
                {tokenText}
              </Text>
            </>
          )}
        </>
      ) : null}
    </View>
  );
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
    : // 发送等待超过阈值时,同一行先说明卡在哪一步;创建完成后回到「思考中」。
      slowSendPhase ? t(`session.new.slowSend.${slowSendPhase}`)
    : t('session.screen.thinking');

  return (
    <View
      pointerEvents="box-none"
      style={pillStyles.composerActivityStatus}
      testID="session.composerActivityStatus"
    >
      <ComposerActivityPill label={activityText} live={Boolean(slowSendPhase) && !reconnectAttempt}>
        {reconnectAttempt ? (
          <Text style={[pillStyles.composerActivityStatusText, pillStyles.composerActivityProgressText]}>
            {reconnectAttempt.attempt}/{reconnectAttempt.maxAttempts}
          </Text>
        ) : null}
      </ComposerActivityPill>
      <RunningTokenRatePopover
        key={sessionKey}
        enabled={canShowRateDetails}
        availableRegion={availableRegion}
        sessionKey={sessionKey}
        startedAt={samplerStartedAt}
        history={rateHistory}
        outputTokens={outputTokens}
        generationDurationMs={generationDurationMs}
        generationReliable={generationReliable && !showElapsedOnly}
        label={showUsageMeta ? `${elapsedText} · ${rateText ?? tokenA11yText}` : elapsedText}
      >
        {usageMeta}
      </RunningTokenRatePopover>
    </View>
  );
}

function formatModelWindowTokens(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : `${Math.round(value / 1_000)}K`;
}

function formatComposerActivityElapsed(seconds: number): string {
  // 按界面语言本地化(中文「3 分 25 秒」),不再固定输出英文 `3m 25s`。
  return formatLocalizedSeconds(seconds, { alwaysShowSeconds: true });
}

function formatComposerActivityTokenCount(tokenUsage: number): string {
  const safeTokens = Math.max(0, Math.round(tokenUsage));
  return safeTokens >= 1000 ? `${(safeTokens / 1000).toFixed(1)}k` : `${safeTokens}`;
}

function formatComposerActivityRateValue(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  if (rate === 0) return '0';
  return rate < 0.1 ? '<0.1' : rate >= 100 ? rate.toFixed(0) : rate.toFixed(1).replace(/\.0$/, '');
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
    // Native glass buttons expand past the compact header during a press.
    overflow: Platform.OS === 'ios' ? 'visible' : 'hidden',
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 10,
    backgroundColor: 'transparent',
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
  sessionBottomFrosted: {
    backgroundColor: 'transparent',
  },
  sessionBottomFloating: {
    backgroundColor: 'transparent',
    overflow: 'visible',
  },
  // Same card as the other bars above the composer, so the transcript never shows through.
  companionQuoteBar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: spacing.sm,
  },
  companionQuoteBarBody: { flex: 1, minWidth: 0 },
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
  collabBarPressed: {
    opacity: 0.7,
  },
  queueEditBarText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  messageEditBarBody: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  messageEditBarText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
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
  sessionHeaderBarNative: {
    borderBottomWidth: 0,
    gap: spacing.sm,
    // Match the home UINavigationBar's compact row, below the existing safe area.
    // Keep 44pt touch targets; larger text may still grow the row naturally.
    minHeight: Platform.OS === 'ios' && Platform.isPad ? 50 : 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: 0,
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
    flexShrink: 1,
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
    lineHeight: lineHeight.body,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',

  },
  searchPanel: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  searchInputPill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
  },
  searchInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.bodySmall,
    minWidth: 0,
    paddingVertical: spacing.sm,
  },
  searchClearButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
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
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular,
  },
  searchButtons: {
    alignItems: 'center',
    flexDirection: 'row',
    // 两钮各 hitSlop 5 扩到 44pt 命中区,间距 ≥10 才不互相重叠。
    gap: spacing.md,
  },
  searchNavButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    width: 44,
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
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium,
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
    lineHeight: lineHeight.caption,
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
    lineHeight: lineHeight.caption,
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
  composer: {
    backgroundColor: 'transparent',
    gap: spacing.xs,
    paddingBottom: spacing.xs,
    paddingTop: spacing.sm,
  },
  composerScrollFrame: {
    flexShrink: 1,
    overflow: 'visible',
  },
  composerSurface: {
    flexShrink: 1,
    gap: 6,
  },
  composerSurfaceCompact: {
    gap: 0,
  },
  composerActivityFrame: {
    alignSelf: 'stretch',
    marginTop: spacing.lg,
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
    fontWeight: fontWeight.regular,
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
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  composerRuntimePillTextRisky: {
    color: colors.statusAccent,
  },
  attachmentErrorText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
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
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
  voiceCancelButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  // 语音按钮撑满 VoicePillWidthFrame,宽度由外框的过渡驱动;裁剪保证展开初段
  // 红点 + 计时尚未装下时不会溢出盖住左邻控件。
  voicePillFill: { overflow: 'hidden', width: '100%' },
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
  voiceDraftOverlayContentGeometric: {
    paddingBottom: COMPOSER_TEXT_GEOMETRIC_PADDING_BOTTOM,
    paddingTop: COMPOSER_TEXT_GEOMETRIC_PADDING_TOP,
  },
  voiceDraftMeasuredBlock: {
    minHeight: COMPOSER_INPUT_LINE_HEIGHT,
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
    minHeight: COMPOSER_INPUT_LINE_HEIGHT,
  },
  // 语音态占位文案渲染的就是普通态 TextInput 的 placeholder,颜色必须同源
  // (placeholderTextColor 也是 textPlaceholder),否则一进语音态这行字会变色。
  voiceDraftListeningText: {
    color: colors.textPlaceholder,
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

