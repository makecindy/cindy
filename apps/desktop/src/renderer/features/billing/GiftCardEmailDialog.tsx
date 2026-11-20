import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type {
  BillingPurchasedGiftCard,
  BillingSendGiftCardEmailResult,
} from '../../../shared/billing';
import { GiftCardFace } from './GiftCardFace';
import { formatGiftCardAmount } from './giftCardPurchase';

interface GiftCardEmailDialogProps {
  /** 要发的卡；null 时弹窗关闭。 */
  card: BillingPurchasedGiftCard | null;
  onClose: () => void;
  onSend: (card: BillingPurchasedGiftCard, email: string) => Promise<BillingSendGiftCardEmailResult>;
}

type SendError =
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'cooldown'; until: number | null }
  | { kind: 'failed' };

/**
 * 服务端说「冷却中」却没给出剩余时间（没有可用的 Retry-After）时按这个时长倒计时：与服务端
 * 的单卡冷却（emailCooldownSeconds，60 秒）一致。期间不能再点发送，到时间后可以再试。
 */
export const GIFT_CARD_EMAIL_FALLBACK_COOLDOWN_MS = 60_000;

/** 距离冷却结束还有几秒；已结束或时间不可读时为 0。 */
export function giftCardEmailCooldownSeconds(until: number | null, now: number): number {
  if (until === null || !Number.isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * 把一张没送出去的卡发到对方邮箱：填收件邮箱，看一眼对方会收到什么，然后发送。
 * 邮件异步发出，结果回到卡片的状态里；同一张卡冷却结束后可以再发，也可以换个邮箱。
 */
export function GiftCardEmailDialog({ card, onClose, onSend }: GiftCardEmailDialogProps) {
  return (
    <Dialog.Root open={card !== null} onOpenChange={(next) => !next && onClose()}>
      {/* 换一张卡就是一张新表单：从这张卡上次发到的邮箱开始（没发过就空着）。 */}
      {card && <GiftCardEmailForm key={card.cardId} card={card} onClose={onClose} onSend={onSend} />}
    </Dialog.Root>
  );
}

/**
 * 冷却到什么时候：优先用服务端这次给的时间；没有时用这张卡记录的下次可发时间；都没有（或已过）
 * 就从现在起按 GIFT_CARD_EMAIL_FALLBACK_COOLDOWN_MS 计，不能当作已经冷却完毕。
 */
function cooldownDeadline(retryAt: number | null, card: BillingPurchasedGiftCard, now: number): number {
  if (retryAt !== null && Number.isFinite(retryAt) && retryAt > now) return retryAt;
  const recorded = card.email ? Date.parse(card.email.nextAvailableAt) : Number.NaN;
  if (Number.isFinite(recorded) && recorded > now) return recorded;
  return now + GIFT_CARD_EMAIL_FALLBACK_COOLDOWN_MS;
}

function GiftCardEmailForm({
  card,
  onClose,
  onSend,
}: {
  card: BillingPurchasedGiftCard;
  onClose: () => void;
  onSend: GiftCardEmailDialogProps['onSend'];
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [email, setEmail] = useState(() => card.email?.recipient ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<SendError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const cooldownUntil =
    error?.kind === 'cooldown'
      ? error.until
      : card.email
        ? Date.parse(card.email.nextAvailableAt)
        : null;
  const cooldown = giftCardEmailCooldownSeconds(cooldownUntil, now);

  // 冷却中每秒更新一次倒计时；结束或关闭（卸载）后停止。
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), 1_000);
    return () => window.clearTimeout(timer);
  }, [cooldown, now]);

  const amount = formatGiftCardAmount(card.amount, card.currency, locale);
  const trimmed = email.trim();
  const canSend = trimmed.length > 0 && !sending && cooldown === 0 && error?.kind !== 'unavailable';

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const result = await onSend(card, trimmed);
      if (result.ok) {
        onClose();
        return;
      }
      const rejectedAt = Date.now();
      setNow(rejectedAt);
      setError(
        result.reason === 'COOLDOWN'
          ? { kind: 'cooldown', until: cooldownDeadline(result.retryAt, card, rejectedAt) }
          : result.reason === 'INVALID_EMAIL'
            ? { kind: 'invalid' }
            : { kind: 'unavailable' },
      );
      if (result.reason === 'INVALID_EMAIL') inputRef.current?.focus();
    } catch {
      setError({ kind: 'failed' });
    } finally {
      setSending(false);
    }
  };

  const fieldError =
    error?.kind === 'invalid'
      ? t('billing.giftCardPurchase.email.invalid')
      : error?.kind === 'unavailable'
        ? t('billing.giftCardPurchase.toasts.unavailable')
        : error?.kind === 'failed'
          ? t('billing.giftCardPurchase.email.failed')
          : undefined;

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10003]" />
      <Dialog.Content
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        className={cn(
          'modal-panel fixed left-1/2 top-1/2 z-[10004] flex max-h-[calc(100dvh-40px)] w-[calc(100vw-40px)] max-w-[440px] flex-col',
          '-translate-x-1/2 -translate-y-1/2 overflow-hidden',
          'text-[var(--text-primary)] focus:outline-none',
        )}
        aria-describedby={undefined}
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-1 pt-5">
            <div>
              <Dialog.Title className="text-lg font-medium">
                {t('billing.giftCardPurchase.email.title')}
              </Dialog.Title>
              <p className="mt-1 text-12 leading-[1.667] text-[var(--text-secondary)]">
                {t('billing.giftCardPurchase.email.description')}
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

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1 pt-3.5">
            <section
              aria-label={t('billing.giftCardPurchase.email.previewLabel')}
              className="flex items-center gap-3.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-hover-soft)] p-3"
            >
              <div className="w-[76px] shrink-0">
                <GiftCardFace
                  faceCode={card.faceCode}
                  amount={card.amount}
                  currency={card.currency}
                  label={t('billing.giftCard.cardLabel', { amount })}
                  className="rounded-lg"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-11 leading-[1.455] text-[var(--text-tertiary)]">
                  {t('billing.giftCardPurchase.email.previewLabel')}
                </p>
                <p className="mt-0.5 truncate text-13 font-medium">
                  <span className="tabular-nums">{amount}</span>
                  <span className="font-normal text-[var(--text-secondary)]">
                    {' · '}
                    {t('billing.giftCard.from', { sender: card.senderName })}
                  </span>
                </p>
                <p className="mt-0.5 line-clamp-2 text-12 leading-[1.5] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                  {card.message
                    ? t('billing.giftCardPurchase.email.previewWithMessage', { message: card.message })
                    : t('billing.giftCardPurchase.email.previewLinkOnly')}
                </p>
              </div>
            </section>

            <FormField
              label={t('billing.giftCardPurchase.email.recipient')}
              error={fieldError}
              hint={
                cooldown > 0
                  ? t('billing.giftCardPurchase.email.cooldown', { seconds: cooldown })
                  : t('billing.giftCardPurchase.email.hint')
              }
              reserveFeedback
            >
              {(control) => (
                <Input
                  id={control.id}
                  aria-describedby={control['aria-describedby']}
                  inputRef={inputRef}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  maxLength={254}
                  value={email}
                  onChange={(value) => {
                    setEmail(value);
                    if (error?.kind === 'invalid' || error?.kind === 'failed') setError(null);
                  }}
                  placeholder={t('billing.giftCardPurchase.email.placeholder')}
                  error={control.error}
                />
              )}
            </FormField>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2.5 px-6 pb-5 pt-4">
            <Button variant="secondary" size="lg" type="button" onClick={onClose}>
              {t('billing.giftCardPurchase.cancel')}
            </Button>
            <Button variant="cta" size="lg" type="submit" loading={sending} disabled={!canSend}>
              {t('billing.giftCardPurchase.email.send')}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
