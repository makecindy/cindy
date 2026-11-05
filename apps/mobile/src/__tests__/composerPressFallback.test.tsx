/**
 * 「按下即生效」兜底:安卓可能在一次按压的中途取消手势(第三方输入法抢输入焦点),
 * `onPress` 永不到达,按钮只闪一下就没了。兜底必须做到:
 * - 正常松手仍然立即触发一次(不能变成两次);
 * - 手势被系统取消(只有按下、没有松手)时,宽限到期后照样触发;
 * - 按下后明显拖动视为放弃,不触发(否则划过按钮就误发)。
 */
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  COMPOSER_PRESS_FALLBACK_DELAY_MS,
  useComposerPressFallback,
  type ComposerPressFallback,
} from '@/session/composerPressFallback';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });

function renderFallback(options: { enabled?: boolean; onPress?: () => void } = {}) {
  const onPress = options.onPress ?? vi.fn();
  let api: ComposerPressFallback | null = null;
  function Probe({ enabled }: { enabled: boolean }) {
    api = useComposerPressFallback({ enabled, onPress });
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(createElement(Probe, { enabled: options.enabled !== false })));
  return {
    onPress,
    api: () => api!,
    rerender: (enabled: boolean) => act(() => root!.render(createElement(Probe, { enabled }))),
  };
}

it('fires the action once when the press is released normally', () => {
  const { onPress, api } = renderFallback();
  act(() => {
    api().beginPress(10, 20);
    api().finishPress();
  });
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS * 2); });
  expect(onPress).not.toHaveBeenCalled();
});

it('fires the action after the grace period when the release never arrives', () => {
  const { onPress, api } = renderFallback();
  act(() => { api().beginPress(10, 20); });
  expect(onPress).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS); });
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('does not fire after the user drags away from the button', () => {
  const { onPress, api } = renderFallback();
  act(() => { api().beginPress(10, 20); });
  act(() => { api().movePress(10, 80); });
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS * 2); });
  expect(onPress).not.toHaveBeenCalled();
});

it('keeps a small finger drift inside the tolerance', () => {
  const { onPress, api } = renderFallback();
  act(() => { api().beginPress(10, 20); });
  act(() => { api().movePress(12, 24); });
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS); });
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('never fires when the fallback is disabled', () => {
  const { onPress, api } = renderFallback({ enabled: false });
  act(() => { api().beginPress(10, 20); });
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS * 2); });
  expect(onPress).not.toHaveBeenCalled();
});

it('cancels the pending fallback when the control becomes disabled mid-press', () => {
  // 按下后 300ms 内按钮因断线/忙碌被禁用:兑底不得再触发(禁用态下不应打开面板或发送)。
  const { onPress, api, rerender } = renderFallback({ enabled: true });
  act(() => { api().beginPress(10, 20); });
  rerender(false);
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS * 2); });
  expect(onPress).not.toHaveBeenCalled();
});

it('reports that the fallback already ran so the release does not fire twice', () => {
  const { onPress, api } = renderFallback();
  act(() => { api().beginPress(10, 20); });
  act(() => { vi.advanceTimersByTime(COMPOSER_PRESS_FALLBACK_DELAY_MS); });
  expect(onPress).toHaveBeenCalledTimes(1);
  let alreadyFired = false;
  act(() => { alreadyFired = api().finishPress(); });
  expect(alreadyFired).toBe(true);
  expect(onPress).toHaveBeenCalledTimes(1);
});

