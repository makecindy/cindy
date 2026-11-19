import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { BillingPurchasedGiftCard } from '../../../shared/billing';
import { GiftCardStack } from './GiftCardStack';
import { formatGiftCardAmount } from './giftCardPurchase';
import {
  PurchasedGiftCardActions,
  PurchasedGiftCardEmailLine,
  purchasedGiftCardStatusText,
} from './PurchasedGiftCardsCard';
import type { PurchasedGiftCards } from './usePurchasedGiftCards';

interface GiftCardPurchasedDialogProps {
  open: boolean;
  /** null 表示还在取回这一单的卡；空数组表示付款已确认、卡还没出现在列表里。 */
  cards: BillingPurchasedGiftCard[] | null;
  giftCards: Pick<PurchasedGiftCards, 'copy'>;
  onRedeemSelf: (card: BillingPurchasedGiftCard) => void;
  /** 服务端支持发信时传入：「⋯」里多一项「发送到邮箱」。 */
  onSendEmail?: (card: BillingPurchasedGiftCard) => void;
  onViewAll: () => void;
  onClose: () => void;
}

/**
 * 付款成功后：这一单的卡叠放展示，逐张复制领取链接，「⋯」里发送到邮箱、复制兑换码或兑换给自己。
 * 关掉也不会丢，卡一直在「我买的礼品卡」里。
 */
export function GiftCardPurchasedDialog({
  open,
  cards,
  giftCards,
  onRedeemSelf,
  onSendEmail,
  onViewAll,
  onClose,
}: GiftCardPurchasedDialogProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const first = cards?.[0] ?? null;
  const amountOf = (card: BillingPurchasedGiftCard) => formatGiftCardAmount(card.amount, card.currency, locale);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[calc(100dvh-40px)] w-[calc(100vw-40px)] max-w-[500px] flex-col',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden',
            'text-[var(--text-primary)] focus:outline-none',
          )}
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-1 pt-5">
            <div>
              <Dialog.Title className="text-lg font-medium">
                {first
                  ? t('billing.giftCardPurchase.done.title', { count: cards!.length })
                  : t('billing.giftCardPurchase.done.pendingTitle')}
              </Dialog.Title>
              <p className="mt-1 text-12 leading-[1.667] text-[var(--text-secondary)]">
                {cards === null
                  ? t('billing.giftCardPurchase.done.loading')
                  : first
                    ? t('billing.giftCardPurchase.done.description')
                    : t('billing.giftCardPurchase.done.missing')}
              </p>
            </div>
            <Dialog.Close asChild>
              <Button
                variant="secondary"
                size="md"
                className="w-8 shrink-0 border-transparent bg-transparent px-0 text-[var(--text-tertiary)]"
                aria-label={t('billing.actions.close')}
              >
                <X size={16} aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-1 pt-3.5">
            {cards === null && (
              <div className="grid min-h-[220px] place-items-center">
                <Spinner size={24} className="text-[var(--text-secondary)]" />
              </div>
            )}
            {first && (
              <>
                <GiftCardStack
                  className="mx-[22px]"
                  faceCode={first.faceCode}
                  amount={first.amount}
                  currency={first.currency}
                  count={cards!.length}
                  label={t('billing.giftCard.cardLabel', { amount: amountOf(first) })}
                />
                <p className="mt-2.5 text-center text-12 leading-[1.667] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                  {t('billing.giftCard.from', { sender: first.senderName })}
                  {first.message ? ` · ${first.message}` : ''}
                </p>
                <ul className="mt-4 divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
                  {cards!.map((card, index) => (
                    <li key={card.cardId} className="flex items-center gap-3 py-2.5 pl-4 pr-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-13 font-medium">
                          {t('billing.giftCardPurchase.done.cardTitle', {
                            index: index + 1,
                            amount: amountOf(card),
                          })}
                        </p>
                        <p className="truncate text-12 text-[var(--text-tertiary)]">
                          {t('billing.giftCardPurchase.done.cardMeta', {
                            tail: card.codeTail,
                            status: purchasedGiftCardStatusText(card, t),
                          })}
                        </p>
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
                  ))}
                </ul>
                <p className="mx-0.5 mt-2.5 text-11 leading-[1.455] text-[var(--text-tertiary)]">
                  {t('billing.giftCardPurchase.done.linkHint')}
                </p>
              </>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2.5 px-6 pb-5 pt-4">
            <Button variant="secondary" size="lg" onClick={onViewAll}>
              {t('billing.giftCardPurchase.done.viewAll')}
            </Button>
            <Button variant="cta" size="lg" onClick={onClose}>
              {t('billing.giftCardPurchase.done.finish')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
