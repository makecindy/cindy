// @vitest-environment jsdom
// #7387 unit: selection -> real task draft. Existing selection tests inspect
// source/metadata but never confirm a comment, cancel, or switch task mid-edit.
// Minimal failure before this change: Add to chat immediately writes a quote.
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionQuoteButton } from '@/components/chat/SelectionQuoteButton';
import { clearDraft, getDraft, subscribeDraft } from '@/lib/composerDraftStore';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    onSelectionContextMenuAddToChat: () => () => undefined,
  } });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [new DOMRect(20, 100, 200, 24)] });
});
afterEach(() => { cleanup(); clearDraft('a'); clearDraft('b'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function select(container: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(container.querySelector('p')!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(container);
}

describe('selection annotation collection', () => {
  it('captures full original and metadata, then only updates the draft on confirmation', () => {
    const ref = createRef<HTMLDivElement>();
    let metadata = { startLine: 2, endLine: 3 };
    const text = 'x'.repeat(5001);
    const view = render(<div ref={ref}><p>{text}</p><SelectionQuoteButton sessionId="a" sourcePath="a.md" containerRef={ref} getQuoteMetadata={() => metadata} /></div>);
    const listener = vi.fn();
    const unsubscribe = subscribeDraft('a', listener);
    select(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
    expect(getDraft('a')).toBeUndefined();
    metadata = { startLine: 8, endLine: 9 };
    view.container.querySelector('p')!.textContent = 'streamed replacement';
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'one\n\ntwo\n' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(getDraft('a')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.confirm' }));
    expect(getDraft('a')?.text?.content?.[0]?.content?.[0]?.attrs).toEqual({ text, comment: 'one\n\ntwo\n', sourcePath: 'a.md', startLine: 2, endLine: 3 });
    expect(listener).toHaveBeenCalledWith({ focus: false });
    expect(getDraft('b')).toBeUndefined();
    unsubscribe();
  });

  it('cancels edits and discards stale selection UI after task or source switches', () => {
    const ref = createRef<HTMLDivElement>();
    const ui = (sessionId: string, sourcePath: string) => <div ref={ref}><p>selected</p><SelectionQuoteButton sessionId={sessionId} sourcePath={sourcePath} containerRef={ref} /></div>;
    const view = render(ui('a', 'a.md'));
    const open = () => { select(view.container); fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' })); };
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cancel me' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.cancel' }));
    expect(getDraft('a')).toBeUndefined();
    open();
    view.rerender(ui('b', 'a.md'));
    expect(screen.queryByRole('textbox')).toBeNull();
    open();
    view.rerender(ui('b', 'b.md'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(getDraft('a')).toBeUndefined();
    expect(getDraft('b')).toBeUndefined();
  });

  it('keeps the separate side-chat action available', async () => {
    const ref = createRef<HTMLDivElement>();
    const ask = vi.fn(async () => true);
    const view = render(<div ref={ref}><p>side question</p><SelectionQuoteButton sessionId="a" containerRef={ref} onAskInSideChat={ask} /></div>);
    select(view.container);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
    expect(ask).toHaveBeenCalledWith('side question');
    expect(getDraft('a')).toBeUndefined();

    // #7387 QA regression: a successful side chat opened from the comment
    // form must release editing state so the next selection can be collected.
    select(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.addToChat' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.title' })); });
    expect(screen.queryByRole('textbox')).toBeNull();
    select(view.container);
    expect(screen.getByRole('button', { name: 'chat.quote.addToChat' })).toBeTruthy();
    expect(getDraft('a')).toBeUndefined();
  });
});
