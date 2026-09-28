// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: new Set<(deviceId: string, payload: { collectionId: string; resourceRefs?: { id: string; kind: string; collectionId: string }[] }) => void>(),
  link: {
    status: 'online', connectionEpoch: 1, presenceVersion: 1,
    getPresenceAvailability: vi.fn(() => true as boolean | null),
    invoke: vi.fn(), openLink: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined), unsubscribe: vi.fn(async () => undefined),
    onRemoteResourceChanged: vi.fn(),
  },
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteStatus', async () => ({ formatRemoteError: (await import('@cindy/maker-shared/device-link-contract')).formatRemoteError }));

import { useBotGroupChat } from '@/session/useBotGroupChat';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = { deviceId: 'mac', deviceName: 'Mac' };
const groupData = (name: string) => ({
  id: 'g1', name, members: [{ botId: 'mimi', name: '咪咪', avatar: '', avatarColor: '', status: 'active' }],
  messages: [], plans: [], round: { status: 'idle', speakers: [], canContinue: false },
});
const resource = (name: string) => ({
  ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, revision: name, display: { title: name }, links: [],
  blocks: [{ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '', data: groupData(name) }],
});
let root: Root | undefined;
let result: ReturnType<typeof useBotGroupChat>;
function Probe() { result = useBotGroupChat(host, 'g1'); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
const reads = () => h.link.invoke.mock.calls.filter((call) => call[1] === 'maker:remote-resources:get');
async function push(payload: Parameters<typeof h.listeners extends Set<infer L> ? L : never>[1], deviceId = 'mac') {
  await act(async () => {
    h.listeners.forEach((listener) => listener(deviceId, payload));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

beforeEach(() => {
  vi.clearAllMocks(); h.listeners.clear(); h.link.status = 'online';
  h.link.getPresenceAvailability.mockReturnValue(true);
  h.link.onRemoteResourceChanged.mockImplementation((listener) => { h.listeners.add(listener); return () => h.listeners.delete(listener); });
  h.link.invoke.mockImplementation(async (_deviceId: string, channel: string) => channel === 'maker:remote-resources:get' ? resource('官网') : { effects: [] });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('reads the group with the chat primitive and follows its change pushes', async () => {
  await render();
  expect(result.state).toMatchObject({ kind: 'ready', group: { id: 'g1', name: '官网' } });
  expect(reads()[0]![2][0]).toMatchObject({ ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' } });
  expect(reads()[0]![2][0].client.primitives).toContain('bot-group-chat');
  expect(h.link.subscribe).toHaveBeenCalledWith(expect.stringMatching(/^bot-group:g1:focus:/), 'mac', ['sessions']);
  expect(result.online).toBe(true);

  h.link.invoke.mockImplementation(async () => resource('新名字'));
  await push({ collectionId: 'bot-groups', resourceRefs: [{ collectionId: 'bot-groups', kind: 'bot-group', id: 'other' }] });
  await push({ collectionId: 'teammates' });
  await push({ collectionId: 'bot-groups' }, 'pc');
  expect(reads()).toHaveLength(1);
  // A burst of pushes for this group is read once.
  await act(async () => {
    for (let index = 0; index < 3; index += 1) h.listeners.forEach((listener) => listener('mac', { collectionId: 'bot-groups', resourceRefs: [{ collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }] }));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(reads()).toHaveLength(2);
  expect(result.state).toMatchObject({ kind: 'ready', group: { name: '新名字' } });
});

it('keeps the conversation on a failed re-read, and reports a missing group', async () => {
  await render();
  h.link.invoke.mockRejectedValue(new Error('[NOT_CONNECTED] offline'));
  await push({ collectionId: 'bot-groups' });
  expect(result.state.kind).toBe('ready');
  h.link.invoke.mockRejectedValue(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }));
  await push({ collectionId: 'bot-groups' });
  expect(result.state.kind).toBe('missing');
});

it('shows an error when the first read fails or the data is unreadable', async () => {
  h.link.invoke.mockResolvedValue({ ...resource('x'), blocks: [{ id: 'chat', primitive: 'markdown', fallbackMarkdown: 'x' }] });
  await render();
  expect(result.state.kind).toBe('error');
});

it('runs actions on the group and re-reads after success and refusal', async () => {
  await render();
  await act(async () => { await result.act('plan-start', { planId: 'p1' }); });
  const invokeCall = h.link.invoke.mock.calls.find((call) => call[1] === 'maker:remote-resources:invoke')!;
  expect(invokeCall[2][0]).toMatchObject({
    collectionId: 'bot-groups', actionId: 'plan-start', input: { planId: 'p1' },
    resourceRef: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' },
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads()).toHaveLength(2);
  h.link.invoke.mockImplementation(async (_deviceId: string, channel: string) => {
    if (channel === 'maker:remote-resources:invoke') throw Object.assign(new Error('PLAN_CLOSED'), { code: 'INVALID_PARAMS' });
    return resource('官网');
  });
  await act(async () => { await expect(result.act('plan-continue', { planId: 'p1' })).rejects.toThrow('PLAN_CLOSED'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads()).toHaveLength(3);
});

it('treats a computer known to be offline as unavailable for actions', async () => {
  h.link.getPresenceAvailability.mockReturnValue(false);
  await render();
  expect(result.online).toBe(false);
});
