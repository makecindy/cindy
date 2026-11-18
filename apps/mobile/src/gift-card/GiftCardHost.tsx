import { useRef } from 'react';
import { GiftCardSheet } from './GiftCardSheet';
import { closeGiftCard, setGiftCardBusy, useGiftCardIntent } from './giftCardIntent';

/**
 * 礼品卡面板的唯一呈现者：设置页的入口与外部链接（`cindy://gift/<code>`）都经这里。
 * 未登录时收到的链接留在内存里，登录完成后再呈现。
 */
export function GiftCardHost({ ready }: { ready: boolean }) {
  const intent = useGiftCardIntent();
  // 关闭动画期间保留同一个面板实例；下一张卡用新的实例，不带上一张的状态。
  const presentedId = useRef<number | null>(null);
  if (intent && intent.id !== presentedId.current) presentedId.current = intent.id;
  const id = presentedId.current;
  if (id === null) return null;
  return <GiftCardSheet key={id} visible={ready && !!intent} code={intent?.code} invalidLink={intent?.invalidLink}
    onClose={() => closeGiftCard(id)} onBusyChange={busy => setGiftCardBusy(id, busy)} />;
}
