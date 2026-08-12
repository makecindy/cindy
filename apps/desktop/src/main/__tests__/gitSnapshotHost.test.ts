import { describe, expect, it, vi } from 'vitest';

import { createGitSnapshotCoordinator } from '../maker-host/git-snapshot-host';
import type {
  CreateShadowSavepointInput,
  ShadowSavepointResult,
} from '../git-snapshot/gitSnapshotService';

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
  it('creates a local after-edit savepoint with anchor and prompt context', async () => {
    const maker = makeMaker();
    const getLatestUserMessage = vi.fn().mockResolvedValue({
      clientId: 'msg-1',
      text: 'please update login',
    });
    const createShadowSavepoint = vi.fn().mockImplementation(
      async (_repo: string, input: CreateShadowSavepointInput): Promise<ShadowSavepointResult> => {
        if (typeof input.label === 'function') {
          await input.label({ diffStat: ' src/a.ts | 1 +', diffText: '+x' });
        }
        return {
          commit: 'hash123',
          tree: 'tree123',
          includedFiles: [],
          skippedFiles: [],
          skippedFingerprints: [],
        };
      },
    );
    const coordinator = createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: () => true,
      detectRepoRoot: vi.fn().mockResolvedValue('/workspace/project'),
      getLatestUserMessage,
      createShadowSavepoint,
      logger,
    });

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    // turn-start 基线 + after-edit 各一次。
    expect(createShadowSavepoint).toHaveBeenCalledTimes(2);
    const [repoRoot, input] = createShadowSavepoint.mock.calls[1] as [
      string,
      CreateShadowSavepointInput,
    ];
    expect(repoRoot).toBe('/workspace/project');
    expect(input.sessionId).toBe('s1');
    expect(input.meta).toMatchObject({
      kind: 'after-edit',
      anchor: 'msg-1',
      baselineCommit: 'hash123',
    });
    expect(input.skipIfTreeEquals).toBe('hash123');
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
    const createShadowSavepoint = vi.fn();

    await createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: () => true,
      detectRepoRoot,
      createShadowSavepoint,
      logger,
    }).onTurnEnd('s1');

    expect(detectRepoRoot).not.toHaveBeenCalled();
    expect(createShadowSavepoint).not.toHaveBeenCalled();
  });

  it('skips sessions without a working directory', async () => {
    const maker = makeMaker({
      getSessionMeta: vi.fn().mockResolvedValue({ agentKind: 'claude-code', workDir: '' }),
    });
    const detectRepoRoot = vi.fn().mockResolvedValue('/repo');
    const createShadowSavepoint = vi.fn();

    await createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: () => true,
      detectRepoRoot,
      createShadowSavepoint,
      logger,
    }).onTurnEnd('s1');

    expect(detectRepoRoot).not.toHaveBeenCalled();
    expect(createShadowSavepoint).not.toHaveBeenCalled();
  });

  it('passes the turn-start Git safety decision into project bootstrap', async () => {
    let enabled = true;
    const maker = makeMaker();
    const initializeProjectGit = vi.fn().mockResolvedValue({ repoRoot: '/workspace/project' });
    const createShadowSavepoint = vi.fn().mockResolvedValue({
      commit: 'hash-t1',
      tree: 'tree-t1',
      includedFiles: [],
      skippedFiles: [],
      skippedFingerprints: [],
    } satisfies ShadowSavepointResult);
    const coordinator = createGitSnapshotCoordinator(maker, {
      readAutoSnapshotEnabled: vi.fn(() => enabled),
      detectRepoRoot: vi.fn().mockResolvedValue(null),
      initializeProjectGit,
      createShadowSavepoint,
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
    expect(createShadowSavepoint).toHaveBeenCalledWith(
      '/workspace/project',
      expect.objectContaining({
        sessionId: 's1',
        meta: expect.objectContaining({ kind: 'turn-start' }),
      }),
    );
  });

  it('defaults to disabled until a host setting enables it', async () => {
    const maker = makeMaker();
    const createShadowSavepoint = vi.fn();

    await createGitSnapshotCoordinator(maker, {
      createShadowSavepoint,
      logger,
    }).onTurnEnd('s1');

    expect(maker.getSessionMeta).not.toHaveBeenCalled();
    expect(createShadowSavepoint).not.toHaveBeenCalled();
  });
});
