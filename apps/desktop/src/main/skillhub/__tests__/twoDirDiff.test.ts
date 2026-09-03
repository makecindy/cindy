import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-two-dir-diff-test-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(TEST_ROOT, 'userData')) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  maskPath: (p: string) => p,
}));

import { computeTwoDirDiff } from '../snapshot';

async function write(dir: string, rel: string, content: string | Buffer): Promise<void> {
  const full = path.join(dir, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, content);
}

beforeEach(async () => {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('computeTwoDirDiff', () => {
  it('oldDir=null → 全部 added(learn 全新提案场景)', async () => {
    const newDir = path.join(TEST_ROOT, 'new');
    await write(newDir, 'SKILL.md', 'hello');
    await write(newDir, 'scripts/run.sh', 'echo hi');

    const changes = await computeTwoDirDiff(null, newDir);
    // 排序是 localeCompare(大小写不敏感),按 path→kind map 断言避免依赖 locale 顺序
    expect(Object.fromEntries(changes.map((c) => [c.path, c.kind]))).toEqual({
      'SKILL.md': 'added',
      'scripts/run.sh': 'added',
    });
    const skillChange = changes.find((c) => c.path === 'SKILL.md')!;
    expect(skillChange.newContent).toBe('hello');
    expect(skillChange.oldContent).toBe('');
  });

  it('detects modified / added / removed across two dirs', async () => {
    const oldDir = path.join(TEST_ROOT, 'old');
    const newDir = path.join(TEST_ROOT, 'new');
    await write(oldDir, 'SKILL.md', 'v1');
    await write(oldDir, 'gone.md', 'bye');
    await write(oldDir, 'same.md', 'stable');
    await write(newDir, 'SKILL.md', 'v2');
    await write(newDir, 'fresh.md', 'hi');
    await write(newDir, 'same.md', 'stable');

    const changes = await computeTwoDirDiff(oldDir, newDir);
    expect(Object.fromEntries(changes.map((c) => [c.path, c.kind]))).toEqual({
      'SKILL.md': 'modified',
      'fresh.md': 'added',
      'gone.md': 'removed',
    });
    const skillChange = changes.find((c) => c.path === 'SKILL.md')!;
    expect(skillChange.oldContent).toBe('v1');
    expect(skillChange.newContent).toBe('v2');
  });

  it('flags binary files by extension and skips content', async () => {
    const newDir = path.join(TEST_ROOT, 'new');
    await write(newDir, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const changes = await computeTwoDirDiff(null, newDir);
    expect(changes[0].isBinary).toBe(true);
    expect(changes[0].newContent).toBe('');
    expect(changes[0].newSize).toBe(4);
  });
});
