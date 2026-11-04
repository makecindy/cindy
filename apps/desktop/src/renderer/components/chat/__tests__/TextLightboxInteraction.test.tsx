// @vitest-environment jsdom
// #8356 r4436061992/r4436061986: production collection + text/diagram viewer.
// The existing text tests inspect source/line helpers; they cannot observe lost
// opening props or a missing close surface. Only editor/diagram engines are stubbed.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { TextLightbox } from '../TextLightbox';
import { AttachmentCollectionContext } from '../AttachmentCollection';

const state = vi.hoisted(() => ({ line: vi.fn(), parse: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), parse: state.parse } }));
vi.mock('@/components/markdown/PlaintextEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    PlaintextEditor: forwardRef(({ initialValue }: { initialValue: string }, ref) => {
      useImperativeHandle(ref, () => ({ scrollToLine: state.line, search: { clear: vi.fn(), findAll: vi.fn(() => 0), setActive: vi.fn() } }));
      return <pre>{initialValue}</pre>;
    }),
  };
});
vi.mock('../MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('../useCopyAsImage', () => ({ useCopyAsImage: () => ({ canAnnotate: false }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockFile(content: string) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      readTextFilePreview: vi
        .fn()
        .mockResolvedValue({ success: true, data: content, size: content.length }),
    },
  });
}

it('opens the referenced line in a collection and returns focus even after switching files', async () => {
  vi.useFakeTimers();
  mockFile('one\ntwo\nthree');
  function Host() {
    const [open, setOpen] = useState(true);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={triggerRef}>entry</button>
        {open && (
          <AttachmentCollectionContext.Provider
            value={[
              { id: 'one', name: 'one.txt', source: '/one.txt', kind: 'text' },
              { id: 'two', name: 'two.txt', source: '/two.txt', kind: 'text' },
            ]}
          >
            <TextLightbox
              filePath="/one.txt"
              initialLine={3}
              triggerRef={triggerRef}
              onClose={() => setOpen(false)}
            />
          </AttachmentCollectionContext.Provider>
        )}
      </>
    );
  }
  render(<Host />);
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(state.line).toHaveBeenCalledWith(3);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('attachmentPreview.next') }));
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.lightbox.close') }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  expect(document.activeElement).toBe(screen.getByText('entry'));
  expect(document.querySelector('[data-text-lightbox-overlay]')).toBeNull();
});

it.each(['pending', 'invalid'])('keeps the diagram %s state closable', async (phase) => {
  vi.useFakeTimers();
  state.parse.mockImplementation(() =>
    phase === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('invalid syntax')),
  );
  mockFile('invalid diagram');
  const close = vi.fn();
  render(<TextLightbox filePath="/flow.mmd" onClose={close} />);
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  const button = screen.getByRole('button', { name: i18n.t('chat.lightbox.close') });
  if (phase === 'pending') {
    // Mount autofocus may open a toolbar tooltip. This case tests the viewer's
    // own close surface; foreground tooltip ownership is covered separately.
    act(() => { document.querySelector<HTMLElement>('[data-text-lightbox-overlay]')?.focus(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
  }
  else fireEvent.click(button);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(close).toHaveBeenCalledOnce();
});


// PR #8022 UI regressions: the real TextLightbox capture listener must yield to
// a foreground popup/fullscreen surface. Earlier cases covered close buttons,
// not the event ownership that destroyed a preview while a menu was dismissing.
it.each(['menu', 'tooltip'] as const)('leaves Escape to a foreground %s', async (kind) => {
  vi.useFakeTimers();
  mockFile('preview content');
  const close = vi.fn();
  render(<TextLightbox filePath="/preview.txt" onClose={close} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  const overlay = document.querySelector<HTMLElement>('[data-text-lightbox-overlay]')!;
  const popup = document.createElement('div');
  popup.setAttribute('role', kind);
  popup.id = 'owned-popup';
  document.body.append(popup);
  const trigger = screen.getByRole('button', { name: i18n.t('chat.textLightbox.copyAll') });
  if (kind === 'tooltip') trigger.setAttribute('aria-describedby', popup.id);
  try {
    fireEvent.keyDown(kind === 'menu' ? popup : trigger, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(close).not.toHaveBeenCalled();
    expect(overlay.style.opacity).toBe('1');
  } finally {
    trigger.removeAttribute('aria-describedby');
    popup.remove();
  }
  fireEvent.keyDown(document.body, { key: 'Escape' });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(close).toHaveBeenCalledOnce();
});

it.each(['key-first', 'exit-first', 'keyup-before-exit', 'consumer-before-rerender'] as const)('keeps the document while fullscreen owns find and Escape (%s)', async (order) => {
  vi.useFakeTimers();
  mockFile('native fullscreen document');
  const close = vi.fn();
  const view = render(<TextLightbox filePath="/preview.md" onClose={close} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  const overlay = document.querySelector<HTMLElement>('[data-text-lightbox-overlay]')!;
  const player = document.createElement('video');
  player.tabIndex = 0;
  overlay.append(player);
  act(() => { player.focus(); });
  expect(document.activeElement).toBe(player);
  let fullscreen: Element | null = player;
  const original = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  try {
    fireEvent(document, new Event('fullscreenchange'));
    fireEvent.keyDown(player, { key: 'f', metaKey: true });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText('native fullscreen document')).toBeNull();
    if (order === 'consumer-before-rerender') {
      window.addEventListener('keydown', event => event.stopImmediatePropagation(), { capture: true, once: true });
      view.rerender(<TextLightbox filePath="/preview.md" onClose={() => close()} />);
      expect(document.activeElement).toBe(player);
    }
    if (order === 'exit-first') {
      fullscreen = null;
      fireEvent(document, new Event('fullscreenchange'));
    }
    if (order === 'keyup-before-exit') {
      // The rendered-find window listener can consume keydown before the
      // document listener; the native exit can still arrive after keyup.
      window.addEventListener('keydown', event => event.stopImmediatePropagation(), { capture: true, once: true });
    }
    fireEvent.keyDown(player, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(close).not.toHaveBeenCalled();
    expect(overlay.style.opacity).toBe('1');
    if (order === 'keyup-before-exit' || order === 'consumer-before-rerender') fireEvent.keyUp(player, { key: 'Escape' });
    if (order !== 'exit-first') {
      fullscreen = null;
      fireEvent(document, new Event('fullscreenchange'));
    }
    if (order !== 'keyup-before-exit' && order !== 'consumer-before-rerender') fireEvent.keyUp(player, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    if (original) Object.defineProperty(document, 'fullscreenElement', original);
    else Reflect.deleteProperty(document, 'fullscreenElement');
  }
});
