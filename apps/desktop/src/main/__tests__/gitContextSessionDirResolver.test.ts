/**
 * git-context/sessionDirResolver 单测 — 候选目录解析(纯函数)+ 三级回退编排。
 * 依赖全注入(recentToolUseContents / probeGitDir),零 DB 零 fs。
 */

import path from 'node:path';

import { describe, it, expect } from 'vitest';

import type { GitHeadInfo } from '../git-context/headReader';
import {
  extractDirCandidate,
  posixDriveToWin32,
  resolveSessionGitDir,
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
