// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';

const fit = vi.fn();
const resize = vi.fn(async () => undefined);
const entry = {
  terminal: {
    cols: 80,
    rows: 24,
    element: undefined,
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    focus: vi.fn(),
  },
  fitAddon: { fit },
  lastSize: { cols: 80, rows: 24 },
  ptyAttached: true,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('../lib/xtermPool', () => ({
  getOrCreateXterm: () => entry,
}));

import { TerminalTabBody } from '../TerminalTabBody';

class TestResizeObserver {
  static callback: ResizeObserverCallback | null = null;
  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeContext(): TabKindHostContext {
  return {
    tabId: 'terminal-1',
    sessionId: 'session-1',
    workdir: '/workspace',
    remoteHostId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
  };
}

beforeEach(() => {
  fit.mockClear();
  resize.mockClear();
  entry.terminal.open.mockClear();
  entry.terminal.onData.mockClear();
  entry.terminal.cols = 80;
  entry.terminal.rows = 24;
  entry.lastSize = { cols: 80, rows: 24 };
  TestResizeObserver.callback = null;
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      terminal: {
        create: vi.fn(async () => ({ shellId: 'zsh', shellDisplayName: 'zsh' })),
        resize,
        restart: vi.fn(),
        write: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalTabBody sidebar visibility', () => {
  it('does not fit or resize the PTY while the sidebar is collapsed, then refits when visible', () => {
    const ctx = makeContext();
    const view = render(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );

    TestResizeObserver.callback?.([], {} as ResizeObserver);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    entry.terminal.cols = 100;
    view.rerender(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    expect(fit).toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith('terminal-1', 100, 24);
  });

  it('drops an already queued fit when the sidebar collapses before its animation frame', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const ctx = makeContext();
    const view = render(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible
      />,
    );

    entry.terminal.cols = 2;
    view.rerender(
      <TerminalTabBody
        state={{ created: true, exited: null, title: '', shellId: '', shellDisplayName: '' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );
    frame?.(0);

    expect(resize).not.toHaveBeenCalled();
  });
});
