// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: 'android', sheet: null as any, model: null as any, choices: [] as any[], portrait: null as any, read: vi.fn(), openLink: vi.fn(), invoke: vi.fn(), alert: vi.fn(),
  close: vi.fn(), closed: vi.fn(), search: vi.fn(), created: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.platform; } }, StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }, Alert: { alert: h.alert }, Image: () => null,
  View: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>, ScrollView: 'div',
  Pressable: ({ children, onPress, disabled, testID }: any) => <button data-testid={testID} disabled={disabled} onClick={onPress}>{children}</button>,
  Switch: ({ accessibilityLabel, value, onValueChange, disabled }: any) => <input type="checkbox" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={e => onValueChange(e.currentTarget.checked)} />,
  ActivityIndicator: ({ accessibilityLabel }: any) => <span role="progressbar" aria-label={accessibilityLabel} />,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('@/platform/chrome', () => ({ NativeSwitch: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Brain', 'Camera', 'FileText', 'Hand', 'History', 'Info', 'Link2', 'MessageCircle', 'Settings2', 'Sparkles']
  .map(name => [name, Object.assign(() => null, { displayName: name })])));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', async original => ({ ...await original<object>(), invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => <span>{children}</span>,
  TextInput: (p: any) => <input aria-label={p.accessibilityLabel} value={p.value} maxLength={p.maxLength} disabled={p.editable === false} onInput={e => p.onChangeText(e.currentTarget.value)} onChange={() => {}} />,
}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => <button disabled={!!action.disabled || !!action.busy} data-tone={action.tone} onClick={action.onPress}>{action.label}</button> }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: (p: any) => <span data-testid="avatar" data-size={p.size} /> }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: ({ label, icon, onPress, disabled, busy, destructive, testID, detail }: any) =>
  <button data-testid={testID} data-icon={icon?.type?.displayName ?? ''} data-destructive={destructive ? 'true' : 'false'} data-detail={detail} disabled={disabled || busy} onClick={onPress}>{label}</button> }));
vi.mock('@/session/CompanionChoice', () => ({ CompanionChoice: (p: any) => { h.choices.push(p); return <span data-choice={p.label} />; } }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: (p: any) => { h.sheet = p; return p.visible ? <div data-testid="sheet">{p.trailingAction ? <header><button data-testid={p.trailingAction.testID} disabled={p.trailingAction.disabled || p.trailingAction.busy} onClick={p.trailingAction.onPress}>{p.trailingAction.label}</button></header> : null}<div data-testid="sheet-body">{p.children}</div></div> : null; } }));
vi.mock('@/session/CompanionProfileArtifacts', () => ({ CompanionProfileArtifacts: () => null }));
vi.mock('@/session/CompanionPortraitPicker', async original => ({ ...await original<object>(), CompanionPortraitPicker: (p: any) => { h.portrait = p; return <span data-testid="portraits" />; } }));
vi.mock('@/session/CompanionMemoryPage', () => ({ CompanionMemoryPage: () => <div data-testid="memoryPage" /> }));
vi.mock('@/session/useCompanionMemory', () => ({ useCompanionMemory: () => ({ busy: false, dirty: false, flush: async () => true, back: async () => false }) }));
vi.mock('@/session/CompanionProfileNativeView', async () => await import('@/session/CompanionProfileNativeView.ios'));
vi.mock('@/session/CompanionCreateNativeView', () => ({ CompanionCreateNativeView: () => { throw new Error('iOS view on Android'); } }));
vi.mock('@/session/CompanionModelChain', () => ({ readCompanionModelChain: (v: string) => JSON.parse(v || '[]'), CompanionModelChain: (p: any) => { h.model = p; return null; }, CompanionModelPicker: () => null }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/session/companionProfileData', async original => ({ ...await original<object>(), loadCompanionProfile: (...args: unknown[]) => h.read(...args) }));

// Real iOS page/menu is rendered too; only platform drawing controls are replaced with DOM.
vi.mock('@/session/ComposerSheet', () => ({ ComposerSheet: (p: any) => { h.sheet = p; return p.visible ? <div>{p.children}</div> : null; } }));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: (p: any) => <section>{p.children}</section> }));
vi.mock('@/session/CompanionNativeContent.ios', () => ({ CompanionNativeContent: (p: any) => p.children }));
vi.mock('@expo/ui/swift-ui', async () => {
  const React = await import('react');
  const control = (p: any) => <div>{p.children}</div>;
  return { HStack: control, RNHostView: control, Spacer: () => null, Image: () => null, ProgressView: () => null,
    Text: (p: any) => <span>{p.children}</span>, TextField: () => null,
    Button: (p: any) => <button data-testid={p.testID} disabled={p.modifiers?.some((m: any) => m.disabled)} onClick={p.onPress}>{p.children}</button>,
    Toggle: () => null,
    Picker: (p: any) => { h.choices.push({ label: p.label, value: p.selection, onChange: p.onSelectionChange }); return <span data-choice={p.label} />; },
    useNativeState: (initial: string) => React.useRef({ value: initial, get() { return this.value; }, set(value: string) { this.value = value; } }).current,
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => Object.fromEntries([
  ...['accessibilityLabel', 'alignmentGuide', 'background', 'buttonBorderShape', 'buttonStyle', 'contentShape', 'controlSize', 'glassEffect', 'disabled', 'font', 'foregroundStyle', 'frame', 'lineLimit', 'listRowInsets', 'pickerStyle', 'tag', 'tint'].map(key => [key, (value: any) => ({ [key]: value })]),
  ['shapes', { rectangle: () => ({}), circle: () => ({}), capsule: () => ({}) }],
]));
import { CompanionCreateSheet, CompanionProfileSheet } from '@/session/CompanionProfileSheet';
import { parseCompanionProfileData } from '@/session/companionProfileData';
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
async function render(online = true) {
  await act(async () => root.render(createElement(CompanionProfileSheet, { visible: true, resource: resource as any, collectionId: 'teammates', deviceId: 'host', deviceName: 'Mac', online,
    onClose: h.close, onClosed: h.closed, onOpenSearch: h.search })));
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks(); h.platform = 'android'; h.choices = []; h.sheet = null;
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
  expect(rows).toEqual(['profile', 'memory', 'models', 'skills', 'channels', 'artifacts', 'search', 'permissions'].map(id => `companionProfile.${id}`));
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

// Skill layers (cindy-bots-runtime.md §6「伙伴技能分层」): the host titles the system and learned lists and marks a
// turned-off Skill with a subtitle. Before, every entry fell into one untitled group without state.
// Minimal input: the host's skills page (an untitled core list, two titled lists); unit, parsed by the real reader.
it('groups a host editor list under its block titles and shows entry subtitles, as iOS does', async () => {
  const id = 'settings:bot/skills';
  const raw = { ref: { ...ref, id }, revision: 'r1', display: { title: 'Skills' }, links: [], blocks: [
    { id: 'core', primitive: 'list', fallbackMarkdown: '', data: { entries: [{ id: 'core', title: 'Core Skill', subtitle: 'Shared by every teammate', resourceId: `${id}/_core` }] } },
    { id: 'system', title: 'System Skills', primitive: 'list', fallbackMarkdown: '', data: { entries: [
      { id: 'todo', title: 'Todos', resourceId: `${id}/_todo` }, { id: 'routine', title: 'Routines', subtitle: 'Off', resourceId: `${id}/_routine` }] } },
    { id: 'skills', title: 'Personal Skills', primitive: 'list', fallbackMarkdown: '', data: { entries: [{ id: 'learned', title: 'Write briefs', resourceId: `${id}/learned` }] } },
  ] };
  const root = () => ({ ...home(), panels: home().panels.map(item => item.id === 'skills' ? { id: 'skills', values: {}, entries: [{ id: 'skills', title: 'Skills', resourceId: id }] } : item) });
  h.read.mockImplementation(async (_invoke: unknown, _device: string, target: { id: string }) => target.id === id ? parseCompanionProfileData(raw, { ...ref, id }) : root());
  await render(); await press(byTest('companionProfile.skills')); await press(byTest('companionProfile.personalSkills'));
  const headers = [...container.querySelectorAll('span')].map(node => node.textContent).filter(text => text?.endsWith('Skills'));
  expect(headers).toEqual(['System Skills', 'Personal Skills']);
  expect(buttons().filter(node => node.dataset.detail !== undefined).map(node => [node.textContent, node.dataset.detail]))
    .toEqual([['Core Skill', 'Shared by every teammate'], ['Routines', 'Off']]);
  await press(byText('Routines'));
  expect(h.read).toHaveBeenLastCalledWith(h.invoke, 'host', { ...ref, id: `${id}/_routine` }, 'en');
});

it('shows a spinner, not loading text, while an editor loads', async () => {
  let finish!: (value: unknown) => void;
  h.read.mockImplementation((_invoke: unknown, _device: string, target: { id: string }) => target.id === 'settings:bot/avatar' ? new Promise(done => { finish = done; }) : Promise.resolve(home()));
  await render(); await press(byTest('companionProfile.profile')); await press(byTest('companionProfile.avatar'));
  expect(container.querySelector('[role="progressbar"]')!.getAttribute('aria-label')).toBe('devices.resources.loading');
  expect(container.textContent).not.toContain('devices.resources.loading');
  await act(async () => finish(home()));
});

async function renderCreate(visible = true, online = true) {
  await act(async () => root.render(createElement(CompanionCreateSheet, { visible, deviceId: 'host', deviceName: 'Mac', collectionId: 'teammates', online, onClose: h.close, onCreated: h.created })));
  await settle();
}
const createPanel = (disabled = false) => ({ resource: { ...resource, ref: { ...ref, id: 'create' } }, panels: [{ id: 'create', values: {}, action: { id: 'create-grant', label: 'Create', disabled,
  fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'avatarImageBase64', label: 'Avatar', kind: 'text' }] } }] });

it('opens the import source picker after the existing creation sheet closes', async () => {
  const data = createPanel();
  h.read.mockResolvedValue({ ...data, resource: { ...data.resource, actions: [{ id: 'open-agent-import', label: 'Import' }] } });
  h.invoke.mockResolvedValue({ blocks: [{ primitive: 'companion-import', data: { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] } }] });
  await renderCreate();
  await press(byText('devices.companionImport.entry'));
  expect(h.sheet.visible).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
  await act(async () => h.sheet.onClosed()); await settle();
  expect(h.sheet.visible).toBe(true);
  expect(byText('Ada · Hermes')).toBeDefined();
  expect(h.close).not.toHaveBeenCalled();
  expect(h.created).not.toHaveBeenCalled();
});

it('reopens normal creation and starts a fresh import after closing, while preserving an open import on reconnect', async () => {
  const data = createPanel();
  h.read.mockResolvedValue({ ...data, resource: { ...data.resource, actions: [{ id: 'open-agent-import', label: 'Import' }] } });
  const sources = { blocks: [{ primitive: 'companion-import', data: { sources: [{ id: 'source', name: 'Ada', kind: 'hermes' }] } }] };
  h.invoke.mockResolvedValue(sources);
  await renderCreate(); await press(byText('devices.companionImport.entry'));
  await act(async () => h.sheet.onClosed()); await settle();
  h.invoke.mockResolvedValueOnce({ blocks: [{ primitive: 'companion-import', data: { preview: { id: 'preview', source: { id: 'source', kind: 'hermes', name: 'Ada' }, name: 'Old import draft', entries: [] } } }] });
  await press(byText('Ada · Hermes'));
  const name = () => container.querySelector<HTMLInputElement>('input[aria-label="devices.companionProfile.name"]');
  expect(name()?.value).toBe('Old import draft');
  await renderCreate(true, false); await renderCreate(true, true);
  expect(name()?.value).toBe('Old import draft');
  await act(async () => h.sheet.onClose()); expect(h.close).toHaveBeenCalledOnce();
  await renderCreate(false); await renderCreate(true);
  expect(byText('devices.companionImport.entry')).toBeDefined();
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe('');
  expect(name()).toBeNull();
  await press(byText('devices.companionImport.entry'));
  await act(async () => h.sheet.onClosed()); await settle();
  expect(byText('Ada · Hermes')).toBeDefined();
  expect(name()).toBeNull();
  expect(byText('devices.companionImport.submit')).toBeUndefined();
});

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

async function renderModels() {
  const data = home();
  data.panels.push(form('models', [{ id: 'modelChain', kind: 'multiline' }, { id: 'followsDefault', kind: 'toggle' }], { modelChain: '[]', followsDefault: false }));
  h.read.mockResolvedValue(data);
  await render();
  expect(h.sheet.trailingAction).toBeUndefined();
  await press(byTest('companionProfile.models'));
}
// Model-page Save placement and controller guards were not covered together on Android.
it('keeps Android model Save in the header and submits the same draft action', async () => {
  await renderModels();
  expect(h.sheet.onBack).toBeTypeOf('function');
  expect(h.sheet.trailingAction).toMatchObject({ label: 'devices.common.save', disabled: true });
  expect(container.querySelectorAll('[data-testid="companionProfile.models.save"]')).toHaveLength(1);
  expect([...container.querySelectorAll('button')].filter(button => button.textContent === 'devices.companionProfile.save')).toHaveLength(0);
  await act(async () => h.model.onChange({ ...h.model.values, followsDefault: true }));
  expect(h.sheet.trailingAction.disabled).toBe(false);
  await act(async () => h.sheet.trailingAction.onPress());
  expect(h.invoke).toHaveBeenCalledOnce();
  expect(h.invoke.mock.calls[0][2]).toMatchObject({ actionId: 'models-grant', input: { followsDefault: true } });
  expect(h.sheet.trailingAction.disabled).toBe(true);
  await act(async () => h.sheet.onBack());
  expect(h.sheet.trailingAction).toBeUndefined();
  await press(byTest('companionProfile.profile'));
  expect(h.sheet.trailingAction).toBeUndefined();
  expect([...container.querySelectorAll('button')].filter(button => button.textContent === 'devices.companionProfile.save')).toHaveLength(1);
});

it('keeps Android header Save disabled offline and while a save is in flight', async () => {
  await renderModels();
  await act(async () => h.model.onChange({ ...h.model.values, followsDefault: true }));
  await render(false);
  expect(h.sheet.trailingAction.disabled).toBe(true);
  await render();
  let finish!: (value: any) => void;
  h.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => h.sheet.trailingAction.onPress());
  expect(h.sheet.trailingAction.busy).toBe(true);
  expect(byTest('companionProfile.models.save')!.disabled).toBe(true);
  await act(async () => h.sheet.trailingAction.onPress());
  expect(h.invoke).toHaveBeenCalledOnce();
  await act(async () => finish({ effects: [] }));
  expect(h.sheet.trailingAction.busy).toBe(false);
});

it('keeps the Android model draft on save failure and blocks a conflicting header save', async () => {
  await renderModels();
  await act(async () => h.model.onChange({ ...h.model.values, followsDefault: true }));
  h.invoke.mockRejectedValueOnce(new Error('offline'));
  await act(async () => h.sheet.trailingAction.onPress());
  expect(h.model.values.followsDefault).toBe(true);
  expect(h.sheet.trailingAction.disabled).toBe(false);
  const latest = await h.read();
  h.read.mockResolvedValue({ ...latest, resource: { ...resource, revision: 'v2' } });
  // The real Retry action re-reads the host and preserves the local conflicting draft.
  const retry = byText('devices.resources.retry')!;
  await act(async () => retry.click());
  expect(h.model.values.followsDefault).toBe(true);
  expect(h.sheet.trailingAction.disabled).toBe(true);
  await act(async () => h.sheet.trailingAction.onPress());
  expect(h.invoke).toHaveBeenCalledOnce();
});

// Review P1: the production platform menu must actually reach the advertised form. Host reads
// and actions use the real mobile parser and production host grant flow; native drawing is mocked.
const { createBotRemoteSettingsResource } = await vi.importActual<{ createBotRemoteSettingsResource: (deps: any) => any }>(
  '../../../desktop/src/main/localDb/ipc/botRemoteSettingsResource.ts');
it.each(['android', 'ios'])('opens, saves and resets media settings from the %s menu, hiding them on older hosts', async platform => {
  h.platform = platform;
  const image = { providerId: 'images-account', modelId: 'draw' };
  const settings: any = { source: { id: 'bot', name: 'Cindy', avatar: '', avatarColor: 'teal', description: 'Assistant', currentVersion: 1, status: 'active' }, identity: '', userContext: '', memory: true, permissions: 'ask', modelChain: [], followsDefault: true, skills: [], connections: [], toolsets: [] };
  const update = vi.fn(async (input: any) => { Object.assign(settings, input.capabilities); settings.source.currentVersion++; });
  const deps: any = { owner: () => 'owner', assertOwner() {}, read: async () => settings, update, skills: async () => [], lifecycle: async () => ({}),
    mediaModels: async () => ({ vision: [], image: [{ ...image, label: 'Image account' }], video: [] }) };
  const host = createBotRemoteSettingsResource(deps);
  const context = { controllerDeviceId: 'phone' };
  h.read.mockImplementation(async () => parseCompanionProfileData(await host.get(context, 'bot'), ref));
  h.invoke.mockImplementation(async (_invoke: unknown, _target: unknown, request: unknown) => host.invoke(context, { ...(request as object), client: { protocolVersion: 1, primitives: ['form'] } }));
  expect((await h.read()).panels.map((panel: any) => panel.id)).toContain('media');
  await render();
  expect(container.innerHTML).toContain('companionProfile.media');
  await press(byTest('companionProfile.media'));
  const imageChoice = () => h.choices.filter(choice => choice.label === 'Image generation model').at(-1);
  expect(imageChoice().value).toBe('inherit');
  const advertised = parseCompanionProfileData(await host.get(context, 'bot'), ref).panels.find(panel => panel.id === 'media')!;
  const option = advertised.action!.fields!.find(field => field.id === 'image')!.options![1];
  await act(async () => imageChoice().onChange(option.value));
  await press(byText('devices.companionProfile.save')); await settle();
  expect(settings.mediaModels).toEqual({ image });
  // Closing/reopening proves the selection came back from the persisted host profile.
  await act(async () => h.sheet.onBack()); await press(byTest('companionProfile.media'));
  expect(imageChoice().value).toBe(option.value);
  await act(async () => imageChoice().onChange('inherit'));
  await press(byText('devices.companionProfile.save')); await settle();
  expect(settings.mediaModels).toBeNull();
  await act(async () => h.sheet.onBack());
  delete deps.mediaModels;
  await act(async () => h.sheet.onClose());
  // A fresh mount reads an older host's resource: no media entry is advertised.
  act(() => root.unmount()); root = createRoot(container);
  await render();
  expect(byTest('companionProfile.media')).toBeNull();
});
