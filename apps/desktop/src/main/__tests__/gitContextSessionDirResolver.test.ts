/**
 * git-context/sessionDirResolver 单测 — 候选目录解析(纯函数)+ 三级回退编排。
 * 依赖全注入(recentToolUseContents / probeGitDir),零 DB 零 fs。
 */

import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

// The injected resolver never opens Electron's persistent store.
vi.mock('electron-store', () => ({ default: class {} }));

import type { GitHeadInfo } from '../git-context/headReader';
import {
  collectTouchedDirs,
  extractDirCandidate,
  findLiveLinkedWorktree,
  posixDriveToWin32,
  resolveSessionGitDir,
  resolveWorkerInheritedDirectory,
  type ResolveSessionGitDirDeps,
} from '../git-context/sessionDirResolver';

/** 造一条 tool-use content(JSON 文本),模拟持久化形状。 */
function toolUse(toolName: string, input: Record<string, unknown>): string {
  return JSON.stringify({ toolUseId: 'x', toolName, input });
}

const branchHead = (branch: string): GitHeadInfo => ({ kind: 'branch', branch, shortSha: null });

describe('extractDirCandidate', () => {
  it('Codex exec:取绝对 cwd', () => {
    expect(
      extractDirCandidate(toolUse('exec', { command: 'git status', cwd: '/Users/x/wt-a' })),
    ).toBe('/Users/x/wt-a');
  });

  it('cc 编辑类:Edit/Write/MultiEdit/NotebookEdit 取 file_path 的 dirname', () => {
    for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(extractDirCandidate(toolUse(name, { file_path: '/Users/x/wt-a/src/y.ts' }))).toBe(
        path.dirname('/Users/x/wt-a/src/y.ts'),
      );
    }
  });

  it('Read 不算「在此工作」→ null', () => {
    expect(extractDirCandidate(toolUse('Read', { file_path: '/Users/x/wt-a/src/y.ts' }))).toBeNull();
  });

  it('cwd 只认 toolName==="exec":非 exec 工具带 cwd 字段 → null', () => {
    // 防御未来某个 input 恰好带 cwd 字段的工具被误当工作目录(Greptile review P2)。
    expect(extractDirCandidate(toolUse('some_future_tool', { cwd: '/Users/x/wt-a' }))).toBeNull();
    expect(extractDirCandidate(toolUse('exec', { command: 'ls', cwd: '/Users/x/wt-a' }))).toBe(
      '/Users/x/wt-a',
    );
  });

  it('普通 Bash(无 cwd)→ null', () => {
    expect(extractDirCandidate(toolUse('Bash', { command: 'ls' }))).toBeNull();
  });

  it.each([
    'cd /Users/x/wt-a && git status',
    "cd '/Users/x/wt-a' && git diff",
    'cd -- "/Users/x/wt-a" && python edit.py',
  ])('Claude Bash reports a literal command directory: %s', (command) => {
    expect(extractDirCandidate(toolUse('Bash', { command }))).toBe('/Users/x/wt-a');
  });

  it('accepts quoted directory spaces without interpreting shell expressions', () => {
    expect(extractDirCandidate(toolUse('Bash', { command: "cd '/Users/x/code tree' && git status" })))
      .toBe('/Users/x/code tree');
    for (const command of [
      'cd "$HOME/wt-a" && git status',
      'cd /Users/$(whoami)/wt-a && git status',
      'cd ../wt-a && git status',
      'echo ok && cd /Users/x/wt-a && git status',
      'cd /Users/x/wt-* && git status',
    ]) expect(extractDirCandidate(toolUse('Bash', { command }))).toBeNull();
  });

  it.each([
    'cd /repo/main && cd ../feature && git diff',
    'cd /repo/main && git status; cd /repo/feature && git diff',
    'cd /repo/main &&\ncd -- /repo/feature && git diff',
    'cd /repo/main && command cd /repo/feature && git diff',
    'cd /repo/main && pushd /repo/feature && git diff',
    'cd /repo/main && popd && git diff',
  ])('does not mistake the first directory for the final one: %s', (command) => {
    expect(extractDirCandidate(toolUse('Bash', { command }))).toBeNull();
  });

  it('相对路径不采纳(cwd / file_path 都要求绝对)→ null', () => {
    expect(extractDirCandidate(toolUse('exec', { command: 'ls', cwd: '../wt-a' }))).toBeNull();
    expect(extractDirCandidate(toolUse('Edit', { file_path: 'src/y.ts' }))).toBeNull();
  });

  it('脏 JSON / 缺 input → null', () => {
    expect(extractDirCandidate('not json')).toBeNull();
    expect(extractDirCandidate('{"toolName":"exec"}')).toBeNull();
  });

  it('远端 POSIX 遥测不按 Windows 控制端转换盘符路径', () => {
    expect(
      extractDirCandidate(toolUse('exec', { command: 'pwd', cwd: '/e/remote/repo' }), 'linux'),
    ).toBe('/e/remote/repo');
    expect(
      extractDirCandidate(toolUse('Edit', { file_path: '/e/remote/repo/src/a.ts' }), 'linux'),
    ).toBe('/e/remote/repo/src');
  });
});

describe('posixDriveToWin32', () => {
  it('win32:POSIX 盘符路径转原生 Win32(/e/AIWork/x → E:\\AIWork\\x)', () => {
    expect(posixDriveToWin32('/e/AIWork/xdt-maker/src', 'win32')).toBe('E:\\AIWork\\xdt-maker\\src');
    expect(posixDriveToWin32('/c/Users/me', 'win32')).toBe('C:\\Users\\me');
  });

  it('win32:已是 Win32 路径 / 非盘符 POSIX 路径不动', () => {
    expect(posixDriveToWin32('E:\\AIWork\\x', 'win32')).toBe('E:\\AIWork\\x');
    expect(posixDriveToWin32('/Users/x/wt', 'win32')).toBe('/Users/x/wt'); // 多字符首段,非单盘符
  });

  it('非 win32:no-op(Mac/Linux POSIX 路径原样)', () => {
    expect(posixDriveToWin32('/e/AIWork/x', 'darwin')).toBe('/e/AIWork/x');
    expect(posixDriveToWin32('/Users/x/wt', 'linux')).toBe('/Users/x/wt');
  });
});

describe('resolveSessionGitDir', () => {
  const FALLBACKS = { fallbackWorktreePath: '/Users/x/app-wt', fallbackWorkingDir: '/Users/x/main' };

  function deps(opts: {
    contents: string[];
    gitDirs: Record<string, string>; // dir → branch(返回 head);不在表里 = 非 git(null)
  }): ResolveSessionGitDirDeps {
    return {
      recentToolUseContents: async () => opts.contents,
      probeGitDir: async (dir) =>
        opts.gitDirs[dir] !== undefined ? branchHead(opts.gitDirs[dir]) : null,
    };
  }

  it('uses a Bash-only linked checkout instead of the unchanged task directory', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', fallbackWorktreePath: null, fallbackWorkingDir: '/Users/x/main' },
      deps({
        contents: [toolUse('Bash', { command: 'cd /Users/x/wt-a && git status --short' })],
        gitDirs: { '/Users/x/main': 'main', '/Users/x/wt-a': 'integration' },
      }),
    );
    expect(res).toMatchObject({ workdir: path.resolve('/Users/x/wt-a'), source: 'telemetry', head: branchHead('integration') });
  });

  it('遥测命中:最近一条候选目录是 git → source=telemetry', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', ...FALLBACKS },
      deps({
        // 倒序:最近的在最前
        contents: [
          toolUse('exec', { command: 'git status', cwd: '/Users/x/wt-a' }),
          toolUse('exec', { command: 'sed', cwd: '/Users/x/main' }),
        ],
        gitDirs: { '/Users/x/wt-a': 'fix/a', '/Users/x/main': 'main' },
      }),
    );
    expect(res).toEqual({
      workdir: path.resolve('/Users/x/wt-a'),
      head: branchHead('fix/a'),
      source: 'telemetry',
    });
  });

  it('跳过无候选消息(Read)找到最近的编辑目录', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', ...FALLBACKS },
      deps({
        contents: [
          toolUse('Read', { file_path: '/Users/x/wt-a/z.ts' }), // 最近,但 Read 不算
          toolUse('Edit', { file_path: '/Users/x/wt-b/src/y.ts' }), // 最近的编辑
        ],
        gitDirs: { '/Users/x/wt-b/src': 'feat/b' },
      }),
    );
    expect(res.source).toBe('telemetry');
    expect(res.workdir).toBe(path.resolve('/Users/x/wt-b/src'));
  });

  it('最近候选目录已删(probe null)→ 不往回翻,落 worktree 兜底', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', ...FALLBACKS },
      deps({
        contents: [
          toolUse('exec', { command: 'x', cwd: '/Users/x/wt-gone' }), // 最近,但已删
          toolUse('exec', { command: 'x', cwd: '/Users/x/main' }), // 更早的主 checkout 不该被翻出来
        ],
        gitDirs: { '/Users/x/main': 'main', '/Users/x/app-wt': 'feat/app' },
      }),
    );
    expect(res).toEqual({
      workdir: path.resolve('/Users/x/app-wt'),
      head: branchHead('feat/app'),
      source: 'worktree',
    });
  });

  it('无遥测候选 → worktree 兜底', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', ...FALLBACKS },
      deps({
        contents: [toolUse('Read', { file_path: '/Users/x/wt-a/z.ts' })],
        gitDirs: { '/Users/x/app-wt': 'feat/app', '/Users/x/main': 'main' },
      }),
    );
    expect(res.source).toBe('worktree');
    expect(res.workdir).toBe(path.resolve('/Users/x/app-wt'));
  });

  it('无遥测、无 worktree → working_dir 兜底(低信任)', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', fallbackWorktreePath: null, fallbackWorkingDir: '/Users/x/main' },
      deps({ contents: [], gitDirs: { '/Users/x/main': 'main' } }),
    );
    expect(res).toEqual({
      workdir: path.resolve('/Users/x/main'),
      head: branchHead('main'),
      source: 'workingDir',
    });
  });

  it('全都不可解析 → 空态', async () => {
    const res = await resolveSessionGitDir(
      { sessionId: 's', fallbackWorktreePath: null, fallbackWorkingDir: null },
      deps({ contents: [], gitDirs: {} }),
    );
    expect(res).toEqual({ workdir: null, head: null, source: null });
  });
});

describe('findLiveLinkedWorktree', () => {
  it('skips the latest main checkout and keeps an older live linked worktree', async () => {
    const res = await findLiveLinkedWorktree('s', {
      recentToolUseContents: async () => [
        toolUse('exec', { command: 'git status', cwd: '/Users/x/main' }),
        toolUse('exec', { command: 'git status', cwd: '/Users/x/wt-a' }),
      ],
      resolveLinkedWorktreeRoot: async (dir) =>
        dir === path.resolve('/Users/x/wt-a') ? path.resolve('/Users/x/wt-a') : null,
      probeGitDir: async (dir) =>
        dir === path.resolve('/Users/x/wt-a') ? branchHead('feat/a') : branchHead('main'),
    });
    expect(res).toEqual({
      workdir: path.resolve('/Users/x/wt-a'),
      branch: 'feat/a',
    });
  });

  it('canonicalizes a nested telemetry cwd to the worktree root', async () => {
    const res = await findLiveLinkedWorktree('s', {
      recentToolUseContents: async () => [
        toolUse('exec', { command: 'git status', cwd: '/Users/x/wt-a/src' }),
      ],
      resolveLinkedWorktreeRoot: async (dir) =>
        dir === path.resolve('/Users/x/wt-a/src') ? path.resolve('/Users/x/wt-a') : null,
      probeGitDir: async (dir) =>
        dir === path.resolve('/Users/x/wt-a') ? branchHead('feat/a') : null,
    });
    expect(res).toEqual({
      workdir: path.resolve('/Users/x/wt-a'),
      branch: 'feat/a',
    });
  });

  it('looks past many recent checkout dirs to find an older live worktree', async () => {
    const recent = Array.from({ length: 21 }, (_, i) =>
      toolUse('exec', { command: 'git status', cwd: `/Users/x/main/pkg-${i}` }),
    );
    const res = await findLiveLinkedWorktree('s', {
      recentToolUseContents: async () => [
        ...recent,
        toolUse('exec', { command: 'git status', cwd: '/Users/x/wt-a' }),
      ],
      resolveLinkedWorktreeRoot: async (dir) =>
        dir === path.resolve('/Users/x/wt-a') ? path.resolve('/Users/x/wt-a') : null,
      probeGitDir: async (dir) =>
        dir === path.resolve('/Users/x/wt-a') ? branchHead('feat/a') : branchHead('main'),
    });
    expect(res).toEqual({
      workdir: path.resolve('/Users/x/wt-a'),
      branch: 'feat/a',
    });
  });

  it('clears the candidate when every telemetry worktree is gone', async () => {
    const res = await findLiveLinkedWorktree('s', {
      recentToolUseContents: async () => [
        toolUse('exec', { command: 'git status', cwd: '/Users/x/wt-gone' }),
      ],
      resolveLinkedWorktreeRoot: async () => null,
      probeGitDir: async () => null,
    });
    expect(res).toBeNull();
  });
});

describe('collectTouchedDirs', () => {
  const client = path.resolve('/work/client/.cindy-worktrees/fix');
  const server = path.resolve('/work/server');
  const piRepo = path.resolve('/work/pi-repo');
  const row = (createdAt: number, toolName: string, input: Record<string, unknown>) => ({
    createdAt,
    content: JSON.stringify({ toolName, input }),
  });

  it('separates edited directories from command-only ones across Codex, Claude and Pi', () => {
    // Rows arrive newest first, like the telemetry query.
    const dirs = collectTouchedDirs([
      row(60, 'exec', { cwd: server }),
      row(50, 'file_change', { changes: [{ path: path.join(client, 'src', 'panel.tsx') }, { path: 'relative.ts' }] }),
      row(40, 'edit', { path: path.join(piRepo, 'price.ts'), edits: [] }),
      row(35, 'write', { path: 'relative-to-task.ts', content: '' }),
      row(30, 'bash', { command: 'cd /work/server && git status' }),
      row(20, 'Edit', { file_path: path.join(server, 'limits.ts') }),
      row(10, 'Read', { file_path: path.join(piRepo, 'ignored.ts') }),
    ]);
    expect(dirs).toEqual([
      { dir: server, edited: true, firstSeenAt: 20 },
      { dir: path.join(client, 'src'), edited: true, firstSeenAt: 50 },
      { dir: piRepo, edited: true, firstSeenAt: 40 },
    ]);
  });

  it('records Pi bash and Codex exec directories as command-only', () => {
    // Shell commands carry POSIX paths on every platform (Git Bash on Windows).
    const piShellDir = '/work/pi-repo';
    expect(collectTouchedDirs([
      row(2, 'bash', { command: `cd '${piShellDir}' && ls`, timeout: 30 }),
      row(1, 'exec', { cwd: server }),
    ])).toEqual([
      { dir: path.resolve(piShellDir), edited: false, firstSeenAt: 2 },
      { dir: server, edited: false, firstSeenAt: 1 },
    ]);
  });
});

// Test value: Worker inheritance is stricter than the header's directory badge.
// Existing resolver tests accept any valid repository; a different common-dir is the minimal
// unsafe input. Unit tier uses injected probes (no Git processes or disk writes).
describe('Worker same-repository inheritance', () => {
  const recorded = {directory: '/repo', realDirectory: '/repo', checkoutRoot: '/repo', baseRepo: '/repo', commonDir: '/repo/.git',
    branch: 'main', exists: true, dirty: false, isWorktree: false};
  it.each([
    ['linked checkout', '/repo/.git', true, '/checkout'],
    ['independent clone', '/clone/.git', true, '/repo'],
    ['nested repository', '/repo/nested/.git', true, '/repo'],
    ['deleted checkout', '/repo/.git', false, '/repo'],
    ['non-Git directory', null, true, '/repo'],
  ])('%s selects only a live directory with the same common-dir', async (_name, commonDir, exists, expected) => {
    const result = await resolveWorkerInheritedDirectory({id: 'lead', workingDir: '/repo'}, {
      infer: async () => ({workdir: '/checkout', head: branchHead('feature'), source: 'telemetry'}),
      probe: async directory => directory === '/repo' ? recorded : {...recorded, directory, realDirectory: directory, checkoutRoot: '/checkout', commonDir, exists, isWorktree: true},
    });
    expect(result.directory).toBe(expected);
  });
  // Regression: Edit telemetry identifies a file's parent, not the desired Worker cwd.
  // The previous implementation submitted that subdirectory; retain checkout/subproject scope.
  it.each([
    ['/repo', '/repo/src', '/repo', true, '/repo'],
    ['/alias/repo', '/repo/src', '/repo', true, '/alias/repo'],
    ['/repo', '/checkout/src', '/checkout', true, '/checkout'],
    ['/repo/apps/web', '/checkout/src', '/checkout', true, '/checkout/apps/web'],
    ['/repo/apps/web', '/checkout/src', '/checkout', false, '/checkout'],
    ['/repo/apps/web', '/repo/lib', '/repo', true, '/repo/apps/web'],
  ])('keeps project scope from %s with telemetry %s (candidate checkout %s, matching subproject exists=%s)', async (rawDirectory, rawTelemetry, rawCheckoutRoot, subprojectExists, expected) => {
    const directory = path.resolve(rawDirectory);
    const telemetry = path.resolve(rawTelemetry);
    const checkoutRoot = path.resolve(rawCheckoutRoot);
    const original = {...recorded, directory, checkoutRoot: path.resolve('/repo'), realDirectory: path.resolve(rawDirectory.replace('/alias', ''))};
    const result = await resolveWorkerInheritedDirectory({id: 'lead', workingDir: directory}, {
      infer: async () => ({workdir: telemetry, head: branchHead('feature'), source: 'telemetry'}),
      probe: async dir => dir === directory ? original : {
        ...recorded, directory: dir, realDirectory: dir, checkoutRoot,
        exists: dir === path.resolve('/checkout/apps/web') ? subprojectExists : true,
        isWorktree: checkoutRoot === path.resolve('/checkout'),
      },
    });
    expect(result.directory).toBe(path.resolve(expected));
    if (checkoutRoot === path.resolve('/repo')) expect(result).toBe(original);
  });
  it('preserves the recorded directory without telemetry or a Git identity', async () => {
    const infer = vi.fn(async () => ({workdir: null, head: null, source: null} as const));
    const result = await resolveWorkerInheritedDirectory({id: 'lead', workingDir: '/repo'}, {
      infer, probe: async () => ({...recorded, commonDir: null}),
    });
    expect(result.directory).toBe('/repo');
  });
});
