// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('searches visible page text without matching the query input or hidden content', async () => {
    const page = document.createElement('main');
    page.append('foo');
    const ariaHidden = document.createElement('span');
    ariaHidden.setAttribute('aria-hidden', 'true');
    ariaHidden.textContent = 'foo';
    page.append(ariaHidden);
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

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(2);
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

  it('case-folds Greek final sigma in either the page or the query', async () => {
    const page = document.createElement('main');
    page.textContent = 'σ ς Σ';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'σ' } });

    expect(screen.getByText('1/3')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      'σ',
      'ς',
      'Σ',
    ]);
  });

  it('keeps ASCII case folding independent of the runtime locale', async () => {
    const localeLowerCaseSpy = vi
      .spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(function (this: string) {
        return this.toLowerCase().replace(/i/g, 'ı');
      });
    const page = document.createElement('main');
    page.textContent = 'I';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'i' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(localeLowerCaseSpy).not.toHaveBeenCalled();
    localeLowerCaseSpy.mockRestore();
  });

  it('maps case-folded characters that expand back to the source range', async () => {
    const page = document.createElement('main');
    page.textContent = 'İ';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'i\u0307' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('İ');
  });

  it('matches an expanded case fold when the query uses the original character', async () => {
    const page = document.createElement('main');
    page.textContent = 'i\u0307';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'İ' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('i\u0307');
  });

  it('matches canonically equivalent Unicode forms and maps the source range', async () => {
    const page = document.createElement('main');
    page.textContent = 'e\u0301 x é';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'é' } });

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      'e\u0301',
      'é',
    ]);

    fireEvent.change(input, { target: { value: 'e\u0301' } });
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      'e\u0301',
      'é',
    ]);
  });

  it('keeps separate Hangul Jamo syllable ranges after normalization', async () => {
    const page = document.createElement('main');
    page.textContent = '가가';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '가' } });

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      '가',
      '가',
    ]);
  });

  it('combines a precomposed Hangul LV syllable with its trailing Jamo', async () => {
    const page = document.createElement('main');
    page.textContent = '각 각';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '각' } });

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges.map((range) => range.toString())).toEqual([
      '각',
      '각',
    ]);
  });

  it('does not merge non-composing Hangul Jamo extensions into a source range', async () => {
    const page = document.createElement('main');
    page.textContent = '가\uD7CB';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '가' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('가');
  });

  it('does not expand one visible character into duplicate navigation matches', async () => {
    const page = document.createElement('main');
    page.textContent = 'ß';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 's' } });

    expect(screen.getByText('0/0')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)).toBeUndefined();

    fireEvent.change(input, { target: { value: 'ß' } });
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('ß');
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

  it('removes normal-layout segment breaks between CJK characters', async () => {
    const page = document.createElement('main');
    page.style.whiteSpace = 'normal';
    page.textContent = '你\n好';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '你好' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('你\n好');
  });

  it('keeps normal-layout segment breaks between Korean syllables', async () => {
    const page = document.createElement('main');
    page.style.whiteSpace = 'normal';
    page.textContent = '한\n글';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '한 글' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('한\n글');
  });

  it('removes normal-layout segment breaks around supplementary-plane CJK characters', async () => {
    const page = document.createElement('main');
    page.style.whiteSpace = 'normal';
    page.textContent = '𠮷\n野';

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: '𠮷野' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges[0].toString()).toBe('𠮷\n野');
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

  it('refreshes matches when page text changes while the bar is open', async () => {
    const page = document.createElement('main');
    page.textContent = 'foo';
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    page.textContent = 'foo foo';
    await waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(2);
  });

  it('refreshes matches when page visibility attributes change', async () => {
    const page = document.createElement('main');
    const responsive = document.createElement('span');
    responsive.textContent = 'foo';
    page.append(responsive);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    responsive.hidden = true;
    await waitFor(() => expect(screen.getByText('0/0')).toBeTruthy());

    responsive.hidden = false;
    await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
  });

  it('refreshes matches when a visibility transition ends', async () => {
    const page = document.createElement('main');
    const responsive = document.createElement('span');
    responsive.textContent = 'foo';
    page.append(responsive);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    await act(async () => {
      responsive.style.opacity = '0';
      const transitionEnd = new Event('transitionend', { bubbles: true });
      Object.defineProperty(transitionEnd, 'propertyName', { value: 'opacity' });
      responsive.dispatchEvent(transitionEnd);
    });
    await waitFor(() => expect(screen.getByText('0/0')).toBeTruthy());
  });

  it('refreshes matches after hover and focus visibility changes', async () => {
    const page = document.createElement('main');
    const responsive = document.createElement('button');
    responsive.textContent = 'foo';
    page.append(responsive);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const initialSearchCount = walkerSpy.mock.calls.length;

    fireEvent.mouseOver(responsive);
    await waitFor(() =>
      expect(walkerSpy.mock.calls.length).toBeGreaterThan(initialSearchCount),
    );
    const hoverSearchCount = walkerSpy.mock.calls.length;

    fireEvent.focusIn(responsive);
    await waitFor(() => expect(walkerSpy.mock.calls.length).toBeGreaterThan(hoverSearchCount));
    walkerSpy.mockRestore();
  });

  it('refreshes matches when details sections expand or collapse', async () => {
    const page = document.createElement('main');
    const details = document.createElement('details');
    details.innerHTML = '<summary>More</summary><span>foo</span>';
    page.append(details);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('0/0')).toBeTruthy();

    details.open = true;
    await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());

    details.open = false;
    await waitFor(() => expect(screen.getByText('0/0')).toBeTruthy());
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
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const initialWalkCount = walkerSpy.mock.calls.length;

    responsive.style.display = 'none';
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('resize'));
    expect(walkerSpy).toHaveBeenCalledTimes(initialWalkCount);
    await waitFor(() => expect(screen.getByText('0/0')).toBeTruthy());

    responsive.style.display = '';
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    walkerSpy.mockRestore();
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

  it('starts at the first or last match when navigation rescans from zero results', async () => {
    const page = document.createElement('main');
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });

    page.textContent = 'foo foo';
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.next' }));
    expect(screen.getByText('1/2')).toBeTruthy();

    page.textContent = '';
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.next' }));
    expect(screen.getByText('0/0')).toBeTruthy();

    page.textContent = 'foo foo';
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.previous' }));
    expect(screen.getByText('2/2')).toBeTruthy();
  });

  it('excludes content hidden by zero opacity', async () => {
    const page = document.createElement('main');
    const visible = document.createElement('span');
    visible.textContent = 'foo';
    const transparent = document.createElement('span');
    transparent.textContent = 'foo';
    transparent.style.opacity = '0';
    page.append(visible, transparent);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(screen.getByText('1/1')).toBeTruthy();

    transparent.style.opacity = '';
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
  });

  it('excludes clipping-based screen-reader-only text', async () => {
    const page = document.createElement('main');
    const visible = document.createElement('span');
    visible.textContent = 'foo';
    const srOnly = document.createElement('span');
    srOnly.textContent = 'foo';
    Object.assign(srOnly.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clip: 'rect(0px, 0px, 0px, 0px)',
      whiteSpace: 'nowrap',
    });
    page.append(visible, srOnly);

    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });

    expect(screen.getByText('1/1')).toBeTruthy();
    expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
  });

  it('keeps text searchable when a line clamp clips its layout', async () => {
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    const page = document.createElement('main');
    const visible = document.createElement('span');
    visible.textContent = 'foo';
    const clamped = document.createElement('span');
    clamped.textContent = 'foo';
    clamped.style.display = '-webkit-box';
    clamped.style.overflow = 'hidden';
    clamped.style.setProperty('-webkit-line-clamp', '1');
    page.append(visible, clamped);

    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        return [{ top: 20, bottom: 30, left: 0, right: 100 }];
      },
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        if (this === clamped) return { top: 0, bottom: 10, left: 0, right: 100 };
        return { top: 0, bottom: 100, left: 0, right: 100 };
      },
    });

    try {
      const input = await openFindBar(page);
      fireEvent.change(input, { target: { value: 'foo' } });

      expect(screen.getByText('1/2')).toBeTruthy();
      expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(2);
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(Element.prototype, 'getBoundingClientRect', elementRectDescriptor);
      } else {
        delete (Element.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    }
  });

  it('keeps text searchable through an overflow-hidden ancestor', async () => {
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    const page = document.createElement('main');
    const visible = document.createElement('span');
    visible.textContent = 'foo';
    const clippedContainer = document.createElement('div');
    clippedContainer.style.overflow = 'hidden';
    const clipped = document.createElement('span');
    clipped.textContent = 'foo';
    clippedContainer.append(clipped);
    page.append(visible, clippedContainer);
    let clipBottom = 10;

    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const parent = this.startContainer.parentElement;
        const top = parent === clipped ? 20 : 0;
        return [{ top, bottom: top + 10, left: 0, right: 100 }];
      },
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        if (this === clippedContainer) return { top: 0, bottom: clipBottom, left: 0, right: 100 };
        return { top: 0, bottom: 100, left: 0, right: 100 };
      },
    });

    try {
      const input = await openFindBar(page);
      fireEvent.change(input, { target: { value: 'foo' } });

      expect(screen.getByText('1/2')).toBeTruthy();
      expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(2);

      clipBottom = 100;
      const transitionEnd = new Event('transitionend', { bubbles: true });
      Object.defineProperty(transitionEnd, 'propertyName', { value: 'height' });
      clippedContainer.dispatchEvent(transitionEnd);
      await waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(Element.prototype, 'getBoundingClientRect', elementRectDescriptor);
      } else {
        delete (Element.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    }
  });

  it('keeps ranges outside the root viewport eligible for navigation', async () => {
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    const root = document.createElement('div');
    root.id = 'root';
    root.style.overflow = 'hidden';
    const page = document.createElement('main');
    page.textContent = 'foo';
    root.append(page);
    document.body.append(root);

    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value() {
        return [{ top: 20, bottom: 30, left: 0, right: 100 }];
      },
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        if (this === root) return { top: 0, bottom: 10, left: 0, right: 100 };
        return { top: 0, bottom: 100, left: 0, right: 100 };
      },
    });

    try {
      const input = await openFindBar();
      fireEvent.change(input, { target: { value: 'foo' } });

      expect(screen.getByText('1/1')).toBeTruthy();
      expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(Element.prototype, 'getBoundingClientRect', elementRectDescriptor);
      } else {
        delete (Element.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    }
  });

  it('keeps scrollable content searchable through a flexible overflow-hidden layout shell', async () => {
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    const layoutShell = document.createElement('div');
    layoutShell.style.display = 'flex';
    layoutShell.style.flexGrow = '1';
    layoutShell.style.overflow = 'hidden';
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    const page = document.createElement('main');
    page.textContent = 'foo';
    scrollContainer.append(page);
    layoutShell.append(scrollContainer);
    document.body.append(layoutShell);

    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value() {
        return [{ top: 20, bottom: 30, left: 0, right: 100 }];
      },
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        if (this === layoutShell) return { top: 0, bottom: 10, left: 0, right: 100 };
        return { top: 0, bottom: 100, left: 0, right: 100 };
      },
    });

    try {
      const input = await openFindBar();
      fireEvent.change(input, { target: { value: 'foo' } });

      expect(screen.getByText('1/1')).toBeTruthy();
      expect(getHighlight(MATCH_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(Element.prototype, 'getBoundingClientRect', elementRectDescriptor);
      } else {
        delete (Element.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    }
  });

  it('keeps transformed drawer text searchable while it is outside the viewport', async () => {
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    const drawer = document.createElement('aside');
    drawer.style.position = 'fixed';
    drawer.style.transform = 'translateX(100%)';
    drawer.textContent = 'foo';
    document.body.append(drawer);
    let rangeRect = { top: 0, bottom: 10, left: -100, right: -90 };

    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value() {
        return [rangeRect];
      },
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return { top: 0, bottom: 100, left: 0, right: 100 };
      },
    });

    try {
      const input = await openFindBar();
      fireEvent.change(input, { target: { value: 'foo' } });
      expect(screen.getByText('1/1')).toBeTruthy();

      drawer.style.transform = 'none';
      rangeRect = { top: 0, bottom: 10, left: 0, right: 10 };
      const transitionEnd = new Event('transitionend', { bubbles: true });
      Object.defineProperty(transitionEnd, 'propertyName', { value: 'transform' });
      drawer.dispatchEvent(transitionEnd);
      await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(Element.prototype, 'getBoundingClientRect', elementRectDescriptor);
      } else {
        delete (Element.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    }
  });

  it('keeps scrollable content searchable regardless of overflow clipping', async () => {
    const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    const elementRectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    );
    const page = document.createElement('main');
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowX = 'hidden';
    scrollContainer.style.overflowY = 'auto';
    const match = document.createElement('span');
    match.textContent = 'foo';
    scrollContainer.append(match);
    page.append(scrollContainer);
    let rangeRect = { top: 20, bottom: 30, left: 0, right: 100 };

    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value() {
        return [rangeRect];
      },
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        if (this === scrollContainer) return { top: 0, bottom: 10, left: 0, right: 100 };
        return { top: 0, bottom: 100, left: 0, right: 100 };
      },
    });

    try {
      const input = await openFindBar(page);
      fireEvent.change(input, { target: { value: 'foo' } });

      expect(screen.getByText('1/1')).toBeTruthy();

      rangeRect = { top: 0, bottom: 10, left: -20, right: -10 };
      const transitionEnd = new Event('transitionend', { bubbles: true });
      Object.defineProperty(transitionEnd, 'propertyName', { value: 'width' });
      scrollContainer.dispatchEvent(transitionEnd);
      await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    } finally {
      if (rangeRectDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeRectDescriptor);
      } else {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      }
      if (elementRectDescriptor) {
        Object.defineProperty(Element.prototype, 'getBoundingClientRect', elementRectDescriptor);
      } else {
        delete (Element.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    }
  });

  it('cancels a delayed scroll when the bar closes', async () => {
    let nextFrame = 1;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const cancelAnimationFrameMock = vi.fn((frame: number) => {
      pendingFrames.delete(frame);
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frame = nextFrame;
      nextFrame += 1;
      pendingFrames.set(frame, callback);
      return frame;
    });
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);

    const page = document.createElement('main');
    page.textContent = 'foo';
    const input = await openFindBar(page);
    fireEvent.change(input, { target: { value: 'foo' } });

    expect(pendingFrames.size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'findInPage.close' }));

    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);
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
