// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shortcut = vi.hoisted(() => ({ handler: null as null | (() => boolean) }));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcut: (_id: string, handler: () => boolean) => {
    shortcut.handler = handler;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FindInPageBar } from '../FindInPageBar';

describe('FindInPageBar', () => {
  const findInPage = vi.fn<(params: {
    text: string;
    forward?: boolean;
    findNext?: boolean;
  }) => Promise<number>>();
  const stopFindInPage = vi.fn();

  beforeEach(() => {
    findInPage.mockReset();
    findInPage.mockResolvedValue(1);
    stopFindInPage.mockReset();
    shortcut.handler = null;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      findInPage,
      stopFindInPage,
      onFindInPageResult: vi.fn(() => vi.fn()),
    };
  });

  afterEach(cleanup);

  async function openFindBar() {
    const view = render(<FindInPageBar />);
    expect(shortcut.handler).not.toBeNull();
    await act(async () => {
      shortcut.handler?.();
    });
    return { view, input: view.getByRole('textbox') as HTMLInputElement };
  }

  it('waits for IME composition to finish before searching the committed text', async () => {
    const { input } = await openFindBar();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'n' } });
    fireEvent.change(input, { target: { value: 'ni' } });
    expect(findInPage).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '你' } });
    fireEvent.compositionEnd(input);

    await waitFor(() => {
      expect(findInPage).toHaveBeenCalledTimes(1);
      expect(findInPage).toHaveBeenCalledWith({ text: '你', forward: true, findNext: true });
    });

    // Some Chromium versions emit one final change after compositionend.
    fireEvent.change(input, { target: { value: '你' } });
    expect(findInPage).toHaveBeenCalledTimes(1);
  });

  it('keeps IME composition intact after an earlier search', async () => {
    const { input } = await openFindBar();

    fireEvent.change(input, { target: { value: 'a' } });
    await waitFor(() => expect(findInPage).toHaveBeenCalledTimes(1));
    findInPage.mockClear();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'z' } });
    fireEvent.change(input, { target: { value: 'zhong' } });
    expect(findInPage).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '中' } });
    fireEvent.compositionEnd(input);

    await waitFor(() =>
      expect(findInPage).toHaveBeenCalledWith({ text: '中', forward: true, findNext: true }),
    );
  });

  it('continues the current Electron search session for Enter navigation', async () => {
    const { input } = await openFindBar();

    fireEvent.change(input, { target: { value: 'term' } });
    await waitFor(() => expect(findInPage).toHaveBeenCalledTimes(1));
    findInPage.mockClear();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(findInPage).toHaveBeenCalledWith({ text: 'term', forward: true, findNext: false });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(findInPage).toHaveBeenLastCalledWith({
      text: 'term',
      forward: false,
      findNext: false,
    });
  });

  it('does not treat a Windows IME confirmation key as find-next', async () => {
    const { input } = await openFindBar();

    fireEvent.change(input, { target: { value: 'term' } });
    await waitFor(() => expect(findInPage).toHaveBeenCalledTimes(1));
    findInPage.mockClear();

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(findInPage).not.toHaveBeenCalled();
  });
});
