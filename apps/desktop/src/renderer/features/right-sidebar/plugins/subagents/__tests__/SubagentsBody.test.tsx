// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SubagentRunDetail,
  SubagentRunsChangedPayload,
} from '@cindy/maker-shared/subagent-workspace';

import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <>{content}</>,
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

  beforeEach(() => {
    dataOwnerTesting.reset();
    setDataOwnerGeneration('owner-1', 1);
    currentDetail = detail('initial progress');
    list.mockClear();
    loadDetail.mockClear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        localDb: {
          subagentRuns: {
            list,
            detail: loadDetail,
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
