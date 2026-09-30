import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { botProfileDir } from '../botProfileFolder.js';
import {
  addBotWorkbenchDirectory,
  normalizeWorkbench,
  readBotWorkbench,
  readBotWorkbenchDirectoryPaths,
  removeBotWorkbenchDirectory,
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
    expect(await readBotWorkbench(root, 'bot-1')).toEqual({ directories: [] });
    await mkdir(botProfileDir(root, 'bot-1'), { recursive: true });
    await writeFile(path.join(botProfileDir(root, 'bot-1'), 'workbench.json'), '{not json', 'utf8');
    expect(await readBotWorkbench(root, 'bot-1')).toEqual({ directories: [] });
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
    });
    await removeBotWorkbenchDirectory(root, 'bot-1', path.join(root, 'nothing'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      directories: [{ path: project, addedAt: '2026-09-30T00:00:00.000Z' }],
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
