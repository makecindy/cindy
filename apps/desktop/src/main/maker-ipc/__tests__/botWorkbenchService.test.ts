import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { botProfileDir } from '../botProfileFolder.js';
import {
  addBotWorkbenchDirectory,
  boundJudgments,
  normalizeWorkbench,
  readBotWorkbench,
  readBotWorkbenchDirectoryPaths,
  readBotWorkbenchState,
  rekeyBotWorkbenchJudgment,
  removeBotWorkbenchDirectory,
  setBotWorkbenchJudgment,
} from '../botWorkbenchService.js';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('bot workbench storage', () => {
  it('records handed-over projects in the Bot home, newest first, and removes them', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const filo = path.join(root, 'Filo');
    const art = path.join(root, 'tapmon-art');
    await mkdir(filo);
    await mkdir(art);

    expect(await addBotWorkbenchDirectory(root, 'bot-1', filo, new Date('2026-10-01T01:00:00.000Z'))).toEqual({ ok: true });
    expect(await addBotWorkbenchDirectory(root, 'bot-1', art, new Date('2026-10-01T02:00:00.000Z'))).toEqual({ ok: true });
    // Handing the same project over again only moves it to the front.
    expect(await addBotWorkbenchDirectory(root, 'bot-1', filo, new Date('2026-10-01T03:00:00.000Z'))).toEqual({ ok: true });

    expect((await readBotWorkbench(root, 'bot-1')).directories).toEqual([
      { path: filo, name: 'Filo', addedAt: '2026-10-01T03:00:00.000Z', exists: true },
      { path: art, name: 'tapmon-art', addedAt: '2026-10-01T02:00:00.000Z', exists: true },
    ]);
    expect(await readBotWorkbenchDirectoryPaths(root, 'bot-1')).toEqual([filo, art]);

    await removeBotWorkbenchDirectory(root, 'bot-1', filo);
    expect(await readBotWorkbenchDirectoryPaths(root, 'bot-1')).toEqual([art]);
    // Other Bots never see this Bot's projects.
    expect(await readBotWorkbenchDirectoryPaths(root, 'bot-2')).toEqual([]);
  });

  it('rejects missing folders and more than six projects', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    expect(await addBotWorkbenchDirectory(root, 'bot-1', path.join(root, 'missing'))).toEqual({
      ok: false,
      errorCode: 'NOT_A_DIRECTORY',
    });
    for (let index = 0; index < 6; index += 1) {
      const dir = path.join(root, `p${index}`);
      await mkdir(dir);
      expect(await addBotWorkbenchDirectory(root, 'bot-1', dir)).toEqual({ ok: true });
    }
    const extra = path.join(root, 'extra');
    await mkdir(extra);
    expect(await addBotWorkbenchDirectory(root, 'bot-1', extra)).toEqual({ ok: false, errorCode: 'TOO_MANY' });
  });

  it('reads an empty workbench when a Bot has none yet or the file is corrupt', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    expect(await readBotWorkbench(root, 'bot-1')).toEqual({ directories: [], tasks: {} });
    await mkdir(botProfileDir(root, 'bot-1'), { recursive: true });
    await writeFile(path.join(botProfileDir(root, 'bot-1'), 'workbench.json'), '{not json', 'utf8');
    expect(await readBotWorkbench(root, 'bot-1')).toEqual({ directories: [], tasks: {} });
  });

  it('ignores cards written by the earlier draft and drops them on the next write', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const project = path.join(root, 'Filo');
    await mkdir(project);
    const file = path.join(botProfileDir(root, 'bot-1'), 'workbench.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      cards: [{ title: '进度', rows: [{ title: '#4100', status: 'review' }] }],
      updatedAt: '2026-09-30T00:00:00.000Z',
      directories: [{ path: project, addedAt: '2026-09-30T00:00:00.000Z' }],
    }), 'utf8');

    expect(await readBotWorkbench(root, 'bot-1')).toEqual({
      directories: [{ path: project, name: 'Filo', addedAt: '2026-09-30T00:00:00.000Z', exists: true }],
      tasks: {},
    });
    await removeBotWorkbenchDirectory(root, 'bot-1', path.join(root, 'nothing'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      directories: [{ path: project, addedAt: '2026-09-30T00:00:00.000Z' }],
      tasks: {},
    });
  });

  it('bounds and drops malformed directory entries instead of trusting the file', () => {
    const normalized = normalizeWorkbench({
      directories: [
        null,
        { path: 'relative/path' },
        { path: '/a', addedAt: 7 },
        { path: '/a' },
        ...Array.from({ length: 8 }, (_, index) => ({ path: `/p${index}`, addedAt: 'x' })),
      ],
    });
    expect(normalized?.directories).toHaveLength(6);
    expect(normalized?.directories[0]).toEqual({ path: '/a', addedAt: new Date(0).toISOString() });
  });
});

describe('bot workbench judgments', () => {
  const judgment = (verdict: 'unfinished' | 'idea' | 'done', updatedAt: string) => ({
    title: '导出图标',
    verdict,
    next: verdict === 'done' ? null : '补 xxhdpi',
    project: '/w/art',
    updatedAt,
  });

  it('stores, replaces and re-keys a judgment next to the handed-over projects', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const project = path.join(root, 'art');
    await mkdir(project);
    await addBotWorkbenchDirectory(root, 'bot-1', project);
    await setBotWorkbenchJudgment(root, 'bot-1', 'claude:abc', {
      title: '导出图标',
      verdict: 'unfinished',
      next: '补 xxhdpi',
      project,
    }, new Date('2026-10-01T01:00:00.000Z'));
    await setBotWorkbenchJudgment(root, 'bot-1', 'claude:abc', {
      title: '导出 Android 图标',
      verdict: 'idea',
      next: '先问要不要做 xxxhdpi',
      project,
    }, new Date('2026-10-01T02:00:00.000Z'));
    expect((await readBotWorkbenchState(root, 'bot-1')).tasks).toEqual({
      'claude:abc': {
        title: '导出 Android 图标',
        verdict: 'idea',
        next: '先问要不要做 xxxhdpi',
        project,
        updatedAt: '2026-10-01T02:00:00.000Z',
      },
    });
    await rekeyBotWorkbenchJudgment(root, 'bot-1', 'claude:abc', 'claude-abc');
    const state = await readBotWorkbenchState(root, 'bot-1');
    expect(Object.keys(state.tasks)).toEqual(['claude-abc']);
    expect(state.directories).toEqual([project]);
    // Removing a project keeps the judgments; the projection hides them by project.
    await removeBotWorkbenchDirectory(root, 'bot-1', project);
    expect(Object.keys((await readBotWorkbenchState(root, 'bot-1')).tasks)).toEqual(['claude-abc']);
  });

  it('keeps at most the limit, evicting the oldest done judgments first', () => {
    const tasks = {
      a: judgment('done', '2026-10-01T00:00:01.000Z'),
      b: judgment('unfinished', '2026-10-01T00:00:00.000Z'),
      c: judgment('done', '2026-10-01T00:00:02.000Z'),
      d: judgment('idea', '2026-10-01T00:00:03.000Z'),
    };
    expect(Object.keys(boundJudgments(tasks, 3)).sort()).toEqual(['b', 'c', 'd']);
    expect(Object.keys(boundJudgments(tasks, 2)).sort()).toEqual(['b', 'd']);
    expect(Object.keys(boundJudgments(tasks, 1))).toEqual(['d']);
  });

  it('drops malformed judgments when reading', () => {
    const normalized = normalizeWorkbench({
      tasks: {
        ok: judgment('idea', '2026-10-01T00:00:00.000Z'),
        badVerdict: { ...judgment('idea', 'x'), verdict: 'maybe' },
        noTitle: { ...judgment('idea', 'x'), title: '' },
        relativeProject: { ...judgment('idea', 'x'), project: 'art' },
        long: { ...judgment('unfinished', 'x'), title: 'x'.repeat(80), next: 'y'.repeat(300) },
      },
    });
    expect(Object.keys(normalized?.tasks ?? {})).toEqual(['ok', 'long']);
    expect(normalized?.tasks.long.title).toHaveLength(40);
    expect(normalized?.tasks.long.next).toHaveLength(120);
  });
});
