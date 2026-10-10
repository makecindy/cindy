/**
 * 「允许被远程调用」一行开关左侧的「管理分享」图标按钮(产品规则 §7.1；设计稿场景 1)。
 * 能力未开启时不可点击，Tip 与无障碍名称说明需先开启哪一级；有待审批申请时带提示点。
 */
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { ProviderShareGate } from './providerShareFormat';

export function ProviderShareEntryButton({
  gate,
  pendingCount,
  onOpen,
}: {
  gate: ProviderShareGate;
  pendingCount: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const enabled = gate === 'on';
  const label = !enabled
    ? t(gate === 'remote-off' ? 'providerShare.entry.disabledRemoteControl' : 'providerShare.entry.disabledInvocation')
    : pendingCount > 0
      ? t('providerShare.entry.manageWithPending', { count: pendingCount })
      : t('providerShare.entry.manage');
  return (
    <Tip text={label}>
      <button
        type="button"
        data-testid="provider-share-entry"
        aria-label={label}
        aria-disabled={enabled ? undefined : true}
        onClick={() => {
          if (enabled) onOpen();
        }}
        className={cn(
          'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          enabled
            ? 'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
            : 'cursor-default opacity-50',
        )}
      >
        <Share2 size={16} aria-hidden />
        {enabled && pendingCount > 0 && (
          <span
            aria-hidden="true"
            data-testid="provider-share-entry-dot"
            className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full border-[1.5px] border-[var(--settings-theme-card-bg)] bg-[var(--text-primary)]"
          />
        )}
      </button>
    </Tip>
  );
}
