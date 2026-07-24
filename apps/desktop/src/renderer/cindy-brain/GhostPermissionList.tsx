/**
 * 装入/更新确认框的逐项权限清单(docs/dev-rules/plugin-security-and-authoring.md)。
 *
 * 纯展示组件:条目由 shared/ghost.ts 的 ghostPermissionItems /
 * diffGhostPermissionItems 静态推导(装入前无需运行意识代码),这里只负责
 * 翻译与排版。装入分支渲染全量清单;更新分支只高亮权限 diff(新增/移除),
 * 不变项折叠成一行计数——权限没变的更新不该让用户重读一遍清单。
 */
import {
  AppWindow,
  Bell,
  BadgeCheck,
  Bot,
  ChevronDown,
  Cpu,
  FileCode2,
  FilePen,
  FolderOpen,
  Globe,
  KeyRound,
  LayoutTemplate,
  MapPin,
  Megaphone,
  PanelLeft,
  PanelRight,
  Sparkles,
  ShieldAlert,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { flashScrollbar } from '@/lib/scrollbarAutoHide';
import { cn } from '@/lib/utils';
import type {
  GhostPermissionDiff,
  GhostPermissionItem,
  GhostTrustInfo,
} from '../../shared/ghost';

const KIND_ICON: Record<GhostPermissionItem['kind'], LucideIcon> = {
  cindy: Sparkles, // 与详情页「Cindy 能力」区同款图标
  agent: Bot,
  node: Cpu,
  tool: Wrench,
  command: Terminal,
  panel: PanelRight,
  code: FileCode2,
  subscribe: Bell,
  card: LayoutTemplate,
  network: Globe,
  notify: Megaphone,
  fs: FilePen,
  'session-context': MapPin,
  pick: FolderOpen,
  preview: AppWindow,
};

function itemIcon(item: GhostPermissionItem): LucideIcon {
  if (item.labelKey === 'panelLeft') return PanelLeft;
  // network 槽的凭证条目换钥匙图标(与域名条目区分:一个是"去哪",一个是"带什么")。
  if (
    item.labelKey === 'networkSecret' ||
    item.labelKey === 'networkSecretOauth' ||
    item.labelKey === 'nodeSecret'
  )
    return KeyRound;
  return KIND_ICON[item.kind];
}

function PermRow({ item, badge }: { item: GhostPermissionItem; badge?: 'added' | 'removed' }) {
  const { t } = useTranslation();
  const Icon = itemIcon(item);
  // 主机固定说明(detailKey)与作者自由文本(detail)可以并存(oauth 凭证:
  // 说明 + scopes 原文清单)——都在时两行都渲染,不许作者文本顶掉主机说明。
  const hostDetail = item.detailKey ? t(`settings.ghosts.perm.${item.detailKey}`) : undefined;
  const authorDetail = item.detail;
  return (
    <div className={cn('flex items-start gap-2 py-1', badge === 'removed' && 'opacity-60')}>
      <span className="mt-[2px] shrink-0 text-[var(--text-tertiary)]">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-13 leading-[1.5] text-[var(--confirm-desc)]',
            badge === 'removed' && 'line-through',
          )}
        >
          {t(`settings.ghosts.perm.${item.labelKey}`, item.labelArgs)}
        </div>
        {hostDetail && (
          <div className="break-words text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {hostDetail}
          </div>
        )}
        {authorDetail && (
          // 作者文本按原样换行展示(scopes 一行一条等,知情面不做加工)。
          <div className="whitespace-pre-line break-words text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {authorDetail}
          </div>
        )}
      </div>
      {badge && (
        // diff 语义豁免色(docs/design-rules/cindy-design-system.md §2 / 规则 16):权限新增/移除就是一次 diff,
        // 用 GitHub diff 红绿 token,跨主题一致;徽章是 chrome,select-none。
        <span
          className={cn(
            'mt-[2px] shrink-0 select-none rounded px-1.5 py-px text-11 font-medium',
            badge === 'added'
              ? 'bg-[var(--diff-add-bg)] text-[var(--diff-add-fg)]'
              : 'bg-[var(--diff-del-bg)] text-[var(--diff-del-fg)]',
          )}
        >
          {t(`settings.ghosts.perm.${badge}`)}
        </span>
      )}
    </div>
  );
}

/**
 * 全量权限行(无标题):装入确认框与详情页「权限」卡共用同一渲染,
 * 保证"事前看到的"和"事后查到的"逐像素一致,不出两套口径。
 */
export function GhostPermissionRows({ items }: { items: GhostPermissionItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      {items.map((item) => (
        <PermRow key={item.key} item={item} />
      ))}
    </div>
  );
}

/**
 * 工具说明由意识作者自由填写,往往是整段接口文档。安装确认只先报工具数量,
 * 用户主动展开后再显示原文,避免常规工具把真正需要留意的权限挤出屏幕。
 */
function GhostToolPermissionGroup({ items }: { items: GhostPermissionItem[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-xl border border-[var(--border-default)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-13 text-[var(--confirm-desc)]"
      >
        <Wrench size={14} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="flex-1">{t('settings.ghosts.perm.toolsGroup')}</span>
        <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
          {t('settings.ghosts.perm.itemCount', { count: items.length })}
        </span>
        <ChevronDown
          size={14}
          className={cn(
            'shrink-0 text-[var(--text-tertiary)] transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-[var(--border-default)] px-3 py-2">
          <GhostPermissionRows items={items} />
        </div>
      )}
    </div>
  );
}

/** 装入确认:全量逐项清单;工具长说明默认折叠,其余权限仍直接展示。 */
export function GhostPermissionList({ items }: { items: GhostPermissionItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const firstToolIndex = items.findIndex((item) => item.kind === 'tool');
  const toolItems = items.filter((item) => item.kind === 'tool');
  const beforeTools =
    firstToolIndex < 0
      ? items
      : items.slice(0, firstToolIndex).filter((item) => item.kind !== 'tool');
  const afterTools =
    firstToolIndex < 0 ? [] : items.slice(firstToolIndex).filter((item) => item.kind !== 'tool');

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-12 font-medium text-[var(--text-tertiary)]">
        <span>{t('settings.ghosts.perm.grantsTitle')}</span>
        <span>{t('settings.ghosts.perm.itemCount', { count: items.length })}</span>
      </div>
      <GhostPermissionRows items={beforeTools} />
      {toolItems.length > 0 && <GhostToolPermissionGroup items={toolItems} />}
      <GhostPermissionRows items={afterTools} />
    </div>
  );
}

/** 主机验出的包来源/签名摘要；不读取作者可伪造的 ghost.json 文案。 */
export function GhostTrustSummary({ trust }: { trust: GhostTrustInfo }) {
  const { t } = useTranslation();
  const trusted = trust.level !== 'unverified';
  const Icon = trusted ? BadgeCheck : ShieldAlert;
  const labelKey =
    trust.level === 'cindy-official'
      ? 'official'
      : trust.level === 'reviewed'
        ? 'reviewed'
        : trust.level === 'verified-publisher'
          ? 'verifiedPublisher'
          : trust.publisherSigned
            ? 'signedUnverified'
            : 'unsigned';
  return (
    <div className="mt-3 flex items-start gap-2 rounded-xl border border-[var(--border-default)] p-3">
      <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-13 font-medium leading-5 text-[var(--confirm-desc)]">
          {t(`settings.ghosts.trust.${labelKey}`, {
            publisher: trust.publisherName ?? t('settings.ghosts.trust.unknownPublisher'),
          })}
        </p>
        <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {t(
            trust.unknownReviewer
              ? 'settings.ghosts.trust.unknownReviewerDetail'
              : `settings.ghosts.trust.${labelKey}Detail`,
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * 安装确认的紧凑内容区:简介可折叠,作者/版本单列,详情只在弹窗内部滚动。
 * 安全相关权限不做总折叠,避免为了短而牺牲知情确认。
 */
export function GhostInstallReview({
  description,
  meta,
  trust,
  items,
}: {
  description?: string;
  meta: string;
  trust: GhostTrustInfo;
  items: GhostPermissionItem[];
}) {
  const { t } = useTranslation();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canCollapseDescription = Boolean(
    description && (description.length > 160 || description.includes('\n')),
  );

  const revealScrollbar = () => {
    requestAnimationFrame(() => {
      if (scrollRef.current) flashScrollbar(scrollRef.current);
    });
  };

  // 初次出现以及展开介绍/工具后都短暂亮出滚动条,明确告诉用户内容还能往下看。
  useEffect(revealScrollbar, []);

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto overscroll-contain pr-1"
      style={{ maxHeight: 'min(56vh, 520px)', scrollbarGutter: 'stable' }}
      onClickCapture={revealScrollbar}
    >
      {description && (
        <div>
          <p
            className={cn(
              'whitespace-pre-line break-words text-13 leading-[1.55] text-[var(--confirm-desc)]',
              canCollapseDescription && !descriptionExpanded && 'line-clamp-3',
            )}
          >
            {description}
          </p>
          {canCollapseDescription && (
            <button
              type="button"
              aria-expanded={descriptionExpanded}
              onClick={() => setDescriptionExpanded((value) => !value)}
              className="mt-1 rounded-full text-12 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              {t(
                descriptionExpanded
                  ? 'settings.ghosts.installConfirm.collapseDescription'
                  : 'settings.ghosts.installConfirm.expandDescription',
              )}
            </button>
          )}
        </div>
      )}
      <p className={cn('text-12 leading-[1.5] text-[var(--text-tertiary)]', description && 'mt-2')}>
        {meta}
      </p>
      <GhostTrustSummary trust={trust} />
      <div className="mt-3 border-t border-[var(--border-default)] pt-3">
        <GhostPermissionList items={items} />
      </div>
    </div>
  );
}

/** 更新确认:只展示权限变化(新增/移除),不变项折叠成一行计数。 */
export function GhostPermissionDiffView({ diff }: { diff: GhostPermissionDiff }) {
  const { t } = useTranslation();
  const changed = diff.added.length > 0 || diff.removed.length > 0;
  if (!changed) {
    return (
      <div className="text-12 text-[var(--text-tertiary)]">
        {t('settings.ghosts.perm.noChange')}
      </div>
    );
  }
  return (
    <div>
      {diff.added.map((item) => (
        <PermRow key={`added:${item.key}`} item={item} badge="added" />
      ))}
      {diff.removed.map((item) => (
        <PermRow key={`removed:${item.key}`} item={item} badge="removed" />
      ))}
      {diff.unchanged.length > 0 && (
        <div className="mt-1 text-12 text-[var(--text-tertiary)]">
          {t('settings.ghosts.perm.unchanged', { count: diff.unchanged.length })}
        </div>
      )}
    </div>
  );
}
