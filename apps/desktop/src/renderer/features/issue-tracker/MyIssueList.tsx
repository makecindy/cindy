/**
 * MyIssueList —— 「我的 Issue」列表本体。
 *
 * 每行两段:标题一行 + 元信息一行(#编号 · 状态 · 类型 · 来源 · 日期 · 评论数)。
 * 整行点击外链到 GitHub —— 详情、评论都在 GitHub 上,应用内不复刻。
 *
 * 配色严格灰度(DESIGN.md §2:非灰色需登记):open / closed / unknown 用实心点、
 * 空心点、虚线点区分,并且**同时**给出状态文字 —— 不靠形状或颜色单独承载语义。
 */

import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MyIssueItem } from '@/../shared/myIssues';
import { cn } from '@/lib/utils';

interface MyIssueListProps {
  items: MyIssueItem[];
}

export function MyIssueList({ items }: MyIssueListProps) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <MyIssueRow key={item.number} item={item} />
      ))}
    </ul>
  );
}

function MyIssueRow({ item }: { item: MyIssueItem }) {
  const { t, i18n } = useTranslation();

  const statusLabel =
    item.state === 'open'
      ? t('issueTracker.status.open')
      : item.state === 'closed'
        ? t('issueTracker.status.closed')
        : t('issueTracker.mine.statusUnknown');

  const meta = [
    `#${item.number}`,
    statusLabel,
    item.type ? t(`issueTracker.type.${item.type}`) : null,
    ...item.sources.map((source) =>
      source === 'cindy-tool'
        ? t('issueTracker.mine.sourceCindy')
        : t('issueTracker.mine.sourceGithub'),
    ),
    formatDate(item.createdAt, i18n.language),
    // 显式判 null 而不是 falsy:0 是「已知 0 条」的有效值,不能和 null(未知)混为一谈。
    // 判完再要求 > 0 —— 「0 条评论」对用户没有信息量,不占元信息行的位置(这是刻意的
    // 展示取舍,不是把 0 当假值漏掉)。
    item.commentCount !== null && item.commentCount > 0
      ? t('issueTracker.mine.commentCount', { count: item.commentCount })
      : null,
  ].filter((part): part is string => !!part);

  return (
    <li>
      <button
        type="button"
        onClick={() => window.electronAPI.openExternal(item.url)}
        title={t('issueTracker.mine.openOnGithub')}
        className={cn(
          'group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left',
          'transition-colors hover:bg-sidebar-item-hover',
        )}
      >
        <StatusDot state={item.state} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className={cn(
              'truncate text-13 text-foreground',
              // 已关闭的降一档存在感,但不靠它承载语义(状态文字在元信息里)。
              item.state === 'closed' && 'text-sidebar-muted',
            )}
          >
            {item.title}
          </span>
          <span className="truncate text-11 text-sidebar-muted">{meta.join(' · ')}</span>
        </span>
        <ExternalLink
          size={13}
          className="mt-0.5 shrink-0 text-sidebar-muted opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </button>
    </li>
  );
}

function StatusDot({ state }: { state: MyIssueItem['state'] }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-[7px] size-2 shrink-0 rounded-full',
        state === 'open' && 'bg-foreground',
        state === 'closed' && 'border border-sidebar-muted',
        state === 'unknown' && 'border border-dashed border-sidebar-muted',
      )}
    />
  );
}

/** 列表跨月跨年,相对时间不如短日期好用;走 Intl 保证四种界面语言都读得通。 */
function formatDate(iso: string, locale: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date);
  } catch {
    // 非法 locale 标签时退回 ISO 日期段,不让一行日期把整页拖崩。
    return iso.slice(0, 10);
  }
}
