// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  focused: true, get: vi.fn(), auth: { accountGeneration: 1 },
  push: undefined as undefined | ((device: string, payload: any) => void),
  foreground: undefined as undefined | ((state: string) => void),
  appState: { currentState: 'active', addEventListener: vi.fn() },
  link: { invoke: vi.fn(), connectionEpoch: 1, status: 'online', onRemoteResourceChanged: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => h.focused }));
vi.mock('react-native', () => ({ AppState: h.appState }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: h.get }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
import { usePluginResultCard } from '@/session/usePluginResultCard';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let current: ReturnType<typeof usePluginResultCard>;
function Probe({ device = 'mac', task = 's', card = 'c' }: { device?: string; task?: string; card?: string }) {
  current = usePluginResultCard(device, task, card); return null;
}
async function render(props = {}) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => { root!.render(createElement(Probe, props)); });
}
const result = (text: string) => ({ display: { title: 'Plugin' }, blocks: [{ id: 'text', primitive: 'markdown', fallbackMarkdown: text }] });
beforeEach(() => {
  vi.clearAllMocks(); h.focused = true; h.link.status = 'online'; h.auth.accountGeneration = 1; h.link.connectionEpoch = 1;
  h.appState.currentState = 'active'; h.get.mockResolvedValue(result('done'));
  h.link.onRemoteResourceChanged.mockImplementation((cb) => { h.push = cb; return () => { h.push = undefined; }; });
  h.appState.addEventListener.mockImplementation((_event, cb) => { h.foreground = cb; return { remove() {} }; });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });
describe('plugin card lifecycle on Mobile', () => {
  it('loads history and refreshes on card change, foreground and reconnect', async () => {
    vi.useFakeTimers(); await render();
    expect(current.blocks?.[0].fallbackMarkdown).toBe('done');
    expect(h.get.mock.calls[0][2]).toEqual({ collectionId: 'plugin-results', kind: 'card', id: '["s","c"]' });
    h.get.mockResolvedValue(result('updated'));
    await act(async () => { h.push?.('other-device', { collectionId: 'plugin-results' }); await vi.advanceTimersByTimeAsync(250); });
    expect(h.get).toHaveBeenCalledTimes(1);
    await act(async () => { h.push?.('mac', { collectionId: 'plugin-results' }); await vi.advanceTimersByTimeAsync(250); });
    expect(current.blocks?.[0].fallbackMarkdown).toBe('updated');
    await act(async () => { h.foreground?.('active'); });
    expect(h.get).toHaveBeenCalledTimes(3);
    h.link.connectionEpoch += 1; await render(); expect(h.get).toHaveBeenCalledTimes(4);
  });
  it.each(['task', 'device', 'account'])('discards the previous %s response and clears its visible content', async (boundary) => {
    let release!: (value: unknown) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await render();
    if (boundary === 'account') h.auth.accountGeneration += 1;
    await render(boundary === 'task' ? { task: 'new' } : boundary === 'device' ? { device: 'new' } : {});
    await act(async () => release(result('old private content')));
    expect(current.blocks?.[0].fallbackMarkdown).toBe('done');
  });
  it('pauses while unfocused or offline and refreshes on return', async () => {
    h.focused = false; await render(); expect(h.get).not.toHaveBeenCalled();
    h.focused = true; h.link.status = 'offline'; await render();
    expect(current.error).toBe(true); expect(h.get).not.toHaveBeenCalled();
    h.link.status = 'online'; await render();
    expect(current.blocks?.[0].fallbackMarkdown).toBe('done');
  });
  it('drops cached content when the host revokes access', async () => {
    await render(); expect(current.blocks?.length).toBe(1);
    h.get.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'NOT_FOUND' }));
    await act(async () => current.retry());
    expect(current.blocks).toBeUndefined(); expect(current.error).toBe(true);
  });
  it('keeps failures visible and allows retry against an old or disconnected host', async () => {
    h.get.mockRejectedValueOnce(new Error('NOT_FOUND'));
    await render(); expect(current.error).toBe(true);
    await act(async () => current.retry());
    expect(current.error).toBe(false); expect(current.blocks?.[0].fallbackMarkdown).toBe('done');
  });
});
