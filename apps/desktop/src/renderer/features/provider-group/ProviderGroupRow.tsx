/**
 * 供应商详情里的「供应商组」一行(docs/product-rules/provider-groups.md §10)：显示「未设置」或
 * 「{N} 台电脑 · {组策略}」，点击进入该供应商的「远程与分享」页。不依赖「允许被远程调用」：
 * 只给本机用时也可以建组。
 */
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import { useProviderGroup } from './useProviderGroup';

export function ProviderGroupRow({ providerId, onOpen }: { providerId: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const { view } = useProviderGroup(providerId);
  const config = view?.config ?? null;
  return (
    <div
      data-testid="provider-group-row"
      className="flex shrink-0 items-start justify-between gap-3 border-t px-5 py-3"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-13 font-medium text-[var(--text-primary)]">{t('providerGroup.row.label')}</span>
        <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]" data-testid="provider-group-summary">
          {config
            ? t('providerGroup.row.summary', {
                count: config.members.length,
                strategy: t(`providerGroup.strategy.${config.strategy}`),
              })
            : t('providerGroup.row.description')}
        </span>
      </div>
      <Button variant="secondary" size="sm" compact onClick={onOpen}>
        {config ? t('providerGroup.row.manage') : t('providerGroup.row.setUp')}
      </Button>
    </div>
  );
}
