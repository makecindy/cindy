import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { botGroupFolderPath, createBotGroupWorkDir, parsePorcelainPaths } from '../botGroupWorkDir.js';

describe('botGroupWorkDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-group-workdir-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function create(overrides: Partial<Parameters<typeof createBotGroupWorkDir>[0]> = {}) {
    return createBotGroupWorkDir({
      ownerRoot: () => path.join(root, 'owner'),
      detectRepo: async () => ({ gitInstalled: true, isGitRepo: false }),
      prepareWorktree: vi.fn(async () => ({ ok: true as const, sessionId: 's-1', workingDir: '/repo/.cindy-worktrees/a', branch: 'cindy/a' })),
      git: async () => {
        throw new Error('not a git repository');
      },
      trashItem: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it("creates the group's own folder when no project folder is set", async () => {
    const workDir = create();
    const prepared = await workDir.prepare({ groupId: 'g1', projectDir: null });
    const folder = botGroupFolderPath(path.join(root, 'owner'), 'g1');
    expect(prepared).toEqual({ ok: true, workDir: folder, branch: null, ownerSessionId: null });
    expect((await stat(folder)).isDirectory()).toBe(true);
  });

  it('uses a plain project folder directly and a git project through a new worktree', async () => {
    const project = path.join(root, 'site');
    await mkdir(project);
    expect(await create().prepare({ groupId: 'g1', projectDir: project }))
      .toEqual({ ok: true, workDir: project, branch: null, ownerSessionId: null });
    const prepareWorktree = vi.fn(async () => ({ ok: true as const, sessionId: 's-1', workingDir: '/repo/.cindy-worktrees/a', branch: 'cindy/a' }));
    const git = create({ detectRepo: async () => ({ gitInstalled: true, isGitRepo: true }), prepareWorktree });
    expect(await git.prepare({ groupId: 'g1', projectDir: project }))
      .toEqual({ ok: true, workDir: '/repo/.cindy-worktrees/a', branch: 'cindy/a', ownerSessionId: 's-1' });
    expect(prepareWorktree).toHaveBeenCalledWith(project);
    expect(await create().prepare({ groupId: 'g1', projectDir: path.join(root, 'missing') }))
      .toMatchObject({ ok: false });
  });

  it('never works in place when it cannot tell whether a project is a git repository', async () => {
    const project = path.join(root, 'site');
    await mkdir(project);
    const broken = create({ detectRepo: async () => { throw new Error('git timed out'); } });
    expect(await broken.prepare({ groupId: 'g1', projectDir: project })).toMatchObject({ ok: false });
    const noGitBinary = create({
      detectRepo: async () => ({ gitInstalled: false, isGitRepo: false }),
      hasGitMarker: async () => true,
    });
    expect(await noGitBinary.prepare({ groupId: 'g1', projectDir: project })).toMatchObject({ ok: false });
    await mkdir(path.join(project, '.git'));
    const misdetected = create({ detectRepo: async () => ({ gitInstalled: true, isGitRepo: false }) });
    expect(await misdetected.prepare({ groupId: 'g1', projectDir: project })).toMatchObject({ ok: false });
  });

  it('lists files a step created or changed, skipping dependency folders', async () => {
    const workDir = create();
    const dir = path.join(root, 'work');
    await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(dir, 'old.md'), 'old');
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(dir, 'old.md'), past, past);
    const before = await workDir.snapshot(dir);
    await writeFile(path.join(dir, '需求说明.md'), 'new');
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets', 'hero.png'), 'png');
    await writeFile(path.join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
    const changed = await workDir.changedFiles(dir, before);
    expect(changed.sort()).toEqual(['assets/hero.png', '需求说明.md']);
  });

  it('counts files a step committed on the plan branch as well as uncommitted ones', async () => {
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const run = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), 'a');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
    const workDir = create({ git: async (args, cwd) => execFileSync('git', [...args], { cwd, encoding: 'utf8' }) });
    const before = await workDir.snapshot(repo);
    await writeFile(path.join(repo, 'README.md'), 'a\nb');
    await writeFile(path.join(repo, 'hello.html'), '<p>hi</p>');
    run('add', '.');
    run('commit', '-q', '-m', 'step');
    await writeFile(path.join(repo, 'notes.md'), 'draft');
    expect((await workDir.changedFiles(repo, before)).sort()).toEqual(['README.md', 'hello.html', 'notes.md']);
  });

  it('reads git status for worktrees, including renames and untracked files', () => {
    expect(parsePorcelainPaths(' M src/a.ts\0?? docs/new.md\0R  b.ts\0old-b.ts\0 D gone.ts\0')).toEqual([
      'src/a.ts',
      'docs/new.md',
      'b.ts',
    ]);
  });

  it("moves the group's folder to the trash, never deleting it", async () => {
    const trashItem = vi.fn(async () => undefined);
    const workDir = create({ trashItem });
    await workDir.prepare({ groupId: 'g1', projectDir: null });
    await workDir.trashGroupFolder('g1');
    expect(trashItem).toHaveBeenCalledWith(path.join(root, 'owner', 'bot-groups', 'g1'));
    await workDir.trashGroupFolder('never-created');
    expect(trashItem).toHaveBeenCalledTimes(1);
  });
});
