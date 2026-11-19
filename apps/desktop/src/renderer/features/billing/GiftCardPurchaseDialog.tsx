import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Minus, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  BillingGiftCardPurchasePolicy,
  CreateBillingGiftCardOrderRequest,
} from '../../../shared/billing';
import { billingApi } from './api';
import { GiftCardFace } from './GiftCardFace';
import { GiftCardStack } from './GiftCardStack';
import {
  GIFT_CARD_FACES,
  defaultGiftCardSender,
  formatGiftCardAmount,
  giftCardOrderTotal,
  maxGiftCardQuantity,
  type GiftCardOfferEntry,
} from './giftCardPurchase';
import { BILLING_CURRENCY } from './money';

type PolicyState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; policy: BillingGiftCardPurchasePolicy };

interface GiftCardPurchaseDialogProps {
  open: boolean;
  offers: GiftCardOfferEntry[];
  /** 账号昵称；署名默认用它，用户可以改。 */
  accountName: string | null;
  onClose: () => void;
  onSubmit: (request: CreateBillingGiftCardOrderRequest, unitAmount: string) => void;
}

/**
 * 购买礼品卡：左边始终是对方收到的样子（卡面、印在卡上的金额、署名与留言），右边选卡面、
 * 面额、张数并填写署名与留言。付款交给计费页已有的支付弹窗。
 */
export function GiftCardPurchaseDialog({
  open,
  offers,
  accountName,
  onClose,
  onSubmit,
}: GiftCardPurchaseDialogProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [policyState, setPolicyState] = useState<PolicyState>({ kind: 'loading' });
  const [faceCode, setFaceCode] = useState<string>(GIFT_CARD_FACES[0]);
  const [offerCode, setOfferCode] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [sender, setSender] = useState('');
  const [message, setMessage] = useState('');
  const [purchaseOptionId, setPurchaseOptionId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const policy = policyState.kind === 'ready' ? policyState.policy : null;
  const faces = useMemo(() => {
    const allowed = policy ? new Set(policy.faces) : null;
    const known = GIFT_CARD_FACES.filter((face) => !allowed || allowed.has(face));
    return known.length > 0 ? known : [...GIFT_CARD_FACES];
  }, [policy]);

  const loadPolicy = async () => {
    const request = ++requestRef.current;
    setPolicyState({ kind: 'loading' });
    try {
      const next = await billingApi.getGiftCardPurchasePolicy();
      if (request === requestRef.current) setPolicyState({ kind: 'ready', policy: next });
    } catch {
      if (request === requestRef.current) setPolicyState({ kind: 'error' });
    }
  };

  // 每次打开都重读限制：24 小时内的剩余张数随刚完成的购买变化。
  useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      return;
    }
    setFaceCode(GIFT_CARD_FACES[0]);
    setOfferCode(null);
    setQuantity(1);
    setMessage('');
    setPurchaseOptionId(null);
    void loadPolicy();
    // 只在打开时初始化；loadPolicy 只读写本组件状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && policy) setSender(defaultGiftCardSender(accountName, policy.maxSenderNameLength));
  }, [accountName, open, policy]);

  const capOf = (entry: GiftCardOfferEntry) => (policy ? maxGiftCardQuantity(policy, entry.offer.amount) : 0);
  const selected =
    offers.find((entry) => entry.offer.code === offerCode) ??
    offers.find((entry) => capOf(entry) > 0) ??
    offers[0] ??
    null;
  const maxQuantity = selected ? capOf(selected) : 0;
  const effectiveQuantity = Math.max(1, Math.min(quantity, Math.max(1, maxQuantity)));
  const option =
    selected?.purchaseOptions.find((item) => item.id === purchaseOptionId) ??
    selected?.purchaseOptions[0] ??
    null;
  const senderName = sender.trim();
  const unitAmount = selected?.offer.amount ?? '0';
  const total = giftCardOrderTotal(unitAmount, effectiveQuantity);
  const amountOf = (value: string) => formatGiftCardAmount(value, BILLING_CURRENCY, locale);
  const canPay = Boolean(policy && selected && option && senderName && maxQuantity >= effectiveQuantity && maxQuantity > 0);

  const submit = () => {
    if (!canPay || !selected || !option) return;
    const text = message.trim();
    onSubmit(
      {
        offerCode: selected.offer.code,
        quantity: effectiveQuantity,
        faceCode,
        senderName,
        message: text ? text : null,
        purchaseOptionId: option.id,
      },
      selected.offer.amount,
    );
  };

  const quantityHint = (() => {
    if (!policy) return null;
    if (policy.remaining === 0) {
      return t('billing.giftCardPurchase.quantityLimitReached', {
        limit: policy.dailyLimit,
        hours: policy.windowHours,
      });
    }
    const hint = t('billing.giftCardPurchase.quantityHint', {
      limit: policy.dailyLimit,
      hours: policy.windowHours,
      remaining: policy.remaining,
    });
    // 单笔总额上限（如支付宝）卡住张数时一并说明，不然用户不明白为什么加不上去。
    if (
      policy.maxOrderAmount !== null &&
      selected &&
      maxQuantity < Math.min(policy.maxQuantityPerOrder, policy.remaining)
    ) {
      return `${hint} · ${t('billing.giftCardPurchase.orderAmountCap', { amount: amountOf(policy.maxOrderAmount) })}`;
    }
    return hint;
  })();

  const faceName = (face: string) =>
    t(`billing.giftCardPurchase.faces.${face}`, { defaultValue: face });
  const cardLabel = t('billing.giftCard.cardLabel', { amount: amountOf(unitAmount) });

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[calc(100dvh-40px)] w-[calc(100vw-40px)] max-w-[780px] flex-col',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden',
            'text-[var(--text-primary)] focus:outline-none',
          )}
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border-default)] px-6 py-5">
            <div>
              <Dialog.Title className="text-lg font-medium">
                {t('billing.giftCardPurchase.title')}
              </Dialog.Title>
              <p className="mt-1 text-12 leading-[1.667] text-[var(--text-secondary)]">
                {t('billing.giftCardPurchase.subtitle')}
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

          <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[340px_minmax(0,1fr)]">
            <div className="border-b border-[var(--border-default)] bg-[var(--surface-hover-soft)] px-6 py-5 md:border-b-0 md:border-r">
              <p className="text-12 text-[var(--text-secondary)]">
                {t('billing.giftCardPurchase.previewLabel')}
              </p>
              <GiftCardStack
                className="mt-2.5"
                faceCode={faceCode}
                amount={unitAmount}
                currency={BILLING_CURRENCY}
                count={effectiveQuantity}
                label={cardLabel}
              />
              <div className="mt-3 text-center">
                <p className="text-12 leading-[1.667] text-[var(--text-secondary)]">
                  {t('billing.giftCard.from', { sender: senderName || '—' })}
                </p>
                {message.trim() && (
                  <p className="mt-1.5 text-13 leading-[1.54] text-[var(--text-primary)] [overflow-wrap:anywhere]">
                    {message.trim()}
                  </p>
                )}
              </div>
              {effectiveQuantity > 1 && (
                <p className="mt-3.5 text-center text-11 leading-[1.455] text-[var(--text-tertiary)]">
                  {t('billing.giftCardPurchase.sameCards', { count: effectiveQuantity })}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-5 px-6 py-5">
              <section aria-labelledby="gift-card-face-label">
                <div className="flex items-center justify-between gap-2">
                  <p id="gift-card-face-label" className="text-12 text-[var(--text-secondary)]">
                    {t('billing.giftCardPurchase.fields.face')}
                  </p>
                  <span className="text-12 text-[var(--text-tertiary)]">{faceName(faceCode)}</span>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2.5" role="group" aria-labelledby="gift-card-face-label">
                  {faces.map((face) => (
                    <button
                      key={face}
                      type="button"
                      aria-pressed={face === faceCode}
                      aria-label={faceName(face)}
                      onClick={() => setFaceCode(face)}
                      className={cn(
                        'rounded-xl border-[1.5px] p-0.5 transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        face === faceCode
                          ? 'border-[var(--text-primary)]'
                          : 'border-transparent hover:border-[var(--border-default)]',
                      )}
                    >
                      <GiftCardFace faceCode={face} className="rounded-lg" />
                    </button>
                  ))}
                </div>
              </section>

              <section aria-labelledby="gift-card-amount-label">
                <p id="gift-card-amount-label" className="text-12 text-[var(--text-secondary)]">
                  {t('billing.giftCardPurchase.fields.amount')}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-labelledby="gift-card-amount-label">
                  {offers.map((entry) => {
                    const active = entry.offer.code === selected?.offer.code;
                    const unavailable = policy !== null && capOf(entry) === 0 && policy.remaining > 0;
                    return (
                      <button
                        key={entry.offer.code}
                        type="button"
                        aria-pressed={active}
                        disabled={unavailable}
                        onClick={() => {
                          setOfferCode(entry.offer.code);
                          setPurchaseOptionId(null);
                        }}
                        className={cn(
                          'h-[52px] rounded-lg text-16 font-semibold tabular-nums tracking-[-0.01em] transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                          active
                            ? 'border-[1.5px] border-[var(--text-primary)] bg-[var(--surface-chip)]'
                            : 'border border-[var(--border-default)] bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
                          'disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        {amountOf(entry.offer.amount)}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section aria-labelledby="gift-card-quantity-label">
                <p id="gift-card-quantity-label" className="text-12 text-[var(--text-secondary)]">
                  {t('billing.giftCardPurchase.fields.quantity')}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <div className="inline-flex h-9 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]">
                    <Button
                      variant="secondary"
                      tone="quiet"
                      size="lg"
                      className="w-9 px-0"
                      aria-label={t('billing.giftCardPurchase.decrease')}
                      disabled={effectiveQuantity <= 1}
                      onClick={() => setQuantity(effectiveQuantity - 1)}
                    >
                      <Minus size={14} aria-hidden />
                    </Button>
                    <span
                      aria-live="polite"
                      aria-labelledby="gift-card-quantity-label"
                      className="min-w-[30px] text-center text-14 font-semibold tabular-nums"
                    >
                      {effectiveQuantity}
                    </span>
                    <Button
                      variant="secondary"
                      tone="quiet"
                      size="lg"
                      className="w-9 px-0"
                      aria-label={t('billing.giftCardPurchase.increase')}
                      disabled={effectiveQuantity >= maxQuantity}
                      onClick={() => setQuantity(effectiveQuantity + 1)}
                    >
                      <Plus size={14} aria-hidden />
                    </Button>
                  </div>
                  {policyState.kind === 'loading' && <Spinner size={14} className="text-[var(--text-tertiary)]" />}
                  {quantityHint && (
                    <span className="min-w-0 text-12 leading-[1.667] text-[var(--text-tertiary)]">{quantityHint}</span>
                  )}
                </div>
              </section>

              <FormField
                label={t('billing.giftCardPurchase.fields.sender')}
                labelAction={
                  senderName ? (
                    <span className="truncate text-12 text-[var(--text-tertiary)]">
                      {t('billing.giftCardPurchase.fields.senderHint', { sender: senderName })}
                    </span>
                  ) : undefined
                }
              >
                {(control) => (
                  <Input
                    id={control.id}
                    aria-describedby={control['aria-describedby']}
                    value={sender}
                    onChange={setSender}
                    maxLength={policy?.maxSenderNameLength ?? 40}
                    placeholder={t('billing.giftCardPurchase.fields.senderPlaceholder')}
                    autoComplete="off"
                  />
                )}
              </FormField>

              <FormField
                label={t('billing.giftCardPurchase.fields.message')}
                labelAction={
                  <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                    {message.length} / {policy?.maxMessageLength ?? 120}
                  </span>
                }
              >
                {(control) => (
                  <Textarea
                    id={control.id}
                    aria-describedby={control['aria-describedby']}
                    value={message}
                    onChange={setMessage}
                    rows={2}
                    maxLength={policy?.maxMessageLength ?? 120}
                    placeholder={t('billing.giftCardPurchase.fields.messagePlaceholder')}
                    className="resize-none"
                  />
                )}
              </FormField>

              {selected && selected.purchaseOptions.length > 1 && (
                <section aria-labelledby="gift-card-payment-label">
                  <p id="gift-card-payment-label" className="text-12 text-[var(--text-secondary)]">
                    {t('billing.giftCardPurchase.fields.paymentMethod')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2" role="group" aria-labelledby="gift-card-payment-label">
                    {selected.purchaseOptions.map((item) => (
                      <Button
                        key={item.id}
                        variant="secondary"
                        aria-pressed={item.id === option?.id}
                        className={cn(item.id === option?.id && '[--button-face-border:var(--text-primary)]')}
                        onClick={() => setPurchaseOptionId(item.id)}
                      >
                        {t(`billing.providers.${item.provider}`)}
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              {policyState.kind === 'error' && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3.5 py-2.5">
                  <p className="text-12 text-[var(--text-secondary)]">
                    {t('billing.giftCardPurchase.loadFailed')}
                  </p>
                  <Button variant="secondary" size="sm" compact onClick={() => void loadPolicy()}>
                    {t('billing.actions.retry')}
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-6 py-3">
            <div className="flex items-baseline gap-2.5" aria-live="polite">
              <span className="text-24 font-semibold tracking-[-0.02em] tabular-nums">{amountOf(total)}</span>
              <span className="text-12 text-[var(--text-secondary)]">
                {t('billing.giftCardPurchase.totalDetail', {
                  count: effectiveQuantity,
                  amount: amountOf(unitAmount),
                })}
              </span>
            </div>
            <div className="flex gap-2.5">
              <Button variant="secondary" size="lg" onClick={onClose}>
                {t('billing.giftCardPurchase.cancel')}
              </Button>
              <Button variant="cta" size="lg" disabled={!canPay} onClick={submit}>
                {t('billing.giftCardPurchase.pay')}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
