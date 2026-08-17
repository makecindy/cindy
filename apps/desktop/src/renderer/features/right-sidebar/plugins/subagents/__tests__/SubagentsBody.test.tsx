// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="legacy-markdown-result">{content}</div>
  ),
}));

vi.mock('@/components/chat/UserMessage', () => ({
  UserMessage: ({ content }: { content: string }) => <div data-testid="session-user-message">{content}</div>,
}));

vi.mock('@/components/chat/AssistantMessage', () => ({
  AssistantMessage: ({ content }: { content: string }) => <div data-testid="session-assistant-message">{content}</div>,
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
  const deviceInvoke = vi.fn(async (_deviceId: string, channel: string) => {
    if (channel === 'local-db:subagent-runs:list') {
      return { supported: true, runs: currentDetail ? [currentDetail] : [] };
    }
    if (channel === 'local-db:subagent-runs:detail') {
      return { supported: true, run: currentDetail };
    }
    return { supported: false, run: null, entries: [] };
  });
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
    loadTranscript.mockClear();
    deviceInvoke.mockClear();
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
    expect(screen.getByText('rightSidebar.subagents.completedOutputFollowUpHint')).toBeTruthy();
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
      expect(screen.queryByPlaceholderText('rightSidebar.subagents.directionPlaceholder')).toBeNull();
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
    const scoutInput = screen.getByPlaceholderText('rightSidebar.subagents.directionPlaceholder');
    fireEvent.change(scoutInput, { target: { value: 'scout draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
    const reviewerInput = screen.getByPlaceholderText('rightSidebar.subagents.directionPlaceholder');
    expect((reviewerInput as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(reviewerInput, { target: { value: 'reviewer draft' } });
    fireEvent.keyDown(reviewerInput, { key: 'Enter', shiftKey: true });
    expect(controlPiSubagent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scout' }));
    const restoredScoutInput = screen.getByPlaceholderText('rightSidebar.subagents.directionPlaceholder');
    expect((restoredScoutInput as HTMLTextAreaElement).value).toBe('scout draft');
    fireEvent.keyDown(restoredScoutInput, { key: 'Enter' });
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'steer',
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
    expect(screen.queryByPlaceholderText('rightSidebar.subagents.directionPlaceholder')).toBeNull();
    expect(screen.getByText('rightSidebar.subagents.childEndedControlHint')).toBeTruthy();
    expect(screen.queryByLabelText('chat.agentTask.stop')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Running Reviewer' }));
    expect(screen.getByPlaceholderText('rightSidebar.subagents.directionPlaceholder')).toBeTruthy();
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
    const input = await screen.findByPlaceholderText('rightSidebar.subagents.directionPlaceholder');
    fireEvent.change(input, { target: { value: 'check the fallback too' } });
    fireEvent.click(screen.getByLabelText('rightSidebar.subagents.controlActions.steer'));
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'steer',
        message: 'check the fallback too',
      });
    });
  });

  it('sends a follow-up after the current PI work finishes', async () => {
    currentDetail = {
      ...detail('running'),
      capabilities: { ...detail('running').capabilities, viewFullTranscript: true, steer: true },
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
    fireEvent.click(await screen.findByText('rightSidebar.subagents.controlActions.follow_up'));
    const input = screen.getByPlaceholderText('rightSidebar.subagents.directionPlaceholder');
    fireEvent.change(input, { target: { value: 'run the final verification' } });
    fireEvent.click(screen.getByLabelText('rightSidebar.subagents.controlActions.follow_up'));
    await waitFor(() => {
      expect(controlPiSubagent).toHaveBeenCalledWith({
        sessionId: 'session-1', taskId: 'task-1', action: 'follow_up',
        message: 'run the final verification',
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
