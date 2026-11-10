import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSnapshotFilePlan,
  buildSnapshotFilePlanFromEntries,
  parseStatusPorcelainZ,
} from '../git-snapshot/snapshotFileFilter';
import { ensureManagedWorktreeExcluded } from '../worktree/managedWorktreeExclude';
import { OperationBudget } from '../utils/operationBudget';

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd }, (err) => (err ? reject(err) : resolve()));
  });
}

async function writeRepoFile(
  repoPath: string,
  gitPath: string,
  content: string | Buffer,
): Promise<void> {
  const filePath = path.join(repoPath, ...gitPath.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

const literal = (gitPath: string): string => `:(literal)${gitPath}`;

describe('parseStatusPorcelainZ', () => {
  it('consumes the extra old-path record for rename entries', () => {
    const output = [
      'MM a space.txt',
      'R  rename new.txt',
      'rename-old.txt',
      '?? new file.txt',
      '',
    ].join('\0');

    expect(parseStatusPorcelainZ(output)).toEqual([
      { code: 'MM', path: 'a space.txt' },
      { code: 'R ', path: 'rename new.txt', oldPath: 'rename-old.txt' },
      { code: '??', path: 'new file.txt' },
    ]);
  });
});

describe('buildSnapshotFilePlan', () => {
  let testRoot: string;
  let repoPath: string;

  beforeEach(async () => {
    testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-snapshot-filter-')));
    repoPath = path.join(testRoot, 'repo');
    await fs.mkdir(repoPath);

    const globalConfig = path.join(testRoot, 'global.gitconfig');
    const systemConfig = path.join(testRoot, 'system.gitconfig');
    await Promise.all([fs.writeFile(globalConfig, ''), fs.writeFile(systemConfig, '')]);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
    vi.stubEnv('GIT_CONFIG_COUNT', '0');

    await git(repoPath, ['init']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('includes ordinary dirty files from git status', async () => {
    await writeRepoFile(repoPath, 'src/app.ts', 'export const value = 1;\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.skippedFiles).toEqual([]);
    expect(plan.includedFiles).toEqual([
      { path: 'src/app.ts', pathsForPathspec: [literal('src/app.ts')] },
    ]);
  });

  // #6901: the file-count gate must run before per-path IO, and the directory
  // cache must not hide a nested .git created between two captures. Real fs
  // fixtures belong in the integration tier; existing tests only scan once.
  it('rejects an oversized status plan before inspecting its paths', async () => {
    const lstat = vi.spyOn(fs, 'lstat');
    await expect(buildSnapshotFilePlanFromEntries(repoPath, [
      { code: '??', path: 'a.txt' }, { code: '??', path: 'b.txt' },
    ], { maxFiles: 1 })).rejects.toMatchObject({ reason: 'file-count' });
    expect(lstat).not.toHaveBeenCalled();
  });

  it('rechecks nested repository markers on the next scan', async () => {
    await writeRepoFile(repoPath, 'nested/a.txt', 'aa');
    await writeRepoFile(repoPath, 'nested/b.txt', 'bb');
    const entries = ['nested/a.txt', 'nested/b.txt'].map((path) => ({ code: '??', path }));
    const first = await buildSnapshotFilePlanFromEntries(repoPath, entries);
    expect(first.includedFiles).toHaveLength(2);
    await fs.mkdir(path.join(repoPath, 'nested/.git'));
    const second = await buildSnapshotFilePlanFromEntries(repoPath, entries);
    expect(second.includedFiles).toEqual([]);
    expect(second.skippedFiles.map((file) => file.reason)).toEqual(['nested-git-repo', 'nested-git-repo']);
  });

  it('does not execute repository-local fsmonitor when reading git status', async () => {
    const marker = path.join(testRoot, 'fsmonitor-ran');
    const script = path.join(testRoot, 'fsmonitor.js');
    await fs.writeFile(
      script,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(0);\n`,
    );
    await git(repoPath, ['config', 'core.fsmonitor', `node ${JSON.stringify(script)}`]);
    await writeRepoFile(repoPath, 'src/app.ts', 'export const value = 1;\n');

    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.includedFiles.map((file) => file.path)).toEqual(['src/app.ts']);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips sensitive paths while allowing env templates', async () => {
    await writeRepoFile(repoPath, '.env', 'TOKEN=secret\n');
    await writeRepoFile(repoPath, 'config/secrets.json', '{}\n');
    await writeRepoFile(repoPath, 'secrets/prod.json', '{}\n');
    await writeRepoFile(repoPath, 'credentials/aws.env', 'TOKEN=secret\n');
    await writeRepoFile(repoPath, '.git-credentials', 'https://token@example.com\n');
    await writeRepoFile(repoPath, '.kube/config', 'token: secret\n');
    await writeRepoFile(repoPath, '.config/gcloud/application_default_credentials.json', '{"client_secret":"secret"}\n');
    await writeRepoFile(repoPath, '.config/gh/hosts.yml', 'oauth_token: secret\n');
    await writeRepoFile(repoPath, '.pip/pip.conf', 'global.index-url = https://token@example.com/simple\n');
    await writeRepoFile(repoPath, '.pip/pip.ini', 'global.index-url = https://token@example.com/simple\n');
    await writeRepoFile(repoPath, '.config/pip/pip.conf', 'global.index-url = https://token@example.com/simple\n');
    await writeRepoFile(repoPath, '.config/pip/pip.ini', 'global.index-url = https://token@example.com/simple\n');
    await writeRepoFile(repoPath, '.azure/accessTokens.json', '[]\n');
    await writeRepoFile(repoPath, 'keys/id_ed25519', 'private key\n');
    await writeRepoFile(repoPath, 'certs/client.pem', 'private key\n');
    await writeRepoFile(repoPath, '.env.example', 'TOKEN=placeholder\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.includedFiles).toEqual([
      { path: '.env.example', pathsForPathspec: [literal('.env.example')] },
    ]);
    for (const [filePath, detector] of [
      ['.env', 'env-file'],
      ['config/secrets.json', 'secret-config-path'],
      ['secrets/prod.json', 'secret-directory'],
      ['credentials/aws.env', 'credentials-directory'],
      ['.git-credentials', 'sensitive-basename'],
      ['.kube/config', 'sensitive-directory'],
      ['.config/gcloud/application_default_credentials.json', 'sensitive-path'],
      ['.config/gh/hosts.yml', 'sensitive-path'],
      ['.pip/pip.conf', 'sensitive-path'],
      ['.pip/pip.ini', 'sensitive-path'],
      ['.config/pip/pip.conf', 'sensitive-path'],
      ['.config/pip/pip.ini', 'sensitive-path'],
      ['.azure/accessTokens.json', 'sensitive-directory'],
      ['keys/id_ed25519', 'private-key-path'],
      ['certs/client.pem', 'sensitive-extension'],
    ]) {
      expect(plan.skippedFiles).toContainEqual(
        expect.objectContaining({ path: filePath, reason: 'sensitive-path', detector }),
      );
    }
  });

  it('does not skip ordinary files under CLI config directories', async () => {
    await writeRepoFile(repoPath, '.config/gcloud/README.md', '# Fixture\n');
    await writeRepoFile(repoPath, '.config/gcloud/configurations/config_default', '[core]\n');
    await writeRepoFile(repoPath, '.config/gh/example.yml', 'example: true\n');
    await writeRepoFile(repoPath, '.config/pip/README.md', '# pip fixture\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.skippedFiles).toEqual([]);
    expect(plan.includedFiles).toHaveLength(4);
    expect(plan.includedFiles).toEqual(expect.arrayContaining([
      { path: '.config/gh/example.yml', pathsForPathspec: [literal('.config/gh/example.yml')] },
      { path: '.config/gcloud/README.md', pathsForPathspec: [literal('.config/gcloud/README.md')] },
      { path: '.config/pip/README.md', pathsForPathspec: [literal('.config/pip/README.md')] },
      {
        path: '.config/gcloud/configurations/config_default',
        pathsForPathspec: [literal('.config/gcloud/configurations/config_default')],
      },
    ]));
  });

  it('skips OS metadata files', async () => {
    await writeRepoFile(repoPath, '.DS_Store', '');
    await writeRepoFile(repoPath, 'docs/Thumbs.db', '');
    await writeRepoFile(repoPath, 'desktop.ini', '');
    await writeRepoFile(repoPath, 'src/app.ts', 'export const value = 1;\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.includedFiles).toEqual([
      { path: 'src/app.ts', pathsForPathspec: [literal('src/app.ts')] },
    ]);
    expect(plan.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '.DS_Store',
        reason: 'ignored-os-metadata',
        detector: '.DS_Store',
      }),
      expect.objectContaining({
        path: 'docs/Thumbs.db',
        reason: 'ignored-os-metadata',
        detector: 'Thumbs.db',
      }),
      expect.objectContaining({
        path: 'desktop.ini',
        reason: 'ignored-os-metadata',
        detector: 'desktop.ini',
      }),
    ]));
  });

  it('does not inherit SkillHub-only Terraform package exclusions', async () => {
    await writeRepoFile(repoPath, '.terraformrc', 'credentials_helper = "example"\n');
    await writeRepoFile(repoPath, 'terraform.rc', 'credentials_helper = "example"\n');
    await writeRepoFile(repoPath, 'credentials.tfrc.json', '{}\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.skippedFiles).toEqual([
      expect.objectContaining({
        path: 'credentials.tfrc.json',
        reason: 'sensitive-path',
        detector: 'secret-config-path',
      }),
    ]);
    expect(plan.includedFiles).toEqual(expect.arrayContaining([
      { path: '.terraformrc', pathsForPathspec: [literal('.terraformrc')] },
      { path: 'terraform.rc', pathsForPathspec: [literal('terraform.rc')] },
    ]));
  });

  it('does not inherit SkillHub-only Maven package exclusions', async () => {
    await writeRepoFile(repoPath, '.m2/settings.xml', '<settings />\n');
    await writeRepoFile(repoPath, '.m2/settings-security.xml', '<settingsSecurity />\n');
    await writeRepoFile(repoPath, '.m2/repository/index.properties', 'created=1\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.skippedFiles).toEqual([]);
    expect(plan.includedFiles).toEqual(expect.arrayContaining([
      { path: '.m2/repository/index.properties', pathsForPathspec: [literal('.m2/repository/index.properties')] },
      { path: '.m2/settings-security.xml', pathsForPathspec: [literal('.m2/settings-security.xml')] },
      { path: '.m2/settings.xml', pathsForPathspec: [literal('.m2/settings.xml')] },
    ]));
  });

  it('returns literal pathspecs and preserves backslashes in file names', async () => {
    const plan = await buildSnapshotFilePlanFromEntries(repoPath, [
      { code: '??', path: ':(glob)*.ts' },
      { code: '??', path: 'large\\file.bin' },
    ]);
    expect(plan.skippedFiles).toEqual([]);
    expect(plan.includedFiles).toEqual([
      { path: ':(glob)*.ts', pathsForPathspec: [literal(':(glob)*.ts')] },
      { path: 'large\\file.bin', pathsForPathspec: [literal('large\\file.bin')] },
    ]);
  });

  it('skips files above the configured size limit', async () => {
    await writeRepoFile(repoPath, 'large.bin', Buffer.alloc(6));
    const plan = await buildSnapshotFilePlan(repoPath, { maxFileBytes: 5, maxContentScanBytes: 5 });

    expect(plan.includedFiles).toEqual([]);
    expect(plan.skippedFiles).toEqual([
      {
        path: 'large.bin',
        reason: 'large-file',
        sizeBytes: 6,
        pathsForPathspec: [literal('large.bin')],
      },
    ]);
  });

  it('skips nested git repositories', async () => {
    const nestedPath = path.join(repoPath, 'vendor', 'tool');
    await fs.mkdir(nestedPath, { recursive: true });
    await git(nestedPath, ['init']);
    await writeRepoFile(repoPath, 'vendor/tool/index.ts', 'export {};\n');
    const plan = await buildSnapshotFilePlan(repoPath);

    expect(plan.includedFiles).toEqual([]);
    expect(plan.skippedFiles).toContainEqual(
      expect.objectContaining({
        path: 'vendor/tool/',
        reason: 'nested-git-repo',
        pathsForPathspec: [literal('vendor/tool/')],
      }),
    );
  });

  // #7259, git-integration tier: cancel while native filesystem metadata is
  // pending. Existing scans only covered completed lstat calls.
  it('stops a stalled file scan and ignores the late filesystem result', async () => {
    await writeRepoFile(repoPath, 'slow.txt', 'slow');
    const budget = new OperationBudget(10_000);
    const nativeLstat = fs.lstat.bind(fs);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(repoPath, 'slow.txt')) {
        entered();
        await gate;
      }
      return nativeLstat(...args);
    });
    try {
      const scanning = budget.run(() => buildSnapshotFilePlanFromEntries(repoPath, [
        { code: '??', path: 'slow.txt' }, { code: '??', path: 'later.txt' },
      ]));
      await started;
      budget.cancel(new Error('stopped scan'));
      await expect(scanning).rejects.toThrow('stopped scan');
      release();
      expect(spy.mock.calls.some(([file]) => String(file) === path.join(repoPath, 'later.txt'))).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  // #7259: prove the exclusion changes real Git enumeration, including gitfile layouts.
  // Creation's mocked Git tests cannot verify root anchoring or tracked-file preservation.
  // Minimal input: managed noise, a tracked file and a nested same-name directory.
  // Windows 2026-10-26: this file alone took 4.07s wall clock (Vitest 2.33s).
  it('excludes managed untracked files through a gitfile without hiding tracked or ordinary project files', async () => {
    const gitDir = path.join(testRoot, 'separate git');
    await git(repoPath, ['init', '--separate-git-dir', gitDir]);
    const exclude = path.join(gitDir, 'info', 'exclude');
    await fs.writeFile(exclude, '# local rule\ncache/\n');
    await writeRepoFile(repoPath, '.cindy-worktrees/tracked.txt', 'before');
    await git(repoPath, ['add', '.cindy-worktrees/tracked.txt']);
    await writeRepoFile(repoPath, '.cindy-worktrees/tracked.txt', 'after');
    await writeRepoFile(repoPath, '.cindy-worktrees/managed/noise.txt', 'noise');
    await writeRepoFile(repoPath, '.xdt-worktrees/legacy/noise.txt', 'noise');
    await writeRepoFile(repoPath, 'src/.cindy-worktrees/user.txt', 'keep');
    await writeRepoFile(repoPath, 'ordinary/user.txt', 'keep');
    await writeRepoFile(repoPath, 'cache/cache.txt', 'noise');

    // Non-managed paths must not cause any local rule changes.
    await ensureManagedWorktreeExcluded(repoPath, path.join(repoPath, 'ordinary', 'example'));
    expect(await fs.readFile(exclude, 'utf8')).toBe('# local rule\ncache/\n');
    await Promise.all([
      ensureManagedWorktreeExcluded(repoPath, path.join(repoPath, '.cindy-worktrees', 'managed')),
      ensureManagedWorktreeExcluded(repoPath, path.join(repoPath, '.xdt-worktrees', 'legacy')),
    ]);
    const plan = await buildSnapshotFilePlan(repoPath);
    expect(plan.skippedFiles).toEqual([]);
    expect(plan.includedFiles.map((file) => file.path).sort()).toEqual([
      '.cindy-worktrees/tracked.txt', 'ordinary/user.txt', 'src/.cindy-worktrees/user.txt',
    ]);
    expect(await fs.readFile(exclude, 'utf8')).toContain('# local rule\ncache/\n');
    await expect(fs.access(path.join(repoPath, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // #7259 / #6901: sibling files used to repeat ancestor .git I/O. Existing
  // nested-repo tests do not cover scan-local reuse or invalidation between scans.
  // Two sibling files and a later .git marker are the minimal input (git-integration tier).
  it.each(['directory', 'file'])('reuses ancestor checks only within one scan, then detects a new .git %s', async (kind) => {
    await writeRepoFile(repoPath, 'src/deep/a.ts', 'a');
    await writeRepoFile(repoPath, 'src/deep/b.ts', 'b');
    const entries = ['src/deep/a.ts', 'src/deep/b.ts'].map((file) => ({ code: '??', path: file }));
    const marker = path.join(repoPath, 'src', '.git');
    const lstat = vi.spyOn(fs, 'lstat');
    try {
      const first = await buildSnapshotFilePlanFromEntries(repoPath, entries);
      expect(first.includedFiles.map((file) => file.path)).toEqual(entries.map((file) => file.path));
      expect(lstat.mock.calls.filter(([file]) => file === marker)).toHaveLength(1);

      if (kind === 'directory') await fs.mkdir(marker);
      else await fs.writeFile(marker, 'gitdir: elsewhere\n');
      const second = await buildSnapshotFilePlanFromEntries(repoPath, entries);
      expect(second.includedFiles).toEqual([]);
      expect(second.skippedFiles.map((file) => [file.path, file.reason])).toEqual(
        entries.map((file) => [file.path, 'nested-git-repo']),
      );
      expect(lstat.mock.calls.filter(([file]) => file === marker)).toHaveLength(2);
    } finally {
      lstat.mockRestore();
    }
  });

  it('checks rename oldPath for nested git repositories', async () => {
    const nestedPath = path.join(repoPath, 'vendor', 'tool');
    await fs.mkdir(nestedPath, { recursive: true });
    await git(nestedPath, ['init']);
    await writeRepoFile(repoPath, 'safe.ts', 'export {};\n');
    const plan = await buildSnapshotFilePlanFromEntries(repoPath, [
      { code: 'R ', path: 'safe.ts', oldPath: 'vendor/tool/index.ts' },
    ]);
    expect(plan.includedFiles).toEqual([]);
    expect(plan.skippedFiles).toEqual([
      {
        path: 'safe.ts',
        oldPath: 'vendor/tool/index.ts',
        reason: 'nested-git-repo',
        pathsForPathspec: [literal('safe.ts')],
      },
    ]);
  });

  it('skips conflict status entries', async () => {
    const plan = await buildSnapshotFilePlanFromEntries(repoPath, [
      { code: 'UU', path: 'conflicted.ts' },
      { code: 'AA', path: 'both-added.ts' },
      { code: 'DD', path: 'both-deleted.ts' },
    ]);
    expect(plan.includedFiles).toEqual([]);
    for (const filePath of ['conflicted.ts', 'both-added.ts', 'both-deleted.ts']) {
      expect(plan.skippedFiles).toContainEqual({
        path: filePath,
        reason: 'conflict',
        pathsForPathspec: [literal(filePath)],
      });
    }
  });

  it('rejects traversal paths and .git internals', async () => {
    const plan = await buildSnapshotFilePlanFromEntries(repoPath, [
      { code: '??', path: '../outside.txt' },
      { code: '??', path: '.git/config' },
    ]);
    expect(plan.includedFiles).toEqual([]);
    expect(plan.skippedFiles).toEqual([
      {
        path: '../outside.txt',
        reason: 'scan-failed',
        detector: 'path-traversal',
        pathsForPathspec: [literal('../outside.txt')],
      },
      {
        path: '.git/config',
        reason: 'sensitive-path',
        detector: 'git-internal-path',
        pathsForPathspec: [literal('.git/config')],
      },
    ]);
  });
});
