import { globalShortcut } from 'electron';

/** 共用一个 OS Esc 注册；截图优先于语音，释放任一使用方不会注销其他人的按键。 */
const owners = new Map<symbol, { priority: number; cancel: () => void }>();

export function acquireOverlayEscape(cancel: () => void, priority = 0): (() => void) | null {
  if (owners.size === 0) {
    try {
      if (
        !globalShortcut.register('Escape', () => {
          const current = [...owners.values()].sort((a, b) => b.priority - a.priority)[0];
          current?.cancel();
        })
      )
        return null;
    } catch {
      return null;
    }
  }
  const key = Symbol();
  owners.set(key, { cancel, priority });
  return () => {
    if (!owners.delete(key)) return;
    if (owners.size === 0) globalShortcut.unregister('Escape');
  };
}
