// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openLink: vi.fn(),
  push: vi.fn(),
  openURL: vi.fn(),
  changed: null as any,
  status: 'online',
  accountGeneration: 1,
  epoch: 1,
  routeDevice: 'home',
  listeners: new Set<any>(),
}));
vi.mock('react-native', () => ({
  Linking: { openURL: h.openURL },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove() {} }),
  },
  View: ({ children, onLayout }: any) => {
    useEffect(() => {
      if (!onLayout) return;
      const event = { nativeEvent: { layout: { width: 128, height: 32, x: 0, y: 0 } } as
        | { layout: { width: number; height: number; x: number; y: number } }
        | null };
      onLayout(event);
      event.nativeEvent = null;
    });
    return createElement('div', {}, children);
  },
  Pressable: ({ children, onPress, disabled, testID }: any) =>
    createElement(
      'button',
      { onClick: onPress, disabled, 'data-testid': testID },
      typeof children === 'function' ? children({ pressed: false }) : children,
    ),
  StyleSheet: { create: (v: any) => v, hairlineWidth: 1 },
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
  Animated: {
    Value: class { setValue() {} stopAnimation() {} interpolate() { return 0; } },
    View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
    timing: () => ({ start() {}, stop() {} }),
    sequence: () => ({ start() {}, stop() {} }),
    loop: () => ({ start() {}, stop() {} }),
  },
  Easing: { inOut: () => () => 0, ease: () => 0, bezier: () => () => 0 },
}));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => useEffect(cb, [cb]),
  useLocalSearchParams: () => ({ deviceId: h.routeDevice }),
  useRouter: () => ({ push: h.push }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => createElement('span', {}, children),
}));
vi.mock('@/theme', async () => ({
  ...await vi.importActual<typeof import('@/theme/tokens')>('@/theme/tokens'),
  useThemedStyles: () => ({ note: {} }),
  useTheme: () => ({ colors: {} }),
}));
vi.mock('lucide-react-native', () => ({
  FileText: () => null,
  ArrowLeftRight: () => null,
  ChevronRight: () => null,
  GitPullRequest: () => null,
  Square: () => null,
  GitMerge: () => createElement('i', { 'data-testid': 'merged-pr' }),
  GitPullRequestClosed: () => null,
  GitPullRequestDraft: () => null,
  Megaphone: () => null,
  TriangleAlert: () => null,
  Layers: () => null,
  CircleAlert: () => null,
  CircleCheck: () => null,
  ChevronDown: () => null,
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ accountGeneration: h.accountGeneration, user: { id: 'owner' } }),
}));
vi.mock('@/components/RemoteCompanionAvatar', () => ({
  RemoteCompanionAvatar: ({ name }: any) => createElement('i', { 'data-testid': 'peer-avatar' }, name),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({
    invoke: h.invoke,
    openLink: h.openLink,
    status: h.status,
    connectionEpoch: h.epoch,
    getPresenceAvailability: () => true,
  }),
  subscribeRemoteBotChanges: (fn: any) => {
    h.listeners.add(fn);
    h.changed = (...args: any[]) => {
      for (const listener of h.listeners) listener(...args);
    };
    return () => {
      h.listeners.delete(fn);
    };
  },
}));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
import { CompanionMessageCard } from '@/session/CompanionMessageCard';
import { SessionQuickSendProvider, useSessionQuickSend } from '@/session/SessionQuickSendContext';
import { _clearRemotePathVerdictCache } from '@/session/remotePathVerdict';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
const message = {
  source: { sessionId: 'parent' },
  companion: {
    kind: 'task',
    meta: {
      role: 'delegation-request',
      delegationId: 'job',
      childSessionId: 'child',
      objective: 'Report',
    },
  },
} as NormalizedRemoteMessage;
let root: Root;
let node: HTMLDivElement;
const render = async () => {
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message })));
};
const renderTasks = async (ids: string[]) => {
  await act(async () => root.render(ids.map((id, index) => createElement(CompanionMessageCard, {
    key: index, deviceId: 'home', message: {
      ...message,
      companion: { ...message.companion, meta: {
        ...message.companion!.meta, delegationId: `job-${id}`, childSessionId: id,
      } },
    } as NormalizedRemoteMessage,
  }))));
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  h.listeners.clear();
  h.accountGeneration = 1;
  h.epoch = 1;
  h.status = 'online';
  h.routeDevice = 'home';
  remoteSessionStore.clear();
  h.invoke.mockReset();
  h.openLink.mockReset().mockResolvedValue({});
  h.push.mockReset();
  h.openURL.mockReset().mockResolvedValue(undefined);
  h.invoke.mockResolvedValue({
    ok: true,
    delegations: [
      {
        id: 'job',
        status: 'running',
        title: 'Report',
        childSessionId: 'child',
      },
    ],
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  _clearRemotePathVerdictCache();
  node.remove();
  vi.useRealTimers();
});
const openEntry = () => node.querySelector<HTMLButtonElement>('[data-testid="companion.taskCard.open"]');
// Regression: a transcript's resolved host can differ from (or be absent in) route params.
// Unit: render the production card, assert the query and actual task-opening destination.
it('uses the transcript host for queries and opening even when the route names another computer', async () => {
  h.routeDevice = 'other';
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message })));
  expect(h.invoke).toHaveBeenCalledWith('home', 'maker:bot-delegations:list', ['parent']);
  await act(async () => openEntry()!.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: { deviceId: 'home', sessionId: 'child' } });
});

// Previously every test supplied a successful delegation snapshot; none exercised the
// reported state where the ordinary task list is live but the delegation query fails.
it('keeps the original task title, live status and opening when the delegation read fails', async () => {
  remoteSessionStore.setDeviceSessions('home', 'Mac', [{
    id: 'child', title: 'Original task', status: 'active', agentKind: 'codex',
    createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  } as RemoteSession]);
  remoteSessionStore.applyRemotePush('home', SESSION_ACTIVITY_CHANNEL, {
    sessionId: 'child', phase: 'running', compactDetail: 'Checking the fix',
  });
  h.invoke.mockRejectedValue(new Error('BACKPRESSURE'));
  await render();
  expect(node.textContent).toContain('Original task');
  expect(node.textContent).toContain('devices.companions.status.running');
  expect(node.textContent).not.toContain('devices.companions.status.unknown');
  await act(async () => openEntry()!.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: { deviceId: 'home', sessionId: 'child' } });
  await act(async () => remoteSessionStore.applyRemotePush('home', SESSION_ACTIVITY_CHANNEL, {
    sessionId: 'child', phase: 'needs-interaction', attention: true,
  }));
  expect(node.textContent).toContain('devices.companions.status.waiting');
});

// Unit regression: a failed delegation refresh retains its old active row. An
// authoritative task error must still win, even while an interaction is pending.
it.each(['running', 'waiting'])('shows task errors ahead of a stale %s delegation', async (status) => {
  remoteSessionStore.setDeviceSessions('home', 'Mac', [
    { id: 'child', title: 'Own task', status: 'active' } as RemoteSession,
  ]);
  h.invoke.mockResolvedValue({ ok: true, delegations: [
    { id: 'job', status, title: 'Report', childSessionId: 'child' },
  ] });
  await render();
  h.invoke.mockRejectedValue(new Error('read failed'));
  vi.useFakeTimers();
  await act(async () => {
    h.changed('home', 'maker:bot-delegation:changed', { parentSessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(node.textContent).toContain('devices.companions.stale');
  await act(async () => {
    if (status === 'waiting') remoteSessionStore.setPendingInteractions('child', [
      { request: { kind: 'permission', requestId: 'permission-1' } },
    ], { deviceId: 'home' });
    remoteSessionStore.applyRemotePush('home', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 'child', phase: 'error', attention: true,
    });
  });
  expect(node.textContent).toContain('devices.companions.status.failed');
  expect(node.textContent).not.toContain(`devices.companions.status.${status}`);
  expect(openEntry()?.disabled).toBe(false);
});

it('opens the task from the whole card and keeps stop as a small action while it runs', async () => {
  await render();
  expect(openEntry()?.disabled).toBe(false);
  expect(node.textContent).not.toContain('devices.companions.openTask');
  expect(node.textContent).toContain('devices.companions.stopTask');
});

// Review regression: a one-shot off-list title masked later renames indefinitely.
// Unit: the rendered card must refresh that title, then stop extra reads once listed.
it('refreshes an off-list task title and follows the list when a completed task runs again', async () => {
  vi.useFakeTimers();
  let title = 'Updated task title';
  h.invoke.mockImplementation(async (_device, channel) => channel === 'local-db:sessions:get-many'
    ? [{ id: 'child', title }]
    : { ok: true, delegations: [{ id: 'job', childSessionId: 'child', status: 'completed', title: 'Old title' }] });
  await render();
  expect(node.textContent).toContain('Updated task title');
  expect(node.textContent).toContain('devices.companions.status.completed');
  title = 'Renamed off-list task';
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(node.textContent).toContain('Renamed off-list task');
  expect(node.textContent).not.toContain('Updated task title');
  await act(async () => {
    remoteSessionStore.setDeviceSessions('home', 'Mac', [{ id: 'child', title: 'Updated task title', status: 'active' } as RemoteSession]);
    remoteSessionStore.applyRemotePush('home', SESSION_ACTIVITY_CHANNEL, { sessionId: 'child', phase: 'running' });
  });
  expect(node.textContent).toContain('devices.companions.status.running');
  expect(node.textContent).not.toContain('devices.companions.status.completed');
  const taskReads = () => h.invoke.mock.calls.filter((call) => call[1] === 'local-db:sessions:get-many').length;
  const reads = taskReads();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(taskReads()).toBe(reads);
  expect(node.textContent).toContain('Updated task title');
});

// Unit: mounted production cards must coalesce different IDs, not just duplicate
// bindings. Nine unique tasks cross the eight-ID boundary without concurrent fanout.
it('batches off-list cards and shares their polling wave', async () => {
  vi.useFakeTimers();
  const ids = Array.from({ length: 9 }, (_, i) => `child-${i}`);
  let active = 0;
  let peak = 0;
  h.invoke.mockImplementation(async (_device, channel, args) => {
    if (channel !== 'local-db:sessions:get-many') return { ok: true, delegations: [] };
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return args[0].map((id: string) => ({ id, title: `Task ${id}` }));
  });
  await renderTasks([...ids, ids[0]!]);
  const batches = () => h.invoke.mock.calls.filter((call) => call[1] === 'local-db:sessions:get-many');
  expect(batches().map((call) => call[2][0])).toEqual([ids.slice(0, 8), ids.slice(8)]);
  ids.forEach((id) => expect(node.textContent).toContain(`Task ${id}`));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(batches().map((call) => call[2][0])).toEqual([
    ids.slice(0, 8), ids.slice(8), ids.slice(0, 8), ids.slice(8),
  ]);
  expect(peak).toBe(1);
  expect(h.invoke.mock.calls.some((call) => call[1] === 'local-db:sessions:get')).toBe(false);
});

it.each(['[CHANNEL_NOT_ALLOWED] old host', '[PRECONDITION_FAILED] REMOTE_SESSION_BATCH_TOO_LARGE'])(
  'uses serial single reads only for batch compatibility failure %s', async (error) => {
    let active = 0;
    let peak = 0;
    h.invoke.mockImplementation(async (_device, channel, args) => {
      if (channel === 'local-db:sessions:get-many') throw new Error(error);
      if (channel !== 'local-db:sessions:get') return { ok: true, delegations: [] };
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return { id: args[0], title: `Task ${args[0]}` };
    });
    await renderTasks(['one', 'two']);
    expect(node.textContent).toContain('Task one');
    expect(node.textContent).toContain('Task two');
    expect(h.invoke.mock.calls.filter((call) => call[1] === 'local-db:sessions:get')).toHaveLength(2);
    expect(peak).toBe(1);
  },
);

it.each(['INVOKE_TIMEOUT', 'ACCESS_REVOKED', 'malformed'])(
  'does not multiply a failed batch into single reads: %s', async (failure) => {
    h.invoke.mockImplementation(async (_device, channel) => {
      if (channel !== 'local-db:sessions:get-many') return { ok: true, delegations: [] };
      if (failure === 'malformed') return [{ id: 'unrequested', title: 'Wrong task' }];
      throw Object.assign(new Error(failure), { code: failure });
    });
    await renderTasks(['one', 'two']);
    expect(node.textContent).not.toContain('Wrong task');
    expect(h.invoke.mock.calls.filter((call) => call[1] === 'local-db:sessions:get-many')).toHaveLength(1);
    expect(h.invoke.mock.calls.some((call) => call[1] === 'local-db:sessions:get')).toBe(false);
  },
);

it('drops queued batch reads and late titles after account change', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation((_device, channel) => channel === 'local-db:sessions:get-many'
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true, delegations: [] }));
  const ids = Array.from({ length: 9 }, (_, i) => `child-${i}`);
  await renderTasks(ids);
  h.accountGeneration++;
  h.status = 'offline';
  await renderTasks(ids);
  await act(async () => finish(ids.slice(0, 8).map((id) => ({ id, title: 'Old private title' }))));
  expect(node.textContent).not.toContain('Old private title');
  expect(h.invoke.mock.calls.filter((call) => call[1] === 'local-db:sessions:get-many')).toHaveLength(1);
});

it.each(['activity', 'interaction'])('filters another host\'s off-list %s even after it is removed', async (kind) => {
  const push = (device: string) => kind === 'activity'
    ? remoteSessionStore.applySessionActivity(device, { sessionId: 'child', phase: 'running' })
    : remoteSessionStore.applyRemotePush(device, 'maker:interaction-request', {
      sessionId: 'child', request: { kind: 'permission', requestId: 'permission-1' },
    });
  push('other');
  remoteSessionStore.removeDevice('other');
  h.invoke.mockRejectedValue(new Error('read failed'));
  await render();
  expect(node.textContent).toContain('devices.companions.status.unknown');
  await act(async () => push('home'));
  expect(node.textContent).toContain(`devices.companions.status.${kind === 'activity' ? 'running' : 'waiting'}`);
});

it('does not borrow another computer\'s task identity or activity for the same id', async () => {
  remoteSessionStore.setDeviceSessions('other', 'Other Mac', [{ id: 'child', title: 'Unrelated task', status: 'active' } as RemoteSession]);
  remoteSessionStore.applyRemotePush('other', SESSION_ACTIVITY_CHANNEL, { sessionId: 'child', phase: 'running' });
  h.invoke.mockRejectedValue(new Error('read failed'));
  await render();
  expect(node.textContent).not.toContain('Unrelated task');
  expect(node.textContent).toContain('devices.companions.status.unknown');
  expect(openEntry()?.disabled).toBe(true);
  expect(h.invoke).not.toHaveBeenCalledWith('home', 'local-db:sessions:get', ['child']);
});

// Reverse collision ordering: the card owns the cached row, then another host
// sends live signals for that ID. Assert the production card's visible status.
it.each(['running', 'completed'] as const)('keeps the owning computer\'s %s state despite another host\'s pushes', async (phase) => {
  remoteSessionStore.setDeviceSessions('home', 'Mac', [{ id: 'child', title: 'Own task', status: 'active' } as RemoteSession]);
  remoteSessionStore.setDeviceSessions('other', 'Other Mac', [{ id: 'child', title: 'Other task', status: 'active' } as RemoteSession]);
  remoteSessionStore.applyRemotePush('home', SESSION_ACTIVITY_CHANNEL, { sessionId: 'child', phase, attention: true });
  h.invoke.mockRejectedValue(new Error('read failed'));
  await render();
  await act(async () => {
    remoteSessionStore.applyRemotePush('other', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 'child', phase: phase === 'running' ? 'completed' : 'needs-interaction', attention: true,
    });
    remoteSessionStore.applyRemotePush('other', 'maker:event', {
      sessionId: 'child', event: { type: phase === 'running' ? 'done' : 'status', data: { isRunning: true } },
    });
  });
  expect(node.textContent).toContain(`devices.companions.status.${phase}`);
  expect(node.textContent).not.toContain('devices.companions.status.waiting');
  expect(openEntry()?.disabled).toBe(false);
});

// Review regression: a push can beat both task lists during reconnect. Choosing
// the row must retain same-host evidence and discard a different host's evidence.
it.each(['home', 'other'])('reconciles %s activity received before the task list', async (source) => {
  remoteSessionStore.applyRemotePush(source, SESSION_ACTIVITY_CHANNEL, { sessionId: 'child', phase: 'running' });
  h.invoke.mockRejectedValue(new Error('read failed'));
  await render();
  await act(async () => remoteSessionStore.setDeviceSessions('home', 'Mac', [
    { id: 'child', title: 'Own task', status: 'active' } as RemoteSession,
  ]));
  expect(node.textContent).toContain(`devices.companions.status.${source === 'home' ? 'running' : 'unknown'}`);
  expect(openEntry()?.disabled).toBe(false);
});

// Detail/reconnect snapshots share this production store entry. Exercise both
// arrival orders and retain same-host snapshots, including an authoritative clear.
it.each(['before', 'after'])('scopes pending snapshots received %s the owning row', async (order) => {
  const row = () => remoteSessionStore.setDeviceSessions('home', 'Mac', [
    { id: 'child', title: 'Own task', status: 'active' } as RemoteSession,
  ]);
  const pending = [{ request: { kind: 'permission' as const, requestId: 'permission-1' } }];
  if (order === 'after') row();
  remoteSessionStore.setPendingInteractions('child', pending, { deviceId: 'other', finalizeStreaming: true });
  if (order === 'before') row();
  h.invoke.mockRejectedValue(new Error('read failed'));
  await render();
  expect(node.textContent).toContain('devices.companions.status.unknown');
  await act(async () => remoteSessionStore.setPendingInteractions('child', pending, { deviceId: 'home' }));
  expect(node.textContent).toContain('devices.companions.status.waiting');
  await act(async () => remoteSessionStore.setPendingInteractions('child', [], { deviceId: 'other' }));
  expect(node.textContent).toContain('devices.companions.status.waiting');
  await act(async () => remoteSessionStore.setPendingInteractions('child', [], { deviceId: 'home' }));
  expect(node.textContent).not.toContain('devices.companions.status.waiting');
});

// A missing activity relay must not hide an interaction already known to the list.
it('shows waiting for pending interactions without activity and clears it after dismissal', async () => {
  remoteSessionStore.setDeviceSessions('home', 'Mac', [{ id: 'child', title: 'Own task', status: 'active' } as RemoteSession]);
  h.invoke.mockRejectedValue(new Error('read failed'));
  await render();
  await act(async () => remoteSessionStore.applyRemotePush('home', 'maker:interaction-request', {
    sessionId: 'child', request: { kind: 'permission', requestId: 'permission-1' },
  }));
  expect(node.textContent).toContain('devices.companions.status.waiting');
  await act(async () => remoteSessionStore.applyRemotePush('other', 'maker:interaction-dismissed', {
    sessionId: 'child', requestId: 'permission-1',
  }));
  expect(node.textContent).toContain('devices.companions.status.waiting');
  await act(async () => remoteSessionStore.applyRemotePush('home', 'maker:interaction-dismissed', {
    sessionId: 'child', requestId: 'permission-1',
  }));
  expect(node.textContent).not.toContain('devices.companions.status.waiting');
});

it('keeps the task card when the host omits delegations or sends a broken status', async () => {
  h.invoke.mockResolvedValue({ ok: true });
  await render();
  expect(node.textContent).toContain('devices.companions.status.unknown');
  expect(node.textContent).not.toContain('devices.companions.stopTask');
  h.invoke.mockResolvedValue({
    ok: true,
    delegations: [{ id: 'job', status: 'not-a-status', title: 'Report', childSessionId: 'child' }],
  });
  await render();
  expect(node.textContent).toContain('devices.companions.status.unknown');
  expect(openEntry()?.disabled).toBe(false);
});

it('isolates a broken private-chat card so the session can keep rendering', async () => {
  const broken = {
    ...message,
    key: 'broken-direct',
    companion: { kind: 'direct', meta: null },
  } as unknown as NormalizedRemoteMessage;
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: broken })));
  consoleError.mockRestore();
  expect(node.textContent).toBe('devices.companions.actionFailed');
});

it('reads, opens and stops the task on its source computer, then disables stop offline', async () => {
  await render();
  expect(h.invoke).toHaveBeenCalledWith('home', 'maker:bot-delegations:list', ['parent']);
  const button = (label: string) =>
    [...node.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => openEntry()!.click());
  expect(h.push).toHaveBeenCalledWith({
    pathname: '/sessions/[sessionId]',
    params: { deviceId: 'home', sessionId: 'child' },
  });
  await act(async () => button('devices.companions.stopTask').click());
  expect(h.invoke).toHaveBeenCalledWith('home', 'maker:bot-delegation:cancel', ['parent', 'job']);
  h.status = 'reconnecting';
  await render();
  expect(button('devices.companions.stopTask').disabled).toBe(true);
});
it('ignores another peer push and refreshes the actual task to completed', async () => {
  await render();
  vi.useFakeTimers();
  h.invoke.mockResolvedValue({
    ok: true,
    delegations: [
      {
        id: 'job',
        status: 'completed',
        title: 'Report',
        resultSummary: 'Report finished',
      },
    ],
  });
  await act(async () => {
    h.changed('office', 'maker:bot-delegation:changed', {
      parentSessionId: 'parent',
    });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(h.invoke.mock.calls.filter((c) => c[1] === 'maker:bot-delegations:list')).toHaveLength(1);
  await act(async () => {
    h.changed('home', 'maker:bot-delegation:changed', {
      parentSessionId: 'parent',
    });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(node.textContent).not.toContain('Report finished');
  expect(node.textContent).toContain('devices.companions.status.completed');
  expect(node.textContent).not.toContain('devices.companions.stopTask');
});
it('does not render an old account response after account and connection change', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  h.accountGeneration = 2;
  h.epoch = 2;
  h.status = 'offline';
  await render();
  await act(async () =>
    finish({
      ok: true,
      delegations: [{ id: 'job', title: 'Old private account', status: 'running' }],
    }),
  );
  expect(node.textContent).not.toContain('Old private account');
});

it('keeps the last successful task across a failed refresh and reconnection, but never another account', async () => {
  await render();
  h.status = 'offline';
  h.epoch += 1;
  await render();
  expect(node.textContent).toContain('devices.companions.status.running');
  expect(node.textContent).toContain('devices.companions.stale');
  h.invoke.mockRejectedValue(new Error('offline'));
  h.status = 'online';
  await render();
  expect(node.textContent).toContain('devices.companions.status.running');
  expect(node.textContent).toContain('devices.companions.stale');
  h.accountGeneration += 1;
  h.status = 'offline';
  await render();
  expect(node.textContent).not.toContain('devices.companions.status.running');
});
it('opens the child session associated PR and consumes its status without needing a report link', async () => {
  const ref = {
    id: 'pr3',
    sessionId: 'child',
    owner: 'a',
    repo: 'b',
    prNumber: 3,
    url: 'https://github.com/a/b/pull/3',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'git-context:pr-refs:list') return [ref];
    if (channel === 'git-context:pr-status') return [{ ...ref, ok: true, status: 'merged' }];
    return {
      ok: true,
      delegations: [
        {
          id: 'job',
          status: 'completed',
          title: 'Report',
          childSessionId: 'child',
          resultSummary: 'No PR URL here',
        },
      ],
    };
  });
  await render();
  expect(h.invoke).toHaveBeenCalledWith('home', 'git-context:pr-refs:list', ['child']);
  expect(h.invoke).toHaveBeenCalledWith('home', 'git-context:pr-status', [
    { sessionId: 'child', queries: [{ owner: 'a', repo: 'b', prNumber: 3 }] },
  ]);
  expect(node.querySelector('[data-testid="merged-pr"]')).not.toBeNull();
  const pr = [...node.querySelectorAll('button')].find(
    (b) => b.textContent === 'devices.companions.viewPr',
  )!;
  await act(async () => pr.click());
  expect(h.openURL).toHaveBeenCalledWith('https://github.com/a/b/pull/3');
});

it('does not derive PRs from task output and does not query a missing child', async () => {
  h.invoke.mockResolvedValue({
    ok: true,
    delegations: [
      {
        id: 'job',
        status: 'completed',
        resultSummary: 'https://github.com/a/b/pull/9',
      },
    ],
  });
  const withoutChild = {
    ...message,
    companion: {
      ...message.companion!,
      meta: { ...(message.companion as any).meta, childSessionId: null },
    },
  } as NormalizedRemoteMessage;
  await act(async () =>
    root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: withoutChild })),
  );
  expect(node.textContent).not.toContain('devices.companions.viewPr');
  expect(h.invoke.mock.calls.every((c) => c[1] === 'maker:bot-delegations:list')).toBe(true);
});

it('refreshes associated PR state only while mounted and never replays task actions', async () => {
  vi.useFakeTimers();
  const ref = {
    id: 'pr5',
    sessionId: 'child',
    owner: 'a',
    repo: 'b',
    prNumber: 5,
    url: 'https://github.com/a/b/pull/5',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  let status = 'open';
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'git-context:pr-refs:list') return [ref];
    if (channel === 'git-context:pr-status') return [{ ...ref, ok: true, status }];
    return { ok: true, delegations: [{ id: 'job', status: 'completed', childSessionId: 'child' }] };
  });
  await render();
  expect(node.querySelector('[data-testid="merged-pr"]')).toBeNull();
  status = 'merged';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(node.querySelector('[data-testid="merged-pr"]')).not.toBeNull();
  expect(
    h.invoke.mock.calls.every((c) =>
      ['maker:bot-delegations:list', 'local-db:sessions:get-many', 'git-context:pr-refs:list', 'git-context:pr-status'].includes(
        c[1],
      ),
    ),
  ).toBe(true);
  await act(async () => root.render(null));
  const reads = h.invoke.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(h.invoke).toHaveBeenCalledTimes(reads);
});

it('drops an old child PR response after switching to a different task', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'git-context:pr-refs:list')
      return await new Promise((resolve) => {
        finish = resolve;
      });
    return { ok: true, delegations: [] };
  });
  await render();
  h.invoke.mockImplementation(async (_device, channel) =>
    channel === 'git-context:pr-refs:list' ? [] : { ok: true, delegations: [] },
  );
  const other = {
    ...message,
    companion: {
      ...message.companion!,
      meta: { ...(message.companion as any).meta, childSessionId: 'other-child' },
    },
  } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: other })));
  await act(async () =>
    finish([{ id: 'old', sessionId: 'child', owner: 'private', repo: 'old', prNumber: 1 }]),
  );
  expect(node.textContent).not.toContain('private');
  expect(node.textContent).not.toContain('devices.companions.viewPr');
  expect(h.invoke).toHaveBeenCalledWith('home', 'git-context:pr-refs:list', ['other-child']);
});

it('rechecks an in-flight empty PR list when the same task completes', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  let reads = 0;
  let completed = false;
  const ref = {
    id: 'new-pr',
    sessionId: 'child',
    owner: 'a',
    repo: 'b',
    prNumber: 7,
    url: 'https://github.com/a/b/pull/7',
    firstSeenAt: 1,
    lastSeenAt: 2,
  };
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'git-context:pr-refs:list') {
      reads += 1;
      if (reads === 1)
        return await new Promise((resolve) => {
          finish = resolve;
        });
      return [ref];
    }
    if (channel === 'git-context:pr-status') return [{ ...ref, ok: true, status: 'open' }];
    return {
      ok: true,
      delegations: [
        {
          id: 'job',
          childSessionId: 'child',
          status: completed ? 'completed' : 'running',
          updatedAt: completed ? 2 : 1,
        },
      ],
    };
  });
  await render();
  expect(reads).toBe(1);
  completed = true;
  await act(async () => {
    h.changed('home', 'maker:bot-delegation:changed', { parentSessionId: 'parent' });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(reads).toBe(1);
  await act(async () => finish([]));
  expect(reads).toBe(2);
  const pr = [...node.querySelectorAll('button')].find(
    (b) => b.textContent === 'devices.companions.viewPr',
  );
  expect(pr).toBeTruthy();
  await act(async () => pr!.click());
  expect(h.openURL).toHaveBeenCalledWith(ref.url);
});

it('keeps the last successful PR icon during an element failure and clears stale on recovery', async () => {
  vi.useFakeTimers();
  const ref = {
    id: 'pr',
    sessionId: 'child',
    owner: 'a',
    repo: 'b',
    prNumber: 7,
    url: 'https://github.com/a/b/pull/7',
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
  let result: any = { ...ref, ok: true, status: 'merged' };
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'git-context:pr-refs:list') return [ref];
    if (channel === 'git-context:pr-status') return [result];
    return {
      ok: true,
      delegations: [{ id: 'job', childSessionId: 'child', status: 'completed', updatedAt: 1 }],
    };
  });
  await render();
  expect(node.querySelector('[data-testid="merged-pr"]')).not.toBeNull();
  for (const reason of ['fetch-failed', 'no-token']) {
    result = { ...ref, ok: false, reason };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(node.querySelector('[data-testid="merged-pr"]')).not.toBeNull();
    expect(node.textContent).toContain('devices.companions.stale');
  }
  for (const reason of ['not-found', 'fetch-failed', 'no-token']) {
    result = { ...ref, ok: false, reason };
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(node.querySelector('[data-testid="merged-pr"]')).toBeNull();
  }
  result = { ...ref, ok: true, status: 'merged' };
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
  expect(node.querySelector('[data-testid="merged-pr"]')).not.toBeNull();
  result = { ...ref, ok: true, status: 'open' };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(node.querySelector('[data-testid="merged-pr"]')).toBeNull();
  expect(node.textContent).not.toContain('devices.companions.stale');
});

it('limits the PR menu and status queries to the same three references as the task header', async () => {
  const refs = [1, 2, 3, 4, 5].map((prNumber) => ({
    id: String(prNumber), sessionId: 'child', owner: 'a', repo: 'b', prNumber,
    url: `https://github.com/a/b/pull/${prNumber}`, firstSeenAt: 1, lastSeenAt: 1,
  }));
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'git-context:pr-refs:list') return refs;
    if (channel === 'git-context:pr-status') return refs.slice(0, 3).map((ref) => ({ ...ref, ok: true, status: 'merged' }));
    return { ok: true, delegations: [{ id: 'job', status: 'completed', title: 'Report', childSessionId: 'child' }] };
  });
  await render();
  const pr = [...node.querySelectorAll('button')].find((b) => b.textContent === 'devices.companions.viewPr')!;
  await act(async () => pr.click());
  const choices = [...node.querySelectorAll('button')].filter((b) => b.textContent?.includes('a/b #'));
  expect(choices.map((b) => b.textContent)).toEqual(['a/b #1', 'a/b #2', 'a/b #3']);
  expect(h.invoke).toHaveBeenCalledWith('home', 'git-context:pr-status', [
    { sessionId: 'child', queries: refs.slice(0, 3).map(({ owner, repo, prNumber }) => ({ owner, repo, prNumber })) },
  ]);
  await act(async () => choices[2].click());
  expect(h.openURL).toHaveBeenCalledWith('https://github.com/a/b/pull/3');
});

it('shows only delivery status even when a legacy task trace contains full instructions', async () => {
  const trace = {
    ...message,
    body: '读取 /workspace/project/AGENTS.md 并核对执行授权。',
    companion: { kind: 'task', meta: { ...message.companion!.meta, role: 'interjection' } },
  } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: trace })));
  expect(node.textContent).toBe('devices.companions.messageSent');
  expect(h.invoke).not.toHaveBeenCalled();
});

it('opens a stable completed result inline and routes its artifact to the child task', async () => {
  h.invoke.mockImplementation(async (_device, channel) => channel === 'fs:stat-path'
    ? { kind: 'file', resolvedPath: '/reports/result.pdf' } : { ok: true });
  const resultMessage = {
    ...message,
    key: 'receipt-2',
    companion: { kind: 'task', meta: { ...message.companion!.meta,
      role: 'delegation-result', result: { runSequence: 2, status: 'completed', text: 'Second execution result', artifacts: [{ absolutePath: '/reports/result.pdf' }] },
    } },
  } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: resultMessage })));
  // Collapsed: a short preview only; the files come with the full result.
  const fileButton = () => [...node.querySelectorAll('button')].find(button => button.textContent === 'result.pdf');
  expect(node.textContent).toContain('Second execution result');
  expect(fileButton()).toBeUndefined();
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="companion.taskResult.toggle"]')!.click());
  expect(fileButton()).toBeDefined();
  const file = [...node.querySelectorAll('button')].find(button => button.textContent === 'result.pdf')!;
  await act(async () => file.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/preview/[sessionId]', params: { sessionId: 'child', deviceId: 'home', absPath: '/reports/result.pdf' } });
  expect(h.invoke).not.toHaveBeenCalledWith('home', 'maker:bot-delegations-list', expect.anything());
});

it('renders the frozen result with the conversation Markdown, resolving links in the child task', async () => {
  h.invoke.mockImplementation(async (_device, channel, args) => channel === 'fs:stat-path'
    ? { kind: 'file', resolvedPath: args[0].path } : { ok: true });
  const { CompanionTaskResultCard } = await import('@/session/CompanionTaskResultCard');
  const { ChatFilePathContext } = await import('@/session/chatFilePathContext');
  const seen: any[] = [];
  function MarkdownProbe({ text }: { text: string }) {
    const { useContext } = require('react') as typeof import('react');
    const ctx = useContext(ChatFilePathContext);
    seen.push(ctx);
    const sender = useSessionQuickSend();
    return createElement('article', { 'data-testid': 'result-markdown' }, text,
      createElement('button', { 'data-testid': 'preview-send', disabled: !sender, onClick: () => sender?.('child reply') }));
  }
  const meta = { ...message.companion!.meta, role: 'delegation-result', childSessionId: 'child',
    result: { runSequence: 1, status: 'completed', workingDir: '/child-task',
      text: '![chart](./chart.png) [Report](https://example.com/report.pdf)', artifacts: [] } } as any;
  // The chat's long-press menu is reused, but every action must target the child task.
  const onLongPressPath = vi.fn();
  const parent = { deviceId: 'home', sessionId: 'chat', workdir: '/chat', statPath: vi.fn(), onOpenPath: vi.fn(), onLongPressPath };
  // PR #6871 regression: a writable parent must not lend sending to child previews.
  // Tier 1; the existing production result-card test covered file context only.
  const send = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(createElement(SessionQuickSendProvider, { value: send },
    createElement(ChatFilePathContext.Provider, { value: parent },
      createElement(CompanionTaskResultCard, {
        meta, deviceId: 'home', renderMarkdown: (text: string) => createElement(MarkdownProbe, { text }),
      })))));
  // Collapsed: status + view result only; the body is not rendered until opened.
  expect(node.querySelector('[data-testid="result-markdown"]')).toBeNull();
  await act(async () => node.querySelector('button')!.click());
  expect(node.querySelector('[data-testid="result-markdown"]')?.textContent)
    .toBe('![chart](./chart.png) [Report](https://example.com/report.pdf)');
  const previewSend = node.querySelector<HTMLButtonElement>('[data-testid="preview-send"]')!;
  expect(previewSend.disabled).toBe(true);
  await act(async () => previewSend.click());
  expect(send).not.toHaveBeenCalled();
  // No second, duplicated link list below the Markdown (Desktop MarkdownRenderer parity).
  expect([...node.querySelectorAll('button')].some(button => ['chart', 'Report'].includes(button.textContent ?? ''))).toBe(false);
  const ctx = seen.at(-1);
  expect(ctx).toMatchObject({ deviceId: 'home', sessionId: 'child', workdir: '/child-task' });
  await expect(ctx.statPath('/child-task/chart.png')).resolves.toMatchObject({ kind: 'file' });
  expect(h.openLink).toHaveBeenCalledWith('home');
  ctx.onOpenPath({ kind: 'file', relPath: 'chart.png', absPath: '/child-task/chart.png', line: 3 });
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/preview/[sessionId]', params: {
    sessionId: 'child', deviceId: 'home', relPath: 'chart.png', line: '3',
  } });
  ctx.onOpenPath({ kind: 'directory', relPath: 'out', absPath: '/child-task/out' });
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/[sessionId]', params: {
    sessionId: 'child', deviceId: 'home', relPath: 'out',
  } });
  ctx.onLongPressPath({ kind: 'file', relPath: 'chart.png', absPath: '/child-task/chart.png' });
  expect(onLongPressPath).toHaveBeenCalledWith({ kind: 'file', relPath: 'chart.png', absPath: '/child-task/chart.png',
    scope: { sessionId: 'child', workdir: '/child-task' } });
  expect(parent.onOpenPath).not.toHaveBeenCalled();
});

it('does not offer an artifact file until the child file is verified', async () => {
  let completeStat!: (result: { kind: 'file'; resolvedPath: string }) => void;
  h.invoke.mockImplementation(async (_device, channel) => channel === 'fs:stat-path'
    ? new Promise((resolve) => { completeStat = resolve; }) : { ok: true });
  const { CompanionTaskResultCard } = await import('@/session/CompanionTaskResultCard');
  const meta = { ...message.companion!.meta, role: 'delegation-result', childSessionId: 'child',
    result: { runSequence: 1, status: 'completed', workingDir: '/child-task',
      text: '', artifacts: [{ absolutePath: '/child-task/chart.png' }] } } as any;
  await act(async () => root.render(createElement(CompanionTaskResultCard, { meta, deviceId: 'home' })));
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('devices.companions.noWrittenResult');
  expect(node.textContent).toContain('chart.png');
  expect([...node.querySelectorAll('button')].some(button => button.textContent === 'chart.png')).toBe(false);
  await act(async () => completeStat({ kind: 'file', resolvedPath: '/child-task/chart.png' }));
  const chart = [...node.querySelectorAll('button')].find(button => button.textContent === 'chart.png')!;
  await act(async () => chart.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/preview/[sessionId]', params: {
    sessionId: 'child', deviceId: 'home', absPath: '/child-task/chart.png',
  } });
});

it('keeps missing and offline result files readable without dead preview actions', async () => {
  h.invoke.mockImplementation(async (_device, channel, args) => {
    if (channel !== 'fs:stat-path') return { ok: true };
    if (args[0].path.endsWith('offline.png')) throw new Error('offline');
    return { kind: 'missing', resolvedPath: args[0].path };
  });
  const { CompanionTaskResultCard } = await import('@/session/CompanionTaskResultCard');
  const meta = { ...message.companion!.meta, role: 'delegation-result', childSessionId: 'child',
    result: { runSequence: 1, status: 'completed', workingDir: '/child-task',
      text: '[Missing](./missing.png) [Offline](./offline.png)',
      artifacts: [{ absolutePath: '/child-task/gone.pdf' }] } } as any;
  await act(async () => root.render(createElement(CompanionTaskResultCard, { meta, deviceId: 'home' })));
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Missing');
  expect(node.textContent).toContain('Offline');
  expect(node.textContent).toContain('gone.pdf');
  expect([...node.querySelectorAll('button')].some(button => ['Missing', 'Offline', 'gone.pdf'].includes(button.textContent ?? ''))).toBe(false);
  expect(h.push).not.toHaveBeenCalled();
});

it('reveals frozen failure details only after opening the result and its details', async () => {
  const { CompanionTaskResultCard } = await import('@/session/CompanionTaskResultCard');
  const meta = { result: { status: 'timed-out', text: '', error: 'TIMEOUT: upstream did not finish', artifacts: [] }, objective: 'Report' } as any;
  await act(async () => root.render(createElement(CompanionTaskResultCard, { meta, deviceId: 'home' })));
  expect(node.textContent).toContain('devices.companions.status.timed-out');
  expect(node.textContent).not.toContain('TIMEOUT:');
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).not.toContain('TIMEOUT:');
  const details = Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'devices.companions.errorDetails');
  await act(async () => details!.click());
  expect(node.textContent).toContain('TIMEOUT: upstream did not finish');
});

it.each(['sent', 'received'] as const)('keeps a compact %s private-message entry without leaking its body', async (direction) => {
  const direct = { ...message, key: 'trace', companion: { kind: 'direct', meta: {
    direction, peerBotName: 'Aster', peerBotId: 'peer', viewerBotId: 'viewer', threadId: 'thread',
    preview: 'Synthetic private transport body',
  } } } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: direct })));
  expect(node.textContent).toContain(`devices.companions.${direction === 'sent' ? 'sentTo' : 'receivedFrom'}`);
  expect(node.textContent).not.toContain('Synthetic private transport body');
  await act(async () => node.querySelector('button')!.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/companions/direct/[threadId]', params: {
    deviceId: 'home', threadId: 'thread', botId: 'viewer',
  } });
});

it('shows the starting state until the first read settles, then the background-task title fallback', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const untitled = { ...message, companion: { kind: 'task', meta: { ...message.companion!.meta, objective: '  ' } } } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: untitled })));
  expect(node.textContent).toContain('devices.companions.status.queued');
  expect(node.textContent).not.toContain('devices.companions.status.unknown');
  expect(node.textContent).toContain('devices.companions.backgroundTask');
  // A settled read without this task is unverifiable, not still starting.
  await act(async () => finish({ ok: true, delegations: [] }));
  expect(node.textContent).toContain('devices.companions.status.unknown');
});

it('does not claim an unread task is starting while its computer is offline', async () => {
  h.status = 'offline';
  await render();
  expect(h.invoke).not.toHaveBeenCalledWith('home', 'maker:bot-delegations:list', expect.anything());
  expect(node.textContent).toContain('devices.companions.status.unknown');
  expect(node.textContent).not.toContain('devices.companions.status.queued');
});

it('shows the peer portrait and current name from the cached roster in the private-message entry', async () => {
  const cache = await import('@/device-link/remoteResourceCache');
  await cache.cacheRemoteResourceItems('owner', 'teammates', [{ key: 'k', host: { deviceId: 'home', deviceName: 'Mac' },
    item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'peer' }, revision: '1', links: [],
      display: { title: 'Aster Renamed', avatar: { kind: 'text', value: '', fallbackText: 'A' } } } } as any]);
  const direct = { ...message, key: 'trace-peer', companion: { kind: 'direct', meta: {
    direction: 'sent', peerBotName: 'Aster', peerBotId: 'peer', viewerBotId: 'viewer', threadId: 'thread', preview: '',
  } } } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: direct })));
  expect(node.querySelector('[data-testid="peer-avatar"]')?.textContent).toBe('Aster Renamed');
  await act(async () => cache.clearRemoteResourceCache());
});

it.each([false, true])('uses the %s receipt title source without replacing frozen results with live state', async (frozen) => {
  const receipt = { ...message, companion: { kind: 'task', meta: { ...message.companion!.meta,
    role: 'delegation-result', objective: 'Full execution instructions',
    result: { ...(frozen ? { title: 'Original title' } : {}), runSequence: 1, status: 'completed',
      text: 'Original result', artifacts: [] },
  } } } as NormalizedRemoteMessage;
  h.invoke.mockResolvedValue({ ok: true, delegations: [{ id: 'job', title: 'Known task title', status: 'running', resultSummary: 'New output' }] });
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: receipt })));
  expect(node.textContent).toContain(frozen ? 'Original title' : 'Known task title');
  expect(node.textContent).not.toContain('Full execution instructions');
  expect(node.textContent).toContain('devices.companions.status.completed');
  expect(node.textContent).not.toContain('devices.companions.status.running');
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Original result');
  expect(node.textContent).not.toContain('New output');
  if (frozen) expect(h.invoke).not.toHaveBeenCalled();
});

it('keeps legacy results available when their task cannot be read', async () => {
  const receipt = { ...message, companion: { kind: 'task', meta: { ...message.companion!.meta,
    role: 'delegation-result', objective: 'First line\nOther instructions',
    result: { runSequence: 1, status: 'failed', text: 'Saved result', artifacts: [] },
  } } } as NormalizedRemoteMessage;
  h.invoke.mockRejectedValue(new Error('offline'));
  await act(async () => root.render(createElement(CompanionMessageCard, { deviceId: 'home', message: receipt })));
  expect(node.textContent).toContain('First line');
  expect(node.textContent).not.toContain('Other instructions');
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Saved result');
});
