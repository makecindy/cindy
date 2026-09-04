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
  readonly ranges: AbstractRange[];

  constructor(...ranges: AbstractRange[]) {
    this.ranges = [...ranges];
  }

  add(range: AbstractRange) {
    this.ranges.push(range);
    return this;
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
    const select = document.createElement('select');
    const selectedOption = document.createElement('option');
    selectedOption.textContent = 'bar';
    selectedOption.selected = true;
    const unselectedOption = document.createElement('option');
    unselectedOption.textContent = 'foo';
    select.append(selectedOption, unselectedOption);
    page.append(select);

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

  it('matches context-sensitive Greek sigma case-insensitively', async () => {
    const page = document.createElement('main');
    page.textContent = 'ΟΣ Σ';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'Σ' } });

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      'Σ',
      'Σ',
    ]);
  });

  it('matches whitespace collapsed by normal text layout', async () => {
    const page = document.createElement('main');
    page.style.whiteSpace = 'normal';
    page.textContent = 'foo\nbar';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo bar' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('foo\nbar');
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

  it('refreshes stale ranges before navigating after page text changes', async () => {
    const page = document.createElement('main');
    page.textContent = 'foo';
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    page.textContent = 'bar';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('0/0')).toBeTruthy();
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
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中' } });
    expect(screen.queryByText('1/1')).toBeNull();

    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    expect(screen.getByText('1/1')).toBeTruthy();
    const searchCount = walkerSpy.mock.calls.length;
    fireEvent.change(input, { target: { value: '中文' } });
    expect(walkerSpy).toHaveBeenCalledTimes(searchCount);
    walkerSpy.mockRestore();
  });

  it('refreshes matches when a single-select option changes', async () => {
    const page = document.createElement('main');
    const select = document.createElement('select');
    const first = document.createElement('option');
    first.value = 'first';
    first.textContent = 'first';
    const second = document.createElement('option');
    second.value = 'second';
    second.textContent = 'second';
    select.append(first, second);
    page.append(select);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'second' } });
    expect(screen.getByText('0/0')).toBeTruthy();

    select.value = 'second';
    fireEvent.change(select);
    expect(screen.getByText('1/1')).toBeTruthy();
  });

  it('refreshes after a controlled select restores its submitted value', async () => {
    const page = document.createElement('main');
    const select = document.createElement('select');
    const first = document.createElement('option');
    first.value = 'first';
    first.textContent = 'first';
    const second = document.createElement('option');
    second.value = 'second';
    second.textContent = 'second';
    select.append(first, second);
    select.addEventListener('change', () => {
      select.value = 'first';
    });
    page.append(select);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'second' } });
    expect(screen.getByText('0/0')).toBeTruthy();

    select.value = 'second';
    fireEvent.change(select);
    expect(screen.getByText('0/0')).toBeTruthy();
  });

  it('refreshes matches when responsive visibility changes on resize', async () => {
    const page = document.createElement('main');
    const responsive = document.createElement('span');
    responsive.textContent = 'foo';
    page.append(responsive);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    responsive.style.display = 'none';
    fireEvent(window, new Event('resize'));
    expect(screen.getByText('0/0')).toBeTruthy();

    responsive.style.display = '';
    fireEvent(window, new Event('resize'));
    expect(screen.getByText('1/1')).toBeTruthy();
  });

  it('allows arrow navigation to rescan after a zero-result search', async () => {
    const page = document.createElement('main');
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });

    expect(screen.getByText('0/0')).toBeTruthy();
    const nextButton = screen.getByRole('button', { name: 'findInPage.next' });
    expect((nextButton as HTMLButtonElement).disabled).toBe(false);

    page.textContent = 'foo';
    fireEvent.click(nextButton);
    expect(screen.getByText('1/1')).toBeTruthy();
  });

  it('does not refresh responsive visibility while composing with IME', async () => {
    const page = document.createElement('main');
    const responsive = document.createElement('span');
    responsive.textContent = 'foo';
    page.append(responsive);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'bar' } });
    const searchCount = walkerSpy.mock.calls.length;

    responsive.style.display = 'none';
    fireEvent(window, new Event('resize'));
    expect(walkerSpy).toHaveBeenCalledTimes(searchCount);

    fireEvent.compositionEnd(input, { target: { value: 'bar' } });
    expect(screen.getByText('0/0')).toBeTruthy();
    walkerSpy.mockRestore();
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
