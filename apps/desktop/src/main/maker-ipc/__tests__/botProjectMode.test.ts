import { spawnSync } from 'node:child_process';
import nodeFs, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { Script } from 'node:vm';
import { Scheduler, type Schedule, type ScheduleStorage } from '@cindy/maker-scheduler';
import { ProjectAutomationLoader, type ProjectScheduleConfig } from '../../scheduler-host/project-automation-loader.js';
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

import { BOT_PROJECT_LOCAL_GITIGNORE, BOT_PROJECT_MEMORY_GITIGNORE, BOT_PROJECT_MEMORY_REVIEW_ID, createBotDefaultProjectSchedule, ensureBotProjectAutomations, ensureTeammateProjectIgnored, moveTeammateMemoryIntoProject, nameBotProject, prepareBotProjectWorkspace } from '../botProjectMode.js';
import { legacyTeammateProjectMemoryDir, teammateProjectMemoryDir, teammateWorkspaceDir } from '../botProjectMemory.js';
import { importBotSkillFiles } from '../botSkillStore.js';
import { prepareArrivedMemoryReview } from '../../companion-cloud/projectHost.js';
import { OWN_RULES_HEADING, importedStandardSkill } from '../botProjectTemplate.js';

// Evaluate the actual generated check with real SQLite, in-process. The hook
// protocol has its own process tests; retain one real spawn below. Repeated
// cold Node startups made the activity matrix exceed 60s on CI (#10413).
async function runMemoryCheck(workingDir: string, firedAt: number,
  event: { lastFinishedAt?: number; scheduleId?: string; runId?: string; log?: string[] } = {}): Promise<number> {
  let exitCode = 0;
  const output = { write: (_text: string, done?: () => void) => { done?.(); } };
  const script = await fs.readFile(path.join(workingDir, '..', '.memory-review-check-v1.cjs'), 'utf8');
  const { log, ...fields } = event;
  await new Script(script).runInNewContext({
    require: (name: string) => {
      if (name === 'node:sqlite') return { DatabaseSync };
      if (name === 'node:fs') return nodeFs;
      if (name === 'node:path') return path;
      throw new Error(`Unexpected check dependency: ${name}`);
    },
    console: { log: (text: string) => { log?.push(text); }, error() {} },
    process: {
      pid: process.pid,
      stdin: Readable.from([JSON.stringify({ event: 'schedule-pre-run', firedAt, ...fields })]),
      stdout: output, stderr: output,
      get exitCode() { return exitCode; },
      set exitCode(value: number) { exitCode = value; },
      exit: (code: number) => { exitCode = code; },
    },
  });
  return exitCode;
}

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
      id: BOT_PROJECT_MEMORY_REVIEW_ID, followTeammateModel: true,
      name: 'Mimi · Review memory', persistentSession: true, silentWhenIdle: true,
      prompt: expect.stringContaining('teammate id bot-1'),
    }), { keepUnreadable: true });

    const supplied = loader.upsertSchedule.mock.calls[0]![1];
    expect(supplied.model).toBeUndefined();
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
        CREATE TABLE schedules(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
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

  // User report 2026-11-22: owners who send fewer than 20 messages a day never got their
  // teammate reviewed, so its saved memories only piled up. Unit, real generated check with
  // SQLite and files: changed memory or skills admit a review at most weekly; only a review
  // whose run succeeded consumes them (#12080 review P1); the review's own edits, the supplied
  // memory guide, the generated MEMORY.md index, the search index, dependency and Python caches
  // (#12080 review) and self-tests do not count.
  it('reviews a quiet teammate whose memory or skills changed, at most once a week', async () => {
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);
      CREATE TABLE schedule_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, finished_at INTEGER, session_id TEXT);
      CREATE TABLE schedules(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, working_dir TEXT, project_dir TEXT);`);
    const finish = db.prepare('INSERT INTO schedule_runs(id, status, finished_at) VALUES (?, ?, ?)');
    const day = 86_400_000;
    const start = Date.now();
    const touch = async (relative: string, at: number) => {
      const file = path.join(workingDir, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, relative);
      await fs.utimes(file, at / 1000, at / 1000);
    };
    try {
      expect(await runMemoryCheck(workingDir, start, { runId: 'r0' })).toBe(2); // Nothing saved yet.
      await touch('.cindy/memory/README.md', start + 1);
      await touch('.cindy/memory/MEMORY.md', start + 1); // Rebuilt on every storage start.
      await touch('.cindy/memory/fts.db', start + 1);
      await touch('.cindy/memory/.cindy-memory-migration-v1.json', start + 1);
      await touch('.agents/skills/brew/node_modules/dep/index.js', start + 1);
      await touch('.agents/skills/brew/__pycache__/tool.cpython-312.pyc', start + 1); // #12080 review
      await touch('.agents/skills/brew/tool.pyc', start + 1);
      expect(await runMemoryCheck(workingDir, start + 2, { runId: 'r1' })).toBe(2);
      await touch('.cindy/memory/coffee.md', start + 3);
      await touch('.agents/skills/brew/SKILL.md', start + 3);
      expect(await runMemoryCheck(workingDir, start + 4, { scheduleId: 'self-test', runId: 'self-test' })).toBe(0);
      const first: string[] = [];
      expect(await runMemoryCheck(workingDir, start + day, { runId: 'r2', log: first })).toBe(0);
      expect(first.join('\n')).toContain('.cindy/memory/coffee.md');
      expect(first.join('\n')).toContain('.agents/skills/brew/SKILL.md');
      expect(first.join('\n')).not.toMatch(/README|MEMORY\.md|fts\.db|migration|node_modules|\.pyc/);
      // That run failed before tidying: the next night tries again with the same material.
      finish.run('r2', 'failed', start + day + 1_000);
      const retry: string[] = [];
      expect(await runMemoryCheck(workingDir, start + 2 * day, { runId: 'r3', log: retry })).toBe(0);
      expect(retry.join('\n')).toContain('.cindy/memory/coffee.md');
      await touch('.cindy/memory/coffee.md', start + 2 * day + 60_000); // The review tidied it.
      finish.run('r3', 'success', start + 2 * day + 120_000);
      expect(await runMemoryCheck(workingDir, start + 3 * day, { runId: 'r4' })).toBe(2);
      await touch('.cindy/memory/tea.md', start + 4 * day);
      expect(await runMemoryCheck(workingDir, start + 5 * day, { runId: 'r5' })).toBe(2); // Within the week.
      const second: string[] = [];
      expect(await runMemoryCheck(workingDir, start + 9 * day, { runId: 'r6', log: second })).toBe(0);
      expect(second.join('\n')).toContain('.cindy/memory/tea.md');
      expect(second.join('\n')).not.toContain('coffee.md');
      finish.run('r6', 'success', start + 9 * day + 60_000);
      expect(await runMemoryCheck(workingDir, start + 17 * day, { runId: 'r7' })).toBe(2);
    } finally { db.close(); }
  });

  // #12080 review (Codex P2): the review shares the project folder with the teammate's other
  // tasks. A memory another task saved while the review ran is not the review's own edit and
  // must wait for the next one. Unit, real generated check with SQLite and files.
  it('keeps a memory another task saved while the review ran for the next review', async () => {
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);
      CREATE TABLE schedule_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, finished_at INTEGER, session_id TEXT);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, working_dir TEXT, project_dir TEXT);
      INSERT INTO bot_session_links VALUES ('bot-1', 'chat');`);
    const day = 86_400_000;
    const start = Date.now();
    const touch = async (relative: string, at: number) => {
      const file = path.join(workingDir, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, relative);
      await fs.utimes(file, at / 1000, at / 1000);
    };
    try {
      await touch('.cindy/memory/coffee.md', start - 1_000);
      expect(await runMemoryCheck(workingDir, start, { runId: 'r1' })).toBe(0);
      // While the review tidies coffee.md, the teammate's chat saves tea.md.
      await touch('.cindy/memory/coffee.md', start + 60_000);
      db.prepare("INSERT INTO messages VALUES ('review', 'assistant', NULL, ?, NULL, 'tidying')").run(start + 50_000);
      db.prepare("INSERT INTO messages VALUES ('chat', 'assistant', NULL, ?, NULL, 'saved')").run(start + 70_000);
      await touch('.cindy/memory/tea.md', start + 70_000);
      db.prepare("INSERT INTO schedule_runs VALUES ('r1', 'success', ?, 'review')").run(start + 120_000);
      const next: string[] = [];
      expect(await runMemoryCheck(workingDir, start + 8 * day, { runId: 'r2', log: next })).toBe(0);
      expect(next.join('\n')).toContain('.cindy/memory/tea.md');
    } finally { db.close(); }
  });

  // #12080 review P2 (Greptile, Codex): the walk is bounded by entries visited, memory first,
  // and each folder level before the next, so a large resource folder in an earlier Skill can
  // neither hold up the check nor hide a later Skill. Unit, real generated check: 2,100 old
  // files in a-large/data, a new z-new/SKILL.md and a changed memory record.
  it('bounds the walk of a large Skill folder without hiding later Skills', async () => {
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);`);
    db.close();
    const firedAt = Date.now();
    const skills = path.join(workingDir, '.agents', 'skills');
    const data = path.join(skills, 'a-large', 'data');
    await fs.mkdir(data, { recursive: true });
    await Promise.all(Array.from({ length: 2100 }, (_, i) => fs.writeFile(path.join(data, `f${i}.txt`), '')));
    await fs.mkdir(path.join(skills, 'z-new'), { recursive: true });
    await fs.writeFile(path.join(skills, 'z-new', 'SKILL.md'), 'New skill');
    // The large folder is old material, the new Skill came after the last review.
    const reviewed = firedAt - 1_000;
    await fs.writeFile(path.join(root, '.memory-review-state-v1.json'), JSON.stringify({ reviewedAt: 0, since: reviewed }));
    const old = reviewed / 1000 - 60;
    await Promise.all(Array.from({ length: 2100 }, (_, i) => fs.utimes(path.join(data, `f${i}.txt`), old, old)));
    await fs.mkdir(path.join(workingDir, '.cindy', 'memory'), { recursive: true });
    await fs.writeFile(path.join(workingDir, '.cindy', 'memory', 'coffee.md'), 'Oat milk');
    const log: string[] = [];
    expect(await runMemoryCheck(workingDir, firedAt, { log })).toBe(0);
    expect(log.join('\n')).toContain('.cindy/memory/coffee.md');
    expect(log.join('\n')).toContain('.agents/skills/z-new/SKILL.md');
    expect(log.join('\n')).not.toContain('a-large/data');
    expect(log.join('\n')).toContain('Stopped after 2000 entries');
  });

  // The check installed before 2026-11-22 (dff1c6e5) only counted messages. Unit, real
  // installed body + SQLite: upgrading it in place lets a quiet teammate's memory be reviewed.
  it('upgrades the installed message-only check so saved memory of a quiet teammate is reviewed', async () => {
    loader.loadProjectSchedules.mockResolvedValueOnce(null);
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const supplied = loader.upsertSchedule.mock.calls[0]![1];
    const checkFile = path.join(root, '.memory-review-check-v1.cjs');
    const old = await fs.readFile(new URL('./fixtures/memory-review-dff1c6e5.cjs.txt', import.meta.url), 'utf8');
    await fs.writeFile(checkFile, `const source = ${JSON.stringify({ databasePath: database.path,
      botId: 'bot-1', syntheticPrefix: '[UI_ACTION_TRIGGER]' })};\n${old.slice(old.indexOf('\n') + 1)}`);
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);`);
    db.close();
    await fs.mkdir(path.join(workingDir, '.cindy', 'memory'), { recursive: true });
    await fs.writeFile(path.join(workingDir, '.cindy', 'memory', 'coffee.md'), 'Oat milk');
    const firedAt = Date.now();
    expect(await runMemoryCheck(workingDir, firedAt)).toBe(2); // Actual installed behavior.
    loader.loadProjectSchedules.mockResolvedValue([supplied]);
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir })).resolves.toBe(false);
    expect(await runMemoryCheck(workingDir, firedAt)).toBe(0);
    expect(loader.upsertSchedule).toHaveBeenCalledOnce();
  });

  // Real data 2026-11-21: one computer's teammates skipped 6 nights in a row; one had 58 owner
  // messages a month and could never reach 20 in a day (#12007). Unit, real generated check +
  // SQLite with the production schedules / schedule_runs columns it reads; the start is the
  // review state's confirmed reviewedAt (#12080).
  it('counts human messages since the last confirmed review, not only the last day', async () => {
    loader.loadProjectSchedules.mockResolvedValueOnce(null);
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);
      CREATE TABLE schedules(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE schedule_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, finished_at INTEGER, session_id TEXT);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, working_dir TEXT, project_dir TEXT);
      INSERT INTO bot_session_links VALUES ('bot-1','chat');`);
    const day = 86_400_000;
    const firedAt = Date.now();
    const created = firedAt - 30 * day;
    db.prepare('INSERT INTO schedules VALUES (?, ?)').run('review', created);
    const message = db.prepare("INSERT INTO messages VALUES ('chat', 'user', NULL, ?, NULL, 'Human request')");
    const finish = db.prepare('INSERT INTO schedule_runs(id, status, finished_at) VALUES (?, ?, ?)');
    const state = path.join(root, '.memory-review-state-v1.json');
    const check = (at: number, runId: string, log?: string[]) =>
      runMemoryCheck(workingDir, at, { scheduleId: 'review', runId, log });
    try {
      message.run(created - day); // Before this automation existed here.
      for (let daysAgo = 2; daysAgo <= 20; daysAgo++) message.run(firedAt - daysAgo * day);
      expect(await check(firedAt, 'r1')).toBe(2); // Never reviewed: 19 since setup.
      message.run(firedAt - 5 * day);
      const first: string[] = [];
      expect(await check(firedAt, 'r2', first)).toBe(0); // 20 accumulated, none in the last day.
      expect(first.join('\n')).toContain(`Review conversations since ${new Date(created).toISOString()}.`);
      // #12080's skip is kept: 20 accumulated, but the previous review is still running.
      finish.run('r2', 'running', null);
      const running: string[] = [];
      expect(await check(firedAt + day / 2, 'r2b', running)).toBe(2);
      expect(running.join('\n')).toContain('still running');
      db.prepare("UPDATE schedule_runs SET status = 'failed', finished_at = ? WHERE id = 'r2'").run(firedAt + 60_000);
      expect(await check(firedAt + day, 'r3')).toBe(0); // A failed review does not reset the count.
      finish.run('r3', 'success', firedAt + day + 60_000);
      for (let i = 0; i < 9; i++) message.run(firedAt + day + 3_600_000);
      const skipped: string[] = [];
      expect(await check(firedAt + 2 * day, 'r4', skipped)).toBe(2); // 9 since that review.
      expect(skipped.join('\n')).toContain(`since ${new Date(firedAt + day).toISOString()}`);
      for (let i = 0; i < 11; i++) message.run(firedAt + 2 * day + 3_600_000);
      expect(await check(firedAt + 3 * day, 'r5')).toBe(0); // Skipped nights kept counting.
      // Clock moved back below the recorded review: count since setup, not an empty window.
      await fs.writeFile(state, JSON.stringify({ reviewedAt: firedAt + 10 * day, since: 0 }));
      expect(await check(firedAt + 3 * day, 'r6')).toBe(0);
      // A test run has no local record of the automation: the last day only.
      await fs.writeFile(state, JSON.stringify({ reviewedAt: 0, since: 0 }));
      expect(await runMemoryCheck(workingDir, firedAt + 3 * day, { scheduleId: 'test', runId: 'test' })).toBe(2);
    } finally { db.close(); }
  });

  // Installed check (ed9421bc, #12080) + its untouched last-day prompt upgrade together; an
  // owner's edited prompt or check is kept (#12007). Unit, real installed body + SQLite.
  it('upgrades the installed last-day message check and its untouched prompt, keeping owner edits', async () => {
    loader.loadProjectSchedules.mockResolvedValueOnce(null);
    await ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir });
    const fresh = loader.upsertSchedule.mock.calls[0]![1];
    const lastDay = { ...fresh, cronExpr: '0 5 * * *',
      prompt: fresh.prompt.replace('since the last completed review', 'from the last day') };
    const checkFile = path.join(root, '.memory-review-check-v1.cjs');
    const old = await fs.readFile(new URL('./fixtures/memory-review-ed9421bc.cjs.txt', import.meta.url), 'utf8');
    const installed = `const source = ${JSON.stringify({ databasePath: database.path, botId: 'bot-1',
      workspace: workingDir, syntheticPrefix: '[UI_ACTION_TRIGGER]' })};\n${old.slice(old.indexOf('\n') + 1)}`;
    const db = new DatabaseSync(database.path);
    db.exec(`CREATE TABLE bot_session_links(bot_id TEXT, session_id TEXT);
      CREATE TABLE messages(session_id TEXT, role TEXT, rewind_at INTEGER, created_at INTEGER, agent_meta TEXT, content TEXT);
      CREATE TABLE schedules(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      INSERT INTO bot_session_links VALUES ('bot-1','chat');`);
    const firedAt = Date.now();
    db.prepare('INSERT INTO schedules VALUES (?, ?)').run('review', firedAt - 30 * 86_400_000);
    const message = db.prepare("INSERT INTO messages VALUES ('chat', 'user', NULL, ?, NULL, 'Human request')");
    for (let i = 0; i < 20; i++) message.run(firedAt - (i + 2) * 86_400_000);
    db.close();
    // Never reviewed: each check below starts without a review state.
    const run = async () => {
      await fs.rm(path.join(root, '.memory-review-state-v1.json'), { force: true });
      return runMemoryCheck(workingDir, firedAt, { scheduleId: 'review' });
    };
    await fs.writeFile(checkFile, installed);
    expect(await run()).toBe(2); // Actual predecessor behavior.
    loader.loadProjectSchedules.mockResolvedValueOnce([lastDay]);
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir })).resolves.toBe(true);
    expect(await run()).toBe(0);
    expect(loader.upsertSchedule).toHaveBeenLastCalledWith(workingDir, expect.objectContaining({
      cronExpr: '0 5 * * *', prompt: fresh.prompt, preRunHook: lastDay.preRunHook,
    }), { keepUnreadable: true });
    // Owner-edited prompt (scope at either end): the check still upgrades, the prompt stays.
    for (const prompt of [`${lastDay.prompt} Also tidy notes.`, lastDay.prompt.replace('Review Mimi', 'Review only work-related parts of Mimi')]) {
      await fs.writeFile(checkFile, installed);
      loader.loadProjectSchedules.mockResolvedValueOnce([{ ...lastDay, prompt }]);
      await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir })).resolves.toBe(false);
      expect(await run()).toBe(0);
    }
    // Owner-edited check: neither the check nor the prompt changes.
    await fs.writeFile(checkFile, `${installed}\n// Owner customization\n`);
    loader.loadProjectSchedules.mockResolvedValueOnce([lastDay]);
    await expect(ensureBotProjectAutomations({ botId: 'bot-1', displayName: 'Mimi', workingDir })).resolves.toBe(false);
    expect(await run()).toBe(2);
    expect(loader.upsertSchedule).toHaveBeenCalledTimes(2);
  });

  // #12608 / unit: local migration and cloud restore previously tested in isolation.
  // Replaying a paused legacy definition after the local upgrade must converge.
  it('keeps the migrated review when the same cloud definition arrives twice', async () => {
    const { applyProjectAutomations } = await import('../../companion-cloud/project.js');
    const bot = { botId: 'bot-1', displayName: 'Mimi', workingDir };
    const rows = new Map<string, Schedule>();
    const storage = {
      list: async () => [...rows.values()],
      get: async (id: string) => rows.get(id) ?? null,
      insert: async (row: Schedule) => { rows.set(row.id, row); return row; },
      update: async (id: string, patch: Partial<Schedule>) => {
        const row = { ...rows.get(id)!, ...patch };
        rows.set(id, row);
        return row;
      },
    };
    const scheduler = new Scheduler({ storage: storage as ScheduleStorage, runner: { fire: vi.fn() } });
    const project = new ProjectAutomationLoader({
      scheduler, storage: storage as ConstructorParameters<typeof ProjectAutomationLoader>[0]['storage'],
      getDb: () => { throw new Error('unexpected database access'); }, logger: { warn: vi.fn() },
    });
    loader.loadProjectSchedules.mockReset().mockImplementation(dir => project.loadProjectSchedules(dir));
    loader.upsertSchedule.mockImplementation((dir, config) => project.upsertSchedule(dir, config, { keepUnreadable: true }));
    try {
      await ensureBotProjectAutomations(bot);
      const [fresh] = (await project.loadProjectSchedules(workingDir))!;
      const legacy = { ...fresh!, prompt: fresh!.prompt.replace('since the last completed review', 'from the last day') };
      const [created] = await storage.list();
      await scheduler.pause(created!.id);
      await project.upsertSchedule(workingDir, legacy);
      const writes: string[] = [];
      let writer = 'migration';
      project.onEvent(event => { if (event.type === 'reconciled') writes.push(`${writer}:${event.updated}`); });
      const migrate = async () => { writer = 'migration'; await ensureBotProjectAutomations(bot); };
      const arrive = (config: ProjectScheduleConfig) => applyProjectAutomations({
        ...bot, selfDeviceId: 'desk', assertCurrent: () => {},
        rows: [{ id: config.id, value: { config, paused: true, originDeviceId: 'desk' } }],
        io: {
          prepareMemoryReview: prepareArrivedMemoryReview,
          prepareProject: async () => { await migrate(); return bot; },
          automations: async () => (await project.loadProjectSchedules(workingDir))!.map(value =>
            ({ config: { ...value }, paused: rows.get(created!.id)?.status === 'paused' })),
          upsertAutomation: async (_dir, value) => {
            writer = 'cloud';
            await project.upsertSchedule(workingDir, value as unknown as ProjectScheduleConfig);
          },
          setAutomationPaused: async () => { throw new Error('unexpected pause change'); },
          removeAutomation: async () => { throw new Error('unexpected removal'); },
        },
      });
      await migrate();
      await migrate();
      expect(writes).toEqual(['migration:1']);
      await arrive(legacy);
      await arrive(legacy);
      const olderHook = { ...legacy, preRunHook: { ...legacy.preRunHook!, command: 'xdt-node "../.memory-review-check-v1.cjs"' } };
      await arrive(olderHook);
      expect(writes).toEqual(['migration:1']);
      await arrive({ ...legacy, cronExpr: '0 5 * * *' });
      expect(rows.get(created!.id)).toMatchObject({ cronExpr: '0 5 * * *', prompt: fresh!.prompt, status: 'paused' });
      const edited = { ...legacy, prompt: legacy.prompt + ' Keep release notes.' };
      await arrive(edited);
      await arrive(edited);
      expect(await storage.list()).toMatchObject([{ id: created!.id, status: 'paused', prompt: edited.prompt }]);
      expect(writes).toEqual(['migration:1', 'cloud:1', 'cloud:1']);

      await arrive(fresh!);
      await fs.appendFile(path.join(root, '.memory-review-check-v1.cjs'), '\n// Owner customization');
      await arrive(legacy);
      await arrive(legacy);
      expect(rows.get(created!.id)?.prompt).toBe(legacy.prompt);
    } finally {
      loader.loadProjectSchedules.mockReset();
      loader.upsertSchedule.mockReset();
    }
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
    // As both upgrade entries do: the local .gitignore entries come first, else the version is deferred.
    await expect(ensureTeammateProjectIgnored({ workspace })).resolves.toBe('ready');

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
