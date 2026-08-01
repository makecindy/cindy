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

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronRight, Layers, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';
import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';

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
    }
  | { kind: 'rendered'; key: string; renderNode: () => ReactNode };

export type LiveWorkActivity = ProjectedWorkActivity;

/** 运行中默认只露出最近 5 条真实活动,与 Slack 远控的滚动窗口同一思路。 */
export const MAX_LIVE_WORK_ACTIVITIES = 5;

/** 把一段可见 thinking 投影成单行动作;empty / redacted 不生成内容行。 */
function thinkingActivityForMessage(
  message: ChatMessage,
): ProjectedThinkingActivity | null {
  if (message.thinkingRedacted) return null;
  const rawContent = message.content.trim();
  const content = rawContent.replace(/\s+/g, ' ');
  return content
    ? { kind: 'thinking', key: message.clientId, rawContent, content }
    : null;
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
}

function ToolActivityRow({ activity }: { activity: ProjectedToolActivity }) {
  return (
    <div data-live-work-activity="tool" className="min-w-0">
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

function ThinkingActivityRow({
  activity,
}: {
  activity: ProjectedThinkingActivity;
}) {
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
      setCanExpand(
        hasExplicitLineBreak || textElement.scrollWidth > textElement.clientWidth + 1,
      );
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
      data-work-thinking-expandable={canExpand ? 'true' : 'false'}
      disabled={!canExpand}
      aria-expanded={canExpand ? expanded : undefined}
      onClick={() => setExpanded((value) => !value)}
      className={cn(
        'flex w-full min-w-0 items-start gap-[6px] px-2 py-[3px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        canExpand && 'cursor-pointer hover:opacity-80 transition-opacity',
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
          'min-w-0 flex-1 text-[14px] italic text-[var(--thinking-body-text)]',
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
        )}
        title={expanded ? undefined : activity.content}
      >
        <ThinkingText content={expanded ? rawContent : activity.content} />
      </span>
      {canExpand && (
        <span aria-hidden="true" className="inline-flex h-[18px] shrink-0 items-center text-[var(--msg-tool-card-chevron)]">
          <ChevronRight
            size={13}
            className={cn(
              'transition-transform duration-[var(--motion-fast,150ms)]',
              expanded && 'rotate-90',
            )}
          />
        </span>
      )}
    </button>
  );
}

/** 展开动作段里的 thinking:默认直接露出一行;原文多行或视觉溢出时,
 *  允许再点该行查看完整原文。live preview 继续复用上面的固定单行版本。 */
function ExpandedThinkingRow({ message }: { message: ChatMessage }) {
  const activity = thinkingActivityForMessage(message);
  const rawContent = message.content.trim();
  const hasExplicitLineBreak = /[\r\n]/.test(rawContent);
  const textRef = useRef<HTMLSpanElement>(null);
  const [canExpand, setCanExpand] = useState(hasExplicitLineBreak);
  const { expanded, setExpanded } = useExpandedBlockMemory(`thinking:${message.clientId}`);

  useLayoutEffect(() => {
    if (!activity) return;
    if (expanded) {
      setCanExpand(true);
      return;
    }
    const textElement = textRef.current;
    if (!textElement) return;
    const updateOverflow = () => {
      setCanExpand(
        hasExplicitLineBreak || textElement.scrollWidth > textElement.clientWidth + 1,
      );
    };
    updateOverflow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [activity?.content, expanded, hasExplicitLineBreak]);

  const onToggle = useCallback(() => {
    if (canExpand) setExpanded((value) => !value);
  }, [canExpand, setExpanded]);

  if (!activity) {
    if (!message.thinkingRedacted) return null;
    return (
      <ThinkingCard
        blockKey={message.clientId}
        content={message.content}
        isRedacted
      />
    );
  }

  return (
    <button
      type="button"
      data-live-work-activity="thinking"
      data-work-thinking-expandable={canExpand ? 'true' : 'false'}
      onClick={onToggle}
      disabled={!canExpand}
      aria-expanded={canExpand ? expanded : undefined}
      className={cn(
        'flex w-full min-w-0 items-start gap-[6px] px-2 py-[3px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        canExpand && 'cursor-pointer hover:opacity-80 transition-opacity',
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
          'min-w-0 flex-1 text-[14px] italic text-[var(--thinking-body-text)]',
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
        )}
        title={expanded ? undefined : activity.content}
      >
        <ThinkingText content={expanded ? rawContent : activity.content} />
      </span>
      {canExpand && (
        <span aria-hidden="true" className="inline-flex h-[18px] shrink-0 items-center text-[var(--msg-tool-card-chevron)]">
          <ChevronRight
            size={13}
            className={cn(
              'transition-transform duration-[var(--motion-fast,150ms)]',
              expanded && 'rotate-90',
            )}
          />
        </span>
      )}
    </button>
  );
}

/** 同一个子项渲染器递归服务运行态动作组、完成态内层动作组和外层文字时间线。 */
function ExpandedWorkGroupChild({
  child,
  toolActivities,
}: {
  child: WorkGroupChild;
  toolActivities?: ProjectedToolActivity[];
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
        blockId={child.blockId}
        durationMs={child.durationMs}
        isStreaming={child.isStreaming}
        startedAtMs={child.startedAtMs}
        childItems={child.childItems}
      />
    );
  }
  return <>{child.renderNode()}</>;
}

export function WorkGroupBlock({
  blockId,
  durationMs,
  isStreaming = false,
  startedAtMs,
  childItems,
}: WorkGroupBlockProps) {
  const { t } = useTranslation();
  const { expanded, setExpanded } = useExpandedBlockMemory(blockId);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isStreaming || startedAtMs === undefined) return;
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const id = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 500);
    return () => window.clearInterval(id);
  }, [isStreaming, startedAtMs]);

  // 多取一条即可判断展开是否能露出更多活动，显示仍只取最近 5 条。
  const recentActivities = useMemo(
    () => projectRecentWorkActivities(childItems, isStreaming, MAX_LIVE_WORK_ACTIVITIES + 1),
    [childItems, isStreaming],
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
          child.kind === 'group'
          || child.kind === 'rendered'
          || (child.kind === 'thinking' && child.message.thinkingRedacted === true),
      ),
    [childItems],
  );
  // 运行中预览已经等于全部内容时，折叠/展开是视觉空操作 — 组头不提供交互。
  const canToggle =
    !isStreaming
    || hasBeyondPreviewChild
    || recentActivities.length > MAX_LIVE_WORK_ACTIVITIES;
  const effectiveExpanded = expanded && canToggle;
  const isLivePreviewVisible =
    isStreaming && !effectiveExpanded && liveActivities.length > 0;
  // 完成态只计算一次完整摘要；运行态保持折叠时走上面的反向 latest-five
  // 热路径，用户主动展开后才投影全部历史。
  const activityProjection = useMemo(
    () =>
      effectiveExpanded || !isStreaming
        ? projectWorkActivities(childItems, isStreaming)
        : null,
    [childItems, effectiveExpanded, isStreaming],
  );

  // 外层完成态组展开成文字 + 内层动作组;内层动作组与运行态组复用本组件,
  // 展开后直接渲染 thinking /工具行,不再多套一层子卡摘要。
  const onToggle = useCallback(() => {
    setExpanded((v) => !v);
  }, [setExpanded]);

  if (childItems.length === 0) return null;

  // durationMs === 0(同毫秒时间戳的极短 run)也显示时长 — formatDuration
  // 自带最小 1s 钳制;只有时间戳缺失(undefined)才退化为无时长文案。
  const baseSummaryText = isStreaming
    ? t('chat.workGroup.working')
    : durationMs !== undefined
      ? t('chat.workGroup.worked', { duration: formatDuration(durationMs) })
      : t('chat.workGroup.workDetails');
  const explorationSummary = activityProjection?.isPureExploration
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
      ].filter((part): part is string => part !== null).join(' · ')
    : '';
  const summaryText = explorationSummary
    ? `${baseSummaryText} · ${explorationSummary}`
    : baseSummaryText;

  return (
    <div className="flex w-full justify-start">
      <div className="w-full">
        <button
          type="button"
          onClick={canToggle ? onToggle : undefined}
          disabled={!canToggle}
          className={cn(
            'flex w-full items-center gap-[6px] py-[2px]',
            'select-none',
            'text-left',
            canToggle && 'cursor-pointer hover:opacity-80 transition-opacity',
            !canToggle && 'cursor-default',
          )}
          aria-expanded={
            canToggle ? effectiveExpanded || isLivePreviewVisible : undefined
          }
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
          <div className="flex-1" />
          {isStreaming && startedAtMs !== undefined && (
            <span className="font-mono text-12 text-[var(--msg-tool-card-chevron)]">
              {formatDuration(elapsedMs)}
            </span>
          )}
          {canToggle && (
            <ChevronRight
              size={14}
              className={cn(
                'shrink-0 text-[var(--msg-tool-card-chevron)]',
                'transition-transform duration-[var(--motion-fast,150ms)]',
                effectiveExpanded && 'rotate-90',
              )}
            />
          )}
        </button>

        {isLivePreviewVisible && (
          <div
            data-live-work-preview="true"
            className={cn(
              'mt-1 border-l-2 border-[var(--agent-actions-rail)] py-[2px] pl-3',
              'flex flex-col',
            )}
          >
            {liveActivities.map((activity) =>
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
              'mt-1 pl-3 py-[2px]',
              'border-l-2 border-[var(--agent-actions-rail)]',
              'flex flex-col gap-2',
            )}
          >
            {childItems.map((child) => (
              <Fragment key={child.key}>
                <ExpandedWorkGroupChild
                  child={child}
                  toolActivities={
                    child.kind === 'tools'
                      ? activityProjection?.toolActivitiesByChildKey.get(child.key)
                      : undefined
                  }
                />
              </Fragment>
            ))}
          </div>
        </Collapse>
      </div>
    </div>
  );
}
