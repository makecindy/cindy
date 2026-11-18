import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type {
  BillingPurchasedGiftCard,
  BillingPurchasedGiftCardCode,
} from '../../../shared/billing';
import { billingApi } from './api';

const PAGE_SIZE = 20;

export type PurchasedGiftCardsState = {
  cards: BillingPurchasedGiftCard[];
  nextCursor: string | null;
  loading: boolean;
  /** 首次加载完成前为 false；之后列表为空即表示没买过卡。 */
  loaded: boolean;
  error: boolean;
};

const INITIAL: PurchasedGiftCardsState = {
  cards: [],
  nextCursor: null,
  loading: false,
  loaded: false,
  error: false,
};

/**
 * 我买的礼品卡：进入计费页、买完、兑换后各读一次第一页，不轮询。兑换码只在复制或
 * 兑换时向服务端取，按卡在内存里留到页面卸载，同一张卡反复复制不再请求。
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
      setState({ cards: page.cards, nextCursor: page.nextCursor, loading: false, loaded: true, error: false });
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

  return { state, reload, loadMore, reveal, copy, forget };
}

export type PurchasedGiftCards = ReturnType<typeof usePurchasedGiftCards>;
