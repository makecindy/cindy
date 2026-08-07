/**
 * AgentSelect —— 新建对话工具条的 Agent 引擎(harness)选择器。
 * ---------------------------------------------------------------------------
 * 取代 VendorSegmentedSwitcher 在 New Maker 工具条上的位置。分段器是定宽等分,
 * 每加一个引擎每段就窄一截(3 段 225px 时每段 75px 刚好放下 13px 图标 + 6px 间隙
 * + 43px 文字;再加就必须截断,更多只能退成 icon-only)。改成下拉后**只渲染当前
 * 引擎**,引擎数量不再影响工具条布局。
 *
 * 视觉规格:
 *   - trigger: pill h-30,px-2.5,gap-1.5;13px 引擎 mark + 12px/500 名称 +
 *     8px chevron。**宽度 hug 内容**(与同排的权限 / 模型 / 协同 pill 一致)——
 *     定宽会让「Pi」这种短名后面拖一大截空白,chevron 被顶到最右(用户实测反馈
 *     2026-08-02)。默认不限名称宽度(引擎名都很短);确有超长名的调用方传
 *     maxLabelWidth 截断。默认描边态(与协同按钮同族:有框 = 可操作控件),
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MakerVendor } from '@/lib/ccAgent.types';

import { AGENT_OPTIONS, agentOptionOf } from './agentOptions';

/**
 * 面板期望高度(px): 标题行 ~28 + 每个引擎行 ~36 + 面板 padding ~16。
 * field 形态据它判断朝下够不够 —— MorphPopover 只按给定 side 钳高、**不做碰撞
 * 翻转**, 固定 side="bottom" 时字段滚到视口底部会把菜单钳成很矮甚至 0 高,
 * 用户就选不了引擎(codex review #1490)。
 */
const FIELD_PANEL_MIN_H = 28 + AGENT_OPTIONS.length * 36 + 16;

interface AgentSelectProps {
  value: MakerVendor;
  onChange: (next: MakerVendor) => void;
  /** disabled 状态(worktree 创建中等);整体降透明且不响应点击。 */
  disabled?: boolean;
  className?: string;
  /**
   * 触发器名称部分的**最大**宽度(px),超出截断。默认不设上限 —— 宽度 hug 内容,
   * 短名(如 Pi)不留空白。工具条整体空间不足时由调用方改用 iconOnly。
   */
  maxLabelWidth?: number;
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
  /**
   * 面板弹出方向。工具条在底部所以默认 'top'; 设置面板里的字段在
   * 页面中部, 往下弹才不遮住自己(与 ModelSelector 的 popoverSide 同口径)。
   */
  side?: 'top' | 'bottom';
  /**
   * 追加到可及名前的上下文(如「字段名 · 目录别名」)。同屏多行各自一个
   * 选择器时, 读屏听到的不能全是同一个名字(与 ModelSelector.ariaContext 同规则)。
   */
  ariaContext?: string;
  /**
   * true = 重选当前项也触发 onChange。给「当前值可能是**继承值**, 重选
   * 等于把它钉成显式偏好」的场景用(工作目录偏好行); 默认只在真的换了
   * 引擎时才回调, 不产生空写。
   */
  reselectEmitsChange?: boolean;
  /**
   * 触发器形态。'toolbar'(默认) = 工具条胶囊, 宽度 hug 内容、面板 196px;
   * 'field' = 设置页字段, trigger 撑满字段宽并与单行输入同规格, 面板宽度
   * **绑定 trigger 实测宽度**(DESIGN.md §4 Select & Dropdown 的宽度铁则:
   * 面板绝不得比触发控件更宽或更窄 —— 直接把工具条形态放进字段时, 短标签
   * (Claude / Pi)会让 196px 面板明显宽于 trigger, codex review #1490)。
   */
  triggerVariant?: 'toolbar' | 'field';
  /** field 形态的紧凑高(h-9); 与同排 ModelSelector 的 dense 保持一致。 */
  dense?: boolean;
  /**
   * false 时改用 Radix Popover。嵌在 Radix Dialog 内必须关闭 MorphPopover：
   * custom portal 不属于 Dialog focus scope，动画结束聚焦选中项时会被拉回并自动收起。
   */
  useMorphPopover?: boolean;
  /** Radix PopoverContent 的附加 class（例如高层级 Dialog 内的 z-index）。 */
  overlayContentClassName?: string;
}

export function AgentSelect({
  value,
  onChange,
  disabled = false,
  className,
  maxLabelWidth,
  iconOnly = false,
  visualVariant = 'default',
  hiddenVendors,
  side = 'top',
  ariaContext,
  reselectEmitsChange = false,
  triggerVariant = 'toolbar',
  dense = false,
  useMorphPopover = true,
  overlayContentClassName,
}: AgentSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  /** field 形态每次打开前按上下可用空间定的方向; null = 用调用方给的 side。 */
  const [autoSide, setAutoSide] = useState<'top' | 'bottom' | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);
  const isCreateAgent = visualVariant === 'create-agent';
  const isField = triggerVariant === 'field';
  const morphEnabled = useMorphPopover;
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

  /**
   * field 形态: 面板打开期间祖先一滚就关掉。
   *
   * MorphPopover 是**形变定位** —— 打开那一刻按触发器的位置算好坐标并钉住(它服务的
   * composer toolbar 固定在底部, 没有可滚动祖先, 所以够用)。设置页不一样: 内容列本身
   * 可滚, 滚一下面板就与字段分离、悬在半空(review 指出)。这里不给 MorphPopover 补一套
   * 跟随定位(那是把工具条的形变语义扩成通用锚点定位, 影响面远超本 PR), 改为在祖先滚动 /
   * 视口变化时收起 —— 与常见下拉的行为一致, 且不会留下错位的面板。
   *
   * capture 阶段监听: scroll 不冒泡, 只有捕获期才能收到祖先滚动容器的事件。
   */
  useEffect(() => {
    if (!morphEnabled || !isField || !open) return;
    const close = (): void => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [isField, morphEnabled, open]);

  /**
   * 朝下空间放得下就朝下(设置字段的自然方向), 否则比较上下取更宽裕的一侧。
   * 只作用于 field 形态: 工具条永远在底部, 方向由调用方定死。
   */
  const resolveFieldSide = (): 'top' | 'bottom' => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return side;
    const below = window.innerHeight - rect.bottom;
    if (below >= FIELD_PANEL_MIN_H) return 'bottom';
    return below >= rect.top ? 'bottom' : 'top';
  };

  const select = (next: MakerVendor) => {
    setOpen(false);
    if (next !== value || reselectEmitsChange) onChange(next);
  };

  const handleOpenChange = (next: boolean): void => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (morphEnabled && isField && next) setAutoSide(resolveFieldSide());
    setOpen(next);
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
      ref={triggerRef}
      type="button"
      disabled={disabled}
      // 阻 mousedown 抢焦点 —— 否则点击时下方 ChatInput 的 :focus-within 边框会瞬间掉色。
      // 键盘 Tab 仍可正常 focus(preventDefault 只阻断鼠标路径)。
      onMouseDown={morphEnabled ? (e) => e.preventDefault() : undefined}
      onClick={morphEnabled ? () => handleOpenChange(!open) : undefined}
      aria-expanded={open && !disabled}
      aria-haspopup="listbox"
      aria-label={
        ariaContext
          ? `${ariaContext} · ${t('newChat.agentSelect.trigger.aria', { agent: current.label })}`
          : t('newChat.agentSelect.trigger.aria', { agent: current.label })
      }
      title={current.label}
      className={cn(
        'flex items-center gap-1.5 rounded-full transition-colors',
        // 字段形态: 撑满字段、高度与同排选择器对齐, 底色走设置页输入框 token
        // (与 ModelSelector 的 field trigger 同规格); 工具条形态保持 hug 不变。
        isField
          ? cn('w-full min-w-0 px-3', dense ? 'h-9' : 'h-10')
          : cn(
              'shrink-0',
              // 工具条高度是 CREATE AGENT 视觉契约锁定值(见
              // newMakerCreateAgentVisualContract.test.ts), 保持独立字面量。
              'h-[30px]',
              iconOnly ? 'w-[34px] min-w-[34px] justify-center px-0' : 'px-2.5',
            ),
        isCreateAgent
          ? [
              'border border-[var(--create-agent-control-border)]',
              'bg-[var(--create-agent-control-bg)] text-[var(--create-agent-control-text)]',
            ]
          : [
              'border border-[var(--border-default)]',
              // 字段形态用设置页输入框底色; 工具条形态用 composer pill 底色。
              isField
                ? 'bg-[var(--settings-input-bg)]'
                : 'bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)]',
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
    >
      <current.Mark size={13} className="shrink-0" />
      {!iconOnly && (
        <>
          {/* 不用 flex-1:撑满会把 chevron 顶到最右,短引擎名后面拖一片空白。
              文字下沉 0.5px —— Inter 在 leading-none 下视觉重心偏上,与 mark 光学居中对齐。 */}
          <span
            className={cn(
              'min-w-0 truncate text-left font-medium leading-none',
              // 字段形态跟随设置页字号(13px, 同 ModelSelector field trigger);
              // flex-1 把 chevron 顶到右缘 —— 字段是定宽控件, 不是 hug。
              isField ? 'flex-1 text-[13px]' : 'text-[12px]',
            )}
            style={maxLabelWidth ? { maxWidth: maxLabelWidth } : undefined}
          >
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

  const optionsList = (
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
              ref={selected ? selectedOptionRef : undefined}
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
  );

  if (morphEnabled) {
    return (
      <MorphPopover
        open={open && !disabled}
        onOpenChange={handleOpenChange}
        side={isField ? (autoSide ?? side) : side}
        align="start"
        // 字段形态不传定宽, 改用 trigger 实测宽度(DESIGN.md §4 宽度铁则)。
        {...(isField ? { panelWidthMode: 'trigger' as const } : { panelWidth: 196 })}
        panelClassName="p-2"
        panelAriaLabel={t('newChat.agentSelect.label')}
        startBg={
          isCreateAgent ? 'var(--create-agent-control-bg)' : 'var(--composer-pill-bg, #FCFCFC)'
        }
        startBorderColor={
          isCreateAgent ? 'var(--create-agent-control-border)' : 'var(--border-default)'
        }
        // 字段形态: wrapper 也要撑满, 否则 inline-flex + shrink-0 会把 trigger 的
        // w-full 压回内容宽, 面板跟着缩 —— 字段就不是字段宽了。
        wrapperClassName={isField ? 'w-full min-w-0' : 'shrink-0'}
        trigger={trigger}
      >
        {optionsList}
      </MorphPopover>
    );
  }

  return (
    <Popover open={open && !disabled} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => {
          if (!selectedOptionRef.current) return;
          event.preventDefault();
          selectedOptionRef.current.focus({ preventScroll: true });
        }}
        className={cn(
          isField ? 'w-[var(--radix-popover-trigger-width)]' : 'w-[196px]',
          'overflow-hidden rounded-[12px] border p-2 shadow-[var(--shadow-menu)]',
          'border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)]',
          overlayContentClassName,
        )}
      >
        {optionsList}
      </PopoverContent>
    </Popover>
  );
}
