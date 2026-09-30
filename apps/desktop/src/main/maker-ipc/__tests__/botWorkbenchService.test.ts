import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));

import { botProfileDir } from '../botProfileFolder.js';
import {
  addBotWorkbenchDirectory,
  normalizeWorkbench,
  readBotWorkbench,
  removeBotWorkbenchDirectory,
  writeBotWorkbench,
} from '../botWorkbenchService.js';

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('bot workbench storage', () => {
  it('writes into the Bot home and reads the same cards back', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const cards = [
      { title: '进度', source: 'Filo', rows: [{ title: '#4100 Yahoo 邮件不显示', detail: 'review 等了 2 天', flag: true, status: 'review' }] },
    ];

    const saved = await writeBotWorkbench(root, 'bot-1', cards, new Date('2026-09-30T01:00:00.000Z'));
    const loaded = await readBotWorkbench(root, 'bot-1');

    expect(saved.updatedAt).toBe('2026-09-30T01:00:00.000Z');
    expect(loaded).toEqual({ cards, updatedAt: '2026-09-30T01:00:00.000Z', directories: [] });
    const onDisk = JSON.parse(await readFile(path.join(botProfileDir(root, 'bot-1'), 'workbench.json'), 'utf8'));
    expect(onDisk.cards).toEqual(cards);
  });

  it('reads an empty workbench when a Bot has none yet or the file is corrupt', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const empty = { cards: [], updatedAt: null, directories: [] };
    expect(await readBotWorkbench(root, 'bot-1')).toEqual(empty);
    await writeBotWorkbench(root, 'bot-1', []);
    await writeFile(path.join(botProfileDir(root, 'bot-1'), 'workbench.json'), '{not json', 'utf8');
    expect(await readBotWorkbench(root, 'bot-1')).toEqual(empty);
  });

  it('keeps directories the owner gave when the Bot rewrites its cards, and the other way round', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'bot-workbench-'));
    const project = path.join(root, 'Filo');
    await mkdir(project);

    await writeBotWorkbench(root, 'bot-1', [{ title: '进度', rows: [{ title: '#4100', status: 'review' }] }]);
    expect(await addBotWorkbenchDirectory(root, 'bot-1', project)).toEqual({ ok: true });
    expect(await addBotWorkbenchDirectory(root, 'bot-1', path.join(root, 'missing'))).toEqual({
      ok: false,
      errorCode: 'NOT_A_DIRECTORY',
    });
    await writeBotWorkbench(root, 'bot-1', [{ title: '资产', rows: [] }]);

    const loaded = await readBotWorkbench(root, 'bot-1');
    expect(loaded.cards.map((card) => card.title)).toEqual(['资产']);
    expect(loaded.directories).toMatchObject([{ path: project, name: 'Filo', exists: true }]);

    await removeBotWorkbenchDirectory(root, 'bot-1', project);
    expect((await readBotWorkbench(root, 'bot-1')).directories).toEqual([]);
    expect((await readBotWorkbench(root, 'bot-1')).cards).toHaveLength(1);
  });

  it('bounds and drops malformed entries instead of trusting the file', () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => ({ title: `卡${index}`, rows: [] }));
    const normalized = normalizeWorkbench({
      updatedAt: '2026-09-30T00:00:00.000Z',
      cards: [
        {
          title: '检查',
          rows: [
            { title: '' },
            { title: '命名不规范', action: { label: '改名', message: '' }, status: '待处理' },
            ...Array.from({ length: 8 }, (_, index) => ({ title: `行${index}`, status: 'x' })),
          ],
        },
        null,
        ...tooMany,
      ],
    });

    expect(normalized?.cards).toHaveLength(4);
    expect(normalized?.cards[0].rows).toHaveLength(5);
    expect(normalized?.cards[0].rows[0]).toEqual({ title: '命名不规范', status: '待处理' });
  });
});
