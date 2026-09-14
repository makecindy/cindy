/**
 * AgentActionsBlock
 * ---------------------------------------------------------------------------
 * F1 / F2 / F8 / F9 (cc-agent-compact-blocks v2) — single-line summary that
 * expands into a left-railed list of AgentActionRow items.
 *
 * Visual contract (sourced from `.pen` reference frames `j22zk` collapsed
 * and `1Tnsk` expanded):
 *   - Header row: `gap:6 padding:[2,0]`, lucide bot 14×14 in
 *     `--msg-tool-card-chevron`, summary text Inter 14 normal in same color,
 *     trailing chevron 14×14. No card chrome.
 *   - Items list: `padding:[2,0,2,12]`, 2px left border in
 *     `--agent-actions-rail`, vertical layout.
 *
 * State machine (v2 — F8 + F9):
 *   - **Default collapsed** for every block, regardless of streaming state.
 *     Streaming blocks still aggregate the summary live; the user opens them
 *     manually if they want to peek.
 *   - **Remembered** per-block via `useExpandedBlockMemory` (in-memory store —
 *     survives session switches within one app run, but is intentionally NOT
 *     persisted across app restart / reload). Storage key is
 *     `agent:<firstClientId>`.
 *   - No more user-interacted ref + prev-streaming ref state machine — the
 *     persistent hook is the single source of truth.
 *
 * Body height (ADR-6):
 *   No max-height / no internal scroll. Content grows naturally.
 */

import { useCallback, useMemo } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import type { ChatMessage } from '@/lib/makerChatStore';
import {
  aggregateVerbs,
  formatSummary,
} from '@/lib/agent-actions/verbAggregator';
import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';

import { AgentActionRow } from './AgentActionRow';

export interface AgentActionsBlockProps {
  toolCalls: ChatMessage[];
  /** clientId of tool_use → string content of its tool_result. */
  resultMap: Map<string, string>;
  /**
   * tool_use clientId 集合:对应 tool_result 已到达但内容被隐藏不进 resultMap
   * (orca 通信工具的空结果,见 MessageStream shouldHideToolResult)。只用于
   * 状态判定,展示语义不变 — 少了它这些工具会永久显示 running。
   */
  settledIds?: Set<string>;
  /**
   * 会话是否仍在流式输出。只有 streaming 中的未完成工具才显示 running;
   * 历史 / 中断会话(默认 false)一律按已完成渲染,不会出现永久 spinner。
   */
  isSessionStreaming?: boolean;
}

export function AgentActionsBlock({
  toolCalls,
  resultMap,
  settledIds,
  isSessionStreaming = false,
}: AgentActionsBlockProps) {
  const { t } = useTranslation();
  const summary = useMemo(() => aggregateVerbs(toolCalls), [toolCalls]);
  const summaryText = useMemo(() => formatSummary(summary, t), [summary, t]);

  // 行级状态:result 已配对 / 已 settle(隐藏结果)→ done;仅当会话仍在
  // streaming 且两者都缺时视为 running。
  const rowStatus = useCallback(
    (clientId: string): 'running' | 'done' =>
      isSessionStreaming && !resultMap.has(clientId) && !settledIds?.has(clientId)
        ? 'running'
        : 'done',
    [isSessionStreaming, resultMap, settledIds],
  );
  const hasRunning = useMemo(
    () => toolCalls.some((msg) => rowStatus(msg.clientId) === 'running'),
    [toolCalls, rowStatus],
  );

  // Stable per-block id for persistence. First tool's clientId uniquely
  // identifies this segment in the stream — survives streaming token churn.
  const blockId = useMemo(() => {
    if (toolCalls.length === 0) return 'agent:empty';
    return `agent:${toolCalls[0].clientId}`;
  }, [toolCalls]);

  const { expanded, setExpanded } = useExpandedBlockMemory(blockId);

  const onToggle = useCallback(() => {
    setExpanded((v) => !v);
  }, [setExpanded]);

  if (toolCalls.length === 0) return null;

  return (
    // data-message-client-ids(空格分隔):后台任务面板「点行跳聊天」的定位锚点。
    // 聚合块内的工具行折叠时不在可视 DOM,精确 clientId 锚点(message wrapper /
    // 任务卡)查不到时,MessageStream 的 focus 用 ~= 属性选择器落到本块容器。
    // 视口删除补偿不读这个聚合列表，避免把隐藏工具 id 当成活锚点。
    <div
      className="flex w-full justify-start"
      data-message-client-ids={toolCalls.map((c) => c.clientId).join(' ')}
    >
      <div className="w-full">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'flex w-full items-center gap-[6px] py-[2px]',
            'select-none cursor-pointer',
            'hover:opacity-80 transition-opacity',
            'text-left',
          )}
          aria-expanded={expanded}
        >
          {/* 有 running 行时 Bot 换成 spinner(同槽位同尺寸同色替换,零跳变),
              全部完成后回落 Bot。 */}
          <span className="inline-flex h-[1lh] items-center shrink-0">
            {hasRunning ? (
              <Spinner size={14} className="text-[var(--msg-tool-card-chevron)]" />
            ) : (
              <Bot
                size={14}
                className="text-[var(--msg-tool-card-chevron)]"
              />
            )}
          </span>
          <span className="text-14 text-[var(--msg-tool-card-chevron)] truncate min-w-0 translate-y-[1px]">
            {summaryText}
          </span>
          <div className="flex-1" />
          <ChevronRight
            size={14}
            className={cn(
              'shrink-0 text-[var(--msg-tool-card-chevron)]',
              'transition-transform duration-[var(--motion-fast,150ms)]',
              expanded && 'rotate-90',
            )}
          />
        </button>

        <Collapse open={expanded}>
          <div
            className={cn(
              'mt-1 pl-3 py-[2px]',
              'border-l-2 border-[var(--agent-actions-rail)]',
              'flex flex-col',
            )}
          >
            {toolCalls.map((msg) => (
              <AgentActionRow
                key={msg.clientId}
                message={msg}
                toolResult={resultMap.get(msg.clientId)}
                status={rowStatus(msg.clientId)}
              />
            ))}
          </div>
        </Collapse>
      </div>
    </div>
  );
}
