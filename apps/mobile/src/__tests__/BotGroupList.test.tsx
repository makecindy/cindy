// @vitest-environment jsdom
import { act, createElement as el, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openLink: vi.fn(async () => undefined),
  inputs: {} as Record<string, any>,
  focus: vi.fn(),
  onShow: undefined as undefined | (() => void),
  teammates: { rows: [] as any[], loading: false, failed: false },
  alert: vi.fn(),
  nativeMenu: true,
  dark: false,
}));

vi.mock('expo-router', () => ({ Stack: { Toolbar: Object.assign(({ children }: any) => children, {
  Button: (props: any) => el('button', { onClick: props.onPress }, props.accessibilityLabel),
  Menu: ({ children }: any) => children,
  MenuAction: (props: any) => el('button', { onClick: props.onPress, disabled: props.disabled }, props.children),
}) } }));
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
  const colors = () => h.dark ? tokens.darkColors : tokens.lightColors;
  return { ...tokens, useThemedStyles: (make: any) => make(colors()), useTheme: () => ({ colors: colors() }) };
});
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => 0 }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '9:41' }));
vi.mock('@/session/SessionRightSpinner', () => ({ SessionRightSpinner: ({ testID }: any) => el('i', { 'data-testid': testID }) }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID, style, accessibilityRole }: any) => el('span', { 'data-testid': testID, role: accessibilityRole, style: { color: style?.color } }, children),
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
  CompanionSheet: ({ visible, children, onClosed, onShow, testID, leadingAction, trailingAction }: any) => {
    h.onShow = onShow;
    const was = useRef(visible);
    useEffect(() => { if (was.current && !visible) onClosed?.(); was.current = visible; }, [visible]);
    const action = (item: any) => item ? el('button', { 'data-testid': item.testID, disabled: item.disabled || item.busy, onClick: item.onPress }, item.label) : null;
    return visible ? el('div', { 'data-testid': testID }, el('header', null, action(leadingAction), action(trailingAction)), children) : null;
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
import { useTeammateCreateController } from '@/session/TeammateCreateController';
import { HomeHeaderGlassButton } from '@/session/HomeHeaderGlassButton';

/** The home teammate section's create trigger: the caller's button inside the controller's menu. */
function CreateTrigger(props: Parameters<typeof useTeammateCreateController>[0]) {
  const create = useTeammateCreateController(props);
  return el('div', null, create.renderTrigger(el(HomeHeaderGlassButton, { accessibilityLabel: create.label, testID: 'teammates.create', onPress: create.press, children: null })), create.sheets);
}

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
  vi.clearAllMocks(); h.inputs = {}; h.nativeMenu = true; h.dark = false;
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

describe('create from the home teammate section + menu', () => {
  async function render(groupTargets = [mac], nativeMenu = true) {
    h.nativeMenu = nativeMenu;
    const onGroupCreated = vi.fn();
    await act(async () => root.render(el(CreateTrigger, {
      targets: [mac], groupTargets, preferredDeviceId: 'pc', onCreated: vi.fn(), onGroupCreated,
    })));
    return onGroupCreated;
  }

  it('offers 新建伙伴 and 新建群聊, creates with teammates in list order, then opens it after the sheet closes', async () => {
    const onGroupCreated = await render();
    const titles = [...node.querySelectorAll('[data-testid^="teammates.createMenu.action."]')].map((entry) => entry.textContent);
    expect(titles).toEqual(['devices.companions.createTeammate', 'groupChat.create.title']);
    await click('teammates.createMenu.action.group:mac');
    expect(byId('botGroup.create')).not.toBeNull();
    await click('botGroup.create.submit');
    expect(node.textContent).toContain('groupChat.create.nameRequired');
    expect(node.textContent).not.toContain('groupChat.create.minMembers');
    expect(h.invoke).not.toHaveBeenCalled();
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('  官网  '); });
    // Equal timestamps now have a stable identity tie-breaker. Select in the
    // reverse order so the assertion still proves list order, not click order.
    expect([...node.querySelectorAll('[data-testid^="botGroup.create.member."]')]
      .map(entry => entry.getAttribute('data-testid'))).toEqual([
      'botGroup.create.member.abu', 'botGroup.create.member.mimi', 'botGroup.create.member.xiaoman',
    ]);
    await click('botGroup.create.member.mimi');
    await click('botGroup.create.member.abu');
    h.invoke.mockResolvedValueOnce({ effects: [
      { kind: 'refresh-collection', collectionId: 'bot-groups' },
      { kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g9' } } },
    ] });
    await click('botGroup.create.submit');
    const request = h.invoke.mock.calls[0]!;
    expect(request[0]).toBe('mac');
    expect(request[1]).toBe('maker:remote-resources:invoke');
    expect(request[2][0]).toMatchObject({ collectionId: 'bot-groups', actionId: 'create', input: { name: '官网', botIds: ['abu', 'mimi'] } });
    expect(byId('botGroup.create')).toBeNull();
    expect(onGroupCreated).toHaveBeenCalledWith(mac, 'g9');
  });

  // Regression: the real create sheet used to block 0/1 selected bots and render
  // required-name errors in neutral text. Existing coverage only exercised 2 bots.
  // Tier: unit (rendered form + outgoing remote-resource request, no network).
  it.each([0, 1])('creates with %i selected teammates and no minimum-count notice', async (count) => {
    if (count === 0) h.teammates.rows = [];
    const onGroupCreated = await render();
    await click('teammates.createMenu.action.group:mac');
    expect(node.textContent).not.toContain('groupChat.create.description');
    expect(node.textContent).not.toContain('groupChat.create.computerNote');
    expect(node.textContent).not.toContain('groupChat.create.notEnoughBots');
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('  官网  '); });
    if (count) await click('botGroup.create.member.abu');
    h.invoke.mockResolvedValueOnce({ effects: [
      { kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g9' } } },
    ] });
    await click('botGroup.create.submit');
    expect(h.invoke.mock.calls[0]?.[2][0]).toMatchObject({
      collectionId: 'bot-groups', actionId: 'create', input: { name: '官网', botIds: count ? ['abu'] : [] },
    });
    expect(onGroupCreated).toHaveBeenCalledWith(mac, 'g9');
  });

  it.each([false, true])('shows a red required-name error and clears it after correction (dark=%s)', async (dark) => {
    h.dark = dark;
    const { lightColors, darkColors } = await import('@/theme/tokens');
    await render();
    await click('teammates.createMenu.action.group:mac');
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('   '); });
    await click('botGroup.create.submit');
    const error = node.querySelector('[role="alert"]') as HTMLElement;
    expect(error?.textContent).toBe('groupChat.create.nameRequired');
    const expected = document.createElement('span');
    expected.style.color = (dark ? darkColors : lightColors).statusError;
    expect(error.style.color).toBe(expected.style.color);
    expect(h.invoke).not.toHaveBeenCalled();
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('官网'); });
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  // #7658: six selected is a cap, not a truncation of the available roster.
  it('focuses the name and can select a teammate beyond the sixth row', async () => {
    h.teammates.rows = Array.from({ length: 12 }, (_, index) => teammate(`bot-${index}`, `Bot ${index}`));
    await render();
    await click('teammates.createMenu.action.group:mac');
    h.inputs['botGroup.create.name'].ref.current = { focus: h.focus };
    expect(h.focus).not.toHaveBeenCalled();
    h.onShow?.();
    expect(h.focus).toHaveBeenCalledOnce();
    expect(node.querySelectorAll('[data-testid^="botGroup.create.member."]')).toHaveLength(12);
    await click('botGroup.create.member.bot-11');
    await act(async () => { h.inputs['botGroup.create.name'].onChangeText('More teammates'); });
    h.invoke.mockResolvedValueOnce({ effects: [
      { kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g9' } } },
    ] });
    await click('botGroup.create.submit');
    expect(h.invoke.mock.calls[0]?.[2][0].input.botIds).toEqual(['bot-11']);
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
    expect(byId('botGroup.create')).not.toBeNull();
    expect(node.textContent).not.toContain('groupChat.create.computerNote');
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
    expect(byId('botGroup.create')).not.toBeNull();
    expect(node.textContent).not.toContain('groupChat.create.computerNote');
  });

  it('keeps the single-purpose teammate button when no computer supports group chats', async () => {
    await render([]);
    expect(byId('teammates.createMenu')).toBeNull();
    expect(byId('teammates.create')).not.toBeNull();
  });
});
