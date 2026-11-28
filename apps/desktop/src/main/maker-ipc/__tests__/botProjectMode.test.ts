import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectScheduleConfig } from '../../scheduler-host/project-automation-loader.js';

import { MEMORY_STORAGE_MIGRATION_RECEIPT } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({
  loadProjectSchedules: vi.fn<(dir: string) => Promise<Array<Partial<ProjectScheduleConfig> & { id: string }> | null>>(async () => null),
  upsertSchedule: vi.fn(async (_dir: string, _config: ProjectScheduleConfig, _options?: unknown) => ({})),
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

import { BOT_PROJECT_LOCAL_GITIGNORE, BOT_PROJECT_MEMORY_GITIGNORE, createBotDefaultProjectSchedule, ensureBotProjectAutomations, ensureTeammateProjectIgnored, moveTeammateMemoryIntoProject, nameBotProject, prepareBotProjectWorkspace } from '../botProjectMode.js';
import { legacyTeammateProjectMemoryDir, teammateProjectMemoryDir, teammateWorkspaceDir } from '../botProjectMemory.js';
import { importBotSkillFiles } from '../botSkillStore.js';
import { OWN_RULES_HEADING, importedStandardSkill } from '../botProjectTemplate.js';

// User decision 2026-11-16 / unit: new supplied tasks must acquire the same model policy
// through the creation entry, without adding their IDs to the runner or editor.
// Existing review-only coverage misses a new task definition and an unmarked old snapshot.
it('gives a new default task model inheritance while retaining every existing model preference', () => {
  const defaults = { id: 'future-default-task', name: 'Future default', prompt: 'Do useful work', cronExpr: '0 9 * * *' };
  expect(createBotDefaultProjectSchedule(defaults)).toMatchObject({ ...defaults, followTeammateModel: true });
  const chosen = { ...defaults, model: 'chosen-c', providerId: 'custom', fastMode: 'ultrafast' as const };
  expect(createBotDefaultProjectSchedule(defaults, chosen)).toMatchObject(chosen);
  expect(createBotDefaultProjectSchedule(defaults, chosen).followTeammateModel).toBeUndefined();
  expect(createBotDefaultProjectSchedule(defaults, { ...defaults, followTeammateModel: false }).followTeammateModel).toBe(false);
  expect(createBotDefaultProjectSchedule(defaults, { ...defaults, followTeammateModel: true }).followTeammateModel).toBe(true);
});

// Teammate memory v3: per-teammate daily `teammate-memory-review` automations are retired in
// favor of the unified host-managed Global Memory & Skill Tidy (`globalMemoryTidy.ts`).
describe('ensureBotProjectAutomations', () => {
  let root = '';
  let workingDir = '';
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-review-'));
    workingDir = path.join(root, 'workspace');
    await fs.mkdir(workingDir);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('is retired and no longer creates per-teammate memory review schedules or check scripts', async () => {
    const route = { harness: 'pi' as const, model: 'm1', providerId: 'p1', effort: 'medium', fastMode: false };
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir, route })).resolves.toBe(false);
    expect(loader.upsertSchedule).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, '.memory-review-check-v1.cjs'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    // As both upgrade entries do: the local .gitignore entries come first, else the version is deferred.
    await expect(ensureTeammateProjectIgnored({ workspace })).resolves.toBe('ready');

    await expect(moveTeammateMemoryIntoProject({ botId: 'bot_mia', ownerRoot: root, workspace })).resolves.toBe(1);
    expect(await fs.readFile(path.join(inside, 'user_tea.md'), 'utf8')).toBe('newer');
    expect(await fs.readFile(path.join(inside, 'project_launch.md'), 'utf8')).toBe('only outside');
    expect((await fs.readdir(inside)).sort()).toEqual([MEMORY_STORAGE_MIGRATION_RECEIPT, 'project_launch.md', 'user_tea.md']);
    expect((await fs.readdir(outside)).sort()).toEqual(['MEMORY.md', 'project_launch.md', 'user_tea.md']);
    expect(snapshot).toHaveBeenCalledOnce();

    // Records, MEMORY.md and the store's copy receipt are versioned; what the store derives is not.
    const ignored = (file: string) => spawnSync('git', ['check-ignore', '-q', file], { cwd: workspace }).status === 0;
    for (const file of ['fts.db', 'fts.db-wal', 'meta.json', 'user_tea.md.12.ab.tmp']) {
      expect(ignored(`.cindy/memory/${file}`), file).toBe(true);
    }
    for (const file of ['MEMORY.md', 'user_tea.md', MEMORY_STORAGE_MIGRATION_RECEIPT]) {
      expect(ignored(`.cindy/memory/${file}`), file).toBe(false);
    }

    // Once: a record deleted in the project afterwards does not come back.
    await fs.rm(path.join(inside, 'project_launch.md'));
    await expect(moveTeammateMemoryIntoProject({ botId: 'bot_mia', ownerRoot: root, workspace })).resolves.toBeNull();
    await expect(fs.stat(path.join(inside, 'project_launch.md'))).rejects.toThrow();
    expect(snapshot).toHaveBeenCalledOnce();
  });
});

/*
 * 测试价值
 * - 生产入口与可观察结果：ensureTeammateProjectIgnored（启动时 botV2Migration 对已升级伙伴、首次升级时
 *   prepareBotProjectWorkspace 调用）执行后 `.gitignore` 的内容、已提交文件与回执。Git 如何解读这些条目
 *   （模板例外的顺序、已跟踪文件照旧跟踪）在 botProjectMode.git-integration.test.ts 用真 Git 核对。
 * - 规则依据：cindy-bots-runtime.md §4「项目的 .gitignore（2026-11-21）」：存量项目只追加缺的条目一次，
 *   不改用户的行，不删磁盘文件；凭证文件、虚拟环境、worktree 不进版本。
 * - 现有覆盖缺口：此前只有记忆条目会补，凭证与虚拟环境条目没有补齐路径；首次升级也要在记版本前补上。
 * - 最小失败输入：旧默认清单 + 用户自己的一行（CRLF），补齐后用户删掉一条再跑；首次升级时已有旧 `.gitignore`。
 * - tier：unit（临时目录真实文件 I/O，无 Git）。
 */
describe('ensureTeammateProjectIgnored', () => {
  let root = '';
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  // The list spells out the memory store's receipt so the snapshot kernel needs no maker-core.
  it('keeps the memory store receipt versioned under the name maker-core writes', () => {
    expect(BOT_PROJECT_MEMORY_GITIGNORE).toContain(`!.cindy/memory/${MEMORY_STORAGE_MIGRATION_RECEIPT}`);
  });

  it('appends the ordered block below the owner\'s lines, once', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-gitignore-'));
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    await fs.mkdir(workspace, { recursive: true });
    const before = 'node_modules/\r\n.env\r\n# mine\r\n!keep.log';
    await fs.writeFile(path.join(workspace, '.gitignore'), before);
    await fs.writeFile(path.join(workspace, '.env'), 'COMMITTED=1');

    await expect(ensureTeammateProjectIgnored({ botId: 'bot_mia', workspace })).resolves.toBe('ready');
    const text = await fs.readFile(path.join(workspace, '.gitignore'), 'utf8');
    // The whole ordered block goes below the owner's lines, even the `.env` it already had.
    expect(text).toBe(`${before}\r\n\r\n${[
      '# Cindy: keep credentials, environments, worktrees and memory caches out of versions',
      ...BOT_PROJECT_LOCAL_GITIGNORE, ...BOT_PROJECT_MEMORY_GITIGNORE,
    ].join('\r\n')}\r\n`);
    await expect(fs.readFile(path.join(workspace, '.env'), 'utf8')).resolves.toBe('COMMITTED=1');

    // Once: an entry the owner removes afterwards is not put back.
    await fs.writeFile(path.join(workspace, '.gitignore'), text.replace('token.json\r\n', ''));
    await expect(ensureTeammateProjectIgnored({ botId: 'bot_mia', workspace })).resolves.toBe('ready');
    expect(await fs.readFile(path.join(workspace, '.gitignore'), 'utf8')).not.toContain('token.json');
  });

  // Codex review 2026-11-24: a `.gitignore` that is a folder (or a link, which Git does not follow)
  // was left alone but counted as ready, so versions went ahead without the rules.
  // Codex review 2026-11-24 (09:13): the startup upgrade and a task's savepoint can complete the same
  // project at once. Each rewrote the file in place, so one could read the other's truncated file and
  // write back only the block, dropping the owner's rules. Minimal input: two calls before either ends.
  it('completes a project once when two callers ask at the same time', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-gitignore-race-'));
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    await fs.mkdir(workspace, { recursive: true });
    const file = path.join(workspace, '.gitignore');
    await fs.writeFile(file, 'auth.json\n');
    const write = vi.spyOn(fs, 'writeFile');
    try {
      await expect(Promise.all([ensureTeammateProjectIgnored({ workspace }), ensureTeammateProjectIgnored({ workspace })]))
        .resolves.toEqual(['ready', 'ready']);
      // The owner's file is only appended to, never rewritten (exclusive-create attempts aside).
      expect(write.mock.calls.filter(([target, , options]) => target === file && (options as { flag?: string } | undefined)?.flag !== 'wx')).toEqual([]);
    } finally { write.mockRestore(); }
    const text = await fs.readFile(file, 'utf8');
    expect(text.startsWith('auth.json\n')).toBe(true);
    expect(text.split('\n').filter(line => line === 'token.json')).toHaveLength(1);
  });

  it('reports a .gitignore it cannot write as failed, leaving it alone and writing no receipt', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-gitignore-dir-'));
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    await fs.mkdir(path.join(workspace, '.gitignore'), { recursive: true });
    await expect(ensureTeammateProjectIgnored({ botId: 'bot_mia', workspace })).resolves.toBe('failed');
    expect((await fs.stat(path.join(workspace, '.gitignore'))).isDirectory()).toBe(true);
    await expect(fs.readdir(path.join(workspace, '.gitignore'))).resolves.toEqual([]);
    await expect(fs.lstat(path.join(path.dirname(workspace), 'project-gitignore.json'))).rejects.toThrow();
  });

  it('completes an existing project\'s .gitignore during the first upgrade', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-gitignore-upgrade-'));
    const workspace = teammateWorkspaceDir(root, 'bot_mia');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, '.gitignore'), 'data/\n');
    await prepareBotProjectWorkspace({ botId: 'bot_mia', displayName: 'Mia', ownerRoot: root });
    const text = await fs.readFile(path.join(workspace, '.gitignore'), 'utf8');
    expect(text.startsWith('data/\n')).toBe(true);
    expect(text).toContain('\n.venv/\n');
  });
});

// 2026-11-09 review: a V1 teammate that already had its own hand-off skill lost it to the
// starter template's copy during the upgrade. The teammate's own rules must win. Since 2026-11-22
// the skill is layered: the standard text is Cindy's and the V1 rules move into "Your own rules",
// which take precedence over the standard, so they are neither lost nor stuck on an old standard.
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
    const text = await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8');
    expect(text.slice(text.indexOf(OWN_RULES_HEADING))).toContain('Owner-specific handover');
    await expect(fs.readFile(path.join(skill, 'checklist.md'), 'utf8')).resolves.toBe('company checklist');
  });

  // Unit, real project preparation and importer publication. A same-named imported skill used to
  // be rejected by its freshly installed starter. A completed migration must also honor deletions.
  it.each([true, false])('adopts imported hand-off rules and keeps its enabled=%s choice on restart', async enabled => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-import-settings-'));
    const botId = 'imported';
    const profile = path.join(root, 'bots', botId);
    const args = { botId, ownerRoot: root, displayName: 'Fixture' };
    const { workingDir } = await prepareBotProjectWorkspace(args);
    const files = [{ name: 'SKILL.md', bytes: Buffer.from('---\nname: hand-off\n---\nInclude the project reference.'), executable: false },
      { name: 'example.txt', bytes: Buffer.from('Example'), executable: false }];
    const publish = () => importBotSkillFiles(root, botId, 'hand-off', files, () => {}, enabled, importedStandardSkill('hand-off'));
    await publish();
    await publish();
    const folder = path.join(enabled ? path.join(workingDir, '.agents/skills') : path.join(profile, 'disabled-skills'), 'hand-off');
    const content = await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8');
    expect(content.slice(content.indexOf(OWN_RULES_HEADING))).toContain('Include the project reference.');
    expect(await fs.readFile(path.join(folder, 'example.txt'), 'utf8')).toBe('Example');
    await fs.mkdir(path.join(profile, 'memories'), { recursive: true });
    await fs.writeFile(path.join(profile, 'memories', 'project_previous.md'), 'Removed in the project');
    await fs.writeFile(path.join(profile, 'v2-migration.json'), '{}');
    await prepareBotProjectWorkspace(args);
    await expect(fs.stat(path.join(teammateProjectMemoryDir(workingDir), 'project_previous.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8')).toBe(content);
    if (!enabled) await expect(fs.stat(path.join(workingDir, '.agents/skills/hand-off'))).rejects.toMatchObject({ code: 'ENOENT' });
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
