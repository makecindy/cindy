import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, createRef, Fragment, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { UserMessage } from '../components/chat/UserMessage';
import { AssistantMessage } from '../components/chat/AssistantMessage';
import { MessageSourceLabels } from '../components/chat/MessageSourceLabels';
import { BotMessageTimelineHeader } from '../components/chat/BotMessageTimelineHeader';
import { ChatAudioCard } from '../components/chat/ChatAudioCard';
import { ChatSoundEffectCard } from '../components/chat/ChatSoundEffectCard';
import { BotTaskCard } from '../features/bots/BotCollaborationCard';
import { clearDraft, getDraft } from '@/lib/composerDraftStore';
import { formatQuoteForSend } from '@/lib/chatQuotes';
import { installRichAnswerClipboardStyles } from '../../test/vitest/rendererSelectionStyles';

import { SelectionQuoteButton } from '../components/chat/SelectionQuoteButton';

const outsideSelectionCase = vi.hoisted(() => () => {
  throw new Error('This selection case must not render or invoke an unrelated feature');
});

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'selection-test' } }) }));
// Keep the actual task card, with a settled offline record and no live queries.
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/bots/BotSessionTaskLink', () => ({ useBotTaskSession: () => ({
  resolved: true, targetId: null, row: null, session: null, activity: null,
}) }));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => {}, visible: false }) }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({}), usePrRefsForSession: () => [],
  usePrStatuses: () => ({ statuses: new Map(), successfulStatuses: new Map() }),
}));
// Use the same production helpers through narrow entries; the shared barrel
// eagerly imports unrelated task/runtime modules in the unit runner.
vi.mock('@cindy/maker-shared', async () => {
  const { leadingSlashInvocation } = await import('@cindy/maker-shared/composer-palette');
  const { normalizeTaskTags, reconcileTaskTags } = await import('../../../../../packages/maker-shared/src/taskTags');
  const { MAX_STATUS_QUERIES } = await import('../../../../../packages/maker-shared/src/sessionPrRefs');
  const workingStatus = await import('../../../../../packages/maker-shared/src/workingStatus');
  return { leadingSlashInvocation, normalizeTaskTags, reconcileTaskTags, MAX_STATUS_QUERIES, ...workingStatus };
});
vi.mock('@cindy/device-link', async () => ({
  ...await import('../../../../../packages/device-link/src/sharedTaskPeer'),
  ...await import('../../../../../packages/device-link/src/metadataContinuity'),
}));
// Selection never edits/resends messages or controls an Agent session. Keep the
// real message bodies/actions, without booting those unrelated dependency trees.
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: {} }));
vi.mock('../components/chat/UserMessageEditBox', () => ({ UserMessageEditBox: outsideSelectionCase }));
// No attachments or expanded previews in these cases. Fail if a case starts
// using a replacement instead of silently masking its rendered output.
vi.mock('../components/chat/ImageLightbox', () => ({ ImageLightbox: outsideSelectionCase }));
vi.mock('../components/chat/ToolPayloadLightbox', () => ({ ToolPayloadLightbox: outsideSelectionCase }));
vi.mock('../components/chat/ModelLightbox', () => ({ ModelLightbox: outsideSelectionCase }));
vi.mock('../components/chat/useFileChipContextMenu', () => ({ useFileChipContextMenu: outsideSelectionCase }));
vi.mock('@/features/bots/BotSessionTaskResultCard', () => ({ BotSessionTaskResultCard: outsideSelectionCase }));
vi.mock('@/components/ui/file-type-icon', () => ({ FileTypeIcon: outsideSelectionCase }));
vi.mock('../components/chat/ErrorMessageCard', () => ({ ErrorMessageCard: outsideSelectionCase }));
vi.mock('@/i18n', async () => {
  const { createInstance } = await import('i18next');
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: {} });
  return { i18n, DEFAULT_LOCALE: 'en' };
});
// Costs/timestamps still use the real action bar. These cases have no model name.
vi.mock('../../shared/usageModelLabel', () => ({ formatModelShort: outsideSelectionCase }));
vi.mock('@/lib/modelShortLabel', () => ({ formatModelShortLabel: outsideSelectionCase }));
vi.mock('../components/chat/AutomationOriginBadge', () => ({
  AutomationOriginBadge: outsideSelectionCase,
  // Keep the real source row and its text; label navigation is outside selection.
  MessageSourceLabelShell: ({ label }: { label: string }) => label,
}));
// Plugin cards are absent from these text-only messages; avoid loading their editors.
vi.mock('../components/chat/GhostToolCard', () => ({
  CARD_EXPAND_TOGGLE_EVENT: 'xdt-card-expand-toggle',
  GhostToolCard: outsideSelectionCase,
  MailCardEditor: outsideSelectionCase,
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

  async function renderMessages(onAskInSideChat?: (quote: string) => Promise<boolean>, reply = assistantText, nextUser?: string,
    userProps?: { content: string; quotesEncoded: boolean }, cards?: ReactNode) {
    const containerRef = createRef<HTMLDivElement>();
    await act(async () => {
      render(createElement(MemoryRouter, null,
        createElement(Tooltip.Provider, null,
          createElement(ConfirmDialogProvider, null,
            createElement('div', { ref: containerRef },
              createElement(UserMessage, { pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
                workingDir: '', content: userText,
                createdAt: '2026-11-09T10:00:00Z', sharedAuthorName: 'Message author',
                ...userProps,
              }),
              // Stream-owned metadata must not depend on being nested inside
              // UserMessage/AssistantMessage to stay out of a selected quote.
              createElement(BotMessageTimelineHeader, { startsUnread: true, groupTimestamp: 1794218400000 }),
              createElement(MessageSourceLabels, { sourceGroup: { groupId: 'group-1', name: 'Planning' }, align: 'start' }),
              createElement(AssistantMessage, { pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
                workingDir: '', content: reply,
                createdAt: '2026-11-09T10:01:00Z', ghostReplyPending: true,
                showActionBar: true, turnCostUsd: 0.001,
              }),
              cards,
              nextUser && createElement(UserMessage, { pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES, workingDir: '', content: nextUser }),
              createElement(SelectionQuoteButton, { sessionId, containerRef, onAskInSideChat }),
            ),
            createElement('p', null, 'Outside the message stream'),
          ),
        ),
      ));
    });
    return containerRef.current!;
  }

  function selectText(start: HTMLElement, end = start, startOffset = 0, endOffset?: number) {
    const startNode = document.createTreeWalker(start, NodeFilter.SHOW_TEXT).nextNode()!;
    const endNode = document.createTreeWalker(end, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset ?? endNode.textContent!.length);
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
    const selectedText = source === 'both' ? `${userText}\n\n${assistantText}` : start.textContent;
    expect(screen.getByRole('button', { name: 'chat.quote.addToChat' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' }));
    });
    expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(selectedText);
    expect(getDraft(sessionId)).toBeUndefined();
    expect(selection.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'chat.sideChat.title' })).toBeNull();
  });

  // PR #9503 discussion_r4511756287: the old test omitted metadata and asserted
  // against Selection.toString(), accepting the timestamp as expected content.
  // Unit/DOM: a real user row with a timestamp must quote only its selected body;
  // selecting its author label alone must not create either selection action.
  it('omits message metadata from a cross-message native quote', async () => {
    await renderMessages();
    const selection = selectText(screen.getByText(userText), screen.getByText(assistantText));
    expect(selection.toString()).toContain(document.querySelector('time')!.textContent);
    act(() => nativeAddToChat());
    expect(getDraft(sessionId)?.text?.content?.[0]?.content).toEqual([
      { type: 'composerQuote', attrs: { text: `${userText}\n\n${assistantText}`, sourcePath: null, startLine: null, endLine: null } },
    ]);
  });

  // PR #9503 discussion_r4514435440: source labels and timeline separators are
  // stream siblings, not children of a message scope. The same real components
  // now exercise that missing boundary in cross-body cases and standalone picks.
  it.each(['user', 'assistant', 'source', 'unread', 'time'] as const)('does not offer quote actions for %s message metadata', async (source) => {
    await renderMessages(vi.fn(async () => true));
    const target = source === 'time'
      ? document.querySelector<HTMLElement>('time[datetime="2026-11-09T10:00:00.000Z"]')!
      : source === 'unread'
        ? screen.getByRole('separator', { name: 'bots.chat.newMessagesBoundary' })
        : screen.getByText({ user: 'Message author', assistant: 'chat.ghostHook.processing',
            source: 'chat.userMessage.groupSentNamed' }[source]!);
    if (source === 'unread') expect(target.textContent).toBe('bots.chat.newMessagesBoundary');
    const selection = selectText(target);
    expect(screen.queryByRole('button', { name: 'chat.quote.addToChat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.sideChat.title' })).toBeNull();
    act(() => nativeAddToChat());
    expect(getDraft(sessionId)).toBeUndefined();
    expect(selection.isCollapsed).toBe(false);
  });

  // PR #9503 discussion_r4511952066: selecting through a complete assistant row
  // must exclude its action bar and status notice as well as user-row metadata.
  // Earlier ranges ended inside the assistant body, before those siblings.
  it.each(['quote', 'side chat'])('omits intervening assistant metadata from a cross-user %s', async (action) => {
    const onAskInSideChat = vi.fn(async () => true);
    const nextUser = 'Please continue';
    await renderMessages(onAskInSideChat, assistantText, nextUser);
    const selection = selectText(screen.getByText(userText), screen.getByText(nextUser));
    expect(selection.toString()).toContain('chat.ghostHook.processing');
    const expected = `${userText}\n\n${assistantText}\n\n${nextUser}`;
    if (action === 'quote') {
      fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
      expect(getDraft(sessionId)?.text?.content?.[0]?.content).toEqual([
        { type: 'composerQuote', attrs: { text: expected, sourcePath: null, startLine: null, endLine: null } },
      ]);
    } else {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
      expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(expected);
      expect(getDraft(sessionId)).toBeUndefined();
    }
  });

  it('preserves partial endpoints and paragraph breaks while filtering a cross-message quote', async () => {
    await renderMessages(undefined, 'First paragraph\n\nSecond paragraph');
    selectText(screen.getByText(userText), screen.getByText('Second paragraph'), 7, 6);
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
    expect(getDraft(sessionId)?.text?.content?.[0]?.content).toEqual([
      { type: 'composerQuote', attrs: { text: 'check this requirement\n\nFirst paragraph\n\nSecond', sourcePath: null, startLine: null, endLine: null } },
    ]);
  });

  // PR #9503 discussion_r4512060775: real QuoteChip summaries and diff gutters
  // are intentionally non-selectable, but the cross-message walker read them.
  // Unit/DOM: supply the CSS utilities missing in jsdom, then assert both output
  // paths exclude that text while retaining bodies that restore select-text.
  it.each(['quote', 'side chat'])('omits non-selectable quote chips and diff gutters from a cross-message %s', async (action) => {
    const style = document.createElement('style');
    // Match the global descendant rule followed by Tailwind utility overrides.
    style.textContent = '.select-text, .select-text * { user-select: text; } .select-none { user-select: none; }';
    document.head.appendChild(style);
    try {
      const onAskInSideChat = vi.fn(async (_quote: string) => true);
      const nextUser = 'Please continue';
      const content = `${userText}\n\n${formatQuoteForSend({ text: 'Original quote\nsecond line' })}`;
      const stream = await renderMessages(onAskInSideChat, '```diff\n- before\n+ after\n```', nextUser,
        { content, quotesEncoded: true });
      // A non-selectable outer container must not suppress descendants whose
      // production message bodies explicitly restore text selection.
      stream.style.userSelect = 'none';
      selectText(screen.getByText(userText), screen.getByText(nextUser));
      if (action === 'quote') {
        fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
      } else {
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
      }
      const quote = action === 'quote'
        ? getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text
        : onAskInSideChat.mock.calls[0]?.[0];
      expect(quote).not.toContain('Original quote');
      expect(quote).not.toMatch(/[12+\-]/);
      expect(quote).toBe(`${userText}\nbefore\nafter\n${nextUser}`);
    } finally {
      style.remove();
    }
  });

  // PR #9503 discussion_r4514841384: cross-message reconstruction appended a
  // tab after every cell, including partial endpoints and the last cell in a row.
  // Unit/DOM: real Markdown table output must delimit cells, not trail each row.
  it.each(['partial cell', 'whole table'] as const)('preserves table separators for a cross-message %s selection', async (source) => {
    const onAskInSideChat = vi.fn(async (_quote: string) => true);
    const nextUser = 'Please continue';
    await renderMessages(onAskInSideChat, '| H1 | H2 |\n| --- | --- |\n| A1 | B1 |\n| A2 | B2 |', nextUser);
    const partial = source === 'partial cell';
    selectText(screen.getByText(userText), screen.getByText(partial ? 'B1' : nextUser), 0, partial ? 1 : undefined);
    const expected = `${userText}\nH1\tH2\nA1\t${partial ? 'B' : `B1\nA2\tB2\n${nextUser}`}`;
    if (partial) {
      fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
      expect(getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text).toBe(expected);
    } else {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
      expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(expected);
      expect(getDraft(sessionId)).toBeUndefined();
    }
  });

  // PR #9503 discussion_r4514983426: closed native details keep normal computed
  // styles on their hidden descendants. Use actual rich-answer disclosures in
  // both states to check only rendered text reaches the selection actions.
  it.each([false, true])('quotes only visible disclosure content when open=%s', async (open) => {
    const onAskInSideChat = vi.fn(async (_quote: string) => true);
    const nextUser = 'Please continue';
    const operations = [
      { version: 1, seq: 1, op: 'create', id: 'details', kind: 'details', props: { label: 'Visible summary', default: open } },
      { seq: 2, op: 'create', id: 'inside', kind: 'text', parent: 'details', props: { text: 'Disclosure body' } },
    ];
    await renderMessages(onAskInSideChat, `\`\`\`cindy-ui\n${operations.map(op => JSON.stringify(op)).join('\n')}\n\`\`\``, nextUser);
    expect(document.querySelector('details')!.open).toBe(open);
    selectText(screen.getByText(userText), screen.getByText(nextUser));
    const expected = `${userText}\nVisible summary${open ? '\n\nDisclosure body\n\n' : '\n'}${nextUser}`;
    if (open) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
      expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(expected);
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
      expect(getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text).toBe(expected);
    }
  });

  // PR #9503 discussion_r4515218826: KaTeX includes both a clipped MathML
  // accessibility copy and visible glyphs. Unit/DOM: actual Markdown output
  // must contribute the selected visual text once, including partial endpoints.
  it.each([false, true])('quotes a formula once without expanding a partial selection=%s', async (partial) => {
    const onAskInSideChat = vi.fn(async (_quote: string) => true);
    const nextUser = 'Please continue';
    const stream = await renderMessages(onAskInSideChat, '$x+1$', nextUser);
    const visualStart = stream.querySelector<HTMLElement>('.katex-html .mathnormal')!;
    expect(visualStart.textContent).toBe('x');
    selectText(screen.getByText(userText), partial ? visualStart : screen.getByText(nextUser));
    const expected = `${userText}\n\n${partial ? 'x' : `x+1\n\n${nextUser}`}`;
    if (partial) {
      fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
      expect(getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text).toBe(expected);
    } else {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
      expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(expected);
    }
  });

  // PR #9503 discussion_r4515218839: native select options are not selected
  // message text. Unit/DOM: preserve the real RichAnswer label and following
  // body, but omit the field's current value, placeholder and unused choices.
  it('omits a native select subtree from a cross-message quote', async () => {
    const nextUser = 'Please continue';
    const operations = [
      { version: 1, seq: 1, op: 'create', id: 'choice', kind: 'select', props: {
        label: 'Choose a fruit', placeholder: 'Pick one', default: 'apple',
        options: [{ label: 'Apple', value: 'apple' }, { label: 'Pear', value: 'pear' }],
      } },
      { seq: 2, op: 'create', id: 'body', kind: 'text', props: { text: 'Following body' } },
    ];
    await renderMessages(undefined, `\`\`\`cindy-ui\n${operations.map(op => JSON.stringify(op)).join('\n')}\n\`\`\``, nextUser);
    const select = screen.getByRole('combobox', { name: 'Choose a fruit' });
    fireEvent.change(select, { target: { value: 'pear' } });
    expect((select as HTMLSelectElement).value).toBe('pear');
    selectText(screen.getByText(userText), screen.getByText(nextUser));
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
    expect(getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text)
      .toBe(`${userText}\nChoose a fruit\n\nFollowing body\n\n${nextUser}`);
  });

  // PR #9503 discussion_r4515827011: a real range label uses spaced flex
  // children. Unit/DOM with production CSS: preserve that gap in both actions,
  // but keep column controls on separate lines and partial endpoints partial.
  it.each([false, true])('preserves rich control layout in a cross-message quote (partial=%s)', async (partial) => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const style = installRichAnswerClipboardStyles();
    try {
      const onAskInSideChat = vi.fn(async (_quote: string) => true);
      const nextUser = 'Please continue';
      const operations = [
        { version: 1, seq: 1, op: 'create', id: 'budget', kind: 'range', props: {
          label: 'Budget', min: 0, max: 100, default: 50, suffix: '%',
        } },
        { seq: 2, op: 'create', id: 'name', kind: 'input', props: { label: 'Name', default: 'Private draft' } },
        { seq: 3, op: 'create', id: 'email', kind: 'input', props: { label: 'Email' } },
      ];
      await renderMessages(onAskInSideChat, `\`\`\`cindy-ui\n${operations.map(op => JSON.stringify(op)).join('\n')}\n\`\`\``, nextUser);
      selectText(screen.getByText(userText), partial ? screen.getByText('50%') : screen.getByText(nextUser), 0, partial ? 1 : undefined);
      const expected = `${userText}\nBudget ${partial ? '5' : `50%\nName\nEmail\n${nextUser}`}`;
      if (partial) {
        fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
        expect(getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text).toBe(expected);
      } else {
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
        expect(onAskInSideChat).toHaveBeenCalledExactlyOnceWith(expected);
      }
    } finally {
      style.remove();
    }
  });

  // PR #9503 discussion_r4515427401: production media controls and screen-reader
  // task status have normal computed display/visibility. Unit/DOM: cross-message
  // quotes keep selectable card content, but omit explicit copy-excluded subtrees.
  it('omits production media controls and screen-reader task status from a cross-message quote', async () => {
    // jsdom has no layout observer for the real media scrubbers.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const nextUser = 'Please continue';
    const track = { audioUrl: 'https://example.com/audio.mp3', coverUrl: '', lyrics: '', durationSeconds: 30 };
    await renderMessages(undefined, assistantText, nextUser, undefined, createElement(Fragment, null,
      createElement(ChatAudioCard, { track: { ...track, kind: 'music', title: 'Song title', tags: 'Ambient' } }),
      createElement(ChatSoundEffectCard, { track: { ...track, kind: 'sound_effect', title: 'Rain sound', tags: '' } }),
      createElement(BotTaskCard, { card: { role: 'delegation-request', objective: 'Task title' } as Parameters<typeof BotTaskCard>[0]['card'] }),
    ));
    expect(screen.getAllByText('0:00')).toHaveLength(2);
    expect(screen.getByText('bots.collab.status.unknown')).toBeTruthy();
    selectText(screen.getByText(userText), screen.getByText(nextUser));
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
    const quote = getDraft(sessionId)?.text?.content?.[0]?.content?.[0]?.attrs?.text;
    for (const visible of [userText, assistantText, 'Song title', 'Ambient', 'Rain sound', 'Task title', nextUser]) {
      expect(quote).toContain(visible);
    }
    expect(quote).not.toMatch(/0:00|0:30|bots\.collab\.status\.unknown/);
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
