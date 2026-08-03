import { useEffect, useRef, useState } from 'react';

import { getAppShortcutPlatform } from '../lib/appShortcutStore';
import { subscribeEarlyKeyDownCapture } from '../lib/earlyKeyDownCapture';

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
    let active = false;
    let chorded = false;

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

    const isPrimaryModifierDown = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>) =>
      isDarwin ? event.metaKey : event.ctrlKey;
    const hasOtherModifier = (
      event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
    ) =>
      isDarwin
        ? event.ctrlKey || event.altKey || event.shiftKey
        : event.metaKey || event.altKey || event.shiftKey;
    const reset = () => {
      chorded = false;
      sync(false);
    };
    const probeKey = (event: KeyboardEvent) => {
      if (document.body.dataset.appShortcutRecording === '1') {
        sync(false);
        return;
      }
      // 主修饰键自身的 keyup 是最权威的释放信号。macOS 系统快捷键
      // (如 ⌘⇧⌃4 截图)可能让事件 flags 短暂滞后,不能因 metaKey / ctrlKey
      // 仍为 true 就把提示留在界面上。
      if (event.type === 'keyup' && event.key === primaryModifierKey) {
        reset();
        return;
      }
      if (!isPrimaryModifierDown(event)) {
        reset();
        return;
      }
      const preservesHold =
        event.type === 'keydown' && preserveOnKeyDownRef.current?.(event) === true;
      if (
        event.type === 'keydown' &&
        !preservesHold &&
        (event.key !== primaryModifierKey || hasOtherModifier(event))
      ) {
        chorded = true;
      }
      sync(!chorded && !hasOtherModifier(event));
    };
    const probePointer = (event: PointerEvent) => {
      if (document.body.dataset.appShortcutRecording === '1') {
        sync(false);
        return;
      }
      if (!isPrimaryModifierDown(event)) {
        reset();
        return;
      }
      if (hasOtherModifier(event)) chorded = true;
      sync(!chorded);
    };

    const unsubscribeEarlyKeyDown = subscribeEarlyKeyDownCapture(probeKey);
    // 直接监听保留给未经过 renderer index bootstrap 的独立测试/预览环境。
    // 正式窗口优先由 earlyKeyDownCapture 投递,避免被其它快捷键的
    // stopImmediatePropagation 按注册顺序截断。
    window.addEventListener('keydown', probeKey, true);
    window.addEventListener('keyup', probeKey, true);
    window.addEventListener('pointermove', probePointer, true);
    window.addEventListener('blur', reset);
    return () => {
      unsubscribeEarlyKeyDown();
      window.removeEventListener('keydown', probeKey, true);
      window.removeEventListener('keyup', probeKey, true);
      window.removeEventListener('pointermove', probePointer, true);
      window.removeEventListener('blur', reset);
      if (timer != null) window.clearTimeout(timer);
      setHeld(false);
    };
  }, [enabled, delayMs]);

  return held;
}
