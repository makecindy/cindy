import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-learn-runstore-test-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(TEST_ROOT, 'userData')) },
}));
vi.mock('../../appSessionState', () => ({
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(TEST_ROOT, 'userData', 'owners', 'test-owner', ...parts),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { LearnRunStore } from '../runStore';
import type { LearnRunPublic } from '../../../shared/learnTypes';

const RUNS_FILE = path.join(
  TEST_ROOT,
  'userData',
  'owners',
  'test-owner',
  'learn',
  'runs.json',
);

const run = (id: string, status: LearnRunPublic['status'] = 'awaiting-review'): LearnRunPublic => ({
  runId: id,
  status,
  sourceKind: 'freetext',
  input: 'x',
  usedSessionEvidence: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

beforeEach(async () => {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('LearnRunStore 竞态防护', () => {
  it('load 单飞:并发调用共享同一 promise,写入不丢已存在的历史 run', async () => {
    await fs.promises.mkdir(path.dirname(RUNS_FILE), { recursive: true });
    await fs.promises.writeFile(RUNS_FILE, JSON.stringify({ schemaVersion: 1, runs: [run('old-run')] }), 'utf8');

    const store = new LearnRunStore();
    const p1 = store.load();
    const p2 = store.load(); // 首个 load 尚未完成时的并发调用
    expect(p2).toBe(p1);
    await p2;
    await store.put(run('new-run'));

    const persisted = JSON.parse(await fs.promises.readFile(RUNS_FILE, 'utf8'));
    const ids = persisted.runs.map((r: LearnRunPublic) => r.runId).sort();
    expect(ids).toEqual(['new-run', 'old-run']);
  });

  it('并发 put 串行落盘,最终文件包含全部 run 且为合法 JSON', async () => {
    const store = new LearnRunStore();
    await store.load();
    await Promise.all([store.put(run('a')), store.put(run('b')), store.put(run('c'))]);

    const persisted = JSON.parse(await fs.promises.readFile(RUNS_FILE, 'utf8'));
    expect(persisted.runs.map((r: LearnRunPublic) => r.runId).sort()).toEqual(['a', 'b', 'c']);
    // 无残留 tmp 文件
    const leftovers = (await fs.promises.readdir(path.dirname(RUNS_FILE))).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
