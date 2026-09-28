// @vitest-environment jsdom
import { act, createElement as el, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openLink: vi.fn(async () => undefined),
  inputs: {} as Record<string, any>,
  teammates: { rows: [] as any[], loading: false, failed: false },
  alert: vi.fn(),
  nativeMenu: true,
}));

vi.mock('react-native', () => {
  const box = ({ children, testID, accessibilityLabel }: any) => el('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children);
  return {
    View: box, ScrollView: box,
    Pressable: ({ children, onPress, disabled, testID, accessibilityLabel }: any) => el('button',
      { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress },
      typeof children === 'function' ? children({ pressed: false }) : children),
    ActivityIndicator: () => null,
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Alert: { alert: h.alert },
  };
});
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => options
      ? `${key}(${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(',')})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('lucide-react-native', () => ({ Plus: () => null, Sparkles: ({ testID }: any) => el('i', { 'data-testid': testID }), Check: () => null, Users: () => null }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }), fontWeight: {}, iconStroke: {} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => 0 }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '9:41' }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children),
  TextInput: ({ testID, ...props }: any) => { h.inputs[testID] = props; return el('input', { 'data-testid': testID, value: props.value ?? '', readOnly: true }); },
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: any) => el('button', { 'data-testid': action.testID, disabled: action.disabled || action.busy, onClick: action.onPress }, action.label),
  MainWindowRowButton: ({ children, onPress, testID }: any) => el('button', { 'data-testid': testID, onClick: onPress }, children),
}));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  usesNativePullDownMenu: () => h.nativeMenu,
  NativePullDownMenu: ({ actions, onAction, children, testID }: any) => {
    const flat = (list: any[]): any[] => list.flatMap((action) => action.subactions ? flat(action.subactions) : [action]);
    return el('div', { 'data-testid': testID }, children, flat(actions).map((action) => el('button', {
      key: action.id, 'data-testid': `${testID}.action.${action.id}`, onClick: () => onAction(action.id),
    }, action.title)));
  },
}));
vi.mock('@/session/CompanionSheet', () => ({
  CompanionSheet: ({ visible, children, onClosed, testID }: any) => {
    const was = useRef(visible);
    useEffect(() => { if (was.current && !visible) onClosed?.(); was.current = visible; }, [visible]);
    return visible ? el('div', { 'data-testid': testID }, children) : null;
  },
}));
vi.mock('@/session/BotGroupAvatars', () => ({
  BOT_GROUP_ROW_AVATAR_SIZE: 32,
  BotGroupAvatar: () => null,
  BotGroupDuoAvatar: ({ members }: any) => el('span', { 'data-testid': 'duo' }, members.map((member: any) => member.name).join('+')),
  useBotGroupIdentities: () => (botId: string, fallbackName = '') => ({ botId, name: fallbackName || botId }),
}));
vi.mock('@/session/useHostTeammates', () => ({ useHostTeammates: () => h.teammates }));

import { BotGroupSection } from '@/session/BotGroupList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const row = (deviceId: string, id: string, display: Record<string, unknown>): HostedRemoteCollectionItem => ({
  key: `${deviceId}:${id}`, host: { deviceId, deviceName: deviceId === 'mac' ? 'Mac' : 'PC' },
  item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: '1', display: { title: id, ...display }, links: [
    { rel: 'member', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'mimi' } }, label: '咪咪' },
    { rel: 'member', target: { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'abu' } }, label: '阿布' },
  ] },
});
const teammate = (id: string, title: string) => ({ key: `mac:${id}`, host: { deviceId: 'mac', deviceName: 'Mac' },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id }, revision: '1', display: { title }, links: [] } });

let root: Root;
let node: HTMLDivElement;
const byId = (id: string) => node.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
async function click(id: string) {
  const target = byId(id);
  if (!target) throw new Error(`missing ${id}`);
  await act(async () => { target.click(); });
}
const props = (overrides: Record<string, unknown> = {}) => ({
  items: [row('mac', 'g-old', { timestamp: 1, preview: '**阿布**：写好了' }), row('pc', 'g-new', { timestamp: 5, generation: { phase: 'processing', startedAt: null }, preview: { fallback: 'Mimi is splitting the work…', translations: { 'zh-CN': '咪咪正在安排…' } } })],
  query: '',
  isOnline: () => true,
  createTargets: [{ deviceId: 'mac', deviceName: 'Mac' }],
  onOpen: vi.fn(), onOpenCreated: vi.fn(),
  ...overrides,
});
async function render(value = props()) {
  await act(async () => root.render(el(BotGroupSection, value as any)));
  return value;
}

beforeEach(() => {
  vi.clearAllMocks(); h.inputs = {}; h.nativeMenu = true;
  h.teammates = { rows: [teammate('mimi', '咪咪'), teammate('abu', '阿布'), teammate('xiaoman', '小满')], loading: false, failed: false };
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('group section', () => {
  it('lists groups newest first with member avatars, localized previews and a running mark', async () => {
    const value = await render();
    const rows = [...node.querySelectorAll('[data-testid^="botGroups.item."]')];
    expect(rows.map((entry) => entry.getAttribute('data-testid'))).toEqual(['botGroups.item.pc.g-new', 'botGroups.item.mac.g-old']);
    expect(rows[0]!.textContent).toContain('咪咪正在安排…');
    expect(rows[1]!.textContent).toContain('阿布：写好了');
    expect(rows[1]!.textContent).not.toContain('**');
    expect(rows[0]!.querySelector('[data-testid="botGroups.running"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="botGroups.running"]')).toBeNull();
    expect(byId('duo')?.textContent).toBe('咪咪+阿布');
    await click('botGroups.item.mac.g-old');
    expect(value.onOpen).toHaveBeenCalledWith(value.items[0]);
  });

  it('disables groups whose computer is offline and hides the running mark there', async () => {
    await render(props({ isOnline: (host: { deviceId: string }) => host.deviceId === 'mac' }));
    expect(byId('botGroups.item.pc.g-new')?.disabled).toBe(true);
    expect(byId('botGroups.item.pc.g-new')?.textContent).toContain('devices.resources.hostOffline');
    expect(byId('botGroups.running')).toBeNull();
  });

  it('filters by the teammate search and shows an empty hint', async () => {
    await render(props({ query: '阿布' }));
    expect(node.querySelectorAll('[data-testid^="botGroups.item."]')).toHaveLength(2);
    await render(props({ query: '没有的' }));
    expect(byId('botGroups.section')).toBeNull();
    await render(props({ items: [] }));
    expect(byId('botGroups.empty')?.textContent).toBe('groupChat.list.empty');
  });
});

describe('create a group', () => {
  it('creates on the only computer with 2–6 teammates in list order, then opens it after the sheet closes', async () => {
    const value = await render();
    await click('botGroups.create');
    expect(byId('botGroup.create')).not.toBeNull();
    await click('botGroup.create.submit');
    expect(node.textContent).toContain('groupChat.create.nameRequired');
    expect(node.textContent).toContain('groupChat.create.minMembers(min=2)');
    expect(h.invoke).not.toHaveBeenCalled();
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('  官网  '); });
    await click('botGroup.create.member.abu');
    await click('botGroup.create.member.mimi');
    h.invoke.mockResolvedValueOnce({ effects: [
      { kind: 'refresh-collection', collectionId: 'bot-groups' },
      { kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g9' } } },
    ] });
    await click('botGroup.create.submit');
    const request = h.invoke.mock.calls[0]!;
    expect(request[0]).toBe('mac');
    expect(request[1]).toBe('maker:remote-resources:invoke');
    expect(request[2][0]).toMatchObject({ collectionId: 'bot-groups', actionId: 'create', input: { name: '官网', botIds: ['mimi', 'abu'] } });
    expect(byId('botGroup.create')).toBeNull();
    expect(value.onOpenCreated).toHaveBeenCalledWith({ deviceId: 'mac', deviceName: 'Mac' }, 'g9');
  });

  it('shows the host’s reason when it refuses', async () => {
    await render();
    await click('botGroups.create');
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('官网'); });
    await click('botGroup.create.member.abu');
    await click('botGroup.create.member.mimi');
    h.invoke.mockRejectedValueOnce(Object.assign(new Error('MEMBER_UNAVAILABLE'), { code: 'INVALID_PARAMS' }));
    await click('botGroup.create.submit');
    expect(byId('botGroup.create.error')?.textContent).toBe('groupChat.errors.memberUnavailable');
  });

  it('asks which computer hosts the group when several support it', async () => {
    const value = await render(props({ createTargets: [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }], preferredDeviceId: 'pc' }));
    const options = [...node.querySelectorAll('[data-testid^="botGroups.createMenu.action."]')].map((entry) => entry.textContent);
    expect(options).toEqual(['PC', 'Mac']);
    await click('botGroups.createMenu.action.pc');
    expect(node.textContent).toContain('groupChat.create.computerNote(deviceName=PC)');
    expect(value.onOpenCreated).not.toHaveBeenCalled();
  });

  it('falls back to a sheet of the same choices where the platform has no anchored menu', async () => {
    h.nativeMenu = false;
    await render(props({ createTargets: [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }] }));
    expect(byId('botGroups.createMenu.sheet')).toBeNull();
    await click('botGroups.create');
    expect(byId('botGroups.createMenu.sheet')).not.toBeNull();
    await click('botGroups.createMenu.option.pc');
    // The create sheet opens only after the chooser has closed.
    expect(byId('botGroups.createMenu.sheet')).toBeNull();
    expect(node.textContent).toContain('groupChat.create.computerNote(deviceName=PC)');
  });

  it('cannot create while no computer that supports groups is online', async () => {
    await render(props({ createTargets: [] }));
    expect(byId('botGroups.create')?.disabled).toBe(true);
  });
});
