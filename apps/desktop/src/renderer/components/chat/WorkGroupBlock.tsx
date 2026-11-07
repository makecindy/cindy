import { segmentTeammateWork, summarizeTeammateWork, teammateWorkSummaryText } from '@cindy/maker-shared/work-activity-projection';
/**
 * WorkGroupBlock
 * ---------------------------------------------------------------------------
 * 「工作过程」组 — 运行中的连续动作由 MessageStream 聚成稳定 work_group;
 * turn 完成后再用外层 work_group 收起此前持续可见的 assistant 工作文字,
 * 文字之间的动作段仍保留为内层 work_group。运行中默认展示最近 5 条活动。
 *
 * 交互契约:
 *   - 运行中动作组默认露出 latest-five preview;点组头在最近 5 条与全部明细
 *     之间切换,不会把活动完全隐藏。完成态默认 collapsed。
 *   - 运行中若展开也不会露出更多内容(全部活动 ≤ 5 条且没有 preview 之外的
 *     子项),组头不提供折叠交互也不显示箭头,避免"点了闪一下又弹回来"。
 *   - 完成态外组展开后直接显示 assistant 文字,动作仍是内层「已工作 Xs」。
 *   - 运行态或完成态的动作组展开后直接显示 thinking 内容和工具行;长 thinking
 *     可再点行展开全文,工具行沿用 AgentActionRow 的详情交互。
 *   - 展开状态走 useExpandedBlockMemory(`work:<groupKey>`),app 运行期内记住;
 *     外层、内层和长 thinking 各自独立记忆。
 *
 * 时长缺失(老历史数据没有 createdAt)时退化为「工作过程」文案,不显示时间。
 */

import { CHAT_CHEVRON_TRANSITION_CLASS } from './chatChrome';
import {
  Fragment,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronRight, Layers, Sparkles, Terminal } from 'lucide-react';
import { TOOL_ROW_VERB_I18N_KEY, INTENT_ROW_VERB_KEY, UPDATED_VERB_I18N_KEY, FILE_CHANGE_FILES_I18N_KEY } from '../../../shared/agentActionVerbKeys';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';
import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';

import {
  ACTIVITY_ROW_CHEVRON_SLOT_CLASS,
  ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
  ACTIVITY_ROW_HOVER_SURFACE_CLASS,
  ACTIVITY_ROW_RADIUS_CLASS,
} from './activityRowChrome';
import { AgentActionRow } from './AgentActionRow';
import { ThinkingCard, formatDuration } from './ThinkingCard';
import { ThinkingText } from './ThinkingText';
import {
  projectRecentWorkActivities,
  projectWorkActivities,
  type ProjectedThinkingActivity,
  type ProjectedToolActivity,
  type ProjectedWorkActivity,
} from '@/lib/agent-actions/workActivityProjection';

/** work_group 子项的窄类型 — 与 MessageStream 的 RenderItem 解耦,由调用方映射。 */
export type WorkGroupChild =
  | {
      kind: 'tools';
      key: string;
      toolCalls: ChatMessage[];
      resultMap: Map<string, string>;
      settledIds: Set<string>;
    }
  | { kind: 'thinking'; key: string; message: ChatMessage }
  | {
      kind: 'group';
      key: string;
      blockId: string;
      durationMs?: number;
      isStreaming: boolean;
      startedAtMs?: number;
      childItems: WorkGroupChild[];
      deferred?: import('@cindy/maker-shared/message-window').DeferredHistoryWork;
    }
  | { kind: 'rendered';
      prose?: boolean; key: string; renderNode: () => ReactNode };

export type LiveWorkActivity = ProjectedWorkActivity;

/** 运行中默认只露出最近 5 条真实活动,与 Slack 远控的滚动窗口同一思路。 */
export const MAX_LIVE_WORK_ACTIVITIES = 5;

/** 把一段可见 thinking 投影成单行动作;empty / redacted 不生成内容行。 */
function thinkingActivityForMessage(message: ChatMessage): ProjectedThinkingActivity | null {
  if (message.thinkingRedacted) return null;
  const rawContent = message.content.trim();
  const content = rawContent.replace(/\s+/g, ' ');
  return content ? { kind: 'thinking', key: message.clientId, rawContent, content } : null;
}

/** 把完整 work_group 历史投影成轻量 live preview。rendered assistant 文本
 *  不属于动作;空 / redacted thinking 也不生成「Thought for 1s」之类噪音行。 */
export function collectLiveWorkActivities(
  childItems: WorkGroupChild[],
  isStreaming: boolean,
): LiveWorkActivity[] {
  return projectRecentWorkActivities(childItems, isStreaming, MAX_LIVE_WORK_ACTIVITIES);
}

export interface WorkGroupBlockProps {
  /** Teammates keep public execution details collapsed, including while running. */
  compact?: boolean;
  deferred?: import('@cindy/maker-shared/message-window').DeferredHistoryWork;
  /** Stable persistence key:动作段 `work:<clientId>`,外层 `work:summary-<clientId>`. */
  blockId: string;
  /** Wall-clock span of the run; undefined when timestamps are unavailable. */
  durationMs?: number;
  /** True while this is the active trailing work run. */
  isStreaming?: boolean;
  /** Work-run start epoch ms for the live elapsed ticker: the previous
   *  boundary (user message / preceding text) when available — may predate
   *  the first activity — falling back to the first activity timestamp. */
  startedAtMs?: number;
  childItems: WorkGroupChild[];
  /** The header hugs its text (teammate chats) instead of pinning the chevron to the far edge. */
  fitHeader?: boolean;
  journal?: boolean;
  journalTitle?: ReactNode | ((elapsed: ReactNode) => ReactNode);
}

function ToolActivityRow({ activity }: { activity: ProjectedToolActivity }) {
  return (
    <div data-live-work-activity="tool" className="w-full min-w-0">
      <AgentActionRow
        message={activity.message}
        toolResult={activity.toolResult}
        showRawCommand
        status={activity.status}
        intentOverride={activity.intentOverride}
      />
    </div>
  );
}

function ThinkingActivityRow({ activity }: { activity: ProjectedThinkingActivity }) {
  const rawContent = activity.rawContent;
  const hasExplicitLineBreak = /[\r\n]/.test(rawContent);
  const textRef = useRef<HTMLSpanElement>(null);
  const [canExpand, setCanExpand] = useState(hasExplicitLineBreak);
  const { expanded, setExpanded } = useExpandedBlockMemory(`thinking:${activity.key}`);

  useLayoutEffect(() => {
    if (expanded) {
      setCanExpand(true);
      return;
    }
    const textElement = textRef.current;
    if (!textElement) return;
    const updateOverflow = () => {
      setCanExpand(hasExplicitLineBreak || textElement.scrollWidth > textElement.clientWidth + 1);
    };
    updateOverflow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [activity.content, expanded, hasExplicitLineBreak]);

  return (
    <button
      type="button"
      data-live-work-activity="thinking"
      data-message-client-id={activity.key}
      data-work-thinking-expandable={canExpand ? 'true' : 'false'}
      data-scroll-disclosure-header=""
      disabled={!canExpand}
      aria-expanded={canExpand ? expanded : undefined}
      onClick={() => setExpanded((value) => !value)}
      className={cn(
        'flex w-full min-w-0 gap-1.5 px-2 py-[3px] text-left outline-none',
        ACTIVITY_ROW_RADIUS_CLASS,
        expanded ? 'items-start' : 'items-center',
        canExpand
          ? [
              'group cursor-pointer select-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
              ACTIVITY_ROW_HOVER_SURFACE_CLASS,
            ]
          : 'cursor-default',
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-[18px] w-4 shrink-0 items-center justify-center text-[var(--msg-tool-card-chevron)]"
      >
        <Sparkles size={13} />
      </span>
      <span
        ref={textRef}
        className={cn(
          'min-w-0 flex-1 text-14 italic text-[var(--thinking-body-text)]',
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
        )}
        title={expanded ? undefined : activity.content}
      >
        <ThinkingText content={expanded ? rawContent : activity.content} />
      </span>
      <span aria-hidden="true" className={ACTIVITY_ROW_CHEVRON_SLOT_CLASS}>
        {canExpand ? (
          <ChevronRight
            size={13}
            className={cn(CHAT_CHEVRON_TRANSITION_CLASS, expanded && 'rotate-90')}
          />
        ) : null}
      </span>
    </button>
  );
}

type HistoryWorkLine = import('@cindy/maker-shared/message-window').HistoryWorkLine;

/** Remote running line: the Host already resolved the descriptor from the full input. */
function ToolLineRow({
  line,
  onActivate,
}: {
  line: Extract<HistoryWorkLine, { kind: 'tool' }>;
  onActivate: () => void;
}) {
  const message = useMemo<ChatMessage>(
    () => ({
      clientId: line.key,
      role: 'tool_use',
      content: '',
      toolName: line.toolName,
      toolInput: line.ghost ? { ghost_id: line.ghost.id, tool: line.ghost.tool } : null,
    }),
    [line.key, line.toolName, line.ghost],
  );
  return (
    <div data-live-work-activity="tool" className="w-full min-w-0">
      <AgentActionRow
        message={message}
        showRawCommand
        status={line.status}
        descriptorOverride={line.descriptor}
        onActivateOverride={onActivate}
      />
    </div>
  );
}

/** Remote running thought: only its opening is on this device; the full text opens with the group. */
function ThinkingLineRow({
  line,
  onActivate,
}: {
  line: Extract<HistoryWorkLine, { kind: 'thinking' }>;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      data-live-work-activity="thinking"
      data-message-client-id={line.key}
      data-scroll-disclosure-header=""
      onClick={onActivate}
      className={cn(
        'group flex w-full min-w-0 cursor-pointer select-none items-center gap-1.5 px-2 py-[3px] text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        ACTIVITY_ROW_RADIUS_CLASS,
        ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
        ACTIVITY_ROW_HOVER_SURFACE_CLASS,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-[18px] w-4 shrink-0 items-center justify-center text-[var(--msg-tool-card-chevron)]"
      >
        <Sparkles size={13} />
      </span>
      <span
        className="min-w-0 flex-1 truncate text-14 italic text-[var(--thinking-body-text)]"
        title={line.text}
      >
        <ThinkingText content={line.text} />
      </span>
      <span aria-hidden="true" className={ACTIVITY_ROW_CHEVRON_SLOT_CLASS}>
        <ChevronRight size={13} />
      </span>
    </button>
  );
}

/** 展开动作段里的 thinking:与 live preview 共用 ThinkingActivityRow,
 *  保证右侧三角槽同一套布局;redacted 仍走 ThinkingCard。 */
function ExpandedThinkingRow({ message }: { message: ChatMessage }) {
  const activity = thinkingActivityForMessage(message);
  if (!activity) {
    if (!message.thinkingRedacted) return null;
    return (
      <div data-message-client-id={message.clientId}>
        <ThinkingCard blockKey={message.clientId} content={message.content} isRedacted />
      </div>
    );
  }

  return <ThinkingActivityRow activity={activity} />;
}

/** 同一个子项渲染器递归服务运行态动作组、完成态内层动作组和外层文字时间线。 */
function ExpandedWorkGroupChild({
  child,
  toolActivities,
  compact,
}: {
  child: WorkGroupChild;
  toolActivities?: ProjectedToolActivity[];
  compact?: boolean;
}) {
  if (child.kind === 'tools') {
    return (
      <>
        {toolActivities?.map((activity) => (
          <ToolActivityRow key={activity.key} activity={activity} />
        ))}
      </>
    );
  }
  if (child.kind === 'thinking') {
    return <ExpandedThinkingRow message={child.message} />;
  }
  if (child.kind === 'group') {
    return (
      <WorkGroupBlock
        compact={compact}
        blockId={child.blockId}
        durationMs={child.durationMs}
        isStreaming={child.isStreaming}
        startedAtMs={child.startedAtMs}
        childItems={child.childItems}
        deferred={child.deferred}
      />
    );
  }
  return <>{child.renderNode()}</>;
}

export function WorkGroupBlock(props: WorkGroupBlockProps) {
  return props.journal ? <TeammateProcessBlock {...props} /> : <ActivityWorkGroupBlock {...props} />;
}

const InspectTeammateProcess = createContext<(() => void) | null>(null);

/** One turn contains ordered work segments separated by unchanged public prose. */
function TeammateProcessBlock({ blockId, childItems, isStreaming = false, journalTitle, deferred, durationMs, startedAtMs }: WorkGroupBlockProps) {
  const { t } = useTranslation();
  const memory = useExpandedBlockMemory(blockId);
  const manual = useExpandedBlockMemory(`${blockId}:manual`);
  const expanded = manual.expanded ? memory.expanded : isStreaming;
  const flattened = useMemo(() => {
    const leaves: WorkGroupChild[] = [];
    const loaders: NonNullable<WorkGroupBlockProps['deferred']>[] = [];
    if (deferred) loaders.push(deferred);
    const walk = (children: WorkGroupChild[]) => children.forEach(child => {
      if (child.kind === 'group') {
        if (child.deferred) loaders.push(child.deferred);
        walk(child.childItems);
      } else leaves.push(child);
    });
    walk(childItems);
    return { leaves, loaders };
  }, [childItems, deferred]);
  const loadersRef = useRef(flattened.loaders);
  loadersRef.current = flattened.loaders;
  const loaderKey = flattened.loaders.map(loader => `${loader.owner}:${loader.key}`).join('|');
  useLayoutEffect(() => {
    const loaders = loadersRef.current;
    const releases = loaders.map(loader => {
      if (loader.setVisible) return loader.setVisible(expanded, false);
      if (expanded && !loader.expanded) loader.toggle();
      return undefined;
    });
    return () => releases.forEach(release => release?.());
  }, [loaderKey, expanded]);
  const segments = useMemo(() => segmentTeammateWork(flattened.leaves, child => child.kind === 'tools' || child.kind === 'thinking'), [flattened.leaves]);
  const inspect = () => { memory.setExpanded(true); manual.setExpanded(true); };
  const elapsed = <TeammateElapsedTitle running={isStreaming} durationMs={durationMs} startedAtMs={startedAtMs} />;
  const title = typeof journalTitle === 'function' ? journalTitle(elapsed) : journalTitle || elapsed;
  return <div className="min-w-0" data-teammate-process="">
    <button type="button" data-scroll-disclosure-header="" aria-expanded={expanded}
      onClick={() => { memory.setExpanded(!expanded); manual.setExpanded(true); }}
      className="flex min-h-8 w-fit max-w-full items-center gap-2 rounded-none py-1 text-left text-14 text-[var(--text-secondary)] focus-ring">
      <span className="inline-flex w-4 shrink-0 items-center justify-center" aria-hidden>{isStreaming ? <Spinner size={14} /> : <Layers size={14} />}</span>
      <span className="min-w-0 break-words">{title}</span>
      <ChevronRight size={14} className={cn(CHAT_CHEVRON_TRANSITION_CLASS, 'shrink-0', expanded && 'rotate-90')} />
    </button>
    <Collapse open={expanded}>
      <div className="relative ml-2 mb-2 mt-1 min-w-0 pl-4 py-0.5">
        <span aria-hidden data-process-guide="" className="pointer-events-none absolute -left-[0.5px] top-0.5 bottom-0.5 w-px bg-[var(--agent-actions-rail)]" />
        <InspectTeammateProcess.Provider value={inspect}><div className="flex min-w-0 flex-col gap-3 text-[var(--text-primary)]">
          {segments.map((segment, index) => segment.kind === 'content'
            ? <Fragment key={segment.key}>{segment.item.kind === 'rendered' && segment.item.renderNode()}</Fragment>
            : <TeammateWorkSegment key={segment.key} blockId={`${blockId}:${segment.key}`} childItems={segment.items}
                active={isStreaming && index === segments.length - 1} onInspect={inspect} />)}
          {flattened.loaders.some(loader => loader.loading) && <Spinner size={14} />}
          {flattened.loaders.filter(loader => loader.failed).map(loader => <Button key={loader.key} variant="secondary" onClick={loader.retry}>{t('chat.errorBanner.retry')}</Button>)}
          {isStreaming && segments.at(-1)?.kind === 'content' && flattened.leaves.at(-1)?.kind === 'rendered' && (flattened.leaves.at(-1) as Extract<WorkGroupChild, { kind: 'rendered' }>).prose && <div className="flex items-center gap-2 text-14 text-[var(--text-secondary)]"><Spinner size={14} />{t('chat.teammateProcess.thinking')}</div>}
        </div></InspectTeammateProcess.Provider>
      </div>
    </Collapse>
  </div>;
}

export function TeammateElapsedTitle({ running, durationMs, startedAtMs }: { running: boolean; durationMs?: number; startedAtMs?: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAtMs === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAtMs]);
  const elapsed = running && startedAtMs !== undefined ? Math.max(0, now - startedAtMs) : durationMs;
  return <>{elapsed !== undefined && Number.isFinite(elapsed)
    ? t(running ? 'chat.teammateProcess.elapsed' : 'chat.teammateProcess.took', { duration: formatDuration(elapsed, t) })
    : t(running ? 'chat.teammateProcess.processing' : 'chat.teammateProcess.worked')}</>;
}

export function TeammateWorkSegment({ blockId, childItems, active = false, onInspect }: {
  blockId: string; childItems: WorkGroupChild[]; active?: boolean; onInspect?(): void;
}) {
  const { t } = useTranslation();
  const memory = useExpandedBlockMemory(blockId);
  const inspectParent = useContext(InspectTeammateProcess);
  const projection = useMemo(() => projectWorkActivities(childItems, active, true), [childItems, active]);
  const summary = useMemo(() => ({ ...summarizeTeammateWork(projection.activities),
    thinking: childItems.some(child => child.kind === 'thinking') }), [projection, childItems]);
  const title = teammateWorkSummaryText(summary, active, t, {
    verb: key => t(TOOL_ROW_VERB_I18N_KEY[key]),
    intentVerb: action => t(INTENT_ROW_VERB_KEY[action]),
    updateFilesLabel: count => `${t(UPDATED_VERB_I18N_KEY)} ${t(FILE_CHANGE_FILES_I18N_KEY, { count })}`,
  });
  const tools = childItems.filter(child => child.kind === 'tools');
  const icon = active && (summary.running || !summary.toolCount) ? <Spinner size={14} />
    : summary.toolCount ? <Terminal size={14} /> : <Sparkles size={14} />;
  const content = <><span aria-hidden className="inline-flex w-4 shrink-0 items-center justify-center">{icon}</span><span className="min-w-0 break-words">{title}</span></>;
  return <div className="min-w-0" data-teammate-segment="">
    {tools.length ? <button type="button" aria-expanded={memory.expanded} data-scroll-disclosure-header=""
      onClick={() => { memory.setExpanded(value => !value); (onInspect ?? inspectParent)?.(); }}
      className="flex min-h-7 w-fit max-w-full items-center gap-2 rounded-none text-left text-14 text-[var(--text-secondary)] focus-ring">
      {content}<ChevronRight size={12} className={cn(CHAT_CHEVRON_TRANSITION_CLASS, 'shrink-0', memory.expanded && 'rotate-90')} />
    </button> : <div className="flex min-h-7 items-center gap-2 text-14 text-[var(--text-secondary)]">{content}</div>}
    {tools.length > 0 && <Collapse open={memory.expanded}><div className="mt-1 ml-6 flex min-w-0 flex-col gap-1">
      {tools.map(child => <ExpandedWorkGroupChild key={child.key} child={child} toolActivities={projection.toolActivitiesByChildKey.get(child.key)} />)}
    </div></Collapse>}
  </div>;
}

function ActivityWorkGroupBlock({
  compact = false,
  deferred,
  blockId,
  durationMs,
  isStreaming = false,
  startedAtMs,
  childItems,
  fitHeader = false,
}: WorkGroupBlockProps) {
  const { t } = useTranslation();
  const { expanded: rememberedExpanded, setExpanded } = useExpandedBlockMemory(blockId);
  const expanded = deferred?.setVisible
    ? rememberedExpanded
    : (deferred?.expanded ?? rememberedExpanded);
  const deferredRef = useRef(deferred);
  deferredRef.current = deferred;
  // A Host that projects running lines makes the folded preview need no detail read.
  // Older Hosts omit them and keep the latest-five detail tail below.
  const workLines = !compact && isStreaming ? deferred?.lines : undefined;
  const lineMode = workLines !== undefined;
  // Register before paint. Switching back to a running task remounts this group;
  // a passive effect can lag 50–300ms behind the stream's mount, showing a
  // preview-less header until the cached tail reappears and the pinned list jumps.
  // The read tail regroups this item, so its own isStreaming must not drive the read.
  useLayoutEffect(
    () => deferredRef.current?.setVisible?.(expanded, !compact),
    [deferred?.owner, deferred?.key, deferred?.livePreview, expanded, compact],
  );
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (compact || !isStreaming || startedAtMs === undefined) return;
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const id = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 500);
    return () => window.clearInterval(id);
  }, [isStreaming, startedAtMs, compact]);

  // 多取一条即可判断展开是否能露出更多活动，显示仍只取最近 5 条。
  const recentActivities = useMemo(
    () =>
      !compact && isStreaming && !lineMode
        ? projectRecentWorkActivities(childItems, true, MAX_LIVE_WORK_ACTIVITIES + 1)
        : [],
    [childItems, isStreaming, compact, lineMode],
  );
  const liveActivities = useMemo(
    () => recentActivities.slice(-MAX_LIVE_WORK_ACTIVITIES),
    [recentActivities],
  );
  // preview 只投影 tools / thinking；嵌套组、rendered 文字和 redacted thinking
  // 只在展开态可见，存在它们时展开仍有意义。
  const hasBeyondPreviewChild = useMemo(
    () =>
      childItems.some(
        (child) =>
          child.kind === 'group' ||
          child.kind === 'rendered' ||
          (child.kind === 'thinking' && child.message.thinkingRedacted === true),
      ),
    [childItems],
  );
  // 运行中预览已经等于全部内容时，折叠/展开是视觉空操作 — 组头不提供交互。
  const canToggle =
    compact ||
    lineMode ||
    (!!deferred && !deferred.previewComplete) ||
    !isStreaming ||
    hasBeyondPreviewChild ||
    recentActivities.length > MAX_LIVE_WORK_ACTIVITIES;
  const effectiveExpanded = expanded && canToggle;
  // Expanding keeps the running lines on screen until the detail read has rows to replace them.
  // The body opens right away (spinner only), so the handoff swaps rows inside an open Collapse.
  const holdLines = effectiveExpanded && deferred?.awaitingDetails === true && !!workLines?.length;
  const isLivePreviewVisible =
    !compact && isStreaming && (!effectiveExpanded || holdLines)
    && (workLines ? workLines.length > 0 : liveActivities.length > 0);
  // 完成态只计算一次完整摘要；运行态保持折叠时走上面的反向 latest-five
  // 热路径，用户主动展开后才投影全部历史。
  const activityProjection = useMemo(
    () =>
      effectiveExpanded || (!compact && !isStreaming)
        ? projectWorkActivities(childItems, isStreaming)
        : null,
    [childItems, effectiveExpanded, isStreaming, compact],
  );

  // 外层完成态组展开成文字 + 内层动作组;内层动作组与运行态组复用本组件,
  // 展开后直接渲染 thinking /工具行,不再多套一层子卡摘要。
  const onToggle = useCallback(() => {
    if (deferred && !deferred.setVisible) {
      deferred.toggle();
      return;
    }
    setExpanded((v) => !v);
  }, [deferred, setExpanded]);

  if (childItems.length === 0 && !deferred) return null;

  // durationMs === 0(同毫秒时间戳的极短 run)也显示时长 — formatDuration
  // 自带最小 1s 钳制;只有时间戳缺失(undefined)才退化为无时长文案。
  const baseSummaryText = compact
    ? t('chat.workGroup.workDetails')
    : isStreaming
      ? t('chat.workGroup.working')
      : durationMs !== undefined
        ? t('chat.workGroup.worked', { duration: formatDuration(durationMs, t) })
        : t('chat.workGroup.workDetails');
  const explorationSummary =
    !compact && activityProjection?.isPureExploration
      ? [
          activityProjection.explorationCounts.read > 0
            ? t('chat.workGroup.exploration.read', {
                count: activityProjection.explorationCounts.read,
              })
            : null,
          activityProjection.explorationCounts.search > 0
            ? t('chat.workGroup.exploration.search', {
                count: activityProjection.explorationCounts.search,
              })
            : null,
          activityProjection.explorationCounts.list > 0
            ? t('chat.workGroup.exploration.list', {
                count: activityProjection.explorationCounts.list,
              })
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')
      : '';
  const summaryText = explorationSummary
    ? `${baseSummaryText} · ${explorationSummary}`
    : baseSummaryText;

  return (
    <div className="flex w-full min-w-0 justify-start">
      <div className="w-full min-w-0">
        <button
          type="button"
          onClick={canToggle ? onToggle : undefined}
          data-scroll-disclosure-header=""
          disabled={!canToggle}
          className={cn(
            fitHeader ? 'flex w-fit max-w-full items-center gap-1.5 py-[2px]' : 'flex w-full items-center gap-1.5 py-[2px]',
            'select-none',
            compact && 'min-h-8 rounded-full px-2 focus-ring hover:bg-[var(--surface-hover)]',
            'text-left',
            canToggle && 'cursor-pointer hover:opacity-80 transition-opacity',
            !canToggle && 'cursor-default',
          )}
          aria-expanded={canToggle ? effectiveExpanded || isLivePreviewVisible : undefined}
        >
          <span className="inline-flex h-[1lh] items-center shrink-0">
            {isStreaming ? (
              <Spinner size={14} className="text-[var(--msg-tool-card-chevron)]" />
            ) : (
              <Layers size={14} className="text-[var(--msg-tool-card-chevron)]" />
            )}
          </span>
          <span className="text-14 text-[var(--msg-tool-card-chevron)] truncate min-w-0 translate-y-[1px]">
            {summaryText}
          </span>
          {!fitHeader && <div className="flex-1" />}
          {!compact && isStreaming && startedAtMs !== undefined && (
            <span className="font-mono text-12 text-[var(--msg-tool-card-chevron)]">
              {formatDuration(elapsedMs, t)}
            </span>
          )}
          {canToggle && (
            <ChevronRight
              size={14}
              className={cn(
                'shrink-0 text-[var(--msg-tool-card-chevron)]',
                CHAT_CHEVRON_TRANSITION_CLASS,
                effectiveExpanded && 'rotate-90',
              )}
            />
          )}
        </button>

        {isLivePreviewVisible && (
          <div
            data-live-work-preview="true"
            className={cn(
              'mt-1 min-w-0 border-l-2 border-[var(--agent-actions-rail)] py-[2px] pl-3',
              'flex flex-col',
            )}
          >
            {workLines
              ? workLines.map((line) =>
                  line.kind === 'tool' ? (
                    <ToolLineRow key={line.key} line={line} onActivate={onToggle} />
                  ) : (
                    <ThinkingLineRow key={line.key} line={line} onActivate={onToggle} />
                  ),
                )
              : liveActivities.map((activity) =>
                  activity.kind === 'tool' ? (
                    <ToolActivityRow key={activity.key} activity={activity} />
                  ) : (
                    <ThinkingActivityRow key={activity.key} activity={activity} />
                  ),
                )}
          </div>
        )}

        <Collapse open={effectiveExpanded}>
          <div
            className={cn(
              'mt-1 min-w-0 pl-3 py-[2px]',
              'border-l-2 border-[var(--agent-actions-rail)]',
              'flex flex-col gap-2',
            )}
          >
            {effectiveExpanded && !holdLines &&
              childItems.map((child) => (
                <Fragment key={child.key}>
                  <ExpandedWorkGroupChild
                    child={child}
                    compact={compact}
                    toolActivities={
                      child.kind === 'tools'
                        ? activityProjection?.toolActivitiesByChildKey.get(child.key)
                        : undefined
                    }
                  />
                </Fragment>
              ))}
            {deferred?.loading && <Spinner size={14} />}
            {deferred?.failed && (
              <Button variant="secondary" disabled={deferred.loading} onClick={deferred.retry}>
                {t('chat.errorBanner.retry')}
              </Button>
            )}
          </div>
        </Collapse>
      </div>
    </div>
  );
}
