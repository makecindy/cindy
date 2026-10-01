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
vi.mock('lucide-react-native', () => ({ Plus: () => null, Check: () => null, Users: () => null }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) };
});
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => 0 }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '9:41' }));
vi.mock('@/session/SessionRightSpinner', () => ({ SessionRightSpinner: ({ testID }: any) => el('i', { 'data-testid': testID }) }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children),
  TextInput: ({ testID, ...props }: any) => { h.inputs[testID] = props; return el('input', { 'data-testid': testID, value: props.value ?? '', readOnly: true }); },
}));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: (props: any) => el('button', { 'data-testid': props.testID, onClick: props.onPress }, props.label) }));
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
vi.mock('@/session/HomeHeaderGlassButton', () => ({
  HomeHeaderGlassButton: ({ onPress, testID, accessibilityLabel }: any) => el('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress }),
}));
vi.mock('@/session/CompanionProfileSheet', () => ({ CompanionCreateSheet: () => null }));
vi.mock('@/session/BotGroupAvatars', () => ({
  BOT_GROUP_ROW_AVATAR_SIZE: 32,
  BotGroupAvatar: () => null,
  BotGroupDuoAvatar: ({ members, working }: any) => el('span', { 'data-testid': 'duo', 'data-working': String(!!working) }, members.map((member: any) => member.name).join('+')),
  useBotGroupIdentities: () => (botId: string, fallbackName = '') => ({ botId, name: fallbackName || botId }),
}));
vi.mock('@/session/useHostTeammates', () => ({ useHostTeammates: () => h.teammates }));
vi.mock('@/session/useTeammateRoster', () => ({ TEAMMATE_COLLECTION_ID: 'teammates' }));

import { BotGroupListRow } from '@/session/BotGroupList';
import { TeammateCreateButton } from '@/session/TeammateCreateButton';

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
const mac = { deviceId: 'mac', deviceName: 'Mac' };
const pc = { deviceId: 'pc', deviceName: 'PC' };

let root: Root;
let node: HTMLDivElement;
const byId = (id: string) => node.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
async function click(id: string) {
  const target = byId(id);
  if (!target) throw new Error(`missing ${id}`);
  await act(async () => { target.click(); });
}

beforeEach(() => {
  vi.clearAllMocks(); h.inputs = {}; h.nativeMenu = true;
  h.teammates = { rows: [teammate('mimi', '咪咪'), teammate('abu', '阿布'), teammate('xiaoman', '小满')], loading: false, failed: false };
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('group row', () => {
  const groups = [
    row('pc', 'g-new', { timestamp: 5, generation: { phase: 'processing', startedAt: null }, preview: { fallback: 'Mimi is splitting the work…', translations: { 'zh-CN': '咪咪正在安排…' } } }),
    row('mac', 'g-old', { timestamp: 1, preview: '**阿布**：写好了' }),
  ];
  async function render(isOnline: (host: { deviceId: string }) => boolean = () => true) {
    const onPress = vi.fn();
    await act(async () => root.render(el('div', null, groups.map((group, index) =>
      el(BotGroupListRow, { key: group.key, row: group, online: isOnline(group.host), last: index === groups.length - 1, onPress: () => onPress(group) })))));
    return onPress;
  }

  it('shows member avatars, the host’s localized preview without Markdown, and a working state in the time slot', async () => {
    const onPress = await render();
    const fresh = byId('botGroups.item.pc.g-new')!;
    const done = byId('botGroups.item.mac.g-old')!;
    expect(fresh.textContent).toContain('咪咪正在安排…');
    expect(done.textContent).toContain('阿布：写好了');
    expect(done.textContent).not.toContain('**');
    expect(fresh.querySelector('[data-testid="companion.row.working"]')).not.toBeNull();
    expect(fresh.querySelector('[data-testid="duo"]')?.getAttribute('data-working')).toBe('true');
    expect(done.querySelector('[data-testid="companion.row.working"]')).toBeNull();
    expect(done.textContent).toContain('9:41');
    expect(done.querySelector('[data-testid="duo"]')?.textContent).toBe('咪咪+阿布');
    await click('botGroups.item.mac.g-old');
    expect(onPress).toHaveBeenCalledWith(groups[1]);
  });

  it('disables a group whose computer is offline, says so in the preview, and stops the working state', async () => {
    await render((host) => host.deviceId === 'mac');
    const offline = byId('botGroups.item.pc.g-new')!;
    expect(offline.disabled).toBe(true);
    expect(offline.textContent).toContain('devices.resources.hostOffline');
    expect(offline.querySelector('[data-testid="companion.row.working"]')).toBeNull();
    expect(offline.querySelector('[data-testid="duo"]')?.getAttribute('data-working')).toBe('false');
  });
});

describe('create from the teammate page + menu', () => {
  async function render(groupTargets = [mac], nativeMenu = true) {
    h.nativeMenu = nativeMenu;
    const onGroupCreated = vi.fn();
    await act(async () => root.render(el(TeammateCreateButton, {
      targets: [mac], groupTargets, preferredDeviceId: 'pc', onCreated: vi.fn(), onGroupCreated,
    })));
    return onGroupCreated;
  }

  it('offers 新建伙伴 and 新建群聊, creates with 2–6 teammates in list order, then opens it after the sheet closes', async () => {
    const onGroupCreated = await render();
    const titles = [...node.querySelectorAll('[data-testid^="teammates.createMenu.action."]')].map((entry) => entry.textContent);
    expect(titles).toEqual(['devices.companions.createTeammate', 'groupChat.create.title']);
    await click('teammates.createMenu.action.group:mac');
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
    expect(onGroupCreated).toHaveBeenCalledWith(mac, 'g9');
  });

  it('shows the host’s reason when it refuses', async () => {
    await render();
    await click('teammates.createMenu.action.group:mac');
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('官网'); });
    await click('botGroup.create.member.abu');
    await click('botGroup.create.member.mimi');
    h.invoke.mockRejectedValueOnce(Object.assign(new Error('MEMBER_UNAVAILABLE'), { code: 'INVALID_PARAMS' }));
    await click('botGroup.create.submit');
    expect(byId('botGroup.create.error')?.textContent).toBe('groupChat.errors.memberUnavailable');
  });

  it('asks which computer hosts the group when several support it, remembered computer first', async () => {
    const onGroupCreated = await render([mac, pc]);
    const hosts = [...node.querySelectorAll('[data-testid^="teammates.createMenu.action.group:"]')].map((entry) => entry.textContent);
    expect(hosts).toEqual(['PC', 'Mac']);
    await click('teammates.createMenu.action.group:pc');
    expect(node.textContent).toContain('groupChat.create.computerNote(deviceName=PC)');
    expect(onGroupCreated).not.toHaveBeenCalled();
  });

  it('falls back to a sheet of the same choices where the platform has no anchored menu', async () => {
    await render([mac, pc], false);
    expect(byId('teammates.createChooser')).toBeNull();
    await click('teammates.create');
    expect(byId('teammates.createChooser')).not.toBeNull();
    await click('teammates.createChooser.group.pc');
    // The create sheet opens only after the chooser has closed.
    expect(byId('teammates.createChooser')).toBeNull();
    expect(node.textContent).toContain('groupChat.create.computerNote(deviceName=PC)');
  });

  it('keeps the single-purpose teammate button when no computer supports group chats', async () => {
    await render([]);
    expect(byId('teammates.createMenu')).toBeNull();
    expect(byId('teammates.create')).not.toBeNull();
  });
});
