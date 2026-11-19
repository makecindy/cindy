import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import type {
  BillingGiftCard,
  BillingGiftCardCredit,
  BillingGiftCardFailure,
} from '../../../shared/billing';
import {
  formatGiftCardCode,
  giftCardCodeFromInput,
  giftCardCodeRegion,
} from '../../../shared/giftCard';
import { billingApi } from './api';
import { GiftCardFace, giftCardFaceShowsAmount } from './GiftCardFace';
import { BILLING_CURRENCY, formatBillingAmount as formatMoney } from './money';

type Step =
  | { kind: 'input' }
  | { kind: 'confirm'; code: string; card: BillingGiftCard }
  /** credit 为 null 表示这张卡早先已被当前账号领取，本次没有新入账。 */
  | { kind: 'done'; card: BillingGiftCard; credit: BillingGiftCardCredit | null };

/**
 * FAILED 是网络或服务故障；其余是服务端给出的卡片状态。purchased：已知这是用户买的卡——它作废
 * 可能只是退款或拒付还在处理，之后还会恢复，所以只说目前不能领取。
 */
type Failure = { reason: BillingGiftCardFailure | 'FAILED'; code: string | null; purchased?: boolean };

interface GiftCardRedeemDialogProps {
  open: boolean;
  /** 从唤起链接带入的兑换码：打开后直接查询，跳过手动输入。 */
  initialCode?: string | null;
  onClose: () => void;
  /**
   * 领取成功后调用，带上领取的兑换码（规范写法）：计费页据此刷新余额，并清掉「我买的礼品卡」里
   * 这张卡缓存的码（已兑换的码不能再被复制出去）。
   */
  onRedeemed: (code: string) => void;
  /**
   * 查询或领取时发现这个码已经不能用了（已是你的、被别人领走、作废或过期）时调用，带上码（规范写法）：
   * 计费页据此清掉「我买的礼品卡」里缓存的这张卡的码并重读列表，不再复制出用不了的码。
   */
  onCodeUnusable?: (code: string) => void;
}

/** 这些结果说明码已经用不了了：缓存它的地方要清掉。 */
const UNUSABLE_FAILURES = new Set<BillingGiftCardFailure | 'FAILED'>(['ALREADY_CLAIMED', 'EXPIRED', 'VOIDED']);

function cardFailure(card: BillingGiftCard): BillingGiftCardFailure | null {
  if (card.status === 'CLAIMED') return 'ALREADY_CLAIMED';
  if (card.status === 'EXPIRED') return 'EXPIRED';
  if (card.status === 'VOIDED') return 'VOIDED';
  return null;
}

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
}

export function GiftCardRedeemDialog({
  open,
  initialCode,
  onClose,
  onRedeemed,
  onCodeUnusable,
}: GiftCardRedeemDialogProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [value, setValue] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'input' });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  // 主按钮会让 Radix 请求关闭；查询与领取期间由这个标记拦住，弹窗留在原地。
  const holdOpenRef = useRef(false);
  // 关闭或重开后，先前请求的结果不再写回。
  const requestRef = useRef(0);
  // 查询回调是稳定的（只在打开时调用），回调属性随渲染变化：经 ref 取最新的。
  const onCodeUnusableRef = useRef(onCodeUnusable);
  onCodeUnusableRef.current = onCodeUnusable;
  // 领取请求在途时不换卡：此时又点开另一张礼品卡链接，若照常重置，这次领取的结果会被
  // 丢掉，到账提示和余额刷新都不会发生。与手机端一致，新链接在这期间不接手弹窗。
  const redeemingRef = useRef<number | null>(null);

  const preview = useCallback(async (input: string) => {
    const code = giftCardCodeFromInput(input);
    if (!code) {
      setFailure({ reason: 'NOT_FOUND', code: null });
      return;
    }
    const request = ++requestRef.current;
    setBusy(true);
    setFailure(null);
    try {
      const result = await billingApi.previewGiftCard(code);
      if (request !== requestRef.current) return;
      if (!result.ok) {
        setFailure({ reason: result.reason, code });
        if (UNUSABLE_FAILURES.has(result.reason)) onCodeUnusableRef.current?.(code);
        return;
      }
      if (result.card.status === 'CLAIMED_BY_YOU') {
        setStep({ kind: 'done', card: result.card, credit: null });
        onCodeUnusableRef.current?.(code);
        return;
      }
      const unavailable = cardFailure(result.card);
      if (unavailable) onCodeUnusableRef.current?.(code);
      if (unavailable) {
        setFailure({ reason: unavailable, code, purchased: result.card.destination === 'PURCHASED' });
      }
      else setStep({ kind: 'confirm', code, card: result.card });
    } catch {
      if (request === requestRef.current) setFailure({ reason: 'FAILED', code });
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open && redeemingRef.current !== null) return;
    redeemingRef.current = null;
    requestRef.current += 1;
    holdOpenRef.current = false;
    setBusy(false);
    setFailure(null);
    setStep({ kind: 'input' });
    if (!open) {
      setValue('');
      return;
    }
    const code = initialCode ? giftCardCodeFromInput(initialCode) : null;
    setValue(code ? formatGiftCardCode(code) : '');
    if (code) void preview(code);
  }, [initialCode, open, preview]);

  const redeem = async (code: string, card: BillingGiftCard) => {
    const request = ++requestRef.current;
    redeemingRef.current = request;
    setBusy(true);
    setFailure(null);
    try {
      const result = await billingApi.redeemGiftCard(code);
      if (request !== requestRef.current) return;
      if (!result.ok) {
        // 确认期间卡片状态变了（被别人领走、作废或过期）：回到输入并说明原因。
        setStep({ kind: 'input' });
        setFailure({ reason: result.reason, code, purchased: card.destination === 'PURCHASED' });
        if (UNUSABLE_FAILURES.has(result.reason)) onCodeUnusable?.(code);
        return;
      }
      setStep({ kind: 'done', card: result.card, credit: result.credit });
      onRedeemed(code);
    } catch {
      // 结果未知：留在确认步骤。领取是幂等的，再点一次不会重复入账。
      if (request === requestRef.current) {
        setStep({ kind: 'confirm', code, card });
        setFailure({ reason: 'FAILED', code });
      }
    } finally {
      if (redeemingRef.current === request) redeemingRef.current = null;
      if (request === requestRef.current) setBusy(false);
    }
  };

  const failureText = (() => {
    if (!failure) return null;
    if (failure.reason === 'WRONG_REGION') {
      const region = failure.code ? giftCardCodeRegion(failure.code) : null;
      return t(
        region === 'cn'
          ? 'billing.giftCard.errors.wrongRegionCn'
          : 'billing.giftCard.errors.wrongRegionGlobal',
      );
    }
    const keys: Record<Exclude<Failure['reason'], 'WRONG_REGION'>, string> = {
      NOT_FOUND: 'billing.giftCard.errors.notFound',
      ALREADY_CLAIMED: 'billing.giftCard.errors.alreadyClaimed',
      EXPIRED: 'billing.giftCard.errors.expired',
      VOIDED: 'billing.giftCard.errors.voided',
      RATE_LIMITED: 'billing.giftCard.errors.rateLimited',
      PERSONAL_REQUIRED: 'billing.giftCard.errors.personalRequired',
      FAILED: 'billing.giftCard.errors.failed',
    };
    if (failure.reason === 'VOIDED' && failure.purchased) {
      return t('billing.giftCard.errors.voidedPurchased');
    }
    return t(keys[failure.reason]);
  })();

  const amountOf = (amount: string) => formatMoney(amount, BILLING_CURRENCY, locale);
  const handleOpenChange = (next: boolean) => {
    if (next) return;
    if (holdOpenRef.current) {
      holdOpenRef.current = false;
      return;
    }
    if (busy) return;
    onClose();
  };
  const hold = () => {
    holdOpenRef.current = true;
  };

  if (step.kind === 'done') {
    const { card, credit } = step;
    // 自己买的卡进充值余额、永久有效；后台发的卡进赠送余额、到期失效。
    const purchased = card.destination === 'PURCHASED';
    const description =
      credit === null
        ? t('billing.giftCard.alreadyYours')
        : credit.state === 'APPLIED'
          ? purchased
            ? t('billing.giftCard.doneDescriptionPurchased')
            : credit.expiresAt
              ? t('billing.giftCard.doneDescription', { date: formatDate(credit.expiresAt, locale) })
              : t('billing.giftCard.doneDescriptionNoDate')
          : t(
              purchased
                ? 'billing.giftCard.pendingDescriptionPurchased'
                : 'billing.giftCard.pendingDescription',
              { amount: amountOf(credit.amount) },
            );
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={
          credit?.state === 'APPLIED'
            ? t('billing.giftCard.doneTitle', { amount: amountOf(credit.amount) })
            : t('billing.giftCard.pendingTitle')
        }
        description={description}
        content={<GiftCardHero card={card} amount={amountOf(card.amount)} />}
        maxWidth={420}
        confirmText={t('billing.giftCard.done')}
        showCancel={false}
        autoFocusConfirm
      />
    );
  }

  if (step.kind === 'confirm') {
    const { code, card } = step;
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('billing.giftCard.confirmTitle')}
        content={
          <div>
            <GiftCardHero card={card} amount={amountOf(card.amount)} />
            <GiftCardTerms card={card} locale={locale} />
            {failureText && (
              <p role="alert" className="mt-3 text-12 leading-[1.667] text-[var(--error-fg)]">
                {failureText}
              </p>
            )}
          </div>
        }
        maxWidth={420}
        confirmText={t('billing.giftCard.confirmAction')}
        cancelText={t('billing.actions.close')}
        autoFocusConfirm
        loading={busy}
        onConfirm={() => {
          hold();
          void redeem(code, card);
        }}
      />
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('billing.giftCard.title')}
      content={
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && value.trim()) void preview(value);
          }}
        >
          <FormField
            label={t('billing.giftCard.inputLabel')}
            hint={failureText ? undefined : t('billing.giftCard.inputHint')}
            error={failureText ?? undefined}
            reserveFeedback
          >
            {(control) => (
              <Input
                id={control.id}
                aria-describedby={control['aria-describedby']}
                aria-invalid={control['aria-invalid']}
                error={control.error}
                value={value}
                onChange={(next) => {
                  setValue(next);
                  if (failure) setFailure(null);
                }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                mono
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={busy}
              />
            )}
          </FormField>
        </form>
      }
      maxWidth={420}
      confirmText={t('billing.giftCard.continue')}
      cancelText={t('billing.actions.close')}
      confirmDisabled={!value.trim()}
      loading={busy}
      onConfirm={() => {
        hold();
        void preview(value);
      }}
    />
  );
}

/**
 * 卡面（金额印在卡上）+ 来源 + 留言：领取前后都以它作为主视觉。
 * 金额印不上卡面时（本版本没有的字符），退回卡面下方的普通文字。
 */
function GiftCardHero({ card, amount }: { card: BillingGiftCard; amount: string }) {
  const { t } = useTranslation();
  const printed = giftCardFaceShowsAmount(card.faceCode, card.amount, BILLING_CURRENCY);
  return (
    <div>
      <GiftCardFace
        faceCode={card.faceCode}
        amount={card.amount}
        currency={BILLING_CURRENCY}
        label={t('billing.giftCard.cardLabel', { amount })}
      />
      <div className="mt-3 text-center">
        {!printed && (
          <p className="text-28 font-semibold leading-[1.286] tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">
            {amount}
          </p>
        )}
        <p className="text-12 leading-[1.667] text-[var(--text-secondary)]">
          {t('billing.giftCard.from', { sender: card.senderName })}
        </p>
        {card.message && (
          <p className="mt-2 text-13 leading-[1.54] text-[var(--text-primary)] [overflow-wrap:anywhere]">
            {card.message}
          </p>
        )}
      </div>
    </div>
  );
}

function GiftCardTerms({ card, locale }: { card: BillingGiftCard; locale: string }) {
  const { t } = useTranslation();
  // 自己买的卡没有领取截止，进充值余额、永久有效。
  if (card.destination === 'PURCHASED') {
    return (
      <div className="mt-4 divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
        <SummaryRow
          label={t('billing.giftCard.fields.destination')}
          value={t('billing.balance.purchased')}
        />
        <SummaryRow
          label={t('billing.giftCard.fields.validity')}
          value={t('billing.giftCard.fields.validityPermanent')}
        />
      </div>
    );
  }
  return (
    <div className="mt-4 divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
      {card.validityDays !== null && (
        <SummaryRow
          label={t('billing.giftCard.fields.validity')}
          value={t('billing.giftCard.fields.validityValue', { count: card.validityDays })}
        />
      )}
      {card.claimDeadline !== null && (
        <SummaryRow
          label={t('billing.giftCard.fields.claimBy')}
          value={formatDate(card.claimDeadline, locale)}
        />
      )}
      <SummaryRow
        label={t('billing.giftCard.fields.destination')}
        value={t('billing.balance.promotional')}
      />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 px-3.5 py-2.5 text-12">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 text-right text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  );
}
