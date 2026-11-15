import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { Script } from 'node:vm';
import type { ProjectScheduleConfig } from '../../scheduler-host/project-automation-loader.js';
import { executePreRunHook } from '../../scheduler-host/pre-run-hook.js';

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
const database = vi.hoisted(() => ({ path: '' }));
vi.mock('../../localDb/index.js', () => ({ getDbPathForUser: () => database.path }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientUserId: () => 'test-owner' }));

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

// Evaluate the actual generated check with real SQLite, in-process. The hook
// protocol has its own process tests; retain one real spawn below. Repeated
// cold Node startups made the activity matrix exceed 60s on CI (#10413).
async function runMemoryCheck(workingDir: string, firedAt: number): Promise<number> {
  let exitCode = 0;
  const output = { write: (_text: string, done?: () => void) => { done?.(); } };
  const script = await fs.readFile(path.join(workingDir, '..', '.memory-review-check-v1.cjs'), 'utf8');
  await new Script(script).runInNewContext({
    require: (name: string) => {
      if (name !== 'node:sqlite') throw new Error(`Unexpected check dependency: ${name}`);
      return { DatabaseSync };
    },
    console: { log() {}, error() {} },
    process: {
      stdin: Readable.from([JSON.stringify({ event: 'schedule-pre-run', firedAt })]),
      stdout: output, stderr: output,
      get exitCode() { return exitCode; },
      set exitCode(value: number) { exitCode = value; },
      exit: (code: number) => { exitCode = code; },
    },
  });
  return exitCode;
}

// Teammate V2 (2026-11-06): the nightly review is the project's own automation,
// added once on the teammate's model; an owner's later edit or removal is kept.
describe('ensureBotProjectAutomations', () => {
  let root = '';
  let workingDir = '';
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teammate-review-'));
    workingDir = path.join(root, 'workspace');
    await fs.mkdir(workingDir);
    database.path = path.join(root, 'account.db');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('adds the memory review to the teammate project on its own model, only once', async () => {
    const route = { harness: 'pi' as const, model: 'm1', providerId: 'p1', effort: 'medium', fastMode: false };
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir, route })).resolves.toBe(true);
    expect(loader.upsertSchedule).toHaveBeenCalledWith(workingDir, expect.objectContaining({
      id: BOT_PROJECT_MEMORY_REVIEW_ID, agentKind: 'pi', model: 'm1', providerId: 'p1',
      name: 'Mimi · Review memory', persistentSession: true, silentWhenIdle: true,
      prompt: expect.stringContaining('teammate id bot-1'),
    }), { keepUnreadable: true });

    const supplied = loader.upsertSchedule.mock.calls[0]![1];
    // Restoring an already-upgraded project on this computer recreates only its local check.
    const checkFile = path.join(root, '.memory-review-check-v1.cjs');
    await fs.rm(checkFile);
    loader.loadProjectSchedules.mockResolvedValueOnce([supplied]);
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir, route })).resolves.toBe(false);
    expect((await fs.stat(checkFile)).isFile()).toBe(true);
    await fs.writeFile(checkFile, '/* owner-edited check */');
    loader.loadProjectSchedules.mockResolvedValueOnce([supplied]);
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir, route });
    expect(await fs.readFile(checkFile, 'utf8')).toBe('/* owner-edited check */');
    expect(loader.upsertSchedule).toHaveBeenCalledOnce();
  });

  // User report: idle teammates ran nightly. Tier: filesystem + real preRunHook process;
  // automatic user-role messages must not satisfy the check or create a database.
  it('skips automatic activity, admits human chat and fails closed on a missing database', async () => {
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const db = new DatabaseSync(database.path);
    try {
      db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
        CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT DEFAULT '');
        INSERT INTO bot_session_links VALUES ('bot-1','chat'), ('other','other-chat');`);
      const firedAt = Date.now();
      const insert = db.prepare('INSERT INTO messages(session_id,role,rewind_at,created_at,agent_meta) VALUES (?, ?, ?, ?, ?)');
      // Actual first-run fixture: welcoming a teammate writes a hidden user-role trigger.
      const welcome = db.prepare('INSERT INTO messages(session_id,role,created_at,content) VALUES (?, ?, ?, ?)');
      welcome.run('chat', 'user', firedAt - 1, '[UI_ACTION_TRIGGER]Say hello');
      welcome.run('chat', 'user', firedAt - 1, JSON.stringify('[UI_ACTION_TRIGGER]Say hello'));
      for (const meta of [{ origin: { kind: 'scheduler' } }, { origin: { kind: 'session' } }, { sourcePlugin: { id: 'p' } }]) {
        insert.run('chat', 'user', null, firedAt - 10, JSON.stringify(meta));
      }
      insert.run('chat', 'assistant', null, firedAt - 10, null);
      insert.run('chat', 'user', null, firedAt - 86_400_001, null);
      insert.run('chat', 'user', firedAt, firedAt - 10, null);
      insert.run('other-chat', 'user', null, firedAt - 10, null);
      const config = loader.upsertSchedule.mock.calls[0]![1];
      // One smoke still exercises the production process adapter + generated script.
      expect((await executePreRunHook({ ...config.preRunHook!, cwd: workingDir,
        stdinPayload: { event: 'schedule-pre-run', scheduleId: 'review', scheduleName: 'review', runId: 'run', firedAt },
      })).exitCode).toBe(2);
      const run = () => runMemoryCheck(workingDir, firedAt);
      insert.run('chat', 'user', null, firedAt - 1, null);
      expect(await run()).toBe(2); // 1 human message is insufficient.
      for (let i = 1; i < 19; i++) insert.run('chat', 'user', null, firedAt - 1, null);
      expect(await run()).toBe(2); // 19 humans plus automatic traffic is still insufficient.
      insert.run('chat', 'user', null, firedAt - 1, JSON.stringify({ autoResume: true }));
      expect(await run()).toBe(2);
      insert.run('chat', 'user', null, firedAt - 1, null);
      expect(await run()).toBe(0); // Exactly 20.
      db.exec('DELETE FROM messages');
      for (let i = 0; i < 20; i++) insert.run('chat', 'user', null, firedAt - 1, JSON.stringify({ origin: { kind: 'scheduler', scheduleId: 'hook:telegram' } }));
      expect(await run()).toBe(0);
    } finally { db.close(); }
    await fs.rm(database.path);
    expect(await runMemoryCheck(workingDir, Date.now())).not.toBe(0);
    await expect(fs.stat(database.path)).rejects.toThrow();
  });

  // PR #10294: actual chatServer group dispatches retain the hidden prefix even for
  // host-attested owner text; attachments serialize it as {text,images,files}. Exercise the
  // production-generated script, not a copy of its predicate (unit, synthetic SQLite).
  it.each([
    ['silent-stop continuation', '继续', { autoResume: true }, 2],
    ['human group text', '[UI_ACTION_TRIGGER]group request', { autoReviewUserText: 'Please review this' }, 0],
    ['human JSON string', JSON.stringify('[UI_ACTION_TRIGGER]group request'), { autoReviewUserText: 'Please review this' }, 0],
    ['human group attachments', JSON.stringify({ text: '[UI_ACTION_TRIGGER]group request', images: [], files: [{ path: 'sample.txt' }] }), { autoReviewUserText: 'Please review this' }, 0],
    ['autonomous attachments', JSON.stringify({ text: '[UI_ACTION_TRIGGER]peer update', images: [], files: [{ path: 'sample.txt' }] }), { autoReviewUserText: '' }, 2],
    ['autonomous attachments without origin', JSON.stringify({ text: '[UI_ACTION_TRIGGER]peer update', images: [], files: [{ path: 'sample.txt' }] }), null, 2],
  ] as const)('counts activity correctly for %s', async (_label, content, meta, expectedExit) => {
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);
      INSERT INTO bot_session_links VALUES ('bot-1','group');`);
    const firedAt = Date.now();
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, NULL, ?, ?, ?)');
    for (let i = 0; i < 19; i++) insert.run('group', 'user', firedAt - 1, null, 'Human request');
    insert.run('group', 'user', firedAt - 1, meta === null ? null : JSON.stringify(meta), content);
    db.close();
    expect(await runMemoryCheck(workingDir, firedAt)).toBe(expectedExit);
  });

  // User correction 2026-11-13: the bundled minimum is 20, not a single human input.
  // Unit, real generated hook + SQLite: installed cdb14543 allows 19; upgrade must skip
  // 19 and admit 20 without changing customized schedules/scripts. Windows checkout uses
  // CRLF: exercise both stored byte formats so the fingerprint cannot misclassify a stock script.
  it.each(['\n', '\r\n'])('upgrades the installed one-message check with %j line endings while preserving choices and edits', async (lineEnding) => {
    loader.loadProjectSchedules.mockResolvedValueOnce(null);
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const supplied = { ...loader.upsertSchedule.mock.calls[0]![1], cronExpr: '0 5 * * *',
      model: 'chosen-model', prompt: 'Owner-maintained review instructions' };
    const checkFile = path.join(root, '.memory-review-check-v1.cjs');
    const old = (await fs.readFile(new URL('./fixtures/memory-review-cdb14543.cjs.txt', import.meta.url), 'utf8'))
      .replace(/\r?\n/g, lineEnding);
    await fs.writeFile(checkFile, `const source = ${JSON.stringify({ databasePath: database.path,
      botId: 'bot-1', syntheticPrefix: '[UI_ACTION_TRIGGER]' })};\n${old.slice(old.indexOf('\n') + 1)}`);
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);
      INSERT INTO bot_session_links VALUES ('bot-1','chat');`);
    const firedAt = Date.now();
    const insert = db.prepare("INSERT INTO messages VALUES ('chat', 'user', NULL, ?, NULL, 'Human request')");
    for (let i = 0; i < 19; i++) insert.run(firedAt - 1);
    const run = () => runMemoryCheck(workingDir, firedAt);
    try {
      expect(await run()).toBe(0); // Actual predecessor behavior.
      loader.loadProjectSchedules.mockResolvedValue([supplied]);
      await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir })).resolves.toBe(false);
      expect(await run()).toBe(2);
      insert.run(firedAt - 1);
      expect(await run()).toBe(0);
      expect(loader.upsertSchedule).toHaveBeenCalledTimes(1);
      const edited = (await fs.readFile(checkFile, 'utf8')) + '\n// Owner customization\n';
      await fs.writeFile(checkFile, edited);
      await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
      expect(await fs.readFile(checkFile, 'utf8')).toBe(edited);
    } finally { db.close(); }
  });

  it('upgrades the supplied review while retaining choices, custom checks and removal', async () => {
    const old = { id: BOT_PROJECT_MEMORY_REVIEW_ID, cronExpr: '0 4 * * *', model: 'chosen',
      prompt: "Look back at Old Name's conversations from the last day (teammate id bot-1) and keep what is worth remembering in this project's memory and skills. If nothing new is worth keeping, finish quietly." };
    const input = { botId: 'bot-1', displayName: 'Mimi', workingDir, addMissing: false };
    loader.loadProjectSchedules.mockResolvedValueOnce([old]);
    await expect(ensureBotProjectAutomations(input)).resolves.toBe(true);
    expect(loader.upsertSchedule).toHaveBeenCalledWith(workingDir, expect.objectContaining({
      cronExpr: old.cronExpr, model: old.model, preRunHook: expect.any(Object),
    }), { keepUnreadable: true });
    for (const configs of [[{ ...old, prompt: 'Custom review' }], [{ ...old, preRunHook: { command: 'custom-check' } }], []]) {
      loader.loadProjectSchedules.mockResolvedValueOnce(configs);
      await expect(ensureBotProjectAutomations(input)).resolves.toBe(false);
    }
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
