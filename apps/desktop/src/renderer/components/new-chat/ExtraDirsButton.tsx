/**
 * ExtraDirsButton —— composer 的「+」触发按钮(左置于权限选择器之前)。
 *
 * 2026-08 统一改版(参考 Codex Desktop):「+」不再拥有自己的 MorphPopover 菜单,
 * 而是**合成打开**与输入 `@` 完全相同的统一建议面板(AtMentionPanel):
 *   - 点击 = toggle(打开时再点关闭),打开态按钮呈按下态(aria-expanded)。
 *   - 不向文档插入 `@` 字符;打开后继续打字即过滤同一列表。
 *   - 原菜单条目(附件 / 新建目标 / 计划模式 / 协同 / 插件 / 引用目录)全部并入
 *     统一面板,由 ChatInput 以 action / resource 条目形式装配。
 *
 * 本组件只剩触发按钮本身 + ×N 引用目录徽标;所有菜单逻辑都在 ChatInput /
 * AtMentionPanel / extraDirsActions.ts。协同配置类型(CollaborationMenuConfig)
 * 仍从这里导出,保持父组件 props 契约不变。
 *
 * 视觉:trigger 是一个「+」(rounded-full / 14px 图标),有引用目录时带 ×N 角标
 * (引用目录扩大 agent 可见范围,必须在收起态外显,不允许静默 —— 2026-07-25 定稿)。
 */

import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';

export type CollabWorkerKind = 'cc' | 'codex' | 'pi';

export interface CollaborationMenuConfig {
  enabled: boolean;
  worker: CollabWorkerKind;
  onChange: (next: { enabled: boolean; worker: CollabWorkerKind }) => void;
  /** 关闭态优先打开完整 Worker 配置;未提供时直接沿用当前 worker 开启。 */
  onOpenDetails?: () => void;
  /** 策略暂不可用时允许从菜单项触发刷新。 */
  onDisabledActivate?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export interface ExtraDirsButtonProps {
  /** 引用目录数量;>0 且接线了引用目录时收起态显示 ×N。 */
  extraDirsCount: number;
  /** 父组件是否接线了引用目录持久化(决定 ×N 徽标是否有意义)。 */
  hasReferenceDirs: boolean;
  /** 统一建议面板是否处于「+」合成打开态(驱动按下态/aria-expanded)。 */
  open: boolean;
  /** 点击 toggle:关→合成打开统一面板;开→关闭。 */
  onToggle: () => void;
  disabled?: boolean;
  /** 窄容器下把 trigger 字号/图标各压一档,默认 false。 */
  dense?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
}

export function ExtraDirsButton({
  extraDirsCount,
  hasReferenceDirs,
  open,
  onToggle,
  disabled,
  dense = false,
  visualVariant = 'default',
}: ExtraDirsButtonProps) {
  const { t } = useTranslation();
  const count = extraDirsCount;
  const isCreateAgentVariant = visualVariant === 'create-agent';

  // hover 展开「添加」文案已移除(2026-07-22 用户定稿:展开必须承载信息,
  // 图标自明的 + 不需要;裸态→hover 外框→点击直接长出面板)。

  return (
    <Tip
      text={count === 0 ? t('extraDirs.tooltipEmpty') : t('extraDirs.tooltipCount', { count })}
      side="top"
    >
      <button
        type="button"
        disabled={disabled}
        // mousedown 不抢编辑器焦点(Codex 同款):合成打开后光标留在 composer,
        // 用户可直接打字过滤。面板的 click-outside 用 data 标记忽略本按钮。
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        aria-expanded={open}
        data-composer-suggestion-trigger
        className={cn(
          'flex shrink-0 items-center rounded-full transition-colors',
          // 裸态工具条(2026-07-22 用户定稿):默认无框,hover 才浮现胶囊外框。
          // create-agent(新建对话框)与会话内共用同一套裸态,不再分叉 —— 静息/hover 逐字一致。
          // 透明 border 常驻占位,避免 hover 时 1px 布局跳动。
          'h-[30px]',
          // count>0 加宽显示 ×N —— 会话内与新建草稿(create-agent)一致:引用目录
          // 扩大 agent 可见范围,必须在收起态外显,不允许静默(2026-07-25 用户定稿,
          // 取代此前 create-agent icon-only 紧凑态的决定)。
          count > 0 && hasReferenceDirs
            ? 'min-w-max justify-center gap-1 px-2.5'
            : 'w-[30px] justify-center p-0',
          'border border-transparent bg-transparent text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
          'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
          // 合成打开态与 hover 同构(按下态),关闭后回到裸态。
          open &&
            'border-[var(--border-default)] bg-[var(--composer-pill-bg,#FCFCFC)] dark:bg-[var(--composer-pill-bg,#393838)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        aria-label={t('extraDirs.menuAria')}
      >
        <Plus size={isCreateAgentVariant ? 11 : dense ? 14 : 14} className="shrink-0" />
        {count > 0 && hasReferenceDirs && (
          <span
            className={cn('font-normal tabular-nums', dense ? 'text-[12.5px]' : 'text-[13px]')}
          >
            ×{count}
          </span>
        )}
      </button>
    </Tip>
  );
}
