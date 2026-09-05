import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  AccessibilityInfo,
  Keyboard,
  LayoutAnimation,
  Platform,
  useWindowDimensions,
  type KeyboardEvent,
  type KeyboardMetrics,
} from 'react-native';
import type { LoginKeyboardRect } from '@/auth/loginKeyboardAvoidance';
import { isDockedKeyboard } from '@/auth/loginKeyboardAvoidance';
import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';

export interface MobileKeyboardState {
  /** 窗口底部实际被遮挡的高度，交互式收起时不等于键盘自身高度。 */
  height: number;
  visible: boolean;
  /** 事件先配置动画再更新布局；卡片切换据此让出同一次布局的动画控制权。 */
  transition: RefObject<{ event: KeyboardEvent; startedAt: number } | null>;
}

/**
 * 跟踪软键盘的可见性与高度。
 *
 * iOS 的输入卡片、消息区域和避让容器共用这份坐标与动画，不再让 KAV
 * 另行监听 show/hide 并覆盖动画。Android 保留 KAV 的 did 事件避让。
 */
export function useMobileKeyboardState(): MobileKeyboardState {
  const viewport = useWindowDimensions();
  const [state, setState] = useState(() => {
    // Web 的 Keyboard shim 没有原生几何快照 API，沿用零占位初值。
    if (Platform.OS === 'web') return { shown: false, frame: null };
    const frame = Keyboard.metrics() ?? null;
    return {
      shown: Keyboard.isVisible(),
      // 已开键盘时导航进来，也先排除 cross-fade 的 screenY=0 特例。
      frame: Platform.OS === 'ios' && frame?.screenY === 0 ? null : frame,
    };
  });
  const snapshot = useRef(state);
  const transition = useRef<MobileKeyboardState['transition']['current']>(null);

  useLayoutEffect(() => {
    let disposed = false;
    let shown = snapshot.current.shown;
    let latestEvent: KeyboardEvent | null = null;
    const publish = (event: KeyboardEvent, frame: KeyboardMetrics | null) => {
      // cross-fade 查询晚于 hide / 下一次 frame 返回时，不得恢复旧键盘占位。
      if (disposed || latestEvent !== event) return;
      const previous = snapshot.current;
      if (previous.shown === shown && sameKeyboardFrame(previous.frame, frame)) return;
      const next = { shown, frame };
      snapshot.current = next;
      transition.current = { event, startedAt: Date.now() };
      if (Platform.OS === 'ios') {
        if (getCachedReduceMotionEnabled() === false && event.duration > 0) {
          Keyboard.scheduleLayoutAnimation(event);
        } else {
          // 零时长是直接跟手；也清掉同一帧此前可能排入的卡片动画。
          LayoutAnimation.configureNext({ duration: 0, update: { duration: 0, type: 'linear' } });
        }
      }
      setState(next);
    };
    const update = (event: KeyboardEvent) => {
      latestEvent = event;
      if (Platform.OS === 'ios' && shown && event.endCoordinates.screenY === 0) {
        // 保留 RN KAV 的系统交叉淡化兼容：此时 screenY=0 不是全屏遮挡。
        void AccessibilityInfo.prefersCrossFadeTransitions()
          .then((crossFade) => publish(event, crossFade ? null : event.endCoordinates))
          .catch(() => publish(event, event.endCoordinates));
      } else {
        publish(event, shown ? event.endCoordinates : null);
      }
    };
    const subscriptions = [
      Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
        (event) => { shown = true; update(event); },
      ),
      Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
        (event) => { shown = false; update(event); },
      ),
    ];
    if (Platform.OS === 'ios') {
      subscriptions.push(Keyboard.addListener('keyboardWillChangeFrame', (event) => {
        // undock 会先 frame 再 hide；hide 后的 frame 不能独自重新显示键盘。
        if (shown) update(event);
      }));
      // 导航可发生在 will 与 did 之间；RN 的 metrics 缓存只在 did 时更新。
      // 最终事件负责补齐挂载前错过的变化，时长归零避免把已结束的动画重播。
      subscriptions.push(
        Keyboard.addListener('keyboardDidShow', (event) => {
          shown = true;
          update({ ...event, duration: 0 });
        }),
        Keyboard.addListener('keyboardDidHide', (event) => {
          shown = false;
          update({ ...event, duration: 0 });
        }),
        Keyboard.addListener('keyboardDidChangeFrame', (event) => {
          if (shown) update({ ...event, duration: 0 });
        }),
      );
      const initialFrame = Keyboard.metrics();
      if (shown && initialFrame?.screenY === 0) {
        update({ duration: 0, easing: 'keyboard', endCoordinates: initialFrame });
      }
    }
    return () => {
      disposed = true;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  const frame = state.shown ? state.frame : null;
  const height = !frame ? 0 : Platform.OS === 'ios'
    ? isDockedKeyboard({ x: frame.screenX, y: frame.screenY, ...frame }, viewport.width)
      && frame.screenY + frame.height >= viewport.height
      ? Math.max(0, Math.min(frame.height, viewport.height - frame.screenY))
      : 0
    : Math.max(0, frame.height);
  return { height, visible: height > 0, transition };
}

function sameKeyboardFrame(a: KeyboardMetrics | null, b: KeyboardMetrics | null): boolean {
  return a === b || (a !== null && b !== null
    && a.screenX === b.screenX && a.screenY === b.screenY
    && a.width === b.width && a.height === b.height);
}

/** 登录键盘契约的完整矩形状态(visible + endCoordinates 矩形)。 */
export interface LoginKeyboardRectState {
  visible: boolean;
  rect: LoginKeyboardRect | null;
}

/**
 * 登录键盘避让 hook(PR4b Step 5b.1):在可见性之外暴露完整 endCoordinates
 * 矩形(x/y/width/height),供 computeLoginKeyboardShift 做停靠/悬浮二维判定。
 *
 * iOS 订阅升级(v6.7):在 keyboardWillShow/Hide 基础上增订 keyboardWillChangeFrame
 * ——悬浮键盘拖动/分离/重停靠等「已显示后改 frame」事件仅经此通道派发,
 * 不订阅则浮动键盘仅首开正确、移动后判定失效;Android 只有 did 事件。
 * 组件卸载时全部移除监听。
 */
export function useLoginKeyboardRect(): LoginKeyboardRectState {
  const [state, setState] = useState<LoginKeyboardRectState>({
    visible: false,
    rect: null,
  });

  useEffect(() => {
    const toRect = (event: KeyboardEvent): LoginKeyboardRect | null => {
      const end = event.endCoordinates;
      if (!end) return null;
      return { x: end.screenX, y: end.screenY, width: end.width, height: end.height };
    };
    const subscriptions = [
      Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
        (event) => setState({ visible: true, rect: toRect(event) }),
      ),
      Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
        () => setState({ visible: false, rect: null }),
      ),
    ];
    if (Platform.OS === 'ios') {
      subscriptions.push(
        Keyboard.addListener('keyboardWillChangeFrame', (event) => {
          // 仅在已显示后更新 frame(show/hide 自身也会派发本事件,避免抢先置位)
          setState((prev) =>
            prev.visible ? { visible: true, rect: toRect(event) } : prev,
          );
        }),
      );
    }
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return state;
}
