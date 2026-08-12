import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitSnapshotCoordinator,
  type GitSnapshotCoordinatorDeps,
} from '../git-snapshot/gitSnapshotCoordinator';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';
import type {
  CreateShadowSavepointInput,
  ShadowSavepointResult,
} from '../git-snapshot/gitSnapshotService';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function savepointResult(
  commit: string | null,
  skippedPaths: string[] = [],
  fingerprintSeed = 1,
  ctimeSeed = fingerprintSeed,
): ShadowSavepointResult {
  return {
    commit,
    tree: 'tree1',
    includedFiles: [],
    skippedFiles: skippedPaths.map((path) => ({
      path,
      reason: 'sensitive-path' as const,
    })),
    skippedFingerprints: skippedPaths.map((path) => ({
      path,
      sizeBytes: 100 * fingerprintSeed,
      mtimeMs: 1_000 * fingerprintSeed,
      ctimeMs: 2_000 * ctimeSeed,
      ino: 10 * ctimeSeed,
    })),
  };
}

function makeDeps(overrides: Partial<GitSnapshotCoordinatorDeps> = {}): GitSnapshotCoordinatorDeps {
  return {
    readAutoSnapshotEnabled: () => true,
    detectRepoRoot: vi.fn().mockResolvedValue('/repo'),
    getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'claude-code' }),
    resolveAnchor: vi.fn().mockResolvedValue('msg-1'),
    getLastUserPrompt: vi.fn().mockResolvedValue('update login'),
    createShadowSavepoint: vi.fn().mockResolvedValue(savepointResult('hash1')),
    createShadowMarker: vi.fn().mockResolvedValue('marker1'),
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
  it('creates a turn-start baseline and an after-edit savepoint for a full turn', async () => {
    const deps = makeDeps();
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    expect(deps.createShadowSavepoint).toHaveBeenNthCalledWith(1, '/repo', {
      sessionId: 's1',
      label: '本轮开始时的工作区基线',
      meta: { kind: 'turn-start', anchor: 'msg-1' },
    });
    const [repoPath, afterEditInput] = vi.mocked(deps.createShadowSavepoint).mock.calls[1] as [
      string,
      CreateShadowSavepointInput,
    ];
    expect(repoPath).toBe('/repo');
    expect(afterEditInput.sessionId).toBe('s1');
    expect(afterEditInput.meta).toMatchObject({
      kind: 'after-edit',
      anchor: 'msg-1',
      baselineCommit: 'hash1',
    });
    expect(afterEditInput.skipIfTreeEquals).toBe('hash1');
    expect(typeof afterEditInput.label).toBe('function');
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('unconditionally creates a turn-start baseline even without pending changes', async () => {
    // Shadow 链上的 turn-start 是每轮统一的恢复基线:clean 工作区也要建。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
    expect(deps.resolveAnchor).toHaveBeenCalledOnce();
    expect(deps.getLastUserPrompt).toHaveBeenCalledOnce();
    expect(deps.logger.info).toHaveBeenCalledWith(
      '[git-snapshot] turn-start baseline created',
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
    expect(deps.createShadowSavepoint).toHaveBeenCalledWith(
      '/new-project',
      expect.objectContaining({
        sessionId: 's1',
        meta: expect.objectContaining({ kind: 'turn-start' }),
      }),
    );
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
    expect(deps.createShadowSavepoint).not.toHaveBeenCalled();
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('does not retroactively disable after-edit snapshots for a turn that started enabled', async () => {
    let enabled = true;
    const deps = makeDeps({
      readAutoSnapshotEnabled: vi.fn(() => enabled),
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    enabled = false;
    await coordinator.onTurnEnd('s1');

    expect(deps.readAutoSnapshotEnabled).toHaveBeenCalledOnce();
    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    const [, input] = vi.mocked(deps.createShadowSavepoint).mock.calls[1] as [
      string,
      CreateShadowSavepointInput,
    ];
    expect(input.sessionId).toBe('s1');
    expect(input.meta).toMatchObject({ kind: 'after-edit', anchor: 'msg-1', baselineCommit: 'hash1' });
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('appends a rewind gap marker when the Codex turn-start baseline fails', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockRejectedValueOnce(new Error('git conflict'))
        .mockResolvedValueOnce(savepointResult('hash-after')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    // turn-start 失败即缺基线:after-edit 不再尝试,只补 gap marker。
    expect(deps.createShadowSavepoint).toHaveBeenCalledOnce();
    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn-start baseline unavailable',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
    expect(deps.logger.debug).toHaveBeenCalledWith(
      '[git-snapshot] missing turn-start baseline, skip',
      { sessionId: 's1', repoRoot: '/repo' },
    );
  });

  it('treats a turn-start savepoint without a commit as a missing baseline', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn().mockResolvedValue(savepointResult(null)),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[git-snapshot] turn-start baseline missing commit',
      { sessionId: 's1', repoRoot: '/repo' },
    );
    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn-start baseline unavailable',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
  });

  it('appends a rewind gap marker when the turn introduces newly filtered paths', async () => {
    // 本轮新出现的被过滤文件(如 Agent 写入 .env):其改动没进任何快照,
    // 覆盖本轮的回退必须降级,链上补 gap 标记。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1'))
        .mockResolvedValueOnce(savepointResult('hash2', ['.env'])),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn changes were partially filtered',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
  });

  it('appends a rewind gap marker when a baseline-filtered path leaves the filter set', async () => {
    // turn-start 时被过滤的文件(如 11MB untracked)本轮被缩小到可纳入快照:
    // 基线树里没有它的原始内容,回退会删掉/覆盖它且无法恢复 → 必须打 gap。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1', ['big.bin']))
        .mockResolvedValueOnce(savepointResult('hash2')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn changes were partially filtered',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
  });

  it('does not append a gap marker for filtered paths that predate the turn unchanged', async () => {
    // session 全程躺着一个大文件/敏感文件(两端都 skip 且 lstat 指纹一致):
    // 不是本轮改动,不打 gap,否则常驻 dirty 的过滤文件会永久禁用文件回退。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1', ['big.bin']))
        .mockResolvedValueOnce(savepointResult('hash2', ['big.bin'])),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('appends a rewind gap marker when a persistently filtered file changes fingerprint', async () => {
    // 两端都被过滤但 lstat 指纹变化(如超限文件被 Agent 重写后仍超限):
    // 该轮改动没有任何快照可恢复,必须打 gap。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1', ['big.bin'], 1))
        .mockResolvedValueOnce(savepointResult('hash2', ['big.bin'], 2)),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn changes were partially filtered',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
  });

  it('skips the filtered-paths gap marker for agents that do not consume the chain', async () => {
    const deps = makeDeps({
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1'))
        .mockResolvedValueOnce(savepointResult('hash2', ['.env'])),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('appends a rewind gap marker when a persistent filter entry changes only ctime/inode', async () => {
    // 等长且保留 mtime 的改写(或 replace-by-rename):size/mtime 全同,
    // 只有 ctime/inode 变——必须同样打 gap。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1', ['big.bin'], 1, 1))
        .mockResolvedValueOnce(savepointResult('hash2', ['big.bin'], 1, 2)),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn changes were partially filtered',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
  });

  it('degrades overlapping turns of different sessions on the same repo to gaps', async () => {
    // 同一仓库上两个 session 并发跑 turn:全工作区树无法归属改动,
    // 双方的 after-edit 都必须降级为 gap 标记。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnStart('s2');
    await coordinator.onTurnEnd('s2');
    await coordinator.onTurnEnd('s1');

    // 只有两次 turn-start,零 after-edit。
    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    expect(deps.createShadowMarker).toHaveBeenCalledTimes(2);
    for (const sid of ['s1', 's2']) {
      expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
        sessionId: sid,
        label: 'File rewind gap: concurrent session activity in the same repository',
        meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
      });
    }
  });

  it('keeps sequential turns of different sessions on the same repo unaffected', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');
    await coordinator.onTurnStart('s2');
    await coordinator.onTurnEnd('s2');

    // 两轮各自 turn-start + after-edit,无 gap。
    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(4);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('unregisters in-flight turn records when the session is closed mid-turn', async () => {
    // s1 开了 turn 却在 done/error 前被关闭(运行中切 Agent / 宿主回收):
    // onSessionClosed 必须注销同仓并发记账,否则悬空 record 会让 s2 之后的
    // 每一轮都被误判为并发、永久降级为 gap。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    coordinator.onSessionClosed('s1');
    await coordinator.onTurnStart('s2');
    await coordinator.onTurnEnd('s2');

    // s1 turn-start + s2 turn-start + s2 after-edit,零 gap 标记。
    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(3);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('does not treat concurrent turns on different repos as overlapping', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockImplementation(async (sessionId: string) => ({
        workingDir: sessionId === 's1' ? '/repo-a' : '/repo-b',
        agentKind: 'codex',
      })),
      detectRepoRoot: vi.fn().mockImplementation(async (dir: string) => dir),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnStart('s2');
    await coordinator.onTurnEnd('s1');
    await coordinator.onTurnEnd('s2');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(4);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('appends a rewind gap marker when the after-edit savepoint itself fails', async () => {
    // turn-start 成功、after-edit 失败:该轮增量没有记录,后续轮次的回退会用
    // 更晚的 baseline 做部分恢复——必须像缺基线一样在链上截断。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1'))
        .mockRejectedValueOnce(new Error('index locked')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: after-edit savepoint failed',
      meta: { kind: 'rewind-blocked', anchor: 'msg-1' },
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[git-snapshot] after-edit savepoint failed',
      expect.objectContaining({ sessionId: 's1', repoRoot: '/repo', error: 'index locked' }),
    );
  });

  it('skips the after-edit failure gap marker for agents that do not consume the chain', async () => {
    const deps = makeDeps({
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash1'))
        .mockRejectedValueOnce(new Error('index locked')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('marks Codex turns as rewind-blocked when the turn-start baseline is missing', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
    });

    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(deps.createShadowSavepoint).not.toHaveBeenCalled();
    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn-start baseline unavailable',
      meta: { kind: 'rewind-blocked' },
    });
    expect(deps.resolveAnchor).not.toHaveBeenCalled();
    expect(deps.getLastUserPrompt).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      '[git-snapshot] missing turn-start baseline, skip',
      { sessionId: 's1', repoRoot: '/repo' },
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      '[git-snapshot] rewind gap marker created',
      expect.objectContaining({ sessionId: 's1', repoRoot: '/repo', commit: 'marker1' }),
    );
  });

  it('marks pi turns as rewind-blocked when the turn-start baseline is missing', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'pi' }),
    });

    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(deps.createShadowSavepoint).not.toHaveBeenCalled();
    expect(deps.createShadowMarker).toHaveBeenCalledWith('/repo', {
      sessionId: 's1',
      label: 'File rewind gap: turn-start baseline unavailable',
      meta: { kind: 'rewind-blocked' },
    });
  });

  it('skips the rewind gap marker for agents that do not consume the savepoint chain', async () => {
    // 默认 agentKind 为 claude-code:缺基线只打 debug 日志,不建 marker,
    // 也不提前解析可选 metadata。
    const deps = makeDeps();

    await new GitSnapshotCoordinator(deps).onTurnEnd('s1');

    expect(deps.createShadowSavepoint).not.toHaveBeenCalled();
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
    expect(deps.resolveAnchor).not.toHaveBeenCalled();
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
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    const turnStart = coordinator.onTurnStart('s1');
    await waitFor(() => Boolean(releaseContext));
    const turnEnd = coordinator.onTurnEnd('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.createShadowSavepoint).not.toHaveBeenCalled();
    releaseContext?.();
    await Promise.all([turnStart, turnEnd]);

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    const [, afterEditInput] = vi.mocked(deps.createShadowSavepoint).mock.calls[1] as [
      string,
      CreateShadowSavepointInput,
    ];
    expect(afterEditInput.meta.kind).toBe('after-edit');
    expect(afterEditInput.meta.baselineCommit).toBe('hash1');
  });

  it('keeps overlapping turn-start baselines isolated by turn order', async () => {
    let releaseFirstBaseline: (() => void) | undefined;
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockImplementationOnce(() =>
          new Promise<ShadowSavepointResult>((resolve) => {
            releaseFirstBaseline = () => resolve(savepointResult('hash-t1'));
          }),
        )
        .mockResolvedValueOnce(savepointResult('hash-a1'))
        .mockResolvedValueOnce(savepointResult('hash-t2'))
        .mockResolvedValue(savepointResult('hash-a2')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    const turnStart1 = coordinator.onTurnStart('s1');
    await waitFor(() => Boolean(releaseFirstBaseline));
    const turnEnd1 = coordinator.onTurnEnd('s1');
    const turnStart2 = coordinator.onTurnStart('s1');

    await new Promise((resolve) => setTimeout(resolve, 20));
    // 第一轮 turn-start 尚未完成:同 repo 写队列挡住后续所有保存点写入。
    expect(deps.createShadowSavepoint).toHaveBeenCalledOnce();
    expect(deps.createShadowMarker).not.toHaveBeenCalled();

    releaseFirstBaseline?.();
    await Promise.all([turnStart1, turnStart2, turnEnd1]);

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(3);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();

    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(4);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
    const calls = vi.mocked(deps.createShadowSavepoint).mock.calls as unknown as [
      string,
      CreateShadowSavepointInput,
    ][];
    // 两个 after-edit 各自绑定所属轮次的 turn-start 基线。
    expect(calls[1][1].meta).toMatchObject({ kind: 'after-edit', baselineCommit: 'hash-t1' });
    expect(calls[1][1].skipIfTreeEquals).toBe('hash-t1');
    expect(calls[3][1].meta).toMatchObject({ kind: 'after-edit', baselineCommit: 'hash-t2' });
    expect(calls[3][1].skipIfTreeEquals).toBe('hash-t2');
  });

  it('consumes an aborted turn baseline before the next successful turn', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash-t1'))
        .mockResolvedValueOnce(savepointResult('hash-t2'))
        .mockResolvedValue(savepointResult('hash-a')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    coordinator.onTurnAbort('s1');
    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(3);
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
    const [, afterEditInput] = vi.mocked(deps.createShadowSavepoint).mock.calls[2] as [
      string,
      CreateShadowSavepointInput,
    ];
    // 被中止轮次的基线已消费:after-edit 绑定第二轮的 turn-start。
    expect(afterEditInput.meta).toMatchObject({ kind: 'after-edit', baselineCommit: 'hash-t2' });
  });

  it('uses the turn-start anchor and prompt for the matching after-edit savepoint', async () => {
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      resolveAnchor: vi.fn().mockResolvedValueOnce('msg-1').mockResolvedValueOnce('msg-2'),
      getLastUserPrompt: vi.fn().mockResolvedValueOnce('first prompt').mockResolvedValueOnce('second prompt'),
      createShadowSavepoint: vi.fn().mockImplementation(
        async (_repo: string, input: CreateShadowSavepointInput) => {
          if (typeof input.label === 'function') {
            await input.label({ diffStat: ' a.ts | 1 +', diffText: '+x' });
          }
          return savepointResult('hash');
        },
      ),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.resolveAnchor).toHaveBeenCalledOnce();
    expect(deps.getLastUserPrompt).toHaveBeenCalledOnce();
    const [, afterEditInput] = vi.mocked(deps.createShadowSavepoint).mock.calls[1] as [
      string,
      CreateShadowSavepointInput,
    ];
    expect(afterEditInput.sessionId).toBe('s1');
    expect(afterEditInput.meta).toMatchObject({ kind: 'after-edit', anchor: 'msg-1' });
    expect(deps.oneShot).toHaveBeenCalledWith('codex', expect.stringContaining('first prompt'));
    expect(deps.oneShot).not.toHaveBeenCalledWith('codex', expect.stringContaining('second prompt'));
  });

  it('only logs a debug skip when the worktree is unchanged since turn start', async () => {
    const deps = makeDeps({
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash-t1'))
        .mockResolvedValueOnce(savepointResult(null)),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await coordinator.onTurnEnd('s1');

    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(2);
    const [, afterEditInput] = vi.mocked(deps.createShadowSavepoint).mock.calls[1] as [
      string,
      CreateShadowSavepointInput,
    ];
    expect(afterEditInput.skipIfTreeEquals).toBe('hash-t1');
    expect(deps.logger.debug).toHaveBeenCalledWith(
      '[git-snapshot] worktree unchanged since turn start, skip',
      { sessionId: 's1', repoRoot: '/repo' },
    );
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      '[git-snapshot] after-edit savepoint created',
      expect.anything(),
    );
    expect(deps.createShadowMarker).not.toHaveBeenCalled();
  });

  it('treats non-git dirs as best-effort no-op and does not cache null roots', async () => {
    const deps = makeDeps({
      detectRepoRoot: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('/repo'),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await expect(coordinator.onTurnStart('s1')).resolves.toBeUndefined();
    await expect(coordinator.onTurnStart('s1')).resolves.toBeUndefined();

    expect(deps.detectRepoRoot).toHaveBeenCalledTimes(2);
    expect(deps.createShadowSavepoint).toHaveBeenCalledOnce();
  });

  it('swallows savepoint failures and logs a warning', async () => {
    const deps = makeDeps({
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash-t1'))
        .mockRejectedValueOnce(new Error('git lock')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await expect(coordinator.onTurnEnd('s1')).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[git-snapshot] after-edit savepoint failed',
      expect.objectContaining({ sessionId: 's1', error: 'git lock' }),
    );
  });

  it('swallows gap marker failures without breaking the turn', async () => {
    // after-edit 失败 → 补 gap marker,marker 也失败 → 由外层 onTurnEnd 吞掉。
    const deps = makeDeps({
      getSessionContext: vi.fn().mockResolvedValue({ workingDir: '/repo', agentKind: 'codex' }),
      createShadowSavepoint: vi.fn()
        .mockResolvedValueOnce(savepointResult('hash-t1'))
        .mockRejectedValueOnce(new Error('git lock')),
      createShadowMarker: vi.fn().mockRejectedValue(new Error('marker failed')),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    await expect(coordinator.onTurnEnd('s1')).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[git-snapshot] onTurnEnd failed (swallowed)',
      expect.objectContaining({ sessionId: 's1', error: 'marker failed' }),
    );
  });

  it('serializes concurrent savepoints for the same repo', async () => {
    let active = 0;
    let maxActive = 0;
    const deps = makeDeps({
      createShadowSavepoint: vi.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return savepointResult('hash');
      }),
    });

    const coordinator = new GitSnapshotCoordinator(deps);
    await Promise.all([
      coordinator.onTurnStart('s1'),
      coordinator.onTurnStart('s2'),
      coordinator.onTurnStart('s3'),
    ]);

    expect(maxActive).toBe(1);
    expect(deps.createShadowSavepoint).toHaveBeenCalledTimes(3);
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
    const turnStart = new GitSnapshotCoordinator(deps).onTurnStart('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.createShadowSavepoint).not.toHaveBeenCalled();
    release?.();
    await Promise.all([blocker, turnStart]);
    expect(deps.createShadowSavepoint).toHaveBeenCalledOnce();
  });

  it('passes the label factory into createShadowSavepoint without eager evaluation', async () => {
    let label = '';
    const deps = makeDeps({
      createShadowSavepoint: vi
        .fn()
        .mockImplementation(async (_repo: string, input: CreateShadowSavepointInput) => {
          if (typeof input.label !== 'function') {
            return savepointResult('hash-t1');
          }
          // after-edit 的 label 是 factory:oneShot 延迟到内核调用时才发生。
          expect(deps.oneShot).not.toHaveBeenCalled();
          label = await input.label({ diffStat: ' a.ts | 1 +', diffText: '+x' });
          return savepointResult('hash-after');
        }),
    });
    const coordinator = new GitSnapshotCoordinator(deps);

    await coordinator.onTurnStart('s1');
    expect(deps.oneShot).not.toHaveBeenCalled();
    await coordinator.onTurnEnd('s1');

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
