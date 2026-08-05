import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as QRCode from 'qrcode';
import {
  ArrowLeft,
  ArrowDownRight,
  ArrowRight,
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

import cindyIconUrl from '@/../../resources/icon.png?url';
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
  providers: Array<'alipay' | 'stripe'>;
  /**
   * UI hint only; the server quote is authoritative. Null means the product
   * level is missing, so the client hides the direction instead of guessing.
   */
  direction: 'UPGRADE' | 'SAME_LEVEL' | 'DOWNGRADE' | null;
};

type PlanChangeProductGroup = {
  product: BillingCatalogProduct;
  candidates: PlanChangeCandidate[];
  defaultCandidate: PlanChangeCandidate;
};

function groupPlanChangeCandidates(candidates: PlanChangeCandidate[]): PlanChangeProductGroup[] {
  const groups = new Map<
    string,
    { product: BillingCatalogProduct; candidates: PlanChangeCandidate[] }
  >();
  for (const candidate of candidates) {
    const group = groups.get(candidate.product.code);
    if (group) {
      group.candidates.push(candidate);
    } else {
      groups.set(candidate.product.code, {
        product: candidate.product,
        candidates: [candidate],
      });
    }
  }
  return Array.from(groups.values()).map(({ product, candidates }) => ({
    product,
    candidates,
    defaultCandidate: candidates[0],
  }));
}

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
}: {
  open: boolean;
  currentPlan: PlanChangeCandidate | null;
  candidates: PlanChangeCandidate[];
  onClose: () => void;
  onSelect: (candidate: PlanChangeCandidate) => void;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const groups = useMemo(() => groupPlanChangeCandidates(candidates), [candidates]);
  const [selectedProductCode, setSelectedProductCode] = useState<string | null>(null);
  const [selectedOfferCode, setSelectedOfferCode] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.product.code === selectedProductCode) ?? null;
  const selectedCandidate =
    selectedGroup?.candidates.find((candidate) => candidate.offer.code === selectedOfferCode) ??
    selectedGroup?.defaultCandidate ??
    null;

  useEffect(() => {
    if (!open) {
      setSelectedProductCode(null);
      setSelectedOfferCode(null);
      return;
    }
    if (!selectedProductCode) return;
    if (!selectedGroup) {
      setSelectedProductCode(null);
      setSelectedOfferCode(null);
      return;
    }
    if (!selectedGroup.candidates.some((candidate) => candidate.offer.code === selectedOfferCode)) {
      setSelectedOfferCode(selectedGroup.defaultCandidate.offer.code);
    }
  }, [open, selectedGroup, selectedOfferCode, selectedProductCode]);

  const selectProduct = (productCode: string) => {
    const group = groups.find((candidate) => candidate.product.code === productCode);
    if (!group) return;
    setSelectedProductCode(productCode);
    setSelectedOfferCode(group.defaultCandidate.offer.code);
  };

  const backToProducts = () => {
    setSelectedProductCode(null);
    setSelectedOfferCode(null);
  };

  const renderAmount = (candidate: PlanChangeCandidate) => (
    <div className="shrink-0 text-right">
      <p className="text-12 font-medium tabular-nums text-[var(--text-primary)]">
        {candidate.offer.amount
          ? formatMoney(candidate.offer.amount, candidate.offer.currency, billingLocale)
          : '—'}
        {candidate.offer.interval && (
          <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
            / {t(`billing.intervals.${candidate.offer.interval}`)}
          </span>
        )}
      </p>
      {candidate.offer.creditAmount && (
        <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
          {t('billing.credits', {
            amount: formatMoney(
              candidate.offer.creditAmount,
              candidate.offer.currency,
              billingLocale,
            ),
          })}
        </p>
      )}
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9990] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-[9991] flex max-h-[min(640px,calc(100vh-48px))]',
            'w-[calc(100vw-48px)] max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-xl border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:outline-none',
          )}
        >
          <div className="flex items-center justify-between gap-4 px-6 pb-4 pt-5">
            <div className="flex min-w-0 items-center gap-2">
              <Dialog.Title className="truncate text-16 font-medium tracking-[-0.01em]">
                {selectedGroup?.product.name ?? t('billing.planChange.targetTitle')}
              </Dialog.Title>
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
            {selectedGroup ? (
              <div className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
                {selectedGroup.candidates.map((candidate) => {
                  const active = selectedCandidate?.offer.code === candidate.offer.code;
                  const offerName = candidate.offer.name?.trim();
                  return (
                    <button
                      key={candidate.offer.code}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedOfferCode(candidate.offer.code)}
                      className={cn(
                        'flex min-h-[72px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                        'focus-visible:ring-[var(--focus-ring)]',
                        active
                          ? 'bg-[var(--surface-hover-soft)]'
                          : 'bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        {offerName && (
                          <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                            {offerName}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        {renderAmount(candidate)}
                        <span
                          className={cn(
                            'grid size-5 shrink-0 place-items-center rounded-full border',
                            active
                              ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-[var(--surface)]'
                              : 'border-[var(--border-default)]',
                          )}
                        >
                          {active && <Check size={12} strokeWidth={2.5} />}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                {currentPlan && (
                  <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
                    <div className="flex w-full items-center justify-between gap-4 bg-[var(--surface-chip)] px-4 py-3 text-left">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                            {currentPlan.product.name}
                          </p>
                          <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                            {t('billing.catalog.currentPlan')}
                          </span>
                        </div>
                      </div>
                      {renderAmount(currentPlan)}
                    </div>
                  </div>
                )}

                {groups.length > 0 && (
                  <div
                    className={cn(
                      'divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]',
                      currentPlan && 'mt-4',
                    )}
                  >
                    {groups.map((group) => {
                      const candidate = group.defaultCandidate;
                      const hasMultipleOffers = group.candidates.length > 1;
                      const DirectionIcon =
                        candidate.direction === 'UPGRADE'
                          ? ArrowUpRight
                          : candidate.direction === 'DOWNGRADE'
                            ? ArrowDownRight
                            : null;
                      const directionLabel =
                        candidate.direction === 'UPGRADE'
                          ? t('billing.planChange.upgradeBadge')
                          : candidate.direction === 'DOWNGRADE'
                            ? t('billing.planChange.downgradeBadge')
                            : candidate.direction === 'SAME_LEVEL'
                              ? t('billing.planChange.sameLevelBadge')
                              : null;
                      const providerLabel = candidate.providers
                        .map((provider) => t(`billing.providers.${provider}`))
                        .join(', ');
                      return (
                        <button
                          key={group.product.code}
                          type="button"
                          onClick={() => {
                            if (hasMultipleOffers) {
                              selectProduct(group.product.code);
                            } else {
                              onSelect(candidate);
                            }
                          }}
                          className={cn(
                            'flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors',
                            'hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none',
                            'focus-visible:ring-2 focus-visible:ring-inset',
                            'focus-visible:ring-[var(--focus-ring)]',
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                              {group.product.name}
                            </p>
                            {(DirectionIcon || directionLabel || providerLabel) && (
                              <p className="mt-0.5 flex min-h-4 items-center gap-1 text-11 text-[var(--text-tertiary)]">
                                {DirectionIcon && <DirectionIcon size={12} />}
                                {directionLabel && <span>{directionLabel}</span>}
                                {directionLabel && providerLabel && <span aria-hidden>·</span>}
                                {providerLabel && <span>{providerLabel}</span>}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            {renderAmount(candidate)}
                            {hasMultipleOffers && (
                              <ArrowRight size={16} className="text-[var(--text-tertiary)]" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {groups.length === 0 && (
                  <div
                    className={cn(
                      'flex min-h-[184px] flex-col items-center justify-center rounded-xl border',
                      'border-[var(--border-default)] px-6 text-center',
                      currentPlan && 'mt-4',
                    )}
                  >
                    <div className="grid size-11 place-items-center rounded-full bg-[var(--surface-chip)]">
                      <PackageOpen size={22} />
                    </div>
                    <p className="mt-4 text-sm font-medium">{t('billing.planChange.emptyTitle')}</p>
                    <p className="mt-1 text-12 text-[var(--text-secondary)]">
                      {t('billing.planChange.emptyDescription')}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {selectedGroup && (
            <div className="flex min-h-16 items-center justify-between gap-4 border-t border-[var(--border-default)] px-6 py-3">
              <button
                type="button"
                onClick={backToProducts}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-1 text-13 font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <ArrowLeft size={15} />
                {t('billing.planChange.back')}
              </button>
              <button
                type="button"
                disabled={selectedCandidate === null}
                onClick={() => {
                  if (selectedCandidate) onSelect(selectedCandidate);
                }}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-5 text-13 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {t('billing.settings.subscriptionCard.changeAction')}
                <ArrowUpRight size={15} />
              </button>
            </div>
          )}
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
                    width: 'min(280px, calc(100vw - 96px), calc(100vh - 280px))',
                    height: 'min(280px, calc(100vw - 96px), calc(100vh - 280px))',
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
              {state.phase === 'FAILED' && state.quoteFailureReason === 'TARGET_NOT_ALLOWED' && (
                <button
                  type="button"
                  onClick={onReselect}
                  className="h-9 rounded-full bg-[var(--text-primary)] px-5 text-13 font-medium text-[var(--surface)]"
                >
                  {t('billing.planChange.chooseAnotherPlan')}
                </button>
              )}
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
