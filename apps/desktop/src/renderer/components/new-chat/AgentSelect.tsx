/**
 * AgentSelect —— 新建对话工具条的 Agent 引擎(harness)选择器。
 * ---------------------------------------------------------------------------
 * 取代 VendorSegmentedSwitcher 在 New Maker 工具条上的位置。分段器是定宽等分,
 * 每加一个引擎每段就窄一截(2 段 150px 时每段 75px 刚好放下 13px 图标 + 6px 间隙
 * + 43px 文字;3 段就必须截断,再多只能退成 icon-only)。改成下拉后触发器定宽,
 * 引擎数量不再影响工具条布局。
 *
 * 视觉规格:
 *   - trigger: pill h-30,px-2.5,gap-1.5;13px 引擎 mark + 12px/500 名称 +
 *     8px chevron(右对齐)。默认描边态(与协同按钮同族:有框 = 可操作控件),
 *     与右侧裸态的模型触发器区分。
 *   - 面板: MorphPopover,panelWidth 196,p-2;标题行「引擎」+ 单行选项 +
 *     15px Check。行 rounded-8 px-3 py-2,13px/500。
 *
 * 选中态是持久的:调用方(NewMakerDraftRoute)把 vendor 存在 newMakerDraft 的
 * localStorage 快照里,切换即写盘,重启后 sanitize 读回 —— 打开菜单时初始焦点
 * 落在**当前选中项**而非第一项,与「记住上次用的引擎」是同一件事的两面。
 * 该焦点由选中行上的 `data-morph-autofocus` 单点决定(MorphPopover 在形变结束后
 * 按它聚焦);不要再叠一层自己的 rAF focus —— 两层会打架,后跑的那层说了算。
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { MorphPopover } from '@/components/ui/morph-popover';
import type { MakerVendor } from '@/lib/ccAgent.types';

import { AGENT_OPTIONS, agentOptionOf } from './agentOptions';

interface AgentSelectProps {
  value: MakerVendor;
  onChange: (next: MakerVendor) => void;
  /** disabled 状态(worktree 创建中等);整体降透明且不响应点击。 */
  disabled?: boolean;
  className?: string;
  /** 触发器定宽(px)。引擎数量不影响它 —— 只需容纳最长的引擎名。 */
  width?: number;
  /** 窄态工具栏只保留引擎 mark,名称通过 title / aria-label 提供。 */
  iconOnly?: boolean;
  /**
   * CREATE AGENT 首页复用该页的私有控件 token(与权限选择器、协同按钮同族);
   * default 走 composer 通用 pill token。
   */
  visualVariant?: 'default' | 'create-agent';
  /**
   * 从列表里**隐藏**的引擎(如 runtime 未注册的 Pi、SSH 远程草稿下的 Pi)。
   * 创建入口据 `maker:list-available-agents` 计算,避免用户创建出最终
   * `Agent 'pi' is not registered` 的会话。当前 `value` 始终保留可见,
   * 否则触发器会显示一个列表里不存在的引擎。
   */
  hiddenVendors?: readonly MakerVendor[];
}

export function AgentSelect({
  value,
  onChange,
  disabled = false,
  className,
  width = 112,
  iconOnly = false,
  visualVariant = 'default',
  hiddenVendors,
}: AgentSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const isCreateAgent = visualVariant === 'create-agent';
  const current = agentOptionOf(value);
  // 当前值始终保留 —— 隐藏它会让触发器显示一个列表里不存在的引擎。
  const visibleOptions =
    hiddenVendors && hiddenVendors.length > 0
      ? AGENT_OPTIONS.filter((opt) => opt.vendor === value || !hiddenVendors.includes(opt.vendor))
      : AGENT_OPTIONS;

  // disabled 中途变 true(如 worktree 创建中)时把 open 收敛掉 —— 只靠
  // `open={open && !disabled}` 只是不渲染面板,本地 open 仍是 true,disabled
  // 恢复后面板会自己弹回来(copilot review)。
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const select = (next: MakerVendor) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  // ↑↓ 在选项间移动(菜单语义);Home/End 跳首尾。Esc / 外部点击由 MorphPopover 兜。
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (at + 1 + items.length) % items.length
            : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      // 阻 mousedown 抢焦点 —— 否则点击时下方 ChatInput 的 :focus-within 边框会瞬间掉色。
      // 键盘 Tab 仍可正常 focus(preventDefault 只阻断鼠标路径)。
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setOpen((prev) => (disabled ? false : !prev))}
      aria-expanded={open && !disabled}
      aria-haspopup="listbox"
      aria-label={t('newChat.agentSelect.trigger.aria', { agent: current.label })}
      title={current.label}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full transition-colors',
        'h-[30px]',
        iconOnly ? 'w-[34px] min-w-[34px] justify-center px-0' : 'px-2.5',
        isCreateAgent
          ? [
              'border border-[var(--create-agent-control-border)]',
              'bg-[var(--create-agent-control-bg)] text-[var(--create-agent-control-text)]',
            ]
          : [
              'border border-[var(--border-default)]',
              'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)]',
              'text-[var(--text-primary)]',
            ],
        // 交互态按变体取:create-agent 有自己的 hover/pressed token(某些主题下
        // 静止底色与 --model-trigger-hover 同色,共用会导致 hover 无反馈,codex review)。
        isCreateAgent
          ? [
              'hover:bg-[var(--create-agent-control-bg-hover)]',
              'active:bg-[var(--create-agent-control-bg-pressed)]',
            ]
          : ['hover:bg-[var(--model-trigger-hover)]', 'active:bg-[var(--surface-hover)]'],
        // globals.css 全局移除了非输入控件的 outline,焦点反馈必须自己给
        // (被替换的分段器原本靠 focus-within:ring-2 提供)。
        'focus-visible:outline-none focus-visible:ring-2',
        isCreateAgent
          ? 'focus-visible:ring-[var(--create-agent-focus-ring)]'
          : 'focus-visible:ring-[var(--focus-ring)]',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
      style={iconOnly ? undefined : { width }}
    >
      <current.Mark size={13} className="shrink-0" />
      {!iconOnly && (
        <>
          {/* 文字下沉 0.5px —— Inter 在 leading-none 下视觉重心偏上,与 mark 光学居中对齐 */}
          <span className="min-w-0 flex-1 truncate text-left text-[12px] font-medium leading-none">
            <span className="inline-block translate-y-[0.5px]">{current.label}</span>
          </span>
          <ChevronDown
            size={8}
            className={cn(
              'shrink-0',
              isCreateAgent
                ? 'text-[var(--create-agent-control-icon)]'
                : 'text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
            )}
          />
        </>
      )}
    </button>
  );

  return (
    <MorphPopover
      open={open && !disabled}
      onOpenChange={(next) => setOpen(disabled ? false : next)}
      side="top"
      align="start"
      panelWidth={196}
      panelClassName="p-2"
      panelAriaLabel={t('newChat.agentSelect.label')}
      startBg={
        isCreateAgent ? 'var(--create-agent-control-bg)' : 'var(--composer-pill-bg, #FCFCFC)'
      }
      startBorderColor={
        isCreateAgent ? 'var(--create-agent-control-border)' : 'var(--border-default)'
      }
      wrapperClassName="shrink-0"
      trigger={trigger}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={t('newChat.agentSelect.label')}
        onKeyDown={onListKeyDown}
        className="flex flex-col gap-0.5"
      >
        <div className="px-2.5 pb-2 pt-1.5 text-11 leading-none text-[var(--model-section-label)]">
          {t('newChat.agentSelect.label')}
        </div>
        {visibleOptions.map((opt) => {
          const selected = opt.vendor === value;
          return (
            <button
              key={opt.vendor}
              type="button"
              role="option"
              aria-selected={selected}
              data-agent-selected={selected ? 'true' : undefined}
              // MorphPopover 形变结束后按此标记聚焦 —— 缺它会回落到"面板内第一个
              // 可交互项",焦点跳到 Claude,回车就选错引擎(3 个 reviewer 同时指出)。
              data-morph-autofocus={selected ? 'true' : undefined}
              data-testid={`agent-select-option-${opt.vendor}`}
              onClick={() => select(opt.vendor)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left',
                'transition-colors duration-100 hover:bg-[var(--model-item-hover)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                selected && 'bg-[var(--model-item-hover)]',
              )}
            >
              <opt.Mark size={14} className="shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--model-item-text)]">
                {opt.label}
              </span>
              {selected && (
                <Check size={15} className="shrink-0 text-[var(--model-item-check)]" />
              )}
            </button>
          );
        })}
      </div>
    </MorphPopover>
  );
}
