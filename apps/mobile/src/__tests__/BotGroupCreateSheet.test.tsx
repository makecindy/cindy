// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn(), openLink: vi.fn(), input: null as any,
  cloud: [] as any[], local: [] as any[], generation: 1, submit: null as any }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => el('div', null, children),
  Pressable: ({ children, onPress, disabled, testID }: any) => el('button', { 'data-testid': testID, onClick: onPress, disabled }, children),
  ActivityIndicator: () => null, Alert: { alert: vi.fn() }, StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
}));
vi.mock('lucide-react-native', () => ({ Check: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: (fn: any) => fn({}) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children), TextInput: (props: any) => { h.input = props; return null; } }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));
vi.mock('@/session/useHostTeammates', () => ({ useHostTeammates: () => ({ rows: h.local, loading: false, failed: false }) }));
vi.mock('@/session/useBotGroupSettingsManagement', () => ({ useCloudGroupCandidates: () => ({ rows: h.cloud, loading: false, failed: false }) }));
vi.mock('@/session/BotGroupAvatars', () => ({ BOT_GROUP_ROW_AVATAR_SIZE: 32, BotGroupAvatar: () => null }));
vi.mock('@/session/FormSheet', () => ({ FormSheet: ({ children, trailingAction }: any) => { h.submit = trailingAction; return el('div', null, children); } }));
import { BotGroupCreateSheet } from '@/session/BotGroupCreateSheet';

let root: Root;
let node: HTMLDivElement;
const created = vi.fn();
const props = { visible: true, host: { deviceId: 'mac', deviceName: 'Mac' }, online: true, onClose: vi.fn(), onCreated: created };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const render = () => act(async () => root.render(el(BotGroupCreateSheet, props)));
beforeEach(() => {
  vi.clearAllMocks(); h.generation = 1;
  h.local = [{ key: 'local', host: props.host, item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'local' },
    display: { title: 'Local' }, links: [] } }];
  h.cloud = [
    { id: 'actor-local', externalId: 'local', name: 'Local', homeDeviceId: 'mac', avatar: null },
    { id: 'actor-linux', externalId: 'linux', name: 'Linux offline', homeDeviceId: 'linux-device', avatar: null },
    { id: 'actor-hidden', externalId: 'hidden', name: 'Hidden local', homeDeviceId: 'mac', avatar: null },
  ];
  h.invoke.mockResolvedValue({ effects: [{ kind: 'navigate', target: { kind: 'resource', ref: {
    collectionId: 'bot-groups', kind: 'bot-group', id: 'new-group',
  } } }] });
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(() => act(() => root.unmount()));

it('selects an offline remote companion once and sends its external ID through the chosen host', async () => {
  await render();
  expect(node.querySelectorAll('[data-testid="botGroup.create.member.local"]')).toHaveLength(1);
  expect(node.querySelector('[data-testid="botGroup.create.member.hidden"]')).toBeNull();
  await act(async () => { (node.querySelector('[data-testid="botGroup.create.member.linux"]') as HTMLButtonElement).click(); h.input.onChangeText('Across devices'); });
  await act(async () => { await h.submit.onPress(); });
  expect(h.openLink).toHaveBeenCalledWith('mac');
  expect(h.invoke).toHaveBeenCalledWith(h.invoke, props.host, {
    collectionId: 'bot-groups', actionId: 'create', input: { name: 'Across devices', botIds: ['linux'] },
  }, 'en');
  expect(created).toHaveBeenCalledWith('new-group');
});

it('clears selections on account change and keeps a rejected remote creation open', async () => {
  await render();
  await act(async () => { (node.querySelector('[data-testid="botGroup.create.member.linux"]') as HTMLButtonElement).click(); h.input.onChangeText('Old'); });
  h.generation++; await render(); expect(h.input.value).toBe('');
  await act(async () => h.input.onChangeText('New'));
  h.invoke.mockRejectedValueOnce(new Error('MEMBER_UNAVAILABLE'));
  await act(async () => { await h.submit.onPress(); });
  expect(h.invoke.mock.calls[0][2].input.botIds).toEqual([]);
  expect(created).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
});
