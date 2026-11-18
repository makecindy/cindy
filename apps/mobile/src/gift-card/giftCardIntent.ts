import { giftCardCodeFromInput } from '@cindy/maker-shared/gift-card';
import { useSyncExternalStore } from 'react';

/**
 * 当前要兑换的礼品卡：只在内存里，一次一张。
 *
 * 兑换码等同于余额，不进路由参数、诊断或持久化存储；登录或切换账号期间保留，
 * 登录完成后由根级 GiftCardHost 呈现。
 */
export interface GiftCardIntent {
  readonly id: number;
  /** 链接带来的兑换码；从设置里手动打开时没有。 */
  readonly code?: string;
  /** 链接指向礼品卡，但里面没有可用的兑换码。 */
  readonly invalidLink?: true;
}

let current: GiftCardIntent | null = null;
let sequence = 0;
/** 领取请求在途时不换卡：结果必须回到发起它的那张面板上。 */
let busyId: number | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/**
 * 礼品卡唤起链接（`cindy://gift/<code>`、`cindycn://gift/<code>`）与分享网页地址
 * （`https://<share host>/gift#<code>`）。残缺的链接也算，保证兑换码不会落到 404 页的路由状态里。
 */
export function isGiftCardLinkPath(path: string): boolean {
  const beforePayload = path.split(/[?#]/, 1)[0];
  return /^(?:https?:\/\/[^/]+\/|[a-z][\w+.-]*:\/\/|\/)?gift(?:\/|$)/i.test(beforePayload);
}

/** 收下一条礼品卡链接。返回 true 表示这是礼品卡链接，调用方不应再把它交给路由。 */
export function receiveGiftCardLink(path: string): boolean {
  if (!isGiftCardLinkPath(path)) return false;
  // Router 可能给完整链接，也可能只给路径；统一成 `scheme://gift/<code>` 再取兑换码。
  const link = /^[a-z][\w+.-]*:\/\//i.test(path) ? path : `cindy://${path.replace(/^\/+/, '')}`;
  const code = giftCardCodeFromInput(link) ?? undefined;
  if (current) {
    if (busyId === current.id || (code !== undefined && current.code === code)) return true;
  }
  current = code ? { id: ++sequence, code } : { id: ++sequence, invalidLink: true };
  notify();
  return true;
}

/** 设置页的「兑换礼品卡」与外部链接共用同一个面板；已有面板时不叠第二个。 */
export function openManualGiftCard(): void {
  if (current) return;
  current = { id: ++sequence };
  notify();
}

export function setGiftCardBusy(id: number, busy: boolean): void {
  if (busy) busyId = id;
  else if (busyId === id) busyId = null;
}

/** 旧面板的回调关不掉新的礼品卡。 */
export function closeGiftCard(id: number): void {
  if (busyId === id) busyId = null;
  if (current?.id !== id) return;
  current = null;
  notify();
}

export const getGiftCardIntent = () => current;
export function subscribeGiftCardIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useGiftCardIntent = () => useSyncExternalStore(
  subscribeGiftCardIntent, getGiftCardIntent, getGiftCardIntent,
);
