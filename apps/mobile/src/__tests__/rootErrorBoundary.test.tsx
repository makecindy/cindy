// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RootErrorBoundary } from '@/components/RootErrorBoundary';

// 测试价值
// - 生产入口与可观察结果：根布局用的 RootErrorBoundary——渲染报错后用户看到错误页还是 App 退出，
//   以及点「重试」后业务树是否重新挂载。
// - 依据：2026-11 线上崩溃日志（JS 致命错误占 iOS 闪退约一半）；启动窗口内必须保持致命，
//   否则 expo-updates 回滚不了坏热更。
// - 现有覆盖缺口：此前渲染路径没有根级 ErrorBoundary。
// - 最小失败输入：子组件渲染时抛错，分别发生在启动窗口内 / 外。
// - tier：unit（真实 React 渲染，jsdom）。
const mock = vi.hoisted(() => ({ settled: true, record: vi.fn() }));
vi.mock('@/debug/jsErrorGuard', () => ({
  launchSettled: () => mock.settled,
  recordJsError: mock.record,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let broken: boolean;
const boom = new TypeError('render failed');
function Screen() {
  if (broken) throw boom;
  return createElement('p', null, 'business tree');
}
function tree() {
  return createElement(RootErrorBoundary, {
    fallback: (retry: () => void) => createElement('button', { onClick: retry }, 'retry'),
    children: createElement(Screen),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.settled = true; broken = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div'); document.body.append(container);
});
afterEach(() => { container.remove(); vi.restoreAllMocks(); });

it('shows the retry page after the launch window and remounts the tree on retry', async () => {
  const uncaught = vi.fn();
  const root = createRoot(container, { onUncaughtError: uncaught });
  await act(async () => { root.render(tree()); });
  expect(container.textContent).toBe('retry');
  expect(mock.record).toHaveBeenCalledExactlyOnceWith('render', boom);
  expect(uncaught).not.toHaveBeenCalled();
  broken = false;
  await act(async () => { container.querySelector('button')!.click(); });
  expect(container.textContent).toBe('business tree');
  await act(async () => { root.unmount(); });
});

it('lets a render error stay uncaught inside the launch window', async () => {
  mock.settled = false;
  const uncaught = vi.fn();
  const root = createRoot(container, { onUncaughtError: uncaught });
  // No boundary handled it: React reports it as uncaught (the fatal path on device) and the
  // test renderer hands the same error back to the caller.
  let thrown: unknown;
  try { await act(async () => { root.render(tree()); }); } catch (error) { thrown = error; }
  expect(thrown ?? uncaught.mock.calls[0]?.[0]).toBe(boom);
  expect(container.textContent).toBe('');
  expect(mock.record).not.toHaveBeenCalled();
});
