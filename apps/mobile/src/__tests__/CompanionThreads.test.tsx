// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  invoke: vi.fn(), push: vi.fn(), upsert: vi.fn(), alert: vi.fn(),
  supported: true, online: true, focused: true, generation: 1,
}));
vi.mock('react-native', () => ({ Alert: { alert: h.alert }, AppState: { currentState: 'active' }, StyleSheet: { create: (v: unknown) => v }, View: 'div' }));
vi.mock('expo-router', () => ({ useIsFocused: () => h.focused, useRouter: () => ({ push: h.push }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, connectionEpoch: 1 }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { upsertDeviceSession: h.upsert } }));
vi.mock('@/session/useRemoteCompanionQuery', () => ({ useRemoteCompanionQuery: (_device: string, channel: string) => ({
  value: channel === 'local-db:bots:get' ? { dmThreadsSupported: h.supported, canonicalSessionId: 'main' }
    : [{ sessionId: 'topic', rootClientId: 'root', replyCount: 2, lastReplyAt: 1000 }], online: h.online,
}) }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/session/BotGroupMessageText', () => ({ BotGroupMarkdownText: () => null }));
vi.mock('@/session/ChatThreadSummary', () => ({ ChatThreadSummary: () => null }));
vi.mock('@/theme', () => ({ fontWeight: {}, lineHeight: {}, spacing: {}, typeScale: {}, useThemedStyles: () => ({}) }));
import { useCompanionThreads } from '@/session/CompanionThreads';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let result: ReturnType<typeof useCompanionThreads>;
function Probe() {
  result = useCompanionThreads({ deviceId: 'mac', deviceName: 'Mac', botId: 'bot', sessionId: 'main', enabled: true, avatar: null });
  return null;
}
const message = { source: { id: 'db-root', clientId: 'root' }, body: 'Plan the launch' } as NormalizedRemoteMessage;
async function render() { await act(async () => root.render(createElement(Probe))); }
beforeEach(() => {
  vi.clearAllMocks(); h.supported = true; h.online = true; h.focused = true; h.generation = 1;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

// New mobile topic flow (unit): existing quotation tests did not verify hidden
// Session routing, duplicate opens or stale device/account results.
it('opens the ensured topic with its exact root and keeps duplicate taps to one request', async () => {
  let resolve!: (v: unknown) => void;
  h.invoke.mockImplementation((_device, channel) => channel.endsWith(':ensure') ? new Promise(r => { resolve = r; })
    : Promise.resolve({ id: 'topic', source: 'bot' }));
  await render();
  await act(async () => { result!.open(message); result!.open(message); });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke).toHaveBeenCalledWith('mac', 'local-db:bots:dm-thread:ensure', [{ botId: 'bot', rootSessionId: 'main', rootClientId: 'root', title: 'Plan the launch' }]);
  await act(async () => resolve({ ok: true, sessionId: 'topic' }));
  expect(h.upsert).toHaveBeenCalledWith('mac', 'Mac', { id: 'topic', source: 'bot' });
  expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
    sessionId: 'topic', resourceId: 'bot', resourceThreadRootSessionId: 'main', resourceThreadRootClientId: 'root',
  }) }));
});

it.each(['account', 'leave-and-return'])('ignores a late open after %s changes', async change => {
  let resolve!: (v: unknown) => void;
  h.invoke.mockReturnValue(new Promise(r => { resolve = r; }));
  await render();
  await act(async () => result!.open(message));
  if (change === 'account') h.generation++;
  else h.focused = false;
  await render();
  h.focused = true;
  await render();
  await act(async () => resolve({ ok: true, sessionId: 'topic' }));
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.push).not.toHaveBeenCalled();
  expect(h.upsert).not.toHaveBeenCalled();
  expect(result!.busy).toBe(false);
});

it('preserves ordinary chat on old hosts and does not create topics while offline', async () => {
  h.supported = false;
  await render(); expect(result).toBeUndefined();
  h.supported = true; h.online = false;
  await render();
  await act(async () => result!.open(message));
  expect(h.invoke).not.toHaveBeenCalled();
});

it('shows a retryable error without navigating when the host rejects the root', async () => {
  h.invoke.mockResolvedValue({ ok: false, errorCode: 'ROOT_UNAVAILABLE' });
  await render();
  await act(async () => result!.open(message));
  expect(h.alert).toHaveBeenCalledWith('groupChat.thread.title', 'groupChat.thread.openFailed');
  expect(h.push).not.toHaveBeenCalled();
  expect(result!.busy).toBe(false);
});
