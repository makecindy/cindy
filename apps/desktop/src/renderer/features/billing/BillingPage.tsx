import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Copy,
  CreditCard,
  ExternalLink,
  PackageOpen,
  RefreshCcw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import {
  BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES,
  type BillingCatalog,
  type BillingCatalogOffer,
  type BillingCatalogOfferUnavailableReason,
  type BillingCatalogProduct,
  type BillingPaymentOrder,
  type BillingPendingPlanChange,
  type BillingSubscription,
} from '../../../shared/billing';
import type {
  ModelAccessBalance,
  ModelAccessCreditPoolUsage,
  ModelAccessCreditUsage,
  ModelAccessPromotionalGrantState,
} from '../../../shared/modelAccess';
import { AlipayIcon } from './AlipayIcon';
import { billingApi } from './api';
import {
  isSupportedBillingProvider,
  isSupportedPurchaseOption,
  type SupportedBillingProvider,
  type SupportedPurchaseOption,
} from './purchaseSupport';
import { BillingCheckoutDialog } from './BillingCheckoutDialog';
import { BILLING_CURRENCY, formatBillingAmount as formatMoney } from './money';
import {
  PlanChangeStatusDialog,
  PlanChangeTargetDialog,
  type PlanChangeCandidate,
} from './PlanChangeDialog';
import { phaseForOrder, useBillingCheckout } from './useBillingCheckout';
import { usePlanChange, type PlanChangeSettledKind } from './usePlanChange';

type CatalogOfferEntry = {
  product: BillingCatalogProduct;
  offer: BillingCatalogOffer;
  purchaseOptions: SupportedPurchaseOption[];
};

type SubscriptionProductEntry = {
  product: BillingCatalogProduct;
  offers: CatalogOfferEntry[];
  defaultOffer: CatalogOfferEntry;
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
  resumable: boolean;
};

// 未完成首购只属于当前 checkout 会话，不能展示为当前套餐或阻断重新购买。
const SUBSCRIPTION_CANCELLABLE_STATUSES = BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES;

const PLAN_CHANGE_ENTRY_STATUSES: BillingSubscription['status'][] = ['ACTIVE'];

/**
 * 订单记录默认只列最近 10 笔。这一组回答的是「上次充了多少、那笔没付成的还在不在」,
 * 不是账目导出 —— 更早的记录没有分页器可翻,服务端还有下一页时只用一条提示条说明。
 */
const ORDER_HISTORY_LIMIT = 10;

/**
 * 订单状态 chip 的文案 key。刻意复用 checkout 的 `phaseForOrder` 而不是自己再写一套
 * status→文案映射:同一个 `CREATED`,支付弹窗说「等待支付」、列表说别的,是用户直接
 * 可见的不一致。两处必须由同一个判据推导。
 */
function orderStatusLabelKey(order: BillingPaymentOrder): string {
  switch (phaseForOrder(order)) {
    case 'COMPLETED':
      return 'billing.orders.states.completed';
    case 'CANCELED':
      return 'billing.orders.states.canceled';
    case 'EXPIRED':
      return 'billing.orders.states.expired';
    case 'FAILED':
      return 'billing.orders.states.failed';
    default:
      // phaseForOrder 对未终态一律返 AWAITING_PAYMENT(CREATED / PENDING)。
      return 'billing.orders.states.awaitingPayment';
  }
}

/** 「待支付」是这组里唯一可能还需要用户处理的状态,给它主文本色;其余保持二级色。 */
function isAwaitingPaymentOrder(order: BillingPaymentOrder): boolean {
  return phaseForOrder(order) === 'AWAITING_PAYMENT';
}

/** 订单号展示保留首尾用于对单，中段固定脱敏；复制仍使用服务端返回的完整原值。 */
function maskedOrderId(orderId: string): string {
  if (orderId.length <= 2) return '*'.repeat(orderId.length);
  const visibleEdgeLength = Math.min(8, Math.floor((orderId.length - 1) / 2));
  return `${orderId.slice(0, visibleEdgeLength)}****${orderId.slice(-visibleEdgeLength)}`;
}

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

function isSubscriptionOfferSelectable(
  entry: CatalogOfferEntry,
  currentSubscriptionOfferCode: string | null,
): boolean {
  return isCatalogOfferPurchasable(entry) && entry.offer.code !== currentSubscriptionOfferCode;
}

function groupSubscriptionProducts(
  entries: CatalogOfferEntry[],
  currentSubscriptionOfferCode: string | null,
): SubscriptionProductEntry[] {
  const groups = new Map<string, { product: BillingCatalogProduct; offers: CatalogOfferEntry[] }>();
  for (const entry of entries) {
    const group = groups.get(entry.product.code);
    if (group) {
      group.offers.push(entry);
    } else {
      groups.set(entry.product.code, { product: entry.product, offers: [entry] });
    }
  }
  return Array.from(groups.values()).flatMap(({ product, offers }) => {
    const defaultOffer =
      offers.find((entry) => isSubscriptionOfferSelectable(entry, currentSubscriptionOfferCode)) ??
      offers[0];
    return defaultOffer ? [{ product, offers, defaultOffer }] : [];
  });
}

function catalogOfferUnavailableReason(
  entry: CatalogOfferEntry,
): BillingCatalogOfferUnavailableReason | null {
  if (isCatalogOfferPurchasable(entry)) return null;
  return entry.offer.unavailableReason ?? 'NO_AVAILABLE_PAYMENT_CHANNEL';
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
  const [resumingSubscription, setResumingSubscription] = useState(false);
  const [openingSubscriptionPortal, setOpeningSubscriptionPortal] = useState(false);
  const [creditUsage, setCreditUsage] = useState<ModelAccessCreditUsage | null>(null);
  const [balance, setBalance] = useState<ModelAccessBalance | null>(null);
  const [usageDetailsUnavailable, setUsageDetailsUnavailable] = useState(false);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [balanceError, setBalanceError] = useState<BalanceIssue>(null);
  // 订单记录按账号天然隔离:BillingPage 用 `billing:<dataOwnerId>` 做 key,换账号会整段
  // 重挂,这份 state 连同缓存一起重建,不会把上一个账号的订单渲染给新账号。
  const [orders, setOrders] = useState<BillingPaymentOrder[]>([]);
  const [moreOrdersAvailable, setMoreOrdersAvailable] = useState(false);
  const [subscriptionDialogOpen, setSubscriptionDialogOpen] = useState(false);
  const [topupDialogOpen, setTopupDialogOpen] = useState(false);
  const [planChangeTargetOpen, setPlanChangeTargetOpen] = useState(false);
  const [selectedProductCode, setSelectedProductCode] = useState<string | null>(null);
  const [selectedOfferCode, setSelectedOfferCode] = useState<string | null>(null);
  const [selectedPurchaseOptionId, setSelectedPurchaseOptionId] = useState<string | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const checkout = useBillingCheckout(accountId);
  const previousCheckoutPhaseRef = useRef(checkout.state.phase);
  const cancelSubscriptionLockRef = useRef(false);
  const resumeSubscriptionLockRef = useRef(false);
  const subscriptionPortalLockRef = useRef(false);
  const subscriptionPortalRefreshPendingRef = useRef(false);
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

  const resetSubscriptionSelection = useCallback(() => {
    setSelectedProductCode(null);
    resetSelection();
  }, [resetSelection]);

  /**
   * 深链 `?tab=billing&intent=topup|subscribe|plan-change` —— 供应商设置页账户资产
   * 模块的入口。弹窗依赖本 section 的目录 / 订阅 / checkout 状态，跨 feature 只投递
   * 意图。消费即从 URL 摘除（replace，防返回/刷新重复弹窗），与 ProvidersSection 的
   * `?connect` 同款契约。
   *
   * topup 立即打开：充值弹窗自己会等目录。subscribe / plan-change 等目录和订阅都回来
   * 再开，避免先弹出可购买再变成 blocked，或 plan-change 入口还没算出来就空弹。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('intent') !== 'topup') return;
    const next = new URLSearchParams(searchParams);
    next.delete('intent');
    setSearchParams(next, { replace: true });
    resetSelection();
    setTopupDialogOpen(true);
  }, [resetSelection, searchParams, setSearchParams]);

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

  const loadOrders = useCallback(async () => {
    try {
      const list = await billingApi.listOrders(ORDER_HISTORY_LIMIT);
      setOrders(list.orders);
      // nextCursor 是「服务端还有更早的记录」的唯一实证;这一组不做分页器,只据此出提示条。
      setMoreOrdersAvailable(list.nextCursor !== null);
    } catch {
      // 订单记录是补充叙事(钱是怎么来的),拿不到就整组不渲染 —— 余额 / 用量 / 赠送
      // 三组都不受影响,也不为它加一个空错误壳占版面。
      setOrders([]);
      setMoreOrdersAvailable(false);
    }
  }, []);

  const loadSubscription = useCallback(async (fallback: BillingSubscription | null = null) => {
    setLoadingSubscription(true);
    setSubscriptionError(false);
    try {
      const subscription = (await billingApi.getCurrentSubscription()).subscription;
      setCurrentSubscription(
        subscription &&
          BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.includes(subscription.status)
          ? subscription
          : null,
      );
    } catch {
      const completedFallback =
        fallback && BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.includes(fallback.status)
          ? fallback
          : null;
      setCurrentSubscription(completedFallback);
      setSubscriptionError(completedFallback === null);
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
      // 进页面拉一次,「刷新」也跟着重拉;不加轮询 —— 订单只在用户自己发起支付时变化,
      // 而那条路径由 checkout 弹窗自己轮询。
      loadOrders(),
    ]);
  }, [loadBalance, loadOrders, loadSubscription]);

  const refreshXdModelsAfterEntitlementChange = useCallback(async () => {
    // 订阅权益会改变 Model Access 按当前用户返回的模型集合。这里必须走 XD 的
    // 主进程真源刷新，不能只重载 Billing state 后继续使用 active-catalog 的旧快照。
    await window.electronAPI.maker.refreshBuiltinProviderModels('xd');
  }, []);

  useEffect(() => {
    void loadBillingState();
  }, [loadBillingState]);

  useEffect(() => {
    const refreshAfterPortal = () => {
      if (!subscriptionPortalRefreshPendingRef.current) return;
      subscriptionPortalRefreshPendingRef.current = false;
      // Stripe Portal can upgrade, downgrade, cancel, or resume a subscription. Billing
      // state and the XD catalog are separate snapshots, so returning to Cindy must refresh
      // both explicitly; the app-wide focus refresh is throttled and cannot provide this
      // entitlement boundary.
      void Promise.allSettled([loadBillingState(), refreshXdModelsAfterEntitlementChange()]);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshAfterPortal();
    };
    window.addEventListener('focus', refreshAfterPortal);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refreshAfterPortal);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadBillingState, refreshXdModelsAfterEntitlementChange]);

  const closeCheckout = useCallback(() => {
    const abandonedIncomplete = checkout.state.subscription?.status === 'INCOMPLETE';
    checkout.close();
    if (abandonedIncomplete) {
      setCurrentSubscription(null);
      void loadSubscription();
    }
    // 关弹窗也刷一次订单:用户可能在 AWAITING_PAYMENT 中途放弃 —— 那笔「待支付」
    // 此刻就该出现在订单记录里,而不是等他手动点「刷新」才知道它还挂着。
    void loadOrders();
  }, [checkout, loadOrders, loadSubscription]);

  useEffect(() => {
    const previousPhase = previousCheckoutPhaseRef.current;
    previousCheckoutPhaseRef.current = checkout.state.phase;
    if (previousPhase === checkout.state.phase) return;
    // 订单记录跟着订单生命周期的每一次落位刷新,不只 COMPLETED:订单一创建(进入
    // AWAITING_PAYMENT)就已经是一条「待支付」记录;轮询落到 FAILED / EXPIRED /
    // CANCELED 时列表里那行的状态也变了。只刷 COMPLETED 会让其余终态全靠手动刷新。
    if (
      checkout.state.phase === 'AWAITING_PAYMENT' ||
      checkout.state.phase === 'COMPLETED' ||
      checkout.state.phase === 'FAILED' ||
      checkout.state.phase === 'EXPIRED' ||
      checkout.state.phase === 'CANCELED'
    ) {
      void loadOrders();
    }
    if (previousPhase !== 'COMPLETED' && checkout.state.phase === 'COMPLETED') {
      void loadBalance();
      // 服务端的 paid tier 同时认有效订阅和未全额退款的成功充值订单；两类支付
      // 完成都必须重拉 `/models`，由服务端重算 tier 并收敛 AIGateway access group。
      if (checkout.state.kind === 'TOPUP' || checkout.state.kind === 'SUBSCRIPTION') {
        void refreshXdModelsAfterEntitlementChange().catch(() => undefined);
      }
      if (checkout.state.kind === 'SUBSCRIPTION') {
        void loadSubscription(checkout.state.subscription);
      }
    }
  }, [
    checkout.state.kind,
    checkout.state.phase,
    checkout.state.subscription,
    loadBalance,
    loadOrders,
    loadSubscription,
    refreshXdModelsAfterEntitlementChange,
  ]);

  const handlePlanChangeSettled = useCallback(
    (kind: PlanChangeSettledKind) => {
      // APPLIED is the only settle that moves credits; one full reload covers
      // subscription, catalog, and balance without a second balance call.
      if (kind === 'APPLIED') {
        void loadBillingState();
        void refreshXdModelsAfterEntitlementChange().catch(() => undefined);
      } else void loadSubscription();
    },
    [loadBillingState, loadSubscription, refreshXdModelsAfterEntitlementChange],
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
    BILLING_SUBSCRIPTION_PURCHASE_BLOCKING_STATUSES.includes(currentSubscription.status);
  const currentSubscriptionOfferCode = subscriptionPurchaseBlocked
    ? (currentSubscription.effectivePlan?.offer.code ?? null)
    : null;
  const subscriptionProducts = useMemo(
    () => groupSubscriptionProducts(subscriptionOffers, currentSubscriptionOfferCode),
    [currentSubscriptionOfferCode, subscriptionOffers],
  );
  const selected = useMemo(() => {
    const entry = offers.find((candidate) => candidate.offer.code === selectedOfferCode) ?? null;
    if (!entry) return null;
    if (entry.product.kind === 'SUBSCRIPTION') {
      return entry.product.code === selectedProductCode ? entry : null;
    }
    return isCatalogOfferPurchasable(entry) ? entry : null;
  }, [offers, selectedOfferCode, selectedProductCode]);
  const selectedOption = useMemo(
    () =>
      selected?.purchaseOptions.find((option) => option.id === selectedPurchaseOptionId) ?? null,
    [selected, selectedPurchaseOptionId],
  );

  const selectSubscriptionOffer = useCallback((entry: CatalogOfferEntry) => {
    setSelectedOfferCode(entry.offer.code);
    setSelectedPurchaseOptionId((currentOptionId) =>
      entry.purchaseOptions.some((option) => option.id === currentOptionId)
        ? currentOptionId
        : (entry.purchaseOptions[0]?.id ?? null),
    );
    setCustomAmount('');
  }, []);

  useEffect(() => {
    if (selectedProductCode) {
      const selectedProduct = subscriptionProducts.find(
        (product) => product.product.code === selectedProductCode,
      );
      if (!selectedProduct) {
        resetSubscriptionSelection();
        return;
      }
      const selectedEntry = selectedProduct.offers.find(
        (entry) => entry.offer.code === selectedOfferCode,
      );
      if (
        !selectedEntry ||
        (!isSubscriptionOfferSelectable(selectedEntry, currentSubscriptionOfferCode) &&
          selectedEntry.offer.code !== selectedProduct.defaultOffer.offer.code)
      ) {
        selectSubscriptionOffer(selectedProduct.defaultOffer);
      }
      return;
    }

    if (!selectedOfferCode) return;
    const selectedEntry = offers.find(({ offer }) => offer.code === selectedOfferCode);
    if (
      !selectedEntry ||
      selectedEntry.product.kind !== 'CREDIT_TOPUP' ||
      !isCatalogOfferPurchasable(selectedEntry)
    ) {
      resetSelection();
    }
  }, [
    currentSubscriptionOfferCode,
    offers,
    resetSelection,
    resetSubscriptionSelection,
    selectSubscriptionOffer,
    selectedOfferCode,
    selectedProductCode,
    subscriptionProducts,
  ]);

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
    isCatalogOfferPurchasable(selected) &&
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
  const subscriptionProvider = currentSubscription?.provider;
  const currentProvider = isSupportedBillingProvider(subscriptionProvider)
    ? subscriptionProvider
    : null;
  const currentPlanCandidate = useMemo<PlanChangeCandidate | null>(() => {
    if (!currentPlan) return null;
    const catalogProduct = catalog?.products.find(
      (product) => product.code === currentPlan.product.code,
    );
    return {
      product: {
        code: currentPlan.product.code,
        name: catalogProduct?.name ?? currentPlan.product.code,
        kind: 'SUBSCRIPTION',
        level: currentPlan.product.level,
        sortOrder: catalogProduct?.sortOrder ?? 0,
        offers: [],
      },
      offer: {
        code: currentPlan.offer.code,
        interval: currentPlan.offer.interval,
        currency: currentPlan.terms.currency,
        amount: currentPlan.terms.amount,
        minAmount: null,
        maxAmount: null,
        creditAmount: currentPlan.terms.creditAmount,
        rolloverCap: currentPlan.terms.rolloverCap,
        purchaseOptions: [],
      },
      providers: currentProvider ? [currentProvider] : [],
      direction: null,
    };
  }, [catalog, currentPlan, currentProvider]);
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
      includedCredits: plan
        ? formatMoney(plan.terms.creditAmount, plan.terms.currency, billingLocale)
        : null,
      periodEndAt: formatBillingDate(currentSubscription.currentPeriodEndAt, billingLocale),
      cancelAtPeriodEnd: currentSubscription.cancelAtPeriodEnd,
      resumable: currentSubscription.resumable === true,
    };
  }, [billingLocale, currentSubscription, planNameOf, t]);

  const openSubscriptionPortal = useCallback(async () => {
    if (subscriptionPortalLockRef.current || currentSubscription?.provider !== 'stripe') return;
    subscriptionPortalLockRef.current = true;
    setOpeningSubscriptionPortal(true);
    subscriptionPortalRefreshPendingRef.current = true;
    try {
      const result = await billingApi.openSubscriptionPortal();
      if (!result.success && !result.timedOut) {
        subscriptionPortalRefreshPendingRef.current = false;
      }
      if (!result.success) {
        toast.error(t('billing.settings.subscriptionCard.portalFailed'));
      }
    } catch {
      subscriptionPortalRefreshPendingRef.current = false;
      toast.error(t('billing.settings.subscriptionCard.portalFailed'));
    } finally {
      setOpeningSubscriptionPortal(false);
      subscriptionPortalLockRef.current = false;
    }
  }, [currentSubscription?.provider, t]);

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
      // 的订阅状态。
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

  const resumeCurrentSubscription = useCallback(async () => {
    if (
      resumeSubscriptionLockRef.current ||
      !currentSubscription ||
      !currentSubscription.cancelAtPeriodEnd ||
      currentSubscription.resumable !== true
    ) {
      return;
    }
    resumeSubscriptionLockRef.current = true;
    try {
      const confirmingAccountId = accountIdRef.current;
      const confirmed = await confirm({
        title: t('billing.settings.subscriptionCard.resumeConfirmTitle'),
        description: t('billing.settings.subscriptionCard.resumeConfirmDescription'),
        confirmText: t('billing.settings.subscriptionCard.resumeConfirmAction'),
        cancelText: t('commonUi.confirmDialog.cancel'),
      });
      if (!confirmed) return;
      // 确认期间账号被换掉(或本 section 已卸载)就放弃:恢复会作用到另一个账号的订阅。
      if (!sectionMountedRef.current || accountIdRef.current !== confirmingAccountId) return;

      setResumingSubscription(true);
      try {
        const resumed = await billingApi.resumeCurrentSubscription();
        setCurrentSubscription(resumed);
        setSubscriptionError(false);
        toast.success(t('billing.settings.subscriptionCard.resumeSuccess'));
      } catch (error) {
        const ipcError = extractIpcError(error);
        if (ipcError?.code === 'RESUME_NOT_AVAILABLE') {
          // 服务端已否定当前投影，立即重拉，避免继续展示过期的恢复入口。
          void loadSubscription();
        }
        toast.error(
          ipcError?.code === 'RESUME_NOT_AVAILABLE'
            ? t('billing.settings.subscriptionCard.resumeNotAvailable')
            : t('billing.settings.subscriptionCard.resumeFailed'),
        );
      } finally {
        setResumingSubscription(false);
      }
    } finally {
      resumeSubscriptionLockRef.current = false;
    }
  }, [confirm, currentSubscription, loadSubscription, t]);

  // The server quote remains authoritative for business reachability. Until
  // that contract supports cross-interval/provider changes, keep those two
  // client-side compatibility gates so the dialog cannot offer known-invalid
  // targets.
  const planChangeCandidates = useMemo<PlanChangeCandidate[]>(() => {
    if (!showPlanChangeEntry || !currentPlan || !currentProvider) return [];
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
      }));
  }, [subscriptionOffers, showPlanChangeEntry, currentPlan, currentProvider]);

  const openPurchaseDialog = useCallback(
    (kind: PurchaseKind) => {
      resetSelection();
      if (kind === 'SUBSCRIPTION') {
        const defaultProduct =
          subscriptionProducts.find((product) =>
            isSubscriptionOfferSelectable(product.defaultOffer, currentSubscriptionOfferCode),
          ) ??
          subscriptionProducts[0] ??
          null;
        setSelectedProductCode(defaultProduct?.product.code ?? null);
        if (defaultProduct) {
          selectSubscriptionOffer(defaultProduct.defaultOffer);
        }
        setSubscriptionDialogOpen(true);
      } else {
        setSelectedProductCode(null);
        setTopupDialogOpen(true);
      }
    },
    [currentSubscriptionOfferCode, resetSelection, selectSubscriptionOffer, subscriptionProducts],
  );

  useEffect(() => {
    const intent = searchParams.get('intent');
    if (intent !== 'subscribe' && intent !== 'plan-change') return;
    if (loadingCatalog || loadingSubscription) return;
    // 目录或订阅请求失败时 loading 也会结束。此时还不知道能不能打开对应弹窗，
    // 不能把 intent 摘掉 —— 用户点刷新成功后才能重放。加载成功但没有改档入口
    // 才消费 plan-change（落地计费页，重放也不会弹出）。
    if (catalogError || subscriptionError) return;
    const next = new URLSearchParams(searchParams);
    next.delete('intent');
    setSearchParams(next, { replace: true });
    if (intent === 'subscribe') {
      openPurchaseDialog('SUBSCRIPTION');
      return;
    }
    if (showPlanChangeEntry) {
      setPlanChangeTargetOpen(true);
    }
  }, [
    catalogError,
    loadingCatalog,
    loadingSubscription,
    openPurchaseDialog,
    searchParams,
    setSearchParams,
    showPlanChangeEntry,
    subscriptionError,
  ]);

  const selectOffer = (offerCode: string) => {
    if (selectedOfferCode === offerCode) return;
    const entry = offers.find(({ offer }) => offer.code === offerCode);
    if (!entry) return;
    if (entry.product.kind === 'SUBSCRIPTION') {
      if (entry.product.code !== selectedProductCode) return;
      selectSubscriptionOffer(entry);
      return;
    }
    if (!isCatalogOfferPurchasable(entry)) return;
    setSelectedOfferCode(offerCode);
    // 只有一种支付方式时默认选中,免去一次多余点击。
    setSelectedPurchaseOptionId(
      entry.purchaseOptions.length === 1 ? entry.purchaseOptions[0].id : null,
    );
    setCustomAmount('');
  };

  const selectSubscriptionProduct = (productCode: string) => {
    const product = subscriptionProducts.find((entry) => entry.product.code === productCode);
    if (!product) return;
    setSelectedProductCode(productCode);
    selectSubscriptionOffer(product.defaultOffer);
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
    resetSubscriptionSelection();
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
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('billing.settings.title')}
          </h2>
          <button
            type="button"
            onClick={() => void loadBillingState()}
            disabled={
              loadingCatalog ||
              loadingSubscription ||
              loadingBalance ||
              cancelingSubscription ||
              resumingSubscription ||
              openingSubscriptionPortal
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
              showPortalEntry={currentSubscription?.provider === 'stripe'}
              canceling={cancelingSubscription}
              resuming={resumingSubscription}
              openingPortal={openingSubscriptionPortal}
              actionDisabled={
                loadingSubscription ||
                subscriptionError ||
                cancelingSubscription ||
                resumingSubscription ||
                openingSubscriptionPortal
              }
              pendingPlanChange={pendingPlanChange}
              pendingTargetName={planNameOf(pendingPlanChange?.targetPlan?.product.code)}
              onCancelSubscription={() => void cancelCurrentSubscription()}
              onResumeSubscription={() => void resumeCurrentSubscription()}
              onOpenPortal={() => void openSubscriptionPortal()}
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
              <UsageBreakdownCard
                usage={creditUsage}
                balance={balance}
                hasNoActiveSubscription={
                  !loadingSubscription && !subscriptionError && currentSubscription === null
                }
              />
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

          {/* 空态(没有任何订单 / 拉不到)整组不渲染:页面保持现状,不加空壳 —— 从没在
              Cindy 内付过钱的用户不需要一个写着「暂无订单」的框告诉他这件事。 */}
          {orders.length > 0 && (
            <BillingGroup
              title={t('billing.orders.title')}
              description={t('billing.orders.description')}
              badge={
                <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-10 font-medium text-[var(--text-secondary)]">
                  {t('billing.orders.count', { count: orders.length })}
                </span>
              }
            >
              <OrderHistoryCard orders={orders} hasMore={moreOrdersAvailable} />
            </BillingGroup>
          )}
        </div>
      </div>

      <BillingOfferDialog
        open={subscriptionDialogOpen}
        kind="SUBSCRIPTION"
        offers={subscriptionOffers}
        subscriptionProducts={subscriptionProducts}
        selectedProductCode={selectedProductCode}
        loading={loadingCatalog}
        catalogError={catalogError}
        selected={selected?.product.kind === 'SUBSCRIPTION' ? selected : null}
        selectedPurchaseOptionId={selectedPurchaseOptionId}
        customAmount={customAmount}
        amountError={amountError}
        subscriptionPurchaseBlocked={subscriptionPurchaseBlocked}
        currentSubscriptionOfferCode={currentSubscriptionOfferCode}
        subscriptionCancelAtPeriodEnd={currentSubscription?.cancelAtPeriodEnd ?? false}
        subscriptionPeriodEndAt={currentSubscription?.currentPeriodEndAt ?? null}
        canCheckout={canCheckout}
        onClose={closeSubscriptionDialog}
        onRetry={() => void loadBillingState()}
        onSelectProduct={selectSubscriptionProduct}
        onSelectOffer={selectOffer}
        onSelectPurchaseOption={setSelectedPurchaseOptionId}
        onCustomAmountChange={setCustomAmount}
        onSubmit={submit}
      />

      <BillingOfferDialog
        open={topupDialogOpen}
        kind="CREDIT_TOPUP"
        offers={topupOffers}
        subscriptionProducts={[]}
        selectedProductCode={null}
        loading={loadingCatalog}
        catalogError={catalogError}
        selected={selected?.product.kind === 'CREDIT_TOPUP' ? selected : null}
        selectedPurchaseOptionId={selectedPurchaseOptionId}
        customAmount={customAmount}
        amountError={amountError}
        subscriptionPurchaseBlocked={false}
        currentSubscriptionOfferCode={null}
        subscriptionCancelAtPeriodEnd={false}
        subscriptionPeriodEndAt={null}
        canCheckout={canCheckout}
        onClose={closeTopupDialog}
        onRetry={() => void loadBillingState()}
        onSelectProduct={() => undefined}
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
        currentPlan={currentPlanCandidate}
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
  showPortalEntry,
  canceling,
  resuming,
  openingPortal,
  actionDisabled,
  pendingPlanChange,
  pendingTargetName,
  onCancelSubscription,
  onResumeSubscription,
  onOpenPortal,
  onChangePlan,
  onPurchase,
  onCancelPending,
}: {
  facts: CurrentPlanFacts | null;
  loading: boolean;
  error: boolean;
  showPlanChangeEntry: boolean;
  showPortalEntry: boolean;
  canceling: boolean;
  resuming: boolean;
  openingPortal: boolean;
  actionDisabled: boolean;
  pendingPlanChange: BillingPendingPlanChange | null;
  pendingTargetName: string | null;
  onCancelSubscription: () => void;
  onResumeSubscription: () => void;
  onOpenPortal: () => void;
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
          {facts ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={actionDisabled}
                  className="group inline-flex h-8 min-w-[9.5rem] select-none items-center justify-center gap-1.5 rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] data-[state=open]:bg-[var(--surface-chip)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('billing.settings.subscriptionCard.manageAction')}
                  {canceling || resuming || openingPortal ? (
                    <Spinner size={13} />
                  ) : (
                    <ChevronDown
                      size={13}
                      strokeWidth={1.75}
                      className="transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="w-[var(--radix-dropdown-menu-trigger-width)] rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-none"
              >
                <DropdownMenuItem
                  onSelect={showPlanChangeEntry ? onChangePlan : onPurchase}
                  disabled={actionDisabled}
                  className="h-9 rounded-lg px-3 text-12 focus:bg-[var(--surface-hover)] focus:text-[var(--text-primary)]"
                >
                  {showPlanChangeEntry
                    ? t('billing.settings.subscriptionCard.changeAction')
                    : t('billing.settings.subscriptionCard.action')}
                </DropdownMenuItem>
                {showPortalEntry && (
                  <DropdownMenuItem
                    onSelect={onOpenPortal}
                    disabled={actionDisabled}
                    className="h-9 gap-2 rounded-lg px-3 text-12 focus:bg-[var(--surface-hover)] focus:text-[var(--text-primary)]"
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    {t('billing.settings.subscriptionCard.portalAction')}
                  </DropdownMenuItem>
                )}
                {!facts.cancelAtPeriodEnd &&
                  SUBSCRIPTION_CANCELLABLE_STATUSES.includes(facts.status) && (
                    <>
                      <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
                      <DropdownMenuItem
                        onSelect={onCancelSubscription}
                        disabled={actionDisabled}
                        className="h-9 rounded-lg px-3 text-12 text-[var(--error-fg)] focus:bg-[var(--error-bg)] focus:text-[var(--error-fg)]"
                      >
                        {canceling ? (
                          <Spinner size={13} />
                        ) : (
                          t('billing.settings.subscriptionCard.cancelAction')
                        )}
                      </DropdownMenuItem>
                    </>
                  )}
                {facts.cancelAtPeriodEnd && facts.resumable && (
                  <>
                    <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
                    <DropdownMenuItem
                      onSelect={onResumeSubscription}
                      disabled={actionDisabled}
                      className="h-9 rounded-lg px-3 text-12 focus:bg-[var(--surface-hover)] focus:text-[var(--text-primary)]"
                    >
                      {resuming ? (
                        <Spinner size={13} />
                      ) : (
                        t('billing.settings.subscriptionCard.resumeAction')
                      )}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <button
              type="button"
              onClick={onPurchase}
              disabled={actionDisabled}
              className="h-8 select-none rounded-full border border-[var(--border-default)] px-3.5 text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover-soft)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('billing.settings.subscriptionCard.action')}
            </button>
          )}
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
  hasNoActiveSubscription,
}: {
  usage: ModelAccessCreditUsage | null;
  balance: ModelAccessBalance | null;
  hasNoActiveSubscription: boolean;
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
          ).map(([key, pool]) => (
            <CreditPoolRow
              key={key}
              label={poolLabels[key]}
              pool={pool}
              noActiveSubscription={key === 'plan' && hasNoActiveSubscription}
            />
          ))
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

function isZeroCreditAmount(amount: string): boolean {
  return /^[+-]?0+(?:\.0+)?$/.test(amount.trim());
}

function CreditPoolRow({
  label,
  pool,
  noActiveSubscription,
}: {
  label: string;
  pool: ModelAccessCreditPoolUsage;
  noActiveSubscription: boolean;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const percent = usagePercent(pool);
  const detail =
    pool.used !== null && pool.total !== null
      ? t('billing.usage.poolDetail', {
          used: formatMoney(pool.used, BILLING_CURRENCY, billingLocale),
          total: formatMoney(pool.total, BILLING_CURRENCY, billingLocale),
        })
      : noActiveSubscription && isZeroCreditAmount(pool.remaining)
        ? t('billing.usage.noPlanCredits')
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

/**
 * 订单记录卡。行结构与 PromotionalGrantsCard 同一套(12px 容器 + 1px 分隔行 + 左列双行
 * 加右侧数列),因为它们在同一页里是同一类东西:一条条只读流水。
 */
function OrderHistoryCard({
  orders,
  hasMore,
}: {
  orders: readonly BillingPaymentOrder[];
  hasMore: boolean;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const copyOrderId = async (orderId: string) => {
    try {
      await navigator.clipboard.writeText(orderId);
      toast.success(t('billing.orders.copy.success'));
    } catch {
      toast.error(t('billing.orders.copy.failed'));
    }
  };
  /**
   * 支付方式只有在服务端还带着本单的支付动作时才知道 —— 订单投影(shared/billing.ts 的
   * BillingPaymentOrder)里没有收单渠道字段,终态订单通常也不再带 paymentAction。整批都
   * 拿不到时**整列不出**,免得留下一列破折号;有一单拿得到就保留该列并给缺的那些占位。
   */
  const showPaymentMethod = orders.some((order) => order.paymentAction !== null);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {hasMore && (
        <p className="border-b border-[var(--border-default)] px-5 py-3 text-11 leading-4 text-[var(--text-tertiary)]">
          {t('billing.orders.incomplete', { count: orders.length })}
        </p>
      )}
      {/* 不像赠送明细那样封高 + 内滚:那边的行数由服务端历史决定(可达上百条),这边行数
          由 ORDER_HISTORY_LIMIT 封死在 10,再套一层内滚只会凭空造出嵌套滚动区。 */}
      <div className="divide-y divide-[var(--border-default)]" role="list">
        {orders.map((order) => (
          <div
            key={order.orderId}
            role="listitem"
            className={cn(
              'grid gap-x-3 gap-y-2 px-5 py-3.5 lg:items-center',
              showPaymentMethod
                ? 'grid-cols-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(80px,0.7fr)_minmax(80px,0.8fr)_minmax(76px,0.6fr)]'
                : 'grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(80px,0.7fr)_minmax(76px,0.6fr)]',
            )}
          >
            <div
              className={cn(
                'min-w-0 lg:col-span-1',
                showPaymentMethod ? 'col-span-3' : 'col-span-2',
              )}
            >
              <p className="truncate text-12 font-medium tabular-nums text-[var(--text-primary)]">
                {formatLedgerTimestamp(order.createdAt, billingLocale)}
              </p>
              {/* 可见值只露首尾；整块按钮含 Copy 图标，点击任一位置都复制完整订单号。 */}
              <button
                type="button"
                onClick={() => void copyOrderId(order.orderId)}
                aria-label={t('billing.orders.copy.action', {
                  id: maskedOrderId(order.orderId),
                })}
                className={cn(
                  '-ml-1.5 mt-0.5 inline-flex max-w-full cursor-pointer select-none items-center gap-1 rounded-full px-1.5 py-0.5 text-left',
                  'font-mono text-10 text-[var(--text-tertiary)] transition-colors',
                  'hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-secondary)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                )}
              >
                <span className="min-w-0 break-all">
                  {t('billing.orders.orderId', { id: maskedOrderId(order.orderId) })}
                </span>
                <Copy aria-hidden="true" size={11} className="shrink-0" />
              </button>
            </div>
            <p className="min-w-0 truncate text-right text-12 font-medium tabular-nums text-[var(--text-primary)]">
              {formatMoney(order.amount, order.currency, billingLocale)}
            </p>
            {showPaymentMethod && (
              <p className="min-w-0 truncate text-11 text-[var(--text-secondary)]">
                {order.paymentAction
                  ? t(`billing.paymentActions.${order.paymentAction.type}`)
                  : '—'}
              </p>
            )}
            <div className="flex min-w-0 justify-end">
              <span
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-full bg-[var(--surface-chip)] px-2.5 py-1',
                  'text-10 font-medium leading-[1.2]',
                  isAwaitingPaymentOrder(order)
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]',
                )}
              >
                {t(orderStatusLabelKey(order))}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
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
  subscriptionProducts,
  selectedProductCode,
  loading,
  catalogError,
  selected,
  selectedPurchaseOptionId,
  customAmount,
  amountError,
  subscriptionPurchaseBlocked,
  currentSubscriptionOfferCode,
  subscriptionCancelAtPeriodEnd,
  subscriptionPeriodEndAt,
  canCheckout,
  onClose,
  onRetry,
  onSelectProduct,
  onSelectOffer,
  onSelectPurchaseOption,
  onCustomAmountChange,
  onSubmit,
}: {
  open: boolean;
  kind: PurchaseKind;
  offers: CatalogOfferEntry[];
  subscriptionProducts: SubscriptionProductEntry[];
  selectedProductCode: string | null;
  loading: boolean;
  catalogError: boolean;
  selected: CatalogOfferEntry | null;
  selectedPurchaseOptionId: string | null;
  customAmount: string;
  amountError: string | null;
  subscriptionPurchaseBlocked: boolean;
  currentSubscriptionOfferCode: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  subscriptionPeriodEndAt: string | null;
  canCheckout: boolean;
  onClose: () => void;
  onRetry: () => void;
  onSelectProduct: (productCode: string) => void;
  onSelectOffer: (offerCode: string) => void;
  onSelectPurchaseOption: (optionId: string) => void;
  onCustomAmountChange: (amount: string) => void;
  onSubmit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const formattedSubscriptionPeriodEndAt = formatBillingDate(
    subscriptionPeriodEndAt,
    billingLocale,
  );
  const title =
    kind === 'SUBSCRIPTION'
      ? t('billing.dialogs.subscription.title')
      : t('billing.dialogs.topup.title');
  const selectedSubscriptionProduct =
    kind === 'SUBSCRIPTION'
      ? (subscriptionProducts.find((product) => product.product.code === selectedProductCode) ??
        null)
      : null;
  const displayedOffers = selectedSubscriptionProduct?.offers ?? offers;
  const initialTopupOfferCode =
    kind === 'CREDIT_TOPUP'
      ? (displayedOffers.find(isCatalogOfferPurchasable)?.offer.code ?? null)
      : null;
  const selectedOfferCanChooseChannel =
    selected !== null &&
    isCatalogOfferPurchasable(selected) &&
    !(kind === 'SUBSCRIPTION' && selected.offer.code === currentSubscriptionOfferCode);
  const primaryFocusRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (primaryFocusRef.current ?? closeButtonRef.current)?.focus();
          }}
        >
          <div className="flex items-center justify-between gap-4 px-6 pb-4 pt-5">
            <Dialog.Title className="truncate text-16 font-medium tracking-[-0.01em]">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                ref={closeButtonRef}
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
                    ref={primaryFocusRef}
                    type="button"
                    onClick={onRetry}
                    className="mt-4 h-9 rounded-full border border-[var(--border-default)] px-4 text-12 font-medium hover:bg-[var(--surface-hover-soft)]"
                  >
                    {t('billing.actions.retry')}
                  </button>
                }
              />
            ) : offers.length === 0 ? (
              <StateCard icon={<PackageOpen size={22} />} title={t('billing.catalog.emptyTitle')} />
            ) : (
              <>
                {kind === 'SUBSCRIPTION' && (
                  <SubscriptionProductAccordion
                    products={subscriptionProducts}
                    selectedProductCode={selectedProductCode}
                    selectedOfferCode={selected?.offer.code ?? null}
                    currentSubscriptionOfferCode={currentSubscriptionOfferCode}
                    billingLocale={billingLocale}
                    initialFocusRef={primaryFocusRef}
                    onSelectProduct={onSelectProduct}
                    onSelectOffer={onSelectOffer}
                  />
                )}

                <div className={kind === 'SUBSCRIPTION' ? 'mt-4' : undefined}>
                  {kind !== 'SUBSCRIPTION' && (
                    <div className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
                      {displayedOffers.map((entry) => {
                        const { product, offer } = entry;
                        const active = selected?.offer.code === offer.code;
                        const unavailableReason = catalogOfferUnavailableReason(entry);
                        const currentPlan = false;
                        return (
                          <button
                            key={offer.code}
                            ref={offer.code === initialTopupOfferCode ? primaryFocusRef : undefined}
                            type="button"
                            onClick={() => onSelectOffer(offer.code)}
                            disabled={currentPlan || unavailableReason !== null}
                            aria-pressed={active}
                            aria-current={currentPlan ? 'true' : undefined}
                            className={cn(
                              'flex min-h-[52px] w-full items-center justify-between gap-4 px-4 py-3',
                              'text-left transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                              'focus-visible:ring-[var(--focus-ring)]',
                              'disabled:cursor-not-allowed disabled:hover:bg-transparent',
                              currentPlan
                                ? 'bg-[var(--surface-chip)]'
                                : unavailableReason
                                  ? 'bg-[var(--surface-elevated)] opacity-55'
                                  : active
                                    ? 'bg-[var(--surface-hover-soft)]'
                                    : 'bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div
                                className={cn(
                                  'grid items-center gap-2',
                                  currentPlan || unavailableReason
                                    ? 'grid-cols-[6rem_minmax(0,1fr)]'
                                    : 'grid-cols-[minmax(0,1fr)]',
                                )}
                              >
                                <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                                  {product.name}
                                </p>
                                {(currentPlan || unavailableReason) && (
                                  <div className="min-w-0">
                                    {currentPlan && (
                                      <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                        {t('billing.catalog.currentPlan')}
                                      </span>
                                    )}
                                    {unavailableReason && (
                                      <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                        {t(
                                          `billing.catalog.unavailableReasons.${unavailableReason}`,
                                        )}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              <div className="text-right">
                                <p className="text-12 font-medium tabular-nums text-[var(--text-primary)]">
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
                                    {t('billing.credits', {
                                      amount: formatMoney(
                                        offer.creditAmount,
                                        offer.currency,
                                        billingLocale,
                                      ),
                                    })}
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
                  )}

                  {selectedOfferCanChooseChannel && (
                    <div className="mt-5">
                      <h3 className="text-13 font-medium text-[var(--text-primary)]">
                        {t('billing.steps.channel.title')}
                      </h3>
                      <div className="mt-3 divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)]">
                        {selected!.purchaseOptions.map((option) => (
                          <PaymentOptionRow
                            key={option.id}
                            option={option}
                            active={selectedPurchaseOptionId === option.id}
                            onSelect={() => onSelectPurchaseOption(option.id)}
                          />
                        ))}
                      </div>

                      {kind === 'CREDIT_TOPUP' && isCustomTopup(selected!.offer) && (
                        <label className="mt-5 block">
                          <span className="text-13 font-medium text-[var(--text-primary)]">
                            {t('billing.amount.label')}
                          </span>
                          <div className="mt-2 flex h-10 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-4 focus-within:border-[var(--text-primary)]">
                            <span className="mr-2 text-13 text-[var(--text-tertiary)]">
                              {selected!.offer.currency.toUpperCase()}
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
                                  selected!.offer.minAmount!,
                                  selected!.offer.currency,
                                  billingLocale,
                                ),
                                max: formatMoney(
                                  selected!.offer.maxAmount!,
                                  selected!.offer.currency,
                                  billingLocale,
                                ),
                              })}
                          </p>
                        </label>
                      )}
                    </div>
                  )}

                  {kind === 'SUBSCRIPTION' && selected && subscriptionPurchaseBlocked && (
                    <p className="mt-4 text-12 leading-5 text-[var(--text-secondary)]">
                      {subscriptionCancelAtPeriodEnd && formattedSubscriptionPeriodEndAt
                        ? t('billing.currentSubscription.purchaseBlockedUntilPeriodEnd', {
                            date: formattedSubscriptionPeriodEndAt,
                          })
                        : t('billing.currentSubscription.purchaseBlocked')}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex min-h-16 items-center justify-end gap-4 border-t border-[var(--border-default)] px-6 py-3">
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canCheckout}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-5 text-13 font-medium text-[var(--accent-pure-cta-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-elevated)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35 disabled:active:scale-100"
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

function SubscriptionProductAccordion({
  products,
  selectedProductCode,
  selectedOfferCode,
  currentSubscriptionOfferCode,
  billingLocale,
  initialFocusRef,
  onSelectProduct,
  onSelectOffer,
}: {
  products: SubscriptionProductEntry[];
  selectedProductCode: string | null;
  selectedOfferCode: string | null;
  currentSubscriptionOfferCode: string | null;
  billingLocale: string;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onSelectProduct: (productCode: string) => void;
  onSelectOffer: (offerCode: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
      {products.map((productEntry, productIndex) => {
        const productActive = productEntry.product.code === selectedProductCode;
        const offerRegionId = `billing-product-${productEntry.product.code}-offers`;
        const singleOfferEntry = productEntry.offers.length === 1 ? productEntry.offers[0] : null;
        const singleOfferCurrentPlan =
          singleOfferEntry?.offer.code === currentSubscriptionOfferCode;
        const singleOfferUnavailableReason = singleOfferEntry
          ? catalogOfferUnavailableReason(singleOfferEntry)
          : null;
        const priceOffer = productEntry.defaultOffer.offer;
        const price = priceOffer.amount
          ? formatMoney(priceOffer.amount, priceOffer.currency, billingLocale)
          : t('billing.amount.custom');
        const interval = priceOffer.interval ? t(`billing.intervals.${priceOffer.interval}`) : null;
        return (
          <section
            key={productEntry.product.code}
            className={cn(productIndex > 0 && 'border-t border-[var(--border-default)]')}
          >
            {singleOfferEntry ? (
              <button
                ref={
                  productActive && !singleOfferCurrentPlan && singleOfferUnavailableReason === null
                    ? initialFocusRef
                    : undefined
                }
                type="button"
                onClick={() => onSelectProduct(productEntry.product.code)}
                disabled={singleOfferCurrentPlan || singleOfferUnavailableReason !== null}
                aria-pressed={productActive}
                aria-current={singleOfferCurrentPlan ? 'true' : undefined}
                className={cn(
                  'flex min-h-[72px] w-full items-center justify-between gap-5 px-4 py-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                  'focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed',
                  singleOfferCurrentPlan
                    ? 'bg-[var(--surface-chip)]'
                    : singleOfferUnavailableReason !== null
                      ? 'bg-[var(--surface-elevated)] opacity-55'
                      : productActive
                        ? 'bg-[var(--surface-hover-soft)]'
                        : 'bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                    {productEntry.product.name}
                  </span>
                  {(singleOfferCurrentPlan || singleOfferUnavailableReason !== null) && (
                    <span className="shrink-0 rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                      {singleOfferCurrentPlan
                        ? t('billing.catalog.currentPlan')
                        : t(`billing.catalog.unavailableReasons.${singleOfferUnavailableReason}`)}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="flex flex-col items-end gap-0.5">
                    <p className="text-12 font-medium tabular-nums text-[var(--text-primary)]">
                      {price}
                      {interval && (
                        <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
                          / {interval}
                        </span>
                      )}
                    </p>
                    {priceOffer.creditAmount && (
                      <p className="text-12 text-[var(--text-secondary)]">
                        {t('billing.credits', {
                          amount: formatMoney(
                            priceOffer.creditAmount,
                            priceOffer.currency,
                            billingLocale,
                          ),
                        })}
                      </p>
                    )}
                  </div>
                  {!singleOfferCurrentPlan && singleOfferUnavailableReason === null ? (
                    <SelectionMark active={productActive} />
                  ) : (
                    <span className="size-5 shrink-0" aria-hidden />
                  )}
                </div>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSelectProduct(productEntry.product.code)}
                aria-pressed={productActive}
                aria-expanded={productActive}
                aria-controls={offerRegionId}
                className={cn(
                  'flex min-h-[52px] w-full items-center justify-between gap-3 px-4 text-left transition-colors',
                  'bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                  'focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {productActive ? (
                    <ChevronUp size={16} className="shrink-0 text-[var(--text-secondary)]" />
                  ) : (
                    <ChevronRight size={16} className="shrink-0 text-[var(--text-tertiary)]" />
                  )}
                  <span className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]">
                    {productEntry.product.name}
                  </span>
                </div>
                {!productActive && (
                  <div className="flex flex-col items-end gap-0.5">
                    <p className="text-right text-12 font-medium tabular-nums text-[var(--text-primary)]">
                      {price}
                      {interval && (
                        <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
                          / {interval}
                        </span>
                      )}
                    </p>
                    {priceOffer.creditAmount && (
                      <p className="text-12 text-[var(--text-secondary)]">
                        {t('billing.credits', {
                          amount: formatMoney(
                            priceOffer.creditAmount,
                            priceOffer.currency,
                            billingLocale,
                          ),
                        })}
                      </p>
                    )}
                  </div>
                )}
              </button>
            )}

            {!singleOfferEntry && productActive && (
              <div
                id={offerRegionId}
                className="divide-y divide-[var(--border-default)] border-t border-[var(--border-default)]"
              >
                {productEntry.offers.map((entry) => {
                  const { offer } = entry;
                  const offerName = offer.name?.trim();
                  const unavailableReason = catalogOfferUnavailableReason(entry);
                  const currentPlan = offer.code === currentSubscriptionOfferCode;
                  const unavailable = unavailableReason !== null;
                  const offerActive = offer.code === selectedOfferCode;
                  return (
                    <button
                      key={offer.code}
                      ref={
                        offerActive && !currentPlan && !unavailable ? initialFocusRef : undefined
                      }
                      type="button"
                      onClick={() => onSelectOffer(offer.code)}
                      disabled={currentPlan || unavailable}
                      aria-pressed={offerActive}
                      aria-current={currentPlan ? 'true' : undefined}
                      className={cn(
                        'flex min-h-[72px] w-full items-center justify-between gap-5 py-3 pl-10 pr-4 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                        'focus-visible:ring-[var(--focus-ring)]',
                        'disabled:cursor-not-allowed disabled:hover:bg-transparent',
                        currentPlan
                          ? 'bg-[var(--surface-chip)]'
                          : unavailable
                            ? 'bg-[var(--surface-elevated)] opacity-55'
                            : offerActive
                              ? 'bg-[var(--surface-hover-soft)]'
                              : 'bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
                      )}
                    >
                      <div className="flex min-w-0 items-center">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            {offerName && (
                              <p className="truncate text-13 font-medium text-[var(--text-primary)]">
                                {offerName}
                              </p>
                            )}
                            {(currentPlan || unavailable) && (
                              <span className="shrink-0 rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                {currentPlan
                                  ? t('billing.catalog.currentPlan')
                                  : t(`billing.catalog.unavailableReasons.${unavailableReason}`)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        <div className="flex flex-col items-end gap-0.5">
                          <p className="text-12 font-medium tabular-nums text-[var(--text-primary)]">
                            {offer.amount
                              ? formatMoney(offer.amount, offer.currency, billingLocale)
                              : t('billing.amount.custom')}
                            {offer.interval && (
                              <span className="ml-1 text-11 font-normal text-[var(--text-tertiary)]">
                                / {t(`billing.intervals.${offer.interval}`)}
                              </span>
                            )}
                          </p>
                          <p className="text-12 text-[var(--text-secondary)]">
                            {offer.creditAmount
                              ? t('billing.credits', {
                                  amount: formatMoney(
                                    offer.creditAmount,
                                    offer.currency,
                                    billingLocale,
                                  ),
                                })
                              : null}
                          </p>
                        </div>
                        {!currentPlan && !unavailable ? (
                          <SelectionMark active={offerActive} />
                        ) : (
                          <span className="size-5 shrink-0" aria-hidden />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
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
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[184px] flex-col items-center justify-center rounded-xl border border-[var(--border-default)] px-6 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-[var(--surface-chip)]">
        {icon}
      </div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      {description && <p className="mt-1 text-12 text-[var(--text-secondary)]">{description}</p>}
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
        'focus-visible:ring-[var(--focus-ring)]',
        active
          ? 'bg-[var(--surface-hover-soft)]'
          : 'bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover-soft)]',
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
