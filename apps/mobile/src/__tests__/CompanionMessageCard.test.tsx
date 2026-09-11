// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  push: vi.fn(),
  openURL: vi.fn(),
  changed: null as any,
  status: 'online',
  accountGeneration: 1,
  epoch: 1,
  listeners: new Set<any>(),
}));
vi.mock('react-native', () => ({
  Linking: { openURL: h.openURL },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove() {} }),
  },
  View: ({ children }: any) => createElement('div', {}, children),
  Pressable: ({ children, onPress, disabled }: any) =>
    createElement(
      'button',
      { onClick: onPress, disabled },
      typeof children === 'function' ? children({ pressed: false }) : children,
    ),
  StyleSheet: { create: (v: any) => v, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => useEffect(cb, [cb]),
  useLocalSearchParams: () => ({ deviceId: 'home' }),
  useRouter: () => ({ push: h.push }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => createElement('span', {}, children),
}));
vi.mock('@/theme', () => ({
  useThemedStyles: () => ({}),
  useTheme: () => ({ colors: {} }),
}));
vi.mock('lucide-react-native', () => ({
  FileText: () => null,
  GitPullRequest: () => null,
  Square: () => null,
  GitMerge: () => createElement('i', { 'data-testid': 'merged-pr' }),
  GitPullRequestClosed: () => null,
  GitPullRequestDraft: () => null,
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ accountGeneration: h.accountGeneration }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({
    invoke: h.invoke,
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
import { CompanionMessageCard } from '@/session/CompanionMessageCard';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
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
  await act(async () => root.render(createElement(CompanionMessageCard, { message })));
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
  h.invoke.mockReset();
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
  node.remove();
  vi.useRealTimers();
});
it('reads, opens and stops the task on its source computer, then disables stop offline', async () => {
  await render();
  expect(h.invoke).toHaveBeenCalledWith('home', 'maker:bot-delegations:list', ['parent']);
  const button = (label: string) =>
    [...node.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button('devices.companions.openTask').click());
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
    root.render(createElement(CompanionMessageCard, { message: withoutChild })),
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
      ['maker:bot-delegations:list', 'git-context:pr-refs:list', 'git-context:pr-status'].includes(
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
  await act(async () => root.render(createElement(CompanionMessageCard, { message: other })));
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
