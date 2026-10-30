// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { BrowserChrome, type BrowserChromeProps } from '../BrowserChrome';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function animation(element: Element, type: 'animationstart' | 'animationend', name: string) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: name });
  fireEvent(element, event);
}

it('keeps external focus when the browser returns before its More exit animation ends', async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = getStyle(element);
    if (element.getAttribute('role') === 'menu') {
      // jsdom does not run CSS animations or return live computed styles.
      // Match the shared DropdownMenu float-in/out browser boundary, keeping
      // BrowserChrome, Radix Presence and delayed close autofocus real.
      Object.defineProperty(style, 'animationName', { configurable: true, get: () =>
        element.getAttribute('data-state') === 'closed' ? 'float-out' : 'float-in' });
    }
    return style;
  });
  const noop = () => undefined;
  const props: BrowserChromeProps = {
    visible: true, url: 'https://example.test/', isLoading: false,
    canGoBack: false, canGoForward: false, canOpenInSystemBrowser: true,
    commentActive: false, onNavigate: noop, onReload: noop, onStop: noop,
    onGoBack: noop, onGoForward: noop, onCaptureScreenshot: noop,
    onToggleComment: noop, onOpenInSystemBrowser: noop, onCopyLink: noop,
  };
  const view = render(createElement(BrowserChrome, props));
  const input = document.createElement('input');
  document.body.append(input);
  try {
    let trigger = screen.getByRole('button', { name: 'rightSidebar.browser.moreTools' });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(view.container.contains(menu)).toBe(false);
    animation(menu, 'animationstart', 'float-in');

    view.rerender(createElement(BrowserChrome, { ...props, visible: false }));
    expect(menu.getAttribute('data-state')).toBe('closed');
    expect(menu.isConnected).toBe(true); // Presence is waiting for float-out.
    view.rerender(createElement(BrowserChrome, props));
    // The closing modal still aria-hides new triggers until Presence exits.
    trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="rightSidebar.browser.moreTools"]',
    )!;
    expect(menu.isConnected).toBe(true);
    expect(trigger.getAttribute('data-state')).toBe('closed');
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    animation(menu, 'animationend', 'float-out');
    await waitFor(() => expect(menu.isConnected).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'rightSidebar.browser.moreTools' })).toBe(trigger);

    // A later ordinary dismissal must not inherit the earlier hidden close.
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const reopened = await screen.findByRole('menu');
    animation(reopened, 'animationstart', 'float-in');
    fireEvent.keyDown(reopened, { key: 'Escape' });
    expect(reopened.isConnected).toBe(true);
    animation(reopened, 'animationend', 'float-out');
    await waitFor(() => expect(reopened.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  } finally {
    view.unmount();
    input.remove();
  }
});
