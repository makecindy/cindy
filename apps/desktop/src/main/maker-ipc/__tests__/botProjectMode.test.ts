import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEMORY_STORAGE_MIGRATION_RECEIPT } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({
  loadProjectSchedules: vi.fn<(dir: string) => Promise<Array<{ id: string }> | null>>(async () => null),
  upsertSchedule: vi.fn(async () => ({})),
  removeSchedule: vi.fn(async () => ({})),
}));
const aliases = vi.hoisted(() => ({
  rows: [] as Array<{ projectKey: string; alias: string }>,
  upsert: vi.fn(async (projectKey: string, alias: string) => ({ projectKey, alias })),
}));

const snapshot = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../git-snapshot/gitSnapshotService.js', () => ({ createSnapshotDetailed: snapshot }));
vi.mock('../../scheduler-host/index.desktop.js', () => ({ getProjectAutomationLoader: () => loader }));
vi.mock('../../i18n.desktop.js', () => ({ t: () => '{{name}} · Review memory' }));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({
  listProjectAliases: async () => aliases.rows,
  upsertProjectAlias: aliases.upsert,
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ normalizeRecentWorkdirPath: (p: string) => p, upsertRecentWorkdir: async () => false }));
vi.mock('../../worktree/WorktreeManager.js', () => ({ detectCwd: async () => ({ gitInstalled: false }) }));

import { BOT_PROJECT_MEMORY_REVIEW_ID, ensureBotProjectAutomations, moveTeammateMemoryIntoProject, nameBotProject, prepareBotProjectWorkspace } from '../botProjectMode.js';
import { legacyTeammateProjectMemoryDir, teammateProjectMemoryDir, teammateWorkspaceDir } from '../botProjectMemory.js';

// Teammate V2 (2026-11-06): the nightly review is the project's own automation,
// added once on the teammate's model; an owner's later edit or removal is kept.
describe('ensureBotProjectAutomations', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('adds the memory review to the teammate project on its own model, only once', async () => {
    const route = { harness: 'pi' as const, model: 'm1', providerId: 'p1', effort: 'medium', fastMode: false };
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir: '/w', route })).resolves.toBe(true);
    expect(loader.upsertSchedule).toHaveBeenCalledWith('/w', expect.objectContaining({
      id: BOT_PROJECT_MEMORY_REVIEW_ID, agentKind: 'pi', model: 'm1', providerId: 'p1',
      name: 'Mimi · Review memory', persistentSession: true, silentWhenIdle: true,
      prompt: expect.stringContaining('teammate id bot-1'),
    }), { keepUnreadable: true });

    loader.loadProjectSchedules.mockResolvedValueOnce([{ id: BOT_PROJECT_MEMORY_REVIEW_ID }]);
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir: '/w', route })).resolves.toBe(false);
    expect(loader.upsertSchedule).toHaveBeenCalledOnce();
  });
});

// 2026-11-07: a teammate project named just "Cindy" sat next to the user's "cindy" repo.
// It now carries the standard name; a name the user gave the project is never replaced.
describe('nameBotProject', () => {
  beforeEach(() => { vi.clearAllMocks(); aliases.rows = []; });

  it('gives the standard name, follows renames, and keeps a name the user chose', async () => {
    await nameBotProject('bot-1', '/w', 'Cindy');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Buddy Cindy');

    aliases.rows = [{ projectKey: 'local:/w', alias: 'Cindy' }];
    await nameBotProject('bot-1', '/w', 'Cindy');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Buddy Cindy');

    aliases.rows = [{ projectKey: 'local:/w', alias: 'Teammate Cindy' }];
    await nameBotProject('bot-1', '/w', 'Mimi', 'Cindy');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Buddy Mimi');

    // An existing V2 default is renamed even when the buddy's own name did not change.
    aliases.rows = [{ projectKey: 'local:/w', alias: 'Teammate Mimi' }];
    await nameBotProject('bot-1', '/w', 'Mimi');
    expect(aliases.upsert).toHaveBeenLastCalledWith('local:/w', 'Buddy Mimi');

    aliases.upsert.mockClear();
    aliases.rows = [{ projectKey: 'local:/w', alias: 'Buddy Mimi' }];
    await nameBotProject('bot-1', '/w', 'Mimi');
    expect(aliases.upsert).not.toHaveBeenCalled();

    aliases.upsert.mockClear();
    aliases.rows = [{ projectKey: 'local:/w', alias: 'My notes' }];
    await nameBotProject('bot-1', '/w', 'Mimi', 'Cindy');
    expect(aliases.upsert).not.toHaveBeenCalled();
  });
});

/*
 * 测试价值
 * - 生产入口与可观察结果：moveTeammateMemoryIntoProject（启动时 botV2Migration 对已升级伙伴、以及
 *   prepareBotProjectWorkspace 调用）执行后项目里与项目外的记忆文件、回执、.gitignore 与版本快照。
 * - 规则依据：cindy-bots-runtime.md「V2 伙伴记忆」：伙伴记忆搬进伙伴项目 `.cindy/memory/` 只做一次，
 *   不覆盖项目里已有（更新）的记录，旧位置原样保留；记录随项目 Git 记版本，派生文件不进 Git。
 * - 现有覆盖缺口：新增的一次性搬迁，无既有覆盖。
 * - 最小失败输入：项目外旧位置有一条同名旧记录 + 一条独有记录；项目里已有同名新记录；搬完后删掉一条再跑。
 * - tier：unit（临时目录真实文件 I/O；有 git 时用真 `git check-ignore` 核对忽略规则；快照服务替换为观察点）。
 */
describe('moveTeammateMemoryIntoProject', () => {
  let root = '';
  beforeEach(async () => {
    snapshot.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-memory-move-'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const put = async (dir: string, name: string, content: string) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  };
  const gitAvailable = spawnSync('git', ['--version']).status === 0;

  it.skipIf(!gitAvailable)('moves the memory into the project once, never over newer records, keeping the old place', async () => {
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    await fs.mkdir(workspace, { recursive: true });
    expect(spawnSync('git', ['init', '-q'], { cwd: workspace }).status).toBe(0);
    const outside = await legacyTeammateProjectMemoryDir(root, workspace);
    const inside = teammateProjectMemoryDir(workspace);
    await put(outside, 'user_tea.md', 'older');
    await put(outside, 'project_launch.md', 'only outside');
    await put(outside, 'MEMORY.md', 'old index');
    await put(inside, 'user_tea.md', 'newer');

    await expect(moveTeammateMemoryIntoProject({ botId: 'bot_mia', ownerRoot: root, workspace })).resolves.toBe(1);
    expect(await fs.readFile(path.join(inside, 'user_tea.md'), 'utf8')).toBe('newer');
    expect(await fs.readFile(path.join(inside, 'project_launch.md'), 'utf8')).toBe('only outside');
    expect((await fs.readdir(inside)).sort()).toEqual([MEMORY_STORAGE_MIGRATION_RECEIPT, 'project_launch.md', 'user_tea.md']);
    expect((await fs.readdir(outside)).sort()).toEqual(['MEMORY.md', 'project_launch.md', 'user_tea.md']);
    expect(snapshot).toHaveBeenCalledOnce();

    // Records and the store's copy receipt are versioned; what the store derives is not.
    const ignored = (file: string) => spawnSync('git', ['check-ignore', '-q', file], { cwd: workspace }).status === 0;
    for (const file of ['MEMORY.md', 'fts.db', 'fts.db-wal', 'meta.json', 'user_tea.md.12.ab.tmp']) {
      expect(ignored(`.cindy/memory/${file}`), file).toBe(true);
    }
    for (const file of ['user_tea.md', MEMORY_STORAGE_MIGRATION_RECEIPT]) {
      expect(ignored(`.cindy/memory/${file}`), file).toBe(false);
    }

    // Once: a record deleted in the project afterwards does not come back.
    await fs.rm(path.join(inside, 'project_launch.md'));
    await expect(moveTeammateMemoryIntoProject({ botId: 'bot_mia', ownerRoot: root, workspace })).resolves.toBeNull();
    await expect(fs.stat(path.join(inside, 'project_launch.md'))).rejects.toThrow();
    expect(snapshot).toHaveBeenCalledOnce();
  });
});

// 2026-11-09 review: a V1 teammate that already had its own hand-off skill lost it to the
// starter template's copy during the upgrade. The teammate's own skill must win.
describe('prepareBotProjectWorkspace', () => {
  let root = '';
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it("keeps a V1 teammate's own skill over the starter template's", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-skill-upgrade-'));
    const legacy = path.join(root, 'bots', 'bot_mia', 'skills', 'hand-off');
    await fs.mkdir(legacy, { recursive: true });
    const own = '---\nname: hand-off\ndescription: Team handover rules\n---\nOwner-specific handover\n';
    await fs.writeFile(path.join(legacy, 'SKILL.md'), own);
    await fs.writeFile(path.join(legacy, 'checklist.md'), 'company checklist');

    const { workingDir } = await prepareBotProjectWorkspace({ botId: 'bot_mia', displayName: 'Mia', ownerRoot: root });
    const skill = path.join(workingDir, '.agents', 'skills', 'hand-off');
    await expect(fs.readFile(path.join(skill, 'SKILL.md'), 'utf8')).resolves.toBe(own);
    await expect(fs.readFile(path.join(skill, 'checklist.md'), 'utf8')).resolves.toBe('company checklist');
  });

  // QA recheck: with the project's Skills folder linked elsewhere, the starter template wrote through the link.
  it('writes nothing through a Skills folder the project linked elsewhere', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-skill-link-'));
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    await fs.mkdir(path.join(workspace, '.agents'), { recursive: true });
    await fs.symlink(elsewhere, path.join(workspace, '.agents', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(path.join(root, 'bots', 'bot_mia', 'skills', 'report'), { recursive: true });
    await fs.writeFile(path.join(root, 'bots', 'bot_mia', 'skills', 'report', 'SKILL.md'), 'v1');
    await prepareBotProjectWorkspace({ botId: 'bot_mia', displayName: 'Mia', ownerRoot: root });
    expect(await fs.readdir(elsewhere)).toEqual([]);
    await expect(fs.readFile(path.join(workspace, 'skills-from-v1', 'report', 'SKILL.md'), 'utf8')).resolves.toBe('v1');
  });

  // QA 2026-11-10: a Skill folder the project already had was skipped whole (its other files lost),
  // every link was dropped (a Skill's own `instructions.md -> real.md` broke), and a memory folder
  // that could not be read counted as empty, so the upgrade finished without the memories.
  // symlink-platform-skip: Windows cannot make a folder unreadable with chmod, which the retry case needs.
  it.skipIf(process.platform === 'win32')('merges Skill files, keeps links inside a Skill and retries an unreadable memory folder', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-skill-merge-'));
    const legacy = path.join(root, 'bots', 'bot_mia', 'skills', 'report');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'SKILL.md'), 'v1 skill');
    await fs.writeFile(path.join(legacy, 'real.md'), 'the steps');
    await fs.symlink('real.md', path.join(legacy, 'instructions.md'));
    await fs.writeFile(path.join(root, 'secret.txt'), 'outside');
    await fs.symlink(path.join(root, 'secret.txt'), path.join(legacy, 'outside.md'));
    // QA recheck: a link back to its own folder looped forever; a folder where the project has a file failed every start.
    await fs.symlink('.', path.join(legacy, 'loop'));
    await fs.mkdir(path.join(legacy, 'templates'));
    await fs.writeFile(path.join(legacy, 'templates', 'brief.md'), 'brief');
    await fs.symlink('templates', path.join(legacy, 'examples'));
    const other = path.join(root, 'bots', 'bot_mia', 'skills', 'linked');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'SKILL.md'), 'linked v1');
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    const existing = path.join(workspace, '.agents', 'skills', 'report');
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, 'SKILL.md'), 'project skill');
    await fs.writeFile(path.join(existing, 'templates'), 'a file here');
    // QA recheck: a link the project has must not be written through.
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(workspace, '.agents', 'skills', 'linked'));

    const prepared = await prepareBotProjectWorkspace({ botId: 'bot_mia', displayName: 'Mia', ownerRoot: root });
    await expect(fs.readFile(path.join(existing, 'SKILL.md'), 'utf8')).resolves.toBe('project skill');
    await expect(fs.readFile(path.join(existing, 'SKILL-from-v1.md'), 'utf8')).resolves.toBe('v1 skill');
    await expect(fs.readFile(path.join(existing, 'instructions.md'), 'utf8')).resolves.toBe('the steps');
    await expect(fs.lstat(path.join(existing, 'outside.md'))).rejects.toThrow();
    expect(prepared.skippedSkillLinks).toEqual([path.join('report', 'outside.md')]);
    await expect(fs.readFile(path.join(existing, 'templates'), 'utf8')).resolves.toBe('a file here');
    await expect(fs.readFile(path.join(existing, 'templates-from-v1', 'brief.md'), 'utf8')).resolves.toBe('brief');
    // A second name for a folder inside the Skill is not a loop: both paths the Skill uses work.
    await expect(fs.readFile(path.join(existing, 'examples', 'brief.md'), 'utf8')).resolves.toBe('brief');
    expect(await fs.readdir(elsewhere)).toEqual([]);
    await expect(fs.readFile(path.join(workspace, '.agents', 'skills', 'linked-from-v1', 'SKILL.md'), 'utf8')).resolves.toBe('linked v1');

    // A retried upgrade reuses its side copy instead of adding another.
    await prepareBotProjectWorkspace({ botId: 'bot_mia', displayName: 'Mia', ownerRoot: root });
    expect((await fs.readdir(existing)).filter((name) => name.startsWith('templates'))).toEqual(['templates', 'templates-from-v1']);

    const memory = path.join(root, 'bots', 'bot_mia', 'memories');
    await fs.mkdir(memory, { recursive: true });
    await fs.writeFile(path.join(memory, 'user_tea.md'), 'tea');
    await fs.chmod(memory, 0o000);
    try {
      await expect(prepareBotProjectWorkspace({ botId: 'bot_mia', displayName: 'Mia', ownerRoot: root })).rejects.toThrow();
    } finally {
      await fs.chmod(memory, 0o755);
    }
  });
});
