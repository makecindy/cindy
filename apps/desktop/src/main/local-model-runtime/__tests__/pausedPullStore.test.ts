import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPausedPullStore, progressFromPausedRecord } from '../pausedPullStore.js';

describe('pausedPullStore', () => {
  it('round-trips a paused download and clears it', async () => {
    const dir = path.join(os.tmpdir(), `paused-pull-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const store = createPausedPullStore(path.join(dir, 'paused.json'));
    await store.write(
      {
        name: 'qwen3.8:27b-mxfp8',
        status: 'paused',
        phase: 'paused',
        completed: 9_000,
        total: 30_000,
        percent: 30,
        done: true,
      },
      ['sha256:aaa'],
    );
    const record = await store.read();
    expect(record).toMatchObject({
      name: 'qwen3.8:27b-mxfp8',
      completed: 9_000,
      total: 30_000,
      percent: 30,
      digests: ['sha256:aaa'],
    });
    expect(progressFromPausedRecord(record!).phase).toBe('paused');
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
    await expect(readFile(path.join(dir, 'paused.json'), 'utf8')).rejects.toThrow();
  });

  it('keeps two paused downloads and removes one', async () => {
    const dir = path.join(os.tmpdir(), `paused-pull-multi-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const store = createPausedPullStore(path.join(dir, 'paused.json'));
    await store.write(
      { name: 'gpt-oss:20b', status: 'paused', phase: 'paused', done: true },
      ['sha256:aaa'],
    );
    await store.write(
      { name: 'gemma4:12b', status: 'paused', phase: 'paused', done: true },
      ['sha256:bbb'],
    );
    await expect(store.readAll()).resolves.toEqual([
      expect.objectContaining({ name: 'gpt-oss:20b', digests: ['sha256:aaa'] }),
      expect.objectContaining({ name: 'gemma4:12b', digests: ['sha256:bbb'] }),
    ]);
    await store.remove('gpt-oss:20b');
    await expect(store.read()).resolves.toMatchObject({ name: 'gemma4:12b' });
  });

  it('keeps parallel writes instead of letting one overwrite the other', async () => {
    const dir = path.join(os.tmpdir(), `paused-pull-race-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const store = createPausedPullStore(path.join(dir, 'paused.json'));
    await Promise.all([
      store.write(
        { name: 'gpt-oss:20b', status: 'paused', phase: 'paused', done: true },
        ['sha256:aaa'],
      ),
      store.write(
        { name: 'gemma4:12b', status: 'paused', phase: 'paused', done: true },
        ['sha256:bbb'],
      ),
      store.write(
        { name: 'ornith15:35b', status: 'paused', phase: 'paused', done: true },
        ['sha256:ccc'],
      ),
    ]);
    const names = (await store.readAll()).map((item) => item.name).sort();
    expect(names).toEqual(['gemma4:12b', 'gpt-oss:20b', 'ornith15:35b']);
  });
});
