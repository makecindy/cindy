// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { UserMessage } from '../components/chat/UserMessage';
import { AssistantMessage } from '../components/chat/AssistantMessage';
import { clearDraft, getDraft } from '@/lib/composerDraftStore';

import { SelectionQuoteButton } from '../components/chat/SelectionQuoteButton';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'selection-test' } }) }));
// Plugin cards are absent from these text-only messages; avoid loading their editors.
vi.mock('../components/chat/GhostToolCard', () => ({
  CARD_EXPAND_TOGGLE_EVENT: 'xdt-card-expand-toggle',
  GhostToolCard: () => null,
  MailCardEditor: () => null,
}));
vi.mock('react-i18next', async (importOriginal) => {
  const t = (key: string) => key;
  return { ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const userMessageSource = readTextLf(
  resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
);

describe('SelectionQuoteButton — quote rendering and menu placement', () => {
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
});

// User request: sent message bodies must offer the same selection actions as replies.
// Existing coverage asserted the exclusion or exercised a plain div, so it could not
// catch UserMessage opting out. Unit/DOM: select text in the real message components
// and observe the composer quote or side-chat request. jsdom only needs layout geometry.
describe('SelectionQuoteButton — message body selection actions', () => {
  const sessionId = 'message-body-selection';
  const userText = 'Please check this requirement';
  const assistantText = 'I will check the requirement';
  let nativeAddToChat: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.stubGlobal('electronAPI', {
      onSelectionContextMenuAddToChat: (listener: () => void) => {
        nativeAddToChat = listener;
        return () => {};
      },
    });
  });

  afterEach(() => {
    cleanup();
    clearDraft(sessionId);
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function renderMessages(onAskInSideChat?: (quote: string) => Promise<boolean>) {
    const containerRef = createRef<HTMLDivElement>();
    await act(async () => {
      render(createElement(MemoryRouter, null,
        createElement(Tooltip.Provider, null,
          createElement(ConfirmDialogProvider, null,
            createElement('div', { ref: containerRef },
              createElement(UserMessage, { workingDir: '', content: userText }),
              createElement(AssistantMessage, { workingDir: '', content: assistantText }),
              createElement(SelectionQuoteButton, { sessionId, containerRef, onAskInSideChat }),
            ),
            createElement('p', null, 'Outside the message stream'),
          ),
        ),
      ));
    });
  }

  function selectText(start: HTMLElement, end = start) {
    const range = document.createRange();
    range.setStart(start.firstChild!, 0);
    range.setEnd(end.firstChild!, end.firstChild!.textContent!.length);
    Object.defineProperty(range, 'getClientRects', {
      value: () => [new DOMRect(120, 100, 160, 20)],
    });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(end);
    act(() => { vi.advanceTimersByTime(16); });
    return selection;
  }

  it.each(['floating button', 'native menu'])('quotes a user message through the %s', async (action) => {
    await renderMessages();
    const selection = selectText(screen.getByText(userText));
    expect(screen.queryByRole('button', { name: 'chat.sideChat.title' })).toBeNull();
    if (action === 'floating button') {
      const button = screen.getByRole('button', { name: 'chat.quote.addToChat' });
      fireEvent.mouseDown(button);
      fireEvent.click(button);
    } else {
      act(() => nativeAddToChat());
    }
    expect(getDraft(sessionId)?.text?.content?.[0]?.content).toEqual([
      { type: 'composerQuote', attrs: { text: userText, sourcePath: null, startLine: null, endLine: null } },
    ]);
    expect(selection.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'chat.quote.addToChat' })).toBeNull();
  });

  it.each(['user', 'assistant', 'both'])('opens a side chat with selected %s message text', async (source) => {
    const onAskInSideChat = vi.fn(async () => true);
    await renderMessages(onAskInSideChat);
    const start = screen.getByText(source === 'assistant' ? assistantText : userText);
    const end = source === 'both' ? screen.getByText(assistantText) : start;
    const selection = selectText(start, end);
    const selectedText = selection.toString();
    expect(screen.getByRole('button', { name: 'chat.quote.addToChat' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' }));
    });
    expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(selectedText);
    expect(getDraft(sessionId)).toBeUndefined();
    expect(selection.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'chat.sideChat.title' })).toBeNull();
  });

  it('does not claim a selection extending beyond its message stream', async () => {
    await renderMessages(vi.fn(async () => true));
    const selection = selectText(screen.getByText(userText), screen.getByText('Outside the message stream'));
    expect(screen.queryByRole('button', { name: 'chat.quote.addToChat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.sideChat.title' })).toBeNull();
    act(() => nativeAddToChat());
    expect(getDraft(sessionId)).toBeUndefined();
    expect(selection.isCollapsed).toBe(false);
  });
});
