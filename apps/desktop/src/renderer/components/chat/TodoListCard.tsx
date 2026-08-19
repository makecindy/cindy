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
 *   - 浮层行:completed 灰(check 圆圈),in_progress 高亮(实心圆点呼吸,
 *     复用侧栏运行态同款 session-status-breathing;按 DESIGN.md §SVG 常驻
 *     动画红线,呼吸挂 HTML wrapper,SVG 本体静态;reduced-motion 静止),
 *     pending 正常前景色(空心圆圈)。
 *   - 胶囊图标使用静态灰度进度圆环表达当前步骤位置(它表达"第几步",不是
 *     loading 语义,不旋转);进度变化只通过圆环长度的短过渡反馈。
 *
 * 颜色沿用 ToolCallCard 同套 token(设计系统零阴影,浮层用 1px 边框):
 *   --msg-tool-card-text:    primary(icon、in_progress/pending 文本)
 *   --msg-tool-card-chevron: secondary(completed 置灰)
 */

import { useEffect, useId, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  Circle,
  ListTodo,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageRenderTodoItem } from '@cindy/maker-shared/message-render';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types — normalized agent plan/todo item
// ---------------------------------------------------------------------------

export type TodoItem = MessageRenderTodoItem;

type FlyoutOpenMode = 'closed' | 'hover' | 'pinned';

/**
 * 静态灰度进度圆环。
 *
 * 这里没有 loading 语义:圆环表达计划当前位于第几步,而不是告诉用户“还在转”。
 * SVG 本身不挂常驻动画;步骤变化时只过渡 stroke-dashoffset,避免在聊天底部制造
 * 持续运动和额外注意力竞争。
 */
function ProgressRing({
  progress,
  size,
  strokeWidth = 1.75,
  className,
}: {
  progress: number;
  size: number;
  strokeWidth?: number;
  className?: string;
}) {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clampedProgress);

  return (
    <svg
      data-plan-progress-ring="true"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--msg-tool-card-chevron)"
        strokeWidth={strokeWidth}
        opacity={0.45}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--msg-tool-card-text)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-[stroke-dashoffset] duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:transition-none"
      />
    </svg>
  );
}

/**
 * InlinePlanCard —— 计划在聊天时间线里的主呈现。
 *
 * 计划默认留在产生它的消息位置，用户滚回任务经过时能直接看到完整清单；
 * composer 上方的 TodoListCard 只在这张卡离开可见区域后接力。两者消费同一份
 * todos，但交互职责不同：流内卡负责阅读与历史，胶囊负责滚动后的轻量提醒。
 */
export function InlinePlanCard({
  todos,
  animated = false,
}: {
  todos: TodoItem[];
  /** 只有会话确实在跑时，进行中行才呼吸；失败/中断后的历史卡保持静止。 */
  animated?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const activeItem = todos.find((todo) => todo.status === 'in_progress');
  const summary = activeItem?.content ?? todos[todos.length - 1]?.content ?? '';

  return (
    <div className="flex w-full justify-start" data-inline-plan-card="true">
      <div
        className={cn(
          'max-w-full overflow-hidden rounded-[12px] border border-[var(--msg-tool-card-border)]',
          'bg-[var(--msg-tool-card-bg)]',
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            'flex w-full cursor-pointer select-none items-center gap-2 px-[14px] py-[10px]',
            'transition-opacity hover:opacity-80',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
            'focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
          )}
          <ListTodo size={16} className="shrink-0 text-[var(--msg-tool-card-text)]" />
          <span className="shrink-0 font-mono text-13 font-medium leading-none text-[var(--msg-tool-card-text)]">
            {completed}/{total}
          </span>
          <span className="shrink-0 text-13 leading-none text-[var(--msg-tool-card-chevron)]">
            ·
          </span>
          <span className="mt-px truncate text-13 leading-none text-[var(--msg-tool-card-text)]">
            {summary}
          </span>
        </button>

        {!expanded && (
          <div className="h-[2px] w-full bg-[var(--todo-bar-track)]">
            <div
              className="h-full bg-[var(--msg-tool-card-text)] transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {expanded && (
          <div className="border-t border-[var(--msg-tool-card-border)] px-[14px] pb-[12px] pt-[10px]">
            <div className="flex flex-col gap-[2px]">
              {todos.map((todo, index) => (
                <div
                  key={`${todo.content}:${index}`}
                  className="flex min-h-[30px] items-center gap-[10px]"
                >
                  {todo.status === 'completed' && (
                    <CircleCheck
                      size={18}
                      strokeWidth={1.5}
                      className="shrink-0 text-[var(--msg-tool-card-chevron)]"
                    />
                  )}
                  {todo.status === 'in_progress' && (
                    <span
                      data-inline-plan-step-active="true"
                      data-inline-plan-step-breathing={animated ? 'true' : 'false'}
                      className={cn('inline-flex shrink-0', animated && 'session-status-breathing')}
                    >
                      <CircleDot
                        size={18}
                        strokeWidth={1.5}
                        className="shrink-0 text-[var(--msg-tool-card-text)]"
                      />
                    </span>
                  )}
                  {todo.status === 'pending' && (
                    <Circle
                      size={18}
                      strokeWidth={1.5}
                      className="shrink-0 text-[var(--msg-tool-card-text)]"
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 break-words text-13 leading-[1.45]',
                      todo.status === 'completed' &&
                        'font-normal text-[var(--msg-tool-card-chevron)]',
                      todo.status === 'in_progress' &&
                        'font-medium text-[var(--msg-tool-card-text)]',
                      todo.status === 'pending' && 'font-normal text-[var(--msg-tool-card-text)]',
                    )}
                  >
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TodoListCard({
  todos,
  animated = false,
  maxWidth,
  onDismiss,
}: {
  todos: TodoItem[];
  /**
   * 会话是否真的在跑(调用方传 isStreaming)。只有它为真时,in_progress 行才挂
   * 呼吸动画——计划因停止/失败/中断留在屏幕上时会话已空闲,继续呼吸等于谎报
   * "这步还在执行"。胶囊上的进度环与其它形态始终静态,不受此参数影响。
   */
  animated?: boolean;
  /** Composer/chat column width. Keeps the flyout inside clipped compact panes. */
  maxWidth?: number;
  /** Hide the current rendered snapshot without mutating the agent's plan state. */
  onDismiss?: () => void;
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
  const stepProgress = total > 0 ? currentStep / total : 0;
  const flyoutMaxWidth =
    typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0
      ? `${Math.floor(maxWidth)}px`
      : null;

  return (
    <div className="pointer-events-none flex w-auto shrink-0 justify-center">
      <div
        ref={cardRef}
        className="pointer-events-auto inline-flex items-center justify-center"
        onMouseEnter={() => {
          setOpenMode((current) => (current === 'closed' ? 'hover' : current));
        }}
        onMouseLeave={() => {
          setOpenMode((current) => (current === 'hover' ? 'closed' : current));
        }}
      >
        <div
          data-plan-pill-anchor="true"
          className="pointer-events-auto relative inline-flex items-center justify-center"
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
              // 28px 紧凑高度:计划槽位仍保持 32px,上下各留约 2px,避免胶囊贴住输入框。
              'px-[14px] py-[6px]',
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
            ) : (
              <ProgressRing progress={stepProgress} size={16} strokeWidth={2} />
            )}
            <span className="text-13 leading-none tabular-nums text-[var(--msg-tool-card-text)]">
              {t('chat.planPill.step', { current: currentStep, total })}
            </span>
          </button>

          {/* 只让 hover 热区跟随胶囊；完整浮层则相对 composer 中央区域定位。 */}
          {renderFlyout && (
            <div
              className="absolute bottom-full left-1/2 h-3 min-w-full -translate-x-1/2"
              aria-hidden="true"
            />
          )}
        </div>

        {/* Hover flyout — 相对 composer 中央区域居中,被控提示把胶囊左推时也不会越界。 */}
        {renderFlyout && (
          <div
            id={flyoutId}
            data-plan-flyout-positioner="composer"
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
                'relative w-full origin-bottom overflow-hidden rounded-[12px]',
                'border border-[var(--msg-tool-card-border)]',
                'bg-[var(--msg-tool-card-bg)]',
                revealed ? 'animate-float-in' : 'animate-float-out',
              )}
              onAnimationEnd={() => {
                if (!revealed) setRenderFlyout(false);
              }}
            >
              {onDismiss && revealed && (
                <Tip text={t('chat.planPill.dismiss')}>
                  <button
                    type="button"
                    onClick={onDismiss}
                    aria-label={t('chat.planPill.dismiss')}
                    className={cn(
                      'absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full',
                      'text-[var(--msg-tool-card-chevron)] transition-colors',
                      'hover:bg-[var(--model-item-hover)] hover:text-[var(--msg-tool-card-text)]',
                      'active:scale-[0.98]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    )}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </Tip>
              )}
              <div
                className={cn(
                  'flex max-h-[280px] flex-col gap-[2px] overflow-y-auto py-[10px] pl-[14px]',
                  onDismiss ? 'pr-10' : 'pr-[14px]',
                )}
              >
                {todos.map((todo, i) => (
                  <div key={i} className="flex h-[30px] items-center gap-[10px]">
                      {/* Icon */}
                      {todo.status === 'completed' && (
                        <CircleCheck
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--msg-tool-card-chevron)]"
                        />
                      )}
                      {todo.status === 'in_progress' && (
                        // 呼吸表达"正在干活":挂侧栏运行态同款动画。按 SVG 常驻
                        // 动画红线,动画在 span wrapper 上,SVG 本体保持静态。
                        // 会话空闲(停止/失败/中断后计划仍留屏)时静止:动画只在
                        // 确有 running 语义时挂载,否则等于谎报该步骤仍在执行。
                        <span
                          data-plan-step-active="true"
                          data-plan-step-breathing={animated ? 'true' : 'false'}
                          className={cn(
                            'inline-flex shrink-0',
                            animated && 'session-status-breathing',
                          )}
                        >
                          <CircleDot
                            size={18}
                            strokeWidth={1.5}
                            className="shrink-0 text-[var(--msg-tool-card-text)]"
                          />
                        </span>
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
        )}
      </div>
    </div>
  );
}
