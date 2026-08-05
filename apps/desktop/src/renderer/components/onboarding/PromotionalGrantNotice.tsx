/**
 * PromotionalGrantNotice —— 「已为你开通 Cindy AI，赠送余额已到账」的一次性告知。
 *
 * 出现条件由 usePromotionalGrantNotice 判定(能看计费 && 账本里有一笔生效中的赠送 &&
 * 未读),挂载方只决定位置与 device-link gate。它与 InheritedSubscriptionNotice **不互斥**:
 * 两者都是告知,同时成立时竖排即可 —— 一条讲「用的是哪个账号」,一条讲「账上有多少钱」。
 *
 * 形态逐项照抄 InheritedSubscriptionNotice(12px 容器 / 1px Board 边 / Card 底 / p-16 /
 * 28px 圆角方图标 / 标题 14px-500 / 描述 13px / 两个 8px 圆角文字按钮),不造新形态:
 * 同一个位置上的同一类东西(读过即止的告知条)必须长得一样。
 *
 * 「查看用量」同时记已读:用户已经被带到计费页看过金额与有效期了,回到首屏再提醒一次
 * 是重复叙事(同 InheritedSubscriptionNotice 的 openProviders)。
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Gift } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePromotionalGrantNotice } from '@/hooks/usePromotionalGrantNotice';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { formatBillingAmount } from '@/features/billing/money';

/**
 * 结算币种由运行区域决定,与计费页 BILLING_CURRENCY 同一口径 —— 金额一律走
 * formatBillingAmount 格式化,组件不硬编码任何数字或币种符号。
 */
const BILLING_CURRENCY = CURRENT_CINDY_REGION === 'global' ? 'usd' : 'cny';

export function PromotionalGrantNotice({
  className,
  enabled = true,
}: {
  className?: string;
  enabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const notice = usePromotionalGrantNotice(enabled);

  if (!notice.visible || !notice.grant) return null;

  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const expiresAt = Date.parse(notice.grant.expiresAt);
  // 有效期解析不出来就不出这张卡(hook 已过滤,这里是渲染期的第二道闸):卡上必须印出
  // 具体日期,印不出来的告知不如不出。
  if (!Number.isFinite(expiresAt)) return null;

  let expiresAtLabel: string;
  try {
    expiresAtLabel = new Intl.DateTimeFormat(billingLocale, { dateStyle: 'medium' }).format(
      expiresAt,
    );
  } catch {
    return null;
  }

  return (
    <section
      data-testid="promotional-grant-notice"
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border border-[var(--border-default)]',
        'bg-[var(--surface-elevated)] p-4',
        className,
      )}
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--model-item-hover)]">
        <Gift size={15} className="text-[var(--text-secondary)]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[14px] font-medium leading-snug text-[var(--text-primary)]">
          {t('onboarding.promotionalGrant.title')}
        </span>
        <span className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {t('onboarding.promotionalGrant.desc', {
            amount: formatBillingAmount(
              notice.grant.originalAmount,
              BILLING_CURRENCY,
              billingLocale,
            ),
            date: expiresAtLabel,
          })}
        </span>
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              notice.acknowledge();
              navigate('/settings?tab=billing');
            }}
            className={cn(
              'flex items-center gap-0.5 rounded-[8px] px-2 py-1 -ml-2',
              'text-[13px] font-medium text-[var(--text-primary)]',
              'transition-colors hover:bg-[var(--model-item-hover)] active:scale-[0.98]',
            )}
          >
            {t('onboarding.promotionalGrant.openBilling')}
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
            {t('onboarding.promotionalGrant.acknowledge')}
          </button>
        </div>
      </div>
    </section>
  );
}
