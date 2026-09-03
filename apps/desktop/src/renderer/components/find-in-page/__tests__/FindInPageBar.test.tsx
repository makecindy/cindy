// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shortcutHandler: null as ((event: KeyboardEvent) => boolean) | null,
  resultHandler: null as
    | ((result: {
        requestId: number;
        activeMatchOrdinal: number;
        matches: number;
        finalUpdate: boolean;
      }) => void)
    | null,
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcut: (_id: string, handler: (event: KeyboardEvent) => boolean) => {
    mocks.shortcutHandler = handler;
  },
}));

vi.mock('@/components/find-in-page/findInPageOwnership', () => ({
  isFindInPageClaimed: () => false,
}));

import { FindInPageBar } from '../FindInPageBar';

async function openFindBar(): Promise<HTMLInputElement> {
  render(<FindInPageBar />);
  await act(async () => {
    expect(mocks.shortcutHandler?.(new KeyboardEvent('keydown'))).toBe(true);
    await Promise.resolve();
  });
  return screen.getByPlaceholderText('findInPage.placeholder') as HTMLInputElement;
}

describe('FindInPageBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.shortcutHandler = null;
    mocks.resultHandler = null;
    mocks.findInPage.mockResolvedValue(41);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        findInPage: mocks.findInPage,
        stopFindInPage: mocks.stopFindInPage,
        onFindInPageResult: (handler: NonNullable<typeof mocks.resultHandler>) => {
          mocks.resultHandler = handler;
          return () => {
            if (mocks.resultHandler === handler) mocks.resultHandler = null;
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('excludes the query input from native search and restores its caret after finalUpdate', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });
    input.setSelectionRange(2, 2);

    expect(mocks.findInPage).not.toHaveBeenCalled();
    mocks.findInPage.mockImplementationOnce(async () => {
      expect(input.type).toBe('password');
      return 41;
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(mocks.findInPage).toHaveBeenCalledWith({
      text: 'foo',
      forward: true,
      findNext: false,
    });
    expect(input.type).toBe('password');

    // Chromium moves focus to the active page match while searching.
    input.blur();
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 2,
        finalUpdate: true,
      });
    });

    expect(input.type).toBe('text');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('cancels the delayed search when the query is cleared', async () => {
    const input = await openFindBar();
    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.change(input, { target: { value: '' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(mocks.findInPage).not.toHaveBeenCalled();
    expect(mocks.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('ignores late results from the previous query during the debounce window', async () => {
    const input = await openFindBar();
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 2,
        finalUpdate: true,
      });
    });
    expect(screen.getByText('1/2')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'bar' } });
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 2,
        matches: 99,
        finalUpdate: true,
      });
    });

    expect(screen.queryByText('2/99')).toBeNull();
    expect(screen.queryByText('1/2')).toBeNull();
  });

  it('restores the query focus when Chromium focuses a matched link', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    const link = document.createElement('a');
    link.href = '#match';
    document.body.append(link);
    link.focus();

    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: false,
      });
    });

    expect(input.type).toBe('password');
    expect(document.activeElement).toBe(input);
    link.remove();
  });

  it('keeps a deliberate pointer focus change after the search completes', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    const button = document.createElement('button');
    document.body.append(button);
    fireEvent.pointerDown(button);
    button.focus();

    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    expect(document.activeElement).toBe(button);
    expect(input.type).toBe('text');
    button.remove();
  });

  it('applies a result that arrives before the invoke reply', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    let resolveRequest!: (requestId: number) => void;
    mocks.findInPage.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(input.type).toBe('password');
    act(() => {
      mocks.resultHandler?.({
        requestId: 77,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    await act(async () => {
      resolveRequest(77);
      await Promise.resolve();
    });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(input.type).toBe('text');
    expect(document.activeElement).toBe(input);
  });

  it('does not revive a cancelled search when its invoke reply arrives late', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    let resolveRequest!: (requestId: number) => void;
    mocks.findInPage.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    fireEvent.change(input, { target: { value: 'bar' } });
    await act(async () => {
      resolveRequest(41);
      await Promise.resolve();
    });

    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 2,
        matches: 99,
        finalUpdate: true,
      });
    });

    expect(screen.queryByText('2/99')).toBeNull();
    expect(input.type).toBe('text');
  });

  it('keeps the query editable while waiting for a slow finalUpdate', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'foobar' } });
    expect(input.value).toBe('foobar');

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(mocks.findInPage).toHaveBeenLastCalledWith({
      text: 'foobar',
      forward: true,
      findNext: false,
    });
  });

  it('re-masks the query when Enter restarts a pending search', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(input.type).toBe('password');
    mocks.findInPage.mockImplementationOnce(async () => {
      expect(input.type).toBe('password');
      return 42;
    });

    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.findInPage).toHaveBeenLastCalledWith({
      text: 'foo',
      forward: true,
      findNext: true,
    });
    expect(input.type).toBe('password');
  });

  it('keeps the query excluded from the async scan until finalUpdate', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    // The password-backed representation is searchable-safe while Chromium
    // continues scoping matches, but the control remains editable.
    expect(input.type).toBe('password');
    expect(input.disabled).toBe(false);
    expect(input.parentElement?.textContent).toBe('');
    const mirror = input.parentElement?.querySelector('[data-query]') as HTMLElement;
    expect(mirror.getAttribute('data-query')).toBe('foo');
    expect(input.getAttribute('role')).toBe('searchbox');
    expect(input.getAttribute('aria-label')).toBe('findInPage.placeholder: foo');

    input.scrollLeft = 37;
    fireEvent.scroll(input);
    expect(mirror.style.transform).toBe('translateX(-37px)');

    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: false,
      });
    });
    expect(input.type).toBe('password');

    // The value returns to a normal text input once native scoping completes.
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });
    expect(input.type).toBe('text');
  });

  it('preserves a caret moved in the query while finalUpdate is pending', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foobar' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    input.setSelectionRange(1, 1);
    fireEvent.pointerDown(input);
    input.setSelectionRange(4, 4);
    input.blur();
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(4);
  });

  it('preserves keyboard caret movement while a result is pending', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foobar' } });
    input.setSelectionRange(1, 1);

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    fireEvent.keyDown(input, { key: 'ArrowRight' });
    input.setSelectionRange(2, 2);
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: false,
      });
    });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it('keeps keyboard caret navigation after native search moves focus away', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foobar' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    input.setSelectionRange(1, 1);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    input.setSelectionRange(2, 2);
    input.blur();
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it('keeps a keyboard select-all after native search moves focus away', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foobar' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    input.setSelectionRange(1, 1);
    fireEvent.keyDown(input, { key: 'a', metaKey: true });
    input.setSelectionRange(0, input.value.length);
    input.blur();
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
  });

  it('keeps a re-opened find bar select-all after native search moves focus away', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foobar' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    await act(async () => {
      expect(mocks.shortcutHandler?.(new KeyboardEvent('keydown'))).toBe(true);
      await Promise.resolve();
    });
    input.blur();
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    expect(document.activeElement).not.toBe(input);
  });

  it('waits for compositionend before starting a search', async () => {
    const input = await openFindBar();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(mocks.findInPage).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    expect(mocks.findInPage).toHaveBeenCalledWith({
      text: '中文',
      forward: true,
      findNext: false,
    });
  });

  it('invalidates an in-flight search when IME composition starts', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    let resolveRequest!: (requestId: number) => void;
    mocks.findInPage.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    fireEvent.compositionStart(input);
    expect(mocks.stopFindInPage).toHaveBeenLastCalledWith('clearSelection');

    await act(async () => {
      resolveRequest(41);
      await Promise.resolve();
    });
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 9,
        finalUpdate: true,
      });
    });

    expect(screen.queryByText('1/9')).toBeNull();
  });

  it('keeps a deliberate Tab navigation after the search completes', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    const button = document.createElement('button');
    document.body.append(button);
    fireEvent.keyDown(input, { key: 'Tab' });
    button.focus();

    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 1,
        finalUpdate: true,
      });
    });

    expect(document.activeElement).toBe(button);
    expect(input.type).toBe('text');
    button.remove();
  });
});
