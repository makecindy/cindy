// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseBrowserWebviewResult } from '../../../hooks/useBrowserWebview';
import type { TabKindHostContext } from '../../../types';
import { BrowserTabBody } from '../BrowserTabBody';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Electron surface boundaries only: Body, Chrome, comment lifecycle, Tip and Radix are real.
vi.mock('../../../hooks/useBrowserWebview', () => ({ useBrowserWebview: () => browser }));
vi.mock('../../../hooks/useNativePopupSurface', () => ({
  useNativePopupSurface: () => ({ ...browser, wrapper: null, closed: false }),
}));
const noop = () => undefined;
const browser: UseBrowserWebviewResult = {
  wrapper: null, webview: null, url: 'https://example.test/', title: '', favicon: '',
  isLoading: false, canGoBack: false, canGoForward: false, isAudible: false,
  crash: null, resourceAlert: { cpuPercent: 95 }, navigate: noop, reload: noop,
  goBack: noop, goForward: noop, stop: noop, dismissResourceAlert: vi.fn(),
};
const ctx: TabKindHostContext = {
  tabId: 'resource-tip-tab', sessionId: 'resource-tip-session', workdir: '/repo',
  remoteHostId: null, deviceLinkDeviceId: null, patchState: noop,
  onVisibilityChange: noop, setCloseInterceptor: () => noop,
};
const props = {
  ctx, active: true, shellVisible: true,
  state: { url: browser.url, title: '', favicon: null, isAudible: false },
};
const cases = (['task switch', 'sidebar hide'] as const).flatMap((boundary) =>
  (['focus', 'hover', 'pending hover'] as const).map((interaction) => ({ boundary, interaction })),
);
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('BrowserTabBody resource tooltip lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'darwin', onRsbBrowserFocusUrlBar: () => noop,
        onRsbBrowserCommand: () => noop,
      },
    });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

  for (const { boundary, interaction } of cases) {
    it(`clears resource tip on ${boundary} with ${interaction}`, async () => {
      const view = render(createElement(BrowserTabBody, props));
      const trigger = () => screen.getByRole('button', { name: 'rightSidebar.browser.resourceAlert.dismiss' });
      const hover = () => fireEvent.pointerMove(trigger(), { pointerType: 'mouse' });
      if (interaction === 'focus') act(() => trigger().focus());
      else hover();
      await tick(interaction === 'hover' ? 550 : 0);
      if (interaction === 'pending hover') expect(screen.queryByRole('tooltip')).toBeNull();
      else {
        const tip = screen.getByRole('tooltip');
        expect(tip.textContent).toBe('rightSidebar.browser.resourceAlert.dismiss');
        expect(view.container.contains(tip)).toBe(false);
      }
      // Real Body visibility props, without synthetic blur or pointerleave.
      view.rerender(createElement(BrowserTabBody, {
        ...props, ...(boundary === 'task switch' ? { active: false } : { shellVisible: false }),
      }));
      expect(screen.queryByRole('tooltip')).toBeNull();
      view.rerender(createElement(BrowserTabBody, props));
      await tick(600);
      expect(screen.queryByRole('tooltip')).toBeNull();
      if (interaction === 'focus') act(() => trigger().focus());
      else hover();
      await tick(550);
      expect(screen.getByRole('tooltip').textContent).toBe('rightSidebar.browser.resourceAlert.dismiss');
      fireEvent.click(trigger());
      expect(browser.dismissResourceAlert).toHaveBeenCalledOnce();
    });
  }
});
