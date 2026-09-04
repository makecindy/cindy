import { useTranslation } from 'react-i18next';
import { ChevronDown, Clock3, Download, Eye, Pencil, Trash2, type LucideIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { i18n } from '@/i18n';
import type { MarketSkill } from '../hooks/useMarketList';
import type { MarketCardPrimaryAction } from '../lib/marketDetailViewModel';
import { marketVisibilityLabelKey } from '../lib/marketVisibility';
import { skillPublisherLabel } from '../lib/publisherLabel';
import {
  effectivePublishedStatus,
  isEffectiveActivePublishedReview,
  publishedStatusClass,
  publishedStatusLabelKey,
} from '../lib/publishedStatus';
import { SkillIcon } from './SkillIcon';
import { SkillTagList } from './SkillTagList';

function visibilityLabel(skill: MarketSkill, allowPrivateLabel: boolean): string {
  return i18n.t(marketVisibilityLabelKey({
    visibility: skill.visibility,
    publishedVisibility: skill.publishedVisibility,
    allowPrivateLabel,
  }));
}

/** 卡片「管理」菜单里的动作(详情统一走浮窗,菜单只收管理类操作) */
export type MarketCardManageAction = 'edit' | 'manageVisibility' | 'clone' | 'delete';

interface MarketCardProps {
  skill: MarketSkill;
  primaryAction?: MarketCardPrimaryAction;
  allowPrivateVisibilityLabel?: boolean;
  /** Clone 按钮点击 → 打开 InstallTargetPicker */
  onClone: (skill: MarketSkill) => void;
  /** 管理菜单动作。仅 My Published 传入。 */
  onManageAction?: (skill: MarketSkill, action: MarketCardManageAction) => void;
  /** 整卡点击 → 更新 useMarketSelection（不打开 Picker）*/
  onClick?: (skill: MarketSkill) => void;
  /** 卡片是否处于"选中"态 — sidebar 联动时加深边框 */
  selected?: boolean;
}

function CloneButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center gap-[6px] rounded-full transition-colors',
        'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] hover:bg-[var(--lightbox-cta-hover)]',
      )}
      style={{ height: '36px', padding: '0 16px', fontSize: '13px', fontWeight: 500 }}
    >
      <Download size={14} className="shrink-0" />
      <span className="leading-none">{t('skillhub.marketCard.clone')}</span>
    </button>
  );
}

/** 管理按钮:点击直接展开菜单(编辑信息 / 管理可见性 / Clone / 删除) */
export function ManageMenu({
  skill,
  onAction,
}: {
  skill: MarketSkill;
  onAction: (skill: MarketSkill, action: MarketCardManageAction) => void;
}) {
  const { t } = useTranslation();
  // 审核中(机审/人工复核)时禁改可见性,对齐 SkillHub;编辑/删除/Clone 保留
  const inReview = isEffectiveActivePublishedReview(skill);
  const items: Array<{
    action: MarketCardManageAction;
    labelKey: string;
    icon: LucideIcon;
    danger?: boolean;
    disabled?: boolean;
  }> = [
    { action: 'edit', labelKey: 'skillhub.marketActions.edit', icon: Pencil },
    { action: 'manageVisibility', labelKey: 'skillhub.marketActions.manageVisibility', icon: Eye, disabled: inReview },
    { action: 'clone', labelKey: 'skillhub.marketActions.clone', icon: Download },
    { action: 'delete', labelKey: 'skillhub.marketActions.delete', icon: Trash2, danger: true },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 几何对齐主仓次级按钮(h-9 pill + gap-2 + 14px icon),
            底色保留浅灰 chip —— 满屏卡片场景下描边按钮过于扎眼 */}
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'flex h-9 shrink-0 items-center gap-2 rounded-full px-[18px]',
            'text-sm font-medium',
            'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)]',
            'transition-colors',
          )}
        >
          <span className="leading-none">{t('skillhub.marketCard.manage')}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        // 菜单渲染在 portal 里,但 React 事件仍沿组件树冒泡——不拦截的话,
        // 点菜单项(编辑/删除等)会触发卡片 onClick,把详情浮窗一起带出来。
        onClick={(e) => e.stopPropagation()}
        className="w-56 rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
      >
        {items.map(({ action, labelKey, icon: Icon, danger, disabled }) => {
          const item = (
            <DropdownMenuItem
              key={action}
              disabled={disabled}
              onSelect={() => onAction(skill, action)}
              className={cn(
                'h-10 rounded-lg px-3 text-sm focus:bg-[var(--cmd-palette-item-hover)]',
                danger ? 'text-[var(--error-fg)]' : 'text-[var(--msg-assistant-text)]',
                disabled && 'opacity-50',
              )}
            >
              <Icon size={15} className="mr-3 shrink-0" />
              {t(labelKey)}
            </DropdownMenuItem>
          );
          return action === 'delete'
            ? <div key={action}><DropdownMenuSeparator />{item}</div>
            : item;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MarketCard({
  skill,
  primaryAction = 'clone',
  allowPrivateVisibilityLabel = false,
  onClone,
  onManageAction,
  onClick,
  selected,
}: MarketCardProps) {
  // useTranslation: subscribe to language change so footer / visibility re-render.
  const { t, i18n: i18next } = useTranslation();
  const versionStr = `v${skill.latestVersion}`;
  const status = effectivePublishedStatus(skill);
  const language = i18next.resolvedLanguage ?? i18next.language;
  const downloads = new Intl.NumberFormat(language).format(skill.downloads);

  return (
    <div
      onClick={onClick ? () => onClick(skill) : undefined}
      className={cn(
        'select-text flex w-full flex-col rounded-xl border p-3',
        'bg-[var(--cmd-palette-bg)]',
        // 选中只改颜色,border 厚度始终 1.5px。否则 1px↔1.5px 切换会让
        // 内容区高度抖动 1px,子元素重排,产生视觉跳变。
        selected
          ? 'border-[var(--settings-theme-preview-border-active)]'
          : 'border-[var(--cmd-palette-border)]',
        onClick ? 'cursor-pointer' : '',
      )}
      style={{ gap: '10px', height: '220px', borderWidth: '1.5px' }}
    >
      {/* Title */}
      <div className="flex w-full min-w-0 items-center" style={{ gap: '10px' }}>
        <SkillIcon url={skill.icon} />
        <h3
          className="min-w-0 flex-1 truncate font-medium text-[var(--msg-assistant-text)]"
          style={{ fontSize: '16px' }}
        >
          {skill.displayName || skill.name}
        </h3>
        <SkillTagList tags={skill.tags} maxVisible={1} className="shrink-0" />
      </div>

      {/* Author · Version + Visibility tag */}
      <div className="flex w-full items-center" style={{ gap: '8px' }}>
        <span className="text-[var(--cmd-palette-item-meta)]" style={{ fontSize: '12px' }}>
          {skillPublisherLabel(skill)} · {versionStr}
        </span>
        {status ? (
          <span
            className={cn('inline-flex shrink-0 items-center justify-center rounded-full border font-medium', publishedStatusClass(status))}
            style={{ height: '20px', padding: '0 8px', fontSize: '11px' }}
          >
            {t(publishedStatusLabelKey(status))}
          </span>
        ) : null}
        <span
          className="ml-auto inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]"
          style={{ height: '20px', padding: '0 8px', fontSize: '11px' }}
        >
          {visibilityLabel(skill, allowPrivateVisibilityLabel)}
        </span>
      </div>

      {/* Description (max 3 lines) */}
      <p
        className="line-clamp-3 text-[var(--settings-section-desc)]"
        style={{ fontSize: '13px', lineHeight: 1.55 }}
      >
        {skill.description}
      </p>

      {/* Spacer */}
      <div style={{ flex: '1 1 auto' }} />

      {/* Footer: 时间戳 + 按钮 */}
      <div
        className="flex w-full items-center justify-between"
        style={{ gap: '8px', height: '36px' }}
      >
        <div
          className="flex min-w-0 items-center text-[var(--cmd-palette-item-meta)]"
          style={{ gap: '12px', fontSize: '11px' }}
        >
          <span
            className="flex min-w-0 items-center"
            style={{ gap: '4px' }}
            title={t('skillhub.marketCard.timeLabel')}
            aria-label={t('skillhub.marketCard.timeLabel')}
          >
            <Clock3 size={12} className="shrink-0" />
            <span className="truncate">{skill.relativeTime}</span>
          </span>
          <span
            className="flex shrink-0 items-center"
            style={{ gap: '4px' }}
            title={t('skillhub.marketCard.downloadsLabel')}
            aria-label={t('skillhub.marketCard.downloadsLabel')}
          >
            <Download size={12} className="shrink-0" />
            <span>{downloads}</span>
          </span>
        </div>
        {primaryAction === 'manage' && onManageAction ? (
          <ManageMenu skill={skill} onAction={onManageAction} />
        ) : primaryAction === 'clone' ? (
          <CloneButton
            onClick={(e) => {
              e.stopPropagation();
              onClone(skill);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
