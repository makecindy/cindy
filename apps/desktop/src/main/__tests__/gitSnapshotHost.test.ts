import { describe, expect, it, vi } from 'vitest';

import { createGitSnapshotCoordinator } from '../maker-host/git-snapshot-host';
import type { CreateSnapshotInput } from '../git-snapshot/gitSnapshotService';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeMaker(overrides: Partial<{
  getSessionMeta: ReturnType<typeof vi.fn>;
  oneShot: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getSessionMeta: vi.fn().mockResolvedValue({
      id: 's1',
      agentKind: 'codex',
      workDir: '/workspace/project',
      title: 'T',
      model: 'gpt-5.4',
      createdAt: 1,
      updatedAt: 1,
    }),
    oneShot: vi.fn().mockResolvedValue('更新登录逻辑'),
    ...overrides,
  };
}

describe('createGitSnapshotCoordinator', () => {
  it('creates a local after-edit snapshot with anchor and prompt context', async () => {
    const maker = makeMaker();
    const getLatestUserMessage = vi.fn().mockResolvedValue({
      clientId: 'msg-1',
      text: 'please update login',
    });
    const createSnapshot = vi.fn().mockImplementation(
      async (_repo: string, input: CreateSnapshotInput) => {
        if (typeof input.label === 'function') {
          await input.label({ diffStat: ' src/a.ts | 1 +', diffText: '+x' });
        }
        return 'hash123';
      },
    );
    const isWorktreeDirty = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const coordinator = createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: () => true,
      detectRepoRoot: vi.fn().mockResolvedValue('/workspace/project'),
      isWorktreeDirty,
      getLatestUserMessage,
      createSnapshot,
      logger,
    });

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(isWorktreeDirty).toHaveBeenCalledTimes(2);
    expect(createSnapshot).toHaveBeenCalledOnce();
    const [repoRoot, input] = createSnapshot.mock.calls[0] as [string, CreateSnapshotInput];
    expect(repoRoot).toBe('/workspace/project');
    expect(input.meta).toMatchObject({ sessionId: 's1', kind: 'after-edit', anchor: 'msg-1' });
    expect(getLatestUserMessage).toHaveBeenCalledOnce();
    expect(maker.oneShot).toHaveBeenCalledWith('codex', expect.stringContaining('please update login'), {
      maxTokens: 80,
      timeoutMs: 20_000,
    });
  });

  it('skips remote sessions before repo detection', async () => {
    const maker = makeMaker({
      getSessionMeta: vi.fn().mockResolvedValue({
        agentKind: 'codex',
        workDir: '/remote/repo',
        remoteHostId: 'host-1',
      }),
    });
    const detectRepoRoot = vi.fn().mockResolvedValue('/remote/repo');
    const createSnapshot = vi.fn();

    await createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: () => true,
      detectRepoRoot,
      createSnapshot,
      logger,
    }).onTurnEnd('s1');

    expect(detectRepoRoot).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it('skips sessions without a working directory', async () => {
    const maker = makeMaker({
      getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'claude-code', workDir: '' }),
    });
    const detectRepoRoot = vi.fn().mockResolvedValue('/repo');
    const createSnapshot = vi.fn();

    await createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: () => true,
      detectRepoRoot,
      createSnapshot,
      logger,
    }).onTurnEnd('s1');

    expect(detectRepoRoot).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it('passes the turn-start Git safety decision into project bootstrap', async () => {
    let enabled = true;
    const maker = makeMaker();
    const initializeProjectGit = vi.fn().mockResolvedValue({ repoRoot: '/workspace/project' });
    const isWorktreeDirty = vi.fn().mockResolvedValue(false);
    const coordinator = createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: vi.fn(() => enabled),
      detectRepoRoot: vi.fn().mockResolvedValue(null),
      initializeProjectGit,
      isWorktreeDirty,
      logger,
    });

    await coordinator.onTurnStart('s1');
    enabled = false;
    await coordinator.onTurnEnd('s1');

    expect(initializeProjectGit).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        workingDir: '/workspace/project',
        remoteHostId: undefined,
      }),
      { autoSnapshotEnabled: true },
    );
    expect(isWorktreeDirty).toHaveBeenCalledWith('/workspace/project');
  });

  it('defaults to disabled until a host setting enables it', async () => {
    const maker = makeMaker();
    const createSnapshot = vi.fn();

    await createGitSnapshotCoordinator(maker, {
      createSnapshot,
      logger,
    }).onTurnEnd('s1');

    expect(maker.getSessionMeta).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
