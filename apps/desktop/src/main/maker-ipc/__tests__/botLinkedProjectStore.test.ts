/**
 * 测试价值
 * - 生产入口与可观察结果:botLinkedProjectStore 的关联项目读写与云端搬家读写;workbench.json 里旧的
 *   tasks(V1 判断)原样保留,搬家不丢另一台电脑的数据。
 * - 规则依据:cloud-companions.md §2(损坏文件不得读成空、搬家不改写别的电脑的路径);关联项目只是上下文。
 * - 现有覆盖缺口:随 V1 工作台删除从 botWorkbenchService.test.ts 移来,行为不变;旧判断不再被读取,只透传。
 * - 最小失败输入:带 directories/tasks 的旧文件;损坏文件;写链中途失败。
 * - tier:unit(临时目录真实文件 I/O,无 Electron)。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { botProfileDir } from '../botProfileFolder.js';
import {
  MAX_LINKED_PROJECTS,
  mergeCompanionWorkbench,
  normalizeLinkedProjectStore,
  readBotLinkedProjects,
  readCompanionWorkbench,
  setBotLinkedProject,
} from '../botLinkedProjectStore.js';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

const judgment = (verdict: 'unfinished' | 'idea' | 'done', updatedAt: string, project = '/w/art') => ({
  title: '导出图标',
  verdict,
  next: verdict === 'done' ? null : '补 xxhdpi',
  project,
  updatedAt,
});

async function writeLegacy(dir: string, value: unknown): Promise<string> {
  const file = path.join(botProfileDir(dir, 'bot-1'), 'workbench.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

const storedTasks = async (dir: string) =>
  JSON.parse(await readFile(path.join(botProfileDir(dir, 'bot-1'), 'workbench.json'), 'utf8')).tasks as Record<string, unknown>;

describe('stored linked projects', () => {
  it('bounds malformed directories and passes V1 judgments through as written', () => {
    const normalized = normalizeLinkedProjectStore({
      directories: [
        null,
        { path: 'relative/path' },
        { path: '/a', addedAt: 7 },
        { path: '/a' },
        ...Array.from({ length: MAX_LINKED_PROJECTS + 5 }, (_, index) => ({ path: `/p${index}`, addedAt: 'x' })),
      ],
      tasks: { ok: judgment('idea', '2026-10-01T00:00:00.000Z'), notObject: 'x', list: [1] },
    });
    expect(normalized?.directories).toHaveLength(MAX_LINKED_PROJECTS);
    expect(normalized?.directories[0]).toEqual({ path: '/a', addedAt: new Date(0).toISOString() });
    expect(normalized?.tasks).toEqual({ ok: judgment('idea', '2026-10-01T00:00:00.000Z') });
  });
});

describe('linked projects moving with the companion', () => {
  it('carries every computer\'s folders and portable judgments unchanged', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const here = path.join(root, 'here');
    await writeLegacy(root, { directories: [{ path: here, addedAt: '2026-10-01T00:00:00.000Z' }], tasks: {} });
    await mergeCompanionWorkbench(root, 'bot-1', 'desk', {
      directories: [{ path: 'C:\\Users\\dash\\game', addedAt: '2026-10-01T00:00:00.000Z', deviceId: 'laptop' },
        { path: '/Users/dash/back-home', addedAt: '2026-10-01T00:00:00.000Z', deviceId: 'desk' }],
      tasks: {
        'pr:makecindy/cindy#1': judgment('unfinished', '2026-10-01T00:00:00.000Z', here),
        'session:abc': judgment('unfinished', '2026-10-01T00:00:00.000Z', here),
      },
    });
    const travelling = await readCompanionWorkbench(root, 'bot-1', 'desk');
    expect(travelling.directories.map((dir) => `${dir.deviceId}:${dir.path}`).sort()).toEqual(
      ['desk:/Users/dash/back-home', `desk:${here}`, 'laptop:C:\\Users\\dash\\game'].sort(),
    );
    expect(Object.keys(travelling.tasks)).toEqual(['pr:makecindy/cindy#1']);
  });

  it('lets the cloud replace what this computer synced before, keeping judgments that never travel', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const here = path.join(root, 'here');
    await writeLegacy(root, {
      directories: [{ path: here, addedAt: '2026-10-01T00:00:00.000Z' }],
      tasks: {
        'session:abc': judgment('unfinished', '2026-10-01T00:00:00.000Z', here),
        'pr:makecindy/cindy#1': judgment('unfinished', '2026-10-01T00:00:00.000Z', here),
      },
    });
    await mergeCompanionWorkbench(root, 'bot-1', 'desk', null, { replace: true });
    expect((await readCompanionWorkbench(root, 'bot-1', 'desk')).directories).toEqual([]);
    expect(Object.keys(await storedTasks(root))).toEqual(['session:abc']);
  });

  it('reads a damaged workbench as unreadable for the cloud, never as an empty one', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    expect(await readCompanionWorkbench(root, 'bot-1', 'desk')).toEqual({ directories: [], tasks: {} });
    await writeLegacy(root, '{not json');
    await expect(readCompanionWorkbench(root, 'bot-1', 'desk')).rejects.toThrow();
  });

  it('absorbs the cleanup rejection when a write fails and keeps the chain usable', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const file = path.join(botProfileDir(root, 'bot-1'), 'workbench.json');
    // workbench.json 是目录 → mutate 的 rename 失败。
    await mkdir(file, { recursive: true });
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(mergeCompanionWorkbench(root, 'bot-1', 'desk', { directories: [], tasks: {} })).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    await rm(file, { recursive: true });
    await mergeCompanionWorkbench(root, 'bot-1', 'desk', {
      directories: [{ path: '/elsewhere', addedAt: '2026-10-01T00:00:00.000Z', deviceId: 'laptop' }], tasks: {},
    });
    expect((await readCompanionWorkbench(root, 'bot-1', 'desk')).directories).toHaveLength(1);
  });
});

// Linked-project restoration: existing tests only cover legacy judgment/cloud transport.
// Production storage must keep multiple associations, other computers and judgments; no task ownership is written.
// Minimal regression: add/remove a second directory beside a legacy directory. Tier: unit, isolated temporary files.
describe('linked projects', () => {
  it('retains legacy links and judgments while independently adding and removing multiple projects', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-projects-'));
    const first = path.join(root, 'first'); const second = path.join(root, 'second');
    const legacy = { directories: [{ path: first, addedAt: 'old' }, { path: first, addedAt: 'remote', deviceId: 'other' }], tasks: { 'idea:icons': judgment('idea', '2026-10-01T00:00:00.000Z') } };
    const file = await writeLegacy(root, legacy);
    await setBotLinkedProject(root, 'bot-1', { path: second }, true, () => {});
    await setBotLinkedProject(root, 'bot-1', { path: second }, true, () => {});
    expect(await readBotLinkedProjects(root, 'bot-1')).toHaveLength(3);
    expect(await readBotLinkedProjects(root, 'bot-2')).toEqual([]);
    await setBotLinkedProject(root, 'bot-1', { path: first }, false, () => {});
    expect((await readBotLinkedProjects(root, 'bot-1')).map(p => [p.path, p.deviceId])).toEqual([[first, 'other'], [second, undefined]]);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.tasks).toEqual(legacy.tasks);
    expect(saved.responsibleSessionIds).toBeUndefined();
    expect((await readCompanionWorkbench(root, 'bot-1', 'self')).directories.map(p => p.deviceId)).toEqual(['other', 'self']);
  });
  it('refuses damaged data and revoked writes without losing the existing associations', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-projects-'));
    const file = await writeLegacy(root, '{broken');
    await expect(setBotLinkedProject(root, 'bot-1', { path: root }, true, () => {})).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{broken');
    await writeLegacy(root, { directories: [{ path: root, addedAt: 'old' }], tasks: {} });
    let checks = 0;
    await expect(setBotLinkedProject(root, 'bot-1', { path: root }, false, () => { if (++checks === 4) throw Error('REVOKED'); })).rejects.toThrow('REVOKED');
    expect(await readBotLinkedProjects(root, 'bot-1')).toEqual([{ path: root, addedAt: 'old' }]);
  });
});
