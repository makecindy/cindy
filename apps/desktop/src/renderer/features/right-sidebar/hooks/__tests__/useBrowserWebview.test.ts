// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseBrowserWebviewResult } from '../useBrowserWebview';
import {
  BROWSER_NAVIGATION_FUSE_LIMIT,
  useBrowserWebview,
} from '../useBrowserWebview';

interface MockWebview {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatch: (type: string, event?: Record<string, unknown>) => void;
  getURL: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

let mockWebview: MockWebview;

vi.mock('../../lib/browserWebviewPool', () => ({
  browserWebviewPool: {
    acquire: vi.fn(() => ({
      wrapper: document.createElement('div'),
      webview: mockWebview,
    })),
  },
}));

vi.mock('../../lib/rsbBrowserBridge', () => ({
  reportRsbBrowserTab: vi.fn(),
  subscribeTabResourceEvent: vi.fn(() => () => undefined),
  consumePendingKillCause: vi.fn(() => null),
}));

function makeMockWebview(initialUrl: string): MockWebview {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  return {
    addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch: (type: string, event: Record<string, unknown> = {}) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    getURL: vi.fn(() => initialUrl),
    loadURL: vi.fn(),
    setAttribute: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    stop: vi.fn(),
  };
}

function HookProbe({ onResult }: { onResult: (result: UseBrowserWebviewResult) => void }) {
  const result = useBrowserWebview('tab-a', 'session-a');
  onResult(result);
  return null;
}

describe('useBrowserWebview', () => {
  beforeEach(() => {
    mockWebview = makeMockWebview('https://www.taptap.cn/');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('restores the real webview URL when an optimistic navigation is aborted', () => {
    let result: UseBrowserWebviewResult | null = null;
    const current = () => {
      if (result === null) throw new Error('hook result was not captured');
      return result;
    };
    render(createElement(HookProbe, { onResult: (next) => { result = next; } }));

    expect(current().url).toBe('https://www.taptap.cn/');

    act(() => {
      current().navigate('https://www.google.com/');
    });
    expect(current().url).toBe('https://www.google.com/');

    act(() => {
      mockWebview.dispatch('did-fail-load', { errorCode: -3 });
    });

    expect(current().url).toBe('https://www.taptap.cn/');
    expect(current().isLoading).toBe(false);
  });

  it('does not publish redirect intermediates as committed URLs', () => {
    let result: UseBrowserWebviewResult | null = null;
    const current = () => {
      if (result === null) throw new Error('hook result was not captured');
      return result;
    };
    render(createElement(HookProbe, { onResult: (next) => { result = next; } }));

    act(() => {
      mockWebview.dispatch('did-redirect-navigation', {
        url: 'https://accounts.example.com/authorize',
      });
    });
    expect(current().url).toBe('https://www.taptap.cn/');

    act(() => {
      mockWebview.dispatch('did-navigate', {
        url: 'https://www.taptap.cn/auth/callback',
      });
    });
    expect(current().url).toBe('https://www.taptap.cn/auth/callback');
  });

  it('stops programmatic navigation bursts and reload clears the fuse', () => {
    let result: UseBrowserWebviewResult | null = null;
    const current = () => {
      if (result === null) throw new Error('hook result was not captured');
      return result;
    };
    render(createElement(HookProbe, { onResult: (next) => { result = next; } }));

    act(() => {
      for (let i = 0; i <= BROWSER_NAVIGATION_FUSE_LIMIT; i += 1) {
        current().navigate(`https://example.com/${i}`);
      }
    });

    expect(mockWebview.loadURL).toHaveBeenCalledTimes(BROWSER_NAVIGATION_FUSE_LIMIT);
    expect(mockWebview.stop).toHaveBeenCalledOnce();
    expect(current().crash).toEqual({ reason: 'navigation-loop' });
    expect(current().isLoading).toBe(false);

    act(() => current().reload());
    expect(mockWebview.reload).toHaveBeenCalledOnce();
    expect(current().crash).toBeNull();

    act(() => current().navigate('https://example.com/recovered'));
    expect(mockWebview.loadURL).toHaveBeenCalledTimes(BROWSER_NAVIGATION_FUSE_LIMIT + 1);
  });
});
