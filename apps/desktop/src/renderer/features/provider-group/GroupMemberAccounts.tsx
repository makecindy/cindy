/**
 * 组内一台电脑上一个订阅供应商的各账号用量(provider-groups.md §10，2026-11-10 用户要求)。
 * 组的调度单位仍是「电脑 + 供应商」；这里只把这台电脑上每个账号的额度分开列出，与供应商详情页的账号区同一份数据。
 * 账号管理通道只对本机和同账号电脑开放；旧电脑没有这个通道时读取失败，组里继续显示原来的单张卡。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useLiveQuotaForeground } from '@/components/settings/useProviderSubscriptionCard';
import {
  QUOTA_WINDOW_COLUMNS,
  QuotaHoverCard,
  QuotaWindowSubgridContext,
} from '@/components/status/QuotaHoverCard';
import {
  buildSubscriptionAccountUsageCard,
  type UsageCardAccount,
} from '@/components/status/usageCardModel';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import { cn } from '@/lib/utils';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';

import {
  SUBSCRIPTION_ACCOUNTS_CHANNEL,
  isSubscriptionProvider,
  isUnusedDefaultAccount,
  type SubscriptionAccountView,
  type SubscriptionProvider,
} from '../../../shared/subscriptionAccounts';

/** 账号用量在宿主有短缓存，与供应商详情页账号区同样约每分钟重读。 */
const REFRESH_MS = 60_000;

export type GroupMemberAccount = {
  account: SubscriptionAccountView;
  /** 在账号池里的序号(从 1 起)，读不到账号身份时写「账号 N」，与账号区一致。 */
  number: number;
};

function listedAccounts(raw: unknown, providerId: SubscriptionProvider): GroupMemberAccount[] {
  const view = raw as { providerId?: unknown; accounts?: unknown } | null | undefined;
  if (view?.providerId !== providerId || !Array.isArray(view.accounts)) return [];
  return (view.accounts as SubscriptionAccountView[]).flatMap((account, index) =>
    account.paused || isUnusedDefaultAccount(account) ? [] : [{ account, number: index + 1 }],
  );
}

/** `deviceId` 为 null 时读本机；只在 `enabled`(展开且这台可读)时读取，首读完成前不展示单账号兜底卡。 */
export function useGroupMemberAccounts(
  providerId: string | null,
  deviceId: string | null,
  enabled: boolean,
): { accounts: GroupMemberAccount[] | null; loading: boolean } {
  const pool = enabled && providerId && isSubscriptionProvider(providerId) ? providerId : null;
  const observed = useLiveQuotaForeground(pool !== null) && pool !== null ? pool : null;
  const reconnectEpoch = useDeviceLinkReconnectEpoch(
    observed && deviceId ? deviceId : undefined,
    observed && deviceId ? true : undefined,
  );
  const owner = getDataOwnerGeneration();
  const key = `${deviceId ?? ''}\n${pool ?? ''}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    owner: typeof owner;
    accounts: GroupMemberAccount[] | null;
  } | null>(null);
  useEffect(() => {
    // 不可读(离线、权限撤销)时不留旧账号，恢复后重新读。
    if (!pool) setLoaded(null);
  }, [pool]);
  useEffect(() => {
    if (!observed) return;
    let disposed = false;
    let latest = 0;
    const refresh = async () => {
      const request = ++latest;
      try {
        const command = { action: 'read', providerId: observed } as const;
        const result = deviceId
          ? await window.electronAPI.deviceLink.invoke(deviceId, SUBSCRIPTION_ACCOUNTS_CHANNEL, [
              command,
            ])
          : await window.electronAPI.subscriptionAccounts.command(command);
        if (disposed || request !== latest || !isDataOwnerGenerationCurrent(owner)) return;
        setLoaded({ key, owner, accounts: listedAccounts(result, observed) });
      } catch {
        if (disposed || request !== latest || !isDataOwnerGenerationCurrent(owner)) return;
        // 旧电脑不支持账号列表时，首读失败后才用原来的单张卡；刷新失败保留已读到的列表。
        setLoaded(previous => previous?.key === key && previous.owner === owner
          ? previous
          : { key, owner, accounts: null });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const offChanged = deviceId
      ? window.electronAPI.deviceLink.onRemotePush?.((push, stamp) => {
          if (push.deviceId === deviceId && push.channel === 'subscription-accounts:changed' &&
              (push.payload as { providerId?: unknown } | null)?.providerId === observed &&
              isDeviceLinkRemotePushCurrent(push, stamp)) void refresh();
        })
      : window.electronAPI.subscriptionAccounts.onChanged((event) => {
          if (event.providerId === observed) void refresh();
        });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      offChanged?.();
    };
  }, [observed, deviceId, key, owner, reconnectEpoch]);
  const current = pool && loaded?.key === key && isDataOwnerGenerationCurrent(loaded.owner)
    ? loaded
    : null;
  return { accounts: current?.accounts ?? null, loading: pool !== null && current === null };
}

/** `defaultCard` 是这台电脑原有的用量卡，它属于 CLI 默认账号，保留实时刷新与 Codex 重置次数。 */
export function GroupMemberAccountList({
  accounts,
  defaultCard,
  hideAccountNames = false,
}: {
  accounts: GroupMemberAccount[];
  defaultCard: UsageCardAccount | null;
  hideAccountNames?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  return (
    // 同一张网格：各账号的进度条起止对齐，不随各自文字宽度变化。
    <QuotaWindowSubgridContext.Provider value={true}>
      <div className={cn('grid gap-x-4', QUOTA_WINDOW_COLUMNS)}>
        {accounts.map(({ account, number }) => {
          const name =
            account.identity || t('providerGroup.member.accountFallback', { index: number });
          const usage =
            account.id === 'default' && defaultCard
              ? defaultCard
              : buildSubscriptionAccountUsageCard(account.usage, t, Date.now(), locale);
          // 正常的账号不写状态，只有不能分配或读不到时才说明。
          const status = account.paused
            ? t('providerGroup.member.status.paused')
            : account.status === 'ready'
              ? usage
                ? null
                : t('quotaCard.noWindows')
              : t(
                  `subscriptionAccounts.${account.status === 'signed-out' ? 'signedOut' : account.status}`,
                );
          return (
            <div
              key={account.id}
              data-testid="provider-group-member-account"
              className={cn(
                'col-span-full grid grid-cols-subgrid [&>*]:col-span-full',
                !usage && 'pb-2',
                account.paused && 'opacity-60',
              )}
            >
              {(!hideAccountNames || status) && (
                <div className="flex min-w-0 items-baseline gap-2 px-4 pt-1">
                  {!hideAccountNames && (
                    <span
                      title={name}
                      className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]"
                    >
                      {name}
                    </span>
                  )}
                  {status && (
                    <span
                      title={status}
                      className="min-w-0 truncate text-12 text-[var(--text-secondary)]"
                    >
                      {status}
                    </span>
                  )}
                </div>
              )}
              {usage && <QuotaHoverCard variant="embedded" hideIdentity account={usage} />}
            </div>
          );
        })}
      </div>
    </QuotaWindowSubgridContext.Provider>
  );
}
