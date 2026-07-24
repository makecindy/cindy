import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as QRCode from 'qrcode';
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  PackageOpen,
  RotateCcw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  BillingCatalogOffer,
  BillingCatalogProduct,
  BillingPaymentAction,
} from '../../../shared/billing';
import { billingApi } from './api';
import {
  formatBillingAmount as formatMoney,
  formatBillingMinorAmount as formatPlanChangeMinorAmount,
} from './money';
import type { PlanChangeState } from './usePlanChange';

export type PlanChangeCandidate = {
  product: BillingCatalogProduct;
  offer: BillingCatalogOffer;
  /** UI hint only; the server quote is the authority on the change type. */
  direction: 'UPGRADE' | 'DOWNGRADE';
};

function formatEffectiveDate(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(timestamp);
  } catch {
    return iso;
  }
}

export function PlanChangeTargetDialog({
  open,
  candidates,
  currentPlanName,
  onClose,
  onSelect,
}: {
  open: boolean;
  candidates: PlanChangeCandidate[];
  currentPlanName: string | null;
  onClose: () => void;
  onSelect: (candidate: PlanChangeCandidate) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9990] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[9991] flex max-h-[min(640px,calc(100vh-48px))]',
            'w-[calc(100vw-48px)] max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-xl border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:outline-none',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
            <div>
              <Dialog.Title className="text-16 font-medium tracking-[-0.01em]">
                {t('billing.planChange.targetTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 max-w-[500px] text-12 leading-5 text-[var(--text-secondary)]">
                {currentPlanName
                  ? t('billing.planChange.targetDescriptionWithCurrent', {
                      plan: currentPlanName,
                    })
                  : t('billing.planChange.targetDescription')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]"
                aria-label={t('billing.actions.close')}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--border-default)] px-6 py-4 [scrollbar-gutter:stable]">
            {candidates.length === 0 ? (
              <div className="flex min-h-[184px] flex-col items-center justify-center rounded-xl border border-[var(--border-default)] px-6 text-center">
                <div className="grid size-11 place-items-center rounded-full bg-[var(--surface-chip)]">
                  <PackageOpen size={22} />
                </div>
                <p className="mt-4 text-sm font-medium">{t('billing.planChange.emptyTitle')}</p>
                <p className="mt-1 text-12 text-[var(--text-secondary)]">
                  {t('billing.planChange.emptyDescription')}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {candidates.map((candidate) => {
                  const DirectionIcon =
                    candidate.direction === 'UPGRADE' ? ArrowUpRight : ArrowDownRight;
                  return (
                    <button
                      key={candidate.offer.code}
                      type="button"
                      onClick={() => onSelect(candidate)}
                      className={cn(
                        'group relative flex min-h-[84px] w-full items-center gap-5 rounded-xl border px-4 py-3.5 text-left',
                        'border-[var(--border-default)] transition-colors hover:bg-[var(--surface-hover-soft)]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-primary)]',
                        'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)]',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                          {candidate.product.name}
                        </p>
                        <p className="mt-1 inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]">
                          <DirectionIcon size={12} />
                          {candidate.direction === 'UPGRADE'
                            ? t('billing.planChange.upgradeBadge')
                            : t('billing.planChange.downgradeBadge')}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-lg font-medium tracking-[-0.02em]">
                          {candidate.offer.amount
                            ? formatMoney(candidate.offer.amount, candidate.offer.currency)
                            : '—'}
                          {candidate.offer.interval && (
                            <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
                              / {t(`billing.intervals.${candidate.offer.interval}`)}
                            </span>
                          )}
                        </p>
                        {candidate.offer.creditAmount && (
                          <p className="mt-1 text-11 text-[var(--text-secondary)]">
                            {t('billing.credits', { amount: candidate.offer.creditAmount })}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useCountdownSeconds(expiresAt: string | null): number | null {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) {
      setRemainingSeconds(null);
      return;
    }
    const update = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return remainingSeconds;
}

export function PlanChangeStatusDialog({
  state,
  targetName,
  onClose,
  onConfirm,
  onRefresh,
  onAbandon,
}: {
  state: PlanChangeState;
  targetName: string | null;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
  onAbandon: () => void;
}) {
  const { t } = useTranslation();
  const change = state.planChange;
  const action: BillingPaymentAction | null = change?.paymentAction ?? null;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const actionSeconds = useCountdownSeconds(
    state.phase === 'AWAITING_PAYMENT' ? (action?.expiresAt ?? null) : null,
  );
  const quoteSeconds = useCountdownSeconds(
    state.phase === 'QUOTE_READY' ? (change?.quoteExpiresAt ?? null) : null,
  );

  useEffect(() => {
    let active = true;
    setQrDataUrl(null);
    if (action?.type === 'QR_CODE') {
      void QRCode.toDataURL(action.value, { width: 1024, margin: 4 })
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

  const busy = state.phase === 'QUOTING' || state.phase === 'CONFIRMING';
  const title = useMemo(() => {
    switch (state.phase) {
      case 'QUOTING':
        return t('billing.planChange.quotingTitle');
      case 'QUOTE_READY':
        return t('billing.planChange.quoteTitle');
      case 'CONFIRMING':
        return t('billing.planChange.confirmingTitle');
      case 'PENDING_PROVIDER':
        return t('billing.planChange.pendingProviderTitle');
      case 'AWAITING_PAYMENT':
        return t('billing.planChange.awaitingTitle');
      case 'SCHEDULED':
        return t('billing.planChange.scheduledTitle');
      case 'APPLIED':
        return t('billing.planChange.appliedTitle');
      case 'CANCELED':
        return t('billing.planChange.canceledTitle');
      case 'EXPIRED':
        return t('billing.planChange.expiredTitle');
      default:
        return t('billing.planChange.failedTitle');
    }
  }, [state.phase, t]);

  const isUpgrade = change?.changeType === 'UPGRADE';
  const quotedAmount =
    change && change.quotedAmountMinor !== null && change.quotedCurrency
      ? formatPlanChangeMinorAmount(change.quotedAmountMinor, change.quotedCurrency)
      : null;
  const settled =
    state.phase === 'SCHEDULED' ||
    state.phase === 'APPLIED' ||
    state.phase === 'CANCELED' ||
    state.phase === 'FAILED' ||
    state.phase === 'EXPIRED';

  return (
    <Dialog.Root open={state.open} onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] w-[calc(100vw-40px)] max-w-[600px]',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl',
            'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            'text-[var(--text-primary)] focus:outline-none',
          )}
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-6 py-5">
            <div>
              <Dialog.Title className="text-lg font-medium">{title}</Dialog.Title>
              {targetName && (
                <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                  {t('billing.planChange.targetLabel', { name: targetName })}
                </p>
              )}
            </div>
            {!busy && (
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

          <div className="flex min-h-[260px] flex-col items-center justify-center px-6 py-7 text-center">
            {busy && (
              <>
                <Spinner icon={LoaderCircle} size={28} className="text-[var(--text-secondary)]" />
                <p className="mt-4 text-sm text-[var(--text-secondary)]">
                  {state.phase === 'QUOTING'
                    ? t('billing.planChange.quotingBody')
                    : t('billing.planChange.confirmingBody')}
                </p>
              </>
            )}

            {state.phase === 'PENDING_PROVIDER' && (
              <>
                <Spinner icon={LoaderCircle} size={28} className="text-[var(--text-secondary)]" />
                <p className="mt-4 max-w-[400px] text-sm text-[var(--text-secondary)]">
                  {t('billing.planChange.pendingProviderBody')}
                </p>
              </>
            )}

            {state.phase === 'QUOTE_READY' && change && (
              <>
                <p className="text-sm font-medium">
                  {isUpgrade
                    ? quotedAmount
                      ? t('billing.planChange.upgradeDueNow', { amount: quotedAmount })
                      : t('billing.planChange.upgradeNoAmount')
                    : t('billing.planChange.downgradeAt', {
                        date: formatEffectiveDate(change.effectiveAt),
                      })}
                </p>
                <p className="mt-2 max-w-[400px] text-12 leading-5 text-[var(--text-secondary)]">
                  {isUpgrade
                    ? t('billing.planChange.upgradeHint')
                    : t('billing.planChange.downgradeHint')}
                </p>
                {quoteSeconds !== null && (
                  <p className="mt-3 text-11 text-[var(--text-tertiary)]">
                    {t('billing.planChange.quoteExpiresIn', {
                      minutes: Math.floor(quoteSeconds / 60),
                      seconds: String(quoteSeconds % 60).padStart(2, '0'),
                    })}
                  </p>
                )}
                {state.error && (
                  <p className="mt-3 text-12 text-[var(--text-primary)]">
                    {state.stale
                      ? t('billing.planChange.resyncHint')
                      : t('billing.planChange.requestFailed')}
                  </p>
                )}
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && action?.type === 'QR_CODE' && (
              <>
                <div
                  className="grid place-items-center rounded-xl border border-[var(--border-default)] bg-white p-2"
                  style={{
                    width: 'min(440px, calc(100vw - 96px), calc(100vh - 280px))',
                    height: 'min(440px, calc(100vw - 96px), calc(100vh - 280px))',
                  }}
                >
                  {qrDataUrl ? (
                    <img src={qrDataUrl} className="size-full" alt={t('billing.checkout.qrAlt')} />
                  ) : (
                    <Spinner size={24} className="text-[var(--text-secondary)]" />
                  )}
                </div>
                <p className="mt-4 text-sm font-medium">
                  {quotedAmount
                    ? t('billing.planChange.scanToPay', { amount: quotedAmount })
                    : t('billing.checkout.scanHint')}
                </p>
                <p className="mt-1 text-12 text-[var(--text-tertiary)]">
                  {actionSeconds === null
                    ? t('billing.checkout.checkingExpiry')
                    : t('billing.checkout.expiresIn', {
                        minutes: Math.floor(actionSeconds / 60),
                        seconds: String(actionSeconds % 60).padStart(2, '0'),
                      })}
                </p>
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && action?.type === 'REDIRECT' && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--surface-chip)]">
                  <ExternalLink size={22} />
                </div>
                <p className="mt-4 text-sm font-medium">{t('billing.checkout.redirectHint')}</p>
                <button
                  type="button"
                  onClick={() => void billingApi.openPaymentRedirect(action.url)}
                  className="mt-5 inline-flex h-9 items-center gap-2 rounded-full bg-[var(--text-primary)] px-5 text-sm font-medium text-[var(--surface)]"
                >
                  <ExternalLink size={14} />
                  {t('billing.checkout.openPayment')}
                </button>
              </>
            )}

            {state.phase === 'AWAITING_PAYMENT' && !action && (
              <>
                <Spinner size={26} className="text-[var(--text-secondary)]" />
                <p className="mt-4 text-sm text-[var(--text-secondary)]">
                  {t('billing.checkout.refreshingAction')}
                </p>
              </>
            )}

            {(state.phase === 'SCHEDULED' || state.phase === 'APPLIED') && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--text-primary)] text-[var(--surface)]">
                  <Check size={24} />
                </div>
                <p className="mt-4 text-sm font-medium">
                  {state.phase === 'APPLIED'
                    ? t('billing.planChange.appliedBody')
                    : change
                      ? t('billing.planChange.scheduledBody', {
                          date: formatEffectiveDate(change.effectiveAt),
                        })
                      : t('billing.planChange.scheduledTitle')}
                </p>
              </>
            )}

            {(state.phase === 'FAILED' ||
              state.phase === 'CANCELED' ||
              state.phase === 'EXPIRED') && (
              <>
                <div className="grid size-14 place-items-center rounded-full bg-[var(--surface-chip)]">
                  <CircleAlert size={23} />
                </div>
                <p className="mt-4 max-w-[340px] text-sm text-[var(--text-secondary)]">
                  {state.error
                    ? t('billing.planChange.requestFailed')
                    : state.phase === 'CANCELED'
                      ? t('billing.planChange.canceledBody')
                      : state.phase === 'EXPIRED'
                        ? t('billing.planChange.expiredBody')
                        : t('billing.planChange.failedBody')}
                </p>
              </>
            )}
          </div>

          <div className="flex min-h-16 items-center justify-between gap-3 border-t border-[var(--border-default)] px-6 py-3">
            <div>
              {state.phase === 'QUOTE_READY' && change?.status === 'QUOTED' && !state.stale && (
                <button
                  type="button"
                  onClick={onAbandon}
                  className="h-9 rounded-full px-3 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
                >
                  {t('billing.planChange.abandon')}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(state.phase === 'AWAITING_PAYMENT' ||
                state.phase === 'PENDING_PROVIDER' ||
                (state.phase === 'QUOTE_READY' && state.stale)) && (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium transition-colors hover:bg-[var(--surface-hover-soft)]"
                >
                  <RotateCcw size={14} />
                  {t('billing.actions.refresh')}
                </button>
              )}
              {/* A stale snapshot must never be confirmable; the refresh action
                  above (plus background polling) re-reads the server first. */}
              {state.phase === 'QUOTE_READY' && change?.status === 'QUOTED' && !state.stale && (
                <button
                  type="button"
                  onClick={onConfirm}
                  className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--text-primary)] px-5 text-13 font-medium text-[var(--surface)]"
                >
                  {t('billing.planChange.confirm')}
                </button>
              )}
              {settled && (
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
