/**
 * worktree-parallel-sessions: includePatternsEngine 解析、glob、复制与 dirty 判定回归。
 * tracked 分支差异场景使用临时 Git worktree 做真实集成验证。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  copyWorktreeIncludeFiles,
  listChangedWorktreeIncludeFiles,
  parseWorktreeIncludePatterns,
  _internal,
} from '../worktree/includePatternsEngine';

const { globToRegex, listAllFiles } = _internal;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('parseWorktreeIncludePatterns', () => {
  it('returns empty for empty / whitespace input', () => {
    expect(parseWorktreeIncludePatterns('')).toEqual([]);
    expect(parseWorktreeIncludePatterns('   \n  \n')).toEqual([]);
  });

  it('skips # comments and blank lines', () => {
    const content = `# top comment
.env

# group 2
.env.local
  # indented comment
  .vscode/settings.json
`;
    const out = parseWorktreeIncludePatterns(content);
    expect(out).toEqual(['.env', '.env.local', '.vscode/settings.json']);
  });

  it('dedupes repeated patterns', () => {
    const content = '.env\n.env\n.env.local\n.env\n';
    expect(parseWorktreeIncludePatterns(content)).toEqual(['.env', '.env.local']);
  });

  it('preserves glob patterns verbatim', () => {
    const content = '*.env\n**/secrets/*.json\nbuild/**\n';
    expect(parseWorktreeIncludePatterns(content)).toEqual([
      '*.env',
      '**/secrets/*.json',
      'build/**',
    ]);
  });
});

describe('globToRegex', () => {
  it('* matches single segment, not /', () => {
    const re = globToRegex('*.env');
    expect(re.test('.env')).toBe(true);
    expect(re.test('foo.env')).toBe(true);
    expect(re.test('sub/.env')).toBe(false);
  });

  it('** matches across slashes', () => {
    const re = globToRegex('**/secrets.json');
    expect(re.test('secrets.json')).toBe(true);
    expect(re.test('a/secrets.json')).toBe(true);
    expect(re.test('a/b/c/secrets.json')).toBe(true);
  });

  it('? matches single char (not /)', () => {
    const re = globToRegex('a?c');
    expect(re.test('abc')).toBe(true);
    expect(re.test('axc')).toBe(true);
    expect(re.test('a/c')).toBe(false);
    expect(re.test('abbc')).toBe(false);
  });

  it('escapes regex meta characters in literal segments', () => {
    const re = globToRegex('a.b+c');
    // . 必须按字面匹配, 不是任意字符
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('aXb+c')).toBe(false);
  });

  it('build/** matches everything under build/', () => {
    const re = globToRegex('build/**');
    expect(re.test('build/')).toBe(true);
    expect(re.test('build/foo')).toBe(true);
    expect(re.test('build/foo/bar.js')).toBe(true);
    expect(re.test('source/build/foo')).toBe(false);
  });
});

describe('listAllFiles', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-list-'));
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'A=1');
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# hi');
    fs.mkdirSync(path.join(tmpRoot, 'src'));
    fs.writeFileSync(path.join(tmpRoot, 'src', 'index.ts'), 'export {};');
    // 应该被跳过的顶层目录
    fs.mkdirSync(path.join(tmpRoot, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'node_modules', 'foo', 'pkg.json'), '{}');
    fs.mkdirSync(path.join(tmpRoot, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.mkdirSync(path.join(tmpRoot, '.xdt-worktrees', 'leaf'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.xdt-worktrees', 'leaf', 'x.txt'), 'x');
    fs.mkdirSync(path.join(tmpRoot, '.cindy-worktrees', 'leaf'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cindy-worktrees', 'leaf', 'x.txt'), 'x');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns top-level + subdir files, with / separators', () => {
    const all = listAllFiles(tmpRoot);
    expect(all).toContain('.env');
    expect(all).toContain('README.md');
    expect(all).toContain('src/index.ts');
  });

  it('skips top-level node_modules / .git / current and legacy worktree subtrees', () => {
    const all = listAllFiles(tmpRoot);
    expect(all.find((f) => f.startsWith('node_modules/'))).toBeUndefined();
    expect(all.find((f) => f.startsWith('.git/'))).toBeUndefined();
    expect(all.find((f) => f.startsWith('.xdt-worktrees/'))).toBeUndefined();
    expect(all.find((f) => f.startsWith('.cindy-worktrees/'))).toBeUndefined();
  });
});

describe('listChangedWorktreeIncludeFiles', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let worktreePath: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-dirty-'));
    baseRepo = path.join(tmpRoot, 'repo');
    worktreePath = path.join(tmpRoot, 'repo', '.cindy-worktrees', 'leaf');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(baseRepo, '.xdtworktreeinclude'), '.env\n');
    fs.writeFileSync(path.join(baseRepo, '.env'), 'A=1\n');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns empty when included local files match the base copy', async () => {
    fs.writeFileSync(path.join(worktreePath, '.env'), 'A=1\n');

    await expect(listChangedWorktreeIncludeFiles(baseRepo, worktreePath)).resolves.toEqual([]);
  });

  it('reports included local files changed inside the worktree', async () => {
    fs.writeFileSync(path.join(worktreePath, '.env'), 'A=2\n');

    await expect(listChangedWorktreeIncludeFiles(baseRepo, worktreePath)).resolves.toEqual([
      { relpath: '.env', reason: 'content-differs' },
    ]);
  });

  it('reports worktree-only include files missing from base (dest-only)', async () => {
    // base 侧从没有过 secret.txt(或已删),worktree 内新建——base 侧循环看不到,
    // 不报 dest-only 的话删除 worktree 会静默丢失(review 反馈)
    fs.writeFileSync(path.join(baseRepo, '.xdtworktreeinclude'), '.env\nsecret.txt\n');
    fs.writeFileSync(path.join(worktreePath, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(worktreePath, 'secret.txt'), 'token\n');
    try {
      await expect(listChangedWorktreeIncludeFiles(baseRepo, worktreePath)).resolves.toEqual([
        { relpath: 'secret.txt', reason: 'dest-only' },
      ]);
    } finally {
      fs.rmSync(path.join(worktreePath, 'secret.txt'), { force: true });
      fs.writeFileSync(path.join(baseRepo, '.xdtworktreeinclude'), '.env\n');
    }
  });

  it('does not report a worktree-only file that is tracked on the worktree branch', async () => {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-tracked-'));
    const repo = path.join(gitRoot, 'repo');
    const worktree = path.join(gitRoot, 'worktree');
    fs.mkdirSync(repo, { recursive: true });
    try {
      git(repo, 'init');
      git(repo, 'config', 'user.name', 'XDMaker Test');
      git(repo, 'config', 'user.email', 'test@xdmaker.local');
      fs.writeFileSync(path.join(repo, '.xdtworktreeinclude'), 'branch-only.txt\n');
      git(repo, 'add', '.xdtworktreeinclude');
      git(repo, 'commit', '-m', 'init');
      git(repo, 'worktree', 'add', '-b', 'feature', worktree);
      fs.writeFileSync(path.join(worktree, 'branch-only.txt'), 'committed\n');
      git(worktree, 'add', 'branch-only.txt');
      git(worktree, 'commit', '-m', 'add branch-only include file');

      await expect(listChangedWorktreeIncludeFiles(repo, worktree)).resolves.toEqual([]);
    } finally {
      fs.rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

describe('copyWorktreeIncludeFiles restore mode', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let worktreePath: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-restore-'));
    baseRepo = path.join(tmpRoot, 'repo');
    worktreePath = path.join(tmpRoot, 'worktree');
    fs.mkdirSync(baseRepo, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(baseRepo, '.env'), 'BASE=1\n');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves a file restored from a dirty snapshot instead of overwriting it', async () => {
    fs.writeFileSync(path.join(worktreePath, '.env'), 'SNAPSHOT=1\n');

    await expect(
      copyWorktreeIncludeFiles(baseRepo, worktreePath, ['.env'], {
        overwriteExisting: false,
      }),
    ).resolves.toEqual([{ relpath: '.env', status: 'skipped-existing' }]);
    expect(fs.readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('SNAPSHOT=1\n');
  });
});
