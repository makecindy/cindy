/** 统一设置卡片结构：主标题、副标题、操作区和正文。 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 供需要自绘正文外壳的自动化卡片复用。 */
export const BOT_SETTINGS_BLOCK_CLASS =
  'scroll-mt-6 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5';

export function BotSettingsBlockHeading({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  /** 只在这一块还空着的时候传。有内容了就别传 —— 见文件头第 2 条。 */
  hint?: string | undefined;
  /** 标题行右端的操作(刷新、新建…)。没有就不占位。 */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-14 font-medium leading-5 text-[var(--text-primary)]">
          <Icon size={16} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
          <span className="min-w-0">{title}</span>
        </span>
        {hint ? (
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{hint}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function BotSettingsBlock({
  icon,
  title,
  hint,
  action,
  testId,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string | undefined;
  action?: ReactNode;
  testId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section data-testid={testId} className={cn(BOT_SETTINGS_BLOCK_CLASS, className)}>
      <BotSettingsBlockHeading icon={icon} title={title} hint={hint} action={action} />
      {children ? <div className="mt-4 [&>*:first-child]:!mt-0">{children}</div> : null}
    </section>
  );
}
