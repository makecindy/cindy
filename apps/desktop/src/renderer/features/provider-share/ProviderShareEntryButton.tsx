/**
 * 「允许被远程调用」一行开关左侧的「远程与分享」入口(供应商分享 §7.1、供应商组 §10)。
 *
 * 2026-10-11 用户反馈供应商详情因「供应商组」多出一行而太长：原来的分享图标与「供应商组」一行合成这一个
 * 胶囊按钮，有组时直接写「供应商组 · N 台电脑」，没有组时写「远程与分享」，点击都进同一页。
 * 供应商组不依赖「允许被远程调用」(只给本机用也能建组)，所以入口始终可点；分享未开启时由那一页说明先开哪一级。
 * 有待审批的申请时右上角带提示点，Tip 与无障碍名称说明有几个。
 */
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';

export function ProviderShareEntryButton({
  groupSize,
  pendingCount,
  onOpen,
}: {
  /** 这个供应商的组里有几台电脑；null = 没有组。 */
  groupSize: number | null;
  pendingCount: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label =
    groupSize === null
      ? t('providerShare.entry.label')
      : t('settings.providers.remote.groupBadge', { count: groupSize });
  const pending = pendingCount > 0 ? t('providerShare.entry.pending', { count: pendingCount }) : null;
  return (
    <Tip text={pending}>
      <Button
        variant="secondary"
        size="sm"
        compact
        data-testid="provider-share-entry"
        aria-label={pending ? `${label} · ${pending}` : undefined}
        onClick={onOpen}
        className="max-w-[240px] pr-2"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        {pending && (
          <span
            aria-hidden="true"
            data-testid="provider-share-entry-dot"
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-[1.5px] border-[var(--settings-theme-card-bg)] bg-[var(--text-primary)]"
          />
        )}
      </Button>
    </Tip>
  );
}
