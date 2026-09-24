// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ account: 1, view: {} as any, create: {} as any, model: {} as any, picker: {} as any, read: vi.fn(), openLink: vi.fn(), invoke: vi.fn(), close: vi.fn(), closed: vi.fn(), push: vi.fn(), created: vi.fn(), deleted: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, StyleSheet: { create: (v: unknown) => v }, View: 'div', Alert: { alert: vi.fn() }, Image: 'img', Pressable: (p: any) => createElement('button', { ...p, onClick: p.onPress, style: undefined }, p.children), ScrollView: 'div', Switch: 'input' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Brain','Check','ChevronRight','Clock3','FileText','MessageCircle','Search','Settings2','Sparkles','UserRound'].map(key => [key, () => null])));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.account }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));
vi.mock('@/components/AppText', () => ({ Text: 'span', TextInput: 'input' }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: () => null }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: (p: any) => p.children, usesNativePullDownMenu: () => false }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: (p: any) => createElement('button', { onClick: p.onPress }, p.label) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: () => null }));
vi.mock('@/session/CompanionProfileArtifacts', () => ({ CompanionProfileArtifacts: () => null }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/session/companionProfileData', async original => ({ ...await original<object>(), loadCompanionProfile: (...args: unknown[]) => h.read(...args) }));
vi.mock('@/session/CompanionProfileNativeView', () => ({ CompanionProfileNativeView: (p: any) => { h.view = p; return p.models; } }));
vi.mock('@/session/CompanionCreateNativeView', () => ({ CompanionCreateNativeView: (p: any) => { h.create = p; return null; } }));
vi.mock('@/session/CompanionModelChain', () => ({ readCompanionModelChain: (v: string) => JSON.parse(v || '[]'), CompanionModelChain: (p: any) => { h.model = p; return null; }, CompanionModelPicker: (p: any) => { h.picker = p; return null; } }));
import { CompanionProfileForm, CompanionProfileSheet, CompanionCreateSheet, shouldShowSelectSearch } from '@/session/CompanionProfileSheet';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const resource = { ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, display: { title: 'Cindy' }, links: [], revision: 'v1' };
const panel = { id: 'profile', values: { name: 'Cindy' }, action: { id: 'grant', label: 'Save', fields: [{ id: 'name', label: 'Name', kind: 'text' }] } };
let root: Root | undefined;
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(CompanionProfileSheet, { visible: true, resource, collectionId: 'teammates', deviceId: 'host', deviceName: 'Mac', online: true, onClose: h.close, onClosed: h.closed, onDeleted: h.deleted, onOpenSearch() {}, onOpenAutomation() {} }))); }
beforeEach(() => { vi.clearAllMocks(); h.account = 1; h.read.mockResolvedValue({ resource, panels: [panel, { ...panel, id: 'models', values: { modelChain: '[]', followsDefault: false }, action: { id: 'model-grant', fields: [{ id: 'modelChain', kind: 'multiline' }, { id: 'followsDefault', kind: 'toggle' }] } }] }); h.invoke.mockResolvedValue({ effects: [] }); });
afterEach(() => { act(() => root?.unmount()); root = undefined; });
it('only enables select search for long option lists', () => {
  expect(shouldShowSelectSearch('permissions', [{ value: 'ask' }, { value: 'auto' }, { value: 'trusted' }])).toBe(false);
  expect(shouldShowSelectSearch('permissions', Array.from({ length: 11 }, (_, index) => ({ value: String(index) })))).toBe(false);
  expect(shouldShowSelectSearch('models', Array.from({ length: 11 }, (_, index) => ({ value: String(index) })))).toBe(true);
});
it('renders the Android permissions picker without search and keeps search for long non-permission lists', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const formRoot = createRoot(container);
  const renderForm = (panelId: string, optionCount: number) => act(() => formRoot.render(createElement(CompanionProfileForm, { key: panelId,
    panel: { id: panelId, action: { fields: [{ id: 'permissions', kind: 'select', label: 'Permissions', options: Array.from({ length: optionCount }, (_, index) => ({ value: String(index), label: String(index) })) }] } } as any,
    values: { permissions: '0' }, onChange: () => undefined, disabled: false,
  })));
  await renderForm('permissions', 3);
  act(() => (document.querySelector('button') as HTMLButtonElement).click());
  expect(document.querySelectorAll('input')).toHaveLength(0);
  await renderForm('models', 11);
  act(() => (document.querySelector('button') as HTMLButtonElement).click());
  expect(document.querySelectorAll('input')).toHaveLength(1);
  formRoot.unmount();
  container.remove();
});
it('keeps the draft and page when saving during dismissal fails', async () => {
  await render(); await act(async () => h.view.onOpen('profile'));
  await act(async () => h.view.onChange({ name: 'Unsaved' }));
  h.invoke.mockRejectedValue(new Error('offline'));
  await act(async () => h.view.onClose());
  expect(h.close).not.toHaveBeenCalled(); expect(h.view.page).toBe('profile');
  expect(h.view.values.name).toBe('Unsaved'); expect(h.view.dirty).toBe(true); expect(h.view.error).toBe(true);
});
it('does not renew a dirty draft against a newer remote revision', async () => {
  await render(); await act(async () => h.view.onOpen('profile'));
  await act(async () => h.view.onChange({ name: 'Local edit' }));
  h.read.mockResolvedValue({ resource: { ...resource, revision: 'v2' }, panels: [{ ...panel, values: { name: 'Desktop edit' } }] });
  await act(async () => h.view.onRetry());
  expect(h.view.conflict).toBe(true); expect(h.view.values.name).toBe('Local edit');
  await act(async () => h.view.onSubmit(h.view.panel)); expect(h.invoke).not.toHaveBeenCalled();
});
it('waits for native dismissal before presenting the model picker and preserves the draft on return', async () => {
  await render(); await act(async () => h.view.onOpen('models'));
  await act(async () => h.model.onPick(0));
  expect(h.view.visible).toBe(false); expect(h.picker.visible).toBe(false);
  await act(async () => h.view.onClosed()); expect(h.picker.visible).toBe(true); expect(h.closed).not.toHaveBeenCalled();
  await act(async () => h.picker.onSelect({ harness: 'pi', model: 'real-model', providerId: 'provider', effort: '', fastMode: false }));
  await act(async () => h.picker.onClose()); expect(h.view.visible).toBe(false);
  await act(async () => h.picker.onClosed());
  expect(h.view.visible).toBe(true); expect(h.view.page).toBe('models'); expect(h.view.dirty).toBe(true);
  expect(JSON.parse(h.view.values.modelChain)[0].model).toBe('real-model');
});
it('ignores a late save response after changing accounts', async () => {
  await render(); await act(async () => h.view.onOpen('profile'));
  await act(async () => h.view.onChange({ name: 'Old account draft' }));
  let done!: (v: unknown) => void; h.invoke.mockReturnValue(new Promise(resolve => { done = resolve; }));
  await act(async () => h.view.onClose());
  h.account++; await render();
  await act(async () => done({ effects: [{ kind: 'toast', message: 'Saved' }] }));
  expect(h.close).not.toHaveBeenCalled(); expect(h.view.page).toBe('home'); expect(h.view.receipt).toBeNull(); expect(h.view.dirty).toBe(false);
});

async function renderCreate(online = true) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(CompanionCreateSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', collectionId: 'teammates', online, onClose: h.close, onCreated: h.created })));
}
it('keeps one selected portrait and creation intent through an ambiguous ACK and reconnect', async () => {
  await renderCreate(); const portrait = h.create.values.avatarImageBase64;
  expect(portrait.length).toBeGreaterThan(100); expect(portrait.length).toBeLessThan(55000);
  await act(async () => h.create.onChange({ ...h.create.values, name: '新伙伴' }));
  h.invoke.mockRejectedValueOnce(new Error('ACK lost'));
  await act(async () => h.create.onSubmit());
  expect(h.create.values).toEqual({ name: '新伙伴', avatarImageBase64: portrait });
  expect(h.create.error).toBe(true); expect(h.created).not.toHaveBeenCalled();
  await renderCreate(false); await renderCreate(true);
  h.invoke.mockResolvedValue({ effects: [{ kind: 'navigate', target: { kind: 'resource', ref: resource.ref } }] });
  await act(async () => h.create.onSubmit());
  expect(h.invoke.mock.calls[0][2].input).toEqual(h.invoke.mock.calls[1][2].input);
  expect(h.created).toHaveBeenCalledWith(resource.ref); expect(h.close).toHaveBeenCalledTimes(1);
});
it('ignores a creation receipt from a previous account', async () => {
  await renderCreate(); await act(async () => h.create.onChange({ ...h.create.values, name: 'New' }));
  let resolve!: (value: unknown) => void;
  h.invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  await act(async () => h.create.onSubmit());
  h.account++; await renderCreate();
  await act(async () => resolve({ effects: [{ kind: 'navigate', target: { kind: 'resource', ref: resource.ref } }] }));
  expect(h.created).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled(); expect(h.create.values.name).toBe('');
});
it('keeps a dirty skill draft when deletion confirmation is canceled', async () => {
  await render();
  const skill = { id: 'skill', values: { body: 'Original' }, action: { id: 'skill-save', label: 'Save', fields: [{ id: 'body', label: 'Content', kind: 'multiline' }] } };
  const remove = { id: 'remove', values: {}, action: { id: 'skill-remove', label: 'Delete', confirmation: { title: 'Delete' } } };
  h.read.mockResolvedValue({ resource: { ...resource, ref: { ...resource.ref, id: 'settings:bot/skills/learned' } }, panels: [skill, remove] });
  await act(async () => h.view.onEditor('settings:bot/skills/learned'));
  await act(async () => h.view.onChange({ body: 'Keep my draft' }));
  await act(async () => h.view.onConfirm(remove));
  await act(async () => h.view.onConfirm(null));
  expect(h.view.values.body).toBe('Keep my draft'); expect(h.view.dirty).toBe(true); expect(h.invoke).not.toHaveBeenCalled();
});

it('reopens the host link on refresh and keeps the unsaved draft', async () => {
  await render(); await act(async () => h.view.onOpen('profile'));
  await act(async () => h.view.onChange({ name: 'Reconnect draft' }));
  h.openLink.mockRejectedValueOnce(new Error('LINK_NOT_OPEN'));
  await act(async () => h.view.onRetry());
  expect(h.view.error).toBe(true);
  const previousReads = h.read.mock.calls.length;
  await act(async () => h.view.onRetry());
  expect(h.openLink).toHaveBeenLastCalledWith('host');
  expect(h.read.mock.calls.length).toBe(previousReads + 1);
  expect(h.view.error).toBe(false);
  expect(h.view.values.name).toBe('Reconnect draft');
  expect(h.view.dirty).toBe(true);
});

it('leaves a deleted teammate only after the native sheet closes', async () => {
  await render();
  await act(async () => h.view.onSubmit({ id: 'delete', values: {}, action: { id: 'delete-grant' } }, true));
  expect(h.view.deleted).toBe(true);
  expect(h.deleted).not.toHaveBeenCalled();
  await act(async () => h.view.onClose());
  expect(h.close).toHaveBeenCalledOnce();
  await act(async () => h.view.onClosed());
  expect(h.deleted).toHaveBeenCalledOnce();
});
