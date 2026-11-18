import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeGiftCard,
  getGiftCardIntent,
  isGiftCardLinkPath,
  openManualGiftCard,
  receiveGiftCardLink,
  setGiftCardBusy,
} from '@/gift-card/giftCardIntent';

const CODE = 'G0123456789ABCDE';
const OTHER = 'G0123456789ABCDF';
function clear() {
  const pending = getGiftCardIntent();
  if (pending) closeGiftCard(pending.id);
}
beforeEach(clear);
afterEach(clear);

// 兑换码等同于余额。链接进来后只允许留在内存的这一个意图里：这些用例钉住
// 「哪些链接算礼品卡」「同时只有一张」「领取在途时不换卡」三条规则。
describe('gift card link intent', () => {
  it('takes the code from every form the system may hand over', () => {
    for (const link of [
      `cindy://gift/${CODE}`,
      'cindycn://gift/G012-3456-789A-BCDE',
      `/gift/${CODE}`,
      `gift/${CODE}`,
      'https://share.cindy.app/gift?face=cat#G012-3456-789A-BCDE',
    ]) {
      expect(receiveGiftCardLink(link)).toBe(true);
      expect(getGiftCardIntent()).toMatchObject({ code: CODE });
      clear();
    }
  });

  it('still claims a broken gift link so its text never reaches the router', () => {
    for (const link of ['cindy://gift/', 'cindy://gift/NOT-A-CODE', '/gift', 'https://share.cindy.app/gift']) {
      expect(receiveGiftCardLink(link)).toBe(true);
      const intent = getGiftCardIntent();
      expect(intent?.invalidLink).toBe(true);
      expect(intent?.code).toBeUndefined();
      clear();
    }
  });

  it('leaves other links alone', () => {
    for (const link of ['cindy://auth?code=1', `cindy://chat-invite/${CODE}`, `cindy://sessions/gift/${CODE}`, '/gifts', '/settings', `cindy://giftcard/${CODE}`]) {
      expect(isGiftCardLinkPath(link)).toBe(false);
      expect(receiveGiftCardLink(link)).toBe(false);
    }
    expect(getGiftCardIntent()).toBeNull();
  });

  it('shows one card at a time: a new link replaces the open one, the same link does not restart it', () => {
    receiveGiftCardLink(`cindy://gift/${CODE}`);
    const first = getGiftCardIntent()!;
    receiveGiftCardLink(`cindycn://gift/${CODE}`);
    expect(getGiftCardIntent()).toBe(first);
    receiveGiftCardLink(`cindy://gift/${OTHER}`);
    expect(getGiftCardIntent()).toMatchObject({ code: OTHER });
    expect(getGiftCardIntent()!.id).not.toBe(first.id);
    // 旧面板的关闭回调不能关掉新的卡。
    closeGiftCard(first.id);
    expect(getGiftCardIntent()).toMatchObject({ code: OTHER });
  });

  it('does not swap the card while its redeem request is in flight', () => {
    receiveGiftCardLink(`cindy://gift/${CODE}`);
    const first = getGiftCardIntent()!;
    setGiftCardBusy(first.id, true);
    expect(receiveGiftCardLink(`cindy://gift/${OTHER}`)).toBe(true);
    expect(getGiftCardIntent()).toBe(first);
    setGiftCardBusy(first.id, false);
    receiveGiftCardLink(`cindy://gift/${OTHER}`);
    expect(getGiftCardIntent()).toMatchObject({ code: OTHER });
  });

  it('opens an empty panel from Settings without stacking on an open card', () => {
    openManualGiftCard();
    const manual = getGiftCardIntent()!;
    expect(manual.code).toBeUndefined();
    expect(manual.invalidLink).toBeUndefined();
    openManualGiftCard();
    expect(getGiftCardIntent()).toBe(manual);
    // 手动面板开着时点了礼品卡链接：换成链接里的那张卡。
    receiveGiftCardLink(`cindy://gift/${CODE}`);
    expect(getGiftCardIntent()).toMatchObject({ code: CODE });
  });
});
