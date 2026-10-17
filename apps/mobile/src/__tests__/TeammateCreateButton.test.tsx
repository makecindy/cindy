// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ account: 1, button: {} as any, menu: {} as any, sheet: null as any, groupSheet: null as any, groupCreated: vi.fn(), created: vi.fn(), alert: vi.fn() }));
vi.mock('expo-router', () => ({ Stack: { Toolbar: Object.assign(({ children }: any) => children, {
  Button: (props: any) => createElement('button', { onClick: props.onPress }, props.accessibilityLabel),
  Menu: ({ children, title, accessibilityLabel }: any) => createElement('section', { 'aria-label': title ?? accessibilityLabel }, children),
  MenuAction: (props: any) => createElement('button', { onClick: props.onPress, disabled: props.disabled }, props.children),
}) } }));
vi.mock('react-native', () => ({ Alert: { alert: h.alert } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({ Plus: () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.account }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: (props: any) => createElement('button', { 'data-testid': props.testID, onClick: props.onPress }, props.label) }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({ usesNativePullDownMenu: () => true, NativePullDownMenu: (props: any) => { h.menu = props; return props.children; } }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: (props: any) => { h.button = props; return null; } }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: () => null }));
vi.mock('@/session/CompanionProfileSheet', () => ({ CompanionCreateSheet: (props: any) => { h.sheet = props; return null; } }));
vi.mock('@/session/useTeammateRoster', () => ({ TEAMMATE_COLLECTION_ID: 'teammates' }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: () => null }));
vi.mock('@/session/BotGroupCreateSheet', () => ({ BotGroupCreateSheet: (props: any) => { h.groupSheet = props; return null; } }));
import { TeammateCreateButton } from '@/session/TeammateCreateButton';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hosts = [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }];
const ref = { collectionId: 'teammates', kind: 'bot', id: 'confirmed' };
let root: Root | undefined;
let node: HTMLDivElement;
async function render(targets = hosts) { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(TeammateCreateButton, { targets, preferredDeviceId: 'pc', onCreated: h.created }))); }
beforeEach(() => { vi.clearAllMocks(); h.account = 1; h.sheet = null; });
afterEach(() => { act(() => root?.unmount()); root = undefined; });
it('uses real menu hosts, prefers the remembered host, and dispatches receipts after form dismissal', async () => {
  await render(); expect(h.menu.actions.map((action: any) => action.title)).toEqual(['PC', 'Mac']); expect(h.sheet).toBeNull();
  await act(async () => h.menu.onAction('pc'));
  expect(h.sheet.deviceId).toBe('pc'); expect(h.sheet.visible).toBe(true);
  await act(async () => { h.sheet.onCreated(ref); h.sheet.onClose(); }); expect(h.created).not.toHaveBeenCalled();
  await act(async () => { h.sheet.onClosed(); h.sheet.onClosed(); }); expect(h.created).toHaveBeenCalledExactlyOnceWith(hosts[1], ref);
});
it('opens the sole capable host, never an empty device', async () => {
  await render([]); await act(async () => h.button.onPress()); expect(h.sheet).toBeNull();
  expect(h.alert).toHaveBeenCalledWith('devices.companionProfile.create', 'devices.companions.noCreateHosts');
  await render([hosts[0]]); await act(async () => h.button.onPress()); expect(h.sheet.deviceId).toBe('mac');
});
it('fences late native menu and create dismissal callbacks after account replacement', async () => {
  await render(); const oldMenu = h.menu; await act(async () => h.menu.onAction('mac'));
  await act(async () => h.sheet.onCreated(ref)); const oldSheet = h.sheet;
  h.account++; await render();
  await act(async () => { oldMenu.onAction('pc'); oldSheet.onClosed(); }); expect(h.created).not.toHaveBeenCalled();
});

async function toolbar(targets = hosts, groupTargets = [] as typeof hosts) {
  if (!root) { node = document.createElement('div'); root = createRoot(node); }
  await act(async () => root!.render(createElement(TeammateCreateButton, {
    targets, groupTargets, appearance: 'toolbar', preferredDeviceId: 'pc', onCreated: h.created, onGroupCreated: h.groupCreated,
  })));
}
it('native toolbar dispatches the selected host and preserves delayed creation receipts', async () => {
  await toolbar();
  expect([...node.querySelectorAll('button')].map(button => button.textContent)).toEqual(['PC', 'Mac']);
  await act(async () => node.querySelector('button')!.click());
  expect(h.sheet.deviceId).toBe('pc');
  await act(async () => { h.sheet.onCreated(ref); h.sheet.onClose(); });
  expect(h.created).not.toHaveBeenCalled();
  await act(async () => h.sheet.onClosed());
  expect(h.created).toHaveBeenCalledExactlyOnceWith(hosts[1], ref);
});
it('native toolbar keeps single-host creation direct and supports group-only hosts', async () => {
  await toolbar([hosts[0]]);
  await act(async () => node.querySelector('button')!.click());
  expect(h.sheet.deviceId).toBe('mac');
  await act(async () => { h.sheet.onClose(); h.sheet.onClosed(); });
  await toolbar([], [hosts[1]]);
  const group = [...node.querySelectorAll('button')].find(button => button.textContent === 'groupChat.create.title')!;
  await act(async () => group.click());
  expect(h.groupSheet.host.deviceId).toBe('pc');
  await act(async () => { h.groupSheet.onCreated('group'); h.groupSheet.onClose(); });
  expect(h.groupCreated).not.toHaveBeenCalled();
  await act(async () => h.groupSheet.onClosed());
  expect(h.groupCreated).toHaveBeenCalledExactlyOnceWith(hosts[1], 'group');
});
