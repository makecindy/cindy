/**
 * 添加 / 刷新市场源成功后的发现回执:插件数 + 跳过 / 暂不可读条目提示。
 *
 * 三类信息刻意分行、语义分开(与 discover.ts 的注释要求一致):
 * - skippedCount:内容**永久**非法,跳过即结论;
 * - 可用 0 且存在被跳过条目:只报告“所有条目均被跳过”。跳过原因包含永久非法
 *   形态和当前版本尚不支持的合法 source,不能仅凭总数判断有效性或具体根因;
 * - unreadableCount:**事实不明**(权限 / 文件锁 / 瞬时 I/O),刷新可解,
 *   不得与 skipped 混同展示。
 */
import { useTranslation } from 'react-i18next';

import type { MarketSourceSummary } from '../../../shared/pluginMarket';

export interface MarketplaceDiscoveryNoticeProps {
  /** add / refresh 返回的来源摘要。 */
  summary: Pick<MarketSourceSummary, 'name' | 'pluginCount' | 'skippedCount' | 'unreadableCount'>;
  /** 回执动词:added(添加)或 refreshed(刷新)。 */
  action: 'added' | 'refreshed';
}

export function MarketplaceDiscoveryNotice({ summary, action }: MarketplaceDiscoveryNoticeProps) {
  const { t } = useTranslation();
  // skippedCount 汇总永久非法原因和当前版本尚不支持的合法 source，不能从中推断
  // 条目有效性或具体根因。unreadable-only 的 0 可用由重试提示单独覆盖。
  const emptyWithSkippedEntries =
    summary.pluginCount === 0 && summary.skippedCount > 0 && summary.unreadableCount === 0;
  return (
    <div
      role="status"
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
    >
      <p className="text-12 leading-5 text-[var(--text-primary)]">
        {t(
          action === 'added'
            ? 'settings.ghosts.market.sources.addedReceipt'
            : 'settings.ghosts.market.sources.refreshedReceipt',
          { name: summary.name, count: summary.pluginCount },
        )}
      </p>
      {summary.skippedCount > 0 ? (
        <p className="mt-1 text-11 leading-4 text-[var(--text-tertiary)]">
          {t('settings.ghosts.market.sources.skippedEntries', { count: summary.skippedCount })}
        </p>
      ) : null}
      {emptyWithSkippedEntries ? (
        <p className="mt-1 text-11 leading-4 text-[var(--warning-fg)]">
          {t('settings.ghosts.market.sources.emptyWithSkippedEntries')}
        </p>
      ) : null}
      {summary.unreadableCount > 0 ? (
        <p className="mt-1 text-11 leading-4 text-[var(--warning-fg)]">
          {t('settings.ghosts.market.sources.unreadableEntries', {
            count: summary.unreadableCount,
          })}
        </p>
      ) : null}
    </div>
  );
}
