// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ menu: null as any, native: true }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, testID }: any) => <button data-testid={testID} disabled={disabled} onClick={onPress}>{children}</button>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({ Copy: () => null, Check: () => null, Ellipsis: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  usesNativePullDownMenu: () => h.native,
  NativePullDownMenu: (props: any) => { h.menu = props; return props.children; },
}));
vi.mock('@/theme', () => ({ iconSize: { sm: 14 }, spacing: { md: 12 }, useTheme: () => ({ colors: {} }) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: () => null }));
import { CompanionMessageActions } from '@/session/CompanionMessageActions';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root; let container: HTMLDivElement;
const onAction = vi.fn();
const actions = [{ id: 'copy', title: 'Copy' }, { id: 'time', title: 'Sent 9:41', disabled: true }];
async function render(disabled: boolean) {
  await act(async () => root.render(createElement(CompanionMessageActions, { user: false, copied: false, copying: false, disabled, actions, onAction })));
}
beforeEach(() => { vi.clearAllMocks(); h.menu = null; container = document.createElement('div'); root = createRoot(container); });
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
