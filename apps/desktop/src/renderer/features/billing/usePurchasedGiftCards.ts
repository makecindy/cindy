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
import { billingApi } from './api';

const PAGE_SIZE = 20;
/** 发到邮箱是异步的：还在排队或发送中的卡，隔一会儿重读一次第一页，最多几次，窗口隐藏时暂停。 */
export const EMAIL_REFRESH_DELAY_MS = 5_000;
export const EMAIL_REFRESH_MAX_ROUNDS = 6;

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
 * 隔 5 秒重读第一页并合并进列表，最多 6 次，窗口隐藏时不读。
 */
export function usePurchasedGiftCards() {
  const { t } = useTranslation();
  const [state, setState] = useState<PurchasedGiftCardsState>(INITIAL);
  const generationRef = useRef(0);
  const codesRef = useRef(new Map<string, BillingPurchasedGiftCardCode>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      codesRef.current.clear();
    };
  }, []);

  const reload = useCallback(async (): Promise<BillingPurchasedGiftCard[] | null> => {
    const generation = ++generationRef.current;
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const page = await billingApi.listPurchasedGiftCards(PAGE_SIZE);
      if (!mountedRef.current || generation !== generationRef.current) return null;
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
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const page = await billingApi.listPurchasedGiftCards(PAGE_SIZE, cursor);
      if (!mountedRef.current || generation !== generationRef.current) return;
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
        codesRef.current.set(card.cardId, result);
        return result;
      } catch (error) {
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
        toast.error(t('billing.giftCardPurchase.toasts.copyFailed'));
        return false;
      }
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

  /** 用服务端返回的最新卡片替换列表里同一张卡（不在列表里的忽略）。 */
  const mergeCards = useCallback((updated: BillingPurchasedGiftCard[]) => {
    const byId = new Map(updated.map((card) => [card.cardId, card]));
    setState((current) => ({
      ...current,
      cards: current.cards.map((card) => byId.get(card.cardId) ?? card),
    }));
  }, []);

  const emailRoundsRef = useRef(0);

  /** 发到邮箱；成功后就地更新这张卡并重新开始有限次的状态刷新。 */
  const sendEmail = useCallback(
    async (card: BillingPurchasedGiftCard, email: string): Promise<BillingSendGiftCardEmailResult> => {
      const result = await billingApi.sendPurchasedGiftCardEmail(card.cardId, email);
      if (!mountedRef.current) return result;
      if (result.ok) {
        emailRoundsRef.current = 0;
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
  useEffect(() => {
    if (!inFlight || !visible || state.loading) return undefined;
    if (emailRoundsRef.current >= EMAIL_REFRESH_MAX_ROUNDS) return undefined;
    const timer = window.setTimeout(() => {
      if (refreshingRef.current || !mountedRef.current) return;
      refreshingRef.current = true;
      emailRoundsRef.current += 1;
      // 只合并第一页里的最新状态，不重置用户已经加载的后续分页。
      void billingApi
        .listPurchasedGiftCards(PAGE_SIZE)
        .then((page) => {
          if (mountedRef.current) mergeCards(page.cards);
        })
        .catch(() => {
          // 状态刷新失败不打扰用户；下次进入计费页或手动刷新时再读。
        })
        .finally(() => {
          refreshingRef.current = false;
        });
    }, EMAIL_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight, mergeCards, state.cards, state.loading, visible]);

  return { state, reload, loadMore, reveal, copy, forget, sendEmail };
}

export type PurchasedGiftCards = ReturnType<typeof usePurchasedGiftCards>;
