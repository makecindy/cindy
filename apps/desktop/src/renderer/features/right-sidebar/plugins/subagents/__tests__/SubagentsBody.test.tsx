// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SubagentRunDetail,
  SubagentRunsChangedPayload,
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The stubs record `allowPrivilegedLinks` so the remote boundary can be asserted
// where it has to arrive. They default it to `true` exactly as the real
// components do, so "not passed" is indistinguishable from "passed true" —
// which is the failure being guarded against.
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, allowPrivilegedLinks = true }: {
    content: string; allowPrivilegedLinks?: boolean;
  }) => (
    <div data-testid="legacy-markdown-result" data-privileged={String(allowPrivilegedLinks)}>
      {content}
    </div>
  ),
}));

vi.mock('@/components/chat/UserMessage', () => ({
  UserMessage: ({ content, allowPrivilegedLinks = true }: {
    content: string; allowPrivilegedLinks?: boolean;
  }) => (
    <div data-testid="session-user-message" data-privileged={String(allowPrivilegedLinks)}>
      {content}
    </div>
  ),
}));

vi.mock('@/components/chat/AssistantMessage', () => ({
  AssistantMessage: ({ content, allowPrivilegedLinks = true }: {
    content: string; allowPrivilegedLinks?: boolean;
  }) => (
    <div data-testid="session-assistant-message" data-privileged={String(allowPrivilegedLinks)}>
      {content}
    </div>
  ),
}));

import { SubagentsBody } from '../SubagentsBody';

const OWNER_STAMP = { dataOwnerId: 'owner-1', ownerGeneration: 1 };

function detail(summary: string): SubagentRunDetail {
  return {
    id: 'run-1',
    parentSessionId: 'session-1',
    provider: 'pi',
    logicalAgentId: 'task-1',
    parentToolUseId: 'task-1',
    identityAliases: ['task-1'],
    providerRunIds: [],
    status: 'running',
    title: 'Research task',
    summary,
    capabilities: {
      viewActivity: false,
      viewReturnedResult: false,
      viewFullTranscript: false,
      resume: false,
      steer: false,
      stop: false,
      parentContext: 'unknown',
    },
    activity: [],
    startedAt: 100,
    updatedAt: 200,
  };
}

let entrySequence = 0;
function entry(
  overrides: Partial<SubagentTranscriptEntry> & { id: string },
): SubagentTranscriptEntry {
  entrySequence += 1;
  return {
    sequence: entrySequence,
    role: 'subagent',
    content: '',
    occurredAt: 1_700_000_000_000 + entrySequence,
    ...overrides,
  };
}

describe('SubagentsBody', () => {
  let onChanged: (payload: SubagentRunsChangedPayload, ownerStamp?: unknown) => void = () =>
    undefined;
  let currentDetail: SubagentRunDetail | null = detail('initial progress');
  const list = vi.fn(async () => ({
    supported: true,
    runs: currentDetail ? [currentDetail] : [],
  }));
  const loadDetail = vi.fn(async () => ({
    supported: true,
    run: currentDetail,
  }));
  const stopAgentTask = vi.fn(async () => ({ ok: true as const }));
  const controlPiSubagent = vi.fn(async () => ({ ok: true, controlled: 1 }));
  const defaultDeviceInvoke = async (_deviceId: string, channel: string) => {
    if (channel === 'local-db:subagent-runs:list') {
      return { supported: true, runs: currentDetail ? [currentDetail] : [] };
    }
    if (channel === 'local-db:subagent-runs:detail') {
      return { supported: true, run: currentDetail };
    }
    return { supported: false, run: null, entries: [] };
  };
  const deviceInvoke = vi.fn(defaultDeviceInvoke);
  const loadTranscript = vi.fn(async (): Promise<SubagentTranscriptPageResponse> => ({
    supported: false,
    entries: [],
  }));

  beforeEach(() => {
    dataOwnerTesting.reset();
    setDataOwnerGeneration('owner-1', 1);
    currentDetail = detail('initial progress');
    list.mockClear();
    loadDetail.mockClear();
    stopAgentTask.mockClear();
    controlPiSubagent.mockClear();
    // mockClear keeps implementations, so a persistent mockResolvedValue would
    // leak across tests. Reset and re-establish the default instead, which lets
    // a test model "every read returns this page" without relying on exactly one
    // read happening.
    loadTranscript.mockReset();
    loadTranscript.mockResolvedValue({ supported: false, entries: [] });
    // Same reason as loadTranscript: mockClear keeps implementations, so a test
    // that models a slow or failing link would leak into the next one.
    deviceInvoke.mockReset();
    deviceInvoke.mockImplementation(defaultDeviceInvoke);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: { stopAgentTask, controlPiSubagent },
        deviceLink: { invoke: deviceInvoke },
        localDb: {
          subagentRuns: {
            list,
            detail: loadDetail,
            transcript: loadTranscript,
            onChanged: vi.fn((listener) => {
              onChanged = listener;
              return () => undefined;
            }),
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    dataOwnerTesting.reset();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('polls a local run to completion when no change push ever arrives', async () => {
    // The local view is push-driven, and the push dies with the root Pi
    // process: `onExit` ends its event queue, so a detached run that finishes
    // afterwards emits no `agent_task_update` and no change push. The row sat at
    // `running` until the panel was remounted.
    vi.useFakeTimers();
    try {
      currentDetail = { ...detail('still working'), status: 'running' };
      render(
        <SubagentsBody
          state={{ selectedRunId: null, selectedProvider: null }}
          ctx={{
            tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
            remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
            onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
          }}
        />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const readsAfterMount = list.mock.calls.length;
      expect(readsAfterMount).toBeGreaterThan(0);

      // The run finishes with nobody left to announce it.
      currentDetail = { ...detail('done'), status: 'completed' };
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(list.mock.calls.length).toBeGreaterThan(readsAfterMount);

      // And once nothing is unfinished the polling stops: no further reads.
      const readsAfterSettle = list.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(list.mock.calls.length).toBe(readsAfterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the transcript from the fallback poll, not just the detail', async () => {
    // Same silence as the test above: the root Pi is gone, so nothing pushes.
    // The poll refreshed the detail record only, which left the conversation
    // frozen on the page read before the exit — every later tool call and reply
    // the runner wrote was unreachable until the panel was remounted.
    vi.useFakeTimers();
    try {
      const running = {
        ...detail('working'),
        status: 'running' as const,
        capabilities: {
          ...detail('working').capabilities,
          viewFullTranscript: true,
          viewReturnedResult: true,
        },
      };
      currentDetail = running;
      loadTranscript.mockResolvedValue({
        supported: true,
        entries: [entry({ id: 'entry-early', content: 'first generation answer' })],
        tailCursor: 'cursor-1',
      });
      render(
        <SubagentsBody
          state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
          ctx={{
            tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
            remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
            onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
          }}
        />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('first generation answer')).toBeTruthy();

      // The runner keeps working and finishes, with nobody to announce it.
      currentDetail = { ...running, status: 'completed', returnedResult: 'second generation answer' };
      loadTranscript.mockResolvedValue({
        supported: true,
        entries: [
          entry({
            id: 'entry-late-tool', role: 'tool', toolPhase: 'start',
            toolName: 'read', content: 'read b.txt',
          }),
          entry({ id: 'entry-late', content: 'second generation answer' }),
        ],
        tailCursor: 'cursor-2',
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

      expect(screen.getByText('read b.txt')).toBeTruthy();
      expect(screen.getByText('second generation answer')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the remote boundary into the Pi conversation and its fallbacks', async () => {
    // `allowPrivilegedLinks` is false for a device-link task, and the Pi detail
    // renders through the same session components the main chat uses — which
    // trust their content by default. Dropping the flag here let a remote
    // transcript's `file:` target or Cindy deep link open a resource on the
    // *control* machine, and made an @-chip resolve the remote author's path
    // against this filesystem.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      description: 'the original assignment',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'durable result from the other machine',
    };
    deviceInvoke.mockImplementation((async (_deviceId: string, channel: string) => {
      if (channel === 'local-db:subagent-runs:list') {
        return { supported: true, runs: currentDetail ? [currentDetail] : [] };
      }
      if (channel === 'local-db:subagent-runs:detail') return { supported: true, run: currentDetail };
      if (channel === 'local-db:subagent-runs:transcript') {
        return {
          supported: true,
          entries: [entry({ id: 'entry-parent', role: 'parent', content: 'remote assignment' })],
          tailCursor: 'cursor-remote',
        };
      }
      return { supported: false, run: null, entries: [] };
    }) as typeof defaultDeviceInvoke);
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/remote/workspace',
          remoteHostId: null, deviceLinkDeviceId: 'device-1', patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // Both entry points: a transcript bubble, and the durable-result fallback.
    expect(await screen.findByText('remote assignment')).toBeTruthy();
    expect(await screen.findByText('durable result from the other machine')).toBeTruthy();
    for (const node of [
      ...screen.getAllByTestId('session-user-message'),
      ...screen.getAllByTestId('session-assistant-message'),
    ]) {
      expect(node.getAttribute('data-privileged')).toBe('false');
    }
  });

  it('leaves a local Pi task fully privileged', async () => {
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'local durable result',
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [entry({ id: 'entry-parent', role: 'parent', content: 'local assignment' })],
      tailCursor: 'cursor-local',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('local assignment')).toBeTruthy();
    expect(await screen.findByText('local durable result')).toBeTruthy();
    for (const node of [
      ...screen.getAllByTestId('session-user-message'),
      ...screen.getAllByTestId('session-assistant-message'),
    ]) {
      expect(node.getAttribute('data-privileged')).toBe('true');
    }
  });

  it('has the session bubbles honour the boundary they are handed', () => {
    // The two tests above stop at the component seam, because the stubs replace
    // exactly the components that would carry the flag further. Asserted on the
    // source instead — same approach as `markdownTargetRendererContract` — so
    // the panel's boundary cannot be silently dropped one level down.
    const chatDir = path.resolve(__dirname, '../../../../../components/chat');
    const assistant = readFileSync(path.join(chatDir, 'AssistantMessage.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    // Defaulting to true is what keeps every local caller unchanged, and is
    // also what made the omission invisible.
    expect(assistant).toContain('allowPrivilegedLinks = true');
    // Both bodies: the streamed one and the settled one.
    expect([...assistant.matchAll(/allowPrivilegedLinks=\{allowPrivilegedLinks\}/g)].length)
      .toBeGreaterThanOrEqual(3);

    const user = readFileSync(path.join(chatDir, 'UserMessage.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(user).toContain('allowPrivilegedLinks = true');
    // A remote author's @-chip must not resolve against this filesystem: the
    // click handler is withheld, which is the inert chip shape the component
    // already uses for a collapsed long message.
    expect(user).toContain('longMessageCollapsed || !allowPrivilegedLinks');
    expect(user).toContain('allowPrivilegedLinks\n                                ? async (abs, name, chip)');
  });

  it('reloads the selected detail when a run change is pushed', async () => {
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1',
          sessionId: 'session-1',
          workdir: '/workspace',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          patchState: vi.fn(),
          onVisibilityChange: vi.fn(),
          setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    await screen.findByText('initial progress');
    const detailCallsBeforePush = loadDetail.mock.calls.length;
    currentDetail = detail('finished result');

    act(() => {
      onChanged(
        {
          sessionId: 'session-1',
          runId: 'run-1',
          created: false,
          firstForSession: false,
        },
        OWNER_STAMP,
      );
    });

    await screen.findByText('finished result');
    await waitFor(() => {
      expect(loadDetail.mock.calls.length).toBeGreaterThan(detailCallsBeforePush);
    });
  });

  it('reads durable runs from the data-owning device for a sticky remote task', async () => {
    render(
      <SubagentsBody
        state={{}}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: 'device-1', patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('Research task')).toBeTruthy();
    expect(deviceInvoke).toHaveBeenCalledWith(
      'device-1',
      'local-db:subagent-runs:list',
      [{ sessionId: 'session-1' }],
    );
  });

  it('never overlaps remote poll rounds while a device-link read is slow', async () => {
    // deviceLink.invoke defaults to ~30s and the breaker only trips after that,
    // so an unfenced 1s interval could stack ~90 in-flight invokes before the
    // first failure — starving the reliable-transport queue the user's own
    // stop/steer controls share.
    let releaseList: (() => void) | undefined;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    let listCalls = 0;
    deviceInvoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'local-db:subagent-runs:list') {
        listCalls += 1;
        await listGate;
        return { supported: true, runs: currentDetail ? [currentDetail] : [] };
      }
      if (channel === 'local-db:subagent-runs:detail') return { supported: true, run: currentDetail };
      return { supported: false, run: null, entries: [] };
    });

    render(
      <SubagentsBody
        state={{}}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: 'device-1', patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    await waitFor(() => expect(listCalls).toBe(1));
    // Several poll periods elapse while the first read is still outstanding.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(listCalls).toBe(1);

    releaseList!();
    // The chain resumes once the slow round settles.
    await waitFor(() => expect(listCalls).toBeGreaterThan(1), { timeout: 5_000 });
  }, 15_000);

  it('keeps polling after a failed remote round and stops once unmounted', async () => {
    let listCalls = 0;
    deviceInvoke.mockImplementation(async (_deviceId: string, channel: string) => {
      if (channel === 'local-db:subagent-runs:list') {
        listCalls += 1;
        throw new Error('device-link unavailable');
      }
      return { supported: false, run: null, entries: [] };
    });

    const view = render(
      <SubagentsBody
        state={{}}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: 'device-1', patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // A failing round must still arm the next one.
    await waitFor(() => expect(listCalls).toBeGreaterThan(1), { timeout: 5_000 });

    view.unmount();
    const afterUnmount = listCalls;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(listCalls).toBe(afterUnmount);
  }, 15_000);

  it('does not expose Claude or Codex runs through the new remote PI path', async () => {
    currentDetail = { ...detail('remote codex'), provider: 'codex', title: 'Remote Codex run' };
    render(
      <SubagentsBody
        state={{}}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: 'device-1', patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    await waitFor(() => expect(deviceInvoke).toHaveBeenCalled());
    expect(screen.queryByText('Remote Codex run')).toBeNull();
  });

  it('renders the detail with the normal Session message components', async () => {
    currentDetail = {
      ...detail('assistant result'),
      description: 'assigned work',
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewReturnedResult: true,
        viewFullTranscript: true,
      },
      returnedResult: 'assistant result',
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect((await screen.findByTestId('session-user-message')).textContent).toContain('assigned work');
    expect(screen.getByTestId('session-assistant-message').textContent).toContain('assistant result');
  });

  it.each([
    ['failed', 'rightSidebar.subagents.failedNoReply'],
    ['stopped', 'rightSidebar.subagents.stoppedNoReply'],
    ['completed', 'rightSidebar.subagents.completedNoReply'],
  ] as const)('shows a readable %s empty-result state', async (status, messageKey) => {
    currentDetail = {
      ...detail(''),
      status,
      capabilities: { ...detail('').capabilities, viewFullTranscript: true },
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText(messageKey)).toBeTruthy();
  });

  it.each([
    ['{"status":401,"error":"Unauthorized: token expired"}', 'credentialInvalid'],
    ['{"status":400,"error":"Invalid model name grok-4.6"}', 'modelInvalid'],
  ])('classifies provider errors and keeps raw JSON collapsed', async (rawError, kind) => {
    currentDetail = {
      ...detail(''),
      status: 'failed',
      capabilities: { ...detail('').capabilities, viewFullTranscript: true },
      children: [{ id: 'child-1', role: 'worker', status: 'failed', error: rawError }],
    };
    const { container } = render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText(`rightSidebar.subagents.errors.${kind}`)).toBeTruthy();
    expect(container.querySelector('[data-subagent-error-kind]')?.getAttribute('data-subagent-error-kind'))
      .toBe(kind);
    expect(screen.queryByTestId('session-assistant-message')).toBeNull();
    expect(screen.getByText(rawError).closest('details')?.hasAttribute('open')).toBe(false);
  });

  it('protects a completed child result and offers follow-up instead of steer', async () => {
    currentDetail = {
      ...detail('still wrapping up'),
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true, steer: true },
      children: [{
        id: 'child-1', role: 'worker', title: 'Completed generation', status: 'running',
        output: 'immutable completed result',
      }],
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('immutable completed result')).toBeTruthy();
    expect(screen.queryByLabelText('rightSidebar.subagents.controlActions.steer')).toBeNull();
    expect(screen.getByLabelText('rightSidebar.subagents.controlActions.follow_up')).toBeTruthy();
    // The composer never asks the user to pick a delivery mode; the settled
    // reply flips the placeholder to the follow-up wording instead.
    expect(
      screen.getByPlaceholderText('rightSidebar.subagents.composerPlaceholders.follow_up'),
    ).toBeTruthy();
    expect(screen.queryByText('rightSidebar.subagents.controlActions.follow_up')).toBeNull();
  });

  it.each(['claude-code', 'codex'] as const)(
    'does not expose a persisted %s selection through the Pi-only sidebar',
    async (provider) => {
      currentDetail = {
        ...detail('legacy summary'),
        provider,
        description: 'legacy assignment',
        status: 'completed',
        capabilities: { ...detail('unused').capabilities, viewReturnedResult: true },
        returnedResult: 'legacy result',
        usage: { costUsd: 9.99 },
      };
      const { container } = render(
        <SubagentsBody
          state={{ selectedRunId: 'run-1', selectedProvider: provider }}
          ctx={{
            tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
            remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
            onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
          }}
        />,
      );
      await screen.findByText('rightSidebar.subagents.empty');
      expect(container.querySelector('[data-subagent-detail-mode="legacy"]')).toBeNull();
      expect(screen.queryByText('legacy assignment')).toBeNull();
      expect(screen.queryByText('legacy result')).toBeNull();
      expect(screen.queryByTestId('session-user-message')).toBeNull();
      expect(screen.queryByTestId('session-assistant-message')).toBeNull();
      expect(screen.queryByLabelText('rightSidebar.subagents.sendDirection')).toBeNull();
      expect(container.textContent).not.toContain('$9.99');
    },
  );

  it('presents parallel PI children as separately selectable task conversations', async () => {
    currentDetail = {
      ...detail('batch summary'),
      status: 'completed',
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true, resume: true },
      children: [
        {
          id: 'child-1', role: 'scout', title: 'Inspect runtime', task: 'Inspect the runner',
          status: 'completed', output: 'Runtime findings', model: 'grok-4.6',
        },
        {
          id: 'child-2', role: 'reviewer', title: 'Review UI', task: 'Review the Session UI',
          status: 'completed', output: 'UI findings', model: 'gpt-5.5',
        },
      ],
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(
      (await screen.findByRole('button', { name: 'rightSidebar.subagents.overview' }))
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByText('Inspect the runner')).toBeTruthy();
    expect(screen.getByText('Review the Session UI')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect runtime' }));
    expect(screen.getByText('Runtime findings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review UI' }));
    expect(await screen.findByText('Review the Session UI')).toBeTruthy();
    expect(screen.getByText('UI findings')).toBeTruthy();
    expect(screen.queryByText('Runtime findings')).toBeNull();
  });

  it('keeps a resumed child\'s earlier generations in its conversation', async () => {
    // A resume mints a fresh `childId` for the task it carries over, and the
    // detail auto-selects that new child. Filtering the transcript on the new
    // id alone threw away the generations the Host had just read across — the
    // original assignment, its reply and its tool cards — leaving the default
    // view of a resumed run showing only the follow-up.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true },
      children: [{
        id: 'run-2-1',
        identityAliases: ['run-1-1'],
        role: 'scout',
        status: 'completed',
      }],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', role: 'parent', content: 'the original assignment' }),
        entry({ id: 'e2', childId: 'run-1-1', content: 'the first generation reply' }),
        entry({ id: 'e3', childId: 'run-2-1', role: 'parent', content: 'the follow-up' }),
        entry({ id: 'e4', childId: 'run-2-1', content: 'the resumed reply' }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('the resumed reply')).toBeTruthy();
    expect(screen.getByText('the original assignment')).toBeTruthy();
    expect(screen.getByText('the first generation reply')).toBeTruthy();
    expect(screen.getByText('the follow-up')).toBeTruthy();
  });

  it('keeps two resumed siblings from picking up each other\'s generations', async () => {
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true },
      children: [
        { id: 'run-2-1', identityAliases: ['run-1-1'], role: 'scout', title: 'Scout', status: 'completed' },
        { id: 'run-2-2', identityAliases: ['run-1-2'], role: 'reviewer', title: 'Reviewer', status: 'completed' },
      ],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', content: 'scout first generation' }),
        entry({ id: 'e2', childId: 'run-1-2', content: 'reviewer first generation' }),
        entry({ id: 'e3', childId: 'run-2-1', content: 'scout resumed' }),
        entry({ id: 'e4', childId: 'run-2-2', content: 'reviewer resumed' }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Scout' }));
    expect(await screen.findByText('scout first generation')).toBeTruthy();
    expect(screen.getByText('scout resumed')).toBeTruthy();
    expect(screen.queryByText('reviewer first generation')).toBeNull();
    expect(screen.queryByText('reviewer resumed')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
    expect(await screen.findByText('reviewer first generation')).toBeTruthy();
    expect(screen.getByText('reviewer resumed')).toBeTruthy();
    expect(screen.queryByText('scout first generation')).toBeNull();
  });

  it('keeps a chip selection pointed at the same child after that child is resumed', async () => {
    // The selection holds the id of the generation the user clicked. A resume
    // renames the child underneath it, so resolving on the current id alone
    // returned undefined — which this view reads as "nothing selected" and, in
    // a parallel run, put every sibling's transcript back on screen under a chip
    // the user had picked precisely to narrow it.
    const beforeResume = {
      ...detail('unused'),
      status: 'completed' as const,
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true },
      children: [
        { id: 'run-1-1', role: 'scout', title: 'Scout', status: 'completed' as const },
        { id: 'run-1-2', role: 'reviewer', title: 'Reviewer', status: 'completed' as const },
      ],
    };
    currentDetail = beforeResume;
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', content: 'scout first generation' }),
        entry({ id: 'e2', childId: 'run-1-2', content: 'reviewer first generation' }),
        entry({ id: 'e3', childId: 'run-2-1', content: 'scout resumed' }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // The user narrows to one child while it is still on its first generation.
    fireEvent.click(await screen.findByRole('button', { name: 'Scout' }));
    expect(await screen.findByText('scout first generation')).toBeTruthy();
    expect(screen.queryByText('reviewer first generation')).toBeNull();

    // That child is resumed: same conversation, new id, old id kept as an alias.
    currentDetail = {
      ...beforeResume,
      children: [
        { id: 'run-2-1', identityAliases: ['run-1-1'], role: 'scout', title: 'Scout', status: 'completed' },
        { id: 'run-1-2', role: 'reviewer', title: 'Reviewer', status: 'completed' },
      ],
    };
    act(() => {
      onChanged(
        { sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false },
        OWNER_STAMP,
      );
    });

    // Still that child, both generations, and still no sibling.
    expect(await screen.findByText('scout resumed')).toBeTruthy();
    expect(screen.getByText('scout first generation')).toBeTruthy();
    expect(screen.queryByText('reviewer first generation')).toBeNull();
    // And the chip the user picked is still the lit one, so the narrowed view
    // and the control it came from do not disagree.
    expect(screen.getByRole('button', { name: 'Scout' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Reviewer' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('falls back to the sole child when the selected one is no longer listed', async () => {
    // Resuming one child of a parallel run carries only that child forward, so
    // the sibling the user had selected is gone from the next generation. An
    // unresolvable selection must degrade to what no selection does — here, the
    // one child there is — and not to "show everything", which would put the
    // departed sibling's transcript back on screen.
    const parallel = {
      ...detail('unused'),
      status: 'completed' as const,
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true },
      children: [
        { id: 'run-1-1', role: 'scout', title: 'Scout', status: 'completed' as const },
        { id: 'run-1-2', role: 'reviewer', title: 'Reviewer', status: 'completed' as const },
      ],
    };
    currentDetail = parallel;
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', content: 'scout first generation' }),
        entry({ id: 'e2', childId: 'run-1-2', content: 'reviewer first generation' }),
        entry({ id: 'e3', childId: 'run-2-1', content: 'scout resumed alone' }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reviewer' }));
    expect(await screen.findByText('reviewer first generation')).toBeTruthy();

    // Only the scout is resumed; the reviewer the user had selected is gone.
    currentDetail = {
      ...parallel,
      children: [
        { id: 'run-2-1', identityAliases: ['run-1-1'], role: 'scout', title: 'Scout', status: 'completed' },
      ],
    };
    act(() => {
      onChanged(
        { sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false },
        OWNER_STAMP,
      );
    });

    expect(await screen.findByText('scout resumed alone')).toBeTruthy();
    expect(screen.getByText('scout first generation')).toBeTruthy();
    expect(screen.queryByText('reviewer first generation')).toBeNull();
  });

  it('drops the waiting notice for a settled child while its siblings keep the run running', async () => {
    // A parallel run stays `running` until the last child settles. Keying the
    // waiting notice off the run status put a spinner under a child that had
    // already finished, contradicting its own terminal label and its disabled
    // composer on the same screen.
    currentDetail = {
      ...detail('parallel running'),
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true, steer: true },
      children: [
        { id: 'child-1', role: 'scout', title: 'Scout', status: 'completed', output: 'scout done' },
        { id: 'child-2', role: 'reviewer', title: 'Reviewer', status: 'failed', error: 'reviewer blew up' },
        { id: 'child-3', role: 'worker', title: 'Worker', status: 'running' },
      ],
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // Overview: the run really is still running, so the notice stays.
    expect(await screen.findByText('rightSidebar.subagents.waitingForReply')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Scout' }));
    expect(screen.queryByText('rightSidebar.subagents.waitingForReply')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
    expect(screen.queryByText('rightSidebar.subagents.waitingForReply')).toBeNull();

    // The child that is genuinely still working keeps it.
    fireEvent.click(screen.getByRole('button', { name: 'Worker' }));
    expect(screen.getByText('rightSidebar.subagents.waitingForReply')).toBeTruthy();
  });

  it('keeps child drafts separate and follows the standard composer send shortcut', async () => {
    currentDetail = {
      ...detail('parallel running'),
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true, steer: true },
      children: [
        { id: 'child-1', role: 'scout', title: 'Scout', status: 'running' },
        { id: 'child-2', role: 'reviewer', title: 'Reviewer', status: 'running' },
      ],
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Scout' }));
    const scoutInput = screen.getByPlaceholderText('rightSidebar.subagents.composerPlaceholders.runningWithSteer');
    fireEvent.change(scoutInput, { target: { value: 'scout draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
    const reviewerInput = screen.getByPlaceholderText('rightSidebar.subagents.composerPlaceholders.runningWithSteer');
    expect((reviewerInput as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(reviewerInput, { target: { value: 'reviewer draft' } });
    fireEvent.keyDown(reviewerInput, { key: 'Enter', shiftKey: true });
    expect(controlPiSubagent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scout' }));
    const restoredScoutInput = screen.getByPlaceholderText('rightSidebar.subagents.composerPlaceholders.runningWithSteer');
    expect((restoredScoutInput as HTMLTextAreaElement).value).toBe('scout draft');
    // Plain Enter is the session's queue keystroke — it must follow up, not steer.
    fireEvent.keyDown(restoredScoutInput, { key: 'Enter' });
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'follow_up',
        message: 'scout draft', childId: 'child-1',
      });
    });
  });

  it('does not offer controls for a finished child while siblings are still running', async () => {
    currentDetail = {
      ...detail('parallel running'),
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        steer: true,
        stop: true,
      },
      children: [
        { id: 'child-1', role: 'scout', title: 'Finished Scout', status: 'completed' },
        { id: 'child-2', role: 'reviewer', title: 'Running Reviewer', status: 'running' },
      ],
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Finished Scout' }));
    expect(screen.queryByPlaceholderText('rightSidebar.subagents.composerPlaceholders.runningWithSteer')).toBeNull();
    expect(screen.getByText('rightSidebar.subagents.childEndedControlHint')).toBeTruthy();
    expect(screen.queryByLabelText('chat.agentTask.stop')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Running Reviewer' }));
    expect(screen.getByPlaceholderText('rightSidebar.subagents.composerPlaceholders.runningWithSteer')).toBeTruthy();
    expect(screen.getByLabelText('chat.agentTask.stop')).toBeTruthy();
  });

  it('pages in a capability-advertised PI transcript without opening technical details', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript.mockResolvedValueOnce({
      supported: true,
      entries: [{
        id: 'entry-1',
        sequence: 1,
        role: 'subagent',
        content: 'transcript answer',
        occurredAt: 300,
      }],
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('transcript answer')).toBeTruthy();
    expect(loadTranscript).toHaveBeenCalledWith({
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'run-1', limit: 200,
    });
  });

  it('follows nextCursor until the whole transcript is paged in', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript
      .mockResolvedValueOnce({
        supported: true,
        entries: [entry({ id: 'entry-1', content: 'page one answer' })],
        nextCursor: 'cursor-2',
        tailCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        supported: true,
        entries: [entry({ id: 'entry-2', content: 'page two answer' })],
        tailCursor: 'cursor-tail',
      });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('page one answer')).toBeTruthy();
    expect(screen.getByText('page two answer')).toBeTruthy();
    expect(loadTranscript).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'run-1',
      limit: 200, cursor: 'cursor-2',
    });
  });

  it('still renders the durable result when the transcript holds no assistant reply', async () => {
    // A long run can hit the 50MB transcript cap, or keep its reply outside the
    // eagerly paged window, leaving only task and tool items behind. Gating the
    // durable-result fallback on "any conversation item" swallowed a finished
    // result the durable record still had — and counted it as a reply, so the
    // missing-reply notice did not appear either.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'durable completed result',
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'entry-parent', role: 'parent', content: 'go and research' }),
        entry({
          id: 'entry-tool', role: 'tool', toolPhase: 'start',
          toolName: 'read', content: 'read a.txt',
        }),
      ],
      tailCursor: 'cursor-tail-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // The tool card is still on screen, and so is the result the record kept.
    // Both waits are `findBy`: the durable result comes straight from the detail
    // record, the transcript items arrive from a separate async page load, and a
    // synchronous read of the second one only happened to pass while that load
    // resolved inside the first tick. Under CI load it did not, and the case
    // failed on timing rather than on what it is testing.
    expect(await screen.findByText('durable completed result')).toBeTruthy();
    expect(await screen.findByText('go and research')).toBeTruthy();
    // A reply is visible, so the "no reply" notice must stay away.
    expect(screen.queryByText('rightSidebar.subagents.completedNoReply')).toBeNull();
  });

  it('shows the durable result when only an older generation carried a reply', async () => {
    // The transcript now aggregates every generation of a child permanently, so
    // "some assistant line exists" stopped meaning "this run answered". A
    // resumed generation whose reply is missing — 50MB cap, unreadable page,
    // outside the paged window — was left showing the *previous* generation's
    // answer with the new `returnedResult` nowhere on screen, and no
    // missing-reply notice either.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'the resumed answer',
      // A selected child shows its own returned output; the run-level result is
      // what the overview uses.
      children: [{
        id: 'run-2-1', identityAliases: ['run-1-1'], role: 'scout', status: 'completed',
        output: 'the resumed answer',
      }],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', role: 'parent', content: 'the original assignment' }),
        entry({ id: 'e2', childId: 'run-1-1', content: 'the first generation answer' }),
        entry({ id: 'e3', childId: 'run-2-1', role: 'parent', content: 'the follow-up' }),
        entry({
          id: 'e4', childId: 'run-2-1', role: 'tool', toolPhase: 'start',
          toolName: 'read', content: 'read b.txt',
        }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // The older generation stays readable, and the newest run's own result is
    // on screen rather than suppressed by it.
    // Wait for the transcript to land first. Before it does, there is no
    // conversation at all and the fallback renders for a moment on every
    // implementation — asserting into that window would pass without testing
    // anything.
    expect(await screen.findByText('the follow-up')).toBeTruthy();
    expect(screen.getByText('the first generation answer')).toBeTruthy();
    expect(screen.getByText('read b.txt')).toBeTruthy();
    expect(screen.getByText('the resumed answer')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.subagents.completedNoReply')).toBeNull();
  });

  it('shows the durable result when the transcript was truncated before the newest reply', async () => {
    // A follow-up gives the same child a second `message_end`, and the runner
    // overwrites `task.output` each time — so the durable result is the newest
    // reply while the transcript may still be showing an earlier one. The
    // runner also stops appending at its byte cap, which always loses the
    // *tail*. "Some assistant line exists" then stopped meaning "the newest
    // reply is on screen", and the user read a stale answer with the current
    // one nowhere.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      children: [{
        id: 'run-1-1', role: 'scout', status: 'completed',
        output: 'the newest answer',
      }],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', content: 'the first answer' }),
        entry({
          id: 'e2', childId: 'run-1-1', role: 'system',
          content: 'Transcript storage limit reached.',
          systemEvent: { kind: 'transcript-truncated' },
        }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('the first answer')).toBeTruthy();
    expect(screen.getByText('the newest answer')).toBeTruthy();
  });

  it('shows the durable result while the transcript tail is still unread', async () => {
    // Same gap from the other direction: paging is head-first with a page
    // bound, so a long transcript can stop short with more still to load.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      children: [{
        id: 'run-1-1', role: 'scout', status: 'completed',
        output: 'the newest answer',
      }],
    };
    // `nextCursor` on every page: the eager loop stops at its page bound and
    // leaves `transcriptCursor` set.
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [entry({ id: 'e1', childId: 'run-1-1', content: 'the first answer' })],
      nextCursor: 'cursor-next',
      tailCursor: 'cursor-next',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // The eager loop re-reads the same page up to its bound, so the transcript
    // legitimately holds repeats of that entry; the assertion that matters is
    // that the durable result is on screen next to them.
    expect((await screen.findAllByText('the first answer')).length).toBeGreaterThan(0);
    expect(screen.getByText('the newest answer')).toBeTruthy();
  });

  it('still suppresses the durable result once the current generation replies', async () => {
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'the resumed answer',
      children: [{
        id: 'run-2-1', identityAliases: ['run-1-1'], role: 'scout', status: 'completed',
        output: 'the resumed answer',
      }],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', content: 'the first generation answer' }),
        entry({ id: 'e2', childId: 'run-2-1', content: 'the resumed answer' }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // Settled state only, for the same reason as above.
    expect(await screen.findByText('the first generation answer')).toBeTruthy();
    // Exactly once: the transcript carried it, so the fallback must not repeat it.
    expect(screen.getAllByText('the resumed answer')).toHaveLength(1);
  });

  it('counts a reply with no childId as the current generation', async () => {
    // Single-generation records, and any older wire format, carry no `childId`.
    // Before aliases existed every entry was the current generation, and that
    // has to stay literally true.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'durable copy of the answer',
      children: [{
        id: 'run-1-1', role: 'scout', status: 'completed',
        output: 'durable copy of the answer',
      }],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [entry({ id: 'e1', content: 'the only answer' })],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('the only answer')).toBeTruthy();
    expect(screen.queryByText('durable copy of the answer')).toBeNull();
    expect(screen.queryByText('rightSidebar.subagents.completedNoReply')).toBeNull();
  });

  it('reads the overview by every current child, not by one generation of one', async () => {
    // No selection: the reply may belong to any of the children, and only their
    // *current* ids count — an older generation of either must not stand in.
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'the batch result',
      children: [
        { id: 'run-2-1', identityAliases: ['run-1-1'], role: 'scout', title: 'Scout', status: 'completed' },
        { id: 'run-2-2', identityAliases: ['run-1-2'], role: 'reviewer', title: 'Reviewer', status: 'completed' },
      ],
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'e1', childId: 'run-1-1', content: 'scout first generation answer' }),
        entry({ id: 'e2', childId: 'run-1-2', content: 'reviewer first generation answer' }),
      ],
      tailCursor: 'cursor-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    // Settled state: the transcript is in, and neither current generation
    // replied — so the durable result is what the user has, and it must be on
    // screen next to the older generations.
    expect(await screen.findByText('scout first generation answer')).toBeTruthy();
    expect(screen.getByText('reviewer first generation answer')).toBeTruthy();
    expect(screen.getByText('the batch result')).toBeTruthy();
  });

  it('does not render the result twice when the transcript already ends with it', async () => {
    currentDetail = {
      ...detail('unused'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        viewReturnedResult: true,
      },
      returnedResult: 'the final answer',
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({ id: 'entry-parent', role: 'parent', content: 'go and research' }),
        entry({ id: 'entry-answer', content: 'the final answer' }),
      ],
      tailCursor: 'cursor-tail-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('the final answer')).toBeTruthy();
    expect(screen.getAllByText('the final answer')).toHaveLength(1);
  });

  it('keeps the missing-reply notice when neither the transcript nor the record has one', async () => {
    currentDetail = {
      ...detail(''),
      status: 'completed',
      summary: '',
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true },
    };
    loadTranscript.mockResolvedValue({
      supported: true,
      entries: [
        entry({
          id: 'entry-tool', role: 'tool', toolPhase: 'start',
          toolName: 'read', content: 'read a.txt',
        }),
      ],
      tailCursor: 'cursor-tail-1',
    });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('rightSidebar.subagents.completedNoReply')).toBeTruthy();
  });

  it('appends from tailCursor after a change instead of duplicating entries', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript
      .mockResolvedValueOnce({
        supported: true,
        entries: [entry({ id: 'entry-1', content: 'first answer' })],
        tailCursor: 'cursor-tail-1',
      })
      // An overlapping tail page replays the last known entry; the merge is by
      // id so the conversation must not grow a duplicate row.
      .mockResolvedValueOnce({
        supported: true,
        entries: [
          entry({ id: 'entry-1', content: 'first answer' }),
          entry({ id: 'entry-2', content: 'appended answer' }),
        ],
        tailCursor: 'cursor-tail-2',
      });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('first answer')).toBeTruthy();

    act(() => {
      onChanged({
        sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false,
      }, OWNER_STAMP);
    });

    expect(await screen.findByText('appended answer')).toBeTruthy();
    expect(loadTranscript).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'run-1',
      limit: 200, cursor: 'cursor-tail-1',
    });
    expect(screen.getAllByText('first answer')).toHaveLength(1);
  });

  it('recovers with a full re-read after a tail read fails', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript
      .mockResolvedValueOnce({
        supported: true,
        entries: [entry({ id: 'entry-1', content: 'first answer' })],
        tailCursor: 'cursor-tail-1',
      })
      // The host rejects the kept cursor (the record was rewritten under it).
      .mockRejectedValueOnce(new Error('PI Subagent transcript cursor exceeds file size'))
      .mockResolvedValueOnce({
        supported: true,
        entries: [
          entry({ id: 'entry-1', content: 'first answer' }),
          entry({ id: 'entry-2', content: 'recovered answer' }),
        ],
        tailCursor: 'cursor-tail-2',
      });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('first answer')).toBeTruthy();

    act(() => {
      onChanged({
        sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false,
      }, OWNER_STAMP);
    });
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
    expect(loadTranscript).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'run-1',
      limit: 200, cursor: 'cursor-tail-1',
    });

    act(() => {
      onChanged({
        sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false,
      }, OWNER_STAMP);
    });
    expect(await screen.findByText('recovered answer')).toBeTruthy();
    // The failed cursor was dropped, so the retry reads from the start again.
    expect(loadTranscript).toHaveBeenNthCalledWith(3, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'run-1', limit: 200,
    });
    expect(screen.getAllByText('first answer')).toHaveLength(1);
  });

  it('renders the transcript as a conversation of user, assistant and tool cards', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript.mockResolvedValueOnce({
      supported: true,
      entries: [
        entry({ id: 'e-1', role: 'parent', content: 'do the research' }),
        entry({
          id: 'e-2', role: 'tool', content: 'read(/tmp/a.ts)', toolName: 'read',
          toolCallId: 'call-1', toolPhase: 'start', toolInputJson: '{"file_path":"/tmp/a.ts"}',
        }),
        entry({
          id: 'e-3', role: 'tool', content: 'file body', toolCallId: 'call-1',
          toolPhase: 'end', isError: false,
        }),
        entry({ id: 'e-4', role: 'system', content: 'raw runner noise' }),
        entry({ id: 'e-5', role: 'subagent', content: 'here is the answer' }),
        entry({
          id: 'e-6', role: 'parent', content: 'also check b', controlAction: 'steer',
        }),
      ],
    });
    const { container } = render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    expect(await screen.findByText('do the research')).toBeTruthy();
    const stream = [...container.querySelectorAll(
      '[data-testid="session-user-message"],[data-testid="session-assistant-message"],[data-subagent-tool-card]',
    )].map((node) => node.textContent);
    expect(stream).toEqual([
      'do the research',
      'read(/tmp/a.ts)',
      'here is the answer',
      'also check b',
    ]);

    // The steer chip marks a parent line the user typed into this run.
    expect(screen.getByText('rightSidebar.subagents.controlBadges.steer')).toBeTruthy();
    // start + end fold into one card, already settled.
    expect(container.querySelectorAll('[data-subagent-tool-card]')).toHaveLength(1);
    expect(container.querySelector('[data-subagent-tool-card]')?.getAttribute('data-subagent-tool-card'))
      .toBe('done');
    // The tool result lives behind the fold, not in the reading flow.
    expect(screen.queryByText('file body')).toBeNull();
    fireEvent.click(screen.getByText('read(/tmp/a.ts)'));
    expect(await screen.findByText('file body')).toBeTruthy();

    // Runtime noise stays out of the conversation and lands under technical
    // details instead.
    expect(screen.queryByText('raw runner noise')).toBeNull();
    fireEvent.click(screen.getByText('rightSidebar.subagents.technicalDetails'));
    expect(screen.getByText('raw runner noise')).toBeTruthy();
  });

  it('keeps an unfinished tool call in its running state', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript.mockResolvedValueOnce({
      supported: true,
      entries: [entry({
        id: 'e-1', role: 'tool', content: 'bash(pnpm test)', toolName: 'bash',
        toolCallId: 'call-1', toolPhase: 'start',
      })],
    });
    const { container } = render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('bash(pnpm test)')).toBeTruthy();
    expect(container.querySelector('[data-subagent-tool-card]')?.getAttribute('data-subagent-tool-card'))
      .toBe('running');
  });

  it('falls back to the assignment and returned result when no transcript exists', async () => {
    currentDetail = {
      ...detail('legacy summary'),
      status: 'completed',
      description: 'assigned work',
      returnedResult: 'archived result',
      capabilities: {
        ...detail('unused').capabilities,
        viewReturnedResult: true,
        viewFullTranscript: true,
      },
    };
    loadTranscript.mockResolvedValueOnce({ supported: true, entries: [], tailCursor: 'tail' });
    const { container } = render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect((await screen.findByTestId('session-user-message')).textContent).toContain('assigned work');
    expect(screen.getByTestId('session-assistant-message').textContent).toContain('archived result');
    expect(container.querySelectorAll('[data-subagent-tool-card]')).toHaveLength(0);
  });

  it('does not let a late transcript from the previous run overwrite the selected run', async () => {
    let resolveFirst!: (response: SubagentTranscriptPageResponse) => void;
    const firstResponse = new Promise<SubagentTranscriptPageResponse>((resolve) => {
      resolveFirst = resolve;
    });
    currentDetail = {
      ...detail('first run'),
      capabilities: { ...detail('first run').capabilities, viewFullTranscript: true },
    };
    loadTranscript
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({
        supported: true,
        entries: [{
          id: 'entry-2', sequence: 2, role: 'subagent', content: 'second transcript', occurredAt: 400,
        }],
      });
    const ctx = {
      tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
      remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
      onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
    };
    const view = render(
      <SubagentsBody state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }} ctx={ctx} />,
    );
    await screen.findByText('rightSidebar.subagents.technicalDetails');
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));

    currentDetail = {
      ...detail('second run'),
      id: 'run-2',
      logicalAgentId: 'task-2',
      parentToolUseId: 'task-2',
      identityAliases: ['task-2'],
      capabilities: { ...detail('second run').capabilities, viewFullTranscript: true },
    };
    view.rerender(
      <SubagentsBody state={{ selectedRunId: 'run-2', selectedProvider: 'pi' }} ctx={ctx} />,
    );
    await screen.findByText('second run');
    expect(await screen.findByText('second transcript')).toBeTruthy();

    await act(async () => {
      resolveFirst({
        supported: true,
        entries: [{
          id: 'entry-1', sequence: 1, role: 'subagent', content: 'stale first transcript', occurredAt: 300,
        }],
      });
      await firstResponse;
    });
    expect(screen.queryByText('stale first transcript')).toBeNull();
    expect(screen.getByText('second transcript')).toBeTruthy();
  });

  it('hides the previous run while a newly selected detail is still loading', async () => {
    currentDetail = {
      ...detail('first controllable run'),
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true, steer: true },
    };
    const ctx = {
      tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
      remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
      onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
    };
    const view = render(
      <SubagentsBody state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }} ctx={ctx} />,
    );
    await screen.findByText('first controllable run');

    let resolveSecond!: (response: { supported: true; run: SubagentRunDetail }) => void;
    loadDetail.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSecond = resolve;
    }));
    currentDetail = {
      ...detail('second run'),
      id: 'run-2',
      logicalAgentId: 'task-2',
      parentToolUseId: 'task-2',
      identityAliases: ['task-2'],
    };
    view.rerender(
      <SubagentsBody state={{ selectedRunId: 'run-2', selectedProvider: 'pi' }} ctx={ctx} />,
    );

    await waitFor(() => expect(screen.queryByText('first controllable run')).toBeNull());
    expect(screen.queryByLabelText('rightSidebar.subagents.controlActions.steer')).toBeNull();

    await act(async () => {
      resolveSecond({ supported: true, run: currentDetail! });
    });
    expect(await screen.findByText('second run')).toBeTruthy();
  });

  it('re-reads the whole transcript after a change when the host reports no tailCursor', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true },
    };
    loadTranscript
      .mockResolvedValueOnce({
        supported: true,
        entries: [{ id: 'entry-1', sequence: 1, role: 'subagent', content: 'before refresh', occurredAt: 300 }],
      })
      .mockResolvedValueOnce({
        supported: true,
        entries: [{ id: 'entry-2', sequence: 2, role: 'subagent', content: 'after refresh', occurredAt: 400 }],
      });
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    expect(await screen.findByText('before refresh')).toBeTruthy();

    act(() => {
      onChanged({
        sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false,
      }, OWNER_STAMP);
    });
    expect(await screen.findByText('after refresh')).toBeTruthy();
    expect(loadTranscript).toHaveBeenCalledTimes(2);
    // Without a tailCursor the second read must be a full read, not a tail read.
    expect(loadTranscript).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'run-1', limit: 200,
    });
    expect(screen.queryByText('before refresh')).toBeNull();
  });

  it('steers a capability-advertised PI run', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: {
        ...detail('running').capabilities,
        viewFullTranscript: true,
        steer: true,
      },
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    const input = await screen.findByPlaceholderText('rightSidebar.subagents.composerPlaceholders.runningWithSteer');
    fireEvent.change(input, { target: { value: 'check the fallback too' } });
    // The modifier send is the session's interjection keystroke while running.
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'steer',
        message: 'check the fallback too',
      });
    });
    // The visible send button is the plain queue path.
    expect(screen.getByLabelText('rightSidebar.subagents.controlActions.follow_up')).toBeTruthy();
  });

  it('dispatches a follow-up automatically once the child has settled output', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true, steer: true },
      children: [{
        id: 'child-1', role: 'worker', title: 'Worker', status: 'running',
        output: 'settled reply',
      }],
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    const input = await screen.findByPlaceholderText(
      'rightSidebar.subagents.composerPlaceholders.follow_up',
    );
    fireEvent.change(input, { target: { value: 'run the final verification' } });
    fireEvent.click(screen.getByLabelText('rightSidebar.subagents.controlActions.follow_up'));
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'follow_up',
        message: 'run the final verification', childId: 'child-1',
      });
    });
  });

  it('dispatches resume when composing into a finished run', async () => {
    currentDetail = {
      ...detail('finished summary'),
      status: 'completed',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        resume: true,
      },
      returnedResult: 'finished result',
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: null, patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );
    const input = await screen.findByPlaceholderText(
      'rightSidebar.subagents.composerPlaceholders.resume',
    );
    fireEvent.change(input, { target: { value: 'pick this back up' } });
    fireEvent.click(screen.getByLabelText('rightSidebar.subagents.controlActions.resume'));
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'resume',
        message: 'pick this back up',
      });
    });
  });

  it('stops a capability-advertised run with its logical task id', async () => {
    currentDetail = {
      ...detail('running durable task'),
      logicalAgentId: 'durable-run-id',
      parentToolUseId: 'task-1',
      capabilities: {
        ...detail('unused').capabilities,
        viewFullTranscript: true,
        stop: true,
      },
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1',
          sessionId: 'session-1',
          workdir: '/workspace',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          patchState: vi.fn(),
          onVisibilityChange: vi.fn(),
          setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    await screen.findByText('running durable task');
    fireEvent.click(screen.getByLabelText('chat.agentTask.stop'));
    await waitFor(() => {
      expect(stopAgentTask).toHaveBeenCalledWith('session-1', 'task-1');
    });
  });

  it('routes remote PI stop through the PI-only control channel', async () => {
    currentDetail = {
      ...detail('remote durable task'),
      capabilities: { ...detail('unused').capabilities, viewFullTranscript: true, stop: true },
    };
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1', sessionId: 'session-1', workdir: '/workspace',
          remoteHostId: null, deviceLinkDeviceId: 'device-1', patchState: vi.fn(),
          onVisibilityChange: vi.fn(), setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    await screen.findByText('remote durable task');
    fireEvent.click(screen.getByLabelText('chat.agentTask.stop'));
    await waitFor(() => {
      expect(deviceInvoke).toHaveBeenCalledWith(
        'device-1',
        'maker:pi-subagent:control',
        [{ sessionId: 'session-1', taskId: 'task-1', action: 'stop' }],
      );
    });
    expect(stopAgentTask).not.toHaveBeenCalled();
  });

  it('removes stale list and detail content after a session boundary invalidation', async () => {
    render(
      <SubagentsBody
        state={{ selectedRunId: 'run-1', selectedProvider: 'pi' }}
        ctx={{
          tabId: 'tab-1',
          sessionId: 'session-1',
          workdir: '/workspace',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          patchState: vi.fn(),
          onVisibilityChange: vi.fn(),
          setCloseInterceptor: vi.fn(() => () => undefined),
        }}
      />,
    );

    await screen.findByText('initial progress');
    currentDetail = null;

    act(() => {
      onChanged(
        {
          sessionId: 'session-1',
          runId: null,
          created: false,
          firstForSession: false,
        },
        OWNER_STAMP,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('initial progress')).toBeNull();
      expect(list).toHaveBeenCalledTimes(2);
    });
  });
});
