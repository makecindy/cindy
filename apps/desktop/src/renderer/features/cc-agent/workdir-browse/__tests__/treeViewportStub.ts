/**
 * 文件树组件测试的视口替身。
 *
 * jsdom 没有布局引擎：`HTMLElement.offsetHeight` / `clientHeight` 恒为 0，
 * @tanstack/react-virtual 拿到的视口高度就是 0 —— 一个行都不会渲染，测试也就
 * 无从断言。把这两个尺寸接本模块的变量后：
 *   - 默认 600px：小树的行会全部渲染（虚拟器至少产出视口内的行）；
 *   - 用例可显式置 0 模拟「隐藏 tab / 隐藏视图」，再置回非 0 模拟重新可见，
 *     驱动 useTreeScrollRestore 的可见性恢复分支（配合用例里的假 ResizeObserver）。
 */

import { act } from '@testing-library/react';

let viewportHeight = 600;
let viewportWidth = 400;

/** react-virtual「滚动结束」回退的默认 debounce 时长（`isScrollingResetDelay` 默认 150ms）。 */
const VIRTUALIZER_SCROLL_RESET_MS = 150;

/**
 * 排干 @tanstack/react-virtual 的「滚动结束」回退定时器。
 *
 * virtual-core 的 `observeElementOffset` 在没有 scrollend 的环境（jsdom）里用一个
 * `isScrollingResetDelay`（默认 150ms）debounce 去通知 React。dispatch 过 scroll 的
 * 用例若不等它落定就结束，这个定时器会在 jsdom 环境被拆掉之后触发一次 React 更新 ——
 * `ReferenceError: window is not defined`，vitest 记成「未捕获异常」，整轮单测直接
 * 判失败（2026-09-17 CI 上就踩到这条）。在 afterEach 里 await 一次：环境还活着时
 * 它已落定，之后没有挂起的定时器。包 `act` 是为了让这次更新不报 "not wrapped in act"。
 */
export async function flushTreeVirtualizerScrollReset(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, VIRTUALIZER_SCROLL_RESET_MS + 50),
    );
  });
}

export function setTestViewportSize(height: number, width = viewportWidth): void {
  viewportHeight = height;
  viewportWidth = width;
}

export function resetTestViewportSize(): void {
  viewportHeight = 600;
  viewportWidth = 400;
}

/** 装到 HTMLElement 原型上：整个测试文件的元素都拿到同一份尺寸。 */
export function installTreeViewportStub(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return viewportHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return viewportWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return viewportHeight;
    },
  });
}
