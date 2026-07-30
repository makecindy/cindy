// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { WebviewTag } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_COMMENT_CANCEL_PENDING_CHANNEL,
  BROWSER_COMMENT_COMMAND_RESULT_CHANNEL,
  BROWSER_COMMENT_COMMIT_PENDING_CHANNEL,
  BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
  BROWSER_COMMENT_ENTER_MODE_CHANNEL,
  BROWSER_COMMENT_EXIT_MODE_CHANNEL,
  BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
  type BrowserCommentCommandEnvelope,
  type BrowserCommentCommandResult,
  type BrowserCommentTargetInfo,
} from '../../../../../../shared/browserComment';
import { useBrowserComment, type UseBrowserCommentResult } from '../useBrowserComment';

const draftMocks = vi.hoisted(() => ({
  append: vi.fn(),
  getDraft: vi.fn(() => ({
    text: null,
    attachments: [],
    quotes: [],
    browserComments: [],
  })),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  appendBrowserCommentToDraft: draftMocks.append,
  getDraft: draftMocks.getDraft,
}));

vi.mock('@/lib/toast', () => ({
  toast: toastMocks,
}));

vi.mock('@/features/cc-agent/newMakerDraftRightSidebar', () => ({
  composerDraftKeyForRightSidebarSession: (sessionId: string) => sessionId,
}));

type WebviewListener = (event: { channel?: string; args?: unknown[] }) => void;

interface MockWebview {
  value: WebviewTag;
  send: ReturnType<typeof vi.fn>;
  dispatchIpc: (channel: string, ...args: unknown[]) => void;
  dispatch: (type: string) => void;
  listenerCount: (type: string) => number;
}

function makeWebview(
  sendImpl: (channel: string, payload: unknown) => Promise<void> = async () => undefined,
): MockWebview {
  const listeners = new Map<string, Set<WebviewListener>>();
  const send = vi.fn(sendImpl);
  const value = {
    send,
    addEventListener: (type: string, listener: WebviewListener) => {
      const current = listeners.get(type) ?? new Set<WebviewListener>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener: (type: string, listener: WebviewListener) => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as WebviewTag;
  return {
    value,
    send,
    dispatchIpc: (channel, ...args) => {
      for (const listener of listeners.get('ipc-message') ?? []) {
        listener({ channel, args });
      }
    },
    dispatch: (type) => {
      for (const listener of listeners.get(type) ?? []) listener({});
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
}

const TARGET: BrowserCommentTargetInfo = {
  kind: 'element',
  point: { x: 120, y: 80 },
  viewport: { width: 1280, height: 720 },
  region: null,
  selectedText: null,
  immediate: false,
  targetTag: 'button',
  targetLabel: 'Save',
  targetRole: 'button',
  targetSelector: '#save',
  targetPath: 'html > body > button#save',
  nearbyText: 'Save changes',
  themeVariant: 'light',
  designBaseline: null,
  markerNumber: 1,
};

function HookProbe({
  webview,
  onResult,
}: {
  webview: WebviewTag | null;
  onResult: (result: UseBrowserCommentResult) => void;
}) {
  const result = useBrowserComment('tab-a', 'session-a', webview, () => 'https://example.com/');
  onResult(result);
  return null;
}

function lastCommand(mock: MockWebview): {
  command: string;
  envelope: BrowserCommentCommandEnvelope;
} {
  const call = mock.send.mock.calls.at(-1);
  if (!call) throw new Error('expected a WebView command');
  return {
    command: call[0] as string,
    envelope: call[1] as BrowserCommentCommandEnvelope,
  };
}

async function acknowledgeLastCommand(mock: MockWebview, ok = true): Promise<void> {
  const { command, envelope } = lastCommand(mock);
  const result: BrowserCommentCommandResult = {
    requestId: envelope.requestId,
    command: command as BrowserCommentCommandResult['command'],
    ok,
  };
  await act(async () => {
    mock.dispatchIpc(BROWSER_COMMENT_COMMAND_RESULT_CHANNEL, result);
  });
}

async function enterSelecting(
  mock: MockWebview,
  getResult: () => UseBrowserCommentResult,
): Promise<void> {
  act(() => getResult().toggle());
  expect(lastCommand(mock).command).toBe(BROWSER_COMMENT_ENTER_MODE_CHANNEL);
  await acknowledgeLastCommand(mock);
  expect(getResult().mode).toBe('selecting');
}

describe('useBrowserComment', () => {
  beforeEach(() => {
    draftMocks.append.mockReset();
    draftMocks.getDraft.mockClear();
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        rsbBrowserBridge: {
          captureScreenshotData: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]) })),
        },
        cacheImageFromBuffer: vi.fn(async () => ({ url: 'xdt-image://cached/comment.png' })),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it('binds events to each WebView generation and accepts selections after replacement', async () => {
    const first = makeWebview();
    const second = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    const view = render(
      createElement(HookProbe, {
        webview: first.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );

    await enterSelecting(first, () => result!);
    act(() => first.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));
    expect(result!.mode).toBe('pending');

    view.rerender(
      createElement(HookProbe, {
        webview: second.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );

    expect(result!.mode).toBe('off');
    expect(first.listenerCount('ipc-message')).toBe(0);
    expect(second.listenerCount('ipc-message')).toBe(1);

    await enterSelecting(second, () => result!);
    act(() => second.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));
    expect(result!.mode).toBe('pending');
  });

  it('does not claim comment mode when enter-mode delivery fails', async () => {
    const webview = makeWebview(async () => {
      throw new Error('detached');
    });
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );

    act(() => result!.toggle());
    expect(result!.mode).toBe('starting');
    await waitFor(() => expect(result!.mode).toBe('off'));
    expect(toastMocks.error).toHaveBeenCalledWith('rightSidebar.browser.commentFailed');
  });

  it('returns to off when a delivered enter command is never acknowledged', async () => {
    vi.useFakeTimers();
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );

    act(() => result!.toggle());
    expect(result!.mode).toBe('starting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(result!.mode).toBe('off');
    expect(lastCommand(webview).command).toBe(BROWSER_COMMENT_EXIT_MODE_CHANNEL);
    expect(toastMocks.error).toHaveBeenCalledWith('rightSidebar.browser.commentFailed');
  });

  it('keeps the pending target mounted when screenshot preparation fails', async () => {
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );
    await enterSelecting(webview, () => result!);
    act(() => webview.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));

    act(() => result!.submit('Do not lose this comment'));
    expect(lastCommand(webview).command).toBe(BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL);
    await acknowledgeLastCommand(webview, false);

    expect(result!.mode).toBe('pending');
    expect(result!.pendingTarget).toEqual(TARGET);
    expect(draftMocks.append).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith('rightSidebar.browser.commentFailed');
  });

  it('keeps the pending target mounted when capture fails after preparation', async () => {
    vi.mocked(window.electronAPI.rsbBrowserBridge.captureScreenshotData).mockRejectedValueOnce(
      new Error('capture failed'),
    );
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );
    await enterSelecting(webview, () => result!);
    act(() => webview.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));

    act(() => result!.submit('Keep this draft in the popover'));
    await acknowledgeLastCommand(webview);

    await waitFor(() => expect(result!.mode).toBe('pending'));
    expect(result!.pendingTarget).toEqual(TARGET);
    expect(draftMocks.append).not.toHaveBeenCalled();
    expect(lastCommand(webview).command).toBe(BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL);
    expect(toastMocks.error).toHaveBeenCalledWith('rightSidebar.browser.commentFailed');
  });

  it('cancels an immediate marker and resumes selecting when capture fails', async () => {
    vi.mocked(window.electronAPI.rsbBrowserBridge.captureScreenshotData).mockRejectedValueOnce(
      new Error('capture failed'),
    );
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );
    await enterSelecting(webview, () => result!);
    act(() =>
      webview.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, {
        ...TARGET,
        immediate: true,
      }),
    );

    expect(result!.mode).toBe('submitting');
    await acknowledgeLastCommand(webview);
    await waitFor(() => {
      expect(lastCommand(webview).command).toBe(BROWSER_COMMENT_CANCEL_PENDING_CHANNEL);
    });
    await acknowledgeLastCommand(webview);

    expect(result!.mode).toBe('selecting');
    expect(result!.pendingTarget).toBeNull();
    expect(draftMocks.append).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith('rightSidebar.browser.commentFailed');
  });

  it('writes the Composer draft once and waits for guest commit acknowledgement', async () => {
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );
    await enterSelecting(webview, () => result!);
    act(() => webview.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));

    act(() => result!.submit('Move this button'));
    await acknowledgeLastCommand(webview);
    await waitFor(() => {
      expect(lastCommand(webview).command).toBe(BROWSER_COMMENT_COMMIT_PENDING_CHANNEL);
    });

    expect(draftMocks.append).toHaveBeenCalledOnce();
    expect(draftMocks.append.mock.calls[0]?.[1]).toMatchObject({
      comment: 'Move this button',
      target: TARGET,
    });
    expect(result!.mode).toBe('submitting');

    await acknowledgeLastCommand(webview);
    expect(result!.mode).toBe('selecting');
    expect(result!.pendingTarget).toBeNull();
    expect(toastMocks.success).toHaveBeenCalledWith('rightSidebar.browser.commentAdded');
  });

  it('keeps an already-written comment and exits cleanly when guest commit fails', async () => {
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );
    await enterSelecting(webview, () => result!);
    act(() => webview.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));

    act(() => result!.submit('Preserve the committed draft'));
    await acknowledgeLastCommand(webview);
    await waitFor(() => {
      expect(lastCommand(webview).command).toBe(BROWSER_COMMENT_COMMIT_PENDING_CHANNEL);
    });
    await acknowledgeLastCommand(webview, false);

    expect(draftMocks.append).toHaveBeenCalledOnce();
    expect(result!.mode).toBe('off');
    expect(result!.pendingTarget).toBeNull();
    expect(toastMocks.success).toHaveBeenCalledWith('rightSidebar.browser.commentAdded');
  });

  it('exits on navigation and ignores the old generation afterwards', async () => {
    const webview = makeWebview();
    let result: UseBrowserCommentResult | null = null;
    render(
      createElement(HookProbe, {
        webview: webview.value,
        onResult: (next) => {
          result = next;
        },
      }),
    );
    await enterSelecting(webview, () => result!);

    act(() => webview.dispatch('did-navigate'));

    expect(result!.mode).toBe('off');
    act(() => webview.dispatchIpc(BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL, TARGET));
    expect(result!.pendingTarget).toBeNull();
  });
});
