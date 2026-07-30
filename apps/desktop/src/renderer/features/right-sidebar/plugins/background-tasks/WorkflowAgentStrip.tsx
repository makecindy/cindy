/**
 * WorkflowAgentStrip —— 逐 agent 状态方块条(对齐官方 CLI 的 agent 状态格概念)。
 *
 * 大编队(几十个 agent)时逐行列表看不清全局,方块条给"一眼总览":每个 agent
 * 一格,按视觉四色着色(绿=完成 / 橙=运行中 / 红=失败 / 灰=排队,全部走既有
 * 语义 token,与状态点/running 色的设计定稿同源)。
 *
 * - 纯视觉增强,aria-hidden(相邻的摘要行/聚合行已承担文字语义);每格 title
 *   提示 label · 状态(状态经 chat.workflowTree.state.* 本地化,词表外原词兜底)。
 * - 无动画(DESIGN.md §14.4:不为常驻状态加循环动效,状态变化直接换色)。
 * - maxVisible 截断(卡片等紧凑场景),超出部分以 +n 文本收尾。
 */

import { useTranslation } from 'react-i18next';

import {
  workflowAgentVisualState,
  type WorkflowAgentVisualState,
} from './workflowProgressModel';

const STATE_BG: Record<WorkflowAgentVisualState, string> = {
  done: 'bg-[var(--card-status-done)]',
  running: 'bg-[var(--warning-accent)]',
  failed: 'bg-[var(--error-fg)]',
  queued: 'bg-[var(--surface-chip)]',
};

export interface WorkflowAgentStripCell {
  state?: string;
  label?: string;
}

export function WorkflowAgentStrip({
  cells,
  maxVisible,
}: {
  cells: readonly WorkflowAgentStripCell[];
  /** 紧凑场景(聊天卡片)截断上限;省略 = 全量 wrap。 */
  maxVisible?: number;
}) {
  const { t } = useTranslation();
  if (cells.length === 0) return null;
  const visible = maxVisible !== undefined ? cells.slice(0, maxVisible) : cells;
  const overflow = cells.length - visible.length;
  // title 是用户可见 tooltip:状态词走 i18n(与树行同一词表 key),词表外原词兜底。
  const cellTitle = (cell: WorkflowAgentStripCell): string | undefined => {
    const stateLabel = cell.state
      ? t(`chat.workflowTree.state.${cell.state}`, { defaultValue: cell.state })
      : undefined;
    if (cell.label && stateLabel) return `${cell.label} · ${stateLabel}`;
    return cell.label ?? stateLabel;
  };
  return (
    <span
      data-workflow-agent-strip="true"
      aria-hidden="true"
      className="flex flex-wrap items-center gap-1"
    >
      {visible.map((cell, i) => (
        <span
          // 稳定序:workflow_progress 条目顺序即 spawn 顺序,index 作 key 足够。
          key={i}
          title={cellTitle(cell)}
          className={`h-2 w-2 rounded-[2px] ${STATE_BG[workflowAgentVisualState(cell.state)]}`}
        />
      ))}
      {overflow > 0 && (
        <span className="text-11 leading-4 text-[var(--text-tertiary)]">+{overflow}</span>
      )}
    </span>
  );
}
