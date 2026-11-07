/**
 * 群设置抽屉的分组与行：组名在卡片外，一张卡片放多行、行间缩进分割线；行左边是名称与
 * 一行说明，右边是当前值、控件或进入下一页的箭头。整行可点时只有一个点击目标。
 * 行高 48（带头像 52），名称 14、说明 12、当前值 13；文字行高用无单位比例，跟随
 * 「外观 → UI 字号」放大（DESIGN.md §3）。
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { ChevronRight, Info } from 'lucide-react';

import { cn } from '@/lib/utils';

export const SETTINGS_DIVIDER = 'relative [&:not(:first-child)]:before:pointer-events-none [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-4 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-[var(--border-default)]';
const CARD = 'overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]';
export const SETTINGS_HINT = 'text-12 leading-[1.42] text-[var(--text-secondary)] [text-wrap:pretty]';

export function SettingsSection({ title, count, action, caption, children, testId }: {
  title?: ReactNode; count?: number; action?: ReactNode; caption?: ReactNode; children: ReactNode; testId?: string;
}) {
  return <section className="flex min-w-0 flex-col" data-testid={testId}>
    {(title || action) && <div className="mb-2 flex min-h-6 items-center justify-between gap-3">
      <h3 className="min-w-0 text-13 font-medium leading-[1.38] text-[var(--text-secondary)]">
        {title}{count !== undefined && <span className="ml-1.5 font-normal tabular-nums text-[var(--text-tertiary)]">{count}</span>}
      </h3>
      {action}
    </div>}
    {children}
    {caption && <p className={cn('mt-2', SETTINGS_HINT)}>{caption}</p>}
  </section>;
}

export function SettingsCard({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(CARD, className)} {...rest} />;
}

export interface SettingsRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'value'> {
  lead?: ReactNode;
  title: ReactNode;
  /** A small tag after the name, such as 「你」. */
  tag?: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  /** A control on the right; the row itself is then not a button. */
  trailing?: ReactNode;
  /** Rows with a 28–32px avatar. */
  media?: boolean;
  /** The control drops under the text when both cannot share a line. */
  wrap?: boolean;
  danger?: boolean;
  /** Rendered as a button when given. */
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
}

export function SettingsRow({ lead, title, tag, hint, value, chevron, trailing, media, wrap, danger, onClick, disabled, className, ...rest }: SettingsRowProps) {
  const interactive = !!onClick;
  const body = <>
    {lead && <span className="flex shrink-0">{lead}</span>}
    <span className={cn('flex min-w-0 flex-col', wrap ? 'flex-[1_1_200px]' : 'flex-1')}>
      <span className={cn('flex min-w-0 items-baseline gap-1.5 text-14 leading-[1.43]', danger ? 'text-[var(--text-danger)]' : 'text-[var(--text-primary)]')}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        {tag && <span className="shrink-0 text-12 leading-[1.33] text-[var(--text-tertiary)]">{tag}</span>}
      </span>
      {hint && <span className={cn('mt-0.5', SETTINGS_HINT)}>{hint}</span>}
    </span>
    {trailing ?? ((value !== undefined || chevron) && <span className="flex max-w-[55%] shrink-0 items-center gap-1 text-13 leading-[1.38] text-[var(--text-secondary)]">
      {value !== undefined && <span className="text-right [overflow-wrap:anywhere]">{value}</span>}
      {chevron && <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />}
    </span>)}
  </>;
  const classes = cn(
    'flex w-full items-center gap-3 px-4 text-left', SETTINGS_DIVIDER,
    media ? 'min-h-[52px] py-2' : 'min-h-12 py-3',
    wrap && 'flex-wrap gap-y-2.5',
    disabled && 'opacity-60',
    className,
  );
  if (!interactive) return <div className={classes} aria-disabled={disabled || undefined}>{body}</div>;
  return <button type="button" {...rest} disabled={disabled} onClick={onClick} className={cn(classes,
    'outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
    !disabled && (danger ? 'hover:bg-[color-mix(in_srgb,var(--text-danger)_8%,transparent)]' : 'hover:bg-[var(--surface-hover)]'))}>{body}</button>;
}

/** A 32px round icon tile leading a row (群管理, AI 代答 without a teammate). */
export function SettingsRowIcon({ children }: { children: ReactNode }) {
  return <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">{children}</span>;
}

/** A one-paragraph state notice (archived, dissolved, only you left). */
export function SettingsNotice({ children, tone = 'info', action }: { children: ReactNode; tone?: 'info' | 'error'; action?: ReactNode }) {
  return <div role={tone === 'error' ? 'alert' : undefined} className={cn(CARD, 'flex gap-2.5 px-3.5 py-3 text-13 leading-[1.54] text-[var(--text-primary)]')}>
    <Info size={16} aria-hidden className={cn('mt-0.5 shrink-0', tone === 'error' ? 'text-[var(--text-danger)]' : 'text-[var(--text-tertiary)]')} />
    <div className="min-w-0 flex-1">{children}{action && <div className="mt-2 flex gap-2">{action}</div>}</div>
  </div>;
}
