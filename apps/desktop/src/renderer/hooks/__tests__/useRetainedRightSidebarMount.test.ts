// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  useRetainedRightSidebarMount,
  type RetainedRightSidebarMountInput,
} from '../useRetainedRightSidebarMount';

afterEach(cleanup);

const route = { available: true, loaded: true, detached: false };
const noSidebarRoute = { ...route, available: false };

function mountSequence(initial: RetainedRightSidebarMountInput) {
  const view = renderHook((props: RetainedRightSidebarMountInput) => useRetainedRightSidebarMount(props), {
    initialProps: initial,
  });
  return {
    step: (next: RetainedRightSidebarMountInput) => {
      view.rerender(next);
      return view.result.current;
    },
    current: () => view.result.current,
  };
}

// #6485: 任务 → 无项目目录的新建页 → 任务。右栏若在中间卸载，内置浏览器的 webview 宿主
// 会被移出 DOM，Electron guest 被销毁，页面内输入与滚动位置丢失。
describe('useRetainedRightSidebarMount', () => {
  it('keeps the sidebar mounted but force-collapsed on a route that does not declare it', () => {
    const view = mountSequence(route);
    expect(view.current()).toEqual({ mounted: true, forceCollapsed: false });

    expect(view.step(noSidebarRoute)).toEqual({ mounted: true, forceCollapsed: true });
    expect(view.step(route)).toEqual({ mounted: true, forceCollapsed: false });
  });

  it('does not mount a sidebar that no route has ever declared', () => {
    const view = mountSequence(noSidebarRoute);
    expect(view.current()).toEqual({ mounted: false, forceCollapsed: true });
  });

  it.each([
    ['the detached window owns the sidebar', { ...noSidebarRoute, detached: true }],
    ['the window state is not loaded yet', { ...noSidebarRoute, loaded: false }],
  ])('drops the retained mount when %s, and does not resurrect it afterwards', (_name, blocked) => {
    const view = mountSequence(route);
    expect(view.step(blocked).mounted).toBe(false);
    expect(view.step(noSidebarRoute)).toEqual({ mounted: false, forceCollapsed: true });
    expect(view.step(route).mounted).toBe(true);
  });
});
