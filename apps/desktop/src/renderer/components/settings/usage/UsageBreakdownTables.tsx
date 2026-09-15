/**
 * UsageBreakdownTables — 用量历史页的两张明细表: 按 agent / harness 与按模型。
 *
 * 两张表共用同一套表格样式与分类配色 (usageHistoryColors), 因此放在同一个文件里,
 * 避免为了共享 5 行 class 再拆一层。
 *
 * 缓存命中率与 shared/turnUsageDetails.ts 的逐轮口径一致 (见 usageHistoryStats.cacheHitRate),
 * 但**不着色**: DESIGN.md §2 的 --warning-accent 是 sanctioned-consumers-only, 用量页的
 * 效率指标不在名单内。要给"偏低"一个视觉信号, 得先在规范里登记这个消费者。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatCompactTokens, formatModelShort } from '@/lib/usageFormat';
import { usageRankOf } from '@/components/new-chat/usagePalette';
import { type AgentTokenRow, type ModelTokenRow } from './usageHistoryStats';
import { usageHistoryAgentColor, usageHistoryModelColor } from './usageHistoryColors';
import { formatUsagePercent } from './formatUsagePercent';

const UNKNOWN_VALUE = '—';

const TH_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] pb-2 pl-3 text-right text-12 font-medium text-[var(--text-secondary)]';
const TD_CLASS =
  'whitespace-nowrap border-b border-[var(--border-default)] py-2 pl-3 text-right text-13 tabular-nums';

/**
 * 首列 (agent / model) 是唯一可收缩的列, 实现与 UsageTaskTable 的任务列相同:
 * `w-full + max-w-0` 让它先塌到 0 (打破"按最长内容取列宽"的默认行为) 再领走
 * 其余列分完后剩下的空间, 内层的 truncate 由此生效 (见 #3393 的同一段分析)。
 * pl-3 是列间距, 否则相邻两列的数字会贴到一起; 首列自身取 pl-0。
 */
const FIRST_COL_CLASS = 'w-full max-w-0 pl-0';

function Swatch({ color }: { color: string }): React.JSX.Element {
  return <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />;
}

function HitRateCell({ value }: { value: number | null }): React.JSX.Element {
  return <td className={TD_CLASS}>{value === null ? UNKNOWN_VALUE : formatUsagePercent(value)}</td>;
}

function ShareCell({ share, color }: { share: number; color: string }): React.JSX.Element {
  return (
    <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
      <span
        className="mr-1.5 inline-block h-1 rounded-[2px] align-[2px]"
        style={{ width: `${Math.max(2, share * 46)}px`, backgroundColor: color }}
      />
      {formatUsagePercent(share)}
    </td>
  );
}

export function UsageAgentTable({
  rows,
  rangeLabel,
  todayLabel,
  hideToday = false,
}: {
  rows: AgentTokenRow[];
  rangeLabel: string;
  todayLabel?: string;
  hideToday?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);

  return (
    <div>
      {/* 占比条与各行共用 harness 身份色；尺寸与既有布局一致。 */}
      <div className="mb-3 flex h-2 overflow-hidden rounded-[2px]">
        {rows.map((row) => (
          <div
            key={row.agentKind}
            title={`${row.agentKind} · ${t('usageDashboard.tokensOnly', {
              tokens: formatCompactTokens(row.tokens),
            })}`}
            style={{
              width: `${total > 0 ? (row.tokens / total) * 100 : 0}%`,
              backgroundColor: usageHistoryAgentColor(row.agentKind),
            }}
          />
        ))}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={cn(TH_CLASS, FIRST_COL_CLASS, 'text-left')}>
              {t('usageHistory.byAgent.col.agent')}
            </th>
            <th className={TH_CLASS}>
              {t('usageHistory.byAgent.col.totalInRange', { range: rangeLabel })}
            </th>
            <th className={TH_CLASS}>{t('usageHistory.byAgent.col.share')}</th>
            {!hideToday ? (
              <th className={TH_CLASS}>{todayLabel ?? t('usageHistory.byAgent.col.today')}</th>
            ) : null}
            <th className={TH_CLASS} title={t('usageHistory.cacheHitTooltip')}>
              {t('usageHistory.byAgent.col.hitRate')}
            </th>
            <th className={TH_CLASS}>{t('usageHistory.byAgent.col.models')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const color = usageHistoryAgentColor(row.agentKind);
            return (
              <tr key={row.agentKind}>
                <td className={cn(TD_CLASS, FIRST_COL_CLASS, 'text-left')}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Swatch color={color} />
                    <span className="truncate font-medium" title={row.agentKind}>
                      {row.agentKind}
                    </span>
                  </span>
                </td>
                <td className={TD_CLASS}>{formatCompactTokens(row.tokens)}</td>
                <ShareCell share={row.share} color={color} />
                {!hideToday ? (
                  <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>
                    {row.todayTokens > 0 ? formatCompactTokens(row.todayTokens) : UNKNOWN_VALUE}
                  </td>
                ) : null}
                <HitRateCell value={row.cacheHitRate} />
                <td className={cn(TD_CLASS, 'text-[var(--text-tertiary)]')}>{row.modelCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function UsageModelTable({
  rows,
  rangeLabel,
  colorOrder,
}: {
  rows: ModelTokenRow[];
  rangeLabel: string;
  colorOrder: string[];
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={cn(TH_CLASS, FIRST_COL_CLASS, 'text-left')}>
            {t('usageHistory.byModel.col.model')}
          </th>
          <th className={TH_CLASS}>
            {t('usageHistory.byModel.col.totalInRange', { range: rangeLabel })}
          </th>
          <th className={TH_CLASS}>{t('usageHistory.byModel.col.share')}</th>
          <th className={TH_CLASS}>{t('usageHistory.byModel.col.input')}</th>
          <th className={TH_CLASS}>{t('usageHistory.byModel.col.output')}</th>
          <th className={TH_CLASS}>{t('usageHistory.byModel.col.cacheRead')}</th>
          <th className={TH_CLASS}>{t('usageHistory.byModel.col.cacheCreate')}</th>
          <th className={TH_CLASS} title={t('usageHistory.cacheHitTooltip')}>
            {t('usageHistory.byModel.col.hitRate')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const rank = usageRankOf(colorOrder, row.key);
          const color = usageHistoryModelColor(rank, colorOrder.length);
          return (
            <tr key={row.key}>
              <td className={cn(TD_CLASS, FIRST_COL_CLASS, 'text-left')}>
                <span className="flex min-w-0 items-center gap-2">
                  <Swatch color={color} />
                  <span className="truncate font-medium" title={row.model}>
                    {formatModelShort(row.model)}
                  </span>
                  {/* 同一模型 id 可能跨 agent 撞名, 标签让两行区分得开 */}
                  <span className="shrink-0 rounded border border-[var(--border-default)] px-1 py-px text-11 leading-[1.4] text-[var(--text-tertiary)]">
                    {row.agentKind}
                  </span>
                </span>
              </td>
              <td className={TD_CLASS}>{formatCompactTokens(row.tokens)}</td>
              <ShareCell share={row.share} color={color} />
              <td className={TD_CLASS}>{formatCompactTokens(row.inputTokens)}</td>
              <td className={TD_CLASS}>{formatCompactTokens(row.outputTokens)}</td>
              <td className={TD_CLASS}>{formatCompactTokens(row.cacheReadTokens)}</td>
              <td className={TD_CLASS}>{formatCompactTokens(row.cacheCreateTokens)}</td>
              <HitRateCell value={row.cacheHitRate} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
