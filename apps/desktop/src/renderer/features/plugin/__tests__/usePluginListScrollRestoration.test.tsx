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

function Harness({ listVisible }: { listVisible: boolean }) {
  restoration = usePluginListScrollRestoration(listVisible);
  return listVisible ? (
    <main data-testid="plugin-list" ref={restoration.listRef} onScroll={restoration.onListScroll} />
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
