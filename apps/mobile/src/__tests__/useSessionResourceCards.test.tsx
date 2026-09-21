// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RemoteResource,
  RemoteResourceChangedPayload,
} from '@cindy/device-link';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  manifest: vi.fn(),
  action: vi.fn(),
  changes: new Set<
    (device: string, payload: RemoteResourceChangedPayload) => void
  >(),
  app: { currentState: 'active', listeners: new Set<(next: string) => void>() },
  auth: { accountGeneration: 1 },
  link: {
    invoke: vi.fn(),
    connectionEpoch: 1,
    status: 'online',
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return h.app.currentState;
    },
    addEventListener: (_name: string, listener: (next: string) => void) => {
      h.app.listeners.add(listener);
      return { remove: () => h.app.listeners.delete(listener) };
    },
  },
}));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(effect, [effect]),
  };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
const onChange = (
  listener: (device: string, payload: RemoteResourceChangedPayload) => void,
) => {
  h.changes.add(listener);
  return () => h.changes.delete(listener);
};
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ ...h.link, onRemoteResourceChanged: onChange }),
}));
vi.mock('@/device-link/remoteResources', () => ({
  getRemoteResource: h.get,
  loadRemoteResourceManifest: h.manifest,
  invokeRemoteResourceAction: h.action,
}));
vi.mock('@/device-link/focusedTopicSubscription', () => ({
  startFocusedTopicSubscription: () => () => {},
}));
import { useSessionResourceCards } from '@/session/useSessionResourceCards';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const views = new Map<string, ReturnType<typeof useSessionResourceCards>>();
const resource = (revision = '1', input = 'blocked'): RemoteResource => ({
  ref: { collectionId: 'workflow', kind: 'session', id: 'task' },
  revision,
  display: { title: 'Preparing test' },
  links: [],
  blocks: [
    {
      id: 'controls',
      primitive: 'session-controls',
      fallbackMarkdown: 'Preparing test',
      data: { input, busy: true },
    },
  ],
  actions: [{ id: 'start', label: 'Start' }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function Probe({
  device,
  session = 'task',
}: {
  device: string;
  session?: string;
}) {
  views.set(
    device,
    useSessionResourceCards(device, device, session, 'host-feature', false),
  );
  return null;
}
async function render(session = 'task', second = false) {
  root ??= createRoot(document.createElement('div'));
  await act(async () =>
    root!.render(
      createElement(
        'div',
        {},
        createElement(Probe, { device: 'mac', session }),
        second ? createElement(Probe, { device: 'pc' }) : null,
      ),
    ),
  );
}
async function advance(ms = 160) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function push(device = 'mac') {
  act(() =>
    h.changes.forEach((listener) =>
      listener(device, {
        collectionId: 'workflow',
        resourceRefs: [resource().ref],
      }),
    ),
  );
}
function foreground(next: string) {
  act(() => {
    h.app.currentState = next;
    h.app.listeners.forEach((listener) => listener(next));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  views.clear();
  h.auth.accountGeneration = 1;
  h.link.connectionEpoch = 1;
  h.link.status = 'online';
  h.app.currentState = 'active';
  h.manifest.mockResolvedValue({
    collections: [
      {
        id: 'workflow',
        resourceKind: 'session',
        placement: 'session:host-feature',
      },
    ],
  });
  h.get.mockResolvedValue(resource());
  h.action.mockResolvedValue({ effects: [] });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

describe('host task cards on Mobile', () => {
  it('keeps available input mounted during progress refresh but blocks after a failed read', async () => {
    h.get.mockResolvedValue(resource('1', 'available'));
    await render();
    const slow = deferred<RemoteResource>();
    h.get.mockReturnValueOnce(slow.promise);
    push();
    expect(views.get('mac')?.fresh).toBe(false);
    expect(views.get('mac')?.blocked).toBe(false);
    await advance();
    expect(views.get('mac')?.blocked).toBe(false);
    await act(async () => slow.reject(new Error('offline')));
    expect(views.get('mac')?.blocked).toBe(true);
  });
  it('holds input after an action until the host has confirmed its resulting state', async () => {
    h.get.mockResolvedValue(resource('1', 'available'));
    await render();
    await act(async () => views.get('mac')!.act(resource(), 'start'));
    expect(views.get('mac')?.blocked).toBe(true);
    h.get.mockResolvedValue(resource('2', 'available'));
    await advance();
    expect(views.get('mac')?.blocked).toBe(false);
  });
  it('uses desktop invalidation to replace progress and unlock editing', async () => {
    await render();
    expect(views.get('mac')?.blocked).toBe(true);
    h.get.mockResolvedValue(resource('2', 'available'));
    push();
    expect(views.get('mac')?.fresh).toBe(false);
    await advance();
    expect(views.get('mac')?.resources[0].revision).toBe('2');
    expect(views.get('mac')?.blocked).toBe(false);
  });
  it('coalesces progress pushes and discards reads superseded by the desktop', async () => {
    await render();
    const old = deferred<RemoteResource>();
    h.get.mockReturnValueOnce(old.promise);
    push();
    await advance();
    push();
    push();
    push();
    expect(h.get).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(resource('old')));
    expect(views.get('mac')?.resources[0].revision).toBe('1');
    h.get.mockResolvedValue(resource('new'));
    await advance();
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(views.get('mac')?.resources[0].revision).toBe('new');
  });
  it('does not starve a read slower than the polling interval', async () => {
    const slow = deferred<RemoteResource>();
    h.get.mockReturnValueOnce(slow.promise);
    await render();
    await advance(12_000);
    expect(h.get).toHaveBeenCalledOnce();
    await act(async () => slow.resolve(resource('slow')));
    expect(views.get('mac')?.fresh).toBe(true);
  });
  it('keeps another device usable when one read fails; retries reads only', async () => {
    await render('task', true);
    h.get.mockImplementation(async (_invoke, target) => {
      if (target.deviceId === 'mac') throw new Error('timeout');
      return resource('pc-new', 'available');
    });
    push();
    push('pc');
    await advance();
    expect(views.get('mac')?.failed).toBe(true);
    expect(views.get('pc')?.blocked).toBe(false);
    expect(h.action).not.toHaveBeenCalled();
    h.get.mockResolvedValue(resource('recovered', 'available'));
    act(() => views.get('mac')?.refresh());
    await advance();
    expect(views.get('mac')?.failed).toBe(false);
  });
  it.each(['account', 'session', 'reconnect'])(
    'ignores late results after %s changes',
    async (change) => {
      const old = deferred<RemoteResource>();
      h.get.mockReturnValueOnce(old.promise);
      await render();
      h.get.mockResolvedValue(resource('current'));
      if (change === 'account') h.auth.accountGeneration += 1;
      if (change === 'reconnect') h.link.connectionEpoch += 1;
      await render(change === 'session' ? 'new-task' : 'task');
      await act(async () => old.resolve(resource('old-owner')));
      expect(views.get('mac')?.resources[0].revision).toBe('current');
    },
  );
  it('refreshes after foreground and reconnect without replaying a timed-out action', async () => {
    await render();
    h.action.mockRejectedValueOnce(new Error('timeout after host accepted'));
    await act(async () => views.get('mac')!.act(resource(), 'start'));
    await advance();
    expect(views.get('mac')?.failed).toBe(true);
    expect(h.action).toHaveBeenCalledOnce();
    foreground('background');
    const before = h.get.mock.calls.length;
    await advance(10_000);
    expect(h.get).toHaveBeenCalledTimes(before);
    foreground('active');
    await advance();
    h.link.status = 'offline';
    await render();
    expect(views.get('mac')?.fresh).toBe(false);
    h.link.status = 'online';
    h.link.connectionEpoch += 1;
    await render();
    expect(h.action).toHaveBeenCalledOnce();
    act(() => views.get('mac')!.refresh());
    await advance();
    expect(views.get('mac')?.failed).toBe(false);
  });
  it('prevents a double tap and does not carry its pending state to another task', async () => {
    await render();
    const pending = deferred<{ effects: [] }>();
    h.action.mockReturnValueOnce(pending.promise);
    let first!: Promise<void>;
    act(() => {
      first = views.get('mac')!.act(resource(), 'start');
      void views.get('mac')!.act(resource(), 'start');
    });
    expect(h.action).toHaveBeenCalledOnce();
    await render('other');
    expect(views.get('mac')?.pending).toBeNull();
    await act(async () => {
      pending.resolve({ effects: [] });
      await first;
    });
    expect(views.get('mac')?.pending).toBeNull();
  });
  it('keeps an ordinary task unchanged when the host has no matching provider', async () => {
    h.manifest.mockResolvedValue(null);
    await render();
    expect(views.get('mac')?.resources).toEqual([]);
    expect(views.get('mac')?.blocked).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });
});
