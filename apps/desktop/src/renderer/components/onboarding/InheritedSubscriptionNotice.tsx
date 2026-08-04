/**
 * InheritedSubscriptionNotice —— 「Cindy 沿用了这台电脑上已登录的订阅」的一次性告知。
 *
 * 出现条件由 useInheritedLocalSubscriptions 判定(本机 CLI 已登录 && 同名供应商已连接 &&
 * 未读),挂载方只决定位置与 device-link gate。它与 ConnectProviderCard **条件互斥**:
 * 那张卡要求零已连接来源,而自动继承成功后该供应商已连接。
 *
 * 形态刻意是提示条而非引导卡:这是告知,不是待办 —— 用户不需要在这里做决定,只需要知道
 * Cindy 用的是哪个账号、以及去哪儿换。所以只给两个出口:去模型供应商,或读过即止。
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, PlugZap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useInheritedLocalSubscriptions } from '@/hooks/useInheritedLocalSubscriptions';

/** 订阅产品名(如 ChatGPT / Claude.ai);目录没标产品时回落供应商名。 */
function subscriptionLabel(provider: { name: string; access?: { kind: string; product?: string } }): string {
  return provider.access?.kind === 'subscription' && provider.access.product
    ? provider.access.product
    : provider.name;
}

export function InheritedSubscriptionNotice({
  className,
  enabled = true,
}: {
  className?: string;
  enabled?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notice = useInheritedLocalSubscriptions(enabled);

  if (!notice.visible) return null;

  // 同时继承 claude + codex 时并列;分隔符走 i18n(中日韩用顿号、英文用逗号)。
  const products = notice.rows
    .map((row) => subscriptionLabel(row.provider))
    .join(t('onboarding.inheritedSubscription.separator'));

  return (
    <section
      data-testid="inherited-subscription-notice"
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border border-[var(--border-default)]',
        'bg-[var(--surface-elevated)] p-4',
        className,
      )}
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--model-item-hover)]">
        <PlugZap size={15} className="text-[var(--text-secondary)]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[14px] font-medium leading-snug text-[var(--text-primary)]">
          {t('onboarding.inheritedSubscription.title', { products })}
        </span>
        <span className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {t('onboarding.inheritedSubscription.desc')}
        </span>
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              notice.acknowledge();
              navigate('/settings?tab=providers');
            }}
            className={cn(
              'flex items-center gap-0.5 rounded-[8px] px-2 py-1 -ml-2',
              'text-[13px] font-medium text-[var(--text-primary)]',
              'transition-colors hover:bg-[var(--model-item-hover)] active:scale-[0.98]',
            )}
          >
            {t('onboarding.inheritedSubscription.openProviders')}
            <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
          </button>
          <button
            type="button"
            onClick={notice.acknowledge}
            className={cn(
              'rounded-[8px] px-2 py-1 text-[13px] font-normal text-[var(--text-secondary)]',
              'transition-colors hover:bg-[var(--model-item-hover)] active:scale-[0.98]',
            )}
          >
            {t('onboarding.inheritedSubscription.acknowledge')}
          </button>
        </div>
      </div>
    </section>
  );
}
