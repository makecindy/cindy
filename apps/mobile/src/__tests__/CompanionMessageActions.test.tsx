// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ menu: null as any, sheet: null as any, native: true }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, testID }: any) => <button data-testid={testID} disabled={disabled} onClick={onPress}>{children}</button>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({ Copy: () => null, Check: () => null, Ellipsis: () => null }));
vi.mock('@/components/ChatReplyIcon', () => ({ ChatReplyIcon: () => <svg data-testid="chatReplyIcon" /> }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  usesNativePullDownMenu: () => h.native,
  NativePullDownMenu: (props: any) => { h.menu = props; return props.children; },
}));
vi.mock('@/theme', () => ({ iconSize: { sm: 14 }, iconStroke: { regular: 2 }, spacing: { md: 12 }, useTheme: () => ({ colors: {} }) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: (props: any) => { h.sheet = props; return props.visible ? props.children : null; } }));
import { CompanionMessageActions } from '@/session/CompanionMessageActions';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root; let container: HTMLDivElement;
const onAction = vi.fn();
const actions = [{ id: 'copy', title: 'Copy' }, { id: 'time', title: 'Sent 9:41', disabled: true }];
async function render(disabled: boolean, items = actions, user = false) {
  await act(async () => root.render(createElement(CompanionMessageActions, { user, copied: false, copying: false, disabled, actions: items, onAction })));
}
beforeEach(() => { vi.clearAllMocks(); h.menu = null; h.sheet = null; h.native = true; container = document.createElement('div'); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); });

it('passes the item list, including the disabled sent-time line, to the system menu', async () => {
  await render(false);
  expect(h.menu.actions).toEqual(actions);
  await act(async () => h.menu.onAction('copy')); expect(onAction).toHaveBeenCalledWith('copy');
});

it('does not open the system menu from a disabled More button', async () => {
  await render(true);
  expect(h.menu).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="companion.messageMore"]')!.disabled).toBe(true);
});

it.each([false, true])('exposes Reply for user=%s and reuses the existing composer action', async user => {
  await render(false, [...actions, { id: 'add-to-chat', title: 'Add to chat' }], user);
  const reply = container.querySelector<HTMLButtonElement>('[data-testid="companion.messageReply"]')!;
  expect(reply.querySelector('[data-testid="chatReplyIcon"]')).not.toBeNull();
  expect(h.menu.actions).toEqual(actions);
  await act(async () => reply.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith('add-to-chat');
});

it.each([[true, false], [false, true]])('keeps Reply disabled when the bar=%s or action=%s is disabled', async (disabled, actionDisabled) => {
  await render(disabled, [...actions, { id: 'add-to-chat', title: 'Add to chat', disabled: actionDisabled }]);
  const reply = container.querySelector<HTMLButtonElement>('[data-testid="companion.messageReply"]')!;
  expect(reply.disabled).toBe(true);
  await act(async () => reply.click());
  expect(onAction).not.toHaveBeenCalled();
});

it('omits Reply when the composer action is unavailable', async () => {
  await render(false);
  expect(container.querySelector('[data-testid="companion.messageReply"]')).toBeNull();
});

it.each([false, true])('copies either side directly and disables repeated copying (user=%s)', async user => {
  const onCopy = vi.fn();
  const props = { user, copied: false, copying: false, disabled: false, actions, onAction, onCopy };
  await act(async () => root.render(<CompanionMessageActions {...props} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="message.copyButton"]')!.click());
  expect(onCopy).toHaveBeenCalledOnce();
  await act(async () => root.render(<CompanionMessageActions {...props} copying />));
  const copy = container.querySelector<HTMLButtonElement>('[data-testid="message.copyButton"]')!;
  expect(copy.disabled).toBe(true);
  await act(async () => copy.click());
  expect(onCopy).toHaveBeenCalledOnce();
});

it('also removes the duplicate composer action from the fallback sheet', async () => {
  h.native = false;
  await render(false, [...actions, { id: 'add-to-chat', title: 'Add to chat' }]);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="companion.messageMore"]')!.click());
  expect(h.sheet.visible).toBe(true);
  expect(container.textContent).not.toContain('Add to chat');
  expect(container.textContent).toContain('Copy');
});
