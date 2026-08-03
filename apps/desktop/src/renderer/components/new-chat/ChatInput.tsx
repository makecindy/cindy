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
  saveDraft as saveComposerDraft,
  clearDraft as clearComposerDraft,
  subscribeDraft as subscribeComposerDraft,
  tiptapDocHasContent,
} from '@/lib/composerDraftStore';
import { subscribeSessionLinkInsert } from '@/lib/composerActionsBus';
import {
  ModelSelector,
  resolveRemoteModelListStatus,
  resolveModelSelectorAgentIdentity,
  type ModelMemoryAccessors,
} from './ModelSelector';
import {
  createEffortChangeCoordinator,
  enqueueEffortChange,
  isSessionScopeCurrent,
} from './effortChangeQueue';
import { useRemoteSessionConnection } from '@/features/cc-agent/hooks/useRemoteSessionConnection';

import {
  confirmAgentSwitchRisk,
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
import { focusComposerEndNextFrame, placeGhostAtComposerStart } from './ghostComposerPlacement';
import { NewGoalDialog } from './NewGoalDialog';
import { PlanModeIndicator } from './PlanModeIndicator';
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
  resolveSessionMessageReferencesForSend,
  resolveSessionChipTitles,
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
  isInteractiveFocusedElement,
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
import { loadAllCommands, filterSlashCommands, type UnifiedCommand } from '@/lib/slashCommands';
import { scanAtResources, filterAtResources, type AtResourceItem } from '@/lib/atResourceService';
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
import { createLogger } from '@/lib/logger';
import { createComposerDraftSaveScheduler } from '@/lib/composerDraftSaveScheduler';
import {
  composerRenderSnapshot,
  shouldRefreshComposerRender,
  type ComposerRenderSnapshot,
} from './composerRenderGate';
import { createComposerFrameScheduler } from './composerFrameScheduler';
import { serializeEditorContent, serializeEditorSlice } from './composerContentSerialization';
import {
  composerDocumentContainsList,
  normalizeComposerDocumentJSON,
  plainTextToComposerDocument,
} from '@/lib/composerListDocument';
import { useAgentCapabilities, type AgentKind } from '@/hooks/useAgentCapabilities';
import { useConnectedSource } from '@/hooks/useConnectedSource';
import { useProviders } from '@/hooks/useProviders';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { chatEligibleSourcesForModel, effectiveSourceIdForModel } from '@cindy/model-providers';
import { deriveModelsFromProviders, filterChatBridgedCodexProviders, resolveFastSupported } from '@/lib/providerModels';
import {
  getProviderModelEffort,
  setProviderModelChoice,
  setProviderModelEffort,
  getProviderModelFast,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import {
  getDraft,
  patchVendorPrefsPreservingModelChoice,
  setEffortForModel,
  setFastModeForModel,
} from '@/state/newMakerDraft';
import type { MessageDeliveryMode, QueuedMessage } from '@/lib/makerChatStore';
import { makerChatStore } from '@/lib/makerChatStore';
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
import { appendMentionChip } from './mentionChipInsertion';
// device-link 远程会话:设置变更不落本地 DB(会 404),改写远程内存层 + 运行时隧道。
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { makerApiFor, makerApiForDevice } from '@/lib/makerTransport';

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
  deviceLinkDeviceId?: string;
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

function hasFocusMovedToInteractiveElement(focusAnchor: Element | null, editor: Editor): boolean {
  const activeElement = document.activeElement;
  if (
    !activeElement ||
    activeElement === document.body ||
    activeElement === document.documentElement
  ) {
    return false;
  }
  if (activeElement === focusAnchor) return false;
  if (editor.view.dom.contains(activeElement)) return false;
  return isInteractiveFocusedElement(activeElement);
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
    if (allowed && !/\s/.test(after)) {
      return {
        kind: 'at',
        query: after,
        from: pos - (textSoFar.length - atIdx),
      };
    }
  }

  return { kind: 'none' };
}

export function ChatInput({
  onSend,
  sessionId,
  runtimeAgentKind,
  sessionOrcaRole,
  initialWorkingDir,
  remoteHostId,
  deviceLinkDeviceId,
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
}: ChatInputProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { preference: composerSendShortcutPreference } = useComposerSendShortcutPreference();
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
  onStopRef.current = onStop;
  const showStopButtonRef = useRef(showStopButton);
  showStopButtonRef.current = showStopButton;
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
    clearFiles,
  } = attachmentState;
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

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const composerMentionDragActiveRef = useRef(false);
  const suppressListNormalizationRef = useRef(false);
  const listPromotionQueuedRef = useRef(false);
  const lastComposerSelectionFromRef = useRef<number | null>(null);
  const internalMentionDragActiveRef = useRef(false);
  const [workingDir, setWorkingDir] = useState<string | null>(initialWorkingDir ?? null);
  const [internalFolderOpen, setInternalFolderOpen] = useState(false);

  // Ref bridge for Tiptap handlePaste(粘贴管线):editorProps 闭包只建一次,
  // 读不到最新 state / props / t——粘贴时的 workdir(路径识别范围)、会话来源
  // (stat 路由)、当前语言(pasted chip 文案)全部经 ref 取现值。
  const workingDirRef = useRef<string | null>(workingDir);
  workingDirRef.current = workingDir;
  const remoteHostIdRef = useRef<string | null | undefined>(remoteHostId);
  remoteHostIdRef.current = remoteHostId;
  const deviceLinkDeviceIdRef = useRef<string | undefined>(deviceLinkDeviceId);
  deviceLinkDeviceIdRef.current = deviceLinkDeviceId;
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
  const localVendorDefaults = getDraft().lastByVendor[
    vendorKey === 'pi' ? 'pi' : vendorKey === 'codex' ? 'codex' : 'cc'
  ];
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
  const ccCaps = useAgentCapabilities('claude-code', deviceLinkDeviceId);
  const codexCaps = useAgentCapabilities('codex', deviceLinkDeviceId);
  const piCaps = useAgentCapabilities('pi', deviceLinkDeviceId);
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
  const remoteConnStatus = useRemoteSessionConnection(deviceLinkDeviceId);
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
    () =>
      activeAgentCapabilities?.permissionModes ?? [],
    [activeAgentCapabilities],
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
  const planModeSupported =
    activeAgentCapabilities?.planMode?.supported === true;
  const planModeEntry =
    planModeSupported && onPlanModeChange
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
  const remoteProviders = useDeviceProviders(deviceLinkDeviceId);
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
  const { loading: localProvidersLoading } = useConnectedSource(
    currentModelAgentKind,
    activeModel,
  );
  const remoteModelListStatus = resolveRemoteModelListStatus({
    deviceId: deviceLinkDeviceId,
    agentKind: currentModelAgentKind,
    cc: ccCaps,
    codex: codexCaps,
    pi: piCaps,
    providers: remoteProviders,
  });
  const providersLoading = deviceLinkDeviceId
    ? remoteModelListStatus === 'loading'
    : localProvidersLoading;
  const remoteModelListBlocked =
    !!deviceLinkDeviceId && remoteModelListStatus !== 'ready';
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
  const draftSaveSchedulerRef = useRef<ReturnType<
    typeof createComposerDraftSaveScheduler
  > | null>(null);
  draftSaveSchedulerRef.current ??= createComposerDraftSaveScheduler();
  const caretScrollEditorRef = useRef<Editor | null>(null);
  const caretScrollSchedulerRef = useRef<ReturnType<
    typeof createComposerFrameScheduler
  > | null>(null);
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
    editable: !disabled,
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
          'text-[15px] leading-[22px] font-normal tabular-nums',
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
        const enterIntent = resolveComposerEnterIntent(
          event,
          getComposerSendShortcutPreference(),
          { turnRunning: showStopButtonRef.current, platform: window.electronAPI?.platform },
        );
        if (enterIntent === 'native') return false;
        if (enterIntent === 'ignore') {
          event.preventDefault();
          return true;
        }
        if (enterIntent === null) return false;

        event.preventDefault();
        if (enterIntent === 'queue' || enterIntent === 'steer') {
          const isEditorEnterTarget = event.target instanceof Node && view.dom.contains(event.target);
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
    onUpdate: ({ editor: ed }) => {
      if (
        !suppressListNormalizationRef.current &&
        !ed.view.composing &&
        !listPromotionQueuedRef.current &&
        hasTrailingPlainListParagraph(ed.view)
      ) {
        listPromotionQueuedRef.current = true;
        queueMicrotask(() => {
          listPromotionQueuedRef.current = false;
          if (
            !ed.isDestroyed &&
            !suppressListNormalizationRef.current &&
            !ed.view.composing
          ) {
            promoteTrailingPlainListParagraph(ed.view);
          }
        });
      }
      const nextRenderSnapshot = composerRenderSnapshot(
        detectTrigger(ed),
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
        const existing = getComposerDraft(sk);
        saveComposerDraft(
          sk,
          {
            text: ed.getJSON(),
            attachments: existing?.attachments ?? [],
            quotes: existing?.quotes ?? [],
            browserComments: existing?.browserComments ?? [],
          },
          { silent: true },
        );
      });
      // chat-input-autoscroll fix: 输入超过 max-h 后，让光标随内容追底
      scheduleCaretScroll(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      const nextRenderSnapshot = composerRenderSnapshot(
        detectTrigger(ed),
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

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

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
      new Set(
        ghostsForCommand
          .filter((ghost) => ghost.enabled && ghost.manifest.command)
          .map((ghost) => ghost.manifest.id),
      ),
    [ghostsForCommand],
  );
  useEffect(() => {
    setGhostCommandRoster(editor, ghostsForCommand);
  }, [editor, ghostsForCommand]);
  const handlePluginSelect = useCallback(
    (ghost: (typeof pluginsForMenu)[number]) => {
      if (!editor || editor.isDestroyed) return;
      placeGhostAtComposerStart(editor, ghost, installedGhosts);
    },
    [editor, installedGhosts],
  );

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

  const voiceInputOptions = useMemo(
    () => ({ onMicrophonePermissionRequired: handleVoiceInputPermissionRequired }),
    [handleVoiceInputPermissionRequired],
  );

  const voiceInput = useVoiceInput(editor, disabled, messages, voiceInputOptions);
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
  const handleVoiceInputPlainStop = useCallback(() => (
    handleVoiceInputStop({ waitForRefinement: true }).catch(() => undefined)
  ), [handleVoiceInputStop]);
  const handleVoiceInputStopWithRefinement = useCallback((options?: { waitForRefinement?: boolean }) => (
    handleVoiceInputStop({ waitForRefinement: options?.waitForRefinement ?? true }).catch(() => undefined)
  ), [handleVoiceInputStop]);

  const voiceShortcutRef = useRef(voiceInputSettings.shortcut);
  const voiceInputStateRef = useRef(voiceInput.state);
  const voiceInputStopRef = useRef(handleVoiceInputStopWithRefinement);
  const voiceInputCancelRef = useRef(voiceInput.cancel);
  const voiceInputStopAndSendRef = useRef<(deliveryMode?: MessageDeliveryMode) => void | Promise<void>>(() => {});
  const voiceInputStopAndSendPromiseRef = useRef<Promise<void> | null>(null);
  const voiceInputCanStopAndSendRef = useRef(false);
  const composerCanSubmitRef = useRef(false);
  const handleVoiceInputStartRef = useRef(handleVoiceInputStart);
  const disabledRef = useRef(disabled);
  const disableAutofocusRef = useRef(disableAutofocus);
  const focusOnStorageKeyChangeRef = useRef(focusOnStorageKeyChange);
  const latestStorageKeyRef = useRef<string | undefined>(storageKey);
  const storageKeyTransitionSeqRef = useRef(0);
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

  useEffect(() => {
    voiceShortcutRef.current = voiceInputSettings.shortcut;
  }, [voiceInputSettings.shortcut]);

  useEffect(() => {
    voiceInputStateRef.current = voiceInput.state;
    voiceInputStopRef.current = handleVoiceInputStopWithRefinement;
    voiceInputCancelRef.current = voiceInput.cancel;
    handleVoiceInputStartRef.current = handleVoiceInputStart;
    disabledRef.current = disabled;
    disableAutofocusRef.current = disableAutofocus;
    focusOnStorageKeyChangeRef.current = focusOnStorageKeyChange;
  }, [
    disabled,
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
      const platform = window.electronAPI?.platform;
      if (event.key === 'Escape' && !event.repeat && !event.isComposing) {
        if (
          currentState === 'listening' ||
          currentState === 'submitting' ||
          currentState === 'refining'
        ) {
          event.preventDefault();
          clearPressTimer();
          voiceShortcutPressRef.current = null;
          void voiceInputCancelRef.current();
          return;
        }
      }

      const enterIntent = resolveComposerEnterIntent(
        event,
        getComposerSendShortcutPreference(),
        { turnRunning: showStopButtonRef.current, platform },
      );
      const isModifiedEnter = hasComposerModifier(event, platform);
      if (
        isComposerEnterTarget(event.target) &&
        isModifiedEnter &&
        (enterIntent === 'queue' || enterIntent === 'steer') &&
        currentState !== 'listening'
      ) {
        event.preventDefault();
        event.stopPropagation();
        clearPressTimer();
        voiceShortcutPressRef.current = null;
        void dispatchSendRef.current(enterIntent);
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

  useEffect(() => {
    if (!editor) return;
    const nextEditable = !voiceInput.isBusy;
    if (editor.isEditable !== nextEditable) {
      editor.setEditable(nextEditable, false);
    }
    return () => {
      if (!editor.isDestroyed && !editor.isEditable) {
        editor.setEditable(true, false);
      }
    };
  }, [editor, voiceInput.isBusy]);

  // While dictation holds the editor read-only the native caret disappears;
  // the decoration renders a mic-shaped caret at the insertion point instead
  // (listening = animated level bars, submitting/refining = spinner).
  const voiceCaretState: VoiceInputCaretState | null = voiceInput.isListening
    ? 'listening'
    : voiceInput.isBusy
      ? 'processing'
      : null;

  useEffect(() => {
    setVoiceInputDraftDecoration(
      editor,
      voiceInput.draftText,
      voiceInput.draftSource,
      voiceInput.draftRange,
      voiceCaretState,
    );
    // Caret-only (no draft text yet) must also stay visible: the insertion
    // point can sit outside the viewport when the composer is scrolled.
    if (voiceInput.draftText || voiceCaretState) {
      requestAnimationFrame(() => {
        if (editor) scrollVoiceInputDraftEndIntoView(editor);
      });
    }
  }, [editor, voiceCaretState, voiceInput.draftRange, voiceInput.draftSource, voiceInput.draftText]);

  // Route changes such as Chat -> Settings unmount the composer immediately.
  // `onUpdate` is still the primary "instant save" path, but this cleanup
  // snapshots the final editor state before React tears the instance down.
  useEffect(() => {
    if (!editor) return;
    return () => {
      draftSaveSchedulerRef.current?.flush();
      const editorStorageKey = storageKeyForDraftRef.current;
      if (!editorStorageKey) return;
      const existing = getComposerDraft(editorStorageKey);
      const hasText = !isEditorEmpty(editor);
      if (!hasText && !existing) return;
      saveComposerDraft(
        editorStorageKey,
        {
          text: editor.getJSON(),
          attachments: existing?.attachments ?? [],
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
        },
        { silent: true },
      );
    };
  }, [editor]);

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
    latestStorageKeyRef.current = storageKey;
    const prevEditorKey = editorStorageKeyRef.current;
    const storageKeyFocusAnchor = document.activeElement;
    // Skip if the editor is already aligned with this storageKey.
    // (Possible when only `editor` flipped to non-null but the key
    // was already current.)
    if (prevEditorKey === storageKey) {
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
        // 位置存活的状态(语音插入点、草稿装饰锚点)推到 block 边界上。本 effect 依赖
        // voiceInput.isBusy,录音开始与结束各会重跑一次——新建对话页的草稿键固定、
        // 常留着一份空正文,于是上屏文字前凭空多出一个空行。
        const draftDocument =
          draft?.text && tiptapDocHasContent(draft.text) ? draft.text : null;
        if (draftDocument && composerDocIsEmpty(editor.state.doc)) {
          isRestoringRef.current = true;
          try {
            editor.commands.setContent(normalizeComposerDocumentJSON(draftDocument));
          } finally {
            isRestoringRef.current = false;
          }
        }
      }
      editorStorageKeyRef.current = storageKey;
      storageKeyForDraftRef.current = storageKey;
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
          if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor)) return;
          editor.commands.focus('end');
        });
      }
      return;
    }

    const transitionSeq = storageKeyTransitionSeqRef.current + 1;
    storageKeyTransitionSeqRef.current = transitionSeq;
    draftSaveSchedulerRef.current?.flush();
    const saveCurrentEditorDraft = () => {
      if (!prevEditorKey) return;
      if (!hasHydratedRef.current) return;
      const existing = getComposerDraft(prevEditorKey);
      const hasText = !isEditorEmpty(editor);
      if (!hasText && !existing) return;
      saveComposerDraft(
        prevEditorKey,
        {
          text: editor.getJSON(),
          attachments: existing?.attachments ?? [],
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
        },
        { silent: true },
      );
    };

    let cancelled = false;
    const isCurrentTransition = () =>
      !cancelled &&
      !editor.isDestroyed &&
      storageKeyTransitionSeqRef.current === transitionSeq &&
      latestStorageKeyRef.current === storageKey;

    const restoreNextDraft = () => {
      if (!isCurrentTransition()) return;
      isRestoringRef.current = true;
      try {
        const draft = storageKey !== undefined ? getComposerDraft(storageKey) : undefined;
        if (draft?.text) {
          editor.commands.setContent(normalizeComposerDocumentJSON(draft.text));
        } else {
          editor.commands.clearContent();
        }
      } finally {
        isRestoringRef.current = false;
      }
      editorStorageKeyRef.current = storageKey;
      storageKeyForDraftRef.current = storageKey;
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
        if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor)) return;
        editor.commands.focus('end');
      });
    };

    const pendingStopAndSend = voiceInputStopAndSendPromiseRef.current;
    if (pendingStopAndSend || voiceInput.isBusy) {
      void (async () => {
        try {
          if (pendingStopAndSend) {
            await pendingStopAndSend;
          } else {
            await voiceInputStopRef.current({ waitForRefinement: true });
          }
        } finally {
          if (isCurrentTransition()) {
            saveCurrentEditorDraft();
          }
          restoreNextDraft();
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // storageKey actually changed — swap the editor's content.
    saveCurrentEditorDraft();
    restoreNextDraft();
  }, [editor, storageKey, voiceInput.isBusy]);

  // ── External draft writes for the CURRENT session (e.g. rewind / fork
  // pre-fill called saveComposerDraft from outside) ──
  // The restore-on-sessionId-change effect above only fires when sessionId
  // toggles; a same-session draft overwrite (rewind in place) needs a separate
  // notification to force-setContent. composerDraftStore notifies subscribers
  // for non-silent writes; ChatInput's own keystroke writes pass `silent:true`
  // so they don't loop back.
  useEffect(() => {
    if (!editor || !storageKey) return;
    return subscribeComposerDraft(storageKey, () => {
      const draft = getComposerDraft(storageKey);
      if (!draft) return;
      setBrowserComments(draft.browserComments ?? []);
      // 同值外部写入不做全量 setContent,避免把用户停在中段的光标弹到末尾、
      // 打断 IME 组合。appendQuoteToDraft 会改变正文文档,自然走下方 setContent。
      // 空草稿在存储里可能是 `{doc:[空 paragraph]}` 而不是 undefined,而右侧对
      // "编辑器为空"一律折叠成 null。两侧判空口径必须一致,否则每次外部草稿通知都
      // 会拿一份空文档整段 setContent:doc 被原地重建,所有按位置存活的状态(语音
      // 草稿锚点等)被迫跨整篇映射(#720 后语音录音时首行多一个空行的成因)。
      const draftDocument = draft.text ? normalizeComposerDocumentJSON(draft.text) : null;
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
  }, [editor, ghostsForCommand, installedGhosts, storageKey]);

  // browser-comment-chip:挂载 / 会话切换时从草稿恢复评论胶囊。
  useEffect(() => {
    if (!storageKey) {
      setBrowserComments([]);
      return;
    }
    const draft = getComposerDraft(storageKey);
    setBrowserComments(draft?.browserComments ?? []);
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
  const [mergedCommands, setMergedCommands] = useState<UnifiedCommand[]>([]);
  const paletteAgentKind = agentKind ?? 'claude-code';
  // remote session:workingDir 是远端主机路径,不能按它扫本机 skills/files。
  // slash 退化为 desktop + agent-builtin(传 null),@ 文件面板直接关闭(见 atOpen)。
  const isRemoteSession = !!remoteHostId;
  const slashCommandLoadSeqRef = useRef(0);
  useEffect(
    () => () => {
      slashCommandLoadSeqRef.current += 1;
    },
    [],
  );
  const reloadSlashCommands = useCallback(
    (opts?: { forceReload?: boolean }) => {
      const seq = ++slashCommandLoadSeqRef.current;
      // device-link 远程会话:agent-builtin / agent-skill 从被控端读(deviceLinkDeviceId);
      // workingDir 是被控端路径；SSH remote 显式关扫描。desktop 命令始终本地。
      loadAllCommands(
        paletteAgentKind,
        workingDir,
        { ...opts, skipAgentSkills: isRemoteSession },
        deviceLinkDeviceId,
      )
        .then((cmds) => {
          if (slashCommandLoadSeqRef.current === seq) setMergedCommands(cmds);
        })
        .catch(() => {
          if (slashCommandLoadSeqRef.current === seq) setMergedCommands([]);
        });
    },
    [workingDir, paletteAgentKind, isRemoteSession, deviceLinkDeviceId],
  );
  // context(workingDir / agentKind / remote)变化时先同步清空命令缓存:切换会话(尤其
  // local→remote)那一瞬,reloadSlashCommands 是异步的,清空可避免 palette 在刷新完成前
  // 残留上一个项目的本地 skills。下面的 reload effect 紧接着用新 context 重填。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这里用依赖数组表达上下文切换触发清空，effect 内不直接读取这些值。
  useEffect(() => {
    setMergedCommands([]);
  }, [workingDir, paletteAgentKind, isRemoteSession, deviceLinkDeviceId]);
  useEffect(() => {
    reloadSlashCommands();
  }, [reloadSlashCommands]);
  // Slash 指令与 $意识一致:doc 保持可逐字编辑的普通文本,完整命中当前 roster
  // 时才由 decoration 显示确认胶囊。异步 roster 刷新不进入 keystroke 热路径。
  useEffect(() => {
    setSlashCommandRoster(editor, mergedCommands);
  }, [editor, mergedCommands]);
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
  const paletteCommands = isGhostSigil ? ghostCommandItems : mergedCommands;
  const filteredCommands = useMemo(
    () => (trigger.kind === 'slash' ? filterSlashCommands(paletteCommands, trigger.query) : []),
    [paletteCommands, trigger],
  );

  // At-panel scan state
  const [atState, setAtState] = useState<AtPanelState>({ kind: 'loading' });
  const atScanSeqRef = useRef(0);
  const atFallbackScanTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      atScanSeqRef.current += 1;
      if (atFallbackScanTimerRef.current !== null) {
        window.clearTimeout(atFallbackScanTimerRef.current);
      }
    },
    [],
  );

  const runAtScan = useCallback(
    (query?: string) => {
      // SSH 远端会话不扫 @ 资源(无隧道);atOpen 也已对其关闭面板,这里再兜一层。
      if (!workingDir || isRemoteSession) return;
      // device-link 远程会话:带 deviceId 经隧道在被控端扫描(workingDir 是被控端路径);
      // 本机会话 deviceId 为 undefined → 本地扫描。
      // 远程**草稿**(NewMakerDraftRoute)此时 sessionId 还是 undefined、但 deviceLinkDeviceId prop 已设——
      // 必须优先用 prop,否则 @ 扫描落到控制端本机 FS(扫到同名目录的错文件),插进首条远程消息的 mention 不可用。
      const remoteDeviceId =
        deviceLinkDeviceId ?? (sessionId ? getSessionDeviceId(sessionId) : undefined);
      const seq = ++atScanSeqRef.current;
      const normalizedQuery = query?.trim() ?? '';
      setAtState((prev) => {
        if (prev.kind === 'ready' && normalizedQuery) {
          return { ...prev, searching: true };
        }
        return { kind: 'loading' };
      });
      scanAtResources(
        workingDir,
        paletteAgentKind,
        2000,
        normalizedQuery || undefined,
        remoteDeviceId,
      )
        .then((res) => {
          if (atScanSeqRef.current !== seq) return;
          if (!res.success) {
            setAtState({ kind: 'error', message: res.error ?? 'scan failed' });
            return;
          }
          setAtState({ kind: 'ready', items: res.items, truncated: res.truncated });
        })
        .catch((err: unknown) => {
          if (atScanSeqRef.current !== seq) return;
          const m = err instanceof Error ? err.message : String(err);
          setAtState({ kind: 'error', message: m });
        });
    },
    [workingDir, paletteAgentKind, isRemoteSession, sessionId, deviceLinkDeviceId],
  );

  const atQuery = trigger.kind === 'at' ? trigger.query : '';

  // When `@` panel opens, rescan so newly created files/agents show immediately.
  useEffect(() => {
    if (trigger.kind !== 'at') return;
    if (!workingDir) return;
    runAtScan();
  }, [trigger.kind, workingDir, runAtScan]);

  // Derive query string for stable memo deps — avoids re-filtering on
  // every editor tick when only the caret moved but the query didn't change.
  const filteredAt = useMemo(() => {
    if (!atQuery && trigger.kind !== 'at') return [];
    if (atState.kind !== 'ready') return [];
    return filterAtResources(atState.items, atQuery);
  }, [atState, atQuery, trigger.kind]);

  // Focused row index for each palette
  const [slashFocus, setSlashFocus] = useState(0);
  const [atFocus, setAtFocus] = useState(0);

  // Reset focus when the list shrinks below current index
  useEffect(() => {
    if (slashFocus >= filteredCommands.length) setSlashFocus(0);
  }, [filteredCommands.length, slashFocus]);
  useEffect(() => {
    if (atFocus >= filteredAt.length) setAtFocus(0);
  }, [filteredAt.length, atFocus]);

  useEffect(() => {
    if (atFallbackScanTimerRef.current !== null) {
      window.clearTimeout(atFallbackScanTimerRef.current);
      atFallbackScanTimerRef.current = null;
    }
    if (trigger.kind !== 'at') return;
    if (!workingDir) return;
    if (!atQuery.trim()) return;
    if (atState.kind !== 'ready') return;
    if (filteredAt.length > 0) return;
    atFallbackScanTimerRef.current = window.setTimeout(() => {
      atFallbackScanTimerRef.current = null;
      runAtScan(atQuery);
    }, 200);
    return () => {
      if (atFallbackScanTimerRef.current !== null) {
        window.clearTimeout(atFallbackScanTimerRef.current);
        atFallbackScanTimerRef.current = null;
      }
    };
  }, [trigger.kind, workingDir, atQuery, atState.kind, filteredAt.length, runAtScan]);

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
  const atOpen =
    trigger.kind === 'at' && !!workingDir && !isRemoteSession && suppressedAtAt !== trigger.from;

  useEffect(() => {
    if (!slashOpen) return;
    reloadSlashCommands({ forceReload: true });
  }, [slashOpen, reloadSlashCommands]);

  // ── Panel → editor bridge for keyboard nav ─────────────────────────
  // The editor's `handleKeyDown` fires before React re-renders, so we need
  // a ref that always points at the freshest panel handler.
  const panelBridgeRef = useRef<{
    captureKey: (e: KeyboardEvent) => boolean;
  } | null>(null);

  useEffect(() => {
    panelBridgeRef.current = {
      captureKey: (e) => {
        if (!slashOpen && !atOpen) return false;
        switch (e.key) {
          case 'ArrowDown':
            if (slashOpen && filteredCommands.length > 0) {
              setSlashFocus((i) => (i + 1) % filteredCommands.length);
              return true;
            }
            if (atOpen && filteredAt.length > 0) {
              setAtFocus((i) => (i + 1) % filteredAt.length);
              return true;
            }
            return false;
          case 'ArrowUp':
            if (slashOpen && filteredCommands.length > 0) {
              setSlashFocus((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
              return true;
            }
            if (atOpen && filteredAt.length > 0) {
              setAtFocus((i) => (i - 1 + filteredAt.length) % filteredAt.length);
              return true;
            }
            return false;
          case 'Enter':
          case 'Tab':
            if (slashOpen && filteredCommands[slashFocus]) {
              insertSlashCommand(filteredCommands[slashFocus]);
              return true;
            }
            if (atOpen && filteredAt[atFocus]) {
              insertAtResource(filteredAt[atFocus]);
              return true;
            }
            return false;
          case 'Escape':
            if (slashOpen && trigger.kind === 'slash') {
              setSuppressedSlashAt(trigger.from);
              return true;
            }
            if (atOpen && trigger.kind === 'at') {
              setSuppressedAtAt(trigger.from);
              return true;
            }
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
      if (!editor || trigger.kind !== 'slash') return;
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
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          if (trigger.sigil === '$') {
            // 意识指令:纯文本 `$命令 `(不建 chip)——发送期由 expandGhostCommand
            // 识别并追加机器指令,序列化零特判。
            tr.replaceWith(from, runEnd, editor.schema.text(`$${cmd.name} `));
          } else {
            // Slash 也保持纯文本;SlashCommandDecoration 只负责视觉确认,
            // Backspace / 光标移动因此与普通文字完全一致。
            replaceSlashCommandRunWithText(tr, editor.schema, from, runEnd, cmd.name);
          }
          return true;
        })
        .run();
    },
    [editor, trigger],
  );

  const insertAtResource = useCallback(
    (item: AtResourceItem) => {
      if (!editor || trigger.kind !== 'at') return;
      const { from } = trigger;
      // Extend replace-range to the end of the @-run (up to whitespace /
      // chip boundary / end of paragraph). Same reasoning as
      // insertSlashCommand — the caret may sit inside the run.
      const $from = editor.state.doc.resolve(from);
      const parent = $from.parent;
      const parentStart = $from.start();
      let runEnd = from + 1; // skip the `@` itself
      const offset = from - parentStart + 1;
      parent.forEach((child, childOffset) => {
        if (childOffset + child.nodeSize <= offset) return;
        if (child.type.name === 'mentionChip') return;
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
      const to = runEnd;
      const attrs: MentionChipAttrs = {
        kind: item.type,
        label: item.name.replace(/\.md$/, ''),
        // For agent chips we stash the bare name so serialization can
        // degrade to `@{name}` if the host can't map it; for files/dirs
        // we stash the relative path as-is.
        path: item.type === 'agent' ? item.name : item.relPath,
      };
      // For agent: store final canonical path in `path` if we know it maps
      // to an existing file. Here we DO know (we just scanned), so use the
      // canonical form.
      if (item.type === 'agent') {
        attrs.path = item.relPath; // .claude/agents/<name>.md
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
    },
    [editor, trigger],
  );

  // ── Send / Stop wiring ─────────────────────────────────────────────
  const dispatchSendInFlightRef = useRef(false);
  const [localSendDispatchInFlight, setSendDispatchInFlight] = useState(false);
  const sendDispatchInFlight = localSendDispatchInFlight || agentSendDispatchInFlight;
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
      if (dispatchSendInFlightRef.current) return;
      const sourceSessionId = sessionId;
      const finishAgentSendDispatch = sourceSessionId
        ? tryBeginAgentSendDispatch(sourceSessionId)
        : () => {};
      if (!finishAgentSendDispatch) return;
      draftSaveSchedulerRef.current?.flush();
      dispatchSendInFlightRef.current = true;
      setSendDispatchInFlight(true);
      try {
        await resolveSessionMessageReferencesForSend(editor);
        // 引用 chip 水合会跨 device-link await；等待期间若旧客户端 / 其他入口登记了切换，
        // 必须在真正 onSend 前再查一次，不能让准备阶段前的一次性检查代表发送时刻。
        if (sourceSessionId && hasPendingAgentSwitchOperation(sourceSessionId)) return;
        if (editor.isDestroyed) return;
        const {
          text: editorText,
          mentions,
          hasQuotes,
          agentReferences,
          pastedTextRanges,
          slashCommandRanges,
        } = serializeEditorContent(editor);
        // composerQuote 在其正文位置序列化成 markdown blockquote,支持引用与回复交错。
        // browser-comment-chip:页面评论序列化为 `# Browser comments:` 段拼在正文后
        // (截图在下方并入 filesToSend,与文本块里的 "attached as a labeled image"
        // caption 对应)。
        const text = formatBrowserCommentsForSend(browserCommentsRef.current, editorText);
        // Allow send if there is text OR attachments(纯引用 / 纯评论无输入也可发送)
        if (!text && !hasAttachments) return;

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
          currentModelAgentKind &&
          // 旧被控端明确不支持 provider:list 时，控制端没有可检查的来源镜像；
          // 与模型列表一致交给 capabilities + 被控端发送链路做兼容回退。
          !(deviceLinkDeviceId && remoteProviders.unsupported)
        ) {
          // 已建会话按实际路由口径判(includeDisabled,与上方 hasConnectedSendSource
          // 同则):运行中会话不因停用打断,最终 preflight 若按准入 rail 判会在全停时
          // 弹「去连接来源」把继续发送挡死(PR #744 review 第十八轮)。草稿保持准入口径。
          const connectedSources = chatEligibleSourcesForModel(providers, activeModel, currentModelAgentKind, {
            onlyConnected: true,
            includeDisabled: !!sessionId,
          });
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
        const commentScreenshots = browserCommentsRef.current.map((c) => c.screenshot);
        const filesToSend =
          hasAttachments || commentScreenshots.length > 0
            ? [...attachments, ...commentScreenshots]
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
        const usedGhost = ghostCommandWord
          ? findGhostByCommand(eligibleGhosts, ghostCommandWord)
          : null;
        const textToSend = expandGhostCommand(text, eligibleGhosts);
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
        dispatchSendInFlightRef.current = true;
        setSendDispatchInFlight(true);
        let result: boolean | void;
        try {
          result = await onSend(
            textToSend,
            activeModel,
            activeEffort,
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
            },
          );
        } catch (error) {
          log.warn('send rejected:', error instanceof Error ? error.message : String(error));
          return;
        } finally {
          dispatchSendInFlightRef.current = false;
          setSendDispatchInFlight(false);
        }
        if (result === false) return;
        markRecentPluginUsage();
        // Suppress onUpdate's draft-save during the post-send clearContent so
        // we don't write a transient empty-doc entry that we're about to drop.
        isRestoringRef.current = true;
        try {
          editor.commands.clearContent(true);
        } finally {
          isRestoringRef.current = false;
        }
        clearFiles();
        setBrowserComments([]);
        historyIndexRef.current = -1;
        hydratedHistoryDocumentRef.current = null;
        draftRef.current = null;
        // composer-draft-per-session: drop the saved draft now that this
        // session's content has been sent. Without this, switching away then
        // back would re-restore the just-sent text/files into the composer.
        if (storageKey) {
          clearComposerDraft(storageKey);
        }
      } finally {
        dispatchSendInFlightRef.current = false;
        setSendDispatchInFlight(false);
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
      storageKey,
      t,
      currentModelAgentKind,
      deviceLinkDeviceId,
      providers,
      remoteProviders.unsupported,
      remoteModelListBlocked,
      remoteModelListStatus,
      confirmDialog,
      navigate,
    ],
  );
  useEffect(() => {
    dispatchSendRef.current = dispatchSend;
  }, [dispatchSend]);

  const handleQueueSteer = useCallback(async (clientId: string) => {
    if (!onQueueSteer) return false;
    return onQueueSteer(clientId);
  }, [onQueueSteer]);

  const handleClickSend = useCallback(async (deliveryMode: MessageDeliveryMode = 'queue') => {
      if (voiceInput.isBusy) {
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
  const effortChangeCoordinatorRef = useRef(createEffortChangeCoordinator());
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

  // 解析某模型的 effort 档 / 默认档 —— **本地会话走 provider catalog**(deriveModelsFromProviders,
  // 含自定义供应商模型),而非 getModelById(只懂 maker-core 内置;自定义模型查不到 → 之前 effort
  // 被错误压成 'low'、记忆无法恢复)。device-link 远程会话仍按被控端能力(getModelById(id, deviceId)),
  // 行为字节级不变(自定义供应商不经隧道,被控端能力才是权威)。
  const resolveModelEfforts = useCallback(
    (modelId: string): { efforts: readonly Effort[]; defaultEffort: Effort | null } => {
      if (deviceLinkDeviceId) {
        const m = getModelById(modelId, deviceLinkDeviceId);
        return { efforts: m?.efforts ?? [], defaultEffort: m?.defaultEffort ?? null };
      }
      const kinds: readonly AgentKind[] = currentModelAgentKind
        ? [currentModelAgentKind]
        : ['claude-code', 'codex', 'pi'];
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
        deviceId: deviceLinkDeviceId,
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
      } = {},
    ) => {
      if (!sessionId || !currentModelAgentKind || !modelId) return;
      const activeProviderId =
        opts.activeProviderId !== undefined ? opts.activeProviderId : selectedProviderId;
      const memoryProviderId =
        opts.memoryProviderId !== undefined ? opts.memoryProviderId : effectiveSourceId;
      const remoteDeviceId =
        opts.remoteDeviceId ?? getSessionDeviceId(sessionId) ?? deviceLinkDeviceId;
      if (!remoteDeviceId) {
        const vendor =
          currentModelAgentKind === 'codex' ? 'codex' : currentModelAgentKind === 'pi' ? 'pi' : 'cc';
        patchVendorPrefsPreservingModelChoice(vendor, {
          model: modelId,
          providerId: activeProviderId ?? null,
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        });
        if (memoryProviderId) {
          if (patch.effort !== undefined) {
            setProviderModelChoice(currentModelAgentKind, memoryProviderId, modelId, patch.effort);
          }
          if (patch.fast !== undefined) {
            setProviderModelFast(currentModelAgentKind, memoryProviderId, modelId, patch.fast);
          }
        }
        if (patch.effort !== undefined) setEffortForModel(modelId, patch.effort);
        if (patch.fast !== undefined) setFastModeForModel(modelId, patch.fast);
        return;
      }
      window.electronAPI.deviceLink
        .invoke(remoteDeviceId, 'maker:apply-new-maker-draft-pref', [
          {
            agent: currentModelAgentKind,
            providerId: activeProviderId ?? '',
            modelId,
            active: true,
            markModelChoice: false,
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

  const handleFastModeChange = useCallback(
    async (
      enabled: boolean,
      modelId = activeModel,
      effort = activeEffort,
      syncDraft = true,
      memoryProviderId = effectiveSourceId,
    ) => {
      // 切换意图期:Fast 改动是"更新意图"而不是改当前会话实时状态(否则普通
      // SET_FAST 链路会让 main 清意图、renderer 乐观态失配)。经 ref 调用——
      // performAgentSwitch 声明在本回调之后(TDZ)。
      if (sessionId && makerChatStore.getAgentSwitchIntent(sessionId)) {
        const intent = makerChatStore.getAgentSwitchIntent(sessionId)!;
        void performAgentSwitchRef.current(intent.target, intent.model, intent.providerId, {
          fastMode: enabled,
          effort: intent.effort as Effort | undefined,
        });
        return;
      }
      const sourceRemoteDeviceId = sessionId
        ? (deviceLinkDeviceId ?? getSessionDeviceId(sessionId))
        : deviceLinkDeviceId;
      const persisted = await persistFastModeChange(enabled, {
        remoteDeviceId: sourceRemoteDeviceId,
      });
      if (!persisted) return;
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
    ],
  );

  /**
   * 切模型前的上下文容量护栏(大窗口 → 小窗口场景)。
   * 为什么必须在**切换前**拦: `/compact` 自救本身是一次 LLM 调用, 要把全量历史喂给
   * "当前模型" —— 切到小窗口模型之后连压缩请求都可能超限, 只有还没切走的大窗口模型
   * 能读完整历史。分级语义见 shared/modelSwitchAssessment.ts。
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
        description: t('newChat.chatInput.modelSwitchContextGuard.overflowDescription', vars),
        confirmText: t('newChat.chatInput.modelSwitchContextGuard.confirmSwitch'),
        cancelText: t('newChat.chatInput.modelSwitchContextGuard.cancelSwitch'),
      });
    },
    [sessionId, confirmDialog, t],
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
    byModel: (modelId: string, expectedRevision?: number) => void | boolean | Promise<void | boolean>;
  }>({ byProvider: () => {}, byModel: () => {} });
  const confirmAgentBrowseSwitch = useCallback(
    () =>
      confirmAgentSwitchRisk({
        // 意图存在 = 用户进入目标浏览态时已经确认过；改选与撤销均不重复弹。
        hasSwitchIntent: !!sessionId && !!makerChatStore.getAgentSwitchIntent(sessionId),
        confirm: confirmDialog,
        copy: {
          title: t('newChat.chatInput.agentSwitch.confirmation.title'),
          description: t('newChat.chatInput.agentSwitch.confirmation.description'),
          confirmText: t('newChat.chatInput.agentSwitch.confirmation.confirm'),
          cancelText: t('newChat.chatInput.agentSwitch.confirmation.cancel'),
          dontShowAgainLabel: t('newChat.chatInput.agentSwitch.confirmation.dontShowAgain'),
        },
      }),
    [sessionId, confirmDialog, t],
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
    ) => {
      if (!sessionId) return;
      // 发送的引用水合 / 预检也可能 await。以同步登记的 session 级发送 token 为准，
      // 防止「先点发送、后选引擎」被异步准备反转成先登记切换再 maker:send。
      if (hasPendingAgentSendDispatch(sessionId)) return;
      // 本次点选无论落到哪个分支(登记意图 / 撤销意图 / 立即切换),都算一次本端写入:
      // 在途的远程意图读回据此作废,不会用旧快照盖掉用户刚做的选择。
      const sourceSessionId = sessionId;
      const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);
      const intentRevAtSend = makerChatStore.getAgentSwitchIntentRev(sourceSessionId);
      const finishAgentSwitchOperation = beginAgentSwitchOperation(sourceSessionId);
      const exclusiveTurn = reserveAgentSwitchExclusive(sourceSessionId);
      try {
        await exclusiveTurn.ready;
        // effort 档按**目标引擎**目录解析(resolveModelEfforts 锚定当前引擎,
        // 同 id 模型两家档位可不同、目标独占模型在当前目录里查不到);浏览态
        // 悬浮面板写下的 per-(目标引擎,来源,模型) 预设在此恢复。
        const targetCatalog = deriveModelsFromProviders(providers, targetAgentKind).find(
          (x) => x.id === newModelId,
        );
        const { efforts, defaultEffort } = targetCatalog
          ? { efforts: targetCatalog.efforts, defaultEffort: targetCatalog.defaultEffort ?? null }
          : resolveModelEfforts(newModelId);
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
                deviceId: deviceLinkDeviceId,
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
        if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return;
        // 远程往返期间状态可能已被更新的选择超车:用户又点了一次(写序号变),或另一个
        // 控制端 / 被控端的权威 sessions:patched 先到(修订号变)。此时这次 ack 携带的是
        // **旧**选择,落下去会让选择器显示过期引擎,而被控端按新意图执行下一条消息。
        // 丢弃即可——被控端每次意图变更都会广播,权威值随 push 收敛。
        // 注意两类守卫作用域不同(见 resolveAgentSwitchAckAction):同引擎 no-op 的清除
        // 回流本就由本次调用引起,不能拿修订号变化把自己判成 stale。
        const ackAction = resolveAgentSwitchAckAction({
          deferred: result.deferred === true,
          switched: result.switched,
          sameEngineRevision: result.sameEngineRevision,
          sameEngineSuperseded: result.sameEngineSuperseded,
          freshness: {
            cancelled: false,
            writeSeqAtStart: writeSeq,
            writeSeqNow: getAgentSwitchWriteSeq(sourceSessionId),
            intentRevAtStart: intentRevAtSend,
            intentRevNow: makerChatStore.getAgentSwitchIntentRev(sourceSessionId),
          },
        });
        if (ackAction === 'discard') return;
        if (ackAction === 'apply-intent') {
          // 意图已登记:乐观呈现目标引擎/模型/档位(独立 intent 覆盖
          // model/effort/provider/fast 显示,不改真实 reducer agentKind)。真切换
          // 在下一条消息发送时刻执行;turn 运行中额外提示旧 turn 不受影响。
          makerChatStore.noteAgentSwitchIntent(sourceSessionId, targetAgentKind, {
            model: newModelId,
            providerId,
            effort: newEffort,
            fastMode: targetFast,
          });
          if (makerChatStore.getSnapshot(sourceSessionId).agentStatus.isRunning) {
            toast.success(
              t('newChat.chatInput.agentSwitch.deferred', {
                agent: targetAgentKind === 'codex'
                  ? 'Codex'
                  : targetAgentKind === 'pi'
                    ? 'Pi'
                    : 'Claude Code',
                model: newModelId,
              }),
              { duration: 4000 },
            );
          }
          return;
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
            : await sameEngineReselectRef.current.byModel(
                newModelId,
                result.sameEngineRevision,
              );
          if (applied === false) return;
          makerChatStore.clearAgentSwitchIntent(sourceSessionId);
          return;
        }
        // 立即切换路径(harness / registry 缺省兜底,生产不走):维持旧收敛语义。
        makerChatStore.noteAgentSwitched(sourceSessionId, targetAgentKind);
        if (!result.engineReady) {
          toast.error(t('newChat.chatInput.agentSwitch.engineNotReady'), { duration: 4000 });
        }
      } catch (err) {
        toast.error(
          t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.chatInput.agentSwitch.failed' })),
        );
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
    ],
  );
  // 声明顺序在 performAgentSwitch 之前的 handler(handleFastModeChange)经此 ref
  // 调用,避免 TDZ;每次渲染刷新指向最新闭包。
  const performAgentSwitchRef = useRef(performAgentSwitch);
  performAgentSwitchRef.current = performAgentSwitch;

  const performModelChange = useCallback(
    async (newModelId: string, expectedAgentSwitchRevision?: number) => {
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
        void performAgentSwitch(intent.target, newModelId, null);
        return;
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

      // effort 档走 catalog(含自定义供应商模型);恢复优先级:
      // (agent,model) 全局预设 > 旧 per-model 记忆 > 沿用当前 > 模型默认。
      const { efforts, defaultEffort } = resolveModelEfforts(newModelId);
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
                undefined,
                expectedAgentSwitchRevision,
                useAtomicSelection
                  ? { effort: newEffort, fastMode: restoredFast }
                  : undefined,
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
              { remoteDeviceId: sourceRemoteDeviceId },
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
            syncSessionDraftModelPrefs(newModelId, { effort: newEffort, fast: restoredFast });
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
            .setModel(
              sessionId,
              rollbackModelAfterPersistFailure.model,
              undefined,
              undefined,
              { effort: activeEffort, fastMode },
            )
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

  const handleEffortChange = useCallback(
    async (newEffort: Effort) => {
      // 切换意图期:effort 改动 = 更新意图(重登记),不走普通 setEffort 链路。
      if (sessionId && makerChatStore.getAgentSwitchIntent(sessionId)) {
        const intent = makerChatStore.getAgentSwitchIntent(sessionId)!;
        void performAgentSwitch(intent.target, intent.model, intent.providerId, {
          effort: newEffort,
          fastMode: intent.fastMode,
        });
        return;
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
              return;
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
            return;
          }
          // 远程会话由被控端 patch 回流；把稳定 device scope 一并传给父级，避免 relay
          // origin 短暂缺失时被误当成本地 session patch。
          onEffortDidChange?.(newEffort, sessionId, remoteDeviceId);
          if (activeModel) rememberProviderChoice(activeModel, newEffort);
          return;
        }

        // 草稿态:全本地生效(同 handleModelChange 草稿分支)。onEffortDidChange → 父级
        // patchVendorPrefs 落 lastByVendor;全局模型预设走 rememberProviderChoice。
        // 不再写服务端默认偏好——此前 await 服务端成功才刷 UI,token 失效时表现为"档位点不动"。
        onEffortDidChange?.(newEffort);
        if (activeModel) rememberProviderChoice(activeModel, newEffort);
      } catch (err) {
        log.warn('effort change failed:', err);
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
    ],
  );

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
      const { efforts, defaultEffort } = resolveModelEfforts(targetModelId);
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
        void performAgentSwitch(intent.target, reconciledModelId ?? intent.model, newProviderId);
        return;
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
            useAtomicSelection
              ? { effort: targetEffort, fastMode: restoredFast }
              : undefined,
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
            { activeProviderId: newProviderId, memoryProviderId: newProviderId },
          );
          if (currentModelAgentKind && newProviderId) {
            modelMemory?.setFast(
              currentModelAgentKind,
              newProviderId,
              modelId,
              restoredFast,
            );
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
        const { efforts, defaultEffort } = resolveModelEfforts(activeModel);
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
            .setModel(
              sessionId,
              rollbackProvider.model,
              rollbackProvider.providerId,
              undefined,
              { effort: activeEffort, fastMode },
            )
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
      const previousMode = activePermissionModeRef.current;
      if (requiresFullAccessConfirmation(previousMode, newMode)) {
        const confirmed = await confirmDialog({
          title: t('newChat.chatInput.fullAccessConfirmation.title'),
          description: t('newChat.chatInput.fullAccessConfirmation.description'),
          confirmText: t('newChat.chatInput.fullAccessConfirmation.confirm'),
          cancelText: t('newChat.chatInput.fullAccessConfirmation.cancel'),
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
    [sessionId, onPermissionModeDidChange, t, confirmDialog],
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
  const hasVoiceDraftText = voiceInput.draftText.trim().length > 0;
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
    (!voiceInput.isListening && !canSend && !hasVoiceDraftText) ||
    voiceInput.state === 'submitting' ||
    voiceInput.state === 'refining',
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
    showStopButton && (sendDispatchInFlight || (!canSend && !voiceInput.isBusy));
  const showSecondaryStop =
    showStopButton && (canSend || voiceInput.isBusy) && !sendDispatchInFlight;
  useEffect(() => {
    voiceInputCanStopAndSendRef.current = !sendButtonDisabled;
    composerCanSubmitRef.current = !sendButtonDisabled;
  }, [sendButtonDisabled]);
  const canReleaseVoiceToSend = Boolean(!disabled && (voiceInput.isListening || canSend || hasVoiceDraftText));
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
  const useUltraCompactToolbar =
    useNarrowToolbar && (toolbarWidth == null || toolbarWidth < 420);

  return (
    <div className="relative flex w-full flex-col items-center gap-4" data-chat-input-root>
      {/* 计划模式激活态 chip(输入框上方,与 GoalIndicator 同形)。-mb-2 抵一部分
          root gap-4,让 chip 与输入框间距接近 GoalIndicator 的节奏。 */}
      {planModeEntry && planModeEnabled && (
        <div className="-mb-2 w-full">
          <PlanModeIndicator onExit={() => void onPlanModeChange?.(false)} disabled={disabled} />
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
                caretAtDocStart:
                  selection.empty && selection.from === Selection.atStart(doc).from,
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
                    className="inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-2.5 text-[12px] group-hover/bcomment:pr-7"
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
                              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
                              style={{
                                backgroundColor: 'var(--focus-ring)',
                                color: '#fff',
                              }}
                            >
                              {item.markerNumber}
                            </span>
                            <span
                              className="inline-flex items-center rounded px-1 py-px font-mono text-[10px]"
                              style={{
                                backgroundColor: 'var(--surface-chip)',
                                color: 'var(--text-tertiary)',
                              }}
                            >
                              {commentPreviewTag(item)}
                            </span>
                          </span>
                          <span
                            className="line-clamp-2 whitespace-pre-wrap text-[12px] leading-[1.5]"
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
                onRemove={removeFile}
                onUpdate={updateFile}
              />
            )}

            {/* Editor — 用负 margin 向右破出容器的 px-[11px],让 scrollbar 贴到圆角边;
             内层 ProseMirror 加 pr-[11px] 作为文字 gutter,视觉上文字宽度与原先一致。 */}
            <VoiceInputPointerHintLayer
              active={voiceInput.isBusy}
              state={voiceInput.state}
              className="w-full"
            >
              <EditorContent
                editor={editor}
                className={cn(
                  'w-[calc(100%+11px)] -mr-[11px]',
                  // Disabled gets the same visual cue as the old textarea
                  disabled && 'cursor-not-allowed opacity-60',
                  voiceInput.isBusy && 'cursor-default',
                )}
                data-voice-draft-active={voiceInput.draftText ? 'true' : undefined}
              />
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
                {/* composer 「+」菜单(权限左侧):本机会话提供附件入口;目标、计划/协同模式、
                Plugin、引用目录按各自能力与接线显示。远程会话不能把控制端绝对路径
                交给远端 agent,因此不接本机文件选择器。 */}
                <ExtraDirsButton
                  extraDirs={extraDirs ?? []}
                  workingDir={workingDir}
                  onAddFiles={localAttachmentPickerEnabled ? addFiles : undefined}
                  planMode={planModeEntry}
                  collaboration={collaboration}
                  plugins={pluginsForMenu}
                  pluginAvailableIds={pluginAvailableIds}
                  onPluginSelect={handlePluginSelect}
                  onChange={onExtraDirsChange}
                  onNewGoal={
                    inSessionGoalEnabled || onNewGoal
                      ? () => {
                          // 把输入框当前文字(去空白)作为目标默认内容。
                          const ed = editorRef.current;
                          const draftText =
                            ed && !ed.isDestroyed ? serializeEditorContent(ed).text.trim() : '';
                          if (inSessionGoalEnabled) {
                            setNewGoalInitial(draftText);
                            setNewGoalOpen(true);
                          } else {
                            onNewGoal?.(draftText);
                          }
                        }
                      : undefined
                  }
                  disabled={disabled}
                  dense={effectiveDenseToolbar}
                  visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                />
                <PermissionSelector
                  permissionMode={activePermissionMode}
                  onPermissionModeChange={handlePermissionModeChange}
                  vendorKey={vendorKey}
                  deviceId={deviceLinkDeviceId}
                  disabled={disabled}
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
                  (useCompactMiddleToolbar
                    ? compactMiddleToolbarSlot ?? <>{middleToolbarSlot}</>
                    : <>{middleToolbarSlot}</>)}
                <div className={useNarrowToolbar ? 'min-w-0 shrink' : undefined}>
                  <ModelSelector
                    modelId={activeModel}
                    effort={activeEffort}
                    onModelChange={handleModelChange}
                    onEffortChange={handleEffortChange}
                    // 意图期显示目标引擎下解析出的 fast(apply 时才落库),无意图走真实态。
                    fastMode={agentSwitchIntent?.fastMode ?? fastMode}
                    onFastModeChange={handleFastModeChange}
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
                    // session-agent-switch:已建会话提供显式两步引擎切换(列表顶部
                    // Claude/Codex 分段,先选 Agent 再选模型)。device-link 远程会话同样
                    // 支持(隧道到被控端执行,与手机端同一套 channel),入口按被控端能力位
                    // 门控。草稿(无 sessionId)与 SSH 远程会话仍不传。
                    agentSwitch={
                      sessionId && vendorKey && !remoteHostId && sessionAgentSwitchSupported
                        ? {
                            currentVendor: vendorKey,
                            confirmBrowseSwitch: confirmAgentBrowseSwitch,
                            onSwitch: performAgentSwitch,
                          }
                        : undefined
                    }
                    deviceId={deviceLinkDeviceId}
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
                    // 已建会话按实际路由口径解析当前来源(含停用拷贝,跟真实扣费路由);
                    // 草稿是新路由选择,保持准入口径(PR #744 review 第十轮)。
                    actualRoute={!!sessionId}
                    onProviderChange={handleProviderChange}
                    onNavigateToProviders={handleNavigateToProviders}
                    switching={remoteSwitchInFlight}
                    disabled={disabled || agentSendDispatchInFlight || agentSwitchInFlight}
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
                      onClick={onStop ?? (() => {})}
                      isStreaming
                      visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}
                    />
                  )}
                  <VoiceInputButton
                    state={voiceInput.state}
                    disabled={!!disabled || !editor}
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
                  <span ref={sendButtonRef} className="inline-flex rounded-full">
                    {mainSlotIsStop ? (
                      <SendButton
                        disabled={false}
                        onClick={onStop ?? (() => {})}
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
          {atOpen && trigger.kind === 'at' && (
            <AtMentionPanel
              query={trigger.query}
              state={atState}
              focusedIndex={atFocus}
              onFocusedIndexChange={setAtFocus}
              onSelect={(item) => insertAtResource(item)}
              onClose={() => {
                if (trigger.kind === 'at') setSuppressedAtAt(trigger.from);
              }}
              onRetry={() => runAtScan(atQuery)}
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
                  <span className="text-[15px] font-normal text-[var(--folder-btn-text)]">
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
            'whitespace-nowrap pr-3 text-[12.5px] tabular-nums',
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
            'px-4 py-[10px] text-[13px] font-medium leading-snug text-[var(--cmd-palette-item-text)]',
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
                <span className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>
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
          'absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white',
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
