import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MainProcessWorkdirProbeClient,
  type MainProcessWorkdirProbeFs,
} from '../MainProcessWorkdirProbeClient.js';

const log = { info: vi.fn(), warn: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('MainProcessWorkdirProbeClient', () => {
  it('performs directory operations asynchronously in the main process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-main-probe-'));
    const client = new MainProcessWorkdirProbeClient({ log });
    try {
      await expect(client.probe(root, root, 1_000)).resolves.toMatchObject({
        ok: true,
        isDirectory: true,
      });
      await expect(
        client.probe(path.join(root, 'created'), `${root}/created`, 1_000, 'mkdir'),
      ).resolves.toEqual({ ok: true, isDirectory: true });
      await expect(
        client.probe(path.join(root, 'created'), `${root}/created`, 1_000, 'realpath'),
      ).resolves.toMatchObject({ ok: true, path: await fs.realpath(path.join(root, 'created')) });
      await expect(
        client.probe(path.join(root, 'created '), `${root}/created `, 1_000, 'similar'),
      ).resolves.toMatchObject({ ok: true, path: path.join(root, 'created') });
      await expect(
        client.probe(path.join(root, 'missing'), `${root}/missing`, 1_000),
      ).resolves.toEqual({ ok: false, code: 'ENOENT' });
      await expect(client.validate(root, root, 1_000)).resolves.toEqual({
        ok: true,
        realPath: await fs.realpath(root),
      });
      await expect(client.availability(root, root, 1_000)).resolves.toEqual({
        ok: true,
        usable: true,
      });
      expect(await fs.readdir(root)).toEqual(['created']);
    } finally {
      client.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed at the deadline while keeping in-flight I/O bounded', async () => {
    vi.useFakeTimers();
    let resolveSlow!: (value: { isDirectory(): boolean }) => void;
    let active = 0;
    let maxActive = 0;
    const slow = new Promise<{ isDirectory(): boolean }>((resolve) => {
      resolveSlow = resolve;
    });
    const fsMock: MainProcessWorkdirProbeFs = {
      stat: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await slow;
        } finally {
          active -= 1;
        }
      },
      mkdir: async () => undefined,
      realpath: async (dir) => dir,
      readdir: async () => [],
      writeFile: async () => undefined,
      rm: async () => undefined,
    };
    const client = new MainProcessWorkdirProbeClient({ log, fs: fsMock, maxInFlight: 1 });
    const first = client.probe('/slow/a', '/slow/a', 20).catch((error) => error);
    const second = client.probe('/slow/b', '/slow/b', 100).catch((error) => error);

    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    expect(maxActive).toBe(1);
    await vi.advanceTimersByTimeAsync(80);
    await expect(second).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });

    resolveSlow({ isDirectory: () => true });
    await vi.runAllTimersAsync();
    expect(maxActive).toBe(1);
    client.dispose();
  });

  it('keeps a timed-out path single-flighted until its filesystem operation settles', async () => {
    vi.useFakeTimers();
    let resolveSlow!: (value: { isDirectory(): boolean }) => void;
    let calls = 0;
    const slow = new Promise<{ isDirectory(): boolean }>((resolve) => {
      resolveSlow = resolve;
    });
    const fsMock: MainProcessWorkdirProbeFs = {
      stat: async () => {
        calls += 1;
        return slow;
      },
      mkdir: async () => undefined,
      realpath: async (dir) => dir,
      readdir: async () => [],
      writeFile: async () => undefined,
      rm: async () => undefined,
    };
    const client = new MainProcessWorkdirProbeClient({ log, fs: fsMock });
    const first = client.probe('/slow', '/slow', 20);
    const firstError = first.catch((error) => error);

    await vi.advanceTimersByTimeAsync(20);
    await expect(firstError).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    const retryWhileIoPending = client.probe('/slow', '/slow', 100);
    const retryWhileIoPendingError = retryWhileIoPending.catch((error) => error);
    expect(retryWhileIoPending).toBe(first);
    expect(calls).toBe(1);
    await expect(retryWhileIoPendingError).resolves.toMatchObject({
      code: 'WORKDIR_PROBE_TIMEOUT',
    });

    resolveSlow({ isDirectory: () => true });
    await vi.runAllTimersAsync();
    const retryAfterIoSettles = client.probe('/slow', '/slow', 100);
    expect(retryAfterIoSettles).not.toBe(first);
    expect(calls).toBe(2);
    await expect(retryAfterIoSettles).resolves.toMatchObject({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('rejects active probes immediately when disposed while letting I/O settle', async () => {
    let resolveSlow!: (value: { isDirectory(): boolean }) => void;
    const slow = new Promise<{ isDirectory(): boolean }>((resolve) => {
      resolveSlow = resolve;
    });
    const fsMock: MainProcessWorkdirProbeFs = {
      stat: async () => slow,
      mkdir: async () => undefined,
      realpath: async (dir) => dir,
      readdir: async () => [],
      writeFile: async () => undefined,
      rm: async () => undefined,
    };
    const client = new MainProcessWorkdirProbeClient({ log, fs: fsMock });
    const probe = client.probe('/slow', '/slow', 5_000).catch((error) => error);

    await Promise.resolve();
    client.dispose();
    await expect(probe).resolves.toMatchObject({ code: 'WORKDIR_PROBE_UNAVAILABLE' });
    await expect(client.probe('/slow', '/slow', 5_000)).rejects.toMatchObject({
      code: 'WORKDIR_PROBE_UNAVAILABLE',
    });

    resolveSlow({ isDirectory: () => true });
    await Promise.resolve();
  });
});
