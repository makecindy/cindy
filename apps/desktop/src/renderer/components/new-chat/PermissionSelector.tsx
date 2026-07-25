import { useRef, useState } from 'react';
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
 * 两种 trigger 形态共用同一份选项列表与权限语义:
 *   - `chip`(默认)= composer 胶囊,唯一历史形态;
 *   - `field`  = 设置页表单字段,供「IM 机器人 → 工作目录映射」等设置卡片与
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
}: PermissionSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // field 形态的停靠侧按 trigger 当前位置**动态**选空间大的一侧(MorphPopover 按请求侧
  // 钳高、不做碰撞翻转,选侧责任在调用方)。恒定任一侧都会在某个位置截断 —— 设置页的
  // 目录卡片列表可长可短,同一个字段既可能贴视口顶也可能贴底(2026-07 Light 实测:
  // 恒 bottom 时页面末行的菜单被底部钳得只剩 2 个选项)。chip 形态仍恒向上(composer
  // 底部工具栏,历史行为)。
  const triggerElRef = useRef<HTMLButtonElement | null>(null);
  const [fieldSide, setFieldSide] = useState<'top' | 'bottom'>('bottom');
  const pickFieldSide = (): 'top' | 'bottom' => {
    const rect = triggerElRef.current?.getBoundingClientRect();
    if (!rect) return 'bottom';
    return window.innerHeight - rect.bottom >= rect.top ? 'bottom' : 'top';
  };
  const openWithSidePick = (next: boolean) => {
    if (next && triggerVariant === 'field') setFieldSide(pickFieldSide());
    setOpen(next);
  };
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
  // 窄态工具条(#562):新建对话框空间不足时权限入口图标化,防与语音/发送重叠。
  const isIconOnly = iconOnly && isCreateAgentVariant;

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

  return (
    <MorphPopover
      open={open && !disabled}
      onOpenChange={(next) => openWithSidePick(disabled ? false : next)}
      panelWidth={300}
      panelClassName="p-2"
      panelAriaLabel={t('newChat.permissionSelector.listAria')}
      // 停靠侧:composer chip 恒向上(底部工具栏,历史行为);field 按 trigger 位置
      // 动态选空间大的一侧(见 pickFieldSide 注释)。
      side={isFieldTrigger ? fieldSide : 'top'}
      // field 形态从设置页输入面生长(chip 形态仍从 composer 胶囊面生长)。
      startBg={isFieldTrigger ? 'var(--settings-input-bg)' : 'var(--composer-pill-bg)'}
      startBorderColor="var(--border-default)"
      wrapperClassName={isFieldTrigger ? 'w-full min-w-0' : 'min-w-0 shrink'}
      trigger={
        <Tip
          text={triggerDescription}
          side="top"
          contentClassName="max-w-[280px] whitespace-normal break-words text-left"
        >
          <button
            ref={triggerElRef}
            type="button"
            disabled={disabled}
            onClick={() => openWithSidePick(disabled ? false : !open)}
            aria-expanded={open && !disabled}
            aria-haspopup="listbox"
            className={cn(
              'flex min-w-0 items-center gap-1 overflow-hidden transition-colors',
              isFieldTrigger
                ? cn(
                    // 与 ModelSelector 的 field trigger 逐字对齐,两个字段才能等高成套。
                    'w-full rounded-lg border border-[var(--border-default)] bg-[var(--settings-input-bg)] px-3',
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
            aria-label={t('newChat.permissionSelector.triggerAria', { label: triggerLabel })}
          >
            {triggerContent}
          </button>
        </Tip>
      }
    >
      <div role="listbox" aria-label={t('newChat.permissionSelector.listAria')}>
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
                onClick={() => {
                  onPermissionModeChange(option.id);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isSelected}
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
    </MorphPopover>
  );
}
