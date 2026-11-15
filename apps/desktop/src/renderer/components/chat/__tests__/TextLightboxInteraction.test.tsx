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
      useImperativeHandle(ref, () => ({ scrollToLine: state.line, search: { clear: vi.fn() } }));
      return <pre>{initialValue}</pre>;
    }),
  };
});
vi.mock('../MarkdownRenderer', () => ({ MarkdownRenderer: () => <video aria-label="Preview video" tabIndex={0} /> }));
vi.mock('../useCopyAsImage', () => ({ useCopyAsImage: () => ({ canAnnotate: false }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'fullscreenElement');
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

// Unit regression (#8481): with find closed, Chromium may deliver fullscreenchange
// before the same Escape keydown. Exercise the real lightbox close handler in both
// orders; only native fullscreen and document rendering are fixtures in jsdom.
it.each(['before', 'after'])('keeps the preview open when fullscreen exits %s Escape', async (order) => {
  vi.useFakeTimers();
  mockFile('# Video');
  const close = vi.fn();
  render(<TextLightbox filePath="/video.md" onClose={close} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  const video = screen.getByLabelText('Preview video');
  act(() => video.focus());
  let fullscreen: Element | null = video;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  fireEvent(document, new Event('fullscreenchange'));
  const exitFullscreen = () => {
    fullscreen = null;
    fireEvent(document, new Event('fullscreenchange'));
  };
  if (order === 'before') exitFullscreen();
  fireEvent.keyDown(video, { key: 'Escape' });
  if (order === 'after') exitFullscreen();
  await act(async () => { await vi.advanceTimersByTimeAsync(210); });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyUp(video, { key: 'Escape' });
  fireEvent.keyDown(video, { key: 'Escape' });
  await act(async () => { await vi.advanceTimersByTimeAsync(210); });
  expect(close).toHaveBeenCalledOnce();
});

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
  // Opening by pointer must not inherit the preceding test's keyboard tooltip.
  fireEvent.pointerDown(document.body);
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  const button = screen.getByRole('button', { name: i18n.t('chat.lightbox.close') });
  if (phase === 'pending') {
    // FocusScope can open the toolbar tooltip on entry. Its Escape must not
    // also close the document (the real Chromium regression found both firing).
    if (screen.queryByRole('tooltip')) {
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(close).not.toHaveBeenCalled();
    }
    fireEvent.keyDown(document.body, { key: 'Escape' });
  }
  else fireEvent.click(button);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(close).toHaveBeenCalledOnce();
});

// Unit regression from markdown-preview-find: the document capture listener
// closed the preview before Radix could handle its menu Escape. Use the real
// preview menu; engine stubs above do not replace keyboard ownership.
it('closes its menu before the document on Escape', async () => {
  vi.useFakeTimers();
  mockFile('content');
  const close = vi.fn();
  render(<TextLightbox filePath="/preview.md" onClose={close} />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  fireEvent.keyDown(screen.getByRole('button', { name: i18n.t('attachmentPreview.more') }), { key: 'Enter' });
  const menu = screen.getByRole('menu');
  fireEvent.keyDown(menu, { key: 'Escape' });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(close).toHaveBeenCalledOnce();
});
