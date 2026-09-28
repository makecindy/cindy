import { expect, it, vi } from 'vitest';
import { createImportBudget, deserializeImportSnapshot, readImportFile, serializeImportSnapshot, snapshotFingerprint } from '../files.js';
import type { ImportSnapshot } from '../types.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('rejects the next file before allocating its buffer when the cumulative budget is exhausted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-budget-test-'));
  try {
    const file = path.join(root, 'resource');
    await fs.writeFile(file, '1234');
    const budget = createImportBudget(7);
    expect((await readImportFile(root, file, budget)).bytes.toString()).toBe('1234');
    const allocate = vi.spyOn(Buffer, 'alloc');
    try {
      await expect(readImportFile(root, file, budget)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
      expect(allocate).not.toHaveBeenCalled();
    } finally { allocate.mockRestore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('hashes binary contents and checkpoints compactly without invoking Buffer.toJSON', () => {
  const snapshot: ImportSnapshot = {
    source: { kind: 'hermes', name: 'Fixture', agentId: 'fixture', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config' },
    fingerprint: 'fixture', items: [
      { view: { id: 'skill', category: 'skills', name: 'skill', selected: true }, files: [{ name: 'data.bin', bytes: Buffer.alloc(256 * 1024, 255), executable: false }] },
      { view: { id: 'script', category: 'connections', name: 'script', selected: true }, asset: { name: 'script.py', bytes: Buffer.from('print(1)') } },
    ],
  };
  const legacy = JSON.stringify(snapshot);
  const stringifyBuffer = vi.spyOn(Buffer.prototype, 'toJSON').mockImplementation(() => { throw new Error('numeric buffer expansion'); });
  try {
    const hash = snapshotFingerprint(snapshot.items);
    const checkpoint = serializeImportSnapshot(snapshot);
    expect(checkpoint.length).toBeLessThan(400_000);
    expect(deserializeImportSnapshot(checkpoint)).toEqual(snapshot);
    expect(deserializeImportSnapshot(legacy)).toEqual(snapshot);
    expect(snapshotFingerprint(deserializeImportSnapshot(checkpoint).items)).toBe(hash);
    snapshot.items[0]!.files![0]!.bytes[0] = 254;
    expect(snapshotFingerprint(snapshot.items)).not.toBe(hash);
    expect(stringifyBuffer).not.toHaveBeenCalled();
  } finally { stringifyBuffer.mockRestore(); }
});
