// @vitest-environment jsdom

import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelectionQuoteButton } from '@/components/chat/SelectionQuoteButton';

const { appendQuoteToDraftMock } = vi.hoisted(() => ({
  appendQuoteToDraftMock: vi.fn(),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  appendQuoteToDraft: appendQuoteToDraftMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function Harness({ sessionId, sourcePath }: { sessionId: string; sourcePath?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={containerRef}>
        <span data-testid="selectable">quoted text</span>
      </div>
      <SelectionQuoteButton
        sessionId={sessionId}
        containerRef={containerRef}
        sourcePath={sourcePath}
      />
    </>
  );
}

function selectHarnessText() {
  const textNode = screen.getByTestId('selectable').firstChild;
  if (!textNode) throw new Error('missing selectable text node');

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent?.length ?? 0);
  Object.defineProperty(range, 'getClientRects', {
    configurable: true,
    value: () => [
      {
        left: 200,
        top: 200,
        right: 300,
        bottom: 220,
        width: 100,
        height: 20,
      } as DOMRect,
    ],
  });

  const selection = window.getSelection();
  if (!selection) throw new Error('missing window selection');
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(screen.getByTestId('selectable'));
  return selection;
}

describe('SelectionQuoteButton interaction', () => {
  beforeEach(() => {
    appendQuoteToDraftMock.mockReset();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSelectionContextMenuAddToChat: vi.fn(() => vi.fn()),
      } as unknown as Window['electronAPI'],
    });
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    vi.restoreAllMocks();
    delete (window as Partial<Window>).electronAPI;
  });

  it('keeps comment editing through selection collapse and discards it on session change', async () => {
    const user = userEvent.setup();
    const view = render(<Harness sessionId="session-a" />);
    const selection = selectHarnessText();

    await user.click(screen.getByRole('button', { name: 'chat.quote.comment' }));
    const textarea = screen.getByPlaceholderText('chat.quote.commentPlaceholder');

    selection.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(screen.getByRole('textbox')).toBe(textarea);

    await user.type(textarea, 'first line{Shift>}{Enter}{/Shift}second line');
    expect((textarea as HTMLTextAreaElement).value).toBe('first line\nsecond line');
    expect(appendQuoteToDraftMock).not.toHaveBeenCalled();

    view.rerender(<Harness sessionId="session-b" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.quote.submitComment' })).toBeNull();
    expect(appendQuoteToDraftMock).not.toHaveBeenCalled();
  });

  it('submits the original comment value to the captured session and source', async () => {
    const user = userEvent.setup();
    render(<Harness sessionId="session-a" sourcePath="src/example.ts" />);
    selectHarnessText();

    await user.click(screen.getByRole('button', { name: 'chat.quote.comment' }));
    const textarea = screen.getByPlaceholderText('chat.quote.commentPlaceholder');
    fireEvent.change(textarea, { target: { value: '\nfirst line\nsecond line\n' } });
    await user.click(screen.getByRole('button', { name: 'chat.quote.submitComment' }));

    expect(appendQuoteToDraftMock).toHaveBeenCalledTimes(1);
    expect(appendQuoteToDraftMock).toHaveBeenCalledWith('session-a', {
      text: 'quoted text',
      sourcePath: 'src/example.ts',
      comment: '\nfirst line\nsecond line\n',
    });
  });
});
