/**
 * 测试价值
 * - 可观察结果：同一仓库、同一任务，先由桌面绑定（git-snapshot-host.ts）建一轮保存点，再由
 *   Node Host 的装配（apps/host/src/agent/git-snapshot.ts）接着建一轮：四条保存点按时间顺序挂在
 *   同一个 refs/cindy/savepoints/<任务 id> 上，Host 的基线接在桌面的改后快照之后；两边的尝试记录
 *   （SnapshotAttemptStore）落在同一个 owner 目录。
 * - 规则依据：迁移前桌面建的保存点，迁移后 Host 要能接着用（放行表第 7b 行与第三节）。
 * - 最小失败输入：Host 换了引用名、换了尝试记录目录，或从新链开始。
 * - tier：integration（真实 git 与临时目录，不调模型）。停用裁决在两边都按“不可用”，标签走
 *   确定性兜底：桌面这里 mock 掉 live 裁决，只是为了不拉起桌面供应商服务。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../model-route-guard-live.js', () => ({ isAgentOneShotRouteDisabled: async () => true }));

// Real git subprocesses for both savepoint rounds: about 2.7 s alone, and over the 5 s default
// when the full desktop pool loads the machine. An explicit bound, wide enough for that load.
const CHAIN_TIMEOUT_MS = 60_000;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
}).trim();

describe('a savepoint chain the desktop started, continued by the Host', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-snapshot-chain-')));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps one ref, in order, and one owner attempt journal', async () => {
    const profile = path.join(root, 'profile');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(profile);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');

    // Non-literal specifiers keep the Host sources out of the desktop typecheck.
    const hostAuth = '../../../../../host/src/agent/claude-auth.mjs';
    const hostSnapshot = '../../../../../host/src/agent/git-snapshot.ts';
    const { configureHostOwner } = (await import(/* @vite-ignore */ hostAuth)) as {
      configureHostOwner(options: { userDataDir: string; ownerId: string }): void;
    };
    const { createHostGitSnapshot } = (await import(/* @vite-ignore */ hostSnapshot)) as {
      createHostGitSnapshot(maker: unknown, deps: unknown): {
        onTurnStart(id: string): Promise<void>;
        onTurnEnd(id: string): Promise<void>;
      };
    };
    configureHostOwner({ userDataDir: profile, ownerId: 'chain-owner' });
    const { createGitSnapshotCoordinator } = await import('../git-snapshot-host.js');
    const { listShadowSavepoints } = await import('../../git-snapshot/gitSnapshotService.js');
    const { ownerScopedUserDataPath } = await import('../../appSessionState.js');

    const meta = { workDir: repo, agentKind: 'claude-code' };
    const desktop = createGitSnapshotCoordinator(
      { getSessionMeta: async () => meta, oneShot: async () => 'unused' } as never,
      { getLatestUserMessage: async () => ({ clientId: 'u-desktop', text: 'desktop turn' }) },
    );
    await desktop.onTurnStart('task-chain');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    await desktop.onTurnEnd('task-chain');

    const host = createHostGitSnapshot({ getSessionMeta: async () => meta },
      { getLatestUserMessage: async () => ({ clientId: 'u-host', text: 'host turn' }) });
    await host.onTurnStart('task-chain');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    await host.onTurnEnd('task-chain');

    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/cindy/savepoints/')).toBe('refs/cindy/savepoints/task-chain');
    const { entries } = await listShadowSavepoints(repo, 'task-chain');
    // Newest first: the Host turn sits on top of the desktop turn in one chain.
    expect(entries.map((entry) => [entry.anchor, entry.label])).toEqual([
      ['u-host', '改动 a.txt'],
      ['u-host', '本轮开始时的工作区基线'],
      ['u-desktop', '改动 a.txt'],
      ['u-desktop', '本轮开始时的工作区基线'],
    ]);
    // The Host after-edit savepoint is a delta on the Host's own baseline.
    expect(entries[0]!.baselineCommit).toBe(entries[1]!.commit);

    // Both attempt journals are in the same owner directory.
    const attemptsRoot = path.join(ownerScopedUserDataPath(), 'git-snapshot-attempts');
    const dirs = fs.readdirSync(attemptsRoot);
    expect(dirs).toHaveLength(1);
    const anchors = fs.readdirSync(path.join(attemptsRoot, dirs[0]!))
      .map((file) => JSON.parse(fs.readFileSync(path.join(attemptsRoot, dirs[0]!, file), 'utf8')).anchor)
      .sort();
    expect(anchors).toEqual(['u-desktop', 'u-host']);
  }, CHAIN_TIMEOUT_MS);
});
