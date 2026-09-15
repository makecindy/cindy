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

let viewportHeight = 600;
let viewportWidth = 400;

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
