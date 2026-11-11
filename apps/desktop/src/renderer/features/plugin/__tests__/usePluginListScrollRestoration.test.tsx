/**
 * Regression coverage for the Plugin catalog's conditional list/detail mount.
 * Scroll-end work must finish before the jsdom window is torn down.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyPluginGridCache, PluginVirtualGrid } from '../PluginVirtualGrid';

import {
  usePluginListScrollRestoration,
  type PluginListScrollRestoration,
} from '../lib/usePluginListScrollRestoration';

let restoration: PluginListScrollRestoration;

function Harness({
  listVisible,
  items = ['plugin-a', 'plugin-b'],
  virtualized = false,
}: {
  listVisible: boolean;
  items?: string[];
  virtualized?: boolean;
}) {
  restoration = usePluginListScrollRestoration(listVisible);
  const gridCache = useRef(emptyPluginGridCache());
  const renderItem = (index: number) => <div data-testid={`plugin-${items[index]}`} />;
  return listVisible ? (
    <main data-testid="plugin-list" ref={restoration.listRef} onScroll={restoration.onListScroll}>
      {virtualized ? items.length > 0 && (
        <PluginVirtualGrid count={items.length} scrollRef={restoration.listRef}
          cache={gridCache.current} renderItem={renderItem} />
      ) : items.map((item) => (
        <div key={item} data-testid={`plugin-${item}`} />
      ))}
    </main>
  ) : (
    <div data-testid="plugin-detail" />
  );
}

function setScrollTop(element: HTMLElement, value: number) {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('usePluginListScrollRestoration', () => {
  // Unit, #9927: mount the real grid with the existing restoration hook. The
  // offset-only tests below cannot detect a grid that stays on six fallback
  // cards after its parent scroller is remounted with already-loaded items.
  it('restores a virtualized list and keeps later items reachable after returning from detail', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'plugin-list' ? 300 : 150;
    });
    // jsdom has no layout: content moves above the viewport when its parent scrolls.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.tagName === 'MAIN' ? 0 : -(this.closest('main')?.scrollTop ?? 0);
      return new DOMRect(0, top, 800, this.offsetHeight);
    });
    const items = Array.from({ length: 40 }, (_, index) => `item-${index}`);
    const view = render(<Harness listVisible virtualized items={[]} />);
    // The first load happens after the scroller mounts, as in the plugin page.
    view.rerender(<Harness listVisible virtualized items={items} />);
    const list = screen.getByTestId('plugin-list');
    setScrollTop(list, 600);
    fireEvent.scroll(list);
    // The virtualizer debounces scroll end; settle it before removing this grid.
    act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.getByTestId('plugin-item-8')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      restoration.capture();
      restoration.requestRestore();
    });
    view.rerender(<Harness listVisible={false} virtualized items={items} />);
    view.rerender(<Harness listVisible virtualized items={items} />);

    const restoredList = screen.getByTestId('plugin-list');
    expect(restoredList.scrollTop).toBe(600);
    expect(screen.getByTestId('plugin-item-8')).toBeTruthy();
    setScrollTop(restoredList, 1500);
    fireEvent.scroll(restoredList);
    act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.getByTestId('plugin-item-20')).toBeTruthy();
    expect(screen.queryByTestId('plugin-item-0')).toBeNull();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores the captured catalog position when the list is mounted again', () => {
    const view = render(<Harness listVisible />);
    const list = screen.getByTestId('plugin-list');
    setScrollTop(list, 640);

    act(() => {
      restoration.capture();
      restoration.requestRestore();
    });
    view.rerender(<Harness listVisible={false} />);
    view.rerender(<Harness listVisible />);

    expect(screen.getByTestId('plugin-list').scrollTop).toBe(640);
  });

  it('keeps the captured pixel position when catalog items change during detail', () => {
    const view = render(<Harness listVisible items={['plugin-a', 'plugin-b', 'plugin-c']} />);
    const list = screen.getByTestId('plugin-list');
    setScrollTop(list, 640);
    fireEvent.scroll(list);

    // Enter detail: the catalog list is unmounted while its data can still refresh.
    act(() => {
      restoration.capture();
      restoration.requestRestore();
    });
    view.rerender(<Harness listVisible={false} items={['plugin-a', 'plugin-b', 'plugin-c']} />);
    // Simulate a market refresh that inserts an item before the previous viewport.
    view.rerender(
      <Harness listVisible={false} items={['plugin-new', 'plugin-a', 'plugin-b', 'plugin-c']} />,
    );
    view.rerender(
      <Harness listVisible items={['plugin-new', 'plugin-a', 'plugin-b', 'plugin-c']} />,
    );

    expect(screen.getByTestId('plugin-plugin-new')).toBeTruthy();
    expect(screen.getByTestId('plugin-list').scrollTop).toBe(640);
  });

  it('does not restore a position unless the return path requests it', () => {
    const view = render(<Harness listVisible />);
    const list = screen.getByTestId('plugin-list');
    setScrollTop(list, 320);
    fireEvent.scroll(list);

    view.rerender(<Harness listVisible={false} />);
    view.rerender(<Harness listVisible />);

    expect(screen.getByTestId('plugin-list').scrollTop).toBe(0);
  });

  it('can cancel a pending restore when the owning catalog changes', () => {
    const view = render(<Harness listVisible />);
    const list = screen.getByTestId('plugin-list');
    setScrollTop(list, 280);
    fireEvent.scroll(list);

    act(() => {
      restoration.requestRestore();
      restoration.clearPendingRestore();
    });
    view.rerender(<Harness listVisible={false} />);
    view.rerender(<Harness listVisible />);

    expect(screen.getByTestId('plugin-list').scrollTop).toBe(0);
  });
});
