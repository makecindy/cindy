/**
 * worktree-parallel-sessions: includePatternsEngine 解析、glob、复制与 dirty 判定回归。
 * tracked 分支差异场景使用临时 Git worktree 做真实集成验证。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  applyWorktreeIncludeFile,
  copyWorktreeIncludeFiles,
  listChangedWorktreeIncludeFiles,
  parseWorktreeIncludePatterns,
  _internal,
} from '../worktree/includePatternsEngine';

const { globToRegex, listAllFiles, gitignoreMatcher } = _internal;

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

describe('gitignoreMatcher (.worktreeinclude)', () => {
  it('matches a slash-less pattern at any depth', () => {
    const matches = gitignoreMatcher(['.env']);
    expect(matches('.env')).toBe(true);
    expect(matches('apps/web/.env')).toBe(true);
    expect(matches('.env.local')).toBe(false);
  });

  it('anchors patterns that contain a slash to the repo root', () => {
    expect(gitignoreMatcher(['/.env'])('apps/.env')).toBe(false);
    expect(gitignoreMatcher(['/.env'])('.env')).toBe(true);
    const matches = gitignoreMatcher(['config/*.json']);
    expect(matches('config/local.json')).toBe(true);
    expect(matches('apps/config/local.json')).toBe(false);
  });

  it('selects every file under a matched directory', () => {
    const dirOnly = gitignoreMatcher(['.vscode/']);
    expect(dirOnly('.vscode/settings.json')).toBe(true);
    expect(dirOnly('apps/.vscode/a/b.json')).toBe(true);
    expect(dirOnly('.vscode')).toBe(false);
    expect(gitignoreMatcher(['secrets'])('secrets/key.pem')).toBe(true);
  });

  it('lets a later negation override an earlier match', () => {
    const matches = gitignoreMatcher(['.env*', '!.env.example']);
    expect(matches('.env.local')).toBe(true);
    expect(matches('.env.example')).toBe(false);
    expect(gitignoreMatcher(['!.env.example', '.env*'])('.env.example')).toBe(true);
  });

  it('treats a lone /** as everything under the repo root', () => {
    const matches = gitignoreMatcher(['/**', '!*.log']);
    expect(matches('.env')).toBe(true);
    expect(matches('apps/web/.env')).toBe(true);
    expect(matches('apps/debug.log')).toBe(false);
  });

  it('only lets a whole-segment ** cross directories', () => {
    const embedded = gitignoreMatcher(['secret**.json']);
    expect(embedded('secret-a.json')).toBe(true);
    expect(embedded('apps/secret-a.json')).toBe(true);
    expect(embedded('secret/private/key.json')).toBe(false);
    const middle = gitignoreMatcher(['a/**/b.txt']);
    expect(middle('a/b.txt')).toBe(true);
    expect(middle('a/x/y/b.txt')).toBe(true);
    expect(middle('c/a/b.txt')).toBe(false);
    const leading = gitignoreMatcher(['**/local/*.json']);
    expect(leading('local/a.json')).toBe(true);
    expect(leading('apps/web/local/a.json')).toBe(true);
    expect(leading('apps/web/local/x/a.json')).toBe(false);
  });

  it('selects only directory contents for a trailing /**', () => {
    const matches = gitignoreMatcher(['config/**']);
    expect(matches('config/local.json')).toBe(true);
    expect(matches('config/a/b.json')).toBe(true);
    expect(matches('config')).toBe(false);
    expect(matches('apps/config/local.json')).toBe(false);
  });
});

describe('applyWorktreeIncludeFile', () => {
  let tmpRoot: string;
  let baseRepo: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-apply-'));
    baseRepo = path.join(tmpRoot, 'repo');
    worktreePath = path.join(tmpRoot, 'worktree');
    fs.mkdirSync(path.join(baseRepo, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(baseRepo, '.env'), 'ROOT=1\n');
    fs.writeFileSync(path.join(baseRepo, 'apps', 'web', '.env'), 'WEB=1\n');
    fs.writeFileSync(path.join(baseRepo, 'local.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const copied = async () =>
    (await applyWorktreeIncludeFile(baseRepo, worktreePath))
      .filter((r) => r.status === 'copied')
      .map((r) => r.relpath)
      .sort();

  it('reads Claude Code .worktreeinclude with .gitignore semantics', async () => {
    fs.writeFileSync(path.join(baseRepo, '.worktreeinclude'), '.env\n');

    await expect(copied()).resolves.toEqual(['.env', 'apps/web/.env']);
    expect(fs.readFileSync(path.join(worktreePath, 'apps', 'web', '.env'), 'utf8')).toBe('WEB=1\n');
  });

  it('keeps repeated .worktreeinclude rules so a later rule re-includes a file', async () => {
    fs.writeFileSync(path.join(baseRepo, '.worktreeinclude'), '/.env\n!/.env\n/.env\n');

    await expect(copied()).resolves.toEqual(['.env']);
  });

  it('keeps .xdtworktreeinclude root-relative and merges both files', async () => {
    fs.writeFileSync(path.join(baseRepo, '.xdtworktreeinclude'), '.env\n');
    await expect(copied()).resolves.toEqual(['.env']);

    fs.writeFileSync(path.join(baseRepo, '.worktreeinclude'), 'local.json\n');
    await expect(copied()).resolves.toEqual(['.env', 'local.json']);
  });

  it('does not write through a symlinked directory that leads outside the worktree', async () => {
    const outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(baseRepo, 'config'));
    fs.writeFileSync(path.join(baseRepo, 'config', 'local.env'), 'SECRET=1\n');
    fs.symlinkSync(outside, path.join(worktreePath, 'config'), 'junction');
    fs.writeFileSync(path.join(baseRepo, '.worktreeinclude'), 'config/**\n');

    await expect(applyWorktreeIncludeFile(baseRepo, worktreePath)).resolves.toEqual([
      { relpath: 'config/local.env', status: 'skipped-outside' },
    ]);
    expect(fs.existsSync(path.join(outside, 'local.env'))).toBe(false);
  });

  it('reports files changed under .worktreeinclude rules as dirty', async () => {
    fs.writeFileSync(path.join(baseRepo, '.worktreeinclude'), '.env\n');
    await applyWorktreeIncludeFile(baseRepo, worktreePath);
    fs.writeFileSync(path.join(worktreePath, 'apps', 'web', '.env'), 'WEB=2\n');

    await expect(listChangedWorktreeIncludeFiles(baseRepo, worktreePath)).resolves.toEqual([
      { relpath: 'apps/web/.env', reason: 'content-differs' },
    ]);
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

describe('include files tracked on the worktree branch', () => {
  it('neither overwrites nor reports a file the target branch already tracks', async () => {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-branch-'));
    const repo = path.join(gitRoot, 'repo');
    const worktree = path.join(gitRoot, 'worktree');
    fs.mkdirSync(repo, { recursive: true });
    try {
      git(repo, 'init');
      git(repo, 'config', 'user.name', 'XDMaker Test');
      git(repo, 'config', 'user.email', 'test@xdmaker.local');
      fs.writeFileSync(path.join(repo, '.worktreeinclude'), 'local.json\n');
      git(repo, 'add', '.worktreeinclude');
      git(repo, 'commit', '-m', 'init');
      git(repo, 'branch', 'feature');
      git(repo, 'worktree', 'add', worktree, 'feature');
      fs.writeFileSync(path.join(worktree, 'local.json'), '{"branch":true}');
      git(worktree, 'add', 'local.json');
      git(worktree, 'commit', '-m', 'track local.json on feature');
      fs.writeFileSync(path.join(repo, 'local.json'), '{"base":true}');

      await expect(applyWorktreeIncludeFile(repo, worktree)).resolves.toEqual([
        { relpath: 'local.json', status: 'skipped-tracked' },
      ]);
      expect(fs.readFileSync(path.join(worktree, 'local.json'), 'utf8')).toBe('{"branch":true}');
      await expect(listChangedWorktreeIncludeFiles(repo, worktree)).resolves.toEqual([]);
    } finally {
      fs.rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

describe('include files under a path the target branch tracks', () => {
  it('skips files beneath a tracked symlink before checkout has written it', async () => {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-link-'));
    const repo = path.join(gitRoot, 'repo');
    const worktree = path.join(gitRoot, 'worktree');
    fs.mkdirSync(repo, { recursive: true });
    try {
      git(repo, 'init');
      git(repo, 'config', 'user.name', 'XDMaker Test');
      git(repo, 'config', 'user.email', 'test@xdmaker.local');
      fs.writeFileSync(path.join(repo, '.worktreeinclude'), 'config/**\n');
      git(repo, 'add', '.worktreeinclude');
      git(repo, 'commit', '-m', 'init');
      // feature 分支以 120000 模式跟踪符号链接 config; 用底层命令建提交, 不切分支、
      // 不依赖平台能否创建链接。
      const run = (args: string[], input?: string, env?: NodeJS.ProcessEnv): string =>
        execFileSync('git', args, { cwd: repo, input, env: { ...process.env, ...env } })
          .toString()
          .trim();
      const indexEnv = { GIT_INDEX_FILE: path.join(gitRoot, 'feature.index') };
      const blob = run(['hash-object', '-w', '--stdin'], '../outside');
      run(['read-tree', 'HEAD'], undefined, indexEnv);
      run(['update-index', '--add', '--cacheinfo', `120000,${blob},config`], undefined, indexEnv);
      const tree = run(['write-tree'], undefined, indexEnv);
      const commit = run(['commit-tree', tree, '-p', 'HEAD', '-m', 'track config as a symlink']);
      git(repo, 'branch', 'feature', commit);
      fs.mkdirSync(path.join(repo, 'config'));
      fs.writeFileSync(path.join(repo, 'config', 'local.env'), 'A=1\n');
      git(repo, 'worktree', 'add', '--no-checkout', worktree, 'feature');

      await expect(applyWorktreeIncludeFile(repo, worktree)).resolves.toEqual([
        { relpath: 'config/local.env', status: 'skipped-tracked' },
      ]);
      expect(fs.existsSync(path.join(worktree, 'config'))).toBe(false);
    } finally {
      fs.rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

describe('include files that are an ancestor of a path the target branch tracks', () => {
  it('skips a file whose name the target branch needs as a directory', async () => {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-wt-include-ancestor-'));
    const repo = path.join(gitRoot, 'repo');
    const worktree = path.join(gitRoot, 'worktree');
    fs.mkdirSync(repo, { recursive: true });
    try {
      git(repo, 'init');
      git(repo, 'config', 'user.name', 'XDMaker Test');
      git(repo, 'config', 'user.email', 'test@xdmaker.local');
      fs.writeFileSync(path.join(repo, '.worktreeinclude'), '/config\n');
      git(repo, 'add', '.worktreeinclude');
      git(repo, 'commit', '-m', 'init');
      git(repo, 'branch', 'feature');
      git(repo, 'worktree', 'add', worktree, 'feature');
      fs.mkdirSync(path.join(worktree, 'config'));
      fs.writeFileSync(path.join(worktree, 'config', 'settings.json'), '{}');
      git(worktree, 'add', 'config/settings.json');
      git(worktree, 'commit', '-m', 'track config/settings.json');
      git(repo, 'worktree', 'remove', '--force', worktree);
      // base 里同名的 config 是未跟踪的普通文件; 目标分支需要 config 作为目录
      fs.writeFileSync(path.join(repo, 'config'), 'LOCAL=1\n');
      git(repo, 'worktree', 'add', '--no-checkout', worktree, 'feature');

      await expect(applyWorktreeIncludeFile(repo, worktree)).resolves.toEqual([
        { relpath: 'config', status: 'skipped-tracked' },
      ]);
      expect(fs.existsSync(path.join(worktree, 'config'))).toBe(false);
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
