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
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => createElement('span', {}, children),
}));
vi.mock('@/theme', () => ({
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
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ accountGeneration: h.accountGeneration }),
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
import { CompanionMessageCard } from '@/session/CompanionMessageCard';
import { _clearRemotePathVerdictCache } from '@/session/remotePathVerdict';
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
it('survives recycled layout events when measuring equal-width task actions', async () => {
  await render();
  expect(node.textContent).toContain('devices.companions.openTask');
  expect(node.textContent).toContain('devices.companions.stopTask');
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
  expect(node.textContent).toContain('devices.companions.openTask');
});

it('isolates a broken private-chat card so the session can keep rendering', async () => {
  const broken = {
    ...message,
    key: 'broken-direct',
    companion: { kind: 'direct', meta: null },
  } as unknown as NormalizedRemoteMessage;
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => root.render(createElement(CompanionMessageCard, { message: broken })));
  consoleError.mockRestore();
  expect(node.textContent).toBe('devices.companions.actionFailed');
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
  await act(async () => root.render(createElement(CompanionMessageCard, { message: trace })));
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
  await act(async () => root.render(createElement(CompanionMessageCard, { message: resultMessage })));
  expect(node.textContent).not.toContain('Second execution result');
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Second execution result');
  const file = [...node.querySelectorAll('button')].find(button => button.textContent === 'result.pdf')!;
  await act(async () => file.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/preview/[sessionId]', params: { sessionId: 'child', deviceId: 'home', absPath: '/reports/result.pdf' } });
  expect(h.invoke).not.toHaveBeenCalledWith('home', 'maker:bot-delegations-list', expect.anything());
});

it('keeps image-only and linked results available from the mobile receipt', async () => {
  h.invoke.mockImplementation(async (_device, channel) => channel === 'fs:stat-path'
    ? { kind: 'file', resolvedPath: '/child-task/chart.png' } : { ok: true });
  const { CompanionTaskResultCard } = await import('@/session/CompanionTaskResultCard');
  const meta = { ...message.companion!.meta, role: 'delegation-result', childSessionId: 'child',
    result: { runSequence: 1, status: 'completed', workingDir: '/child-task',
      text: '![chart](./chart.png) [Report](https://example.com/report.pdf)', artifacts: [] } } as any;
  await act(async () => root.render(createElement(CompanionTaskResultCard, { meta, deviceId: 'home' })));
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('![chart](./chart.png)');
  expect(node.textContent).not.toContain('devices.companions.noWrittenResult');
  const chart = [...node.querySelectorAll('button')].find(button => button.textContent === 'chart')!;
  await act(async () => chart.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/preview/[sessionId]', params: {
    sessionId: 'child', deviceId: 'home', absPath: '/child-task/./chart.png',
  } });
  const report = [...node.querySelectorAll('button')].find(button => button.textContent === 'Report')!;
  await act(async () => report.click());
  expect(h.openURL).toHaveBeenCalledWith('https://example.com/report.pdf');
});

it('does not offer a local result link until the child file is verified', async () => {
  let completeStat!: (result: { kind: 'file'; resolvedPath: string }) => void;
  h.invoke.mockImplementation(async (_device, channel) => channel === 'fs:stat-path'
    ? new Promise((resolve) => { completeStat = resolve; }) : { ok: true });
  const { CompanionTaskResultCard } = await import('@/session/CompanionTaskResultCard');
  const meta = { ...message.companion!.meta, role: 'delegation-result', childSessionId: 'child',
    result: { runSequence: 1, status: 'completed', workingDir: '/child-task',
      text: '[Chart](./chart.png)', artifacts: [] } } as any;
  await act(async () => root.render(createElement(CompanionTaskResultCard, { meta, deviceId: 'home' })));
  await act(async () => node.querySelector('button')!.click());
  expect(node.textContent).toContain('Chart');
  expect([...node.querySelectorAll('button')].some(button => button.textContent === 'Chart')).toBe(false);
  await act(async () => completeStat({ kind: 'file', resolvedPath: '/child-task/chart.png' }));
  const chart = [...node.querySelectorAll('button')].find(button => button.textContent === 'Chart')!;
  await act(async () => chart.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/files/preview/[sessionId]', params: {
    sessionId: 'child', deviceId: 'home', absPath: '/child-task/./chart.png',
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
  const details = Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'interaction.companion.details');
  await act(async () => details!.click());
  expect(node.textContent).toContain('TIMEOUT: upstream did not finish');
});

it.each(['sent', 'received'] as const)('keeps a compact %s private-message entry without leaking its body', async (direction) => {
  const direct = { ...message, key: 'trace', companion: { kind: 'direct', meta: {
    direction, peerBotName: 'Aster', peerBotId: 'peer', viewerBotId: 'viewer', threadId: 'thread',
    preview: 'Synthetic private transport body',
  } } } as NormalizedRemoteMessage;
  await act(async () => root.render(createElement(CompanionMessageCard, { message: direct })));
  expect(node.textContent).toContain(`devices.companions.${direction === 'sent' ? 'sentTo' : 'receivedFrom'}`);
  expect(node.textContent).not.toContain('Synthetic private transport body');
  await act(async () => node.querySelector('button')!.click());
  expect(h.push).toHaveBeenCalledWith({ pathname: '/companions/direct/[threadId]', params: {
    deviceId: 'home', threadId: 'thread', botId: 'viewer',
  } });
});
