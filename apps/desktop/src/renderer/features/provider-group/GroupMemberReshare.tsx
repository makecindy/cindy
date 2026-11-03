/**
 * 组里分享来的电脑：它的主人是否同意本机分享出去的人经组使用它(docs/product-rules/provider-sharing.md §4.3)。
 * 状态行带一句摘要；展开这一行时逐人列出。只在本机的组、组所在的供应商分享给了别人时出现。
 */
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import type { ProviderGroupReshareGuest, ProviderGroupReshareSummary } from '../../../shared/providerGroup';
import { ShareAvatar } from '../provider-share/ShareAvatar';

type Translate = ReturnType<typeof useTranslation>['t'];

/** 状态行的一句摘要：都同意了、有人在等、有人没被同意、那台需要更新或还没问到。 */
export function reshareSummaryText(t: Translate, summary: ProviderGroupReshareSummary, owner: string): string {
  if (summary.support === 'needs-update') return t('providerGroup.member.reshare.needsUpdate', { owner });
  if (summary.support === 'unknown') return t('providerGroup.member.reshare.unknown', { owner });
  const count = (state: ProviderGroupReshareGuest['state']) => summary.guests.filter((guest) => guest.state === state).length;
  if (count('approved') === summary.guests.length) return t('providerGroup.member.reshare.allApproved');
  if (count('pending') > 0) return t('providerGroup.member.reshare.waiting', { count: count('pending'), owner });
  if (count('rejected') > 0) return t('providerGroup.member.reshare.rejected', { count: count('rejected'), owner });
  return t('providerGroup.member.reshare.unknown', { owner });
}

export function GroupMemberReshare({ summary, owner }: { summary: ProviderGroupReshareSummary; owner: string }) {
  const { t } = useTranslation();
  return (
    // 与上方的额度说明一样缩进到电脑名一列：说明的是这一台。
    <div data-testid="provider-group-member-reshare" className="-mt-1 flex flex-col gap-1.5 pb-3 pl-11 pr-4">
      <div className="flex flex-col gap-0.5 px-4">
        <span className="text-12 font-medium text-[var(--text-secondary)]">{t('providerGroup.member.reshare.title')}</span>
        <span className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {summary.support === 'needs-update'
            ? t('providerGroup.member.reshare.needsUpdate', { owner })
            : t('providerGroup.member.reshare.description', { owner })}
        </span>
      </div>
      {summary.guests.map((guest) => (
        <div key={guest.memberId} data-testid="provider-group-member-reshare-guest" className="flex items-center gap-2 px-4">
          <ShareAvatar
            displayName={guest.displayName}
            avatarUrl={guest.avatarUrl}
            size="sm"
            className={cn(guest.state !== 'approved' && 'opacity-70')}
          />
          <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-primary)]">{guest.displayName}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                background: guest.state === 'approved' ? 'var(--remote-status-ready)' : 'var(--remote-status-disconnected)',
              }}
            />
            {t(`providerGroup.member.reshare.state.${summary.support === 'supported' ? guest.state : 'unknown'}`)}
          </span>
        </div>
      ))}
    </div>
  );
}
