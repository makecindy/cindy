// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRun, SubagentRunsListResponse } from '@cindy/maker-shared/subagent-workspace';

import { useSubagentRunStatusIndex } from '../useSubagentRunStatusIndex';

type ChangeListener = (
  payload: { sessionId: string; runId: string | null },
  stamp?: unknown,
) => void;

function run(partial: Partial<SubagentRun> & Pick<SubagentRun, 'id' | 'status'>): SubagentRun {
  return {
    parentSessionId: 's1',
    provider: 'claude-code',
    logicalAgentId: partial.id,
    identityAliases: [],
    providerRunIds: [],
    capabilities: {} as SubagentRun['capabilities'],
    startedAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function installApi(pages: Record<string, SubagentRunsListResponse>) {
  const listeners = new Set<ChangeListener>();
  const list = vi.fn(
    async (input: { sessionId: string; cursor?: string }) =>
      pages[`${input.sessionId}:${input.cursor ?? ''}`] ?? { supported: true, runs: [] },
  );
  const api = {
    list,
    onChanged: vi.fn((listener: ChangeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { subagentRuns: api },
  };
  return { list, listeners };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useSubagentRunStatusIndex', () => {
  it('reads every page and indexes runs by their parent tool-use id', async () => {
    installApi({
      's1:': {
        supported: true,
        runs: [run({ id: 'r1', parentToolUseId: 'toolu_1', status: 'running' })],
        nextCursor: 'c2',
      },
      's1:c2': {
        supported: true,
        runs: [run({ id: 'r2', parentToolUseId: 'toolu_2', status: 'failed' })],
      },
    });
    const { result } = renderHook(() => useSubagentRunStatusIndex({ sessionId: 's1' }));
    await waitFor(() => expect(result.current.get('toolu_2')).toBe('failed'));
    expect(result.current.get('toolu_1')).toBe('running');
  });

  it('re-reads on a change push for its own task only', async () => {
    const pages: Record<string, SubagentRunsListResponse> = {
      's1:': {
        supported: true,
        runs: [run({ id: 'r1', parentToolUseId: 'toolu_1', status: 'running' })],
      },
    };
    const { list, listeners } = installApi(pages);
    const { result } = renderHook(() => useSubagentRunStatusIndex({ sessionId: 's1' }));
    await waitFor(() => expect(result.current.get('toolu_1')).toBe('running'));

    pages['s1:'] = {
      supported: true,
      runs: [run({ id: 'r1', parentToolUseId: 'toolu_1', status: 'completed', updatedAt: 2 })],
    };
    const callsBefore = list.mock.calls.length;
    act(() => {
      for (const listener of listeners) listener({ sessionId: 'other', runId: null });
    });
    act(() => {
      for (const listener of listeners) listener({ sessionId: 's1', runId: 'r1' });
    });
    await waitFor(() => expect(result.current.get('toolu_1')).toBe('completed'));
    expect(list.mock.calls.length).toBe(callsBefore + 1);
  });

  it('does not read this machine for a device-link task', () => {
    const { list } = installApi({});
    const { result } = renderHook(() =>
      useSubagentRunStatusIndex({ sessionId: 's1', deviceId: 'device-2' }),
    );
    expect(list).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it('never shows the previous task while the next task is still loading', async () => {
    installApi({
      's1:': {
        supported: true,
        runs: [run({ id: 'r1', parentToolUseId: 'toolu_1', status: 'running' })],
      },
    });
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSubagentRunStatusIndex({ sessionId }),
      { initialProps: { sessionId: 's1' } },
    );
    await waitFor(() => expect(result.current.get('toolu_1')).toBe('running'));
    rerender({ sessionId: 's2' });
    expect(result.current.get('toolu_1')).toBeUndefined();
    // Let the s2 read settle inside act so it cannot leak into the next test.
    await waitFor(() => expect(result.current.size).toBe(0));
  });
});
