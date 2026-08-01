import { useEffect, useState } from 'react';

import { getAppShortcutPlatform } from '../lib/appShortcutStore';

export interface UseModifierHoldOptions {
  /** false 时不挂监听且状态归零。默认 true。 */
  enabled?: boolean;
  /** 按住多久才算 hold(ms)。默认 500。 */
  delayMs?: number;
}

const DEFAULT_HOLD_DELAY_MS = 500;

/**
 * 「按住主修饰键」检测: mac ⌘ / 其它平台 Ctrl 持续按住 delayMs 后返回 true,
 * 松开立即回落 false。给「按住修饰键浮现快捷键提示」类 UI 做门控 —— 延迟的
 * 意义是 ⌘C / ⌘1 等快速组合根本来不及触发提示, 只有真正按住犹豫的用户才看到。
 *
 * 修饰键状态直接读每次 keydown / keyup / pointermove 的 metaKey / ctrlKey
 * (松开修饰键的 keyup 里对应 flag 已为 false, 松开其它键不受影响), 不跟踪
 * 具体键位。pointermove 兜底覆盖「keyup 被吞」的场景 —— 按住修饰键期间打开
 * 原生上下文菜单再松开, keyup 不会投递到 renderer, 靠下一次鼠标移动的真实
 * flags 复位。window blur 兜底复位 —— mac 上按住 ⌘ 点别的窗口会丢 keyup,
 * 不兜底状态会卡在按住态。设置页快捷键录制期间(body dataset 旗标, 与
 * useAppShortcut 同口径)一律视为未按住, 录制时按修饰键是常态, 不该弹提示。
 */
export function useModifierHold(options: UseModifierHoldOptions = {}): boolean {
  const { enabled = true, delayMs = DEFAULT_HOLD_DELAY_MS } = options;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const isDarwin = getAppShortcutPlatform() === 'darwin';
    let timer: number | null = null;
    let active = false;

    const sync = (modifierDown: boolean) => {
      if (modifierDown) {
        if (active || timer != null) return;
        timer = window.setTimeout(() => {
          timer = null;
          active = true;
          setHeld(true);
        }, delayMs);
        return;
      }
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (active) {
        active = false;
        setHeld(false);
      }
    };

    const probe = (event: { metaKey: boolean; ctrlKey: boolean }) => {
      if (document.body.dataset.appShortcutRecording === '1') {
        sync(false);
        return;
      }
      sync(isDarwin ? event.metaKey : event.ctrlKey);
    };
    const reset = () => sync(false);

    window.addEventListener('keydown', probe, true);
    window.addEventListener('keyup', probe, true);
    window.addEventListener('pointermove', probe, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', probe, true);
      window.removeEventListener('keyup', probe, true);
      window.removeEventListener('pointermove', probe, true);
      window.removeEventListener('blur', reset);
      if (timer != null) window.clearTimeout(timer);
      setHeld(false);
    };
  }, [enabled, delayMs]);

  return held;
}
