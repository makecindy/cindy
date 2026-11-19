import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Link2, Mail, MoreHorizontal, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { BillingPurchasedGiftCard } from '../../../shared/billing';
import { GiftCardFace } from './GiftCardFace';
import { formatGiftCardAmount } from './giftCardPurchase';
import type { PurchasedGiftCards } from './usePurchasedGiftCards';

const COPIED_FEEDBACK_MS = 2_000;

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
}

/** 状态的一句话：被别人领走时写领取人昵称（没有昵称就只说已被领取）。 */
export function purchasedGiftCardStatusText(
  card: BillingPurchasedGiftCard,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (card.status) {
    case 'UNCLAIMED':
      return t('billing.giftCardPurchase.list.status.unclaimed');
    case 'CLAIMED':
      return card.claimedByName
        ? t('billing.giftCardPurchase.list.status.claimedBy', { name: card.claimedByName })
        : t('billing.giftCardPurchase.list.status.claimed');
    case 'REDEEMED_BY_YOU':
      return t('billing.giftCardPurchase.list.status.redeemedByYou');
    case 'REFUNDED':
      return t('billing.giftCardPurchase.list.status.refunded');
    case 'ON_HOLD':
      return t('billing.giftCardPurchase.list.status.onHold');
  }
}

/**
 * 最近一次发到邮箱的情况，写在卡片的说明行下面。已领取、已退款或处理中的卡不会再发出，
 * 不再显示「正在发送」；发送失败且卡仍未领取时提示可以重新发送。
 */
export function purchasedGiftCardEmailLine(
  card: BillingPurchasedGiftCard,
  t: (key: string, options?: Record<string, unknown>) => string,
): { text: string; failed: boolean } | null {
  const email = card.email;
  if (!email) return null;
  const values = { email: email.recipient };
  if (email.status === 'SENT') {
    return { text: t('billing.giftCardPurchase.email.status.sent', values), failed: false };
  }
  if (email.status === 'FAILED') {
    return {
      text: t(
        card.status === 'UNCLAIMED'
          ? 'billing.giftCardPurchase.email.status.failedRetry'
          : 'billing.giftCardPurchase.email.status.failed',
        values,
      ),
      failed: true,
    };
  }
  if (card.status !== 'UNCLAIMED') return null;
  return { text: t('billing.giftCardPurchase.email.status.sending', values), failed: false };
}

export function PurchasedGiftCardEmailLine({ card }: { card: BillingPurchasedGiftCard }) {
  const { t } = useTranslation();
  const line = purchasedGiftCardEmailLine(card, t);
  if (!line) return null;
  return (
    <p
      className={cn(
        'mt-0.5 truncate text-12',
        line.failed ? 'text-[var(--error-fg)]' : 'text-[var(--text-tertiary)]',
      )}
    >
      {line.text}
    </p>
  );
}

/**
 * 一张没送出去的卡的操作：主按钮复制领取链接，「⋯」里是发送到邮箱、复制兑换码与兑换给自己。
 * 复制成功后主按钮短暂显示「已复制」，便于逐张发给不同的人。服务端不支持发信时不出现
 * 「发送到邮箱」（onSendEmail 不传）。
 */
export function PurchasedGiftCardActions({
  card,
  giftCards,
  onRedeemSelf,
  onSendEmail,
}: {
  card: BillingPurchasedGiftCard;
  giftCards: Pick<PurchasedGiftCards, 'copy'>;
  onRedeemSelf: (card: BillingPurchasedGiftCard) => void;
  onSendEmail?: (card: BillingPurchasedGiftCard) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'link' | 'code' | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const copy = async (kind: 'link' | 'code') => {
    if (busy) return;
    setBusy(kind);
    const ok = await giftCards.copy(card, kind);
    setBusy(null);
    if (ok && kind === 'link') {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        variant="secondary"
        size="md"
        compact
        loading={busy === 'link'}
        onClick={() => void copy('link')}
        className="whitespace-nowrap"
      >
        {copied ? (
          <Check size={14} aria-hidden className="text-[var(--status-success)]" />
        ) : (
          <Link2 size={14} aria-hidden />
        )}
        {copied ? t('billing.giftCardPurchase.actions.copied') : t('billing.giftCardPurchase.actions.copyLink')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="md"
            className="w-8 px-0"
            aria-label={t('billing.giftCardPurchase.actions.more')}
            disabled={busy !== null}
          >
            {busy === 'code' ? <Spinner size={13} /> : <MoreHorizontal size={15} aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="z-[10002] min-w-[168px] p-1">
          {onSendEmail && (
            <DropdownMenuItem onSelect={() => onSendEmail(card)}>
              <Mail size={14} aria-hidden className="text-[var(--text-secondary)]" />
              {t('billing.giftCardPurchase.actions.sendEmail')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copy('code')}>
            <Copy size={14} aria-hidden className="text-[var(--text-secondary)]" />
            {t('billing.giftCardPurchase.actions.copyCode')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onRedeemSelf(card)}>
            <Wallet size={14} aria-hidden className="text-[var(--text-secondary)]" />
            {t('billing.giftCardPurchase.actions.redeemSelf')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 计费页「我买的礼品卡」：每张卡一行，缩略图是登记过的卡面品牌露出面。 */
export function PurchasedGiftCardsCard({
  giftCards,
  onRedeemSelf,
  onSendEmail,
}: {
  giftCards: PurchasedGiftCards;
  onRedeemSelf: (card: BillingPurchasedGiftCard) => void;
  onSendEmail?: (card: BillingPurchasedGiftCard) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { state } = giftCards;
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {state.error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] px-5 py-3">
          <p className="text-12 text-[var(--text-secondary)]">{t('billing.giftCardPurchase.list.loadFailed')}</p>
          <Button variant="secondary" disabled={state.loading} onClick={() => void giftCards.reload()}>
            {t('billing.giftCardPurchase.list.retry')}
          </Button>
        </div>
      )}
      <ul className="divide-y divide-[var(--border-default)]">
        {state.cards.map((card) => {
          const amount = formatGiftCardAmount(card.amount, card.currency, locale);
          const meta =
            card.status === 'CLAIMED' && card.claimedAt
              ? t('billing.giftCardPurchase.list.meta.claimed', { date: formatDate(card.claimedAt, locale), tail: card.codeTail })
              : card.status === 'REDEEMED_BY_YOU' && card.claimedAt
                ? t('billing.giftCardPurchase.list.meta.redeemed', { date: formatDate(card.claimedAt, locale), tail: card.codeTail })
                : t('billing.giftCardPurchase.list.meta.purchased', { date: formatDate(card.purchasedAt, locale), tail: card.codeTail });
          return (
            <li key={card.cardId} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3">
              <div className={cn('w-[76px] shrink-0', card.status === 'REFUNDED' && 'opacity-50')}>
                <GiftCardFace
                  faceCode={card.faceCode}
                  amount={card.amount}
                  currency={card.currency}
                  label={t('billing.giftCard.cardLabel', { amount })}
                  className="rounded-lg"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                  <span className="tabular-nums">{amount}</span>
                  <span className="font-normal text-[var(--text-secondary)]">
                    {' · '}
                    {purchasedGiftCardStatusText(card, t)}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-12 text-[var(--text-tertiary)]">{meta}</p>
                <PurchasedGiftCardEmailLine card={card} />
              </div>
              {card.status === 'UNCLAIMED' && (
                <PurchasedGiftCardActions
                  card={card}
                  giftCards={giftCards}
                  onRedeemSelf={onRedeemSelf}
                  onSendEmail={onSendEmail}
                />
              )}
            </li>
          );
        })}
      </ul>
      {state.nextCursor && (
        <div className="flex justify-center border-t border-[var(--border-default)] px-5 py-2.5">
          <Button variant="secondary" tone="quiet" loading={state.loading} onClick={() => void giftCards.loadMore()}>
            {t('billing.giftCardPurchase.list.loadMore')}
          </Button>
        </div>
      )}
    </section>
  );
}
