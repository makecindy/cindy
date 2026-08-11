/**
 * MessageStream
 * ---------------------------------------------------------------------------
 * Vertically scrolling message list with auto-scroll-to-bottom.
 *
 * F-MSG-1: Message stream container
 * - Messages listed top-to-bottom, gap 14px (v2 — F10 halved from 28px)
 * - Content area max-width 880px, centered
 * - Auto-scroll to bottom on new messages, unless user scrolled up
 *
 * cc-agent-compact-blocks v2 (F8 / F9): tool_use messages between text
 *   segments collapse into a single AgentActionsBlock — default collapsed,
 *   per-block expand state remembered in-memory (not persisted; lost on
 *   app restart) via useExpandedBlockMemory. Streaming no longer
 *   auto-expands; the user opens blocks manually if they want to peek live.
 * F-SYNC-2: Scroll-to-top pagination with position preservation.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { GitFork } from 'lucide-react';
import { SelectionQuoteButton } from './SelectionQuoteButton';
import { useTranslation } from 'react-i18next';
import {
  deriveAgentTaskStatus,
  subagentSpawnReceiptName,
  subagentSpawnResultIndicatesRunning,
} from '@cindy/maker-shared/agent-task';
import {
  isAgentPlanToolName,
  isDeliveryProseText,
} from '@cindy/maker-shared/message-render';
// 子代理卡判据只能有一份:此前桌面自带一份只认 Agent/Task/collab:* 的副本,新增 harness
// (PI 的 subagent)加进共享判据也到不了 AgentTaskCard,会静默落进普通工具组(codex review)。
import { isAgentTaskToolName } from '@cindy/maker-shared/agent-task';

import type {
  AgentTaskUpdate,
  ChatMessage,
  ContinuationInFlightProjectionCapability,
} from '@/hooks/useCCAgentChat';
import { Spinner } from '@/components/ui/spinner';
import { BrandLoadingMark } from '@/components/branding/BrandLoadingMark';
import { useMessageNavRailPreference } from '@/hooks/useMessageNavRailPreference';
import { HISTORY_GAP_SPLIT_MS } from '@/lib/historyGap';
import { resolveToolFilePath, type KnownLocalFileRef } from '@/lib/localPathResolver';
import { collectGeneratedFiles, type GeneratedFileRef } from '@/lib/generatedFiles';
import {
  isRemoteSessionSticky,
  subscribeTurnChangeSetUpdated,
} from '@/lib/makerTransport';
import { isEditableKeyboardTarget } from '@/lib/editableKeyboardTarget';
import { createLogger } from '@/lib/logger';
import { stopAllMedia } from '@/lib/mediaPlaybackBus';
import { cn } from '@/lib/utils';
import {
  readSessionScroll,
  saveSessionScroll,
  type SessionScrollSnapshot,
} from '@/lib/sessionScrollStore';
import { SHARE_MESSAGE_ATTR, SHARE_SESSION_ATTR } from '@/lib/shareConversationImage';
import { ShareMessageCheckbox } from './ShareMessageCheckbox';
import { isShareableMessage, useShareSelectionActive } from './shareSelectionStore';

// perf-baseline: 大 session 切换 first-paint 性能基线,保留用于回归监测。
// 历史:commit ffff3603 (render-window 首引入) 因 687 条 session first-paint
// 80–300ms 卡顿引入临时探针;render-window 重构到 item 轴后(本次)转正成常驻
// 基线日志 — 任何动 MessageStream 渲染路径的改动可直接对比 `stream:first-paint
// elapsed=` 字段做回归判定。日志级 debug:DevTools 默认级别下不显示(归 Verbose),
// dev 的文件日志(main 侧 dev 默认 trace)仍落盘可查;生产(main 默认 info)不落。无 PII。
const perfLog = createLogger('perf/session-switch');

// jump-down chip 静止隐藏时长 — 用户向下滚动停止后多久淡出。2s 是用户要求,
// 与 prev-msg-jump 的 IDLE_HIDE_MS=3000 区分(向上 chip 显示更长方便回看,
// 向下 chip 是快捷跳转 affordance,短一些不打扰)。
const JUMP_DOWN_IDLE_MS = 2000;
// 方向判断死区 — 1px 内的 scrollTop 变化不算方向。
const SCROLL_DIRECTION_DEAD_ZONE_PX = 1;
const TOUCH_HISTORY_INTENT_THRESHOLD_PX = 8;
const HISTORY_NAVIGATION_KEYS: ReadonlySet<string> = new Set(['PageUp', 'ArrowUp', 'Home']);
// chip jump 抑制 expand/load 的安全兜底时长。正常解抑靠 wheel/touch/keydown,
// 这个 timer 只防"click 后既不滚也不动键盘"的极端情况,够长能覆盖最长 smooth
// scroll(浏览器长距离 ~1s)。
const CHIP_JUMP_SAFETY_MS = 3000;
// 卡片"展开详情"点击后跳过贴底跟随的窗口。click → setState → 重渲 → RO 回调
// 通常 1-2 帧内到达,300ms 富余;窗口过后 auto-follow 原样恢复。
const CARD_EXPAND_PIN_SUPPRESS_MS = 300;
// ── render-window ──
// 切大 session 时一次性 mount 全部 UI 卡会卡(687 条 messages → commit 80–300ms)。
// 先只渲染最后 N 个 render-item(渲染单元 = 已折叠 / 已丢弃后的 UI 卡),用户滚到顶
// 按 GROWTH 继续把更早的 item 纳入窗口;窗口已包含所有内存中的 item 后,才走原有
// F-SYNC-2 onLoadMore 去拉 DB 更早历史。
//
// 关键设计:窗口单位是 **render-item** 而非 message。原因见 commit history (U1/U2 死锁):
// `buildRenderItems` 把 messages 折叠 / 丢弃 / 反向膨胀,密度极不均匀。以消息条数
// 切窗会让"末尾 100 条恰好全是 orphan tool_result / ask_user / AskUserQuestion /
// ExitPlanMode"等场景塌缩到 items=[] 死锁。以 render-item 切窗时这些丢弃类型不会
// 出现在 `allRenderItems` 末尾,死锁同源 bug 一次性消失。
//
// 锚点用 `firstVisibleItemKey`(item 的 stable key,见 RenderItem.key 派生约定),
// 不用 index — DB prepend / 流式追加 / 客户端扩窗都会让 index 漂移,key 稳定。
// export 供 render-window 集成单测复用同一基准值,避免测试里再定义一份靠注释手动同步。
export const RENDER_WINDOW_INITIAL_ITEMS = 80;
// 首屏窗口:切会话(mount)首帧只画末尾 FIRST_PAINT 个 item,首帧提交后的
// 空闲期再把默认窗口扩回 INITIAL —— 首屏 commit 体量减少,补窗那笔开销移出
// 点击关键路径。15 条足以覆盖典型视口(240px/条 × 15 = 3600px > 常见屏幕高度),
// 且锚定恢复路径下 viewportTopKey 就是窗口首条,大小 ≥1 天然满足。
// 安全约束:
//   - 扩窗 = 在视口上方 prepend,仅在"仍钉在底部"时执行,pin-to-bottom layout
//     effect 会在同一帧把视口重新钉回底,无视觉跳动;
//   - 用户在 FIRST_PAINT 阶段就向上滚动时,走既有 expandWindow 锚点路径,
//     默认窗口保持小尺寸不再自动扩(读历史的人不需要底部多 mount 50 条)。
export const RENDER_WINDOW_FIRST_PAINT_ITEMS = 15;
const RENDER_WINDOW_GROWTH_ITEMS = 80;
const RENDER_WINDOW_BOUNDARY_LOOKBACK_ITEMS = 24;
/** shell-first mount 的首帧空窗口。模块级常量保证引用稳定,不触发下游 memo 重算。 */
const EMPTY_RENDER_ITEMS: RenderItem[] = [];

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function hasNestedScrollableAncestorThatCanScrollUp(
  root: HTMLElement,
  target: EventTarget | null,
): boolean {
  let el = eventTargetElement(target);
  while (el && el !== root) {
    if (!root.contains(el)) return false;
    const overflowY = window.getComputedStyle(el).overflowY;
    const canScroll =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      el.scrollHeight - el.clientHeight > SCROLL_DIRECTION_DEAD_ZONE_PX &&
      el.scrollTop > SCROLL_DIRECTION_DEAD_ZONE_PX;
    if (canScroll) return true;
    el = el.parentElement;
  }
  return false;
}

import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { AskUserQuestionBubble } from './AskUserQuestionBubble';
import { ErrorMessageCard } from './ErrorMessageCard';
import { APP_EXIT_INTERRUPTED_REASON } from '../../../shared/interruptedTurn';
import { PlanReviewBubble } from './PlanReviewBubble';
import { ToolCallCard, getToolSummary } from './ToolCallCard';
import { SystemCard } from './SystemCard';
import { NewMessageIndicator } from './NewMessageIndicator';
import { ThinkingCard } from './ThinkingCard';
import { AgentActionsBlock } from './AgentActionsBlock';
import { AgentTaskCard } from './AgentTaskCard';
import { TurnChangesCard } from './TurnChangesCard';
import { GeneratedFilesCard } from './GeneratedFilesCard';
import { WorkGroupBlock, type WorkGroupChild } from './WorkGroupBlock';
import {
  extractAnchorCardId,
  extractGhostCardId,
  extractToolResultMedia,
  type ToolMediaItem,
} from './AgentActionRow';
import { CARD_EXPAND_TOGGLE_EVENT, GhostToolCard } from './GhostToolCard';
import {
  ensureCard,
  ensureSessionCards,
  getGhostCardSnapshot,
  subscribeGhostCards,
  type GhostCardSnapshot,
} from '@/cindy-brain/ghostCardStore';
import {
  collectGhostCardGalleryImages,
  createGhostCardSpawnIndex,
} from '@/cindy-brain/ghostCardGallery';
import { ChatImageView } from './ChatImageView';
import { ImageGalleryContext, type GalleryImage } from './ImageGalleryContext';
import { GhostFulfillmentContext } from './GhostSummonCard';
import { ChatSessionFileProvider, useChatSessionFileValue } from './ChatSessionFileContext';
import { toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin, type RemoteMediaOrigin } from '@/../shared/remoteMediaUrl';
import { isGhostCallToolName } from '@/../shared/ghost';
import { ChatVideoView } from './ChatVideoView';
import { ChatAudioCard } from './ChatAudioCard';
import { ChatSoundEffectCard } from './ChatSoundEffectCard';
import { PrevMessageJumpChip, firstNonEmptyLine } from './PrevMessageJumpChip';
import { useTopRightChipSlot } from './TopRightChipStack';
import { usePrevUserMessageInView } from './usePrevUserMessageInView';
import { JumpToBottomChip } from './JumpToBottomChip';
import { MessageNavRail } from './MessageNavRail';
import {
  NAV_RAIL_JUMP_TOP_OFFSET_PX,
  deriveNavRailEntries,
  shouldBackfillForNavRail,
} from './messageNavRailModel';
import { resolveUserDisplayText } from './userMessageDisplayText';
import { detectScrollAnchoringApplied } from './scrollAnchoringDetect';
import {
  decideAutoFillAction,
  decideUserIntentFillAction,
  TOP_HISTORY_TRIGGER_PX,
  NO_SCROLL_TOLERANCE_PX,
} from './viewportFillDetect';
import {
  resolveNearBottomOnScroll,
  resolveLastUserMessageObservation,
  resolveRenderPinDecision,
  selectTailUserMessageId,
  shouldUnpinOnUpIntent,
  shouldUnpinOnWheel,
} from './autoFollowIntent';
import { useNavigationKeyListener } from './useNavigationKeyListener';
import { suppressScrollbarActivation } from '@/lib/scrollbarAutoHide';
import { collectAssistantTurnUsageDetails } from '@/lib/userTurnUsage';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import { hasReviewableTurnChanges, type TurnChangeSetSummary } from '../../../shared/turnChangeSet';

interface MessageStreamProps {
  /** Active session id — used to reset scroll state on session switch. */
  sessionId?: string;
  /** Active session title, forwarded to handoff cards for return navigation. */
  sessionTitle?: string | null;
  /** Owning agent kind — propagated to UserMessage so capability gates
   *  (fork/rewind icon visibility) can read the right agent's capabilities. */
  agentKind?: 'cc' | 'codex' | 'pi';
  /** Owning session's remote SSH host id (null for local sessions). Forwarded
   *  so message-level controls can gate features unsupported on remote
   *  (e.g. rewind on cc-remote daemon sessions). */
  remoteHostId?: string | null;
  /** Session working directory; passed down so MarkdownRenderer / UserMessage
   *  can resolve relative paths in markdown links and inline @-chips
   *  (text-lightbox-trigger-extension F1 / F2). Stable within a session
   *  lifecycle — only changes on session switch (which already remounts
   *  MessageStream via the `key={sessionId}` parent prop), so it never
   *  triggers extra re-renders mid-session. */
  workingDir: string;
  messages: ChatMessage[];
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
  /** Kept for API compatibility. v2 — no longer threaded into render items
   *  (AgentActionsBlock + ThinkingCard manage their own per-block expand
   *  state via useExpandedBlockMemory). The session-level "is streaming"
   *  state lives on each ChatMessage's own `isStreaming` field instead. */
  isSessionStreaming?: boolean;
  /** 当前 vendor turn 的续跑发起项 clientId；steer 顶替 activeTurn 后仍保持。 */
  continuationTurnClientId?: string | null;
  /** 旧被控端缺省该字段时才启用兼容兜底；unknown 在首个投影前 fail closed。 */
  continuationInFlightProjectionCapability?: ContinuationInFlightProjectionCapability;
  /** F-SYNC-2: callback to load older messages */
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  hasMoreMessages?: boolean;
  /** Dynamic bottom padding (px) to reserve space for the input overlay */
  bottomPadding?: number;
  /** Content width — shared with the input overlay so chat stream + input
   *  box stay horizontally aligned (same width, same center, symmetric
   *  padding when the main area is compressed). */
  contentWidth?: number;
  /** Message clientId to scroll into view and briefly highlight after search navigation. */
  focusMessageClientId?: string | null;
  /** Incremented by the parent for each search navigation, including repeated hits. */
  focusMessageRequestId?: number;
  /** Source marker shown for sessions forked from another conversation. */
  forkOrigin?: {
    parentSessionId: string;
    forkedAtMessageId: string;
    forkedSessionCreatedAt: string;
  } | null;
  /** Opens the parent conversation and focuses the original fork point. */
  onOpenForkOrigin?: () => void;
}

// ---------------------------------------------------------------------------
// Merged rendering items
// ---------------------------------------------------------------------------

// Render-item 单元:渲染窗口 / 锚点 / 滚动数学的统一度量。`key` 是 stable id,
// 跨 build 保持稳定(由消息 clientId 派生),供:
//   - React `key=` 复用 DOM 节点(避免 unmount 丢折叠态)
//   - render-window 锚点 `firstVisibleItemKey` 跨 build 定位 slice 起点
// key 派生约定见 buildRenderItems 内注释。
// export 仅供单测(`buildRenderItemsKeyStability.test.ts`)使用,运行时无外部消费者。
// message / tool_segment 抽成命名别名 — work_group 的 children 需要在类型层
// 引用这两个成员(WorkChildItem),让「children 只含这两类」由类型系统保证,
// 渲染处无需 as 强转;其余成员保持内联。
type MessageRenderItem = { type: 'message'; key: string; message: ChatMessage };
type ToolSegmentRenderItem = {
  /** A run of consecutive tool_use messages between text segments,
   *  rendered as a single AgentActionsBlock. v2 — no isStreaming
   *  field; default-collapsed + persistent memory removes the need
   *  to thread streaming state down. */
  type: 'tool_segment';
  key: string;
  toolCalls: ChatMessage[];
  resultMap: Map<string, string>;
  /** tool_use clientId 集合:tool_result 已到达(含被 shouldHideToolResult
   *  隐藏、没进 resultMap 的空结果)。行级 running/done 状态判定用 —
   *  只看 resultMap 会让 orca 通信工具永久显示 running。 */
  settledIds: Set<string>;
  /** tool_use clientId → 对应 tool_result 的 createdAt(ms)。
   *  段的结束时间必须算进 result:单次工具跑了半小时以上时,只看最后一个 tool_use 的
   *  createdAt 会把段的结束时间大幅低估,让紧随其后的最终答复被空洞守卫误判(#676
   *  review)。resultMap 只留正文,时间戳单独存这里。 */
  resultTsMap: Map<string, number>;
};
type AgentTaskRenderItem = {
  type: 'agent_task';
  key: string;
  toolCall?: ChatMessage;
  update?: AgentTaskUpdate;
  result?: string;
  /** 对应 tool_result 的 createdAt(ms)。历史会话没有 live taskUpdates 时,item 的结束
   *  时间只能靠它 —— 否则跑了半小时以上的 Agent/Task 会让紧随其后的最终答复被空洞守卫
   *  误判(#676 review)。与 tool_segment 的 resultTsMap 同源。 */
  resultTsMs?: number;
};
type ForkOriginRenderItem = {
  type: 'fork_origin';
  key: string;
  parentSessionId: string;
  forkedAtMessageId: string;
};
type TurnChangesRenderItem = {
  /** Exact provider patches attached to one visible user turn. */
  type: 'turn_changes';
  key: string;
  changeSet: TurnChangeSetSummary;
};
type GeneratedFilesRenderItem = {
  type: 'generated_files';
  key: string;
  files: GeneratedFileRef[];
  turnStartMs: number | null;
  turnEndMs: number | null;
};

/** 原子工作子项:tool / agent task / thinking / assistant 工作文字。 */
export type WorkChildItem = ToolSegmentRenderItem | AgentTaskRenderItem | MessageRenderItem;

/** work_group 可以嵌套一层:完成态外组装 assistant 文字时间线,其中每段
 *  连续动作仍是独立的内层「已工作 Xs」。内层继续只收原子工作子项。 */
type WorkGroupChildItem = WorkChildItem | WorkGroupRenderItem;

interface WorkGroupRenderItem {
  /** work-group:运行中的连续动作段,或完成态收拢整段工作文字的外层时间线。
   *  动作段展开后直接显示思考 / 工具行;外层展开后显示 assistant 文字和
   *  仍保持折叠的内层动作段。tool_media 不参与合并,继续留在组外可见。 */
  type: 'work_group';
  key: string;
  children: WorkGroupChildItem[];
  durationMs?: number;
  /** 当前是否是仍在执行的尾部动作段。完成态时间线始终 false。 */
  isStreaming: boolean;
  /** 工作段起点 epoch ms,供 live elapsed ticker 使用。优先是上一个边界
   *  (用户消息/上一句正文,可能早于段内首个活动),边界缺失时退回首个活动
   *  时间戳 —— 与 durationMs 的段起点同源(见 createWorkGroup)。 */
  startedAtMs?: number;
}

export type RenderItem =
  | MessageRenderItem
  | ToolSegmentRenderItem
  | AgentTaskRenderItem
  | ForkOriginRenderItem
  | TurnChangesRenderItem
  | GeneratedFilesRenderItem
  | {
      /** tool-result-media: 把 tool_result 里的 xdt_image_url(s) / xdt_video_urls
       *  提取出来作为独立视觉消息渲染,跳出 tool_segment 折叠卡片。统一容器,
       *  按 kind 分发到 ChatImageView / ChatVideoView。
       *
       *  生成期间不展示占位卡 — 与 image_generate 保持同款体验:tool_use 卡
       *  自身就标识"正在做",result 一到再渲染媒体。失败由 tool_result 文本
       *  里的 error 字段承载,不需要单独的 placeholder。 */
      type: 'tool_media';
      key: string;
      items: ToolMediaItem[];
    }
  | {
      /** ghost-card(卡槽③海报模式):意识为自己的一次 ghost_call 供片的
       *  聊天卡片,是该次调用的**唯一呈现**——配上卡后对应工具行不进
       *  tool_segment(行与卡信息重复,合并进卡),原始调用参数由卡片头带
       *  展开区承担(toolCall 透传)。key 锚定 ghost_call tool_use 的
       *  clientId(`ghostcard-${clientId}`,窗口锚定稳定);卡体 html/height
       *  渲染时从 ghostCardStore 现取(限速 ≥1s/卡,重建频率可控)。
       *  settled=false 为进行中(turn 内活卡,claude 精确 toolUseId 锚 /
       *  codex 同 ghost 启发式锚),tool_result 到达后经 xdt_card_id 配对
       *  转 settled。未供卡的调用不产生本 item —— 逐像素回退今日渲染。 */
      type: 'ghost_card';
      key: string;
      callId: string;
      ghostId: string;
      /** 该次调用的意识侧工具名(toolInput.tool;身份头徽章展示)。 */
      tool: string;
      /** 原始 tool_use 消息(头带展开区显示调用参数;审计层不因行隐身而丢)。 */
      toolCall: ChatMessage;
      settled: boolean;
      /** 配对到的 tool_result 时间戳(ms)。与 AgentTaskRenderItem.resultTsMs 同口径:
       *  toolCall.createdAt 只是"开始调用",一次跑很久的供卡调用(出图 / 出视频)拿它
       *  当结束会把结束时间低估整个执行时长,紧随其后的正文被误判成历史空洞。
       *  未配对(活卡)时缺省。 */
      resultTsMs?: number;
      /** 回锚媒体:后续调用(如 poll_result)的 tool_result 带 xdt_anchor_card_id
       *  指回本卡时,其媒体挂在卡正下方渲染(替换"生成中"的视觉位置),而非
       *  留在轮询调用处。仅同 ghostId 的结果可锚入;无回锚时字段缺省。 */
      media?: ToolMediaItem[];
    }
  | WorkGroupRenderItem;

function isRenderWindowBoundaryItem(item: RenderItem | undefined): boolean {
  return item?.type === 'fork_origin' || (item?.type === 'message' && item.message.role === 'user');
}

/**
 * 首帧字节预算:单条 render item 的挂载成本估算(≈ markdown parse 体量)。
 * message 正文按字符数计(react-markdown parse 成本与正文长度近似线性);
 * 折叠类卡片(tool_segment / agent_task / work_group)默认收拢、不 parse 正文,
 * 按小常量计;ghost_card 挂 html 卡体,按较大常量计。
 */
export function estimateRenderItemMountCost(item: RenderItem): number {
  if (item.type === 'message') return 200 + item.message.content.length;
  if (item.type === 'ghost_card') return 2000;
  return 300;
}

/**
 * 首帧窗口的内容预算(估算成本单位 ≈ 字符数)。
 *
 * 条数上限(FIRST_PAINT_ITEMS)防"多而小",本预算防"少而大"——单条 12KB
 * 大表格的压测 session,15 条 = ~380ms(dev 构建实测,2026-08-10 perf 日志),
 * 条数封顶对它无效。两者先到为准。64k ≈ 5 条大表格 ≈ ~130ms dev、release 减半;
 * 普通 session(单条 <2KB)触不到本预算,照走条数上限。
 * 被预算推迟的 item 由既有空闲扩窗(FIRST_PAINT → INITIAL)在 ~1s 内补回,
 * 不影响内容完整性。
 */
export const RENDER_WINDOW_FIRST_PAINT_BUDGET = 64_000;

/**
 * 从末尾向前累计挂载成本,预算耗尽时把窗口起点向后收(渲染更少条)。
 * 至少保留最后 1 条(单条超预算也要渲染它)。export 供单测。
 */
export function clampTailWindowStartByBudget(
  items: readonly RenderItem[],
  countStartIdx: number,
  budget = RENDER_WINDOW_FIRST_PAINT_BUDGET,
): number {
  let cost = 0;
  for (let i = items.length - 1; i >= countStartIdx; i--) {
    cost += estimateRenderItemMountCost(items[i]);
    if (cost > budget && i < items.length - 1) return i + 1;
  }
  return countStartIdx;
}

export function resolveAnchoredWindowItemCount(
  startIdx: number,
  anchorIdx: number,
  desiredForwardItems: number,
): number {
  return desiredForwardItems + Math.max(0, anchorIdx - startIdx);
}

export function shouldBoostDefaultWindow({
  allItemCount,
  visibleItemCount,
  defaultWindowItems,
}: {
  allItemCount: number;
  visibleItemCount: number;
  defaultWindowItems: number;
}): boolean {
  if (defaultWindowItems >= RENDER_WINDOW_INITIAL_ITEMS) return false;
  return visibleItemCount < allItemCount;
}

export function resolveDefaultWindowStartIdx({
  allItemCount,
  defaultWindowItems,
  visibleStartIdx,
  visibleItemCount,
}: {
  allItemCount: number;
  defaultWindowItems: number;
  visibleStartIdx: number;
  visibleItemCount: number;
}): number {
  // 首帧字节预算可能让实际 DOM 窗口比声明容量小。用户在 idle boost 前主动
  // 向上滚动时，必须从真实 visibleStartIdx 扩，而不是用声明容量反算出 0。
  if (visibleItemCount < allItemCount) return visibleStartIdx;
  return Math.max(0, allItemCount - defaultWindowItems);
}

// export 仅供 render-window 集成单测使用。窗口默认/扩窗时如果刚好切在
// agent_task / work_group / assistant 中间,顶部会出现无上下文的卡片。
// 向前吸收同一 user turn 的开头,但限制 lookback 防止单个超长 turn 破坏首屏预算。
export function snapRenderWindowStartIdx(
  items: readonly RenderItem[],
  startIdx: number,
  maxLookback = RENDER_WINDOW_BOUNDARY_LOOKBACK_ITEMS,
): number {
  if (items.length === 0) return 0;
  const clamped = Math.min(Math.max(0, startIdx), items.length - 1);
  if (clamped === 0 || isRenderWindowBoundaryItem(items[clamped])) return clamped;

  const stop = Math.max(0, clamped - Math.max(0, maxLookback));
  for (let i = clamped - 1; i >= stop; i--) {
    if (isRenderWindowBoundaryItem(items[i])) return i;
  }
  return clamped;
}

function ForkOriginMarker({ onClick }: { onClick?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="h-px flex-1 bg-[var(--border-default)]" />
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className="group inline-flex shrink-0 items-center gap-2 bg-transparent p-0 text-13 font-medium leading-5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default disabled:text-[var(--text-tertiary)] disabled:hover:no-underline"
      >
        <GitFork size={15} strokeWidth={2} className="shrink-0" aria-hidden="true" />
        <span>{t('chat.forkOrigin.label')}</span>
      </button>
      <div className="h-px flex-1 bg-[var(--border-default)]" />
    </div>
  );
}

function areLocalFileRefsEqual(
  a: readonly KnownLocalFileRef[],
  b: readonly KnownLocalFileRef[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].path !== b[i].path) return false;
  }
  return true;
}

// export 仅供单测使用。MessageStream 用它在 streaming token 期间复用未变化的
// localFileRefs 引用，避免打破历史 MessageItem 的 memo。
export function collectStableLocalFileRefs(
  messages: readonly ChatMessage[],
  previousRefs: readonly KnownLocalFileRef[] = [],
): readonly KnownLocalFileRef[] {
  const refs: KnownLocalFileRef[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const file of message.files ?? []) {
      refs.push({ name: file.name, path: file.path });
    }
  }
  return areLocalFileRefsEqual(previousRefs, refs) ? previousRefs : refs;
}

export function assistantHasFollowingUserBoundary(
  messages: readonly ChatMessage[],
  assistantClientId: string,
): boolean {
  const idx = messages.findIndex((m) => m.clientId === assistantClientId);
  if (idx < 0) return false;
  return messages.slice(idx + 1).some((m) => m.role === 'user' && m.delivery !== 'steer');
}

function collectAssistantsWithFollowingUserBoundary(messages: readonly ChatMessage[]): Set<string> {
  const out = new Set<string>();
  let hasFollowingUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && message.delivery !== 'steer') {
      hasFollowingUser = true;
    } else if (message.role === 'assistant' && hasFollowingUser) {
      out.add(message.clientId);
    }
  }
  return out;
}

/**
 * 意识"提及 → 兑现"关联(方案 2,渲染期从持久数据推导,重启幂等):
 * 逐条扫消息,维护"当前轮的 user 消息",遇到 assistant 的 ghost_call 工具
 * 调用就把其 ghost_id 记到当前 user 名下——即"这条 user 触发的那一轮里,
 * AI 真的召唤了哪些意识"。软提示徽章据此升级为召唤卡(徽章说'提到了',
 * 兑现后才敢说'召唤了')。turn 边界 = 下一条非 steer 的 user 消息。
 * 判据全取自会话历史(user 消息 + ghost_call tool_use 都已持久化),不落
 * 任何额外状态,重启重算结果一致。
 */
export function collectGhostCallsByUserTurn(
  messages: readonly ChatMessage[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let currentUserClientId: string | null = null;
  for (const m of messages) {
    if (m.role === 'user' && m.delivery !== 'steer' && !m.isSyntheticTrigger) {
      currentUserClientId = m.clientId;
      continue;
    }
    if (
      currentUserClientId &&
      isGhostCallToolName(m.toolName) &&
      m.toolInput &&
      typeof (m.toolInput as Record<string, unknown>).ghost_id === 'string'
    ) {
      const gid = (m.toolInput as Record<string, unknown>).ghost_id as string;
      const set = out.get(currentUserClientId) ?? new Set<string>();
      set.add(gid);
      out.set(currentUserClientId, set);
    }
  }
  return out;
}

/**
 * 兑现关联 map 的结构等价判断:用于给 Provider value 做引用缓存。
 * messages 数组在流式期间每批 delta 都换新引用,useMemo 会重算出"内容相同
 * 但身份全新"的 Map;而 UserMessage 顶层订阅该 context(判定合并形态),
 * context 消费按 Object.is 判变、无视 memo——不做等价缓存的话,每批 token
 * 都会把全部历史 UserMessage 重渲一遍(规则 10 热路径口径)。fulfillment
 * 实际只在 ghost_call 落地时才变化,每 turn 至多一两次。
 */
export function ghostCallMapsEqual(
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, setA] of a) {
    const setB = b.get(key);
    if (!setB || setA.size !== setB.size) return false;
    for (const v of setA) if (!setB.has(v)) return false;
  }
  return true;
}

/**
 * 已加载消息里"整段对话首条 user 消息"的 clientId(判不出则 null)。
 * 首条 user 消息要隐藏 Fork/Rewind/编辑(没有 prior assistant 锚点,后端必抛
 * NO_PRIOR_ASSISTANT)。关键修正:messages 只是**已加载的尾部切片**(初始 50 条),
 * `hasMoreOlderMessages=true` 时真正的首条 user 消息(任何会话的第一行)还在
 * 未加载的老页里,切片首条必然不是它——此时返回 null,不把任何已加载消息误判
 * 为首条。此前的误判会让"一个长 turn 挤掉切片里更早 user 消息"的会话在滚动
 * 加载前丢失最后一条消息的 Fork/Rewind/编辑按钮(hover 只剩复制 + 时间戳)。
 * 导出为纯函数供单测直接断言。
 */
export function findFirstUserMessageClientId(
  messages: readonly ChatMessage[],
  hasMoreOlderMessages: boolean,
): string | null {
  if (hasMoreOlderMessages) return null;
  for (const m of messages) {
    // isSyntheticTrigger 行渲染 null,不能成为可见 affordance 的目标(review P2)。
    if (m.role === 'user' && !m.isSyntheticTrigger) return m.clientId;
  }
  return null;
}

/**
 * edit-last-message: 全量消息列表里最后一条 user 消息的 clientId(无则 null)。
 * 只有它显示编辑入口——编辑 = rewind 到该条 + 重发,对更早的消息开放会连带
 * 丢弃后续轮次。导出为纯函数供单测直接断言。
 * (last 与 first 不同,不受向上分页影响——切片永远包含真实的尾部。)
 */
export function findLastUserMessageClientId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    // isSyntheticTrigger 行渲染 null:它成为"最后一条 user"会让真实最后一条
    // user 消息丢失编辑入口(review P2)——可见 affordance 只认可见行。
    if (messages[i].role === 'user' && !messages[i].isSyntheticTrigger) return messages[i].clientId;
  }
  return null;
}

/**
 * 最后一条「用户侧输入」的 clientId —— **含**合成行（自动续跑指令本身）。
 *
 * 与上面的 `findLastUserMessageClientId` 的区别就在这里：那份服务于「编辑最后一条消息」
 * 这个**可见** affordance，刻意跳过渲染成 null 的合成行；本份要回答的是「此刻正在跑的
 * 这个 turn 是不是自动续跑发起的」——合成行恰恰是那个 turn 的发起者，跳过就答不了。
 *
 * 用途：自愈重连行判断自己是不是"仍在飞"。用户在续跑之后又自己发了消息时，最后一条用户
 * 侧输入就换成他那条，旧的重连行随之停转（正在跑的已经是另一个 turn 了）。
 */
export function findLastUserInputClientId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    // **插话（`delivery === 'steer'`）不算新 turn 的发起者** —— 它是同一个正在跑的 turn 内
    // 的追加输入。算进来的话，用户在自愈 turn 里插一句，正在跑的重连行会立刻被"夺走归属"、
    // 提前停转退回静态（codex P2 / greptile P1）。本文件里其它 turn 边界判断（见上方
    // `hasFollowingUserTurn` 等）也都显式排除 steer，此处保持一致。
    //
    // 首选判据直接使用 main 投影的 vendor-turn owner；旧被控端缺省 owner 字段时，
    // 才由下面的兼容分支按最后一条非 steer 用户输入兜底。
    if (messages[i].role === 'user' && messages[i].delivery !== 'steer') {
      return messages[i].clientId;
    }
  }
  return null;
}

/**
 * 自愈落库行是否仍属于当前运行中的续跑 turn。
 *
 * 新端以 main 持有的 vendor-turn owner 做精确关联；只有 wire 上确实缺省 owner 字段的旧
 * 被控端才恢复历史启发式。旧端无法区分自动续跑与不落 user 行的 Goal turn，这是协议信息
 * 不足时的兼容降级，不能扩散到 supported / unknown 两种状态。
 */
export function isAutoResumeRowInFlight(args: {
  isContinuationTurnOwner: boolean;
  sessionRunning: boolean;
  isLastUserInput: boolean;
  projectionCapability: ContinuationInFlightProjectionCapability;
}): boolean {
  return (
    args.isContinuationTurnOwner ||
    (args.projectionCapability === 'legacy' && args.sessionRunning && args.isLastUserInput)
  );
}

export function shouldBlockAssistantFork(
  isSessionStreaming: boolean,
  message: ChatMessage,
  assistantsWithFollowingUserBoundary: ReadonlySet<string>,
): boolean {
  return (
    isSessionStreaming &&
    message.role === 'assistant' &&
    !assistantsWithFollowingUserBoundary.has(message.clientId)
  );
}

/**
 * 每个 user turn 的「收尾 assistant 正文」clientId 集合 —— action bar
 * (复制 / 分叉 / 时间 / 费用)只挂这些消息:任务执行过程中的中间正文不挂,
 * 避免每句话下面都占一行操作区(bar 即使 opacity-0 也占 24px 布局高度),
 * 保持消息流紧凑。产品口径:只有任务结束的最后一句话才出现这些操作。
 * turn 边界与 fork 口径一致(非 steer 的 user 消息);候选口径与
 * isAssistantAnswerCandidate 一致(普通 assistant 文本:非 systemCard、非空)。
 * 尾部 turn 是否"已结束"由调用方叠加 shouldBlockAssistantFork 判定,本函数
 * 只回答"是不是本 turn 最后一条正文"。export 仅供单测使用。
 */
function isCompletedAssistantMessage(message: ChatMessage): boolean {
  return (
    message.turnCompleted === true ||
    (message.turnMoney?.amount ?? 0) > 0 ||
    (typeof message.turnCostUsd === 'number' && message.turnCostUsd > 0) ||
    // turnUsageDetails 也只在 turn 结束时 patch(算不出报价的轮次只落它),
    // 与费用字段一样是等价的收尾信号 —— 少这一条,无金额轮就挂不出 action bar。
    message.turnUsageDetails !== undefined
  );
}

export function collectTurnFinalAssistantClientIds(messages: readonly ChatMessage[]): Set<string> {
  const out = new Set<string>();
  let sealedAnswerFound = false;
  let pendingLegacyFallback: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && message.delivery !== 'steer') {
      if (!sealedAnswerFound && pendingLegacyFallback) out.add(pendingLegacyFallback);
      sealedAnswerFound = false;
      pendingLegacyFallback = null;
      continue;
    }
    if (
      message.role !== 'assistant' ||
      message.systemCardType ||
      message.content.trim().length === 0
    ) {
      continue;
    }
    if (isCompletedAssistantMessage(message)) {
      out.add(message.clientId);
      sealedAnswerFound = true;
      pendingLegacyFallback = null;
      continue;
    }
    // 倒序扫描先暂存本 user turn 最后一条正文；只有整段没有 seal 时才采用。
    pendingLegacyFallback ??= message.clientId;
  }
  if (!sealedAnswerFound && pendingLegacyFallback) out.add(pendingLegacyFallback);
  return out;
}

/**
 * Build renderable items from the flat message array.
 *
 * Single linear pass. v2 — `isSessionStreaming` is no longer threaded into
 * tool_segment items because AgentActionsBlock + ThinkingCard now manage
 * their own per-block expand state via useExpandedBlockMemory (default
 * collapsed; user click → persisted).
 *
 * Agent plan handling:
 *   Plan tool calls (TodoWrite / update_plan / TaskCreate…) are swallowed
 *   entirely — same treatment as F7's AskUserQuestion / ExitPlanMode: the
 *   call and its tool_results produce no render item and do NOT cut the
 *   surrounding tool_segment. 计划的唯一呈现是 composer 上方的常驻面板
 *   (PinnedPlanPanel,Codex IDE 扩展式钉住交互),它直接从 messages 派生
 *   最新 plan session 快照,与本函数无关。
 */
/**
 * 锚点丢失恢复:DB 加载更老历史 prepend 时,若新拉回的末尾是 tool_use 且当前
 * 首段 render item 是 tool_segment,segment 会向前合并吸收这些 toolCall —— 原
 * `seg-${toolCalls[0].clientId}` 的 toolCalls[0] 变了,key 失效。直接 fallback
 * 到 slice(-INITIAL_ITEMS) 会让窗口跳回末尾 80 个,expandWindow 的
 * `currentStartIdx<=0` 早返也使 expand 永远 no-op,用户卡死。
 *
 * 恢复策略:从 lost key 反解 clientId(所有 key 形如 `${prefix}-${clientId}`),
 * 扫描 allRenderItems 找哪个 item **现在覆盖**这个 clientId:
 *   - message: msg.clientId 严格匹配
 *   - tool_segment: toolCalls.*.clientId 任一匹配(段合并后老 toolCall 仍在新段内)
 *   - tool_media / ghost_card: 用 key 后缀匹配(它们的 key 派生自 stable message clientId)
 *
 * 找到即返回该 index,visible slice 从这里继续;找不到才退回默认窗口。
 *
 * 注:此处不更新 firstVisibleItemKey state(避免在 useMemo 里触发 setState 的
 * React 警告)— 锚点状态保持 stale 没关系,下次 useMemo / expandWindow 会再
 * 走同样的 recover。每次扫描 O(n × m) 其中 m 是平均 toolCalls/segment,典型 n=200
 * 时几毫秒,可接受。
 */
function recoverLostAnchorIdx(items: RenderItem[], lostKey: string): number {
  const dashIdx = lostKey.indexOf('-');
  if (dashIdx < 0) return -1;
  const lostCid = lostKey.slice(dashIdx + 1);
  if (!lostCid) return -1;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'message') {
      if (it.message.clientId === lostCid) return i;
    } else if (it.type === 'tool_segment') {
      // segment 合并后,老的 toolCall 仍是新段内某条 toolCall
      if (it.toolCalls.some((tc) => tc.clientId === lostCid)) return i;
    } else if (it.type === 'agent_task') {
      if (it.toolCall?.clientId === lostCid) return i;
    } else if (it.type === 'work_group') {
      // work_group 可能嵌套完成态时间线 — 老锚点(`seg-${cid}` /
      // `msg-${cid}` / `work-${cid}`)递归落到任一后代即由外组接住。
      if (it.key === lostKey || it.key.endsWith(`-${lostCid}`)) return i;
      if (renderItemContainsClientId(it, lostCid)) return i;
    } else if (it.type !== 'fork_origin') {
      // tool_media / ghost_card:其 key 派生自 stable message clientId,精确后缀匹配
      if (it.key === lostKey || it.key.endsWith(`-${lostCid}`)) return i;
    }
  }
  return -1;
}

export function findRestorableViewportItemIdx(items: RenderItem[], viewportTopKey: string): number {
  const exactIdx = items.findIndex((it) => it.key === viewportTopKey);
  return exactIdx >= 0 ? exactIdx : recoverLostAnchorIdx(items, viewportTopKey);
}

/**
 * Whether a restored viewport anchor still belongs to the bounded default tail.
 * This is intentionally limited to the restore path; user-created anchored
 * windows remain unbounded until the separate bidirectional-window change.
 */
export function isViewportAnchorWithinDefaultTail(
  items: RenderItem[],
  viewportTopKey: string,
  windowSize = RENDER_WINDOW_INITIAL_ITEMS,
): boolean {
  const idx = findRestorableViewportItemIdx(items, viewportTopKey);
  return idx >= Math.max(0, items.length - windowSize);
}

/**
 * 从全量 render items 里按渲染顺序抽出会话内所有图片的 src,作为 lightbox 翻图
 * 的数据源(全量,不受渲染窗口裁剪影响)。只收**结构化、确定会渲染成图**的三类:
 *   - tool-output 图(art 出图 / 飞书拉图等)→ tool_media item 的 image 项
 *   - 用户上传图 → user message 的 images(url 或 data:base64,与 UserMessage 同款拼法)
 *   - 插件生成图 → ghost card 及其衍生卡中会打开 ImageLightbox 的图片
 *
 * 不收正文 Markdown 内嵌图:用正则扫文本会误抓代码块里当作文本展示的 ![]() 语法,
 * 虚增计数 / 让翻页跳到无效图(codex review);要准确得复刻 MarkdownRenderer 的
 * AST 渲染规则,成本高且易漂移。Markdown 内嵌图点开仍是单图预览,不进会话画廊。
 * 顺序与 DOM 渲染一致(用户消息里上传图在正文之前),便于 lightbox 做位置映射。
 */
export function collectSessionImageSrcs(
  items: RenderItem[],
  mediaOrigin?: RemoteMediaOrigin,
  ghostCards?: GhostCardSnapshot,
  isSessionStreaming = false,
): GalleryImage[] {
  // 远程会话:画廊 src 必须与渲染出的 <img data-gallery-src> 同样改写到 cindy-remote-media://,
  // 否则 ImageLightbox 的画廊 src 匹配对不上、退化成仅当前窗口翻图 + 计数错。
  const push = (url: string, meta?: Omit<GalleryImage, 'src'>): void =>
    void out.push({ src: rewriteToRemoteMediaOrigin(url, mediaOrigin), ...meta });
  const out: GalleryImage[] = [];
  const ghostCardSpawnIndex = ghostCards ? createGhostCardSpawnIndex(ghostCards) : undefined;
  for (const item of items) {
    if (item.type === 'fork_origin') {
      continue;
    } else if (item.type === 'tool_media') {
      for (const m of item.items) {
        if (m.kind === 'image' && m.url) push(m.url);
      }
    } else if (item.type === 'ghost_card') {
      if (ghostCards) {
        for (const image of collectGhostCardGalleryImages(
          item.callId,
          ghostCards,
          !item.settled && isSessionStreaming,
          ghostCardSpawnIndex!,
        )) {
          push(image.src, { galleryId: image.galleryId });
        }
      }
      // 回锚媒体渲染在卡片及其衍生卡之后，画廊顺序必须与 DOM 一致。
      for (const media of item.media ?? []) {
        if (media.kind === 'image' && media.url) push(media.url);
      }
    } else if (item.type === 'message') {
      const msg = item.message;
      if (msg.role === 'user' && msg.images) {
        for (const img of msg.images) {
          if ('url' in img) {
            // 标注元数据只在本地会话下发:远程会话里 annotationSourceUrl 指向
            // 被控端本机缓存,控制端拿不到原图,翻页保持普通烧录图预览(与
            // ChatImageView 直接点击分支的 displaySrc !== src 防御同口径)。
            const meta =
              !mediaOrigin && img.annotationSourceUrl && img.annotationStrokes?.length
                ? {
                    annotationSourceUrl: img.annotationSourceUrl,
                    annotationStrokes: img.annotationStrokes,
                  }
                : undefined;
            push(img.url, meta);
          } else {
            push(`data:${img.mimeType};base64,${img.base64}`);
          }
        }
      } else if (msg.role === 'assistant' && ghostCards) {
        // will-assistant-message 出口钩子的自绘卡以消息 clientId 为根 callId。
        for (const image of collectGhostCardGalleryImages(
          msg.clientId,
          ghostCards,
          false,
          ghostCardSpawnIndex!,
        )) {
          push(image.src, { galleryId: image.galleryId });
        }
      }
    }
  }
  return out;
}

// Workflow 工具(Claude Code SDK 多 agent 编排)在父会话事件流里 = 单个 local_workflow
// 任务(内部子 agent 不发独立 task 事件,只有 workflow 级聚合进度)。与 Agent/Task 一样
// 走 agent_task 渲染项;AgentTaskCard 内部按 taskType/toolName 识别为 workflow,展示
// workflowName + 聚合进度(status / tokens / 工具数 / 耗时)。
function isWorkflowToolName(toolName: string): boolean {
  return toolName === 'Workflow';
}

function findTaskUpdate(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  toolCall: ChatMessage,
): AgentTaskUpdate | undefined {
  if (!taskUpdates) return undefined;
  if (toolCall.toolUseId) {
    const byToolUseId = taskUpdates.get(toolCall.toolUseId);
    if (byToolUseId) return byToolUseId;
  }
  return taskUpdates.get(toolCall.clientId);
}

/**
 * subagent-model-chip: 构建 parentToolUseId(= 父 Agent/Task 工具调用的 toolUseId)
 * → 子代理模型 raw id 的映射。
 *
 * 数据来源:subagent 的每条子消息都带 `parentToolUseId`(SDK parent_tool_use_id,
 * 即派生它的 Agent 工具调用 id)+ `model`(子代理实际跑的模型)。first-writer-wins
 * 收敛 —— 同一子代理的所有子消息 model 相同,先到先得即可保持稳定。
 *
 * 必须喂全量 `messages`:子消息与 Agent 行常落在不同 render item / segment,
 * segment-local 扫不全。多个并发 Agent 调用天然各占一条 entry(各自 toolUseId)。
 *
 * 反查精确性:map 的 key 只可能是 Agent/Task 调用的 toolUseId(普通工具的
 * toolUseId 不会被任何子消息当作 parent),所以下游按 row.toolUseId 反查时,
 * 只有真正的 Agent/Task 行会命中。
 *
 * export 仅供单测使用,运行时无外部消费者。
 */
export function buildSubagentModelMap(messages: ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.parentToolUseId && m.model && !out.has(m.parentToolUseId)) {
      out.set(m.parentToolUseId, m.model);
    }
  }
  return out;
}

export function buildRenderItems(
  messages: ChatMessage[],
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>,
  ghostCards?: GhostCardSnapshot,
  opts?: {
    /**
     * 还有更老的历史页没加载(= `messages` 只是窗口、不是全量)。为真时,凡靠
     * 「父调用在不在 messages 里」做的归属判定都不可信,必须放宽而不是丢弃。
     */
    historyWindowIncomplete?: boolean;
    /** Main-persisted exact patches, anchored to their visible user message. */
    turnChangeSets?: readonly TurnChangeSetSummary[];
    /** Session working directory for opaque generated-file fallback chips. */
    workingDir?: string;
  },
): {
  items: RenderItem[];
  singleResultMap: Map<string, string>;
} {
  // ── Pass 0: build toolUseId → tool_result.content lookup ──
  // Plan/task rendering and regular tool result pairing both need a stable
  // lookup by vendor toolUseId. Adjacency remains a fallback in Pass 2.
  const resultByToolUseId = new Map<string, string>();
  // toolUseId → tool_result.createdAt(ms)。段的结束时间要算进 result,见
  // ToolSegmentRenderItem.resultTsMap 的注释。
  const resultTsByToolUseId = new Map<string, number>();
  // 卡槽③:已被某条 tool_result 认领的卡(xdt_card_id)——活卡锚定要跳过
  // 这些,防止 settle 后同一张卡又被别的 in-flight 行启发式抢走。
  const settledCardIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool_result' && typeof m.toolUseId === 'string' && m.toolUseId.length > 0) {
      resultByToolUseId.set(m.toolUseId, m.content);
      const resultMs = Date.parse(m.createdAt ?? '');
      if (Number.isFinite(resultMs)) resultTsByToolUseId.set(m.toolUseId, resultMs);
      const cardId = extractGhostCardId(m.content);
      if (cardId) settledCardIds.add(cardId);
    }
  }

  const isOrcaCommunicationTool = (toolName: string): boolean => {
    const normalized = toolName.replace(/^mcp__/, 'mcp:').replace(/__/g, ':');
    return (
      normalized === 'mcp:orca_worker_bridge:send_to_lead' ||
      normalized === 'mcp:orca_worker_bridge:read_lead' ||
      normalized === 'mcp:orca_worker_bridge:lead_status' ||
      toolName === 'send_to_lead' ||
      toolName === 'read_lead' ||
      toolName === 'lead_status'
    );
  };

  const isEmptyOrcaCommunicationResult = (content: string): boolean => {
    const trimmed = content.trim();
    if (!trimmed) return true;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      const hasUserFacingContent = ['message', 'result', 'text', 'content', 'error', 'detail'].some(
        (key) => typeof record[key] === 'string' && record[key].trim().length > 0,
      );
      if (hasUserFacingContent) return false;
      return record.ok === true;
    } catch {
      return false;
    }
  };

  const shouldHideToolResult = (toolName: string, content: string): boolean =>
    isOrcaCommunicationTool(toolName) && isEmptyOrcaCommunicationResult(content);

  // ── Pass 1.5: toolUseId lookup already built in Pass 0 ──
  // 为什么需要这一步: Pass 2 原本只按"tool_result 紧跟 tool_use"的 adjacency 配对
  // (见 while 循环)。但对 SDK 不发 tool_use_summary 的工具(如返回 image content
  // block 的 MCP),renderer 在 case 'done' 里自建 orphan
  // tool_result 并 append 到 messages 末尾,顺序上不再紧邻 tool_use → adjacency
  // 配不上。改用 toolUseId 直接查表(主路径),adjacency 只作为旧数据兜底
  // (toolUseId 字段缺失或老消息没存的情况)。

  // ── Pass 2: linear build ──
  const items: RenderItem[] = [];
  const renderedTaskKeys = new Set<string>();
  const singleResultMap = new Map<string, string>();
  let pendingToolCalls: ChatMessage[] = [];
  let pendingResultMap = new Map<string, string>();
  // 段内 tool_use clientId → tool_result.createdAt(ms),见 resultTsMap 注释。
  let pendingResultTsMap = new Map<string, number>();
  // 段内已见过的最晚**结束**时间(调用发起时刻与其 tool_result 时间取 max)。空洞判定用它,
  // 增量维护而不是每条调用重扫一遍 pendingToolCalls —— 工具密集的长 turn 里那是 O(n²)
  // (#676 review copilot)。flushSegment 时复位。
  let pendingSegmentEndMs: number | null = null;
  const notePendingSegmentEnd = (ms: number | null | undefined): void => {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return;
    pendingSegmentEndMs = pendingSegmentEndMs === null ? ms : Math.max(pendingSegmentEndMs, ms);
  };
  // 状态判定专用:tool_result 已到达的 tool_use(含被 shouldHideToolResult
  // 隐藏、不进 resultMap 的空结果)。
  let pendingSettledIds = new Set<string>();
  // tool-result-media: 累积当前 segment 内所有 tool_result 提取出的媒体 (image/video),
  // segment flush 时单独 push 一个 'tool_media' item,让媒体显示在 tool_segment 外面。
  let pendingSegmentMedia: ToolMediaItem[] = [];
  // 卡槽③:当前 segment 内累计的意识卡片(与 tool_media 同节奏 flush,
  // 每张卡各自锚定自己的 ghost_call clientId,不像媒体那样按段合并)。
  let pendingSegmentGhostCards: Extract<RenderItem, { type: 'ghost_card' }>[] = [];
  // 本次 build 内已被认领的活卡(claude 精确锚 / codex 启发式各认领一次)。
  const claimedLiveCallIds = new Set<string>();
  // 媒体回锚:本次 build 已上屏的 ghost_card item 按 callId 索引。后续调用的
  // tool_result 带 xdt_anchor_card_id 时按此把媒体挂回对应卡下方(item 是引用,
  // flush 进 items 后追加 media 仍然生效)。
  const ghostCardItemByCallId = new Map<string, Extract<RenderItem, { type: 'ghost_card' }>>();

  const flushSegment = () => {
    // 段内全部工具行都因供卡隐身时,段本体不渲染,卡片仍要落地。
    if (pendingToolCalls.length === 0) {
      for (const gc of pendingSegmentGhostCards) items.push(gc);
      pendingSegmentGhostCards = [];
      return;
    }
    // key 派生自 segment 首 toolCall clientId — 与历史 React `key=` (`seg-${...}`)
    // 同源,保证流式中新 tool_use 加入现有 segment 时 toolCalls[0] 不变 → key 稳定。
    const segmentKey = `seg-${pendingToolCalls[0].clientId}`;
    items.push({
      type: 'tool_segment',
      key: segmentKey,
      toolCalls: pendingToolCalls,
      resultMap: pendingResultMap,
      resultTsMap: pendingResultTsMap,
      settledIds: pendingSettledIds,
    });
    if (pendingSegmentMedia.length > 0) {
      // De-dup by url so multi-tool-call segments don't show same image twice.
      // Preserve insertion order so the order in chat matches tool-call order.
      const seen = new Set<string>();
      const dedup = pendingSegmentMedia.filter((m) => {
        if (seen.has(m.url)) return false;
        seen.add(m.url);
        return true;
      });
      // tool_media 跟其派生来源的 segment 共用首 toolCall id,只是 prefix 不同,
      // 保证两个 item 不撞 key,且都跟所属 segment 共生 / 同稳定性。
      items.push({
        type: 'tool_media',
        key: `media-${pendingToolCalls[0].clientId}`,
        items: dedup,
      });
    }
    // 意识卡片跟在媒体后(通常互斥:供卡的调用其媒体贡献已被抑制;同段
    // 其它工具的媒体仍在上面正常渲染)。
    for (const gc of pendingSegmentGhostCards) items.push(gc);
    pendingToolCalls = [];
    pendingResultMap = new Map<string, string>();
    pendingResultTsMap = new Map<string, number>();
    pendingSegmentEndMs = null;
    pendingSettledIds = new Set<string>();
    pendingSegmentMedia = [];
    pendingSegmentGhostCards = [];
  };

  let turnStartIdx = 0;
  const flushTurnChanges = (lo: number, hi: number): void => {
    if (hi <= lo) return;
    const anchorClientId = messages[lo]?.clientId;
    if (!anchorClientId) return;
    const changeSets = (opts?.turnChangeSets ?? []).filter(
      (changeSet) => changeSet.anchorClientId === anchorClientId,
    );
    const exactPaths = new Set<string>();
    const pathKey = (value: string): string => {
      const normalized = value.replace(/\\/g, '/');
      const windowsShape = /^[a-zA-Z]:[\\/]/.test(value) || value.includes('\\');
      return windowsShape ? normalized.toLowerCase() : normalized;
    };
    for (const changeSet of changeSets) {
      for (const file of changeSet.files) {
        exactPaths.add(pathKey(resolveToolFilePath(file.path, changeSet.cwd)));
        if (file.oldPath) exactPaths.add(pathKey(resolveToolFilePath(file.oldPath, changeSet.cwd)));
      }
    }
    for (const changeSet of changeSets) {
      // Zero-file entries have nothing the user can inspect or act on. Keep their
      // diagnostic sidecars in Main, but do not add a warning-only chat card.
      if (!hasReviewableTurnChanges(changeSet)) continue;
      items.push({
        type: 'turn_changes',
        key: `turnchanges-${changeSet.id}`,
        changeSet,
      });
    }
    const workingDir = opts?.workingDir ?? '';
    if (!workingDir || hi <= lo) return;
    const slice = messages.slice(lo, hi);
    const generatedFiles = collectGeneratedFiles(slice, workingDir).filter((file) => {
      const normalized = pathKey(file.path);
      return !exactPaths.has(normalized) || changeSets.length === 0;
    });
    if (generatedFiles.length === 0) return;
    let turnStartMs: number | null = null;
    for (const message of slice) {
      const timestamp = Date.parse(message.createdAt ?? '');
      if (Number.isFinite(timestamp) && (turnStartMs === null || timestamp < turnStartMs)) {
        turnStartMs = timestamp;
      }
    }
    const boundaryTimestamp = Date.parse(messages[hi]?.createdAt ?? '');
    items.push({
      type: 'generated_files',
      key: `genfiles-${messages[lo].clientId}`,
      files: generatedFiles,
      turnStartMs,
      turnEndMs: Number.isFinite(boundaryTimestamp) ? boundaryTimestamp : null,
    });
  };
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    // User turn boundary: attach the sealed patch after the turn it belongs to.
    if (msg.role === 'user' && msg.delivery !== 'steer' && !msg.isSyntheticTrigger) {
      flushSegment();
      flushTurnChanges(turnStartIdx, i);
      turnStartIdx = i;
    }

    // ask_user: pending lives in the bottom input overlay; expired/unanswered
    // questions have no user selection to show. Only the answered state surfaces
    // in the stream — rendered by AskUserQuestionBubble so the choice the user
    // made stays visible after the agent moves on.
    if (msg.role === 'ask_user' && msg.askUserStatus !== 'answered') {
      i++;
      continue;
    }

    if (msg.role === 'tool_use') {
      const toolName = msg.toolName ?? '';

      // F7: AskUserQuestion / ExitPlanMode are filtered out entirely. They
      // do NOT cut the current tool_segment — surrounding tools stay
      // grouped as if these calls never existed.
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool_result') j++;
        i = j;
        continue;
      }

      // Plan tools (TodoWrite / update_plan / Task*) — swallowed like F7:
      // 计划的唯一呈现是 composer 上方的 PinnedPlanPanel(钉住式常驻面板),
      // 流内不再插卡;也不切段,周围工具保持聚组,如同调用不存在。
      if (isAgentPlanToolName(toolName)) {
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool_result') j++;
        i = j;
        continue;
      }

      if (isAgentTaskToolName(toolName) || isWorkflowToolName(toolName)) {
        flushSegment();
        let result =
          typeof msg.toolUseId === 'string' && msg.toolUseId.length > 0
            ? resultByToolUseId.get(msg.toolUseId)
            : undefined;
        // 结束时间:主路径按 toolUseId 查,adjacency 兜底取相邻 tool_result 的最新时间。
        let resultTsMs =
          typeof msg.toolUseId === 'string' && msg.toolUseId.length > 0
            ? resultTsByToolUseId.get(msg.toolUseId)
            : undefined;
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool_result') {
          if (result === undefined && !shouldHideToolResult(toolName, messages[j].content)) {
            result = messages[j].content;
          }
          const adjacentTs = Date.parse(messages[j].createdAt ?? '');
          if (
            Number.isFinite(adjacentTs) &&
            (resultTsMs === undefined || adjacentTs > resultTsMs)
          ) {
            resultTsMs = adjacentTs;
          }
          j++;
        }
        const update = findTaskUpdate(taskUpdates, msg);
        if (msg.toolUseId) renderedTaskKeys.add(msg.toolUseId);
        if (update?.taskId) renderedTaskKeys.add(update.taskId);
        if (update?.parentToolUseId) renderedTaskKeys.add(update.parentToolUseId);
        items.push({
          type: 'agent_task',
          key: `task-${msg.clientId}`,
          toolCall: msg,
          update,
          ...(result !== undefined && !shouldHideToolResult(toolName, result) ? { result } : {}),
          ...(resultTsMs !== undefined ? { resultTsMs } : {}),
        });
        i = j;
        continue;
      }

      // ── 卡槽③:ghost_call 的卡片配对/锚定(先算,决定行/媒体去留)──
      // 卡片是这次调用的**唯一呈现**(2026-07-12 Lizi 定案:行与卡信息重复,
      // 合并进卡):配上卡的 ghost_call 不进 tool_segment(工具行隐身),
      // 原始调用参数由卡片头带展开区承担;同时抑制自己的媒体贡献。
      // settled:tool_result 顶层 xdt_card_id → 卡片库取卡;missing(远程
      // 会话/被 GC)完全回退今日渲染(行 + generic 媒体);loading/未知先
      // 藏行藏媒体(取件毫秒级落定,避免"行闪现再消失"跳变,规则 7)。
      // in-flight:活卡先按 toolUseId 精确锚(claude),再按同 ghostId 的
      // 最早未认领活卡启发式锚(codex);settle 后 xdt_card_id 自校正。
      let suppressMediaForCard = false;
      let hideRowForCard = false;
      const maybeQueueGhostCard = (result: string | undefined): void => {
        if (!ghostCards || !isGhostCallToolName(toolName)) return;
        const inp = (msg.toolInput ?? null) as Record<string, unknown> | null;
        const ghostIdFromInput = typeof inp?.ghost_id === 'string' ? inp.ghost_id : '';
        const toolFromInput = typeof inp?.tool === 'string' ? inp.tool : '';
        if (result !== undefined) {
          const cardId = extractGhostCardId(result);
          if (!cardId) return;
          const entry = ghostCards.byCallId.get(cardId);
          if (entry?.status === 'missing') return; // 降级 generic,行照旧
          suppressMediaForCard = true;
          hideRowForCard = true;
          if (entry?.status === 'ready') {
            const cardItem: Extract<RenderItem, { type: 'ghost_card' }> = {
              type: 'ghost_card',
              key: `ghostcard-${msg.clientId}`,
              callId: cardId,
              ghostId: ghostIdFromInput || entry.ghostId,
              tool: toolFromInput,
              toolCall: msg,
              settled: true,
              resultTsMs:
                typeof msg.toolUseId === 'string'
                  ? resultTsByToolUseId.get(msg.toolUseId)
                  : undefined,
            };
            pendingSegmentGhostCards.push(cardItem);
            ghostCardItemByCallId.set(cardId, cardItem);
          }
          return;
        }
        // in-flight:只认已 ready 的活卡(推送带 html 全量到,ready 是常态)。
        const live =
          ghostCards.liveCards.find(
            (lc) =>
              !claimedLiveCallIds.has(lc.callId) &&
              !settledCardIds.has(lc.callId) &&
              lc.toolUseId !== null &&
              typeof msg.toolUseId === 'string' &&
              lc.toolUseId === msg.toolUseId,
          ) ??
          (ghostIdFromInput
            ? ghostCards.liveCards.find(
                (lc) =>
                  !claimedLiveCallIds.has(lc.callId) &&
                  !settledCardIds.has(lc.callId) &&
                  lc.toolUseId === null &&
                  lc.ghostId === ghostIdFromInput,
              )
            : undefined);
        if (!live) return;
        if (ghostCards.byCallId.get(live.callId)?.status !== 'ready') return;
        claimedLiveCallIds.add(live.callId);
        hideRowForCard = true;
        const liveCardItem: Extract<RenderItem, { type: 'ghost_card' }> = {
          type: 'ghost_card',
          key: `ghostcard-${msg.clientId}`,
          callId: live.callId,
          ghostId: ghostIdFromInput || live.ghostId,
          tool: toolFromInput,
          toolCall: msg,
          settled: false,
        };
        pendingSegmentGhostCards.push(liveCardItem);
        ghostCardItemByCallId.set(live.callId, liveCardItem);
      };
      // 媒体收集:结果带 xdt_anchor_card_id(ghost_call 的"提交开卡 → 轮询出
      // 媒体"跨调用任务)且锚到的是**同一意识**已上屏的卡时,把媒体挂到那张卡
      // item 的 media 上(卡正下方渲染,替换"生成中"占位);锚不上(卡 missing/
      // 提交消息被 rewind/异 ghost 伪锚)回退今日行为——本调用位置渲染。
      const collectResultMedia = (result: string): void => {
        let media = extractToolResultMedia(result);
        if (media.length === 0) return;
        if (isGhostCallToolName(toolName)) {
          const anchor = extractAnchorCardId(result);
          const inp = (msg.toolInput ?? null) as Record<string, unknown> | null;
          const ghostIdFromInput = typeof inp?.ghost_id === 'string' ? inp.ghost_id : '';
          const target = anchor ? ghostCardItemByCallId.get(anchor) : undefined;
          const sameGhostTarget =
            target && ghostIdFromInput && target.ghostId === ghostIdFromInput ? target : undefined;
          // 音频入卡令牌(audioInCard)= 意识的**待验证声明**:锚到的同意识卡
          // 确实 ready 且 html 真含对应 data-ghost-audio 插槽(播放器已由卡内
          // 受信桥渲染)才压掉基座音频卡,防同一首歌双播放器;验证不过(远程
          // 控制端无卡、card-update 被静默拒、老历史)保留基座渲染,音频永不
          // 消失。URL 在净化器输出里是 escapeAttr 原样(cindy-media 地址无需
          // 转义字符),字面量包含判定成立。
          if (media.some((m) => m.audioInCard || m.imageInCard)) {
            const anchorEntry = anchor ? ghostCards?.byCallId.get(anchor) : undefined;
            const cardHtml =
              sameGhostTarget && anchorEntry?.status === 'ready' ? anchorEntry.html : '';
            media = media.filter(
              (m) =>
                !(
                  m.kind === 'audio' &&
                  m.audioInCard &&
                  cardHtml.includes(`data-ghost-audio="${m.url}"`)
                ) &&
                // 图片入卡令牌同款验证:锚到的同意识卡 html 真含该图片地址
                // (卡内 <img src> 就是 cindy-media 地址原文)才压基座。
                !(m.kind === 'image' && m.imageInCard && cardHtml.includes(m.url)),
            );
            if (media.length === 0) return;
          }
          if (sameGhostTarget) {
            // 同 URL 去重(重复轮询同一 completed 任务会再次带回同一指纹地址)。
            const seen = new Set((sameGhostTarget.media ?? []).map((x) => x.url));
            const fresh = media.filter((x) => !seen.has(x.url));
            if (fresh.length > 0)
              sameGhostTarget.media = [...(sameGhostTarget.media ?? []), ...fresh];
            return;
          }
        }
        pendingSegmentMedia.push(...media);
      };
      // 主路径: 按 toolUseId 直接查 orphan/正常 tool_result 内容,不依赖位置
      const mainResult =
        typeof msg.toolUseId === 'string' && msg.toolUseId.length > 0
          ? resultByToolUseId.get(msg.toolUseId)
          : undefined;
      maybeQueueGhostCard(mainResult);

      // Regular tool_use — accumulate(配上卡的 ghost_call 不进段,行隐身)。
      if (!hideRowForCard) {
        // 历史窗口空洞可能正好落在两次工具调用之间(缺的是 user 行):那样两个窗口的
        // tool call 会被合进同一个 tool_segment,段首尾时间差直接成了跨空洞的假时长,
        // 而 groupWorkRuns 的空洞守卫只看段首时间、发现不了段内部的跳变。所以在段内
        // 也按同一阈值切开,让「已工作 Xs」的时长和分组都落在真实连续的动作上。
        //
        // 锚点是 pendingSegmentEndMs —— 段内所有调用结束时间的**最大值**,不能只看紧邻的
        // 上一条:并行工具会乱序完成(A 跑 40 分钟还没回,B 紧随其后一分钟就结束,这时又发起
        // C),只比 B 的早结束时间会把 C 误判成空洞、把一段连续工作切碎,段产物(tool_media)
        // 也跟着挪到错误的边界上(#676 review codex P1)。groupWorkRuns 的 prevEndMs 早就是
        // 单调取 max 的,这里补齐同一口径。
        if (pendingToolCalls.length > 0) {
          const currentCallMs = messageTs(msg);
          if (
            pendingSegmentEndMs !== null &&
            currentCallMs !== null &&
            currentCallMs - pendingSegmentEndMs > HISTORY_GAP_SPLIT_MS
          ) {
            flushSegment();
          }
        }
        pendingToolCalls.push(msg);
        notePendingSegmentEnd(messageTs(msg));
        if (mainResult !== undefined) {
          // result 到了就算 settled,即便内容被隐藏不进 resultMap。
          pendingSettledIds.add(msg.clientId);
          // 时间戳与内容是否被隐藏无关:段的结束时间靠它算(见 resultTsMap 注释)。
          const resultTs =
            typeof msg.toolUseId === 'string' ? resultTsByToolUseId.get(msg.toolUseId) : undefined;
          if (resultTs !== undefined) {
            pendingResultTsMap.set(msg.clientId, resultTs);
            notePendingSegmentEnd(resultTs);
          }
        }
        if (mainResult !== undefined && !shouldHideToolResult(toolName, mainResult)) {
          pendingResultMap.set(msg.clientId, mainResult);
          // 同时把 result 里嵌的媒体 URL (image/video) 累积起来,segment flush
          // 时作为独立 'tool_media' item 渲染到 chat 流上(脱离 tool_segment 折叠)。
          // 供卡的调用抑制自己的媒体贡献(卡片替换 generic 图卡)。
          if (!suppressMediaForCard) {
            collectResultMedia(mainResult);
          }
        }
      }
      // Adjacency 兜底: 旧数据 toolUseId 缺失时,沿用原有"tool_result 紧跟"配对。
      // 即便主路径已命中(或行隐身),这里也跳过相邻 tool_result,免得它们被
      // 当 orphan 重渲染。
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool_result') {
        if (!hideRowForCard) {
          pendingSettledIds.add(msg.clientId);
          // adjacency 配对同样要留下 result 时间戳(段结束时间用)。
          const adjacencyTs = Date.parse(messages[j].createdAt ?? '');
          if (Number.isFinite(adjacencyTs)) {
            notePendingSegmentEnd(adjacencyTs);
            const known = pendingResultTsMap.get(msg.clientId);
            if (known === undefined || adjacencyTs > known) {
              pendingResultTsMap.set(msg.clientId, adjacencyTs);
            }
          }
          // 主路径没命中时才用 adjacency 覆盖(后到 last wins,保留原行为)
          const result = messages[j].content;
          if (!pendingResultMap.has(msg.clientId) && !shouldHideToolResult(toolName, result)) {
            pendingResultMap.set(msg.clientId, result);
            if (!suppressMediaForCard) {
              collectResultMedia(result);
            }
          }
        }
        j++;
      }

      i = j;
    } else if (msg.role === 'tool_result') {
      // Orphan tool_result — skip
      i++;
    } else {
      // Any non-tool message flushes the pending segment first so tool
      // segments appear above their text result, not after it.
      flushSegment();
      items.push({ type: 'message', key: `msg-${msg.clientId}`, message: msg });
      i++;
    }
  }

  // Flush trailing segment — important for streaming, where the turn often
  // ends mid-segment (no closing text yet).
  flushSegment();
  // 末尾 turn 的产出文件卡(没有后续 user 边界触发)。
  flushTurnChanges(turnStartIdx, messages.length);

  if (taskUpdates) {
    // 父会话自己的 Bash 调用集合:local_bash 任务卡(#247 的「后台命令」卡,含
    // 停止按钮)的**唯一**渲染来源就是本孤儿循环(Bash toolCall 走 tool_segment,
    // 不进 agent_task 配对分支),必须按 parentToolUseId 命中保留;命不中的才是
    // workflow / 子 agent 内部启动的后台命令 —— 只进后台任务面板,不进聊天流刷屏
    // (对齐官方:聊天流只呈现父会话自己的调用)。
    //
    // 归属只能靠「父 Bash 调用在不在 messages 里」判定(AgentTaskUpdate 没有
    // 结构化的「谁 spawn 的」字段),而 messages 是分页窗口(首屏 50 行)。窗口
    // 不完整时父调用可能只是还没翻到,此时**不丢**:宁可临时多显示 workflow 内部
    // 的后台命令卡(本 PR 之前就是这个形态),也不能把用户自己还在跑的后台命令
    // 及其停止按钮从聊天流里抹掉。翻到旧页 / 加载完历史后过滤自动恢复。
    const historyWindowIncomplete = opts?.historyWindowIncomplete === true;
    const parentBashToolUseIds = new Set<string>();
    for (const m of messages) {
      if (
        m.role === 'tool_use' &&
        m.toolName === 'Bash' &&
        typeof m.toolUseId === 'string' &&
        m.toolUseId.length > 0
      ) {
        parentBashToolUseIds.add(m.toolUseId);
      }
    }
    const seenTaskIds = new Set<string>();
    for (const update of taskUpdates.values()) {
      if (
        update.taskType === 'local_bash' &&
        !historyWindowIncomplete &&
        !(update.parentToolUseId && parentBashToolUseIds.has(update.parentToolUseId))
      ) {
        continue;
      }
      const primaryKey = update.parentToolUseId ?? update.taskId;
      if (
        seenTaskIds.has(update.taskId) ||
        renderedTaskKeys.has(primaryKey) ||
        renderedTaskKeys.has(update.taskId)
      ) {
        continue;
      }
      seenTaskIds.add(update.taskId);
      const item: AgentTaskRenderItem = {
        type: 'agent_task',
        key: `task-update-${primaryKey}`,
        update,
      };
      const itemMs = renderItemStartMs(item);
      if (itemMs === null) {
        items.push(item);
        continue;
      }
      const insertAt = items.findIndex((candidate) => {
        const candidateMs = renderItemStartMs(candidate);
        return candidateMs !== null && candidateMs > itemMs;
      });
      if (insertAt < 0) items.push(item);
      else items.splice(insertAt, 0, item);
    }
  }

  return { items, singleResultMap };
}

// ---------------------------------------------------------------------------
// Work-group pass(buildRenderItems 之后的第二层后处理)
// ---------------------------------------------------------------------------

/** 完成态 work_group 可合并的子项:tool_segment / agent_task / thinking /
 *  assistant 工作文字。运行态只通过 isWorkActivityItem 收动作,所以不会提前
 *  折叠正在输出的 assistant 文字。 */
function isWorkChild(it: RenderItem): it is WorkChildItem {
  return (
    it.type === 'tool_segment' ||
    it.type === 'agent_task' ||
    (it.type === 'message' &&
      (it.message.role === 'thinking' ||
        (it.message.role === 'assistant' && !it.message.systemCardType)))
  );
}

/** 运行中(未到终态)的子 Agent 卡片 —— 折叠时视为"可见锚点",绝不折进
 *  「已工作 Xs」工作组:任务没完成就归档会谎报终态时长(典型:后台 workflow
 *  子 Agent 仍在跑,父 turn 却已产出最终正文)。status 派生口径与 AgentTaskCard
 *  完全一致:配对的最终 result 会把 stale running 收敛为 completed,但不覆盖
 *  failed/stopped 等明确终态,
 *  保证"卡片显示运行中"与"是否折叠"永远同步。 */
// A paired final result closes a stale running update; this must match AgentTaskCard.
function isRunningAgentTask(it: RenderItem): boolean {
  if (it.type !== 'agent_task') return false;
  const status = deriveAgentTaskStatus(it.update?.status, it.result, {
    resultIsLaunchReceipt:
      subagentSpawnReceiptName(it.toolCall?.toolName, it.toolCall?.toolInput, it.result) !== undefined
      || subagentSpawnResultIndicatesRunning(it.toolCall?.toolName, it.result),
  });
  return status === 'running';
}

/** workflow 卡永远平铺,完成后也不折进工作组:它是后台任务面板的常驻入口,
 *  折叠掉等于把入口藏起来(产品拍板 2026-07-27:完成后保留痕迹、可点击进
 *  面板详情;对齐官方——原版完成的 workflow 行留在对话里)。 */
function isWorkflowTaskItem(it: RenderItem): boolean {
  return (
    it.type === 'agent_task' &&
    (it.update?.taskType === 'local_workflow' || it.toolCall?.toolName === 'Workflow')
  );
}

/** preview 中计为一条真实活动的 render item。assistant 进度文字
 *  始终留在主消息流,不占最近 5 条活动窗口。 */
function isWorkActivityItem(it: RenderItem): it is WorkChildItem {
  return (
    !isRunningAgentTask(it) &&
    // workflow 卡三条分组路径(answered/legacy/active)统一平铺,见 isWorkflowTaskItem。
    !isWorkflowTaskItem(it) &&
    (it.type === 'tool_segment' ||
      it.type === 'agent_task' ||
      (it.type === 'message' && it.message.role === 'thinking'))
  );
}

/**
 * 交付正文 item —— 无论落在 turn 的哪个位置都不折进「已工作 Xs」。
 *
 * 为什么只靠 seal 位置不够:「最终答复」只认最后一次动作之后的正文,而 agent
 * 常见「先输出正文 → 再执行一个收尾副作用(发通知 / 落库 / 提交) → 再说一句
 * 已完成」。这时真正的交付内容排在收尾动作之前,会被整段折起来,只剩收尾那句
 * 元数据留在消息流里(实例:2026-07-31 定时巡检的产品决策简报 3250 字被折,
 * 外面只剩 110 字的「已触发通知」)。
 *
 * 判据(长度 / 块级 markdown 结构)由 maker-shared 的 isDeliveryProseText 单一
 * 提供,两端不各写一份。
 */
function isDeliveryProseItem(it: RenderItem): boolean {
  return (
    it.type === 'message' &&
    it.message.role === 'assistant' &&
    !it.message.systemCardType &&
    isDeliveryProseText(it.message.content)
  );
}

/** 最终可见正文候选:同一用户 turn 内最后一条普通 assistant 文本。 */
function isAssistantAnswerCandidate(it: RenderItem): it is MessageRenderItem {
  return (
    it.type === 'message' &&
    it.message.role === 'assistant' &&
    !it.message.systemCardType &&
    it.message.content.trim().length > 0
  );
}

/** 自动压缩会开始新的 live 工作片段，因此也必须结束压缩前的动作组。 */
function isCompactBoundaryItem(it: RenderItem): it is MessageRenderItem {
  return (
    it.type === 'message' &&
    it.message.role === 'assistant' &&
    it.message.systemCardType === 'compact'
  );
}

/** 子项的稳定 clientId(group key 派生用)。 */
function workChildClientId(it: WorkChildItem): string {
  if (it.type === 'tool_segment') return it.toolCalls[0].clientId;
  if (it.type === 'agent_task') {
    return (
      it.toolCall?.clientId ??
      it.update?.parentToolUseId ??
      it.update?.taskId ??
      (it.key.startsWith('task-update-') ? it.key.slice('task-update-'.length) : it.key)
    );
  }
  return it.message.clientId;
}

/** group 的身份锚在首个真实活动(tool / thinking / agent task)。
 *  完成后的合并组沿用第一段的锚点,保持该段的手动展开态。 */
function workGroupClientId(run: WorkChildItem[]): string {
  const firstActivity = run.find((it) => it.type !== 'message' || it.message.role === 'thinking');
  return workChildClientId(firstActivity ?? run[0]);
}

/** 工作组内全部可定位 clientId(嵌套组递归),供组容器的回退锚点使用。 */
function collectWorkGroupClientIds(children: readonly RenderItem[]): string[] {
  const ids: string[] = [];
  for (const child of children) {
    if (child.type === 'message') ids.push(child.message.clientId);
    else if (child.type === 'tool_segment') {
      for (const toolCall of child.toolCalls) ids.push(toolCall.clientId);
    } else if (child.type === 'agent_task' && child.toolCall) {
      ids.push(child.toolCall.clientId);
    } else if (child.type === 'work_group') {
      ids.push(...collectWorkGroupClientIds(child.children));
    }
  }
  return ids;
}

function renderItemContainsClientId(item: RenderItem, clientId: string): boolean {
  if (item.type === 'fork_origin') return false;
  if (item.type === 'message') return item.message.clientId === clientId;
  if (item.type === 'tool_segment')
    return item.toolCalls.some((toolCall) => toolCall.clientId === clientId);
  if (item.type === 'agent_task') return item.toolCall?.clientId === clientId;
  if (item.type === 'work_group') {
    return item.children.some((child) => renderItemContainsClientId(child, clientId));
  }
  return item.key.endsWith(`-${clientId}`);
}

function renderItemStartMs(item: RenderItem): number | null {
  if (item.type === 'message') {
    const ms = Date.parse(item.message.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'tool_segment') {
    const ms = Date.parse(item.toolCalls[0]?.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'agent_task') {
    const ms = Date.parse(item.toolCall?.createdAt ?? item.update?.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  // ghost_card 是那次调用在流里的**唯一**呈现(工具行被卡片取代),所以它必须
  // 报出调用时间。漏掉的后果是间隔判定把它当"无时间戳"跳过:空洞后的第一个
  // 动作恰好是卡片时切不开,卡片还会被归到空洞前那一组里(#676 review)。
  if (item.type === 'ghost_card') {
    const ms = Date.parse(item.toolCall.createdAt ?? '');
    return Number.isFinite(ms) ? ms : null;
  }
  if (item.type === 'work_group') {
    for (const child of item.children) {
      const childMs = renderItemStartMs(child);
      if (childMs !== null) return childMs;
    }
  }
  // 剩下两类**故意**不报时间,不是漏:
  //  - tool_media:段产物,永远紧跟在派生它的 tool_segment 之后(见 flushSegment),
  //    锚点留在段末正是它自己的时间区间,单独给它一个时间戳没有意义。
  //  - fork_origin:分叉标记,不是动作,不该参与间隔判定。
  return null;
}

/**
 * item 的结束时间戳 —— 空洞判定必须用它,不能用 start。
 *
 * 一个合法连续 turn 里的 tool_segment 本身可能跨半小时以上(段内每次相邻调用都在
 * 阈值内,所以不会被切段)。若拿下一条 item 的 start 去跟这个段的 **start** 比,
 * 差值就等于整段耗时,会把正常长任务误判成历史空洞:该切的没切,不该切的切了,
 * 前面的 assistant 进度文字被留在工作组外,时长也退化成段兜底而非最终答复。
 *
 * 段的结束必须算进 tool_result:单次工具跑半小时以上时(典型:一次长构建 / CI),
 * 段里只有一个 tool_use,它的 createdAt 是"开始执行"的时刻,拿它当段末会把结束
 * 时间低估整个执行时长,紧随其后的最终答复照样被误判成空洞。
 */
function renderItemEndMs(item: RenderItem): number | null {
  if (item.type === 'tool_segment') {
    let latest = Number.NEGATIVE_INFINITY;
    for (const call of item.toolCalls) {
      const callMs = Date.parse(call.createdAt ?? '');
      if (Number.isFinite(callMs)) latest = Math.max(latest, callMs);
      const resultMs = item.resultTsMap.get(call.clientId);
      if (resultMs !== undefined) latest = Math.max(latest, resultMs);
    }
    return Number.isFinite(latest) ? latest : renderItemStartMs(item);
  }
  if (item.type === 'agent_task') {
    // fallback 顺序:updatedAt → update.createdAt → toolCall.createdAt。
    // AgentTaskUpdate 可以只有 createdAt 而没有 updatedAt(见 normalizeAgentTaskUpdate),
    // 那时 update.createdAt 比调用发起时刻更接近任务结束 —— 先取 toolCall.createdAt 会
    // 低估结束时间,进而误判空洞、低报工作组时长(#676 review)。
    const ms = Date.parse(
      item.update?.updatedAt ?? item.update?.createdAt ?? item.toolCall?.createdAt ?? '',
    );
    const liveEnd = Number.isFinite(ms) ? ms : renderItemStartMs(item);
    // 历史会话没有 live update 时,liveEnd 退化成调用的开始时间;result 时间戳才是
    // 这张卡真正的结束(与 tool_segment 同口径)。两者取更晚的。
    if (item.resultTsMs === undefined) return liveEnd;
    return liveEnd === null ? item.resultTsMs : Math.max(liveEnd, item.resultTsMs);
  }
  if (item.type === 'ghost_card') {
    const startMs = renderItemStartMs(item);
    if (item.resultTsMs === undefined) return startMs;
    return startMs === null ? item.resultTsMs : Math.max(startMs, item.resultTsMs);
  }
  if (item.type === 'work_group') {
    // 全量取 max,不是"最后一个 child":children 按**发起**时刻排列,并行的 Agent/Task 乱序完成时
    // 真正的结束时刻可能落在更靠前的 child 上(先发起、更晚 settle)。取最后一个会低估组的结束
    // 时间,于是空洞判定的锚点变小、把本来连续的 turn 误判成空洞切开 —— 与本函数 tool_segment
    // 分支、以及 groupWorkRuns 里 prevEndMs 的 Math.max 是同一条理由(#676 review codex P1)。
    // 手机端同款函数(maker-shared 的 itemEndTimestamp)已按此收敛,#1210 review 指出这里镜像存在。
    let latest: number | null = null;
    for (const child of item.children) {
      const childMs = renderItemEndMs(child);
      if (childMs === null) continue;
      latest = latest === null ? childMs : Math.max(latest, childMs);
    }
    return latest;
  }
  // thinking 的 createdAt 是块**开始**的时刻,真正结束要加 thinkingDurationMs
  // (与 workRunEndTs 同口径)。一个想了半小时以上的 thinking 块后面紧跟工具或正文时,
  // 只看 createdAt 会把它误判成历史空洞、切开一个本来连续的 turn。
  const startMs = renderItemStartMs(item);
  if (startMs !== null && item.type === 'message' && item.message.role === 'thinking') {
    // duration 与 mapServerCreatedAt 同口径夹断:该字段可能是负数 / 非有限值(那边就做了
    // Math.max(0, …) 的防御)。不夹断会得出 end < start,空洞判定与工作组时长都跟着错
    // (#676 review copilot)。
    const durationMs = item.message.thinkingDurationMs;
    const safeDurationMs =
      typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    return startMs + safeDurationMs;
  }
  return startMs;
}

export function insertForkOriginItem(
  items: RenderItem[],
  forkOrigin: MessageStreamProps['forkOrigin'],
): RenderItem[] {
  if (!forkOrigin) return items;
  const marker: ForkOriginRenderItem = {
    type: 'fork_origin',
    key: `fork-origin-${forkOrigin.parentSessionId}-${forkOrigin.forkedAtMessageId}`,
    parentSessionId: forkOrigin.parentSessionId,
    forkedAtMessageId: forkOrigin.forkedAtMessageId,
  };
  const forkCreatedMs = Date.parse(forkOrigin.forkedSessionCreatedAt);
  if (Number.isNaN(forkCreatedMs)) return items;

  let hasLoadedItemBeforeFork = false;
  const insertAt = items.findIndex((item) => {
    const itemMs = renderItemStartMs(item);
    if (itemMs !== null && itemMs < forkCreatedMs) {
      hasLoadedItemBeforeFork = true;
      return false;
    }
    return itemMs !== null && itemMs >= forkCreatedMs;
  });
  if (!hasLoadedItemBeforeFork || insertAt < 0) return items;
  return [...items.slice(0, insertAt), marker, ...items.slice(insertAt)];
}

function renderItemKeyForClientId(items: readonly RenderItem[], clientId: string): string | null {
  const item = items.find((candidate) => renderItemContainsClientId(candidate, clientId));
  return item?.key ?? null;
}

/** 消息 createdAt → epoch ms,缺失 / 非法返回 null。 */
function messageTs(msg: ChatMessage): number | null {
  if (!msg.createdAt) return null;
  const t = new Date(msg.createdAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 边界项(用户消息 / assistant 正文)的时间戳;非 message 项(卡片等)返回 null,
 *  让下一段退回段内锚点,避免把已折叠段的时长重复计入。 */
function boundaryTs(item: RenderItem | undefined): number | null {
  return item && item.type === 'message' ? messageTs(item.message) : null;
}

/** run 首子项的起始时间戳。 */
function workRunStartTs(it: WorkChildItem): number | null {
  if (it.type === 'tool_segment') return messageTs(it.toolCalls[0]);
  if (it.type === 'agent_task') return renderItemStartMs(it);
  return messageTs(it.message);
}

/**
 * run 末子项的结束时间戳 —— 直接复用 renderItemEndMs,不再自己算一份。
 *
 * 原来这里另算一份:tool_segment 取**最后一次调用的发起时刻**、agent_task 取
 * `updatedAt ?? toolCall.createdAt`,两者都不看 tool_result 时间。于是"一个跑了 40 分钟的
 * 工具 / Task 之后紧跟一段历史空洞、后面没有 assistant 正文"时,createWorkGroup 拿不到
 * nextItem、回落到这里,时长显示成约 0s —— 而 renderItemEndMs 明明已经算得出真正的结束
 * 时间(#676 review codex P1)。两处口径合一,顺带修掉 agent_task 那个把
 * `toolCall.createdAt` 排在 `update.createdAt` 前面的旧 fallback 顺序。
 */
function workRunEndTs(it: WorkChildItem): number | null {
  return renderItemEndMs(it);
}

/**
 * 没有终结正文可用时,run 的结束时间 = **所有子项结束时间的最大值**。
 *
 * 不能"从后往前找第一个有时间的子项就返回":并行的 Agent/Task 会乱序完成(A 跑到 40 分钟,
 * B 紧随其后 2 分钟就结束),末尾那张卡的结束时间可能远早于整段真正的结束。被空洞收尾的组
 * 正好走这条 fallback(没有 nextItem),于是 40 分钟的工作显示成约 2 分钟 —— 而空洞判定那边
 * 用的已经是正确的最大值(#676 review codex P1)。
 */
function workRunFallbackEndTs(run: WorkChildItem[]): number | null {
  let latest: number | null = null;
  for (const item of run) {
    const ts = workRunEndTs(item);
    if (ts === null) continue;
    latest = latest === null ? ts : Math.max(latest, ts);
  }
  return latest;
}

function createWorkGroup(
  run: WorkChildItem[],
  nextItem: RenderItem | undefined,
  isStreaming = false,
  prevBoundaryTs: number | null = null,
): Extract<RenderItem, { type: 'work_group' }> {
  const firstActivity = run.find((it) => it.type !== 'message' || it.message.role === 'thinking');
  const anchorTs = workRunStartTs(firstActivity ?? run[0]);
  // 段起点优先锚上一个边界(用户消息 / 上一句正文),与「正在工作…」活表的墙钟
  // 口径一致:一次性到达的 thinking 块 createdAt≈结束时刻,只用段内锚点会把
  // 模型思考整段丢掉(实际 6s 显示 1s,内层相加也对不上外层总表)。边界缺失
  // (窗口截断)或时序异常(rewind 改序)时退回段内锚点。
  const startTs =
    prevBoundaryTs !== null && (anchorTs === null || prevBoundaryTs <= anchorTs)
      ? prevBoundaryTs
      : anchorTs;
  const endTs =
    nextItem && nextItem.type === 'message'
      ? messageTs(nextItem.message)
      : workRunFallbackEndTs(run);
  const durationMs =
    startTs !== null && endTs !== null && endTs >= startTs ? endTs - startTs : undefined;
  return {
    type: 'work_group',
    key: `work-${workGroupClientId(run)}`,
    children: run,
    durationMs,
    isStreaming,
    ...(startTs !== null ? { startedAtMs: startTs } : {}),
  };
}

/** 完成态时间线:assistant 工作文字直接成为外组子项,文字之间的连续动作
 *  继续复用 createWorkGroup 生成内层「已工作 Xs」。外组使用独立 key,
 *  避免与第一段动作共享展开记忆;内组 key 保持不变,从运行中到完成后连续。 */
function createCompletedWorkGroup(
  run: WorkChildItem[],
  nextItem: RenderItem | undefined,
  prevBoundaryTs: number | null = null,
): WorkGroupRenderItem {
  const hasAssistantText = run.some(
    (item) => item.type === 'message' && item.message.role === 'assistant',
  );
  if (!hasAssistantText) return createWorkGroup(run, nextItem, false, prevBoundaryTs);

  const children: WorkGroupChildItem[] = [];
  let activityRun: WorkChildItem[] = [];
  let innerPrevBoundaryTs = prevBoundaryTs;
  const flushActivityRun = (activityNextItem: RenderItem | undefined) => {
    if (activityRun.length === 0) return;
    children.push(createWorkGroup(activityRun, activityNextItem, false, innerPrevBoundaryTs));
    activityRun = [];
  };

  for (const item of run) {
    if (isWorkActivityItem(item)) {
      activityRun.push(item);
      continue;
    }
    flushActivityRun(item);
    children.push(item);
    innerPrevBoundaryTs = boundaryTs(item);
  }
  flushActivityRun(nextItem);

  const outer = createWorkGroup(run, nextItem, false, prevBoundaryTs);
  return {
    ...outer,
    key: `work-summary-${workGroupClientId(run)}`,
    children,
    isStreaming: false,
  };
}

function groupLegacyWorkRuns(items: RenderItem[], turnStartTs: number | null = null): RenderItem[] {
  const out: RenderItem[] = [];
  let run: WorkChildItem[] = [];
  let prevBoundaryTs = turnStartTs;

  const flushRun = (nextItem: RenderItem | undefined) => {
    if (run.length === 0) return;
    out.push(createWorkGroup(run, nextItem, false, prevBoundaryTs));
    run = [];
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // 运行中的子 Agent 不算可折叠 child —— 触发 flushRun 折掉它之前的 run,
    // 自身平铺,不被卷入「已工作 Xs」(见 isRunningAgentTask)。
    if (isWorkActivityItem(it)) {
      run.push(it);
    } else {
      flushRun(it);
      out.push(it);
      prevBoundaryTs = boundaryTs(it);
    }
  }
  flushRun(undefined);
  return out;
}

/** Active turn 专用分组:
 *  - assistant 文字始终作为普通 message 留在主消息流;
 *  - assistant 文字和自动压缩卡片是动作组的分段边界:边界一出现,
 *    前一段立即变为已完成;
 *  - 最后一段之后还没有新的边界时,该段才标成 streaming,
 *    默认显示 latest-five preview。
 */
function groupActiveWorkRuns(items: RenderItem[], turnStartTs: number | null = null): RenderItem[] {
  let lastCompletedRunBoundaryIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (isAssistantAnswerCandidate(items[i]) || isCompactBoundaryItem(items[i])) {
      lastCompletedRunBoundaryIdx = i;
    }
  }

  const out: RenderItem[] = [];
  let run: WorkChildItem[] = [];
  let runLastIdx = -1;
  let prevBoundaryTs = turnStartTs;
  const flushRun = (nextItem: RenderItem | undefined) => {
    if (run.length === 0) return;
    out.push(
      createWorkGroup(run, nextItem, runLastIdx > lastCompletedRunBoundaryIdx, prevBoundaryTs),
    );
    run = [];
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isWorkActivityItem(it)) {
      run.push(it);
      runLastIdx = i;
    } else {
      flushRun(it);
      out.push(it);
      prevBoundaryTs = boundaryTs(it);
    }
  }
  flushRun(undefined);
  return out;
}

/**
 * 已结束的 turn:最终答复阶段之前的 assistant 工作文字收入外层
 * 「已工作 Xs」;文字之间的 tool / thinking / 已结束 agent task 仍各自
 * 聚成内层「已工作 Xs」。最后一个真实动作之后
 * 连续输出的 assistant 文字视为最终答复阶段,留在组外;若整轮没有真实动作,
 * 只保留最后一条 assistant 正文,此前文字仍视作工作过程。
 *
 * 位置判定之外还有一条位置无关的兜底:交付正文(见 isDeliveryProseItem)即使排在
 * 收尾动作之前也不折叠,免得「先出简报 → 再发通知 → 再说一句已完成」把产出藏进组里。
 *
 * 没有最终正文(被中断 / 停在工具)或最终正文后仍有已完成动作时返回
 * handled:false,交回 groupLegacyWorkRuns 按连续动作折叠。tool_media /
 * 运行中子 Agent 等非可归档项保持可见,并作为顺序锚点切开工作组。
 */
function groupAnsweredTurnItems(
  turnItems: RenderItem[],
  turnStartTs: number | null = null,
): {
  items: RenderItem[];
  handled: boolean;
} {
  const sealedAnswers = new Set<number>();
  for (let i = 0; i < turnItems.length; i++) {
    const item = turnItems[i];
    if (isAssistantAnswerCandidate(item) && isCompletedAssistantMessage(item.message)) {
      sealedAnswers.add(i);
    }
  }

  let lastAnswerIdx = -1;
  for (let i = turnItems.length - 1; i >= 0; i--) {
    if (isAssistantAnswerCandidate(turnItems[i])) {
      lastAnswerIdx = i;
      break;
    }
  }
  if (lastAnswerIdx < 0) return { items: turnItems, handled: false };

  // 新数据按 SDK done seal 分段；旧数据没有 seal 时继续沿用最后一句回退。
  if (sealedAnswers.size > 0) {
    // 每个 seal 只盖 SDK turn 最后一条 assistant；与它连续、且位于本段最后一次真实
    // 动作之后的前置正文同属正式答复阶段，也必须保留在「已工作」外。
    let segmentStart = 0;
    for (const sealedIndex of [...sealedAnswers]) {
      let lastWorkActivityIdx = -1;
      for (let i = sealedIndex - 1; i >= segmentStart; i--) {
        if (isWorkActivityItem(turnItems[i])) {
          lastWorkActivityIdx = i;
          break;
        }
      }
      let answerStart = sealedIndex;
      while (
        answerStart > lastWorkActivityIdx + 1 &&
        answerStart > segmentStart &&
        isAssistantAnswerCandidate(turnItems[answerStart - 1])
      ) {
        answerStart--;
      }
      for (let i = answerStart; i <= sealedIndex; i++) {
        if (isAssistantAnswerCandidate(turnItems[i])) sealedAnswers.add(i);
      }
      segmentStart = sealedIndex + 1;
    }
  } else {
    const hasWorkAfterLastAnswer = turnItems.some(
      (item, index) => index > lastAnswerIdx && isWorkActivityItem(item),
    );
    if (hasWorkAfterLastAnswer) return { items: turnItems, handled: false };

    let lastWorkActivityIdx = -1;
    for (let i = lastAnswerIdx - 1; i >= 0; i--) {
      if (isWorkActivityItem(turnItems[i])) {
        lastWorkActivityIdx = i;
        break;
      }
    }
    let finalAnswerStartIdx = lastAnswerIdx;
    if (lastWorkActivityIdx >= 0) {
      while (
        finalAnswerStartIdx > lastWorkActivityIdx + 1 &&
        isAssistantAnswerCandidate(turnItems[finalAnswerStartIdx - 1])
      ) {
        finalAnswerStartIdx--;
      }
    }
    for (let i = finalAnswerStartIdx; i <= lastAnswerIdx; i++) {
      if (isAssistantAnswerCandidate(turnItems[i])) sealedAnswers.add(i);
    }
  }

  const out: RenderItem[] = [];
  let run: WorkChildItem[] = [];
  let prevBoundaryTs = turnStartTs;
  const flushRun = (nextItem: RenderItem | undefined) => {
    if (run.length === 0) return;
    out.push(createCompletedWorkGroup(run, nextItem, prevBoundaryTs));
    run = [];
  };

  for (let i = 0; i < turnItems.length; i++) {
    const it = turnItems[i];
    if (
      !sealedAnswers.has(i) &&
      !isRunningAgentTask(it) &&
      !isWorkflowTaskItem(it) &&
      !isDeliveryProseItem(it) &&
      isWorkChild(it)
    ) {
      run.push(it);
    } else {
      flushRun(it);
      out.push(it);
      prevBoundaryTs = boundaryTs(it);
    }
  }
  flushRun(undefined);

  return { items: out, handled: true };
}

/**
 * tool_result 媒体列表(单一来源渲染器):按 kind 分发到 ChatImageView /
 * ChatVideoView / ChatAudioCard / ChatSoundEffectCard。两个消费方共用:
 * 'tool_media' item(工具段外的产物流)与 'ghost_card' item 的回锚媒体
 * (卡正下方)。加新 kind 只需改 extractToolResultMedia + 这里加分支。
 */
function ToolMediaList({ items, sessionId }: { items: ToolMediaItem[]; sessionId?: string }) {
  const mediaKeyCounts = new Map<string, number>();
  return (
    <>
      {items.map((m, i) => {
        const mediaKeyBase = `${m.kind}-${m.url}`;
        const mediaKeyOccurrence = mediaKeyCounts.get(mediaKeyBase) ?? 0;
        mediaKeyCounts.set(mediaKeyBase, mediaKeyOccurrence + 1);
        const mediaKey =
          mediaKeyOccurrence === 0 ? mediaKeyBase : `${mediaKeyBase}-${mediaKeyOccurrence}`;
        if (m.kind === 'image') {
          return (
            <div key={mediaKey} className="flex flex-col gap-1.5">
              <ChatImageView
                src={m.url}
                filename={`tool-image-${i + 1}`}
                variant="tool-output"
                modelFile={m.modelFile}
                sessionId={sessionId}
              />
            </div>
          );
        }
        if (m.kind === 'video') {
          return (
            <div key={mediaKey} className="flex flex-col gap-1.5">
              <ChatVideoView
                src={m.url}
                filename={`tool-video-${i + 1}`}
                variant="tool-output"
                sessionId={sessionId}
              />
            </div>
          );
        }
        // kind === 'audio' — 按 track.kind 分发到两种音频卡:
        //   music        → ChatAudioCard (Suno 完整歌曲, 带封面/tags/歌词)
        //   sound_effect → ChatSoundEffectCard (ElevenLabs 音效, 无封面紧凑布局)
        // 两个组件都共享 mediaPlaybackBus + xdt-audio:// 协议 + 右键
        // "打开文件夹"菜单, 只是视觉上音效更紧凑没封面。
        // Track must be present (extractToolResultMedia synthesises
        // an empty one if only xdt_audio_urls came in defensively).
        if (m.audioTrack) {
          if (m.audioTrack.kind === 'sound_effect') {
            return (
              <ChatSoundEffectCard key={mediaKey} track={m.audioTrack} sessionId={sessionId} />
            );
          }
          return <ChatAudioCard key={mediaKey} track={m.audioTrack} sessionId={sessionId} />;
        }
        return null;
      })}
    </>
  );
}

function renderWorkGroupChild(
  item: Exclude<WorkChildItem, ToolSegmentRenderItem>,
  props: {
    workingDir: string;
    sessionId?: string;
    sessionTitle?: string | null;
    agentKind?: 'cc' | 'codex' | 'pi';
    remoteHostId?: string | null;
    isSessionStreaming: boolean;
    firstUserMessageClientId: string | null;
    lastUserMessageClientId: string | null;
    /** 含合成行的最后一条用户侧输入(自愈重连行判断"仍在飞"的兜底判据)。 */
    lastUserInputClientId: string | null;
    /** 当前 vendor turn 的续跑 owner clientId。 */
    continuationTurnClientId: string | null;
    /** 旧端缺省 owner 字段时才启用兼容兜底。 */
    continuationInFlightProjectionCapability: ContinuationInFlightProjectionCapability;
    localFileRefs: readonly KnownLocalFileRef[];
    singleResultMap: Map<string, string>;
    assistantsWithFollowingUserBoundary: ReadonlySet<string>;
    turnFinalAssistantClientIds: ReadonlySet<string>;
    subagentModelByToolUseId: ReadonlyMap<string, string>;
    userTurnUsageDetailsByAssistantId: ReadonlyMap<string, TurnUsageDetails>;
  },
): ReactNode {
  if (item.type === 'agent_task') {
    return (
      <AgentTaskCard
        toolCall={item.toolCall}
        update={item.update}
        result={item.result}
        {...(props.sessionId ? { sessionId: props.sessionId } : {})}
        subagentModel={
          item.toolCall?.toolUseId
            ? props.subagentModelByToolUseId.get(item.toolCall.toolUseId)
            : undefined
        }
      />
    );
  }

  return (
    <MessageItem
      message={item.message}
      toolResult={props.singleResultMap.get(item.message.clientId)}
      workingDir={props.workingDir}
      sessionId={props.sessionId}
      sessionTitle={props.sessionTitle}
      agentKind={props.agentKind}
      remoteHostId={props.remoteHostId}
      sessionRunning={props.isSessionStreaming}
      assistantForkBlocked={shouldBlockAssistantFork(
        props.isSessionStreaming,
        item.message,
        props.assistantsWithFollowingUserBoundary,
      )}
      assistantIsTurnFinal={props.turnFinalAssistantClientIds.has(item.message.clientId)}
      userTurnUsageDetails={props.userTurnUsageDetailsByAssistantId.get(item.message.clientId)}
      isFirstUserMessage={item.message.clientId === props.firstUserMessageClientId}
      isLastUserMessage={item.message.clientId === props.lastUserMessageClientId}
      isLastUserInput={item.message.clientId === props.lastUserInputClientId}
      isContinuationTurnOwner={item.message.clientId === props.continuationTurnClientId}
      continuationInFlightProjectionCapability={props.continuationInFlightProjectionCapability}
      localFileRefs={props.localFileRefs}
    />
  );
}

/**
 * 把每个 user turn 内最终 assistant 正文前的工作过程聚成 work_group item。
 *
 * 新规则:assistant 文字在运行中始终持续可见,不进最近 5 条动作窗口;
 * 每次文字出现都结束前一个 live 动作片段,后续动作重新开一组。
 * turn 结束后,最终答复阶段之前的 assistant 工作文字收入外层「已工作 Xs」,
 * 各段动作仍是内层「已工作 Xs」并保持原始顺序。tool_media 不参与折叠。
 *
 * 兼容旧规则:如果 turn 里还没有最终文本(例如正在流式执行),继续按连续的
 * tool_segment + thinking run 分组;正在进行中的尾部 run 也立即成为 work_group,
 * 默认仅展示最近 5 条活动,不再把所有卡片平铺到消息流。
 *
 * key 稳定性:动作段始终使用首个真实活动 clientId,所以从 live 到完成后的
 * 内层组 key 不变;完成态外组另用 `work-summary-*`,避免复用展开记忆。
 * DB prepend 向前合并等场景由 recoverLostAnchorIdx 递归找回锚点。
 *
 * 窗口空洞:除 user 行外,相邻动作间隔超过 HISTORY_GAP_SPLIT_MS 也切断工作组,
 * 见该常量注释。
 *
 * export 仅供单测使用。
 */
export function groupWorkRuns(items: RenderItem[], isSessionStreaming: boolean): RenderItem[] {
  const out: RenderItem[] = [];
  let currentTurn: RenderItem[] = [];
  // turn 开场边界(用户消息)的时间戳;窗口截断没见到用户消息时为 null,
  // 各分组路径退回段内锚点。
  let turnStartTs: number | null = null;

  const flushTurn = (isActiveTail: boolean) => {
    if (currentTurn.length === 0) return;
    const activeStreaming = isActiveTail && isSessionStreaming;
    if (activeStreaming) {
      out.push(...groupActiveWorkRuns(currentTurn, turnStartTs));
      currentTurn = [];
      return;
    }
    const grouped = groupAnsweredTurnItems(currentTurn, turnStartTs);
    out.push(...(grouped.handled ? grouped.items : groupLegacyWorkRuns(currentTurn, turnStartTs)));
    currentTurn = [];
  };

  // 锚点用上一个 item 的**结束**时间(见 renderItemEndMs):否则一个正常的长时段
  // tool_segment 会让紧随其后的 item 被误判成空洞。
  // 无时间戳的 item 不重置锚点:让间隔判定跨过它,继续比对上一个有时间的动作。
  let prevEndMs: number | null = null;

  for (const it of items) {
    if (it.type === 'message' && it.message.role === 'user') {
      flushTurn(false);
      out.push(it);
      // 两件事互不相干,合并时都要保留:
      //  - prevEndMs:空洞判定的锚点(#676);
      //  - turnStartTs:turn 开场边界,分组算时长用(#598)。
      prevEndMs = renderItemEndMs(it) ?? prevEndMs;
      turnStartTs = messageTs(it.message);
      continue;
    }
    const itemStartMs = renderItemStartMs(it);
    if (
      prevEndMs !== null &&
      itemStartMs !== null &&
      itemStartMs - prevEndMs > HISTORY_GAP_SPLIT_MS
    ) {
      flushTurn(false);
      // 空洞切开的新段没有已知的 turn 开场边界:那条 user 行在空洞的**另一侧**(或压根没加载)。
      // 继续拿它当起点会让新段的时长横跨整个空洞 —— 正是本 PR 要修的那种谎报(实测 47 小时)。
      // 置 null 与 #598 里"窗口截断没见到用户消息"同语义:各分组路径退回段内锚点。
      turnStartTs = null;
    }
    currentTurn.push(it);
    // 取本 turn 内见过的**最大**结束时间,不能无条件覆盖:并行的 Agent/Task 可能乱序完成
    // (相邻的后一张卡先结束),无条件赋值会让锚点回退到更早的时刻,于是紧随其后的最终答复
    // 与这个退化锚点相差超过阈值 → 连续 turn 被误切、时长被低报(#676 review)。
    const itemEndMs = renderItemEndMs(it);
    if (itemEndMs !== null) {
      prevEndMs = prevEndMs === null ? itemEndMs : Math.max(prevEndMs, itemEndMs);
    }
  }
  flushTurn(true);
  return out;
}

// agent 出图(art / 飞书拉图等)统一走 ChatImageView('tool-output' variant),
// 与用户上传图共用一份组件,样式/交互/错误降级集中维护。

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MessageStream({
  sessionId,
  sessionTitle,
  agentKind,
  remoteHostId,
  workingDir,
  messages,
  taskUpdates,
  isSessionStreaming = false,
  continuationTurnClientId = null,
  continuationInFlightProjectionCapability = 'unknown',
  onLoadMore,
  isLoadingMore,
  hasMoreMessages,
  bottomPadding,
  contentWidth,
  focusMessageClientId,
  focusMessageRequestId,
  forkOrigin,
  onOpenForkOrigin,
}: MessageStreamProps) {
  // 右上角 chip 栈插槽 —— PrevMessageJumpChip 通过 portal 挂到这里,
  // 与 DiffPanelToggle 在同一栈中各占一行。Provider 不存在时返回 null,
  // 渲染处会兜底跳过(典型场景:其他视图直接用 MessageStream 但不需要栈)。
  const chipSlot = useTopRightChipSlot();

  // 会话文件来源上下文(local / device-link / SSH):顶层构造一次,经
  // ChatSessionFileProvider 下发给整棵消息树;galleryDeviceId 也从这里同源取
  // (见 sessionImageSrcs 处注释)。
  const sessionFileValue = useChatSessionFileValue(sessionId, workingDir, remoteHostId);

  /** 分享选择模式:只驱动整列缩进(低频)。逐条的选中态由每个复选框自己订阅。 */
  const shareSelectionActive = useShareSelectionActive(sessionId);

  // 滚动容器:原生 div + overflow-y-auto,样式由全局 .is-scrolling 体系接管
  // (lib/scrollbarAutoHide.ts 自动加/撤 .is-scrolling 类,globals.css 控制
  // thumb 显隐)。data-scroll-container 给 ImageLightbox 等四个 lightbox
  // 的全局 querySelector 找锚点用。
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 渲染 item 的内层 flex 容器 —— 其 children 与 visibleRenderItems 按索引一一对应,
   *  「按条目相对定位」的还原逻辑靠它反查视口顶端那条 item 的 DOM 节点。 */
  const itemsRef = useRef<HTMLDivElement>(null);

  // ── 切会话恢复浏览位置(默认常开) ──
  // 父组件用 key={sessionId} 重挂载本组件,所以这里在 mount 时一次性读取快照即可:
  // 该 session 的快照在第一次 render 时确定,后续不再变。
  /** 本次 mount 命中的「上次浏览位置」快照(无快照 / 离开时本就在底部 → undefined)。 */
  const restoreSnapshotRef = useRef<SessionScrollSnapshot | undefined>(
    sessionId ? readSessionScroll(sessionId) : undefined,
  );
  /** 是否正处于「还原中」:有快照且离开时不在底部。还原中关闭 auto-follow,
   *  并在内容异步settle期间持续按锚点重定位,直到用户第一次手动滚动接管。 */
  const restoringRef = useRef<boolean>(
    restoreSnapshotRef.current ? restoreSnapshotRef.current.isNearBottom === false : false,
  );
  /** Whether we should keep pinning the viewport to the bottom. */
  const isNearBottomRef = useRef(!restoringRef.current);
  /** Set while we programmatically change scrollTop, so the scroll handler
   *  doesn't misread the assignment as user-initiated up-scroll. */
  const programmaticScrollRef = useRef(false);
  /** F-SYNC-2: remembered scrollHeight snapshot taken at the moment we
   *  trigger `onLoadMore`, used to restore position after prepend. */
  const prevScrollHeightRef = useRef(0);
  /** F-SYNC-2 anchoring 检测配套:与 `prevScrollHeightRef` 同时刻记录的 scrollTop
   *  快照。effect 跑前比对 `el.scrollTop` 与这个快照,大于一定阈值 = 浏览器
   *  scroll anchoring 已经把 scrollTop 自动加过 delta(无需 React 层再补),
   *  避免与浏览器 anchoring 双补偿导致 viewport 被推到底。 */
  const prevScrollTopAtLoadRef = useRef(0);
  /** Track previous scrollTop to detect scroll direction. */
  const prevScrollTopRef = useRef(0);
  /** clientId of the last user-role message we've already observed. Used to
   *  detect a NEW user send → force pin regardless of prior scroll state. */
  const lastUserMsg = messages[messages.length - 1];
  const lastUserMsgIdRef = useRef<string | null>(
    lastUserMsg?.role === 'user' ? lastUserMsg.clientId : null,
  );

  // ── render-window state ──
  // null = 默认窗口(取末尾 RENDER_WINDOW_INITIAL_ITEMS 个 item);非 null = 锚定到
  // 具体的 RenderItem.key,从那个 item 开始 slice 到末尾。expand 时把锚点往前挪
  // RENDER_WINDOW_GROWTH_ITEMS 个 item。
  //
  // 还原快照是"默认窗口 + 非贴底"(windowAnchorKey=null 且 isNearBottom=false)
  // 时,直接把窗口锚定到 viewportTopKey(视口顶端那条 item):applyRestore 需要
  // 的锚点必然在窗口内(就是第一条),位置恢复不漂;窗口 = 视口位置 → 末尾,
  // 必然有界(该快照态意味着用户仍在末尾 INITIAL 窗口内,≤80 条、典型只有一半)。
  // 此前(codex review P2)这种快照走"全量 INITIAL 默认窗口"保锚点命中,几万字
  // 会话切回要全量渲染 73+ 条、首帧 ~400ms(2026-08-09 沙盒 perf 日志实测),
  // 锚定后回落到与贴底切换同阶。viewportTopKey 缺失(老快照)才退回全量窗口。
  const [firstVisibleItemKey, setFirstVisibleItemKey] = useState<string | null>(() => {
    if (!restoringRef.current) return null;
    const snap = restoreSnapshotRef.current;
    if (!snap) return null;
    if (snap.windowAnchorKey !== null) return snap.windowAnchorKey;
    if (!snap.isNearBottom && snap.viewportTopKey) return snap.viewportTopKey;
    return null;
  });
  const restoreDefaultViewportRef = useRef(
    Boolean(
      restoringRef.current &&
        restoreSnapshotRef.current?.windowAnchorKey === null &&
        restoreSnapshotRef.current?.isNearBottom === false &&
        restoreSnapshotRef.current?.viewportTopKey,
    ),
  );
  // 两段式默认窗口的当前尺寸(FIRST_PAINT → 空闲期扩到 INITIAL)。只影响
  // firstVisibleItemKey === null 的"默认窗口"分支;锚点窗口不看它。
  // "默认窗口 + 非贴底"快照已在上面转为锚点窗口,不再进本分支;仅
  // viewportTopKey 缺失的降级路径仍需全量 INITIAL 保命中率。
  const [defaultWindowItems, setDefaultWindowItems] = useState(() => {
    const snap = restoringRef.current ? restoreSnapshotRef.current : null;
    if (snap && snap.windowAnchorKey === null && !snap.isNearBottom && !snap.viewportTopKey) {
      return RENDER_WINDOW_INITIAL_ITEMS;
    }
    return RENDER_WINDOW_FIRST_PAINT_ITEMS;
  });
  /**
   * 锚点窗口向后的 item 上界（render-window-bidirectional 要点 1）。
   * 仅 firstVisibleItemKey !== null 时生效；null（默认窗口）时不参与 slice。
   * 锚点变化时重置为 FIRST_PAINT，expandWindow / 向下扩窗时增长。
   * 初始化时从滚动快照恢复（P1 fix：否则扩窗后切走的浏览位置会丢失）。
   */
  const [anchoredForwardItems, setAnchoredForwardItems] = useState(() => {
    if (!restoringRef.current) return RENDER_WINDOW_FIRST_PAINT_ITEMS;
    const snap = restoreSnapshotRef.current;
    if (snap?.anchoredForwardCount && snap.anchoredForwardCount > 0) {
      return snap.anchoredForwardCount;
    }
    return RENDER_WINDOW_FIRST_PAINT_ITEMS;
  });
  const [highlightMessageClientId, setHighlightMessageClientId] = useState<string | null>(null);
  const lastAppliedFocusRef = useRef<string | null>(null);
  const lastMissingFocusRef = useRef<{
    clientId: string;
    requestKey: string;
    itemCount: number;
    lastItemKey: string | null;
  } | null>(null);
  const focusScrollTimerRef = useRef<number | null>(null);
  const focusHighlightTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (focusScrollTimerRef.current !== null) {
        window.clearTimeout(focusScrollTimerRef.current);
      }
      if (focusHighlightTimerRef.current !== null) {
        window.clearTimeout(focusHighlightTimerRef.current);
      }
    },
    [],
  );

  // 意识卡片快照(卡槽③):独立 store,版本号变才触发重建;供片限速 ≥1s/卡,
  // 对 build 频率的额外贡献可控。
  const ghostCardSnapshot = useSyncExternalStore(subscribeGhostCards, getGhostCardSnapshot);
  // 历史回放取卡:会话打开时一次性批量取本会话全部卡(含 tool-call 卡与
  // 出口钩子的 turn 级自绘卡,后者 callId = assistant 消息 clientId),让"该气泡
  // 被自绘替换"的判定在重启/回放后成立;再对 settled 消息里的 xdt_card_id 逐个
  // ensureCard 兜底(幂等,批量已 ready 者直接跳过)。
  useEffect(() => {
    if (sessionId) ensureSessionCards(sessionId);
  }, [sessionId]);
  useEffect(() => {
    for (const m of messages) {
      if (m.role === 'tool_result' && m.content.includes('xdt_card_id')) {
        const cardId = extractGhostCardId(m.content);
        if (cardId) ensureCard(cardId);
      }
    }
  }, [messages]);

  const [turnChangeSets, setTurnChangeSets] = useState<TurnChangeSetSummary[]>([]);
  useEffect(() => {
    if (!sessionId || remoteHostId !== null || isRemoteSessionSticky(sessionId)) {
      setTurnChangeSets([]);
      return;
    }
    let cancelled = false;
    setTurnChangeSets([]);
    const off = subscribeTurnChangeSetUpdated(sessionId, ({ summary }) => {
      if (cancelled) return;
      setTurnChangeSets((current) => {
        const next = current.filter((item) => item.id !== summary.id);
        next.push(summary);
        next.sort((a, b) => a.createdAt - b.createdAt);
        return next;
      });
    });
    void window.electronAPI.maker.listTurnChangeSets(sessionId)
      .then((next) => {
        if (cancelled) return;
        setTurnChangeSets((current) => {
          const merged = new Map(next.map((item) => [item.id, item]));
          for (const item of current) merged.set(item.id, item);
          return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
        });
      })
      .catch(() => {
        // A live push may already have arrived; keep it instead of clearing the card.
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [remoteHostId, sessionId]);

  // 全量 build:折叠 / 丢弃 / 反向膨胀的所有规则一次性吸收 — 窗口看到的就是
  // 用户看到的。流式中每 token messages 引用变 → 这里跑一次 O(n) 单线性扫描,
  // 实测 N=1000 < 2ms (Windows),如果未来发现瓶颈再走增量化(out of scope)。
  const { items: ungroupedRenderItems, singleResultMap } = useMemo(
    () =>
      buildRenderItems(messages, taskUpdates, ghostCardSnapshot, {
        historyWindowIncomplete: Boolean(hasMoreMessages),
        turnChangeSets,
        workingDir,
      }),
    [messages, taskUpdates, ghostCardSnapshot, hasMoreMessages, turnChangeSets, workingDir],
  );
  const assistantsWithFollowingUserBoundary = useMemo(
    () => collectAssistantsWithFollowingUserBoundary(messages),
    [messages],
  );
  // action bar 只挂每个 turn 的收尾 assistant 正文(见 collectTurnFinalAssistantClientIds)。
  const turnFinalAssistantClientIds = useMemo(
    () => collectTurnFinalAssistantClientIds(messages),
    [messages],
  );
  // subagent-model-chip: parentToolUseId(Agent/Task 行 id)→ 子代理模型,
  // 供 AgentActionsBlock 给 Agent/Task 行反查并渲染模型 chip。
  const subagentModelByToolUseId = useMemo(() => buildSubagentModelMap(messages), [messages]);

  // work-group pass:把最终回答前的工作过程折叠成 work_group,无最终回答时
  // 继续走旧的 tool_segment + thinking 折叠兼容路径。
  // isSessionStreaming 翻转(每 turn 一次)与 items 变化时重算,O(n) 单扫描。
  const allRenderItems = useMemo(
    () => insertForkOriginItem(groupWorkRuns(ungroupedRenderItems, isSessionStreaming), forkOrigin),
    [ungroupedRenderItems, isSessionStreaming, forkOrigin],
  );

  /**
   * render-window-bidirectional 已实施：锚定窗口改为双向有界
   * `slice(startIdx, startIdx + anchoredForwardItems)`（要点 1）。
   * 配合 expandWindow 同步扩上界（要点 4）、handleScroll 向下扩窗（要点 5）、
   * windowAtTop 改 visibleStartIdx === 0（要点 2）、isNearBottom 强制非贴底（要点 3）。
   * 之前那套 store 侧补齐预算是它落地前的过渡兜底，后续可大幅放宽甚至移除。
   */
  /**
   * render-window-bidirectional: 锚定窗口从 `slice(startIdx)` 改成
   * `slice(startIdx, startIdx + anchoredForwardItems)`，配合向下扩窗（要点 1）。
   * 同时导出 startIdx 供 windowAtTop 判定使用（要点 2）。
   */
  // ── 切换立即响应(shell-first mount)──
  // 旧行为:点击切 session → 首个提交同步构建整个消息树 → 期间界面冻结(压测
  // session 实测 ~380ms 无响应),体感是"卡住才切过去"。
  // 新行为:首个提交只渲染外壳(标题栏/输入框/空消息区 + spinner),消息树推迟
  // 到外壳绘制后的下一帧 —— 点击零冻结,先切进去再看到内容浮现(对齐 Codex
  // Desktop 的加载体感)。挂载后的滚动定位不受影响:pin-to-bottom 与 applyRestore
  // 都由 ResizeObserver 在内容真正挂载时驱动,首帧空内容它们自然 no-op。
  // 各 auto-fill effect 均有 `visibleRenderItems.length === 0` 早退守卫,空帧不误触发。
  const [firstMountDeferred, setFirstMountDeferred] = useState(true);
  useEffect(() => {
    // rAF 保证外壳那一帧真正上屏后才挂消息树;卸载时取消,防 setState-after-unmount。
    const raf = requestAnimationFrame(() => setFirstMountDeferred(false));
    return () => cancelAnimationFrame(raf);
  }, []);

  const { items: visibleRenderItems, startIdx: visibleStartIdx } = useMemo(() => {
    if (firstMountDeferred) return { items: EMPTY_RENDER_ITEMS, startIdx: 0 };
    if (allRenderItems.length === 0) return { items: allRenderItems, startIdx: 0 };
    if (firstVisibleItemKey === null) {
      // 首帧阶段(defaultWindowItems 还没被空闲扩窗抬到 INITIAL)叠加内容预算:
      // 条数上限防"多而小",字节预算防"少而大"(单条 12KB 表格 × 15 条 = ~380ms)。
      // 顺序:先 snap(边界吸附向前扩)再按预算收 —— 预算是硬上界,否则 snap 会把
      // 刚裁掉的大条目又吸回来。预算收窄后的起点可能不在 turn 边界上(顶部短暂出现
      // 无上下文卡片),空闲扩窗(→INITIAL)会在 ~1s 内带着正常 snap 重建窗口。
      const countStartIdx = Math.max(0, allRenderItems.length - defaultWindowItems);
      const snappedStartIdx = snapRenderWindowStartIdx(allRenderItems, countStartIdx);
      const defaultStartIdx =
        defaultWindowItems < RENDER_WINDOW_INITIAL_ITEMS
          ? clampTailWindowStartByBudget(allRenderItems, snappedStartIdx)
          : snappedStartIdx;
      return { items: allRenderItems.slice(defaultStartIdx), startIdx: defaultStartIdx };
    }
    let idx = allRenderItems.findIndex((it) => it.key === firstVisibleItemKey);
    if (idx < 0) {
      // 锚点 key 失效 — 最常见原因:DB prepend 让 tool_segment 合并,
      // toolCalls[0] 变了导致 seg-${cid} key 漂移。recoverLostAnchorIdx 反解
      // clientId 找到现在覆盖它的 item,跨段合并的边界仍能续上。
      // 真正找不到(消息被删/clear)才退回默认窗口。
      idx = recoverLostAnchorIdx(allRenderItems, firstVisibleItemKey);
      if (idx < 0) {
        // 锚点彻底失效的兜底窗口用全量 INITIAL 而非两段式的 defaultWindowItems:
        // 该分支多发生在还原/删改消息的异常路径,宽窗口能最大化保住 viewportTopKey
        // 命中率(与"非贴底快照首帧用全量窗口"同理),不吝啬这 50 个 item。
        const defaultStartIdx = snapRenderWindowStartIdx(
          allRenderItems,
          Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
        );
        return { items: allRenderItems.slice(defaultStartIdx), startIdx: defaultStartIdx };
      }
    }

    // A default-tail snapshot can become stale while the session is in the
    // background. If enough messages arrive, the saved viewport anchor is no
    // longer in the bounded tail; prefer a bounded tail first paint over
    // mounting the entire anchor-to-end range. The layout effect below clears
    // the stale anchor state before the next paint.
    if (
      restoreDefaultViewportRef.current &&
      restoringRef.current &&
      idx < Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS)
    ) {
      const defaultStartIdx = snapRenderWindowStartIdx(
        allRenderItems,
        Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
      );
      return { items: allRenderItems.slice(defaultStartIdx), startIdx: defaultStartIdx };
    }

    const startIdx = snapRenderWindowStartIdx(allRenderItems, idx);
    const windowItemCount = resolveAnchoredWindowItemCount(
      startIdx,
      idx,
      anchoredForwardItems,
    );
    return {
      items: allRenderItems.slice(startIdx, startIdx + windowItemCount),
      startIdx,
    };
  }, [allRenderItems, firstVisibleItemKey, defaultWindowItems, anchoredForwardItems, firstMountDeferred]);

  // If a restored default-tail anchor fell out of the tail while this session
  // was backgrounded, permanently fall back to the bounded default window for
  // this mount. This also prevents expandWindow from treating the stale key as
  // a user-created anchored window.
  useLayoutEffect(() => {
    if (!restoreDefaultViewportRef.current || !restoringRef.current || firstVisibleItemKey === null) return;
    const snap = restoreSnapshotRef.current;
    if (!snap?.viewportTopKey) return;
    if (allRenderItems.length === 0) return;
    const anchorIdx = findRestorableViewportItemIdx(allRenderItems, snap.viewportTopKey);
    // History hydration can temporarily omit the anchor; retain restore mode
    // until a later render can locate it instead of treating it as deleted.
    if (anchorIdx < 0) return;
    if (isViewportAnchorWithinDefaultTail(allRenderItems, snap.viewportTopKey)) return;
    restoreDefaultViewportRef.current = false;
    restoringRef.current = false;
    isNearBottomRef.current = false;
    setIsNearBottom(false);
    setFirstVisibleItemKey(null);
    setDefaultWindowItems(RENDER_WINDOW_INITIAL_ITEMS);
  }, [allRenderItems, firstVisibleItemKey]);

  // 两段式默认窗口第二段:首帧(非空)提交后,空闲期把默认窗口扩回 INITIAL。
  // 只在仍钉底时扩(prepend 在视口上方,pin-to-bottom layout effect 同帧重钉,
  // 无跳动);已向上滚离底部 / 已切到锚点窗口的,交给既有 expandWindow 路径。
  // requestIdleCallback 带 1s timeout 兜底;测试等无 ric 环境退化为 setTimeout。
  useEffect(() => {
    if (firstVisibleItemKey !== null) return;
    if (visibleRenderItems.length === 0) return;
    // 不能只比较 allItems <= defaultWindowItems。短会话的声明窗口容量可能已
    // 覆盖全量，但首帧字节预算仍会把实际 DOM 起点向后裁；此时 visible.length
    // 才是窗口是否完整的事实源。只要实际可见数 < 全量，就要在空闲期 boost，
    // 将 defaultWindowItems 升到 INITIAL（预算仅在 <INITIAL 阶段生效），恢复全部 item。
    if (
      !shouldBoostDefaultWindow({
        allItemCount: allRenderItems.length,
        visibleItemCount: visibleRenderItems.length,
        defaultWindowItems,
      })
    ) {
      return;
    }
    const boost = () => {
      if (isNearBottomRef.current) {
        setDefaultWindowItems(RENDER_WINDOW_INITIAL_ITEMS);
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(boost, { timeout: 1000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(boost, 200);
    return () => window.clearTimeout(id);
  }, [defaultWindowItems, firstVisibleItemKey, visibleRenderItems.length, allRenderItems.length]);

  useLayoutEffect(() => {
    const focusRequestKey = focusMessageClientId
      ? `${focusMessageRequestId ?? 0}:${focusMessageClientId}`
      : null;
    if (!focusMessageClientId || !focusRequestKey) {
      lastAppliedFocusRef.current = null;
      lastMissingFocusRef.current = null;
      return;
    }
    if (lastAppliedFocusRef.current === focusRequestKey) return;
    const lastItemKey = allRenderItems.at(-1)?.key ?? null;
    const missingFocus = lastMissingFocusRef.current;
    if (
      missingFocus?.clientId === focusMessageClientId &&
      missingFocus.requestKey === focusRequestKey &&
      missingFocus.itemCount === allRenderItems.length &&
      missingFocus.lastItemKey === lastItemKey
    ) {
      return;
    }
    const targetKey = renderItemKeyForClientId(allRenderItems, focusMessageClientId);
    if (!targetKey) {
      lastMissingFocusRef.current = {
        clientId: focusMessageClientId,
        requestKey: focusRequestKey,
        itemCount: allRenderItems.length,
        lastItemKey,
      };
      return;
    }
    lastMissingFocusRef.current = null;
    if (!visibleRenderItems.some((item) => item.key === targetKey)) {
      setFirstVisibleItemKey(targetKey);
      setAnchoredForwardItems(RENDER_WINDOW_FIRST_PAINT_ITEMS);
      return;
    }
    const root = scrollRef.current;
    if (!root) return;
    // 精确锚点(message wrapper / 带 toolCall 的任务卡)优先;查不到时退回
    // 聚合动作块的容器锚点(data-message-client-ids 空格分隔多 clientId)——
    // 后台 Bash 等工具行渲染在折叠块内,没有独立的行级 DOM 锚点。
    const el = (root.querySelector(
      `[data-message-client-id="${CSS.escape(focusMessageClientId)}"]`,
    ) ??
      root.querySelector(
        `[data-message-client-ids~="${CSS.escape(focusMessageClientId)}"]`,
      )) as HTMLElement | null;
    if (!el) return;
    restoringRef.current = false;
    isNearBottomRef.current = false;
    setIsNearBottom(false);
    programmaticScrollRef.current = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    lastAppliedFocusRef.current = focusRequestKey;
    if (focusScrollTimerRef.current !== null) {
      window.clearTimeout(focusScrollTimerRef.current);
    }
    if (focusHighlightTimerRef.current !== null) {
      window.clearTimeout(focusHighlightTimerRef.current);
    }
    // 高亮时机:等平滑滚动**落定后**再点亮,避免目标还在半途就提前闪高亮(用户反馈)。
    // 优先用 scrollend 精确对齐;拿不到(不支持 / 目标已在视口内滚动距离为 0 不触发)时用兜底延时。
    // 点亮后**不再自动淡出**——停在搜索命中处,直到下次跳转覆盖或切会话(满足「搜索态高亮不消失」)。
    let highlightApplied = false;
    const applyHighlight = () => {
      if (highlightApplied) return;
      highlightApplied = true;
      root.removeEventListener('scrollend', applyHighlight);
      setHighlightMessageClientId(focusMessageClientId);
    };
    root.addEventListener('scrollend', applyHighlight, { once: true });
    focusScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 800);
    // 兜底:scrollend 未触发(距离为 0 / 环境不支持)时,~600ms 后强制点亮。
    focusHighlightTimerRef.current = window.setTimeout(() => {
      applyHighlight();
      focusHighlightTimerRef.current = null;
    }, 600);
    // 清理:effect 因依赖变化重跑(如用户快速连点两条结果)时,移除尚未触发的旧监听器,
    // 避免旧 applyHighlight 在下次 scrollend 以上一条 clientId 点亮、造成高亮闪错消息。
    // 已触发过则监听器已被 { once } 自动移除,这里为幂等空操作。
    return () => {
      root.removeEventListener('scrollend', applyHighlight);
    };
  }, [allRenderItems, focusMessageClientId, focusMessageRequestId, visibleRenderItems]);

  // 会话内全部图片的有序 src(全量,来自未裁剪的 allRenderItems),下发给
  // ImageLightbox 做翻图。基于全量而非 visibleRenderItems,这样计数 / 翻页
  // 立刻覆盖整个会话,不用先往上滚动加载老图。
  // galleryMediaOrigin 与 ChatSessionFileContext 同源(sessionFileValue,订阅式):
  // 画廊 src 的远程改写必须和 <img data-gallery-src> 的改写用同一个来源
  // (useRemoteMediaUrl 同款 toRemoteMediaOrigin),否则 ImageLightbox 的
  // includes 匹配失效;订阅式取值同时修掉了旧实现(render 时一次性
  // getSessionDeviceId)在 deviceId 迟到注册时画廊停在未改写 src 的隐患。
  const galleryMediaOrigin = useMemo(
    () => toRemoteMediaOrigin(sessionFileValue.origin, sessionFileValue.workingDir),
    [sessionFileValue],
  );
  const sessionImageSrcs = useMemo(
    () =>
      collectSessionImageSrcs(
        allRenderItems,
        galleryMediaOrigin,
        ghostCardSnapshot,
        isSessionStreaming,
      ),
    [allRenderItems, galleryMediaOrigin, ghostCardSnapshot, isSessionStreaming],
  );

  // 把可见窗口往前(更早)推 RENDER_WINDOW_GROWTH_ITEMS 个 item,用于滚到顶时的客户端扩窗。
  // render-window-bidirectional 要点 4: expandWindow 必须同步把上界 +GROWTH，
  // 否则 start 前移而上界不动，会把用户视口下方的内容反向截掉。
  const expandWindow = useCallback(() => {
    if (allRenderItems.length === 0) return;
    let currentStartIdx: number;
    const wasDefaultWindow = firstVisibleItemKey === null;
    if (wasDefaultWindow) {
      currentStartIdx = resolveDefaultWindowStartIdx({
        allItemCount: allRenderItems.length,
        defaultWindowItems,
        visibleStartIdx,
        visibleItemCount: visibleRenderItems.length,
      });
    } else {
      currentStartIdx = allRenderItems.findIndex((it) => it.key === firstVisibleItemKey);
      if (currentStartIdx < 0) {
        // 锚点失效场景同 visibleRenderItems useMemo 的注释 —— 先 recover 再继续。
        // recover 失败把窗口当作"默认"位置;与 visibleRenderItems 的兜底同口径用全量
        // INITIAL(而非两段式 defaultWindowItems),expand 仍能从这往前扩。
        currentStartIdx = recoverLostAnchorIdx(allRenderItems, firstVisibleItemKey);
        if (currentStartIdx < 0) {
          currentStartIdx = Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS);
        }
      }
    }
    if (currentStartIdx <= 0) return;
    const newIdx = Math.max(0, currentStartIdx - RENDER_WINDOW_GROWTH_ITEMS);
    const newAnchorIdx = snapRenderWindowStartIdx(allRenderItems, newIdx);
    const newAnchor = allRenderItems[newAnchorIdx]?.key ?? null;
    if (newAnchor) {
      setFirstVisibleItemKey(newAnchor);
      if (wasDefaultWindow) {
        // 默认窗口 → 锚定窗口：从新锚点到末尾全部可见（数量 = defaultWindowItems + GROWTH，有界）。
        setAnchoredForwardItems(allRenderItems.length - newAnchorIdx);
      } else {
        // P1 fix: 按实际起点位移增长，而非固定 GROWTH。
        // snapRenderWindowStartIdx 可能因边界吸附向前多移最多 RENDER_WINDOW_BOUNDARY_LOOKBACK_ITEMS，
        // 若上界只 +GROWTH 会把尾部截掉差值条 item。
        setAnchoredForwardItems((prev) => prev + (currentStartIdx - newAnchorIdx));
      }
    }
  }, [
    allRenderItems,
    firstVisibleItemKey,
    defaultWindowItems,
    visibleStartIdx,
    visibleRenderItems.length,
  ]);

  // render-window-bidirectional 要点 2: windowAtTop 改基于 visibleStartIdx === 0。
  // 原定义 visible.length === all.length 在双向窗口下即使 start 已到 0 也恒为 false。
  const windowAtTop = visibleStartIdx === 0;

  // render-window-bidirectional 要点 3/5: 窗口是否已覆盖到内存末尾。
  // 默认窗口(firstVisibleItemKey === null)始终覆盖末尾。
  const windowCoversEnd =
    firstVisibleItemKey === null ||
    allRenderItems.length === 0 ||
    visibleStartIdx + visibleRenderItems.length >= allRenderItems.length;

  // ── 滚动位置 保存 / 还原 的辅助 ──
  // unmount cleanup 与 ResizeObserver 回调里读不到最新的 visibleRenderItems /
  // firstVisibleItemKey(闭包会 stale),用 ref 镜像每次 render 同步一份,供它们读取。
  const visibleRenderItemsRef = useRef(visibleRenderItems);
  visibleRenderItemsRef.current = visibleRenderItems;
  const windowCoversEndRef = useRef(windowCoversEnd);
  windowCoversEndRef.current = windowCoversEnd;
  const firstVisibleItemKeyRef = useRef(firstVisibleItemKey);
  firstVisibleItemKeyRef.current = firstVisibleItemKey;
  const anchoredForwardItemsRef = useRef(anchoredForwardItems);
  anchoredForwardItemsRef.current = anchoredForwardItems;

  // render-window-bidirectional P1 fix: 新消息导致锚定窗口不再覆盖末尾时，
  // 重置 near-bottom 以触发未读提示（覆盖末尾→清锚回默认窗的逻辑在 handleScroll 里）。
  const prevWindowCoversEndRef = useRef(windowCoversEnd);
  useLayoutEffect(() => {
    const wasCovering = prevWindowCoversEndRef.current;
    prevWindowCoversEndRef.current = windowCoversEnd;

    if (firstVisibleItemKey !== null && wasCovering && !windowCoversEnd) {
      isNearBottomRef.current = false;
      setIsNearBottom(false);
    }
  }, [firstVisibleItemKey, windowCoversEnd]);

  // 量出当前视口顶端那条 render-item 的 key + 它被滚到视口上方的像素数。
  // 用 children 索引 ↔ visibleRenderItems 索引的天然对应关系反查(map 一条 item
  // 产出一个根节点),不需要给每条 item 的 DOM 打 data 标记。stable 引用(无依赖)。
  const measureViewportTop = useCallback((): { viewportTopKey: string; offset: number } | null => {
    const container = scrollRef.current;
    const items = itemsRef.current;
    if (!container || !items) return null;
    const vis = visibleRenderItemsRef.current;
    const cTop = container.getBoundingClientRect().top;
    const children = items.children;
    for (let i = 0; i < children.length; i++) {
      const rect = (children[i] as HTMLElement).getBoundingClientRect();
      // 第一条「底边还在容器顶边下方」的 item = 正好跨过视口顶边的那条。
      if (rect.bottom - cTop > 0) {
        const key = vis[i]?.key;
        if (!key) return null;
        return { viewportTopKey: key, offset: Math.max(0, cTop - rect.top) };
      }
    }
    return null;
  }, []);

  // 把视口滚回快照记录的「锚点 item + 偏移」。按条目相对定位,所以即使上方图片 /
  // markdown 还没异步渲染完导致高度偏小,也会落在正确的 item 上;settle 期间由
  // ResizeObserver 反复调用本函数纠偏(幂等,不漂移)。stable 引用(无依赖)。
  const applyRestore = useCallback(() => {
    const snap = restoreSnapshotRef.current;
    const container = scrollRef.current;
    const items = itemsRef.current;
    if (!snap || !container || !items) return;
    const idx = findRestorableViewportItemIdx(visibleRenderItemsRef.current, snap.viewportTopKey);
    if (idx < 0) return; // 锚点 item 不在当前窗口(消息被删 / clear)→ 放弃还原,停在默认位置
    const child = items.children[idx] as HTMLElement | undefined;
    if (!child) return;
    const cTop = container.getBoundingClientRect().top;
    const rect = child.getBoundingClientRect();
    // 期望 child 顶端落在 (容器顶边 - offset) 处;向下滚 delta 会让 rect.top 上移 delta。
    const delta = rect.top - (cTop - snap.offset);
    if (Math.abs(delta) < 1) return;
    programmaticScrollRef.current = true;
    container.scrollTop += delta;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);
  // ResizeObserver 回调用 ref 取最新 applyRestore,避免把它放进 observer 依赖导致
  // 流式每 token(visibleRenderItems 变)都 disconnect/reconnect。
  const applyRestoreRef = useRef(applyRestore);
  applyRestoreRef.current = applyRestore;

  // 保存当前浏览位置到 sessionScrollStore。在用户滚动时(DOM 一定存活)持续调用,
  // 不依赖 unmount 时机。无 sessionId / 量测失败则跳过。
  const saveRafRef = useRef<number | null>(null);
  const saveScrollSnapshot = useCallback(() => {
    if (!sessionId) return;
    const measured = measureViewportTop();
    if (!measured) return;
    saveSessionScroll(sessionId, {
      windowAnchorKey: firstVisibleItemKeyRef.current,
      viewportTopKey: measured.viewportTopKey,
      offset: measured.offset,
      isNearBottom: isNearBottomRef.current,
      anchoredForwardCount:
        firstVisibleItemKeyRef.current !== null
          ? anchoredForwardItemsRef.current
          : undefined,
    });
  }, [sessionId, measureViewportTop]);

  // perf-baseline (见 perfLog 注释):
  // 父组件用 key={sessionId} 包了本组件,所以每次切 session 都是全新 mount,
  // mountTimeRef 在 component body 初始化即可作为切换时间锚点。
  // 度量单位:initialItems/renderedItems = render-item 数(不是消息条数 —— 跟
  // 渲染窗口同轴),totalMsgs 仍保留方便定位真实消息规模。
  const perfMountTimeRef = useRef<number>(performance.now());
  const perfFirstPaintLoggedRef = useRef<boolean>(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only perf baseline；父组件按 sessionId key 重挂载，依赖变化不应重复打 mount 日志。
  useEffect(() => {
    perfLog.debug(
      `stream:mount sid=${sessionId ?? 'null'} initialMsgs=${messages.length} initialItems=${allRenderItems.length} renderedItems=${visibleRenderItems.length}`,
    );
    // 仅 mount 时跑一次,sessionId 不会在 lifecycle 内变化(parent 用 key 重挂载)
  }, []);

  // 切 session 兜底:父组件用 key={sessionId} 包本组件,session 切换
  // 走整树 unmount → 这里的 cleanup 显式 pause 所有仍在播放的媒体。
  // React unmount 移除 DOM 通常会自动停掉 <audio>/<video>,但 chromium
  // 偶发存在短暂延迟,显式停一次保证即时静音。
  useEffect(() => {
    return () => {
      stopAllMedia();
    };
  }, []);

  // 切会话兜底:在本组件 unmount(切走该 session)时做最后一次保存,补捉 handleScroll
  // 的 rAF 节流来不及落的最后一帧。必须用 useLayoutEffect —— 它的 cleanup 在 commit
  // 的 mutation 阶段同步执行,此时本组件子树的 DOM / ref 仍存活,可正常量测;若用
  // useEffect,其 cleanup 跑在 passive 阶段(DOM 已移除、ref 已置空),measureViewportTop
  // 必拿到 null,快照永远存不进去(这正是「切回会话仍每次滚到底」的根因)。
  useLayoutEffect(() => {
    return () => {
      if (saveRafRef.current !== null) {
        cancelAnimationFrame(saveRafRef.current);
        saveRafRef.current = null;
      }
      saveScrollSnapshot();
    };
    // sessionId 在本组件生命周期内不变(parent 用 key 重挂载);saveScrollSnapshot
    // 通过 ref 镜像在 cleanup 时读到最新的位置 / 锚点 / nearBottom。
  }, [saveScrollSnapshot]);
  useLayoutEffect(() => {
    if (!perfFirstPaintLoggedRef.current && visibleRenderItems.length > 0) {
      perfFirstPaintLoggedRef.current = true;
      perfLog.debug(
        `stream:first-paint sid=${sessionId ?? 'null'} totalMsgs=${messages.length} totalItems=${allRenderItems.length} renderedItems=${visibleRenderItems.length} elapsed=${Math.round(performance.now() - perfMountTimeRef.current)}ms`,
      );
    }
    // first-paint 只打一次；deps 保留日志里读取的计数，ref 负责短路后续变化。
  }, [allRenderItems, visibleRenderItems, sessionId, messages.length]);

  // ── viewport-fill auto-fill (二段式 mirror handleScroll) ──
  // 处理"内容 < viewport 时的滚动死锁": scroll 容器是 h-full(撑满 viewport),
  // 短 session 真实渲染高度可能远小于 viewport (item 少 / 单 item 短),
  // scrollH = max(content, container) = clientH → scrollbar 不出现 → 用户的
  // handleScroll 永远不会进"距顶<50px"分支 → 既不会 expandWindow 也不会
  // onLoadMore → 内存里没显示的更老 item 以及 DB 里更老的历史都永远拉不到。
  //
  // 二段式 (与 handleScroll 里 "二段式加载" 注释段同款逻辑):
  //   Stage 1 — expand: render-window 还没覆盖内存全部 (visibleItems<allItems) →
  //              shouldAutoExpandRenderWindow=true → expandWindow() 把 render-window
  //              的锚点往前挪 RENDER_WINDOW_GROWTH_ITEMS 个 item (无 IPC, 纯本地,
  //              不计 attempt). 这步是必需的 — 否则 onLoadMore prepend 回来的更老
  //              消息映射成的 render-item 会被 `slice(-INITIAL_ITEMS)` 切在外面看不见 →
  //              DOM 不渲染 → contentH 不增长 → scrollH 永远 = clientH → 死锁.
  //
  //   Stage 2 — load: render-window 已覆盖内存全部 (windowAtTop=y) AND DB 还有
  //              更老历史 → shouldAutoLoadMoreHistory=true → onLoadMore() 拉 DB
  //              (走 IPC, 计 attempt). 拉回来后 prepend 进 messages → buildRenderItems
  //              重算 → allRenderItems 增长, 下次 effect 重新走 Stage 1 expand
  //              把它纳入 visible.
  //
  // 终止条件 (任一满足):
  //   1. scrollH > clientH  → 出现滚动条, 用户可手动续翻
  //   2. windowAtTop=y AND hasMoreMessages=false  → DB 真的没历史了
  //   3. attemptCount >= MAX_AUTO_LOAD_ATTEMPTS  → 退化保护 (只数 IPC, 不数 expand)
  //
  // attemptCount 用 ref 持有, 跟着 mount 生命周期走; sessionId 切换时父组件用
  // key={sessionId} 重挂载本组件, ref 自动归零 (单 session 内独立计数, 无需手动 reset).
  // useLayoutEffect 而不是 useEffect — 在 commit 同步阶段读 scrollH/clientH,
  // 避免 useEffect 滞后一帧导致跟 ResizeObserver/pinToBottom 的副作用错序.
  //
  // prevScrollHeightRef / prevScrollTopAtLoadRef 在两段都 set, 与 handleScroll
  // 完全对称, 让 F-SYNC-2 effect 的 anchoring 检测 + fallback 补偿正常工作.
  // 当前触发条件下 (scrollH===clientH) scrollTop 必为 0, 视觉收敛主要靠 line 716
  // 的 pinToBottom effect, 这两个 ref 在这是防御层 (避免 IPC race window 里
  // handleScroll 误覆盖 ref 用错快照 → F-SYNC-2 算错 delta).
  const autoLoadAttemptCountRef = useRef<number>(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (visibleRenderItems.length === 0) return; // first-paint 之前不判

    // hasMoreMessages / isLoadingMore 是 props 上的可选 boolean, 统一规整成 boolean
    // 再喂给 helper (否则 TS narrow 跨 OR 短路失效).
    const action = decideAutoFillAction({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      windowAtTop,
      hasMoreMessages: hasMoreMessages ?? false,
      isLoadingMore: isLoadingMore ?? false,
      attemptCount: autoLoadAttemptCountRef.current,
    });

    switch (action) {
      case 'expand-window': {
        prevScrollHeightRef.current = el.scrollHeight;
        prevScrollTopAtLoadRef.current = el.scrollTop;
        expandWindow();
        return;
      }
      case 'load-from-db': {
        if (!onLoadMore) return; // 父没接 onLoadMore (理论上 decideAutoFillAction
        // 不应在这种情况下返 'load-from-db', 这里防御一下)
        autoLoadAttemptCountRef.current += 1;
        prevScrollHeightRef.current = el.scrollHeight;
        prevScrollTopAtLoadRef.current = el.scrollTop;
        onLoadMore();
        return;
      }
      case 'none':
        // render-window-bidirectional: 锚定窗口未覆盖末尾且内容不溢出时，
        // expandWindow 只向前扩（向最早方向）、保持窗口尾边不变；对向后
        // 方向（锚点后的内容）没有帮助。这里从尾部扩 anchoredForwardItems
        // 把锚点后内容逐步纳入 DOM，直到视口撑出滚动条或窗口触及全量末尾。
        if (
          firstVisibleItemKey !== null &&
          !windowCoversEnd &&
          Math.abs(el.scrollHeight - el.clientHeight) <= NO_SCROLL_TOLERANCE_PX
        ) {
          setAnchoredForwardItems((prev) => prev + RENDER_WINDOW_GROWTH_ITEMS);
        }
        return;
    }
  }, [
    visibleRenderItems.length,
    bottomPadding,
    hasMoreMessages,
    isLoadingMore,
    onLoadMore,
    windowAtTop,
    expandWindow,
    windowCoversEnd,
    firstVisibleItemKey,
  ]);

  // ── F2 / new-message-indicator ──
  // `isNearBottomRef` 驱动 auto-follow 判定；`isNearBottom` state 只驱动按钮
  // 显隐（两者同步更新，任何路径都不允许只更新其中一个）。
  // `unreadCount` 在"已离底 + 新 assistant/ask_user/plan_review 消息到达"时递增，
  // 点击按钮 / 自动回底 / 切换会话 → 归零。
  const [isNearBottom, setIsNearBottom] = useState<boolean>(true);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  /** 上一次 render 已见过的 clientId 集合，用于 O(n) diff 出"首次出现"的消息。 */
  const prevMessageIdsRef = useRef<Set<string>>(new Set());

  // ── 意图解除 auto-follow ──
  // wheel 上滚 / 触摸下拉 / PageUp 等历史导航键只有用户能产生(程序化 scrollTop
  // 赋值不发这些事件),在事件层直接解除跟随:不经过 scroll 事件,不受
  // programmaticScrollRef 竞态影响,也不看距离阈值 — 上滚一行(哪怕 1px)立即
  // 停止自动滚动。距离阈值只保留给「恢复跟随」与滚动条拖拽的解除兜底
  // (见 autoFollowIntent.ts 模块注释与 handleScroll)。
  // 是否构成解除条件由各事件路径的纯函数判定(shouldUnpinOnWheel /
  // shouldUnpinOnUpIntent),本回调只负责翻转:ref 与 state 同步更新(F2 不
  // 变量);unreadCount 不动 — 它只在回底时清零。
  const unpinAutoFollowForUserUpIntent = useCallback(() => {
    if (!isNearBottomRef.current) return;
    isNearBottomRef.current = false;
    setIsNearBottom(false);
  }, []);

  // ── jump-to-bottom chip ──
  // 用户向下滚动且未到底时显示扁平的"跳到底部" chip,2s 内无滚动自动隐藏。
  // 与 NewMessageIndicator 互斥(它有未读时优先)。state 用 setter 直接控制,
  // timer 走 ref 持有句柄方便 reset / cleanup。
  const [showJumpDown, setShowJumpDown] = useState(false);
  const jumpDownIdleTimerRef = useRef<number | null>(null);

  // 卸载时清掉 idle timer 防泄漏
  useEffect(
    () => () => {
      if (jumpDownIdleTimerRef.current !== null) {
        window.clearTimeout(jumpDownIdleTimerRef.current);
        jumpDownIdleTimerRef.current = null;
      }
    },
    [],
  );

  // ── chip-jump expand/load 抑制 ──
  // chip click 跳转的 smooth scroll 期间,如果路径穿过 scrollTop<50 会触发
  // expandWindow/onLoadMore,叠加 F-SYNC-2 的 scrollTop+=delta 会把 viewport
  // 拽向不可预期位置(疑为"长距离跳转踹回底"现象的源头,见 13:12 日志分析)。
  // 抑制策略:click 时设 ref,任何**用户主动滚动意图**(wheel/touch/PageUp 等)
  // 立刻解抑,smooth scroll 自身不发这些事件,所以 race 期间稳定抑制,用户一
  // 动手就立即通行 — 不会卡住"用 chip 连点上翻"或"跳完立刻 wheel 看更老历史"。
  // 3s safety timer 兜底,应对极端 case(用户 click 后既不滚也不动键盘)。
  const chipJumpInProgressRef = useRef<boolean>(false);
  const chipJumpClearTimerRef = useRef<number | null>(null);
  const userHistoryTouchStartYRef = useRef<number | null>(null);
  const userIntentLoadInFlightRef = useRef<boolean>(false);
  const clearChipJumpSuppression = useCallback(() => {
    if (chipJumpInProgressRef.current) {
      chipJumpInProgressRef.current = false;
    }
    if (chipJumpClearTimerRef.current !== null) {
      window.clearTimeout(chipJumpClearTimerRef.current);
      chipJumpClearTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    return () => {
      if (chipJumpClearTimerRef.current !== null) {
        window.clearTimeout(chipJumpClearTimerRef.current);
        chipJumpClearTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (isLoadingMore !== true) {
      userIntentLoadInFlightRef.current = false;
    }
  }, [isLoadingMore]);
  const triggerUserIntentFill = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (visibleRenderItems.length === 0) return; // first-paint 之前不判
    if (chipJumpInProgressRef.current) return;

    const action = decideUserIntentFillAction({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      windowAtTop,
      hasMoreMessages: hasMoreMessages ?? false,
      isLoadingMore: (isLoadingMore ?? false) || userIntentLoadInFlightRef.current,
    });

    switch (action) {
      case 'expand-window': {
        prevScrollHeightRef.current = el.scrollHeight;
        prevScrollTopAtLoadRef.current = el.scrollTop;
        expandWindow();
        return;
      }
      case 'load-from-db': {
        if (!onLoadMore) return;
        userIntentLoadInFlightRef.current = true;
        prevScrollHeightRef.current = el.scrollHeight;
        prevScrollTopAtLoadRef.current = el.scrollTop;
        onLoadMore();
        return;
      }
      case 'none':
        return;
    }
  }, [
    visibleRenderItems.length,
    windowAtTop,
    hasMoreMessages,
    isLoadingMore,
    onLoadMore,
    expandWindow,
  ]);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // wheel/touchstart 挂在 scroll 容器上(与上 chip 抑制对称)。容器不可滚时
    // 不会产生 scroll 事件,所以用户继续向上滚动的意图必须在这里接住。
    const onWheel = (event: WheelEvent) => {
      clearChipJumpSuppression();
      if (event.deltaY < 0) {
        if (hasNestedScrollableAncestorThatCanScrollUp(root, event.target)) return;
        if (
          shouldUnpinOnWheel({
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
          })
        ) {
          unpinAutoFollowForUserUpIntent();
        }
        triggerUserIntentFill();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      clearChipJumpSuppression();
      userHistoryTouchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const startY = userHistoryTouchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY == null || currentY == null) return;
      if (currentY - startY > TOUCH_HISTORY_INTENT_THRESHOLD_PX) {
        userHistoryTouchStartYRef.current = currentY;
        if (hasNestedScrollableAncestorThatCanScrollUp(root, event.target)) return;
        if (
          shouldUnpinOnUpIntent({
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
          })
        ) {
          unpinAutoFollowForUserUpIntent();
        }
        triggerUserIntentFill();
      }
    };
    const onTouchEnd = () => {
      userHistoryTouchStartYRef.current = null;
    };
    root.addEventListener('wheel', onWheel, { passive: true });
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: true });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    root.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [clearChipJumpSuppression, triggerUserIntentFill, unpinAutoFollowForUserUpIntent]);
  useEffect(() => {
    const onHistoryNavigationKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!HISTORY_NAVIGATION_KEYS.has(event.key)) return;
      if (isEditableKeyboardTarget(event.target)) return;
      clearChipJumpSuppression();
      const el = scrollRef.current;
      if (
        el &&
        shouldUnpinOnUpIntent({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })
      ) {
        unpinAutoFollowForUserUpIntent();
      }
      triggerUserIntentFill();
    };
    window.addEventListener('keydown', onHistoryNavigationKey);
    return () => {
      window.removeEventListener('keydown', onHistoryNavigationKey);
    };
  }, [clearChipJumpSuppression, triggerUserIntentFill, unpinAutoFollowForUserUpIntent]);
  useNavigationKeyListener(clearChipJumpSuppression);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    suppressScrollbarActivation(el);
    el.scrollTop = el.scrollHeight;
    // Clear the flag on the next frame — after the browser has dispatched
    // the resulting scroll event. We use rAF (not a microtask) because the
    // scroll event is dispatched asynchronously.
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  // F3: 平滑滚到底的按钮回调。
  //   - 乐观更新 unreadCount / isNearBottom / isNearBottomRef → 按钮同一 tick fade-out
  //   - programmaticScrollRef 打开 → scroll handler 在动画期间不会误判为"用户上滚"
  //   - 原生 smooth 由浏览器接管（~300ms），不手写 rAF
  //   - 动画期间 ResizeObserver 仍可正常 pinToBottom，auto-follow 无缝接入
  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setUnreadCount(0);
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    programmaticScrollRef.current = true;
    // render-window-bidirectional: 清除锚点回到默认尾部窗口（chip/jump-down 语义）。
    setFirstVisibleItemKey(null);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  // F2: messages diff → 按角色累计 unreadCount
  //   - 用 Set 做 O(n) diff，流式 token 追加（同一 clientId 的 content 变化）不计数
  //   - 只在 isNearBottomRef.current === false 时累计；底部时 auto-follow 接手
  //   - 角色过滤：user / tool_use / tool_result 跳过；assistant / ask_user / plan_review 计数
  useEffect(() => {
    const prev = prevMessageIdsRef.current;
    const currentIds = new Set<string>();
    let addedVisible = 0;

    for (const m of messages) {
      currentIds.add(m.clientId);
      if (prev.has(m.clientId)) continue;
      // 新出现的 clientId：按角色过滤
      if (m.role === 'assistant' || m.role === 'ask_user' || m.role === 'plan_review') {
        if (!isNearBottomRef.current) addedVisible += 1;
      }
    }

    if (addedVisible > 0) {
      setUnreadCount((c) => c + addedVisible);
    }
    prevMessageIdsRef.current = currentIds;
  }, [messages]);

  // ── Synchronous pin-to-bottom on every relevant change. ──
  // useLayoutEffect fires before paint, so a new message / bottomPadding change
  // never flashes at the old scroll position. Runs on:
  //   • initial mount (keyed by sessionId in parent → one fresh run per session)
  //   • messages reference change (new token, new card, etc.)
  //   • bottomPadding change (overlay re-measured after Plan Viewer expand etc.)
  // ResizeObserver below is a safety net for async height growth *after* paint
  // (markdown render finish, image/code-highlight completion).
  //
  // Special case: when the user hits send, a fresh user-role message appears
  // at the tail. We force auto-follow back on regardless of whether the user
  // had scrolled up — committing a new turn is an explicit intent to see the
  // result land.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bottomPadding 是触发型依赖；overlay 高度变化时即使 effect 内不读取它，也必须重新 pin 到底。
  useLayoutEffect(() => {
    const visibleLastItem = visibleRenderItems[visibleRenderItems.length - 1];
    const realLastItem = allRenderItems[allRenderItems.length - 1];
    const tailUserMessageId = selectTailUserMessageId({
      windowCoversEnd,
      visibleLastItem,
      realLastItem,
      userMessageId: (item) =>
        item?.type === 'message' && item.message.role === 'user'
          ? item.message.clientId
          : null,
    });
    const lastUserMsg =
      tailUserMessageId === null
        ? null
        : realLastItem?.type === 'message' && realLastItem.message.clientId === tailUserMessageId
          ? realLastItem.message
          : visibleLastItem?.type === 'message' &&
              visibleLastItem.message.clientId === tailUserMessageId
            ? visibleLastItem.message
            : null;

    // 锚定窗口外检测到真实的新发送：当前 effect 的 visibleRenderItems 仍是旧切片，
    // 不能同帧 pinToBottom。先清锚并恢复 near-bottom，下一次 render 切回默认尾窗
    // 后再自然 pin；提前同步 lastUserMsgIdRef，防下一帧重复判成新发送。
    let windowAnchorClearedOnSend = false;
    const realTailUserSendOutsideWindow =
      !restoringRef.current &&
      firstVisibleItemKey !== null &&
      !windowCoversEnd &&
      lastUserMsg !== null &&
      lastUserMsg.clientId !== lastUserMsgIdRef.current;
    if (realTailUserSendOutsideWindow) {
      setFirstVisibleItemKey(null);
      isNearBottomRef.current = true;
      setIsNearBottom(true);
      setUnreadCount(0);
      lastUserMsgIdRef.current = lastUserMsg.clientId;
      windowAnchorClearedOnSend = true;
    }
    const userMessageObservation = resolveLastUserMessageObservation({
      restoring: restoringRef.current,
      tailUserMessageId: lastUserMsg?.clientId ?? null,
      previousTailUserMessageId: lastUserMsgIdRef.current,
    });
    if (!windowAnchorClearedOnSend) {
      lastUserMsgIdRef.current = userMessageObservation.baselineUserMessageId;
    }
    const decision = resolveRenderPinDecision({
      restoring: restoringRef.current,
      newUserSend: userMessageObservation.isNewUserSend,
      nearBottom: isNearBottomRef.current,
    });

    if (userMessageObservation.isNewUserSend && lastUserMsg) {
      lastUserMsgIdRef.current = lastUserMsg.clientId;
    }
    if (decision.clearRestoring) {
      restoringRef.current = false;
      isNearBottomRef.current = true;
    }
    if (decision.pinToBottom && !windowAnchorClearedOnSend) pinToBottom();

    const el = scrollRef.current;
    if (el) prevScrollTopRef.current = el.scrollTop;
  }, [visibleRenderItems, bottomPadding, pinToBottom, firstVisibleItemKey, windowCoversEnd, allRenderItems]);

  // ── 还原浏览位置(layout effect,在上面的 pin-to-bottom effect 之后跑) ──
  // mount 首帧 + 还原期间窗口变化时把视口摆回锚点。settle(图片/markdown 异步加载
  // 改变高度但不改 visibleRenderItems)由下方 ResizeObserver 兜底纠偏。
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleRenderItems 是触发型依赖；扩窗/加载历史后需要按最新 DOM 重新 applyRestore。
  useLayoutEffect(() => {
    if (!restoringRef.current) return;
    applyRestore();
  }, [visibleRenderItems, applyRestore]);

  // ── Continuous auto-follow via ResizeObserver. ──
  // Catches every source of content-height growth:
  //   • streaming tokens appending to an assistant message
  //   • tool cards / plan viewer expanding
  //   • markdown / code-highlighting / image loads finalizing async
  //   • bottomPadding changes (status bar, ask prompts)
  // As long as the user hasn't scrolled up, we keep scrollTop pinned to
  // scrollHeight. This replaces the old "scroll on messages/bottomPadding
  // change" effect, which missed async height settles.
  //
  // 例外:卡片内用户点击"展开详情"(CARD_EXPAND_TOGGLE_EVENT 冒泡上来)。
  // 这是"就地看内容"的意图,贴底时若照常 pin-to-bottom,展开区的高度会把
  // 卡片头部顶出视口上方,看起来像"往上展开"。收到事件后开一个短抑制窗口,
  // 窗口内的高度变化不 pin(scrollTop 不动 = 展开区自然向下铺开);窗口一过
  // auto-follow 原样恢复,流式跟随不受影响。
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let suppressPinUntil = 0;
    const onCardExpandToggle = () => {
      suppressPinUntil = performance.now() + CARD_EXPAND_PIN_SUPPRESS_MS;
    };
    content.addEventListener(CARD_EXPAND_TOGGLE_EVENT, onCardExpandToggle);
    const ro = new ResizeObserver(() => {
      // 还原中:内容高度因异步渲染 settle 时,持续按锚点纠偏(直到用户手动滚动接管)。
      if (restoringRef.current) {
        applyRestoreRef.current();
        return;
      }
      if (performance.now() < suppressPinUntil) return;
      if (isNearBottomRef.current) pinToBottom();
    });
    ro.observe(content);
    return () => {
      content.removeEventListener(CARD_EXPAND_TOGGLE_EVENT, onCardExpandToggle);
      ro.disconnect();
    };
  }, [pinToBottom]);

  // F-SYNC-2 + render-window: Preserve scroll position after either
  //   (a) DB prepend (messages 数组前端追加,触发 isLoadingMore false → render)
  //   (b) 客户端扩窗 (firstVisibleItemKey 前移,visibleRenderItems 头部增长)
  // 两者本质都是"DOM 顶部增长,需要把 scrollTop 加上 delta",共用同一段恢复逻辑。
  // 依赖 visibleRenderItems —— 它的引用变化 = DOM 顶部可能变化,触发器一致。
  //
  // ── 浏览器 scroll anchoring 双补偿防御 ──
  //
  // Chromium 默认开启 `overflow-anchor`,顶部 prepend 内容时**自动**调整 scrollTop
  // 让 viewport 视觉锚点不漂。这条跟 F-SYNC-2 的 `scrollTop += delta` 做同一件事 ——
  // 两者叠加 = scrollTop 被加了 2 倍 delta,viewport 直接被推到底。
  //
  // 防御:effect 入口比对实际 scrollTop 增量与内容高度增量。anchoring 真生效时,
  // 浏览器为保持锚点元素视觉位置,scrollTop 增量应该 ≈ 内容高度增量(delta)。
  // 若两者接近(差值在容差内),说明 anchoring 已经把 delta 加过了 → skip 手动补偿。
  //
  // 容差 ANCHORING_TOLERANCE_PX=50:anchoring 在 viewport 内找锚点元素时,如果锚点
  // 不是完美贴顶会有几十 px 偏差,留出空间。比"scrollTop > snapshot + 8" 那种宽松
  // 判断严格得多 — 反例(用户在 onLoadMore→effect 间隙手动下滑、其它 programmatic
  // scroll 等)产生的 scrollTop 增量是随意值,极少恰好 ≈ delta,基本不会误判。
  //
  // 不直接关 scroll anchoring(CSS overflow-anchor:none) — 那会让 tool 卡展开 /
  // 图片异步加载 / markdown 异步渲染等"viewport 上方内容增长"场景失去稳定性,而
  // F-SYNC-2 只 cover visibleRenderItems 变化路径,接不住其它来源。保留 anchoring +
  // 检测后跳过是最小副作用方案。
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleRenderItems 是触发型依赖；DOM 顶部增长后需要重新检测 scroll anchoring。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isLoadingMore) return;

    if (prevScrollHeightRef.current > 0) {
      const newScrollHeight = el.scrollHeight;
      const delta = newScrollHeight - prevScrollHeightRef.current;
      // [mr-16 review #1] 判定从"scrollTop > snapshot + 8"收紧成"scrollTop 增量
      // ≈ delta",避免在 onLoadMore → effect 间隙若有其它 scrollTop 写入(用户
      // 手动下滑、其它 programmatic 路径)导致误判 anchoring 已生效 → 漏补偿 →
      // viewport 跳变。具体规则与边界 case 见 scrollAnchoringDetect.ts + test。
      const anchoringApplied = detectScrollAnchoringApplied({
        prevScrollHeight: prevScrollHeightRef.current,
        prevScrollTop: prevScrollTopAtLoadRef.current,
        currentScrollHeight: newScrollHeight,
        currentScrollTop: el.scrollTop,
      });
      if (delta > 0 && !anchoringApplied) {
        // anchoring 没生效(viewport 内没合适锚点元素时 Chromium 会跳过自动调整),
        // 由 F-SYNC-2 手动补偿,行为同原版。
        programmaticScrollRef.current = true;
        el.scrollTop += delta;
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }
      // anchoringApplied=true 分支无操作 — 浏览器 anchoring 已把 viewport 摆好。
      prevScrollHeightRef.current = 0;
      prevScrollTopAtLoadRef.current = 0;
    }
  }, [visibleRenderItems, isLoadingMore]);

  // ── post-load auto-expand ──
  // 修一类已知 UX 缺口 (跟 render-window 轴换轴无关,老代码同病):
  //   用户滚到顶 → handleScroll 触发 onLoadMore → DB prepend 进 messages →
  //   allRenderItems 增长但 visibleRenderItems 因为锚点 firstVisibleItemKey 不动
  //   而内容不变 → DOM 高度也不变 → 用户停在 scrollTop=0,wheel up 不产生 scroll
  //   event → handleScroll 不再 fire → 新加载的更老 item 卡在内存里看不到。
  //
  // 触发器: isLoadingMore 从 true → false 的边沿 + windowAtTop=false (说明 load
  // 确实带回了新内容,只是被锚点切在外面)。fire 一次 expandWindow,同时设
  // prevScrollHeightRef 快照让上面 F-SYNC-2 effect 在 *下一个* commit (expand
  // 的 state setter 触发的) 里读到 expand 前的高度算 delta 做 scroll 恢复 ——
  // 用户原本看的内容仍在原 viewport 位置,新内容在它上方可被 wheel up 滚进去。
  //
  // 与 viewport-fill auto-fill effect 正交: 那条只在 scrollH===clientH 时 fire
  // (防"完全不可滚"死锁),这里覆盖"可滚但新内容不在视野"的另一类。两者
  // 同 commit 都 fire expand 是安全的 — expandWindow 幂等 (同一 firstVisibleItemKey
  // 快照下计算的目标 anchor 相同, React 批处理后 net 等价单次)。
  //
  // 注册位置必须在 F-SYNC-2 之后: 同 commit 里 F-SYNC-2 先跑会清空
  // prevScrollHeightRef (delta=0,因为 DOM 没变),我们再 set 新快照才能让下个
  // commit 的 F-SYNC-2 算到 expand 引入的 delta。useEffect 同序按声明顺序触发。
  const prevIsLoadingMoreRef = useRef<boolean>(false);
  useEffect(() => {
    const wasLoading = prevIsLoadingMoreRef.current;
    const isNowDone = isLoadingMore === false;
    prevIsLoadingMoreRef.current = isLoadingMore === true;

    if (!wasLoading || !isNowDone) return;
    if (windowAtTop) return; // load 实际没带新 item (DB 返空 / 已被同 commit 其它 expand 消化)

    const el = scrollRef.current;
    if (!el) return;
    prevScrollHeightRef.current = el.scrollHeight;
    prevScrollTopAtLoadRef.current = el.scrollTop;
    expandWindow();
  }, [isLoadingMore, windowAtTop, expandWindow]);

  // F-SYNC-2 + F2: 跟随态的 scroll 事件侧迁移。
  //
  // 「解除跟随」的主路径在事件层(wheel / touch / 键盘意图 →
  // unpinAutoFollowForUserUpIntent,见上),不在这里 — scroll 事件在流式期间
  // 与 pinToBottom 高频竞态(小幅上滚永远越不过距离阈值就被钉回,且
  // programmaticScrollRef 窗口会吞掉部分用户 scroll 事件),距离判定对
  // 「上滚一行就停」不可靠。本 handler 只负责:
  //   - 离底 >= threshold → 解除(滚动条拖拽等无 wheel 事件路径的兜底);
  //   - 已解除 + 明确向下滚回阈值带内 → 恢复跟随。
  // 迁移规则收敛在 resolveNearBottomOnScroll(纯函数,见 autoFollowIntent.ts)。
  // `isNearBottomRef`(auto-follow gate)与 `isNearBottom` state(指示器显隐)
  // 仍在同一分支同步更新,不允许失步。
  //
  // Programmatic scrolls (pinToBottom / scrollToBottomSmooth / load-more
  // restore) bypass all state updates — they are our own writes and must not
  // be read back as user intent. `prevScrollTopRef` is kept only for the
  // load-more prepend restore path further down.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const currentScrollTop = el.scrollTop;
    const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;
    const threshold = 100;

    if (!programmaticScrollRef.current) {
      // 用户手动滚动 = 接管浏览,退出「还原中」,后续恢复正常 auto-follow 判定。
      restoringRef.current = false;
      // 持续保存当前浏览位置(rAF 节流,DOM 必然存活)。不依赖 unmount 时机,
      // 规避「React passive cleanup 在 DOM 移除后才跑、量测拿到 null」的坑。
      if (saveRafRef.current === null) {
        saveRafRef.current = requestAnimationFrame(() => {
          saveRafRef.current = null;
          saveScrollSnapshot();
        });
      }
      // 方向增量 — 比较当前 scrollTop 与 prevScrollTopRef(在本函数末尾才会被
      // 覆盖,这里读的还是上一次值)。跟随态迁移与 jump-down chip 共用。
      // programmatic scroll 不进本分支 — auto-follow 自己滚不该参与判定。
      const delta = currentScrollTop - prevScrollTopRef.current;

      // F2: 跟随态迁移(规则见 resolveNearBottomOnScroll 注释)。恢复跟随要求
      // 明确向下滚 — 意图解除(wheel 上滚)后紧跟着的上滚 scroll 事件距底仍
      // < threshold,只看距离会把刚解除的跟随立刻翻回去。
      // ref (auto-follow) 与 state (按钮显隐) 在同一分支同步，永不失步。
      // unreadCount 仅在"从非底 → 底"的翻转瞬间清零，避免已累计未读被吞。
      const nowNearBottom = resolveNearBottomOnScroll({
        wasNearBottom: isNearBottomRef.current,
        distanceFromBottom,
        scrollDelta: delta,
        thresholdPx: threshold,
        directionDeadZonePx: SCROLL_DIRECTION_DEAD_ZONE_PX,
      });
      // render-window-bidirectional 要点 3: 窗口未覆盖末尾时强制判为非贴底。
      // 否则 DOM 距底 <100px 会被误判成"贴底"，auto-follow 拽回底部、jump-down chip 不出现。
      const effectiveNearBottom = !windowCoversEnd ? false : nowNearBottom;
      if (effectiveNearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = effectiveNearBottom;
        setIsNearBottom(effectiveNearBottom);
        if (effectiveNearBottom) setUnreadCount(0);
      }
      // render-window-bidirectional P1 fix: 锚定窗口覆盖末尾 + 用户到达底部 →
      // 切回默认尾窗。必须在 handleScroll 里而不是 layout effect 里做——
      // 用户从"向上扩窗"滚回底部时 wasCovering 从始至终为 true，layout effect 捕不到。
      if (effectiveNearBottom && firstVisibleItemKey !== null && windowCoversEnd) {
        setFirstVisibleItemKey(null);
      }
      if (effectiveNearBottom) {
        // 到底了:无论方向都隐藏 chip,清掉 timer
        if (jumpDownIdleTimerRef.current !== null) {
          window.clearTimeout(jumpDownIdleTimerRef.current);
          jumpDownIdleTimerRef.current = null;
        }
        setShowJumpDown((cur) => (cur ? false : cur));
      } else if (delta > SCROLL_DIRECTION_DEAD_ZONE_PX) {
        // 向下滚 + 未到底:显示 chip,reset idle timer
        setShowJumpDown((cur) => (cur ? cur : true));
        if (jumpDownIdleTimerRef.current !== null) {
          window.clearTimeout(jumpDownIdleTimerRef.current);
        }
        jumpDownIdleTimerRef.current = window.setTimeout(() => {
          jumpDownIdleTimerRef.current = null;
          setShowJumpDown(false);
        }, JUMP_DOWN_IDLE_MS);
      } else if (delta < -SCROLL_DIRECTION_DEAD_ZONE_PX) {
        // 向上滚:立即隐藏 chip(用户改变方向了,跳底意图消失)
        if (jumpDownIdleTimerRef.current !== null) {
          window.clearTimeout(jumpDownIdleTimerRef.current);
          jumpDownIdleTimerRef.current = null;
        }
        setShowJumpDown((cur) => (cur ? false : cur));
      }

      // render-window-bidirectional 要点 5: 向下扩窗。
      // 用户向下滚动接近当前窗口下缘时，扩 anchoredForwardItems 纳入更多 item。
      // 向下 append 不改变已有内容的滚动偏移，不需要 F-SYNC-2 delta 补偿。
      // 扩到覆盖末尾后直接清除锚点，回到默认贴底窗口。
      if (!windowCoversEnd && delta > SCROLL_DIRECTION_DEAD_ZONE_PX && distanceFromBottom < threshold) {
        const nextForward = anchoredForwardItems + RENDER_WINDOW_GROWTH_ITEMS;
        // 最后一批照常渲染：不在此处清除锚点。用户真正滚到窗口底部后，
        // 上面 effectiveNearBottom + windowCoversEnd 分支会自然清除锚点、
        // 切回默认尾窗并恢复 near-bottom 状态。
        setAnchoredForwardItems(nextForward);
      }
    }
    prevScrollTopRef.current = currentScrollTop;

    // F3: smooth 滚动完成后清除 programmaticScrollRef，让后续用户滚动能被正确识别。
    //   - 判据：距底 < 5px（smooth 动画收敛后的稳定值）+ 当前处于 programmatic 态
    //   - 用 rAF 推迟一帧，避免连续 smooth 滚动的尾帧事件被误判
    if (programmaticScrollRef.current && distanceFromBottom < 5) {
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    }

    // 滚到顶 50px 内才触发后续加载逻辑(阈值与 decideUserIntentFillAction 的
    // "停在顶部"判定共用 TOP_HISTORY_TRIGGER_PX,两条路径合起来覆盖
    // "穿过顶部区间"与"停在顶部继续上滚"的完整触发面)
    if (el.scrollTop >= TOP_HISTORY_TRIGGER_PX) return;

    // chip jump 期间抑制 — chip click 是导航语义不是"想加载更多",而且 smooth
    // 路径穿过顶部时叠加 F-SYNC-2 的 scrollTop+=delta 可能把 viewport 拽飞
    // (长距离跳转踹回底嫌疑)。用户主动 wheel/touch/keydown 会立刻清掉这个 ref
    // (见 mount effect 里的监听),所以"跳完立刻继续往上翻"完全 OK。
    if (chipJumpInProgressRef.current) {
      return;
    }

    // 二段式加载:
    //   1. 内存里还有比当前窗口更早的消息 → 客户端扩窗(无 IPC,即时)
    //   2. 窗口已经覆盖到内存最早的消息,且 DB 还有更老历史 → 走 onLoadMore 拉 DB
    // prevScrollHeightRef 给 F-SYNC-2 + render-window 的统一 scroll 恢复用。
    if (!windowAtTop) {
      prevScrollHeightRef.current = el.scrollHeight;
      prevScrollTopAtLoadRef.current = el.scrollTop;
      expandWindow();
      return;
    }

    if (!onLoadMore || isLoadingMore || !hasMoreMessages) return;
    prevScrollHeightRef.current = el.scrollHeight;
    prevScrollTopAtLoadRef.current = el.scrollTop;
    onLoadMore();
  }, [
    onLoadMore,
    isLoadingMore,
    hasMoreMessages,
    windowAtTop,
    expandWindow,
    saveScrollSnapshot,
    windowCoversEnd,
    anchoredForwardItems,
    visibleStartIdx,
    allRenderItems.length,
    setFirstVisibleItemKey,
    setAnchoredForwardItems,
  ]);

  // 渲染窗口下移到 render-item 轴后,U2 "末尾窗口全是 orphan tool_result"
  // 死锁不可能复现:`buildRenderItems(messages)` 喂全量 → orphan / ask_user /
  // AskUserQuestion / ExitPlanMode 在 Pass 2 就被丢弃,绝不会出现在
  // `allRenderItems` 末尾。`visibleRenderItems = slice(-INITIAL_ITEMS)` 必然
  // 落在有效 item 上,自愈 effect 失去存在意义,随之删除(原 effect:
  // "renderItems 全空 → 自动扩窗",见 commit 05cafaa7)。
  // `allRenderItems` / `singleResultMap` 已在文件上方 useMemo 中声明并参与
  // visibleRenderItems / 窗口数学,这里无须再 build 一次。

  // ── prev-user-msg-jump ──
  // 滚动时右侧浮一个"↑ 上一条提问" pill,点击跳到对应 user 消息的顶端。
  // userMessageIds 从 visibleRenderItems 派生 — 保证 Chip 目标永远在 DOM 里,
  // scrollIntoView 直接可用,无需扩窗。user 消息总是单独 message item(不进
  // segment / 不被丢弃),所以这里只 unwrap type==='message' && role==='user'。
  // previewById 同源,截断/去噪都在 PrevMessageJumpChip 的 truncatePreview 里做。
  // 预览存显示文本而非原始 content:chip 是导航条缺席/截断时的兜底入口,其
  // title/aria 与刻度预览承担同一职责,hook 消息的隐藏 prompt/<thread_context>
  // 与 Orca 行的 JSON 原文同样不能裸奔(userMessageDisplayText,PR #830 review)。
  const { userMessageIds, previewById } = useMemo(() => {
    const ids: string[] = [];
    const map = new Map<string, string>();
    for (const it of visibleRenderItems) {
      if (it.type !== 'message' || it.message.role !== 'user') continue;
      // 合成指令行渲染 null,没有对应 DOM 元素,chip 指向它 scrollIntoView 会
      // 静默失效(review P2)。
      if (it.message.isSyntheticTrigger) continue;
      ids.push(it.message.clientId);
      map.set(it.message.clientId, resolveUserDisplayText(it.message));
    }
    return { userMessageIds: ids, previewById: map };
  }, [visibleRenderItems]);

  const { displayId: prevUserMsgId, suppressAfterClick } = usePrevUserMessageInView({
    scrollRef,
    userMessageIds,
    resetKey: sessionId,
  });

  const handleJumpToPrevUserMsg = useCallback(() => {
    const root = scrollRef.current;
    if (!root || !prevUserMsgId) return;
    const el = root.querySelector(
      `[data-user-msg-id="${CSS.escape(prevUserMsgId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    suppressAfterClick();
    // expand/load 抑制:smooth scroll 期间路径如果穿过 scrollTop<50,handleScroll
    // 会触发 expandWindow/onLoadMore + F-SYNC-2 scrollTop+=delta,这条 race 可能
    // 把 viewport 拽飞。设 ref 让 handleScroll 跳过那分支。解抑靠 wheel/touch/
    // keydown(在上面 useEffect 里挂的监听),用户一动手就过去,不会卡"用 chip
    // 连点上翻"或"跳完立刻 wheel 看更老历史"。
    chipJumpInProgressRef.current = true;
    if (chipJumpClearTimerRef.current !== null) {
      window.clearTimeout(chipJumpClearTimerRef.current);
    }
    chipJumpClearTimerRef.current = window.setTimeout(() => {
      chipJumpClearTimerRef.current = null;
      clearChipJumpSuppression();
    }, CHIP_JUMP_SAFETY_MS);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [prevUserMsgId, suppressAfterClick, clearChipJumpSuppression]);

  const prevPreview = prevUserMsgId ? firstNonEmptyLine(previewById.get(prevUserMsgId) ?? '') : '';

  // chip 是否需要在右上角栈里出场。栈容器(TopRightChipStack)接管定位,
  // 所以不再需要旧的"通知父级 DiffToggle 让位"那套互斥 —— DiffToggle 与
  // chip 在栈里各占一行,自然共存。
  const prevUserMsgVisible = prevUserMsgId !== null;

  // ── message-nav-rail ──
  // 左缘"提问导航条":条目覆盖**全量已加载** messages(不同于 chip 的窗口内
  // 派生 —— 导航条要给整段历史画刻度)。目标可能在渲染窗口外,跳转走下面的
  // layout effect:复用 focus-jump 的"先扩窗到目标、下一轮再滚动"两段式,
  // 以及 chip-jump 的 expandWindow/onLoadMore 抑制协议。
  // 导航条是个性化可选功能(Settings → 个性化 → 小技巧),默认关闭;关闭时
  // 不挂载组件(卸载时组件自会把 navRailCoversNav 报回 false,chip 兜底回归),
  // 也不做下面的空闲补页。
  const { enabled: navRailEnabled } = useMessageNavRailPreference();
  const navRailEntries = useMemo(() => deriveNavRailEntries(messages), [messages]);

  // 入口去重:导航条**完整覆盖导航**(出场且刻度未截断)时抑制"跳到上一条
  // 提问"chip —— 同一个导航任务只保留一套入口。导航条缺席(短对话 / 窄窗 /
  // 矮视口)或截断了更早刻度的超长会话里 chip 回归兜底(PR #830 review)。
  const [navRailCoversNav, setNavRailCoversNav] = useState(false);

  // ── nav-rail 空闲补页 ──
  // 老会话打开时只加载尾部切片,导航条(整段对话的地图)可能凑不齐条目。
  // 首屏落定后的空闲期沿现有 onLoadMore 通道自动向前补页,直到提问数达标 /
  // 翻到历史起点 / 轮数预算用完(目标与预算的设计依据见
  // shouldBackfillForNavRail 一族常量注释)。与"跳转补齐"同属程序化翻页,
  // prepend 的滚动补偿照走 F-SYNC-2 协议:调用前快照 scrollHeight/scrollTop。
  // 即使当下窗口太窄导航条没出场,补到的历史对搜索/上滚阅读同样有用,
  // 且有轮数预算封顶,不做 eligible 门控。但**用户显式关闭导航条**(个性化
  // 开关,默认关)时跳过:为一个不存在的 UI 自动翻页不符合默认克制,开关
  // 打开后本 effect 依赖变化会重新评估补页。
  // 调度 effect 的依赖含 sessionId(与 MessageNavRail 的 resetKey 同款惯例):
  // 两个会话的条目数 / hasMore 恰好相同且 onLoadMore 身份未变时,切会话也要
  // 取消旧会话待发的空闲回调、并按归零后的轮数预算为新会话重新评估
  // (Copilot review)。
  const navRailBackfillRoundsRef = useRef(0);
  useEffect(() => {
    navRailBackfillRoundsRef.current = 0;
  }, [sessionId]);
  useEffect(() => {
    if (!navRailEnabled) return;
    if (!onLoadMore) return;
    if (
      !shouldBackfillForNavRail({
        entryCount: navRailEntries.length,
        hasMoreMessages: hasMoreMessages ?? false,
        isLoadingMore: isLoadingMore ?? false,
        rounds: navRailBackfillRoundsRef.current,
      })
    ) {
      return;
    }
    const run = () => {
      const el = scrollRef.current;
      if (!el) return;
      navRailBackfillRoundsRef.current += 1;
      prevScrollHeightRef.current = el.scrollHeight;
      prevScrollTopAtLoadRef.current = el.scrollTop;
      onLoadMore();
    };
    // 空闲期执行,别跟首屏渲染 / 两段式扩窗抢主线程;测试等无 ric 环境退化。
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 300);
    return () => window.clearTimeout(id);
  }, [
    sessionId,
    navRailEnabled,
    navRailEntries.length,
    hasMoreMessages,
    isLoadingMore,
    onLoadMore,
  ]);

  const railJumpSeqRef = useRef(0);
  const [railJumpRequest, setRailJumpRequest] = useState<{ id: string; seq: number } | null>(null);
  const lastAppliedRailJumpRef = useRef(0);
  const handleNavRailJump = useCallback((clientId: string) => {
    railJumpSeqRef.current += 1;
    setRailJumpRequest({ id: clientId, seq: railJumpSeqRef.current });
  }, []);

  useLayoutEffect(() => {
    if (!railJumpRequest) return;
    if (lastAppliedRailJumpRef.current === railJumpRequest.seq) return;
    const targetKey = renderItemKeyForClientId(allRenderItems, railJumpRequest.id);
    if (!targetKey) {
      // 条目派生自 messages,拿不到 key 只可能是消息刚被删 / clear — 放弃本次。
      lastAppliedRailJumpRef.current = railJumpRequest.seq;
      return;
    }
    if (!visibleRenderItems.some((item) => item.key === targetKey)) {
      // 目标在渲染窗口外:先把窗口锚到目标。本 effect 因 visibleRenderItems
      // 变化重跑,下一轮走下面的滚动分支(focus-jump 同款两段式)。
      setFirstVisibleItemKey(targetKey);
      setAnchoredForwardItems(RENDER_WINDOW_FIRST_PAINT_ITEMS);
      return;
    }
    const root = scrollRef.current;
    if (!root) return;
    const el = root.querySelector(
      `[data-message-client-id="${CSS.escape(railJumpRequest.id)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    lastAppliedRailJumpRef.current = railJumpRequest.seq;
    // 从贴底态往上跳必须先解除 auto-follow 钉底,否则流式期间 pin effect 会把
    // 视口拽回底部(focus-jump 同款处理;chip 不需要是因为它只在已上滚时出现)。
    restoringRef.current = false;
    isNearBottomRef.current = false;
    setIsNearBottom(false);
    // smooth scroll 途经顶部区域时抑制 expandWindow/onLoadMore(chip-jump 协议,
    // 解抑靠用户 wheel/touch/keydown + 安全兜底 timer)。
    chipJumpInProgressRef.current = true;
    if (chipJumpClearTimerRef.current !== null) {
      window.clearTimeout(chipJumpClearTimerRef.current);
    }
    chipJumpClearTimerRef.current = window.setTimeout(() => {
      chipJumpClearTimerRef.current = null;
      clearChipJumpSuppression();
    }, CHIP_JUMP_SAFETY_MS);
    // 落点手动计算,不走 scrollIntoView:轮次跳转要让视口恰好框住
    // "提问 → 回答",提问顶边停在容器顶下方 12px;消息锚点通用的
    // scroll-mt-20(80px)是搜索跳转的上文语境预留,对本任务是漏出
    // 上一轮尾巴的噪音(设计依据见 NAV_RAIL_JUMP_TOP_OFFSET_PX 注释)。
    const targetTop =
      root.scrollTop +
      (el.getBoundingClientRect().top - root.getBoundingClientRect().top) -
      NAV_RAIL_JUMP_TOP_OFFSET_PX;
    root.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }, [railJumpRequest, allRenderItems, visibleRenderItems, clearChipJumpSuppression]);

  // 第一条 user 消息没有"上一条 assistant"作为 resumeSessionAt 锚点，
  // rewind 必然抛 NO_PRIOR_ASSISTANT。直接在 UI 层把按钮藏掉，避免无效点击。
  // 注意:这里要用全量 messages 而不是 visibleRenderItems —— "首条 user" 的语义
  // 是整段对话的首条,不是当前窗口的首条;且 messages 本身也只是已加载的尾部
  // 切片,还有老页未加载(hasMoreMessages)时不能把切片首条误判为对话首条
  // (判定逻辑与陷阱见 findFirstUserMessageClientId 注释)。
  const firstUserMessageClientId = useMemo(
    () => findFirstUserMessageClientId(messages, Boolean(hasMoreMessages)),
    [messages, hasMoreMessages],
  );

  // edit-last-message: 最后一条 user 消息才显示编辑入口(编辑 = rewind 到该条
  // + 重发,更早的消息会连带丢弃后续轮次,v1 不开放)。与 first 同理用全量
  // messages 判定,不受窗口分页影响。
  const lastUserMessageClientId = useMemo(() => findLastUserMessageClientId(messages), [messages]);
  // 含合成行的"最后一条用户侧输入":自愈重连行据此判断自己是不是仍在飞(见 helper 注释)。
  const lastUserInputClientId = useMemo(() => findLastUserInputClientId(messages), [messages]);

  const userTurnUsageDetailsByAssistantId = useMemo(() => {
    return collectAssistantTurnUsageDetails(messages, turnFinalAssistantClientIds);
  }, [messages, turnFinalAssistantClientIds]);

  // error-tail-banner:尾部未忽略的 error 行由输入框上方红条独家承载,流内需要
  // 知道"是不是最后一条"来跳过重复渲染。
  const lastMessageClientId =
    messages.length > 0 ? messages[messages.length - 1].clientId : undefined;
  const previousLocalFileRefsRef = useRef<readonly KnownLocalFileRef[]>([]);
  const localFileRefs = useMemo<readonly KnownLocalFileRef[]>(() => {
    return collectStableLocalFileRefs(messages, previousLocalFileRefsRef.current);
  }, [messages]);
  useEffect(() => {
    previousLocalFileRefsRef.current = localFileRefs;
  }, [localFileRefs]);

  // chip 垂直位置 — 用户要求贴在"Generating..." RunningStatusBar 那一行。
  // overlay 内部从下到上是:input box + 上方 10px gap + RunningStatusBar(约 28px)+
  // 32px 渐变蒙层。把 chip 挪进 overlay 内、center 大致对齐 status bar center,
  // 经验值 overlayHeight - 56(原 -60,2026-05-13 用户反馈再往上 4px)。
  // Math.max 兜底防极小 overlay 时 chip 跑出容器。
  const resolvedBottomPadding = bottomPadding ?? 200;
  const indicatorBottomOffset = Math.max(resolvedBottomPadding - 56, 12);

  // 「提及 → 兑现」关联(方案 2):从会话历史现算,软提示卡据此升级为召唤卡。
  // 引用缓存:内容不变时复用上一个 Map 引用——UserMessage 顶层订阅该
  // context,流式期间 messages 每批 delta 都换引用,不缓存会让全部历史
  // 消息每批 token 重渲一遍(ghostCallMapsEqual 注释有完整推导)。
  const ghostCallsByUserTurnRaw = useMemo(() => collectGhostCallsByUserTurn(messages), [messages]);
  const ghostCallsCacheRef = useRef(ghostCallsByUserTurnRaw);
  if (!ghostCallMapsEqual(ghostCallsCacheRef.current, ghostCallsByUserTurnRaw)) {
    ghostCallsCacheRef.current = ghostCallsByUserTurnRaw;
  }
  const ghostCallsByUserTurn = ghostCallsCacheRef.current;

  return (
    <ChatSessionFileProvider value={sessionFileValue}>
      <GhostFulfillmentContext.Provider value={ghostCallsByUserTurn}>
        <ImageGalleryContext.Provider value={sessionImageSrcs}>
          <div className="relative h-full w-full">
            {/* shell-first mount:外壳帧(消息树推迟一帧挂载)的品牌加载指示。
                挂在滚动容器外的 overlay 层,视口正中(absolute inset-0 center),
                不随滚动内容移动,也不参与 contentH / pin-to-bottom 计算。
                只在确有内容待挂时挂载;指示器自带延迟浮现(CSS animation-delay)
                —— 小会话下一帧就挂载完,指示器从未可见,不闪 loading。 */}
            {firstMountDeferred && messages.length > 0 && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <BrandLoadingMark />
              </div>
            )}
            {/* chat-text-quote:选中消息文字 → 浮出"添加到对话"按钮(portal 到 body)。
          绑定本流的滚动容器:协同模式多流并存时,选区归属按各自容器判定。 */}
            {sessionId ? (
              <SelectionQuoteButton sessionId={sessionId} containerRef={scrollRef} />
            ) : null}
            {/*
        原生滚动容器:overflow-y-auto + overflow-x-hidden。
        - 滚动条样式由 globals.css 的 ::-webkit-scrollbar + .is-scrolling 规则统一接管,
          默认 thumb 透明,scroll/hover gutter 时显形,2s 无活动后淡出
          (lib/scrollbarAutoHide.ts 全局 capture 阶段自动加类)。
        - data-scroll-container 给 ImageLightbox/TextLightbox/MermaidLightbox/
          ToolPayloadLightbox 的全局 querySelector('[data-scroll-container]') 找锚点。
        - 50px 视觉边距由 contentRef 的 mx-auto + maxWidth 自然产生。
      */}
            <div
              ref={scrollRef}
              data-scroll-container=""
              className="h-full w-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
              onScroll={handleScroll}
            >
              <div
                ref={contentRef}
                className="mx-auto w-full pt-7"
                style={{
                  paddingBottom: resolvedBottomPadding,
                  // Match the input overlay's width so chat content + input box
                  // share the same horizontal bounds. Falls back to 880 only if
                  // the parent forgot to pass contentWidth.
                  maxWidth: contentWidth ?? 880,
                }}
              >
                {/* F-SYNC-2: Loading spinner at top */}
                {isLoadingMore && (
                  <div className="flex items-center justify-center pb-4">
                    <Spinner size={20} className="text-[var(--msg-tool-text)]" />
                  </div>
                )}

                {/* F10 (v2): vertical gap halved 28→14px so thinking + tool blocks
              read more compactly, matching Claude Code Desktop density.
              React `key` 一律取 item.key — stable across builds(派生约定见
              RenderItem 类型注释 / buildRenderItems),复用 DOM 节点避免折叠
              态丢失 / 滚动锚点漂走。 */}
                <div
                  ref={itemsRef}
                  data-share-selection-active={shareSelectionActive ? '' : undefined}
                  className={cn(
                    // msg-stream-items:直接子元素(每条 render item 的根节点)带
                    // content-visibility:auto(globals.css)—— 视口外条目跳过布局
                    // 与绘制,切入长 session 的首帧成本从「整个窗口 80 条」降到
                    // 「一屏」。滚动恢复按条目锚定 + ResizeObserver 纠偏,估高
                    // (240px)与真实高度的偏差在条目进入视口后被自动纠正。
                    'msg-stream-items flex flex-col gap-3.5',
                    // 分享选择模式:整列内容右移,左侧让出复选框那一列。缩进加在
                    // 容器上(不是逐条消息),工具卡等不可选的 item 也跟着移,
                    // 左边缘保持对齐。
                    shareSelectionActive && 'pl-10',
                    'transition-[padding] duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:transition-none',
                  )}
                >
                  {visibleRenderItems.map((item) => {
                    if (item.type === 'fork_origin') {
                      return <ForkOriginMarker key={item.key} onClick={onOpenForkOrigin} />;
                    }

                    if (item.type === 'turn_changes') {
                      if (!sessionId) return null;
                      return (
                        <TurnChangesCard
                          key={item.key}
                          sessionId={sessionId}
                          changeSet={item.changeSet}
                        />
                      );
                    }

                    if (item.type === 'generated_files') {
                      return (
                        <GeneratedFilesCard
                          key={item.key}
                          files={item.files}
                          turnStartMs={item.turnStartMs}
                          turnEndMs={item.turnEndMs}
                        />
                      );
                    }

                    if (item.type === 'tool_segment') {
                      return (
                        <AgentActionsBlock
                          key={item.key}
                          toolCalls={item.toolCalls}
                          resultMap={item.resultMap}
                          settledIds={item.settledIds}
                          isSessionStreaming={isSessionStreaming}
                        />
                      );
                    }

                    if (item.type === 'agent_task') {
                      return (
                        <AgentTaskCard
                          key={item.key}
                          toolCall={item.toolCall}
                          update={item.update}
                          result={item.result}
                          {...(sessionId ? { sessionId } : {})}
                          subagentModel={
                            item.toolCall?.toolUseId
                              ? subagentModelByToolUseId.get(item.toolCall.toolUseId)
                              : undefined
                          }
                        />
                      );
                    }

                    if (item.type === 'work_group') {
                      // 完成态外层时间线可包含内层 work_group。递归只负责形状映射,
                      // 具体折叠 / 直接详情逻辑全部复用 WorkGroupBlock。
                      const toWorkGroupChild = (child: WorkGroupChildItem): WorkGroupChild => {
                        if (child.type === 'work_group') {
                          return {
                            kind: 'group',
                            key: child.key,
                            blockId: `work:${child.key.slice('work-'.length)}`,
                            durationMs: child.durationMs,
                            isStreaming: child.isStreaming,
                            startedAtMs: child.startedAtMs,
                            childItems: child.children.map(toWorkGroupChild),
                          };
                        }
                        if (child.type === 'tool_segment') {
                          return {
                            kind: 'tools',
                            key: child.key,
                            toolCalls: child.toolCalls,
                            resultMap: child.resultMap,
                            settledIds: child.settledIds,
                          };
                        }
                        if (child.type === 'message' && child.message.role === 'thinking') {
                          return { kind: 'thinking', key: child.key, message: child.message };
                        }
                        return {
                          kind: 'rendered',
                          key: child.key,
                          renderNode: () =>
                            renderWorkGroupChild(child, {
                              workingDir,
                              sessionId,
                              sessionTitle,
                              agentKind,
                              remoteHostId,
                              isSessionStreaming,
                              firstUserMessageClientId,
                              lastUserMessageClientId,
                              lastUserInputClientId,
                              continuationTurnClientId,
                              continuationInFlightProjectionCapability,
                              localFileRefs,
                              singleResultMap,
                              assistantsWithFollowingUserBoundary,
                              turnFinalAssistantClientIds,
                              subagentModelByToolUseId,
                              userTurnUsageDetailsByAssistantId,
                            }),
                        };
                      };
                      const childItems = item.children.map(toWorkGroupChild);
                      return (
                        // data-message-client-ids:组折叠时子卡片/聚合块整体 unmount,
                        // 精确锚点消失 —— 后台任务面板「点行跳聊天」经 ~= 回退查询
                        // 落到组容器(与 AgentActionsBlock 的容器锚点同一约定)。
                        <div
                          key={item.key}
                          className="scroll-mt-20"
                          data-message-client-ids={collectWorkGroupClientIds(item.children).join(
                            ' ',
                          )}
                        >
                          <WorkGroupBlock
                            // 单层前缀约定 `work:<clientId>` — item.key 形如 `work-<cid>`,
                            // 去掉 `work-` 后拼 `<role>:<id>`,与 agent: / thinking: 同构。
                            blockId={`work:${item.key.slice('work-'.length)}`}
                            durationMs={item.durationMs}
                            isStreaming={item.isStreaming}
                            startedAtMs={item.startedAtMs}
                            childItems={childItems}
                          />
                        </div>
                      );
                    }

                    if (item.type === 'ghost_card') {
                      // 卡槽③:卡体 html/height 渲染时从 store 现取(换海报 = 推送
                      // bump version → 本组件重渲,GhostToolCard 原地更新 srcDoc)。
                      // entry 不 ready(极端竞态:build 后被 reset)静默不渲染,
                      // 下一次 store 变更自愈。
                      const entry = ghostCardSnapshot.byCallId.get(item.callId);
                      if (!entry || entry.status !== 'ready') return null;
                      // 常态包一层 div(结构稳定,回锚媒体到达时卡片 iframe 不重挂);
                      // 回锚媒体(如 mivo 视频)挂卡正下方,与 tool_media 同款间距。
                      return (
                        <div key={item.key} className="flex flex-col gap-2">
                          <GhostToolCard
                            callId={item.callId}
                            ghostId={item.ghostId}
                            toolName={item.tool}
                            toolInput={item.toolCall.toolInput ?? null}
                            html={entry.html}
                            animatedHtml={entry.animatedHtml}
                            height={entry.height}
                            running={!item.settled && isSessionStreaming}
                            sessionId={sessionId}
                          />
                          {item.media && item.media.length > 0 ? (
                            <ToolMediaList items={item.media} sessionId={sessionId} />
                          ) : null}
                        </div>
                      );
                    }

                    if (item.type === 'tool_media') {
                      // tool-result-media: 跳出 tool_segment 折叠卡片,渲染体在
                      // ToolMediaList(与 ghost_card 回锚媒体共用单一来源)。
                      return (
                        <div key={item.key} className="flex flex-col gap-2">
                          <ToolMediaList items={item.items} sessionId={sessionId} />
                        </div>
                      );
                    }

                    const msg = item.message;

                    // v2: ThinkingCard manages its own expand state via
                    // useExpandedBlockMemory; no need to thread isTurnActive.
                    // Inline-rendered (not through MessageItem) so the live
                    // isStreaming flag from the message reaches it directly.
                    if (msg.role === 'thinking') {
                      return (
                        <ThinkingCard
                          key={item.key}
                          blockKey={msg.clientId}
                          content={msg.content}
                          isStreaming={msg.isStreaming}
                          startedAt={msg.thinkingStartedAt}
                          durationMs={msg.thinkingDurationMs}
                          isRedacted={msg.thinkingRedacted}
                        />
                      );
                    }

                    // 分享选择:复选框与光栅化定位属性都挂在这个**既有** wrapper 上,
                    // 不新增 DOM 层级 —— 多包一层会让 AssistantMessage 子树在进出
                    // 选择模式时 remount(mermaid 重渲、GhostToolCard iframe 重载)。
                    const shareable =
                      Boolean(sessionId) && Boolean(msg.clientId) && isShareableMessage(msg);

                    return (
                      <div
                        key={item.key}
                        data-message-client-id={msg.clientId}
                        {...(shareable
                          ? {
                              [SHARE_SESSION_ATTR]: sessionId,
                              [SHARE_MESSAGE_ATTR]: msg.clientId,
                            }
                          : {})}
                        className={cn(
                          'scroll-mt-20 transition-colors',
                          shareable && 'relative',
                          highlightMessageClientId === msg.clientId &&
                            'rounded-xl bg-[hsl(var(--search-match-bg))] ring-1 ring-[var(--border-default)]',
                        )}
                      >
                        {shareable && shareSelectionActive ? (
                          <ShareMessageCheckbox clientId={msg.clientId} />
                        ) : null}
                        <MessageItem
                          message={msg}
                          toolResult={singleResultMap.get(msg.clientId)}
                          workingDir={workingDir}
                          sessionId={sessionId}
                          sessionTitle={sessionTitle}
                          agentKind={agentKind}
                          remoteHostId={remoteHostId}
                          sessionRunning={isSessionStreaming}
                          assistantForkBlocked={shouldBlockAssistantFork(
                            isSessionStreaming,
                            msg,
                            assistantsWithFollowingUserBoundary,
                          )}
                          assistantIsTurnFinal={turnFinalAssistantClientIds.has(msg.clientId)}
                          userTurnUsageDetails={userTurnUsageDetailsByAssistantId.get(msg.clientId)}
                          isFirstUserMessage={msg.clientId === firstUserMessageClientId}
                          isLastUserMessage={msg.clientId === lastUserMessageClientId}
                          isLastUserInput={msg.clientId === lastUserInputClientId}
                          isContinuationTurnOwner={msg.clientId === continuationTurnClientId}
                          continuationInFlightProjectionCapability={
                            continuationInFlightProjectionCapability
                          }
                          isLastMessage={msg.clientId === lastMessageClientId}
                          localFileRefs={localFileRefs}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* F1 / F3: 新消息悬浮提示——挂在 scrollRef 的 relative wrapper 内部，
           与滚动容器平级。visible 由 `!isNearBottom && unreadCount > 0` 双重
           守护；bottomOffset 直接复用 bottomPadding（overlayHeight）+ 12。 */}
            <NewMessageIndicator
              visible={!isNearBottom && unreadCount > 0}
              count={unreadCount}
              onClick={scrollToBottomSmooth}
              bottomOffset={indicatorBottomOffset}
            />

            {/* jump-to-bottom: 向下滚动时的扁平快捷跳底 pill。
          互斥规则:NewMessageIndicator 有未读时优先(信息密度高),所以
          unreadCount===0 才显示;isNearBottom=true 时无意义,handleScroll
          已经会 reset showJumpDown,这里再叠一层 visible 守护防边界 race。 */}
            <JumpToBottomChip
              visible={showJumpDown && unreadCount === 0 && !isNearBottom}
              onClick={scrollToBottomSmooth}
              bottomOffset={indicatorBottomOffset}
            />

            {/* message-nav-rail: 左缘提问导航条(每条提问一根刻度,当前项加深,
          hover 预览,点击跳转)。个性化开关(默认关)决定挂不挂载;挂载后的
          显隐仍由组件自判:提问数 ≥4 且内容列左侧留白足够;窄窗口 / 嵌入面板
          自然隐藏,绝不压在气泡上。 */}
            {navRailEnabled && (
              <MessageNavRail
                entries={navRailEntries}
                scrollRef={scrollRef}
                contentMaxWidth={contentWidth ?? 880}
                bottomOffset={resolvedBottomPadding}
                onJump={handleNavRailJump}
                onNavCoverageChange={setNavRailCoversNav}
                resetKey={sessionId}
              />
            )}

            {/* prev-user-msg-jump: 右上角"跳到上一条提问"icon 按钮。
          通过 createPortal 挂到祖先的 TopRightChipStack 容器里,与 DiffPanelToggle
          各占栈中一行;DiffToggle 在 session 载入时就 mount,本 chip 仅在
          上滑时 mount,DOM append 顺序天然落到第二行。仅在 viewport 之上
          确实存在 user 消息时(prevUserMsgId !== null)portal 才挂入,
          近底时 hook 自然返回 null → 不挂入 → 不占行。 */}
            {chipSlot &&
              prevUserMsgVisible &&
              // 导航条完整覆盖导航时不再挂本 chip(入口去重,见 navRailCoversNav)。
              !navRailCoversNav &&
              createPortal(
                <PrevMessageJumpChip preview={prevPreview} onClick={handleJumpToPrevUserMsg} />,
                chipSlot,
              )}
          </div>
        </ImageGalleryContext.Provider>
      </GhostFulfillmentContext.Provider>
    </ChatSessionFileProvider>
  );
}

// memo: during streaming, only the currently-streaming message's content
// changes. Without memo, every token re-renders ALL historical MessageItems.
// workingDir is a stable string within a session lifecycle (the parent
// MessageStream is remounted via key={sessionId} on session switch), so the
// shallow-prop comparison still skips re-render cleanly.
//
// thinking messages are now rendered inline by MessageStream (above) so they
// can receive the live isSessionStreaming flag without breaking this memo.
// The thinking branch below is kept as a defensive fallback only.
const MessageItem = memo(function MessageItem({
  message,
  toolResult,
  workingDir,
  sessionId,
  sessionTitle,
  agentKind,
  remoteHostId,
  sessionRunning,
  assistantForkBlocked,
  assistantIsTurnFinal,
  userTurnUsageDetails,
  isFirstUserMessage,
  isLastUserMessage,
  isLastUserInput,
  isContinuationTurnOwner,
  continuationInFlightProjectionCapability,
  isLastMessage,
  localFileRefs,
}: {
  message: ChatMessage;
  toolResult?: string;
  workingDir: string;
  /** Forwarded to User/AssistantMessage so the Fork button can call the IPC. */
  sessionId?: string;
  /** Forwarded to AssistantMessage so handoff cards can build return state. */
  sessionTitle?: string | null;
  /** Owning session's remote SSH host id; forwarded to User/AssistantMessage
   *  to gate Fork/Rewind (unsupported on remote cc daemon sessions). */
  remoteHostId?: string | null;
  /** Forwarded to User/AssistantMessage so they can read this agent's
   *  capabilities (gates Fork/Rewind icon visibility). */
  agentKind?: 'cc' | 'codex' | 'pi';
  /** Whether this session currently has an in-flight SDK turn. Rewind uses it
   *  to require an idle live query; fork can still target stable history. */
  sessionRunning?: boolean;
  /** True for assistant messages in the current tail turn while the session is running. */
  assistantForkBlocked?: boolean;
  /** True iff this assistant message is its turn's final answer text
   *  (collectTurnFinalAssistantClientIds). Gates the hover action bar —
   *  mid-turn texts don't mount it, keeping the stream compact. */
  assistantIsTurnFinal?: boolean;
  /** Aggregated token/cache/model details for this assistant's visible user turn. */
  userTurnUsageDetails?: TurnUsageDetails;
  /** True iff this message is the first user message in the visible list.
   *  UserMessage hides the Rewind button for it (no prior assistant to
   *  resumeSessionAt anchor on — backend would throw NO_PRIOR_ASSISTANT). */
  isFirstUserMessage?: boolean;
  /** True iff this message is the last user message in the full list —
   *  edit-last-message: gates the Edit (pencil) entry in UserMessage. */
  isLastUserMessage?: boolean;
  /**
   * True iff this message is the last **user-side input** in the full list, synthetic rows
   * included（见 `findLastUserInputClientId`）。自愈重连行用它 + `sessionRunning` 判断
   * 「此刻正在跑的 turn 是不是我发起的」，从而决定要不要显示成"重新连接中"。
   */
  isLastUserInput?: boolean;
  /** 当前 vendor turn 的续跑 owner 是否就是这条消息。 */
  isContinuationTurnOwner?: boolean;
  /** 当前投影对精确续跑边界字段的支持状态；legacy 才允许启用旧端兼容兜底。 */
  continuationInFlightProjectionCapability?: ContinuationInFlightProjectionCapability;
  /** True iff this message is the last message in the full list —
   *  error-tail-banner: a trailing un-dismissed error row is rendered by the
   *  actionable banner above the composer instead of an inline card. */
  isLastMessage?: boolean;
  localFileRefs: readonly KnownLocalFileRef[];
}) {
  // silent-stop 自动续跑行(isSyntheticTrigger + systemCardType):渲染成
  // 「已自动继续」分隔线,必须在 synthetic early-return 之前检查,否则分隔线被吞。
  if (message.role === 'user' && message.systemCardType) {
    return (
      <SystemCard
        cardType={message.systemCardType}
        data={message.systemCardData}
        sessionId={sessionId}
        workingDir={workingDir}
        // 「这条自愈记录此刻真的在飞吗」：main 持有 vendor-turn owner，只有旧端缺省该字段时
        // 才回落到兼容启发式；supported / unknown 不再依赖 Renderer 的 sticky memory。
        autoResumeInFlight={isAutoResumeRowInFlight({
          isContinuationTurnOwner: isContinuationTurnOwner === true,
          sessionRunning: sessionRunning === true,
          isLastUserInput: isLastUserInput === true,
          projectionCapability: continuationInFlightProjectionCapability ?? 'unknown',
        })}
      />
    );
  }
  // [UI_ACTION_TRIGGER] 合成指令行:保留在 messages 里参与时序判定(error-tail
  // banner 的尾部判定不能忽视它,review P2),但不渲染任何气泡。
  if (message.isSyntheticTrigger) return null;
  switch (message.role) {
    case 'user':
      return (
        <UserMessage
          workingDir={workingDir}
          content={message.content}
          sessionReferences={message.sessionReferences}
          quotesEncoded={message.quotesEncoded}
          agentReferences={message.agentReferences}
          pastedTextRanges={message.pastedTextRanges}
          slashCommandRanges={message.slashCommandRanges}
          images={message.images}
          files={message.files}
          createdAt={message.createdAt}
          sessionId={sessionId}
          agentKind={agentKind}
          remoteHostId={remoteHostId}
          messageClientId={message.clientId}
          sessionRunning={sessionRunning}
          isFirstUserMessage={isFirstUserMessage}
          isLastUserMessage={isLastUserMessage}
          automationOrigin={message.automationOrigin}
          hookSource={message.hookSource}
          delivery={message.delivery}
          goalBadge={message.goalBadge}
          blockedByGhost={message.blockedByGhost}
        />
      );
    case 'assistant':
      if (message.systemCardType) {
        return (
          <SystemCard
            cardType={message.systemCardType}
            data={message.systemCardData}
            sessionId={sessionId}
            workingDir={workingDir}
          />
        );
      }
      return (
        <AssistantMessage
          workingDir={workingDir}
          localFileRefs={localFileRefs}
          currentSessionId={sessionId}
          currentSessionTitle={sessionTitle}
          content={message.content}
          isStreaming={message.isStreaming}
          createdAt={message.createdAt}
          messageClientId={message.clientId}
          agentKind={agentKind}
          remoteHostId={remoteHostId}
          forkBlocked={assistantForkBlocked}
          sessionRunning={sessionRunning}
          // 任务执行过程中(尾部 turn 流式中,forkBlocked=true)不出现操作行;
          // turn 结束后只有收尾正文出现 —— 中间句彻底不挂 bar。
          showActionBar={Boolean(assistantIsTurnFinal) && !assistantForkBlocked}
          turnMoney={message.turnMoney}
          turnCostUsd={message.turnCostUsd}
          turnCostIsEstimate={message.turnCostIsEstimate}
          userTurnMoney={message.userTurnMoney}
          userTurnCostUsd={message.userTurnCostUsd}
          userTurnCostIsEstimate={message.userTurnCostIsEstimate}
          turnUsageDetails={message.turnUsageDetails}
          userTurnUsageDetails={userTurnUsageDetails}
          modelMismatch={message.modelMismatch}
          ghostReplyPending={message.ghostReplyPending}
        />
      );
    case 'tool_use':
      return (
        <ToolCallCard
          toolName={message.toolName ?? ''}
          toolInput={message.toolInput}
          summary={getToolSummary(message.toolName ?? '', message.toolInput)}
          toolResult={toolResult}
        />
      );
    case 'tool_result':
      // Standalone tool_result — should not normally appear
      // (consumed by tool_use card or group), but render as fallback
      return null;
    case 'ask_user':
      return <AskUserQuestionBubble message={message} />;
    case 'plan_review':
      // 计划正文是会话消息内容,解析上下文与 AssistantMessage 保持一致
      // (currentSessionId 缺失会让远程会话里计划内的媒体链接绕过
      // cindy-remote-media:// 改写而坏图)。
      return (
        <PlanReviewBubble
          message={message}
          workingDir={workingDir}
          currentSessionId={sessionId}
          currentSessionTitle={sessionTitle}
          localFileRefs={localFileRefs}
        />
      );
    case 'error':
      // interrupted-turn-resume:app 退出中断标记行不进消息流(2026-07-05 产品
      // 决策)——它作为「会话尾部是否停在中断态」的判定源保留在 messages 数组里,
      // 呈现走 CCAgentSessionView 输入框上方的 InterruptedTurnBanner(与 ErrorBanner
      // 同风格)+ sidebar 'error' 红点,这里渲染 null。
      if (message.errorReason === APP_EXIT_INTERRUPTED_REASON) return null;
      // error-tail-banner:普通失败行是尾部消息且未被忽略时,由输入框上方的可操作
      // 红条(重试/关闭)独家承载,流内不重复渲染,避免双红条;被忽略或后续有新
      // 消息后回落为流内静态历史卡。
      if (isLastMessage && !message.errorDismissed) return null;
      // 历史里的 turn 失败记录(role='error' 持久化行)——静态时间线卡,
      // live 报错仍走输入框上方的 ErrorBanner,两者不会同时出现
      // (error 行落库时不广播,只在历史加载路径进入消息流)。
      return <ErrorMessageCard message={message.content} reason={message.errorReason} />;
    case 'thinking':
      // Defensive fallback only — MessageStream renders thinking inline.
      return (
        <ThinkingCard
          content={message.content}
          isStreaming={message.isStreaming}
          startedAt={message.thinkingStartedAt}
          durationMs={message.thinkingDurationMs}
          isRedacted={message.thinkingRedacted}
        />
      );
    default:
      return null;
  }
});
