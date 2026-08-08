/**
 * 添加 / 刷新市场源成功后的发现回执:插件数 + 跳过 / 暂不可读条目提示。
 *
 * 三类信息刻意分行、语义分开(与 discover.ts 的注释要求一致):
 * - skippedCount:内容**永久**非法,跳过即结论;
 * - 可用 0 且存在被跳过条目:典型成因是市场仓库把插件目录做成了 Git submodule
 *   (clone 有意不递归,见 sources/git.ts),目录存在但内容为空——清单完全合法,
 *   不触发任何错误码,不专门点明的话用户与市场作者完全无从排查;
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
  // "清单有条目但可用 0"由既有字段推导,不在 IPC 上加冗余布尔。推导依据的不变量:
  // discover.ts 对每个清单条目恰好计入 plugins/skipped/unreadable 三者之一,即
  // declared = accepted + skipped + unreadable 恒成立——改 summary 字段语义时必须
  // 同步审视这里。unreadable-only 的 0 可用不算:那是瞬时问题,刷新提示已覆盖。
  const emptyWithSkips = summary.pluginCount === 0 && summary.skippedCount > 0;
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
      {emptyWithSkips ? (
        <p className="mt-1 text-11 leading-4 text-[var(--warning-fg)]">
          {t('settings.ghosts.market.sources.emptyWithEntries')}
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
