import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  CreditCard,
  PackageOpen,
  RefreshCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type {
  BillingCatalog,
  BillingCatalogOffer,
  BillingCatalogOfferUnavailableReason,
  BillingCatalogProduct,
  BillingPendingPlanChange,
  BillingPurchaseOption,
  BillingSubscription,
} from '../../../shared/billing';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import type {
  ModelAccessBalance,
  ModelAccessCreditPoolUsage,
  ModelAccessCreditUsage,
  ModelAccessPromotionalGrantState,
} from '../../../shared/modelAccess';
import { billingApi } from './api';
import { BillingCheckoutDialog } from './BillingCheckoutDialog';
import { formatBillingAmount as formatMoney } from './money';
import {
  PlanChangeStatusDialog,
  PlanChangeTargetDialog,
  type PlanChangeCandidate,
} from './PlanChangeDialog';
import { useBillingCheckout } from './useBillingCheckout';
import { usePlanChange, type PlanChangeSettledKind } from './usePlanChange';

type CatalogOfferEntry = {
  product: BillingCatalogProduct;
  offer: BillingCatalogOffer;
  purchaseOptions: SupportedPurchaseOption[];
};

type SupportedBillingProvider = 'alipay' | 'stripe';
type SupportedPurchaseOption = BillingPurchaseOption & {
  provider: SupportedBillingProvider;
};

type PurchaseKind = BillingCatalogProduct['kind'];
type BalanceIssue = 'NOT_PROVISIONED' | 'NOT_SUPPORTED' | 'UNAVAILABLE' | null;

const SUPPORTED_BILLING_PROVIDERS = new Set<SupportedBillingProvider>(['alipay', 'stripe']);
const SUPPORTED_PAYMENT_ACTIONS = new Set<BillingPurchaseOption['paymentAction']>([
  'QR_CODE',
  'REDIRECT',
]);
const SUPPORTED_SUBSCRIPTION_CAPABILITIES = new Set<BillingPurchaseOption['capability']>([
  'MERCHANT_INITIATED_MANDATE',
  'PROVIDER_MANAGED_SUBSCRIPTION',
]);

const SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES: BillingSubscription['status'][] = [
  'INCOMPLETE',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'PAUSED',
];

function decimalParts(value: string): { value: bigint; scale: number } | null {
  const match = /^(0|[1-9]\d{0,14})(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  return {
    value: BigInt(`${match[1]}${fraction}`),
    scale: fraction.length,
  };
}

function compareDecimal(left: string, right: string): number | null {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return null;
  const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale);
  const bv = b.value * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function ledgerUnits(value: string): bigint | null {
  const match = /^(-?)(0|[1-9]\d{0,9})(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(9, '0');
  const units = BigInt(match[2]) * 1_000_000_000n + BigInt(fraction || '0');
  return match[1] === '-' ? -units : units;
}

function usagePercent(pool: ModelAccessCreditPoolUsage): number | null {
  if (pool.used === null || pool.total === null) return null;
  const used = ledgerUnits(pool.used);
  const total = ledgerUnits(pool.total);
  if (used === null || total === null || used < 0n || total < 0n) return null;
  if (total === 0n) return used === 0n ? 0 : null;
  const tenths = (used * 1_000n) / total;
  return Number(tenths > 1_000n ? 1_000n : tenths) / 10;
}

function formatLedgerTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(timestamp);
  } catch {
    return value;
  }
}

function isCustomTopup(offer: BillingCatalogOffer): boolean {
  return offer.amount === null && offer.minAmount !== null && offer.maxAmount !== null;
}

function hasServerAvailabilityProjection(offer: BillingCatalogOffer): boolean {
  return (
    offer.salesState !== undefined &&
    offer.purchasable !== undefined &&
    offer.unavailableReason !== undefined
  );
}

function isCatalogOfferVisible(entry: CatalogOfferEntry): boolean {
  return hasServerAvailabilityProjection(entry.offer) || entry.purchaseOptions.length > 0;
}

function isCatalogOfferPurchasable(entry: CatalogOfferEntry): boolean {
  if (!hasServerAvailabilityProjection(entry.offer)) return entry.purchaseOptions.length > 0;
  return entry.offer.purchasable === true && entry.purchaseOptions.length > 0;
}

function catalogOfferUnavailableReason(
  entry: CatalogOfferEntry,
): BillingCatalogOfferUnavailableReason | null {
  if (isCatalogOfferPurchasable(entry)) return null;
  return entry.offer.unavailableReason ?? 'NO_AVAILABLE_PAYMENT_CHANNEL';
}

function isSupportedPurchaseOption(
  option: BillingPurchaseOption,
  productKind: BillingCatalogProduct['kind'],
): option is SupportedPurchaseOption {
  if (!SUPPORTED_BILLING_PROVIDERS.has(option.provider as SupportedBillingProvider)) return false;
  if (!SUPPORTED_PAYMENT_ACTIONS.has(option.paymentAction)) return false;
  return productKind === 'CREDIT_TOPUP'
    ? option.capability === 'ONE_TIME_PAYMENT'
    : SUPPORTED_SUBSCRIPTION_CAPABILITIES.has(option.capability);
}

function currencyFractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function balanceIssue(error: unknown): Exclude<BalanceIssue, null> {
  const code = extractIpcError(error)?.code;
  if (code === 'NOT_FOUND') return 'NOT_PROVISIONED';
  if (code === 'UNSUPPORTED_CAPABILITY') return 'NOT_SUPPORTED';
  return 'UNAVAILABLE';
}

/**
 * Kept as a compatibility export for focused tests and old imports.
 * The actual product entry now lives in Settings.
 */
export function BillingPage() {
  const { dataOwnerId } = useAuth();
  return (
    <BillingSettingsSection key={`billing:${dataOwnerId ?? 'none'}`} accountId={dataOwnerId} />
  );
}

export function BillingSettingsSection({ accountId }: { accountId: string | null }) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [currentSubscription, setCurrentSubscription] = useState<BillingSubscription | null>(null);
  const [loadingSubscription, setLoadingSubscription] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState(false);
  const [creditUsage, setCreditUsage] = useState<ModelAccessCreditUsage | null>(null);
  const [balance, setBalance] = useState<ModelAccessBalance | null>(null);
  const [usageDetailsUnavailable, setUsageDetailsUnavailable] = useState(false);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [balanceError, setBalanceError] = useState<BalanceIssue>(null);
  const [subscriptionDialogOpen, setSubscriptionDialogOpen] = useState(false);
  const [topupDialogOpen, setTopupDialogOpen] = useState(false);
  const [planChangeTargetOpen, setPlanChangeTargetOpen] = useState(false);
  const [selectedOfferCode, setSelectedOfferCode] = useState<string | null>(null);
  const [selectedPurchaseOptionId, setSelectedPurchaseOptionId] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const checkout = useBillingCheckout(accountId);
  const previousCheckoutPhaseRef = useRef(checkout.state.phase);

  const resetSelection = useCallback(() => {
    setSelectedOfferCode(null);
    setSelectedPurchaseOptionId(null);
    setCustomAmount('');
  }, []);

  const loadBalance = useCallback(async () => {
    setLoadingBalance(true);
    setBalanceError(null);
    setUsageDetailsUnavailable(false);
    try {
      setCreditUsage(await billingApi.getCreditUsage());
      setBalance(null);
    } catch {
      try {
        setBalance(await billingApi.getBalance());
        setCreditUsage(null);
        setUsageDetailsUnavailable(true);
      } catch (error) {
        setCreditUsage(null);
        setBalance(null);
        setBalanceError(balanceIssue(error));
      }
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  const loadSubscription = useCallback(async () => {
    setLoadingSubscription(true);
    setSubscriptionError(false);
    try {
      setCurrentSubscription((await billingApi.getCurrentSubscription()).subscription);
    } catch {
      setCurrentSubscription(null);
      setSubscriptionError(true);
    } finally {
      setLoadingSubscription(false);
    }
  }, []);

  const loadBillingState = useCallback(async () => {
    setLoadingCatalog(true);
    setCatalogError(false);
    await Promise.allSettled([
      billingApi
        .getCatalog()
        .then(setCatalog, () => {
          setCatalog(null);
          setCatalogError(true);
        })
        .finally(() => setLoadingCatalog(false)),
      loadSubscription(),
      loadBalance(),
    ]);
  }, [loadBalance, loadSubscription]);

  useEffect(() => {
    void loadBillingState();
  }, [loadBillingState]);

  useEffect(() => {
    if (checkout.state.subscription) {
      setCurrentSubscription(checkout.state.subscription);
      setSubscriptionError(false);
    }
  }, [checkout.state.subscription]);

  useEffect(() => {
    const previousPhase = previousCheckoutPhaseRef.current;
    previousCheckoutPhaseRef.current = checkout.state.phase;
    if (previousPhase !== 'COMPLETED' && checkout.state.phase === 'COMPLETED') {
      void loadBalance();
    }
  }, [checkout.state.phase, loadBalance]);

  const handlePlanChangeSettled = useCallback(
    (kind: PlanChangeSettledKind) => {
      // APPLIED is the only settle that moves credits; one full reload covers
      // subscription, catalog, and balance without a second balance call.
      if (kind === 'APPLIED') void loadBillingState();
      else void loadSubscription();
    },
    [loadBillingState, loadSubscription],
  );
  const planChange = usePlanChange(accountId, handlePlanChangeSettled);

  const offers = useMemo<CatalogOfferEntry[]>(() => {
    if (!catalog) return [];
    return catalog.products
      .flatMap((product) =>
        product.offers.map((offer) => ({
          product,
          offer,
          purchaseOptions: Array.isArray(offer.purchaseOptions)
            ? offer.purchaseOptions.filter((option) =>
                isSupportedPurchaseOption(option, product.kind),
              )
            : [],
        })),
      )
      .filter(isCatalogOfferVisible)
      .sort((left, right) => {
        const productOrder = left.product.sortOrder - right.product.sortOrder;
        if (productOrder !== 0) return productOrder;
        return left.offer.code.localeCompare(right.offer.code);
      });
  }, [catalog]);

  const subscriptionOffers = useMemo(
    () => offers.filter(({ product }) => product.kind === 'SUBSCRIPTION'),
    [offers],
  );
  const topupOffers = useMemo(
    () => offers.filter(({ product }) => product.kind === 'CREDIT_TOPUP'),
    [offers],
  );

  const selected = useMemo(
    () =>
      offers.find(
        (entry) => entry.offer.code === selectedOfferCode && isCatalogOfferPurchasable(entry),
      ) ?? null,
    [offers, selectedOfferCode],
  );
  const selectedOption = useMemo(
    () =>
      selected?.purchaseOptions.find((option) => option.id === selectedPurchaseOptionId) ?? null,
    [selected, selectedPurchaseOptionId],
  );

  useEffect(() => {
    if (!selectedOfferCode) return;
    const selectedEntry = offers.find(({ offer }) => offer.code === selectedOfferCode);
    if (!selectedEntry || !isCatalogOfferPurchasable(selectedEntry)) {
      resetSelection();
    }
  }, [offers, resetSelection, selectedOfferCode]);

  useEffect(() => {
    if (!selectedPurchaseOptionId) return;
    if (!selected?.purchaseOptions.some((option) => option.id === selectedPurchaseOptionId)) {
      setSelectedPurchaseOptionId(null);
    }
  }, [selected, selectedPurchaseOptionId]);

  const amountError = useMemo(() => {
    if (!selected || !isCustomTopup(selected.offer)) return null;
    if (!customAmount) return null;
    const amountParts = decimalParts(customAmount);
    const fractionDigits = currencyFractionDigits(selected.offer.currency);
    if (!amountParts || amountParts.scale > fractionDigits) {
      return t('billing.amount.formatError', { digits: fractionDigits });
    }
    const min = selected.offer.minAmount!;
    const max = selected.offer.maxAmount!;
    const minComparison = compareDecimal(customAmount, min);
    const maxComparison = compareDecimal(customAmount, max);
    if (
      minComparison === null ||
      minComparison < 0 ||
      maxComparison === null ||
      maxComparison > 0
    ) {
      return t('billing.amount.rangeError', {
        min: formatMoney(min, selected.offer.currency),
        max: formatMoney(max, selected.offer.currency),
      });
    }
    return null;
  }, [customAmount, selected, t]);

  const subscriptionPurchaseBlocked =
    currentSubscription !== null &&
    SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.includes(currentSubscription.status);
  const canCheckout =
    !checkout.recovering &&
    selected !== null &&
    selectedOption !== null &&
    !(
      selected.product.kind === 'SUBSCRIPTION' &&
      (loadingSubscription || subscriptionError || subscriptionPurchaseBlocked)
    ) &&
    (!isCustomTopup(selected.offer) || (customAmount.length > 0 && amountError === null));

  const planNameOf = useCallback(
    (productCode: string | null | undefined) => {
      if (!productCode) return null;
      return catalog?.products.find((product) => product.code === productCode)?.name ?? productCode;
    },
    [catalog],
  );

  const currentPlanName = useMemo(
    () => planNameOf(currentSubscription?.effectivePlan?.product.code),
    [planNameOf, currentSubscription],
  );

  const currentPlan = currentSubscription?.effectivePlan ?? null;
  const pendingPlanChange = currentSubscription?.pendingPlanChange ?? null;
  const planChangeable =
    currentSubscription?.status === 'ACTIVE' &&
    !currentSubscription.cancelAtPeriodEnd &&
    currentPlan?.offer.interval === 'MONTH';

  // UI candidates only. The quote is the authority on whether a target is
  // actually reachable; this filter just avoids offering obviously invalid
  // targets (other interval, same level, or another provider's offers).
  const planChangeCandidates = useMemo<PlanChangeCandidate[]>(() => {
    if (!planChangeable || !currentPlan) return [];
    const currentProvider = currentSubscription?.provider ?? null;
    return subscriptionOffers
      .filter(
        (entry) =>
          isCatalogOfferPurchasable(entry) &&
          entry.offer.interval === currentPlan.offer.interval &&
          entry.offer.code !== currentPlan.offer.code &&
          entry.product.level !== null &&
          entry.product.level !== currentPlan.product.level &&
          (currentProvider === null ||
            entry.purchaseOptions.some((option) => option.provider === currentProvider)),
      )
      .map(({ product, offer }) => ({
        product,
        offer,
        direction:
          (product.level ?? 0) > currentPlan.product.level
            ? ('UPGRADE' as const)
            : ('DOWNGRADE' as const),
      }));
  }, [subscriptionOffers, planChangeable, currentPlan, currentSubscription?.provider]);

  const openPurchaseDialog = (kind: PurchaseKind) => {
    resetSelection();
    if (kind === 'SUBSCRIPTION') {
      setSubscriptionDialogOpen(true);
    } else {
      setTopupDialogOpen(true);
    }
  };

  const selectOffer = (offerCode: string) => {
    if (selectedOfferCode === offerCode) return;
    const entry = offers.find(({ offer }) => offer.code === offerCode);
    if (!entry || !isCatalogOfferPurchasable(entry)) return;
    setSelectedOfferCode(offerCode);
    setSelectedPurchaseOptionId(null);
    setCustomAmount('');
  };

  const submit = () => {
    if (!selected || !selectedOption || !canCheckout) return;
    setSubscriptionDialogOpen(false);
    setTopupDialogOpen(false);
    if (selected.product.kind === 'CREDIT_TOPUP') {
      void checkout.startTopup({
        offerCode: selected.offer.code,
        ...(isCustomTopup(selected.offer) ? { amount: customAmount.trim() } : {}),
        purchaseOptionId: selectedOption.id,
      });
    } else {
      void checkout.startSubscription({
        offerCode: selected.offer.code,
        purchaseOptionId: selectedOption.id,
      });
    }
  };

  const closeSubscriptionDialog = () => {
    setSubscriptionDialogOpen(false);
    resetSelection();
  };
  const closeTopupDialog = () => {
    setTopupDialogOpen(false);
    resetSelection();
  };

  const openPlanChange = () => {
    // An open change is the server's fact; re-enter it instead of quoting anew.
    if (pendingPlanChange) {
      planChange.resumePending(pendingPlanChange);
    } else {
      setPlanChangeTargetOpen(true);
    }
  };

  const selectPlanChangeTarget = (candidate: PlanChangeCandidate) => {
    if (candidate.offer.interval === null) return;
    setPlanChangeTargetOpen(false);
    void planChange.startQuote(candidate.offer.code, {
      product: { code: candidate.product.code, level: candidate.product.level ?? 0 },
      offer: { code: candidate.offer.code, interval: candidate.offer.interval },
      terms: {
        amount: candidate.offer.amount ?? '0',
        currency: candidate.offer.currency,
        creditAmount: candidate.offer.creditAmount ?? '0',
      },
    });
  };

  const closePlanChangeStatus = () => {
    const phase = planChange.state.phase;
    planChange.close();
    // Leaving an open change mid-flow: re-sync the pending projection so the
    // banner reflects what is still open on the server.
    if (phase === 'QUOTE_READY' || phase === 'PENDING_PROVIDER' || phase === 'AWAITING_PAYMENT')
      void loadSubscription();
  };

  return (
    <>
      <div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="text-20 font-medium tracking-[-0.01em] text-[var(--settings-section-title)]">
              {t('billing.settings.title')}
            </h2>
            <p className="mt-1.5 max-w-[620px] text-13 leading-5 text-[var(--settings-section-desc)]">
              {t('billing.settings.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadBillingState()}
            disabled={loadingCatalog || loadingSubscription || loadingBalance}
            className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover-soft)] disabled:opacity-45"
          >
            {loadingCatalog || loadingSubscription || loadingBalance ? (
              <Spinner size={13} />
            ) : (
              <RefreshCcw size={13} />
            )}
            {t('billing.actions.refreshCatalog')}
          </button>
        </div>

        <div className="mt-8 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
          <BillingUsageSummary
            usage={creditUsage}
            balance={balance}
            issue={balanceError}
            loading={loadingBalance}
            detailsUnavailable={usageDetailsUnavailable}
          />
          <div className="border-t border-[var(--border-default)]">
            <BillingSummaryRow
              label={t('billing.settings.subscriptionCard.title')}
              title={
                currentPlanName ??
                (currentSubscription
                  ? t('billing.settings.subscriptionCard.unnamedPlan')
                  : t('billing.settings.subscriptionCard.emptyTitle'))
              }
              description={
                loadingSubscription
                  ? t('billing.settings.loading')
                  : subscriptionError
                    ? t('billing.settings.subscriptionCard.unavailable')
                    : currentSubscription
                      ? t(`billing.subscriptionStatus.${currentSubscription.status}`)
                      : t('billing.settings.subscriptionCard.empty')
              }
              loading={loadingSubscription}
              disabled={loadingSubscription || subscriptionError}
              actionLabel={
                planChangeable
                  ? t('billing.settings.subscriptionCard.changeAction')
                  : t('billing.settings.subscriptionCard.action')
              }
              onAction={() => {
                if (planChangeable) openPlanChange();
                else openPurchaseDialog('SUBSCRIPTION');
              }}
            />
            {pendingPlanChange && (
              <PendingPlanChangeBanner
                pending={pendingPlanChange}
                targetName={planNameOf(pendingPlanChange.targetPlan?.product.code)}
                onResume={() => planChange.resumePending(pendingPlanChange)}
                onUndo={() => void planChange.cancelChange(pendingPlanChange.planChangeId)}
              />
            )}
          </div>
          <div className="border-t border-[var(--border-default)]">
            <BillingSummaryRow
              label={t('billing.settings.topupCard.title')}
              title={t('billing.settings.topupCard.cardTitle')}
              description={t('billing.settings.topupCard.cardDescription')}
              actionLabel={t('billing.settings.topupCard.action')}
              onAction={() => openPurchaseDialog('CREDIT_TOPUP')}
            />
          </div>
        </div>

        {!checkout.recovering &&
          (checkout.recoverables.topups.length > 0 ||
            checkout.recoverables.subscription !== null) && (
            <div className="mt-5 rounded-xl border border-[var(--border-default)] px-5 py-4">
              <p className="text-sm font-medium">{t('billing.recovery.title')}</p>
              <p className="mt-1 text-12 text-[var(--text-secondary)]">
                {t('billing.recovery.description')}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {checkout.recoverables.topups.map((order) => (
                  <button
                    key={order.orderId}
                    type="button"
                    onClick={() => checkout.resumeTopup(order)}
                    className="rounded-full border border-[var(--border-default)] px-3 py-1.5 text-12 font-medium hover:bg-[var(--surface-hover-soft)]"
                  >
                    {t('billing.recovery.continueTopup', {
                      amount: formatMoney(order.amount, order.currency),
                    })}
                  </button>
                ))}
                {checkout.recoverables.subscription && (
                  <button
                    type="button"
                    onClick={() => checkout.resumeSubscription(checkout.recoverables.subscription!)}
                    className="rounded-full border border-[var(--border-default)] px-3 py-1.5 text-12 font-medium hover:bg-[var(--surface-hover-soft)]"
                  >
                    {t('billing.recovery.continueSubscription')}
                  </button>
                )}
              </div>
            </div>
          )}
      </div>

      <BillingOfferDialog
        open={subscriptionDialogOpen}
        kind="SUBSCRIPTION"
        offers={subscriptionOffers}
        loading={loadingCatalog}
        catalogError={catalogError}
        selected={selected?.product.kind === 'SUBSCRIPTION' ? selected : null}
        selectedPurchaseOptionId={selectedPurchaseOptionId}
        customAmount={customAmount}
        amountError={amountError}
        subscriptionPurchaseBlocked={subscriptionPurchaseBlocked}
        canCheckout={canCheckout}
        onClose={closeSubscriptionDialog}
        onRetry={() => void loadBillingState()}
        onSelectOffer={selectOffer}
        onSelectPurchaseOption={setSelectedPurchaseOptionId}
        onCustomAmountChange={setCustomAmount}
        onSubmit={submit}
      />

      <BillingOfferDialog
        open={topupDialogOpen}
        kind="CREDIT_TOPUP"
        offers={topupOffers}
        loading={loadingCatalog}
        catalogError={catalogError}
        selected={selected?.product.kind === 'CREDIT_TOPUP' ? selected : null}
        selectedPurchaseOptionId={selectedPurchaseOptionId}
        customAmount={customAmount}
        amountError={amountError}
        subscriptionPurchaseBlocked={false}
        canCheckout={canCheckout}
        onClose={closeTopupDialog}
        onRetry={() => void loadBillingState()}
        onSelectOffer={selectOffer}
        onSelectPurchaseOption={setSelectedPurchaseOptionId}
        onCustomAmountChange={setCustomAmount}
        onSubmit={submit}
      />

      <BillingCheckoutDialog
        state={checkout.state}
        onClose={checkout.close}
        onRefresh={() => void checkout.refreshActive()}
        onRetry={() => void checkout.retry()}
        onCancel={() => void checkout.cancel()}
      />

      <PlanChangeTargetDialog
        open={planChangeTargetOpen}
        candidates={planChangeCandidates}
        currentPlanName={currentPlanName}
        onClose={() => setPlanChangeTargetOpen(false)}
        onSelect={selectPlanChangeTarget}
      />

      <PlanChangeStatusDialog
        state={planChange.state}
        targetName={planNameOf(planChange.state.targetPlan?.product.code)}
        onClose={closePlanChangeStatus}
        onConfirm={() => void planChange.confirm()}
        onRefresh={() => void planChange.refresh()}
        onAbandon={() => {
          const change = planChange.state.planChange;
          if (change) void planChange.cancelChange(change.planChangeId);
        }}
      />
    </>
  );
}

function PendingPlanChangeBanner({
  pending,
  targetName,
  onResume,
  onUndo,
}: {
  pending: BillingPendingPlanChange;
  targetName: string | null;
  onResume: () => void;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  const effectiveDate = useMemo(() => {
    const timestamp = Date.parse(pending.effectiveAt);
    if (!Number.isFinite(timestamp)) return pending.effectiveAt;
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp);
    } catch {
      return pending.effectiveAt;
    }
  }, [pending.effectiveAt]);
  const label =
    pending.status === 'SCHEDULED'
      ? t('billing.planChange.pendingDowngrade', {
          name: targetName ?? t('billing.settings.subscriptionCard.unnamedPlan'),
          date: effectiveDate,
        })
      : pending.status === 'AWAITING_PAYMENT'
        ? t('billing.planChange.pendingPayment', {
            name: targetName ?? t('billing.settings.subscriptionCard.unnamedPlan'),
          })
        : t('billing.planChange.pendingQuote', {
            name: targetName ?? t('billing.settings.subscriptionCard.unnamedPlan'),
          });
  return (
    <div className="flex items-center gap-4 border-t border-[var(--border-default)] bg-[var(--surface-chip)] px-5 py-3">
      <p className="min-w-0 flex-1 text-12 leading-5 text-[var(--text-secondary)]">{label}</p>
      {pending.status === 'SCHEDULED' ? (
        <button
          type="button"
          onClick={onUndo}
          className="h-8 shrink-0 rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
        >
          {t('billing.planChange.undo')}
        </button>
      ) : (
        <button
          type="button"
          onClick={onResume}
          className="h-8 shrink-0 rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
        >
          {t('billing.planChange.resume')}
        </button>
      )}
    </div>
  );
}

function BillingUsageSummary({
  usage,
  balance,
  issue,
  loading,
  detailsUnavailable,
}: {
  usage: ModelAccessCreditUsage | null;
  balance: ModelAccessBalance | null;
  issue: BalanceIssue;
  loading: boolean;
  detailsUnavailable: boolean;
}) {
  const { t } = useTranslation();
  const currency = CURRENT_CINDY_REGION === 'global' ? 'usd' : 'cny';
  const legacyPools = balance
    ? [
        { key: 'plan', label: t('billing.balance.plan'), amount: balance.planCredits },
        {
          key: 'purchased',
          label: t('billing.balance.purchased'),
          amount: balance.purchasedCredits,
        },
        {
          key: 'promotional',
          label: t('billing.balance.promotional'),
          amount: balance.promotionalCredits,
        },
      ]
    : [];
  const usagePools = usage
    ? [
        { key: 'plan', label: t('billing.balance.plan'), pool: usage.plan },
        { key: 'purchased', label: t('billing.balance.purchased'), pool: usage.purchased },
        { key: 'promotional', label: t('billing.balance.promotional'), pool: usage.promotional },
      ]
    : [];
  const issueDescription =
    issue === 'NOT_PROVISIONED'
      ? t('billing.balance.notProvisioned')
      : issue === 'NOT_SUPPORTED'
        ? t('billing.balance.notSupported')
        : t('billing.balance.unavailable');

  return (
    <section
      className="px-5 py-5"
      aria-labelledby="billing-balance-title"
      aria-live="polite"
      aria-busy={loading}
    >
      {loading ? (
        <div className="flex h-[118px] items-center px-5">
          <Spinner size={15} />
        </div>
      ) : usage ? (
        <>
          <div className="px-5 py-5">
            <p
              id="billing-balance-title"
              className="text-11 font-medium text-[var(--text-tertiary)]"
            >
              {t('billing.balance.title')}
            </p>
            <p className="mt-1 text-[28px] font-medium leading-9 tracking-[-0.03em] tabular-nums text-[var(--text-primary)]">
              {formatMoney(usage.available, currency)}
            </p>
            <p className="mt-1 text-11 text-[var(--text-tertiary)]">
              {t('billing.usage.observedAt', {
                date: formatLedgerTimestamp(usage.observedAt),
              })}
            </p>
          </div>
          <div className="border-t border-[var(--border-default)] px-5 py-5">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              {usagePools.map(({ key, label, pool }) => (
                <CreditPoolCard key={key} label={label} pool={pool} currency={currency} />
              ))}
            </div>
          </div>
          <PromotionalGrantLedger usage={usage} currency={currency} />
        </>
      ) : balance ? (
        <div className="px-5 py-5">
          <p id="billing-balance-title" className="text-11 font-medium text-[var(--text-tertiary)]">
            {t('billing.balance.title')}
          </p>
          <p className="mt-1 text-[28px] font-medium leading-9 tracking-[-0.03em] tabular-nums text-[var(--text-primary)]">
            {formatMoney(balance.available, currency)}
          </p>
          <div className="mt-4 grid grid-cols-3 divide-x divide-[var(--border-default)] rounded-xl bg-[var(--surface-chip)] px-1 py-2.5">
            {legacyPools.map(({ key, label, amount }) => (
              <div key={key} className="min-w-0 px-3">
                <p className="truncate text-11 text-[var(--text-tertiary)]">{label}</p>
                <p className="mt-1 truncate text-13 font-medium tabular-nums text-[var(--text-primary)]">
                  {formatMoney(amount, currency)}
                </p>
              </div>
            ))}
          </div>
          {detailsUnavailable && (
            <p className="mt-3 text-11 leading-4 text-[var(--text-secondary)]">
              {t('billing.usage.detailsUnavailable')}
            </p>
          )}
        </div>
      ) : (
        <div
          role="status"
          className="flex min-h-[118px] items-center px-5 text-12 leading-5 text-[var(--text-secondary)]"
        >
          {issueDescription}
        </div>
      )}
    </section>
  );
}

function CreditPoolCard({
  label,
  pool,
  currency,
}: {
  label: string;
  pool: ModelAccessCreditPoolUsage;
  currency: string;
}) {
  const { t } = useTranslation();
  const percent = usagePercent(pool);
  const stats = [
    { key: 'used', label: t('billing.usage.used'), amount: pool.used },
    { key: 'total', label: t('billing.usage.total'), amount: pool.total },
    { key: 'remaining', label: t('billing.usage.remaining'), amount: pool.remaining },
  ];
  return (
    <article className="min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-4">
      <p className="truncate text-12 font-medium text-[var(--text-primary)]">{label}</p>
      <p className="mt-3 text-11 text-[var(--text-tertiary)]">{t('billing.usage.remaining')}</p>
      <p className="mt-0.5 truncate text-lg font-medium tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">
        {formatMoney(pool.remaining, currency)}
      </p>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-chip)]"
        role={percent === null ? undefined : 'progressbar'}
        aria-label={t('billing.usage.progressLabel', { label })}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        {percent !== null && (
          <div
            className="h-full rounded-full bg-[var(--text-primary)]"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      {percent === null ? (
        <p className="mt-2 min-h-8 text-10 leading-4 text-[var(--text-tertiary)]">
          {t('billing.usage.historyUnavailable')}
        </p>
      ) : (
        <p className="mt-2 min-h-8 text-10 leading-4 text-[var(--text-tertiary)]">
          {t('billing.usage.percentUsed', {
            percent: new Intl.NumberFormat(undefined, {
              maximumFractionDigits: 1,
            }).format(percent),
          })}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--border-default)] pt-3">
        {stats.map(({ key, label: statLabel, amount }) => (
          <div key={key} className="min-w-0">
            <dt className="truncate text-10 text-[var(--text-tertiary)]">{statLabel}</dt>
            <dd className="mt-0.5 truncate text-11 font-medium tabular-nums text-[var(--text-primary)]">
              {amount === null ? '—' : formatMoney(amount, currency)}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function PromotionalGrantLedger({
  usage,
  currency,
}: {
  usage: ModelAccessCreditUsage;
  currency: string;
}) {
  const { t } = useTranslation();
  const hasUnavailableHistoricalUsage = usage.promotionalGrants.some(
    (grant) => grant.usedAmount === null,
  );
  return (
    <div className="border-t border-[var(--border-default)] px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-13 font-medium text-[var(--text-primary)]">
            {t('billing.usage.promotionalDetails.title')}
          </h3>
          <p className="mt-1 max-w-[620px] text-11 leading-4 text-[var(--text-secondary)]">
            {t('billing.usage.promotionalDetails.description')}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-10 font-medium text-[var(--text-secondary)]">
          {t('billing.usage.promotionalDetails.count', {
            count: usage.promotionalGrants.length,
          })}
        </span>
      </div>

      {!usage.promotionalGrantsComplete && (
        <p className="mt-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-4 text-[var(--text-secondary)]">
          {t('billing.usage.promotionalDetails.incomplete', {
            count: usage.promotionalGrants.length,
          })}
        </p>
      )}
      {hasUnavailableHistoricalUsage && (
        <p className="mt-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-4 text-[var(--text-secondary)]">
          {t('billing.usage.promotionalDetails.historicalUsageUnavailable')}
        </p>
      )}

      {usage.promotionalGrants.length === 0 ? (
        <p className="mt-4 rounded-xl border border-[var(--border-default)] px-4 py-5 text-12 text-[var(--text-secondary)]">
          {t('billing.usage.promotionalDetails.empty')}
        </p>
      ) : (
        <div
          className="mt-4 max-h-[360px] overflow-y-auto rounded-xl border border-[var(--border-default)] [scrollbar-gutter:stable]"
          role="list"
        >
          {usage.promotionalGrants.map((grant, index) => (
            <div
              key={grant.grantId}
              role="listitem"
              className={cn(
                'grid grid-cols-3 gap-x-3 gap-y-2 px-4 py-3 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(80px,0.7fr))] lg:items-center',
                index > 0 && 'border-t border-[var(--border-default)]',
              )}
            >
              <div className="col-span-3 min-w-0 lg:col-span-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-12 font-medium text-[var(--text-primary)]">
                    {grant.displayName ?? t('billing.usage.promotionalDetails.unnamed')}
                  </p>
                  <PromotionalGrantStatus state={grant.state} />
                </div>
                <p className="mt-1 truncate text-10 text-[var(--text-tertiary)]">
                  {t('billing.usage.promotionalDetails.expiresAt', {
                    date: formatLedgerTimestamp(grant.expiresAt),
                  })}
                </p>
              </div>
              <GrantAmount
                label={t('billing.usage.promotionalDetails.original')}
                amount={grant.originalAmount}
                currency={currency}
              />
              <GrantAmount
                label={t('billing.usage.promotionalDetails.used')}
                amount={grant.usedAmount}
                currency={currency}
              />
              <GrantAmount
                label={t('billing.usage.promotionalDetails.remaining')}
                amount={grant.remainingAmount}
                currency={currency}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PromotionalGrantStatus({ state }: { state: ModelAccessPromotionalGrantState }) {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 text-[var(--text-secondary)]">
      {t(`billing.usage.promotionalDetails.states.${state}`)}
    </span>
  );
}

function GrantAmount({
  label,
  amount,
  currency,
}: {
  label: string;
  amount: string | null;
  currency: string;
}) {
  return (
    <div className="min-w-0 text-right">
      <p className="truncate text-10 text-[var(--text-tertiary)]">{label}</p>
      <p className="mt-0.5 truncate text-11 font-medium tabular-nums text-[var(--text-primary)]">
        {amount === null ? '—' : formatMoney(amount, currency)}
      </p>
    </div>
  );
}

function BillingSummaryRow({
  label,
  title,
  description,
  loading = false,
  disabled = false,
  actionLabel,
  onAction,
}: {
  label: string;
  title: string;
  description: string;
  loading?: boolean;
  disabled?: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-[112px] items-center gap-6 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-11 font-medium text-[var(--text-tertiary)]">{label}</p>
        <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{title}</p>
        <div className="mt-1 min-h-5 text-12 leading-5 text-[var(--text-secondary)]">
          {loading ? <Spinner size={13} /> : description}
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className="h-8 shrink-0 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function BillingOfferDialog({
  open,
  kind,
  offers,
  loading,
  catalogError,
  selected,
  selectedPurchaseOptionId,
  customAmount,
  amountError,
  subscriptionPurchaseBlocked,
  canCheckout,
  onClose,
  onRetry,
  onSelectOffer,
  onSelectPurchaseOption,
  onCustomAmountChange,
  onSubmit,
}: {
  open: boolean;
  kind: PurchaseKind;
  offers: CatalogOfferEntry[];
  loading: boolean;
  catalogError: boolean;
  selected: CatalogOfferEntry | null;
  selectedPurchaseOptionId: string | null;
  customAmount: string;
  amountError: string | null;
  subscriptionPurchaseBlocked: boolean;
  canCheckout: boolean;
  onClose: () => void;
  onRetry: () => void;
  onSelectOffer: (offerCode: string) => void;
  onSelectPurchaseOption: (optionId: string) => void;
  onCustomAmountChange: (amount: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const title =
    kind === 'SUBSCRIPTION'
      ? t('billing.dialogs.subscription.title')
      : t('billing.dialogs.topup.title');
  const description =
    kind === 'SUBSCRIPTION'
      ? t('billing.dialogs.subscription.description')
      : t('billing.dialogs.topup.description');

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9990] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[9991] flex max-h-[min(720px,calc(100vh-48px))]',
            'w-[calc(100vw-48px)] max-w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-xl border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:outline-none',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
            <div>
              <Dialog.Title className="text-16 font-medium tracking-[-0.01em]">
                {title}
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 max-w-[520px] text-12 leading-5 text-[var(--text-secondary)]">
                {description}
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
            {loading ? (
              <CatalogSkeleton />
            ) : catalogError ? (
              <StateCard
                icon={<RefreshCcw size={22} />}
                title={t('billing.catalog.errorTitle')}
                description={t('billing.catalog.errorDescription')}
                action={
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-4 h-9 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium hover:bg-[var(--surface-hover-soft)]"
                  >
                    {t('billing.actions.retry')}
                  </button>
                }
              />
            ) : offers.length === 0 ? (
              <StateCard
                icon={<PackageOpen size={22} />}
                title={t('billing.catalog.emptyTitle')}
                description={t('billing.catalog.emptyDescription')}
              />
            ) : (
              <>
                <div className="space-y-2.5">
                  {offers.map((entry) => {
                    const { product, offer } = entry;
                    const active = selected?.offer.code === offer.code;
                    const unavailableReason = catalogOfferUnavailableReason(entry);
                    return (
                      <button
                        key={offer.code}
                        type="button"
                        onClick={() => onSelectOffer(offer.code)}
                        disabled={unavailableReason !== null}
                        aria-pressed={active}
                        className={cn(
                          'group relative flex min-h-[88px] w-full items-center gap-5 rounded-xl border px-4 py-3.5 text-left',
                          'transition-[background-color,border-color,box-shadow] focus-visible:outline-none',
                          'focus-visible:ring-2 focus-visible:ring-[var(--text-primary)] focus-visible:ring-offset-2',
                          'focus-visible:ring-offset-[var(--surface-elevated)]',
                          'disabled:cursor-not-allowed disabled:bg-[var(--surface)] disabled:hover:bg-[var(--surface)]',
                          active
                            ? 'border-[var(--text-primary)] bg-[var(--surface)] shadow-[inset_3px_0_0_var(--text-primary)]'
                            : 'border-[var(--border-default)] hover:bg-[var(--surface-hover-soft)]',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                            {product.name}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="text-11 text-[var(--text-tertiary)]">
                              {kind === 'SUBSCRIPTION'
                                ? t('billing.offerKinds.subscription')
                                : t('billing.offerKinds.topup')}
                            </span>
                            {unavailableReason && (
                              <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                {t(`billing.catalog.unavailableReasons.${unavailableReason}`)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-4">
                          <div className="text-right">
                            <p className="text-lg font-medium tracking-[-0.02em]">
                              {offer.amount
                                ? formatMoney(offer.amount, offer.currency)
                                : t('billing.amount.custom')}
                              {offer.interval && (
                                <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
                                  / {t(`billing.intervals.${offer.interval}`)}
                                </span>
                              )}
                            </p>
                            {offer.creditAmount && (
                              <p className="mt-1 text-11 text-[var(--text-secondary)]">
                                {t('billing.credits', { amount: offer.creditAmount })}
                              </p>
                            )}
                          </div>
                          {unavailableReason === null && <SelectionMark active={active} />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {selected && (
                  <div className="mt-5 border-t border-[var(--border-default)] pt-4">
                    <h3 className="text-13 font-medium">{t('billing.steps.channel.title')}</h3>
                    <p className="mt-1 text-12 text-[var(--text-secondary)]">
                      {t('billing.steps.channel.description')}
                    </p>
                    <div className="mt-3 space-y-2">
                      {selected.purchaseOptions.map((option) => (
                        <PaymentOptionCard
                          key={option.id}
                          option={option}
                          active={selectedPurchaseOptionId === option.id}
                          onSelect={() => onSelectPurchaseOption(option.id)}
                        />
                      ))}
                    </div>

                    {kind === 'CREDIT_TOPUP' && isCustomTopup(selected.offer) && (
                      <label className="mt-5 block">
                        <span className="text-12 font-medium text-[var(--text-secondary)]">
                          {t('billing.amount.label')}
                        </span>
                        <div className="mt-2 flex h-11 items-center rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-4 focus-within:border-[var(--text-primary)]">
                          <span className="mr-2 text-sm text-[var(--text-tertiary)]">
                            {selected.offer.currency.toUpperCase()}
                          </span>
                          <input
                            value={customAmount}
                            onChange={(event) => onCustomAmountChange(event.target.value)}
                            inputMode="decimal"
                            placeholder={t('billing.amount.placeholder')}
                            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-tertiary)]"
                          />
                        </div>
                        <p
                          className={cn(
                            'mt-2 text-11',
                            amountError
                              ? 'text-[var(--text-primary)]'
                              : 'text-[var(--text-tertiary)]',
                          )}
                        >
                          {amountError ??
                            t('billing.amount.rangeHint', {
                              min: formatMoney(selected.offer.minAmount!, selected.offer.currency),
                              max: formatMoney(selected.offer.maxAmount!, selected.offer.currency),
                            })}
                        </p>
                      </label>
                    )}

                    {kind === 'SUBSCRIPTION' && subscriptionPurchaseBlocked && (
                      <p className="mt-5 rounded-lg bg-[var(--surface-chip)] px-4 py-3 text-12 leading-5 text-[var(--text-secondary)]">
                        {t('billing.currentSubscription.purchaseBlocked')}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex min-h-16 items-center justify-between gap-4 border-t border-[var(--border-default)] px-6 py-3">
            <div className="flex min-w-0 max-w-[380px] items-start gap-2 text-11 leading-4 text-[var(--text-tertiary)]">
              <ShieldCheck size={13} className="shrink-0" />
              <span>{t('billing.securityNotice')}</span>
            </div>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canCheckout}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--text-primary)] px-5 text-13 font-medium text-[var(--surface)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              {t('billing.actions.pay')}
              <ArrowRight size={15} />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CatalogSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden>
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="h-[88px] animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function StateCard({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[184px] flex-col items-center justify-center rounded-xl border border-[var(--border-default)] px-6 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-[var(--surface-chip)]">
        {icon}
      </div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      <p className="mt-1 text-12 text-[var(--text-secondary)]">{description}</p>
      {action}
    </div>
  );
}

function PaymentOptionCard({
  option,
  active,
  onSelect,
}: {
  option: SupportedPurchaseOption;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const Icon = option.paymentAction === 'QR_CODE' ? CircleDollarSign : CreditCard;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex min-h-[64px] w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left',
        'transition-colors focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-[var(--text-primary)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--surface-elevated)]',
        active
          ? 'border-[var(--text-primary)] bg-[var(--surface)]'
          : 'border-[var(--border-default)] hover:bg-[var(--surface-hover-soft)]',
      )}
    >
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--surface-chip)]">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{providerLabel(option.provider, t)}</p>
        <p className="mt-1 text-11 text-[var(--text-tertiary)]">
          {option.paymentAction === 'QR_CODE'
            ? t('billing.paymentActions.QR_CODE')
            : t('billing.paymentActions.REDIRECT')}
        </p>
      </div>
      <SelectionMark active={active} />
    </button>
  );
}

function SelectionMark({ active }: { active: boolean }) {
  return (
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
  );
}

function providerLabel(
  provider: SupportedBillingProvider,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return t(`billing.providers.${provider}`);
}
