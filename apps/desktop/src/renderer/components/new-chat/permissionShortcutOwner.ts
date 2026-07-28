/**
 * 权限卡片 window 级快捷键的**唯一归属**登记处。
 *
 * 为什么需要它:PermissionPrompt 的 Enter / Esc / Shift+Tab 挂在 window 上,而
 * CCAgentSessionView 是多实例的 —— Orca 协同 tab 打开时 lead 与 focused worker
 * 各挂一个,两边的 viewVisible 都是 true。仅靠"可见"过滤只能排除隐藏的卡片,
 * 两张同时可见的卡片仍会各注册一个 handler,于是一次按键把两个会话的 pending
 * 一起结掉(Shift+Tab 尤其隐蔽:切档会连带 dismissAllPending)。
 *
 * 规则:LIFO —— 最近获得资格的那张卡拥有键盘,它退场后所有权自动交还给上一张。
 * 「最近出现的卡片接管键盘」符合用户直觉,也与栈式弹层的焦点惯例一致。
 *
 * 只登记"有资格"的卡片(可见 / 已 portal 到可见槽位);没资格的根本不进栈。
 */

let stack: symbol[] = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

/** 进栈并取得所有权;返回退栈函数(在 effect cleanup 里调用)。 */
export function acquirePermissionShortcutOwnership(token: symbol): () => void {
  stack.push(token);
  notify();
  return () => {
    const index = stack.lastIndexOf(token);
    if (index === -1) return;
    stack = [...stack.slice(0, index), ...stack.slice(index + 1)];
    notify();
  };
}

/** 当前持有键盘的卡片 token;无人登记时为 null。 */
export function getPermissionShortcutOwner(): symbol | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

export function subscribePermissionShortcutOwner(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
