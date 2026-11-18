/**
 * 从唤起链接带进来的兑换码，在导航到计费页的途中暂存在内存里。
 *
 * 兑换码等同于可领取的余额，不放进路由 URL：URL 会进入历史栈、页面埋点和日志。
 * 计费页消费 `intent=redeem-gift-card` 时取走一次，取走即清空。
 */
let pendingCode: string | null = null;

export function setPendingGiftCardCode(code: string): void {
  pendingCode = code;
}

export function takePendingGiftCardCode(): string | null {
  const code = pendingCode;
  pendingCode = null;
  return code;
}
