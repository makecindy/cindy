// @vitest-environment jsdom
// Tier: unit. Production hook boundary: human-only read acknowledgements and
// membership revocation while a settings mutation is in flight (transport tests do not cover React lifetime).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMaskState } from '@cindy/maker-shared/botGroupChat';

const h = vi.hoisted(() => ({ client: { mask: vi.fn(), maskMentions: vi.fn() }, online: true }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ getPresenceAvailability: () => h.online }) }));
vi.mock('@/chat/useChatServer', () => {
  const api = { owner: 'owner', current: () => true, client: h.client };
  return { useChatClient: () => api };
});
import { useGroupPersonalMask } from '@/session/useGroupPersonalMask';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, result: ReturnType<typeof useGroupPersonalMask>, server: ChatMaskState;
const remote = async () => undefined;
function Probe({ enabled }: { enabled: boolean }) { result = useGroupPersonalMask('room', '', enabled, remote, 0); return null; }
async function render(enabled = true) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => { root!.render(createElement(Probe, { enabled })); });
}
beforeEach(() => {
  vi.clearAllMocks(); h.online = true;
  server = { revision: 1, status: 'enabled', manualRunning: false, homeDeviceId: 'mac', self: { id: 'human', name: 'Alex', avatarUrl: null }, companions: [],
    settings: { companionId: 'bot', enabled: true, access: 'chat', trigger: 'always', start: '09:00', end: '18:00', timeZone: 'UTC', resumeMinutes: 15, collectTodos: true, digest: 'manual' } };
  h.client.mask.mockImplementation(async () => server);
  h.client.maskMentions.mockResolvedValue({ mentions: [{ messageId: 'question', sequence: '1', authorName: 'Jamie', text: '@Alex please confirm' }], hasMore: false });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('reads without acknowledging, acknowledges the selected original, and reflects offline home presence', async () => {
  await render();
  expect(result.mentions).toHaveLength(1);
  expect(h.client.maskMentions.mock.calls.every(call => call[2] === undefined)).toBe(true);
  await act(async () => { result.markRead(['question']); });
  expect(h.client.maskMentions.mock.calls.filter(call => call[2] !== undefined)).toEqual([
    ['room', undefined, ['question'], expect.any(String)],
  ]);
  h.online = false; await render();
  expect(result.state?.status).toBe('offline');
});

it('discards late receipts and queued grants after access disappears, even when the same room returns', async () => {
  await render();
  let finish!: (state: ChatMaskState) => void;
  h.client.mask.mockImplementation((_room, action) => action ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(server));
  await act(async () => { result.update({ access: 'tools' }); result.update({ enabled: false }); });
  await render(false);
  expect(result.state).toBeNull();
  await render(true);
  await act(async () => { finish({ ...server, revision: 2, settings: { ...server.settings, access: 'tools' } }); });
  expect(result.state?.settings.access).toBe('chat');
  expect(h.client.mask.mock.calls.filter(call => call[1])).toHaveLength(1);
  await act(async () => { result.retry(); });
  expect(h.client.mask.mock.calls.filter(call => call[1])).toHaveLength(1);
});

// Independent mutations used to clear the shared failure ref. Exercise the real
// hook with a failed save followed by successful presence/read, then retry it.
it.each(['participate', 'read'] as const)('retains a failed save after %s succeeds', async operation => {
  let fail = true;
  h.client.mask.mockImplementation(async (_room, action) => {
    if (action?.type === 'save') {
      if (fail) throw new Error('NETWORK_ERROR');
      server = { ...server, revision: 2, settings: action.settings };
    }
    return server;
  });
  await render();
  await act(async () => result.update({ enabled: false }));
  expect(result.error).toBe(true);
  await act(async () => operation === 'read' ? result.markRead(['question']) : result.participate());
  expect(result.error).toBe(true);
  fail = false;
  await act(async () => result.retry());
  expect(result.error).toBe(false);
  expect(result.state?.settings.enabled).toBe(false);
  const saves = h.client.mask.mock.calls.filter(call => call[1]?.type === 'save');
  expect(saves).toHaveLength(2);
  expect(saves[1]![2]).toBe(saves[0]![2]);
});

it('replaces a failed setting with a newer explicit intent without replaying the obsolete value', async () => {
  h.client.mask.mockImplementation(async (_room, action) => {
    if (action?.type === 'save' && !action.settings.enabled) throw new Error('NETWORK_ERROR');
    if (action?.type === 'save') server = { ...server, revision: 2, settings: action.settings };
    return server;
  });
  await render();
  await act(async () => result.update({ enabled: false }));
  expect(result.error).toBe(true);
  await act(async () => result.update({ enabled: true }));
  expect(result.error).toBe(false);
  await act(async () => result.retry());
  expect(result.state?.settings.enabled).toBe(true);
  expect(h.client.mask.mock.calls.filter(call => call[1]?.type === 'save')).toHaveLength(2);
});
