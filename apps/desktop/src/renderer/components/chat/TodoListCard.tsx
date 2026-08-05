/**
 * TodoListCard
 * ---------------------------------------------------------------------------
 * TodoChecklistCard · Showcase visual contract
 *
 * Card with border, collapsible (default expanded).
 * Uses the same color tokens as ToolCallCard for consistency:
 *   --msg-tool-card-text:    primary (icons, completed/in_progress text)
 *   --msg-tool-card-chevron: secondary (chevron, pending icon/text, separator)
 *
 * Collapsed: top rounded-12 / bottom square
 *   chevron + list-todo 16px + "X/Y" (mono bold) + "·" + msg + bar 2px
 * Expanded:  all corners rounded-12
 *   chevron + same header + divider + todo list
 *
 * Item states:
 *   completed:   circle-check  + font-semibold  (--msg-tool-card-text)
 *   in_progress: circle-dashed + font-semibold  (--msg-tool-card-text) + pulse
 *   pending:     circle        + font-normal     (--msg-tool-card-chevron) opacity-60
 */

import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  ListTodo,
  CircleCheck,
  CircleDashed,
  Circle,
} from 'lucide-react';
import type { MessageRenderTodoItem } from '@cindy/maker-shared/message-render';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types — normalized agent plan/todo item
// ---------------------------------------------------------------------------

export type TodoItem = MessageRenderTodoItem;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TodoListCard({
  todos,
  animated = true,
}: {
  todos: TodoItem[];
  /** When false, in_progress items render the dashed circle but no pulse / spin —
   *  used after the session stops so frozen todos don't keep "spinning". */
  animated?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  // Header message: content of current in_progress item, or last item
  const activeItem = todos.find((t) => t.status === 'in_progress');
  const headerMsg = activeItem
    ? activeItem.content + (expanded ? '' : '…')
    : todos[todos.length - 1]?.content ?? '';

  return (
    <div className="flex w-full justify-start">
      <div
        className={cn(
          'border border-[var(--msg-tool-card-border)]',
          'bg-[var(--msg-tool-card-bg)]',
          'overflow-hidden max-w-full',
          expanded ? 'rounded-[12px]' : 'rounded-t-[12px] rounded-b-none',
        )}
      >
        {/* Header row */}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className={cn(
            'flex w-full items-center gap-2',
            'px-[14px] py-[10px]',
            'cursor-pointer select-none',
            'hover:opacity-80 transition-opacity',
          )}
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          )}
          <ListTodo size={16} className="shrink-0 text-[var(--msg-tool-card-text)]" />
          <span className="shrink-0 font-mono text-[13px] leading-none font-semibold text-[var(--msg-tool-card-text)]">
            {completed}/{total}
          </span>
          <span className="shrink-0 text-13 leading-none text-[var(--msg-tool-card-chevron)]">·</span>
          <span className="mt-px truncate text-13 leading-none text-[var(--msg-tool-card-text)]">
            {headerMsg}
          </span>
        </button>

        {/* Progress bar — collapsed only */}
        {!expanded && (
          <div className="h-[2px] w-full bg-[var(--todo-bar-track)]">
            <div
              className="h-full bg-[var(--msg-tool-card-text)] transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {/* Expanded: divider + todo list */}
        {expanded && (
          <>
            <div className="h-px w-full bg-[var(--msg-tool-card-border)]" />
            <div className="flex flex-col gap-[2px] px-[14px] pb-[12px] pt-[10px]">
              {todos.map((todo, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex h-[30px] items-center gap-[10px]',
                    todo.status === 'in_progress' && animated && 'animate-pulse',
                  )}
                >
                  {/* Icon */}
                  {todo.status === 'completed' && (
                    <CircleCheck size={18} strokeWidth={1.5} className="shrink-0 text-[var(--msg-tool-card-text)]" />
                  )}
                  {todo.status === 'in_progress' && (
                    <Spinner
                      icon={CircleDashed}
                      size={18}
                      strokeWidth={1.5}
                      spinning={animated}
                      className="text-[var(--msg-tool-card-text)]"
                      style={{ animationDuration: '3s' }}
                    />
                  )}
                  {todo.status === 'pending' && (
                    <Circle size={18} strokeWidth={1.5} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
                  )}

                  {/* Text */}
                  <span
                    className={cn(
                      'mt-px truncate text-13',
                      todo.status === 'completed' && 'font-semibold text-[var(--msg-tool-card-text)]',
                      todo.status === 'in_progress' && 'font-semibold text-[var(--msg-tool-card-text)]',
                      todo.status === 'pending' && 'font-normal text-[var(--msg-tool-card-chevron)] opacity-60',
                    )}
                  >
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
