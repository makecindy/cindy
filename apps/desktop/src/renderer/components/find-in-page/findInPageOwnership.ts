/**
 * findInPageOwnership — Ctrl/Cmd+F 接管令牌。
 *
 * 默认情况下,App 根上挂了一个 FindInPageBar,它在 window 上 capture 阶段截
 * Ctrl+F,驱动 Chromium 原生的 webContents.findInPage。但有些场景需要把搜
 * 索改成自己的 in-doc 搜索(例如 doc 模式的 FileBodyView),不希望全局那个
 * 搜索条同时弹出。
 *
 * 简单做"我也注册一个 capture 监听 + stopImmediatePropagation"是错的:同
 * 一 target 同 phase 的监听按注册顺序触发,App 根的 bar 先注册,先跑,
 * 后挂的接管者来不及拦。
 *
 * 这里用引用计数:接管者 mount 时 acquire,unmount 时 release。FindInPageBar
 * 自己的 handler 内部检查计数,>0 就直接 bail,让位给接管者。这样谁先注册
 * 都不影响。计数而非布尔是为了保证嵌套/并发的 mount 也能正确 release。
 */

let claimCount = 0;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function acquireFindInPage(): () => void {
  claimCount += 1;
  notifyListeners();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claimCount = Math.max(0, claimCount - 1);
    notifyListeners();
  };
}

export function isFindInPageClaimed(): boolean {
  return claimCount > 0;
}

export function subscribeFindInPageClaim(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
