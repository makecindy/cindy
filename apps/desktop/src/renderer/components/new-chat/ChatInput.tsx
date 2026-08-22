import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Folder, MessageSquarePlus, Mic, Pen, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { ImageHoverPreview } from '@/components/chat/ImageHoverPreview';
import { formatBytes, TextLightbox } from '@/components/chat/TextLightbox';
import { AttachmentTypeThumb } from './AttachmentTypeThumb';
import { FullAccessConfirmContent } from './FullAccessConfirmContent';
import { useEditor, EditorContent } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import HardBreak from '@tiptap/extension-hard-break';
import type { Editor, JSONContent } from '@tiptap/core';
import { createComposerInputLatencyProbe } from '@/lib/composerInputLatencyProbe';
import { CjkPunctDecoration } from './CjkPunctDecoration';
import { ComposerListIndentDecoration } from './ComposerListIndentDecoration';
import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
  handleStructuredListBackspace,
  handleStructuredListBreak,
  hasTrailingPlainListParagraph,
  isTopLevelBlockSelection,
  isTrailingEmptyTopLevelParagraph,
  promoteTrailingPlainListParagraph,
} from './ComposerListNodes';
import { WindowsSelectionReplacement } from './WindowsSelectionReplacement';
import { EmptyDocSelectionGuard } from './EmptyDocSelectionGuard';
import {
  hasFocusMovedToInteractiveElement,
  useComposerSendFocusRestore,
} from './useComposerSendFocusRestore';
import {
  setVoiceInputDraftDecoration,
  VoiceInputDraftDecoration,
  type VoiceInputCaretState,
} from './VoiceInputDraftDecoration';
import { MentionDragCaretDecoration, setMentionDragCaret } from './MentionDragCaretDecoration';
import {
  applyGhostCommandBackspace,
  GhostCommandDecoration,
  setGhostCommandRoster,
} from './GhostCommandDecoration';
import {
  replaceSlashCommandRunWithText,
  setSlashCommandRoster,
  SlashCommandDecoration,
} from './SlashCommandDecoration';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { Tip } from '@/components/ui/tooltip';
import type { AttachedFile, MentionedResource, ImageAnnotationStroke } from '@/lib/fileTypes';
import {
  commentPreviewTag,
  formatBrowserCommentsForSend,
  removeBrowserCommentAndRepairChains,
  type BrowserCommentDraftItem,
} from '@/lib/browserComments';
import { isGlobalDropIntercepted } from '@/lib/globalDropIntercept';
import {
  classifyUnclassifiedDroppedItems,
  getDroppedFileItems,
  type DroppedFileItems,
} from '@/lib/fileDrop';
import { shouldOpenTextLightbox } from '@/lib/filePreview';
import { isDangerousAttachmentName } from '../../../shared/attachmentSafety';
import {
  getDraft as getComposerDraft,
  getOrCreateRemoteOptimisticTransitionCheckpoint,
  removeRemoteOptimisticDraftFragment,
  type RemoteOptimisticTransitionCheckpoint,
  saveDraft as saveComposerDraft,
  saveComposerTextAfterAsyncTransition,
  clearDraft as clearComposerDraft,
  restoreRemoteOptimisticDraft,
  subscribeDraft as subscribeComposerDraft,
  tiptapDocHasContent,
} from '@/lib/composerDraftStore';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { subscribeSessionLinkInsert } from '@/lib/composerActionsBus';
import {
  ModelSelector,
  resolveRemoteModelListStatus,
  resolveModelSelectorAgentIdentity,
  type ModelMemoryAccessors,
} from './ModelSelector';
import {
  enqueueEffortChange,
  getEffortChangeCoordinator,
  isSessionScopeCurrent,
} from './effortChangeQueue';
import {
  applyVoiceResultToSerializedText,
  armDetachedVoiceDraftPersist,
  editorOwnsSourceDraft,
  mergeDetachedVoiceTextIntoDocument,
  resolveSourceOwnedComposerExtras,
  voiceLocksCurrentComposer,
} from './composerSendOwnership';
import { captureComposerSendSnapshot, isComposerSendSnapshotCurrent } from './composerSendSnapshot';
import { useRemoteSessionConnection } from '@/features/cc-agent/hooks/useRemoteSessionConnection';

import {
  confirmAgentSwitchRisk,
  isAgentSwitchEchoConfigConsistent,
  isAgentSwitchResponseFresh,
  resolveAgentSwitchAckAction,
} from './agentSwitchConfirmation';
import {
  beginAgentSwitchOperation,
  getAgentSwitchWriteSeq,
  hasPendingAgentSendDispatch,
  hasPendingAgentSwitchOperation,
  nextAgentSwitchWriteSeq,
  reserveAgentSwitchExclusive,
  subscribeAgentSwitchPending,
  tryBeginAgentSendDispatch,
} from '@/lib/agentSwitchCoordinator';
import {
  isSelectedSourceDisconnected,
  resolveEffort,
  resolveProviderSwitchEffort,
} from './sourceSwitch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { PermissionSelector } from './PermissionSelector';
import { ExtraDirsButton, type CollaborationMenuConfig } from './ExtraDirsButton';
import { expandHostCapabilityInvocation } from '../../cindy-brain/hostCapabilityInvocation';
import { focusComposerEndNextFrame, hostCapabilityForGhost, placeGhostAtComposerStart, placeHostCapabilityAtComposerStart } from './ghostComposerPlacement';
import { NewGoalDialog } from './NewGoalDialog';
import { PlanModeIndicator } from './PlanModeIndicator';
import {
  addPlanModeComposerCommand,
  consumePlanModeComposerCommand,
  isPlanModeComposerCommandText,
  planModeComposerDraftText,
  shouldPreservePlanModeComposerDraft,
} from './planModeComposerCommand';
import { PendingQueuePanel } from './PendingQueuePanel';
import { SendButton } from './SendButton';
import { FolderPickerPopover, addRecentFolder } from './FolderPickerPopover';
import { SlashCommandPalette } from './SlashCommandPalette';
import {
  expandGhostCommand,
  findGhostByCommand,
  parseGhostCommandWord,
} from '@/cindy-brain/ghostCommand';
import { filterGhostsForWorkdir } from '@/cindy-brain/ghostWorkdirFilter';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import {
  attachGhostMediaToSession,
  getGhostMediaUriFromDataTransfer,
} from '@/cindy-brain/ghostMediaHandover';
import { AtMentionPanel, type AtPanelState } from './AtMentionPanel';
import { MentionChipNode, type MentionChipAttrs } from './MentionChipNode';
import { ComposerQuoteNode } from './ComposerQuoteNode';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerHistoryEntryToDocument,
  type ComposerHistoryEntry,
} from '@/lib/composerQuoteDocument';
import { deriveStableComposerHistory } from './composerHistoryProjection';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import {
  pastedSessionChipAttrs,
  resolveSerializedSessionMessageReferencesForSend,
  resolveSessionMessageReferencesForSend,
  resolveSessionChipTitles,
  sanitizeSessionChipTitle,
} from './sessionLinkPaste';
import {
  isLongPasteText,
  countPasteLines,
  htmlCarriesOwnChipMarkup,
  LONG_PASTE_MAX_CHARS,
  segmentPastedContent,
  pastedProjectChipAttrs,
} from './pastePipeline';
import { upgradePastedPathsToChips, type PendingPathRange } from './pathPaste';
import { composerDocIsEmpty } from './composerDocState';
import { canUseLocalAttachmentPicker } from './localAttachmentPicker';
import {
  isComposerBlankPointerTarget,
  resolveComposerBlankFocusIntent,
} from './composerBlankPointerFocus';
import {
  applyPastedTextChipEdit,
  PastedTextChipNode,
  replacePastedTextChipWithPlainText,
  type PastedTextChipAttrs,
} from './PastedTextChipNode';
import { QuickStartPillMark } from './QuickStartPillMark';
import { ToolPayloadLightbox } from '@/components/chat/ToolPayloadLightbox';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import * as sessionService from '@/lib/sessionService';
import { getModelById } from '@/lib/modelDefinitions';
import {
  beginSlashCommandRosterLoad,
  EMPTY_SLASH_COMMANDS,
  failSlashCommandRosterLoad,
  filterSlashCommands,
  firstAvailableSlashCommandIndex,
  hasAvailableSlashCommand,
  hasUnavailableProjectSkillPreview,
  isSlashCommandUnavailable,
  isSlashCommandRosterReady,
  loadAllCommands,
  nextAvailableSlashCommandIndex,
  PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
  type SlashCommandRosterState,
  type UnifiedCommand,
} from '@/lib/slashCommands';
import type { PiPackageCommandRuntimeStatus } from '@/../shared/piPackages';
import {
  AT_MENTION_EMPTY_WORKSPACE_SCAN_CAP,
  getAtDirectoryCompletionQuery,
  mergeAtResourceItems,
  scanAtResources,
  type AtResourceItem,
} from '@/lib/atResourceService';
import {
  buildComposerSuggestionEntries,
  firstEnabledSuggestionIndex,
  isComposerSuggestionEntryDisabled,
  nextEnabledSuggestionIndex,
  resolveComposerAtActivation,
  type ComposerPluginSuggestion,
  type ComposerSuggestionAction,
  type ComposerSuggestionEntry,
} from '@/lib/composerSuggestion';
import { MAX_EXTRA_DIRS, pickAndAddExtraDir } from './extraDirsActions';
import { applyListBackspace, applyListContinuation } from '@/lib/composerListContinuation';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import { getAppShortcutCombos } from '@/lib/appShortcutStore';
import { getNextPermissionMode } from '@/lib/permissionModeCycle';
import { matchesKeyboardEvent } from '../../../shared/appShortcuts';
import {
  getComposerSendShortcutPreference,
  getComposerSendShortcutLabel,
  hasComposerModifier,
  resolveComposerEnterIntent,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { usePromptRecommendationPreference } from '@/hooks/usePromptRecommendationPreference';
import { createLogger } from '@/lib/logger';
import { subscribeWorkLouderCodexAction } from '@/lib/workLouderCodexActions';
import { createComposerDraftSaveScheduler } from '@/lib/composerDraftSaveScheduler';
import {
  composerRenderSnapshot,
  shouldRefreshComposerRender,
  type ComposerRenderSnapshot,
} from './composerRenderGate';
import { createComposerFrameScheduler } from './composerFrameScheduler';
import {
  serializeEditorContent,
  serializeEditorSlice,
  type SerializedComposerContent,
} from './composerContentSerialization';
import {
  composerDocumentContainsHostCapabilityChip,
  composerDocumentContainsList,
  normalizeComposerDocumentJSON,
  plainTextToComposerDocument,
  stripHostCapabilityChips,
} from '@/lib/composerListDocument';
import { useAgentCapabilities, type AgentKind } from '@/hooks/useAgentCapabilities';
import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import { useConnectedSource } from '@/hooks/useConnectedSource';
import { useProviders } from '@/hooks/useProviders';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { chatEligibleSourcesForModel, effectiveSourceIdForModel } from '@cindy/model-providers';
import {
  deriveModelsFromProviders,
  filterChatBridgedCodexProviders,
  resolveFastSupported,
  resolveProviderModelEfforts,
} from '@/lib/providerModels';
import {
  clearProviderModelEffort,
  clearProviderModelFast,
  getProviderModelEffort,
  setProviderModelChoice,
  setProviderModelEffort,
  getProviderModelFast,
  setProviderModelFast,
  getProviderModelThinking,
  setProviderModelThinking,
  useProviderModelMemoryVersion,
} from '@/state/providerModelMemory';
import { useModelPickerLayout } from '@/state/modelPickerLayout';
import {
  setSessionFavoriteAnchor as setSessionFavoriteAnchorMemory,
  useSessionFavoriteAnchor,
  type SessionFavoriteAnchor,
} from '@/state/favoriteAnchorMemory';
import {
  getDraft,
  patchVendorPrefs,
  patchVendorPrefsPreservingModelChoice,
  setEffortForModel,
  setFastModeForModel,
} from '@/state/newMakerDraft';
import type { MessageDeliveryMode, QueuedMessage } from '@/lib/makerChatStore';
import {
  isRemoteOptimisticComposerTransitionActive,
  isRemoteOptimisticDataOwnerBoundaryError,
  isRemoteOptimisticSessionPurgedError,
  makerChatStore,
	wasLastStopSideTask,
} from '@/lib/makerChatStore';
// 切模型前的上下文容量预检(大窗口 → 小窗口护栏), 纯函数与 main 共用。
import { assessModelSwitchContext } from '../../../shared/modelSwitchAssessment';
import { useVoiceInput } from '@/voice-input/useVoiceInput';
import { useVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import { VoiceInputStatusNotice } from '@/voice-input/VoiceInputStatusNotice';
import type { VoiceInputState } from '@cindy/voice-input-core';
import {
  playVoiceInputEndCue,
  playVoiceInputStartCue,
  prepareVoiceInputCues,
} from '@/voice-input/startCue';
import {
  formatVoiceInputShortcut,
  isVoiceInputShortcutMatch,
  isVoiceInputShortcutRelease,
  type VoiceInputShortcut,
} from '@/voice-input/shortcut';
import { VoiceInputPointerHintLayer } from '@/voice-input/VoiceInputPointerHintLayer';
import { requestRendererMicrophonePermission } from '@/voice-input/startGuards';
import { COMPOSER_MENTION_MIME, decodeComposerMentionPayload } from '@/lib/composerMentionDrag';
import { createWorkLouderCodexVoiceGesture } from '@/lib/workLouderCodexVoiceGesture';
import { appendMentionChip } from './mentionChipInsertion';
// device-link 远程会话:设置变更不落本地 DB(会 404),改写远程内存层 + 运行时隧道。
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { makerApiFor, makerApiForDevice } from '@/lib/makerTransport';
import { SESSION_LINK_DROP_MIME } from '@/lib/sessionLinkDrop';

const log = createLogger('ChatInput');
// perf-baseline(与 MessageStream / sidebar 的 perf/session-switch 探针同通道):
// chat-input:commit 量化每次会话切换时 ChatInput 子树(Lexical 初始化 + 草稿恢复
// + 工具栏)的首次 commit 主线程占用;<30ms 不打,避免噪音。
const perfLog = createLogger('perf/session-switch');
const composerPerfLog = createLogger('perf/composer-input');

const VOICE_INPUT_LONG_PRESS_MS = 450;
const VOICE_INPUT_SHORTCUT_DEDUPE_MS = 250;
const ComposerHardBreak = HardBreak.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      'Alt-Enter': () => this.editor.commands.setHardBreak(),
    };
  },
});

// 工具行宽度自适应阈值（input card 像素宽）。低于阈值时自动收紧工具行，避免窄宽
// 下换行 / 文字溢出，与 doc rail / orca 的显式 compactToolbar / denseToolbar 取 OR。
// 两档：先 dense（控件字号 / 图标压一档），更窄再 compact
// （左侧 permission 可 truncate 成 "完..."、右侧 shrink-0 防换行）。数值按主会话工具行
// 自然宽度（permission + model + voice + send 等）估，实测可微调。
const TOOLBAR_DENSE_MAX_WIDTH = 520;
const TOOLBAR_COMPACT_MAX_WIDTH = 448;

// 预测去重:同一 session 在多个窗口(openSessionInNewWindow)打开时,每个 ChatInput
// 实例都会独立检测到 turn 结束并触发 predictNextPrompt,导致重复的 provider 调用。
// 模块级 Map<sessionId, turnGen> 跟踪正在进行的预测(renderer 端辅助跟踪),
// 主要用于 cleanup 时防止误删其他窗口的条目。主进程级去重(main 侧 title.ts)
// 使用 DB session.updatedAt 作为跨窗口一致的去重键,才是真正的付费调用防线。
// 当旧 turn 的预测仍在途时新 turn 触发预测,新 turn 的 turnGen 不同,
// 会替换旧条目并允许新预测通过(main 侧也通过 updatedAt 变化放行)。
const _predictingSessions = new Map<string, number>();

function isVoiceInputIdleLike(state: VoiceInputState): boolean {
  return state === 'idle' || state === 'done' || state === 'error';
}

function isPointInsideElement(
  element: HTMLElement | null,
  clientX: number,
  clientY: number,
  padding = 0,
) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  );
}

interface ChatInputProps {
  onSend: (
    message: string,
    model: string,
    effort: Effort,
    permissionMode: PermissionMode,
    files?: AttachedFile[],
    mentions?: MentionedResource[],
    opts?: {
      deliveryMode?: MessageDeliveryMode;
      providerId?: string | null;
      /** chat-text-quote:message 开头的 blockquote 为引用功能拼接产出。 */
      quotesEncoded?: boolean;
      /** Ordered semantic projection metadata for session/project/message chips. */
      agentReferences?: AgentInputReference[];
      /** Local display ranges for sent long-paste chips; never added to Agent text. */
      pastedTextRanges?: PastedTextRange[];
      /** Exact local display ranges for slash commands confirmed by this composer. */
      slashCommandRanges?: SlashCommandRange[];
      /**
       * New Maker 会异步创建会话并自己清理草稿，onSend 为保留编辑器
       * 始终返回 false。它在消息真正移交给新会话后调本回调，与
       * false（未接受）语义解耦。
       */
      onAccepted?: () => void;
      /** 远端乐观发送稍后永久失败时恢复本地 composer。 */
      onRemoteOptimisticFailure?: (clientId: string, error?: unknown) => void;
      /** 发送因补选目录暂缓时，由父组件在后续真正受理后完成原 composer 的清理。 */
      onDeferredAccepted?: () => void;
    },
  ) => boolean | void | Promise<boolean | void>;
  /** Session ID for binding workingDir. When absent, folder picker is hidden. */
  sessionId?: string;
  /**
   * 已由 session/runtime 元数据确认的当前 Agent。null/undefined 表示身份尚未加载；
   * 不能用 vendorKey 的 Claude Code 默认回退冒充真实身份。
   */
  runtimeAgentKind?: AgentKind | null;
  /**
   * 会话的 Orca 角色(lead / worker;null = 已确认非协同;undefined = 元数据未加载)。
   * 协同运行时对 agent 形态有独立
   * 契约(docs/dev-rules/orca-team-architecture.md),被控端的 session-agent-switch handler
   * 对任何带 orcaRole 的会话一律拒 UNSUPPORTED_CAPABILITY —— 入口据此隐藏,不给用户
   * 一个点了必失败的控件(与手机端 supportsMobileSessionAgentSwitch 同口径)。
   */
  sessionOrcaRole?: string | null;
  /** Initial workingDir from session data. */
  initialWorkingDir?: string | null;
  /**
   * 远程 host alias;非空 = remote session。remote 的 workingDir 是远端主机路径,
   * 本地 slash skill 扫描 / @ 资源扫描不能按它读本机文件,故 remote 下退化为
   * desktop + agent-builtin 命令、关闭 @ 文件面板。null/undefined = 本地。
   */
  remoteHostId?: string | null;
  /**
   * device-link 远程会话所属被控端 id(与 SSH remoteHostId 互斥)。非空 = 控制端在远程操控,
   * 此时模型 / fast / effort / 权限档 等**能力全部从被控端读**(经隧道),控制端"忘掉"本地能力。
   * 由 CCAgentSessionView(reactive remoteDeviceId)/ NewMakerDraftRoute(目标设备)传入;本地会话 undefined。
   */
  deviceLinkDeviceId?: string | null;
  /**
   * device-link「纯显示镜像」记忆 override:非空时优先于本机全局模型预设注入 ModelSelector,
   * 用于远程草稿 / 远程会话——非选中行读被控端镜像、改动经隧道写穿被控端,绝不碰控制端本地记忆
   * (newMakerDraft / providerModelMemory)。由 NewMakerDraftRoute(草稿)/
   * CCAgentSessionView(会话)用 deviceLinkModelMirror.makeMirrorAccessors 构建并传入。
   */
  modelMemoryOverride?: ModelMemoryAccessors;
  /** Initial model from session data. When provided, overrides activeModel. */
  initialModel?: string;
  /** Initial effort from session data. When provided, overrides activeEffort. */
  initialEffort?: Effort;
  /**
   * per-session 来源(供应商)初值。来自 session.providerId(null = 跟随默认路由)。
   * 决定 ModelSelector 来源栏高亮哪家;不传 = 跟随默认(显示列表首项为默认命中)。
   */
  initialProviderId?: string | null;
  /** Initial permissionMode from session data. When provided, overrides activePermissionMode. */
  initialPermissionMode?: PermissionMode;
  /**
   * 计划模式一级开关(与 permissionMode 正交)。会话内来自 chat store
   * (session.planModeEnabled 水合 + plan_mode_changed 回流镜像);草稿来自 draft store。
   */
  planModeEnabled?: boolean;
  /**
   * 计划模式切换回调 —— 持久化由父组件负责(会话内 makerChatStore.setPlanMode;
   * 草稿 patchVendorPrefs)。未提供 = 不显示计划模式入口。
   */
  onPlanModeChange?: (enabled: boolean) => void | Promise<void>;
  /** Current Fast Mode state from the session store. */
  fastMode?: boolean;
  /** Called when the Fast Mode toggle changes. Captured device ID pins remote routing. */
  onFastModeChange?: (enabled: boolean, sourceRemoteDeviceId?: string) => void | Promise<void>;
  /** Callback when workingDir changes (for parent state sync). */
  onWorkingDirChange?: (dir: string | null) => void;
  /** When true, the input is disabled (e.g. during streaming). */
  disabled?: boolean;
  /** Freeze model/provider/effort/permission controls for audit-only tasks. */
  settingsLocked?: boolean;
  /** When true, shows Stop button instead of Send button. */
  isStreaming?: boolean;
  /**
   * F-QUEUE-1: "agent 忙"的派生判据。由 store/hook 负责把暂停队列排除掉;
   * ChatInput 只消费最终结果来决定 Stop / Send 按钮。
   */
  isAgentBusy?: boolean;
  /** Called when user clicks Stop button during streaming. */
  onStop?: () => void;
  /** Gate before starting voice input; return false to keep the recorder closed. */
  onBeforeVoiceInputStart?: () => boolean | Promise<boolean>;
  /**
   * F-QUEUE-DEFER: un-dispatched messages (rendered above the input by
   * `PendingQueuePanel`). Empty array hides the panel entirely.
   */
  pendingQueue?: QueuedMessage[];
  /** F-QUEUE-DEFER: queue panel expanded state. */
  queueExpanded?: boolean;
  /** F-QUEUE-DEFER: toggle queue panel expanded/collapsed. */
  onQueueExpandedChange?: (expanded: boolean) => void;
  /** F-QUEUE-DEFER: remove a single un-dispatched queued message. */
  onQueueRemove?: (clientId: string) => void;
  /** F-QUEUE-DEFER: edit a single un-dispatched queued message's text. */
  onQueueEdit?: (clientId: string, newText: string) => void;
  /**
   * Same-turn 插话: a queued row can be delivered into the currently-running
   * turn without waiting for FIFO drain. This is a delivery choice only; the
   * row's text/files/mentions snapshot stays the same as normal queue send.
   */
  onQueueSteer?: (clientId: string) => Promise<boolean>;
  /** Queue row ids currently being delivered through onQueueSteer. */
  steeringQueueClientIds?: string[];
  /** Queue was paused by Stop; a Continue button appears in the queue panel. */
  queuePaused?: boolean;
  /** Resume a queue paused by Stop. */
  onQueueResume?: () => void;
  /** Move a queued row to a new insertion index. */
  onQueueReorder?: (clientId: string, targetIndex: number) => void;
  /** Lock the whole queue while drag-sort is in progress. */
  onQueueInteractionLock?: (lockId: string, locked: boolean) => void;
  /** Lock one queued row while its text is being edited. */
  onQueueEditLock?: (clientId: string, locked: boolean) => void;
  /** Chat messages — used to derive user message history for ↑/↓ navigation. */
  messages?: Array<{ role: string; content: string; quotesEncoded?: boolean }>;
  /** Custom placeholder text. Defaults to "今天我们做点什么呢~" */
  placeholder?: string;
  /** Controlled open state for FolderPickerPopover. When omitted, internal state is used. */
  folderPickerOpen?: boolean;
  /** Callback when FolderPickerPopover open state changes (controlled mode). */
  onFolderPickerOpenChange?: (open: boolean) => void;
  /** Whether to show the folder picker button. Defaults to true. */
  showFolderPicker?: boolean;
  /**
   * 渲染在 folder picker chip 左侧的额外 chips（同一行，folder 始终最右）。
   * 当前唯一使用方:NewMakerDraftRoute 把 WorktreeChipsRow 注入这里。
   */
  leftOfFolderPicker?: React.ReactNode;
  /**
   * External attachment management — when provided, ChatInput uses these
   * instead of its own internal useAttachments(). This allows a parent
   * component to manage attachments (e.g. for full-area drag-and-drop).
   */
  /** Callback fired after model is changed (for Fast Mode linkage etc.). */
  onModelDidChange?: (newModelId: string) => void;
  /**
   * Callback fired after effort is persisted. The parent should merge the exact
   * value into its session snapshot so it flows back as `initialEffort` without
   * waiting for a full refresh. Required for the SSoT wiring.
   */
  onEffortDidChange?: (
    newEffort: Effort,
    sourceSessionId?: string,
    sourceRemoteDeviceId?: string,
  ) => void;
  /**
   * Callback fired after permissionMode is persisted to server. Same contract
   * as `onEffortDidChange` — the parent should refresh its session snapshot.
   */
  onPermissionModeDidChange?: (newMode: PermissionMode) => void;
  /**
   * Callback fired after the source (provider) selection changes. Same SSoT
   * contract as `onModelDidChange`: the parent persists it (草稿态写进
   * VendorPrefs.providerId,会话态由 ChatInput 自身 update 落盘) and seeds it back
   * as `initialProviderId`. null = 清除显式选择,回落默认路由。
   */
  onProviderDidChange?: (newProviderId: string | null) => void;
  /**
   * 附件状态由调用方持有(必填)。原本 ChatInput 内部还 fallback 一份
   * `useAttachments(sessionId)`,但只要外部传了,内部那份就完全用不上,纯粹是
   * 1×useState + 4×useRef + 6×useCallback + 1×useEffect 的死分配,而且和外部那份
   * 写同一个 composerDraftStore 槽位会产生 race(切回 A 后附件丢失的根因)。
   * 把它改成必填,内部不再 fallback。
   */
  attachmentState: {
    attachments: AttachedFile[];
    hasAttachments: boolean;
    addFiles: (fileList: FileList | readonly File[]) => Promise<void>;
    addClipboardImage: (blob: Blob) => Promise<void>;
    rejections: { id: string; message: string }[];
    dismissRejection: (id: string) => void;
    clearRejections: () => void;
    addFolderPath: (folderPath: string) => void;
    pendingFoldersVersion: number;
    consumePendingFolders: () => string[];
    addFileMention: (payload: { type: 'file'; relPath: string; name: string }) => void;
    pendingFileMentionsVersion: number;
    consumePendingFileMentions: () => Array<{ type: 'file'; relPath: string; name: string }>;
    removeFile: (id: string) => void;
    updateFile: (id: string, patch: Partial<AttachedFile>) => void;
    discardFiles: () => void;
    restoreFiles: (files: readonly AttachedFile[]) => AttachedFile[];
    clearFiles: () => void;
  };
  /**
   * `/` 与 `@` 弹窗的最大高度（px）。默认 400（chat view 沿用）；NewMaker 需要传更小的值，
   * 避免弹窗盖住 logo / worktree chips。
   */
  paletteMaxHeight?: number;
  /** Parent-owned drag state for full-page drop zones; mirrors the same hint inside the input card. */
  externalDragOver?: boolean;
  /** Composer drops stop propagation, so parent full-page drag state needs an explicit reset hook. */
  onComposerDropHandled?: () => void;
  /**
   * M35: Vendor lock — when provided, ModelSelector only shows models
   * belonging to this vendor ('cc' for Claude, 'codex' for OpenAI Codex).
   */
  vendorKey?: 'cc' | 'codex' | 'pi';
  /**
   * Optional override for the composerDraftStore key used to persist editor
   * content (and via attachmentState, attachments) across mount/unmount.
   * Defaults to `sessionId`. Pass an explicit sentinel (e.g. the new-maker
   * transient draft) when there is no real backend session yet but you still
   * want sidebar-switch survival. Backend calls (sessionService.update / etc.)
   * remain gated on the real `sessionId` and are unaffected.
   */
  draftKey?: string;
  /**
   * 关掉编辑器 mount 时的 autofocus。
   * 默认 false (= autofocus 开),保持 chat 模式 / new-maker 的"打开就能直接
   * 输入"。在 doc 模式右栏 (workdir-browse rail) 里必须传 true:
   *   Windows 中文 IME 在 contenteditable 获得焦点时进入 active 状态,
   *   会在 OS 层吞掉 Ctrl+Shift+F 这类组合键 — 用户进 doc 模式后第一次按
   *   会完全没反应,必须先点击非 contenteditable 区域让 IME 退出 active。
   *   把这个开关关掉,焦点不会自动落进 TipTap,IME 不 active,doc 模式
   *   的全文搜索快捷键开箱即用。
   */
  disableAutofocus?: boolean;
  /**
   * 父组件复用同一个 ChatInput 实例切换 storageKey (= session/draft) 后,
   * 是否把焦点放回编辑器。主会话视图需要它来保证 sidebar 切会话后可直接输入;
   * 嵌入式 rail / split pane 保持 false,避免抢走当前页面快捷键或其它 pane 的焦点。
   */
  focusOnStorageKeyChange?: boolean;
  /**
   * Whether this composer should consume hardware send / voice / text commands.
   * Split panes keep every ChatInput mounted; only the focused owner may act.
   */
  ownsHardwareComposerActions?: boolean;
  /**
   * 附加只读引用目录列表(绝对路径)。
   * 与 onExtraDirsChange 成对出现:
   *   - 创建时(NewMakerDraftRoute):传 draft.extraDirs + 写 newMakerDraft store
   *   - 中途(CCAgentSessionView):传 session.extraDirs + 双 IPC(sessionService.update + maker.setExtraDirs)
   * 不传 / 传 undefined → 不显示引用目录段(老调用方零迁移)。Claude 与 Codex 共用;
   * 但「+」按钮本身在有 onNewGoal(新建目标入口)时两端都会出现。
   */
  extraDirs?: string[];
  onExtraDirsChange?: (next: string[]) => void | Promise<void>;
  /**
   * 「新建目标」入口回调(首页草稿态用):提供时「+」菜单显示「新建目标」,点击调它
   * (NewMakerDraftRoute 负责建会话 + setGoal)。会话态(有 sessionId)不需要传 ——
   * ChatInput 用内部 NewGoalDialog 处理。两端通用,与 vendor 无关。
   * initialObjective:点击时输入框里已有的文字(去空白),用作目标的默认内容。
   */
  onNewGoal?: (initialObjective: string) => void;
  /**
   * Per-model effort 记忆的外部存储 (typically NewMakerDraft store)。
   * 传入时:决定 newEffort 的优先级是 props 这份 > 组件内 effortByModelRef > model.defaultEffort。
   * 不传时:仅靠组件内 effortByModelRef (仅 ChatInput 单实例生命周期内有效)。
   * 给"+ New Maker"路径用,让用户上次为某 modelId 选过的 effort 跨实例 / 跨重启保留。
   * 一般会话内 (CCAgentSessionView) 不需要传,session 自己的 model+effort 已经是 DB SSoT。
   */
  rememberedEffortByModel?: Record<string, Effort>;
  /**
   * 配合 rememberedEffortByModel:当用户在某 modelId 上显式改 effort,
   * 或从某 modelId 切走时,这个回调把 (modelId → effort) 写回外部 store。
   * 内部 effortByModelRef 仍会同步写,做即时双保险。
   */
  onRememberedEffortChange?: (modelId: string, effort: Effort) => void;
  /** Enables wrapping for narrow split-pane layouts such as Orca. Defaults to false. */
  compactToolbar?: boolean;
  /** 强制使用紧凑单行工具栏；容器测宽也会自动进入同一状态。 */
  narrowToolbar?: boolean;
  /**
   * 工具行采用更紧凑的视觉密度 (字号 -1px)。
   * 用于 doc rail 这种宽度受限的容器,与 compactToolbar (wrap 兜底) 正交:
   *   - dense=true 把控件本身压瘦, 一般就够单行塞下
   *   - compactToolbar 是宽度极端时的 wrap 兜底, split-pane 仍然需要
   * 默认 false (保持主会话视图的舒适字号)。
   */
  denseToolbar?: boolean;
  visualVariant?: 'default' | 'create-agent';
  middleToolbarSlot?: ReactNode;
  compactMiddleToolbarSlot?: ReactNode;
  /**
   * Slot rendered INSIDE the input card, above the textarea, sharing the same
   * rounded border / focus-within highlight. Used by Orca mode for the
   * "Lead·Claude → Worker [Codex ▾]" header strip. Reuses the same
   * fused-wrapper trick as PendingQueuePanel — when present, the outer wrapper
   * takes ownership of the border so the slot + textarea look like one card
   * with a hairline divider.
   */
  topSlot?: React.ReactNode;
  /**
   * 协同模式入口 (Claude / Codex Lead session 中途 toggle Worker)。
   * 提供时:与目标模式、计划模式同级渲染在 composer「+」菜单;
   *        ON 态点击菜单项即触发关闭 (由 parent 决定确认弹窗)。
   * 不提供时:菜单里不渲染该项。
   * 状态完全由 parent 持有 (controlled);ChatInput 只做展示与事件转发。
   */
  collaboration?: CollaborationMenuConfig;
  /**
   * 新会话统一模型选择器(model-selector-unified M5)的**选中直通**。
   *
   * 传入 = 这条 composer 的模型 pill 用统一面板,而且它是**草稿**:面板里的一行自带引擎
   * (推荐 ⊕ 用户 override ⊕ 收藏副本),所以选中要连引擎一起落 —— ChatInput 把
   * (vendor, providerId, modelId, effort, fast, 收藏锚点) 一次交给草稿层写 newMakerDraft,
   * 不走 onProviderDidChange / onModelDidChange 那条按「当前引擎」二次解析的链路(它在
   * 跨引擎行上会拿旧引擎的档位表把档清空)。
   *
   * 已建会话不传:那边换引擎有损,跨引擎行走 performAgentSwitch 事务(M6)。
   *
   * `modelId` 是**选中引擎的 wire model id**(不是面板行的归一化 id):它会直接落进
   * `lastByVendor.model` 并原样进 createSession,写错就是首条请求路由到一个不存在的模型。
   */
  onUnifiedDraftSelect?: (selection: {
    vendor: 'cc' | 'codex' | 'pi';
    providerId: string;
    /** 选中引擎的 **wire model id**。 */
    modelId: string;
    effort?: Effort;
    fast: boolean;
    favoriteUid: string | null;
  }) => void;
  /**
   * 统一面板里被选中的收藏锚点 uid(与 onUnifiedDraftSelect 成对,由草稿层持有)。
   * 语义见 ModelSelectorProps.selectedFavoriteUid。
   */
  selectedFavoriteUid?: string | null;
}

/** 统一模型选择器联合列表的候选引擎全集(与 SELECTABLE_VENDORS 同一顺序)。 */
const UNIFIED_AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/** AgentKind → NewMaker vendor(useAvailableAgents 用 vendor 口径)。 */
function agentKindToVendor(kind: AgentKind): 'cc' | 'codex' | 'pi' {
  return kind === 'codex' ? 'codex' : kind === 'pi' ? 'pi' : 'cc';
}

function vendorKeyToAgentKind(v?: 'cc' | 'codex' | 'pi'): AgentKind | null {
  if (v === 'cc') return 'claude-code';
  if (v === 'codex') return 'codex';
  if (v === 'pi') return 'pi';
  return null;
}

/**
 * Tiptap/ProseMirror 不会自动把光标滚入视野（与 <textarea> 不同）。
 * 当编辑器套了 max-height + overflow-y:auto 容器时，连续输入或换行
 * 会让光标越界、被 overflow 裁掉。这里手动同步：
 *   1. 找到 .ProseMirror 滚动容器
 *   2. 用 view.coordsAtPos(selection.head) 拿到光标 viewport 坐标
 *   3. 若光标 y 越过容器可视下边界 → 滚到底部；越过上边界 → 滚到顶部
 *
 * 只在光标真的越界时调整 scrollTop，不无脑 scroll 到底——避免覆盖
 * 用户主动向上翻看历史输入时被强制拖回底部的体感问题。
 */
function scrollCaretIntoView(editor: Editor, position?: number): void {
  if (editor.isDestroyed) return;
  const view = editor.view;
  const scroller = view.dom as HTMLElement; // .ProseMirror element
  if (!scroller) return;
  // 仅当容器真有溢出滚动时才需要处理
  if (scroller.scrollHeight <= scroller.clientHeight) return;
  try {
    const head = position ?? view.state.selection.head;
    const caret = view.coordsAtPos(head);
    const box = scroller.getBoundingClientRect();
    // caret.bottom > box.bottom：光标在视口下方 → 把它滚进来
    const PAD = 4; // 给一点呼吸空间
    if (caret.bottom > box.bottom - PAD) {
      scroller.scrollTop += caret.bottom - (box.bottom - PAD);
    } else if (caret.top < box.top + PAD) {
      scroller.scrollTop -= box.top + PAD - caret.top;
    }
  } catch {
    // coordsAtPos 在某些极端瞬间（doc 刚 setContent 完）会抛——
    // 退化为最暴力的"滚到底"，对追底场景仍然正确
    scroller.scrollTop = scroller.scrollHeight;
  }
}

function scrollVoiceInputDraftEndIntoView(editor: Editor): void {
  if (editor.isDestroyed) return;
  const view = editor.view;
  const scroller = view.dom as HTMLElement;
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
  // The voice caret widget sits at the draft end, so it is the most precise
  // anchor; fall back to the ghost-text span, then to the native caret.
  const anchor =
    scroller.querySelector<HTMLElement>('[data-voice-caret]') ??
    scroller.querySelector<HTMLElement>('[data-voice-draft-inline="true"]');
  if (!anchor) {
    scrollCaretIntoView(editor);
    return;
  }
  const draftBox = anchor.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const PAD = 4;
  if (draftBox.bottom > scrollerBox.bottom - PAD) {
    scroller.scrollTop += draftBox.bottom - (scrollerBox.bottom - PAD);
  } else if (draftBox.bottom < scrollerBox.top + PAD) {
    scroller.scrollTop -= scrollerBox.top + PAD - draftBox.bottom;
  }
}

/**
 * Is the editor document "empty" (no text and no chips)? Used to mimic the
 * textarea's `message.trim().length > 0` gate for the Send button.
 */
function isEditorEmpty(editor: Editor | null): boolean {
  if (!editor) return true;
  return composerDocIsEmpty(editor.state.doc);
}

/**
 * Detect the active command-palette trigger based on the current selection.
 * Returns:
 *   - { kind: 'slash', query }  if `/` is the very first character of the doc
 *     and the caret sits in the leading slash-run
 *   - { kind: 'at', query, from } if `@` preceded by whitespace/start exists
 *     in the current text block up to the caret with no whitespace between
 *   - { kind: 'none' } otherwise
 *
 * `from` is the absolute doc position of the `@` char — ChatInput uses it
 * later to replace the `@query` run with a chip + trailing space.
 */
interface TriggerSlash {
  kind: 'slash';
  /** 触发符:'/' = 技能/命令,'$' = 意识指令(2026-07-09 定案分流)。 */
  sigil: '/' | '$';
  query: string;
  from: number; // absolute position of the leading `/` or `$`
}
interface TriggerAt {
  kind: 'at';
  query: string;
  from: number; // absolute position of the `@`
}
type TriggerState = TriggerSlash | TriggerAt | { kind: 'none' };

/**
 * `$` 触发符的等价字符集:中文输入法下 Shift+4 产出的是全角 ¥(U+FFE5),
 * 全角标点模式/日文布局还可能产出全角 $(U+FF04)/半角 ¥(U+00A5)——
 * 一律视作 `$`,用户打中文时不必切输入法。面板选中后统一替换为 ASCII
 * `$cmd `(见 applySlashSelect),发送期 ghostCommand.ts 的 COMMAND_RE
 * 认同一字符集,两端必须保持一致。
 */
const GHOST_SIGIL_CHARS = ['$', '＄', '¥', '￥'] as const;

function detectTrigger(editor: Editor): TriggerState {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return { kind: 'none' };

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);

  // Must be inside a paragraph
  const parent = $pos.parent;
  if (parent.type.name !== 'paragraph') return { kind: 'none' };

  const offsetInParent = $pos.parentOffset;
  // Collect paragraph text up to the caret. We iterate children because
  // inline nodes (chips) break `textBetween` semantics — we want chips to
  // act as hard boundaries that reset any @-run.
  let textSoFar = '';
  let consumed = 0;
  parent.forEach((child) => {
    if (consumed >= offsetInParent) return;
    const size = child.nodeSize;
    if (child.type.name === 'mentionChip' || child.type.name === COMPOSER_QUOTE_NODE_TYPE) {
      textSoFar = ''; // chips reset the @ / slash run
      consumed += size;
      return;
    }
    if (child.isText) {
      const remaining = offsetInParent - consumed;
      const slice = (child.text ?? '').slice(0, remaining);
      textSoFar += slice;
      consumed += slice.length;
    } else {
      // hardBreak (Shift+Enter) → treat as whitespace so @ / / triggers
      // fire at the start of a new line, not glued to the previous word.
      if (child.type.name === 'hardBreak') textSoFar += '\n';
      consumed += size;
    }
  });

  // Slash detection — mirror @ semantics: trigger when `/` sits at the start
  // of the current paragraph OR is preceded by whitespace, with no whitespace
  // between it and the caret. The previous "must be doc[0]" rule was too
  // strict — users couldn't fire / after a Shift+Enter or in a sentence.
  const slashIdx = textSoFar.lastIndexOf('/');
  if (slashIdx >= 0) {
    const beforeSlash = slashIdx === 0 ? '' : textSoFar[slashIdx - 1];
    const slashAllowed = slashIdx === 0 || /\s/.test(beforeSlash);
    const afterSlash = textSoFar.slice(slashIdx + 1);
    if (slashAllowed && !/\s/.test(afterSlash)) {
      return {
        kind: 'slash',
        sigil: '/',
        query: afterSlash,
        from: pos - (textSoFar.length - slashIdx),
      };
    }
  }

  // `$` 检测 —— 与 `/` 同规则(段首或空白后,到光标无空白):意识指令面板。
  // 全角变体(GHOST_SIGIL_CHARS)同权触发;都是单 UTF-16 code unit,位置
  // 计算与 ASCII `$` 完全一致。
  let dollarIdx = -1;
  for (const sigil of GHOST_SIGIL_CHARS) {
    const idx = textSoFar.lastIndexOf(sigil);
    if (idx > dollarIdx) dollarIdx = idx;
  }
  if (dollarIdx >= 0) {
    const beforeDollar = dollarIdx === 0 ? '' : textSoFar[dollarIdx - 1];
    const dollarAllowed = dollarIdx === 0 || /\s/.test(beforeDollar);
    const afterDollar = textSoFar.slice(dollarIdx + 1);
    if (dollarAllowed && !/\s/.test(afterDollar)) {
      return {
        kind: 'slash',
        sigil: '$',
        query: afterDollar,
        from: pos - (textSoFar.length - dollarIdx),
      };
    }
  }

  // @ detection — find the last `@` with whitespace or start-of-text before it.
  const atIdx = textSoFar.lastIndexOf('@');
  if (atIdx >= 0) {
    const before = atIdx === 0 ? '' : textSoFar[atIdx - 1];
    const allowed = atIdx === 0 || /\s/.test(before);
    const after = textSoFar.slice(atIdx + 1);
    const from = pos - (textSoFar.length - atIdx);
    if (allowed && !/\s/.test(after)) {
      return {
        kind: 'at',
        query: after,
        from,
      };
    }
  }

  return { kind: 'none' };
}

/**
 * 合成激活(「+」按钮打开统一建议面板,Codex 模式)的 query 推导:
 * 不向文档插入 `@`,query = 锚点→光标之间的纯文本。返回 null 表示锚点失效
 * (光标移到锚点前 / 跨段落 / 中间出现空白、chip 或换行),此时
 * ChatInput 会清掉合成锚点、关闭面板。
 */
function deriveSyntheticAtQuery(editor: Editor, anchor: number, rangeEnd: number): string | null {
  const { state } = editor;
  const { selection, doc } = state;
  // 点击「+」前可能已有文本选区。synthetic anchor 就落在 selection.from，
  // 选区未变化时仍是空查询；用户继续输入后 ProseMirror 会自然替换选区并折叠光标，
  // 后续字符再按 anchor → caret 推导 query。
  if (!selection.empty) return selection.from === anchor ? '' : null;
  const pos = selection.from;
  if (pos < anchor || pos > rangeEnd || anchor > doc.content.size || rangeEnd > doc.content.size) {
    return null;
  }
  let $anchor;
  let $pos;
  try {
    $anchor = doc.resolve(anchor);
    $pos = doc.resolve(pos);
  } catch {
    return null;
  }
  if ($anchor.parent.type.name !== 'paragraph' || $anchor.parent !== $pos.parent) return null;
  // textBetween 用占位符替换非文本节点(chip / hardBreak),含占位符或空白即失效。
  const text = doc.textBetween(anchor, pos, '￼', '￼');
  if (/[\s￼]/.test(text)) return null;
  return text;
}

export function ChatInput({
  onSend,
  sessionId,
  runtimeAgentKind,
  sessionOrcaRole,
  initialWorkingDir,
  remoteHostId,
  deviceLinkDeviceId: _deviceLinkDeviceId,
  modelMemoryOverride,
  initialModel,
  initialEffort,
  initialProviderId,
  initialPermissionMode,
  planModeEnabled = false,
  onPlanModeChange,
  fastMode = false,
  onFastModeChange,
  onWorkingDirChange,
  disabled,
  settingsLocked = false,
  isStreaming = false,
  isAgentBusy,
  onStop,
  onBeforeVoiceInputStart,
  pendingQueue,
  queueExpanded = false,
  onQueueExpandedChange,
  onQueueRemove,
  onQueueEdit,
  onQueueSteer,
  steeringQueueClientIds = [],
  queuePaused = false,
  onQueueResume,
  onQueueReorder,
  onQueueInteractionLock,
  onQueueEditLock,
  messages,
  placeholder,
  folderPickerOpen,
  onFolderPickerOpenChange,
  showFolderPicker = true,
  leftOfFolderPicker,
  onModelDidChange,
  onEffortDidChange,
  onPermissionModeDidChange,
  onProviderDidChange,
  attachmentState,
  paletteMaxHeight,
  externalDragOver = false,
  onComposerDropHandled,
  vendorKey,
  draftKey,
  disableAutofocus = false,
  focusOnStorageKeyChange = false,
  ownsHardwareComposerActions = true,
  extraDirs,
  onExtraDirsChange,
  onNewGoal,
  rememberedEffortByModel,
  onRememberedEffortChange,
  compactToolbar = false,
  narrowToolbar = false,
  denseToolbar = false,
  visualVariant = 'default',
  middleToolbarSlot,
  compactMiddleToolbarSlot,
  topSlot,
  collaboration,
  onUnifiedDraftSelect,
  selectedFavoriteUid = null,
}: ChatInputProps) {
  // device-link 远程会话:null = 已确认本地会话,undefined = 所有权尚未解析,string = 远程会话。
  // 预测守卫用原始值区分 null vs undefined,下游通路继续用 ?? undefined 归一化。
  const deviceLinkDeviceId = _deviceLinkDeviceId;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { preference: composerSendShortcutPreference } = useComposerSendShortcutPreference();
  // ── 推荐提示词 ────────────────────────────────────────────────────
  // 设置开关:通过 shared hook 订阅,与 TipsSection 同源,切换后立即生效。
  const { enabled: recommendationEnabled } = usePromptRecommendationPreference();
  // 推荐词渲染成一层 overlay 盖在编辑器上(原生 placeholder 由 CSS 隐藏)——
  // Tiptap Placeholder 的文本在 extension 创建时定型,运行期改不动,所以不走它。
  const [recommendedPrompt, setRecommendedPrompt] = useState<string | null>(null);
  // handleKeyDown / onUpdate 是稳定闭包,读不到 state,走 ref 取值
  const recommendedPromptRef = useRef<string | null>(null);
  recommendedPromptRef.current = recommendedPrompt;
  const showRecommendationRef = useRef(false);
  // 完整输入框空判断:不仅检查 ProseMirror 文档是否为空,还检查附件、浏览器评论和语音稿。
  // 避免在用户放好了附件/评论/语音稿但正文为空时,仍发起付费的 predictNextPrompt 调用。
  const voiceDraftTextRef = useRef('');
  const composerFullyEmptyRef = useRef<() => boolean>(() => true);
  composerFullyEmptyRef.current = () => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return false;
    return (
      composerDocIsEmpty(ed.state.doc) &&
      latestAttachmentsRef.current.length === 0 &&
      browserCommentsRef.current.length === 0 &&
      voiceDraftTextRef.current.length === 0
    );
  };
  const resolvedPlaceholder = placeholder ?? t('newChat.chatInput.defaultPlaceholder');
  const composerSendShortcutLabel = getComposerSendShortcutLabel(
    composerSendShortcutPreference,
    window.electronAPI?.platform,
  );
  const steerShortcutLabel = useMemo(
    () => (window.electronAPI?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'),
    [],
  );
  // Storage key for composerDraftStore. Defaults to sessionId so existing
  // call sites keep working unchanged; NewMakerDraftRoute passes an explicit
  // sentinel to keep the transient draft alive across sidebar switches.
  const storageKey = draftKey ?? sessionId;
  // perf/session-switch 探针(见文件头 perfLog 注释):按 storageKey 换代计一次
  // render 起点,layout effect 里量到 commit 完成;覆盖"remount"与"复用组件仅换
  // key"两种切换形态。纯诊断:所有测量走 import.meta.env.DEV,生产构建里 body
  // 被 dead-code 消除(hooks 本身按 rules-of-hooks 保持无条件调用,残留可忽略)。
  const perfCommitKeyRef = useRef<string | null>(null);
  const perfCommitStartRef = useRef(0);
  const perfCommitKey = storageKey ?? 'null';
  if (import.meta.env.DEV && perfCommitKeyRef.current !== perfCommitKey) {
    perfCommitKeyRef.current = perfCommitKey;
    perfCommitStartRef.current = performance.now();
  }
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const durMs = performance.now() - perfCommitStartRef.current;
    if (durMs >= 30) {
      perfLog.debug(`chat-input:commit key=${perfCommitKey} dur=${Math.round(durMs)}ms`);
    }
  }, [perfCommitKey]);
  // composer 「+」菜单 → 新建目标弹窗开关(仅会话中可用)。
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  // 点「新建目标」时把输入框当前文字带进弹窗作默认目标内容。
  const [newGoalInitial, setNewGoalInitial] = useState('');
  // 会话内「新建目标」对本机与 device-link 远程会话都开放:远程会话的 setGoal / 状态
  // 订阅经 goalApiFor / subscribeGoalStatusChanged 隧道到被控端 goal-host(目标随会话
  // 在被控端自主续跑)。历史上 device-link 曾被排除(reviewer #354,当时无隧道路由)。
  const inSessionGoalEnabled = !!sessionId;
  // 无参 `/goal` 命令 → 等同点「新建目标」:main 广播 goalAction:'open-dialog',
  // 这里按 sessionId 过滤后打开本会话的弹窗(命令侧已确保有 session)。
  useEffect(() => {
    if (!sessionId) return;
    return window.electronAPI.maker.onDesktopCommandTriggered((payload) => {
      if (
        payload.command === 'goal' &&
        payload.goalAction === 'open-dialog' &&
        payload.sessionId === sessionId
      ) {
        setNewGoalOpen(true);
      }
    });
  }, [sessionId]);
  // 延迟凭证切换(set-model 时会话在跑,登记 pending)在 turn 结束兑现 → 会话内轻提示,
  // 让用户确知"来源切换已生效"(对应 deferred toast 的收尾,消除切没切成的不确定感)。
  useEffect(() => {
    if (!sessionId) return;
    return window.electronAPI.maker.onSessionCredentialSwitchApplied((payload) => {
      if (payload.sessionId !== sessionId) return;
      toast.success(t('newChat.chatInput.credentialSwitchApplied'), { duration: 3000 });
    });
  }, [sessionId, t]);
  // F-QUEUE-1 — preserve prior semantics
  const showStopButton = isAgentBusy ?? isStreaming;
  const { confirm: confirmDialog } = useConfirmDialog();

  // ── ESC / history ref bridges for Tiptap handleKeyDown ────────────
  // Tiptap editorProps can't read React state, so we use refs.
  const onStopRef = useRef(onStop);
  // 用户点击 Stop 时标记 wasTurnStoppedByUserRef,阻止该轮次触发预测。
  onStopRef.current = onStop;
  const handleStop = useCallback(() => {
    wasTurnStoppedByUserRef.current = true;
    onStop?.();
  }, [onStop]);
  const showStopButtonRef = useRef(showStopButton);
  showStopButtonRef.current = showStopButton;

  const recommendationEnabledRef = useRef(recommendationEnabled);
  recommendationEnabledRef.current = recommendationEnabled;

  // ── 推荐提示词:turn 结束(showStopButton true→false)→ 调 IPC 预测 ────
  // messages 在流式期间每个 delta 都变,放进 deps 会让本 effect 反复重跑并把
  // prevShowStopRef 冲掉,从而永远检测不到那次跳变 —— 所以走 ref 读最新值。
  const prevShowStopRef = useRef(false);
  // 用户点击 Stop 或 turn 以错误结束时，不应触发预测。
  // 该 ref 在 Stop 按钮/快捷键触发时置 true，新 turn 开始时重置。
  const wasTurnStoppedByUserRef = useRef(false);
  // turnGen: 每次新 turn 开始递增,预测请求携带代次;落地时检查代次与 sessionId
  // 是否仍匹配,避免旧请求覆盖新轮推荐或跨 session 残留。
  // 递增分两层:render 阶段同步检测 showStopButton false→true 跳变,关闭「用户操作
  // → React render」之间旧 Promise 落地的空窗;useEffect 里照旧做清除推荐 UI 的副作用。
  const turnGenRef = useRef(0);
  const prevShowStopRender = useRef(false);
  const prevSessionIdRef = useRef(sessionId);
  // sessionId 切换时在 render 阶段同步更新预测相关 ref，消除 session 切换与
  // layout effect 之间的时序窗口。旧代码将 ref 更新放在 useLayoutEffect 中，
  // 当会话 A 的预测仍在途且切换到会话 B 时，sessionId 已变但 ref 未更新，
  // 旧 Promise 返回时仍通过 prevSessionIdRef.current === requestSessionId 校验，
  // 导致会话 A 的推荐词写入会话 B 的输入框。
  // 修复：在 render 阶段同步更新 ref，旧 session 的预测请求落回时
  // prevSessionIdRef 已更新为新 sessionId，校验失败后静默丢弃。
  // React concurrent rendering 下若某次 render 被丢弃，ref 会在实际 commit 的
  // render 中再次正确更新，不影响最终正确性。
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    prevShowStopRef.current = false;
    turnGenRef.current += 1;
    prevShowStopRender.current = false;
    showRecommendationRef.current = false;
  }
  // useLayoutEffect 在 React commit 后、浏览器绘制前同步执行，比 useEffect 更接近
  // render 阶段的时序，同时避免 React concurrent rendering 下 render 被丢弃但 ref
  // 已被错误修改的风险。防御纵深：发送时已通过 turnGenRef.current += 1 立即失效
  // 旧预测（见 handleSend），此处作为兜底处理 showStopButton 跳变场景。
  useLayoutEffect(() => {
    const turnStarting = showStopButton && !prevShowStopRender.current;
    prevShowStopRender.current = showStopButton;
    if (turnStarting) {
      turnGenRef.current += 1;
    }
  });
  useLayoutEffect(() => {
    // sessionId 变化时同步清除推荐 UI（用 useLayoutEffect 避免旧推荐跨会话闪现）
    setRecommendedPrompt(null);
  }, [sessionId]);
  useEffect(() => {
    // 用户在 Settings 里关闭推荐提示词后,立即清除当前可见的推荐 UI。
    if (!recommendationEnabled) {
      setRecommendedPrompt(null);
    }
  }, [recommendationEnabled]);
  // messages 是可选 prop,缺省按空历史处理(空历史不发预测请求)。
  const messagesRef = useRef(messages ?? []);
  messagesRef.current = messages ?? [];
  useEffect(() => {
    const wasRunning = prevShowStopRef.current;
    prevShowStopRef.current = showStopButton;
    // 新 turn 开始 → 清除推荐 UI(代次已在 render 阶段同步递增)
    if (showStopButton) {
      showRecommendationRef.current = false;
      setRecommendedPrompt(null);
      wasTurnStoppedByUserRef.current = false;
    }
    // device-link 远程会话 & SSH 远程会话:maker:predict-prompt 不在 allowlist,且远程对话内容
    // 不应送到控制端本地 provider/凭证 —— 跳过预测。deviceLinkDeviceId 语义（来自
    // CCAgentSessionView）：
    //   null = 已确认本地会话 → 允许预测
    //   undefined = 所有权尚未解析 → 跳过预测（device-link 引导/重连窗口期归属未定，
    //               远程转写可能被误送到本地 provider，故 fail-closed）
    //   string = 远程会话 → 被下面 deviceLinkDeviceId === null 拦截
    if (wasRunning && !showStopButton && recommendationEnabled && sessionId && deviceLinkDeviceId === null && !remoteHostId) {
      // 当 composer 被禁用时（如 reviewer 任务完成后 read-only），不应触发
      // 预测：用户无法 Tab 填入或发送，发起 provider 调用是浪费。
      // 读取 disabled prop 而非 disabledRef：disabledRef 由后续 effect 刷新，
      // reviewer 任务变为 read-only 的同一次 render 中 ref 可能仍是旧值。
      if (disabled) return;
      // 后台 wake 型任务(local_agent / local_workflow)仍在运行时,主 turn 报告
      // 用户点击 Stop 或 turn 以错误/中止结束时,不应触发预测。
      // turnStoppedByUser 是 session 级 store 字段(stopSession 置位、新 turn 复位),
      // 确保同一 session 在多窗口打开时,任一窗口的 Stop 都能阻止其他窗口触发预测。
      if (makerChatStore.getSnapshot(sessionId)?.turnStoppedByUser) return;
      // turn 以终端错误结束时，不应触发预测：错误上下文可能包含不完整/损坏的对话，
      // 避免在错误状态下发起付费 provider 调用。
      if (makerChatStore.getSnapshot(sessionId)?.error) return;
      // stopped 但会话仍在工作 —— 跳过预测,避免用不完整上下文发起付费调用。
      // hasBackgroundAgentWork 已在 _isSessionBusy 里统一折算,这里单独补门禁。
      if (makerChatStore.hasBackgroundAgentWork(sessionId)) return;
	      // side-task（skipTurnReset 如 Mivo 侧通道）结束时，store 将 running 翻为
	      // false 但未产生新的 assistant 回复，不应在对话内容未变时发起付费预测。
	      if (wasLastStopSideTask(sessionId)) return;
      // 冷加载帧:runtimeAgentKind 尚未确认时就默认 claude-code,会将其他引擎的会话内容
      // 发给 Claude Code provider —— 跳过预测,等 agent 身份确认后再恢复。
      if (runtimeAgentKind == null) return;
      const latestMessages = messagesRef.current;
      const ed = editorRef.current;
      if (
        latestMessages.length > 0 &&
        ed &&
        !ed.isDestroyed &&
        composerFullyEmptyRef.current()
      ) {
        const contextMsgs = latestMessages.slice(-20).map((m) => ({
          role: m.role,
          content: m.content,
        }));
        // 捕获请求时刻的 sessionId、turnGen 与 workingDir 快照,落地前校验是否仍匹配。
        const requestSessionId = sessionId;
        const requestTurnGen = turnGenRef.current;
        const requestWorkingDir = workingDir;
        // 去重:同一 session 同一 turnGen 同时只有一次预测调用,避免重复 provider 调用与费用。
        // 当旧 turn 预测仍在途时新 turn 触发预测,新 turnGen 不同 → 替换旧条目,允许新预测通过。
        const existingTurnGen = _predictingSessions.get(requestSessionId);
        if (existingTurnGen === requestTurnGen) return;
        _predictingSessions.set(requestSessionId, requestTurnGen);
        window.electronAPI.maker
          .predictNextPrompt({
            sessionId,
            agentKind: runtimeAgentKind,
            messages: contextMsgs,
            workingDir: workingDir ?? undefined,
            turnGen: requestTurnGen,
          })
          .then((result) => {
            if (_predictingSessions.get(requestSessionId) === requestTurnGen) {
              _predictingSessions.delete(requestSessionId);
            }
            // 请求往返期间用户可能已经切换会话、发起新 turn 或开始打字 —— 落地前
            // 重新确认 sessionId、turnGen、编辑器状态,否则旧上下文的推荐会覆盖当前轮。
            const cur = editorRef.current;
            if (
              result?.prompt &&
              recommendationEnabledRef.current &&
              cur &&
              !cur.isDestroyed &&
              composerFullyEmptyRef.current() &&
              !showStopButtonRef.current &&
              !composerMutationLockedRef.current &&
              prevSessionIdRef.current === requestSessionId &&
              turnGenRef.current === requestTurnGen &&
              workingDirRef.current === requestWorkingDir
            ) {
              showRecommendationRef.current = true;
              setRecommendedPrompt(result.prompt);
            }
          })
          .catch(() => {
            if (_predictingSessions.get(requestSessionId) === requestTurnGen) {
              _predictingSessions.delete(requestSessionId);
            }
            // 预测失败静默处理:不显示推荐,也不回落任何默认文案。
          });
      }
    }
    // 新 turn 开始 → 立即撤掉推荐
    if (showStopButton) {
      showRecommendationRef.current = false;
      setRecommendedPrompt(null);
    }
  }, [showStopButton, sessionId, recommendationEnabled, runtimeAgentKind]);

  // F-QUEUE-DEFER: when the queue panel is expanded, esc collapses it
  // BEFORE falling through to the existing stop / history shortcuts. That
  // way the user's mental model stays consistent: esc = "back out of the
  // current thing". For the queue this only collapses the tail after the first
  // three rows; it does not affect dispatch.
  const queueExpandedRef = useRef(queueExpanded);
  queueExpandedRef.current = queueExpanded;
  const onQueueExpandedChangeRef = useRef(onQueueExpandedChange);
  onQueueExpandedChangeRef.current = onQueueExpandedChange;
  // F-QUEUE-DEFER: outside-click collapses the queue tail. Boundary = the
  // palette anchor layer that holds the merged card (panel + input editor)
  // AND the palette host (slash / at-mention popovers) — clicking into the
  // editor or a palette row must NOT collapse rows under the user's cursor.
  // (The palette host sits outside the merged card since the slash-menu
  // overlap fix, so the boundary must be the anchor layer, not the card.)
  const mergedCardRef = useRef<HTMLDivElement | null>(null);
  const paletteAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!queueExpanded || !onQueueExpandedChange) return;
    const handler = (e: MouseEvent) => {
      const root = paletteAnchorRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      onQueueExpandedChange(false);
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [queueExpanded, onQueueExpandedChange]);

  // ── 工具行宽度自适应 ────────────────────────────────────────────────
  // 测 input card（mergedCardRef）实际宽度，窄宽时自动收紧工具行。主会话被右栏
  // 拖宽压窄时据此折叠，行为对齐 doc rail（doc rail 仍按 denseToolbar 强制收紧，
  // 二者取 OR）。ResizeObserver 只读宽度、值不变时 React 跳过 setState，不影响
  // 输入热路径。
  const [toolbarWidth, setToolbarWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = mergedCardRef.current;
    if (!el) return;
    const update = () => setToolbarWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const autoDenseToolbar = toolbarWidth != null && toolbarWidth < TOOLBAR_DENSE_MAX_WIDTH;
  const autoCompactToolbar = toolbarWidth != null && toolbarWidth < TOOLBAR_COMPACT_MAX_WIDTH;
  const effectiveDenseToolbar = denseToolbar || autoDenseToolbar;
  const effectiveCompactToolbar = compactToolbar || autoCompactToolbar;

  // ── User message history for ↑/↓ navigation ──────────────────────
  const userHistoryRef = useRef<ComposerHistoryEntry[]>([]);
  userHistoryRef.current = deriveStableComposerHistory(messages, userHistoryRef.current);
  const historyIndexRef = useRef(-1); // -1 = current draft (not browsing)
  const draftRef = useRef<JSONContent | null>(null); // saves draft doc JSON when user starts browsing (preserves marks)
  const hydratedHistoryDocumentRef = useRef<ProseMirrorNode | null>(null);

  // ── composer-draft-per-session ─────────────────────────────────────
  // When the parent switches `sessionId`, a `useEffect` below restores the
  // saved Tiptap doc (if any) into the editor. Tiptap's `setContent` fires
  // `onUpdate`, which would re-save the just-restored content into the
  // store and (if it ran during a different session change) potentially
  // race. This ref short-circuits `onUpdate`'s save side-effect during
  // restore so the user-typing path stays the only writer.
  const isRestoringRef = useRef(false);
  // Track which storageKey the *editor's* current content belongs to.
  // Compared with the prop `storageKey` inside the restore effect so we
  // don't re-restore on every render — only when the prop actually changes.
  const editorStorageKeyRef = useRef<string | undefined>(storageKey);
  // Stable ref so the Tiptap `onUpdate` closure (created once at useEditor
  // time) always reads the key that the editor content currently belongs to.
  // During voice-input session switches this can intentionally lag behind the
  // prop `storageKey` until the old stop/refine/send transaction is complete.
  const storageKeyForDraftRef = useRef<string | undefined>(storageKey);
  // The editor owns both a raw storageKey and the data-owner generation that
  // qualified it. Stale effects must never reinterpret an old editor as the
  // newly published owner just because the raw session id is unchanged.
  const editorDataOwnerRef = useRef(getDataOwnerGeneration());
  // composer-draft-mount-race 修复 (issue #40):Tiptap 的 useEditor 在 mount 期间
  // 会因为我们挂的 decoration 扩展 (CjkPunctDecoration / VoiceInputDraftDecoration)
  // 触发一次 onUpdate,这次 onUpdate 跑在 React 的 useEffect 之前(早 4ms 量级),
  // 拿到的是 editor 的初始空 doc,会把 composerDraftStore 里已有的真实草稿
  // 覆盖成空文档。等 storageKey-effect 跑 hydration 时,store 已经被刷成空了,
  // setContent 自然只能恢复空。
  //
  // 同 feature 内复用同一个 ChatInput 实例的路径(`/cc-agent/A` → `/cc-agent/B`)
  // 不会触发,因为没有 mount;Orca / FadeSwitcher 重挂 / 跨 feature 切换才会踩到。
  //
  // 修法:onUpdate 在 hydration effect 至少跑一次之前直接 return,不写 store。
  // hydration effect 在结尾会把这个 ref 翻成 true,真正用户按键路径不受影响。
  const hasHydratedRef = useRef(false);

  // ── File attachments (F-FI-1) ──
  // 由调用方持有(必传 attachmentState),ChatInput 内部不再 fallback 一份
  // useAttachments,避免:
  //   1. 与父级共享同一 composerDraftStore slot 的 race(切回 A 附件丢失)
  //   2. 1×useState + 4×useRef + 6×useCallback + 1×useEffect 的死分配
  const {
    attachments,
    hasAttachments,
    addFiles,
    addClipboardImage,
    rejections,
    dismissRejection,
    addFolderPath,
    pendingFoldersVersion,
    consumePendingFolders,
    pendingFileMentionsVersion,
    consumePendingFileMentions,
    removeFile,
    updateFile,
    discardFiles,
    restoreFiles,
    clearFiles,
  } = attachmentState;
  const latestAttachmentsRef = useRef(attachments);
  latestAttachmentsRef.current = attachments;
  // browser-comment-chip:内置浏览器页面评论(结构化,不进草稿文本),渲染为
  // 「N 条注释」胶囊,发送时序列化 + 截图并入 filesToSend。
  const [browserComments, setBrowserComments] = useState<BrowserCommentDraftItem[]>([]);
  const browserCommentsRef = useRef<BrowserCommentDraftItem[]>(browserComments);
  browserCommentsRef.current = browserComments;

  // Ref bridge for Tiptap handlePaste — editorProps can't read React
  // state directly, so we expose attachment writers via stable refs.
  const addClipboardImageRef = useRef(addClipboardImage);
  addClipboardImageRef.current = addClipboardImage;
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const addFolderPathRef = useRef(addFolderPath);
  addFolderPathRef.current = addFolderPath;
  const localAttachmentPickerEnabled = canUseLocalAttachmentPicker({
    sessionId,
    runtimeAgentKind,
    remoteHostId,
    deviceLinkDeviceId,
  });
  const suggestionFileInputRef = useRef<HTMLInputElement>(null);

  // ── 「+」合成打开统一建议面板(Codex 模式)────────────────────────────
  // state 在 at-panel 区声明;editor 回调(render gate / blur)先于 state 声明
  // 创建,通过 ref 读最新锚点。锚点 = 打开面板那一刻的光标位,query = 锚点→光标
  // 纯文本(deriveSyntheticAtQuery)。
  const syntheticAtAnchorRef = useRef<number | null>(null);
  // synthetic query 的真实替换终点跟随 ProseMirror transaction mapping；它与
  // 当前光标位置分离，因此光标移回 query 中间时仍能删除完整 filter，同时不会
  // 吞掉「+」激活前就存在于锚点后的连续文本。
  const syntheticAtRangeEndRef = useRef<number | null>(null);
  const [syntheticAtAnchor, setSyntheticAtAnchorState] = useState<number | null>(null);
  const setSyntheticAtAnchor = useCallback((next: number | null) => {
    const previous = syntheticAtAnchorRef.current;
    syntheticAtAnchorRef.current = next;
    if (next === null) {
      syntheticAtRangeEndRef.current = null;
    } else if (previous !== next || syntheticAtRangeEndRef.current === null) {
      syntheticAtRangeEndRef.current = next;
    }
    setSyntheticAtAnchorState(next);
  }, []);
  // render gate 的 trigger 快照:typed 触发优先;合成激活期间以 pseudo-at 快照
  // 参与 diff,保证「+」打开后继续打字仍能触发 React 刷新(否则 gate 会把
  // trigger:none 的普通输入吞掉,面板不过滤)。锚点失效时返回哨兵 query,
  // 放行一次刷新让清锚点 effect 跑掉。
  const composerTriggerSnapshotOf = (ed: Editor): TriggerState => {
    const typed = detectTrigger(ed);
    if (typed.kind !== 'none') return typed;
    const anchor = syntheticAtAnchorRef.current;
    if (anchor != null) {
      const rangeEnd = syntheticAtRangeEndRef.current;
      const q = rangeEnd == null ? null : deriveSyntheticAtQuery(ed, anchor, rangeEnd);
      return { kind: 'at', query: q ?? '__synthetic_invalid__', from: anchor };
    }
    return typed;
  };

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const composerMentionDragActiveRef = useRef(false);
  const suppressListNormalizationRef = useRef(false);
  const listPromotionQueuedRef = useRef(false);
  const lastComposerSelectionFromRef = useRef<number | null>(null);
  const internalMentionDragActiveRef = useRef(false);
  const [workingDir, setWorkingDir] = useState<string | null>(initialWorkingDir ?? null);
  const [internalFolderOpen, setInternalFolderOpen] = useState(false);

  // 工作目录变化 → 作废在途推荐并清除已显示推荐,避免旧目录上下文诱导错误操作。
  useEffect(() => {
    turnGenRef.current += 1;
    showRecommendationRef.current = false;
    setRecommendedPrompt(null);
  }, [workingDir]);

  // Ref bridge for Tiptap handlePaste(粘贴管线):editorProps 闭包只建一次,
  // 读不到最新 state / props / t——粘贴时的 workdir(路径识别范围)、会话来源
  // (stat 路由)、当前语言(pasted chip 文案)全部经 ref 取现值。
  const workingDirRef = useRef<string | null>(workingDir);
  workingDirRef.current = workingDir;
  const remoteHostIdRef = useRef<string | null | undefined>(remoteHostId);
  remoteHostIdRef.current = remoteHostId;
  const deviceLinkDeviceIdRef = useRef<string | null | undefined>(deviceLinkDeviceId);
  deviceLinkDeviceIdRef.current = deviceLinkDeviceId;
  // Host capability 芯片只在「已确认本机」的 composer 里有效:SSH(remoteHostId)或
  // device-link 远程会话若恢复本地草稿里序列化的芯片,发送路径会因
  // TARGET_UNAVAILABLE 中断、逼用户手动删芯片。这里把「归一化 + 已确认远程剥芯片」
  // 收口成一个入口,供草稿恢复路径统一复用。
  // 三态:deviceLinkDeviceId = string(远程) / null(本机) / undefined(归属未解析)。
  // 冷打开/重载时首帧归属尚未回流(undefined),不能当远程把已存本机草稿的芯片剥掉
  // —— 只在「已确认远程」(SSH remoteHostId 或 deviceLinkDeviceId 为 string)时剥离,
  // 未解析(undefined)时延后决定、保留芯片;随后本机(null)自然保留,若解析成远程则由
  // 发送路径的 hostCapabilityGhost 谓词 fail-closed 兜底。
  const normalizeRestoredComposerDraft = (
    draftText: JSONContent | null | undefined,
  ): JSONContent | null => {
    if (!draftText) return null;
    const normalized = normalizeComposerDocumentJSON(draftText);
    const isConfirmedRemote =
      !!remoteHostIdRef.current || typeof deviceLinkDeviceIdRef.current === 'string';
    return isConfirmedRemote ? stripHostCapabilityChips(normalized) : normalized;
  };
  const tRef = useRef(t);
  tRef.current = t;
  // 长文本粘贴 chip 的点击编辑目标。保存时用 nodePos + originalText 双重校验，
  // 防止弹窗打开期间草稿 / 会话替换后误改同位置上的其它节点。
  const [pastedTextEditTarget, setPastedTextEditTarget] = useState<{
    nodePos: number;
    originalText: string;
  } | null>(null);

  // ── Model / effort / permission — Single Source of Truth ────────────
  // model-selector-xhigh-ui-stale fix (2026-04-21): the previous design held
  // local override state (`localModel/localEffort/localPermissionMode`) that
  // was set inside the `handleXxxChange` callbacks AFTER `await` boundaries.
  // That created two parallel state tracks (local override vs. props derived
  // from `session?.xxx`); when the user clicked a new effort, the local
  // override updated, but the parent's `session.effort` did not refresh
  // until ChatInput unmounted/remounted (e.g. via session route navigation).
  // The visible result was: button text stayed stale on "Medium"
  // even though the user just picked "XHigh".
  //
  // Fix: derive directly from props every render; let the parent own the
  // truth. Each handler calls a `onXxxDidChange` callback so the parent can
  // refresh `serverSession` (the same mechanism `handleModelDidChange`
  // already uses). One render cycle later, props arrive and UI updates.
  // device-link 远程切换:in-flight 乐观快照(仅远程分支写入)。远程会话的 model/effort 没有本地
  // 乐观态(本地分支靠 update + 快速 refresh 隐藏延迟),必须等被控端经 sessions:patched 回流(网络
  // 往返)才更新 props —— 期间 chip 各字段会先回落默认(`?? defaultModel` / nativeDefaultSourceId)
  // 再跳变。点击即把目标 (model, effort, provider) 乐观显示出来 + 置灰禁用 selector,props(mirror)
  // 追上目标或超时后解除;隧道失败回滚。本地会话恒为 null,行为逐字节不变(保持上方 SSoT-from-props 不变量)。
  const [pendingRemoteSwitch, setPendingRemoteSwitch] = useState<{
    model: string;
    effort: Effort;
    providerId: string | null;
  } | null>(null);
  // device-link 远程切换的「禁用」只绑定隧道 await 进行中(被控端 ack 即解除),**不**等完整 mirror 回流。
  // 原因:providerId 等字段在控制端 mirror 上回流不可靠(远程会话 serverSession 恒空、mirrorSessionFields
  // 只镜像 fastMode),若把禁用绑到 pendingRemoteSwitch 的三元 settle 上,跨来源切换(如 GPT→Opus 必换来源)
  // 会一直 settle 不了、selector 置灰吃满 5s 兜底。乐观显示(chip 不回落默认)仍由 pendingRemoteSwitch 承接。
  const [remoteSwitchInFlight, setRemoteSwitchInFlight] = useState(false);
  // 跨引擎切换的 pending 真源在模块级协调器：切走再切回 / 组件重挂时仍保持发送门禁。
  const agentSwitchInFlight = useSyncExternalStore(
    subscribeAgentSwitchPending,
    () => !!sessionId && hasPendingAgentSwitchOperation(sessionId),
    () => false,
  );
  const agentSendDispatchInFlight = useSyncExternalStore(
    subscribeAgentSwitchPending,
    () => !!sessionId && hasPendingAgentSendDispatch(sessionId),
    () => false,
  );
  useEffect(() => {
    setPendingRemoteSwitch(null);
    setRemoteSwitchInFlight(false);
  }, [sessionId]);

  // initialModel/initialEffort 缺失的瞬态(会话快照未加载)兜底:读本地草稿 lastByVendor
  // (localStorage,按 agent 分槽、sanitize 恒有种子值)。默认模型/档位偏好已全量本地化,
  // 不再依赖服务端 UserPreferences(登录态失效/离线时模型与档位选择必须照常工作)。
  const localVendorDefaults =
    getDraft().lastByVendor[vendorKey === 'pi' ? 'pi' : vendorKey === 'codex' ? 'codex' : 'cc'];
  // session-agent-switch 意图制:意图期内 chip / 选择器显示用户选择的目标
  // (model/effort/provider/fast),props(镜像 DB)仍是旧引擎值——真切换在下一条
  // 消息发送时刻 apply,patched 回流后意图清除、显示交回 props。意图存放在
  // SessionChatState 独立槽位,登记/撤销通过 setState 驱动重渲染,不会改真实
  // agentKind reducer 路由。device-link 远程会话同样适用:意图的权威态在被控端
  // main,控制端 store 里这份是它的镜像(登记时乐观写、重连时读回、push 回流覆盖)。
  const agentSwitchIntent =
    sessionId && !remoteHostId ? makerChatStore.getAgentSwitchIntent(sessionId) : null;
  const activeModel =
    agentSwitchIntent?.model ??
    pendingRemoteSwitch?.model ??
    initialModel ??
    localVendorDefaults.model;
  const activeEffort =
    (agentSwitchIntent?.effort as Effort | undefined) ??
    pendingRemoteSwitch?.effort ??
    initialEffort ??
    localVendorDefaults.effort;
  const activePermissionMode: PermissionMode =
    initialPermissionMode ?? localVendorDefaults.permissionMode;

  // per-session 来源(供应商)选择。session.providerId 尚未在 Session 类型回流前,
  // 这里用本地乐观态承接即时反馈:seed 自 initialProviderId,选择时乐观更新;
  // initialProviderId 变化(将来 session 回流)时跟随。null = 跟随默认路由。
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    initialProviderId ?? null,
  );
  // in-flight 远程切换期间不让 mirror 的瞬时回流(可能短暂为空)打断乐观 provider,否则 mark 会闪默认来源。
  useEffect(() => {
    if (pendingRemoteSwitch) return;
    setSelectedProviderId(initialProviderId ?? null);
  }, [initialProviderId, pendingRemoteSwitch]);

  // 意图期的来源与模型/Agent 同属一份乐观展示快照。不能让旧会话的
  // selectedProviderId 继续参与断开态、默认来源与发送来源解析，否则会形成
  // 「目标 Agent + 目标模型 + 旧来源」的混合状态；null 仍表示跟随目标引擎默认路由。
  const activeProviderId = agentSwitchIntent ? agentSwitchIntent.providerId : selectedProviderId;

  /**
   * 会话内经统一面板选中的**收藏锚点**(model-selector-unified §1.5,2026-08-17 review 第三轮 G4)。
   *
   * 它曾经刻意只是**渲染进程内存态**(重启 / 刷新 / 换会话即忘),理由是「只是 UI 选中提示,
   * 忘掉等价于从没选过收藏」。Chris 2026-08-19 实测推翻了这条取舍:收藏区置顶、模型行在下面,
   * 锚点一忘,面板就回落到模型行打勾并把列表滚到那一行 —— 用户看到的是「我明明选了收藏第 3
   * 个,打开选单默认焦点永远在下面不在收藏」。所以改成按 sessionId 持久化到
   * `favoriteAnchorMemory`(renderer localStorage,按 owner 分区、LRU 100 条),换会话 / 重启后
   * 仍勾在那一条上。**仍不是用户数据**:不落库、不进 device-link payload,丢了只回落模型行。
   *
   * 读走 `useSessionFavoriteAnchor`(useSyncExternalStore)而不是本地 state:锚点的真相在 store,
   * 再挂一份组件态就要为「换会话 / 跨窗口写入 / 换账号分区」各补一条同步,那正是内存态时代
   * 的三个 effect。写走 `setSessionFavoriteAnchorMemory`,同步落盘。
   *
   * 草稿的同名锚点在 NewMakerDraftRoute(经 `selectedFavoriteUid` prop 传进来),两者不共用:
   * 草稿的锚点按 vendor 分槽、跟着草稿走,会话的锚点按 sessionId 分槽、跟着会话走。
   */
  const sessionFavoriteAnchor = useSessionFavoriteAnchor(sessionId ?? null);
  const setSessionFavoriteAnchor = useCallback(
    (next: SessionFavoriteAnchor | null): void => {
      // ★ 绑**发起这次选择时的** sessionId(闭包捕获的那一份),不是 currentSessionIdRef。
      // 跨引擎选中要等一整条切换事务,收尾时用户可能已经切走会话:读 ref 会把这条锚点记到
      // **新**会话头上(那条会话根本没选过这份收藏,面板会凭空打勾)。锚点描述的是「发起
      // 选择的那条会话选了哪一条收藏」,写回它永远正确;它是否**过期**由显示端的派生校验
      // (effectiveSelectedFavoriteUid 比 wire id / 来源 / 引擎)兜住,不需要靠写入时机去防。
      if (!sessionId) return;
      setSessionFavoriteAnchorMemory(sessionId, next);
    },
    [sessionId],
  );

  // 乐观切换解除:props(被控端 echo 回流的 mirror)追上目标三元组即交回 props;否则 5s 兜底解除
  // (被控端把 effort 降级等导致永不相等时,避免 selector 永久置灰)。
  useEffect(() => {
    if (!pendingRemoteSwitch) return;
    const settled =
      initialModel === pendingRemoteSwitch.model &&
      initialEffort === pendingRemoteSwitch.effort &&
      (initialProviderId ?? null) === pendingRemoteSwitch.providerId;
    if (settled) {
      setPendingRemoteSwitch(null);
      return;
    }
    const timer = setTimeout(() => setPendingRemoteSwitch(null), 5000);
    return () => clearTimeout(timer);
  }, [initialModel, initialEffort, initialProviderId, pendingRemoteSwitch]);

  const agentKind = vendorKeyToAgentKind(vendorKey);
  // device-link 远程会话:能力(模型 / fast / effort)从被控端读;本地会话 deviceLinkDeviceId undefined → 本地。
  const ccCaps = useAgentCapabilities('claude-code', deviceLinkDeviceId ?? undefined);
  const codexCaps = useAgentCapabilities('codex', deviceLinkDeviceId ?? undefined);
  const piCaps = useAgentCapabilities('pi', deviceLinkDeviceId ?? undefined);
  const activeAgentCapabilities =
    agentKind === 'codex'
      ? codexCaps.capabilities
      : agentKind === 'pi'
        ? piCaps.capabilities
        : ccCaps.capabilities;

  // session-agent-switch 入口门控。device-link 远程会话读**被控端**的值；除了基础
  // supportsSessionAgentSwitch，还必须有 v2 CAS 能力。同引擎 no-op 的安全收尾依赖 host
  // 返回修订号，只有基础位的旧 host 无法把自己的 clear push 与外部 ABA 关联，不能开放
  // 一个会随机吞掉模型重选的入口。本机会话恒可用——main 与 renderer 同版本，不能因
  // capabilities 还没加载完而闪掉入口。
  // SSH 远程(remoteHostId)是另一套引擎生命周期,继续不支持,由调用点单独排除。
  // Orca 会话(lead / worker)同样排除:被控端 handler 对带 orcaRole 的会话一律拒
  // UNSUPPORTED_CAPABILITY。角色未加载(undefined)也 fail-closed,避免冷启动短暂露出入口。
  const ccSupportsSessionAgentSwitch =
    ccCaps.capabilities?.supportsSessionAgentSwitch === true &&
    ccCaps.capabilities.supportsSessionAgentSwitchCas === true;
  const codexSupportsSessionAgentSwitch =
    codexCaps.capabilities?.supportsSessionAgentSwitch === true &&
    codexCaps.capabilities.supportsSessionAgentSwitchCas === true;
  // 此能力与原子 model-selection payload 同版发布。旧被控端会忽略 SET_MODEL 第 5 参，
  // 因此缺能力位时保留原来的 SET_MODEL → SET_EFFORT → SET_FAST 兼容链；同引擎
  // reselect 入口本就要求 CAS=true，不会退回这条非原子路径。
  const remoteAtomicModelSelectionSupported =
    ccCaps.capabilities?.supportsSessionAgentSwitchCas === true ||
    codexCaps.capabilities?.supportsSessionAgentSwitchCas === true;
  const sessionAgentSwitchSupported =
    sessionOrcaRole === null &&
    (!deviceLinkDeviceId || ccSupportsSessionAgentSwitch || codexSupportsSessionAgentSwitch);

  // 切换写入的串行链与写序号都按 session 存在**模块级**协调层(agentSwitchCoordinator),
  // 不放组件 ref:用户切走再切回时旧组件已卸载但 invoke 仍在飞,新组件若另起空队列 /
  // 归零序号,两个请求会重新并发、旧 ack 会被误判成新鲜。理由与取舍见该模块头注释。
  // 链路重连代际:deviceId 在断链重连期间保持不变,只靠它当依赖的话读回永远不会重试。
  // 断链期间发出的读回会失败(catch 吞掉),断链期间被控端 / 另一控制端改的意图其
  // sessions:patched 推送也收不到 —— 恢复连接后必须重读一次,否则 composer 会一直
  // 停在过期引擎上。非 connected → connected 的每次跃迁 +1,驱动下方 effect 重跑。
  const remoteConnStatus = useRemoteSessionConnection(deviceLinkDeviceId ?? undefined);
  const [remoteReconnectEpoch, setRemoteReconnectEpoch] = useState(0);
  const remoteWasConnectedRef = useRef(false);
  useEffect(() => {
    const connected = remoteConnStatus === 'connected';
    if (connected && !remoteWasConnectedRef.current) setRemoteReconnectEpoch((n) => n + 1);
    remoteWasConnectedRef.current = connected;
  }, [remoteConnStatus]);

  // 会话打开时读回 main 的权威 pending 意图。意图是 main 的内存态、不落库,
  // renderer 换窗口 / 重开视图 / LRU 驱逐后本地镜像为空,不读回就会出现「UI 显示旧引擎、
  // 下一条消息却按意图切换」的错位。device-link 会话直连稳定 deviceId;本地会话走
  // 本机 maker。SSH 是另一套引擎生命周期,继续排除。
  useEffect(() => {
    if (!sessionId || remoteHostId) return;
    let cancelled = false;
    const writeSeq = getAgentSwitchWriteSeq(sessionId);
    const intentRev = makerChatStore.getAgentSwitchIntentRev(sessionId);
    const switchApi = deviceLinkDeviceId
      ? makerApiForDevice(deviceLinkDeviceId)
      : makerApiFor(sessionId);
    void switchApi
      .getSessionAgentSwitchIntent(sessionId)
      .then((authoritativeIntent) => {
        const fresh = isAgentSwitchResponseFresh({
          // 会话在往返期间被切走 → 这次响应不属于当前视图,丢弃。
          cancelled: cancelled || !isSessionScopeCurrent(sessionId, currentSessionIdRef.current),
          writeSeqAtStart: writeSeq,
          writeSeqNow: getAgentSwitchWriteSeq(sessionId),
          intentRevAtStart: intentRev,
          intentRevNow: makerChatStore.getAgentSwitchIntentRev(sessionId),
        });
        if (!fresh) return;
        makerChatStore.mirrorAgentSwitchIntent(sessionId, authoritativeIntent);
      })
      .catch(() => {
        // 老被控端未收录该 channel(CHANNEL_NOT_ALLOWED)、断链或本地读取失败:保留已有镜像,
        // 不擦用户已登记的选择(入口本身已按 capabilities 隐藏)。
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, deviceLinkDeviceId, remoteHostId, remoteReconnectEpoch]);

  // cycle-permission-mode 快捷键 (默认 Shift+Tab) 的轮切候选 —— 与
  // PermissionSelector 用同一份 capabilities.permissionModes 列表, 键盘轮切
  // 与下拉菜单看到的顺序一致。vendorKey 未锁定时按 PermissionSelector 的
  // 默认取 cc。editorProps.handleKeyDown 是稳定闭包, 走 ref 取值。
  const permissionCycleOptions = useMemo(
    () => (settingsLocked ? [] : (activeAgentCapabilities?.permissionModes ?? [])),
    [activeAgentCapabilities, settingsLocked],
  );
  const permissionCycleOptionsRef = useRef(permissionCycleOptions);
  permissionCycleOptionsRef.current = permissionCycleOptions;
  const activePermissionModeRef = useRef(activePermissionMode);
  activePermissionModeRef.current = activePermissionMode;
  // handlePermissionModeChange 定义在 useEditor 之后, ref 桥接 (同 dispatchSendRef)。
  const handlePermissionModeChangeRef = useRef<(mode: PermissionMode) => void | Promise<void>>(
    () => {},
  );

  // 计划模式入口门控:agent capability(device-link 老被控端无此字段 → 隐藏)+ 父组件接线。
  const planModeSupported = activeAgentCapabilities?.planMode?.supported === true;
  const planModeEntry =
    !settingsLocked && planModeSupported && onPlanModeChange
      ? { enabled: planModeEnabled, onToggle: (next: boolean) => void onPlanModeChange(next) }
      : undefined;
  // 当前 activeModel 归属的 agent runtime —— 用于 send 预检里按 (model, agent) 查
  // 「有没有已连接来源」。vendorKey 锁定时直接信任;否则按 capabilities 反推
  // (按 availableModels 归类,不靠 id 前缀猜)。
  const currentModelAgentKind: AgentKind | null = useMemo(() => {
    if (agentKind) return agentKind;
    if ((ccCaps.capabilities?.availableModels ?? []).some((m) => m.id === activeModel)) {
      return 'claude-code';
    }
    if ((codexCaps.capabilities?.availableModels ?? []).some((m) => m.id === activeModel)) {
      return 'codex';
    }
    if ((piCaps.capabilities?.availableModels ?? []).some((m) => m.id === activeModel)) {
      return 'pi';
    }
    return null;
  }, [activeModel, agentKind, ccCaps.capabilities, codexCaps.capabilities, piCaps.capabilities]);
  // 供应商连接态。effectiveSourceId / sendProviderId / dispatchSend 预检用它。device-link 远程会话 /
  // 草稿用**被控端**供应商目录(隧道),否则用本机(两 hook 都无条件调用,按 deviceLinkDeviceId 取)。
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceLinkDeviceId ?? undefined);
  const providers = deviceLinkDeviceId ? remoteProviders.providers : localProviders.providers;
  const sendProviders = filterChatBridgedCodexProviders(
    providers,
    currentModelAgentKind ?? 'codex',
    !!remoteHostId,
  );

  // 空態(设计 Q7NYAD「ChatInput 空态 · 模型选择器」):当前模型一个已连接来源都没有 →
  // 模型选择器 trigger 化成「连接来源」CTA、Send 禁用。useConnectedSource 仅用于
  // loading 态判定；实际「有没有可发送来源」独立走 sendProviders（已过滤 SSH remote
  // 排除项），两者职责分离以保留 remote guard。
  // 本机沿用 useConnectedSource 的加载态；device-link 必须同时等待被控端 capabilities 与
  // provider 目录，且真实读取失败时 fail closed。只有结构化 unsupported 才允许旧端回退。
  const { loading: localProvidersLoading } = useConnectedSource(currentModelAgentKind, activeModel);
  const remoteModelListStatus = resolveRemoteModelListStatus({
    deviceId: deviceLinkDeviceId ?? undefined,
    agentKind: currentModelAgentKind,
    cc: ccCaps,
    codex: codexCaps,
    pi: piCaps,
    providers: remoteProviders,
  });
  const providersLoading = deviceLinkDeviceId
    ? remoteModelListStatus === 'loading'
    : localProvidersLoading;
  // 统一模型选择器(model-selector-unified M5 / M6)在 composer 上的开关 —— **能力级**那一半
  // (下面还要叠形态偏好才是真正启用,见 unifiedPanelCapable / unifiedPanelActive;
  // NewMakerDraftRoute 的 unifiedModelPanelEnabled / unifiedModelPanelActive 与这两级逐字对应)。
  //
  // 这一级唯一的降级条件是**没有供应商目录可用**:联合列表(unifiedModelEntries)只认目录里的
  // (provider, agent) 条目,而老被控端不支持 provider:list 时控制端只有一份拍平的
  // capabilities —— 那种情况下开了统一面板就是一张空列表(见 ModelSelector.unifiedPanel
  // 的「已知边界」)。unsupported 是**结构化**判定(isDeviceProvidersUnsupportedError),
  // 不是 providers.length===0:后者在首帧加载中恒成立,拿它当条件会让面板每次打开先闪
  // 一下旧版布局。
  const unifiedModelPanelEnabled = !deviceLinkDeviceId || !remoteProviders.unsupported;
  // 联合列表参与哪些引擎 —— 以**运行时注册结果**为准(device-link 取被控端的)。
  // 撤掉新会话工具条的 AgentSelect 后,它的 hiddenVendors 门禁就落到这里:Pi 二进制缺失
  // 时模型目录照样投影 Pi 模型,只看目录会让用户一路选到 requireAgent 的 not-registered。
  // 未加载完成 → 传 undefined(fail-open,不隐藏任何引擎);当前引擎恒在列。
  const { availableVendors: runtimeAvailableVendors, loaded: runtimeAgentsLoaded } =
    useAvailableAgents(deviceLinkDeviceId);
  const unifiedAgents = useMemo<readonly AgentKind[] | undefined>(() => {
    if (!runtimeAgentsLoaded) return undefined;
    const kinds = UNIFIED_AGENT_KINDS.filter(
      (kind) => kind === agentKind || runtimeAvailableVendors.has(agentKindToVendor(kind)),
    );
    return kinds.length > 0 ? kinds : undefined;
  }, [runtimeAgentsLoaded, runtimeAvailableVendors, agentKind]);
  // 已有 device-link 任务在断链时仍有 pinned deviceId + renderer outbox 可接住发送，
  // 不能因为被控端 provider 目录暂时拉不到就禁用 composer。远程草稿没有既有 session
  // 可以排队，仍与本地任务一样保留来源门禁。
  const enforceConnectedSourceGate = !sessionId || !deviceLinkDeviceId;
  const remoteModelListBlocked =
    !!deviceLinkDeviceId && enforceConnectedSourceGate && remoteModelListStatus !== 'ready';
  // chatEligibleSourcesForModel(不是裸 sourcesForModel):非聊天模型即便"存在于某个
  // 已连接来源"也不算有可发送来源(issue #882 第 3 点,2026-07 review)——否则 Send
  // 会对着一个 image/embedding 端点放行,而不是显示这里的"去连接"空态。已建会话
  // (sessionId 在)按实际路由口径判(includeDisabled):运行中的会话不因停用打断,
  // 请求仍走原路由,把停用当「无来源」会误禁 Send(PR #744 review 第十轮)。草稿是
  // 新路由选择,保持准入口径(停用拷贝不算可发送来源)。
  const hasConnectedSendSource = currentModelAgentKind
    ? chatEligibleSourcesForModel(sendProviders, activeModel, currentModelAgentKind, {
        onlyConnected: true,
        includeDisabled: !!sessionId,
      }).length > 0
    : false;
  const noConnectedSource =
    enforceConnectedSourceGate &&
    !!currentModelAgentKind &&
    !providersLoading &&
    !remoteModelListBlocked &&
    // 老被控端明确不支持 provider:list 时只能依据 capabilities 放行；不能把缺少
    // provider 镜像误判成权威的「没有已连接来源」。
    (!deviceLinkDeviceId || !remoteProviders.unsupported) &&
    !hasConnectedSendSource;

  // 会话显式选中的来源已断开(如外部删除订阅 OAuth 凭证):trigger 显示「已断开」错误态 +
  // Send 禁用,不再静默回退默认来源图标(否则界面显示 XD、main 懒创建却按 DB 里的来源报
  // no_oauth,用户无法自查)。仅本地已建会话适用 ——
  //   · 草稿(无 sessionId):sendProviderId 会 null 化 → 建会话回落默认路由,回落图标即真实,不判断开;
  //   · device-link 远程会话:连接态在被控端,控制端不判。
  // providersLoading 期间不判(规则同 noConnectedSource,避免首帧闪断开态)。
  const selectedSourceDisconnected =
    !!sessionId &&
    !deviceLinkDeviceId &&
    isSelectedSourceDisconnected({
      providers,
      agent: currentModelAgentKind,
      modelId: activeModel,
      selectedProviderId: activeProviderId,
      providersLoading,
    });

  // 当前**生效来源 id**(= ModelSelector 高亮的 activeSourceId 同口径):显式选中且仍可连、
  // 且提供当前模型 → 用它;否则只在“提供当前模型”的来源里取原生默认。providerModelMemory
  // 按 (agent, 来源) 分槽记 (model, effort),写入 / 恢复都以这个 id 为 key,保证对称。
  const effectiveSourceId = useMemo<string | null>(() => {
    const kind = currentModelAgentKind;
    if (!kind) return null;
    return effectiveSourceIdForModel(providers, activeProviderId, activeModel, kind);
  }, [providers, currentModelAgentKind, activeProviderId, activeModel]);

  // 发送(草稿态建会话)时携带的**显式来源**:仅当本地选择仍在已连接来源栏内才带上
  // (与 effectiveSourceId 的高亮口径一致,即"所见即所得");否则带 null。
  // 关键:这里**绝不**把"跟随默认"具体化成原生默认 id(如 'xd')——默认 cohort 必须保持
  //   providerId=null,路由才回落 spawn-aware 默认(字节级不变,no-break);写成显式 'xd'
  //   会改走 catalog gateway-key 路由(见 provider-route.ts),破坏默认 cohort 的路由/缓存基线。
  const sendProviderId = useMemo<string | null>(() => {
    const kind = currentModelAgentKind;
    if (!kind || !activeProviderId) return null;
    return effectiveSourceIdForModel(sendProviders, activeProviderId, activeModel, kind) ===
      activeProviderId
      ? activeProviderId
      : null;
  }, [sendProviders, currentModelAgentKind, activeProviderId, activeModel]);

  // 模型预设采用「全局默认 + 已创建会话保护」:
  //   - 本地草稿 / 已创建会话的**非选中行**都读写 providerModelMemory,所以同一
  //     (agent, model) 的 effort/fast 会跨对话、跨来源即时同步。
  //   - 已创建会话的当前选中行由 ModelSelector 读取 live props(DB / runtime),不会被其它对话改写;
  //     该会话切走后再切回此模型,才会采用最新全局预设。
  //   - 首页草稿无 live 会话,NewMakerDraftRoute 会把当前显示模型的 props 也从全局预设派生。
  //   - device-link 必须使用被控端镜像 override;旧被控端拿不到镜像时宁可无记忆,也不掺控制端本机。
  useProviderModelMemoryVersion();
  const modelMemory = useMemo<ModelMemoryAccessors | undefined>(() => {
    // device-link 远程草稿 / 会话:用纯显示镜像 override(读被控端全局预设、写穿被控端)。
    if (modelMemoryOverride) return modelMemoryOverride;
    if (deviceLinkDeviceId) return undefined;
    return {
      getEffort: getProviderModelEffort,
      setEffort: setProviderModelEffort,
      setChoice: setProviderModelChoice,
      getFast: getProviderModelFast,
      setFast: setProviderModelFast,
      getThinking: getProviderModelThinking,
      setThinking: setProviderModelThinking,
      // 「恢复推荐」= 删记忆键(跟随目录新默认),不是把这一版的默认快照写回去。
      // device-link 镜像没有这两个入口(隧道协议没有删除那一笔),按各自能力退化。
      clearEffort: clearProviderModelEffort,
      clearFast: clearProviderModelFast,
    };
  }, [deviceLinkDeviceId, modelMemoryOverride]);

  // 把「用户在当前来源下选定的 (model, effort)」记进模型全局预设,供其它非活跃行和之后的
  // 模型切换恢复。agent / 来源缺失(未知模型 / 0 已连接来源)/ device-link 无镜像时静默跳过。
  const rememberProviderChoice = useCallback(
    (modelId: string, eff: Effort) => {
      const kind = currentModelAgentKind;
      if (kind && effectiveSourceId && modelId) {
        if (modelMemory?.setChoice) {
          modelMemory.setChoice(kind, effectiveSourceId, modelId, eff);
        } else if (!deviceLinkDeviceId) {
          setProviderModelChoice(kind, effectiveSourceId, modelId, eff);
        }
      }
    },
    [currentModelAgentKind, effectiveSourceId, modelMemory, deviceLinkDeviceId],
  );

  const folderOpen = folderPickerOpen ?? internalFolderOpen;
  const setFolderOpen = onFolderPickerOpenChange ?? setInternalFolderOpen;
  // `dispatchSend` 在取发送快照后可能等待 effort runtime 同步。此窗口内继续编辑会让
  // 成功发送后的清理误删尚未发送的文字或附件，因此 composer 必须作为一个整体短暂只读。
  // 正常路径没有等待；只有设置同步中的会话最多锁 5 秒（见 dispatchSend 的 preflight）。
  const [sendDispatchInFlight, setSendDispatchInFlight] = useState(false);
  const composerEditorLocked = disabled || sendDispatchInFlight;
  const composerMutationLockedRef = useRef(composerEditorLocked);
  composerMutationLockedRef.current = composerEditorLocked;

  useEffect(() => {
    setWorkingDir(initialWorkingDir ?? null);
  }, [initialWorkingDir]);

  // ── Tiptap editor ──────────────────────────────────────────────────
  // The composer remains intentionally small: it has paragraphs, hard breaks,
  // atomic chips, and only the list nodes needed to preserve Markdown list
  // structure while editing. It does not use StarterKit, whose headings and
  // marks are not part of the chat input contract.
  const [, setTick] = useState(0);
  const refreshComposerRef = useRef<(() => void) | null>(null);
  refreshComposerRef.current = () => setTick((t) => t + 1);
  const renderSnapshotRef = useRef<ComposerRenderSnapshot | null>(null);
  const draftSaveSchedulerRef = useRef<ReturnType<typeof createComposerDraftSaveScheduler> | null>(
    null,
  );
  draftSaveSchedulerRef.current ??= createComposerDraftSaveScheduler();
  const caretScrollEditorRef = useRef<Editor | null>(null);
  const caretScrollSchedulerRef = useRef<ReturnType<typeof createComposerFrameScheduler> | null>(
    null,
  );
  caretScrollSchedulerRef.current ??= createComposerFrameScheduler(() => {
    const current = caretScrollEditorRef.current;
    if (current) scrollCaretIntoView(current);
  });
  const scheduleCaretScroll = (ed: Editor): void => {
    caretScrollEditorRef.current = ed;
    caretScrollSchedulerRef.current?.schedule();
  };
  useEffect(
    () => () => {
      caretScrollSchedulerRef.current?.cancel();
    },
    [],
  );
  const editor = useEditor({
    // React receives only the narrow snapshots above; Tiptap keeps ordinary
    // transactions inside its editor view instead of rerendering ChatInput.
    shouldRerenderOnTransaction: false,
    // Match the legacy textarea's `autoFocus` prop — on mount, focus the
    // editor at the end so the user can continue typing after restored text.
    // Tiptap treats boolean `true` as `focus('start')`; its deferred mount
    // autofocus would otherwise overwrite routed Plugin/Create end-focus.
    // doc 模式下必须关掉,理由见上方 disableAutofocus prop 注释。
    autofocus: !disableAutofocus && !disabled ? 'end' : false,
    editable: !composerEditorLocked,
    extensions: [
      Document,
      Paragraph,
      Text,
      ComposerListItem,
      ComposerBulletList,
      ComposerOrderedList,
      ComposerHardBreak,
      History,
      Placeholder.configure({
        placeholder: resolvedPlaceholder,
        // Only show placeholder when the editor is truly empty — Tiptap's
        // default is to show it on every empty paragraph, which feels wrong
        // when the user adds newlines.
        showOnlyWhenEditable: true,
        showOnlyCurrent: false,
      }),
      MentionChipNode,
      ComposerQuoteNode,
      PastedTextChipNode,
      WindowsSelectionReplacement.configure({
        enabled: window.electronAPI.platform === 'win32',
      }),
      // 空输入框全选 / 全选后删空都会在行首留一块幽灵高亮(空 paragraph 被整体框进
      // AllSelection,删空后 Chromium 的 DOM selection 也不跟着折叠)。见模块头注释。
      EmptyDocSelectionGuard,
      CjkPunctDecoration,
      ComposerListIndentDecoration,
      VoiceInputDraftDecoration,
      MentionDragCaretDecoration,
      GhostCommandDecoration,
      SlashCommandDecoration,
      QuickStartPillMark,
    ],
    editorProps: {
      clipboardTextSerializer: (slice) => serializeEditorSlice(editorRef.current, slice),
      attributes: {
        class: cn(
          // py + 负 my:.ProseMirror 自身是 overflow 裁剪容器,inline 装饰
          // (ghost-cmd-pill 的 padding/border)会超出 22px 行盒 1~3px,padding
          // 把裁剪边界外扩 3px 兜住绘制,负 margin 抵消占位——文字位置与输入框
          // 高度零变化(同右侧 -mr/pr 破出惯例)。max-h 同步 +6 保持可视行数不变。
          'w-full min-h-[22px] max-h-[186px] overflow-y-auto py-[3px] -my-[3px] pr-[11px]',
          // tabular-nums:等宽数字。系统字体默认数字是比例宽度("1" 比 "2" 窄),
          // 多行列表 "1. / 2. / 3." 的点和正文会逐行漂移;等宽数字让前缀宽度
          // 一致、列表自然对齐。ComposerListIndentDecoration 会额外为整条列表
          // 行保留换行后的视觉缩进。
          'text-15 leading-[1.467] font-normal tabular-nums',
          'text-[var(--chat-input-text)]',
          'focus:outline-none',
          // Tailwind can't target ProseMirror placeholder pseudo — handled
          // below in globals.css via `.ProseMirror p.is-editor-empty:first-child::before`
          // (placeholder extension relies on that CSS hook).
        ),
      },
      handleDOMEvents: {
        dragstart: (_view, event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return false;
          if (
            !target.closest('[data-mention-chip], [data-pasted-text-chip], [data-composer-quote]')
          ) {
            return false;
          }
          internalMentionDragActiveRef.current = true;
          return false;
        },
        dragend: () => {
          internalMentionDragActiveRef.current = false;
          setMentionDragCaret(editorRef.current, null);
          return false;
        },
        compositionend: (view) => {
          // The final IME commit can bypass input rules. Wait until
          // ProseMirror releases its native composition DOM, then promote a
          // trailing Markdown list row if one was committed as plain text.
          setTimeout(() => {
            if (view.isDestroyed || view.composing) return;
            promoteTrailingPlainListParagraph(view);
          }, 0);
          return false;
        },
      },
      handleClickOn(_view, _pos, node, nodePos, _event, direct) {
        // 长文本粘贴 chip:点击打开 ToolPayloadLightbox 的可编辑 text 模式。
        // 仅 direct 命中(点在节点本体上)才消费,避免吞掉普通文本点击。
        if (direct && node.type.name === 'pastedTextChip') {
          setPastedTextEditTarget({
            nodePos,
            originalText: (node.attrs as PastedTextChipAttrs).text,
          });
          return true;
        }
        return false;
      },
      handlePaste(view, event) {
        if (composerMutationLockedRef.current) return true;
        // Intercept clipboard file/folder/image. Three sources to handle,
        // matching the onDrop logic below:
        //   1. Folder copied from OS file manager  → addFolderPath (@dir chip)
        //   2. File(s) copied from OS file manager → addFiles (real path via
        //      getPathForFile; no base64 read in renderer)
        //   3. Bitmap on clipboard with no backing file (screenshot, web
        //      "Copy image") → addClipboardImage
        const items = event.clipboardData?.items;
        if (items && items.length > 0) {
          const filesWithPath: File[] = [];
          let handledAny = false;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind !== 'file') continue;
            const file = item.getAsFile();
            if (!file) continue;
            const entry = item.webkitGetAsEntry?.();
            if (entry?.isDirectory) {
              let folderPath = '';
              try {
                folderPath = window.electronAPI.getFilePath(file);
              } catch {
                /* ignore */
              }
              if (folderPath) {
                addFolderPathRef.current(folderPath);
                handledAny = true;
              }
              continue;
            }
            // Try to resolve a real OS path. Files copied from Explorer/Finder
            // expose one; in-memory bitmaps (screenshots) do not.
            let realPath = '';
            try {
              realPath = window.electronAPI.getFilePath(file);
            } catch {
              /* ignore */
            }
            if (realPath) {
              filesWithPath.push(file);
              handledAny = true;
            } else if (item.type.startsWith('image/')) {
              addClipboardImageRef.current(file);
              handledAny = true;
            }
          }
          if (filesWithPath.length > 0) addFilesRef.current(filesWithPath);
          if (handledAny) {
            // Prevent default so the file/image doesn't insert as inline
            // content — we handle it as an attachment instead. Text content
            // in the same paste event is intentionally discarded; mixed
            // clipboard (file + text) is rare.
            return true;
          }
        }
        // ── 文本粘贴变换管线(pastePipeline.ts,命中即停)──
        // 放在 html 分支之前:从消息 / 飞书等复制的内容常同时带 text/html
        // payload,同样要走管线。
        const text = event.clipboardData?.getData('text/plain');
        const html = event.clipboardData?.getData('text/html');

        // 0. 自家 chip 的剪贴板回环:HTML 带本编辑器的 chip 标记(复制 / 剪切
        //    含 @chip / 粘贴文本 chip 的选区)时,整个粘贴交回 ProseMirror 默认
        //    HTML 解析原样还原——atom chip 在 text/plain 里没有文本投影,下面
        //    任何基于 text/plain 的分支都会把 chip payload 丢掉(review P2)。
        if (html && htmlCarriesOwnChipMarkup(html)) return false;

        // 1. 长文本 → 折叠为 PastedTextChip(点击预览,发送时原文内联)。
        if (text && isLongPasteText(text)) {
          event.preventDefault();
          const display = tRef.current('newChat.pastedText.chipLabel', {
            lines: countPasteLines(text),
          });
          const node = view.state.schema.nodes.pastedTextChip.create({ text, display });
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
          return true;
        }

        // 2. 深链 / 路径混排 → text / session / project / path 分段:
        //    session、project 即时成 chip(session 裸链接先短 ID 占位,标题
        //    异步原地补齐——sessionLinkPaste.ts);path 段先落纯文本,stat
        //    确认存在后原地升级为 @chip(pathPaste.ts)。
        const segments = text
          ? segmentPastedContent(text, { workingDir: workingDirRef.current })
          : null;
        // Plain Markdown pasted into the final empty row should enter the same
        // structured document model as a typed list marker. Paste does not run
        // Tiptap input rules, so normalize it explicitly at this boundary.
        if (text && !segments) {
          const normalizedPaste = plainTextToComposerDocument(text);
          const { state } = view;
          const { $from } = state.selection;
          const pasteIntoTrailingEmptyLine = isTrailingEmptyTopLevelParagraph(view);
          const pasteIntoBlockSelection = isTopLevelBlockSelection(view);

          if (
            composerDocumentContainsList(normalizedPaste) &&
            (pasteIntoTrailingEmptyLine || pasteIntoBlockSelection)
          ) {
            event.preventDefault();
            const paragraphPosition = $from.before(1);
            const replacement = (normalizedPaste.content ?? []).map((node) =>
              state.schema.nodeFromJSON(node),
            );
            if (pasteIntoTrailingEmptyLine && $from.parent.content.size > 0) {
              replacement.unshift(state.schema.nodes.paragraph.create());
            }
            const fragment = Fragment.from(replacement);
            const tr = pasteIntoTrailingEmptyLine
              ? state.tr.replaceWith(
                  paragraphPosition,
                  paragraphPosition + $from.parent.nodeSize,
                  fragment,
                )
              : state.tr.replaceSelection(new Slice(fragment, 0, 0));
            if (pasteIntoTrailingEmptyLine) tr.setSelection(TextSelection.atEnd(tr.doc));
            view.dispatch(tr.scrollIntoView());
            return true;
          }
        }
        if (segments) {
          event.preventDefault();
          const { state } = view;
          // 相邻 text/path 段先合并进 buf(path 以原文落地),flush 时按 `\n`
          // 拆成 text + hardBreak 节点:编辑器用 hardBreak 表达可见换行,裸
          // `\n` 塞进 text 节点会在输入框里塌缩成空白(PR #970 review P2);
          // serializeEditorContent 已把 hardBreak 还原为 `\n`,发送内容不变。
          const nodes: Array<ReturnType<typeof state.schema.text>> = [];
          let textBuf = '';
          const flushText = () => {
            if (!textBuf) return;
            textBuf.split('\n').forEach((part, i) => {
              if (i > 0) nodes.push(state.schema.nodes.hardBreak.create());
              if (part) nodes.push(state.schema.text(part));
            });
            textBuf = '';
          };
          // path 段记录「插入后文档中的区间」交给 pathPaste 做 stat 后升级——
          // 只动本次粘贴落地的那一段,不做全文档扫描(review P1)。偏移即
          // 字符偏移:text 按长度累计,`\n` 会变 hardBreak 但 nodeSize 同为 1,
          // mentionChip 原子节点 nodeSize 为 1;replaceSelection 把内容落在
          // selection.from 起。
          const insertFrom = state.selection.from;
          let offset = 0;
          const pathRanges: PendingPathRange[] = [];
          for (const seg of segments) {
            if (seg.kind === 'text') {
              textBuf += seg.text;
              offset += seg.text.length;
            } else if (seg.kind === 'path') {
              pathRanges.push({
                absPath: seg.path,
                from: insertFrom + offset,
                to: insertFrom + offset + seg.path.length,
              });
              textBuf += seg.path;
              offset += seg.path.length;
            } else {
              flushText();
              nodes.push(
                state.schema.nodes.mentionChip.create(
                  seg.kind === 'session'
                    ? pastedSessionChipAttrs(seg)
                    : pastedProjectChipAttrs(seg),
                ),
              );
              offset += 1;
            }
          }
          flushText();
          suppressListNormalizationRef.current = true;
          try {
            view.dispatch(
              state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView(),
            );
          } finally {
            suppressListNormalizationRef.current = false;
          }
          const ed = editorRef.current;
          if (ed) {
            resolveSessionChipTitles(ed);
            const wd = workingDirRef.current;
            if (pathRanges.length > 0 && wd) {
              upgradePastedPathsToChips(ed, pathRanges, wd, {
                remoteHostId: remoteHostIdRef.current,
                deviceLinkDeviceId: deviceLinkDeviceIdRef.current,
              });
            }
          }
          return true;
        }
        // When clipboard carries both HTML and plain text (common when
        // copying links from Feishu / Slack / Notion / Claude Code), the
        // HTML payload looks like <a href="...">Page Title</a>. Default
        // ProseMirror parsing strips the <a> tag (no Link mark installed)
        // and keeps only the visible text — turning the URL into a title.
        // Force plain text in this case so the raw URL is preserved.
        // (自家 chip 标记的 HTML 已在管线第 0 步交回 ProseMirror,不会走到这。)
        if (html && text) {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(text));
          return true;
        }
        return false;
      },
      handleDrop(_view, event) {
        // Session-link drops are inserted by the outer composer drop handler.
        // Consume the event here first so ProseMirror does not also insert the
        // drag source's `text/plain` fallback (the raw session id).
        if (event.dataTransfer?.getData(SESSION_LINK_DROP_MIME).trim()) {
          event.preventDefault();
          return true;
        }
        const payload = decodeComposerMentionPayload(
          event.dataTransfer?.getData(COMPOSER_MENTION_MIME) ?? '',
        );
        internalMentionDragActiveRef.current = false;
        setMentionDragCaret(editorRef.current, null);
        if (!payload) return false;
        event.preventDefault();
        return true;
      },
      handleKeyDown(view, event) {
        // Delegate panel navigation keys (↑ ↓ Enter Esc Tab) when a
        // palette is open. We can't read React state from here directly,
        // but we expose a ref-based escape hatch via `panelBridgeRef`.
        const bridge = panelBridgeRef.current;
        if (bridge?.captureKey(event)) {
          event.preventDefault();
          return true;
        }

        // Tab — 填入推荐提示词(编辑器为空 + 推荐激活 + 无修饰键)。
        // 放在 captureKey 之后:palette 打开时 Tab 归 palette。
        // 放在 cycle-permission-mode 之前:裸 Tab 不会误触 Shift+Tab 权限轮切。
        if (
          event.key === 'Tab' &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.repeat &&
          !event.isComposing &&
          showRecommendationRef.current &&
          recommendedPromptRef.current &&
          !composerMutationLockedRef.current
        ) {
          if (composerFullyEmptyRef.current()) {
            event.preventDefault();
            // 先撤推荐(overlay 与正文同位置,不先撤会有一帧重叠),再插入文本。
            showRecommendationRef.current = false;
            setRecommendedPrompt(null);
            view.dispatch(view.state.tr.insertText(recommendedPromptRef.current));
            return true;
          }
        }

        // cycle-permission-mode (registry 默认 Shift+Tab, 用户可改绑) —— 输入框
        // 聚焦时轮切会话权限模式。放在 captureKey 之后: palette 打开时 Tab 归
        // palette。IME composition / repeat 跳过; 可用模式不足 2 个时不消费,
        // Shift+Tab 保持原生反向焦点导航。
        if (
          !event.repeat &&
          !event.isComposing &&
          getAppShortcutCombos('cycle-permission-mode').some((c) => matchesKeyboardEvent(event, c))
        ) {
          if (disabledRef.current) return false;
          const next = getNextPermissionMode(
            activePermissionModeRef.current,
            permissionCycleOptionsRef.current,
          );
          if (!next) return false;
          event.preventDefault();
          void handlePermissionModeChangeRef.current(next);
          return true;
        }

        // ESC — back out of the topmost thing the user is interacting with.
        if (event.key === 'Escape') {
          // F-QUEUE-DEFER: if the queue tail is expanded, Esc collapses that
          // visual tail before falling through to Stop.
          if (queueExpandedRef.current && onQueueExpandedChangeRef.current) {
            event.preventDefault();
            onQueueExpandedChangeRef.current(false);
            return true;
          }
          // Existing behaviour: abort running task (same as clicking Stop).
          // If queued messages exist, useCCAgentChat.stopSession pauses them
          // instead of sending the next one immediately.
          if (showStopButtonRef.current && onStopRef.current) {
            event.preventDefault();
            wasTurnStoppedByUserRef.current = true;
            onStopRef.current();
            return true;
          }
          return false;
        }

        // A history undo intentionally restores the marker as plain text. Keep
        // the queued live promotion from immediately converting it again.
        if (
          event.key.toLowerCase() === 'z' &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          suppressListNormalizationRef.current = true;
          queueMicrotask(() => {
            suppressListNormalizationRef.current = false;
          });
        }

        // ↑ / ↓ — browse user message history when editor is empty
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const history = userHistoryRef.current;
          if (history.length === 0) return false;

          const editorInstance = view.state.doc;
          const idx = historyIndexRef.current;
          // atom chip 无文本投影,textContent 判空会把只含 chip 的草稿误当
          // 空:进入历史浏览的 replaceWith 会整段覆盖、粘贴 payload 静默
          // 丢失(review P2)。唯一例外是我们刚从 history 恢复且仍逐节点相等
          // 的文档——quoted history 本来就含 quote atom,必须允许继续 ↑/↓;
          // 浏览中途新增/修改任意 chip 后 eq 失配,仍不介入。
          const isUnmodifiedHydratedHistory =
            idx >= 0 && hydratedHistoryDocumentRef.current?.eq(editorInstance) === true;
          if (!isUnmodifiedHydratedHistory && !composerDocIsEmpty(editorInstance)) return false;
          const isEmpty = composerDocIsEmpty(editorInstance);
          const replaceWithHistoryEntry = (entry: ComposerHistoryEntry) => {
            const historyDocument = view.state.schema.nodeFromJSON(
              composerHistoryEntryToDocument(entry),
            );
            const tr = view.state.tr.replaceWith(
              0,
              view.state.doc.content.size,
              historyDocument.content,
            );
            view.dispatch(tr);
            hydratedHistoryDocumentRef.current = tr.doc;
          };

          if (event.key === 'ArrowUp') {
            // Only enter history browsing when the editor is empty or already browsing
            if (idx === -1 && !isEmpty) return false;
            if (idx === -1) {
              // Save current draft before browsing (full doc JSON preserves marks)
              draftRef.current = view.state.doc.toJSON();
            }
            const next = Math.min(idx + 1, history.length - 1);
            if (next === idx) return false; // already at oldest
            historyIndexRef.current = next;
            replaceWithHistoryEntry(history[next]);
            event.preventDefault();
            return true;
          }

          if (event.key === 'ArrowDown' && idx >= 0) {
            const next = idx - 1;
            historyIndexRef.current = next;
            const tr = view.state.tr;
            if (next === -1) {
              // Restore draft from saved doc JSON (preserves marks like quickStartPill)
              const draft = draftRef.current;
              if (draft) {
                const draftDocument = view.state.schema.nodeFromJSON(draft);
                tr.replaceWith(0, view.state.doc.content.size, draftDocument.content);
              } else {
                tr.delete(0, view.state.doc.content.size);
              }
              view.dispatch(tr);
              hydratedHistoryDocumentRef.current = null;
              draftRef.current = null;
            } else {
              replaceWithHistoryEntry(history[next]);
            }
            event.preventDefault();
            return true;
          }
        }

        // Backspace — structured list items exit through the schema command;
        // legacy plain Markdown rows keep the prefix-deletion fallback so
        // pasted and restored text remains editable without a migration pass.
        // 意识指令胶囊排最后:只在胶囊亮起且光标停在胶囊外(尾随空格之后)才
        // 接管,胶囊内一律原样落回原生逐字删。
        if (
          event.key === 'Backspace' &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          !event.isComposing &&
          (handleStructuredListBackspace(view) ||
            applyListBackspace(view) ||
            applyGhostCommandBackspace(view))
        ) {
          event.preventDefault();
          return true;
        }

        // Shift/Alt+Enter — split or exit a structured item. The plain-text
        // fallback remains for old drafts and pasted Markdown that has not
        // gone through an input rule.
        if (
          event.key === 'Enter' &&
          (event.shiftKey || event.altKey) &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          if (handleStructuredListBreak(view) || applyListContinuation(view)) {
            event.preventDefault();
            return true;
          }
          return false;
        }

        // Resolve the configurable send shortcut after structured list handling.
        // Native mode keeps Enter available to Tiptap for paragraph breaks and
        // IME composition; queue/steer modes continue through the existing
        // send and voice state machines.
        const enterIntent = resolveComposerEnterIntent(event, getComposerSendShortcutPreference(), {
          turnRunning: showStopButtonRef.current,
          platform: window.electronAPI?.platform,
        });
        if (enterIntent === 'native') return false;
        if (enterIntent === 'ignore') {
          event.preventDefault();
          return true;
        }
        if (enterIntent === null) return false;

        event.preventDefault();
        if (enterIntent === 'queue' || enterIntent === 'steer') {
          const isEditorEnterTarget =
            event.target instanceof Node && view.dom.contains(event.target);
          if (
            voiceInputStateRef.current === 'listening' &&
            voiceInputCanStopAndSendRef.current &&
            isEditorEnterTarget &&
            !isVoiceInputShortcutMatch(event, voiceShortcutRef.current)
          ) {
            event.stopPropagation();
            void voiceInputStopAndSendRef.current(enterIntent);
            return true;
          }
          void dispatchSendRef.current(enterIntent);
          return true;
        }
        return false;
      },
    },
    // Tick state on every update so triggerState below recomputes.
    onUpdate: ({ editor: ed, transaction }) => {
      const syntheticRangeEnd = syntheticAtRangeEndRef.current;
      if (syntheticRangeEnd !== null && transaction.docChanged) {
        syntheticAtRangeEndRef.current = transaction.mapping.map(syntheticRangeEnd, 1);
      }
      // 编辑器一旦非空就彻底撤掉推荐(不只是隐藏)。留着 state 的话,发送后正文被
      // 清空的那一帧 overlay 会重新出现 —— 那就是提交后闪一下推荐词的来源。
      if (!composerDocIsEmpty(ed.state.doc) && recommendedPromptRef.current) {
        showRecommendationRef.current = false;
        setRecommendedPrompt(null);
      }
      if (
        !suppressListNormalizationRef.current &&
        !ed.view.composing &&
        !listPromotionQueuedRef.current &&
        hasTrailingPlainListParagraph(ed.view)
      ) {
        listPromotionQueuedRef.current = true;
        queueMicrotask(() => {
          listPromotionQueuedRef.current = false;
          if (!ed.isDestroyed && !suppressListNormalizationRef.current && !ed.view.composing) {
            promoteTrailingPlainListParagraph(ed.view);
          }
        });
      }
      const nextRenderSnapshot = composerRenderSnapshot(
        composerTriggerSnapshotOf(ed),
        !composerDocIsEmpty(ed.state.doc),
      );
      if (shouldRefreshComposerRender(renderSnapshotRef.current, nextRenderSnapshot)) {
        renderSnapshotRef.current = nextRenderSnapshot;
        refreshComposerRef.current?.();
      }
      if (!composerMentionDragActiveRef.current) {
        lastComposerSelectionFromRef.current = ed.state.selection.from;
      }
      // composer-draft-per-session: persist the current Tiptap JSON for
      // this session so switching away/back restores it. Skip while we're
      // restoring (setContent fires onUpdate too — would otherwise race /
      // recurse on rapid switches).
      if (isRestoringRef.current) {
        // 即便是 restore，也要补一次滚动——切换 session 后光标常落在末尾
        scheduleCaretScroll(ed);
        return;
      }
      // composer-draft-mount-race 修复 (issue #40):hydration 还没跑过 → 这次
      // onUpdate 是 Tiptap mount 期间的初始触发(空 editor),不能写 store。
      if (!hasHydratedRef.current) {
        scheduleCaretScroll(ed);
        return;
      }
      const sk = storageKeyForDraftRef.current;
      if (!sk) {
        scheduleCaretScroll(ed);
        return;
      }
      const dataOwnerAtSchedule = editorDataOwnerRef.current;
      // silent: 自己写自己——不通知 subscribeComposerDraft 监听器，避免回灌
      // setContent 把光标位置/IME 组合状态打乱。把 JSON 序列化和写入都放进短
      // debounce,生命周期边界由 flush 强制落最后一版。
      //
      // voice-input session-switch 草稿串味修复:`ed.getJSON()` 故意延后到
      // debounce 触发那一刻才读(保住上面这条 perf 优化——不在每次按键都同步
      // 序列化整份文档)。但 storageKeyForDraftRef 在语音输入 stop/refine/send
      // 的 async 等待期间会「故意滞后」于 storageKey prop(见该 ref 声明处注释),
      // 期间若这条 debounce 定时器还没触发,restoreNextDraft 就可能先跑完
      // setContent 把编辑器换成下一个 session 的文档、再把 ref 切到新 key —
      // 定时器这时才触发的话,`ed.getJSON()` 读到的已经是下一个 session 的内容,
      // 却仍会存进这里捕获的旧 `sk` 下,串味覆盖旧会话草稿。任务真正执行时重新核对
      // ref 是否还等于调度时捕获的 `sk`,不等就说明编辑器内容已经不再属于它,直接
      // 跳过这次写入(旧会话的最终内容已由 saveCurrentEditorDraft 在切换前存妥)。
      draftSaveSchedulerRef.current?.schedule(() => {
        if (storageKeyForDraftRef.current !== sk) return;
        if (!isDataOwnerGenerationCurrent(dataOwnerAtSchedule)) return;
        const existing = getComposerDraft(sk);
        saveComposerDraft(
          sk,
          {
            text: ed.getJSON(),
            attachments: existing?.attachments ?? [],
            quotes: existing?.quotes ?? [],
            browserComments: existing?.browserComments ?? [],
            ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
            ...(existing?.pendingHostCapabilityGhostId
              ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
              : {}),
            ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
          },
          { silent: true },
        );
      });
      // chat-input-autoscroll fix: 输入超过 max-h 后，让光标随内容追底
      scheduleCaretScroll(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const nextRenderSnapshot = composerRenderSnapshot(
        composerTriggerSnapshotOf(ed),
        !composerDocIsEmpty(ed.state.doc),
      );
      if (shouldRefreshComposerRender(renderSnapshotRef.current, nextRenderSnapshot)) {
        renderSnapshotRef.current = nextRenderSnapshot;
        refreshComposerRef.current?.();
      }
      if (!composerMentionDragActiveRef.current) {
        lastComposerSelectionFromRef.current = ed.state.selection.from;
      }
      // 方向键移动光标也要跟随（例如 ↓ 把光标从可见区移到 doc 末尾）
      scheduleCaretScroll(ed);
    },
    onBlur: () => {
      draftSaveSchedulerRef.current?.flush();
      // Focus left the editor. Spec F1/F2 require the palette to close on
      // blur. We defer by a microtask so mouse-click selections on the
      // palette (which also blur the editor momentarily) still register.
      setTimeout(() => {
        if (!panelHoverRef.current) {
          // Close both palettes by suppressing the current trigger position.
          // The triggerState recomputes on next tick — if it is still
          // active, the suppressed-at check keeps it closed.
          const ed = editorRef.current;
          if (!ed) return;
          const t = detectTrigger(ed);
          if (t.kind === 'slash') setSuppressedSlashAt(t.from);
          else if (t.kind === 'at') setSuppressedAtAt(t.from);
          // 合成打开的统一面板同样随失焦关闭(「+」按钮本身 mousedown
          // preventDefault 不夺焦,不会触发这里)。
          setSyntheticAtAnchor(null);
        }
      }, 0);
    },
  });

  const insertComposerMentionDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>): boolean => {
      if (!editor || editor.isDestroyed) return false;
      const payload = decodeComposerMentionPayload(e.dataTransfer.getData(COMPOSER_MENTION_MIME));
      if (!payload) return false;

      const at = lastComposerSelectionFromRef.current ?? editor.state.selection.from;
      if (payload.type === 'directory') {
        appendMentionChip(
          editor,
          {
            kind: 'dir',
            label: payload.name,
            path: payload.relPath,
          },
          { at },
        );
        return true;
      }

      appendMentionChip(
        editor,
        {
          kind: 'file',
          label: payload.name,
          path: payload.relPath,
        },
        { at },
      );
      return true;
    },
    [editor],
  );

  const insertSessionLinkDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>): boolean => {
      if (!editor || editor.isDestroyed) return false;
      const href = e.dataTransfer.getData(SESSION_LINK_DROP_MIME).trim();
      if (!href) return false;
      const at = lastComposerSelectionFromRef.current ?? editor.state.selection.from;
      appendMentionChip(editor, pastedSessionChipAttrs({ href, label: null }), { at });
      lastComposerSelectionFromRef.current = editor.state.selection.from;
      resolveSessionChipTitles(editor);
      return true;
    },
    [editor],
  );

  // Hold a live ref to the editor for handlers that mount before Tiptap
  // exposes it through React (e.g. the blur handler above).
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    const probe = createComposerInputLatencyProbe({ log: composerPerfLog });
    const markDocumentUpdate = ({ editor: activeEditor }: { editor: Editor }): void => {
      probe.markUpdate({
        kind: 'document',
        composing: activeEditor.view.composing,
        docSize: activeEditor.state.doc.content.size,
      });
    };
    const markSelectionUpdate = ({ editor: activeEditor }: { editor: Editor }): void => {
      probe.markUpdate({
        kind: 'selection',
        composing: activeEditor.view.composing,
        docSize: activeEditor.state.doc.content.size,
      });
    };

    editor.on('update', markDocumentUpdate);
    editor.on('selectionUpdate', markSelectionUpdate);
    return () => {
      editor.off('update', markDocumentUpdate);
      editor.off('selectionUpdate', markSelectionUpdate);
      probe.dispose();
    };
  }, [editor]);

  // Message action menu “Add to chat”: reuse the exact session-chip insertion
  // path used by clipboard paste, at the last composer caret position.
  useEffect(() => {
    if (!editor || !sessionId) return;
    return subscribeSessionLinkInsert(({ targetSessionId, href }) => {
      if (targetSessionId !== sessionId || editor.isDestroyed) return;
      const at = lastComposerSelectionFromRef.current ?? editor.state.selection.from;
      appendMentionChip(editor, pastedSessionChipAttrs({ href, label: null }), { at });
      lastComposerSelectionFromRef.current = editor.state.selection.from;
      resolveSessionChipTitles(editor);
    });
  }, [editor, sessionId]);

  const handleSavePastedText = useCallback(
    (text: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || !pastedTextEditTarget) return;

      // PastedTextChip 把原文写进 data-pasted-text 以支持复制回环；编辑后
      // 超过同一硬上限时降级为普通文本，避免超大 DOM attribute 重新引入卡顿。
      if (text.length > LONG_PASTE_MAX_CHARS) {
        replacePastedTextChipWithPlainText(
          currentEditor,
          pastedTextEditTarget.nodePos,
          pastedTextEditTarget.originalText,
          text,
        );
        return;
      }

      const nextAttrs =
        text.length === 0
          ? null
          : {
              text,
              display: t('newChat.pastedText.chipLabel', {
                lines: countPasteLines(text),
              }),
            };
      applyPastedTextChipEdit(
        currentEditor,
        pastedTextEditTarget.nodePos,
        pastedTextEditTarget.originalText,
        nextAttrs,
      );
    },
    [pastedTextEditTarget, t],
  );

  const handleClosePastedTextEdit = useCallback(() => {
    setPastedTextEditTarget(null);
    // ToolPayloadLightbox calls onClose after its fade-out; restore composer focus
    // only after the overlay has relinquished its primary textarea.
    requestAnimationFrame(() => editorRef.current?.commands.focus());
  }, []);

  // 意识指令确认胶囊:清单推给 GhostCommandDecoration(装/卸/唤醒/沉睡即时
  // 反映;plugin 不自己查 listSync,同步 IPC 不进 keystroke 热路径)。
  // 目录级禁用同判(ghostWorkdirFilter):被禁用的意识胶囊不亮——渲染层
  // 绝不比发送层乐观;禁用变更会广播 ghosts:changed,清单引用变化时重滤。
  const installedGhosts = useInstalledGhosts();
  const installedGhostsRef = useRef(installedGhosts);
  installedGhostsRef.current = installedGhosts;
  const pluginsForMenu = useMemo(
    () =>
      installedGhosts.filter(
        (ghost) =>
          ghost.manifest.id !== 'cindy-mivo' ||
          !installedGhosts.some((candidate) => candidate.manifest.id === 'xd-mivo'),
      ),
    [installedGhosts],
  );
  const ghostsForCommand = useMemo(
    () => filterGhostsForWorkdir(installedGhosts, workingDir),
    [installedGhosts, workingDir],
  );
  const pluginAvailableIds = useMemo(
    () =>
      new Set(ghostsForCommand.filter((ghost) => ghost.enabled).map((ghost) => ghost.manifest.id)),
    [ghostsForCommand],
  );
  // 统一建议面板的插件条目(旧 `+` 菜单口径的并集):可用项可选,无指令或
  // Host 入口或未生效项保留展示但置灰(entry 级 disabled + 原因)。
  const pluginSuggestions = useMemo<ComposerPluginSuggestion[]>(
    () => {
      // device-link 会话的插件运行在被控端；控制端清单既不代表远端已安装
      // 状态，选择后也无法用本地 InstalledGhost 解析并插入命令。fail-closed：
      // 仅 deviceLinkDeviceId === null（已确认本机）才展示；undefined（所有权
      // 尚未解析）与 string（远程）一律隐藏，避免 bootstrap/重连窗口期把控制端
      // 本地插件项泄漏进可能落为远程的会话。
      if (deviceLinkDeviceId !== null) return [];
      return pluginsForMenu.map((ghost) => {
        const hasCommand = !!ghost.manifest.command;
        const hostCapability = remoteHostId ? null : hostCapabilityForGhost(ghost);
        const hasComposerEntry = hasCommand || hostCapability !== null;
        const selectable = pluginAvailableIds.has(ghost.manifest.id) && hasComposerEntry;
        const entryKey = ghost.manifest.command ?? hostCapability ?? '';
        return {
          item: {
            type: 'plugin-command' as const,
            name: ghost.manifest.name,
            relPath:
              ghost.manifest.command ??
              (hostCapability
                ? `cindy://host-capability/${hostCapability}`
                : `cindy://plugin/${ghost.manifest.id}`),
            pluginId: ghost.manifest.id,
            ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
            sourceLabel: entryKey,
            _nameLower: `${ghost.manifest.name} ${entryKey}`.toLowerCase(),
            _relPathLower: `${entryKey} ${ghost.manifest.id}`.toLowerCase(),
          },
          ...(selectable
            ? {}
            : {
                disabled: true,
                disabledReason: t(
                  !pluginAvailableIds.has(ghost.manifest.id)
                    ? 'extraDirs.pluginDisabled'
                    : ghost.manifest.slots.includes('skill')
                      ? 'extraDirs.pluginAgentInvoked'
                      : 'extraDirs.pluginNoCommand',
                ),
              }),
        };
      });
    },
    [deviceLinkDeviceId, pluginsForMenu, pluginAvailableIds, remoteHostId, t],
  );
  useEffect(() => {
    setGhostCommandRoster(editor, ghostsForCommand);
  }, [editor, ghostsForCommand]);

  const handleVoiceInputPermissionRequired = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('newChat.chatInput.voiceInput.permissionDialog.title'),
      description: t('newChat.chatInput.voiceInput.permissionDialog.description'),
      confirmText: t('newChat.chatInput.voiceInput.permissionDialog.confirm'),
      cancelText: t('newChat.chatInput.voiceInput.permissionDialog.cancel'),
      autoFocusConfirm: true,
    });
    if (!confirmed) return;

    const result = await requestRendererMicrophonePermission();
    if (result.ok) return;

    const settingsResult = await window.electronAPI.voiceInput.openMicrophoneSettings();
    if (!settingsResult.ok) {
      toast.error(settingsResult.error);
    }
  }, [confirmDialog, t]);

  const voiceOwnerStorageKeyRef = useRef<string | undefined>(undefined);
  const frozenVoiceSendRef = useRef<{
    kind: 'send' | 'persist';
    sourceStorageKey: string;
    serialized: SerializedComposerContent;
    attachments: AttachedFile[];
    comments: BrowserCommentDraftItem[];
  } | null>(null);
  const voiceInputOptions = useMemo(
    () => ({
      onMicrophonePermissionRequired: handleVoiceInputPermissionRequired,
      shouldApplyToEditor: () =>
        voiceOwnerStorageKeyRef.current === undefined ||
        voiceOwnerStorageKeyRef.current === storageKeyForDraftRef.current,
      getDraftStorageKey: () => storageKeyForDraftRef.current,
    }),
    [handleVoiceInputPermissionRequired],
  );

  const voiceInputBusyRef = useRef(false);
  const voiceInputStopAndSendPromiseRef = useRef<Promise<void> | null>(null);

  // Declared before useVoiceInput so React 19 runs this cleanup first
  // (declaration order). Arm must be visible before the voice hook decides
  // whether to cancel or settle; otherwise the run is cancelled and a later
  // unmount can skip microphone teardown.
  useEffect(() => {
    if (!editor) return;
    const dataOwnerAtEffect = editorDataOwnerRef.current;
    return () => {
      if (!isDataOwnerGenerationCurrent(dataOwnerAtEffect)) {
        draftSaveSchedulerRef.current?.cancel();
        return;
      }
      draftSaveSchedulerRef.current?.flush();
      const editorStorageKey = storageKeyForDraftRef.current;
      if (!editorStorageKey) return;
      const existing = getComposerDraft(editorStorageKey);
      const hasText = !isEditorEmpty(editor);
      if (hasText || existing) {
        saveComposerDraft(
          editorStorageKey,
          {
            text: editor.getJSON(),
            attachments: existing?.attachments ?? [],
            quotes: existing?.quotes ?? [],
            browserComments: existing?.browserComments ?? [],
            ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
            ...(existing?.pendingHostCapabilityGhostId
              ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
              : {}),
            ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
          },
          { silent: true },
        );
      }
      const persistKey = voiceOwnerStorageKeyRef.current ?? editorStorageKey;
      // Only arm the composer that still owns this voice run. After a session
      // switch the switch effect already persists to the source; do not write
      // the source preview into the destination draft.
      if (
        voiceInputBusyRef.current &&
        !voiceInputStopAndSendPromiseRef.current &&
        persistKey &&
        persistKey === editorStorageKey
      ) {
        armDetachedVoiceDraftPersist(
          persistKey,
          voiceDraftTextRef.current.trim(),
        );
      }
    };
  }, [editor]);

  const voiceInput = useVoiceInput(editor, disabled, messages, voiceInputOptions);
  if (voiceInput.isBusy) {
    if (voiceOwnerStorageKeyRef.current === undefined) {
      voiceOwnerStorageKeyRef.current = storageKeyForDraftRef.current ?? storageKey;
    }
  } else {
    voiceOwnerStorageKeyRef.current = undefined;
    if (frozenVoiceSendRef.current?.kind === 'persist') {
      frozenVoiceSendRef.current = null;
    }
  }
  voiceDraftTextRef.current = voiceInput.draftText;
  const voiceBusyOnCurrentComposer = voiceLocksCurrentComposer({
    isBusy: voiceInput.isBusy,
    ownerStorageKey: voiceOwnerStorageKeyRef.current,
    currentStorageKey: storageKeyForDraftRef.current,
  });
  const composerMutationLocked = composerEditorLocked || voiceBusyOnCurrentComposer;
  composerMutationLockedRef.current = composerMutationLocked;
  useEffect(() => {
    editor?.setEditable(!composerMutationLocked);
  }, [composerMutationLocked, editor]);

  // 当推荐因附件/浏览器评论/语音草稿变为不可见时,清除 ref 防止 Tab 填入隐藏内容。
  // showRecommendationOverlay 的可见判据包含 !hasAttachments / browserComments.length === 0 /
  // !hasVoiceDraftText,但当这些条件变为 false 时只隐藏 overlay,不清除 ref。
  // 此时按 Tab 仍会通过 showRecommendationRef.current 检查并插入不可见的推荐词。
  // voiceInput.isBusy 也需要纳入：用户通过快捷键开始听写时 isBusy 立即为 true，
  // 但 draftText 可能尚未到达，此时 overlay 已隐藏而 ref 未清除，Tab 仍会插入推荐词。
  // composerMutationLocked 涵盖 disabled、sendDispatchInFlight、voiceInput.isBusy 及远程只读/锁定状态。
  useEffect(() => {
    if (
      recommendedPromptRef.current &&
      (attachments.length > 0 || browserComments.length > 0 || composerMutationLocked || voiceInput.draftText.trim().length > 0)
    ) {
      showRecommendationRef.current = false;
      setRecommendedPrompt(null);
    }
  }, [attachments.length, browserComments.length, composerMutationLocked, voiceInput.draftText]);

  const captureSendFocusForRestore = useComposerSendFocusRestore(
    editor,
    composerMutationLocked,
    sendDispatchInFlight,
  );
  const { settings: voiceInputSettings } = useVoiceInputSettings();
  const voiceInputShortcutLabel = useMemo(
    () => formatVoiceInputShortcut(voiceInputSettings.shortcut),
    [voiceInputSettings.shortcut],
  );
  useEffect(() => {
    if (voiceInputSettings.playInteractionSound) {
      prepareVoiceInputCues();
    }
  }, [voiceInputSettings.playInteractionSound]);
  const handleVoiceInputStart = useCallback(async () => {
    const proceed = await onBeforeVoiceInputStart?.();
    if (proceed === false) return;
    if (voiceInputSettings.playInteractionSound) {
      playVoiceInputStartCue();
    }
    await voiceInput.start();
  }, [onBeforeVoiceInputStart, voiceInput.start, voiceInputSettings.playInteractionSound]);

  const playVoiceInputEndCueNow = useCallback(() => {
    if (!voiceInputSettings.playInteractionSound) return;
    playVoiceInputEndCue();
  }, [voiceInputSettings.playInteractionSound]);

  const handleVoiceInputStop = useCallback(
    async (options?: { waitForRefinement?: boolean }) => {
      await voiceInput.stop({
        onReadyForEndCue: playVoiceInputEndCueNow,
        waitForRefinement: options?.waitForRefinement,
      });
    },
    [voiceInput.stop, playVoiceInputEndCueNow],
  );
  const handleVoiceInputPlainStop = useCallback(
    () => handleVoiceInputStop({ waitForRefinement: true }).catch(() => undefined),
    [handleVoiceInputStop],
  );
  const handleVoiceInputStopWithRefinement = useCallback(
    (options?: { waitForRefinement?: boolean }) =>
      handleVoiceInputStop({ waitForRefinement: options?.waitForRefinement ?? true }).catch(
        () => undefined,
      ),
    [handleVoiceInputStop],
  );

  const voiceShortcutRef = useRef(voiceInputSettings.shortcut);
  const voiceInputStateRef = useRef(voiceInput.state);
  const voiceInputStopRef = useRef(handleVoiceInputStopWithRefinement);
  voiceInputBusyRef.current = voiceInput.isBusy;
  voiceDraftTextRef.current = voiceInput.draftText;
  const voiceInputCancelRef = useRef(voiceInput.cancel);
  const voiceInputStopAndSendRef = useRef<
    (deliveryMode?: MessageDeliveryMode) => void | Promise<void>
  >(() => {});
  const voiceInputCanStopAndSendRef = useRef(false);
  const composerCanSubmitRef = useRef(false);
  const handleVoiceInputStartRef = useRef(handleVoiceInputStart);
  // The voice lifecycle locks surrounding composer mutations while listening,
  // but that must not disable the shortcut that stops the active recording.
  // Keep this ref on the external composer lock only (disabled / send preflight).
  const disabledRef = useRef(composerEditorLocked);
  const disableAutofocusRef = useRef(disableAutofocus);
  const focusOnStorageKeyChangeRef = useRef(focusOnStorageKeyChange);
  const latestStorageKeyRef = useRef<string | undefined>(storageKey);
  const currentStorageKeyRef = useRef<string | undefined>(storageKey);
  currentStorageKeyRef.current = storageKey;
  latestStorageKeyRef.current = storageKey;
  const storageKeyTransitionSeqRef = useRef(0);
  const storageKeyTransitionRecoveryRef = useRef<RemoteOptimisticTransitionCheckpoint | null>(null);
  const sendButtonRef = useRef<HTMLElement | null>(null);
  const voiceShortcutPressRef = useRef<{
    shortcut: VoiceInputShortcut;
    longPress: boolean;
    timer: number | null;
  } | null>(null);
  const voiceShortcutActionInFlightRef = useRef(false);
  const voiceShortcutStopAfterStartRef = useRef(false);
  const voiceShortcutStartedFromPressRef = useRef(false);
  const voiceShortcutSuppressNextReleaseRef = useRef(false);
  const localVoiceShortcutHandledAtRef = useRef(0);
  const globalVoiceShortcutStartHandledAtRef = useRef(0);
  const globalVoiceShortcutSuppressReleaseFromLocalRef = useRef(false);
  const workLouderVoiceGestureRef = useRef<ReturnType<
    typeof createWorkLouderCodexVoiceGesture
  > | null>(null);

  useEffect(() => {
    voiceShortcutRef.current = voiceInputSettings.shortcut;
  }, [voiceInputSettings.shortcut]);

  useEffect(() => {
    voiceInputStateRef.current = voiceInput.state;
    voiceInputStopRef.current = handleVoiceInputStopWithRefinement;
    voiceInputCancelRef.current = voiceInput.cancel;
    handleVoiceInputStartRef.current = handleVoiceInputStart;
    disabledRef.current = composerEditorLocked;
    disableAutofocusRef.current = disableAutofocus;
    focusOnStorageKeyChangeRef.current = focusOnStorageKeyChange;
  }, [
    composerEditorLocked,
    disableAutofocus,
    focusOnStorageKeyChange,
    handleVoiceInputStart,
    handleVoiceInputStopWithRefinement,
    voiceInput.cancel,
    voiceInput.state,
  ]);

  useEffect(() => {
    const clearPressTimer = () => {
      const press = voiceShortcutPressRef.current;
      if (!press?.timer) return;
      window.clearTimeout(press.timer);
      press.timer = null;
    };

    const isComposerEnterTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      const editorElement = editorRef.current?.view.dom;
      return !!(editorElement?.contains(target) || sendButtonRef.current?.contains(target));
    };
    const isVoiceInputEnterTarget = (target: EventTarget | null) => {
      if (isComposerEnterTarget(target)) return true;
      if (!target || target === document.body || target === document.documentElement) {
        return true;
      }
      return false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const currentState = voiceInputStateRef.current;
      // 权限菜单 / 确认框是当前顶层交互面，应先消费 Esc；它们的 capture handler
      // 注册在 document 或组件层，晚于本 window capture handler 执行。
      if (
        event.key === 'Escape' &&
        event.target instanceof Element &&
        event.target.closest('[role="alertdialog"], [data-morph-side]')
      ) {
        return;
      }
      const platform = window.electronAPI?.platform;
      if (event.key === 'Escape' && !event.repeat && !event.isComposing) {
        const voiceOwnsCurrentComposer =
          voiceOwnerStorageKeyRef.current === undefined ||
          voiceOwnerStorageKeyRef.current === storageKeyForDraftRef.current;
        if (
          voiceOwnsCurrentComposer &&
          (currentState === 'listening' ||
            currentState === 'submitting' ||
            currentState === 'refining')
        ) {
          event.preventDefault();
          clearPressTimer();
          voiceShortcutPressRef.current = null;
          void voiceInputCancelRef.current();
          return;
        }
      }

      const enterIntent = resolveComposerEnterIntent(event, getComposerSendShortcutPreference(), {
        turnRunning: showStopButtonRef.current,
        platform,
      });
      const isModifiedEnter = hasComposerModifier(event, platform);
      if (
        isComposerEnterTarget(event.target) &&
        isModifiedEnter &&
        (enterIntent === 'queue' || enterIntent === 'steer') &&
        currentState !== 'listening'
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (panelBridgeRef.current?.captureKey(event)) return;
        clearPressTimer();
        voiceShortcutPressRef.current = null;
        void dispatchSendRef.current(enterIntent);
        return;
      }

      // This window capture listener runs before Tiptap's palette bridge. While
      // listening, preserve the editor's normal priority: Enter first selects
      // or dismisses the open palette instead of stopping voice and sending the
      // unresolved slash query.
      if (
        currentState === 'listening' &&
        isComposerEnterTarget(event.target) &&
        (enterIntent === 'queue' || enterIntent === 'steer') &&
        panelBridgeRef.current?.captureKey(event)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (
        currentState === 'listening' &&
        voiceInputCanStopAndSendRef.current &&
        isVoiceInputEnterTarget(event.target) &&
        (enterIntent === 'queue' || enterIntent === 'steer') &&
        !isVoiceInputShortcutMatch(event, voiceShortcutRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        clearPressTimer();
        voiceShortcutPressRef.current = null;
        void voiceInputStopAndSendRef.current(enterIntent);
        return;
      }

      const shortcut = voiceShortcutRef.current;
      if (!shortcut || event.repeat || event.isComposing) return;
      if (!isVoiceInputShortcutMatch(event, shortcut)) return;
      if (disabledRef.current || !editorRef.current || editorRef.current.isDestroyed) return;

      if (isVoiceInputIdleLike(currentState) && !editorRef.current.isFocused) {
        // Editor not focused: don't act on the shortcut here, but still
        // consume the event so the matched key combo doesn't leak as a
        // character into whatever other input is focused.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (currentState === 'submitting' || currentState === 'refining') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (
        performance.now() - globalVoiceShortcutStartHandledAtRef.current <
        VOICE_INPUT_SHORTCUT_DEDUPE_MS
      ) {
        return;
      }
      localVoiceShortcutHandledAtRef.current = performance.now();
      if (voiceShortcutActionInFlightRef.current) return;
      voiceShortcutActionInFlightRef.current = true;
      window.setTimeout(() => {
        voiceShortcutActionInFlightRef.current = false;
      }, 120);

      if (currentState === 'listening') {
        if (voiceShortcutPressRef.current) return;
        void voiceInputStopRef.current();
        return;
      }

      if (voiceShortcutPressRef.current) return;
      const press = {
        shortcut,
        longPress: false,
        timer: null as number | null,
      };
      press.timer = window.setTimeout(() => {
        press.longPress = true;
        press.timer = null;
      }, VOICE_INPUT_LONG_PRESS_MS);
      voiceShortcutPressRef.current = press;
      void handleVoiceInputStartRef.current();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const press = voiceShortcutPressRef.current;
      const releaseCurrentPress = Boolean(
        press && isVoiceInputShortcutRelease(event, press.shortcut),
      );
      if (!press || !releaseCurrentPress) return;

      event.preventDefault();
      event.stopPropagation();
      clearPressTimer();
      voiceShortcutPressRef.current = null;
      if (press.longPress) {
        void voiceInputStopRef.current();
      }
    };

    const handleWindowBlur = () => {
      const press = voiceShortcutPressRef.current;
      if (!press) return;
      clearPressTimer();
      voiceShortcutPressRef.current = null;
      if (press.longPress) {
        void voiceInputStopRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      clearPressTimer();
      voiceShortcutPressRef.current = null;
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    return window.electronAPI.voiceInput.onGlobalShortcutTrigger((payload) => {
      if (disabledRef.current || !editorRef.current || editorRef.current.isDestroyed) return;

      const currentState = voiceInputStateRef.current;
      if (isVoiceInputIdleLike(currentState) && !editorRef.current.isFocused) return;
      if (payload?.id) {
        window.electronAPI.voiceInput.claimGlobalShortcutTrigger(payload.id);
      }
      const phase = payload?.phase;
      if (
        (phase === 'tap' || phase === 'end') &&
        globalVoiceShortcutSuppressReleaseFromLocalRef.current
      ) {
        globalVoiceShortcutSuppressReleaseFromLocalRef.current = false;
        return;
      }
      if (
        performance.now() - localVoiceShortcutHandledAtRef.current <
        VOICE_INPUT_SHORTCUT_DEDUPE_MS
      ) {
        if (phase === 'start') {
          globalVoiceShortcutSuppressReleaseFromLocalRef.current = true;
        }
        return;
      }
      if (phase === 'start') {
        voiceShortcutSuppressNextReleaseRef.current = false;
        globalVoiceShortcutStartHandledAtRef.current = performance.now();
      }
      if ((phase === 'tap' || phase === 'end') && voiceShortcutSuppressNextReleaseRef.current) {
        voiceShortcutSuppressNextReleaseRef.current = false;
        voiceShortcutStartedFromPressRef.current = false;
        return;
      }
      if (currentState === 'submitting' || currentState === 'refining') return;

      if (phase === 'tap') {
        if (voiceShortcutStartedFromPressRef.current) {
          voiceShortcutStartedFromPressRef.current = false;
          return;
        }
        if (voiceShortcutActionInFlightRef.current) return;
        if (currentState !== 'listening') return;
        voiceShortcutActionInFlightRef.current = true;
        voiceShortcutStopAfterStartRef.current = false;
        void voiceInputStopRef.current().finally(() => {
          window.setTimeout(() => {
            voiceShortcutActionInFlightRef.current = false;
          }, 120);
        });
        return;
      }

      if (phase === 'end') {
        voiceShortcutStartedFromPressRef.current = false;
        if (voiceShortcutActionInFlightRef.current) {
          voiceShortcutStopAfterStartRef.current = true;
          return;
        }
        if (currentState !== 'listening') return;
        voiceShortcutActionInFlightRef.current = true;
        voiceShortcutStopAfterStartRef.current = false;
        void voiceInputStopRef.current().finally(() => {
          window.setTimeout(() => {
            voiceShortcutActionInFlightRef.current = false;
          }, 120);
        });
        return;
      }

      if (phase === 'start' && !isVoiceInputIdleLike(currentState)) {
        voiceShortcutStartedFromPressRef.current = false;
        if (currentState === 'listening') {
          voiceShortcutSuppressNextReleaseRef.current = true;
          if (voiceShortcutActionInFlightRef.current) return;
          voiceShortcutActionInFlightRef.current = true;
          voiceShortcutStopAfterStartRef.current = false;
          void voiceInputStopRef.current().finally(() => {
            window.setTimeout(() => {
              voiceShortcutActionInFlightRef.current = false;
            }, 120);
          });
        }
        return;
      }

      if (voiceShortcutActionInFlightRef.current) return;
      voiceShortcutActionInFlightRef.current = true;
      voiceShortcutStartedFromPressRef.current = phase === 'start';
      const releaseInFlight = () => {
        window.setTimeout(() => {
          voiceShortcutActionInFlightRef.current = false;
        }, 120);
      };

      if (currentState === 'listening') {
        void voiceInputStopRef.current().finally(releaseInFlight);
        return;
      }

      void handleVoiceInputStartRef
        .current()
        .then(() => {
          if (!voiceShortcutStopAfterStartRef.current) return;
          voiceShortcutStopAfterStartRef.current = false;
          return voiceInputStopRef.current();
        })
        .catch(() => {
          voiceShortcutStopAfterStartRef.current = false;
        })
        .finally(releaseInFlight);
    });
  }, []);

  // While dictation holds the editor read-only the native caret disappears;
  // the decoration renders a mic-shaped caret at the insertion point instead
  // (listening = animated level bars, submitting/refining = spinner).
  const voiceCaretState: VoiceInputCaretState | null = !voiceBusyOnCurrentComposer
    ? null
    : voiceInput.isListening
      ? 'listening'
      : voiceInput.isBusy
        ? 'processing'
        : null;

  useEffect(() => {
    setVoiceInputDraftDecoration(
      editor,
      voiceBusyOnCurrentComposer ? voiceInput.draftText : '',
      voiceBusyOnCurrentComposer ? voiceInput.draftSource : null,
      voiceBusyOnCurrentComposer ? voiceInput.draftRange : null,
      voiceCaretState,
    );
    // Caret-only (no draft text yet) must also stay visible: the insertion
    // point can sit outside the viewport when the composer is scrolled.
    if (voiceBusyOnCurrentComposer && (voiceInput.draftText || voiceCaretState)) {
      requestAnimationFrame(() => {
        if (editor) scrollVoiceInputDraftEndIntoView(editor);
      });
    }
  }, [
    editor,
    voiceBusyOnCurrentComposer,
    voiceCaretState,
    voiceInput.draftRange,
    voiceInput.draftSource,
    voiceInput.draftText,
  ]);

  // Route changes such as Chat -> Settings unmount the composer immediately.
  // Draft snapshot + detached-voice arm run in the earlier effect declared
  // before useVoiceInput, so React 19 cleanup arms persist first.

  // ── composer-draft-per-session: restore on storageKey change ────────
  // Whenever the parent switches `storageKey` (= `draftKey ?? sessionId`),
  // swap the editor's content to that key's saved draft (or empty if none).
  // The `useAttachments` hook handles the attachments half; this handles the
  // text half.
  //
  // Guard against onUpdate recursion via `isRestoringRef` — Tiptap's
  // setContent fires onUpdate, which would otherwise re-write the draft
  // we just restored.
  //
  // Also fires once when `editor` first becomes non-null (mount), to
  // hydrate the initial key's draft if one exists.
  useEffect(() => {
    if (!editor) return;
    const dataOwnerAtTransition = getDataOwnerGeneration();
    latestStorageKeyRef.current = storageKey;
    const prevEditorKey = editorStorageKeyRef.current;
    const storageKeyFocusAnchor = document.activeElement;
    // Skip if the editor is already aligned with this storageKey.
    // (Possible when only `editor` flipped to non-null but the key
    // was already current.)
    if (prevEditorKey === storageKey) {
      storageKeyTransitionRecoveryRef.current = null;
      // First-mount hydration path: the editor just became available for
      // the *current* storageKey — check the store once.
      // We detect "first-mount" by an editorStorageKeyRef that matches the
      // initial key AND an empty editor. If the editor already has content
      // (e.g. user typed before this effect ran in StrictMode), we leave it
      // alone.
      if (storageKey !== undefined) {
        const draft = getComposerDraft(storageKey);
        // 判空同外部草稿订阅:草稿正文可能是「空文档 JSON」而不是 undefined。此时
        // 编辑器本来就是空的,setContent 只会原地重建 doc(replace(0, size)),把按
        // 位置存活的状态(语音插入点、草稿装饰锚点)推到 block 边界上。此前把
        // voiceInput.isBusy 放进依赖时,录音开始与结束各会重跑一次——新建对话页的
        // 草稿键固定、常留着一份空正文,于是上屏文字前凭空多出一个空行。
        const draftDocument = draft?.text && tiptapDocHasContent(draft.text) ? draft.text : null;
        if (draftDocument && composerDocIsEmpty(editor.state.doc)) {
          isRestoringRef.current = true;
          try {
            editor.commands.setContent(normalizeRestoredComposerDraft(draftDocument));
          } finally {
            isRestoringRef.current = false;
          }
        }
      }
      editorStorageKeyRef.current = storageKey;
      storageKeyForDraftRef.current = storageKey;
      editorDataOwnerRef.current = dataOwnerAtTransition;
      // composer-draft-mount-race 修复 (issue #40):放行后续 onUpdate 写 store。
      hasHydratedRef.current = true;
      if (
        focusOnStorageKeyChangeRef.current &&
        !disableAutofocusRef.current &&
        !disabledRef.current
      ) {
        window.requestAnimationFrame(() => {
          if (editor.isDestroyed || !editor.isEditable) return;
          if (latestStorageKeyRef.current !== storageKey) return;
          if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor.view.dom)) return;
          editor.commands.focus('end');
        });
      }
      return;
    }

    const transitionSeq = storageKeyTransitionSeqRef.current + 1;
    storageKeyTransitionSeqRef.current = transitionSeq;
    const transitionRecovery = prevEditorKey
      ? getOrCreateRemoteOptimisticTransitionCheckpoint(
          storageKeyTransitionRecoveryRef.current,
          prevEditorKey,
        )
      : null;
    storageKeyTransitionRecoveryRef.current = transitionRecovery;
    const recoveryCheckpoint = transitionRecovery?.checkpoint ?? null;
    draftSaveSchedulerRef.current?.flush();
    const saveCurrentEditorDraft = () => {
      if (!prevEditorKey) return;
      if (!hasHydratedRef.current) return;
      const existing = getComposerDraft(prevEditorKey);
      const hasText = !isEditorEmpty(editor);
      if (!hasText && !existing) return;
      saveComposerTextAfterAsyncTransition(prevEditorKey, editor.getJSON(), recoveryCheckpoint!);
    };

    let cancelled = false;
    const isCurrentTransition = () =>
      !cancelled &&
      !editor.isDestroyed &&
      isDataOwnerGenerationCurrent(dataOwnerAtTransition) &&
      storageKeyTransitionSeqRef.current === transitionSeq &&
      latestStorageKeyRef.current === storageKey;

    const restoreNextDraft = () => {
      if (!isCurrentTransition()) return;
      isRestoringRef.current = true;
      try {
        const draft = storageKey !== undefined ? getComposerDraft(storageKey) : undefined;
        if (draft?.text) {
          editor.commands.setContent(normalizeRestoredComposerDraft(draft.text));
        } else {
          editor.commands.clearContent();
        }
      } finally {
        isRestoringRef.current = false;
      }
      editorStorageKeyRef.current = storageKey;
      storageKeyForDraftRef.current = storageKey;
      editorDataOwnerRef.current = dataOwnerAtTransition;
      storageKeyTransitionRecoveryRef.current = null;
      hasHydratedRef.current = true;

      // Reset history-browse bookkeeping when switching sessions —
      // arrow-key history was relative to the previous session.
      historyIndexRef.current = -1;
      hydratedHistoryDocumentRef.current = null;
      draftRef.current = null;

      if (!focusOnStorageKeyChangeRef.current) return;
      if (disableAutofocusRef.current || disabledRef.current) return;
      window.requestAnimationFrame(() => {
        if (!isCurrentTransition()) return;
        if (!focusOnStorageKeyChangeRef.current) return;
        if (disableAutofocusRef.current || disabledRef.current) return;
        if (editor.isDestroyed || !editor.isEditable) return;
        if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor.view.dom)) return;
        editor.commands.focus('end');
      });
    };

    const pendingStopAndSend = voiceInputStopAndSendPromiseRef.current;
    const wasBusyWithoutSend = !pendingStopAndSend && voiceInputBusyRef.current;
    const submittedAtSwitch = wasBusyWithoutSend ? voiceInput.getLastSubmittedText().trim() : '';
    const unlandedPreview =
      wasBusyWithoutSend && !submittedAtSwitch ? voiceDraftTextRef.current.trim() : '';
    const voiceOwnerKey = voiceOwnerStorageKeyRef.current ?? prevEditorKey;
    if ((pendingStopAndSend || voiceInputBusyRef.current) && prevEditorKey && voiceOwnerKey) {
      const existingFreeze = frozenVoiceSendRef.current;
      if (
        prevEditorKey === voiceOwnerKey &&
        (!existingFreeze || existingFreeze.sourceStorageKey === voiceOwnerKey)
      ) {
        const sourceDraft = getComposerDraft(prevEditorKey);
        frozenVoiceSendRef.current = {
          kind: pendingStopAndSend ? 'send' : 'persist',
          sourceStorageKey: voiceOwnerKey,
          serialized: serializeEditorContent(editor),
          attachments: [...(sourceDraft?.attachments ?? [])],
          comments: [...(sourceDraft?.browserComments ?? browserCommentsRef.current)],
        };
      }
    }

    // storageKey actually changed — swap the editor's content immediately so
    // the next task never paints the previous session's listening/refining text.
    saveCurrentEditorDraft();
    restoreNextDraft();
    // The reused composer now shows the destination draft. Drop the source
    // send lock so the next task is immediately editable.
    setSendDispatchInFlight(false);
    if (wasBusyWithoutSend && prevEditorKey && prevEditorKey === voiceOwnerKey) {
      const sourceKey = prevEditorKey;
      const persistDetachedVoice = (previousVoiceText: string, nextVoiceText: string) => {
        if (!nextVoiceText) return;
        const existing = getComposerDraft(sourceKey);
        saveComposerDraft(
          sourceKey,
          {
            text: mergeDetachedVoiceTextIntoDocument(
              existing?.text,
              previousVoiceText,
              nextVoiceText,
            ),
            attachments: existing?.attachments ?? [],
            quotes: existing?.quotes ?? [],
            browserComments: existing?.browserComments ?? [],
            ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
            ...(existing?.pendingHostCapabilityGhostId
              ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
              : {}),
            ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
          },
          { silent: latestStorageKeyRef.current !== sourceKey },
        );
      };
      // Submitted text is already in the editor snapshot. Only persist a
      // still-ghost listening preview, then upgrade it after stop/refine.
      if (unlandedPreview) persistDetachedVoice('', unlandedPreview);
      void (async () => {
        try {
          await voiceInputStopRef.current({ waitForRefinement: true });
        } catch {
          const submitted = voiceInput.getLastSubmittedText().trim();
          if (submitted && unlandedPreview) persistDetachedVoice(unlandedPreview, submitted);
          return;
        }
        const submitted = voiceInput.getLastSubmittedText().trim();
        const refined = voiceInput.getLastRefinement()?.refinedText.trim() ?? '';
        const nextVoice = refined || submitted;
        if (!nextVoice) return;
        persistDetachedVoice(unlandedPreview || submittedAtSwitch, nextVoice);
      })();
    }
  }, [editor, storageKey]);

  // ── External draft writes for the CURRENT session (e.g. rewind / fork
  // pre-fill called saveComposerDraft from outside) ──
  // The restore-on-sessionId-change effect above only fires when sessionId
  // toggles; a same-session draft overwrite (rewind in place) needs a separate
  // notification to force-setContent. composerDraftStore notifies subscribers
  // for non-silent writes; ChatInput's own keystroke writes pass `silent:true`
  // so they don't loop back.
  useEffect(() => {
    if (!editor || !storageKey) return;
    const dataOwnerAtSubscription = editorDataOwnerRef.current;
    return subscribeComposerDraft(storageKey, () => {
      if (!isDataOwnerGenerationCurrent(dataOwnerAtSubscription)) return;
      const draft = getComposerDraft(storageKey);
      if (!draft) return;
      const nextBrowserComments = [...(draft.browserComments ?? [])];
      browserCommentsRef.current = nextBrowserComments;
      setBrowserComments(nextBrowserComments);
      // 同值外部写入不做全量 setContent,避免把用户停在中段的光标弹到末尾、
      // 打断 IME 组合。appendQuoteToDraft 会改变正文文档,自然走下方 setContent。
      // 空草稿在存储里可能是 `{doc:[空 paragraph]}` 而不是 undefined,而右侧对
      // "编辑器为空"一律折叠成 null。两侧判空口径必须一致,否则每次外部草稿通知都
      // 会拿一份空文档整段 setContent:doc 被原地重建,所有按位置存活的状态(语音
      // 草稿锚点等)被迫跨整篇映射(#720 后语音录音时首行多一个空行的成因)。
      const draftDocument = normalizeRestoredComposerDraft(draft.text);
      const normalizedDraftText =
        draftDocument && tiptapDocHasContent(draftDocument) ? draftDocument : null;
      const textUnchanged =
        JSON.stringify(normalizedDraftText) ===
        JSON.stringify(composerDocIsEmpty(editor.state.doc) ? null : editor.getJSON());
      if (textUnchanged) {
        if (!editor.isFocused) editor.commands.focus();
        return;
      }
      isRestoringRef.current = true;
      try {
        if (normalizedDraftText) {
          editor.commands.setContent(normalizedDraftText);
          editor.commands.focus('end');
        } else {
          editor.commands.clearContent();
        }
      } finally {
        isRestoringRef.current = false;
      }
    });
  }, [editor, storageKey]);

  // device-link 归属解析成「已确认远程」后补剥 Host capability 芯片。草稿恢复
  // 效果依赖 [editor, storageKey],归属从 undefined(未解析)→ 远程 string 时不会
  // 重跑,而 normalizeRestoredComposerDraft 在未解析阶段保留了芯片(不能把已存本机
  // 草稿的芯片当远程剥掉);这里监听归属转译,一旦确认远程就把当前编辑器内容里残留
  // 的 Host 芯片剥掉,避免发送路径被 TARGET_UNAVAILABLE 拦截、逼用户手动删芯片。
  const prevConfirmedRemoteRef = useRef<boolean>(false);
  useEffect(() => {
    const isConfirmedRemote = !!remoteHostId || typeof deviceLinkDeviceId === 'string';
    const becameRemote = isConfirmedRemote && !prevConfirmedRemoteRef.current;
    prevConfirmedRemoteRef.current = isConfirmedRemote;
    if (!becameRemote || !editor) return;
    const doc = editor.getJSON();
    if (!composerDocumentContainsHostCapabilityChip(doc)) return;
    isRestoringRef.current = true;
    try {
      editor.commands.setContent(stripHostCapabilityChips(doc));
    } finally {
      isRestoringRef.current = false;
    }
  }, [editor, remoteHostId, deviceLinkDeviceId]);

  // Plugin page routed entry: wait until the editor has hydrated its existing
  // draft, then reuse the exact same insertion/focus path as the in-composer
  // `$` / `+` selectors. This preserves body text and replaces an existing
  // Plugin command instead of treating the command as prefilled plain text.
  useEffect(() => {
    if (!editor || !storageKey || !hasHydratedRef.current) return;
    const draft = getComposerDraft(storageKey);
    if (!draft) return;

    if (draft.pendingGhostId) {
      const ghost = ghostsForCommand.find(
        (candidate) => candidate.manifest.id === draft.pendingGhostId,
      );
      if (!ghost) return;
      saveComposerDraft(
        storageKey,
        {
          ...draft,
          pendingGhostId: undefined,
          focusAtEnd: false,
        },
        { silent: true },
      );
      placeGhostAtComposerStart(editor, ghost, installedGhosts);
      return;
    }

    if (draft.pendingHostCapabilityGhostId) {
      const ghost = ghostsForCommand.find(
        (candidate) => candidate.manifest.id === draft.pendingHostCapabilityGhostId,
      );
      // 远程/未解析归属不恢复 Host capability 芯片(与 `+` 菜单和发送路径的
      // fail-closed 同口径):SSH(remoteHostId)或 device-link(deviceLinkDeviceId
      // !== null,含未解析)会话若恢复芯片,发送时会被 TARGET_UNAVAILABLE 拦截,
      // 阻塞用户发送正文。仅已确认本机(deviceLinkDeviceId === null 且无
      // remoteHostId)才恢复,否则静默丢弃芯片意图。
      const dlDeviceId = deviceLinkDeviceIdRef.current;
      const canPlaceHostCapability =
        !remoteHostIdRef.current && dlDeviceId === null;
      // 归属未解析(deviceLinkDeviceId === undefined)且非 SSH 时延后决定:不清除
      // pendingHostCapabilityGhostId,等归属解析后 effect 重跑。若此时清除,
      // 后续解析成本机也无法恢复芯片,Host 插件(如 iOS Simulator)的"使用"
      // handoff 会静默丢失。
      // SSH(remoteHostId 已解析)时:即使 dlDeviceId === undefined,SSH 会话
      // 永远无法放置 Host capability 芯片,直接清除 pendingHostCapabilityGhostId,
      // 避免残留芯片在后续依赖变化时延迟插入已失效的能力。
      if (dlDeviceId === undefined && !remoteHostIdRef.current) {
        return;
      }
      saveComposerDraft(
        storageKey,
        {
          ...draft,
          pendingHostCapabilityGhostId: undefined,
          focusAtEnd: false,
        },
        { silent: true },
      );
      if (ghost && canPlaceHostCapability) {
        placeHostCapabilityAtComposerStart(editor, ghost, installedGhosts);
      }
      return;
    }

    if (!draft.focusAtEnd) return;
    saveComposerDraft(
      storageKey,
      {
        ...draft,
        focusAtEnd: false,
      },
      { silent: true },
    );
    focusComposerEndNextFrame(editor);
  }, [editor, ghostsForCommand, installedGhosts, storageKey, deviceLinkDeviceId, remoteHostId]);

  // browser-comment-chip:挂载 / 会话切换时从草稿恢复评论胶囊。
  useEffect(() => {
    if (!storageKey) {
      browserCommentsRef.current = [];
      setBrowserComments([]);
      return;
    }
    const draft = getComposerDraft(storageKey);
    const nextBrowserComments = [...(draft?.browserComments ?? [])];
    browserCommentsRef.current = nextBrowserComments;
    setBrowserComments(nextBrowserComments);
  }, [storageKey]);

  /** browser-comment-chip:按 id 删除单条 / 清空全部评论。同步镜像 state 与
   *  草稿事实源(silent——自己写自己)。**丢弃即清缓存**:评论截图是
   *  `image-cache:from-buffer` 的会话私有文件、仅被该草稿条目引用,chip 被
   *  丢弃后 UI 再无入口,不清会一直躺到会话删除(发送成功的路径不走这里,
   *  消息接管截图所有权,post-send 只 setBrowserComments([]) 不清缓存)。
   *  页面上的常驻 marker 不即时联动(guest overlay 生命周期独立),由下一次
   *  截图前的 validMarkerNumbers 对账剪除。 */
  const updateBrowserComments = useCallback(
    (next: BrowserCommentDraftItem[]) => {
      browserCommentsRef.current = next;
      setBrowserComments(next);
      if (storageKey) {
        const existing = getComposerDraft(storageKey);
        saveComposerDraft(
          storageKey,
          {
            text: existing?.text ?? null,
            attachments: existing?.attachments ?? [],
            quotes: existing?.quotes ?? [],
            browserComments: next,
            ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
            ...(existing?.pendingHostCapabilityGhostId
              ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
              : {}),
            ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
          },
          { silent: true },
        );
      }
    },
    [storageKey],
  );
  /** 丢弃若干评论条目:草稿更新 + best-effort 清理其截图缓存文件。 */
  const discardBrowserComments = useCallback(
    (next: BrowserCommentDraftItem[], discarded: BrowserCommentDraftItem[]) => {
      updateBrowserComments(next);
      const urls = discarded
        .map((c) => c.screenshot.url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0);
      if (urls.length > 0) {
        // 清理失败无害(文件残留至会话删除,与修复前同等行为),不阻塞交互。
        void window.electronAPI.cleanupCachedImages(urls).catch(() => undefined);
      }
    },
    [updateBrowserComments],
  );
  const clearBrowserComments = useCallback(() => {
    discardBrowserComments([], browserCommentsRef.current);
  }, [discardBrowserComments]);
  const removeBrowserComment = useCallback(
    (id: string) => {
      const current = browserCommentsRef.current;
      const removed = current.filter((c) => c.id === id);
      // 单删走链修复:同元素同属性的后续注解,其 previousValue 可能采自被删
      // 条目的预览值(getComputedStyle 读到的是预览后页面),原样保留会让
      // 序列化输出"中间预览值 -> 新值",模型按不存在于源码的旧值找错目标。
      discardBrowserComments(removeBrowserCommentAndRepairChains(current, id), removed);
    },
    [discardBrowserComments],
  );

  // ── Folder drop → @dir mention chip ──
  // When pending folder paths arrive (from any drop zone), insert them as
  // @dir mention chips in the editor.
  useEffect(() => {
    if (!editor) return;
    if (pendingFoldersVersion === 0) return;
    const paths = consumePendingFolders();
    if (paths.length === 0) return;
    for (const folderPath of paths) {
      const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath;
      appendMentionChip(editor, {
        kind: 'dir',
        label: folderName,
        path: folderPath,
      });
    }
  }, [editor, consumePendingFolders, pendingFoldersVersion]);

  useEffect(() => {
    if (!editor) return;
    if (pendingFileMentionsVersion === 0) return;
    const payloads = consumePendingFileMentions();
    if (payloads.length === 0) return;
    for (const payload of payloads) {
      appendMentionChip(editor, {
        kind: 'file',
        label: payload.name,
        path: payload.relPath,
      });
    }
  }, [editor, consumePendingFileMentions, pendingFileMentionsVersion]);

  // Track whether the user is interacting with a palette (mouseover) — if
  // so the blur handler should NOT auto-close, otherwise a mouse click on
  // a row gets cancelled by the blur fire.
  const panelHoverRef = useRef(false);
  const palettePanelHoverRef = useRef(false);
  const paletteTooltipHoverRef = useRef(false);
  const syncPaletteHover = useCallback(() => {
    panelHoverRef.current = palettePanelHoverRef.current || paletteTooltipHoverRef.current;
  }, []);
  const setPalettePanelHover = useCallback(
    (hovered: boolean) => {
      palettePanelHoverRef.current = hovered;
      syncPaletteHover();
    },
    [syncPaletteHover],
  );
  const setPaletteTooltipHover = useCallback(
    (hovered: boolean) => {
      paletteTooltipHoverRef.current = hovered;
      syncPaletteHover();
    },
    [syncPaletteHover],
  );

  // ── Slash / At panel state ─────────────────────────────────────────
  const trigger: TriggerState = editor ? detectTrigger(editor) : { kind: 'none' };

  // Slash commands — palette refactor 后改成 loadAllCommands 一次性拉三源(desktop +
  // agent-builtin + agent-skill); 内部并发, mergeCommands 按优先级合并去重。
  const paletteAgentKind = agentKind ?? 'claude-code';
  // remote session:workingDir 是远端主机路径,不能按它扫本机 skills/files。
  // slash 退化为 desktop + agent-builtin(传 null),@ 文件面板直接关闭(见 atOpen)。
  const isRemoteSession = !!remoteHostId;
  const slashCommandContextKey = JSON.stringify([
    workingDir ?? null,
    paletteAgentKind,
    isRemoteSession,
    sessionId ?? null,
    deviceLinkDeviceId ?? null,
  ]);
  const [slashCommandLoadState, setSlashCommandLoadState] = useState<SlashCommandRosterState>({
    contextKey: '',
    status: 'loading',
    commands: EMPTY_SLASH_COMMANDS,
  });
  const [piRuntimeCommandStatus, setPiRuntimeCommandStatus] =
    useState<PiPackageCommandRuntimeStatus | null>(null);
  const slashCommandsReady = isSlashCommandRosterReady(
    slashCommandLoadState,
    slashCommandContextKey,
  );
  const mergedCommands =
    slashCommandLoadState.contextKey === slashCommandContextKey
      ? slashCommandLoadState.commands
      : EMPTY_SLASH_COMMANDS;
  const planModeCommandAvailable = planModeEntry !== undefined;
  const composerSlashCommands = useMemo(
    () =>
      addPlanModeComposerCommand(
        mergedCommands,
        planModeCommandAvailable && slashCommandsReady ? t('planMode.menuItem') : null,
      ),
    [mergedCommands, planModeCommandAvailable, slashCommandsReady, t],
  );
  const slashCommandLoadSeqRef = useRef(0);
  const piRuntimeRetryRef = useRef(0);
  useEffect(
    () => () => {
      slashCommandLoadSeqRef.current += 1;
    },
    [],
  );
  const reloadSlashCommands = useCallback(
    (opts?: { forceReload?: boolean }) => {
      const seq = ++slashCommandLoadSeqRef.current;
      setSlashCommandLoadState((current) =>
        beginSlashCommandRosterLoad(current, slashCommandContextKey),
      );
      // device-link 远程会话:agent-builtin / agent-skill 从被控端读(deviceLinkDeviceId);
      // workingDir 是被控端路径；SSH remote 显式关扫描。desktop 命令始终本地。
      loadAllCommands(
        paletteAgentKind,
        workingDir,
        {
          ...opts,
          skipAgentSkills: isRemoteSession,
          sessionId,
          allowManagedPiPackagePreview: !isRemoteSession,
          onPiRuntimeStatus: (status) => {
            if (slashCommandLoadSeqRef.current === seq) setPiRuntimeCommandStatus(status);
          },
        },
        deviceLinkDeviceId ?? undefined,
      )
        .then((cmds) => {
          if (slashCommandLoadSeqRef.current === seq) {
            setSlashCommandLoadState({
              contextKey: slashCommandContextKey,
              status: 'ready',
              commands: cmds,
            });
          }
        })
        .catch(() => {
          if (slashCommandLoadSeqRef.current === seq) {
            setSlashCommandLoadState((current) =>
              failSlashCommandRosterLoad(current, slashCommandContextKey),
            );
          }
        });
    },
    [
      workingDir,
      paletteAgentKind,
      isRemoteSession,
      sessionId,
      deviceLinkDeviceId,
      slashCommandContextKey,
    ],
  );
  useEffect(() => {
    piRuntimeRetryRef.current = 0;
    setPiRuntimeCommandStatus(null);
  }, [slashCommandContextKey]);
  useEffect(() => {
    reloadSlashCommands();
  }, [reloadSlashCommands]);
  useEffect(() => window.electronAPI.maker.onPiPackagesChanged(() => {
    reloadSlashCommands({ forceReload: true });
  }), [reloadSlashCommands]);
  // Slash 指令与 $意识一致:doc 保持可逐字编辑的普通文本,完整命中当前 roster
  // 时才由 decoration 显示确认胶囊。异步 roster 刷新不进入 keystroke 热路径。
  useEffect(() => {
    setSlashCommandRoster(editor, composerSlashCommands);
  }, [editor, composerSlashCommands]);
  // 意识指令源($ 触发):复用窗口级已装意识快照,避免输入触发符时同步扫盘。
  // 目录级禁用同判:被禁用的意识不进 $ 菜单(与胶囊 / 发送期展开同源)。
  const isGhostSigil = trigger.kind === 'slash' && trigger.sigil === '$';
  const ghostCommandItems = useMemo(() => {
    if (!isGhostSigil) return [];
    return ghostsForCommand
      .filter((g) => g.enabled && g.manifest.command !== undefined)
      .map(
        (g) =>
          ({
            kind: 'desktop',
            name: g.manifest.command!,
            description: `${g.manifest.name} · ${t('settings.ghosts.commandPaletteTag')}`,
          }) as UnifiedCommand,
      );
  }, [ghostsForCommand, isGhostSigil, t]);
  // 面板显示与键盘导航共用同一份命令源:$ 只列意识,/ 只列技能/命令。
  const paletteCommands = isGhostSigil ? ghostCommandItems : composerSlashCommands;
  const filteredCommands = useMemo(
    () => (trigger.kind === 'slash' ? filterSlashCommands(paletteCommands, trigger.query) : []),
    [paletteCommands, trigger],
  );

  // At-panel scan state
  const [atState, setAtState] = useState<AtPanelState>({ kind: 'loading' });
  const atScanSeqRef = useRef(0);
  const atLastScanQueryRef = useRef('');
  const atQueryScanTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      atScanSeqRef.current += 1;
      if (atQueryScanTimerRef.current !== null) {
        window.clearTimeout(atQueryScanTimerRef.current);
      }
    },
    [],
  );

  const runAtScan = useCallback(
    (query?: string, reservedSeq?: number) => {
      // SSH 远端会话不扫 @ 资源(无隧道)。统一面板仍可打开(动作 + 插件条目),
      // 资源区直接置空 ready,不能留 loading 骨架。
      if (isRemoteSession) {
        atScanSeqRef.current += 1;
        setAtState({ kind: 'ready', items: [], truncated: false });
        return;
      }
      // device-link 远程会话:带 deviceId 经隧道在被控端扫描(workingDir 是被控端路径);
      // 本机会话 deviceId 为 undefined → 本地扫描。
      // 远程**草稿**(NewMakerDraftRoute)此时 sessionId 还是 undefined、但 deviceLinkDeviceId prop 已设——
      // 必须优先用 prop,否则 @ 扫描落到控制端本机 FS(扫到同名目录的错文件),插进首条远程消息的 mention 不可用。
      const remoteDeviceId =
        deviceLinkDeviceId ?? (sessionId ? getSessionDeviceId(sessionId) : undefined);
      const normalizedQuery = query?.trim() ?? '';
      // device-link 纯远程草稿尚未选 workspace 时不能把空路径发给被控端扫描。
      // 空查询仅清空资源区；非空查询仍可经隧道搜索被控端任务历史。
      if (remoteDeviceId && !workingDir?.trim() && !normalizedQuery) {
        atScanSeqRef.current += 1;
        setAtState({ kind: 'ready', items: [], truncated: false });
        return;
      }
      const seq = reservedSeq ?? ++atScanSeqRef.current;
      if (atScanSeqRef.current !== seq) return;
      const preservePreviousItems = reservedSeq !== undefined && !!normalizedQuery;
      atLastScanQueryRef.current = normalizedQuery;
      setAtState((prev) => {
        if (prev.kind === 'ready' && normalizedQuery) {
          return { ...prev, searching: true };
        }
        return { kind: 'loading' };
      });
      scanAtResources(
        workingDir ?? '',
        paletteAgentKind,
        normalizedQuery ? 2000 : AT_MENTION_EMPTY_WORKSPACE_SCAN_CAP,
        normalizedQuery || undefined,
        remoteDeviceId,
        {
          sessionId,
          includeLocalContext: !remoteDeviceId,
          includeTaskHistory: !!normalizedQuery,
          unnamedLabel: t('ccAgent.common.unnamedSession'),
          onPartial: (partial) => {
            if (atScanSeqRef.current !== seq || !partial.success) return;
            setAtState((prev) => ({
              kind: 'ready',
              items:
                preservePreviousItems && prev.kind === 'ready'
                  ? mergeAtResourceItems(prev.items, partial.items)
                  : partial.items,
              truncated: partial.truncated || (prev.kind === 'ready' && prev.truncated),
              searching: true,
            }));
          },
        },
      )
        .then((res) => {
          if (atScanSeqRef.current !== seq) return;
          if (!res.success) {
            // 扫描失败不再整面板报错兜底插件:插件/动作条目独立于 atState,
            // 面板在有其它条目时把错误降级为底部一行 + 重试。
            setAtState({ kind: 'error', message: res.error ?? 'scan failed' });
            return;
          }
          setAtState({
            kind: 'ready',
            items: res.items,
            truncated: res.truncated,
          });
        })
        .catch((err: unknown) => {
          if (atScanSeqRef.current !== seq) return;
          const m = err instanceof Error ? err.message : String(err);
          setAtState({ kind: 'error', message: m });
        });
    },
    [workingDir, paletteAgentKind, isRemoteSession, sessionId, deviceLinkDeviceId, t],
  );

  const syntheticAtQuery = useMemo(
    () =>
      editor && syntheticAtAnchor !== null
        ? (() => {
            const rangeEnd = syntheticAtRangeEndRef.current;
            return rangeEnd == null
              ? null
              : deriveSyntheticAtQuery(editor, syntheticAtAnchor, rangeEnd);
          })()
        : null,
    [editor, syntheticAtAnchor, trigger],
  );
  useEffect(() => {
    if (syntheticAtAnchor === null || syntheticAtQuery !== null) return;
    setSyntheticAtAnchor(null);
  }, [setSyntheticAtAnchor, syntheticAtAnchor, syntheticAtQuery]);

  // synthetic 是一次显式激活：打开期间即使光标前仍能匹配 `/` / `@` typed run，
  // 也应继续由「+」锚点解释 query；否则刚打开就会被旧 trigger 抢回并立即收起。
  const effectiveAt = resolveComposerAtActivation({
    typed: trigger.kind === 'at' ? { from: trigger.from, query: trigger.query } : null,
    syntheticAnchor: syntheticAtAnchor,
    syntheticQuery: syntheticAtQuery,
  });
  const atQuery = effectiveAt?.query ?? '';

  const runNewGoalAction = useCallback(() => {
    const activeEditor = editorRef.current;
    const draftText =
      activeEditor && !activeEditor.isDestroyed
        ? serializeEditorContent(activeEditor).text.trim()
        : '';
    if (inSessionGoalEnabled) {
      setNewGoalInitial(draftText);
      setNewGoalOpen(true);
      return;
    }
    onNewGoal?.(draftText);
  }, [inSessionGoalEnabled, onNewGoal]);

  const composerSuggestionActions = useMemo<ComposerSuggestionAction[]>(() => {
    const actions: ComposerSuggestionAction[] = [];
    if (localAttachmentPickerEnabled) {
      actions.push({
        id: 'attach-files',
        label: t('extraDirs.addFiles'),
        disabled: composerMutationLocked,
        run: () => suggestionFileInputRef.current?.click(),
      });
    }
    if (inSessionGoalEnabled || onNewGoal) {
      actions.push({
        id: 'new-goal',
        label: t('goal.newGoalMenuItem'),
        disabled: composerMutationLocked,
        run: runNewGoalAction,
      });
    }
    if (planModeEntry) {
      actions.push({
        id: 'plan-mode',
        label: t('planMode.menuItem'),
        checked: planModeEntry.enabled,
        disabled: composerMutationLocked,
        run: () => planModeEntry.onToggle(!planModeEntry.enabled),
      });
    }
    if (collaboration) {
      const policyDisabled = collaboration.disabled === true;
      const retryable = policyDisabled && !!collaboration.onDisabledActivate;
      actions.push({
        id: 'collaboration',
        label: t('newChat.collaboration.modeLabel'),
        checked: collaboration.enabled,
        disabled: composerMutationLocked || (policyDisabled && !retryable),
        disabledReason: collaboration.disabledReason,
        run: () => {
          if (policyDisabled) {
            collaboration.onDisabledActivate?.();
            return;
          }
          if (collaboration.enabled) {
            collaboration.onChange({ enabled: false, worker: collaboration.worker });
            return;
          }
          if (collaboration.onOpenDetails) {
            collaboration.onOpenDetails();
            return;
          }
          collaboration.onChange({ enabled: true, worker: collaboration.worker });
        },
      });
    }
    if (onExtraDirsChange) {
      const currentExtraDirs = extraDirs ?? [];
      actions.push({
        id: 'add-extra-dir',
        label:
          currentExtraDirs.length >= MAX_EXTRA_DIRS
            ? t('extraDirs.atLimit', { max: MAX_EXTRA_DIRS })
            : t('extraDirs.add'),
        disabled: composerMutationLocked || currentExtraDirs.length >= MAX_EXTRA_DIRS,
        run: () => {
          void pickAndAddExtraDir({
            extraDirs: currentExtraDirs,
            workingDir,
            onChange: onExtraDirsChange,
            confirm: confirmDialog,
            parentDirectoryConfirm: {
              title: t('extraDirs.parentConfirmTitle'),
              description: (path) => t('extraDirs.parentConfirmDescription', { path }),
              confirmText: t('extraDirs.parentConfirmAccept'),
              cancelText: t('extraDirs.parentConfirmCancel'),
            },
          });
        },
      });
    }
    return actions;
  }, [
    collaboration,
    composerMutationLocked,
    confirmDialog,
    extraDirs,
    inSessionGoalEnabled,
    localAttachmentPickerEnabled,
    onExtraDirsChange,
    onNewGoal,
    planModeEntry,
    runNewGoalAction,
    t,
    workingDir,
  ]);

  const atResources = useMemo(() => (atState.kind === 'ready' ? atState.items : []), [atState]);

  const filteredAt = useMemo(
    () =>
      effectiveAt
        ? buildComposerSuggestionEntries({
            query: atQuery,
            actions: composerSuggestionActions,
            resources: atResources,
            plugins: pluginSuggestions,
          })
        : [],
    [atQuery, atResources, composerSuggestionActions, effectiveAt, pluginSuggestions],
  );

  // When `@` panel opens, rescan so newly created files/agents show immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首次打开只按 activation/from/context 扫一次；query 变化由下方 debounce effect 独立负责，避免每次按键立即重复扫描。
  useEffect(() => {
    if (!effectiveAt) return;
    runAtScan(atQuery);
  }, [effectiveAt?.activation, effectiveAt?.from, runAtScan, workingDir]);

  // Focused row index for each palette
  const [slashFocus, setSlashFocus] = useState(0);
  const [atFocus, setAtFocus] = useState(0);

  // Keep keyboard focus on an executable row when filtering or runtime status changes.
  useEffect(() => {
    setSlashFocus((current) =>
      current >= filteredCommands.length ||
      (filteredCommands[current] && isSlashCommandUnavailable(filteredCommands[current]))
        ? firstAvailableSlashCommandIndex(filteredCommands)
        : current,
    );
  }, [filteredCommands]);
  useEffect(() => {
    if (
      atFocus >= filteredAt.length ||
      (filteredAt[atFocus] && isComposerSuggestionEntryDisabled(filteredAt[atFocus]))
    ) {
      setAtFocus(firstEnabledSuggestionIndex(filteredAt));
    }
  }, [filteredAt, atFocus]);
  useEffect(() => {
    if (atQueryScanTimerRef.current !== null) {
      window.clearTimeout(atQueryScanTimerRef.current);
      atQueryScanTimerRef.current = null;
    }
    if (!effectiveAt) return;
    const normalizedQuery = atQuery.trim();
    if (normalizedQuery === atLastScanQueryRef.current) return;
    atLastScanQueryRef.current = normalizedQuery;
    const seq = ++atScanSeqRef.current;
    setAtState((prev) => (prev.kind === 'ready' ? { ...prev, searching: true } : prev));
    atQueryScanTimerRef.current = window.setTimeout(
      () => {
        atQueryScanTimerRef.current = null;
        runAtScan(normalizedQuery, seq);
      },
      normalizedQuery ? 200 : 0,
    );
    return () => {
      if (atQueryScanTimerRef.current !== null) {
        window.clearTimeout(atQueryScanTimerRef.current);
        atQueryScanTimerRef.current = null;
      }
    };
  }, [effectiveAt?.activation, effectiveAt?.from, workingDir, atQuery, runAtScan]);

  // ── Panel-close flags (Esc cancelation) ────────────────────────────
  // Once the user cancels a panel (Esc), we must NOT reopen it until the
  // user either (a) deletes the trigger char or (b) types a fresh one.
  // We track "suppressed trigger position" — if the active trigger's
  // anchor matches this, we treat the panel as closed.
  const [suppressedSlashAt, setSuppressedSlashAt] = useState<number | null>(null);
  const [suppressedAtAt, setSuppressedAtAt] = useState<number | null>(null);
  // Clear suppression when the trigger goes away naturally (caret moves
  // out of the run, chars typed past a whitespace, etc.)
  useEffect(() => {
    if (trigger.kind === 'none') {
      setSuppressedSlashAt(null);
      setSuppressedAtAt(null);
      return;
    }
    if (trigger.kind === 'slash' && suppressedSlashAt !== trigger.from) {
      setSuppressedSlashAt(null);
    }
    if (trigger.kind === 'at' && suppressedAtAt !== trigger.from) {
      setSuppressedAtAt(null);
    }
  }, [trigger, suppressedSlashAt, suppressedAtAt]);

  const slashOpen = trigger.kind === 'slash' && suppressedSlashAt !== trigger.from;
  const typedAtOpen =
    effectiveAt?.activation === 'typed' && !isRemoteSession && suppressedAtAt !== effectiveAt.from;
  const syntheticAtOpen = effectiveAt?.activation === 'synthetic';
  const atOpen = typedAtOpen || syntheticAtOpen;

  const closeAtPanel = useCallback(() => {
    if (effectiveAt?.activation === 'typed') {
      setSuppressedAtAt(effectiveAt.from);
    } else {
      setSyntheticAtAnchor(null);
    }
  }, [effectiveAt, setSyntheticAtAnchor]);

  useEffect(() => {
    if (!slashOpen) return;
    reloadSlashCommands({ forceReload: true });
  }, [slashOpen, reloadSlashCommands]);
  useEffect(() => {
    if (!slashOpen) {
      piRuntimeRetryRef.current = 0;
      return;
    }
    if (paletteAgentKind !== 'pi' || !sessionId) return;
    const waitingForRuntimeCommands = piRuntimeCommandStatus === 'pending';
    const waitingForProjectSkills = hasUnavailableProjectSkillPreview(mergedCommands);
    if (!waitingForRuntimeCommands && !waitingForProjectSkills) return;
    const attempt = piRuntimeRetryRef.current;
    if (attempt >= PI_RUNTIME_SKILL_RETRY_DELAYS_MS.length) return;
    piRuntimeRetryRef.current = attempt + 1;
    const timer = window.setTimeout(() => {
      reloadSlashCommands({ forceReload: true });
    }, PI_RUNTIME_SKILL_RETRY_DELAYS_MS[attempt]);
    return () => window.clearTimeout(timer);
  }, [
    mergedCommands,
    paletteAgentKind,
    piRuntimeCommandStatus,
    reloadSlashCommands,
    sessionId,
    slashOpen,
  ]);

  // ── Panel → editor bridge for keyboard nav ─────────────────────────
  // The editor's `handleKeyDown` fires before React re-renders, so we need
  // a ref that always points at the freshest panel handler.
  const panelBridgeRef = useRef<{
    captureKey: (e: KeyboardEvent) => boolean;
  } | null>(null);

  useEffect(() => {
    panelBridgeRef.current = {
      captureKey: (e) => {
        if (e.isComposing) return false;
        if (!slashOpen && !atOpen) return false;
        switch (e.key) {
          case 'ArrowDown':
            if (slashOpen && filteredCommands.length > 0) {
              setSlashFocus((i) => nextAvailableSlashCommandIndex(filteredCommands, i, 1));
              return true;
            }
            if (atOpen && filteredAt.length > 0) {
              setAtFocus((i) => nextEnabledSuggestionIndex(filteredAt, i, 1));
              return true;
            }
            return false;
          case 'ArrowUp':
            if (slashOpen && filteredCommands.length > 0) {
              setSlashFocus((i) => nextAvailableSlashCommandIndex(filteredCommands, i, -1));
              return true;
            }
            if (atOpen && filteredAt.length > 0) {
              setAtFocus((i) => nextEnabledSuggestionIndex(filteredAt, i, -1));
              return true;
            }
            return false;
          case 'Enter':
          case 'Tab':
            if (slashOpen) {
              const focusedCommand = filteredCommands[slashFocus];
              if (!focusedCommand) {
                if (trigger.kind === 'slash') setSuppressedSlashAt(trigger.from);
                return true;
              }
              if (isSlashCommandUnavailable(focusedCommand)) {
                setSlashFocus(firstAvailableSlashCommandIndex(filteredCommands));
                if (!hasAvailableSlashCommand(filteredCommands) && trigger.kind === 'slash') {
                  setSuppressedSlashAt(trigger.from);
                }
                return true;
              }
              insertSlashCommand(focusedCommand);
              return true;
            }
            if (
              atOpen &&
              filteredAt[atFocus] &&
              !isComposerSuggestionEntryDisabled(filteredAt[atFocus])
            ) {
              void handleComposerSuggestionSelect(filteredAt[atFocus]);
              return true;
            }
            return false;
          case 'Escape':
            if (slashOpen && trigger.kind === 'slash') {
              setSuppressedSlashAt(trigger.from);
              return true;
            }
            if (atOpen) {
              closeAtPanel();
              return true;
            }
            return false;
          case 'Backspace':
            if (syntheticAtOpen && !atQuery) {
              closeAtPanel();
              return true;
            }
            return false;
          case 'ArrowLeft':
            return false;
          default:
            return false;
        }
      },
    };
  });

  // ── Palette insertions ─────────────────────────────────────────────
  const insertSlashCommand = useCallback(
    (cmd: UnifiedCommand) => {
      if (
        !editor ||
        editor.isDestroyed ||
        trigger.kind !== 'slash' ||
        composerMutationLockedRef.current ||
        editor.view.composing ||
        isSlashCommandUnavailable(cmd)
      ) {
        return;
      }
      const { from } = trigger;
      // Replace the WHOLE slash-run, not just up-to-caret: the user may
      // have moved the caret back inside the run (e.g. `/compa|ct`) and
      // still hit Enter. Extend `to` to the first whitespace / end of
      // paragraph after the `/`.
      const $from = editor.state.doc.resolve(from);
      const parent = $from.parent;
      const parentStart = $from.start();
      let runEnd = from + 1; // skip the `/` itself
      // Walk forward through inline nodes until whitespace / chip boundary
      const offset = from - parentStart + 1;
      parent.forEach((child, childOffset) => {
        // childOffset is relative to parentStart
        if (childOffset + child.nodeSize <= offset) return;
        if (child.type.name === 'mentionChip') return; // chip boundary
        if (!child.isText) return;
        const localStart = Math.max(0, offset - childOffset);
        const text = child.text ?? '';
        for (let i = localStart; i < text.length; i++) {
          if (/\s/.test(text[i])) {
            runEnd = parentStart + childOffset + i;
            return;
          }
        }
        runEnd = parentStart + childOffset + text.length;
      });
      let planModeCommandConsumed = false;
      const applied = editor
        .chain()
        .focus()
        .command(({ tr }) => {
          planModeCommandConsumed = consumePlanModeComposerCommand(
            tr,
            from,
            runEnd,
            cmd,
            planModeCommandAvailable && trigger.sigil === '/',
          );
          if (planModeCommandConsumed) return true;
          if (trigger.sigil === '$') {
            // 意识指令:纯文本 `$命令 `(不建 chip)——发送期由 expandGhostCommand
            // 识别并追加机器指令,序列化零特判。
            tr.replaceWith(from, runEnd, editor.schema.text(`$${cmd.name} `));
          } else {
            // 展示层写入人类名(`/git`);Pi 线路名(`/skill:git`)只在发送期改写。
            replaceSlashCommandRunWithText(
              tr,
              editor.schema,
              from,
              runEnd,
              cmd.name,
            );
          }
          return true;
        })
        .run();
      if (applied && planModeCommandConsumed) {
        planModeEntry?.onToggle(!planModeEntry.enabled);
      }
    },
    [editor, planModeCommandAvailable, planModeEntry, trigger],
  );

  const resolveEffectiveAtRange = useCallback((): { from: number; to: number } | null => {
    if (!editor || !effectiveAt) return null;
    const { from } = effectiveAt;

    // synthetic query 没有文档内触发符，替换范围由 transaction mapping 单独跟踪。
    // 不能像 typed `@` 一样向后扫到空白，否则在已有单词中间激活并输入过滤词时
    // 会把激活前就存在的单词后缀一起删除。
    if (effectiveAt.activation === 'synthetic') {
      const to = syntheticAtRangeEndRef.current;
      return to !== null && to >= from ? { from, to } : null;
    }

    // Extend replace-range to the end of the complete query run (up to
    // whitespace / chip boundary / end of paragraph). The caret may sit
    // inside either a typed `@query` or a synthetic `query`; selecting an
    // entry must not leave the suffix after the caret behind.
    let $from;
    try {
      $from = editor.state.doc.resolve(from);
    } catch {
      return null;
    }
    const parent = $from.parent;
    const parentStart = $from.start();
    const triggerOffset = 1;
    let runEnd = from + triggerOffset;
    const offset = from - parentStart + triggerOffset;
    let stopped = false;
    parent.forEach((child, childOffset) => {
      if (stopped || childOffset + child.nodeSize <= offset) return;
      if (child.type.name === 'mentionChip' || !child.isText) {
        stopped = true;
        return;
      }
      const localStart = Math.max(0, offset - childOffset);
      const text = child.text ?? '';
      for (let i = localStart; i < text.length; i++) {
        if (/\s/.test(text[i])) {
          runEnd = parentStart + childOffset + i;
          stopped = true;
          return;
        }
      }
      runEnd = parentStart + childOffset + text.length;
    });
    return { from, to: runEnd };
  }, [editor, effectiveAt]);

  const insertAtResource = useCallback(
    (selectedItem: AtResourceItem) => {
      if (!editor || !effectiveAt) return;
      const range = resolveEffectiveAtRange();
      if (!range) return;
      const { from, to } = range;
      // `file-picker` remains in the shared AtResourceItem protocol for
      // compatibility, but the unified composer no longer assembles that
      // duplicate row. Keep a defensive guard for exhaustive type narrowing.
      if (selectedItem.type === 'file-picker') return;
      if (selectedItem.type === 'plugin-command') {
        if (!selectedItem.pluginId) return;
        const ghost = installedGhostsRef.current.find(
          (candidate) => candidate.manifest.id === selectedItem.pluginId,
        );
        if (!ghost?.enabled) return;

        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(from, to);
            return true;
          })
          .run();

        if (ghost.manifest.command) {
          placeGhostAtComposerStart(editor, ghost, installedGhostsRef.current);
        } else {
          const hostCap = hostCapabilityForGhost(ghost);
          if (hostCap) {
            placeHostCapabilityAtComposerStart(editor, ghost, installedGhostsRef.current);
          }
        }

        closeAtPanel();
        return;
      }
      const directoryQuery = getAtDirectoryCompletionQuery(selectedItem);
      if (directoryQuery) {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.replaceWith(
              from,
              to,
              editor.schema.text(
                effectiveAt.activation === 'typed' ? `@${directoryQuery}` : directoryQuery,
              ),
            );
            return true;
          })
          .run();
        if (effectiveAt.activation === 'synthetic') setSyntheticAtAnchor(from);
        setAtFocus(0);
        return;
      }
      const attrs: MentionChipAttrs = {
        kind: selectedItem.type,
        label: selectedItem.name.replace(/\.md$/, ''),
        // For agent chips we stash the bare name so serialization can
        // degrade to `@{name}` if the host can't map it; for files/dirs
        // we stash the relative path as-is.
        path: selectedItem.type === 'agent' ? selectedItem.name : selectedItem.relPath,
        ...(selectedItem.type === 'plugin-resource' && selectedItem.sourceLabel
          ? { sourceLabel: selectedItem.sourceLabel }
          : {}),
        ...(selectedItem.type === 'plugin-resource' && selectedItem.description
          ? { sourceDescription: selectedItem.description }
          : {}),
      };
      // For agent: store final canonical path in `path` if we know it maps
      // to an existing file. Here we DO know (we just scanned), so use the
      // canonical form.
      if (selectedItem.type === 'agent') {
        attrs.path = selectedItem.relPath; // .claude/agents/<name>.md
      } else if (selectedItem.type === 'session') {
        attrs.label = sanitizeSessionChipTitle(selectedItem.name);
        attrs.titled = true;
      }
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          const node = editor.schema.nodes.mentionChip.create(attrs);
          // Replace `@query` run with chip + a single space after
          tr.replaceWith(from, to, [node, editor.schema.text(' ')]);
          return true;
        })
        .run();
      closeAtPanel();
    },
    [
      closeAtPanel,
      editor,
      effectiveAt,
      resolveEffectiveAtRange,
      setSyntheticAtAnchor,
    ],
  );

  const handleComposerSuggestionSelect = useCallback(
    (entry: ComposerSuggestionEntry) => {
      if (isComposerSuggestionEntryDisabled(entry)) return;
      if (entry.kind === 'resource') {
        void insertAtResource(entry.item);
        return;
      }
      if (!editor) return;
      const range = resolveEffectiveAtRange();
      if (!range) return;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.delete(range.from, range.to);
          return true;
        })
        .run();
      closeAtPanel();
      entry.action.run();
    },
    [closeAtPanel, editor, insertAtResource, resolveEffectiveAtRange],
  );

  const handleComposerSuggestionOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setSyntheticAtAnchor(null);
        return;
      }
      if (!editor || editor.isDestroyed || composerMutationLocked) return;
      if (trigger.kind === 'slash') {
        setSuppressedSlashAt(trigger.from);
      } else if (trigger.kind === 'at') {
        setSuppressedAtAt(trigger.from);
      }
      setSyntheticAtAnchor(editor.state.selection.from);
      setAtFocus(0);
      editor.commands.focus();
    },
    [composerMutationLocked, editor, setSyntheticAtAnchor, trigger],
  );
  const composerSuggestionFocusTarget = useCallback(() => editor?.view.dom ?? null, [editor]);

  // ── Send / Stop wiring ─────────────────────────────────────────────
  const dispatchSendInFlightKeysRef = useRef(new Set<string>());
  const dispatchSendRef = useRef<(deliveryMode?: MessageDeliveryMode) => void | Promise<void>>(
    () => {},
  );
  const dispatchSend = useCallback(
    async (deliveryMode: MessageDeliveryMode = 'queue') => {
      if (!editor) return;
      if (disabled) return;
      // React 的 disabled 状态可能尚未完成下一帧渲染；同步读协调器兜住点击、快捷键、
      // 语音发送等所有入口，确保 host 已登记切换意图后才允许 maker:send。
      if (sessionId && hasPendingAgentSendDispatch(sessionId)) return;
      const sourceSessionId = sessionId;
      const sourceStorageKey = storageKey;
      const sendInFlightKey = sourceStorageKey ?? sourceSessionId ?? '__draft__';
      if (dispatchSendInFlightKeysRef.current.has(sendInFlightKey)) return;
      const optimisticallyClearRemoteComposer = Boolean(deviceLinkDeviceId && sourceSessionId);
      // Device-link sends freeze the entire composer at click time. Any remote
      // reference hydration happens against this immutable payload after the
      // live composer is cleared, so the user can immediately type the next
      // message without it leaking into or being cleared by this send.
      const serializedAtClick = optimisticallyClearRemoteComposer
        ? serializeEditorContent(editor)
        : null;
      const documentBeforeOptimisticClear = optimisticallyClearRemoteComposer
        ? editor.getJSON()
        : null;
      const attachmentsBeforeOptimisticClear = optimisticallyClearRemoteComposer
        ? [...latestAttachmentsRef.current]
        : [];
      const commentsBeforeOptimisticClear = optimisticallyClearRemoteComposer
        ? [...browserCommentsRef.current]
        : [];
      const dataOwnerAtOptimisticClear = optimisticallyClearRemoteComposer
        ? getDataOwnerGeneration()
        : null;
      const finishAgentSendDispatch = sourceSessionId
        ? tryBeginAgentSendDispatch(sourceSessionId)
        : () => {};
      if (!finishAgentSendDispatch) return;
      draftSaveSchedulerRef.current?.flush();
      dispatchSendInFlightKeysRef.current.add(sendInFlightKey);
      // 发送新消息时立即递增 turnGen，让任何还未落地的旧 turn 预测结果失效。
      // 必须在所有异步操作（resolveSessionMessageReferencesForSend / effort settle）
      // 之前递增，防止旧预测在 reference 解析等异步等待期间落地到输入框。
      turnGenRef.current += 1;
      // Local/SSH sends keep the live composer while references and runtime
      // settings settle; remote sends must stay editable after their
      // click-time snapshot is cleared. A background source send after a
      // session switch must not lock the newly restored composer.
      const lockCurrentComposer =
        !optimisticallyClearRemoteComposer &&
        storageKeyForDraftRef.current === sourceStorageKey;
      if (lockCurrentComposer) {
        captureSendFocusForRestore();
        setSendDispatchInFlight(true);
      }
      try {
        let serializedContent = serializedAtClick;
        let frozenVoiceSend = frozenVoiceSendRef.current;
        if (!serializedContent) {
          if (sourceSessionId && hasPendingAgentSwitchOperation(sourceSessionId)) return;
          const editorOwnsSource = editorOwnsSourceDraft({
            editorDestroyed: editor.isDestroyed,
            editorStorageKey: storageKeyForDraftRef.current,
            sourceStorageKey,
          });
          if (editorOwnsSource) {
            await resolveSessionMessageReferencesForSend(editor);
            if (sourceSessionId && hasPendingAgentSwitchOperation(sourceSessionId)) return;
            if (
              editorOwnsSourceDraft({
                editorDestroyed: editor.isDestroyed,
                editorStorageKey: storageKeyForDraftRef.current,
                sourceStorageKey,
              })
            ) {
              serializedContent = serializeEditorContent(editor);
              if (frozenVoiceSendRef.current?.sourceStorageKey === sourceStorageKey) {
                frozenVoiceSendRef.current = null;
              }
            }
          }
          // Switch during hydration may have just frozen the source send.
          frozenVoiceSend = frozenVoiceSendRef.current;
          if (!serializedContent) {
            if (
              !frozenVoiceSend ||
              frozenVoiceSend.kind !== 'send' ||
              frozenVoiceSend.sourceStorageKey !== sourceStorageKey
            ) {
              return;
            }
            const submitted = voiceInput.getLastSubmittedText();
            const refined = voiceInput.getLastRefinement()?.refinedText ?? '';
            serializedContent = {
              ...frozenVoiceSend.serialized,
              text: applyVoiceResultToSerializedText(
                frozenVoiceSend.serialized.text,
                submitted,
                refined,
              ),
            };
            frozenVoiceSendRef.current = null;
          }
        }
        const {
          text: editorText,
          mentions,
          hasQuotes,
          agentReferences: serializedAgentReferences,
          pastedTextRanges,
          slashCommandRanges,
          hostCapability,
        } = serializedContent;
        let agentReferences = serializedAgentReferences;
        const sourceDraftExtras =
          sourceStorageKey !== undefined ? getComposerDraft(sourceStorageKey) : undefined;
        const frozenExtras =
          frozenVoiceSend?.sourceStorageKey === sourceStorageKey ? frozenVoiceSend : null;
        const sourceOwnedExtras = resolveSourceOwnedComposerExtras({
          editorOwnsSource: editorOwnsSourceDraft({
            editorDestroyed: editor.isDestroyed,
            editorStorageKey: storageKeyForDraftRef.current,
            sourceStorageKey,
          }),
          liveAttachments: latestAttachmentsRef.current,
          liveComments: browserCommentsRef.current,
          sourceAttachments: frozenExtras?.attachments ?? sourceDraftExtras?.attachments,
          sourceComments: frozenExtras?.comments ?? sourceDraftExtras?.browserComments,
        });
        const attachmentsForSend = optimisticallyClearRemoteComposer
          ? attachmentsBeforeOptimisticClear
          : sourceOwnedExtras.attachments;
        const commentsForSend = optimisticallyClearRemoteComposer
          ? commentsBeforeOptimisticClear
          : sourceOwnedExtras.comments;
        if (
          !hostCapability &&
          isPlanModeComposerCommandText(
            editorText,
            planModeEntry !== undefined,
            slashCommandsReady ? mergedCommands : null,
          )
        ) {
          const editorOwnsSource = editorOwnsSourceDraft({
            editorDestroyed: editor.isDestroyed,
            editorStorageKey: storageKeyForDraftRef.current,
            sourceStorageKey,
          });
          const existingDraft = sourceStorageKey ? getComposerDraft(sourceStorageKey) : undefined;
          // Capture this before consuming `/plan`, which clears the live editor.
          const draftText = planModeComposerDraftText(
            editorOwnsSource,
            editorOwnsSource ? editor.getJSON() : null,
            existingDraft?.text,
            true,
          );
          if (editorOwnsSource) {
            planModeEntry?.onToggle(!planModeEntry.enabled);
            isRestoringRef.current = true;
            try {
              editor.commands.clearContent(true);
            } finally {
              isRestoringRef.current = false;
            }
            historyIndexRef.current = -1;
            hydratedHistoryDocumentRef.current = null;
            draftRef.current = null;
          }
          if (sourceStorageKey) {
            if (
              shouldPreservePlanModeComposerDraft(attachmentsForSend.length, commentsForSend.length)
            ) {
              saveComposerDraft(
                sourceStorageKey,
                {
                  text: draftText,
                  attachments: attachmentsForSend,
                  quotes: existingDraft?.quotes ?? [],
                  browserComments: commentsForSend,
                },
                { silent: true },
              );
            } else {
              clearComposerDraft(sourceStorageKey);
            }
          }
          return;
        }
        // composerQuote 在其正文位置序列化成 markdown blockquote,支持引用与回复交错。
        // browser-comment-chip:页面评论序列化为 `# Browser comments:` 段拼在正文后
        // (截图在下方并入 filesToSend,与文本块里的 "attached as a labeled image"
        // caption 对应)。
        const text = formatBrowserCommentsForSend(commentsForSend, editorText);
        // Allow send if there is text, attachments, or a host-capability chip
        // (host-capability chips carry routing metadata but no visible text).
        if (!text && attachmentsForSend.length === 0 && !hostCapability) return;

        // device-link 模型清单未结算或真实读取失败时禁止发送。模型选择器会同步显示
        // loading / error；这里兜住快捷键、语音等间接派发入口，避免旧快照继续路由。
        if (remoteModelListBlocked) {
          if (remoteModelListStatus === 'error') {
            toast.error(t('newChat.modelSelector.remoteLoadFailed'));
          } else {
            toast.warning(t('newChat.modelSelector.remoteLoading'));
          }
          return;
        }

        // 预检:会话显式选中的来源已断开 → 发送前拦截。main 侧懒创建会从 DB 水合 providerId
        // 直接 LAZY_CREATE_FAILED(renderer 的 sendProviderId=null 救不了已建会话),所以这里
        // 弹窗给出明确原因 + 去设置入口,而不是让请求出去撞一个原始错误码。
        // Send 按钮已被 selectedSourceDisconnected 禁用,此 guard 兜底覆盖间接派发路径。
        if (selectedSourceDisconnected) {
          const goConnect = await confirmDialog({
            title: t('newChat.sourceDisconnected.title'),
            description: t('newChat.sourceDisconnected.description'),
            confirmText: t('newChat.sourceDisconnected.connect'),
            cancelText: t('logic.confirm.cancel'),
            autoFocusConfirm: true,
          });
          if (goConnect) navigate('/settings?tab=providers');
          return;
        }

        // 预检(通用、provider-aware): 当前模型在当前 agent 下「一个已连接来源都没有」
        // 时,不把请求扔给 SDK 等 401,改弹确认框引导用户去「设置 → 模型供应商」连接。
        // 取代过去仅 cc + 仅 api_key 的写法 —— 现在 OAuth / XD 网关 / 未来自定义供应商
        // 都按 ProviderView.connected 统一计入(chatEligibleSourcesForModel onlyConnected),
        // 未来加新供应商无需改这里。判定数据来自本地 IPC(useProviders),无网络往返、
        // ~ms 级。只有「确实零已连接来源」才拦截;≥1 个直接放行(无弹窗)。
        // currentModelAgentKind 解析不出(罕见:capabilities 未就绪)时不拦,交给下游
        // 处理,不误伤。用 chatEligibleSourcesForModel 而非裸 sourcesForModel:
        // 非聊天来源不该被当成"可以发"放行(issue #882 第 3 点,2026-07 review)。
        if (
          enforceConnectedSourceGate &&
          currentModelAgentKind &&
          // 旧被控端明确不支持 provider:list 时，控制端没有可检查的来源镜像；
          // 与模型列表一致交给 capabilities + 被控端发送链路做兼容回退。
          !(deviceLinkDeviceId && remoteProviders.unsupported)
        ) {
          // 已建会话按实际路由口径判(includeDisabled,与上方 hasConnectedSendSource
          // 同则):运行中会话不因停用打断,最终 preflight 若按准入 rail 判会在全停时
          // 弹「去连接来源」把继续发送挡死(PR #744 review 第十八轮)。草稿保持准入口径。
          const connectedSources = chatEligibleSourcesForModel(
            providers,
            activeModel,
            currentModelAgentKind,
            {
              onlyConnected: true,
              includeDisabled: !!sessionId,
            },
          );
          if (connectedSources.length === 0) {
            const goConnect = await confirmDialog({
              title: t('newChat.noProvider.title'),
              description: t('newChat.noProvider.description'),
              confirmText: t('newChat.noProvider.connect'),
              cancelText: t('logic.confirm.cancel'),
              autoFocusConfirm: true,
            });
            if (goConnect) navigate('/settings?tab=providers');
            return;
          }
        }

        // 评论截图并入发送附件(item.screenshot 即 AttachedFile,顺序在用户附件后,
        // 与评论块的编号 caption 对应)。
        const commentScreenshots = commentsForSend.map((c) => c.screenshot);
        const filesToSend =
          attachmentsForSend.length > 0 || commentScreenshots.length > 0
            ? [...attachmentsForSend, ...commentScreenshots]
            : undefined;
        const mentionsToSend = mentions.length > 0 ? mentions : undefined;
        // 意识 $指令展开(C3d 双触发):`$画图 ...` 开头且命中已唤醒意识时,
        // 追加"必须走 cindy 总机"的机器指令;未命中原样发送。
        // 读取 useInstalledGhosts 的最新窗口级快照。ghosts:changed 会原子更新
        // 该快照;发送路径无需同步 IPC,仍按当前工作目录执行同一禁用判定。
        const eligibleGhosts = filterGhostsForWorkdir(
          installedGhostsRef.current,
          workingDirRef.current,
        );
        const ghostCommandWord = parseGhostCommandWord(text);
        // Host-capability 芯片同样计入最近插件使用(与 $command 路径对齐)：
        // 从 eligibleGhosts 解析出仍有效(启用 + workdir + manifest 一致 + 非远程会话)
        // 的 host 插件对象交给 usedGhost，使发送后 markUsed 能更新该插件的最近使用排序。
        const hostCapabilityGhost =
          hostCapability !== undefined && !remoteHostId && deviceLinkDeviceId === null
            ? eligibleGhosts.find(
                (g) =>
                  g.manifest.id === hostCapability.ghostId &&
                  g.enabled &&
                  hostCapabilityForGhost(g) === hostCapability.capability,
              )
            : undefined;
        const usedGhost = ghostCommandWord
          ? findGhostByCommand(eligibleGhosts, ghostCommandWord)
          : (hostCapabilityGhost ?? null);
        const textToSend = expandGhostCommand(text, eligibleGhosts);
        // 发送前校验 host-capability 插件仍处于启用且 workdir 可用的状态。
        // 若用户在插入芯片后停用/卸载了该插件，芯片内序列化的 ghostId/capability
        // 已失时效，不应再展开 Host 路由指令（fail-closed）。
        // 额外收口(remote session + manifest 一致性)：
        //   - SSH(remoteHostId)/device-link(deviceLinkDeviceId) 远程会话不展开控制端 Host 路由；
        //     deviceLinkDeviceId 仅 null（已确认本机）放行，undefined（所有权未解析）fail-closed；
        //   - 插件更新后芯片保留旧 capability 时，manifest 当前声明必须仍匹配才放行。
        const isHostCapabilityValid = hostCapabilityGhost !== undefined;
        // 校验失败(插件停用/卸载/超 workdir/远程会话)时不静默退化为普通文本发送:
        // 芯片承载的是用户选择的能力路由意图,退化发送会丢失 Host 路由,仅芯片消息还会
        // 以空文本派发,静默丢弃用户意图。直接提示并拦截,让用户修复插件状态后重发。
        if (hostCapability && !isHostCapabilityValid) {
          toast.warning(t('newChat.pluginSetup.error.TARGET_UNAVAILABLE'));
          return;
        }
        const routedText = hostCapability
          ? expandHostCapabilityInvocation(textToSend, hostCapability, hostCapability.name)
          : textToSend;
        const sendSnapshot = captureComposerSendSnapshot(
          editor.getJSON(),
          latestAttachmentsRef.current,
          browserCommentsRef.current,
        );
        let recentUsageMarked = false;
        const markRecentPluginUsage = () => {
          if (!usedGhost || recentUsageMarked) return;
          recentUsageMarked = true;
          void window.electronAPI.ghosts.markUsed(usedGhost.manifest.id).catch((error) => {
            log.warn(
              'failed to persist recent Plugin usage:',
              error instanceof Error ? error.message : String(error),
            );
          });
        };
        const clearSentComposer = (options?: { preserveNewerContent?: boolean }) => {
          const editorOwnsSource = editorOwnsSourceDraft({
            editorDestroyed: editor.isDestroyed,
            editorStorageKey: storageKeyForDraftRef.current,
            sourceStorageKey,
          });
          const isCurrentComposer =
            latestStorageKeyRef.current === sourceStorageKey && editorOwnsSource;
          // Local/SSH sends keep the live composer until onSend is accepted.
          // If the user kept typing on the same session, leave that newer
          // draft untouched. A route switch is not "newer input": the reused
          // editor may still hold the source document because restoreNextDraft
          // was deferred for voice stop/refine/send.
          if (
            !optimisticallyClearRemoteComposer &&
            isCurrentComposer &&
            !isComposerSendSnapshotCurrent(
              sendSnapshot,
              editor.getJSON(),
              latestAttachmentsRef.current,
              browserCommentsRef.current,
            )
          ) {
            return;
          }
          if (!isCurrentComposer) {
            if (!optimisticallyClearRemoteComposer) {
              if (editorOwnsSource) {
                isRestoringRef.current = true;
                try {
                  editor.commands.clearContent(true);
                } finally {
                  isRestoringRef.current = false;
                }
                historyIndexRef.current = -1;
                hydratedHistoryDocumentRef.current = null;
                draftRef.current = null;
              }
              if (sourceStorageKey) clearComposerDraft(sourceStorageKey);
              return;
            }
            if (!options?.preserveNewerContent || !sourceStorageKey) {
              if (sourceStorageKey) clearComposerDraft(sourceStorageKey);
              return;
            }
            // The original ChatInput may have unmounted after a session switch,
            // but the old storage slot can already contain newer text/files from
            // another mounted composer. Remove only the click-time fragment;
            // never clear that whole slot from a stale continuation.
            const currentDraft = getComposerDraft(sourceStorageKey);
            if (!currentDraft) return;
            const next = removeRemoteOptimisticDraftFragment(
              {
                text: currentDraft.text,
                attachments: currentDraft.attachments,
                browserComments: currentDraft.browserComments ?? [],
              },
              {
                text: documentBeforeOptimisticClear,
                attachments: attachmentsBeforeOptimisticClear,
                browserComments: commentsBeforeOptimisticClear,
              },
            );
            const changed =
              next.text !== currentDraft.text ||
              next.attachments.length !== currentDraft.attachments.length ||
              next.attachments.some((file, index) => file !== currentDraft.attachments[index]) ||
              next.browserComments.length !== (currentDraft.browserComments ?? []).length ||
              next.browserComments.some(
                (comment, index) => comment !== (currentDraft.browserComments ?? [])[index],
              );
            if (!changed) return;
            saveComposerDraft(
              sourceStorageKey,
              {
                ...currentDraft,
                text: next.text,
                attachments: [...next.attachments],
                browserComments: [...next.browserComments],
              },
              { silent: true, preserveRemoteOptimisticRecovery: true },
            );
            return;
          }
          if (options?.preserveNewerContent) {
            const currentDocument = editor.getJSON();
            const next = removeRemoteOptimisticDraftFragment(
              {
                text: currentDocument,
                attachments: latestAttachmentsRef.current,
                browserComments: browserCommentsRef.current,
              },
              {
                text: documentBeforeOptimisticClear,
                attachments: attachmentsBeforeOptimisticClear,
                browserComments: commentsBeforeOptimisticClear,
              },
            );
            const changed =
              next.text !== currentDocument ||
              next.attachments.length !== latestAttachmentsRef.current.length ||
              next.attachments.some(
                (file, index) => file !== latestAttachmentsRef.current[index],
              ) ||
              next.browserComments.length !== browserCommentsRef.current.length ||
              next.browserComments.some(
                (comment, index) => comment !== browserCommentsRef.current[index],
              );
            if (!changed) return;
            isRestoringRef.current = true;
            try {
              if (next.text !== currentDocument) {
                if (next.text) editor.commands.setContent(next.text);
                else editor.commands.clearContent(true);
              }
            } finally {
              isRestoringRef.current = false;
            }
            // restoreFiles is intentionally additive for failure recovery;
            // this branch is a successful deferred acceptance and must remove
            // the click-time attachments while retaining only newer input.
            clearFiles();
            restoreFiles(next.attachments);
            browserCommentsRef.current = [...next.browserComments];
            setBrowserComments([...next.browserComments]);
            if (sourceStorageKey) {
              const existing = getComposerDraft(sourceStorageKey);
              saveComposerDraft(
                sourceStorageKey,
                {
                  text: next.text,
                  attachments: [...next.attachments],
                  quotes: existing?.quotes ?? [],
                  browserComments: [...next.browserComments],
                },
                { silent: true, preserveRemoteOptimisticRecovery: true },
              );
            }
            return;
          }
          // Suppress onUpdate's draft-save during clearContent so we don't write a
          // transient empty-doc entry that we're about to drop.
          isRestoringRef.current = true;
          try {
            editor.commands.clearContent(true);
          } finally {
            isRestoringRef.current = false;
          }
          clearFiles();
          browserCommentsRef.current = [];
          setBrowserComments([]);
          historyIndexRef.current = -1;
          hydratedHistoryDocumentRef.current = null;
          draftRef.current = null;
          if (sourceStorageKey) clearComposerDraft(sourceStorageKey);
        };
        let optimisticComposerRestored = false;
        const immediateRestoreClientId = `local-restore:${crypto.randomUUID()}`;
        const restoreOptimisticallyClearedComposer = (
          clientId = immediateRestoreClientId,
          {
            updateLive = true,
            recoveryBatch,
          }: { updateLive?: boolean; recoveryBatch?: object } = {},
        ) => {
          if (
            !documentBeforeOptimisticClear ||
            optimisticComposerRestored ||
            !sourceStorageKey ||
            (dataOwnerAtOptimisticClear &&
              !isDataOwnerGenerationCurrent(dataOwnerAtOptimisticClear))
          ) {
            return;
          }
          optimisticComposerRestored = true;
          const isCurrentComposer =
            latestStorageKeyRef.current === sourceStorageKey &&
            storageKeyForDraftRef.current === sourceStorageKey &&
            !editor.isDestroyed;
          const restored = restoreRemoteOptimisticDraft(
            sourceStorageKey,
            {
              clientId,
              text: tiptapDocHasContent(documentBeforeOptimisticClear)
                ? documentBeforeOptimisticClear
                : null,
              attachments: attachmentsBeforeOptimisticClear,
              browserComments: commentsBeforeOptimisticClear,
            },
            isCurrentComposer
              ? {
                  text: isEditorEmpty(editor) ? null : editor.getJSON(),
                  attachments: latestAttachmentsRef.current,
                  browserComments: browserCommentsRef.current,
                }
              : undefined,
            recoveryBatch ? { recoveryBatch } : undefined,
          );
          if (!updateLive || !isCurrentComposer) return;
          const composerWasFocused = editor.isFocused;
          isRestoringRef.current = true;
          try {
            if (restored.text && tiptapDocHasContent(restored.text)) {
              editor.commands.setContent(restored.text);
            } else {
              editor.commands.clearContent(true);
            }
            if (composerWasFocused) editor.commands.focus('end');
          } finally {
            isRestoringRef.current = false;
          }
          restoreFiles(restored.attachments);
          const restoredComments = [...(restored.browserComments ?? [])];
          browserCommentsRef.current = restoredComments;
          setBrowserComments(restoredComments);
        };
        const onRemoteOptimisticFailure = optimisticallyClearRemoteComposer
          ? (clientId: string, error?: unknown) => {
              if (isRemoteOptimisticSessionPurgedError(error)) {
                // The user deleted/archived this task while the click-time
                // payload was still hydrating or waiting in the outbox. Mark
                // the transition settled without resurrecting its draft.
                optimisticComposerRestored = true;
                return;
              }
              const isDataOwnerBoundary = isRemoteOptimisticDataOwnerBoundaryError(error);
              restoreOptimisticallyClearedComposer(clientId, {
                updateLive: !isDataOwnerBoundary,
                ...(isDataOwnerBoundary ? { recoveryBatch: error as object } : {}),
              });
              if (!isDataOwnerBoundary && error !== undefined) {
                log.warn(
                  'remote optimistic send failed after reconnect:',
                  error instanceof Error ? error.message : String(error ?? ''),
                );
              }
            }
          : undefined;
        const releaseRemoteComposerTransition =
          optimisticallyClearRemoteComposer && sourceSessionId && onRemoteOptimisticFailure
            ? makerChatStore.beginRemoteOptimisticComposerTransition(
                sourceSessionId,
                filesToSend,
                onRemoteOptimisticFailure,
              )
            : () => {};
        const onDeferredAccepted = () => {
          if (optimisticallyClearRemoteComposer) {
            // 缺 workingDir 的第一次尝试会返回 false，并把远程 composer 恢复回来。
            // 补选目录后若真正受理，需要开启一轮新的失败恢复资格，再只清掉原草稿；
            // 否则后续 outbox 永久失败会因为 optimisticComposerRestored=true 而无法恢复。
            optimisticComposerRestored = false;
            clearSentComposer({ preserveNewerContent: true });
          } else {
            // Local/SSH never entered the optimistic-clear path. Reuse the normal
            // snapshot guard so an unchanged accepted draft clears while newer edits survive.
            clearSentComposer();
          }
          markRecentPluginUsage();
        };
        const restoreRemoteComposerAndRelease = () => {
          try {
            restoreOptimisticallyClearedComposer();
          } finally {
            releaseRemoteComposerTransition();
          }
        };
        if (optimisticallyClearRemoteComposer) {
          try {
            clearSentComposer();
          } catch (error) {
            restoreRemoteComposerAndRelease();
            throw error;
          }
        }
        if (
          optimisticallyClearRemoteComposer &&
          sourceSessionId &&
          onRemoteOptimisticFailure &&
          agentReferences.length > 0
        ) {
          try {
            agentReferences =
              await resolveSerializedSessionMessageReferencesForSend(agentReferences);
          } catch (error) {
            restoreRemoteComposerAndRelease();
            log.warn(
              'remote optimistic reference hydration failed:',
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          if (
            !isRemoteOptimisticComposerTransitionActive(sourceSessionId, onRemoteOptimisticFailure)
          ) {
            // /clear restores the click-time draft through the normal caller
            // path; purge has already marked the callback as a no-op above.
            restoreRemoteComposerAndRelease();
            return;
          }
        }
        let result: boolean | void;
        let effortForSend = activeEffort;
        try {
          if (sessionId) {
            const coordinator = effortChangeCoordinatorRef.current;
            let runtimeSettled = false;
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const lockComposerForEffort =
              !optimisticallyClearRemoteComposer &&
              storageKeyForDraftRef.current === sourceStorageKey;
            if (lockComposerForEffort) setSendDispatchInFlight(true);
            try {
              await Promise.race([
                coordinator.awaitRuntimeSettled(sessionId).then(() => {
                  runtimeSettled = true;
                }),
                new Promise<void>((resolve) => {
                  timeoutId = setTimeout(resolve, 5000);
                }),
              ]);
            } finally {
              if (timeoutId !== undefined) clearTimeout(timeoutId);
              if (
                lockComposerForEffort &&
                storageKeyForDraftRef.current === sourceStorageKey
              ) {
                setSendDispatchInFlight(false);
              }
            }

            // 不把 timeout 写成全局 dirty：若迟到的是「持久化失败、runtime 尚未触碰」，旧实现
            // 会永久阻断后续发送。当前这次发送直接失败；下一次会重新等待真实 settle 结果。
            if (!runtimeSettled) {
              toast.error(t('newChat.chatInput.effortRuntimeDirty'));
              if (optimisticallyClearRemoteComposer) restoreRemoteComposerAndRelease();
              return;
            }
            // onSend is the click-time closure and still targets the source
            // session. A route change while effort settles (or while voice
            // refine was deferred) must not cancel that pinned send; clearing
            // the live composer is gated separately so session B's draft is
            // never wiped.
            if (coordinator.isRuntimeDirty(sessionId)) {
              toast.error(t('newChat.chatInput.effortRuntimeDirty'));
              if (optimisticallyClearRemoteComposer) restoreRemoteComposerAndRelease();
              return;
            }
            // 等待 commit 后，闭包里的 activeEffort 可能仍是旧 props；以该 session 已提交的
            // 选择发送，保证本 turn 与 UI/SQLite 的 effort 相同。
            effortForSend = coordinator.getCommittedEffort(sessionId) ?? activeEffort;
          }
          result = await onSend(
            routedText,
            activeModel,
            effortForSend,
            activePermissionMode,
            filesToSend,
            mentionsToSend,
            {
              deliveryMode,
              providerId: sendProviderId,
              ...(hasQuotes ? { quotesEncoded: true } : {}),
              ...(agentReferences.length > 0 ? { agentReferences } : {}),
              ...(pastedTextRanges.length > 0 ? { pastedTextRanges } : {}),
              slashCommandRanges,
              ...(usedGhost ? { onAccepted: markRecentPluginUsage } : {}),
              ...(onRemoteOptimisticFailure ? { onRemoteOptimisticFailure } : {}),
              onDeferredAccepted,
            },
          );
        } catch (error) {
          if (optimisticallyClearRemoteComposer) restoreRemoteComposerAndRelease();
          log.warn('send rejected:', error instanceof Error ? error.message : String(error));
          return;
        }
        if (result === false) {
          if (optimisticallyClearRemoteComposer) restoreRemoteComposerAndRelease();
          return;
        }
        releaseRemoteComposerTransition();
        markRecentPluginUsage();
        if (!optimisticallyClearRemoteComposer) clearSentComposer();
      } finally {
        dispatchSendInFlightKeysRef.current.delete(sendInFlightKey);
        if (
          lockCurrentComposer &&
          storageKeyForDraftRef.current === sourceStorageKey
        ) {
          setSendDispatchInFlight(false);
        }
        finishAgentSendDispatch();
      }
    },
    [
      editor,
      disabled,
      sessionId,
      onSend,
      activeModel,
      activeEffort,
      activePermissionMode,
      sendProviderId,
      selectedSourceDisconnected,
      hasAttachments,
      attachments,
      clearFiles,
      restoreFiles,
      storageKey,
      deviceLinkDeviceId,
      remoteHostId,
      t,
      currentModelAgentKind,
      enforceConnectedSourceGate,
      providers,
      remoteProviders.unsupported,
      remoteModelListBlocked,
      remoteModelListStatus,
      confirmDialog,
      navigate,
      planModeEntry,
      captureSendFocusForRestore,
      slashCommandsReady,
      mergedCommands,
    ],
  );
  useEffect(() => {
    dispatchSendRef.current = dispatchSend;
  }, [dispatchSend]);

  const handleQueueSteer = useCallback(
    async (clientId: string) => {
      if (!onQueueSteer) return false;
      return onQueueSteer(clientId);
    },
    [onQueueSteer],
  );

  const handleClickSend = useCallback(
    async (deliveryMode: MessageDeliveryMode = 'queue') => {
      if (voiceBusyOnCurrentComposer) {
        const currentCanSend = !isEditorEmpty(editor) || hasAttachments;
        if (!voiceInput.isListening && !currentCanSend && voiceInput.draftText.trim().length === 0)
          return;
        if (voiceInputStopAndSendPromiseRef.current) {
          await voiceInputStopAndSendPromiseRef.current;
          return;
        }
        const stopAndSend = (async () => {
          try {
            await handleVoiceInputStop({ waitForRefinement: true });
          } catch {
            // Voice stop failures already surface through the voice input UI.
            // Do not send the pre-existing draft/attachments when transcription
            // failed after the user pressed Send.
            return;
          }
          await dispatchSend(deliveryMode);
        })().finally(() => {
          if (voiceInputStopAndSendPromiseRef.current === stopAndSend) {
            voiceInputStopAndSendPromiseRef.current = null;
          }
        });
        voiceInputStopAndSendPromiseRef.current = stopAndSend;
        await stopAndSend;
        return;
      }
      await dispatchSend(deliveryMode);
    },
    [
      dispatchSend,
      editor,
      handleVoiceInputStop,
      hasAttachments,
      voiceBusyOnCurrentComposer,
      voiceInput.draftText,
      voiceInput.isBusy,
      voiceInput.isListening,
    ],
  );
  useEffect(() => {
    voiceInputStopAndSendRef.current = handleClickSend;
  }, [handleClickSend]);

  // ── Model / effort / permission / folder callbacks (unchanged) ─────
  // ---------------------------------------------------------------------------
  // Server-first handlers: persist to server FIRST, then update UI on success.
  // On failure the UI stays unchanged so it always reflects the persisted state.
  // ---------------------------------------------------------------------------

  // 记每个 modelId 上一次显式选过的 effort, 切回来时优先恢复。
  // 场景: A 支持 [low,high,max], B 只支持 [low]。在 A 选 max → 切到 B (强制落到 low)
  // → 再切回 A, 应该恢复 max 而不是停在 low。仅 ChatInput 实例生命周期内有效;
  // 跨实例 / 跨重启的持久化由调用方通过 rememberedEffortByModel + onRememberedEffortChange
  // 注入 (NewMakerDraftRoute 走 newMakerDraft store)。
  const effortByModelRef = useRef<Map<string, Effort>>(new Map());
  const effortChangeCoordinatorRef = useRef(getEffortChangeCoordinator());
  const localRuntimeSwitchSeqBySessionRef = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    if (!sessionId || initialEffort === undefined) return;
    if (deviceLinkDeviceId ?? getSessionDeviceId(sessionId)) return;
    // 其它窗口 / 控制路径的 sessions:patched 会更新 SSoT props；同步刷新本地 commit
    // cache，并使先前本机发布的旧 runtime attempt 失效，避免迟到完成覆盖外部终态。
    effortChangeCoordinatorRef.current.adoptExternalEffort(
      sessionId,
      initialEffort,
      (targetSessionId, effort) => window.electronAPI.maker.setEffort(targetSessionId, effort),
    );
  }, [deviceLinkDeviceId, initialEffort, sessionId]);

  // 优先级: 外部 store > 本实例 ref。两份独立来源, 保证即便外部 store 还没回灌
  // (异步 sanitize 完成前) 本实例切换也不丢记忆。
  const getRememberedEffort = useCallback(
    (modelId: string): Effort | undefined => {
      return rememberedEffortByModel?.[modelId] ?? effortByModelRef.current.get(modelId);
    },
    [rememberedEffortByModel],
  );
  const setRememberedEffort = useCallback(
    (modelId: string, effort: Effort): void => {
      effortByModelRef.current.set(modelId, effort);
      onRememberedEffortChange?.(modelId, effort);
    },
    [onRememberedEffortChange],
  );

  // 解析某模型的 effort 档 / 默认档 —— **本地显式来源按 (provider, agent, model) 精确查目录**。
  // picker 用的 deriveModelsFromProviders 是跨来源 first-wins，并不适合运行时能力解析：Pi BYOM
  // 与内置来源复用 model id 时，二者可有不同的显式 effort 子集。没有来源上下文的旧入口才保留
  // 拍平回退。device-link 远程会话仍按被控端能力(getModelById(id, deviceId))，行为不变。
  const resolveModelEfforts = useCallback(
    (
      modelId: string,
      providerId?: string | null,
      targetAgentKind?: AgentKind,
    ): { efforts: readonly Effort[]; defaultEffort: Effort | null } => {
      if (deviceLinkDeviceId) {
        const m = getModelById(modelId, deviceLinkDeviceId);
        return { efforts: m?.efforts ?? [], defaultEffort: m?.defaultEffort ?? null };
      }
      const kinds: readonly AgentKind[] = targetAgentKind
        ? [targetAgentKind]
        : currentModelAgentKind
          ? [currentModelAgentKind]
          : ['claude-code', 'codex', 'pi'];
      if (providerId) {
        for (const kind of kinds) {
          const scoped = resolveProviderModelEfforts({
            providers,
            providerId,
            modelId,
            agentKind: kind,
          });
          if (scoped) return scoped;
        }
        // 显式目标来源却找不到对应条目时 fail closed，不能回退到同 id 的另一来源能力。
        return { efforts: [], defaultEffort: null };
      }
      for (const kind of kinds) {
        const found = deriveModelsFromProviders(providers, kind).find((x) => x.id === modelId);
        if (found) return { efforts: found.efforts, defaultEffort: found.defaultEffort ?? null };
      }
      const legacy = getModelById(modelId);
      return { efforts: legacy?.efforts ?? [], defaultEffort: legacy?.defaultEffort ?? null };
    },
    [deviceLinkDeviceId, currentModelAgentKind, providers],
  );

  // 解析切到某 (供应商, 模型) 时应恢复的 fast —— 先读 (agent, model) 全局预设,再按目标来源
  // capability 校验;不支持 Fast → 恒 false。device-link 已创建会话通过被控端
  // 全局预设镜像参与:handleProviderChange 的远程分支用它把 fast 经隧道
  // (onFastModeChange → makerChatStore.setFastMode)推给被控端,与本地分支同口径。
  // 某 (模型, 来源) 是否支持 Fast —— 统一走 resolveFastSupported(本地 + device-link 同一套共享逻辑;
  // device-link 用被控端隧道 providers 现查 per-provider,旧被控端回退拍平 caps;控制端不另写远程判断)。
  // capabilities 按当前模型所属 agent 选(两 hook 已按 deviceLinkDeviceId 作用域)。
  const modelFastSupported = useCallback(
    (targetModelId: string, providerId: string | null): boolean =>
      resolveFastSupported({
        deviceId: deviceLinkDeviceId ?? undefined,
        deviceProviders: remoteProviders.providers,
        localProviders: localProviders.providers,
        capabilities:
          currentModelAgentKind === 'codex'
            ? codexCaps.capabilities
            : currentModelAgentKind === 'pi'
              ? piCaps.capabilities
              : ccCaps.capabilities,
        providerId,
        modelId: targetModelId,
        agentKind: currentModelAgentKind,
      }),
    [
      deviceLinkDeviceId,
      remoteProviders.providers,
      localProviders.providers,
      currentModelAgentKind,
      ccCaps.capabilities,
      codexCaps.capabilities,
      piCaps.capabilities,
    ],
  );

  const resolveFast = useCallback(
    (targetModelId: string, providerId: string | null): boolean => {
      if (!modelFastSupported(targetModelId, providerId)) return false;
      // providerId 只用于来源 capability 与旧 v2 兼容回退;新预设按 (agent, model) 跨来源共享。
      // 无 providerId / device-link(modelMemory 为 undefined)→ false,且不掺控制端本机记忆。
      if (!currentModelAgentKind || !providerId || !modelMemory) return false;
      return modelMemory.getFast(currentModelAgentKind, providerId, targetModelId) ?? false;
    },
    [currentModelAgentKind, modelMemory, modelFastSupported],
  );

  const syncSessionDraftModelPrefs = useCallback(
    (
      modelId: string,
      patch: { effort?: Effort; fast?: boolean },
      opts: {
        activeProviderId?: string | null;
        memoryProviderId?: string | null;
        remoteDeviceId?: string;
        /** 跨引擎换模时写目标 Agent 的草稿槽,缺省用当前任务引擎。 */
        agentKind?: AgentKind;
        /** 已有任务里换模 / 换来源时为 true,下次新建跟随这次选择。只改思考档 / Fast 保持 false。 */
        markModelChoice?: boolean;
      } = {},
    ) => {
      const agentKind = opts.agentKind ?? currentModelAgentKind;
      if (!sessionId || !agentKind || !modelId) return;
      const activeProviderId =
        opts.activeProviderId !== undefined ? opts.activeProviderId : selectedProviderId;
      const memoryProviderId =
        opts.memoryProviderId !== undefined ? opts.memoryProviderId : effectiveSourceId;
      const remoteDeviceId =
        opts.remoteDeviceId ?? getSessionDeviceId(sessionId) ?? deviceLinkDeviceId;
      const markModelChoice = opts.markModelChoice === true;
      if (!remoteDeviceId) {
        const vendor =
          agentKind === 'codex'
            ? 'codex'
            : agentKind === 'pi'
              ? 'pi'
              : 'cc';
        const persistPrefs = markModelChoice ? patchVendorPrefs : patchVendorPrefsPreservingModelChoice;
        persistPrefs(vendor, {
          // 换模才带配对并打标记。本机只改思考档 / Fast 不写回活动模型,
          // 避免未打标用户把区域默认改成当前任务模型。
          ...(markModelChoice
            ? { model: modelId, providerId: activeProviderId ?? null }
            : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        });
        if (memoryProviderId) {
          if (patch.effort !== undefined) {
            setProviderModelChoice(agentKind, memoryProviderId, modelId, patch.effort);
          }
          if (patch.fast !== undefined) {
            setProviderModelFast(agentKind, memoryProviderId, modelId, patch.fast);
          }
        }
        if (patch.effort !== undefined) setEffortForModel(modelId, patch.effort);
        if (patch.fast !== undefined) setFastModeForModel(modelId, patch.fast);
        return;
      }
      window.electronAPI.deviceLink
        .invoke(remoteDeviceId, 'maker:apply-new-maker-draft-pref', [
          {
            agent: agentKind,
            providerId: activeProviderId ?? '',
            modelId,
            active: true,
            markModelChoice,
            ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
            ...(patch.fast !== undefined ? { fast: patch.fast } : {}),
          },
        ])
        .catch((err) => {
          log.warn('session draft model preference sync failed:', err);
        });
    },
    [sessionId, deviceLinkDeviceId, currentModelAgentKind, selectedProviderId, effectiveSourceId],
  );

  const persistFastModeChange = useCallback(
    async (
      enabled: boolean,
      options?: { silent?: boolean; remoteDeviceId?: string },
    ): Promise<boolean> => {
      try {
        await onFastModeChange?.(enabled, options?.remoteDeviceId);
        return true;
      } catch (err) {
        log.warn('fast mode change failed:', err);
        if (!options?.silent) {
          toast.error(
            t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.remoteSwitchFailed' })),
          );
        }
        return false;
      }
    },
    [onFastModeChange, t],
  );

  /**
   * 返回值 = **这次 Fast 写入真的落下去了没有**(2026-08-17 review 第三轮 G2)。统一面板的
   * 三个「先应用、后清存储」入口(恢复推荐 / 删选中收藏 / 编辑选中收藏)按它决定要不要收尾:
   * 报假成功会让 override / 记忆 / 收藏被清掉,而任务还在旧配置上跑。其余调用方无视返回值。
   */
  const handleFastModeChange = useCallback(
    async (
      enabled: boolean,
      modelId = activeModel,
      effort = activeEffort,
      syncDraft = true,
      memoryProviderId = effectiveSourceId,
    ): Promise<boolean> => {
      if (settingsLocked) return false;
      // 切换意图期:Fast 改动是"更新意图"而不是改当前会话实时状态(否则普通
      // SET_FAST 链路会让 main 清意图、renderer 乐观态失配)。经 ref 调用——
      // performAgentSwitch 声明在本回调之后(TDZ)。
      if (sessionId && makerChatStore.getAgentSwitchIntent(sessionId)) {
        const intent = makerChatStore.getAgentSwitchIntent(sessionId)!;
        // await 而非 fire-and-forget:意图重登记是不是真的成功,是这次 Fast 写入的唯一结果。
        return (
          (await performAgentSwitchRef.current(intent.target, intent.model, intent.providerId, {
            fastMode: enabled,
            effort: intent.effort as Effort | undefined,
          })) !== false
        );
      }
      const sourceRemoteDeviceId = (sessionId
        ? (deviceLinkDeviceId ?? getSessionDeviceId(sessionId))
        : deviceLinkDeviceId) ?? undefined;
      const persisted = await persistFastModeChange(enabled, {
        remoteDeviceId: sourceRemoteDeviceId,
      });
      if (!persisted) return false;
      if (modelId && currentModelAgentKind && memoryProviderId) {
        modelMemory?.setFast(currentModelAgentKind, memoryProviderId, modelId, enabled);
      }
      if (syncDraft && modelId) {
        syncSessionDraftModelPrefs(
          modelId,
          { effort, fast: enabled },
          { remoteDeviceId: sourceRemoteDeviceId },
        );
      }
      return true;
    },
    [
      sessionId,
      deviceLinkDeviceId,
      activeModel,
      activeEffort,
      currentModelAgentKind,
      effectiveSourceId,
      modelMemory,
      persistFastModeChange,
      syncSessionDraftModelPrefs,
      settingsLocked,
    ],
  );

  /**
   * 切模型前的上下文容量护栏(大窗口 → 小窗口场景)。
   * 分级语义见 shared/modelSwitchAssessment.ts。overflow 确认后由 host 交接换窗,
   * 不要再建议用户先 /compact —— 小窗口模型压整段历史同样会失败。
   * 返回 false = 用户取消, 调用方直接放弃本次切换(无任何副作用)。
   * fail-open: 占用未知(0)/ 目标窗口未知 / 阈值读取失败都不拦。
   */
  const confirmModelSwitchContextGuard = useCallback(
    async (newModelId: string, sourceRemoteDeviceId?: string): Promise<boolean> => {
      if (!sessionId) return true;
      const contextTokens = makerChatStore.getSnapshot(sessionId).agentStatus.contextTokens;
      if (!contextTokens || contextTokens <= 0) return true;
      // device-link 远程会话: 目标模型窗口必须查被控端能力缓存(模型 id 跨设备不唯一)。
      // 优先复用操作开始时捕获的 device scope，relay origin 暂失时不能退回本机目录。
      const remoteDeviceId = sourceRemoteDeviceId ?? getSessionDeviceId(sessionId) ?? undefined;
      const targetContextWindow = getModelById(newModelId, remoteDeviceId)?.contextWindow;
      let autoCompactThresholdPct: number | undefined;
      try {
        autoCompactThresholdPct = (await window.electronAPI.maker.compactionGetState()).pct;
      } catch {
        // 阈值读不到 → assessment 内部回退默认 90, 不阻断切换。
      }
      const verdict = assessModelSwitchContext({
        contextTokens,
        targetContextWindow,
        autoCompactThresholdPct,
      });
      if (verdict.level === 'ok') return true;
      const fmtTokens = (n: number): string =>
        n >= 1_000_000
          ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
          : `${Math.round(n / 1000)}K`;
      const vars = {
        used: fmtTokens(contextTokens),
        total: fmtTokens(targetContextWindow ?? 0),
        pct: verdict.projectedPct,
      };
      if (verdict.level === 'warn' || verdict.level === 'danger') {
        toast.warning(t('newChat.chatInput.modelSwitchContextGuard.warnToast', vars), {
          duration: 4000,
        });
        return true;
      }
      // overflow (≥100%): 弹确认。默认焦点保持在取消(Radix 默认)——
      // 期望用户先取消回去压缩(点上下文圆环)或新开会话, "仍然切换"是次选。
      return confirmDialog({
        title: t('newChat.chatInput.modelSwitchContextGuard.title'),
        description: t(
          remoteHostId
            ? 'newChat.chatInput.modelSwitchContextGuard.overflowDescriptionRemote'
            : 'newChat.chatInput.modelSwitchContextGuard.overflowDescription',
          vars,
        ),
        confirmText: t('newChat.chatInput.modelSwitchContextGuard.confirmSwitch'),
        cancelText: t('newChat.chatInput.modelSwitchContextGuard.cancelSwitch'),
      });
    },
    [sessionId, remoteHostId, confirmDialog, t],
  );

  // session-agent-switch 意图制:选中「只属于另一家引擎」的模型 → 只向 main 登记
  // 切换意图并乐观呈现(chip / 选择器立即跟随目标引擎),真正的交接、关旧引擎、
  // 边界行与重建全部推迟到下一条消息发送时刻由 send 事务执行——用户反复改选
  // 零成本,不反复切换/交接(2026-07-20 产品反馈)。effort / Fast 的目标值在此
  // 按目标引擎目录与 per-(引擎,来源,模型) 预设解析好,随意图带给 main,apply 时
  // 一并落库;renderer 不再做切换后补写。
  // handleModelChange / handleProviderChange 声明在本回调之后,经 ref 引用避免
  // TDZ(仅在"选回当前引擎"分支的调用时刻解引用)。
  const sameEngineReselectRef = useRef<{
    byProvider: (
      providerId: string,
      modelId: string,
      expectedRevision?: number,
    ) => void | boolean | Promise<void | boolean>;
    byModel: (
      modelId: string,
      expectedRevision?: number,
    ) => void | boolean | Promise<void | boolean>;
  }>({ byProvider: () => {}, byModel: () => {} });
  const confirmAgentBrowseSwitch = useCallback(
    (targetAgent: 'claude-code' | 'codex' | 'pi' | null) =>
      confirmAgentSwitchRisk({
        // 只有「目标就是会话正在跑的真实引擎」才不必再问(回原引擎 = same-engine no-op,
        // 不重建上下文)。挂着的切换意图不算已经确认过(Chris 2026-08-20):Claude 任务里
        // 点了 Pi 收藏、意图挂上但还没发消息,再点另一条非当前引擎的模型/收藏,仍然要问。
        // 真源必须用 `runtimeAgentKind`,绝不能用 vendorKey / 意图目标 —— 那两个在意图期
        // 会翻到目标引擎,把「继续切到意图目标」错判成同引擎、把确认框跳过。
        hasSwitchIntent:
          !!sessionId && !!targetAgent && runtimeAgentKind != null && runtimeAgentKind === targetAgent,
        confirm: confirmDialog,
        copy: {
          title: t('newChat.chatInput.agentSwitch.confirmation.title'),
          description: t('newChat.chatInput.agentSwitch.confirmation.description'),
          confirmText: t('newChat.chatInput.agentSwitch.confirmation.confirm'),
          cancelText: t('newChat.chatInput.agentSwitch.confirmation.cancel'),
          dontShowAgainLabel: t('newChat.chatInput.agentSwitch.confirmation.dontShowAgain'),
        },
      }),
    [sessionId, runtimeAgentKind, confirmDialog, t],
  );
  const performAgentSwitch = useCallback(
    async (
      targetAgentKind: 'claude-code' | 'codex' | 'pi',
      newModelId: string,
      providerId: string | null = null,
      // 意图期内的档位/Fast 改动经此显式覆盖(用户手选优先于记忆/默认解析)。
      overrides?: {
        effort?: Effort;
        fastMode?: boolean;
      },
    ): Promise<boolean> => {
      // ★ 返回值 = **本端请求的完整配置真的落到会话上了没有**(2026-08-17 review 确立
      // 「登记成功才 true」;2026-08-19 review P2 再收紧一档)。此前本函数只返回 void,
      // 调用方(统一面板的跨引擎链路)拿不到结果,只能在「确认框过了」这一刻就返回
      // true —— 面板据此做的清理动作(恢复推荐清 override / 删收藏)会在事务其实失败或
      // 被拒时照样执行,把用户原来的配置抹掉。凡是「没把这次选择落到会话上」的出口一律
      // 返 false;登记成功但**权威回声显示 effort / Fast 已被别处改动**(见 apply-intent
      // 分支末尾的 isAgentSwitchEchoConfigConsistent)同样返 false —— 三元组落了不等于
      // 这份完整配置落了,调用方挂在 true 上的持久化收尾(清 override / 提交・删除收藏
      // 编辑 / 写收藏锚点)一律不做。只有完整配置原样成为权威意图 / 已应用才返 true。
      if (!sessionId) return false;
      // 发送的引用水合 / 预检也可能 await。以同步登记的 session 级发送 token 为准，
      // 防止「先点发送、后选引擎」被异步准备反转成先登记切换再 maker:send。
      if (hasPendingAgentSendDispatch(sessionId)) return false;
      // 本次点选无论落到哪个分支(登记意图 / 撤销意图 / 立即切换),都算一次本端写入:
      // 在途的远程意图读回据此作废,不会用旧快照盖掉用户刚做的选择。
      const sourceSessionId = sessionId;
      const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);
      const intentRevAtSend = makerChatStore.getAgentSwitchIntentRev(sourceSessionId);
      const finishAgentSwitchOperation = beginAgentSwitchOperation(sourceSessionId);
      const exclusiveTurn = reserveAgentSwitchExclusive(sourceSessionId);
      try {
        await exclusiveTurn.ready;
        // effort 档按**目标引擎 + 目标来源**目录解析（同 id 模型跨来源档位可不同）；浏览态
        // 悬浮面板写下的 per-(目标引擎,来源,模型) 预设在此恢复。
        const { efforts, defaultEffort } = resolveModelEfforts(
          newModelId,
          providerId,
          targetAgentKind,
        );
        const providerEffort =
          modelMemory && providerId
            ? modelMemory.getEffort(targetAgentKind, providerId, newModelId)
            : undefined;
        const newEffort =
          overrides?.effort && efforts.includes(overrides.effort)
            ? overrides.effort
            : resolveEffort({
                efforts,
                defaultEffort,
                activeEffort,
                providerEffort,
                rememberedEffort: getRememberedEffort(newModelId),
              });
        // Fast 目标值:目标 (来源,模型) 支持时按目标引擎全局预设,否则 false——
        // 旧引擎的 fastMode 不能原样带进新引擎。
        const targetFast =
          overrides?.fastMode !== undefined
            ? overrides.fastMode
            : !!providerId &&
              !!modelMemory &&
              resolveFastSupported({
                deviceId: deviceLinkDeviceId ?? undefined,
                deviceProviders: remoteProviders.providers,
                localProviders: localProviders.providers,
                capabilities:
                  targetAgentKind === 'codex'
                    ? codexCaps.capabilities
                    : targetAgentKind === 'pi'
                      ? piCaps.capabilities
                      : ccCaps.capabilities,
                providerId,
                modelId: newModelId,
                agentKind: targetAgentKind,
              }) &&
              (modelMemory.getFast(targetAgentKind, providerId, newModelId) ?? false);

        // 会话级操作按来源路由:device-link 远程会话隧道到被控端(意图注册表与引擎
        // 交接都在那边),本机会话零变化直连本机 maker。
        // 远程分支用**稳定的** deviceLinkDeviceId 直连隧道,不走 makerApiFor 的
        // sessionId→deviceId 索引解析:该索引在 relay 瞬时重连窗口会被清空(见
        // stickySessionOrigin),此时远程会话会被误判成本机 → 打到控制端本机 maker,
        // 轻则「无此 session」,极小概率命中本机同 id 会话写错 pending intent。
        const switchApi = deviceLinkDeviceId
          ? makerApiForDevice(deviceLinkDeviceId)
          : makerApiFor(sourceSessionId);
        const result = await switchApi.switchSessionAgent(
          sourceSessionId,
          targetAgentKind,
          newModelId,
          providerId,
          newEffort,
          targetFast,
        );
        // device-link 往返期间可以切到另一个任务:同一路由下 ChatInput 会带着新
        // sessionId 继续渲染,sameEngineReselectRef 等闭包也已指向新会话。旧会话的
        // 响应绝不能借最新的 ref 把模型/来源写进当前会话。
        if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return false;
        // 远程往返期间状态可能已被更新的选择超车:用户又点了一次(写序号变),或另一个
        // 控制端 / 被控端的权威 sessions:patched 先到(修订号变)。此时这次 ack 携带的是
        // **旧**选择,落下去会让选择器显示过期引擎,而被控端按新意图执行下一条消息。
        // 丢弃即可——被控端每次意图变更都会广播,权威值随 push 收敛。
        // 注意两类守卫作用域不同(见 resolveAgentSwitchAckAction):同引擎 no-op 的清除
        // 回流本就由本次调用引起,不能拿修订号变化把自己判成 stale。
        //
        // deferred 分支同理:main **先广播 sessions:patched(带 agentSwitchIntent)、后返回
        // invoke reply**,push 处理必然先于 ack 到达并把修订号推走 —— 单看修订号,每一次正常
        // 登记都会被自己的回声判成 stale(Chris 2026-08-19 实测「会话内换引擎整条链都不生效,
        // 但下一条消息还是切了」的主根因)。所以额外交出「此刻的权威值是不是逐字就是本次登记
        // 的那一份」:相等 = 变化来自本次登记的回声,应用它不会覆盖任何更新的外部选择。
        // 只比 target / model / providerId —— effort / fastMode 可能被 main 按目标引擎归一化后
        // 才投影(见 projectPendingAgentSwitchIntent),比它们会把合法回声误判成不匹配。
        //
        // providerId 还要再让一步:本端传 `null` 的语义是**「我没指定来源,跟随默认路由」**
        // (flat 退化行 / 意图期改选模型的分支),而 main 完全可以在登记时把它解析成一个
        // 具体来源再投影回来。此时严格相等会把每一次 null 调用都判成「被外部超车」,等于
        // 在那条路径上原样退回本次要修的 bug。所以:传了具体来源就必须逐字相等;传 null 时
        // 只认 target + model —— main 解析出什么来源,都是我这一份意图。
        // 「用户又点了一次」仍由写序号守卫独立覆盖,不靠这一维。
        const registeredIntent = makerChatStore.getAgentSwitchIntent(sourceSessionId);
        const registeredIntentMatchesCurrent =
          registeredIntent !== null &&
          registeredIntent.target === targetAgentKind &&
          registeredIntent.model === newModelId &&
          (providerId === null || registeredIntent.providerId === providerId);
        const ackAction = resolveAgentSwitchAckAction({
          deferred: result.deferred === true,
          switched: result.switched,
          sameEngineRevision: result.sameEngineRevision,
          sameEngineSuperseded: result.sameEngineSuperseded,
          registeredIntentMatchesCurrent,
          freshness: {
            cancelled: false,
            writeSeqAtStart: writeSeq,
            writeSeqNow: getAgentSwitchWriteSeq(sourceSessionId),
            intentRevAtStart: intentRevAtSend,
            intentRevNow: makerChatStore.getAgentSwitchIntentRev(sourceSessionId),
          },
        });
        // 被更新的选择超车 → 这次点选没有落地(权威值属于后来那次),按「没切」上报:
        // 调用方的清理若按成功走,清掉的是**用户最新那次选择**对应的配置。
        if (ackAction === 'discard') return false;
        if (ackAction === 'apply-intent') {
          // 意图已登记:乐观呈现目标引擎/模型/档位(独立 intent 覆盖
          // model/effort/provider/fast 显示,不改真实 reducer agentKind)。真切换
          // 在下一条消息发送时刻执行;turn 运行中额外提示旧 turn 不受影响。
          //
          // ★ 回声已匹配时**一个字段都不重写**(2026-08-19 review 两轮 P1 的合并收口):
          // 走到值匹配出口 = `sessions:patched` 权威回声已先于 ack 落进 store,此刻 store 里
          // 就是 main 的 pending intent 快照 —— 再用本端的旧值 note 一遍只可能把它改坏:
          //   · providerId:本端传 null(跟随默认路由)而 main 解析成了具体来源 → null 盖掉
          //     权威来源,意图期改选按错误路由走;
          //   · effort / fastMode:另一控制端在本次往返期间只改了同一 intent 的档位 / Fast
          //     (target/model/provider 不变,匹配判定刻意不比这两维)→ 本端旧
          //     newEffort/targetFast 盖掉外部权威值,选择器与下一条消息实际采用的配置分叉;
          //     本端自己的登记同理 —— main 可能按目标引擎归一化 effort 后才投影。
          // 且回声已经到过,不会再有第二次权威回流来纠正。回声未到(修订号未变的常规路径)
          // 才写本端解析值,稍后到达的权威回声会自然覆盖收敛。
          if (!registeredIntentMatchesCurrent) {
            makerChatStore.noteAgentSwitchIntent(sourceSessionId, targetAgentKind, {
              model: newModelId,
              providerId,
              effort: newEffort,
              fastMode: targetFast,
            });
          }
          // 跨引擎点选也是用户显式选模:记到目标 vendor,下次用该引擎新建跟随这次选择。
          // 真切换可能推迟到下一条消息,但选择已经做出。
          //
          // ★ 偏好同步与上面的 note-skip 同族(2026-08-19 review P2):回声已匹配时,写进
          // newMakerDraft / providerModelMemory / 远端 apply-new-maker-draft-pref 的也必须是
          // **权威快照里的值** —— 拿本端旧 newEffort / targetFast / providerId 去同步,另一
          // 控制端只改 effort / Fast(或 main 归一化 / 解析来源)的场景里,下一次新建任务会
          // 采用过期偏好,还会把权威值从偏好面盖掉。权威快照缺某字段(如不可调模型没有
          // effort)时该维**不写**,而不是回落本端旧值 —— 写一个 main 都没有的档同样是分叉。
          const authoritative = registeredIntentMatchesCurrent ? registeredIntent : null;
          const syncedEffort = authoritative ? authoritative.effort : newEffort;
          const syncedFast = authoritative ? authoritative.fastMode : targetFast;
          const syncedProviderId = authoritative ? authoritative.providerId : providerId;
          syncSessionDraftModelPrefs(
            newModelId,
            {
              ...(syncedEffort ? { effort: syncedEffort } : {}),
              ...(syncedFast !== undefined ? { fast: syncedFast } : {}),
            },
            {
              activeProviderId: syncedProviderId,
              memoryProviderId: syncedProviderId,
              remoteDeviceId: deviceLinkDeviceId ?? undefined,
              agentKind: targetAgentKind,
              markModelChoice: true,
            },
          );
          if (makerChatStore.getSnapshot(sourceSessionId).agentStatus.isRunning) {
            toast.success(
              t('newChat.chatInput.agentSwitch.deferred', {
                agent:
                  targetAgentKind === 'codex'
                    ? 'Codex'
                    : targetAgentKind === 'pi'
                      ? 'Pi'
                      : 'Claude Code',
                model: newModelId,
              }),
              { duration: 4000 },
            );
          }
          // ★ 完整配置权威性(2026-08-19 review P2 的最后一环):三元组回声匹配放行的是
          // 「这份变化来自本次登记」,但 effort / Fast 刻意不进匹配判据 —— 于是另一控制端
          // 在往返期间只改同一意图的档位 / Fast 时,走到这里的仍是「登记成功」。上面的
          // note-skip 与权威快照同步已保证**展示与偏好**不被本端旧值污染;这里再保证
          // **返回值**不撒谎:权威 effort / Fast 与本端这次请求不一致 = 本端的完整配置
          // 并没有成为会话将要采用的配置,按「未完整应用」返 false,调用方挂在成功上的
          // 持久化收尾(统一面板 onApplied 的清 override / 提交・删除收藏编辑,以及
          // onCrossEngineSelect 的收藏锚点写入)一律不做 —— 旧锚点由派生校验自然失效,
          // 不会出现「面板勾着一条配置早已不同的收藏」。
          return isAgentSwitchEchoConfigConsistent({
            authoritative,
            requestedEffort: newEffort,
            requestedFastMode: targetFast,
          });
        }
        if (ackAction === 'same-engine-reselect') {
          // 同引擎 no-op = 用户选回当前引擎:撤销展示意图(幂等,被控端可能已清并回流),
          // 再把这次点选当作普通的模型/来源切换应用到当前引擎。
          //
          // 这次 SET_MODEL 在被控端会走 applySetModelThenCancelAgentSwitchIntent —— 它
          // **无条件**清掉 pending intent 并广播 agentSwitchIntent:null。fire-and-forget
          // 的话,它可能在用户随后登记的新跨引擎意图之后才落地,把那次选择清掉(下一条
          // 消息就不切引擎了)。因此把完整异步调用也排进同一条会话串行链:后续的引擎切换
          // 必须等它发完才发出,顺序由链保证。
          const applied = providerId
            ? await sameEngineReselectRef.current.byProvider(
                providerId,
                newModelId,
                result.sameEngineRevision,
              )
            : await sameEngineReselectRef.current.byModel(newModelId, result.sameEngineRevision);
          // 被更新的选择超车(byProvider / byModel 自带修订号守卫)→ 同样按「没切」上报。
          if (applied === false) return false;
          makerChatStore.clearAgentSwitchIntent(sourceSessionId);
          return true;
        }
        // 立即切换路径(harness / registry 缺省兜底,生产不走):维持旧收敛语义。
        makerChatStore.noteAgentSwitched(sourceSessionId, targetAgentKind);
        syncSessionDraftModelPrefs(
          newModelId,
          { effort: newEffort, fast: targetFast },
          {
            activeProviderId: providerId,
            memoryProviderId: providerId,
            remoteDeviceId: deviceLinkDeviceId ?? undefined,
            agentKind: targetAgentKind,
            markModelChoice: true,
          },
        );
        if (!result.engineReady) {
          toast.error(t('newChat.chatInput.agentSwitch.engineNotReady'), { duration: 4000 });
        }
        // 立即切换已经落库(noteAgentSwitched + 草稿同步):engineReady 只影响提示,
        // 不改变「这次选择已应用」这一事实。
        return true;
      } catch (err) {
        toast.error(
          t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.agentSwitch.failed' })),
        );
        // 切换事务抛错 = 没切成:调用方不得在此之上做「成功才做」的清理。
        return false;
      } finally {
        exclusiveTurn.release();
        finishAgentSwitchOperation();
      }
    },
    [
      sessionId,
      activeEffort,
      resolveModelEfforts,
      getRememberedEffort,
      t,
      providers,
      modelMemory,
      deviceLinkDeviceId,
      remoteProviders.providers,
      localProviders.providers,
      ccCaps.capabilities,
      codexCaps.capabilities,
      piCaps.capabilities,
      syncSessionDraftModelPrefs,
    ],
  );
  // 声明顺序在 performAgentSwitch 之前的 handler(handleFastModeChange)经此 ref
  // 调用,避免 TDZ;每次渲染刷新指向最新闭包。
  const performAgentSwitchRef = useRef(performAgentSwitch);
  performAgentSwitchRef.current = performAgentSwitch;

  // ── 统一模型选择器 · 会话内形态(model-selector-unified M6)────────────────────
  // 旧的两步分段(先切引擎 tab、再选模型)在统一面板下不渲染,取而代之的是
  // 「同引擎视图默认 + 显式跨引擎入口 + 行浮层引擎胶囊」。**执行链路一个字没变**:
  // 跨引擎选中仍然是 confirmAgentBrowseSwitch(同一份确认与「不再提示」偏好)
  // → performAgentSwitch(意图登记与上下文容量护栏全在那边)。
  //
  // Fast 与 effort 同规则:面板交出来的 `fast` 是按**目标引擎**解析并过完能力门控的值
  // (行记忆 / 收藏副本 / 恢复推荐的显式关),那是用户看着点下去的配置,显式传进
  // overrides.fastMode(2026-08-17 review:留给事务按目标记忆重解析,收藏 Fast 与记忆值
  // 不同、或恢复推荐要明确关 Fast 时,界面配置与运行态分离)。**旧引擎的实时 fastMode
  // 仍然绝不进这条链路**——缺省(面板拿不到目标配置的入口)时由 performAgentSwitch 按
  // 目标重解析,两条路都不读旧引擎的值。
  // effort 同样显式传:面板行(以及收藏副本)已经按目标引擎解析好档位。
  //
  // `modelId` 在契约上**已经是目标引擎的 wire model id**(面板按
  // `capabilities[targetAgent].wireModelId` 交出来)。这里对它零加工直接进切换事务 ——
  // 任何"顺手归一化 / 加前缀"都会让 SET_MODEL 落一个目标引擎目录里不存在的 id。
  //
  // `currentAgent` = **待切换意图目标优先**(2026-08-17 review):跨引擎意图登记后、真切换
  // 落地前,activeModel / activeEffort / fastMode / activeProviderId 展示的全是意图目标值,
  // 面板的 live / keep / pinned 引擎必须用同一口径 —— 仍取旧 vendorKey 会把意图中的目标
  // 模型画成旧引擎:浮层摆出旧引擎的档位集合,而意图期的深度 / Fast 回调
  // (performAgentSwitch(intent.target, …))按**目标**能力校验,用户选的旧引擎档位被静默
  // 回落。写侧本就全部落在意图目标上(performModelChange / performProviderChange /
  // handleEffortChange / handleFastModeChange 的意图分支),这里只是让显示端对齐;
  // composerEngineMarkVendor / 锚点派生校验早已同口径。意图清除(发送后 patched 回流)时
  // vendorKey 收敛成同一个值,口径无缝交回。
  const intentTargetAgent = agentSwitchIntent?.target ?? null;
  const sessionEngineFilter = useMemo(() => {
    if (!unifiedModelPanelEnabled) return undefined;
    if (!sessionId || !vendorKey || remoteHostId || !sessionAgentSwitchSupported) return undefined;
    const currentAgent = intentTargetAgent ?? vendorKeyToAgentKind(vendorKey);
    if (!currentAgent) return undefined;
    return {
      currentAgent,
      // 跨引擎确认 / 切换路由只认任务**正在跑**的引擎,不认挂着的意图目标。
      // 意图期 currentAgent 会翻到 Pi,若用它判断,点 Pi 收藏会被当成同引擎、不弹确认、
      // 还不带收藏里的思维(Chris 2026-08-20)。
      runtimeAgent: runtimeAgentKind ?? undefined,
      onCrossEngineSelect: async ({
        providerId,
        modelId,
        targetAgent,
        effort,
        fast,
        favoriteUid = null,
      }: {
        providerId: string;
        modelId: string;
        targetAgent: AgentKind;
        effort: Effort | '';
        fast?: boolean;
        favoriteUid?: string | null;
      }): Promise<boolean> => {
        // 取消 = 什么都不改;返回 false 让选择器留在原地(用户还能挑别的行)。
        // 目标显式传给确认门:同一目标不重复弹,换目标要重新确认(见 confirmAgentBrowseSwitch)。
        if (!(await confirmAgentBrowseSwitch(targetAgent))) return false;
        // ★ 必须 await 并**透传事务的真实结果**(2026-08-17 review)。此前这里 fire-and-forget
        // 之后立即 return true —— 那个 true 只表示「确认框过了」,不表示切换登记成功。
        // 面板侧把「成功才做」的清理(恢复推荐清 override / 删除选中收藏)挂在这个提前
        // 布尔上,于是 switchSessionAgent 抛错、或 pending send 把切换挡掉时,用户的
        // override / 收藏已经被清掉,原配置无从恢复。
        //
        // 代价是面板会在事务在途期间多停留一会儿:这段时间由 ModelSelector 的
        // keepOpenForAgentConfirmation 保命锁按住(它已经覆盖整个 await 期),面板本身在
        // 切换 in-flight 期间是置灰的,不会出现「面板可点却在切换中」的中间态。
        const applied = await performAgentSwitchRef.current(
          targetAgent,
          modelId,
          providerId,
          // fast 只认**面板显式给的目标值**;缺省时不传,由 performAgentSwitch 按目标
          // 重解析。旧引擎的实时 Fast(本组件同名 state)不进这条链路。
          effort || fast !== undefined
            ? {
                ...(effort ? { effort } : {}),
                ...(fast !== undefined ? { fastMode: fast } : {}),
              }
            : undefined,
        );
        // 收藏锚点只在事务**真成功**后才记(G4):确认框被取消 / 登记失败时这次选择根本没
        // 发生,记下来会让面板在一条没被采用的收藏上打勾。选普通模型行 → favoriteUid 为
        // null → 顺带把上一条锚点清掉。
        // 「真成功」自 2026-08-19 review P2 起含**完整配置一致**:登记成功但权威回声里的
        // effort / Fast 已被另一控制端改走时 applied 为 false —— 锚点不写(那份收藏副本
        // 不再是会话将要采用的配置),旧锚点因 model / 引擎已变而被派生校验自然判失效,
        // 面板不会勾住任何一条配置对不上的收藏。
        if (applied) {
          setSessionFavoriteAnchor(
            favoriteUid
              ? {
                  uid: favoriteUid,
                  wireModelId: modelId,
                  engine: agentKindToVendor(targetAgent),
                  providerId,
                }
              : null,
          );
        }
        return applied;
      },
    };
  }, [
    unifiedModelPanelEnabled,
    sessionId,
    vendorKey,
    intentTargetAgent,
    remoteHostId,
    runtimeAgentKind,
    sessionAgentSwitchSupported,
    confirmAgentBrowseSwitch,
    // 锚点写入绑的是**这一份闭包里的** sessionId(见 setSessionFavoriteAnchor):它随会话
    // 变化换新引用,必须进依赖,否则事务收尾会用上一条会话的 setter 写错分槽。
    setSessionFavoriteAnchor,
  ]);

  // composer pill 尾部引擎小标的取值(model-selector-unified §1.1,Chris 2026-08-12 裁决:
  // pill 不再写 harness 名字文本)。与 agentIdentity **同一口径**,不另起一套:
  //   · 已建会话:身份由 session / runtime 确认后才画;切换意图期画目标引擎;
  //     身份未加载时 resolveModelSelectorAgentIdentity 返回 undefined → 不画
  //     (绝不拿 vendorKey 的 Claude Code 回退冒充,见 runtimeAgentKind 的 prop 说明);
  //   · 草稿:没有 session 身份可言,当前引擎就是 vendorKey 本身。
  const composerEngineMarkVendor = sessionId
    ? (resolveModelSelectorAgentIdentity(runtimeAgentKind, agentSwitchIntent?.target)?.vendorKey ??
      null)
    : (vendorKey ?? null);

  /**
   * 下发给统一面板的收藏锚点:草稿用调用方(NewMakerDraftRoute)持有的那一份,会话用上面
   * 那份内存态。
   *
   * 收藏是**独立选中项**(Chris 2026-08-20):选中身份就是那条收藏的 uid,不拿正在跑的
   * 模型 / 引擎 / 思维去对副本 —— 对上才会勾,等于让下面的同名模型行把焦点抢走(点了
   * Pi 收藏、任务还停在 Claude 时必现)。uid 指向的收藏被删 / 换账号后查无此条,由面板
   * 侧 activeFavoriteUid 兜底。用户点普通模型行时 favoriteUid 显式置 null,那才是离开
   * 这条收藏。
   */
  const effectiveSelectedFavoriteUid = sessionId
    ? (sessionFavoriteAnchor?.uid ?? null)
    : selectedFavoriteUid;

  // 会话内拿不到跨引擎切换事务(SSH 远程会话 / 被控端不支持 session-agent-switch /
  // Orca 会话)时,统一面板**不能**摆出其它引擎的行:useUnifiedRowActions.selectRow 只有在
  // 传了 sessionEngineFilter 时才把跨引擎行改道给切换事务,没有它时跨引擎行会被当普通选中
  // 交给单引擎链路(onProviderChange 只换 model / provider),等于把另一个引擎的模型
  // 直接塞进当前会话。与旧面板同待遇:这类会话把联合列表锁定在当前引擎(旧版本来就是
  // 单引擎列表)。
  //
  // 锁定用的必须是**已确认**的会话引擎,不能用 vendorKey 派生的 agentKind:
  // CCAgentSessionView 的 vendorKey 走 dbToMakerAgentKind(session?.agentKind),元数据到达
  // 前回退成 'cc'。而 sessionOrcaRole 在同一窗口里是 undefined(≠ null)→
  // sessionAgentSwitchSupported=false → 没有 sessionEngineFilter → 走到这条锁定分支。
  // 两件事撞在一起的后果不是"闪一下":Codex 会话会摆出一张**纯 Claude** 的列表,而且此时
  // 没有跨引擎兜底,点任意一行都会把 Claude 模型经 onProviderChange 塞进 Codex 会话
  // (bug4)。所以身份未确认时不锁 —— 回落旧面板一帧,等 runtimeAgentKind 落地再进统一面板。
  const sessionEngineConfirmed = !sessionId || runtimeAgentKind != null;
  const inSessionEngineLocked = Boolean(sessionId) && !sessionEngineFilter;
  const lockedSessionAgentKind =
    inSessionEngineLocked && sessionEngineConfirmed ? (runtimeAgentKind ?? agentKind) : null;
  // 形态偏好(三档并存,Chris 2026-08-17):'original' = 最原始选择器(含旧 harness
  // 分段切换,agentSwitch 因 unifiedPanelActive=false 自动回来);'classic'/'badge' =
  // 新选择器 A/B 版。capable 表示统一面板**可用**(老面板 footer 据此摆「尝试新
  // 选择器」入口),active 才真正启用。
  const modelPickerLayoutPref = useModelPickerLayout();
  const unifiedPanelCapable =
    unifiedModelPanelEnabled && (!inSessionEngineLocked || lockedSessionAgentKind !== null);
  const unifiedPanelActive = unifiedPanelCapable && modelPickerLayoutPref !== 'original';
  const effectiveUnifiedAgents = useMemo<readonly AgentKind[] | undefined>(
    () => (lockedSessionAgentKind ? [lockedSessionAgentKind] : unifiedAgents),
    [lockedSessionAgentKind, unifiedAgents],
  );

  // ── 统一模型选择器 · 新会话形态(model-selector-unified M5)────────────────────
  // 草稿里换引擎是无损的(会话还没建),所以选中一行 = 直接把它整份配置写下去。
  // 深度 / Fast 记忆按**目标引擎**槽写:草稿的生效 Fast 是从这份记忆派生的
  // (NewMakerDraftRoute.resolveDraftFast),收藏副本带来的 Fast 只有落进这里才真生效;
  // 不写就会出现「选了收藏的 Opus·Fast,pill 上却没有闪电」。
  //
  // ── id 口径(数据层把同一模型的多引擎条目合并成一行之后)────────────────────
  // 面板的行身份是**归一化 id**(`rowModelId`),而每个引擎真正能发出去的是各自的
  // **wire id**(`capabilities[engine].wireModelId`,如 cc 侧的 `chatgpt/gpt-5.6-luna`
  // 对 codex 侧的 `gpt-5.6-luna`)。`selection.modelId` 在契约上**已经是选中引擎的
  // wire id**,本函数因此对它零加工:
  //   · 写 providerModelMemory —— 键必须是 wire id(记忆表的既有消费方全按 wire id 存取,
  //     混进归一化 id 会读不回来,表现为"设过的档下次不认");
  //   · 交给草稿层 —— 它会落进 lastByVendor.model,并原样进 createSession。
  // `rowModelId` 只在需要指回"面板上那一行"时有用(收藏锚点等),**绝不能当发送 id**,
  // 所以这里只接收、不消费,也不往下游传。
  const handleUnifiedDraftSelect = useCallback(
    (selection: {
      providerId: string;
      /** 选中引擎的 **wire model id** —— 唯一可发送、可当记忆键的那个 id。 */
      modelId: string;
      effort?: Effort;
      engine: 'cc' | 'codex' | 'pi';
      fast: boolean;
      favoriteUid: string | null;
      /** 行的归一化 id(面板行身份)。草稿层不消费,更不作为发送 id。 */
      rowModelId?: string;
    }) => {
      if (sessionId || settingsLocked) return;
      const targetKind = vendorKeyToAgentKind(selection.engine);
      if (targetKind && selection.providerId) {
        if (selection.effort) {
          modelMemory?.setEffort(
            targetKind,
            selection.providerId,
            selection.modelId,
            selection.effort,
          );
        }
        modelMemory?.setFast(targetKind, selection.providerId, selection.modelId, selection.fast);
      }
      // 乐观来源:草稿没有 SSoT 回流,pill 的来源图标靠这份本地态即时跟上。
      setSelectedProviderId(selection.providerId);
      onUnifiedDraftSelect?.({
        vendor: selection.engine,
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.effort ? { effort: selection.effort } : {}),
        fast: selection.fast,
        favoriteUid: selection.favoriteUid,
      });
    },
    [sessionId, settingsLocked, modelMemory, onUnifiedDraftSelect],
  );

  const performModelChange = useCallback(
    async (newModelId: string, expectedAgentSwitchRevision?: number) => {
      if (settingsLocked) return false;
      const sourceSessionId = sessionId;
      const sourceRemoteDeviceId = sourceSessionId
        ? (deviceLinkDeviceId ?? getSessionDeviceId(sourceSessionId))
        : undefined;
      const sourceIsRemoteSession = Boolean(sourceRemoteDeviceId);
      const isSourceSessionCurrent = () =>
        isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current);
      // 容量护栏最先跑: 用户取消时直接 return, 不留任何副作用(effort 快照都不动)。
      if (sessionId && newModelId !== activeModel) {
        const proceed = await confirmModelSwitchContextGuard(newModelId, sourceRemoteDeviceId);
        if (!proceed || (sourceIsRemoteSession && !isSourceSessionCurrent())) return false;
      }
      // 切换意图期:此时列表展示的是目标引擎(乐观翻转),改选模型 = 更新意图,
      // 绝不能走普通 SET_MODEL 链路(main 会清意图、renderer 乐观态失配)。
      // flat 路径无来源信息,交默认路由(null)。
      // 带 host CAS token = 同引擎 no-op 的第二段收尾。此时 clear push 可能尚未回流，
      // store 里仍是发起前的旧跨引擎意图；不能把它误当成一次新的意图编辑重新登记。
      if (
        sessionId &&
        expectedAgentSwitchRevision === undefined &&
        makerChatStore.getAgentSwitchIntent(sessionId)
      ) {
        const intent = makerChatStore.getAgentSwitchIntent(sessionId)!;
        // ★ await 并**透传真实结果**(Chris 2026-08-19):此前是 fire-and-forget + `return`,
        // 返回 undefined 被上游读成「已应用」——意图期内改选模型时,登记失败 / 被超车的
        // 那一路会被当成成功,后续持久化照跑,而会话上的意图其实一个字没变。
        return await performAgentSwitch(intent.target, newModelId, null);
      }
      let rollbackModelAfterPersistFailure: { model: string; seq: number } | null = null;
      const committedActiveEffort =
        sessionId && !sourceRemoteDeviceId
          ? (effortChangeCoordinatorRef.current.getCommittedEffort(sessionId) ?? activeEffort)
          : activeEffort;
      // 切换前先快照旧模型的当前 effort, 这样 user 切回来时能拿回原选择。
      // 本地 lane 读取上一条已提交值，不依赖 React props 是否已经 rerender。
      if (activeModel && activeModel !== newModelId) {
        setRememberedEffort(activeModel, committedActiveEffort);
      }

      // model-only 不改变当前生效来源；effort 能力也必须按该来源精确解析，避免同 id 的
      // 内置模型档位穿进 BYOM。恢复优先级:模型预设 > 旧 per-model 记忆 > 沿用当前 > 模型默认。
      const { efforts, defaultEffort } = resolveModelEfforts(
        newModelId,
        effectiveSourceId,
      );
      const providerEffort =
        modelMemory && currentModelAgentKind && effectiveSourceId
          ? modelMemory.getEffort(currentModelAgentKind, effectiveSourceId, newModelId)
          : undefined;
      const newEffort = resolveEffort({
        efforts,
        defaultEffort,
        activeEffort: committedActiveEffort,
        providerEffort,
        rememberedEffort: getRememberedEffort(newModelId),
      });
      try {
        if (sessionId) {
          // 切模型时 fast 恢复该 (供应商, 模型) 的记忆值(对齐 effort);模型不支持 → false。
          // 已创建会话会在成功切换后同步 New Maker 草稿默认,使下一次新建聊天复用本次选择。
          const restoredFast = resolveFast(newModelId, effectiveSourceId);
          if (sourceRemoteDeviceId) {
            // device-link 远程会话:控制端纯镜像。把 model/effort/fast 作为一个选择快照交给
            // 被控端 SET_MODEL；host 会在同一 session 锁内完成 runtime + DB 后才回 ack，避免
            // close/wake 的 queue drain 在独立 SET_EFFORT/SET_FAST 之前抢锁。
            // 乐观显示目标 (model, effort) + 置灰 selector,等被控端 echo 回流;失败回滚。
            setPendingRemoteSwitch({
              model: newModelId,
              effort: newEffort,
              providerId: selectedProviderId,
            });
            setRemoteSwitchInFlight(true);
            // 被控端可能返回 { deferred }(会话在跑,凭证切换登记为 pending、turn 结束生效);
            // 老被控端返回 undefined = 立即生效。deferred 时给控制端同款提示,消除"切没切成"疑惑。
            let remoteDeferred = false;
            const remoteMaker = makerApiForDevice(sourceRemoteDeviceId);
            let fastPersisted = true;
            const useAtomicSelection =
              expectedAgentSwitchRevision !== undefined || remoteAtomicModelSelectionSupported;
            try {
              const remoteSetModelResult = await remoteMaker.setModel(
                sessionId,
                newModelId,
                selectedProviderId,
                expectedAgentSwitchRevision,
                useAtomicSelection ? { effort: newEffort, fastMode: restoredFast } : undefined,
              );
              if (remoteSetModelResult?.superseded) {
                if (isSourceSessionCurrent()) setPendingRemoteSwitch(null);
                return false;
              }
              remoteDeferred = remoteSetModelResult?.deferred === true;
              if (!useAtomicSelection) {
                await remoteMaker.setEffort(sessionId, newEffort);
                fastPersisted = await persistFastModeChange(restoredFast, {
                  silent: true,
                  remoteDeviceId: sourceRemoteDeviceId,
                });
              }
            } catch (err) {
              if (isSourceSessionCurrent()) {
                setPendingRemoteSwitch(null);
                toast.error(
                  t(
                    mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.remoteSwitchFailed' }),
                  ),
                );
              }
              return false;
            } finally {
              // 被控端 ack(成功)/ 失败 return 都解除禁用,不等 mirror 三元回流。
              if (isSourceSessionCurrent()) setRemoteSwitchInFlight(false);
            }
            syncSessionDraftModelPrefs(
              newModelId,
              { effort: newEffort, fast: fastPersisted ? restoredFast : fastMode },
              { remoteDeviceId: sourceRemoteDeviceId, markModelChoice: true },
            );
            if (remoteDeferred && isSourceSessionCurrent()) {
              toast.success(t('newChat.chatInput.credentialSwitchDeferred'), { duration: 4000 });
            }
          } else {
            // 本地 model-only 切换也可能跨 Codex credential family；先让 main 的
            // busy gate 接受，再写 DB/UI。deferred = 会话自己在跑,main 已登记 pending、
            // turn 结束自动生效(不再拒绝丢弃选择);此时跳过 runtime setEffort/setFastMode
            // —— 会话 turn 结束会被关闭重建,DB 值届时生效,别去动还在跑的旧 turn。
            const switchSeqBySession = localRuntimeSwitchSeqBySessionRef.current;
            const rollbackSeq = (switchSeqBySession.get(sessionId) ?? 0) + 1;
            switchSeqBySession.set(sessionId, rollbackSeq);
            rollbackModelAfterPersistFailure = { model: activeModel, seq: rollbackSeq };
            const setModelResult = await window.electronAPI.maker.setModel(
              sessionId,
              newModelId,
              undefined,
              expectedAgentSwitchRevision,
              { effort: newEffort, fastMode: restoredFast },
            );
            if (setModelResult?.superseded) {
              rollbackModelAfterPersistFailure = null;
              return false;
            }
            const deferredUntilTurnEnd = setModelResult?.deferred === true;
            rollbackModelAfterPersistFailure = null;
            const effortCoordinator = effortChangeCoordinatorRef.current;
            effortCoordinator.setCommittedEffort(sessionId, newEffort);
            if (deferredUntilTurnEnd) {
              effortCoordinator.suppressRuntimeEffort(sessionId);
              // 默认 success 1200ms 读不完这句;拉长到 4s。
              toast.success(t('newChat.chatInput.credentialSwitchDeferred'), { duration: 4000 });
            }
            syncSessionDraftModelPrefs(newModelId, { effort: newEffort, fast: restoredFast }, {
              markModelChoice: true,
            });
            if (currentModelAgentKind && effectiveSourceId) {
              modelMemory?.setFast(
                currentModelAgentKind,
                effectiveSourceId,
                newModelId,
                restoredFast,
              );
            }
            // fast live 同步:host 已原子落 DB/runtime,这里只更新驱动 chip ⚡ 的 renderer 快照。
            // 目标模型支持 fast 时把恢复值推进快照,否则切到
            // 「该来源记过 fast=on」的模型 chip 读不到、⚡ 掉档(本次修的 bug)。不支持 fast 的模型不在
            // 此动 —— 交给下方 onModelDidChange → handleModelDidChange 的关闭路径(保留「模型不支持已关闭
            // Fast」toast)。deferred 时由 sessions:patched 回流，避免提前改当前 turn 的展示。
            if (!deferredUntilTurnEnd && modelFastSupported(newModelId, effectiveSourceId)) {
              makerChatStore.mirrorSessionFields(sessionId, { fastMode: restoredFast });
            }
          }
          // SSoT: server persisted → ask parent to refresh `session` so the
          // new `initialModel` / `initialEffort` flow back as props next render.
          // (The previous `setLocalModel/setLocalEffort` here created a parallel
          // state track that lagged the props track — see model-selector-xhigh-ui-stale.)
          onModelDidChange?.(newModelId);
          onEffortDidChange?.(newEffort, sessionId, sourceRemoteDeviceId);
          // 记进当前来源的槽:切回该来源时恢复这次选的 (model, effort)。
          rememberProviderChoice(newModelId, newEffort);
          return;
        }

        // 草稿态:全本地生效。onModelDidChange/onEffortDidChange → 父级 patchVendorPrefs 落
        // lastByVendor(localStorage,按 agent 分槽);全局模型预设走 rememberProviderChoice。
        // 不再写服务端默认偏好——离线 / 登录态失效时草稿选择必须照常工作。
        onModelDidChange?.(newModelId);
        onEffortDidChange?.(newEffort);
        rememberProviderChoice(newModelId, newEffort);
      } catch (err) {
        if (
          rollbackModelAfterPersistFailure &&
          sessionId &&
          rollbackModelAfterPersistFailure.seq ===
            localRuntimeSwitchSeqBySessionRef.current.get(sessionId) &&
          !getSessionDeviceId(sessionId)
        ) {
          await window.electronAPI.maker
            .setModel(sessionId, rollbackModelAfterPersistFailure.model, undefined, undefined, {
              effort: activeEffort,
              fastMode,
            })
            .catch((rollbackErr) => {
              log.warn('model change rollback failed:', rollbackErr);
            });
        }
        log.warn('model change failed:', err);
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.switchFailed' })));
        return false;
      }
    },
    [
      activeModel,
      activeEffort,
      sessionId,
      deviceLinkDeviceId,
      selectedProviderId,
      onModelDidChange,
      onEffortDidChange,
      handleFastModeChange,
      persistFastModeChange,
      t,
      getRememberedEffort,
      setRememberedEffort,
      rememberProviderChoice,
      resolveModelEfforts,
      resolveFast,
      currentModelAgentKind,
      effectiveSourceId,
      modelMemory,
      modelFastSupported,
      syncSessionDraftModelPrefs,
      fastMode,
      confirmModelSwitchContextGuard,
      performAgentSwitch,
      remoteAtomicModelSelectionSupported,
      settingsLocked,
    ],
  );

  const handleModelChange = useCallback(
    (newModelId: string, expectedAgentSwitchRevision?: number): Promise<void | boolean> => {
      const remoteDeviceId = sessionId
        ? (deviceLinkDeviceId ?? getSessionDeviceId(sessionId))
        : undefined;
      if (sessionId && !remoteDeviceId) {
        return effortChangeCoordinatorRef.current.enqueue(sessionId, () =>
          performModelChange(newModelId, expectedAgentSwitchRevision),
        );
      }
      return performModelChange(newModelId, expectedAgentSwitchRevision);
    },
    [deviceLinkDeviceId, performModelChange, sessionId],
  );

  /**
   * 返回值 = **这次深度写入真的落下去了没有**(2026-08-17 review 第三轮 G2,口径同
   * handleFastModeChange)。统一面板的「先应用、后清存储」入口按它决定要不要收尾。
   */
  const handleEffortChange = useCallback(
    async (newEffort: Effort): Promise<boolean> => {
      if (settingsLocked) return false;
      // 切换意图期:effort 改动 = 更新意图(重登记),不走普通 setEffort 链路。
      if (sessionId && makerChatStore.getAgentSwitchIntent(sessionId)) {
        const intent = makerChatStore.getAgentSwitchIntent(sessionId)!;
        // await 而非 fire-and-forget:意图重登记成功与否就是这次深度写入的结果。
        return (
          (await performAgentSwitch(intent.target, intent.model, intent.providerId, {
            effort: newEffort,
            fastMode: intent.fastMode,
          })) !== false
        );
      }
      // 用户在当前模型上显式选了 effort → 记下来, 切走再切回来时能恢复
      if (activeModel) {
        setRememberedEffort(activeModel, newEffort);
      }
      try {
        if (sessionId) {
          const remoteDeviceId = deviceLinkDeviceId ?? getSessionDeviceId(sessionId);
          if (remoteDeviceId) {
            // 控制端纯镜像:**await** 运行时隧道 setEffort,被控端持久化后广播回流更新分片。
            // New-K:await 而非 fire-and-forget —— 失败时被控端没真改,不能照报成功、污染默认偏好;
            // toast 提示并 return,不跑下方 onEffortDidChange 成功收尾。
            // 乐观显示目标 effort + 置灰 selector(model/provider 不变),等被控端 echo 回流;失败回滚。
            setPendingRemoteSwitch({
              model: activeModel,
              effort: newEffort,
              providerId: selectedProviderId,
            });
            setRemoteSwitchInFlight(true);
            try {
              await makerApiForDevice(remoteDeviceId).setEffort(sessionId, newEffort);
            } catch (err) {
              if (isSessionScopeCurrent(sessionId, currentSessionIdRef.current)) {
                setPendingRemoteSwitch(null);
                toast.error(
                  t(
                    mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.remoteSwitchFailed' }),
                  ),
                );
              }
              return false;
            } finally {
              if (isSessionScopeCurrent(sessionId, currentSessionIdRef.current))
                setRemoteSwitchInFlight(false);
            }
            if (activeModel) {
              syncSessionDraftModelPrefs(
                activeModel,
                { effort: newEffort, fast: fastMode },
                { remoteDeviceId },
              );
            }
          } else {
            // 同一会话的 effort/model/provider 共用 commit lane，按点击顺序提交 DB → UI。
            // runtime 不阻塞 lane；旧 IPC 晚完成时 coordinator 会重放最新 effort。
            await enqueueEffortChange(effortChangeCoordinatorRef.current, sessionId, newEffort, {
              persist: (targetSessionId, effort) =>
                sessionService.update(targetSessionId, { effort }),
              applyRuntime: (targetSessionId, effort) =>
                window.electronAPI.maker.setEffort(targetSessionId, effort),
              onCommitted: (targetSessionId, effort) => {
                if (activeModel)
                  syncSessionDraftModelPrefs(activeModel, { effort, fast: fastMode });
                // SSoT:持久化成功后直接把确切值交给父级，不再依赖一次竞态 GET。
                onEffortDidChange?.(effort, targetSessionId);
                // 记进当前来源的槽:effort 与 model 同维度记忆。
                if (activeModel) rememberProviderChoice(activeModel, effort);
              },
            });
            return true;
          }
          // 远程会话由被控端 patch 回流；把稳定 device scope 一并传给父级，避免 relay
          // origin 短暂缺失时被误当成本地 session patch。
          onEffortDidChange?.(newEffort, sessionId, remoteDeviceId);
          if (activeModel) rememberProviderChoice(activeModel, newEffort);
          return true;
        }

        // 草稿态:全本地生效(同 handleModelChange 草稿分支)。onEffortDidChange → 父级
        // patchVendorPrefs 落 lastByVendor;全局模型预设走 rememberProviderChoice。
        // 不再写服务端默认偏好——此前 await 服务端成功才刷 UI,token 失效时表现为"档位点不动"。
        onEffortDidChange?.(newEffort);
        if (activeModel) rememberProviderChoice(activeModel, newEffort);
        return true;
      } catch (err) {
        log.warn('effort change failed:', err);
        return false;
      }
    },
    [
      activeModel,
      sessionId,
      deviceLinkDeviceId,
      selectedProviderId,
      onEffortDidChange,
      setRememberedEffort,
      t,
      rememberProviderChoice,
      syncSessionDraftModelPrefs,
      fastMode,
      performAgentSwitch,
      settingsLocked,
    ],
  );

  useEffect(() => {
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: VOICE_INPUT_LONG_PRESS_MS,
      getState: () => voiceInputStateRef.current,
      start: () => handleVoiceInputStartRef.current(),
      stop: () => voiceInputStopRef.current(),
    });
    workLouderVoiceGestureRef.current = gesture;
    return () => {
      gesture.dispose();
      if (workLouderVoiceGestureRef.current === gesture) {
        workLouderVoiceGestureRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!ownsHardwareComposerActions) {
      workLouderVoiceGestureRef.current?.cancelHeldPress();
    }
    return subscribeWorkLouderCodexAction((action) => {
      if (action.type === 'voice' && !ownsHardwareComposerActions) {
        workLouderVoiceGestureRef.current?.cancelHeldPress();
        return false;
      }
      if (!ownsHardwareComposerActions) return false;
      if (action.type === 'skill') {
        if (!editor || editor.isDestroyed || composerMutationLocked) return false;
        editor.chain().focus().insertContent(`$${action.name} `).run();
        return true;
      }
      if (action.type === 'composer-text') {
        if (!editor || editor.isDestroyed || composerMutationLocked) return false;
        editor.chain().focus().insertContent(action.text).run();
        return true;
      }
      if (action.type === 'voice') {
        // One path for the key: the gesture already covers tap-to-start,
        // tap-again-to-stop, and hold-to-talk, matching Cindy's microphone.
        workLouderVoiceGestureRef.current?.handle({ phase: action.phase });
        return true;
      }
      if (action.type !== 'command') return false;
      switch (action.commandId) {
        case 'composer.submit':
          void handleClickSend();
          return true;
        case 'composer.toggleFastMode':
          void handleFastModeChange(!fastMode);
          return true;
        case 'composer.togglePlanMode':
          if (!planModeEntry) return false;
          planModeEntry.onToggle(!planModeEntry.enabled);
          return true;
        case 'composer.focus':
          editor?.commands.focus('end');
          return true;
        case 'composer.addFiles':
        case 'composer.addPhotos':
          suggestionFileInputRef.current?.click();
          return true;
        case 'composer.increaseReasoningEffort':
        case 'composer.decreaseReasoningEffort': {
          const { efforts } = resolveModelEfforts(activeModel, effectiveSourceId);
          if (efforts.length === 0) return false;
          const currentIndex = Math.max(0, efforts.indexOf(activeEffort));
          const delta = action.commandId === 'composer.increaseReasoningEffort' ? 1 : -1;
          const next = efforts[Math.max(0, Math.min(efforts.length - 1, currentIndex + delta))];
          if (!next || next === activeEffort) return true;
          void handleEffortChange(next);
          return true;
        }
        default:
          return false;
      }
    });
  }, [
    activeEffort,
    activeModel,
    composerMutationLocked,
    editor,
    ownsHardwareComposerActions,
    effectiveSourceId,
    fastMode,
    handleClickSend,
    handleEffortChange,
    handleFastModeChange,
    handleVoiceInputPlainStop,
    handleVoiceInputStart,
    planModeEntry,
    resolveModelEfforts,
    voiceInput.isBusy,
    voiceInput.isListening,
  ]);

  // per-session 来源切换。镜像 model 持久化路径(handleModelChange 里的
  // `sessionService.update({ model }) + maker.setModel`):
  //   - maker.setModel(sessionId, activeModel, providerId):第 3 参把显式来源记进
  //     host 的 session-provider-store,即时改变本会话路由(支持会话中途切换);
  //   - sessionService.update({ providerId }):落盘 sessions.provider_id,跨重启可恢复。
  // 乐观更新本地 selectedProviderId(无 SSoT 回流前的即时反馈)。null = 清除显式选择。
  // 切来源时为目标模型决定 effort —— 与 handleModelChange 同套 resolveEffort 策略(共用纯函数)。
  // providerId = 目标来源:用来校验 capability / 兼容读取旧来源槽;新值按 (agent,model) 全局共享。
  // 优先级:preferred(resolveSourceSwitch 带回的 hint)> (agent,model) 全局预设 >
  // per-model 记忆 > 沿用当前 > 模型默认。effort 档走 catalog(含自定义供应商模型)。
  const resolveSwitchEffort = useCallback(
    (targetModelId: string, providerId: string | null, preferred?: Effort): Effort => {
      const { efforts, defaultEffort } = resolveModelEfforts(targetModelId, providerId);
      const providerEffort =
        modelMemory && currentModelAgentKind && providerId
          ? modelMemory.getEffort(currentModelAgentKind, providerId, targetModelId)
          : undefined;
      const committedActiveEffort =
        sessionId && !deviceLinkDeviceId && !getSessionDeviceId(sessionId)
          ? (effortChangeCoordinatorRef.current.getCommittedEffort(sessionId) ?? activeEffort)
          : activeEffort;
      return resolveEffort({
        efforts,
        defaultEffort,
        activeEffort: committedActiveEffort,
        preferred,
        providerEffort,
        rememberedEffort: getRememberedEffort(targetModelId),
      });
    },
    [
      resolveModelEfforts,
      currentModelAgentKind,
      modelMemory,
      getRememberedEffort,
      activeEffort,
      sessionId,
      deviceLinkDeviceId,
    ],
  );

  const performProviderChange = useCallback(
    async (
      newProviderId: string | null,
      reconciledModelId?: string,
      reconciledEffort?: Effort,
      expectedAgentSwitchRevision?: number,
    ) => {
      if (settingsLocked) return false;
      const sourceSessionId = sessionId;
      const sourceRemoteDeviceId = sourceSessionId
        ? (deviceLinkDeviceId ?? getSessionDeviceId(sourceSessionId))
        : undefined;
      const sourceIsRemoteSession = Boolean(sourceRemoteDeviceId);
      const isSourceSessionCurrent = () =>
        isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current);
      // 容量护栏(与 handleModelChange 同款): 切来源若连带换到更小窗口的模型
      // (典型: 官方 Claude 1M → 折扣 GPT 272K, 在选择器里是跨分组点击、走本路径而非
      // handleModelChange —— 2026-07-06 实测踩中), 同样要先过上下文容量确认。
      // 同模型只切来源不拦: 窗口按 model id 取自目录, 来源不变窗口, 无新增风险。
      // 放在函数最前: 本地分支此前无任何乐观状态写入, 用户取消 = 零副作用直接 return。
      if (sessionId && reconciledModelId && reconciledModelId !== activeModel) {
        const proceed = await confirmModelSwitchContextGuard(
          reconciledModelId,
          sourceRemoteDeviceId,
        );
        if (!proceed || (sourceIsRemoteSession && !isSourceSessionCurrent())) return false;
      }
      // 切换意图期:列表展示的是目标引擎(乐观翻转),(来源,模型) 改选 = 更新意图,
      // 不走普通 set-model 链路(main 会清意图、renderer 乐观态失配)。
      // 同 performModelChange：因果 token 存在时必须直达 SET_MODEL，绕过尚未回流
      // 的旧 intent 镜像；最终是否仍新鲜由 host 在 session 锁内用 revision 裁决。
      if (
        sessionId &&
        expectedAgentSwitchRevision === undefined &&
        makerChatStore.getAgentSwitchIntent(sessionId)
      ) {
        const intent = makerChatStore.getAgentSwitchIntent(sessionId)!;
        // 同 performModelChange:await 并透传真实结果,别把「意图重登记失败」当成已应用
        // (Chris 2026-08-19)。
        return await performAgentSwitch(
          intent.target,
          reconciledModelId ?? intent.model,
          newProviderId,
        );
      }
      let rollbackProviderAfterPersistFailure: {
        model: string;
        providerId: string | null;
        seq: number;
      } | null = null;
      const applyProviderSelection = () => {
        if (!isSourceSessionCurrent()) return;
        setSelectedProviderId(newProviderId);
        onProviderDidChange?.(newProviderId);
      };
      const isRemoteSession = sourceIsRemoteSession;
      if (!sessionId || isRemoteSession) {
        // 草稿 / 远程镜像可以先给即时反馈；本地 live session 必须等 main 接受切换后再回写，
        // 避免 busy fail-closed 时 UI/DB 提前显示“已切换”。
        applyProviderSelection();
      }
      // device-link 远程会话:经隧道把 (目标 model, effort, providerId) 应用到被控端 —— await + 失败 toast。
      // 不写控制端 mirror DB、不写本机 provider 记忆:被控端 set-model handler 落 setSessionProvider +
      // persistRemoteSetting 写 provider_id,经 sessions:patched 回流到 mirror,selectedProviderId 随
      // initialProviderId 同步收敛(顶部 setSelectedProviderId 已给即时乐观反馈)。
      // 草稿(无 sessionId)的远程选择已由上方 onProviderDidChange 记进 draft prefs(P2 create 时透传)。
      if (sessionId && sourceRemoteDeviceId) {
        const targetModel =
          reconciledModelId && reconciledModelId !== activeModel ? reconciledModelId : activeModel;
        // effort/fast 从**被控端全局模型预设**恢复;该远程会话当前正在使用的模型仍由 live
        // session 状态保护,只有切到目标 (来源, 模型) 时才应用这个预设。
        // resolveSwitchEffort / resolveFast 内部已按目标模型支持的档位校验、不支持 fast 的模型恒 false。
        const targetEffort = resolveSwitchEffort(targetModel, newProviderId, reconciledEffort);
        const restoredFast = resolveFast(targetModel, newProviderId);
        // 乐观显示目标 (model, effort, provider) + 置灰 selector,等被控端 echo 回流;失败回滚 provider/快照。
        setPendingRemoteSwitch({
          model: targetModel,
          effort: targetEffort,
          providerId: newProviderId,
        });
        setRemoteSwitchInFlight(true);
        // deferred 语义同 handleModelChange 远程分支(被控端会话在跑 → pending、turn 结束生效)。
        let remoteDeferred = false;
        const remoteMaker = makerApiForDevice(sourceRemoteDeviceId);
        let fastPersisted = true;
        const useAtomicSelection =
          expectedAgentSwitchRevision !== undefined || remoteAtomicModelSelectionSupported;
        try {
          const remoteSetModelResult = await remoteMaker.setModel(
            sessionId,
            targetModel,
            newProviderId,
            expectedAgentSwitchRevision,
            useAtomicSelection ? { effort: targetEffort, fastMode: restoredFast } : undefined,
          );
          if (remoteSetModelResult?.superseded) {
            if (isSourceSessionCurrent()) {
              setPendingRemoteSwitch(null);
              setSelectedProviderId(initialProviderId ?? null);
            }
            return false;
          }
          remoteDeferred = remoteSetModelResult?.deferred === true;
          if (!useAtomicSelection) {
            await remoteMaker.setEffort(sessionId, targetEffort);
            fastPersisted = await persistFastModeChange(restoredFast, {
              silent: true,
              remoteDeviceId: sourceRemoteDeviceId,
            });
          }
        } catch (err) {
          if (isSourceSessionCurrent()) {
            setPendingRemoteSwitch(null);
            setSelectedProviderId(initialProviderId ?? null);
            toast.error(
              t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.remoteSwitchFailed' })),
            );
          }
          return false;
        } finally {
          if (isSourceSessionCurrent()) setRemoteSwitchInFlight(false);
        }
        syncSessionDraftModelPrefs(
          targetModel,
          { effort: targetEffort, fast: fastPersisted ? restoredFast : fastMode },
          {
            activeProviderId: newProviderId,
            memoryProviderId: newProviderId,
            remoteDeviceId: sourceRemoteDeviceId,
            markModelChoice: true,
          },
        );
        onModelDidChange?.(targetModel);
        onEffortDidChange?.(targetEffort, sessionId, sourceRemoteDeviceId);
        if (remoteDeferred && isSourceSessionCurrent()) {
          toast.success(t('newChat.chatInput.credentialSwitchDeferred'), { duration: 4000 });
        }
        return;
      }

      // 把这次切换后落定的 (model, effort) 记进新来源的槽,供下次切回时恢复。
      const kind = currentModelAgentKind;
      const remember = (modelId: string, eff: Effort) => {
        if (kind && newProviderId && modelId)
          modelMemory?.setEffort(kind, newProviderId, modelId, eff);
      };
      // 应用「目标 model + effort」:会话态落盘 sessions.{model,effort,providerId} + 即时切运行时路由;
      // 草稿态(无 sessionId)providerId 本就不持久化,只通知父级刷新 SSoT(草稿 vendor prefs)。
      // 两态都写本地记忆(lastByVendor 经父级回调 + 全局模型预设),无服务端偏好写入。
      const applyModelAndEffort = async (modelId: string, eff: Effort) => {
        if (sessionId) {
          // 切来源+模型:fast 恢复目标 (供应商, 模型) 的记忆值(对齐 effort);不支持 → false。
          const restoredFast = resolveFast(modelId, newProviderId);
          const switchSeqBySession = localRuntimeSwitchSeqBySessionRef.current;
          const rollbackSeq = (switchSeqBySession.get(sessionId) ?? 0) + 1;
          switchSeqBySession.set(sessionId, rollbackSeq);
          rollbackProviderAfterPersistFailure = {
            model: activeModel,
            providerId: selectedProviderId ?? null,
            seq: rollbackSeq,
          };
          // deferred = 会话自己在跑,main 已登记 pending、turn 结束自动生效(选择不丢);
          // DB 照常落盘(重启也生效),但跳过 runtime setEffort/setFastMode —— 会话
          // turn 结束会被关闭重建,别去动还在跑的旧 turn。
          const setModelResult = await window.electronAPI.maker.setModel(
            sessionId,
            modelId,
            newProviderId,
            expectedAgentSwitchRevision,
            { effort: eff, fastMode: restoredFast },
          );
          if (setModelResult?.superseded) {
            rollbackProviderAfterPersistFailure = null;
            return false;
          }
          const deferredUntilTurnEnd = setModelResult?.deferred === true;
          rollbackProviderAfterPersistFailure = null;
          const effortCoordinator = effortChangeCoordinatorRef.current;
          effortCoordinator.setCommittedEffort(sessionId, eff);
          if (deferredUntilTurnEnd) {
            effortCoordinator.suppressRuntimeEffort(sessionId);
            toast.success(t('newChat.chatInput.credentialSwitchDeferred'), { duration: 4000 });
          }
          applyProviderSelection();
          syncSessionDraftModelPrefs(
            modelId,
            { effort: eff, fast: restoredFast },
            {
              activeProviderId: newProviderId,
              memoryProviderId: newProviderId,
              markModelChoice: true,
            },
          );
          if (currentModelAgentKind && newProviderId) {
            modelMemory?.setFast(currentModelAgentKind, newProviderId, modelId, restoredFast);
          }
          // fast live 同步:host 已原子落 DB/runtime,这里只更新 renderer 快照。
          // 目标模型支持 fast 时把恢复值推进快照(切来源 / 同来源换模型都覆盖);
          // 不支持 fast 的模型交给 onModelDidChange 的关闭路径(保留 toast)。
          // deferred 时由 sessions:patched 回流。
          if (!deferredUntilTurnEnd && modelFastSupported(modelId, newProviderId)) {
            makerChatStore.mirrorSessionFields(sessionId, { fastMode: restoredFast });
          }
        }
        onModelDidChange?.(modelId);
        onEffortDidChange?.(eff, sessionId);
        remember(modelId, eff);
        return true;
      };
      try {
        // 选源 reconcile:picker 传来新来源下应落到的模型(优先恢复该来源记忆的模型,其次当前
        // 模型不被 offer 时落到首个可用)。原子应用 model+effort+providerId(避免「先改 model
        // 再改 provider」的闭包 stale)。effort 优先用记忆带回的 reconciledEffort(resolveSwitchEffort 内校验)。
        if (reconciledModelId && reconciledModelId !== activeModel) {
          return await applyModelAndEffort(
            reconciledModelId,
            resolveSwitchEffort(reconciledModelId, newProviderId, reconciledEffort),
          );
        }
        // 同模型只切来源:effort/fast 采用同一份 (agent,model) 全局预设,但仍按新来源 capability
        // 校验;不支持的档位回落模型默认。reconciledEffort(来源切换 hint,当前 picker 不传)
        // 仍受支持时优先。
        const { efforts, defaultEffort } = resolveModelEfforts(activeModel, newProviderId);
        const providerEffort =
          modelMemory && currentModelAgentKind && newProviderId
            ? modelMemory.getEffort(currentModelAgentKind, newProviderId, activeModel)
            : undefined;
        // provider task 可能排在 effort commit 后执行；此处必须在 lane 内重新读取最新值，
        // 不能用点击时闭包里的 activeEffort 把刚提交的 effort 写回旧档。
        const committedActiveEffort = sessionId
          ? (effortChangeCoordinatorRef.current.getCommittedEffort(sessionId) ?? activeEffort)
          : activeEffort;
        const targetEffort = resolveProviderSwitchEffort({
          efforts,
          defaultEffort,
          providerEffort,
          preferred: reconciledEffort,
          fallbackEffort: committedActiveEffort,
        });
        // applyModelAndEffort 同时按新来源 capability 校验 fast,并把 (activeModel, targetEffort)
        // 写回模型级全局预设。模型不变,model 字段照写 activeModel(幂等)。
        return await applyModelAndEffort(activeModel, targetEffort);
      } catch (err) {
        const rollbackProvider = rollbackProviderAfterPersistFailure as {
          model: string;
          providerId: string | null;
          seq: number;
        } | null;
        if (
          rollbackProvider &&
          sessionId &&
          rollbackProvider.seq === localRuntimeSwitchSeqBySessionRef.current.get(sessionId) &&
          !isRemoteSession
        ) {
          await window.electronAPI.maker
            .setModel(sessionId, rollbackProvider.model, rollbackProvider.providerId, undefined, {
              effort: activeEffort,
              fastMode,
            })
            .catch((rollbackErr) => {
              log.warn('provider change rollback failed:', rollbackErr);
            });
        }
        log.warn('provider change failed:', err);
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.switchFailed' })));
        return false;
      }
    },
    [
      sessionId,
      activeModel,
      activeEffort,
      deviceLinkDeviceId,
      initialProviderId,
      currentModelAgentKind,
      resolveSwitchEffort,
      resolveModelEfforts,
      resolveFast,
      onModelDidChange,
      onEffortDidChange,
      handleFastModeChange,
      persistFastModeChange,
      onProviderDidChange,
      modelMemory,
      syncSessionDraftModelPrefs,
      fastMode,
      modelFastSupported,
      selectedProviderId,
      t,
      confirmModelSwitchContextGuard,
      performAgentSwitch,
      remoteAtomicModelSelectionSupported,
      settingsLocked,
    ],
  );

  const handleProviderChange = useCallback(
    (
      newProviderId: string | null,
      reconciledModelId?: string,
      reconciledEffort?: Effort,
      expectedAgentSwitchRevision?: number,
    ): Promise<void | boolean> => {
      const remoteDeviceId = sessionId
        ? (deviceLinkDeviceId ?? getSessionDeviceId(sessionId))
        : undefined;
      if (sessionId && !remoteDeviceId) {
        return effortChangeCoordinatorRef.current.enqueue(sessionId, () =>
          performProviderChange(
            newProviderId,
            reconciledModelId,
            reconciledEffort,
            expectedAgentSwitchRevision,
          ),
        );
      }
      return performProviderChange(
        newProviderId,
        reconciledModelId,
        reconciledEffort,
        expectedAgentSwitchRevision,
      );
    },
    [deviceLinkDeviceId, performProviderChange, sessionId],
  );

  // performAgentSwitch 的"选回当前引擎"分支经 ref 调用(两 handler 声明在其后,TDZ)。
  sameEngineReselectRef.current = {
    byProvider: (providerId, modelId, expectedRevision) =>
      handleProviderChange(providerId, modelId, undefined, expectedRevision),
    byModel: (modelId, expectedRevision) => handleModelChange(modelId, expectedRevision),
  };

  const handleNavigateToProviders = useCallback(() => {
    navigate('/settings?tab=providers');
  }, [navigate]);

  const handlePermissionModeChange = useCallback(
    async (newMode: PermissionMode) => {
      if (settingsLocked) return;
      const previousMode = activePermissionModeRef.current;
      if (requiresFullAccessConfirmation(previousMode, newMode)) {
        const confirmed = await confirmDialog({
          title: t('newChat.chatInput.fullAccessConfirmation.title'),
          description: t('newChat.chatInput.fullAccessConfirmation.description'),
          // 逐类权限清单(文件 / 终端命令 / 网络)+ 高风险操作仍确认的脚注。
          content: <FullAccessConfirmContent />,
          // 高风险授权:开场朗读必须覆盖清单全文,SR 用户听全权限再确认。
          describeContent: true,
          // 带清单的确认框放宽到 440(§4:普通确认 400,富内容可适度放宽)。
          maxWidth: 440,
          confirmText: t('newChat.chatInput.fullAccessConfirmation.confirm'),
          cancelText: t('newChat.chatInput.fullAccessConfirmation.cancel'),
          // 警示三角跟随按钮文字颜色,不引入新语义色;高风险升级的视觉提醒。
          confirmIcon: <TriangleAlert size={14} />,
        });
        if (!confirmed) return;
      }
      try {
        if (sessionId) {
          if (getSessionDeviceId(sessionId)) {
            // 控制端纯镜像:运行时隧道 setPermissionMode,被控端持久化后广播回流更新分片。
            await makerApiFor(sessionId).setPermissionMode(sessionId, newMode);
          } else {
            // runtime-first:运行时成功后才持久化，避免 UI/DB 先显示已切换而实际 agent 仍是旧档。
            await window.electronAPI.maker.setPermissionMode(sessionId, newMode);
            try {
              await sessionService.update(sessionId, { permissionMode: newMode });
            } catch (persistError) {
              // DB 写入失败时尽力恢复运行时，保持用户看到的旧设置与实际行为一致。
              try {
                await window.electronAPI.maker.setPermissionMode(sessionId, previousMode);
              } catch (rollbackError) {
                log.warn('permission runtime rollback failed:', rollbackError);
              }
              throw persistError;
            }
          }
        }
        // SSoT: notify parent so it refreshes `session.permissionMode` → props update.
        onPermissionModeDidChange?.(newMode);
      } catch (err) {
        log.warn('permission change failed:', err);
        toast.error(t('newChat.chatInput.permissionSwitchFailed'));
      }
    },
    [sessionId, onPermissionModeDidChange, t, confirmDialog, settingsLocked],
  );
  useEffect(() => {
    handlePermissionModeChangeRef.current = handlePermissionModeChange;
  }, [handlePermissionModeChange]);

  const handleFolderSelect = useCallback(
    async (folderPath: string) => {
      addRecentFolder(folderPath);
      try {
        if (sessionId) {
          await sessionService.update(sessionId, { workingDir: folderPath });
        }
        // Server succeeded → update UI
        setWorkingDir(folderPath);
        onWorkingDirChange?.(folderPath);
      } catch {
        // Server failed → UI stays unchanged
      }
    },
    [sessionId, onWorkingDirChange],
  );

  const hasMessage = !isEditorEmpty(editor);
  renderSnapshotRef.current = composerRenderSnapshot(trigger, hasMessage);
  const canSend = hasMessage || hasAttachments || browserComments.length > 0;
  const hasVoiceDraftText =
    voiceBusyOnCurrentComposer && voiceInput.draftText.trim().length > 0;
  // 推荐 overlay 的可见判据:开关开启 + 有推荐词 + 输入框空 + 无附件/浏览器评论/语音草稿 + 输入框未锁定。
  // composerMutationLocked 涵盖 disabled、sendDispatchInFlight、当前输入框所属语音及远程只读/锁定状态。
  const showRecommendationOverlay =
    recommendationEnabled &&
    !!recommendedPrompt &&
    !hasMessage &&
    !hasAttachments &&
    browserComments.length === 0 &&
    !hasVoiceDraftText &&
    !composerMutationLocked;
  const [voiceReleaseToSendActive, setVoiceReleaseToSendActive] = useState(false);
  const sendButtonDisabled = Boolean(
    disabled ||
    // 空態:当前 agent 无已连接来源 → Send 禁用(设计 Q7NYAD「send 置灰」),引导用户先去连接来源。
    noConnectedSource ||
    // 会话显式选中的来源已断开 → Send 禁用(trigger 同步显示「已断开」错误态说明原因)。
    selectedSourceDisconnected ||
    // device-link 模型目录仍在读取或真实失败 → 禁止旧快照继续发送；旧端明确
    // unsupported 已由 remoteModelListStatus 归并为 ready，不会误伤兼容回退。
    remoteModelListBlocked ||
    // host 尚未完成切换意图登记时不能发送，否则 maker:send 可能先被旧引擎消费。
    agentSwitchInFlight ||
    sendDispatchInFlight ||
    (!voiceBusyOnCurrentComposer && !canSend && !hasVoiceDraftText) ||
    (voiceBusyOnCurrentComposer &&
      (voiceInput.state === 'submitting' || voiceInput.state === 'refining')),
  );
  // Send / Stop 双槽语义 (voice busy = voiceInput.isBusy = listening|submitting|refining,
  // 判定为何用 isBusy 而不是 isListening 见下方第三段):
  // - 主槽 (最右, 永远占位, sendButtonRef 钉在这里):
  //     · 发送瞬间 (inflight=true) → Stop  (Send 原位被替换, 不抖左侧 layout)
  //     · streaming idle (无内容 且 无 voice busy) → Stop  (取代 Send 占主槽)
  //     · 其它 (idle / streaming+canSend / voice busy) → Send
  // - 次槽 (语音按钮左边, 即本组最左; 仅 streaming+(canSend||voice busy)+!inflight 时出现): Stop
  // 设计意图: Send 是最显眼的主行动按钮, 应当永远在最右; streaming idle 时由 Stop 顶替
  // Send 主槽 (原位替换, 不抖); streaming 中用户输入下一条要送入 PendingQueue 时, Send 回
  // 到主槽, Stop 退到次槽. sendDispatchInFlight 锁次槽, 避免 send 瞬间主槽 Send→Stop 切换
  // 的同帧再多出一个 Stop 把模型选择推一下又复位的 bug.
  //
  // 次槽必须在语音按钮**左边**, 不能夹在语音与 Send 之间 (2026-07-25): 本组右对齐, 语音
  // 按钮永远紧邻主槽左侧, 于是它的右边缘恒等于「容器右 - 主槽宽 - gap」, 与是否 streaming /
  // 是否有草稿 / 是否录音全部无关 —— 录音时计时胶囊只向左生长, 原来的麦克风命中点始终留在
  // 按钮内, 用户可以"原地再点一下"停止录音. 若把 Stop 塞进语音与 Send 之间, 语音按钮会随
  // Stop 的出现/消失整格横跳, 而它让出的位置正好被 Stop 占据, 原地再点一下就会误停任务.
  //
  // 槽位判定用 isBusy 而不是 isListening (2026-07-25): 停止录音的瞬间 state 就离开
  // listening 进入 submitting/refining, 但转写文本要等润色完才落进草稿, 中间这一小段
  // canSend 仍是 false —— 若按 isListening 判定, 这一帧会退化成"streaming idle", Stop 弹
  // 回主槽、Send 消失, 等草稿落地再弹回来, 肉眼可见闪一下. isBusy 覆盖整个语音生命周期
  // (listening + submitting + refining), 让槽位从开录到润色结束保持不变; 润色期间主槽是
  // 禁用态 Send (见 sendButtonDisabled), 停止任务的能力由次槽 Stop 承担.
  const mainSlotIsStop =
    showStopButton && (sendDispatchInFlight || (!canSend && !voiceBusyOnCurrentComposer));
  const showSecondaryStop =
    showStopButton && (canSend || voiceBusyOnCurrentComposer) && !sendDispatchInFlight;
  useEffect(() => {
    voiceInputCanStopAndSendRef.current = !sendButtonDisabled;
    composerCanSubmitRef.current = !sendButtonDisabled;
  }, [sendButtonDisabled]);
  const canReleaseVoiceToSend = Boolean(
    !disabled && (voiceInput.isListening || canSend || hasVoiceDraftText),
  );
  const folderBasename = workingDir ? workingDir.split(/[\\/]/).pop() : null;

  // F-QUEUE-DEFER: panel + input fuse into a single visual card when the
  // queue has entries. Two-step rendering would leave a 16px gap between
  // them (the parent's `gap-4`), which reads as "two cards stacked" — the
  // design exploration shows them as one continuous card with a hairline
  // divider, so we wrap them in a gap-0 sub-flex and surgically drop the
  // input's top-border + top-radius.
  const queuePanelState =
    pendingQueue && pendingQueue.length > 0 && onQueueExpandedChange && onQueueRemove
      ? { queue: pendingQueue, onExpandedChange: onQueueExpandedChange, onRemove: onQueueRemove }
      : null;
  const showQueuePanel = queuePanelState !== null;
  // Orca / topSlot 也走 fused-wrapper 模式:外层 wrapper 拿 border + rounded,
  // 内部 topSlot 与 textarea 用 1px hairline 分隔但看起来是一张卡。
  const showTopSlot = !!topSlot;
  const showFusedWrapper = showQueuePanel || showTopSlot;
  const isCreateAgentVariant = visualVariant === 'create-agent';
  // split-pane 同时打开侧栏 / 会话 / 浏览器时，普通会话 composer 也会落到窄容器。
  // 这里必须按 card 实际宽度统一切 compact，而不是只照顾 create-agent；否则普通
  // 会话仍走两组 max-content flex，长模型名会把权限入口挤进语音 / 发送固定动作区。
  const useNarrowToolbar = narrowToolbar || (toolbarWidth != null && toolbarWidth < 600);
  const useCompactMiddleToolbar =
    isCreateAgentVariant && (toolbarWidth == null ? narrowToolbar : toolbarWidth < 600);
  const useUltraCompactToolbar = useNarrowToolbar && (toolbarWidth == null || toolbarWidth < 420);

  return (
    <div className="relative flex w-full flex-col items-center gap-4" data-chat-input-root>
      {/* 计划模式激活态 chip(输入框上方,与 GoalIndicator 同形)。-mb-2 抵一部分
          root gap-4,让 chip 与输入框间距接近 GoalIndicator 的节奏。 */}
      {planModeEntry && planModeEnabled && (
        <div className="-mb-2 w-full">
          <PlanModeIndicator
            onExit={() => void onPlanModeChange?.(false)}
            disabled={composerMutationLocked}
          />
        </div>
      )}
      {/* Voice-input error + attachment rejections (oversize / blocked /
          read-failed) share ONE floating slot above the input card — so they
          don't shrink the typing area and are clearly visible. They MUST live
          in a single flex-col container: two separate same-position absolute
          divs would overlap, and the later one in the DOM would hide the other.
          Stacked here (voice error on top, rejections below) so both stay
          visible when present simultaneously. */}
      {(voiceInput.lastError || rejections.length > 0) && (
        <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-2 flex flex-col items-center gap-1 px-3">
          {voiceInput.lastError && <VoiceInputStatusNotice message={voiceInput.lastError} />}
          {rejections.length > 0 && (
            <AttachmentRejectionStrip rejections={rejections} onDismiss={dismissRejection} />
          )}
        </div>
      )}
      {/* When the pending-queue panel is visible, the wrapper div owns the
          border + corner radius + focus-within highlight. Both inner halves
          (panel + input card) become borderless sections, so a focus on the
          input lights up the entire composite card edge — no kink at the
          panel-input seam. When no panel is visible, the wrapper is a plain
          flex container and the input card carries its own border (legacy
          path, NewMakerDraftRoute relies on this). */}
      {/* Palette anchor layer — palettes (slash / at-mention) use `absolute
          bottom-full`, so their anchor must be the WHOLE merged card: anchoring
          inside the input card made them cover the pending-queue panel stacked
          above it. They can't live inside the wrapper either — fused mode is
          `overflow-hidden` (corner clipping) and would clip the popover away.
          Hence this extra `relative` layer around the wrapper. It also serves
          as the outside-click boundary for collapsing the expanded queue tail
          (see paletteAnchorRef) — palette clicks are "inside". */}
      <div ref={paletteAnchorRef} className="relative w-full">
        <div
          ref={mergedCardRef}
          className={cn(
            'flex w-full flex-col gap-0',
            showFusedWrapper && [
              'overflow-hidden border transition-colors',
              // 输入框卡片圆角与对话页统一为 12px(用户定稿 2026-07-22);create-agent
              // 不再用 Figma 的 6px,避免新建/对话两个框圆角不一致。
              'rounded-[12px]',
              'bg-[var(--chat-input-bg)]',
              'border-[var(--chat-input-border)]',
              isCreateAgentVariant
                ? 'focus-within:border-[var(--chat-input-border-focus)]' // 聚焦描边走 30% 弱化 token;focus-ring 专供键盘 focus-visible(PR#174 review 拆分)
                : 'focus-within:border-[var(--chat-input-border-focus)]',
            ],
          )}
        >
          {queuePanelState && (
            <PendingQueuePanel
              queue={queuePanelState.queue}
              expanded={queueExpanded}
              onToggle={() => queuePanelState.onExpandedChange(!queueExpanded)}
              onRemove={queuePanelState.onRemove}
              onEdit={onQueueEdit}
              onSteer={onQueueSteer ? handleQueueSteer : undefined}
              steeringClientIds={steeringQueueClientIds}
              paused={queuePaused}
              turnRunning={showStopButton}
              onResume={onQueueResume}
              onReorder={onQueueReorder}
              onInteractionLock={onQueueInteractionLock}
              onEditLock={onQueueEditLock}
              mergedWithBelow
              steerShortcutLabel={steerShortcutLabel}
            />
          )}
          {showTopSlot && (
            <div className="border-b border-[var(--chat-input-border)] px-[11px] py-2">
              {topSlot}
            </div>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: this area handles drag/drop; keyboard attachment flow uses the picker controls. */}
          <div
            className={cn(
              'relative flex max-h-[300px] w-full flex-col justify-between px-[11px] pt-[11px] pb-[6px]',
              // 新建对话框内容列变宽后适当加高编辑区,让整框比例更舒展(用户改稿 2026-07-22)。
              isCreateAgentVariant ? 'min-h-[140px]' : 'min-h-[86px]',
              // Standalone mode: own border + bg + focus-within. Fused mode:
              // outer wrapper handles all of that, we render flat.
              showFusedWrapper
                ? null
                : [
                    'border transition-colors',
                    // 输入框卡片圆角与对话页统一为 12px(用户定稿 2026-07-22);create-agent
                    // 不再用 Figma 的 6px,避免新建/对话两个框圆角不一致。
                    'rounded-[12px]',
                    'bg-[var(--chat-input-bg)]',
                    'border-[var(--chat-input-border)]',
                    isCreateAgentVariant
                      ? 'focus-within:border-[var(--chat-input-border-focus)]' // 聚焦描边走 30% 弱化 token;focus-ring 专供键盘 focus-visible(PR#174 review 拆分)
                      : 'focus-within:border-[var(--chat-input-border-focus)]',
                  ],
            )}
            data-split-group-composer-drop-target
            // 卡片里的空白(文字行下方的空隙、工具栏两组按钮之间的空档、四周
            // padding)没有元素承接点击:浏览器默认会把焦点从 contenteditable 撤到
            // <body>,正在输入的光标凭空消失;而点空白又该能进入输入态。所以先
            // preventDefault 掉这次默认的焦点转移,再按需补一次不带坐标的 focus ——
            // 「进入输入态」归空白区,「定位插入点」只归点击文字那一行。
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              if (
                !isComposerBlankPointerTarget(
                  event.target,
                  event.currentTarget,
                  editor && !editor.isDestroyed ? editor.view.dom : null,
                  event,
                )
              ) {
                return;
              }
              event.preventDefault();
              if (!editor || editor.isDestroyed) return;
              const { selection, doc } = editor.state;
              const intent = resolveComposerBlankFocusIntent({
                isDestroyed: editor.isDestroyed,
                isEditable: editor.isEditable,
                isFocused: editor.isFocused,
                caretAtDocStart: selection.empty && selection.from === Selection.atStart(doc).from,
              });
              if (intent === 'keep-caret') editor.commands.focus();
              else if (intent === 'doc-end') editor.commands.focus('end');
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const firstEnter = dragCounterRef.current === 0;
              if (firstEnter && Array.from(e.dataTransfer.types).includes(COMPOSER_MENTION_MIME)) {
                composerMentionDragActiveRef.current = true;
                if (editor && !editor.isDestroyed) {
                  lastComposerSelectionFromRef.current = editor.state.selection.from;
                }
              }
              dragCounterRef.current += 1;
              if (firstEnter && !internalMentionDragActiveRef.current) {
                setIsDragOver(true);
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (internalMentionDragActiveRef.current && editor && !editor.isDestroyed) {
                const dropPos =
                  editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null;
                setMentionDragCaret(editor, dropPos);
                e.dataTransfer.dropEffect = 'move';
              } else {
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragCounterRef.current -= 1;
              if (dragCounterRef.current === 0) {
                setIsDragOver(false);
                composerMentionDragActiveRef.current = false;
                internalMentionDragActiveRef.current = false;
                setMentionDragCaret(editor, null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragCounterRef.current = 0;
              setIsDragOver(false);
              if (composerMutationLocked) return;
              onComposerDropHandled?.();
              // .cindy / .cshare 已被窗口级 capture 接管(装入 / 导入链路),
              // 这里只清理拖拽 UI 状态,不当附件消费。
              if (isGlobalDropIntercepted(e.nativeEvent)) {
                composerMentionDragActiveRef.current = false;
                internalMentionDragActiveRef.current = false;
                setMentionDragCaret(editor, null);
                return;
              }
              const mentionInserted = insertComposerMentionDrop(e);
              composerMentionDragActiveRef.current = false;
              internalMentionDragActiveRef.current = false;
              setMentionDragCaret(editor, null);
              if (mentionInserted) {
                return;
              }
              if (insertSessionLinkDrop(e)) {
                return;
              }
              // 意识面板拖来的产物(cindy-ghost:// 媒体地址):走引渡链路——
              // main 验归属后,图片落图片附件、视频落路径引用的 file 附件(托盘可见)。
              // 键用 storageKey(= draftKey ?? sessionId):新建会话草稿态没有
              // sessionId,附件落草稿命名空间,发送时 rehomeDraftAttachments 迁移。
              const ghostMediaUri = getGhostMediaUriFromDataTransfer(e.dataTransfer);
              if (ghostMediaUri) {
                if (storageKey) void attachGhostMediaToSession(ghostMediaUri, storageKey, t);
                return;
              }
              const attachDroppedItems = (
                items: Pick<DroppedFileItems, 'files' | 'directories'>,
              ) => {
                for (const directory of items.directories) {
                  let folderPath = '';
                  try {
                    folderPath = window.electronAPI.getFilePath(directory);
                  } catch {
                    /* ignore */
                  }
                  if (folderPath) addFolderPath(folderPath);
                }
                if (items.files.length > 0) addFiles(items.files);
              };
              const droppedItems = getDroppedFileItems(e.dataTransfer);
              attachDroppedItems(droppedItems);
              if (droppedItems.unclassified.length > 0) {
                void classifyUnclassifiedDroppedItems(droppedItems.unclassified, {
                  getFilePath: (file) => window.electronAPI.getFilePath(file),
                  classifyPath: (path) =>
                    window.electronAPI.localDb.sessionShare.classifyPath({ path }),
                }).then(attachDroppedItems);
              }
            }}
          >
            {/* Drop overlay (F-FI-1) */}
            {(isDragOver || externalDragOver) && (
              <div
                className={cn(
                  'pointer-events-none absolute inset-0 z-10',
                  // 输入框卡片圆角与对话页统一为 12px(用户定稿 2026-07-22);create-agent
                  // 不再用 Figma 的 6px,避免新建/对话两个框圆角不一致。
                  'rounded-[12px]',
                )}
                style={{
                  backgroundColor: 'var(--drop-overlay-bg)',
                  border: '2px dashed var(--drop-overlay-border)',
                }}
              />
            )}

            {/* Browser comment chip:页面评论收敛为一个「N 条注释」胶囊,
            hover 浮出逐条预览(截图缩略 + 目标标签 + 评论文字,可逐条删),
            X 清空全部。发送时序列化为 `# Browser comments:` 段 + 截图附件。 */}
            {browserComments.length > 0 && (
              <div className="pb-1.5">
                <div className="group/bcomment relative inline-flex">
                  <div
                    className="inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-2.5 text-12 group-hover/bcomment:pr-7"
                    style={{
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {t('chat.browserComment.count', { count: browserComments.length })}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={t('chat.browserComment.clear')}
                    onClick={clearBrowserComments}
                    className="absolute right-1 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full group-hover/bcomment:inline-flex"
                    style={{
                      backgroundColor: 'var(--surface-chip)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {/* hover 预览:逐条评论(截图缩略 + 标签 + 文字),行内可单删。
                  与 quotes 预览不同,这里是可交互面板(pointer-events 开)。 */}
                  <div
                    className="absolute bottom-full left-0 z-30 mb-2 hidden max-h-72 w-80 max-w-[70vw] flex-col gap-2 overflow-y-auto rounded-[12px] border p-3 group-hover/bcomment:flex"
                    style={{
                      backgroundColor: 'var(--surface-elevated)',
                      borderColor: 'var(--border-default)',
                      boxShadow: 'var(--shadow-menu)',
                    }}
                  >
                    {browserComments.map((item) => (
                      <div key={item.id} className="flex min-w-0 items-start gap-2">
                        <img
                          src={item.screenshot.url}
                          alt=""
                          className="h-9 w-14 shrink-0 rounded-md border object-cover"
                          style={{ borderColor: 'var(--border-default)' }}
                          draggable={false}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-10 font-semibold"
                              style={{
                                backgroundColor: 'var(--focus-ring)',
                                color: '#fff',
                              }}
                            >
                              {item.markerNumber}
                            </span>
                            <span
                              className="inline-flex items-center rounded px-1 py-px font-mono text-10"
                              style={{
                                backgroundColor: 'var(--surface-chip)',
                                color: 'var(--text-tertiary)',
                              }}
                            >
                              {commentPreviewTag(item)}
                            </span>
                          </span>
                          <span
                            className="line-clamp-2 whitespace-pre-wrap text-12 leading-[1.5]"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {item.comment || t('chat.browserComment.noText')}
                          </span>
                        </div>
                        <button
                          type="button"
                          aria-label={t('chat.browserComment.removeOne')}
                          onClick={() => removeBrowserComment(item.id)}
                          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                          style={{
                            backgroundColor: 'var(--surface-chip)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Thumbnail strip (F-FI-3) — above EditorContent */}
            {hasAttachments && (
              <ThumbnailStrip
                attachments={attachments}
                onRemove={composerMutationLocked ? () => undefined : removeFile}
                onUpdate={composerMutationLocked ? () => undefined : updateFile}
              />
            )}

            {/* Editor — 用负 margin 向右破出容器的 px-[11px],让 scrollbar 贴到圆角边;
             内层 ProseMirror 加 pr-[11px] 作为文字 gutter,视觉上文字宽度与原先一致。 */}
            <VoiceInputPointerHintLayer
              active={voiceBusyOnCurrentComposer}
              state={voiceInput.state}
              className="w-full"
            >
              <div
                className="relative w-full"
                // 推荐词生效时由 CSS 关掉原生 placeholder,避免两行字叠在一起。
                data-recommendation-active={showRecommendationOverlay ? 'true' : undefined}
              >
                <EditorContent
                  editor={editor}
                  className={cn(
                    'w-[calc(100%+11px)] -mr-[11px]',
                    // Disabled gets the same visual cue as the old textarea
                    composerMutationLocked && 'cursor-not-allowed opacity-60',
                    voiceBusyOnCurrentComposer && 'cursor-default',
                  )}
                  data-voice-draft-active={
                    voiceBusyOnCurrentComposer && voiceInput.draftText ? 'true' : undefined
                  }
                />
                {/* 字号 / 行高 / 颜色与原生 placeholder 对齐,单行截断防止长句撑高输入框。
                    py-[3px] 是镜像 .ProseMirror 的 py-[3px]:它的 -my-[3px] 会穿过这里
                    向外折叠(relative 不建立 BFC),于是 .ProseMirror 的 border box 贴在本
                    容器顶边、正文被自身 padding 推低 3px。overlay 不跟着补这 3px 就会高一行边距。 */}
                {showRecommendationOverlay && (
                  <div
                    className={cn(
                      'pointer-events-none absolute left-0 top-0 w-full truncate py-[3px]',
                      'text-15 leading-[1.467] font-normal',
                      'text-[var(--chat-input-placeholder-subtle)]',
                    )}
                    aria-hidden="true"
                  >
                    {recommendedPrompt}
                  </div>
                )}
              </div>
            </VoiceInputPointerHintLayer>

            {inSessionGoalEnabled && (
              <NewGoalDialog
                open={newGoalOpen}
                onOpenChange={setNewGoalOpen}
                sessionId={sessionId}
                initialObjective={newGoalInitial}
                onCreated={() => {
                  // 目标的默认文字取自 composer,创建成功后清空原文(与发送后清空同款:
                  // 抑制 onUpdate 的 draft-save → 清内容 + 文件 + 页面评论 + 已存草稿)。
                  const ed = editorRef.current;
                  if (!ed || ed.isDestroyed) return;
                  isRestoringRef.current = true;
                  try {
                    ed.commands.clearContent(true);
                  } finally {
                    isRestoringRef.current = false;
                  }
                  discardFiles();
                  // 页面评论走丢弃语义(清 state + 清截图缓存):目标不接管评论截图,
                  // 与发送后清空(消息接管截图,不清缓存)不同,这里不清会留磁盘孤儿。
                  clearBrowserComments();
                  draftRef.current = null;
                  if (storageKey) clearComposerDraft(storageKey);
                }}
              />
            )}
            <div
              className={cn(
                // select-none 挂容器而非逐按钮:Chromium 的 user-select:none 只挡
                // "在元素上起选",从相邻可选区起拖再划入时按钮文字仍会被刷蓝
                // (同 sortable.css 侧栏行修过的 selection bleed),容器级禁选才挡得住。
                'mt-[2px] flex select-none items-center',
                useNarrowToolbar
                  ? 'min-w-0 flex-nowrap justify-between gap-2 overflow-hidden'
                  : effectiveCompactToolbar
                    ? isCreateAgentVariant
                      ? 'min-w-0 flex-nowrap justify-between gap-2 overflow-hidden'
                      : 'min-w-0 flex-nowrap justify-between gap-1 overflow-hidden'
                    : 'justify-between',
              )}
            >
              <div
                className={cn(
                  useNarrowToolbar
                    ? 'flex min-w-0 shrink-0 items-center gap-1'
                    : effectiveCompactToolbar
                      ? isCreateAgentVariant
                        ? 'flex min-w-0 shrink items-center gap-2'
                        : 'flex min-w-0 shrink items-center gap-1'
                      : 'flex items-center gap-2',
                  // create-agent 按 Figma 使用 hug-content pills;默认会话页仍保留左侧优先压缩。
                )}
              >
                {localAttachmentPickerEnabled && (
                  <input
                    ref={suggestionFileInputRef}
                    type="file"
                    multiple
                    disabled={composerMutationLocked}
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = '';
                      if (files.length > 0) void addFiles(files);
                    }}
                  />
                )}
                {/* 「+」只负责合成打开统一建议面板；内容与输入 @ 完全共用。 */}
                <ExtraDirsButton
                  extraDirsCount={(extraDirs ?? []).length}
                  hasReferenceDirs={!settingsLocked && onExtraDirsChange !== undefined}
                  open={syntheticAtOpen}
                  onOpenChange={handleComposerSuggestionOpenChange}
                  autoFocusTarget={composerSuggestionFocusTarget}
                  panel={
                    <AtMentionPanel
                      embedded
                      query={atQuery}
                      state={atState}
                      entries={filteredAt}
                      focusedIndex={atFocus}
                      onFocusedIndexChange={setAtFocus}
                      onSelect={handleComposerSuggestionSelect}
                      onClose={closeAtPanel}
                      onRetry={() => runAtScan(atQuery)}
                      referenceDirs={
                        !settingsLocked && onExtraDirsChange
                          ? {
                              dirs: extraDirs ?? [],
                              onRemove: (path) => {
                                void onExtraDirsChange(
                                  (extraDirs ?? []).filter((item) => item !== path),
                                );
                              },
                            }
                          : null
                      }
                      maxHeight={paletteMaxHeight}
                    />
                  }
                  disabled={composerMutationLocked}
                  dense={effectiveDenseToolbar}
                  visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                />
                <PermissionSelector
                  permissionMode={activePermissionMode}
                  onPermissionModeChange={handlePermissionModeChange}
                  vendorKey={vendorKey}
                  deviceId={deviceLinkDeviceId ?? undefined}
                  disabled={composerEditorLocked || settingsLocked}
                  dense={effectiveDenseToolbar}
                  iconOnly={useUltraCompactToolbar}
                  visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                />
                {useNarrowToolbar && !useCompactMiddleToolbar && <>{middleToolbarSlot}</>}
              </div>
              <div
                className={cn(
                  useNarrowToolbar
                    ? 'flex min-w-0 shrink items-center justify-end gap-1'
                    : effectiveCompactToolbar
                      ? isCreateAgentVariant
                        ? 'flex min-w-0 shrink items-center justify-end gap-2'
                        : 'flex min-w-0 shrink items-center justify-end gap-1'
                      : 'flex items-center gap-2',
                  // compact 模式下所有输入框工具行保持单行;权限 / 模型 pill 内部截断承压,
                  // vendor tab 与圆形操作按钮保持固定宽,避免控件重叠或掉到第二行。
                )}
              >
                {(!useNarrowToolbar || useCompactMiddleToolbar) &&
                  (useCompactMiddleToolbar ? (
                    (compactMiddleToolbarSlot ?? <>{middleToolbarSlot}</>)
                  ) : (
                    <>{middleToolbarSlot}</>
                  ))}
                <div className={useNarrowToolbar ? 'min-w-0 shrink' : undefined}>
                  <ModelSelector
                    // 选中态一律是会话 / 草稿持有的 **wire model id**(sessions.model 或
                    // lastByVendor.model)。面板行的归一化 id 只活在面板内部 —— 从这里递进去
                    // 会让"当前选中的那一行"在合并行上错位,也会把归一化 id 顺着
                    // onProviderChange 漏回会话。
                    modelId={activeModel}
                    effort={activeEffort}
                    onModelChange={handleModelChange}
                    onEffortChange={handleEffortChange}
                    // 意图期显示目标引擎下解析出的 fast(apply 时才落库),无意图走真实态。
                    fastMode={agentSwitchIntent?.fastMode ?? fastMode}
                    onFastModeChange={handleFastModeChange}
                    thinkingEnabled={
                      currentModelAgentKind && effectiveSourceId
                        ? (modelMemory?.getThinking?.(
                            currentModelAgentKind,
                            effectiveSourceId,
                            activeModel,
                          ) ??
                          (!deviceLinkDeviceId
                            ? getProviderModelThinking(
                                currentModelAgentKind,
                                effectiveSourceId,
                                activeModel,
                              )
                            : undefined) ??
                          true)
                        : true
                    }
                    onThinkingChange={async (enabled) => {
                      if (currentModelAgentKind && effectiveSourceId) {
                        if (modelMemory?.setThinking) {
                          modelMemory.setThinking(
                            currentModelAgentKind,
                            effectiveSourceId,
                            activeModel,
                            enabled,
                          );
                        } else if (!deviceLinkDeviceId) {
                          setProviderModelThinking(
                            currentModelAgentKind,
                            effectiveSourceId,
                            activeModel,
                            enabled,
                          );
                        }
                      }
                      if (sessionId) {
                        const api = deviceLinkDeviceId
                          ? makerApiForDevice(deviceLinkDeviceId)
                          : window.electronAPI.maker;
                        await api.setThinkingEnabled(sessionId, enabled);
                      }
                    }}
                    modelMemory={modelMemory}
                    vendorKey={vendorKey}
                    // 稳态只接受父层已加载的 session/runtime 身份；intent 存在时则明确标成
                    // “下条消息”的目标。这样冷启动不猜 Claude Code，切换失败保留 intent
                    // 供重试时也不会长期隐藏身份或把目标冒充为当前 Agent。
                    agentIdentity={
                      sessionId
                        ? resolveModelSelectorAgentIdentity(
                            runtimeAgentKind,
                            agentSwitchIntent?.target,
                          )
                        : undefined
                    }
                    // 统一模型选择器(M5 新会话 / M6 会话内)。composer 是它的两个真实入口;
                    // 其余 7 个消费者(scheduler / IM / Hook / Subagent / Worker /
                    // GhostErrand / 设置)本版一律不开。
                    // pill 形态(model-selector-unified §1.1):不写 harness 名字,改成
                    // 「模型名 + 引擎小标 + 思考深度」。会话内取已确认 / 意图中的引擎
                    // (agentIdentity 同一口径:身份没加载完就不画,不拿 vendorKey 的
                    // Claude Code 回退冒充);草稿直接取当前引擎。
                    // original 形态不传:老 pill 仍写 harness 名字文本(agentIdentity),
                    // 引擎小标是统一面板时代的形态,别把两代形态混在一颗 pill 上。
                    engineMarkVendor={unifiedPanelActive ? composerEngineMarkVendor : null}
                    unifiedPanel={unifiedPanelActive}
                    // 统一面板「可用但未启用」(original 形态)时,老面板 footer 摆
                    // 「尝试新选择器」入口 —— 可用性与启用态分开传,设置类入口两者皆无。
                    unifiedPanelAvailable={unifiedPanelCapable}
                    // 联合列表只列**运行时已注册**的引擎(撤掉 AgentSelect 后接住它的
                    // hiddenVendors 门禁);未加载时不传 = 不隐藏任何引擎。会话内没有
                    // 跨引擎切换事务可走时锁定当前引擎(见 inSessionEngineLocked)。
                    unifiedAgents={effectiveUnifiedAgents}
                    // 会话内:同引擎过滤 + 跨引擎走 performAgentSwitch(见 sessionEngineFilter)。
                    sessionEngineFilter={sessionEngineFilter}
                    // 新会话:选中直通,引擎跟着模型一起落进草稿(见 handleUnifiedDraftSelect)。
                    onUnifiedSelect={
                      !sessionId && unifiedPanelActive && onUnifiedDraftSelect
                        ? handleUnifiedDraftSelect
                        : undefined
                    }
                    // 草稿取调用方持有的锚点,会话取本组件的内存态(见 effectiveSelectedFavoriteUid)。
                    selectedFavoriteUid={effectiveSelectedFavoriteUid}
                    // 会话内同引擎选中一行后回传该行的收藏锚点(跨引擎那一路在
                    // sessionEngineFilter.onCrossEngineSelect 里按事务真实结果自行记录)。
                    onSessionFavoriteAnchorChange={
                      sessionId && unifiedPanelActive ? setSessionFavoriteAnchor : undefined
                    }
                    // session-agent-switch:已建会话提供显式两步引擎切换(列表顶部
                    // Claude/Codex 分段,先选 Agent 再选模型)。device-link 远程会话同样
                    // 支持(隧道到被控端执行,与手机端同一套 channel),入口按被控端能力位
                    // 门控。草稿(无 sessionId)与 SSH 远程会话仍不传。
                    //
                    // 统一面板下**刻意不传**:那两步分段已被「同引擎默认 + 显式跨引擎入口 +
                    // 行浮层引擎胶囊」完整取代(见 ModelSelectorContentProps.sessionEngineFilter
                    // 的 prop 说明),两者同时传会得到一个永远不渲染的分段。
                    agentSwitch={
                      !unifiedPanelActive &&
                      sessionId &&
                      vendorKey &&
                      !remoteHostId &&
                      sessionAgentSwitchSupported
                        ? {
                            currentVendor: vendorKey,
                            // 两步分段的目标是 vendor 口径,确认门按 AgentKind 判(与意图
                            // 记录同形),在边界上转一次 —— 见 confirmAgentBrowseSwitch。
                            confirmBrowseSwitch: (targetVendor: 'cc' | 'codex' | 'pi') =>
                              confirmAgentBrowseSwitch(vendorKeyToAgentKind(targetVendor)),
                            onSwitch: performAgentSwitch,
                          }
                        : undefined
                    }
                    deviceId={deviceLinkDeviceId ?? undefined}
                    // SSH 远程会话隐藏订阅直连模型(chatgpt/ / xai/):bridge 只挂在本地 compat-proxy,
                    // 远程模式走 remoteEndpoint 不经翻译,选了必失败。
                    excludeSubscriptionDirect={!!remoteHostId}
                    // 同理隐藏 openai-chat 桥接的 Codex 供应商(DeepSeek / Kimi / GLM 等):
                    // Responses→Chat 桥只挂在本地 codex-proxy,SSH 远程走 daemon 不经它。
                    excludeChatBridgedCodex={!!remoteHostId}
                    dense={effectiveDenseToolbar}
                    // 意图期显示用户在浏览态选中的来源(null = flat 退化行,跟随默认路由)。
                    currentProviderId={activeProviderId}
                    sourceDisconnected={selectedSourceDisconnected}
                    // 断开来源回落到默认来源后,面板会高亮同模型的回落行;点击该行必须重新
                    // 发出来源选择,把显示中的默认来源钉回会话的显式来源。
                    reselectEmitsChange={selectedSourceDisconnected}
                    // 已建会话按实际路由口径解析当前来源(含停用拷贝,跟真实扣费路由);
                    // 草稿是新路由选择,保持准入口径(PR #744 review 第十轮)。
                    actualRoute={!!sessionId}
                    onProviderChange={handleProviderChange}
                    onNavigateToProviders={handleNavigateToProviders}
                    switching={remoteSwitchInFlight}
                    disabled={
                      disabled || settingsLocked || agentSendDispatchInFlight || agentSwitchInFlight
                    }
                    visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                    compactToolbar={useNarrowToolbar}
                    ultraCompactToolbar={useUltraCompactToolbar}
                    // composer 工具条(含新建对话框 create-agent)统一走脱身上浮 morph;
                    // settings/CreateWorker 不传该 prop → Radix 回退,不 morph。
                    useMorphPopover
                  />
                </div>
                <div
                  className={
                    useNarrowToolbar
                      ? 'flex shrink-0 items-center gap-1'
                      : 'flex items-center gap-2'
                  }
                >
                  {/* 次槽 Stop 必须在语音按钮左边 —— 见 showSecondaryStop 定义处的
                 双槽语义与"语音按钮位置守恒"说明, 不要挪到语音与 Send 之间。 */}
                  {showSecondaryStop && (
                    <SendButton
                      disabled={false}
                      onClick={handleStop}
                      isStreaming
                      visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                    />
                  )}
                  <VoiceInputButton
                    state={voiceBusyOnCurrentComposer ? voiceInput.state : 'idle'}
                    // The surrounding controls stay locked during voice input, but
                    // this control must remain enabled so the recording can stop.
                    disabled={
                      composerEditorLocked ||
                      !editor ||
                      (voiceInput.isBusy && !voiceBusyOnCurrentComposer)
                    }
                    shortcutLabel={voiceInputShortcutLabel}
                    onStart={handleVoiceInputStart}
                    onStop={handleVoiceInputPlainStop}
                    onStopAndSend={handleClickSend}
                    sendTargetRef={sendButtonRef}
                    canReleaseToSend={canReleaseVoiceToSend}
                    releaseToSendActive={voiceReleaseToSendActive}
                    onReleaseToSendChange={setVoiceReleaseToSendActive}
                    visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                    className={isCreateAgentVariant && !useNarrowToolbar ? 'ml-[7px]' : undefined}
                  />
                  {/* mousedown 吃掉默认行为:否则点发送会把焦点从 contenteditable
                      挪到 button 上,发完光标就没了(接着打字要先点回输入框),
                      推荐提示词的 Tab 也会因为编辑器失焦而落到原生焦点导航上。
                      只压默认的「点击聚焦」,click 照常触发,键盘 Tab 聚焦不受影响。 */}
                  <span
                    ref={sendButtonRef}
                    className="inline-flex rounded-full"
                    onMouseDown={(event) => {
                      // 只在编辑器已聚焦时压默认聚焦:点发送会先把焦点从
                      // contenteditable 挪到 button 上,发完光标就没了;
                      // 编辑器未聚焦时保留按钮正常聚焦行为(可访问性)。
                      if (editor?.isFocused) event.preventDefault();
                    }}
                  >
                    {mainSlotIsStop ? (
                      <SendButton
                        disabled={false}
                        onClick={handleStop}
                        isStreaming
                        visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                      />
                    ) : (
                      <Tip
                        text={
                          voiceReleaseToSendActive
                            ? t('newChat.chatInput.voiceInput.releaseToSend')
                            : voiceInput.isListening && !sendButtonDisabled
                              ? `${t('newChat.chatInput.voiceInput.finishAndSend')} · ${composerSendShortcutLabel}`
                              : showStopButton
                                ? composerSendShortcutPreference === 'modifier-enter'
                                  ? t('newChat.sendButton.queueTooltipSendMode', {
                                      shortcut: composerSendShortcutLabel,
                                    })
                                  : t('newChat.sendButton.queueTooltip', {
                                      shortcut: steerShortcutLabel,
                                    })
                                : !sendButtonDisabled
                                  ? `${t('newChat.sendButton.send')} · ${composerSendShortcutLabel}`
                                  : selectedSourceDisconnected
                                    ? t('newChat.sourceDisconnected.sendBlocked')
                                    : null
                        }
                        side="top"
                        forceOpen={voiceReleaseToSendActive}
                      >
                        {/* Tip 的 trigger 放在稳定 wrapper 上，而不是 button 本身。
                            disabled button 不会可靠地产生 hover/focus 事件；曾经因此让
                            running 时“排队/快捷键插话”提示完全不出现。 */}
                        <span className="inline-flex rounded-full">
                          <SendButton
                            disabled={sendButtonDisabled}
                            highlighted={voiceReleaseToSendActive}
                            visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                            ariaLabel={
                              showStopButton
                                ? t('newChat.sendButton.queue')
                                : t('newChat.sendButton.send')
                            }
                            onClick={() => {
                              void handleClickSend();
                            }}
                          />
                        </span>
                      </Tip>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Palette host — tracks mouseover to prevent blur-close races.
           Palettes use `absolute bottom-full` referencing the palette anchor
           layer above, so they appear flush above the ENTIRE ChatInputBox —
           pending-queue panel included — matching the design spec
           (command-palette.pen: Slash Popover Wrap bottom ≈ ChatInputBox top). */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover tracking prevents palette blur-close races; rows remain keyboard reachable. */}
        <div
          onMouseEnter={() => setPalettePanelHover(true)}
          onMouseLeave={() => setPalettePanelHover(false)}
        >
          {/* Slash palette */}
          {slashOpen && trigger.kind === 'slash' && (
            <SlashCommandPalette
              query={trigger.query}
              commands={paletteCommands}
              focusedIndex={slashFocus}
              onFocusedIndexChange={setSlashFocus}
              onSelect={(cmd) => insertSlashCommand(cmd)}
              onClose={() => {
                if (trigger.kind === 'slash') setSuppressedSlashAt(trigger.from);
              }}
              onTooltipHoverChange={setPaletteTooltipHover}
              maxHeight={paletteMaxHeight}
            />
          )}

          {/* At-mention panel */}
          {typedAtOpen && effectiveAt && (
            <AtMentionPanel
              query={atQuery}
              state={atState}
              entries={filteredAt}
              focusedIndex={atFocus}
              onFocusedIndexChange={setAtFocus}
              onSelect={handleComposerSuggestionSelect}
              onClose={closeAtPanel}
              onRetry={() => runAtScan(atQuery)}
              referenceDirs={
                onExtraDirsChange
                  ? {
                      dirs: extraDirs ?? [],
                      onRemove: (path) => {
                        void onExtraDirsChange((extraDirs ?? []).filter((item) => item !== path));
                      },
                    }
                  : null
              }
              maxHeight={paletteMaxHeight}
            />
          )}
        </div>
      </div>

      {/* 长文本粘贴 chip 的编辑弹窗(editorProps.handleClickOn 打开)。 */}
      {pastedTextEditTarget != null && (
        <ToolPayloadLightbox
          payload={{
            kind: 'text',
            title: t('newChat.pastedText.editTitle'),
            text: pastedTextEditTarget.originalText,
          }}
          textEdit={{
            cancelLabel: t('newChat.pastedText.cancelEdit'),
            saveLabel: t('newChat.pastedText.saveEdit'),
            onSave: handleSavePastedText,
          }}
          onClose={handleClosePastedTextEdit}
        />
      )}

      {/* Select Folder row — folder chip 默认显示，可被 leftOfFolderPicker 注入的 toolbar 替代。
          showFolderPicker=false + leftOfFolderPicker 提供独立 toolbar 时，本行只渲染 toolbar（不显示 folder chip）
          delayed-create:sessionId=undefined 也要显示(NewMakerDraftRoute 走 transient 模式),
          handleFolderSelect 的 sessionService.update 内部已用 sessionId guard。 */}
      {(showFolderPicker || leftOfFolderPicker) && (
        <div className="flex w-full items-end justify-end gap-2">
          {leftOfFolderPicker}
          {showFolderPicker && (
            <FolderPickerPopover
              open={folderOpen}
              onOpenChange={setFolderOpen}
              onSelect={handleFolderSelect}
            >
              <Tip text={workingDir ?? null} mono side="top">
                <button
                  type="button"
                  className={cn(
                    'flex h-[46px] items-center gap-[10px] rounded-full',
                    'border px-5',
                    'bg-[var(--folder-btn-bg)]',
                    'border-[var(--folder-btn-border)]',
                    'transition-colors',
                    'hover:bg-[var(--folder-item-hover)]',
                    'focus-visible:outline-none',
                  )}
                  aria-label={t('newChat.folderPicker.selectFolder')}
                >
                  <Folder size={18} className="shrink-0 text-[var(--folder-btn-icon)]" />
                  <span className="text-15 font-normal text-[var(--folder-btn-text)]">
                    {folderBasename ?? t('newChat.folderPicker.selectFolder')}
                  </span>
                </button>
              </Tip>
            </FolderPickerPopover>
          )}
        </div>
      )}
    </div>
  );
}

function VoiceInputButton({
  state,
  disabled,
  shortcutLabel,
  onStart,
  onStop,
  onStopAndSend,
  sendTargetRef,
  canReleaseToSend,
  releaseToSendActive,
  onReleaseToSendChange,
  className,
}: {
  state: import('@cindy/voice-input-core').VoiceInputState;
  disabled: boolean;
  shortcutLabel: string;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onStopAndSend: () => Promise<void>;
  sendTargetRef: RefObject<HTMLElement | null>;
  canReleaseToSend: boolean;
  releaseToSendActive: boolean;
  onReleaseToSendChange: (active: boolean) => void;
  visualVariant?: 'default' | 'create-agent';
  className?: string;
}) {
  const { t } = useTranslation();
  const [longPressActive, setLongPressActive] = useState(false);
  const timerRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointerPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const longPressStartedRef = useRef(false);
  const pointerStartedRecordingRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const releaseToSendActiveRef = useRef(false);
  const listening = state === 'listening';
  const refining = state === 'refining';
  const busy = state === 'submitting' || state === 'refining';
  const activeRecording = listening || longPressActive;
  const disabledOrBusy = disabled || (busy && !longPressActive);

  // ── 录音态宽度形变 + 计时(DESIGN.md §14.4 窄变体,≤240ms)──
  // 仅录音中展开(2026-07-22 用户定稿:展开必须承载信息,hover 展出「语音」
  // 文案已移除):红点(呼吸,仅 opacity 动画挂 wrapper,规则 7)+ 计时。
  // 会话内与新建对话框共用同一套(不再按 create-agent 分叉)。
  // 计时数字 tabular-nums 等宽,配合"分钟位数变化才重新量宽",秒跳动不抖框。
  const [recSeconds, setRecSeconds] = useState(0);
  const pillLabelRef = useRef<HTMLSpanElement>(null);
  const [pillWidth, setPillWidth] = useState<number | null>(null);
  const expandable = true;
  const expanded = expandable && activeRecording;
  const minuteDigits = String(Math.floor(recSeconds / 60)).length;

  useEffect(() => {
    if (!activeRecording) return;
    setRecSeconds(0);
    const id = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [activeRecording]);

  useLayoutEffect(() => {
    if (!expandable) return;
    if (!expanded) {
      setPillWidth(null);
      return;
    }
    // 28px 图标位 + 标签实测宽(含右 padding)+ 2px 余量
    setPillWidth(28 + (pillLabelRef.current?.scrollWidth ?? 0) + 2);
  }, [expandable, expanded, activeRecording, minuteDigits]);

  const recTimeText = `${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, '0')}`;
  // 宽度过渡走 inline transition(与 class transition-colors 合并声明,避免
  // tailwind transition-property 工具类互相覆盖的顺序不确定性);reduced-motion 直切
  const reduceMotion =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const pillTransition = reduceMotion
    ? undefined
    : 'width 240ms cubic-bezier(0.3, 0.9, 0.25, 1), background-color 150ms ease, color 150ms ease, border-color 150ms ease';
  let label = t('newChat.chatInput.voiceInput.start');
  if (longPressActive) {
    label = t('newChat.chatInput.voiceInput.releaseToStop');
  } else if (refining) {
    label = t('newChat.chatInput.voiceInput.refining');
  } else if (activeRecording) {
    label = t('newChat.chatInput.voiceInput.stop');
  }
  const tooltipText =
    shortcutLabel && !longPressActive && !refining ? `${label} · ${shortcutLabel}` : label;
  const controlledTooltipOpen = refining
    ? true
    : longPressActive
      ? !releaseToSendActive
      : undefined;

  const clearLongPressTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearSuppressClickTimer = useCallback(() => {
    if (suppressClickTimerRef.current === null) return;
    window.clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = null;
  }, []);

  const clearSuppressNextClick = useCallback(() => {
    clearSuppressClickTimer();
    suppressNextClickRef.current = false;
  }, [clearSuppressClickTimer]);

  const armSuppressNextClick = useCallback(() => {
    clearSuppressClickTimer();
    suppressNextClickRef.current = true;
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 250);
  }, [clearSuppressClickTimer]);

  const setReleaseToSendActive = useCallback(
    (active: boolean) => {
      if (releaseToSendActiveRef.current === active) return;
      releaseToSendActiveRef.current = active;
      onReleaseToSendChange(active);
    },
    [onReleaseToSendChange],
  );

  const updateReleaseToSendTarget = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      lastPointerPointRef.current = { clientX: event.clientX, clientY: event.clientY };
      if (!longPressStartedRef.current) return;
      setReleaseToSendActive(
        canReleaseToSend &&
          isPointInsideElement(sendTargetRef.current, event.clientX, event.clientY, 10),
      );
    },
    [canReleaseToSend, sendTargetRef, setReleaseToSendActive],
  );

  useEffect(() => {
    if (!longPressActive) {
      setReleaseToSendActive(false);
      return;
    }
    const point = lastPointerPointRef.current;
    if (!point) return;
    setReleaseToSendActive(
      canReleaseToSend &&
        isPointInsideElement(sendTargetRef.current, point.clientX, point.clientY, 10),
    );
  }, [canReleaseToSend, longPressActive, sendTargetRef, setReleaseToSendActive]);

  const finishLongPress = useCallback(
    (send: boolean, cancelStartedRecording = false) => {
      clearLongPressTimer();
      pointerIdRef.current = null;
      const longPressStarted = longPressStartedRef.current;
      longPressStartedRef.current = false;
      const pointerStartedRecording = pointerStartedRecordingRef.current;
      pointerStartedRecordingRef.current = false;
      if (pointerStartedRecording) {
        armSuppressNextClick();
      }
      if (!longPressStarted) {
        if (cancelStartedRecording && pointerStartedRecording) {
          void onStop();
        }
        return;
      }
      setLongPressActive(false);
      setReleaseToSendActive(false);
      void (send ? onStopAndSend() : onStop());
    },
    [armSuppressNextClick, clearLongPressTimer, onStop, onStopAndSend, setReleaseToSendActive],
  );

  useEffect(() => {
    return () => {
      clearLongPressTimer();
      clearSuppressNextClick();
      longPressStartedRef.current = false;
      pointerStartedRecordingRef.current = false;
      setReleaseToSendActive(false);
    };
  }, [clearLongPressTimer, clearSuppressNextClick, setReleaseToSendActive]);

  return (
    <Tip text={tooltipText} side="top" controlledOpen={controlledTooltipOpen}>
      <button
        type="button"
        className={cn(
          'flex shrink-0 items-center rounded-full',
          // 语音按钮:常驻外框 + 录音展开(红点+计时)。会话内与新建对话框共用同一套
          // (2026-07-22 用户定稿:裸态只用于 +/权限/模型;语音/发送常驻框,create-agent 不再分叉)。
          // 宽度由 inline style 驱动,标签溢出裁剪。
          'h-[30px] justify-start overflow-hidden p-0',
          'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)] border border-[var(--border-default)] text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]' /* spec 2026-07-17, token by 一哥 */,
          'hover:bg-[var(--model-trigger-hover)]',
          // 录音态:与主题同极性的 chip 填充(light 亮灰 / dark 深灰),红点 + 计时承担状态信号
          activeRecording &&
            'bg-[var(--surface-chip)] text-[var(--text-primary)] hover:bg-[var(--surface-chip)]',
          'focus-visible:outline-none',
          disabledOrBusy && 'cursor-not-allowed opacity-40',
          className,
        )}
        style={expandable ? { width: pillWidth ?? 30, transition: pillTransition } : undefined}
        disabled={disabledOrBusy}
        aria-label={label}
        aria-pressed={activeRecording}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.blur();
          if (disabledOrBusy || listening) return;
          pointerIdRef.current = event.pointerId;
          lastPointerPointRef.current = { clientX: event.clientX, clientY: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
          clearLongPressTimer();
          longPressStartedRef.current = false;
          pointerStartedRecordingRef.current = true;
          setReleaseToSendActive(false);
          void onStart();
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            longPressStartedRef.current = true;
            setLongPressActive(true);
          }, VOICE_INPUT_LONG_PRESS_MS);
        }}
        onPointerMove={updateReleaseToSendTarget}
        onPointerUp={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          updateReleaseToSendTarget(event);
          const shouldSend =
            canReleaseToSend &&
            isPointInsideElement(sendTargetRef.current, event.clientX, event.clientY, 10);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          finishLongPress(shouldSend);
        }}
        onPointerCancel={() => finishLongPress(false, true)}
        onClick={() => {
          if (suppressNextClickRef.current) {
            clearSuppressNextClick();
            return;
          }
          void (listening ? onStop() : onStart());
        }}
      >
        {/* 28px 图标位: idle 麦克风 / 录音红点(呼吸动画挂 wrapper,仅 opacity) / refining spinner。
            会话内与新建对话框共用(不再按 create-agent 分叉)。 */}
        <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center">
          {refining ? (
            <Spinner size={15} />
          ) : activeRecording ? (
            <span className="inline-flex animate-pulse motion-reduce:animate-none">
              <span className="h-2 w-2 rounded-full bg-[var(--settings-badge-error)]" />
            </span>
          ) : (
            <Mic size={15} />
          )}
        </span>
        {/* 录音计时(tabular-nums 等宽,秒跳不抖框);非录音态无标签,按钮保持圆形 */}
        <span
          ref={pillLabelRef}
          className={cn(
            'whitespace-nowrap pr-3 text-12 tabular-nums',
            '-translate-x-1 opacity-0 transition-[opacity,transform] duration-[180ms] ease-out',
            expanded && 'translate-x-0 opacity-100',
            'motion-reduce:transition-none',
          )}
        >
          {activeRecording ? recTimeText : ''}
        </span>
      </button>
    </Tip>
  );
}

// ── Attachment rejection strip — internal to ChatInput ──
//
// Replacement for the old top-center toast.warning on attachment rejection
// (oversize / blocked type / read failure). Floats ABOVE the input card (same
// slot as the voice-input error notice) so it doesn't shrink the typing area,
// and persists until the next add attempt or manual dismiss (no auto-hide).
// Visually mirrors VoiceInputStatusNotice: a neutral rounded pill with a red
// warning icon + a dismiss button, stacked one per rejected file.
function AttachmentRejectionStrip({
  rejections,
  onDismiss,
}: {
  rejections: { id: string; message: string }[];
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {rejections.map((r) => (
        <div
          key={r.id}
          role="status"
          className={cn(
            'pointer-events-auto inline-flex max-w-[640px] items-center gap-2',
            'rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
            'px-4 py-[10px] text-13 font-medium leading-snug text-[var(--cmd-palette-item-text)]',
            'shadow-[var(--shadow-menu)]',
          )}
        >
          <TriangleAlert
            aria-hidden
            className="h-4 w-4 shrink-0 text-[var(--error-fg)]"
            strokeWidth={2}
          />
          <span className="min-w-0 max-w-[calc(100vw-96px)] break-words">{r.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(r.id)}
            aria-label={t('newChat.chatInput.attachmentRejection.dismiss')}
            className="-mr-1 shrink-0 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <X aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      ))}
    </>
  );
}

// ── Thumbnail components (F-FI-3/4/5) — internal to ChatInput ──

/**
 * 标注编辑保存回调(惰性烧录):只把矢量笔迹写回附件——url/base64 保持原图
 * 不变,烧录位图在发送消息时由 materializeAnnotatedAttachmentsForSend 统一
 * 生成。空笔迹 = 清掉标注字段,附件回到普通图片。
 */
function applyAnnotationEdit(
  file: AttachedFile,
  result: { strokes: ImageAnnotationStroke[] },
  onUpdate: (id: string, patch: Partial<AttachedFile>) => void,
): void {
  if (result.strokes.length === 0) {
    onUpdate(file.id, { annotationStrokes: undefined });
  } else {
    onUpdate(file.id, { annotationStrokes: result.strokes });
  }
}

function ThumbnailStrip({
  attachments,
  onRemove,
  onUpdate,
}: {
  attachments: AttachedFile[];
  onRemove: (id: string) => void;
  /** 标注编辑保存后就地替换附件(useAttachments.updateFile)。 */
  onUpdate: (id: string, patch: Partial<AttachedFile>) => void;
}) {
  return (
    <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto pb-2 pl-0 pr-2 pt-2">
      {attachments.map((file) => (
        <ThumbnailItem key={file.id} file={file} onRemove={onRemove} onUpdate={onUpdate} />
      ))}
    </div>
  );
}

function ThumbnailItem({
  file,
  onRemove,
  onUpdate,
}: {
  file: AttachedFile;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<AttachedFile>) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // attachment-thumb-click (2026-04-19): mirror UserMessage behaviour — clicking
  // a thumbnail opens the same overlay used in the message stream:
  //   - image  → ImageLightbox (full-screen image preview)
  //   - other  → TextLightbox (file content / oversize CTA)
  // Lightbox state is local to each item so multiple thumbnails don't fight.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [textLightboxOpen, setTextLightboxOpen] = useState(false);
  const isDownloadOnly =
    isDangerousAttachmentName(file.name) || isDangerousAttachmentName(file.path);

  // 非图片附件仍使用路径 tooltip；图片定位由共享 ImageHoverPreview 自己负责。
  useLayoutEffect(() => {
    if (isHovered && file.category !== 'image' && thumbRef.current) {
      const rect = thumbRef.current.getBoundingClientRect();
      setPopoverPos({
        top: rect.top,
        left: rect.left + rect.width / 2,
      });
    } else {
      setPopoverPos(null);
    }
  }, [file.category, isHovered]);

  const handleOpenPreview = useCallback(async () => {
    // attachment-thumb-click polish (2026-04-19): clicking opens the lightbox
    // INSTEAD of leaving the hover preview/tooltip dangling. Reset the hover
    // flag here so the portal popover (image preview / path tooltip) hides
    // immediately — otherwise it stays visible behind the lightbox and is
    // still on screen the moment the lightbox closes (mouse hasn't moved, so
    // onMouseLeave never fires on its own).
    setIsHovered(false);
    if (file.category === 'image') {
      // 惰性烧录:托盘附件的 url/base64 恒为原图,已有笔迹由 lightbox 以矢量
      // 叠加显示(可继续编辑/撤销)。
      const src = file.url ?? (file.base64 ? `data:${file.mimeType};base64,${file.base64}` : null);
      if (src) setLightboxSrc(src);
      return;
    }
    // Historical composer drafts may still contain an executable's original
    // path from before dangerous attachments were staged as `.bin`. Never pass
    // those paths to the OS default-app opener from the attachment tray.
    if (isDownloadOnly) return;
    // Non-image text/code/markdown files preview via TextLightbox. Other
    // supported attachment categories (PDF, etc.) open in the system app.
    if (!file.path) return;
    if (!(await shouldOpenTextLightbox(file.path))) return;
    setTextLightboxOpen(true);
  }, [file, isDownloadOnly]);

  // 图片缩略图恒为 56×56 方块;其余附件走横向文件卡,宽度随文件名自适应
  // (上限 220px)。判定条件必须与下面渲染分支一致——缓存写失败、既无 url 也无
  // base64 的图片同样落到文件卡分支。
  const isImageThumb = file.category === 'image' && Boolean(file.url || file.base64);
  // 副行是「类型 · 大小」;无扩展名(Makefile 之类)或 size 缺失时按存在的部分给。
  // file.size 是拖入那一刻的快照:文件在托盘期间被改写后,发出去的是新内容,卡片
  // 却还报旧字节数。缩略图复核时 main 会把当前 stat 大小一并带回,这里优先用它。
  const extLabel = file.ext.replace('.', '').toUpperCase();
  const [liveByteSize, setLiveByteSize] = useState<number | null>(null);
  const shownSize = liveByteSize ?? file.size;
  // 复核回来的 0 是**真实的当前大小**(文件被清空了),要照实显示 0 B;只有拿不到
  // 复核值、且快照本身就是 0/缺失时才省掉大小段。
  const hasSize =
    Number.isFinite(shownSize) && (liveByteSize !== null ? shownSize >= 0 : shownSize > 0);
  const metaLine = [extLabel || null, hasSize ? formatBytes(shownSize) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      ref={thumbRef}
      className="group relative shrink-0"
      style={isImageThumb ? { width: 56, height: 56 } : { height: 56, maxWidth: 220 }}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      {/* Thumbnail content */}
      {/* image-local-cache: prefer xdt-image:// url; fall back to base64 (F6). */}
      <button
        type="button"
        className={cn(
          'h-full w-full border-0 bg-transparent p-0 text-left',
          isDownloadOnly ? 'cursor-default' : 'cursor-pointer',
        )}
        onClick={handleOpenPreview}
        disabled={isDownloadOnly}
        aria-label={
          isDownloadOnly
            ? t('chat.userMessage.attachmentAttachedAria', { name: file.name })
            : `Preview ${file.name}`
        }
      >
        {file.category === 'image' && (file.url || file.base64) ? (
          <span className="relative block h-full w-full">
            <img
              src={file.url ?? `data:${file.mimeType};base64,${file.base64}`}
              alt={file.name}
              className="h-full w-full rounded-lg object-cover"
              draggable={false}
            />
            {file.annotationStrokes && file.annotationStrokes.length > 0 ? (
              <span
                className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full"
                style={{ backgroundColor: 'var(--annotation-accent)' }}
                aria-hidden
              >
                <Pen className="h-2.5 w-2.5 text-white" />
              </span>
            ) : null}
          </span>
        ) : (
          // 文件卡(2026-07-27):图标块 + 文件名 + 「类型 · 大小」。此前是一个只印
          // 扩展名的 56×56 方块,并排两份 PDF 根本认不出谁是谁——文件名必须直接
          // 可见,不能只挂在 hover tooltip 上。
          <div
            className="flex h-full w-full items-center gap-2 rounded-xl px-2"
            style={{ backgroundColor: 'var(--surface-chip)' }}
          >
            <span
              // 缩略区比卡片底再抬一层:--file-chip-bg 与 --surface-chip 在 Light
              // 下只差一档灰(#D8D9DB / #e5e5e5),实机上根本看不出块。内容由
              // AttachmentTypeThumb 决定:优先系统缩略图,拿不到回落自绘类型图标。
              className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
              style={{ backgroundColor: 'var(--surface-elevated)' }}
            >
              <AttachmentTypeThumb file={file} onByteSize={setLiveByteSize} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                {file.name}
              </span>
              {metaLine ? (
                <span className="truncate text-11" style={{ color: 'var(--text-secondary)' }}>
                  {metaLine}
                </span>
              ) : null}
            </span>
          </div>
        )}
      </button>

      {/* Remove button — visible on hover */}
      <button
        type="button"
        className={cn(
          'absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-10 text-white',
          'opacity-0 transition-opacity group-hover:opacity-100',
        )}
        style={{ backgroundColor: 'var(--file-remove-bg)' }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(file.id);
        }}
        aria-label={`Remove ${file.name}`}
      >
        &times;
      </button>

      {/* Hover preview / tooltip (F-FI-4) — rendered via portal to escape overflow clipping */}
      {file.category === 'image' && (file.url || file.base64) ? (
        <ImageHoverPreview
          open={isHovered}
          anchorRef={thumbRef}
          src={file.url ?? `data:${file.mimeType};base64,${file.base64}`}
          alt={file.name}
        />
      ) : null}
      {isHovered &&
        popoverPos &&
        file.category !== 'image' &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs"
            style={{
              top: popoverPos.top - 10, // 10px gap above thumbnail
              left: popoverPos.left,
              transform: 'translate(-50%, -100%)',
              backgroundColor: 'var(--tooltip-bg)',
              color: 'var(--tooltip-text)',
            }}
          >
            {file.path}
          </div>,
          document.body,
        )}

      {/* attachment-thumb-click (2026-04-19): lightboxes mirroring UserMessage. */}
      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          onClose={() => setLightboxSrc(null)}
          // 托盘图片的标注编辑:惰性烧录只写回矢量笔迹,不再依赖会话缓存,
          // 缓存附件与草稿 base64 附件统一支持。
          annotationEdit={
            file.category === 'image' && (file.url || file.base64)
              ? {
                  initialStrokes: file.annotationStrokes,
                  onSave: (result) => applyAnnotationEdit(file, result, onUpdate),
                }
              : undefined
          }
        />
      )}
      {textLightboxOpen && (
        <TextLightbox
          filePath={file.path}
          fileName={file.name}
          onClose={() => setTextLightboxOpen(false)}
        />
      )}
    </div>
  );
}
