import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AppshotCoordinator,
  type AppshotCoordinatorDeps,
  type MacAppshotNativeResult,
} from '../coordinator.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const tempRoots = new Set<string>();

function nativeResult(pngPath: string): MacAppshotNativeResult {
  return {
    pngPath,
    applicationName: 'Example App',
    bundleIdentifier: 'com.example.app',
    windowTitle: 'Example window',
    accessibilityText: 'button: Save',
    accessibilityTruncated: false,
  };
}

async function createTempRoot(prefix = 'cindy-appshot-test-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function writePng(root: string, name = 'capture.png'): Promise<string> {
  const output = path.join(root, name);
  await fs.writeFile(output, PNG);
  return output;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(
  captureNative: (outputDir: string) => Promise<MacAppshotNativeResult>,
  options: { platform?: NodeJS.Platform } = {},
) {
  const published: unknown[] = [];
  const ingested: Uint8Array[] = [];
  const removed: string[] = [];
  let sequence = 0;
  const deps: AppshotCoordinatorDeps = {
    captureNative,
    ingestPng: async (bytes) => {
      ingested.push(bytes);
      return { url: `cindy-media://blobs/${ingested.length}.png`, filename: `${ingested.length}.png` };
    },
    makeTempDir: () => createTempRoot(),
    removeTempDir: async (root) => {
      removed.push(root);
      await fs.rm(root, { recursive: true, force: true });
      tempRoots.delete(root);
    },
    now: () => new Date('2026-08-06T01:02:03.000Z'),
    randomUUID: () => `capture-${++sequence}`,
    publish: (result) => published.push(result),
  };
  return {
    coordinator: new AppshotCoordinator(deps, options.platform),
    ingested,
    published,
    removed,
  };
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.clear();
  vi.restoreAllMocks();
});

describe('AppshotCoordinator boundary', () => {
  it('rejects unsupported platforms before allocating output or invoking native capture', async () => {
    const captureNative = vi.fn();
    const { coordinator } = createHarness(captureNative, { platform: 'win32' });

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'unsupported-platform' });
    expect(captureNative).not.toHaveBeenCalled();
  });

  it('rejects an overlapping capture and invokes the native host only once', async () => {
    const pending = deferred<MacAppshotNativeResult>();
    const captureNative = vi.fn((outputDir: string) => {
      void outputDir;
      return pending.promise;
    });
    const { coordinator, removed } = createHarness(captureNative);

    const first = coordinator.capture();
    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'capture-in-progress' });
    await vi.waitFor(() => expect(captureNative).toHaveBeenCalledTimes(1));
    expect(captureNative).toHaveBeenCalledTimes(1);
    const output = await writePng(captureNative.mock.calls[0][0]);
    pending.resolve(nativeResult(output));
    await expect(first).resolves.toMatchObject({ captureId: 'capture-1' });
    expect(removed).toHaveLength(1);
  });

  it('rejects malformed native metadata and cleans its managed temp root', async () => {
    const { coordinator, removed } = createHarness(async (root) => ({
      ...nativeResult(await writePng(root)),
      applicationName: '',
    }));

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(removed).toHaveLength(1);
  });

  it('rejects native output paths outside the managed temp root', async () => {
    const outside = await createTempRoot('cindy-appshot-outside-');
    const outsidePng = await writePng(outside);
    const { coordinator, removed } = createHarness(async () => nativeResult(outsidePng));

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(removed).toHaveLength(1);
  });

  it('rejects a symlink whose real path escapes the managed temp root', async () => {
    const outside = await createTempRoot('cindy-appshot-outside-');
    const outsidePng = await writePng(outside);
    const { coordinator, removed } = createHarness(async (root) => {
      const link = path.join(root, 'capture.png');
      await fs.symlink(outsidePng, link);
      return nativeResult(link);
    });

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(removed).toHaveLength(1);
  });

  it('rejects native output that is not a regular file', async () => {
    const { coordinator, removed } = createHarness(async (root) => {
      const output = path.join(root, 'capture.png');
      await fs.mkdir(output);
      return nativeResult(output);
    });

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(removed).toHaveLength(1);
  });

  it('ingests bytes from the validated descriptor when the pathname is swapped', async () => {
    const replacement = Uint8Array.from([...PNG.slice(0, 8), 0x99]);
    const ingestPng = vi.fn(async () => ({
      url: 'cindy-media://blobs/race.png',
      filename: 'race.png',
    }));
    const realStat = fs.stat;
    let swapped = false;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const stats = await realStat(...args);
      const filePath = String(args[0]);
      if (!swapped && filePath.endsWith('capture.png')) {
        swapped = true;
        const replacementPath = `${filePath}.replacement`;
        await fs.writeFile(replacementPath, replacement);
        await fs.rename(replacementPath, filePath);
      }
      return stats;
    });
    const root = await createTempRoot();
    const output = await writePng(root);
    const coordinator = new AppshotCoordinator({
      captureNative: async () => nativeResult(output),
      ingestPng,
      makeTempDir: async () => root,
      removeTempDir: async (managedRoot) => {
        await fs.rm(managedRoot, { recursive: true, force: true });
        tempRoots.delete(managedRoot);
      },
      now: () => new Date(),
      randomUUID: () => 'race-capture',
      publish: () => undefined,
    });

    await expect(coordinator.capture()).resolves.toMatchObject({ captureId: 'race-capture' });
    expect(swapped).toBe(true);
    expect(ingestPng).toHaveBeenCalledTimes(1);
    expect([...ingestPng.mock.calls[0][0]]).toEqual([...PNG]);
    expect([...ingestPng.mock.calls[0][0]]).not.toEqual([...replacement]);
  });

  it.each([
    ['wrong PNG signature', async (root: string) => {
      const output = path.join(root, 'capture.png');
      await fs.writeFile(output, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]));
      return output;
    }],
    ['zero-byte file', async (root: string) => {
      const output = path.join(root, 'capture.png');
      await fs.writeFile(output, new Uint8Array());
      return output;
    }],
    ['sparse file larger than 100 MiB', async (root: string) => {
      const output = path.join(root, 'capture.png');
      const handle = await fs.open(output, 'w');
      await handle.truncate(100 * 1024 * 1024 + 1);
      await handle.close();
      return output;
    }],
  ])('rejects a %s and cleans up', async (_label, prepare) => {
    const { coordinator, removed } = createHarness(async (root) => nativeResult(await prepare(root)));

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(removed).toHaveLength(1);
  });

  it('maps native screen-recording permission failure without exposing native detail', async () => {
    const captureNative = vi.fn(async () => {
      const error = Object.assign(new Error('internal secret'), { code: 'screen-permission' });
      throw error;
    });
    const { coordinator, removed } = createHarness(captureNative);

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'screen-permission' });
    expect(removed).toHaveLength(1);
  });

  it('preserves a primary screen-permission failure when temp cleanup also fails', async () => {
    const coordinator = new AppshotCoordinator({
      captureNative: async () => {
        throw Object.assign(new Error('permission detail'), { code: 'screen-permission' });
      },
      ingestPng: vi.fn(),
      makeTempDir: () => createTempRoot(),
      removeTempDir: async () => { throw new Error('cleanup failed'); },
      now: () => new Date(),
      randomUUID: () => 'unused',
      publish: vi.fn(),
    });

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'screen-permission' });
  });

  it('does not commit or publish when successful ingest is followed by cleanup failure', async () => {
    const publish = vi.fn();
    const coordinator = new AppshotCoordinator({
      captureNative: async (root) => nativeResult(await writePng(root)),
      ingestPng: async () => ({ url: 'cindy-media://blobs/cleanup.png', filename: 'cleanup.png' }),
      makeTempDir: () => createTempRoot(),
      removeTempDir: async () => { throw new Error('cleanup failed'); },
      now: () => new Date(),
      randomUUID: () => 'cleanup-capture',
      publish,
    });

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(coordinator.listPending()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps a successful capture pending when best-effort publish throws', async () => {
    const publish = vi.fn(() => { throw new Error('renderer disappeared'); });
    const { coordinator } = createHarness(async (root) => nativeResult(await writePng(root)));
    const deps = (coordinator as unknown as { deps: AppshotCoordinatorDeps }).deps;
    const bestEffortCoordinator = new AppshotCoordinator({ ...deps, publish });

    await expect(bestEffortCoordinator.capture()).resolves.toMatchObject({ captureId: 'capture-1' });
    expect(bestEffortCoordinator.listPending()).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('succeeds when only accessibility data is unavailable', async () => {
    const { coordinator, ingested, removed } = createHarness(async (root) => ({
      ...nativeResult(await writePng(root)),
      accessibilityText: null,
      accessibilityUnavailableReason: 'permission',
    }));

    await expect(coordinator.capture()).resolves.toMatchObject({
      image: { size: PNG.byteLength, mimeType: 'image/png' },
      metadata: { accessibilityText: null, accessibilityUnavailableReason: 'permission' },
    });
    expect([...ingested[0]]).toEqual([...PNG]);
    expect(removed).toHaveLength(1);
  });

  it('cleans the managed temp root when media ingestion fails', async () => {
    const removed: string[] = [];
    const ingestFailure = Object.assign(new Error('storage unavailable'), { code: 'ingest-failure' });
    const failingCoordinator = new AppshotCoordinator({
      captureNative: async (root) => nativeResult(await writePng(root)),
      ingestPng: async () => { throw ingestFailure; },
      makeTempDir: () => createTempRoot(),
      removeTempDir: async (root) => {
        removed.push(root);
        await fs.rm(root, { recursive: true, force: true });
        tempRoots.delete(root);
      },
      now: () => new Date(),
      randomUUID: () => 'unused',
      publish: () => undefined,
    });

    await expect(failingCoordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(removed).toHaveLength(1);
  });

  it('ingests valid bytes, publishes managed data, stores pending results, and acks exactly one', async () => {
    const { coordinator, published, removed } = createHarness(async (root) => nativeResult(await writePng(root)));

    const result = await coordinator.capture();
    expect(result).toEqual({
      captureId: 'capture-1',
      image: {
        url: 'cindy-media://blobs/1.png',
        filename: '1.png',
        size: PNG.byteLength,
        mimeType: 'image/png',
      },
      metadata: {
        schemaVersion: 1,
        captureId: 'capture-1',
        capturedAt: '2026-08-06T01:02:03.000Z',
        applicationName: 'Example App',
        bundleIdentifier: 'com.example.app',
        windowTitle: 'Example window',
        accessibilityText: 'button: Save',
        accessibilityTruncated: false,
      },
    });
    expect(published).toEqual([result]);
    expect(removed).toHaveLength(1);
    expect(coordinator.listPending()).toEqual([result]);
    expect(coordinator.ack('capture-1')).toBe(true);
    expect(coordinator.ack('capture-1')).toBe(false);
    expect(coordinator.listPending()).toEqual([]);
  });

  it('keeps only the newest ten pending captures and returns defensive copies', async () => {
    const { coordinator } = createHarness(async (root) => nativeResult(await writePng(root)));

    for (let index = 0; index < 11; index += 1) await coordinator.capture();

    const pending = coordinator.listPending();
    expect(pending.map((capture) => capture.captureId)).toEqual([
      'capture-2', 'capture-3', 'capture-4', 'capture-5', 'capture-6',
      'capture-7', 'capture-8', 'capture-9', 'capture-10', 'capture-11',
    ]);
    pending[0].metadata.applicationName = 'mutated';
    expect(coordinator.listPending()[0].metadata.applicationName).toBe('Example App');
    coordinator.clear();
    expect(coordinator.listPending()).toEqual([]);
  });

  it('does not log captured metadata or bytes on failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const capturedPayload = 'captured content must not reach logs';
    const { coordinator } = createHarness(async () => {
      throw new Error(`APPSHOT_NATIVE_FAILURE ${capturedPayload}`);
    });

    await expect(coordinator.capture()).rejects.toMatchObject({ code: 'native-failure' });
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
