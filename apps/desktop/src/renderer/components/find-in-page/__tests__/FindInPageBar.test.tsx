// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MATCH_HIGHLIGHT_NAME = 'cindy-find-in-page-match';
const ACTIVE_HIGHLIGHT_NAME = 'cindy-find-in-page-active';

const mocks = vi.hoisted(() => ({
  shortcutHandler: null as ((event: KeyboardEvent) => boolean) | null,
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

class MockHighlight {
  readonly ranges: readonly AbstractRange[];

  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges;
  }
}

let highlights: Map<string, MockHighlight>;

async function openFindBar(page?: HTMLElement): Promise<HTMLInputElement> {
  if (page) document.body.append(page);
  render(<FindInPageBar />);
  await act(async () => {
    expect(mocks.shortcutHandler?.(new KeyboardEvent('keydown'))).toBe(true);
    await Promise.resolve();
  });
  return screen.getByRole('searchbox') as HTMLInputElement;
}

function getHighlight(name: string): MockHighlight | undefined {
  return highlights.get(name);
}

describe('FindInPageBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.shortcutHandler = null;
    highlights = new Map();
    vi.stubGlobal('Highlight', MockHighlight);
    vi.stubGlobal('CSS', {
      highlights: {
        set: vi.fn((name: string, highlight: MockHighlight) => highlights.set(name, highlight)),
        delete: vi.fn((name: string) => highlights.delete(name)),
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('searches page text without matching the query input or hidden content', async () => {
    const page = document.createElement('main');
    page.append('foo');
    const hidden = document.createElement('span');
    hidden.setAttribute('aria-hidden', 'true');
    hidden.textContent = 'foo';
    page.append(hidden);
    const cssHidden = document.createElement('span');
    cssHidden.style.display = 'none';
    cssHidden.textContent = 'foo';
    page.append(cssHidden);
    const script = document.createElement('script');
    script.textContent = '// foo';
    page.append(script);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('foo');
    expect(getHighlight(ACTIVE_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
  });

  it('matches case-insensitively and keeps element-boundary matches explicit', async () => {
    const page = document.createElement('main');
    page.append('Foo foo 中文中文');
    const first = document.createElement('span');
    first.textContent = '中';
    const second = document.createElement('span');
    second.textContent = '文';
    page.append(first, second);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '中文' } });

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(2);
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      '中文',
      '中文',
    ]);
  });

  it('walks matches with Enter, Shift+Enter, and the navigation buttons', async () => {
    const page = document.createElement('main');
    page.textContent = 'foo foo foo';
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });

    expect(screen.getByText('1/3')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('2/3')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByText('1/3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.previous' }));
    expect(screen.getByText('3/3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.next' }));
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('clears highlights when the query is cleared or the bar closes', async () => {
    const page = document.createElement('main');
    page.textContent = 'foo';
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText('1/1')).toBeNull();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)).toBeUndefined();
    expect(getHighlight(ACTIVE_HIGHLIGHT_NAME)).toBeUndefined();

    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)).toBeUndefined();
  });

  it('waits for compositionend before searching committed IME text', async () => {
    const page = document.createElement('main');
    page.textContent = '中文';
    const input = await openFindBar(page);

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中' } });
    expect(screen.queryByText('1/1')).toBeNull();

    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    expect(screen.getByText('1/1')).toBeTruthy();
  });

  it('refreshes matches after page text changes', async () => {
    const page = document.createElement('main');
    page.textContent = 'foo';
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    page.append(' foo');
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('reopens the bar and selects the whole query', async () => {
    const input = await openFindBar();
    fireEvent.change(input, { target: { value: 'foobar' } });
    input.setSelectionRange(2, 2);

    await act(async () => {
      expect(mocks.shortcutHandler?.(new KeyboardEvent('keydown'))).toBe(true);
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});
