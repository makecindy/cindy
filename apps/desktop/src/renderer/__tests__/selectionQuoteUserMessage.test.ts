// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SelectionQuoteButton, selectionIntersectsFloatingQuoteDisabledArea } from '../components/chat/SelectionQuoteButton';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const userMessageSource = readTextLf(
  resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
);

describe('SelectionQuoteButton — user message floating action exclusion', () => {
  it('marks the whole user message as opted out of the floating action', () => {
    expect(userMessageSource).toContain('data-selection-floating-quote-disabled=""');
  });

  it('renders sent quotes with the same compact chip as the composer', () => {
    expect(userMessageSource).toContain('<QuoteChip quote={segment.quote} />');
    expect(userMessageSource).toContain(
      'mx-1 inline-flex max-w-[min(240px,55vw)] select-none align-middle',
    );
    expect(userMessageSource).not.toContain('min-w-0 rounded-lg border px-3 py-2');
  });

  it('keeps long-message collapse enabled for mixed quote and prose messages', () => {
    const collapseGuard = userMessageSource.slice(
      userMessageSource.indexOf('const collapseMeasureEnabled ='),
      userMessageSource.indexOf(
        'const { mirrorRef:',
        userMessageSource.indexOf('const collapseMeasureEnabled ='),
      ),
    );
    expect(collapseGuard).not.toContain('inlineQuoteCount === 0');
    expect(userMessageSource).toMatch(
      /longMessageCollapsed\s*&&\s*\(isScheduledAutomation \? 'line-clamp-3' : 'line-clamp-10'\)/,
    );
    expect(userMessageSource).toMatch(/\{renderContent\(\n\s+segment\.text,/);
    expect(userMessageSource).toContain('!longMessageCollapsed,');
  });

  it('keeps right-click Add to chat enabled while suppressing the floating button', () => {
    const buttonSource = readTextLf(
      resolve(__dirname, '..', 'components', 'chat', 'SelectionQuoteButton.tsx'),
    );
    expect(buttonSource).toContain("container.dataset.selectionQuoteContext = '';");
    expect(buttonSource).toContain('readSelectionInStream(true)');
    expect(buttonSource).toContain(
      '!allowQuoteDisabled && selectionIntersectsFloatingQuoteDisabledArea',
    );
  });

  // The second action changes menu width. Exercise the real selection/portal
  // path: fixed 100px margins could let the wider menu cross the viewport edge.
  it.each([240, 320])('keeps a %ipx selection menu inside both viewport edges', async (menuWidth) => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.stubGlobal('electronAPI', { onSelectionContextMenuAddToChat: () => () => {} });
    vi.stubGlobal('innerWidth', 1024);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, menuWidth, 32));
    const stream = document.createElement('div');
    stream.textContent = 'selected context';
    document.body.appendChild(stream);
    const range = document.createRange();
    range.selectNodeContents(stream);
    let selectionX = 1;
    Object.defineProperty(range, 'getClientRects', {
      value: () => [new DOMRect(selectionX - 1, 100, 1, 20)],
    });
    const selection = window.getSelection()!;
    selection.addRange(range);
    const onAskInSideChat = vi.fn(async () => true);
    try {
      render(createElement(SelectionQuoteButton, {
        sessionId: 'selection-menu-edges',
        containerRef: { current: stream },
        onAskInSideChat,
      }));
      for (const edgeX of [1, 1023]) {
        selectionX = edgeX;
        fireEvent.mouseUp(stream);
        act(() => { vi.advanceTimersByTime(16); });
        const menu = screen.getByRole('button', { name: 'chat.quote.addToChat' }).parentElement!;
        const centerX = Number.parseFloat(menu.style.left);
        expect(centerX - menuWidth / 2).toBeGreaterThanOrEqual(8);
        expect(centerX + menuWidth / 2).toBeLessThanOrEqual(1016);
      }
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' }));
      });
      expect(onAskInSideChat).toHaveBeenCalledWith('selected context');
      expect(selection.isCollapsed).toBe(true);
      expect(screen.queryByRole('button', { name: 'chat.sideChat.title' })).toBeNull();
    } finally {
      cleanup();
      stream.remove();
      selection.removeAllRanges();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('rejects a selection intersecting any copy-only region', () => {
    const allowed = {} as Element;
    const disabled = {} as Element;
    const range = {
      intersectsNode: vi.fn((node: Node) => node === disabled),
    };
    const container = {
      querySelectorAll: vi.fn(() => [allowed, disabled]),
    };

    expect(
      selectionIntersectsFloatingQuoteDisabledArea(
        range as Pick<Range, 'intersectsNode'>,
        container as unknown as Pick<HTMLElement, 'querySelectorAll'>,
      ),
    ).toBe(true);
    expect(range.intersectsNode).toHaveBeenCalledTimes(2);
  });

  it('keeps assistant/file selections eligible when no copy-only region intersects', () => {
    const range = { intersectsNode: vi.fn(() => false) };
    const container = { querySelectorAll: vi.fn(() => [{} as Element]) };

    expect(
      selectionIntersectsFloatingQuoteDisabledArea(
        range as Pick<Range, 'intersectsNode'>,
        container as unknown as Pick<HTMLElement, 'querySelectorAll'>,
      ),
    ).toBe(false);
  });
});
