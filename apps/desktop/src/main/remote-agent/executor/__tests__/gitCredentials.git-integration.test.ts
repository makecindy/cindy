/**
 * 供应商分享的受邀者任务：git 查看内容的命令在本机核实仓库读不到凭证类文件时不弹卡(gitCredentials.ts)。
 * 用真实的 git 仓库验证扫描范围(历史、reflog、stash、暂存区)与各种照旧弹卡的情况。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isShareCredentialCommand, shareCredentialGitReads } from '../../credentials';
import { RemoteExecutor } from '../executor';
import { ExecutorGate, type ExecutorAction } from '../gate';
import { GitCredentialHistory } from '../gitCredentials';
import * as executorShell from '../shell';
import { ExecutorWorkspace } from '../workspace';

// Windows 上每次 spawn git 要数百毫秒。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 60_000 });

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function write(file: string, content = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(message: string, ...files: string[]): void {
  for (const file of files) write(file);
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', message);
}

/** 按分享任务的判定取出要核实的 git 调用，再交给本机核实。 */
async function provesSafe(history: GitCredentialHistory, command: string, cwd = repo): Promise<boolean> {
  const reads = shareCredentialGitReads(command, [repo], { cwd, platform: process.platform });
  expect(reads, command).not.toBeNull();
  return history.provesSafe(command, reads ?? []);
}

async function requiresCredentialConfirmation(history: GitCredentialHistory, command: string): Promise<void> {
  const workspace = new ExecutorWorkspace({ workingDir: repo });
  const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
  const confirm = vi.fn(async () => false);
  const executor = new RemoteExecutor({
    workspace,
    gate,
    rgPath: 'rg',
    tempDir: path.join(root, 'executor'),
    confirm,
    gitCredentials: history,
  });
  const action: ExecutorAction = { kind: 'exec', command, cwd: repo };
  try {
    expect(gate.authorize(action).ok, command).toBe(false);
    expect(await executor.confirm(action), command).toBe(false);
    expect(confirm, command).toHaveBeenCalledExactlyOnceWith(action);
    expect(gate.authorize(action).ok, command).toBe(false);
  } finally {
    await executor.close();
  }
}

const GIT_ENV_KEYS = ['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const savedEnv = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-git-credentials-')));
  vi.stubEnv('SHELL', '/bin/bash');
  vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', undefined);
  vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
  vi.stubEnv('PATH', (process.env.PATH ?? '').split(path.delimiter).map((entry) => path.resolve(entry)).join(path.delimiter));
  // 临时目录的上层也可能是 git 仓库(比如整个用户目录)：不往上找。开发机自己的全局与系统 git 配置
  // 也不读，免得里面的令牌影响结果。
  process.env.GIT_CEILING_DIRECTORIES = root;
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@xdt.local');
  git('config', 'user.name', 'XDT Test');
  git('config', 'core.autocrlf', 'false');
  commit('init', 'src/app.ts', 'README.md', '.env.example', 'deploy/id_rsa.pub');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of GIT_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GitCredentialHistory', () => {
  it('lets content commands run in a repository that never had credential files', async () => {
    const history = new GitCredentialHistory();
    commit('more', 'src/util.ts');
    write('src/app.ts', 'changed\n');
    for (const command of ['git diff', 'git log -p', 'git show HEAD', 'git grep -n x', 'git diff --cached', 'git log -p --all | head -50']) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    // 子目录里跑也是同一个仓库。
    expect(await provesSafe(history, 'git log -p', path.join(repo, 'src'))).toBe(true);
  });

  // git grep 只看扫描结果(不按会显示的文件再核对)，用它验证扫描范围。
  it('finds credential files anywhere in history: deleted, only in the reflog, in a stash or staged', async () => {
    // 提交过又删掉。
    let history = new GitCredentialHistory();
    commit('add env', '.env');
    git('rm', '-q', '.env');
    git('commit', '-q', '--no-gpg-sign', '-m', 'drop env');
    expect(await provesSafe(history, 'git grep -n x')).toBe(false);

    // 只剩在 reflog 里。
    fs.rmSync(path.join(root, 'repo'), { recursive: true, force: true });
    fs.mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'test@xdt.local');
    git('config', 'user.name', 'XDT Test');
    commit('init', 'src/app.ts');
    history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git grep -n x')).toBe(true);
    commit('key', 'certs/server.key');
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(await provesSafe(history, 'git grep -n x')).toBe(false);

    // 在 stash 里。
    history = new GitCredentialHistory();
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    expect(await provesSafe(history, 'git grep -n x')).toBe(true);
    write('.npmrc');
    git('add', '.npmrc');
    git('stash', '-q');
    expect(await provesSafe(history, 'git grep -n x')).toBe(false);

    // 只在暂存区。
    history = new GitCredentialHistory();
    git('stash', 'drop', '-q');
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    write('.env.local');
    git('add', '.env.local');
    expect(await provesSafe(history, 'git diff --cached')).toBe(false);
  });

  it('lets commands limited to paths that never held credential files run', async () => {
    const history = new GitCredentialHistory();
    commit('fixtures', 'test/fixtures/server.key', 'src/lib/index.ts');
    for (const command of [
      'git log -p -- src/app.ts',
      'git log -p -- src',
      'git diff HEAD~1 -- src/lib README.md',
      "git grep -n x -- '*.ts'",
      'git show HEAD -- src',
      // 没写 `--` 时按会显示的文件核对。
      'git log -p src/app.ts',
    ]) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    for (const command of [
      'git log -p',
      'git log -p -- .',
      'git log -p -- test',
      "git grep -n x -- '*'",
      "git grep -n x -- 't*/fixtures'",
      'git show HEAD:src/app.ts -- src',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    // 在子目录里跑时，路径按子目录解释。
    expect(await provesSafe(history, 'git log -p -- lib', path.join(repo, 'src'))).toBe(true);
    expect(await provesSafe(history, 'git log -p -- fixtures', path.join(repo, 'test'))).toBe(false);
  });

  it('checks the files a command would show when the repository has credential files', async () => {
    const history = new GitCredentialHistory();
    // 像多数 pnpm / npm 项目一样提交了 .npmrc。
    commit('npmrc', '.npmrc');
    commit('code', 'src/util.ts');
    write('src/app.ts', 'changed\n');
    for (const command of [
      'git diff',
      'git diff HEAD',
      'git diff HEAD~1 HEAD',
      'git show HEAD',
      'git log -p -1',
      'git log -p src/app.ts',
      'git log -p -n 1 src/app.ts',
      'git log -p --author=XDT -- src',
    ]) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    for (const command of [
      'git show HEAD~1',
      'git log -p -2',
      'git log -p',
      'git log -p --graph -1',
      'git diff --stat -p',
      // 选项的取值恰好是个文件名：插入的选项可能被它当成取值，不这样核对。
      'git log -p -S README.md',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    write('.npmrc', 'changed\n');
    expect(await provesSafe(history, 'git diff')).toBe(false);
    // 直接写出文件对象时显示的是内容本身。
    git('tag', '-a', 'blob-tag', '-m', 't', git('rev-parse', 'HEAD:src/util.ts').trim());
    expect(await provesSafe(history, 'git show blob-tag')).toBe(false);
    expect(await provesSafe(history, 'git show blob-tag -- src')).toBe(false);
  });

  it('checks credential lines printed by whitespace diagnostics without blocking source checks', async () => {
    commit('credential baseline', '.env');
    write('.env', 'PRIVATE_FIXTURE=whitespace-check \n');
    write('src/app.ts', 'const changed = true; \n');
    const history = new GitCredentialHistory();
    const check = async (args: string[]) => {
      const output = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      expect(output.stdout, args.join(' ')).toContain('PRIVATE_FIXTURE=whitespace-check');
      const command = 'git ' + args.join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      if (!args.includes('--stat')) {
        expect(await provesSafe(history, command + ' -- src/app.ts'), command).toBe(true);
      }
    };
    await check(['diff', '--check']);
    await check(['diff', '--stat', '--check']);
    git('add', '.env', 'src/app.ts');
    await check(['diff', '--cached', '--check']);
    git('commit', '-qm', 'whitespace change', '--no-gpg-sign');
    for (const sub of ['log', 'show']) await check([sub, '--check', '-1']);
    expect(await provesSafe(history, 'git diff --check')).toBe(true);
  });

  it('keeps consent for implicit merge patches containing credentials', async () => {
    write('.env', 'PRIVATE_FIXTURE=base\n');
    git('add', '.env');
    git('commit', '-q', '--no-gpg-sign', '-m', 'base');
    const baseBranch = git('branch', '--show-current').trim();
    git('checkout', '-q', '-b', 'side');
    write('.env', 'PRIVATE_FIXTURE=side\n');
    git('commit', '-qam', 'side', '--no-gpg-sign');
    git('checkout', '-q', baseBranch);
    write('.env', 'PRIVATE_FIXTURE=main\n');
    git('commit', '-qam', 'main', '--no-gpg-sign');
    expect(spawnSync('git', ['merge', '--no-gpg-sign', 'side'], { cwd: repo }).status).toBe(1);
    write('.env', 'PRIVATE_FIXTURE=resolved\n');
    git('add', '.env');
    git('commit', '-qm', 'resolve merge', '--no-gpg-sign');
    const history = new GitCredentialHistory();
    for (const options of [
      ['--remerge-diff'], ['--dd'], ['--diff-merges', 'remerge'],
      ...['on', 'm', 'first-parent', '1', 'separate', 'combined', 'c', 'dense-combined', 'cc', 'remerge', 'r']
        .map((mode) => ['--diff-merges=' + mode]),
    ]) {
      expect(git('log', ...options, '-1'), options.join(' ')).toContain('PRIVATE_FIXTURE=resolved');
      const command = 'git log ' + options.join(' ') + ' -1';
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    expect(await provesSafe(history, 'git log --oneline -1')).toBe(true);
    expect(await provesSafe(history, 'git log --diff-merges=off -1')).toBe(true);
    expect(await provesSafe(history, 'git log --diff-merges=none -1')).toBe(true);
  });

  it('keeps mailmap credential sources behind consent while allowing ordinary mappings', async () => {
    const mapping = 'PRIVATE_FIXTURE=mailmap <mapped@example.invalid> <test@xdt.local>\n';
    const externalCredential = path.join(root, '.env');
    fs.writeFileSync(externalCredential, mapping);
    git('config', 'mailmap.file', externalCredential);
    const history = new GitCredentialHistory();
    for (const args of [
      ['log', '--use-mailmap', '--format=%aN', '-1'],
      ['log', '--format=%aN', '-1'],
      ['show', '--format=%aN', '--no-patch', 'HEAD'],
    ]) {
      expect(git(...args)).toContain('PRIVATE_FIXTURE=mailmap');
      const command = 'git ' + args.join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    for (const command of ['git diff', 'git status --short']) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    const ordinaryMapping = path.join(root, 'authors.mailmap');
    fs.writeFileSync(ordinaryMapping, 'Mapped Author <mapped@example.invalid> <test@xdt.local>\n');
    git('config', 'mailmap.file', ordinaryMapping);
    expect(git('log', '--format=%aN', '-1')).toContain('Mapped Author');
    expect(await provesSafe(history, 'git log --format=%aN -1')).toBe(true);
    git('config', '--unset', 'mailmap.file');
    write('.env', mapping);
    write('.mailmap', 'Mapped Author <mapped@example.invalid> <test@xdt.local>\n');
    git('add', '.env', '.mailmap');
    git('commit', '-qm', 'mapping sources', '--no-gpg-sign');
    git('config', 'mailmap.blob', 'HEAD:.env');
    expect(git('log', '--format=%aN', '-1')).toContain('PRIVATE_FIXTURE=mailmap');
    expect(await provesSafe(history, 'git log --format=%aN -1')).toBe(false);
    git('config', 'mailmap.blob', 'HEAD:.mailmap');
    expect(await provesSafe(history, 'git log --format=%aN -1')).toBe(true);
  });

  it('checks custom merge drivers only when history reads may remerge commits', async () => {
    write('.gitattributes', 'src/app.ts merge=shared\n');
    git('add', '.gitattributes');
    git('commit', '-qm', 'merge attributes', '--no-gpg-sign');
    const baseBranch = git('branch', '--show-current').trim();
    git('checkout', '-q', '-b', 'side');
    write('src/app.ts', 'side\n');
    git('commit', '-qam', 'side', '--no-gpg-sign');
    git('checkout', '-q', baseBranch);
    write('src/app.ts', 'main\n');
    git('commit', '-qam', 'main', '--no-gpg-sign');
    expect(spawnSync('git', ['merge', '--no-gpg-sign', 'side'], { cwd: repo }).status).toBe(1);
    write('src/app.ts', 'resolved\n');
    git('add', 'src/app.ts');
    git('commit', '-qm', 'resolve merge', '--no-gpg-sign');
    const credential = path.join(root, '.env');
    const invoked = path.join(root, 'merge-invoked');
    const helperFile = path.join(root, 'merge-helper.cjs');
    fs.writeFileSync(credential, 'PRIVATE_FIXTURE=merge-driver\n');
    fs.writeFileSync(helperFile, 'const fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(invoked) + ', "called");\n'
      + 'process.stderr.write(fs.readFileSync(' + JSON.stringify(credential) + '));\nprocess.exit(1);\n');
    const helper = [process.execPath, helperFile].map((file) => JSON.stringify(file.split(path.sep).join('/'))).join(' ');
    git('config', 'merge.shared.driver', helper);
    git('config', 'log.diffMerges', 'remerge');
    const history = new GitCredentialHistory();
    for (const options of [
      ['--remerge-diff'], ['--diff-merges=remerge'], ['--diff-merges', 'r'],
      ['-m', '-p'], ['--diff-merges=on'], ['--diff-merges', 'm'],
    ]) {
      const actual = spawnSync('git', ['log', ...options, '-1'], { cwd: repo, encoding: 'utf8' });
      expect(actual.status).toBe(0);
      expect(actual.stderr).toContain('PRIVATE_FIXTURE=merge-driver');
      fs.unlinkSync(invoked);
      const command = 'git log ' + options.join(' ') + ' -1';
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invoked), command).toBe(false);
    }
    for (const command of ['git log --oneline -1', 'git log -p -1', 'git diff', 'git status --short', 'git log --dd -1']) {
      expect(await provesSafe(history, command), command).toBe(true);
      expect(fs.existsSync(invoked), command).toBe(false);
    }
  });

  it('does not trust path-limited full diffs or commits outside the scanned history', async () => {
    const history = new GitCredentialHistory();
    const visible = git('rev-parse', 'HEAD').trim();
    expect(await provesSafe(history, 'git log -p')).toBe(true);

    write('.aws/credentials');
    git('add', '.aws/credentials');
    const hiddenTree = git('write-tree').trim();
    git('reset', '-q', 'HEAD', '--', '.aws/credentials');
    fs.rmSync(path.join(repo, '.aws', 'credentials'));
    const hidden = execFileSync('git', ['commit-tree', hiddenTree, '-p', visible], {
      cwd: repo,
      encoding: 'utf8',
      input: 'hidden\n',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    expect(await provesSafe(history, 'git show ' + hidden)).toBe(false);

    const fullDiffHistory = new GitCredentialHistory();
    write('README.md', 'changed\n');
    write('.aws/credentials');
    git('add', '-A');
    git('commit', '-q', '--no-gpg-sign', '-m', 'mixed');
    expect(await provesSafe(fullDiffHistory, 'git log -p -- README.md')).toBe(true);
    expect(await provesSafe(fullDiffHistory, 'git log -p --full-diff -- README.md')).toBe(false);
  });

  it('keeps confirmation for a dangling credential blob outside every scanned commit', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    write('.env', 'PRIVATE_FIXTURE=unreachable-content\n');
    const blob = git('hash-object', '-w', '.env').trim();
    fs.rmSync(path.join(repo, '.env'));
    expect(git('ls-files', '--', '.env')).toBe('');
    expect(git('rev-list', '--all', '--reflog', '--objects')).not.toContain(blob);
    expect(git('show', blob)).toContain('PRIVATE_FIXTURE=unreachable-content');
    for (const command of [
      'git show ' + blob,
      'git show ' + blob + ' -- README.md',
      'git show -s ' + blob,
      'git show --name-only ' + blob,
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent when implicit HEAD names a blob instead of a commit', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show')).toBe(true);
    write('.env', 'PRIVATE_FIXTURE=implicit-blob\n');
    const blob = git('hash-object', '-w', '.env').trim();
    git('update-ref', 'refs/tags/fixture-blob', blob);
    git('symbolic-ref', 'HEAD', 'refs/tags/fixture-blob');
    for (const args of [[], ['-s'], ['--name-only'], ['--', 'README.md']]) {
      expect(git('show', ...args)).toContain('PRIVATE_FIXTURE=implicit-blob');
      const command = 'git show ' + args.join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('does not use replaced objects to prove the original history has no credentials', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    const safe = git('rev-parse', 'HEAD').trim();
    write('.env', 'PRIVATE_FIXTURE=original-history\n');
    git('add', '.env');
    git('commit', '-q', '--no-gpg-sign', '-m', 'original credentials');
    const original = git('rev-parse', 'HEAD').trim();
    git('replace', original, safe);
    git('reset', '--mixed', '-q', 'HEAD');
    expect(git('ls-files', '--', '.env')).toBe('');
    expect(git('show', 'HEAD')).not.toContain('PRIVATE_FIXTURE=original-history');
    expect(git('--no-replace-objects', 'show', 'HEAD')).toContain('PRIVATE_FIXTURE=original-history');
    for (const command of ['git --no-replace-objects show HEAD', 'git show HEAD']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    git('replace', '-d', original);
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/custom-replace/');
    git('replace', original, safe);
    expect(await provesSafe(history, 'git --no-replace-objects show HEAD')).toBe(false);
    await requiresCredentialConfirmation(history, 'git --no-replace-objects show HEAD');
  });

  it.runIf(process.platform !== 'win32')('does not exempt a tracked template symlink to an ignored credential file', async () => {
    write('.gitignore', '.env\n');
    write('.env', 'PRIVATE_FIXTURE=symlink-target\n');
    fs.rmSync(path.join(repo, '.env.example'));
    fs.symlinkSync('.env', path.join(repo, '.env.example'));
    git('add', '.gitignore', '.env.example');
    git('commit', '-q', '--no-gpg-sign', '-m', 'template link');
    expect(git('ls-files', '--', '.env')).toBe('');
    expect(git('ls-files', '--stage', '--', '.env.example')).toMatch(/^120000 /);
    const history = new GitCredentialHistory();
    for (const command of [
      'cat .env.example',
      'cat < .env.example',
      'git diff && cat .env.example',
      'git grep -f .env.example -- README.md',
      'git blame --contents .env.example README.md',
    ]) {
      await requiresCredentialConfirmation(history, command);
    }
  });

  it.runIf(process.platform !== 'win32')('keeps consent when inherited ripgrep config follows source symlinks', async () => {
    const history = new GitCredentialHistory();
    const ripgrep = path.resolve(__dirname, '../../../../../../ripgrep-bin', process.platform + '-' + process.arch, 'rg');
    const config = path.join(root, 'ripgrep-config');
    const command = "rg -g '*.ts' PRIVATE .";
    write('.gitignore', '.env\n');
    write('.env', 'PRIVATE_FIXTURE=rg-config\n');
    fs.symlinkSync('.env', path.join(repo, 'safe.ts'));
    fs.writeFileSync(config, '--follow\n');
    vi.stubEnv('RIPGREP_CONFIG_PATH', config);
    expect(execFileSync(ripgrep, ['-g', '*.ts', 'PRIVATE', '.'], { cwd: repo, encoding: 'utf8' }))
      .toContain('PRIVATE_FIXTURE=rg-config');
    const disabled = spawnSync(ripgrep, ['--no-config', '-g', '*.ts', 'PRIVATE', '.'], { cwd: repo, encoding: 'utf8' });
    expect(disabled.status).toBe(1);
    expect(disabled.stdout).toBe('');
    expect(disabled.stderr).toBe('');
    await requiresCredentialConfirmation(history, command);
    const workspace = new ExecutorWorkspace({ workingDir: repo });
    const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
    expect(gate.authorize({ kind: 'exec', command: "rg --no-config -g '*.ts' PRIVATE .", cwd: repo }).ok).toBe(true);
    fs.writeFileSync(config, '--hidden\n--glob=*.env\n');
    await requiresCredentialConfirmation(history, command);
  });

  it.runIf(process.platform !== 'win32')('keeps consent when ripgrep preprocessors expose a credential outside source files', async () => {
    const history = new GitCredentialHistory();
    const ripgrep = path.resolve(__dirname, '../../../../../../ripgrep-bin', process.platform + '-' + process.arch, 'rg');
    const credential = path.join(root, 'private.env');
    const filter = path.join(root, 'preprocessor');
    fs.writeFileSync(credential, 'PRIVATE_FIXTURE=rg-preprocessor\n');
    fs.writeFileSync(filter, '#!/bin/sh\ncat ' + JSON.stringify(credential) + '\n', { mode: 0o700 });
    for (const args of [
      ['PRIVATE_FIXTURE', '-g', '*.ts', '--pre=' + filter, '.'],
      ['PRIVATE_FIXTURE', '-g', '*.ts', '--pre', filter, '.'],
      ['--no-config', 'PRIVATE_FIXTURE', '-g', '*.ts', '--pre=' + filter, '.'],
      ['-e', '--', '-e', 'PRIVATE_FIXTURE', '-g', '*.ts', '--pre=' + filter, '.'],
      ['PRIVATE_FIXTURE', '-g', '*.ts', '--pre-glob', '*.ts', '--pre=' + filter, '.'],
    ]) {
      expect(execFileSync(ripgrep, args, { cwd: repo, encoding: 'utf8' })).toContain('PRIVATE_FIXTURE=rg-preprocessor');
      const command = 'rg ' + args.map((arg) => JSON.stringify(arg)).join(' ');
      expect(isShareCredentialCommand(command, [repo], { cwd: repo, platform: process.platform }), command).toBe(true);
      await requiresCredentialConfirmation(history, command);
    }
    const plain = spawnSync(ripgrep, ['PRIVATE_FIXTURE', '-g', '*.ts', '.'], { cwd: repo, encoding: 'utf8' });
    expect(plain.status).toBe(1);
    expect(plain.stdout).toBe('');
    expect(plain.stderr).toBe('');
    const workspace = new ExecutorWorkspace({ workingDir: repo });
    const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
    expect(gate.authorize({ kind: 'exec', command: "rg PRIVATE_FIXTURE -g '*.ts' .", cwd: repo }).ok).toBe(true);
  });

  it('keeps consent when --bare selects a different repository in the same directory', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    const bare = path.join(root, 'bare');
    git('init', '--bare', '-q', bare);
    for (const entry of fs.readdirSync(bare)) {
      expect(fs.existsSync(path.join(repo, entry))).toBe(false);
      fs.cpSync(path.join(bare, entry), path.join(repo, entry), { recursive: true });
    }
    write('.env', 'PRIVATE_FIXTURE=bare-history\n');
    git('--bare', 'config', 'user.email', 'fixture@example.com');
    git('--bare', 'config', 'user.name', 'Fixture');
    const blob = git('--bare', 'hash-object', '-w', '.env').trim();
    const tree = execFileSync('git', ['--bare', 'mktree'], {
      cwd: repo, encoding: 'utf8', input: '100644 blob ' + blob + '\t.env\n',
    }).trim();
    const revision = git('--bare', 'commit-tree', tree, '-m', 'bare fixture').trim();
    git('--bare', 'update-ref', 'HEAD', revision);
    git('--bare', 'config', 'http.extraHeader', 'PRIVATE_FIXTURE=bare-config');
    expect(git('show', 'HEAD', '--')).not.toContain('PRIVATE_FIXTURE=bare-history');
    expect(git('--bare', 'show', 'HEAD')).toContain('PRIVATE_FIXTURE=bare-history');
    expect(git('config', '--list')).not.toContain('PRIVATE_FIXTURE=bare-config');
    expect(git('--bare', 'config', '--list')).toContain('PRIVATE_FIXTURE=bare-config');
    for (const command of ['git --bare show HEAD', 'git --bare config --list']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent for attached, abbreviated and clustered config-source flags', async () => {
    const file = path.join(root, 'alternate.config');
    fs.writeFileSync(file, '[http]\nextraHeader = PRIVATE_FIXTURE=alternate-config\n');
    const blob = git('hash-object', '-w', file).trim();
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    for (const args of [
      ['-f' + file, '--list'],
      ['-lf' + file],
      ['--fil=' + file, '--list'],
      ['--fil', file, '--list'],
      ['--blo=' + blob, '--list'],
      ['--fil', file, 'http.extraHeader'],
      ['--file', file, '--type', 'path', 'http.extraHeader'],
      ['-f' + file, '--type', 'path', 'http.extraHeader'],
      ['--blo', blob, 'http.extraHeader'],
    ]) {
      expect(git('config', ...args)).toContain('PRIVATE_FIXTURE=alternate-config');
      const command = 'git config ' + args.map((arg) => JSON.stringify(arg)).join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent for implicit config reads with value-taking options and stdin sources', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git config --type path user.name')).toBe(true);
    git('config', 'user.password', 'PRIVATE_FIXTURE=implicit-config');
    expect(git('config', '--type', 'path', 'user.password')).toContain('PRIVATE_FIXTURE=implicit-config');
    await requiresCredentialConfirmation(history, 'git config --type path user.password');
    if (process.platform === 'win32') return;
    const input = '[http]\nextraHeader = PRIVATE_FIXTURE=stdin-config\n';
    for (const args of [['--fil', '/dev/stdin', 'http.extraHeader'], ['-f/dev/stdin', '--type', 'path', 'http.extraHeader']]) {
      const command = 'printf ' + JSON.stringify(input) + ' | git config ' + args.join(' ');
      const output = execFileSync('sh', ['-c', command], { cwd: repo, encoding: 'utf8' });
      expect(output).toContain('PRIVATE_FIXTURE=stdin-config');
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('does not mistake abbreviated regexp queries for literal config keys', async () => {
    const history = new GitCredentialHistory();
    git('config', 'http.extraHeader', 'PRIVATE_FIXTURE=regexp-query');
    expect(await provesSafe(history, 'git config --get user.name')).toBe(true);
    for (const option of ['--get-r', '--get-re', '--get-reg']) {
      expect(git('config', option, '.*')).toContain('PRIVATE_FIXTURE=regexp-query');
      const command = 'git config ' + option + " '.*'";
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps consent for Git reads that cannot enter the readonly probe path', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    write('.env', 'PRIVATE_FIXTURE=non-probed-read\n');
    git('add', '.env');
    for (const args of [
      ['--literal-pathspecs', 'diff', '--cached'],
      ['--git-dir=' + path.join(repo, '.git'), '--work-tree=' + repo, 'diff', '--cached'],
      ['diff', '--ext-diff', '--cached'],
      ['diff', '--textconv', '--cached'],
      ['status', '-v'],
    ]) {
      expect(git(...args)).toContain('PRIVATE_FIXTURE=non-probed-read');
      await requiresCredentialConfirmation(history, 'git ' + args.map((arg) => JSON.stringify(arg)).join(' '));
    }
  });

  it('allows ordinary Git reads with standard Git LFS installed without exempting credential files', async () => {
    const history = new GitCredentialHistory();
    write('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    commit('source and LFS attributes', 'src/util.ts');
    write('src/app.ts', 'changed\n');
    git('config', '--global', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git('config', '--global', 'filter.lfs.process', 'git-lfs filter-process');
    for (const command of [
      'git diff', 'git diff -- src/app.ts', 'git diff --cached', 'git status --short',
      'git show HEAD', 'git log -p -1', 'git grep x -- src',
    ]) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    write('.env', 'PRIVATE_FIXTURE=lfs-consent\n');
    git('add', '.env');
    expect(await provesSafe(history, 'git diff --cached')).toBe(false);
    await requiresCredentialConfirmation(history, 'git diff --cached');
    for (const [key, value] of [
      ['filter.lfs.clean', 'git-lfs clean -- %f && cat .env'],
      ['filter.lfs.process', 'git-lfs filter-process; cat .env'],
    ]) {
      git('config', key, value);
      expect(await provesSafe(history, 'git diff -- src/app.ts'), key).toBe(false);
      git('config', '--unset', key);
    }
  });

  it('keeps consent for clean and process filters even when diff helpers are disabled', async () => {
    const history = new GitCredentialHistory();
    const credentialFile = path.join(root, '.env');
    const helperFile = path.join(root, 'clean-helper.cjs');
    const invokedFile = path.join(root, 'filter-invoked');
    const disabledCommand = 'git diff --no-ext-diff --no-textconv';
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=clean-filter\n');
    fs.writeFileSync(helperFile, 'const fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(invokedFile) + ', "called");\n'
      + 'process.stdout.write(fs.readFileSync(' + JSON.stringify(credentialFile) + '));\n');
    const helper = [process.execPath, helperFile].map((file) => JSON.stringify(file.split(path.sep).join('/'))).join(' ');
    write('.gitattributes', 'safe.txt filter=shared\n');
    write('safe.txt', 'safe before\n');
    git('add', '.gitattributes', 'safe.txt');
    git('commit', '-q', '--no-gpg-sign', '-m', 'filtered file');
    write('safe.txt', 'safe after\n');
    expect(await provesSafe(history, disabledCommand)).toBe(true);
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    git('config', 'filter.shared.clean', helper);
    expect(git('diff', '--no-ext-diff', '--no-textconv')).toContain('PRIVATE_FIXTURE=clean-filter');
    expect(fs.existsSync(invokedFile)).toBe(true);
    fs.unlinkSync(invokedFile);
    for (const key of ['filter.shared.clean', 'filter.shared.process']) {
      git('config', key, helper);
      for (const command of ['git diff', disabledCommand, 'git diff --cached', 'git show HEAD', 'git log -p -- safe.txt', 'git grep safe']) {
        expect(await provesSafe(history, command), key + ': ' + command).toBe(false);
        await requiresCredentialConfirmation(history, command);
        expect(fs.existsSync(invokedFile), key + ': ' + command).toBe(false);
      }
      expect(await provesSafe(history, 'git config --get core.autocrlf')).toBe(true);
      git('config', '--unset', key);
      expect(await provesSafe(history, disabledCommand)).toBe(true);
      expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    }
    git('config', 'filter.shared.clean', '');
    git('config', 'filter.shared.process', '');
    expect(await provesSafe(history, disabledCommand)).toBe(true);
    expect(fs.existsSync(invokedFile)).toBe(false);
  });

  it('keeps consent for fsmonitor hooks before any index probe can run them', async () => {
    const history = new GitCredentialHistory();
    const credentialFile = path.join(root, '.env');
    const hookFile = path.join(root, 'fsmonitor-hook.cjs');
    const invokedFile = path.join(root, 'fsmonitor-invoked');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=fsmonitor-hook\n');
    fs.writeFileSync(hookFile, 'const fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(invokedFile) + ', "called");\n'
      + 'process.stderr.write(fs.readFileSync(' + JSON.stringify(credentialFile) + '));\n'
      + 'process.stdout.write("fixture-token\\0");\n');
    const hook = [process.execPath, hookFile].map((file) => JSON.stringify(file.split(path.sep).join('/'))).join(' ');
    expect(await provesSafe(history, 'git diff')).toBe(true);
    git('config', 'core.fsmonitor', hook);
    for (const subcommand of ['diff', 'status']) {
      const output = spawnSync('git', [subcommand], { cwd: repo, encoding: 'utf8' });
      expect(output.stderr, subcommand).toContain('PRIVATE_FIXTURE=fsmonitor-hook');
      expect(output.status, subcommand).toBe(0);
    }
    fs.unlinkSync(invokedFile);
    for (const command of ['git diff', 'git diff --no-ext-diff --no-textconv', 'git diff --cached', 'git show HEAD',
      'git diff --name-only', 'git status', 'git ls-files', 'git show -s HEAD:src/app.ts']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invokedFile), command).toBe(false);
    }
    expect(await provesSafe(history, 'git config --get core.autocrlf')).toBe(true);
    for (const value of ['true', 'false']) {
      git('config', 'core.fsmonitor', value);
      expect(await provesSafe(history, 'git diff'), value).toBe(false);
    }
    git('config', '--unset', 'core.fsmonitor');
    expect(await provesSafe(history, 'git diff')).toBe(true);
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    expect(await provesSafe(history, 'git status')).toBe(true);
    expect(await provesSafe(history, 'git ls-files')).toBe(true);
    expect(fs.existsSync(invokedFile)).toBe(false);
  });

  it.each(['absorbed', 'embedded'])('keeps consent when status enters an %s submodule with a helper', async (layout) => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git status')).toBe(true);
    const child = path.join(repo, 'child');
    if (layout === 'absorbed') {
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repo, 'child');
    } else {
      git('clone', '--no-hardlinks', '-q', repo, child);
      git('config', '-f', '.gitmodules', 'submodule.child.path', 'child');
      git('config', '-f', '.gitmodules', 'submodule.child.url', repo.split(path.sep).join('/'));
      git('add', '.gitmodules', 'child');
    }
    git('commit', '-q', '--no-gpg-sign', '-m', 'submodule fixture');
    expect(fs.existsSync(path.join(repo, '.git', 'modules'))).toBe(layout === 'absorbed');
    expect(git('ls-files', '--stage', 'child')).toMatch(/^160000 /);
    const credentialFile = path.join(root, '.env');
    const hookFile = path.join(root, 'submodule-fsmonitor.cjs');
    const invokedFile = path.join(root, 'submodule-helper-invoked');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=submodule-helper\n');
    fs.writeFileSync(hookFile, 'const fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(invokedFile) + ', "called");\n'
      + 'process.stderr.write(fs.readFileSync(' + JSON.stringify(credentialFile) + '));\n'
      + 'process.stdout.write("fixture-token\\0");\n');
    const hook = [process.execPath, hookFile].map((file) => JSON.stringify(file.split(path.sep).join('/'))).join(' ');
    git('-C', child, 'config', 'core.fsmonitor', hook);
    const output = spawnSync('git', ['status'], { cwd: repo, encoding: 'utf8' });
    expect(output.stdout + output.stderr).toContain('PRIVATE_FIXTURE=submodule-helper');
    expect(output.status).toBe(0);
    fs.unlinkSync(invokedFile);
    for (const command of ['git status', 'git status --porcelain', 'git diff --name-only', 'git ls-files', 'git diff --cached']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invokedFile), command).toBe(false);
    }
  });

  it('fails closed when the submodule directory cannot be inspected', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git status')).toBe(true);
    const modules = path.join(repo, '.git', 'modules');
    const lstat = fsPromises.lstat;
    const stats = vi.spyOn(fsPromises, 'lstat').mockImplementation((file) => file === modules
      ? Promise.reject(Object.assign(new Error('unavailable'), { code: 'EACCES' })) : lstat(file));
    expect(await provesSafe(history, 'git status')).toBe(false);
    expect(stats).toHaveBeenCalledWith(modules);
    await requiresCredentialConfirmation(history, 'git status');
  });

  it('keeps consent for post-index-change hooks and configured hook directories', async () => {
    vi.stubEnv('GIT_OPTIONAL_LOCKS', undefined);
    const history = new GitCredentialHistory();
    const credentialFile = path.join(root, '.env');
    const hooksDir = path.join(root, 'custom-hooks');
    const hookFile = path.join(hooksDir, 'post-index-change');
    const invokedFile = path.join(root, 'post-index-change-invoked');
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=post-index-change\n');
    fs.writeFileSync(hookFile, '#!/usr/bin/env node\nconst fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(invokedFile) + ', "called");\n'
      + 'process.stderr.write(fs.readFileSync(' + JSON.stringify(credentialFile) + '));\n');
    fs.chmodSync(hookFile, 0o700);
    expect(await provesSafe(history, 'git status')).toBe(true);
    git('config', 'core.hooksPath', hooksDir.split(path.sep).join('/'));
    if (process.platform !== 'win32') {
      const changedTime = new Date(Date.now() + 2_000);
      fs.utimesSync(path.join(repo, 'src/app.ts'), changedTime, changedTime);
      const output = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      expect(output.stdout + output.stderr).toContain('PRIVATE_FIXTURE=post-index-change');
      expect(output.status).toBe(0);
      fs.unlinkSync(invokedFile);
    }
    for (const command of ['git status', 'git status --porcelain', 'git diff --name-only', 'git ls-files',
      'git diff', 'git diff --cached', 'git show HEAD']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invokedFile), command).toBe(false);
    }
    for (const value of ['', '/dev/null', path.join(root, 'missing-hooks').split(path.sep).join('/')]) {
      git('config', 'core.hooksPath', value);
      expect(await provesSafe(history, 'git status'), value).toBe(false);
    }
    git('config', '--unset', 'core.hooksPath');
    expect(await provesSafe(history, 'git status')).toBe(true);
    const defaultHook = path.resolve(repo, git('rev-parse', '--git-common-dir').trim(), 'hooks', 'post-index-change');
    fs.renameSync(hookFile, defaultHook);
    for (const command of ['git status', 'git diff --cached', 'git diff --name-only']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invokedFile), command).toBe(false);
    }
    expect(await provesSafe(history, 'git config --get core.autocrlf')).toBe(true);
    fs.unlinkSync(defaultHook);
    expect(await provesSafe(history, 'git status')).toBe(true);
    expect(fs.existsSync(invokedFile)).toBe(false);
  });

  it('checks shared worktree hooks each time and fails closed on hook inspection errors', async () => {
    const history = new GitCredentialHistory();
    const linked = path.join(root, 'linked-worktree');
    git('worktree', 'add', '--detach', '-q', linked, 'HEAD');
    const reads = shareCredentialGitReads('git status', [linked], { cwd: linked, platform: process.platform });
    expect(reads).not.toBeNull();
    expect(await history.provesSafe('git status', reads ?? [])).toBe(true);
    const defaultHook = path.resolve(repo, git('rev-parse', '--git-common-dir').trim(), 'hooks', 'post-index-change');
    fs.writeFileSync(defaultHook, 'hook-fixture\n');
    expect(await history.provesSafe('git status', reads ?? [])).toBe(false);
    fs.unlinkSync(defaultHook);
    expect(await history.provesSafe('git status', reads ?? [])).toBe(true);
    fs.writeFileSync(defaultHook + '.exe', 'hook-fixture\n');
    expect(await history.provesSafe('git status', reads ?? [])).toBe(false);
    fs.unlinkSync(defaultHook + '.exe');
    expect(await history.provesSafe('git status', reads ?? [])).toBe(true);
    const stats = vi.spyOn(fsPromises, 'lstat').mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }));
    expect(await history.provesSafe('git status', reads ?? [])).toBe(false);
    expect(stats).toHaveBeenCalledWith(defaultHook);
  });

  it('uses one budget for all Git segments including configuration reads', async () => {
    vi.spyOn(fsPromises, 'realpath').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return repo;
    });
    const history = new GitCredentialHistory({ waitMs: 100 });
    const started = Date.now();
    expect(await provesSafe(history, 'git config --get core.autocrlf && git config --get core.autocrlf')).toBe(false);
    expect(Date.now() - started).toBeLessThan(process.platform === 'win32' ? 5_000 : 1_000);
    const contentStarted = Date.now();
    expect(await provesSafe(history, 'git diff && git show HEAD')).toBe(false);
    expect(Date.now() - contentStarted).toBeLessThan(process.platform === 'win32' ? 5_000 : 1_000);
  });

  it('stops a stalled configuration filesystem check and cancelled command within the same budget', async () => {
    vi.spyOn(fsPromises, 'realpath').mockImplementation(() => new Promise<string>(() => {}));
    const history = new GitCredentialHistory({ waitMs: 30 });
    const started = Date.now();
    expect(await provesSafe(history, 'git config --list')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    const abort = new AbortController();
    const reads = shareCredentialGitReads('git config --list', [repo], { cwd: repo, platform: process.platform });
    const cancelled = new GitCredentialHistory({ waitMs: 5_000 });
    const cancelledStarted = Date.now();
    const pending = cancelled.provesSafe('git config --list', reads ?? [], abort.signal);
    abort.abort();
    expect(await pending).toBe(false);
    expect(Date.now() - cancelledStarted).toBeLessThan(1_000);
    expect(await history.provesSafe('git config --list', reads ?? [], abort.signal)).toBe(false);
  });

  it('keeps consent for signature verifiers including configured and formatted verification', async () => {
    const history = new GitCredentialHistory();
    const credentialFile = path.join(root, '.env');
    const verifierFile = path.join(root, 'signature-verifier.cjs');
    const invokedFile = path.join(root, 'verifier-invoked');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=signature-verifier\n');
    fs.writeFileSync(verifierFile, '#!/usr/bin/env node\nconst fs = require("node:fs");\n'
      + 'fs.writeFileSync(' + JSON.stringify(invokedFile) + ', "called");\n'
      + 'process.stderr.write(fs.readFileSync(' + JSON.stringify(credentialFile) + '));\n'
      + 'process.exitCode = 1;\n');
    fs.chmodSync(verifierFile, 0o700);
    const verifier = verifierFile.split(path.sep).join('/');
    const parent = git('rev-parse', 'HEAD').trim();
    const rawCommit = ['tree ' + git('rev-parse', 'HEAD^{tree}').trim(), 'parent ' + parent,
      'author ' + git('var', 'GIT_AUTHOR_IDENT').trim(), 'committer ' + git('var', 'GIT_COMMITTER_IDENT').trim(),
      'gpgsig -----BEGIN PGP SIGNATURE-----', ' synthetic-fixture', ' -----END PGP SIGNATURE-----', '', 'verifier fixture', ''].join('\n');
    const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo, input: rawCommit, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    git('update-ref', 'HEAD', signed);
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    git('config', 'gpg.program', verifier);
    git('config', 'log.showSignature', 'true');
    if (process.platform !== 'win32') {
      for (const args of [['show', 'HEAD'], ['log', '-1']]) {
        const output = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
        expect(output.stdout + output.stderr, args.join(' ')).toContain('PRIVATE_FIXTURE=signature-verifier');
      }
      fs.unlinkSync(invokedFile);
    }
    for (const command of ['git show HEAD', 'git log -1', 'git log --format=%G?', 'git log --format=%GG']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invokedFile), command).toBe(false);
    }
    await requiresCredentialConfirmation(history, 'git log --show-signature -1');
    git('config', '--unset', 'gpg.program');
    expect(await provesSafe(history, 'git show HEAD')).toBe(false);
    git('config', 'log.showSignature', 'false');
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    for (const key of ['gpg.openpgp.program', 'gpg.ssh.program', 'gpg.x509.program']) {
      git('config', key, verifier);
      expect(await provesSafe(history, 'git show HEAD'), key).toBe(false);
      git('config', '--unset', key);
    }
    for (const key of ['format.pretty', 'pretty.fixture']) {
      git('config', key, '%G?');
      expect(await provesSafe(history, 'git log --oneline'), key).toBe(false);
      git('config', '--unset', key);
    }
    expect(await provesSafe(history, 'git log --format=%GG')).toBe(false);
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    expect(fs.existsSync(invokedFile)).toBe(false);
  });

  it('keeps consent for configured textconv and external diff helpers', async () => {
    const history = new GitCredentialHistory();
    const credentialFile = path.join(root, '.env');
    const helperFile = path.join(root, 'diff-helper.cjs');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=diff-helper\n');
    fs.writeFileSync(helperFile, 'const fs = require("node:fs");\n'
      + 'process.stdout.write(fs.readFileSync(' + JSON.stringify(credentialFile) + '));\n'
      + 'process.stdout.write(fs.readFileSync(process.argv[2], "utf8").replaceAll("\\0", ""));\n');
    const helper = [process.execPath, helperFile].map((file) => JSON.stringify(file.split(path.sep).join('/'))).join(' ');
    write('.gitattributes', 'data.bin diff=shared\n');
    write('data.bin', 'old\0bytes\n');
    git('add', '.gitattributes', 'data.bin');
    git('commit', '-q', '--no-gpg-sign', '-m', 'binary data');
    expect(await provesSafe(history, 'git show HEAD')).toBe(true);
    git('config', 'diff.shared.textconv', helper);
    for (const args of [['show', 'HEAD'], ['log', '-p']]) {
      expect(git(...args)).toContain('PRIVATE_FIXTURE=diff-helper');
      const command = 'git ' + args.join(' ');
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    write('data.bin', 'new\0bytes\n');
    expect(git('diff')).toContain('PRIVATE_FIXTURE=diff-helper');
    await requiresCredentialConfirmation(history, 'git diff');
    git('add', 'data.bin');
    expect(git('diff', '--cached')).toContain('PRIVATE_FIXTURE=diff-helper');
    await requiresCredentialConfirmation(history, 'git diff --cached');
    expect(git('show', '--textconv', 'HEAD:data.bin')).toContain('PRIVATE_FIXTURE=diff-helper');
    await requiresCredentialConfirmation(history, 'git show --textconv HEAD:data.bin');
    expect(await provesSafe(history, 'git log -p -S --no-textconv')).toBe(false);
    expect(git('show', '--no-textconv', 'HEAD')).not.toContain('PRIVATE_FIXTURE=diff-helper');
    expect(await provesSafe(history, 'git show --no-textconv HEAD')).toBe(true);
    git('config', '--unset', 'diff.shared.textconv');
    git('config', 'diff.shared.command', helper);
    expect(git('diff', '--cached')).toContain('PRIVATE_FIXTURE=diff-helper');
    await requiresCredentialConfirmation(history, 'git diff --cached');
    expect(await provesSafe(history, 'git diff --no-ext-diff --cached')).toBe(true);
    git('config', '--unset', 'diff.shared.command');
    git('config', 'diff.external', helper);
    expect(git('diff', '--cached')).toContain('PRIVATE_FIXTURE=diff-helper');
    await requiresCredentialConfirmation(history, 'git diff --cached');
    expect(await provesSafe(history, 'git diff --no-ext-diff --cached')).toBe(true);
    git('config', '--unset', 'diff.external');
    vi.stubEnv('GIT_EXTERNAL_DIFF', helper);
    expect(git('diff', '--cached')).toContain('PRIVATE_FIXTURE=diff-helper');
    await requiresCredentialConfirmation(history, 'git diff --cached');
    expect(await provesSafe(history, 'git diff --no-ext-diff --cached')).toBe(true);
  });

  it('does not exempt a git read after an earlier shell segment may change state', async () => {
    const history = new GitCredentialHistory();
    expect(await provesSafe(history, 'git add -A && git diff --cached')).toBe(false);
    // A read-only segment before another read does not invalidate the probe.
    expect(await provesSafe(history, 'git diff && git diff --cached')).toBe(true);
  });

  it('does not exempt a git read hidden behind shell substitution or xargs', async () => {
    const history = new GitCredentialHistory();
    for (const command of [
      'git diff $(git add -A)',
      'git diff ' + String.fromCharCode(96) + 'git add -A' + String.fromCharCode(96),
      'git diff >(git add -A)',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
  });

  it('keeps consent for remote queries that can run transport helpers', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', undefined);
    vi.stubEnv('GIT_PROXY_COMMAND', undefined);
    const history = new GitCredentialHistory();
    const credentialFile = path.join(root, '.env');
    const helperFile = path.join(root, 'transport-helper.cjs');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=transport-helper\n');
    fs.writeFileSync(helperFile, 'process.stderr.write(require("node:fs").readFileSync('
      + JSON.stringify(credentialFile) + '));\nprocess.exit(1);\n');
    write('transport-fixture.cjs', fs.readFileSync(helperFile, 'utf8'));
    const helper = [process.execPath, helperFile].map((file) => JSON.stringify(file.split(path.sep).join('/'))).join(' ');
    git('remote', 'add', 'origin', 'ssh://example.invalid/repository');
    for (const variant of [
      { config: 'core.sshCommand', env: 'GIT_SSH_COMMAND', url: 'ssh://example.invalid/repository', helper },
      { config: 'core.gitProxy', env: 'GIT_PROXY_COMMAND', url: 'git://transport-fixture.cjs/repository', helper: process.execPath },
    ]) {
      git('remote', 'set-url', 'origin', variant.url);
      git('config', variant.config, variant.helper);
      for (const source of ['config', 'environment']) {
        if (source === 'environment') {
          git('config', '--unset', variant.config);
          vi.stubEnv(variant.env, variant.helper);
        }
        const output = spawnSync('git', ['remote', 'show', 'origin'], { cwd: repo, encoding: 'utf8', timeout: 5_000 });
        expect(output.error).toBeUndefined();
        expect(output.stderr).toContain('PRIVATE_FIXTURE=transport-helper');
        expect(await provesSafe(history, 'git remote show origin'), variant.config + ':' + source).toBe(false);
        await requiresCredentialConfirmation(history, 'git remote show origin');
        const local = spawnSync('git', ['remote', 'show', '-n', 'origin'], { cwd: repo, encoding: 'utf8', timeout: 5_000 });
        expect(local.status).toBe(0);
        expect(local.stdout + local.stderr).not.toContain('PRIVATE_FIXTURE=transport-helper');
        expect(await provesSafe(history, 'git remote show -n origin')).toBe(true);
        expect(await provesSafe(history, 'git remote -v')).toBe(true);
        expect(await provesSafe(history, 'git remote get-url origin')).toBe(true);
      }
      vi.stubEnv(variant.env, undefined);
    }
    expect(await provesSafe(history, 'git remote show origin')).toBe(false);
    expect(await provesSafe(history, 'git remote show -- -n')).toBe(false);
  });

  it('lets commands that print the git config run only while the config holds no secrets', async () => {
    const history = new GitCredentialHistory();
    const token = ['ghp_', '0123456789abcdefghijABCDEFGHIJ012345'].join('');
    const printing = ['git remote -v', 'git remote get-url origin', 'git config --list', 'git config --get remote.origin.url'];
    git('remote', 'add', 'origin', 'https://github.com/a/b.git');
    for (const command of [...printing, 'git config user.name']) {
      expect(await provesSafe(history, command), command).toBe(true);
    }
    // 远程地址里嵌着令牌：打出地址与整份配置的要问，只读别的键的不用。
    git('remote', 'set-url', 'origin', `https://me:${token}@github.com/a/b.git`);
    for (const command of printing) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    expect(await provesSafe(history, 'git config user.name')).toBe(true);
    // 令牌藏在地址改写规则的键名里、或在 http 头里。
    git('remote', 'set-url', 'origin', 'https://github.com/a/b.git');
    git('config', `url.https://${token}@github.com/.insteadOf`, 'https://github.com/');
    expect(await provesSafe(history, 'git remote -v')).toBe(false);
    git('config', '--unset', `url.https://${token}@github.com/.insteadOf`);
    git('config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic eDp5');
    expect(await provesSafe(history, 'git remote -v')).toBe(true);
    expect(await provesSafe(history, 'git config --list')).toBe(false);
    // 全局配置也算。
    git('config', '--unset', 'http.https://github.com/.extraheader');
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    git('config', '--global', 'sendemail.smtppass', 'hunter2');
    expect(await provesSafe(history, 'git config --list')).toBe(false);
    expect(await provesSafe(history, 'HOME=' + path.join(root, 'other-home') + ' git config --list')).toBe(false);
    expect(await provesSafe(history, 'XDG_CONFIG_HOME=' + path.join(root, 'other-config') + ' git remote -v')).toBe(false);
  });

  it('checks Git logical variable output including environment and derived values', async () => {
    const history = new GitCredentialHistory();
    const fakeToken = 'ghp_' + '0'.repeat(36);
    const editorEnv = ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'EDITOR', 'VISUAL', 'PAGER'];
    for (const key of editorEnv) vi.stubEnv(key, undefined);
    vi.stubEnv('GIT_EDITOR', 'vi');
    vi.stubEnv('GIT_PAGER', 'less');
    for (const variable of ['-l', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER']) {
      expect(await provesSafe(history, 'git var ' + variable), variable).toBe(true);
    }
    for (const [key, variables] of [
      ['GIT_EDITOR', ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']],
      ['GIT_SEQUENCE_EDITOR', ['GIT_SEQUENCE_EDITOR']],
      ['GIT_PAGER', ['GIT_PAGER']],
      ['EDITOR', ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']],
      ['VISUAL', ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']],
      ['PAGER', ['GIT_PAGER']],
    ] as const) {
      for (const envKey of editorEnv) vi.stubEnv(envKey, undefined);
      vi.stubEnv('TERM', 'xterm');
      vi.stubEnv('EDITOR', 'vi');
      vi.stubEnv('PAGER', 'less');
      vi.stubEnv(key, fakeToken);
      for (const variable of ['-l', ...variables]) {
        expect(git('var', variable), key + ': ' + variable).toContain(fakeToken);
        const command = 'git var ' + variable;
        expect(await provesSafe(history, command), key + ': ' + command).toBe(false);
        await requiresCredentialConfirmation(history, command);
      }
      expect(await provesSafe(history, 'git config user.name')).toBe(true);
    }
    vi.stubEnv('PAGER', 'less');
    git('config', 'http.extraHeader', 'synthetic-config-secret');
    expect(await provesSafe(history, 'git var -l')).toBe(false);
    expect(await provesSafe(history, 'git var GIT_EDITOR')).toBe(true);
    git('config', '--unset', 'http.extraHeader');
    git('config', 'custom.token', '\nsynthetic-config-secret');
    expect(await provesSafe(history, 'git var -l')).toBe(false);
    expect(await provesSafe(history, 'git var GIT_EDITOR')).toBe(true);
  });

  it('fails closed for path selectors that exceed the bounded matcher', async () => {
    const history = new GitCredentialHistory();
    const selector = 'a*'.repeat(20) + 'b';
    const started = Date.now();
    expect(await provesSafe(history, 'git log -p -- ' + selector)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps confirmation when env removes variables or clears the environment', async () => {
    const history = new GitCredentialHistory();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[http]\n\textraHeader = global-runtime-fixture\n');
    const systemConfig = path.join(root, 'system-gitconfig');
    fs.writeFileSync(systemConfig, '[http]\n\textraHeader = system-runtime-fixture\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'xdg'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    const removedEnv = { ...process.env };
    delete removedEnv.GIT_CONFIG_GLOBAL;
    delete removedEnv.GIT_CONFIG_NOSYSTEM;
    const output = execFileSync('git', ['config', '--list'], { cwd: repo, env: removedEnv, encoding: 'utf8' });
    expect(output).toContain('http.extraheader=global-runtime-fixture');
    expect(output).toContain('http.extraheader=system-runtime-fixture');
    for (const command of [
      'env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM git config --list',
      'env -uGIT_CONFIG_GLOBAL git config --list',
      'env --unset GIT_CONFIG_GLOBAL git config --list',
      'env --unset=GIT_CONFIG_GLOBAL git config --list',
      'env -u HOME git diff',
      'env -i git config --list',
      'env --ignore-environment git diff --cached',
      'env - git config --list',
      'exec -c git config --list',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps confirmation for explicit executables, wrappers and runtime overrides', async () => {
    const history = new GitCredentialHistory();
    const executable = path.join(repo, 'git');
    write('git', '#!/bin/sh\nprintf "runtime-mismatch\\n"\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(executable, 0o755);
      expect(execFileSync(executable, ['diff'], { cwd: repo, encoding: 'utf8' })).toBe('runtime-mismatch\n');
    }
    expect(await provesSafe(history, 'git diff')).toBe(true);
    expect(await provesSafe(history, 'git diff --cached')).toBe(true);
    expect(await provesSafe(history, 'git config --list')).toBe(true);
    for (const command of [
      './git diff',
      './git config --list',
      '"' + executable + '" diff',
      '/usr/bin/git config --list',
      'git.exe diff',
      'GIT diff',
      'PATH=/other/bin git diff',
      'env PATH=/other/bin git config --list',
      'LD_PRELOAD=/other/lib.so git diff',
      'DYLD_INSERT_LIBRARIES=/other/lib.dylib git config --list',
      'command -p git diff',
      'env git config --list',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
  });

  it('keeps confirmation when the inherited PATH has a relative search directory', async () => {
    const history = new GitCredentialHistory();
    const command = 'git diff';
    expect(await provesSafe(history, command)).toBe(true);
    vi.stubEnv('PATH', '.' + path.delimiter + process.env.PATH);
    expect(await provesSafe(history, command)).toBe(false);
    await requiresCredentialConfirmation(history, command);
  });

  it('keeps confirmation for inherited shell startup hooks and exported functions', async () => {
    const history = new GitCredentialHistory();
    const startupFile = path.join(root, 'bash-env');
    const credentialFile = path.join(root, '.env');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=shell-startup\n');
    const payload = 'cat ' + JSON.stringify(credentialFile.split(path.sep).join('/'));
    fs.writeFileSync(startupFile, 'git() { ' + payload + '; }\n');
    expect(await provesSafe(history, 'git diff')).toBe(true);
    vi.stubEnv('BASH_ENV', startupFile);
    if (process.platform !== 'win32') {
      expect(execFileSync('/bin/bash', ['-c', 'git diff'], { cwd: repo, encoding: 'utf8' }))
        .toContain('PRIVATE_FIXTURE=shell-startup');
    }
    for (const command of ['git diff', 'git config --list']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    vi.stubEnv('BASH_ENV', undefined);
    expect(await provesSafe(history, 'git diff')).toBe(true);
    for (const key of ['ENV', 'ZDOTDIR', 'BASH_FUNC_git%%']) {
      vi.stubEnv(key, key.startsWith('BASH_FUNC_') ? '() { ' + payload + '; }' : startupFile);
      expect(await provesSafe(history, 'git diff'), key).toBe(false);
      await requiresCredentialConfirmation(history, 'git diff');
      vi.stubEnv(key, undefined);
    }
    expect(await provesSafe(history, 'git diff')).toBe(true);
  });

  it('keeps consent for custom Bash and other unverified shell executables', async () => {
    const history = new GitCredentialHistory();
    const shellFile = path.join(root, process.platform === 'win32' ? 'bash.exe' : 'bash');
    const credentialFile = path.join(root, '.env');
    const invokedFile = path.join(root, 'custom-shell-invoked');
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=custom-shell\n');
    fs.writeFileSync(shellFile, '#!/bin/sh\nprintf called > ' + JSON.stringify(invokedFile.split(path.sep).join('/'))
      + '\ncat ' + JSON.stringify(credentialFile.split(path.sep).join('/')) + '\n');
    fs.chmodSync(shellFile, 0o700);
    expect(await provesSafe(history, 'git diff')).toBe(true);
    vi.stubEnv(process.platform === 'win32' ? 'CLAUDE_CODE_GIT_BASH_PATH' : 'SHELL', shellFile);
    const selected = executorShell.resolveExecutorShell();
    expect(selected.file).toBe(shellFile);
    if (process.platform !== 'win32') {
      const output = spawnSync(selected.file, ['-c', 'git diff'], { cwd: repo, encoding: 'utf8' });
      expect(output.stdout + output.stderr).toContain('PRIVATE_FIXTURE=custom-shell');
      expect(output.status).toBe(0);
      fs.unlinkSync(invokedFile);
    }
    for (const command of ['git diff', 'git status', 'git config --list']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
      expect(fs.existsSync(invokedFile), command).toBe(false);
    }
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', undefined);
    expect(await provesSafe(history, 'git diff')).toBe(true);
    const shell = vi.spyOn(executorShell, 'resolveExecutorShell');
    for (const name of ['bash', 'bash.exe', 'cmd.exe']) {
      shell.mockReturnValue({ file: path.join(root, 'custom', name), dialect: name === 'cmd.exe' ? 'cmd' : 'bash',
        scriptName: 'script.sh', args: ['script.sh'] });
      expect(await provesSafe(history, 'git diff'), name).toBe(false);
    }
    shell.mockRestore();
    expect(await provesSafe(history, 'git diff')).toBe(true);
  });

  it('keeps confirmation for zsh default and compiled startup files without ZDOTDIR', async () => {
    const history = new GitCredentialHistory();
    const home = path.join(root, 'home');
    const credentialFile = path.join(root, '.env');
    const startupFile = path.join(home, '.zshenv');
    fs.mkdirSync(home);
    fs.writeFileSync(credentialFile, 'PRIVATE_FIXTURE=zsh-startup\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('ZDOTDIR', undefined);
    expect(await provesSafe(history, 'git diff')).toBe(true);
    fs.writeFileSync(startupFile, 'git() { cat ' + JSON.stringify(credentialFile.split(path.sep).join('/')) + '; }\n');
    const shell = vi.spyOn(executorShell, 'resolveExecutorShell').mockReturnValue({
      file: '/bin/zsh', dialect: 'bash', scriptName: 'script.sh', args: ['script.sh'],
    });
    if (process.platform !== 'win32' && fs.existsSync('/bin/zsh')) {
      expect(execFileSync('/bin/zsh', ['-c', 'git diff'], { cwd: repo, encoding: 'utf8' }))
        .toContain('PRIVATE_FIXTURE=zsh-startup');
    }
    for (const command of ['git diff', 'git config --list']) {
      expect(await provesSafe(history, command), command).toBe(false);
      await requiresCredentialConfirmation(history, command);
    }
    fs.renameSync(startupFile, startupFile + '.zwc');
    expect(await provesSafe(history, 'git diff')).toBe(false);
    fs.unlinkSync(startupFile + '.zwc');
    const globalStartups = ['/etc/zshenv', '/etc/zsh/zshenv'].flatMap((file) => [file, file + '.zwc']);
    if (!globalStartups.some((file) => fs.existsSync(file))) {
      expect(await provesSafe(history, 'git diff')).toBe(true);
    }
    const stats = vi.spyOn(fsPromises, 'lstat').mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }));
    expect(await provesSafe(history, 'git diff')).toBe(false);
    stats.mockImplementation(() => new Promise<never>(() => {}));
    const bounded = new GitCredentialHistory({ waitMs: 10 });
    const started = Date.now();
    expect(await provesSafe(bounded, 'git diff')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    await requiresCredentialConfirmation(bounded, 'git config --list');
    stats.mockRestore();
    shell.mockReturnValue({ file: '/custom/bin/zsh', dialect: 'bash', scriptName: 'script.sh', args: ['script.sh'] });
    expect(await provesSafe(history, 'git diff')).toBe(false);
    shell.mockRestore();
    expect(await provesSafe(history, 'git diff')).toBe(true);
  });

  it('keeps asking where the scan does not reach', async () => {
    const history = new GitCredentialHistory();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'a.txt'), 'a');
    for (const command of [
      'GIT_DIR=/other/.git git log -p',
      'git diff --no-index a b',
      `git diff ${path.join(outside, 'a.txt')} src/app.ts`,
      'git log -p ORIG_HEAD',
      'git grep --recurse-submodules x',
      'git log -p $(cat revs)',
    ]) {
      expect(await provesSafe(history, command), command).toBe(false);
    }
    // 不在 git 仓库里。
    expect(await provesSafe(history, 'git log -p', outside)).toBe(false);
    // 认不出目录。
    expect(await history.provesSafe('git log -p', [{ sub: 'log', args: ['-p'] }])).toBe(false);
    // 带子模块。
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD').trim()},vendor/lib`);
    expect(await provesSafe(history, 'git log -p')).toBe(false);
  });

  it('does not keep the command waiting past the limit', async () => {
    const history = new GitCredentialHistory({ waitMs: 0 });
    expect(await provesSafe(history, 'git log -p')).toBe(false);
    // 扫描在后台继续；等它结束再清理(Windows 上 git 进程占着目录时删不掉)。
    await vi.waitFor(() => fs.rmSync(root, { recursive: true, force: true }), { timeout: 30_000, interval: 200 });
  });
});
