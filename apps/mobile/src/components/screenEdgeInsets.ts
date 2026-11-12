import { useEffect } from 'react';
import { Dimensions, Platform } from 'react-native';

/** Four edges are independent on resizable displays. The old rotation workaround
 * is opt-in for legacy phone layouts, never inferred from an inset's shape alone. */

export interface ScreenEdgeInsetsInput {
  /** 残留形态下 top 的兜底值(最近一次稳定竖屏 top);不传则残留帧 top 为 0。 */
  fallbackPortraitTop?: number;
  legacyPhoneLayout?: boolean;
  insets: { top: number; left: number; right: number };
  windowHeight: number;
  windowWidth: number;
}

/** Only a compact, full-display Android window uses the legacy phone workaround.
 * Split/freeform windows and tablet/foldable interiors retain independent edges. */
export function isLegacyPhoneWindow(input: {
  platform: string; iosPad: boolean; version: string | number;
  windowWidth: number; windowHeight: number;
  screenWidth: number; screenHeight: number;
}): boolean {
  if (input.platform === 'ios') return !input.iosPad && Number.parseInt(String(input.version), 10) < 27;
  if (input.platform !== 'android') return false;
  const { screenWidth, screenHeight, windowWidth, windowHeight } = input;
  return Math.min(screenWidth, screenHeight) > 0 && Math.min(screenWidth, screenHeight) < 600
    && Math.abs(windowWidth - screenWidth) < 1
    // Android may exclude status/navigation bars from the application window.
    && screenHeight >= windowHeight && screenHeight - windowHeight <= 96;
}

export interface ScreenEdgePadding {
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
}

/** 模块级「最近一次稳定竖屏 top」记忆,跨页面实例存活(见文件头注释)。 */
let stablePortraitTopMemory = 0;

export function resolveScreenEdgePadding(input: ScreenEdgeInsetsInput): ScreenEdgePadding {
  const top = sanitize(input.insets.top);
  const left = sanitize(input.insets.left);
  const right = sanitize(input.insets.right);
  const portrait = input.windowHeight > input.windowWidth;
  const landscapeResidue = input.legacyPhoneLayout === true && portrait && top <= 0 && (left > 0 || right > 0);
  if (landscapeResidue) {
    return {
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: sanitize(input.fallbackPortraitTop ?? 0),
    };
  }
  return { paddingLeft: left, paddingRight: right, paddingTop: top };
}

/** 竖屏且 top 有效时记入模块级记忆;横屏与残留形态(top=0)天然不满足条件,不会污染。 */
export function recordStablePortraitTop(input: {
  top: number;
  windowHeight: number;
  windowWidth: number;
}): void {
  if (input.windowHeight > input.windowWidth && Number.isFinite(input.top) && input.top > 0) {
    stablePortraitTopMemory = input.top;
  }
}

export function getStablePortraitTopMemory(): number {
  return stablePortraitTopMemory;
}

export function resetStablePortraitTopMemoryForTests(): void {
  stablePortraitTopMemory = 0;
}

/**
 * 页面容器三边 padding hook:commit 后记录稳定竖屏 top(残留过渡帧读到的必然是
 * 此前正常帧或上一个页面实例记入的值),渲染期解析当前 insets。
 */
export function useScreenEdgePadding(input: {
  insets: { top: number; left: number; right: number };
  legacyPhoneLayout?: boolean;
  windowHeight: number;
  windowWidth: number;
}): ScreenEdgePadding {
  const { insets, windowHeight, windowWidth } = input;
  useEffect(() => {
    recordStablePortraitTop({ top: insets.top, windowHeight, windowWidth });
  }, [insets.top, windowHeight, windowWidth]);
  return resolveScreenEdgePadding({
    legacyPhoneLayout: input.legacyPhoneLayout ?? isLegacyPhoneWindow({
      platform: Platform.OS, iosPad: Platform.OS === 'ios' && Platform.isPad,
      version: Platform.Version, windowWidth, windowHeight,
      screenWidth: Dimensions.get('screen').width, screenHeight: Dimensions.get('screen').height,
    }),
    fallbackPortraitTop: getStablePortraitTopMemory(),
    insets,
    windowHeight,
    windowWidth,
  });
}

function sanitize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
