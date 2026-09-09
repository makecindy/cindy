// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ invoke: vi.fn(), push: vi.fn(), changed: null as any, status: 'online', accountGeneration: 1, epoch: 1 }));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  View: ({ children }: any) => createElement('div', {}, children),
  Pressable: ({ children, onPress, disabled }: any) => createElement('button', { onClick: onPress, disabled }, children),
  StyleSheet: { create: (v: any) => v, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => useEffect(cb, [cb]), useLocalSearchParams: () => ({ deviceId: 'home' }), useRouter: () => ({ push: h.push }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => createElement('span', {}, children) }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.accountGeneration }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ invoke: h.invoke, status: h.status, connectionEpoch: h.epoch, getPresenceAvailability: () => true }),
  subscribeRemoteBotChanges: (fn: any) => { h.changed = fn; return () => { h.changed = null; }; },
}));
import { CompanionMessageCard } from '@/session/CompanionMessageCard';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
const message = { source: { sessionId: 'parent' }, companion: { kind: 'task', meta: { role: 'delegation-request', delegationId: 'job', childSessionId: 'child', objective: 'Report' } } } as NormalizedRemoteMessage;
let root: Root;
let node: HTMLDivElement;
const render = async () => { await act(async () => root.render(createElement(CompanionMessageCard, { message }))); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  h.accountGeneration = 1; h.epoch = 1; h.status = 'online'; h.invoke.mockReset(); h.push.mockReset();
  h.invoke.mockResolvedValue({ ok: true, delegations: [{ id: 'job', status: 'running', title: 'Report', childSessionId: 'child' }] });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });
it('reads, opens and stops the task on its source computer, then disables stop offline', async () => {
  await render();
  expect(h.invoke).toHaveBeenCalledWith('home', 'maker:bot-delegations:list', ['parent']);
  const button = (label: string) => [...node.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button('devices.companions.openTask').click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: { deviceId: 'home', sessionId: 'child' } });
  await act(async () => button('devices.companions.stopTask').click());
  expect(h.invoke).toHaveBeenCalledWith('home', 'maker:bot-delegation:cancel', ['parent', 'job']);
  h.status = 'reconnecting'; await render();
  expect(button('devices.companions.stopTask').disabled).toBe(true);
});
it('ignores another peer push and refreshes the actual task to completed', async () => {
  await render(); vi.useFakeTimers();
  h.invoke.mockResolvedValue({ ok: true, delegations: [{ id: 'job', status: 'completed', title: 'Report', resultSummary: 'Report finished' }] });
  await act(async () => { h.changed('office', 'maker:bot-delegation:changed', { parentSessionId: 'parent' }); await vi.advanceTimersByTimeAsync(400); });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await act(async () => { h.changed('home', 'maker:bot-delegation:changed', { parentSessionId: 'parent' }); await vi.advanceTimersByTimeAsync(400); });
  expect(node.textContent).toContain('Report finished');
  expect(node.textContent).not.toContain('devices.companions.stopTask');
});
it('does not render an old account response after account and connection change', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render(); h.accountGeneration = 2; h.epoch = 2; h.status = 'offline'; await render();
  await act(async () => finish({ ok: true, delegations: [{ id: 'job', title: 'Old private account', status: 'running' }] }));
  expect(node.textContent).not.toContain('Old private account');
});
