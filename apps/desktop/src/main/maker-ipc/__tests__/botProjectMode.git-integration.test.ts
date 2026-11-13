import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({ listProjectAliases: async () => [], upsertProjectAlias: async () => {} }));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ normalizeRecentWorkdirPath: (p: string) => p, upsertRecentWorkdir: async () => true }));
vi.mock('../../sidebarSettingsStore.js', () => ({ restoreLocalProjectVisibility: async () => {} }));
vi.mock('../../appSessionState.js', () => ({ getActiveDataOwnerPushStamp: () => ({}) }));
vi.mock('../../worktree/WorktreeManager.js', async () => ({ detectCwd: (await import('../../worktree/detectCwd.js')).detectCwd }));
// Keep the real memory helpers without loading the unrelated agent harness barrel.
vi.mock('@cindy/maker-core', async () => {
  const [manager, storage, types, resolver] = await Promise.all([
    import('../../../../../../packages/maker-core/src/memory/manager.js'),
    import('../../../../../../packages/maker-core/src/memory/storage.js'),
    import('../../../../../../packages/maker-core/src/memory/types.js'),
    import('../../../../../../packages/maker-core/src/memory/scope-resolver.js'),
  ]);
  return {
    MEMORY_STORAGE_MIGRATION_RECEIPT: manager.MEMORY_STORAGE_MIGRATION_RECEIPT,
    parseFilename: storage.parseFilename,
    memoryScopeDirName: storage.memoryScopeDirName,
    MemoryError: types.MemoryError,
    resolveMemoryScopeKey: resolver.resolveMemoryScopeKey,
  };
});

import { prepareBotProjectWorkspace, readWorkspaceRepositoryStatus } from '../botProjectMode.js';
import { teammateWorkspaceDir } from '../botProjectMemory.js';
import { gitExec } from '../../worktree/gitExec.js';

/*
 * #10216: prepareBotProjectWorkspace must recover a failed first commit, keep files/config,
 * register the project on failure, and leave committed or damaged repositories alone.
 * Existing unit tests replace snapshots and report Git unavailable, so cannot catch this.
 * Minimal failure: git init succeeds without an identity, then the same workspace is retried
 * after setting a repository-local identity. Real Git/ref/index semantics require git-integration.
 */
describe('buddy repository initialization (#10216)', () => {
  let root: string;
  const prepare = (botId: string) => prepareBotProjectWorkspace({ botId, displayName: 'Test buddy', ownerRoot: root });
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-buddy-git-'));
    const config = path.join(root, 'isolated.gitconfig');
    await fs.writeFile(config, '[user]\n\tuseConfigOnly = true\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG_SYSTEM', config);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '0');
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) vi.stubEnv(key, undefined);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('recovers after local identity is supplied, preserves user files/config, and is then idempotent', async () => {
    const failed = await prepare('missing_identity');
    expect(failed.repository).toBe('failed');
    expect(failed.registered).toBe(true);
    const workspace = failed.workingDir;
    expect(await readWorkspaceRepositoryStatus(workspace)).toBe('needs-identity');
    await expect(gitExec(['rev-parse', '--verify', 'HEAD'], workspace)).rejects.toThrow();
    await fs.writeFile(path.join(workspace, 'notes.md'), 'Keep these notes\n');
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    const config = await fs.readFile(path.join(workspace, '.git', 'config'), 'utf8');
    expect(await readWorkspaceRepositoryStatus(workspace)).toBe('not-ready');
    await expect(gitExec(['rev-parse', '--verify', 'HEAD'], workspace)).rejects.toThrow();
    const recovered = await prepare('missing_identity');
    expect(recovered.repository).toBe('initialized');
    expect(await readWorkspaceRepositoryStatus(workspace)).toBe('ready');
    expect((await gitExec(['show', 'HEAD:notes.md'], workspace)).stdout).toBe('Keep these notes\n');
    expect((await gitExec(['log', '-1', '--format=%an <%ae>'], workspace)).stdout.trim()).toBe('Test Author <author@example.invalid>');
    expect(await fs.readFile(path.join(workspace, '.git', 'config'), 'utf8')).toBe(config);
    const head = (await gitExec(['rev-parse', 'HEAD'], workspace)).stdout;
    await fs.writeFile(path.join(workspace, 'notes.md'), 'Uncommitted user changes\n');
    expect((await prepare('missing_identity')).repository).toBe('already-git');
    expect((await gitExec(['rev-parse', 'HEAD'], workspace)).stdout).toBe(head);
    expect(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8')).toBe('Uncommitted user changes\n');
  });

  it('does not overwrite a broken .git entry when repository detection fails', async () => {
    const workspace = teammateWorkspaceDir(root, 'broken_metadata');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, '.git'), 'broken metadata\n');
    const result = await prepare('broken_metadata');
    expect(result.repository).toBe('failed');
    expect(result.registered).toBe(true);
    expect(await readWorkspaceRepositoryStatus(workspace)).toBe('failed');
    expect(await fs.readFile(path.join(workspace, '.git'), 'utf8')).toBe('broken metadata\n');
  });

  // PR #10251: opening settings must not trust a foreign-owned repository globally.
  // Existing status cases use owned repositories and miss gitExec's automatic repair.
  // Real Git ownership rejection plus isolated global config require git-integration.
  it('reports foreign ownership without changing Git trust or repository files', async () => {
    const workspace = teammateWorkspaceDir(root, 'foreign_owner');
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    const configPath = path.join(root, 'isolated.gitconfig');
    const globalConfig = await fs.readFile(configPath, 'utf8');
    const localConfig = await fs.readFile(path.join(workspace, '.git', 'config'), 'utf8');
    const head = await fs.readFile(path.join(workspace, '.git', 'HEAD'), 'utf8');
    const previousOwnerOverride = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
    try {
      expect.soft(await readWorkspaceRepositoryStatus(workspace)).toBe('failed');
      expect.soft(await fs.readFile(configPath, 'utf8')).toBe(globalConfig);
      expect(await fs.readFile(path.join(workspace, '.git', 'config'), 'utf8')).toBe(localConfig);
      expect(await fs.readFile(path.join(workspace, '.git', 'HEAD'), 'utf8')).toBe(head);
    } finally {
      vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', previousOwnerOverride);
    }
  });

  it('does not treat a branch referencing a missing commit as unborn', async () => {
    const result = await prepare('missing_object');
    const branch = (await gitExec(['symbolic-ref', 'HEAD'], result.workingDir)).stdout.trim();
    const refFile = path.join(result.workingDir, '.git', ...branch.split('/'));
    await fs.mkdir(path.dirname(refFile), { recursive: true });
    const badRef = `${'1'.repeat(40)}\n`;
    await fs.writeFile(refFile, badRef);
    expect((await prepare('missing_object')).repository).toBe('failed');
    expect(await fs.readFile(refFile, 'utf8')).toBe(badRef);
  });
});
