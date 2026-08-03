import { useEffect, useRef, useState } from 'react';

import { getAppShortcutPlatform } from '../lib/appShortcutStore';
import {
  isEarlyKeyDownCaptureInstalled,
  subscribeEarlyKeyDownCapture,
} from '../lib/earlyKeyDownCapture';

export interface UseModifierHoldOptions {
  /** false 时不挂监听且状态归零。默认 true。 */
  enabled?: boolean;
  /** 按住多久才算 hold(ms)。默认 500。 */
  delayMs?: number;
  /** 命中时该 keydown 属于当前提示快捷键,不中断长按态。 */
  preserveOnKeyDown?: (event: KeyboardEvent) => boolean;
}

const DEFAULT_HOLD_DELAY_MS = 500;

/**
 * 「单独按住主修饰键」检测: mac ⌘ / 其它平台 Ctrl 持续按住 delayMs
 * 后返回 true, 松开立即回落 false。给「按住修饰键浮现快捷键提示」类 UI
 * 做门控 —— 延迟的意义是 ⌘C / ⌘1 等快速组合根本来不及触发提示,
 * 只有真正按住犹豫的用户才看到。长按期间一旦按下任何其它键,
 * 本次长按就被视为组合键手势:提示立即消失,且要等主修饰键松开后才能重新触发。
 * 唯一例外是 preserveOnKeyDown 明确识别的当前提示快捷键
 * (例如任务序号提示的 mod+1..9),连续使用它们时长按态保留。
 *
 * 修饰键状态直接读每次 keydown / keyup / pointermove 的 modifier flags;
 * keydown 额外用 key 判断是否已按下其它键。pointermove 兜底覆盖
 * 「keyup 被吞」的场景 —— 按住修饰键期间打开
 * 原生上下文菜单再松开, keyup 不会投递到 renderer, 靠下一次鼠标移动的真实
 * flags 复位。window blur 兜底复位 —— mac 上按住 ⌘ 点别的窗口会丢 keyup,
 * 不兜底状态会卡在按住态。设置页快捷键录制期间(body dataset 旗标, 与
 * useAppShortcut 同口径)一律视为未按住, 录制时按修饰键是常态, 不该弹提示。
 */
export function useModifierHold(options: UseModifierHoldOptions = {}): boolean {
  const { enabled = true, delayMs = DEFAULT_HOLD_DELAY_MS, preserveOnKeyDown } = options;
  const [held, setHeld] = useState(false);
  const preserveOnKeyDownRef = useRef(preserveOnKeyDown);
  preserveOnKeyDownRef.current = preserveOnKeyDown;

  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const isDarwin = getAppShortcutPlatform() === 'darwin';
    const primaryModifierKey = isDarwin ? 'Meta' : 'Control';
    let timer: number | null = null;
    let qualified = false;
    let visible = false;
    let blocked = false;
    let modifierPrefix = false;
    let preservingShortcut = false;

    const setVisible = (nextVisible: boolean) => {
      if (visible === nextVisible) return;
      visible = nextVisible;
      setHeld(nextVisible);
    };
    const cancelTimer = () => {
      if (timer == null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const resetGesture = () => {
      cancelTimer();
      qualified = false;
      blocked = false;
      modifierPrefix = false;
      preservingShortcut = false;
      setVisible(false);
    };
    const startHoldTimer = () => {
      if (qualified || blocked || timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        qualified = true;
        if (!blocked && (!modifierPrefix || preservingShortcut)) setVisible(true);
      }, delayMs);
    };
    const blockGesture = () => {
      blocked = true;
      modifierPrefix = false;
      preservingShortcut = false;
      cancelTimer();
      setVisible(false);
    };
    const isModifierKey = (key: string) =>
      key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift';

    const isPrimaryModifierDown = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>) =>
      isDarwin ? event.metaKey : event.ctrlKey;
    const hasOtherModifier = (
      event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
    ) =>
      isDarwin
        ? event.ctrlKey || event.altKey || event.shiftKey
        : event.metaKey || event.altKey || event.shiftKey;
    const probeKey = (event: KeyboardEvent) => {
      if (document.body.dataset.appShortcutRecording === '1') {
        resetGesture();
        return;
      }
      // 主修饰键自身的 keyup 是最权威的释放信号。macOS 系统快捷键
      // (如 ⌘⇧⌃4 截图)可能让事件 flags 短暂滞后,不能因 metaKey / ctrlKey
      // 仍为 true 就把提示留在界面上。
      if (event.type === 'keyup' && event.key === primaryModifierKey) {
        resetGesture();
        return;
      }
      if (!isPrimaryModifierDown(event)) {
        resetGesture();
        return;
      }

      // 系统可能吞掉上一轮组合键的全部 keyup。新的非 repeat 主修饰键
      // keydown 是可靠的新手势边界;repeat 仍属于旧手势,不能借此解除 blocked。
      if (event.type === 'keydown' && event.key === primaryModifierKey && !event.repeat) {
        resetGesture();
        if (hasOtherModifier(event)) {
          modifierPrefix = true;
        } else {
          startHoldTimer();
        }
        return;
      }
      if (event.type === 'keydown' && event.key === primaryModifierKey) {
        return;
      }

      if (event.type === 'keyup') {
        if (isModifierKey(event.key) && modifierPrefix) blockGesture();
        else if (preservingShortcut && !hasOtherModifier(event)) preservingShortcut = false;
        return;
      }

      const preservesHold = preserveOnKeyDownRef.current?.(event) === true;
      if (preservesHold && !blocked) {
        modifierPrefix = false;
        preservingShortcut = hasOtherModifier(event);
        if (qualified) setVisible(true);
        return;
      }
      if (isModifierKey(event.key)) {
        modifierPrefix = true;
        preservingShortcut = false;
        setVisible(false);
        return;
      }
      blockGesture();
    };
    const probePointer = (event: PointerEvent) => {
      if (document.body.dataset.appShortcutRecording === '1') {
        resetGesture();
        return;
      }
      if (!isPrimaryModifierDown(event)) {
        resetGesture();
        return;
      }
      if (blocked) {
        setVisible(false);
        return;
      }
      if (hasOtherModifier(event)) {
        if (!preservingShortcut) {
          modifierPrefix = true;
          setVisible(false);
        }
        return;
      }
      if (modifierPrefix) {
        blockGesture();
        return;
      }
      preservingShortcut = false;
      if (qualified) setVisible(true);
    };

    const useEarlyCapture = isEarlyKeyDownCaptureInstalled();
    const unsubscribeEarlyKeyDown = useEarlyCapture
      ? subscribeEarlyKeyDownCapture(probeKey)
      : (): void => {};
    // 直接监听保留给未经过 renderer index bootstrap 的独立测试/预览环境。
    // 正式窗口优先由 earlyKeyDownCapture 投递,避免被其它快捷键的
    // stopImmediatePropagation 按注册顺序截断。
    if (!useEarlyCapture) window.addEventListener('keydown', probeKey, true);
    window.addEventListener('keyup', probeKey, true);
    window.addEventListener('pointermove', probePointer, true);
    window.addEventListener('blur', resetGesture);
    return () => {
      unsubscribeEarlyKeyDown();
      if (!useEarlyCapture) window.removeEventListener('keydown', probeKey, true);
      window.removeEventListener('keyup', probeKey, true);
      window.removeEventListener('pointermove', probePointer, true);
      window.removeEventListener('blur', resetGesture);
      cancelTimer();
      setHeld(false);
    };
  }, [enabled, delayMs]);

  return held;
}
