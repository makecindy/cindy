import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { sendParts, receiveParts } from '../transferParts';
describe('migration through existing attachment-sized transfers', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-migration-parts-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it('reassembles validated segments in order and keeps the source intact', async () => {
    const bytes = Buffer.from('project bytes spanning several objects');
    const source = path.join(root, 'source'),
      target = path.join(root, 'target');
    await fs.writeFile(source, bytes);
    const objects = new Map<string, Buffer>();
    const file = await sendParts(source, 7, async (part) => {
      const content = await fs.readFile(part),
        ref = String(objects.size);
      objects.set(ref, content);
      expect(content.length).toBeLessThanOrEqual(7);
      return {
        ref,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    });
    await receiveParts(file, target, async (part, destination) => {
      await fs.writeFile(destination, objects.get(part.ref)!);
    });
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readFile(source)).toEqual(bytes);
    expect((await fs.readdir(root)).sort()).toEqual(['source', 'target']);
  });
  it('stops on a truncated segment without consuming source data', async () => {
    await expect(
      receiveParts(
        { size: 8, parts: [{ ref: 'one', size: 8, sha256: 'a'.repeat(64) }] },
        path.join(root, 'target'),
        async (_part, destination) => {
          await fs.writeFile(destination, 'bad');
        },
      ),
    ).rejects.toThrow('MIGRATION_INVALID_FILE');
    expect(await fs.readdir(root)).toEqual(['target']);
  });
});
