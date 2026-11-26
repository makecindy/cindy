/**
 * 供应商页里「这几个账号／这几台电脑按什么选法分配」的一行说明。选法只在「智能路由」里改
 * (ModelGroupsAutoRoutes)，这里不放第二个控件，只说明现状并给出入口。
 */
import { createContext, useContext } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RouteStrategy } from '../../../shared/routeStrategy';

/** 打开设置里的「智能路由」。不在供应商页里(测试、别的窗口)时为 null，说明照常显示，只是没有入口。 */
export const OpenSmartRoutingContext = createContext<((providerId?: string) => void) | null>(null);

/** `providerId`：点「调整」后落到智能路由里这个供应商的账号或电脑那一行(在合并路由里时先打开那条路由)。 */
export function RouteStrategyNote({ strategy, className, providerId }: { strategy: RouteStrategy; className?: string; providerId?: string }) {
  const { t } = useTranslation();
  const open = useContext(OpenSmartRoutingContext);
  return (
    <div data-testid="route-strategy-note" className={className ?? 'mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1'}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-13 leading-[1.5] text-[var(--text-secondary)]">
          {t('modelGroups.auto.assignedBy', { strategy: t(`modelGroups.strategy.${strategy}.title`) })}
        </span>
        {/* 账号之间、电脑之间与智能路由同一套选法规则(2026-11-26)：写出这个选法本身怎么挑。 */}
        <span className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{t(`modelGroups.strategy.${strategy}.hint`)}</span>
      </span>
      {open && (
        <button type="button" onClick={() => open(providerId)}
          className="inline-flex min-h-8 shrink-0 items-center gap-0.5 rounded-lg px-2 text-13 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]">
          {t('modelGroups.auto.adjust')}
          <ChevronRight size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
