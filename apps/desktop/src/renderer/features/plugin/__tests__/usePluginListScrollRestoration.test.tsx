/**
 * Regression coverage for the Plugin catalog's conditional list/detail mount.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  usePluginListScrollRestoration,
  type PluginListScrollRestoration,
} from '../lib/usePluginListScrollRestoration';

let restoration: PluginListScrollRestoration;

function Harness({
  listVisible,
  items = ['plugin-a', 'plugin-b'],
}: {
  listVisible: boolean;
  items?: string[];
}) {
  restoration = usePluginListScrollRestoration(listVisible);
  return listVisible ? (
    <main data-testid="plugin-list" ref={restoration.listRef} onScroll={restoration.onListScroll}>
      {items.map((item) => (
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

describe('usePluginListScrollRestoration', () => {
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
