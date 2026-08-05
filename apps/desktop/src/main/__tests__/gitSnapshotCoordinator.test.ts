import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitSnapshotCoordinator,
  type GitSnapshotCoordinatorDeps,
} from '../git-snapshot/gitSnapshotCoordinator';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';
import type { CreateSnapshotInput } from '../git-snapshot/gitSnapshotService';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeDeps(overrides: Partial<GitSnapshotCoordinatorDeps> = {}): GitSnapshotCoordinatorDeps {
  return {
    readAutoSnapshotEnabled: () => true,
    detectRepoRoot: vi.fn().mockResolvedValue('/repo'),
    isWorktreeDirty: vi.fn().mockResolvedValue(true),
    getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'claude-code' }),
    resolveAnchor: vi.fn().mockResolvedValue('msg-1'),
    getLastUserPrompt: vi.fn().mockResolvedValue('update login'),
    createSnapshot: vi.fn().mockResolvedValue('hash1'),
    createSnapshotMarker: vi.fn().mockResolvedValue('marker1'),
    oneShot: vi.fn().mockResolvedValue('实现登录校验'),
    logger,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

describe('GitSnapshotCoordinator', () => {
  it('creates an after-edit snapshot for a dirty git repo', async () => {
    const deps = makeDeps();
    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(deps.createSnapshot).toHaveBeenCalledOnce();
    const [repoPath, input] = vi.mocked(deps.createSnapshot).mock.calls[0] as [
      string,
      CreateSnapshotInput,
    ];
    expect(repoPath).toBe('/repo');
    expect(input.meta).toMatchObject({ sessionId: 's1', kind: 'after-edit', anchor: 'msg-1' });
    expect(typeof input.label).toBe('function');
  });

  it('creates a before-edit baseline when the repo is dirty at turn start', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn().mockResolvedValue(true),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshot).toHaveBeenNthCalledWith(1, '/repo', {
      label: '本轮开始前的未提交改动',
      meta: { sessionId: 's1', kind: 'before-edit', anchor: 'msg-1' },
    });
    const [, afterEditInput] = vi.mocked(deps.createSnapshot).mock.calls[1] as [
      string,
      CreateSnapshotInput,
    ];
    expect(afterEditInput.meta).toMatchObject({ sessionId: 's1', kind: 'after-edit', anchor: 'msg-1' });
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();
    expect(deps.isWorktreeDirty).toHaveBeenCalledTimes(2);
    expect(deps.resolveAnchor).toHaveBeenCalledOnce();
    expect(deps.getLastUserPrompt).toHaveBeenCalledOnce();
    expect(deps.logger.info).toHaveBeenCalledWith(
      '[git-snapshot] before-edit baseline created',
      expect.objectContaining({ sessionId: 's1', repoRoot: '/repo', commit: 'hash1', anchor: 'msg-1' }),
    );
  });

  it('bootstraps an empty local project after Git safety is enabled', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({
        workingDir: '/new-project',
        agentKind: 'codex',
        workspaceKind: 'project',
        remoteHostId: null,
      }),
      detectRepoRoot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue('/new-project'),
      initializeProjectGit: vi.fn().mockResolvedValue({
        status: 'initialized',
        repoRoot: '/new-project',
      }),
      isWorktreeDirty: vi.fn().mockResolvedValue(false),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');

    expect(deps.initializeProjectGit).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        workingDir: '/new-project',
        workspaceKind: 'project',
        remoteHostId: null,
      }),
      { autoSnapshotEnabled: true },
    );
    expect(deps.detectRepoRoot).toHaveBeenCalledOnce();
    expect(deps.isWorktreeDirty).toHaveBeenCalledWith('/new-project');
    expect(deps.createSnapshot).not.toHaveBeenCalled();
    expect(coordinator.hasPendingTurnStart('s1')).toBe(true);
  });

  it('does not retroactively enable snapshots for a turn that started disabled', async () => {
    let enabled = false;
    const deps = makeDeps({
      readAutoSnapshotEnabled: vi.fn(() => enabled),
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    enabled = true;
    await coordinator.onTurnEnd('s1');

    expect(deps.readAutoSnapshotEnabled).toHaveBeenCalledOnce();
    expect(deps.detectRepoRoot).not.toHaveBeenCalled();
    expect(deps.isWorktreeDirty).not.toHaveBeenCalled();
    expect(deps.createSnapshot).not.toHaveBeenCalled();
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();
  });

  it('does not retroactively disable after-edit snapshots for a turn that started enabled', async () => {
    let enabled = true;
    const deps = makeDeps({
      readAutoSnapshotEnabled: vi.fn(() => enabled),
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    enabled = false;
    await coordinator.onTurnEnd('s1');

    expect(deps.readAutoSnapshotEnabled).toHaveBeenCalledOnce();
    expect(deps.isWorktreeDirty).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshot).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(deps.createSnapshot).mock.calls[0] as [
      string,
      CreateSnapshotInput,
    ];
    expect(input.meta).toMatchObject({ sessionId: 's1', kind: 'after-edit', anchor: 'msg-1' });
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();
  });

  it('blocks Codex file rewind when a dirty turn-start baseline fails', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn().mockResolvedValue(true),
      createSnapshot: vi.fn()
        .mockRejectedValueOnce(new Error('git conflict'))
        .mockResolvedValueOnce('hash-after'),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createSnapshot).toHaveBeenCalledOnce();
    expect(deps.createSnapshotMarker).toHaveBeenCalledWith('/repo', {
      label: 'Codex rewind unavailable: turn-start baseline failed',
      meta: { sessionId: 's1', kind: 'rewind-blocked', anchor: 'msg-1' },
    });
    expect(deps.logger.debug).toHaveBeenCalledWith(
      '[git-snapshot] before-edit baseline failed, skip',
      { sessionId: 's1', repoRoot: '/repo' },
    );
  });

  it('continues when dirty turn-start files are all skipped by the safety filter', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn().mockResolvedValue(true),
      createSnapshot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('hash-after'),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();
    const [, afterEditInput] = vi.mocked(deps.createSnapshot).mock.calls[1] as [
      string,
      CreateSnapshotInput,
    ];
    expect(afterEditInput.meta.kind).toBe('after-edit');
    expect(deps.logger.debug).toHaveBeenCalledWith(
      '[git-snapshot] no staged turn-start changes after add, skip',
      { sessionId: 's1', repoRoot: '/repo' },
    );
  });

  it('marks Codex turns as rewind-blocked when the turn-start baseline is missing', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });

    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(deps.createSnapshot).not.toHaveBeenCalled();
    expect(deps.createSnapshotMarker).toHaveBeenCalledWith('/repo', {
      label: 'Codex rewind unavailable: missing turn-start baseline',
      meta: { sessionId: 's1', kind: 'rewind-blocked' },
    });
    expect(deps.isWorktreeDirty).not.toHaveBeenCalled();
    expect(deps.resolveAnchor).not.toHaveBeenCalled();
    expect(deps.getLastUserPrompt).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      '[git-snapshot] missing turn-start baseline, skip',
      { sessionId: 's1', repoRoot: '/repo' },
    );
  });

  it('waits for an in-flight turn-start baseline before turn-end snapshotting', async () => {
    let releaseContext: (() => void) | undefined;
    const deps = makeDeps({
      getSessionContext: vi.fn()
        .mockImplementationOnce(() =>
          new Promise((resolve) => {
            releaseContext = () => resolve({ workingDir: '/repo', agentKind: 'codex' });
          }),
        )
        .mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn().mockResolvedValue(true),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    const turnStart = coordinator.onTurnStart('s1');
    await waitFor(() => Boolean(releaseContext));
    const turnEnd = coordinator.onTurnEnd('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.createSnapshot).not.toHaveBeenCalled();
    releaseContext?.();
    await Promise.all([turnStart, turnEnd]);

    expect(deps.isWorktreeDirty).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshot).toHaveBeenCalledTimes(2);
    const [, afterEditInput] = vi.mocked(deps.createSnapshot).mock.calls[1] as [
      string,
      CreateSnapshotInput,
    ];
    expect(afterEditInput.meta.kind).toBe('after-edit');
  });

  it('keeps overlapping turn-start baselines isolated by turn order', async () => {
    let releaseFirstBaseline: (() => void) | undefined;
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn()
        .mockImplementationOnce(() =>
          new Promise<boolean>((resolve) => {
            releaseFirstBaseline = () => resolve(false);
          }),
        )
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    const turnStart1 = coordinator.onTurnStart('s1');
    await waitFor(() => Boolean(releaseFirstBaseline));
    const turnEnd1 = coordinator.onTurnEnd('s1');
    const turnStart2 = coordinator.onTurnStart('s1');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.createSnapshot).not.toHaveBeenCalled();
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();

    releaseFirstBaseline?.();
    await Promise.all([turnStart1, turnStart2, turnEnd1]);

    expect(deps.createSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();

    await coordinator.onTurnEnd('s1');

    expect(deps.createSnapshot).toHaveBeenCalledTimes(3);
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();
    expect(deps.isWorktreeDirty).toHaveBeenCalledTimes(4);
  });

  it('consumes an aborted turn baseline before the next successful turn', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    coordinator.onTurnAbort('s1');
    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshotMarker).not.toHaveBeenCalled();
    expect(deps.isWorktreeDirty).toHaveBeenCalledTimes(3);
  });

  it('uses the turn-start anchor and prompt for the matching after-edit snapshot', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      isWorktreeDirty: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      resolveAnchor: vi.fn().mockResolvedValueOnce('msg-1').mockResolvedValueOnce('msg-2'),
      getLastUserPrompt: vi.fn().mockResolvedValueOnce('first prompt').mockResolvedValueOnce('second prompt'),
      createSnapshot: vi.fn().mockImplementation(async (_repo: string, input: CreateSnapshotInput) => {
        if (typeof input.label === 'function') {
          await input.label({ diffStat: ' a.ts | 1 +', diffText: '+x' });
        }
        return 'hash';
      }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.resolveAnchor).toHaveBeenCalledOnce();
    expect(deps.getLastUserPrompt).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(deps.createSnapshot).mock.calls[0] as [
      string,
      CreateSnapshotInput,
    ];
    expect(input.meta).toMatchObject({ sessionId: 's1', kind: 'after-edit', anchor: 'msg-1' });
    expect(deps.oneShot).toHaveBeenCalledWith('codex', expect.stringContaining('first prompt'));
    expect(deps.oneShot).not.toHaveBeenCalledWith('codex', expect.stringContaining('second prompt'));
  });

  it('creates a snapshot when the repo becomes dirty after a clean turn start', async () => {
    const deps = makeDeps({
      isWorktreeDirty: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.isWorktreeDirty).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshot).toHaveBeenCalledOnce();
  });

  it('skips clean repos before resolving optional metadata', async () => {
    const deps = makeDeps({ isWorktreeDirty: vi.fn().mockResolvedValue(false) });
    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(deps.createSnapshot).not.toHaveBeenCalled();
    expect(deps.resolveAnchor).not.toHaveBeenCalled();
  });

  it('treats non-git dirs as best-effort no-op and does not cache null roots', async () => {
    const deps = makeDeps({
      detectRepoRoot: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('/repo'),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await expect(coordinator.onTurnEnd('s1')).resolves.toBeUndefined();
    await expect(coordinator.onTurnEnd('s1')).resolves.toBeUndefined();

    expect(deps.detectRepoRoot).toHaveBeenCalledTimes(2);
    expect(deps.createSnapshot).toHaveBeenCalledOnce();
  });

  it('swallows snapshot failures and logs a warning', async () => {
    const deps = makeDeps({ createSnapshot: vi.fn().mockRejectedValue(new Error('git lock')) });
    await expect(new GitSnapshotCoordinator(deps).onTurnEnd('s1')).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[git-snapshot] onTurnEnd failed (swallowed)',
      expect.objectContaining({ sessionId: 's1', error: 'git lock' }),
    );
  });

  it('serializes concurrent snapshots for the same repo', async () => {
    let active = 0;
    let maxActive = 0;
    const deps = makeDeps({
      createSnapshot: vi.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return 'hash';
      }),
    });

    const coordinator = new GitSnapshotCoordinator(deps);
    await Promise.all([
      coordinator.onTurnEnd('s1'),
      coordinator.onTurnEnd('s2'),
      coordinator.onTurnEnd('s3'),
    ]);

    expect(maxActive).toBe(1);
    expect(deps.createSnapshot).toHaveBeenCalledTimes(3);
  });

  it('shares the repo write queue with external git write tasks', async () => {
    let release: (() => void) | undefined;
    const blocker = enqueueGitRepoWrite('/repo', () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor(() => Boolean(release));

    const deps = makeDeps();
    const turnEnd = new GitSnapshotCoordinator(deps).onTurnEnd('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.isWorktreeDirty).not.toHaveBeenCalled();
    release?.();
    await Promise.all([blocker, turnEnd]);
    expect(deps.createSnapshot).toHaveBeenCalledOnce();
  });

  it('keeps label generation delayed inside createSnapshot', async () => {
    let label = '';
    const deps = makeDeps({
      createSnapshot: vi
        .fn()
        .mockImplementation(async (_repo: string, input: CreateSnapshotInput) => {
          if (typeof input.label === 'function') {
            label = await input.label({ diffStat: ' a.ts | 1 +', diffText: '+x' });
          }
          return 'hash';
        }),
    });
    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(label).toBe('实现登录校验');
    expect(deps.oneShot).toHaveBeenCalledWith('claude-code', expect.stringContaining('a.ts'));
  });

  it('clears positive repo root cache on session close', async () => {
    const deps = makeDeps();
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnEnd('s1');
    await coordinator.onTurnEnd('s1');
    coordinator.onSessionClosed('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.detectRepoRoot).toHaveBeenCalledTimes(2);
    expect(deps.getSessionContext).toHaveBeenCalledTimes(2);
  });
});
