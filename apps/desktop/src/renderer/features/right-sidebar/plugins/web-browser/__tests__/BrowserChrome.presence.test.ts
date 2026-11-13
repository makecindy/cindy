// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { BrowserChrome, type BrowserChromeProps } from '../BrowserChrome';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const props: BrowserChromeProps = {
  visible: true, url: 'https://example.test/', isLoading: false,
  canGoBack: false, canGoForward: false, canOpenInSystemBrowser: true,
  commentActive: false, onNavigate: noop, onReload: noop, onStop: noop,
  onGoBack: noop, onGoForward: noop, onCaptureScreenshot: noop,
  onToggleComment: noop, onOpenInSystemBrowser: noop, onCopyLink: noop,
};

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

// Unit regression: existing presence coverage only exercised keyboard dismissal.
// Clicking a toolbar action used to blur page inputs; pointer-opened menus then
// restored their trigger instead of the original page. Use real focus defaults.
it('keeps page input focus for toolbar clicks and restores it after a pointer menu action', async () => {
  const user = userEvent.setup();
  const capture = vi.fn();
  const restoreNative = vi.fn();
  const copy = vi.fn();
  render(createElement('div', null,
    createElement('input', { 'aria-label': 'page input' }),
    createElement(BrowserChrome, { ...props, onCaptureScreenshot: capture, onCopyLink: copy, onRestorePageFocus: restoreNative }),
  ));
  const input = screen.getByRole('textbox', { name: 'page input' });
  await user.click(input);
  await user.click(screen.getByRole('button', { name: 'rightSidebar.browser.screenshot' }));
  expect(capture).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(input);
  await user.click(screen.getByRole('button', { name: 'rightSidebar.browser.goBackUnavailable' }));
  expect(document.activeElement).toBe(input);
  await user.click(screen.getByRole('button', { name: 'rightSidebar.browser.moreTools' }));
  await user.click(await screen.findByRole('menuitem', { name: 'rightSidebar.browser.copyLink' }));
  expect(copy).toHaveBeenCalledOnce();
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.keyboard('continued');
  expect((input as HTMLInputElement).value).toBe('continued');
  expect(restoreNative).not.toHaveBeenCalled();
});

// Native guest focus is represented by the host body, not a DOM webview.
// Regression #10449: pointer menu dismissal must use the native restoration
// boundary; keyboard dismissal and a hidden host must never request it. Unit.
it('restores a native page only after pointer dismissal while its host remains visible', async () => {
  const user = userEvent.setup();
  const restore = vi.fn();
  const view = render(createElement(BrowserChrome, { ...props, onRestorePageFocus: restore }));
  const trigger = screen.getByRole('button', { name: 'rightSidebar.browser.moreTools' });
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'rightSidebar.browser.copyLink' }));
  await waitFor(() => expect(restore).toHaveBeenCalledOnce());
  restore.mockClear();
  act(() => trigger.focus());
  await user.keyboard('{Enter}');
  await screen.findByRole('menu');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(restore).not.toHaveBeenCalled();
  act(() => trigger.blur());
  await user.click(trigger);
  await screen.findByRole('menu');
  view.rerender(createElement(BrowserChrome, { ...props, visible: false, onRestorePageFocus: restore }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(restore).not.toHaveBeenCalled();
});
