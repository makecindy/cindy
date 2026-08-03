import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import {
  GHOST_AT_RESOURCE_QUERY_TIMEOUT_MS,
  GhostAtResourceQueryScheduler,
  listGhostAtResourceProviders,
  queryGhostAtResources,
  resolveGhostAtResourceWorkingDir,
  type GhostAtResourceProviderDeps,
} from '../atResourceProvider.js';

function ghost(overrides: Partial<InstalledGhost> = {}): InstalledGhost {
  return {
    dir: '/plugins/issues',
    enabled: true,
    manifest: {
      schemaVersion: 2,
      id: 'issues',
      name: 'Issue Tracker',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'search_issues', description: 'Search issues without side effects' }],
      atResourceProvider: { tool: 'search_issues' },
    },
    ...overrides,
  };
}

function deps(overrides: Partial<GhostAtResourceProviderDeps> = {}): GhostAtResourceProviderDeps {
  return {
    listGhosts: () => [ghost()],
    isAvailable: () => true,
    isDisabledForWorkdir: () => false,
    getSetupAssessment: () => ({ state: 'ready', revision: 1, groups: [] }),
    callTool: vi.fn(async () => ({
      ok: true as const,
      result: {
        items: [{ id: 'ISSUE-1', label: '  Fix\u202e\nlogin  ', description: '  Open\tissue ' }],
      },
    })),
    ...overrides,
  };
}

describe('Plugin @ resource providers', () => {
  it('uses authoritative local session scope and rejects draft paths', async () => {
    const getSessionSnapshot = vi.fn(async (sessionId: string) => {
      if (sessionId === 'local') return { workingDir: '/db/repo', remoteHostId: null };
      if (sessionId === 'remote') return { workingDir: '/remote/repo', remoteHostId: 'host-1' };
      return null;
    });

    await expect(resolveGhostAtResourceWorkingDir({
      sessionId: 'local',
      workingDir: '/spoofed/repo',
    }, getSessionSnapshot)).resolves.toEqual({ allowed: true, workingDir: '/db/repo' });
    await expect(resolveGhostAtResourceWorkingDir({
      sessionId: 'remote',
      workingDir: '/spoofed/repo',
    }, getSessionSnapshot)).resolves.toEqual({ allowed: false });
    await expect(resolveGhostAtResourceWorkingDir({ sessionId: 'missing' }, getSessionSnapshot))
      .resolves.toEqual({ allowed: false });
    await expect(resolveGhostAtResourceWorkingDir({ workingDir: '/draft/repo' }, getSessionSnapshot))
      .resolves.toEqual({ allowed: false });
    await expect(resolveGhostAtResourceWorkingDir({}, getSessionSnapshot))
      .resolves.toEqual({ allowed: false });
  });

  it('lists eligible metadata without dispatching a tool', () => {
    const harness = deps();
    expect(listGhostAtResourceProviders(harness, '/repo')).toEqual([
      { ghostId: 'issues', name: 'Issue Tracker' },
    ]);
    expect(harness.callTool).not.toHaveBeenCalled();
  });

  it('fails closed when disabled, workdir-disabled or setup is not ready', async () => {
    const disabled = deps({ listGhosts: () => [ghost({ enabled: false })] });
    const workdirDisabled = deps({ isDisabledForWorkdir: () => true });
    const setupRequired = deps({
      getSetupAssessment: () => ({ state: 'required', revision: 1, groups: [] }),
    });

    expect(listGhostAtResourceProviders(disabled)).toEqual([]);
    expect(listGhostAtResourceProviders(workdirDisabled, '/repo')).toEqual([]);
    await expect(queryGhostAtResources(setupRequired, { ghostId: 'issues' })).resolves
      .toMatchObject({ success: false });
    expect(setupRequired.callTool).not.toHaveBeenCalled();
  });

  it('dispatches only the fixed query contract with a short host timeout', async () => {
    const harness = deps();
    const result = await queryGhostAtResources(harness, {
      ghostId: 'issues',
      query: `  login\n${'x'.repeat(200)}`,
      limit: 100,
    });

    expect(harness.callTool).toHaveBeenCalledWith({
      ghostId: 'issues',
      tool: 'search_issues',
      args: { query: `login ${'x'.repeat(122)}`, limit: 20 },
      timeoutMs: GHOST_AT_RESOURCE_QUERY_TIMEOUT_MS,
    });
    expect(result).toMatchObject({
      success: true,
      pluginName: 'Issue Tracker',
      items: [{
        id: 'ISSUE-1',
        label: 'Fix login',
        description: 'Open issue',
      }],
    });
    expect(result.items[0]?.href).toBe(
      'cindy://plugin-resource/issues/search_issues/ISSUE-1',
    );
  });

  it('drops malformed, duplicate and excess result rows', async () => {
    const harness = deps({
      callTool: vi.fn(async () => ({
        ok: true as const,
        result: {
          items: [
            { id: 'A', label: 'First' },
            { id: 'A', label: 'Duplicate' },
            { id: 'BAD\u0000', label: 'Control' },
            { id: 'B', label: '' },
            { id: '😀'.repeat(128), label: 'Encoded href too long' },
            { id: 'C', label: 'Third' },
          ],
        },
      })),
    });
    const result = await queryGhostAtResources(harness, { ghostId: 'issues', limit: 2 });
    expect(result.success && result.items.map((item) => item.id)).toEqual(['A', 'C']);
    expect(result.truncated).toBe(true);
  });

  it('allows one running query per Plugin and coalesces pending work to the latest query', async () => {
    const deliveries: Array<(result: { ok: true; result: unknown }) => void> = [];
    const callTool = vi.fn(() => new Promise<{ ok: true; result: unknown }>((resolve) => {
      deliveries.push(resolve);
    }));
    const scheduler = new GhostAtResourceQueryScheduler(deps({ callTool }));

    const first = scheduler.query('window-1:session-1', { ghostId: 'issues', query: 'first' });
    const superseded = scheduler.query('window-1:session-1', { ghostId: 'issues', query: 'second' });
    const latest = scheduler.query('window-1:session-1', { ghostId: 'issues', query: 'latest' });
    expect(callTool).toHaveBeenCalledTimes(1);
    await expect(superseded).resolves.toMatchObject({
      success: false,
      error: 'Plugin resource search superseded',
    });

    deliveries[0]({ ok: true, result: { items: [] } });
    await expect(first).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    expect(callTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      args: { query: 'latest', limit: 20 },
    }));
    deliveries[1]({ ok: true, result: { items: [] } });
    await expect(latest).resolves.toMatchObject({ success: true });
  });

  it('does not coalesce the same Plugin across window/task scopes', async () => {
    const deliveries: Array<(result: { ok: true; result: unknown }) => void> = [];
    const callTool = vi.fn(() => new Promise<{ ok: true; result: unknown }>((resolve) => {
      deliveries.push(resolve);
    }));
    const scheduler = new GhostAtResourceQueryScheduler(deps({ callTool }));

    const first = scheduler.query('window-1:session-1', { ghostId: 'issues', query: 'one' });
    const second = scheduler.query('window-2:session-2', { ghostId: 'issues', query: 'two' });
    expect(callTool).toHaveBeenCalledTimes(2);
    deliveries[0]({ ok: true, result: { items: [] } });
    deliveries[1]({ ok: true, result: { items: [] } });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
