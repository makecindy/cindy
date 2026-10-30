// @vitest-environment jsdom
// Regression: IM records were inaccessible on both mobile presentations. Exercise the
// shared record picker with the real request envelope; opening must not reset a lane. Unit tier.
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionChannelTasks } from '@/session/CompanionChannelTasks';
const h = vi.hoisted(() => ({ requests: [] as any[], supported: true, fail: false, rejectCaps: null as unknown }));
const invoke = vi.fn(async (device: string, channel: string, args: any[]) => {
  const request = args[0];
  h.requests.push({ device, channel, request });
  const op = request.input.op;
  if (op === 'caps' && h.rejectCaps) throw h.rejectCaps;
  const value = op === 'caps' ? { ops: h.supported ? ['channels.im.list', 'channels.im.listLanes'] : [] }
    : op === 'channels.im.list' ? { connections: [{ id: 'connection', botId: 'bot', channel: 'telegram' }, { id: 'other', botId: 'other-bot', channel: 'discord' }] }
      : { lanes: [{ sessionId: 'original-lane', name: 'Release group', chatId: 'group', kind: 'group' }] };
  return { result: { ok: !h.fail, value } };
});
const link = { invoke, status: 'online', connectionEpoch: 1, getPresenceAvailability: () => true };
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => link, subscribeRemoteBotChanges: () => () => {} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) }));
vi.mock('react-native', () => ({ View: ({ children }: any) => createElement('div', {}, children), StyleSheet: { create: (s: unknown) => s },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => createElement('button', { disabled: action.disabled, onClick: action.onPress }, action.label) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', async () => { const tokens = await import('@/theme/tokens'); return { ...tokens, useThemedStyles: (make: any) => make(tokens.lightColors) }; });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div');
let root = createRoot(host);
const open = vi.fn();
const render = (online = true) => act(async () => root.render(<CompanionChannelTasks deviceId="studio" botId="bot" online={online} onOpenTask={open} />));
afterEach(() => { act(() => root.unmount()); root = createRoot(host); h.requests = []; h.supported = true; h.fail = false; h.rejectCaps = null; vi.clearAllMocks(); });
it('opens the exact channel task and only reads the selected connection on its computer', async () => {
  await render();
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(h.requests.some(row => row.request.input.op === 'channels.im.listLanes')).toBe(false);
  await act(async () => host.querySelector('button')!.click());
  expect(h.requests.at(-1)).toMatchObject({ device: 'studio', channel: 'maker:remote-resources:invoke', request: {
    resourceRef: { id: 'bot' }, input: { v: 1, op: 'channels.im.listLanes', args: { id: 'connection' } },
  } });
  await act(async () => host.querySelectorAll('button')[1]!.click());
  expect(open).toHaveBeenCalledWith('original-lane');
  expect(h.requests.every(row => ['caps', 'channels.im.list', 'channels.im.listLanes'].includes(row.request.input.op))).toBe(true);
});
it('explains offline, unsupported hosts and logical failures instead of an empty picker', async () => {
  await render(false); expect(host.textContent).toContain('devices.resources.hostOffline');
  expect(h.requests).toHaveLength(0);
  h.supported = false; await render(); expect(host.textContent).toContain('devices.companionProfile.hostUpgrade');
  h.fail = true; await act(async () => root.unmount()); root = createRoot(host); await render(); expect(host.textContent).toContain('devices.companionProfile.readFailed');
  const attempts = h.requests.length;
  await act(async () => host.querySelector('button')!.click()); expect(h.requests.length).toBeGreaterThan(attempts);
});

// Review #7105: the real query catch previously erased UNSUPPORTED_CAPABILITY.
// Empty ops did not exercise rejected transport promises. One rejected caps read is the failure input; unit tier.
it.each([
  Object.assign(new Error('Unknown teammate action'), { code: 'UNSUPPORTED_CAPABILITY' }),
  new Error('[UNSUPPORTED_CAPABILITY] Unknown teammate action'),
  Object.assign(new Error('Channel unavailable'), { code: 'CHANNEL_NOT_ALLOWED' }),
])('shows the upgrade hint when the host rejects the settings capability (%s)', async error => {
  h.rejectCaps = error;
  await render();
  expect(host.textContent).toContain('devices.companionProfile.hostUpgrade');
  expect(host.textContent).not.toContain('devices.companionProfile.readFailed');
  expect(host.querySelector('button')).toBeNull();
  expect(h.requests.map(row => row.request.input.op)).toEqual(['caps']);
});
it('keeps a transient rejected read retryable and recovers after retry', async () => {
  h.rejectCaps = Object.assign(new Error('Host timeout'), { code: 'INVOKE_TIMEOUT' });
  await render();
  expect(host.textContent).toContain('devices.companionProfile.readFailed');
  expect(host.textContent).not.toContain('devices.companionProfile.hostUpgrade');
  h.rejectCaps = null;
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).not.toContain('devices.companionProfile.readFailed');
  expect(host.querySelectorAll('button')).toHaveLength(1);
});
