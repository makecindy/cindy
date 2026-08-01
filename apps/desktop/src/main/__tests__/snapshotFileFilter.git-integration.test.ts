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
