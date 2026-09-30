import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateWorkspace } from '../workspace';

it('counts hidden and nested files, skips root Git metadata and does not count directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'objects'), 'excluded');
    await fs.writeFile(path.join(root, '.env'), 'abc');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'file'), '12345');
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 2, bytes: 8 });
    await expect(
      estimateWorkspace(root, () => {
        throw new Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
