// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sheet: null as any, choices: [] as any[], portrait: null as any, read: vi.fn(), openLink: vi.fn(), invoke: vi.fn(), alert: vi.fn(),
  close: vi.fn(), closed: vi.fn(), search: vi.fn(), created: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' }, StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }, Alert: { alert: h.alert }, Image: () => null,
  View: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
  Pressable: ({ children, onPress, disabled, testID }: any) => <button data-testid={testID} disabled={disabled} onClick={onPress}>{children}</button>,
  Switch: ({ accessibilityLabel, value, onValueChange, disabled }: any) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={e => onValueChange(e.currentTarget.checked)} />,
  ActivityIndicator: ({ accessibilityLabel }: any) => <span role="progressbar" aria-label={accessibilityLabel} />,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Brain', 'Camera', 'FileText', 'Hand', 'History', 'Info', 'Link2', 'Settings2', 'Sparkles']
  .map(name => [name, Object.assign(() => null, { displayName: name })])));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => <span>{children}</span>,
  TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} maxLength={p.maxLength} disabled={p.editable === false} onInput={e => p.onChangeText(e.currentTarget.value)} onChange={() => {}} />,
}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => <button disabled={!!action.disabled || !!action.busy} data-tone={action.tone} onClick={action.onPress}>{action.label}</button> }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: (p: any) => <span data-testid="avatar" data-size={p.size} /> }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: ({ label, icon, onPress, disabled, busy, destructive, testID }: any) =>
  <button data-testid={testID} data-icon={icon?.type?.displayName ?? ''} data-destructive={destructive ? 'true' : 'false'} disabled={disabled || busy} onClick={onPress}>{label}</button> }));
vi.mock('@/session/CompanionChoice', () => ({ CompanionChoice: (p: any) => { h.choices.push(p); return <span data-choice={p.label} />; } }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: (p: any) => { h.sheet = p; return p.visible ? <div data-testid="sheet">{p.children}</div> : null; } }));
vi.mock('@/session/CompanionProfileArtifacts', () => ({ CompanionProfileArtifacts: () => null }));
vi.mock('@/session/CompanionPortraitPicker', async original => ({ ...await original<object>(), CompanionPortraitPicker: (p: any) => { h.portrait = p; return <span data-testid="portraits" />; } }));
vi.mock('@/session/CompanionMemoryPage', () => ({ CompanionMemoryPage: () => <div data-testid="memoryPage" /> }));
vi.mock('@/session/useCompanionMemory', () => ({ useCompanionMemory: () => ({ busy: false, dirty: false, flush: async () => true, back: async () => false }) }));
vi.mock('@/session/CompanionProfileNativeView', () => ({ CompanionProfileNativeView: () => { throw new Error('iOS view on Android'); } }));
vi.mock('@/session/CompanionCreateNativeView', () => ({ CompanionCreateNativeView: () => { throw new Error('iOS view on Android'); } }));
vi.mock('@/session/CompanionModelChain', () => ({ readCompanionModelChain: (v: string) => JSON.parse(v || '[]'), CompanionModelChain: () => null, CompanionModelPicker: () => null }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/session/companionProfileData', async original => ({ ...await original<object>(), loadCompanionProfile: (...args: unknown[]) => h.read(...args) }));
import { CompanionCreateSheet, CompanionProfileSheet } from '@/session/CompanionProfileSheet';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ref = { collectionId: 'teammates', kind: 'bot', id: 'bot' };
const resource = { ref, display: { title: 'Cindy', subtitle: 'Teammate on Mac' }, links: [], revision: 'v1' };
const form = (id: string, fields: object[], values: Record<string, unknown> = {}, extra: object = {}) => ({ id, values, action: { id: `${id}-grant`, label: 'Save', fields }, ...extra });
const managed = (id: string, label: string, extra: object = {}) => ({ id, values: {}, action: { id: `${id}-grant`, label, confirmation: { title: `${label}?`, body: `${label} body` }, ...extra } });
const home = () => ({ resource, panels: [
  form('profile', [{ id: 'name', label: 'Name', kind: 'text' }], { name: 'Cindy' }),
  { id: 'avatar', values: {}, entries: [{ id: 'avatar', title: 'Avatar', resourceId: 'settings:bot/avatar' }] },
  { ...form('skills', [{ id: 'skillNote', label: 'Skill note', kind: 'text' }]), text: '' },
  { id: 'connections', values: {}, entries: [{ id: 'refs', title: 'Referenced', resourceId: 'settings:bot/connections' }] },
  // Host order is authoritative: delete before restart here.
  managed('delete', 'Delete teammate'), managed('restart', 'Restart'),
] });
let root: Root; let container: HTMLDivElement;
const buttons = () => [...container.querySelectorAll('button')];
const byTest = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const byText = (text: string) => buttons().find(node => node.textContent === text);
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
async function press(node: HTMLElement | null | undefined) { if (!node) throw new Error('Missing control'); await act(async () => { node.click(); }); await settle(); }
async function type(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!field) throw new Error(`Missing ${label}`);
  await act(async () => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function render() {
  await act(async () => root.render(createElement(CompanionProfileSheet, { visible: true, resource: resource as any, collectionId: 'teammates', deviceId: 'host', deviceName: 'Mac', online: true,
    onClose: h.close, onClosed: h.closed, onOpenSearch: h.search })));
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks(); h.choices = []; h.sheet = null;
  h.read.mockImplementation(async () => home()); h.openLink.mockResolvedValue(undefined); h.invoke.mockResolvedValue({ effects: [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('lays out the iOS identity, entry groups, icons and host-ordered management actions', async () => {
  await render();
  const avatar = container.querySelector('[data-testid="avatar"]')!;
  expect(avatar.getAttribute('data-size')).toBe('48');
  // Identity only: no navigation target and no subtitle line.
  expect(avatar.closest('button')).toBeNull();
  expect(container.textContent).toContain('Cindy'); expect(container.textContent).not.toContain('Teammate on Mac');
  const rows = buttons().map(node => node.dataset.testid ?? '').filter(id => /^companionProfile\.[a-z]+$/.test(id));
  expect(rows).toEqual(['profile', 'memory', 'models', 'skills', 'artifacts', 'search', 'permissions'].map(id => `companionProfile.${id}`));
  const icons = Object.fromEntries(rows.map(id => [id.split('.')[1], byTest(id)!.dataset.icon]));
  // 图标与桌面 BotsHomeView 同一动作同一 lucide 图标(mobile-design-guide §6)。
  expect(icons).toMatchObject({ profile: 'Info', memory: 'Brain', models: 'Sparkles', skills: 'Settings2', artifacts: 'FileText', search: 'History', permissions: 'Hand' });
  expect(new Set(Object.values(icons)).size).toBe(rows.length);
  const actions = buttons().filter(node => node.dataset.testid?.startsWith('companionProfile.action.'));
  expect(actions.map(node => [node.dataset.testid, node.dataset.destructive])).toEqual([['companionProfile.action.delete', 'true'], ['companionProfile.action.restart', 'false']]);
});

it('keeps automation absent and hands search to the owner like iOS, without closing first', async () => {
  await render();
  expect(byTest('companionProfile.automation')).toBeNull();
  await press(byTest('companionProfile.search'));
  expect(h.search).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled();
});

it('renders confirmation fields for any confirmed action, not only delete', async () => {
  h.read.mockImplementation(async () => ({ ...home(), panels: [...home().panels.filter(item => item.id !== 'restart'),
    managed('restart', 'Restart', { fields: [{ id: 'reason', label: 'Reason', kind: 'text' }] })] }));
  await render(); await press(byTest('companionProfile.action.restart'));
  expect(h.sheet.title).toBe('Restart?'); expect(h.sheet.preventDismiss).toBe(true); expect(h.sheet.onBack).toBeTypeOf('function');
  expect(container.textContent).toContain('Restart body');
  await type('Reason', 'Stuck on a tool'); await press(byText('Restart'));
  expect(h.invoke.mock.calls[0][2]).toMatchObject({ actionId: 'restart-grant', input: { reason: 'Stuck on a tool' } });
});

it('keeps Settings to Permissions and opens selects through the system menu without a search box', async () => {
  const models = form('models', [{ id: 'route0', label: 'Route', kind: 'select', options: [{ value: '', label: 'None' }, { value: 'a', label: 'Model A' }] }], { route0: 'a' });
  h.read.mockImplementation(async (_invoke: unknown, _device: string, target: { id: string }) => target.id === 'settings:bot/avatar'
    ? { resource: { ...resource, ref: { ...ref, id: 'settings:bot/models' }, display: { title: 'Models' } }, panels: [models] } : home());
  await render(); await press(byTest('companionProfile.profile')); await press(byTest('companionProfile.avatar'));
  expect(h.sheet.title).toBe('Models');
  const choice = h.choices.at(-1);
  expect(choice).toMatchObject({ label: 'Route', value: 'a', disabled: false, options: [{ value: '', label: 'None', disabled: false }, { value: 'a', label: 'Model A', disabled: false }] });
  expect(container.querySelector('input[aria-label*="searchOptions"]')).toBeNull();
  await act(async () => choice.onChange(''));
  expect(h.sheet.preventDismiss).toBe(true);
  await act(async () => h.sheet.onBack()); await settle();
  // Back saves the draft first, exactly like the iOS page Back, then lands on Settings.
  expect(h.invoke.mock.calls[0][2]).toMatchObject({ actionId: 'models-grant', input: { route0: '' } });
  const rows = buttons().map(node => node.dataset.testid).filter(Boolean);
  expect(rows).toEqual(['companionProfile.permissions']); expect(byTest('companionProfile.permissions')!.dataset.icon).toBe('Hand');
});

it('follows the iOS skills page: entry rows or the empty note, never an inline form', async () => {
  await render(); await press(byTest('companionProfile.skills'));
  expect(container.textContent).toContain('devices.companionProfile.skillsEmpty');
  expect(container.querySelector('input[aria-label="Skill note"]')).toBeNull();
  expect(byTest('companionProfile.connections')!.dataset.icon).toBe('Link2');
});

it('edits a skill with the host body limit and removes it through a destructive row', async () => {
  const skill = form('skill', [{ id: 'body', label: 'Content', kind: 'multiline' }], { body: 'Original' });
  const remove = { id: 'remove', values: {}, action: { id: 'skill-remove', label: 'Remove skill', tone: 'destructive', confirmation: { title: 'Remove?' } } };
  h.read.mockImplementation(async (_invoke: unknown, _device: string, target: { id: string }) => target.id.startsWith('settings:bot/connections')
    ? { resource: { ...resource, ref: { ...ref, id: 'settings:bot/skills/learned' }, display: { title: 'Learned' } }, panels: [skill, remove] } : home());
  await render(); await press(byTest('companionProfile.skills')); await press(byTest('companionProfile.connections'));
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Content"]')!.maxLength).toBe(55000);
  const row = byTest('companionProfile.action.remove')!;
  expect(row.dataset.destructive).toBe('true');
  await press(row); expect(h.sheet.title).toBe('Remove?');
});

it('shows a spinner, not loading text, while an editor loads', async () => {
  let finish!: (value: unknown) => void;
  h.read.mockImplementation((_invoke: unknown, _device: string, target: { id: string }) => target.id === 'settings:bot/avatar' ? new Promise(done => { finish = done; }) : Promise.resolve(home()));
  await render(); await press(byTest('companionProfile.profile')); await press(byTest('companionProfile.avatar'));
  expect(container.querySelector('[role="progressbar"]')!.getAttribute('aria-label')).toBe('devices.resources.loading');
  expect(container.textContent).not.toContain('devices.resources.loading');
  await act(async () => finish(home()));
});

async function renderCreate() {
  await act(async () => root.render(createElement(CompanionCreateSheet, { visible: true, deviceId: 'host', deviceName: 'Mac', collectionId: 'teammates', online: true, onClose: h.close, onCreated: h.created })));
  await settle();
}
const createPanel = (disabled = false) => ({ resource: { ...resource, ref: { ...ref, id: 'create' } }, panels: [{ id: 'create', values: {}, action: { id: 'create-grant', label: 'Create', disabled,
  fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'avatarImageBase64', label: 'Avatar', kind: 'text' }] } }] });

it('gates Create like iOS and offers an explicit Cancel that guards the draft', async () => {
  h.read.mockResolvedValue(createPanel());
  await renderCreate();
  const create = () => byText('devices.companionProfile.create')!;
  expect(create().disabled).toBe(true);
  await type('Name', 'Nova'); expect(create().disabled).toBe(false);
  await act(async () => h.portrait.onChange('')); expect(create().disabled).toBe(true);
  await act(async () => h.portrait.onChange('portrait')); expect(create().disabled).toBe(false);
  expect(h.sheet.preventDismiss).toBe(true);
  await press(byText('devices.common.cancel'));
  expect(h.close).not.toHaveBeenCalled(); expect(h.alert).toHaveBeenCalledOnce();
  await act(async () => h.alert.mock.calls[0][2][1].onPress()); expect(h.close).toHaveBeenCalledOnce();
});

it('keeps Create disabled for a disabled host action and cancels a clean form directly', async () => {
  h.read.mockResolvedValue(createPanel(true));
  await renderCreate(); await type('Name', 'Nova');
  expect(byText('devices.companionProfile.create')!.disabled).toBe(true);
  await type('Name', '');
  await press(byText('devices.common.cancel'));
  expect(h.alert).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalledOnce();
});
