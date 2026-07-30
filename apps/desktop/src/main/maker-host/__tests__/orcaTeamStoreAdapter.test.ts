import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDesktopOrcaTeamStoreAdapter,
  type DesktopOrcaTeamStoreAdapterDeps,
} from '../orcaTeamStoreAdapter.js';
import type { OrcaWorkerLinkRecord } from '../../localDb/orcaTeamStore.js';

const workerLink: OrcaWorkerLinkRecord = {
  workerId: 'worker-1',
  teamId: 'team-1',
  workerSessionId: 'worker-session-1',
  leadSessionId: 'lead-session-1',
  leadSession: {
    sessionId: 'lead-session-1',
    agentKind: 'claude-code',
    workingDir: 'E:\\workspace',
    model: 'claude-sonnet-4-6',
    providerId: 'anthropic',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    fastMode: false,
    sdkSessionId: 'sdk-lead-1',
    title: 'Lead session',
    remoteHostId: 'host-remote-1',
  },
};

function createDeps(
  link: typeof workerLink | null = workerLink,
): DesktopOrcaTeamStoreAdapterDeps {
  return {
    getWorkerLink: vi.fn(async () => link),
    updateWorkerStatus: vi.fn(async () => undefined),
    markKnownOrcaWorkerSession: vi.fn(),
    broadcastOrcaWorkerChanged: vi.fn(),
    logger: { debug: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maker host orca team store adapter', () => {
  it('maps DB worker links for orca bridge and registers known worker sessions', async () => {
    const deps = createDeps();
    const adapter = createDesktopOrcaTeamStoreAdapter(deps);

    await expect(adapter.getWorkerLink({ workerId: 'worker-1' })).resolves.toEqual({
      workerId: 'worker-1',
      teamId: 'team-1',
      workflowId: 'team-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-session-1',
      leadSession: {
        sessionId: 'lead-session-1',
        agentKind: 'claude-code',
        workingDir: 'E:\\workspace',
        model: 'claude-sonnet-4-6',
        providerId: 'anthropic',
        effort: 'medium',
        permissionMode: 'acceptEdits',
        fastMode: false,
        sdkSessionId: 'sdk-lead-1',
        title: 'Lead session',
        // DB 带出的 host id 必须透传进 bridge 快照 (rehydrate 要用)。
        remoteHostId: 'host-remote-1',
      },
    });
    expect(deps.markKnownOrcaWorkerSession).toHaveBeenCalledWith('worker-session-1');
  });

  it('broadcasts ORCA_WORKER_CHANGED after worker status updates with a live link', async () => {
    const deps = createDeps();
    const adapter = createDesktopOrcaTeamStoreAdapter(deps);

    await adapter.updateWorkerStatus('worker-1', 'running');

    expect(deps.updateWorkerStatus).toHaveBeenCalledWith('worker-1', 'running');
    expect(deps.getWorkerLink).toHaveBeenCalledWith({ workerId: 'worker-1' });
    expect(deps.broadcastOrcaWorkerChanged).toHaveBeenCalledWith('lead-session-1');
    expect(deps.logger.debug).not.toHaveBeenCalled();
  });

  it('logs and skips ORCA_WORKER_CHANGED when the worker link is gone', async () => {
    const deps = createDeps(null);
    const adapter = createDesktopOrcaTeamStoreAdapter(deps);

    await adapter.updateWorkerStatus('worker-missing', 'idle');

    expect(deps.updateWorkerStatus).toHaveBeenCalledWith('worker-missing', 'idle');
    expect(deps.broadcastOrcaWorkerChanged).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'orcaTeamStoreAdapter.updateWorkerStatus: worker link 未找到，跳过 ORCA_WORKER_CHANGED 广播',
      { workerId: 'worker-missing' },
    );
  });
});
