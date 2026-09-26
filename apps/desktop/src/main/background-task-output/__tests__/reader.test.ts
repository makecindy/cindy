import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBackgroundTaskOutputTail } from '../reader';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-task-output-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readBackgroundTaskOutputTail', () => {
  it('returns the whole file with size and mtime when under the cap', async () => {
    const file = path.join(dir, 'b1.output');
    await fs.writeFile(file, 'line 1\nline 2\n');
    const result = await readBackgroundTaskOutputTail(file);
    expect(result).toMatchObject({
      ok: true,
      text: 'line 1\nline 2\n',
      size: 14,
      truncated: false,
    });
    if (result.ok) expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it('reads only the tail and drops the partial first line when over the cap', async () => {
    const file = path.join(dir, 'b2.output');
    await fs.writeFile(file, 'aaaaaaaaaa\nbbbb\ncccc\n');
    const result = await readBackgroundTaskOutputTail(file, 12);
    expect(result).toMatchObject({ ok: true, text: 'bbbb\ncccc\n', size: 21, truncated: true });
  });

  it('returns an empty tail for an empty file', async () => {
    const file = path.join(dir, 'b3.output');
    await fs.writeFile(file, '');
    expect(await readBackgroundTaskOutputTail(file)).toMatchObject({ ok: true, text: '', size: 0 });
  });

  it('rejects non-.output files, relative paths, directories and non-strings', async () => {
    const txt = path.join(dir, 'secret.txt');
    await fs.writeFile(txt, 'x');
    const folder = path.join(dir, 'folder.output');
    await fs.mkdir(folder);
    expect(await readBackgroundTaskOutputTail(txt)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await readBackgroundTaskOutputTail('tasks/b1.output')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await readBackgroundTaskOutputTail(123)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await readBackgroundTaskOutputTail(folder)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reports a missing file as not_found', async () => {
    expect(await readBackgroundTaskOutputTail(path.join(dir, 'gone.output'))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
