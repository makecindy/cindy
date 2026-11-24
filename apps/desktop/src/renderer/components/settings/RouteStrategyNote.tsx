/**
 * 供应商页里「这几个账号／这几台电脑按什么选法分配」的一行说明。选法只在「智能路由」里改
 * (ModelGroupsAutoRoutes)，这里不放第二个控件，只说明现状并给出入口。
 */
import { createContext, useContext } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RouteStrategy } from '../../../shared/routeStrategy';

/** 打开设置里的「智能路由」。不在供应商页里(测试、别的窗口)时为 null，说明照常显示，只是没有入口。 */
export const OpenSmartRoutingContext = createContext<(() => void) | null>(null);

export function RouteStrategyNote({ strategy, className }: { strategy: RouteStrategy; className?: string }) {
  const { t } = useTranslation();
  const open = useContext(OpenSmartRoutingContext);
  return (
    <div data-testid="route-strategy-note" className={className ?? 'mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1'}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-13 leading-[1.5] text-[var(--text-secondary)]">
          {t('modelGroups.auto.assignedBy', { strategy: t(`modelGroups.strategy.${strategy}.title`) })}
        </span>
        {/* 账号之间、电脑之间配额先比(2026-10-21 用户裁决)：选了别的选法也一样，在这里说清楚。 */}
        <span className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('modelGroups.auto.quotaFirst')}</span>
      </span>
      {open && (
        <button type="button" onClick={open}
          className="inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-lg px-2 text-13 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]">
          {t('modelGroups.auto.adjust')}
          <ChevronRight size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
