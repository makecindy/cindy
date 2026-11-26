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

import { BOT_PROJECT_MEMORY_GITIGNORE, ensureTeammateProjectIgnored, prepareBotProjectWorkspace, readWorkspaceRepositoryStatus } from '../botProjectMode.js';
import { BOT_PROJECT_GITIGNORE } from '../botProjectGitignore.js';
import { legacyTeammateProjectMemoryDir, teammateProjectMemoryDir, teammateWorkspaceDir } from '../botProjectMemory.js';
import { gitExec } from '../../worktree/gitExec.js';
import { createShadowSavepoint } from '../../git-snapshot/gitSnapshotService.js';

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
    expect(failed.registered).toBe(false);
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
    expect(result.registered).toBe(false);
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

  // 2026-11-21 teammate project review: `.env`, `.venv` and worktrees entered teammate versions, and
  // an untracked venv (15k files measured) made every automatic snapshot exceed its file limit.
  // Unit tests check the appended text; only real Git shows how the entries are read: env templates
  // stay versioned (their exceptions follow `.env.*`), and an already committed file stays tracked.
  it('completes an older .gitignore so Git ignores credentials, environments and worktrees', async () => {
    const workspace = teammateWorkspaceDir(root, 'old_ignore');
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    await fs.writeFile(path.join(workspace, '.gitignore'), '!.env.example\n*.log\n!keep.log\n');
    await fs.writeFile(path.join(workspace, '.env'), 'COMMITTED=1\n');
    await gitExec(['add', '.gitignore', '.env'], workspace);
    await gitExec(['commit', '-m', 'v1'], workspace);
    await expect(ensureTeammateProjectIgnored({ botId: 'old_ignore', workspace })).resolves.toBe('ready');
    const ignored = (file: string) => gitExec(['check-ignore', '-q', file], workspace).then(() => true, () => false);
    for (const file of ['.env.local', '.agents/skills/a/.env', '.agents/skills/a/token.json', '.agents/skills/a/.venv/bin/python', 'venv/lib/x.py', '.cindy-worktrees/t/a.txt', 'key.pem']) {
      expect(await ignored(file), file).toBe(true);
    }
    for (const file of ['.env.example', 'notes.md', 'keep.log']) expect(await ignored(file), file).toBe(false);
    expect((await gitExec(['ls-files', '.env'], workspace)).stdout.trim()).toBe('.env');
    expect(await fs.readFile(path.join(workspace, '.env'), 'utf8')).toBe('COMMITTED=1\n');
  });

  // Maintainer review 2026-11-24: when an older project's .gitignore could not be completed, the
  // upgrade went on to record a version, so an untracked token.json entered the history before the
  // next start could add the rule. Minimal failure: committed old .gitignore made read-only, an
  // untracked token.json, then the first preparation; then the file is writable again on the next start.
  // The old file already has the memory entries (as every project after the memory move does).
  it.skipIf(process.getuid?.() === 0)('records no version while the .gitignore cannot be completed, and completes it on the next start', async () => {
    const workspace = teammateWorkspaceDir(root, 'readonly_ignore');
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    const ignore = path.join(workspace, '.gitignore');
    const before = ['node_modules/', ...BOT_PROJECT_MEMORY_GITIGNORE, ''].join('\n');
    await fs.writeFile(ignore, before);
    await gitExec(['add', '.gitignore'], workspace);
    await gitExec(['commit', '-m', 'v1'], workspace);
    await fs.writeFile(path.join(workspace, 'token.json'), '{"refresh_token":"fixture"}\n');
    const versioned = async () => (await gitExec(['log', '--all', '--name-only', '--format='], workspace)).stdout.split('\n').includes('token.json');
    await fs.chmod(ignore, 0o444);
    try {
      await prepare('readonly_ignore');
      expect(await versioned()).toBe(false);
      expect(await fs.readFile(ignore, 'utf8')).toBe(before);
    } finally { await fs.chmod(ignore, 0o644); }

    // Next start, writable again: the rules are completed and the credential stays out of Git.
    await prepare('readonly_ignore');
    await expect(gitExec(['check-ignore', '-q', 'token.json'], workspace)).resolves.toBeDefined();
    expect(await versioned()).toBe(false);
  });

  // Maintainer review 2026-11-24 (06:37): a first-time teammate (no project-memory-move.json) whose
  // old .gitignore has neither list. Read-only: the memory move wrote the same file again and its
  // EACCES stopped the preparation. A link: the memory move counted it as unchanged and wrote its
  // receipt, so once a regular file was back only the credential rules were added and the memory's
  // derived files stayed versionable. Nothing is prefilled; the retry uses a writable regular file.
  async function firstPreparationWithUnwritableIgnore(botId: string, kind: 'read-only' | 'link'): Promise<'skipped' | void> {
    const workspace = teammateWorkspaceDir(root, botId);
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    const ignore = path.join(workspace, '.gitignore');
    if (kind === 'link') {
      const target = path.join(root, `${botId}.gitignore`);
      await fs.writeFile(target, 'node_modules/\ntoken.json\n');
      try { await fs.symlink(target, ignore); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return 'skipped';
        throw error;
      }
    } else await fs.writeFile(ignore, 'node_modules/\n');
    await gitExec(['add', '.gitignore'], workspace);
    await gitExec(['commit', '-m', 'v1'], workspace);
    const outside = await legacyTeammateProjectMemoryDir(root, workspace);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'project_launch.md'), 'Launch on Friday\n');
    await fs.writeFile(path.join(workspace, 'token.json'), '{"refresh_token":"fixture"}\n');
    const versioned = async () => (await gitExec(['log', '--all', '--name-only', '--format='], workspace)).stdout.split('\n').includes('token.json');
    const ignored = (file: string) => gitExec(['check-ignore', '-q', file], workspace).then(() => true, () => false);

    if (kind === 'read-only') await fs.chmod(ignore, 0o444);
    try {
      await expect(prepare(botId)).resolves.toMatchObject({ workingDir: workspace });
      // Not interrupted: the memory moved in; no version took the untracked credential.
      expect(await fs.readFile(path.join(teammateProjectMemoryDir(workspace), 'project_launch.md'), 'utf8')).toBe('Launch on Friday\n');
      expect(await versioned()).toBe(false);
    } finally { if (kind === 'read-only') await fs.chmod(ignore, 0o644); }

    // Next start with a writable regular file: both lists are completed, still nothing versioned.
    if (kind === 'link') { await fs.rm(ignore); await fs.writeFile(ignore, 'node_modules/\n'); }
    await expect(prepare(botId)).resolves.toMatchObject({ workingDir: workspace });
    for (const file of ['token.json', '.cindy/memory/fts.db', '.cindy/memory/meta.json']) {
      expect(await ignored(file), file).toBe(true);
    }
    expect(await ignored('.cindy/memory/MEMORY.md')).toBe(false);
    expect(await ignored('.cindy/memory/project_launch.md')).toBe(false);
    expect(await versioned()).toBe(false);
  }

  it.skipIf(process.getuid?.() === 0)('keeps preparing a first-time teammate whose read-only .gitignore lacks both lists, completing them later', async () => {
    await firstPreparationWithUnwritableIgnore('readonly_first', 'read-only');
  });

  it('keeps preparing a first-time teammate whose .gitignore is a link, completing both lists once it is a file', async (ctx) => {
    if (await firstPreparationWithUnwritableIgnore('linked_first', 'link') === 'skipped') ctx.skip();
  });

  // Maintainer review 2026-11-24 (07:18, 08:03): lines were compared trimmed and as a set. Git reads
  // ` token.json` (leading space) as another pattern, exceptions written above `.env.*` are
  // overridden by it, and a later `!*.json` lets token.json back in; each counted as present and the
  // receipt let versions go ahead. The old rules stay at the start; the block goes below them.
  async function preparedWithOldRules(botId: string, rules: string) {
    const workspace = teammateWorkspaceDir(root, botId);
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    await fs.writeFile(path.join(workspace, '.gitignore'), rules);
    await gitExec(['add', '.gitignore'], workspace);
    await gitExec(['commit', '-m', 'v1'], workspace);
    await fs.writeFile(path.join(workspace, 'token.json'), '{"refresh_token":"fixture"}\n');
    await fs.writeFile(path.join(workspace, '.env.example'), 'API_KEY=\n');
    await expect(prepare(botId)).resolves.toMatchObject({ workingDir: workspace });
    const versioned = (await gitExec(['log', '--all', '--name-only', '--format='], workspace)).stdout.split('\n');
    const ignored = (file: string) => gitExec(['check-ignore', '-q', file], workspace).then(() => true, () => false);
    expect(await fs.readFile(path.join(workspace, '.gitignore'), 'utf8')).toMatch(new RegExp(`^${rules.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(versioned).not.toContain('token.json');
    expect(await ignored('token.json')).toBe(true);
    expect(await ignored('.env.local')).toBe(true);
    expect(await ignored('.env.example')).toBe(false);
  }

  it('adds a rule an old .gitignore only has with a leading space', async () => {
    await preparedWithOldRules('spaced_rule', 'node_modules/\n token.json\n');
  });

  it('re-adds env template exceptions an old .gitignore lists above .env.*', async () => {
    await preparedWithOldRules('early_exceptions', '!.env.example\n!.env.sample\n!.env.template\n.env\n.env.*\n');
  });

  // Maintainer review 2026-11-24 (08:03): a later rule of the owner's matched the file the other way.
  it('keeps token.json out when an old .gitignore lets JSON back in below it', async () => {
    await preparedWithOldRules('json_back_in', 'token.json\n!*.json\n');
  });

  // Review rounds 2026-11-24: each round found one more Git ignore rule our own reading of an old
  // .gitignore got wrong. The block now goes at the end; Git itself checks the outcome for old files
  // written to defeat it (later negations, spacing, order, line endings, our block not last).
  it.each([
    ['a later !*.json', 'token.json\n!*.json\n'],
    ['a negated token.json', '!token.json\n'],
    ['a leading space', ' token.json\n'],
    ['exceptions above .env.*', '!.env.example\n.env.*\n'],
    ['CRLF and a negated .env', 'node_modules/\r\n!.env\r\n'],
    ['no final newline', 'node_modules/'],
    ['negated folders', '!.venv/\n!venv/\n!.cindy-worktrees/\n!.cindy/memory/MEMORY.md\n'],
    ['the default list followed by negations', `${BOT_PROJECT_GITIGNORE}!token.json\n!*.pem\n`],
  ])('completes an old .gitignore with %s so Git ignores what the lists name', async (_name, rules) => {
    const workspace = teammateWorkspaceDir(root, `adversarial_${rules.length}_${_name.replace(/\W+/g, '_')}`);
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    await fs.writeFile(path.join(workspace, '.gitignore'), rules);
    await expect(ensureTeammateProjectIgnored({ workspace })).resolves.toBe('ready');
    expect((await fs.readFile(path.join(workspace, '.gitignore'), 'utf8')).startsWith(rules)).toBe(true);
    const ignored = (file: string) => gitExec(['check-ignore', '-q', file], workspace).then(() => true, () => false);
    for (const file of ['token.json', '.env', '.env.local', 'credentials.json', 'key.pem', '.venv/bin/python', 'venv/lib/x.py',
      '.cindy-worktrees/t/a.txt', '.agents/skills/a/token.json', '.cindy/memory/fts.db']) {
      expect(await ignored(file), file).toBe(true);
    }
    for (const file of ['.env.example', '.cindy/memory/MEMORY.md', '.cindy/memory/project_launch.md', '.cindy/memory/.cindy-memory-migration-v1.json', 'notes.md']) {
      expect(await ignored(file), file).toBe(false);
    }
  });

  // Codex review 2026-11-24 (07:28): while a teammate project's .gitignore cannot take the entries
  // (here: a folder) preparation goes on, so an ordinary turn's savepoint (GitSnapshotCoordinator →
  // createShadowSavepoint, also the pre-rollback one) stored the untracked token under refs/cindy.
  it('takes no savepoint of a teammate project before its .gitignore is complete', async () => {
    // The layout the host gives a teammate project: <userData>/owners/<account>/bots/<teammate>/workspace.
    const workspace = teammateWorkspaceDir(path.join(root, 'owners', 'test-owner'), 'savepoint_gate');
    await fs.mkdir(path.join(workspace, '.gitignore'), { recursive: true });
    await gitExec(['init'], workspace);
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    await fs.writeFile(path.join(workspace, 'notes.md'), 'notes\n');
    await gitExec(['add', 'notes.md'], workspace);
    await gitExec(['commit', '-m', 'v1'], workspace);
    await fs.writeFile(path.join(workspace, 'token.json'), '{"refresh_token":"fixture"}\n');
    const versioned = async () => (await gitExec(['log', '--all', '--name-only', '--format='], workspace)).stdout.split('\n').includes('token.json');
    const turnStart = () => createShadowSavepoint(workspace, { sessionId: 'turn-session', label: 'turn start', meta: { kind: 'turn-start' } });

    await expect(turnStart()).rejects.toThrow();
    expect(await versioned()).toBe(false);
    // A regular file again: the next turn completes the rules first, then the savepoint leaves the token out.
    await fs.rm(path.join(workspace, '.gitignore'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.gitignore'), 'node_modules/\n');
    await expect(turnStart()).resolves.toMatchObject({ commit: expect.any(String) });
    expect(await versioned()).toBe(false);
  });

  // Codex review 2026-11-24 (09:13): the startup upgrade (prepareBotProjectWorkspace) and a task's
  // savepoint (createShadowSavepoint) completing the same old project at once could lose the owner's
  // rules and let a credential into the savepoint. Both production entries run together here.
  it('keeps the owner\'s rules and the credential out when preparation and a savepoint complete together', async () => {
    const ownerRoot = path.join(root, 'owners', 'race-owner');
    const workspace = teammateWorkspaceDir(ownerRoot, 'race_buddy');
    await fs.mkdir(workspace, { recursive: true });
    await gitExec(['init'], workspace);
    await gitExec(['config', '--local', 'user.name', 'Test Author'], workspace);
    await gitExec(['config', '--local', 'user.email', 'author@example.invalid'], workspace);
    await fs.writeFile(path.join(workspace, '.gitignore'), 'auth.json\n');
    await gitExec(['add', '.gitignore'], workspace);
    await gitExec(['commit', '-m', 'v1'], workspace);
    await fs.writeFile(path.join(workspace, 'auth.json'), '{"session":"fixture"}\n');
    await fs.writeFile(path.join(workspace, 'token.json'), '{"refresh_token":"fixture"}\n');
    await Promise.all([
      prepareBotProjectWorkspace({ botId: 'race_buddy', displayName: 'Race buddy', ownerRoot }),
      createShadowSavepoint(workspace, { sessionId: 'race-session', label: 'turn start', meta: { kind: 'turn-start' } }),
    ]);
    const text = await fs.readFile(path.join(workspace, '.gitignore'), 'utf8');
    expect(text.startsWith('auth.json\n')).toBe(true);
    expect(text.split('\n').filter(line => line === 'token.json')).toHaveLength(1);
    const versioned = (await gitExec(['log', '--all', '--name-only', '--format='], workspace)).stdout.split('\n');
    expect(versioned).not.toContain('token.json');
    expect(versioned).not.toContain('auth.json');
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
