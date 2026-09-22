// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL as CHANGED,
  REMOTE_RESOURCE_MANIFEST_CHANNEL as MANIFEST,
  REMOTE_RESOURCE_GET_CHANNEL as GET,
  REMOTE_RESOURCE_INVOKE_CHANNEL as INVOKE,
  sharedTaskHostPeer,
} from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { useSessionResourceCards } from '../useSessionResourceCards';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
const options = {
  deviceId: 'computer-a',
  sessionId: 'make-a',
  source: 'cindy-make',
  connected: true,
  running: false,
};
type Options = Parameters<typeof useSessionResourceCards>[0];
type Push = Parameters<Parameters<Window['electronAPI']['deviceLink']['onRemotePush']>[0]>[0];
const callbacks = new Set<(push: Push) => void>();
const manifest = {
  protocolVersion: 1,
  collections: [{ id: 'cindy-make', resourceKind: 'session', placement: 'session:cindy-make' }],
};
function card(sessionId = 'make-a', input = 'blocked') {
  return {
    ref: { collectionId: 'cindy-make', kind: 'session', id: sessionId },
    revision: 'one',
    display: { title: 'Ready to test' },
    blocks: [
      {
        id: 'workflow',
        primitive: 'session-controls',
        fallbackMarkdown: 'Ready to test',
        data: { input, busy: false },
      },
    ],
    actions: [
      { id: 'opaque:continue', label: 'Continue editing' },
      { id: 'opaque:test', label: 'Start test' },
      { id: 'opaque:build', label: 'Generate personal version' },
    ],
  };
}
let host = card();
const invoke = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function tick(ms = 200) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function push(deviceId = 'computer-a', sessionId = 'make-a', owner = 'account') {
  act(() => {
    for (const callback of callbacks)
      callback({
        deviceId,
        channel: CHANGED,
        ownerStamp: { dataOwnerId: owner, ownerGeneration: 1 },
        payload: {
          collectionId: 'cindy-make',
          resourceRefs: [{ collectionId: 'cindy-make', kind: 'session', id: sessionId }],
        },
      });
  });
}
function mount(props: Options = options) {
  return renderHook((input: Options) => useSessionResourceCards(input), { initialProps: props });
}
beforeEach(() => {
  vi.useFakeTimers();
  callbacks.clear();
  setDataOwnerGeneration('account', 1);
  resetRemoteDataOwnerPushFence();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  host = card();
  invoke.mockReset().mockImplementation(async (_device, channel) => {
    if (channel === MANIFEST) return manifest;
    if (channel === GET) return host;
    return { effects: [] };
  });
  confirm.mockReset().mockResolvedValue(true);
  vi.stubGlobal('electronAPI', {
    deviceLink: {
      invoke,
      onRemotePush: (callback: (push: Push) => void) => {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['opaque:continue', 'opaque:test', 'opaque:build'])(
  'routes %s to the owning computer once and refreshes host facts',
  async (actionId) => {
    const view = mount();
    expect(view.result.current.blocked).toBe(true);
    await tick();
    expect(view.result.current.fresh).toBe(true);
    const resource = view.result.current.resources[0];
    const response = deferred<unknown>();
    invoke.mockImplementation(async (_device, channel) =>
      channel === INVOKE ? response.promise : channel === MANIFEST ? manifest : host,
    );
    let action!: Promise<void>;
    act(() => {
      action = view.result.current.act(resource, actionId);
      void view.result.current.act(resource, actionId);
    });
    expect(invoke.mock.calls.filter((call) => call[1] === INVOKE)).toEqual([
      [
        'computer-a',
        INVOKE,
        [
          {
            client: { protocolVersion: 1, primitives: ['session-controls'], locale: 'en' },
            collectionId: 'cindy-make',
            resourceRef: resource.ref,
            actionId,
          },
        ],
      ],
    ]);
    host = card('make-a', 'available');
    await act(async () => {
      response.resolve({ effects: [] });
      await action;
    });
    expect(view.result.current.blocked).toBe(true);
    await tick();
    expect(view.result.current.blocked).toBe(false);
  },
);

it('ignores other computers, tasks and accounts, and refreshes matching changes', async () => {
  const view = mount();
  await tick();
  host = card('make-a', 'available');
  push('computer-b');
  push('computer-a', 'make-b');
  push('computer-a', 'make-a', 'other');
  await tick();
  expect(invoke.mock.calls.filter((call) => call[1] === GET)).toHaveLength(1);
  expect(view.result.current.blocked).toBe(true);
  push();
  await tick();
  expect(view.result.current.blocked).toBe(false);
});

it('coalesces invalidations and does not publish a read begun before the change', async () => {
  const response = deferred<unknown>();
  invoke.mockImplementation(async (_device, channel) =>
    channel === MANIFEST ? manifest : response.promise,
  );
  const view = mount();
  await tick();
  push();
  push();
  push();
  await tick(16_000);
  expect(invoke.mock.calls.filter((call) => call[1] === GET)).toHaveLength(1);
  invoke.mockImplementation(async () => card());
  await act(async () => response.resolve(card('make-a', 'available')));
  expect(view.result.current.fresh).toBe(false);
  await tick();
  expect(invoke.mock.calls.filter((call) => call[1] === GET)).toHaveLength(2);
  expect(view.result.current.blocked).toBe(true);
});

it.each(['task', 'computer', 'account'])(
  'discards late reads and old actions after switching %s',
  async (change) => {
    const response = deferred<unknown>();
    invoke.mockImplementation(async (_device, channel) =>
      channel === MANIFEST ? manifest : response.promise,
    );
    const view = mount();
    await tick();
    const next = { ...options };
    if (change === 'task') next.sessionId = 'make-b';
    if (change === 'computer') next.deviceId = 'computer-b';
    if (change === 'account') setDataOwnerGeneration('other', 2);
    invoke.mockImplementation(async (_device, channel) =>
      channel === MANIFEST ? manifest : card(next.sessionId, 'available'),
    );
    view.rerender(next);
    await tick();
    await act(async () => response.resolve(card()));
    expect(view.result.current.blocked).toBe(false);
    expect(view.result.current.resources[0].ref.id).toBe(next.sessionId);
  },
);

it('keeps the last card offline and reconnects without replaying a failed write', async () => {
  const view = mount();
  await tick();
  const resource = view.result.current.resources[0];
  invoke.mockRejectedValueOnce(new Error('Reply lost'));
  await act(async () => view.result.current.act(resource, 'opaque:build'));
  view.rerender({ ...options, connected: false });
  expect(view.result.current.resources[0]).toBe(resource);
  expect(view.result.current.fresh).toBe(false);
  await act(async () => view.result.current.act(resource, 'opaque:build'));
  view.rerender(options);
  expect(view.result.current.fresh).toBe(false);
  await tick();
  expect(view.result.current.fresh).toBe(true);
  expect(view.result.current.failed).toBe(false);
  expect(invoke.mock.calls.filter((call) => call[1] === INVOKE)).toHaveLength(1);
});

it('pauses hidden/disabled views and refreshes before enabling actions on return', async () => {
  const view = mount();
  await tick();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await tick(20_000);
  expect(view.result.current.fresh).toBe(false);
  expect(invoke.mock.calls.filter((call) => call[1] === GET)).toHaveLength(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await tick();
  expect(view.result.current.fresh).toBe(true);
  view.rerender({ ...options, active: false });
  await tick(20_000);
  expect(invoke.mock.calls.filter((call) => call[1] === GET)).toHaveLength(2);
});

it.each(['no-placement', 'old-host'])(
  'keeps read-only history when the host has %s',
  async (kind) => {
    if (kind === 'old-host')
      invoke.mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unavailable'));
    else invoke.mockResolvedValue({ protocolVersion: 1, collections: [] });
    const view = mount();
    await tick();
    expect(view.result.current.handlesSession).toBe(false);
    expect(view.result.current.blocked).toBe(false);
    expect(view.result.current.failed).toBe(false);
    await tick(20_000);
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it('blocks on read errors and supports explicit retry without local fallback', async () => {
  invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] timeout'));
  const view = mount();
  await tick();
  expect(view.result.current.failed).toBe(true);
  expect(view.result.current.blocked).toBe(true);
  act(() => view.result.current.refresh());
  await tick();
  expect(view.result.current.failed).toBe(false);
  expect(view.result.current.fresh).toBe(true);
});

it.each([undefined, sharedTaskHostPeer('membership', 'computer')])(
  'does not discover device-wide resources for local or shared guest tasks (%s)',
  async (deviceId) => {
    const view = mount({ ...options, deviceId });
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(view.result.current.blocked).toBe(false);
  },
);

it('allows read-only projection but rejects its actions', async () => {
  const view = mount({ ...options, readOnly: true });
  await tick();
  await act(async () => view.result.current.act(view.result.current.resources[0], 'opaque:build'));
  expect(invoke.mock.calls.some((call) => call[1] === INVOKE)).toBe(false);
});

it.each(['accept', 'cancel', 'changed', 'disconnect', 'account', 'unmount'])(
  'rechecks a stop confirmation on %s',
  async (change) => {
    const stop = {
      id: 'opaque:stop',
      label: 'Stop',
      tone: 'destructive',
      confirmation: { title: 'Stop this build?', body: 'Prepared files are kept.' },
    };
    host.actions = [stop];
    const approval = deferred<boolean>();
    confirm.mockReturnValue(approval.promise);
    const view = mount();
    await tick();
    let operation!: Promise<void>;
    act(() => {
      operation = view.result.current.act(view.result.current.resources[0], stop.id);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Stop this build?', confirmVariant: 'destructive' }),
      expect.any(AbortSignal),
    );
    if (change === 'changed') {
      host = card();
      push();
      await tick();
    }
    if (change === 'disconnect') view.rerender({ ...options, connected: false });
    if (change === 'account') {
      setDataOwnerGeneration('other', 2);
      view.rerender(options);
    }
    if (change === 'unmount') view.unmount();
    await act(async () => {
      approval.resolve(change !== 'cancel');
      await operation;
    });
    expect(invoke.mock.calls.filter((call) => call[1] === INVOKE)).toHaveLength(
      change === 'accept' ? 1 : 0,
    );
  },
);
