import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  CreditCard,
  PackageOpen,
  RefreshCcw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
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
import { AlipayIcon } from './AlipayIcon';
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
type CurrentPlanFacts = {
  name: string;
  status: BillingSubscription['status'];
  price: string | null;
  interval: BillingCatalogOffer['interval'];
  includedCredits: string | null;
  periodEndAt: string | null;
  cancelAtPeriodEnd: boolean;
};

const SUPPORTED_BILLING_PROVIDERS = new Set<SupportedBillingProvider>(['alipay', 'stripe']);
const SUPPORTED_PAYMENT_ACTIONS = new Set<BillingPurchaseOption['paymentAction']>([
  'QR_CODE',
  'REDIRECT',
]);
const SUPPORTED_SUBSCRIPTION_CAPABILITIES = new Set<BillingPurchaseOption['capability']>([
  'MERCHANT_INITIATED_MANDATE',
  'PROVIDER_MANAGED_SUBSCRIPTION',
]);

// 新服务端的“当前订阅”只包含真实生命周期状态，未完成首购不再下发也不阻断重选；
// INCOMPLETE 仅作为旧服务端兼容防御保留（旧服务端仍会拒绝重复首购）。
const SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES: BillingSubscription['status'][] = [
  'INCOMPLETE',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'PAUSED',
];
const SUBSCRIPTION_CANCELLABLE_STATUSES: BillingSubscription['status'][] =
  SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.filter((status) => status !== 'INCOMPLETE');

const PLAN_CHANGE_ENTRY_STATUSES: BillingSubscription['status'][] = ['ACTIVE'];

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

function formatLedgerTimestamp(value: string, locale: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(timestamp);
  } catch {
    return value;
  }
}

function formatBillingDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(timestamp);
  } catch {
    return null;
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
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [currentSubscription, setCurrentSubscription] = useState<BillingSubscription | null>(null);
  const [loadingSubscription, setLoadingSubscription] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState(false);
  const [cancelingSubscription, setCancelingSubscription] = useState(false);
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
  const cancelSubscriptionLockRef = useRef(false);
  // 取消订阅的 DELETE 不带 subscriptionId,服务端按「请求时已认证的账号」执行。
  // ConfirmDialogProvider 挂在 AuthProvider 之外(见 App.tsx),弹窗会活过本 section
  // 因 dataOwnerId 变化而发生的卸载,所以必须记住确认时的账号与挂载态。
  const accountIdRef = useRef(accountId);
  const sectionMountedRef = useRef(true);

  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  useEffect(() => {
    sectionMountedRef.current = true;
    return () => {
      sectionMountedRef.current = false;
    };
  }, []);

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

  const closeCheckout = useCallback(() => {
    const abandonedIncomplete = checkout.state.subscription?.status === 'INCOMPLETE';
    checkout.close();
    if (abandonedIncomplete) {
      setCurrentSubscription(null);
      void loadSubscription();
    }
  }, [checkout, loadSubscription]);

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
      .filter(isCatalogOfferVisible);
  }, [catalog]);

  const subscriptionOffers = useMemo(
    () => offers.filter(({ product }) => product.kind === 'SUBSCRIPTION'),
    [offers],
  );
  const topupOffers = useMemo(
    () => offers.filter(({ product }) => product.kind === 'CREDIT_TOPUP'),
    [offers],
  );

  const subscriptionPurchaseBlocked =
    currentSubscription !== null &&
    SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.includes(currentSubscription.status);
  const currentSubscriptionOfferCode = subscriptionPurchaseBlocked
    ? (currentSubscription.effectivePlan?.offer.code ?? null)
    : null;
  const selected = useMemo(
    () =>
      offers.find(
        (entry) =>
          entry.offer.code === selectedOfferCode &&
          isCatalogOfferPurchasable(entry) &&
          !(
            entry.product.kind === 'SUBSCRIPTION' &&
            entry.offer.code === currentSubscriptionOfferCode
          ),
      ) ?? null,
    [currentSubscriptionOfferCode, offers, selectedOfferCode],
  );
  const selectedOption = useMemo(
    () =>
      selected?.purchaseOptions.find((option) => option.id === selectedPurchaseOptionId) ?? null,
    [selected, selectedPurchaseOptionId],
  );

  useEffect(() => {
    if (!selectedOfferCode) return;
    const selectedEntry = offers.find(({ offer }) => offer.code === selectedOfferCode);
    if (
      !selectedEntry ||
      !isCatalogOfferPurchasable(selectedEntry) ||
      (selectedEntry.product.kind === 'SUBSCRIPTION' &&
        selectedEntry.offer.code === currentSubscriptionOfferCode)
    ) {
      resetSelection();
    }
  }, [currentSubscriptionOfferCode, offers, resetSelection, selectedOfferCode]);

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
        min: formatMoney(min, selected.offer.currency, billingLocale),
        max: formatMoney(max, selected.offer.currency, billingLocale),
      });
    }
    return null;
  }, [billingLocale, customAmount, selected, t]);

  const canCheckout =
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

  const currentPlan = currentSubscription?.effectivePlan ?? null;
  const pendingPlanChange = currentSubscription?.pendingPlanChange ?? null;
  const currentProvider =
    currentSubscription?.provider &&
    SUPPORTED_BILLING_PROVIDERS.has(currentSubscription.provider as SupportedBillingProvider)
      ? (currentSubscription.provider as SupportedBillingProvider)
      : null;
  const showPlanChangeEntry =
    currentPlan !== null &&
    currentSubscription !== null &&
    PLAN_CHANGE_ENTRY_STATUSES.includes(currentSubscription.status) &&
    !currentSubscription.cancelAtPeriodEnd &&
    currentPlan.offer.interval === 'MONTH';
  const currentPlanFacts = useMemo(() => {
    if (!currentSubscription) return null;
    const plan = currentSubscription.effectivePlan;
    return {
      name: planNameOf(plan?.product.code) ?? t('billing.settings.subscriptionCard.unnamedPlan'),
      status: currentSubscription.status,
      price: plan ? formatMoney(plan.terms.amount, plan.terms.currency, billingLocale) : null,
      interval: plan?.offer.interval ?? null,
      includedCredits: plan?.terms.creditAmount ?? null,
      periodEndAt: formatBillingDate(currentSubscription.currentPeriodEndAt, billingLocale),
      cancelAtPeriodEnd: currentSubscription.cancelAtPeriodEnd,
    };
  }, [billingLocale, currentSubscription, planNameOf, t]);

  const cancelCurrentSubscription = useCallback(async () => {
    if (
      cancelSubscriptionLockRef.current ||
      !currentSubscription ||
      currentSubscription.cancelAtPeriodEnd ||
      !SUBSCRIPTION_CANCELLABLE_STATUSES.includes(currentSubscription.status)
    ) {
      return;
    }
    cancelSubscriptionLockRef.current = true;
    try {
      const confirmingAccountId = accountIdRef.current;
      const periodEndAt = currentPlanFacts?.periodEndAt ?? null;
      const confirmed = await confirm({
        title: t('billing.settings.subscriptionCard.cancelConfirmTitle'),
        description: periodEndAt
          ? t('billing.settings.subscriptionCard.cancelConfirmDescription', {
              date: periodEndAt,
            })
          : t('billing.settings.subscriptionCard.cancelConfirmDescriptionWithoutDate'),
        confirmText: t('billing.settings.subscriptionCard.cancelConfirmAction'),
        cancelText: t('commonUi.confirmDialog.cancel'),
      });
      if (!confirmed) return;
      // 确认期间账号被换掉(或本 section 已卸载)就放弃:再发请求会取消到另一个账号
      // 的订阅,而取消不可撤销。
      if (!sectionMountedRef.current || accountIdRef.current !== confirmingAccountId) return;

      setCancelingSubscription(true);
      try {
        const canceled = await billingApi.cancelCurrentSubscription();
        setCurrentSubscription(canceled);
        setSubscriptionError(false);
        const canceledPeriodEndAt = formatBillingDate(canceled.currentPeriodEndAt, billingLocale);
        toast.success(
          canceledPeriodEndAt
            ? t('billing.settings.subscriptionCard.cancelSuccess', { date: canceledPeriodEndAt })
            : t('billing.settings.subscriptionCard.cancelSuccessWithoutDate'),
        );
      } catch (error) {
        const ipcError = extractIpcError(error);
        toast.error(
          ipcError?.code === 'PRECONDITION_FAILED'
            ? t('billing.settings.subscriptionCard.cancelNotSupported')
            : t('billing.settings.subscriptionCard.cancelFailed'),
        );
      } finally {
        setCancelingSubscription(false);
      }
    } finally {
      cancelSubscriptionLockRef.current = false;
    }
  }, [billingLocale, confirm, currentPlanFacts?.periodEndAt, currentSubscription, t]);

  // The server quote remains authoritative for business reachability. Until
  // that contract supports cross-interval/provider changes, keep those two
  // client-side compatibility gates so the dialog cannot offer known-invalid
  // targets.
  const planChangeCandidates = useMemo<PlanChangeCandidate[]>(() => {
    if (!showPlanChangeEntry || !currentPlan || !currentProvider) return [];
    const directionRank: Record<Exclude<PlanChangeCandidate['direction'], null>, number> = {
      UPGRADE: 0,
      SAME_LEVEL: 1,
      DOWNGRADE: 2,
    };
    return subscriptionOffers
      .filter(
        (entry) =>
          isCatalogOfferPurchasable(entry) &&
          entry.offer.interval === currentPlan.offer.interval &&
          entry.offer.code !== currentPlan.offer.code &&
          entry.purchaseOptions.some((option) => option.provider === currentProvider),
      )
      .map(({ product, offer }) => ({
        product,
        offer,
        providers: [currentProvider],
        direction:
          product.level === null
            ? null
            : product.level > currentPlan.product.level
              ? ('UPGRADE' as const)
              : product.level < currentPlan.product.level
                ? ('DOWNGRADE' as const)
                : ('SAME_LEVEL' as const),
      }))
      .sort(
        (left, right) =>
          (left.direction === null ? 3 : directionRank[left.direction]) -
            (right.direction === null ? 3 : directionRank[right.direction]) ||
          left.product.sortOrder - right.product.sortOrder ||
          left.offer.code.localeCompare(right.offer.code),
      );
  }, [subscriptionOffers, showPlanChangeEntry, currentPlan, currentProvider]);

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
    if (
      !entry ||
      !isCatalogOfferPurchasable(entry) ||
      (entry.product.kind === 'SUBSCRIPTION' && entry.offer.code === currentSubscriptionOfferCode)
    ) {
      return;
    }
    setSelectedOfferCode(offerCode);
    // 只有一种支付方式时默认选中,免去一次多余点击。
    setSelectedPurchaseOptionId(
      entry.purchaseOptions.length === 1 ? entry.purchaseOptions[0].id : null,
    );
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
    // 服务端在新报价时自动撤销旧未完成变更；这里总是重新选择目标。
    setPlanChangeTargetOpen(true);
  };

  const selectPlanChangeTarget = (candidate: PlanChangeCandidate) => {
    if (candidate.offer.interval === null) return;
    setPlanChangeTargetOpen(false);
    void planChange.startQuote(candidate.offer.code, {
      product: { code: candidate.product.code, level: candidate.product.level },
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

  const reselectPlanChangeTarget = () => {
    planChange.close();
    setPlanChangeTargetOpen(true);
  };

  return (
    <>
      <div>
        <div className="flex items-start justify-between gap-6">
          <h2 className="text-20 font-medium tracking-[-0.01em] text-[var(--settings-section-title)]">
            {t('billing.settings.title')}
          </h2>
          <button
            type="button"
            onClick={() => void loadBillingState()}
            disabled={
              loadingCatalog || loadingSubscription || loadingBalance || cancelingSubscription
            }
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

        <div className="mt-6 flex flex-col gap-8">
          <BillingGroup title={t('billing.settings.subscriptionCard.title')}>
            <SubscriptionOverviewCard
              facts={currentPlanFacts}
              loading={loadingSubscription}
              error={subscriptionError}
              showPlanChangeEntry={showPlanChangeEntry}
              canceling={cancelingSubscription}
              actionDisabled={loadingSubscription || subscriptionError || cancelingSubscription}
              pendingPlanChange={pendingPlanChange}
              pendingTargetName={planNameOf(pendingPlanChange?.targetPlan?.product.code)}
              onCancelSubscription={() => void cancelCurrentSubscription()}
              onChangePlan={openPlanChange}
              onPurchase={() => openPurchaseDialog('SUBSCRIPTION')}
              onCancelPending={() => {
                if (pendingPlanChange) void planChange.cancelChange(pendingPlanChange.planChangeId);
              }}
            />
          </BillingGroup>

          <BillingGroup titleId="billing-balance-title" title={t('billing.balance.title')}>
            <BalanceOverviewCard
              usage={creditUsage}
              balance={balance}
              issue={balanceError}
              loading={loadingBalance}
              onPurchase={() => openPurchaseDialog('CREDIT_TOPUP')}
            />
          </BillingGroup>

          {(creditUsage || balance) && (
            <BillingGroup
              title={t('billing.usage.title')}
              description={
                usageDetailsUnavailable ? t('billing.usage.detailsUnavailable') : undefined
              }
            >
              <UsageBreakdownCard usage={creditUsage} balance={balance} />
            </BillingGroup>
          )}

          {creditUsage && (
            <BillingGroup
              title={t('billing.usage.promotionalDetails.title')}
              badge={
                <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-10 font-medium text-[var(--text-secondary)]">
                  {t('billing.usage.promotionalDetails.count', {
                    count: creditUsage.promotionalGrants.length,
                  })}
                </span>
              }
            >
              <PromotionalGrantsCard usage={creditUsage} />
            </BillingGroup>
          )}
        </div>

        <p className="mt-8 text-12 leading-5 text-[var(--text-tertiary)]">
          {t(
            BILLING_CURRENCY === 'usd'
              ? 'billing.balance.creditParityUsd'
              : 'billing.balance.creditParityCny',
          )}
        </p>
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
        currentSubscriptionOfferCode={currentSubscriptionOfferCode}
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
        currentSubscriptionOfferCode={null}
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
        onClose={closeCheckout}
        onRefresh={() => void checkout.refreshActive()}
        onRetry={() => void checkout.retry()}
      />

      <PlanChangeTargetDialog
        open={planChangeTargetOpen}
        candidates={planChangeCandidates}
        onClose={() => setPlanChangeTargetOpen(false)}
        onSelect={selectPlanChangeTarget}
      />

      <PlanChangeStatusDialog
        state={planChange.state}
        targetName={planNameOf(planChange.state.targetPlan?.product.code)}
        onClose={closePlanChangeStatus}
        onConfirm={() => void planChange.confirm()}
        onRefresh={() => void planChange.refresh()}
        onReselect={reselectPlanChangeTarget}
        onAbandon={() => {
          const change = planChange.state.planChange;
          if (change) void planChange.cancelChange(change.planChangeId);
        }}
      />
    </>
  );
}

function SubscriptionOverviewCard({
  facts,
  loading,
  error,
  showPlanChangeEntry,
  canceling,
  actionDisabled,
  pendingPlanChange,
  pendingTargetName,
  onCancelSubscription,
  onChangePlan,
  onPurchase,
  onCancelPending,
}: {
  facts: CurrentPlanFacts | null;
  loading: boolean;
  error: boolean;
  showPlanChangeEntry: boolean;
  canceling: boolean;
  actionDisabled: boolean;
  pendingPlanChange: BillingPendingPlanChange | null;
  pendingTargetName: string | null;
  onCancelSubscription: () => void;
  onChangePlan: () => void;
  onPurchase: () => void;
  onCancelPending: () => void;
}) {
  const { t } = useTranslation();
  const showPeriodDate =
    facts?.periodEndAt &&
    (facts.cancelAtPeriodEnd || facts.status === 'ACTIVE' || facts.status === 'TRIALING');

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="flex min-h-[72px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          {loading ? (
            <Spinner size={15} />
          ) : error ? (
            <p className="text-12 leading-5 text-[var(--text-secondary)]">
              {t('billing.settings.subscriptionCard.unavailable')}
            </p>
          ) : facts ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-14 font-medium text-[var(--text-primary)]">{facts.name}</h4>
                <span className="select-none rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-10 font-medium text-[var(--text-secondary)]">
                  {t(`billing.subscriptionStatus.${facts.status}`)}
                </span>
              </div>
              {(facts.price || facts.includedCredits) && facts.interval && (
                <p className="mt-1.5 text-12 text-[var(--text-secondary)]">
                  {facts.price && (
                    <span>
                      {t('billing.settings.subscriptionCard.priceInterval', {
                        price: facts.price,
                        interval: t(`billing.intervals.${facts.interval}`),
                      })}
                    </span>
                  )}
                  {facts.price && facts.includedCredits && <span aria-hidden> · </span>}
                  {facts.includedCredits && (
                    <span>
                      {t('billing.settings.subscriptionCard.includedCredits', {
                        amount: facts.includedCredits,
                        interval: t(`billing.intervals.${facts.interval}`),
                      })}
                    </span>
                  )}
                </p>
              )}
              {showPeriodDate && (
                <p className="mt-1 text-12 text-[var(--text-tertiary)]">
                  {facts.cancelAtPeriodEnd
                    ? t('billing.settings.subscriptionCard.endsAt', {
                        date: facts.periodEndAt,
                      })
                    : t('billing.settings.subscriptionCard.renewsAt', {
                        date: facts.periodEndAt,
                      })}
                </p>
              )}
            </>
          ) : (
            <>
              <h4 className="text-14 font-medium text-[var(--text-primary)]">
                {t('billing.settings.subscriptionCard.emptyTitle')}
              </h4>
              <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                {t('billing.settings.subscriptionCard.empty')}
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {facts &&
            !facts.cancelAtPeriodEnd &&
            SUBSCRIPTION_CANCELLABLE_STATUSES.includes(facts.status) && (
              <button
                type="button"
                onClick={onCancelSubscription}
                disabled={actionDisabled}
                aria-label={t('billing.settings.subscriptionCard.cancelAction')}
                className="inline-flex h-8 select-none items-center justify-center rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--error-fg)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {canceling ? (
                  <Spinner size={13} />
                ) : (
                  t('billing.settings.subscriptionCard.cancelAction')
                )}
              </button>
            )}
          <button
            type="button"
            onClick={showPlanChangeEntry ? onChangePlan : onPurchase}
            disabled={actionDisabled}
            className="h-8 select-none rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {showPlanChangeEntry
              ? t('billing.settings.subscriptionCard.changeAction')
              : t('billing.settings.subscriptionCard.action')}
          </button>
        </div>
      </div>
      {pendingPlanChange?.status === 'SCHEDULED' && (
        <PendingPlanChangeBanner
          pending={pendingPlanChange}
          targetName={pendingTargetName}
          disabled={actionDisabled}
          onUndo={onCancelPending}
        />
      )}
    </section>
  );
}

// 服务端普通订阅投影只下发 SCHEDULED 变更：它是已确定的期末事实，展示并允许撤销。
function PendingPlanChangeBanner({
  pending,
  targetName,
  disabled,
  onUndo,
}: {
  pending: BillingPendingPlanChange;
  targetName: string | null;
  disabled: boolean;
  onUndo: () => void;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const effectiveDate = useMemo(
    () => formatBillingDate(pending.effectiveAt, billingLocale) ?? pending.effectiveAt,
    [billingLocale, pending.effectiveAt],
  );
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-default)] px-5 py-3">
      <p className="min-w-0 flex-1 text-12 leading-5 text-[var(--text-secondary)]">
        {t('billing.planChange.pendingDowngrade', {
          name: targetName ?? t('billing.settings.subscriptionCard.unnamedPlan'),
          date: effectiveDate,
        })}
      </p>
      <button
        type="button"
        onClick={onUndo}
        disabled={disabled}
        className="h-8 shrink-0 select-none rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('billing.planChange.undo')}
      </button>
    </div>
  );
}

const BILLING_CURRENCY = CURRENT_CINDY_REGION === 'global' ? 'usd' : 'cny';

function BillingGroup({
  title,
  titleId,
  description,
  badge,
  children,
}: {
  title: string;
  titleId?: string;
  description?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-14 font-medium text-[var(--text-primary)]">
          {title}
        </h3>
        {badge}
      </div>
      {description && (
        <p className="mt-1 max-w-[620px] text-12 leading-5 text-[var(--text-secondary)]">
          {description}
        </p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function BalanceOverviewCard({
  usage,
  balance,
  issue,
  loading,
  onPurchase,
}: {
  usage: ModelAccessCreditUsage | null;
  balance: ModelAccessBalance | null;
  issue: BalanceIssue;
  loading: boolean;
  onPurchase: () => void;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const available = usage?.available ?? balance?.available ?? null;
  const observedAt = usage?.observedAt ?? balance?.observedAt ?? null;
  const issueDescription =
    issue === 'NOT_PROVISIONED'
      ? t('billing.balance.notProvisioned')
      : issue === 'NOT_SUPPORTED'
        ? t('billing.balance.notSupported')
        : t('billing.balance.unavailable');

  return (
    <section
      aria-live="polite"
      aria-busy={loading}
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
    >
      <div className="flex min-h-[72px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          {loading ? (
            <Spinner size={15} />
          ) : available !== null ? (
            <>
              <p className="text-20 font-medium leading-7 tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">
                {formatMoney(available, BILLING_CURRENCY, billingLocale)}
              </p>
              {observedAt && (
                <p className="mt-1 text-11 text-[var(--text-tertiary)]">
                  {t('billing.usage.observedAt', {
                    date: formatLedgerTimestamp(observedAt, billingLocale),
                  })}
                </p>
              )}
            </>
          ) : (
            <p role="status" className="text-12 leading-5 text-[var(--text-secondary)]">
              {issueDescription}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onPurchase}
          className="h-8 shrink-0 select-none rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)]"
        >
          {t('billing.settings.topupCard.action')}
        </button>
      </div>
    </section>
  );
}

function UsageBreakdownCard({
  usage,
  balance,
}: {
  usage: ModelAccessCreditUsage | null;
  balance: ModelAccessBalance | null;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const poolLabels = {
    plan: t('billing.balance.plan'),
    purchased: t('billing.balance.purchased'),
    promotional: t('billing.balance.promotional'),
  };
  return (
    <section className="divide-y divide-[var(--border-default)] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {usage
        ? (
            [
              ['plan', usage.plan],
              ['purchased', usage.purchased],
              ['promotional', usage.promotional],
            ] as const
          ).map(([key, pool]) => <CreditPoolRow key={key} label={poolLabels[key]} pool={pool} />)
        : balance
          ? (
              [
                ['plan', balance.planCredits],
                ['purchased', balance.purchasedCredits],
                ['promotional', balance.promotionalCredits],
              ] as const
            ).map(([key, amount]) => (
              <div
                key={key}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5"
              >
                <p className="text-13 font-medium text-[var(--text-primary)]">{poolLabels[key]}</p>
                <p className="text-13 font-medium tabular-nums text-[var(--text-primary)]">
                  {formatMoney(amount, BILLING_CURRENCY, billingLocale)}
                </p>
              </div>
            ))
          : null}
    </section>
  );
}

function CreditPoolRow({ label, pool }: { label: string; pool: ModelAccessCreditPoolUsage }) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const percent = usagePercent(pool);
  const detail =
    pool.used !== null && pool.total !== null
      ? t('billing.usage.poolDetail', {
          used: formatMoney(pool.used, BILLING_CURRENCY, billingLocale),
          total: formatMoney(pool.total, BILLING_CURRENCY, billingLocale),
        })
      : t('billing.usage.historyUnavailable');
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="min-w-0">
        <p className="truncate text-13 font-medium text-[var(--text-primary)]">{label}</p>
        <p className="mt-1 text-11 leading-4 text-[var(--text-tertiary)]">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div
          className="h-1 w-40 overflow-hidden rounded-full bg-[var(--surface-chip)]"
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
        <p className="text-11 text-[var(--text-tertiary)]">
          {t('billing.usage.remaining')}
          <span className="ml-1.5 text-13 font-medium tabular-nums text-[var(--text-primary)]">
            {formatMoney(pool.remaining, BILLING_CURRENCY, billingLocale)}
          </span>
        </p>
      </div>
    </div>
  );
}

function PromotionalGrantsCard({ usage }: { usage: ModelAccessCreditUsage }) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {!usage.promotionalGrantsComplete && (
        <p className="border-b border-[var(--border-default)] px-5 py-3 text-11 leading-4 text-[var(--text-tertiary)]">
          {t('billing.usage.promotionalDetails.incomplete', {
            count: usage.promotionalGrants.length,
          })}
        </p>
      )}
      {usage.promotionalGrants.length === 0 ? (
        <p className="px-5 py-4 text-12 text-[var(--text-secondary)]">
          {t('billing.usage.promotionalDetails.empty')}
        </p>
      ) : (
        <div
          className="max-h-[360px] divide-y divide-[var(--border-default)] overflow-y-auto [scrollbar-gutter:stable]"
          role="list"
        >
          {usage.promotionalGrants.map((grant) => (
            <div
              key={grant.grantId}
              role="listitem"
              className="grid grid-cols-3 gap-x-3 gap-y-2 px-5 py-3 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(80px,0.7fr))] lg:items-center"
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
                    date: formatLedgerTimestamp(grant.expiresAt, billingLocale),
                  })}
                </p>
              </div>
              <GrantAmount
                label={t('billing.usage.promotionalDetails.original')}
                amount={grant.originalAmount}
              />
              <GrantAmount
                label={t('billing.usage.promotionalDetails.used')}
                amount={grant.usedAmount}
              />
              <GrantAmount
                label={t('billing.usage.promotionalDetails.remaining')}
                amount={grant.remainingAmount}
              />
            </div>
          ))}
        </div>
      )}
    </section>
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

function GrantAmount({ label, amount }: { label: string; amount: string }) {
  const { i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div className="min-w-0 text-right">
      <p className="truncate text-10 text-[var(--text-tertiary)]">{label}</p>
      <p className="mt-0.5 truncate text-11 font-medium tabular-nums text-[var(--text-primary)]">
        {formatMoney(amount, BILLING_CURRENCY, billingLocale)}
      </p>
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
  currentSubscriptionOfferCode,
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
  currentSubscriptionOfferCode: string | null;
  canCheckout: boolean;
  onClose: () => void;
  onRetry: () => void;
  onSelectOffer: (offerCode: string) => void;
  onSelectPurchaseOption: (optionId: string) => void;
  onCustomAmountChange: (amount: string) => void;
  onSubmit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const title =
    kind === 'SUBSCRIPTION'
      ? t('billing.dialogs.subscription.title')
      : t('billing.dialogs.topup.title');

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9990] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-[9991] flex max-h-[min(720px,calc(100vh-48px))]',
            'w-[calc(100vw-48px)] max-w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-xl border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:outline-none',
          )}
        >
          <div className="flex items-center justify-between gap-4 px-6 pb-4 pt-5">
            <Dialog.Title className="text-16 font-medium tracking-[-0.01em]">{title}</Dialog.Title>
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
                <div className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
                  {offers.map((entry) => {
                    const { product, offer } = entry;
                    const active = selected?.offer.code === offer.code;
                    const unavailableReason = catalogOfferUnavailableReason(entry);
                    const currentPlan =
                      kind === 'SUBSCRIPTION' && offer.code === currentSubscriptionOfferCode;
                    return (
                      <button
                        key={offer.code}
                        type="button"
                        onClick={() => onSelectOffer(offer.code)}
                        disabled={currentPlan || unavailableReason !== null}
                        aria-pressed={active}
                        aria-current={currentPlan ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                          'focus-visible:ring-[var(--text-primary)]',
                          'disabled:cursor-not-allowed disabled:hover:bg-transparent',
                          currentPlan
                            ? 'bg-[var(--surface-chip)]'
                            : unavailableReason
                              ? 'opacity-55'
                              : active
                                ? 'bg-[var(--surface-chip)]'
                                : 'hover:bg-[var(--surface-hover-soft)]',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                              {product.name}
                            </p>
                            {currentPlan && (
                              <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                {t('billing.catalog.currentPlan')}
                              </span>
                            )}
                            {unavailableReason && (
                              <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                {t(`billing.catalog.unavailableReasons.${unavailableReason}`)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <div className="text-right">
                            <p className="text-13 font-medium tabular-nums text-[var(--text-primary)]">
                              {offer.amount
                                ? formatMoney(offer.amount, offer.currency, billingLocale)
                                : t('billing.amount.custom')}
                              {offer.interval && (
                                <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
                                  / {t(`billing.intervals.${offer.interval}`)}
                                </span>
                              )}
                            </p>
                            {offer.creditAmount && (
                              <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                                {t('billing.credits', { amount: offer.creditAmount })}
                              </p>
                            )}
                          </div>
                          {!currentPlan && unavailableReason === null && (
                            <SelectionMark active={active} />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {selected && (
                  <div className="mt-5">
                    <h3 className="text-13 font-medium text-[var(--text-primary)]">
                      {t('billing.steps.channel.title')}
                    </h3>
                    <div className="mt-3 divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
                      {selected.purchaseOptions.map((option) => (
                        <PaymentOptionRow
                          key={option.id}
                          option={option}
                          active={selectedPurchaseOptionId === option.id}
                          onSelect={() => onSelectPurchaseOption(option.id)}
                        />
                      ))}
                    </div>

                    {kind === 'CREDIT_TOPUP' && isCustomTopup(selected.offer) && (
                      <label className="mt-5 block">
                        <span className="text-13 font-medium text-[var(--text-primary)]">
                          {t('billing.amount.label')}
                        </span>
                        <div className="mt-2 flex h-10 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-4 focus-within:border-[var(--text-primary)]">
                          <span className="mr-2 text-13 text-[var(--text-tertiary)]">
                            {selected.offer.currency.toUpperCase()}
                          </span>
                          <input
                            value={customAmount}
                            onChange={(event) => onCustomAmountChange(event.target.value)}
                            inputMode="decimal"
                            placeholder={t('billing.amount.placeholder')}
                            className="min-w-0 flex-1 bg-transparent text-13 outline-none placeholder:text-[var(--text-placeholder)]"
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
                              min: formatMoney(
                                selected.offer.minAmount!,
                                selected.offer.currency,
                                billingLocale,
                              ),
                              max: formatMoney(
                                selected.offer.maxAmount!,
                                selected.offer.currency,
                                billingLocale,
                              ),
                            })}
                        </p>
                      </label>
                    )}

                    {kind === 'SUBSCRIPTION' && subscriptionPurchaseBlocked && (
                      <p className="mt-4 text-12 leading-5 text-[var(--text-secondary)]">
                        {t('billing.currentSubscription.purchaseBlocked')}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex min-h-16 items-center justify-end gap-4 border-t border-[var(--border-default)] px-6 py-3">
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
    <div
      className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]"
      aria-hidden
    >
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="h-[52px] animate-pulse bg-[var(--surface-chip)] motion-reduce:animate-none"
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

function PaymentOptionRow({
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
        'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
        'focus-visible:ring-[var(--text-primary)]',
        active ? 'bg-[var(--surface-chip)]' : 'hover:bg-[var(--surface-hover-soft)]',
      )}
    >
      {option.provider === 'alipay' ? (
        <AlipayIcon className="size-4 shrink-0 text-[var(--text-secondary)]" />
      ) : (
        <Icon size={16} className="shrink-0 text-[var(--text-secondary)]" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <p className="truncate text-13 font-medium text-[var(--text-primary)]">
          {providerLabel(option.provider, t)}
        </p>
        <p className="truncate text-11 text-[var(--text-tertiary)]">
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
