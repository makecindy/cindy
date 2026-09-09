import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  formatAppShortcutCombo,
  matchesKeyboardEvent,
  type AppShortcutId,
} from '../../shared/appShortcuts';
import {
  getAppShortcutCombos,
  getAppShortcutPlatform,
  subscribeAppShortcuts,
} from '../lib/appShortcutStore';
import { isAppInteractionLocked } from '../lib/appInteractionLock';

export interface UseAppShortcutOptions {
  /** false 时不挂监听 (如 BrowserTabBody 仅 active tab 响应)。默认 true。 */
  enabled?: boolean;
  /**
   * 命中并消费后额外 stopImmediatePropagation —— 用于需要压制同阶段其它
   * capture 监听的场景 (缩放键、doc 内查找对全局查找的接管)。默认 false。
   */
  stopImmediate?: boolean;
}

/**
 * 应用级快捷键统一消费 hook。
 *
 * window capture 阶段监听 keydown, 用 shared registry 的生效组合匹配 (含用户
 * override, 改绑后热更新即时生效)。让路 guard 属于调用点的领域知识 —— handler
 * 返回 false 表示"本次不消费"(如输入框让路、findInPage claim 让位), hook 不做
 * 任何默认行为拦截; 返回 true 表示已消费, hook 执行 preventDefault +
 * stopPropagation (+ 可选 stopImmediatePropagation)。
 *
 * e.repeat / e.isComposing 一律跳过 (应用级快捷键都是 press-to-fire, 且不能
 * 干扰 IME 组合输入)。
 */
export function useAppShortcut(
  id: AppShortcutId,
  handler: (event: KeyboardEvent) => boolean,
  options: UseAppShortcutOptions = {},
): void {
  const { enabled = true, stopImmediate = false } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      // 设置页快捷键录制期间全体让路 —— 录制监听注册晚于业务监听, 无法靠
      // stopImmediatePropagation 压制, 用 body dataset 旗标做确定性互斥
      // (KeyboardShortcutsSection 录制态设置)。
      if (document.body.dataset.appShortcutRecording === '1') return;
      const combos = getAppShortcutCombos(id);
      if (combos.length === 0) return;
      if (!combos.some((combo) => matchesKeyboardEvent(event, combo))) return;
      if (isAppInteractionLocked()) {
        event.preventDefault();
        event.stopPropagation();
        if (stopImmediate) event.stopImmediatePropagation();
        return;
      }
      if (!handlerRef.current(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (stopImmediate) event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [id, enabled, stopImmediate]);
}

/**
 * 某快捷键的显示文本 (如 mac '⌘N' / win 'Ctrl+N'), 跟随用户 override 热更新。
 * 平台不可用 / 无组合时返回空串, 调用点据此隐藏 kbd 提示。
 */
export function useAppShortcutDisplay(id: AppShortcutId): string {
  const display = useSyncExternalStore(subscribeAppShortcuts, () => {
    const first = getAppShortcutCombos(id)[0];
    return first ? formatAppShortcutCombo(first, getAppShortcutPlatform()) : '';
  });
  return display;
}
