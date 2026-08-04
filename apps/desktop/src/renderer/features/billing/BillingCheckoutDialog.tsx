import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as QRCode from 'qrcode';
import { Check, CircleAlert, ExternalLink, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import cindyIconUrl from '@/../../resources/icon.png?url';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { billingApi } from './api';
import type { BillingCheckoutState } from './useBillingCheckout';

interface BillingCheckoutDialogProps {
  state: BillingCheckoutState;
  onClose: () => void;
  onRefresh: () => void;
  onRetry: () => void;
}

function actionOf(state: BillingCheckoutState) {
  return state.order?.paymentAction ?? state.subscription?.paymentAction ?? null;
}

export function BillingCheckoutDialog({
  state,
  onClose,
  onRefresh,
  onRetry,
}: BillingCheckoutDialogProps) {
  const { t } = useTranslation();
  const action = actionOf(state);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const openedRedirectKeyRef = useRef<string | null>(null);
  const redirectUrl = action?.type === 'REDIRECT' ? action.url : null;
  const redirectKey =
    action?.type === 'REDIRECT'
      ? [
          state.kind,
          state.order?.orderId ??
            state.subscription?.purchaseAttemptId ??
            state.subscription?.subscriptionId,
          action.url,
          action.expiresAt,
        ].join(':')
      : null;

  useEffect(() => {
    let active = true;
    setQrDataUrl(null);
    if (action?.type === 'QR_CODE') {
      void QRCode.toDataURL(action.value, {
        errorCorrectionLevel: 'H',
        width: 320,
        margin: 4,
      })
        .then((dataUrl) => {
          if (active) setQrDataUrl(dataUrl);
        })
        .catch(() => {
          if (active) setQrDataUrl(null);
        });
    }
    return () => {
      active = false;
    };
  }, [action]);

  useEffect(() => {
    if (!action) {
      setRemainingSeconds(null);
      return;
    }
    const update = () => {
      setRemainingSeconds(
        Math.max(0, Math.ceil((Date.parse(action.expiresAt) - Date.now()) / 1000)),
      );
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [action]);

  const title = useMemo(() => {
    if (state.phase === 'CREATING') return t('billing.checkout.creatingTitle');
    if (state.phase === 'AWAITING_PAYMENT') return t('billing.checkout.awaitingTitle');
    if (state.phase === 'COMPLETED') return t('billing.checkout.completedTitle');
    if (state.phase === 'EXPIRED') return t('billing.checkout.expiredTitle');
    if (state.phase === 'CANCELED') return t('billing.checkout.canceledTitle');
    return t('billing.checkout.failedTitle');
  }, [state.phase, t]);

  const openRedirect = () => {
    if (action?.type === 'REDIRECT') void billingApi.openPaymentRedirect(action.url);
  };

  useEffect(() => {
    if (!state.open || state.phase !== 'AWAITING_PAYMENT') {
      openedRedirectKeyRef.current = null;
      return;
    }
    if (!redirectKey || !redirectUrl || openedRedirectKeyRef.current === redirectKey) return;
    openedRedirectKeyRef.current = redirectKey;
    void billingApi.openPaymentRedirect(redirectUrl);
  }, [redirectKey, redirectUrl, state.open, state.phase]);

  // 过期判定以服务端为权威：服务端只下发仍有效的动作，动作过期后轮询响应里
  // 会把它置空。因此“曾经有动作、现在没有了”才代表过期，本地时钟偏移不会
  // 误藏仍可支付的二维码，也不会闪现已过期动作。倒计时仅作展示。
  const hadActionRef = useRef(false);
  useEffect(() => {
    if (action) hadActionRef.current = true;
    if (!state.open || state.phase !== 'AWAITING_PAYMENT') hadActionRef.current = false;
  }, [action, state.open, state.phase]);
  const actionExpired =
    state.phase === 'AWAITING_PAYMENT' && action === null && hadActionRef.current;

  const canRetry =
    (state.error && state.intent !== null && state.order === null && state.subscription === null) ||
    (state.kind === 'TOPUP' &&
      (state.order?.status === 'FAILED' || state.order?.status === 'EXPIRED'));

  return (
    <Dialog.Root
      open={state.open}
      onOpenChange={(open) => !open && state.phase !== 'CREATING' && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] w-[calc(100vw-40px)] max-w-[620px]',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl',
            'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            'text-[var(--text-primary)] focus:outline-none',
          )}
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-6 py-5">
            <div>
              <Dialog.Title className="text-lg font-medium">{title}</Dialog.Title>
              <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {state.kind === 'TOPUP'
                  ? t('billing.checkout.topupSubtitle')
                  : t('billing.checkout.subscriptionSubtitle')}
              </p>
            </div>
            {state.phase !== 'CREATING' && (
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]"
                  aria-label={t('billing.actions.close')}
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            )}
          </div>

          <div className="flex min-h-[300px] flex-col items-center justify-center px-6 py-7 text-center">
            {state.phase === 'CREATING' && (
              <>
                <Spinner icon={LoaderCircle} size={28} className="text-[var(--text-secondary)]" />
                <p className="mt-4 text-sm text-[var(--text-secondary)]">
                  {t('billing.checkout.creatingBody')}
                </p>
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && actionExpired && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--surface-chip)]">
                  <CircleAlert size={23} />
                </div>
                <p className="mt-4 max-w-[320px] text-sm text-[var(--text-secondary)]">
                  {t('billing.checkout.actionExpiredBody')}
                </p>
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && !actionExpired && action?.type === 'QR_CODE' && (
              <>
                <div
                  className="relative grid place-items-center rounded-xl border border-[var(--border-default)] bg-white p-2"
                  style={{
                    width: 'min(280px, calc(100vw - 96px), calc(100vh - 260px))',
                    height: 'min(280px, calc(100vw - 96px), calc(100vh - 260px))',
                  }}
                >
                  {qrDataUrl ? (
                    <>
                      <img src={qrDataUrl} className="size-full" alt={t('billing.checkout.qrAlt')} />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute grid size-10 place-items-center rounded-lg bg-white p-1"
                      >
                        <img src={cindyIconUrl} className="size-8 rounded-md" alt="" />
                      </span>
                    </>
                  ) : (
                    <Spinner size={24} className="text-[var(--text-secondary)]" />
                  )}
                </div>
                <p className="mt-4 text-sm font-medium">{t('billing.checkout.scanHint')}</p>
                <p className="mt-1 text-12 text-[var(--text-tertiary)]">
                  {remainingSeconds === null
                    ? t('billing.checkout.checkingExpiry')
                    : t('billing.checkout.expiresIn', {
                        minutes: Math.floor(remainingSeconds / 60),
                        seconds: String(remainingSeconds % 60).padStart(2, '0'),
                      })}
                </p>
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && !actionExpired && action?.type === 'REDIRECT' && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--surface-chip)]">
                  <ExternalLink size={22} />
                </div>
                <p className="mt-4 text-sm font-medium">{t('billing.checkout.redirectHint')}</p>
                <button
                  type="button"
                  onClick={openRedirect}
                  className="mt-5 inline-flex h-9 items-center gap-2 rounded-full bg-[var(--text-primary)] px-5 text-sm font-medium text-[var(--surface)]"
                >
                  <ExternalLink size={14} />
                  {t('billing.checkout.openPayment')}
                </button>
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && !action && !actionExpired && (
              <>
                <Spinner size={26} className="text-[var(--text-secondary)]" />
                <p className="mt-4 text-sm text-[var(--text-secondary)]">
                  {t('billing.checkout.refreshingAction')}
                </p>
              </>
            )}

            {state.phase === 'COMPLETED' && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--text-primary)] text-[var(--surface)]">
                  <Check size={24} />
                </div>
                <p className="mt-4 text-sm font-medium">{t('billing.checkout.paymentCompleted')}</p>
              </>
            )}

            {(state.phase === 'FAILED' ||
              state.phase === 'EXPIRED' ||
              state.phase === 'CANCELED') && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--surface-chip)]">
                  <CircleAlert size={23} />
                </div>
                <p className="mt-4 max-w-[320px] text-sm text-[var(--text-secondary)]">
                  {state.error
                    ? t('billing.checkout.requestFailed')
                    : state.phase === 'EXPIRED'
                      ? t('billing.checkout.expiredBody')
                      : state.phase === 'CANCELED'
                        ? t('billing.checkout.canceledBody')
                        : t('billing.checkout.failedBody')}
                </p>
              </>
            )}
          </div>

          <div className="flex min-h-16 items-center justify-end gap-3 border-t border-[var(--border-default)] px-6 py-3">
            <div className="flex items-center gap-2">
              {state.phase === 'AWAITING_PAYMENT' && (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium transition-colors hover:bg-[var(--surface-hover-soft)]"
                >
                  <RotateCcw size={14} />
                  {t('billing.actions.refresh')}
                </button>
              )}
              {(state.phase === 'FAILED' || state.phase === 'EXPIRED') && canRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--text-primary)] px-4 text-12 font-medium text-[var(--surface)]"
                >
                  <RotateCcw size={14} />
                  {t('billing.actions.retry')}
                </button>
              )}
              {isTerminalPhase(state.phase) && (
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium transition-colors hover:bg-[var(--surface-hover-soft)]"
                >
                  {t('billing.actions.close')}
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function isTerminalPhase(phase: BillingCheckoutState['phase']): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'EXPIRED' || phase === 'CANCELED';
}
