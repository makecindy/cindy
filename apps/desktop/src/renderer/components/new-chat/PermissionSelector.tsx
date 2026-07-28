import { useEffect, useRef, useState } from 'react';
import {
  Hand,
  CodeXml,
  ClipboardList,
  Sparkles,
  TriangleAlert,
  ChevronDown,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { MorphPopover } from '@/components/ui/morph-popover';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import {
  useAgentCapabilities,
  type AgentKind,
  type PermissionModeDescriptor,
} from '@/hooks/useAgentCapabilities';
import type { PermissionMode } from '@/lib/userPreferences.types';

interface PermissionSelectorProps {
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  vendorKey?: 'cc' | 'codex';
  /** device-link 远程会话所属被控端 id;非空 = 权限档从被控端读(本地会话 undefined,行为不变)。 */
  deviceId?: string;
  /** 禁用 trigger。用于断线远程会话等只读 composer 状态。 */
  disabled?: boolean;
  /** 窄容器(如 doc rail)下把 trigger 字号/图标各压一档,默认 false。 */
  dense?: boolean;
  /** 极窄新建对话工具栏只显示当前权限图标，文字通过 tooltip / aria-label 提供。 */
  iconOnly?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
  /**
   * Trigger 形态:chip = composer 胶囊(默认,唯一历史形态);field = 设置页表单字段,
   * 与 ModelSelector 的 `triggerVariant="field"` 逐字对齐(同 radius / 同边框 / 同
   * 输入面 token / 同 hover),让设置卡片里的「模型」「权限模式」两个字段等高成套。
   */
  triggerVariant?: 'chip' | 'field';
  /**
   * 可及名上下文前缀(如「权限模式 · chat」)。多实例同屏(IM 目录偏好逐行一个)时
   * 前置到 trigger 的 aria-label,行与行才能被读屏区分 —— 与
   * VendorSegmentedSwitcher.ariaLabel 同一动机;单实例的 composer 不传,行为不变。
   */
  ariaContext?: string;
}

/**
 * value → icon 映射: 纯 UI 元数据, 不属于 maker capabilities。
 * 未知 id (maker 加新 mode 还没在 renderer 配图标) 走 Hand 兜底, 不影响显示。
 */
const PERMISSION_ICONS: Record<string, typeof Hand> = {
  ask: Hand,
  default: Hand,
  acceptEdits: CodeXml,
  plan: ClipboardList,
  auto: Sparkles,
  bypassPermissions: TriangleAlert,
};

function vendorKeyToAgentKind(v: 'cc' | 'codex'): AgentKind {
  return v === 'codex' ? 'codex' : 'claude-code';
}

/** Codex 不支持 acceptEdits/plan, 落到 ask 兜底 */
function normalizeMode(mode: PermissionMode, options: PermissionModeDescriptor[]): PermissionMode {
  if (options.some((o) => o.id === mode)) return mode;
  return options[0]?.id ?? mode;
}

function getModeTone(mode: PermissionMode): 'auto' | 'bypassPermissions' | null {
  if (mode === 'auto') return 'auto';
  if (mode === 'bypassPermissions') return 'bypassPermissions';
  return null;
}

/**
 * 权限模式选择器 —— 容器形变(MorphPopover)试点组件。
 * 弹层不再是 Radix Popover 浮层,而是从 trigger chip 原位生长(docs/design-rules/cindy-design-system.md §14.4
 * 容器形变类目);trigger 视觉与旧版逐像素一致,变化只在开合方式。
 *
 * 两种 trigger 形态共用同一份选项列表与权限语义,分叉的只有弹层原语:
 *   - `chip`(默认)= composer 胶囊 + MorphPopover(容器形变是 composer 专属类目,
 *     design-rules §14.4),唯一历史形态;
 *   - `field`  = 设置页表单字段 + **Radix Popover**(锚点随滚动跟随、collision 自动
 *     翻转 —— 与 ModelSelector 的 field 形态同一原语;morph 只在打开时测一次 fixed
 *     几何,设置页的滚动列里会脱锚),供「IM 机器人 → 工作目录映射」等设置卡片与
 *     ModelSelector 的 field trigger 并排成套。权限模式的可选项、Codex 归一化、
 *     危险档配色只此一份,设置页不得再私搭一套下拉。
 */
export function PermissionSelector({
  permissionMode,
  onPermissionModeChange,
  vendorKey = 'cc',
  deviceId,
  disabled = false,
  dense = false,
  iconOnly = false,
  visualVariant = 'default',
  triggerVariant = 'chip',
  ariaContext,
}: PermissionSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [focusedOptionId, setFocusedOptionId] = useState<string | null>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);
  const agentKind = vendorKeyToAgentKind(vendorKey);
  // device-link:deviceId 非空 → 权限档从被控端读(本地会话 undefined,行为不变)。
  const { capabilities } = useAgentCapabilities(agentKind, deviceId);

  const options: PermissionModeDescriptor[] = capabilities?.permissionModes ?? [];
  const effectiveMode =
    options.length > 0 ? normalizeMode(permissionMode, options) : permissionMode;
  const current = options.find((o) => o.id === effectiveMode);
  const TriggerIcon = PERMISSION_ICONS[effectiveMode] ?? Hand;
  const triggerTone = getModeTone(effectiveMode);
  const labelOf = (option: PermissionModeDescriptor | undefined, fallbackId: string) => {
    const id = option?.id ?? fallbackId;
    return t(`newChat.permissionSelector.modes.${agentKind}.${id}.label`, {
      defaultValue: option?.displayName ?? fallbackId,
    });
  };
  const descriptionOf = (option: PermissionModeDescriptor | undefined, fallbackId: string) => {
    const id = option?.id ?? fallbackId;
    return t(`newChat.permissionSelector.modes.${agentKind}.${id}.description`, {
      defaultValue: option?.description ?? '',
    });
  };
  const triggerLabel = labelOf(current, effectiveMode);
  const triggerDescription = descriptionOf(current, effectiveMode);
  const isCreateAgentVariant = visualVariant === 'create-agent';
  const isFieldTrigger = triggerVariant === 'field';
  const previousOptionsLengthRef = useRef(options.length);
  // 窄态工具条:权限语义由 tooltip + aria-label 保留，视觉收成固定宽图标。
  // 普通会话在侧栏 + 浏览器 split-pane 下同样会变窄，不能只处理 create-agent。
  const isIconOnly = iconOnly && !isFieldTrigger;

  useEffect(() => {
    if (!open) {
      setFocusedOptionId(null);
    }
  }, [open]);

  useEffect(() => {
    const previousLength = previousOptionsLengthRef.current;
    previousOptionsLengthRef.current = options.length;
    if (!open || previousLength !== 0 || options.length === 0) return;

    // capability cache miss 时，选项可能晚于弹层首次 autofocus 才返回。仅在菜单仍打开且
    // 选项从空变为可用时补聚焦一次，使 chip / field 的当前权限 tooltip 都与选择一致。
    setFocusedOptionId(effectiveMode);
    const frame = requestAnimationFrame(() => {
      selectedOptionRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, options.length, effectiveMode]);

  /** chip 内容行(icon + label + chevron) */
  const triggerContent = (
    <>
      <TriggerIcon
        size={isCreateAgentVariant ? 11 : dense ? 13 : 14}
        className="shrink-0 text-current"
      />
      {!isIconOnly && (
        <span
          className={cn(
            // min-w-0 让 span 能在 flex 容器里跌破内容宽度,truncate 才能在窄宽下出现 "完..."
            'min-w-0 font-normal text-current',
            'truncate',
            isCreateAgentVariant ? 'text-[12px]' : dense ? 'text-[12.5px]' : 'text-[13px]',
          )}
        >
          {triggerLabel}
        </span>
      )}
      {!isIconOnly && (
        // field 形态:chevron 靠右贴边(与 ModelSelector 的 field trigger 同规则),
        // chip 形态维持紧跟文字的历史排布。
        <div className={cn('pt-[2px]', isFieldTrigger && 'ml-auto')}>
          <ChevronDown
            size={isCreateAgentVariant ? 8 : dense ? 13 : 14}
            className="shrink-0 text-current"
          />
        </div>
      )}
    </>
  );

  // trigger 与选项列表在 chip(Morph)/ field(Radix)两个弹层原语间共用 —— 权限语义、
  // 归一化、危险档配色只此一份,分叉的只有弹层壳。
  const triggerButton = (
        <Tip
          text={triggerDescription}
          side="top"
          contentClassName="max-w-[280px] whitespace-normal break-words text-left"
        >
          <button
            type="button"
            disabled={disabled}
            // field 走 Radix Popover,开合交给 PopoverTrigger;chip 的 morph 自管点击。
            onClick={isFieldTrigger ? undefined : () => setOpen((prev) => (disabled ? false : !prev))}
            aria-expanded={open && !disabled}
            aria-haspopup="listbox"
            className={cn(
              'flex min-w-0 items-center gap-1 overflow-hidden transition-colors',
              isFieldTrigger
                ? cn(
                    // 与 ModelSelector 的 field trigger 逐字对齐,两个字段才能等高成套。
                    // pill 而非 8px:DESIGN.md §4 Select & Dropdown 规定单行 select trigger 同单行输入,胶囊形。
                    'w-full rounded-full border border-[var(--border-default)] bg-[var(--settings-input-bg)] px-3',
                    dense ? 'h-9' : 'h-10',
                    'text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)]',
                  )
                : cn(
                    'rounded-full',
                    // 裸态工具条(2026-07-22 用户定稿):默认无框,hover 才浮现胶囊外框。
                    // create-agent(新建对话框)与会话内共用同一套裸态,不再分叉 —— 静息/hover 逐字一致。
                    isIconOnly
                      ? 'h-[30px] w-[34px] min-w-[34px] justify-center px-0'
                      : 'h-[30px] min-w-[72px] max-w-full shrink px-2.5',
                    'border border-transparent bg-transparent text-[var(--text-primary)]',
                    'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
                  ),
              // 危险档只染文字,不改底色 —— field / chip 两形态同规则。
              triggerTone === 'auto' && 'text-[var(--perm-auto-selected-text)]',
              triggerTone === 'bypassPermissions' && 'text-[var(--perm-bypass-selected-text)]',
              disabled && 'pointer-events-none opacity-50',
            )}
            aria-label={
              ariaContext
                ? `${ariaContext}:${t('newChat.permissionSelector.triggerAria', { label: triggerLabel })}`
                : t('newChat.permissionSelector.triggerAria', { label: triggerLabel })
            }
          >
            {triggerContent}
          </button>
        </Tip>
  );

  const optionsList = (
      <div
        role="listbox"
        aria-label={t('newChat.permissionSelector.listAria')}
        className="flex flex-col gap-0.5"
        onKeyDown={(event) => {
          if (
            event.key !== 'ArrowDown' &&
            event.key !== 'ArrowUp' &&
            event.key !== 'Home' &&
            event.key !== 'End'
          ) {
            return;
          }

          const enabledOptions = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="option"]:not([disabled])',
            ),
          );
          if (enabledOptions.length === 0) return;

          event.preventDefault();
          const activeIndex = enabledOptions.indexOf(document.activeElement as HTMLButtonElement);
          let nextIndex: number;
          if (event.key === 'Home') {
            nextIndex = 0;
          } else if (event.key === 'End') {
            nextIndex = enabledOptions.length - 1;
          } else if (event.key === 'ArrowDown') {
            nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % enabledOptions.length;
          } else {
            nextIndex =
              activeIndex < 0
                ? enabledOptions.length - 1
                : (activeIndex - 1 + enabledOptions.length) % enabledOptions.length;
          }
          const nextOption = enabledOptions[nextIndex];
          if (!nextOption) return;
          setFocusedOptionId(nextOption.dataset.permissionMode ?? null);
          nextOption.focus({ preventScroll: true });
        }}
      >
        {options.map((option) => {
          const Icon = PERMISSION_ICONS[option.id] ?? Hand;
          const isSelected = effectiveMode === option.id;
          const selectedTone = isSelected ? getModeTone(option.id) : null;
          const label = labelOf(option, option.id);
          const description = descriptionOf(option, option.id);
          return (
            <Tip
              key={option.id}
              text={description}
              side="right"
              contentClassName="max-w-[280px] whitespace-normal break-words text-left"
            >
              <button
                type="button"
                ref={isSelected ? selectedOptionRef : undefined}
                // MorphPopover 打开后优先聚焦当前选中项；否则会聚焦列表首项，
                // 触发“默认权限”的 focus tooltip，造成介绍与当前权限不一致。
                data-morph-autofocus={isSelected ? '' : undefined}
                onClick={() => {
                  onPermissionModeChange(option.id);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isSelected}
                data-permission-mode={option.id}
                tabIndex={(focusedOptionId ?? effectiveMode) === option.id ? 0 : -1}
                className={cn(
                  'flex w-full items-center gap-3 rounded-[8px] px-3 py-2',
                  'transition-colors',
                  'hover:bg-[var(--model-item-hover)]',
                  // 选中底与 hover 统一到 --model-item-hover,和模型/+ 菜单一致(危险档的
                  // 橙/蓝仍只染文字,不改底色);原 --perm-item-selected-bg 在 cindy 面板上隐形。
                  isSelected && 'bg-[var(--model-item-hover)]',
                  selectedTone === 'auto' && 'text-[var(--perm-auto-selected-text)]',
                  selectedTone === 'bypassPermissions' &&
                    'text-[var(--perm-bypass-selected-text)]',
                )}
              >
                <Icon
                  size={17}
                  className={cn(
                    'shrink-0',
                    selectedTone ? 'text-current' : 'text-[var(--model-item-text)]',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[14px] font-medium',
                    selectedTone ? 'text-current' : 'text-[var(--model-item-text)]',
                  )}
                >
                  {label}
                </span>
                {isSelected && (
                  <Check
                    size={13}
                    className={cn(
                      'shrink-0',
                      selectedTone ? 'text-current' : 'text-[var(--model-item-check)]',
                    )}
                  />
                )}
              </button>
            </Tip>
          );
        })}
      </div>
  );

  // field(设置页表单字段)→ Radix Popover:锚点随滚动跟随、collision 自动翻转 ——
  // 与 ModelSelector 的 field 形态同一原语。容器形变(MorphPopover)是 composer 专属
  // 类目(design-rules §14.4),且它只在打开时测一次 fixed 几何,设置页的 overflow-y
  // 滚动列里面板会脱锚(2026-07 review 实锤),settings 一律走 Radix。
  if (isFieldTrigger) {
    return (
      <Popover open={open && !disabled} onOpenChange={(next) => setOpen(disabled ? false : next)}>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            // Radix 默认聚焦首个可交互项；与 MorphPopover 保持一致，聚焦当前选中权限，
            // 使 focus tooltip 的介绍与 field trigger 当前值一致。
            if (selectedOptionRef.current) {
              event.preventDefault();
              selectedOptionRef.current.focus({ preventScroll: true });
            }
          }}
          className={cn(
            // 面板宽度绑定 trigger 宽度(DESIGN.md §Select & Dropdown: 不许比触发它的
            // 控件更宽或更窄;Radix 语义即 --radix-popover-trigger-width)。行内容自带
            // truncate,窄字段下文案省略号收尾,描述仍有行级 tooltip 兜底。
            'w-[var(--radix-popover-trigger-width)] rounded-[12px] p-2',
            'bg-[var(--model-dropdown-bg)]',
            'border border-[var(--model-dropdown-border)]',
            // 共享 PopoverContent 自带 shadow-md;DESIGN.md §4 面板无阴影(分离感来自
            // 层色/描边),显式压掉。
            'shadow-none',
          )}
        >
          {optionsList}
        </PopoverContent>
      </Popover>
    );
  }

  // chip(composer)→ 容器形变,历史行为逐字不变。
  return (
    <MorphPopover
      open={open && !disabled}
      onOpenChange={(next) => setOpen(disabled ? false : next)}
      panelWidth={300}
      panelClassName="p-2"
      panelAriaLabel={t('newChat.permissionSelector.listAria')}
      startBg="var(--composer-pill-bg)"
      startBorderColor="var(--border-default)"
      wrapperClassName="min-w-0 shrink"
      trigger={triggerButton}
    >
      {optionsList}
    </MorphPopover>
  );
}
