import { Button } from '@/components/ui/button';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as QRCode from 'qrcode';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import cindyIconUrl from '@/../../resources/icon.png?url';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  BillingCatalogOffer,
  BillingCatalogProduct,
  BillingCatalogOfferUnavailableReason,
  BillingPaymentAction,
} from '../../../shared/billing';
import { PlanComparison, type ComparisonPlan } from './PlanComparison';
import { billingApi } from './api';
import {
  formatBillingAmount,
  formatBillingMinorAmount as formatPlanChangeMinorAmount,
} from './money';
import type { PlanChangeState } from './usePlanChange';

export type PlanChangeCandidate = {
  product: BillingCatalogProduct;
  offer: BillingCatalogOffer;
  providers: Array<'alipay' | 'stripe'>;
  available?: boolean;
  unavailableReason?: BillingCatalogOfferUnavailableReason | null;
  /**
   * UI hint only; the server quote is authoritative. Null means the product
   * level is missing, so the client hides the direction instead of guessing.
   */
  direction: 'UPGRADE' | 'SAME_LEVEL' | 'DOWNGRADE' | null;
};

function formatEffectiveDate(iso: string, locale: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(timestamp);
  } catch {
    return iso;
  }
}

export function PlanChangeTargetDialog({
  open,
  currentPlan,
  candidates,
  onClose,
  onSelect,
  onTopup,
  topupDisabled = false,
  disabled = false,
}: {
  open: boolean;
  currentPlan: PlanChangeCandidate | null;
  candidates: PlanChangeCandidate[];
  onClose: () => void;
  onSelect: (candidate: PlanChangeCandidate) => void;
  onTopup?: () => void;
  topupDisabled?: boolean;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [selectedProductCode, setSelectedProductCode] = useState<string | null>(null);
  const selectedCandidates = candidates.filter(
    (candidate) => candidate.product.code === selectedProductCode,
  );
  useEffect(() => {
    if (!open || (selectedProductCode && selectedCandidates.length === 0))
      setSelectedProductCode(null);
  }, [open, selectedProductCode, selectedCandidates.length]);
  const choosingOffer = selectedProductCode !== null && selectedCandidates.length > 0;
  const offerListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && choosingOffer)
      offerListRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, choosingOffer]);
  const plans = new Map<string, ComparisonPlan>();
  for (const candidate of currentPlan ? [currentPlan, ...candidates] : candidates) {
    const current = candidate.offer.code === currentPlan?.offer.code;
    const action = current
      ? t('billing.catalog.currentPlan')
      : candidate.available === false
        ? candidate.unavailableReason
          ? t(`billing.catalog.unavailableReasons.${candidate.unavailableReason}`)
          : t('billing.comparison.changeUnavailable')
        : t(
            candidate.direction === 'UPGRADE'
              ? 'billing.comparison.upgrade'
              : candidate.direction === 'DOWNGRADE'
                ? 'billing.comparison.downgrade'
                : 'billing.comparison.select',
            { name: candidate.product.name },
          );
    const entry = {
      offer: candidate.offer,
      current,
      action,
      disabled: disabled || candidate.available === false,
      onSelect: () => {
        if (disabled || current || candidate.available === false) return;
        if (
          candidates.filter(
            (option) =>
              option.product.code === candidate.product.code && option.available !== false,
          ).length > 1
        ) {
          setSelectedProductCode(candidate.product.code);
        } else onSelect(candidate);
      },
    };
    const group = plans.get(candidate.product.code);
    if (group) {
      group.offers.push(entry);
    } else
      plans.set(candidate.product.code, {
        product: candidate.product,
        offers: [entry],
        defaultOfferCode: candidate.offer.code,
      });
  }
  const sortedPlans = [...plans.values()]
    .map((plan) => {
      // The current contract keeps its own price. Targets use only offers that
      // this subscription can switch to, regardless of transient refresh state.
      const available = candidates.filter(
        (candidate) =>
          candidate.product.code === plan.product.code && candidate.available !== false,
      );
      if (plan.offers.some((entry) => entry.current)) {
        return available.length === 0
          ? plan
          : {
              ...plan,
              action: {
                action: t('billing.settings.subscriptionCard.changeAction'),
                disabled,
                onSelect: () => {
                  if (!disabled) setSelectedProductCode(plan.product.code);
                },
              },
            };
      }
      const defaultCandidate = available.reduce<PlanChangeCandidate | undefined>(
        (lowest, candidate) => {
          if (!lowest) return candidate;
          const offer = candidate.offer;
          return offer.currency === lowest.offer.currency &&
            offer.interval === lowest.offer.interval &&
            offer.amount !== null &&
            (lowest.offer.amount === null || Number(offer.amount) < Number(lowest.offer.amount))
            ? candidate
            : lowest;
        },
        undefined,
      );
      return {
        ...plan,
        defaultOfferCode: defaultCandidate?.offer.code ?? plan.defaultOfferCode,
        purchasableOffers: available.map((candidate) => candidate.offer),
      };
    })
    .sort((a, b) => a.product.sortOrder - b.product.sortOrder);
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9990] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-[9991] flex max-h-[calc(100dvh-48px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:outline-none',
            choosingOffer ? 'max-w-[600px]' : 'max-w-[1120px]',
          )}
        >
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <div className="flex min-w-0 items-center gap-2">
              {choosingOffer && (
                <button
                  type="button"
                  aria-label={t('billing.planChange.back')}
                  onClick={() => setSelectedProductCode(null)}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <ChevronLeft size={16} />
                </button>
              )}
              <Dialog.Title className="text-16 font-medium">
                {choosingOffer
                  ? selectedCandidates[0].product.name
                  : t('billing.planChange.targetTitle')}
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('billing.actions.close')}
                className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)]"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--border-default)] px-6 py-4 [scrollbar-gutter:stable]">
            {!candidates.some((candidate) => candidate.available !== false) && (
              <p role="status" className="mb-4 text-12 text-[var(--text-secondary)]">
                {t('billing.planChange.emptyTitle')}
              </p>
            )}
            {choosingOffer ? (
              <div
                ref={offerListRef}
                className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]"
              >
                {selectedCandidates.map((candidate) => {
                  const offer = candidate.offer;
                  const unavailable = candidate.available === false;
                  return (
                    <button
                      key={offer.code}
                      type="button"
                      disabled={disabled || unavailable}
                      onClick={() => {
                        if (!disabled && !unavailable) onSelect(candidate);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-13 transition-colors enabled:hover:bg-[var(--surface-hover-soft)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="font-medium">
                          {candidate.providers
                            .map((provider) => t(`billing.providers.${provider}`))
                            .join(' / ')}
                        </p>
                        {offer.name?.trim() && <p>{offer.name}</p>}
                        {offer.creditAmount !== null && (
                          <p className="text-12 text-[var(--text-secondary)]">
                            {t(
                              offer.interval
                                ? `billing.comparison.credits.${offer.interval}`
                                : 'billing.credits',
                              {
                                amount: formatBillingAmount(
                                  offer.creditAmount,
                                  offer.currency,
                                  locale,
                                ),
                              },
                            )}
                          </p>
                        )}
                        {offer.rolloverCap !== null && (
                          <p className="text-12 text-[var(--text-secondary)]">
                            {t('billing.comparison.rollover', {
                              amount: formatBillingAmount(
                                offer.rolloverCap,
                                offer.currency,
                                locale,
                              ),
                              period: t(
                                `billing.comparison.nextPeriod.${offer.interval ?? 'OTHER'}`,
                              ),
                            })}
                          </p>
                        )}
                        {unavailable && (
                          <p className="text-12 text-[var(--text-secondary)]">
                            {t(
                              candidate.unavailableReason
                                ? `billing.catalog.unavailableReasons.${candidate.unavailableReason}`
                                : 'billing.comparison.changeUnavailable',
                            )}
                          </p>
                        )}
                      </div>
                      <p className="text-right tabular-nums">
                        {offer.amount !== null
                          ? formatBillingAmount(offer.amount, offer.currency, locale)
                          : '—'}
                        {offer.interval && (
                          <span className="text-12 text-[var(--text-secondary)]">
                            {' '}
                            / {t(`billing.intervals.${offer.interval}`)}
                          </span>
                        )}
                      </p>
                      <ChevronRight size={16} className="shrink-0 text-[var(--text-secondary)]" />
                    </button>
                  );
                })}
              </div>
            ) : (
              <PlanComparison
                plans={sortedPlans}
                freeAction={t('billing.comparison.topup')}
                onViewModels={onClose}
                freeDisabled={topupDisabled || !onTopup}
                onFreeAction={() => onTopup?.()}
              />
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
  onReselect,
  onAbandon,
}: {
  state: PlanChangeState;
  targetName: string | null;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
  onReselect: () => void;
  onAbandon: () => void;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const change = state.planChange;
  const action: BillingPaymentAction | null = change?.paymentAction ?? null;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const openedRedirectKeyRef = useRef<string | null>(null);
  const redirectUrl = action?.type === 'REDIRECT' ? action.url : null;
  const redirectKey =
    action?.type === 'REDIRECT'
      ? [change?.planChangeId, action.url, action.expiresAt].join(':')
      : null;
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
    if (!state.open || state.phase !== 'AWAITING_PAYMENT') {
      openedRedirectKeyRef.current = null;
      return;
    }
    if (!redirectKey || !redirectUrl || openedRedirectKeyRef.current === redirectKey) return;
    openedRedirectKeyRef.current = redirectKey;
    void billingApi.openPaymentRedirect(redirectUrl);
  }, [redirectKey, redirectUrl, state.open, state.phase]);

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
      ? formatPlanChangeMinorAmount(change.quotedAmountMinor, change.quotedCurrency, billingLocale)
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
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] flex max-h-[calc(100dvh-40px)] w-[calc(100vw-40px)] max-w-[600px] flex-col',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl',
            'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            'text-[var(--text-primary)] focus:outline-none',
          )}
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border-default)] px-6 py-5">
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

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 text-center">
            <div className="flex min-h-[204px] flex-col items-center justify-center">
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
                          date: formatEffectiveDate(change.effectiveAt, billingLocale),
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
                    className="relative grid place-items-center rounded-xl border border-[var(--border-default)] bg-white p-2"
                    style={{
                      width: 'min(280px, calc(100vw - 96px))',
                      height: 'min(280px, calc(100vw - 96px))',
                    }}
                  >
                    {qrDataUrl ? (
                      <>
                        <img
                          src={qrDataUrl}
                          className="size-full"
                          alt={t('billing.checkout.qrAlt')}
                        />
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
                  <Button
                    variant="cta"
                    size="lg"
                    type="button"
                    onClick={() => void billingApi.openPaymentRedirect(action.url)}
                    className="mt-5"
                  >
                    <ExternalLink size={14} />
                    {t('billing.checkout.openPayment')}
                  </Button>
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
                            date: formatEffectiveDate(change.effectiveAt, billingLocale),
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
                      ? state.quoteFailureReason === 'TARGET_NOT_ALLOWED'
                        ? t('billing.planChange.quoteRejected')
                        : t('billing.planChange.requestFailed')
                      : state.phase === 'CANCELED'
                        ? t('billing.planChange.canceledBody')
                        : state.phase === 'EXPIRED'
                          ? t('billing.planChange.expiredBody')
                          : t('billing.planChange.failedBody')}
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-6 py-3">
            <div>
              {state.phase === 'QUOTE_READY' && change?.status === 'QUOTED' && !state.stale && (
                <Button
                  variant="secondary"
                  size="lg"
                  tone="quiet"
                  type="button"
                  onClick={onAbandon}
                >
                  {t('billing.planChange.abandon')}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {state.phase === 'FAILED' && state.quoteFailureReason === 'TARGET_NOT_ALLOWED' && (
                <Button variant="cta" size="lg" type="button" onClick={onReselect}>
                  {t('billing.planChange.chooseAnotherPlan')}
                </Button>
              )}
              {(state.phase === 'AWAITING_PAYMENT' ||
                state.phase === 'PENDING_PROVIDER' ||
                (state.phase === 'QUOTE_READY' && state.stale)) && (
                <Button variant="secondary" size="lg" type="button" onClick={onRefresh}>
                  <RotateCcw size={14} />
                  {t('billing.actions.refresh')}
                </Button>
              )}
              {/* A stale snapshot must never be confirmable; the refresh action
                  above (plus background polling) re-reads the server first. */}
              {state.phase === 'QUOTE_READY' && change?.status === 'QUOTED' && !state.stale && (
                <Button variant="cta" size="lg" type="button" onClick={onConfirm}>
                  {t('billing.planChange.confirm')}
                </Button>
              )}
              {settled && (
                <Button variant="secondary" size="lg" type="button" onClick={onClose}>
                  {t('billing.actions.close')}
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
