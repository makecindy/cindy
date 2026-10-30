// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitSelectionMenuAction,
  handleSelectionQuoteMenuAction,
  SelectionQuoteContext,
  sliceRenderedSelection,
} from '@/session/selectionQuote';
import { SelectionMenuText } from '@/session/SelectionMenuText';

const bridge = vi.hoisted(() => ({
  attach: vi.fn(async () => {}),
  detach: vi.fn(async () => {}),
  listeners: new Set<(event: { registration: string; action: string; text: string }) => void>(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, findNodeHandle: () => 42 }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({
    attach: bridge.attach,
    detach: bridge.detach,
    addListener: (_: string, handler: (event: { registration: string; action: string; text: string }) => void) => {
      bridge.listeners.add(handler);
      return { remove: () => bridge.listeners.delete(handler) };
    },
  }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ onLayout, children }: { onLayout: (event: unknown) => void; children: string }) =>
    createElement('span', { onClick: () => onLayout({ nativeEvent: { target: 42 } }) }, children),
}));

describe('sliceRenderedSelection', () => {
  const lines = ['first line\n', 'second line\n', 'third'];

  it('slices within a single line', () => {
    expect(sliceRenderedSelection(lines, 0, 5)).toBe('first');
  });

  it('slices across line boundaries (lines join to the full rendered string)', () => {
    expect(sliceRenderedSelection(lines, 6, 17)).toBe('line\nsecond');
  });

  it('clamps out-of-range offsets from stale layouts', () => {
    expect(sliceRenderedSelection(lines, 23, 999)).toBe('third');
  });

  it('returns null for collapsed, inverted, or whitespace-only selections', () => {
    expect(sliceRenderedSelection(lines, 5, 5)).toBeNull();
    expect(sliceRenderedSelection(lines, 7, 3)).toBeNull();
    expect(sliceRenderedSelection(lines, 10, 11)).toBeNull();
    expect(sliceRenderedSelection([], 0, 5)).toBeNull();
  });
});

describe('handleSelectionQuoteMenuAction', () => {
  const lines = ['abc\n', 'defg'];

  it('commits the sliced selection text', () => {
    const commitQuote = vi.fn();
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 0, end: 3 } },
      lines,
      { commitQuote },
    );
    expect(commitQuote).toHaveBeenCalledWith('abc');
  });

  it('ignores events when layout lines are missing or the slice is empty', () => {
    const commitQuote = vi.fn();
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 0, end: 3 } },
      [],
      { commitQuote },
    );
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 3, end: 4 } },
      lines,
      { commitQuote },
    );
    expect(commitQuote).not.toHaveBeenCalled();
  });

  // User requirement: the native selection action opens a separate draft, not
  // a full-message quote in the main task. Existing tests only covered quote.
  // Minimal failure: side-chat action + a UTF-16 selection across rendered lines. Tier: unit.
  it('opens a side chat with only the selected rendered text and preserves the main draft', () => {
    const mainDraft = ['keep this draft'];
    const sideDraft: string[] = [];
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 1, end: 9 } },
      ['前😀选区\n', '第二段结束'],
      { commitQuote: text => mainDraft.push(text), askInSideChat: text => sideDraft.push(text) },
      'side-chat',
    );
    expect(sideDraft).toEqual(['😀选区\n第二段']);
    expect(mainDraft).toEqual(['keep this draft']);
  });

  it('ignores unavailable side-chat, unknown actions, and empty selections', () => {
    const commitQuote = vi.fn();
    const askInSideChat = vi.fn();
    commitSelectionMenuAction('side-chat', 'selection', { commitQuote });
    commitSelectionMenuAction('unknown', 'selection', { commitQuote, askInSideChat });
    commitSelectionMenuAction('side-chat', '\n ', { commitQuote, askInSideChat });
    expect(commitQuote).not.toHaveBeenCalled();
    expect(askInSideChat).not.toHaveBeenCalled();
  });
});

// Native event routing/lifecycle has no previous coverage. A removed TextView's
// event must never create a side chat in another task (unit; native UI is tested on emulator).
describe('SelectionMenuText', () => {
  const roots: ReturnType<typeof createRoot>[] = [];
  afterEach(() => {
    act(() => roots.splice(0).forEach(root => root.unmount()));
    document.body.replaceChildren();
    bridge.attach.mockClear();
    bridge.detach.mockClear();
  });
  function mount(ctx: React.ContextType<typeof SelectionQuoteContext>) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(createElement(SelectionQuoteContext.Provider, { value: ctx },
      createElement(SelectionMenuText, { selectable: true }, 'rendered message'))));
    act(() => container.querySelector('span')!.click());
    return root;
  }

  it('routes only the current native registration and releases it when the task closes', () => {
    const mainDraft: string[] = [];
    const sideDraft: string[] = [];
    const root = mount({ commitQuote: text => mainDraft.push(text), askInSideChat: text => sideDraft.push(text) });
    const registration = (bridge.attach.mock.calls[0] as unknown as [number, string])[1];
    const emit = (id: string) => bridge.listeners.forEach(listener => listener({ registration: id, action: 'side-chat', text: 'selected words' }));
    emit('stale');
    expect(sideDraft).toEqual([]);
    emit(registration);
    expect(sideDraft).toEqual(['selected words']);
    expect(mainDraft).toEqual([]);
    act(() => root.render(null));
    emit(registration);
    expect(sideDraft).toEqual(['selected words']);
    expect(bridge.detach).toHaveBeenCalledWith(registration);
    expect(bridge.listeners.size).toBe(0);
  });

  it('leaves the native system menu alone in a read-only host', () => {
    mount(null);
    expect(bridge.attach).not.toHaveBeenCalled();
  });

  it('keeps an open menu usable when a same-task render replaces the side-chat callback', () => {
    // The native ActionMode retains the registration from menu creation. Replacing
    // it on ordinary renders makes the eventual tap silently disappear.
    const commitQuote = vi.fn();
    const oldDraft: string[] = [];
    const newDraft: string[] = [];
    const root = mount({ commitQuote, askInSideChat: text => oldDraft.push(text) });
    const registration = (bridge.attach.mock.calls[0] as unknown as [number, string])[1];
    act(() => root.render(createElement(SelectionQuoteContext.Provider, {
      value: { commitQuote, askInSideChat: text => newDraft.push(text) },
    }, createElement(SelectionMenuText, { selectable: true }, 'rendered message'))));
    bridge.listeners.forEach(listener => listener({ registration, action: 'side-chat', text: 'selected words' }));
    expect(oldDraft).toEqual([]);
    expect(newDraft).toEqual(['selected words']);
  });
});
