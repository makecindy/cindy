import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentVisible } from '@/hooks/useWindowVisible';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type {
  BillingPurchasedGiftCard,
  BillingPurchasedGiftCardCode,
  BillingSendGiftCardEmailResult,
} from '../../../shared/billing';
import { giftCardCodeFromInput } from '../../../shared/giftCard';
import { billingApi } from './api';

const PAGE_SIZE = 20;
/** 发到邮箱是异步的：还在排队或发送中的卡，隔一会儿重读它所在的那一页，最多几次，窗口隐藏时暂停。 */
export const EMAIL_REFRESH_DELAY_MS = 5_000;
export const EMAIL_REFRESH_MAX_ROUNDS = 6;
/**
 * 每轮最多重读几页、逐页串行：发送中的卡分散在很多已加载的分页时，不能每 5 秒并发一批请求。
 * 超出的页这轮不刷新，下次进入计费页或手动刷新时再读。
 */
export const EMAIL_REFRESH_MAX_PAGES = 3;

/** 还没领取、邮件仍在排队或发送中的卡；已领取或已退款的卡不会再发出，不等它。 */
export function isGiftCardEmailInFlight(card: BillingPurchasedGiftCard): boolean {
  return (
    card.status === 'UNCLAIMED' &&
    (card.email?.status === 'PENDING' || card.email?.status === 'SENDING')
  );
}

export type PurchasedGiftCardsState = {
  cards: BillingPurchasedGiftCard[];
  nextCursor: string | null;
  loading: boolean;
  /** 首次加载完成前为 false；之后列表为空即表示没买过卡。 */
  loaded: boolean;
  error: boolean;
  /** 服务端支持发到邮箱（见 BillingPurchasedGiftCardList.emailSupported）。 */
  emailSupported: boolean;
};

const INITIAL: PurchasedGiftCardsState = {
  cards: [],
  nextCursor: null,
  loading: false,
  loaded: false,
  error: false,
  emailSupported: false,
};

/**
 * 我买的礼品卡：进入计费页、买完、兑换后各读一次第一页。兑换码只在复制或兑换时向服务端取，
 * 按卡在内存里留到页面卸载，同一张卡反复复制不再请求。发到邮箱后，有邮件仍在发送的卡时
 * 隔 5 秒重读这些卡所在的分页（「加载更多」载入的卡读它那一页）并合并进列表，最多 6 次，
 * 窗口隐藏时不读。
 */
export function usePurchasedGiftCards() {
  const { t } = useTranslation();
  const [state, setState] = useState<PurchasedGiftCardsState>(INITIAL);
  const generationRef = useRef(0);
  const codesRef = useRef(new Map<string, BillingPurchasedGiftCardCode>());
  const mountedRef = useRef(true);
  // 每张卡来自哪一页：那一页请求用的游标，第一页为 null。刷新发信状态时只重读这些页。
  const pageOfCardRef = useRef(new Map<string, string | null>());
  // 列表从别的途径拿到更新的数据（重读、加载更多、发信成功）时加一：在那之前发出的发信状态刷新
  // 晚到时作废，不能用旧快照盖掉新状态（比如把刚兑换的卡改回未领取、重新放出操作）。
  const freshnessRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      codesRef.current.clear();
    };
  }, []);

  const reload = useCallback(async (): Promise<BillingPurchasedGiftCard[] | null> => {
    // 卸载后不再发起读取（迟到的取码、发信结果可能在离开页面后才回来）。
    if (!mountedRef.current) return null;
    const generation = ++generationRef.current;
    freshnessRef.current += 1;
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const page = await billingApi.listPurchasedGiftCards(PAGE_SIZE);
      if (!mountedRef.current || generation !== generationRef.current) return null;
      pageOfCardRef.current = new Map(page.cards.map((card) => [card.cardId, null]));
      setState({
        cards: page.cards,
        nextCursor: page.nextCursor,
        loading: false,
        loaded: true,
        error: false,
        emailSupported: page.emailSupported,
      });
      return page.cards;
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return null;
      // 旧服务端没有这个接口：等同于没买过卡，不显示错误。
      const missing = extractIpcError(error)?.code === 'NOT_FOUND';
      setState((current) => ({ ...current, loading: false, loaded: true, error: !missing }));
      return null;
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loading) return;
    const generation = ++generationRef.current;
    freshnessRef.current += 1;
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const page = await billingApi.listPurchasedGiftCards(PAGE_SIZE, cursor);
      if (!mountedRef.current || generation !== generationRef.current) return;
      for (const card of page.cards) {
        if (!pageOfCardRef.current.has(card.cardId)) pageOfCardRef.current.set(card.cardId, cursor);
      }
      setState((current) => {
        const seen = new Set(current.cards.map((card) => card.cardId));
        return {
          cards: [...current.cards, ...page.cards.filter((card) => !seen.has(card.cardId))],
          nextCursor: page.nextCursor,
          loading: false,
          loaded: true,
          error: false,
          emailSupported: current.emailSupported || page.emailSupported,
        };
      });
    } catch {
      if (mountedRef.current && generation === generationRef.current) {
        setState((current) => ({ ...current, loading: false, error: true }));
      }
    }
  }, [state.loading, state.nextCursor]);

  /** 取回兑换码；卡已被领取或已退款时提示并刷新列表，返回 null。 */
  const reveal = useCallback(
    async (card: BillingPurchasedGiftCard): Promise<BillingPurchasedGiftCardCode | null> => {
      const cached = codesRef.current.get(card.cardId);
      if (cached) return cached;
      try {
        const result = await billingApi.revealPurchasedGiftCard(card.cardId, card.faceCode);
        // 页面已离开（含切换账号，计费页按账号重新挂载）：不缓存、不提示、不复制。
        if (!mountedRef.current) return null;
        codesRef.current.set(card.cardId, result);
        return result;
      } catch (error) {
        if (!mountedRef.current) return null;
        const code = extractIpcError(error)?.code;
        if (code === 'PRECONDITION_FAILED' || code === 'NOT_FOUND') {
          toast.error(t('billing.giftCardPurchase.toasts.unavailable'));
          void reload();
        } else {
          toast.error(t('billing.giftCardPurchase.toasts.revealFailed'));
        }
        return null;
      }
    },
    [reload, t],
  );

  /** 复制领取链接或兑换码。分享站未配置时链接拿不到，退回复制兑换码并照实提示。 */
  const copy = useCallback(
    async (card: BillingPurchasedGiftCard, kind: 'link' | 'code'): Promise<boolean> => {
      const result = await reveal(card);
      if (!result) return false;
      const value = kind === 'link' && result.claimUrl ? result.claimUrl : result.code;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        if (mountedRef.current) toast.error(t('billing.giftCardPurchase.toasts.copyFailed'));
        return false;
      }
      if (!mountedRef.current) return false;
      toast.success(
        t(
          kind === 'link' && result.claimUrl
            ? 'billing.giftCardPurchase.toasts.linkCopied'
            : 'billing.giftCardPurchase.toasts.codeCopied',
        ),
      );
      return true;
    },
    [reveal, t],
  );

  /** 卡已兑换（自己兑换或被别人领走）后，它的兑换码不再有用。 */
  const forget = useCallback((cardId: string) => {
    codesRef.current.delete(cardId);
  }, []);

  /** 按兑换码清掉缓存（兑换弹窗只知道码，不知道是哪张卡；手动粘贴兑换的也算）。 */
  const forgetCode = useCallback((code: string) => {
    const redeemed = giftCardCodeFromInput(code);
    if (!redeemed) return;
    for (const [cardId, cached] of codesRef.current) {
      if (giftCardCodeFromInput(cached.code) === redeemed) codesRef.current.delete(cardId);
    }
  }, []);

  /** 用服务端返回的最新卡片替换列表里同一张卡（不在列表里的忽略）。 */
  const mergeCards = useCallback((updated: BillingPurchasedGiftCard[]) => {
    const byId = new Map(updated.map((card) => [card.cardId, card]));
    setState((current) => ({
      ...current,
      cards: current.cards.map((card) => byId.get(card.cardId) ?? card),
    }));
  }, []);

  const emailRoundsRef = useRef(0);

  /**
   * 发到邮箱；成功后就地更新这张卡并重新开始有限次的状态刷新。请求在途期间列表已从别的途径更新
   * （比如关掉弹窗后兑换了这张卡、重读完成）时，返回的卡可能是更旧的快照：不拿它覆盖，改为重读一次，
   * 以服务端当前状态为准（那次重读可能早于发信生效，直接丢掉会漏掉发信状态）。
   */
  const sendEmail = useCallback(
    async (card: BillingPurchasedGiftCard, email: string): Promise<BillingSendGiftCardEmailResult> => {
      const freshness = freshnessRef.current;
      const result = await billingApi.sendPurchasedGiftCardEmail(card.cardId, email);
      if (!mountedRef.current) return result;
      if (result.ok && freshness !== freshnessRef.current) {
        emailRoundsRef.current = 0;
        void reload();
      } else if (result.ok) {
        emailRoundsRef.current = 0;
        freshnessRef.current += 1;
        mergeCards([result.card]);
      } else if (result.reason === 'NOT_AVAILABLE') {
        void reload();
      }
      return result;
    },
    [mergeCards, reload],
  );

  const inFlight = state.cards.some(isGiftCardEmailInFlight);
  const visible = useDocumentVisible(inFlight);
  const refreshingRef = useRef(false);
  // 每轮刷新结束（成功或失败）都推进一次，失败时卡片没变也会排上下一轮，总轮数仍受上限约束。
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!inFlight || !visible || state.loading) return undefined;
    if (emailRoundsRef.current >= EMAIL_REFRESH_MAX_ROUNDS) return undefined;
    const timer = window.setTimeout(() => {
      if (refreshingRef.current || !mountedRef.current) return;
      refreshingRef.current = true;
      emailRoundsRef.current += 1;
      const freshness = freshnessRef.current;
      // 只重读发送中的卡所在的那几页并合并最新状态，不重置用户已经加载的后续分页。
      const cursors = [...new Set(
        state.cards
          .filter(isGiftCardEmailInFlight)
          .map((card) => pageOfCardRef.current.get(card.cardId) ?? null),
      )].slice(0, EMAIL_REFRESH_MAX_PAGES);
      void (async () => {
        const pages = [];
        for (const cursor of cursors) pages.push(await billingApi.listPurchasedGiftCards(PAGE_SIZE, cursor ?? undefined));
        return pages;
      })()
        .then((pages) => {
          // 期间列表已从别的途径更新：这份快照可能更旧，丢掉，下一轮再读。
          if (mountedRef.current && freshness === freshnessRef.current) mergeCards(pages.flatMap((page) => page.cards));
        })
        .catch(() => {
          // 状态刷新失败不打扰用户；下次进入计费页或手动刷新时再读。
        })
        .finally(() => {
          refreshingRef.current = false;
          if (mountedRef.current) setRefreshTick((tick) => tick + 1);
        });
    }, EMAIL_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight, mergeCards, refreshTick, state.cards, state.loading, visible]);

  return { state, reload, loadMore, reveal, copy, forget, forgetCode, sendEmail };
}

export type PurchasedGiftCards = ReturnType<typeof usePurchasedGiftCards>;
