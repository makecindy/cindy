/**
 * TodoListCard
 * ---------------------------------------------------------------------------
 * 计划清单常驻胶囊(composer 上方,PinnedPlanPanel 专用)。
 *
 * 交互与形态 1:1 对齐 Codex IDE 扩展:
 *   - 收起态:居中小胶囊 `[进度 icon] Step N / M`,不占整行宽度;
 *   - 鼠标悬停时临时展开,移开即收起;点击/Enter 后固定展开,再次触发立即收起。
 *     浮层绝对定位(bottom-full),不改变 composer overlay 的实测高度,
 *     消息流不会因 hover 抖动。
 *   - 浮层行:completed 灰(check 圆圈),in_progress 高亮(虚线圆圈 + 旋转),
 *     pending 正常前景色(空心圆圈)。
 *
 * 颜色沿用 ToolCallCard 同套 token(设计系统零阴影,浮层用 1px 边框):
 *   --msg-tool-card-text:    primary(icon、in_progress/pending 文本)
 *   --msg-tool-card-chevron: secondary(completed 置灰)
 */

import { useEffect, useId, useRef, useState } from 'react';
import { CircleCheck, CircleDashed, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageRenderTodoItem } from '@cindy/maker-shared/message-render';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types — normalized agent plan/todo item
// ---------------------------------------------------------------------------

export type TodoItem = MessageRenderTodoItem;

type FlyoutOpenMode = 'closed' | 'hover' | 'pinned';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TodoListCard({
  todos,
  animated = true,
  maxWidth,
}: {
  todos: TodoItem[];
  /** When false, in_progress items render the dashed circle but no pulse / spin —
   *  used after the session stops so frozen todos don't keep "spinning". */
  animated?: boolean;
  /** Composer/chat column width. Keeps the flyout inside clipped compact panes. */
  maxWidth?: number;
}) {
  const { t } = useTranslation();
  const flyoutId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [openMode, setOpenMode] = useState<FlyoutOpenMode>('closed');
  const [renderFlyout, setRenderFlyout] = useState(false);
  const revealed = openMode !== 'closed';

  useEffect(() => {
    if (openMode !== 'pinned') return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      setOpenMode('closed');
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMode('closed');
    };

    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMode]);

  useEffect(() => {
    if (revealed) setRenderFlyout(true);
  }, [revealed]);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const total = todos.length;
  const allDone = completed >= total;
  const activeIndex = todos.findIndex((todo) => todo.status === 'in_progress');
  const pendingIndex = todos.findIndex((todo) => todo.status === 'pending');
  const currentIndex =
    activeIndex >= 0
      ? activeIndex
      : pendingIndex >= 0
        ? pendingIndex
        : Math.min(completed, total - 1);
  const currentStep = allDone ? total : currentIndex + 1;
  const hasActive = todos.some((todo) => todo.status === 'in_progress');
  const flyoutMaxWidth =
    typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0
      ? `${Math.floor(maxWidth)}px`
      : null;

  return (
    <div className="flex w-full justify-center">
      <div
        ref={cardRef}
        className="relative inline-flex items-center justify-center"
        onMouseEnter={() => {
          setOpenMode((current) => (current === 'closed' ? 'hover' : current));
        }}
        onMouseLeave={() => {
          setOpenMode((current) => (current === 'hover' ? 'closed' : current));
        }}
      >
        {/* Collapsed pill — `[icon] Step N / M`,点击/Enter 也可切换浮层(键盘可达)。 */}
        <button
          type="button"
          onClick={() => {
            setOpenMode((current) => (current === 'pinned' ? 'closed' : 'pinned'));
          }}
          aria-controls={flyoutId}
          aria-expanded={revealed}
          className={cn(
            'flex items-center gap-2 rounded-full',
            'border border-[var(--msg-tool-card-border)]',
            'bg-[var(--msg-tool-card-bg)]',
            'px-[14px] py-[8px]',
            'cursor-pointer select-none',
            'hover:opacity-80 transition-opacity',
          )}
        >
          {allDone ? (
            <CircleCheck
              size={14}
              strokeWidth={2}
              className="shrink-0 text-[var(--msg-tool-card-text)]"
            />
          ) : hasActive ? (
            <Spinner
              icon={CircleDashed}
              size={14}
              strokeWidth={2}
              spinning={animated}
              className="shrink-0 text-[var(--msg-tool-card-text)]"
            />
          ) : (
            <Circle
              size={14}
              strokeWidth={2}
              className="shrink-0 text-[var(--msg-tool-card-text)]"
            />
          )}
          <span className="text-13 leading-none tabular-nums text-[var(--msg-tool-card-text)]">
            {t('chat.planPill.step', { current: currentStep, total })}
          </span>
        </button>

        {/* Hover flyout — 完整清单向上浮出;绝对定位不占布局高度,消息流不抖动。 */}
        {renderFlyout && (
          <>
            <div
              className="absolute bottom-full left-1/2 h-2 min-w-full -translate-x-1/2"
              aria-hidden="true"
            />
            <div
              id={flyoutId}
              className={cn(
                'absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2',
                'w-max',
                flyoutMaxWidth === null && 'min-w-[220px] max-w-[min(420px,calc(100vw-32px))]',
              )}
              style={
                flyoutMaxWidth === null
                  ? undefined
                  : {
                      minWidth: `min(220px, ${flyoutMaxWidth})`,
                      maxWidth: `min(420px, ${flyoutMaxWidth}, calc(100vw - 32px))`,
                    }
              }
            >
              <div
                aria-hidden={!revealed}
                className={cn(
                  'w-full origin-bottom overflow-hidden rounded-[12px]',
                  'border border-[var(--msg-tool-card-border)]',
                  'bg-[var(--msg-tool-card-bg)]',
                  revealed ? 'animate-float-in' : 'animate-float-out',
                )}
                onAnimationEnd={() => {
                  if (!revealed) setRenderFlyout(false);
                }}
              >
                <div className="flex max-h-[280px] flex-col gap-[2px] overflow-y-auto px-[14px] py-[10px]">
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
                        <CircleCheck
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--msg-tool-card-chevron)]"
                        />
                      )}
                      {todo.status === 'in_progress' && (
                        <Spinner
                          icon={CircleDashed}
                          size={18}
                          strokeWidth={1.5}
                          spinning={animated}
                          className="text-[var(--msg-tool-card-text)]"
                        />
                      )}
                      {todo.status === 'pending' && (
                        <Circle
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--msg-tool-card-text)]"
                        />
                      )}

                      {/* Text — 对齐 Codex:completed 置灰,in_progress 高亮,pending 正常。 */}
                      <span
                        className={cn(
                          'mt-px truncate text-13',
                          todo.status === 'completed' &&
                            'font-normal text-[var(--msg-tool-card-chevron)]',
                          todo.status === 'in_progress' &&
                            'font-semibold text-[var(--msg-tool-card-text)]',
                          todo.status === 'pending' &&
                            'font-normal text-[var(--msg-tool-card-text)]',
                        )}
                      >
                        {todo.content}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
