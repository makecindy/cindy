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
  if (phase === 'pending') fireEvent.keyDown(document.body, { key: 'Escape' });
  else fireEvent.click(button);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(close).toHaveBeenCalledOnce();
});
