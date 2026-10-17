import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createElement, useRef, type ReactNode } from 'react';

import { useMobileKeyboardState, type MobileKeyboardState } from '@/session/useMobileKeyboardState';

interface AndroidKeyboardLiftInput {
  /** endCoordinates.height：IME 高度（RN 已减去系统栏底）。 */
  imeHeight: number;
  /** SafeAreaView 已扣掉的底部 inset（导航栏）；不重复扣除，避免多抬一段空白。 */
  systemBarBottom: number;
  /** 键盘未弹起时的全屏高（useWindowDimensions 稳态高度；0 / NaN 表示未知）。 */
  fullHeight: number;
  /** 当前 viewport 高（Android 键盘弹起后可能不变，也可能被旧系统缩窗）。 */
  viewportHeight: number;
  /** endCoordinates.screenY：窗口可见区底边（缩窗时 = 键盘顶边，未缩窗时 = 窗口底边）。 */
  windowVisibleBottom: number | null;
}

/**
 * Android edge-to-edge 下全屏输入页要补的键盘让位高度。
 *
 * edge-to-edge（Android 15+ targetSdk 35、Android 16 强制）下系统不再为 IME 缩窗：
 * 只依赖 adjustResize 的输入面拿不到任何让位，KAV(behavior='height') 依赖的 viewport
 * 变化也不再发生。这里按「键盘整体高度 − 系统已让出的高度」补差值，几何与
 * auth/loginKeyboardAvoidance.ts 的 U-8b / 2026-07-21 结论一致；旧系统真的缩窗时
 * 差值为 0，不会叠加。系统栏底只算一次：SafeAreaView 已扣的 inset 不重复扣除。
 */
export function computeAndroidKeyboardInsetLift(input: AndroidKeyboardLiftInput): number {
  const imeFullHeight = Math.max(0, input.imeHeight) + Math.max(0, input.systemBarBottom);
  if (imeFullHeight <= 0) return 0;
  const shrinkKnown = Number.isFinite(input.fullHeight) && input.fullHeight > 0
    && Number.isFinite(input.viewportHeight) && input.viewportHeight > 0;
  const screenShrink = shrinkKnown
    ? Math.max(0, input.fullHeight - input.viewportHeight)
    : 0;
  const shrunk = screenShrink > KEYBOARD_RESIZE_THRESHOLD;
  if (!shrunk) return Math.round(imeFullHeight);
  // 系统确实缩了窗：已让出高度取「缩窗量」与「可见区底边以下的高度」中更保守的较小值,
  // 键盘事件来自另一个 window root（screenY 退化为窗口底边）时按缩窗量全额抵扣。
  const visibleBelow = input.windowVisibleBottom != null && Number.isFinite(input.windowVisibleBottom)
    ? Math.max(0, input.fullHeight - Math.max(0, input.windowVisibleBottom))
    : screenShrink;
  // screenY 退化为窗口底边（事件来自另一个 window root）时，可见区没有真实让位证据,
  // 按缩窗量全额抵扣；两个证据都有值时取更保守的较小值，避免把让位算大顶过键盘。
  const reservedBySystem = input.windowVisibleBottom != null
    && Number.isFinite(input.windowVisibleBottom)
    && input.windowVisibleBottom < input.viewportHeight
    ? Math.min(screenShrink, visibleBelow)
    : screenShrink;
  return Math.max(0, Math.round(imeFullHeight - reservedBySystem));
}

const KEYBOARD_RESIZE_THRESHOLD = 10;

/**
 * 全屏输入页的键盘避让容器（SafeAreaView 下 flex:1 的内容层）。
 *
 * iOS 继续走 KAV padding；Android 用同一 hook 的实测差值做 paddingBottom，flex 布局会把
 * 输入区与底部操作抬到键盘上方。旧系统 / 未开 edge-to-edge 时差值为 0，行为不变。
 */
export function KeyboardAvoidingFlex({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  if (Platform.OS === 'ios') {
    return createElement(
      KeyboardAvoidingView,
      { behavior: 'padding', style: styles.flex, testID },
      children,
    );
  }
  return createElement(AndroidKeyboardAvoidingFlex, { testID, children });
}

function AndroidKeyboardAvoidingFlex({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  // Android 也订阅键盘：让位按实测差值计算，缩窗设备上为 0，不会与 adjustResize 叠加。
  const keyboard = useMobileKeyboardState();
  const insets = useSafeAreaInsets();
  const { height: viewportHeight } = useWindowDimensions();
  const fullHeight = useStableFullHeight(viewportHeight, keyboard.visible);
  const lift = computeAndroidKeyboardInsetLift({
    imeHeight: keyboard.height,
    systemBarBottom: insets.bottom,
    fullHeight,
    viewportHeight,
    windowVisibleBottom: keyboard.screenY,
  });
  return createElement(
    View,
    { style: [styles.flex, lift > 0 ? { paddingBottom: lift } : null], testID },
    children,
  );
}

/** 键盘未弹起时跟踪全屏高；弹起期间冻结，防止把键盘顶边误记成窗口变化。 */
function useStableFullHeight(viewportHeight: number, keyboardVisible: boolean): number {
  const fullHeight = useRef(viewportHeight);
  if (!keyboardVisible && fullHeight.current !== viewportHeight) {
    fullHeight.current = viewportHeight;
  }
  return fullHeight.current;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
