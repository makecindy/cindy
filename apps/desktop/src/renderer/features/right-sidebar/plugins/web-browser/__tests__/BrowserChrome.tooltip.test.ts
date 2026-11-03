// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { BrowserChrome, type BrowserChromeProps } from '../BrowserChrome';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const noop = () => undefined;
const base: BrowserChromeProps = {
  url: 'https://example.test/', isLoading: false, canGoBack: true, canGoForward: true,
  commentActive: false, canOpenInSystemBrowser: true,
  onNavigate: noop, onReload: noop, onStop: noop, onGoBack: noop, onGoForward: noop,
  onCaptureScreenshot: noop, onToggleComment: noop, onOpenInSystemBrowser: noop, onCopyLink: noop,
};
const actions: Array<[string, Partial<BrowserChromeProps>]> = [
  ['goBack', {}], ['goBackUnavailable', { canGoBack: false }],
  ['goForward', {}], ['goForwardUnavailable', { canGoForward: false }],
  ['reload', {}], ['stop', { isLoading: true }], ['screenshot', {}],
  ['comment', {}], ['exitCommentMode', { commentActive: true }], ['moreTools', {}],
];
const cases = actions.flatMap(([label, overrides]) =>
  (['focus', 'hover', 'pending hover'] as const).map((interaction) => ({ label, overrides, interaction })),
);

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('BrowserChrome tooltip lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it.each(cases)('clears $label $interaction on inactivity and allows a new interaction', async ({ label, overrides, interaction }) => {
    const props = { ...base, ...overrides };
    const view = render(createElement(BrowserChrome, props));
    const trigger = () => screen.getByRole('button', { name: `rightSidebar.browser.${label}` });
    const hover = () => fireEvent.pointerMove(trigger(), { pointerType: 'mouse' });
    if (interaction === 'focus') act(() => trigger().focus());
    else hover();
    await tick(interaction === 'hover' ? 550 : 0);
    if (interaction === 'pending hover') expect(screen.queryByRole('tooltip')).toBeNull();
    else {
      const tip = screen.getByRole('tooltip');
      expect(tip.textContent).toBe(`rightSidebar.browser.${label}`);
      expect(view.container.contains(tip)).toBe(false); // Real Tip/Radix body portal.
    }

    // The actual retained-host boundary; no synthetic blur/pointerleave closes it.
    view.rerender(createElement(BrowserChrome, { ...props, visible: false }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Return before the original 500ms deadline, without new pointer/focus input.
    view.rerender(createElement(BrowserChrome, props));
    await tick(600);
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Reacquire the visible control and intentionally request its normal tip.
    if (interaction === 'focus') act(() => trigger().focus());
    else hover();
    await tick(550);
    expect(screen.getByRole('tooltip').textContent).toBe(`rightSidebar.browser.${label}`);
  });
});
