// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ account: 1, button: {} as any, menu: {} as any, sheet: null as any, groupSheet: null as any, groupCreated: vi.fn(), created: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: h.alert } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.account }) }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: (props: any) => createElement('button', { 'data-testid': props.testID, onClick: props.onPress }, props.label) }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({ usesNativePullDownMenu: () => true, NativePullDownMenu: (props: any) => { h.menu = props; return props.children; } }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: () => null }));
vi.mock('@/session/CompanionProfileSheet', () => ({ CompanionCreateSheet: (props: any) => { h.sheet = props; return null; } }));
vi.mock('@/session/useTeammateRoster', () => ({ TEAMMATE_COLLECTION_ID: 'teammates' }));
vi.mock('@/session/BotGroupCreateSheet', () => ({ BotGroupCreateSheet: (props: any) => { h.groupSheet = props; return null; } }));
import { useTeammateCreateController } from '@/session/TeammateCreateController';
function Trigger(props: { onPress(): void }) { h.button = props; return null; }
/** A caller draws its own trigger, as the task home's teammate section does. */
function Create(props: Parameters<typeof useTeammateCreateController>[0]) {
  const create = useTeammateCreateController(props);
  return createElement('div', null, create.renderTrigger(createElement(Trigger, { onPress: create.press })), create.sheets);
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hosts = [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }];
const ref = { collectionId: 'teammates', kind: 'bot', id: 'confirmed' };
let root: Root | undefined;
async function render(targets = hosts, groupTargets = [] as typeof hosts) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Create, { targets, groupTargets, preferredDeviceId: 'pc', onCreated: h.created, onGroupCreated: h.groupCreated })));
}
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
// Android and wide screens host the home list at the root, so an account switch reaches the same instance.
it('serves the new account after a switch without remounting, and never closes its form for the old one', async () => {
  await render(); await act(async () => h.menu.onAction('mac')); const oldSheet = h.sheet;
  h.account++; h.sheet = null; await render();
  expect(h.sheet).toBeNull();
  await act(async () => h.menu.onAction('pc'));
  expect(h.sheet.deviceId).toBe('pc'); expect(h.sheet.visible).toBe(true);
  await act(async () => { oldSheet.onCreated(ref); oldSheet.onClosed(); }); expect(h.created).not.toHaveBeenCalled();
  await act(async () => { h.sheet.onCreated(ref); h.sheet.onClose(); h.sheet.onClosed(); });
  expect(h.created).toHaveBeenCalledExactlyOnceWith(hosts[1], ref);
});

it('offers group chats in the same menu and reports a new group only after its form closes', async () => {
  await render([], [hosts[1]]);
  expect(h.menu.actions.map((action: any) => action.title)).toEqual(['groupChat.create.title']);
  await act(async () => h.menu.onAction(h.menu.actions[0].id));
  expect(h.groupSheet.host.deviceId).toBe('pc');
  await act(async () => { h.groupSheet.onCreated('group'); h.groupSheet.onClose(); });
  expect(h.groupCreated).not.toHaveBeenCalled();
  await act(async () => h.groupSheet.onClosed());
  expect(h.groupCreated).toHaveBeenCalledExactlyOnceWith(hosts[1], 'group');
});
