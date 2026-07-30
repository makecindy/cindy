import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RsbWebviewArtifacts } from '../rsb-webview-artifacts.js';

function artifactHarness() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const session = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const wc = { session } as unknown as WebContents;
  const emitDownload = (item: ReturnType<typeof downloadItem>) => {
    for (const listener of listeners.get('will-download') ?? []) {
      listener({}, item, wc);
    }
  };
  return { wc, emitDownload };
}

function downloadItem(
  finalState: 'completed' | 'cancelled' | 'interrupted',
  options: { totalBytes?: number; receivedBytes?: number } = {},
) {
  let savePath = '';
  let doneListener: ((...args: unknown[]) => void) | undefined;
  let updateListener: ((...args: unknown[]) => void) | undefined;
  let receivedBytes = options.receivedBytes ?? options.totalBytes ?? 5;
  return {
    getFilename: () => '../unsafe?.txt',
    getURL: () => 'https://example.test/download',
    getMimeType: () => 'text/plain',
    getTotalBytes: () => options.totalBytes ?? 5,
    getReceivedBytes: () => receivedBytes,
    setSavePath: vi.fn((value: string) => {
      savePath = value;
      fs.writeFileSync(value, 'hello');
    }),
    cancel: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'updated') updateListener = listener;
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'done') doneListener = listener;
    }),
    finish: () => doneListener?.({}, finalState),
    update: (value: number) => {
      receivedBytes = value;
      updateListener?.();
    },
    savedPath: () => savePath,
  };
}

let root = '';

// Most cases exercise handling after a known download event, not the production
// grace window. Keep those cases deterministic; the delayed-start case opts
// into a short non-zero window to preserve that separate timing contract.
function createArtifacts(downloadGraceMs = 0): RsbWebviewArtifacts {
  return new RsbWebviewArtifacts(() => root, { warn: vi.fn() }, downloadGraceMs);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-browser-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('RsbWebviewArtifacts', () => {
  it('reclaims artifact roots left by a dead process before reuse', async () => {
    const staleRoot = path.join(root, 'process-99999999');
    await fs.promises.mkdir(staleRoot, { recursive: true });
    await fs.promises.writeFile(path.join(staleRoot, 'stale.txt'), 'stale');
    const harness = artifactHarness();
    const artifacts = createArtifacts();

    await artifacts.capture(
      harness.wc,
      { sessionId: 'startup-cleanup', timeoutMs: 1000 },
      async () => undefined,
    );

    expect(fs.existsSync(staleRoot)).toBe(false);
  });

  it('stores a completed download in an isolated directory with a safe name', async () => {
    const harness = artifactHarness();
    const item = downloadItem('completed');
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'session/one', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        setTimeout(() => item.finish(), 0);
        return 'clicked';
      },
    );

    expect(result.value).toBe('clicked');
    expect(result.downloads).toEqual([
      expect.objectContaining({
        fileName: 'unsafe.txt',
        state: 'completed',
        bytes: 5,
      }),
    ]);
    expect(result.downloads[0].path).toBe(item.savedPath());
    expect(fs.readFileSync(item.savedPath(), 'utf8')).toBe('hello');
  });

  it('removes partial files after a cancelled download', async () => {
    const harness = artifactHarness();
    const item = downloadItem('cancelled');
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'session-two', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        setTimeout(() => item.finish(), 0);
      },
    );

    expect(result.downloads[0]).toMatchObject({ state: 'cancelled' });
    expect(result.downloads[0].path).toBeUndefined();
    expect(fs.existsSync(item.savedPath())).toBe(false);
  });

  it('does not intercept downloads outside an active agent action', async () => {
    const harness = artifactHarness();
    const artifacts = createArtifacts();
    await artifacts.capture(harness.wc, { sessionId: 'session-three' }, async () => undefined);

    const item = downloadItem('completed');
    harness.emitDownload(item);

    expect(item.setSavePath).not.toHaveBeenCalled();
  });

  it('captures a download that starts after the action returns', async () => {
    const harness = artifactHarness();
    const item = downloadItem('completed');
    const artifacts = createArtifacts(100);

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'delayed-download', timeoutMs: 1_000 },
      async () => {
        setTimeout(() => {
          harness.emitDownload(item);
          setTimeout(() => item.finish(), 0);
        }, 10);
        return 'clicked';
      },
    );

    expect(result.downloads).toHaveLength(1);
    expect(result.downloads[0].state).toBe('completed');
  });

  it('limits artifact diagnostics to the requested session', async () => {
    const harness = artifactHarness();
    const artifacts = createArtifacts();

    for (const sessionId of ['session-a', 'session-b']) {
      const item = downloadItem('completed');
      await artifacts.capture(
        harness.wc,
        { sessionId, timeoutMs: 1_000 },
        async () => {
          harness.emitDownload(item);
          setTimeout(() => item.finish(), 0);
        },
      );
    }

    expect(artifacts.diagnostics('session-a').recentArtifacts).toHaveLength(1);
    expect(artifacts.diagnostics('session-b').recentArtifacts).toHaveLength(1);
    expect(artifacts.diagnostics('session-c').recentArtifacts).toHaveLength(0);
  });

  it('cancels a download that exceeds the per-file quota before saving', async () => {
    const harness = artifactHarness();
    const item = downloadItem('cancelled', { totalBytes: 32 * 1024 * 1024 + 1 });
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'quota-file', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        setTimeout(() => item.finish(), 0);
      },
    );

    expect(item.cancel).toHaveBeenCalledTimes(1);
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(result.downloads[0]).toMatchObject({ state: 'cancelled' });
  });

  it('cancels a download that crosses the quota while streaming', async () => {
    const harness = artifactHarness();
    const item = downloadItem('cancelled', { totalBytes: 0, receivedBytes: 0 });
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'quota-stream', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        item.update(32 * 1024 * 1024 + 1);
        setTimeout(() => item.finish(), 0);
      },
    );

    expect(item.setSavePath).toHaveBeenCalledTimes(1);
    expect(item.cancel).toHaveBeenCalledTimes(1);
    expect(result.downloads[0]).toMatchObject({ state: 'cancelled' });
    expect(fs.existsSync(item.savedPath())).toBe(false);
  });

  it('counts streaming bytes beyond a declared total toward the capture quota', async () => {
    const harness = artifactHarness();
    const items = Array.from({ length: 4 }, () => (
      downloadItem('completed', { totalBytes: 16 * 1024 * 1024 })
    ));
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'quota-known-total-overrun', timeoutMs: 1000 },
      async () => {
        for (const item of items) harness.emitDownload(item);
        items[3].update(17 * 1024 * 1024);
        setTimeout(() => {
          for (const item of items) item.finish();
        }, 0);
      },
    );

    expect(items[3].cancel).toHaveBeenCalledTimes(1);
    expect(result.downloads.map((artifact) => artifact.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'cancelled',
    ]);
  });

  it('bounds both download count and total bytes for one action', async () => {
    const harness = artifactHarness();
    const items = Array.from({ length: 9 }, () => (
      downloadItem('completed', { totalBytes: 20 * 1024 * 1024 })
    ));
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'quota-capture', timeoutMs: 1000 },
      async () => {
        for (const item of items) harness.emitDownload(item);
        setTimeout(() => {
          for (const item of items) item.finish();
        }, 0);
      },
    );

    expect(result.downloads).toHaveLength(8);
    expect(items.slice(0, 3).every((item) => item.setSavePath.mock.calls.length === 1)).toBe(true);
    expect(items[3].cancel).toHaveBeenCalledTimes(1);
    expect(items[8].cancel).toHaveBeenCalledTimes(1);
    expect(result.downloads.slice(3).every((artifact) => artifact.state === 'cancelled')).toBe(true);
  });

  it('releases reserved bytes after a download is cancelled', async () => {
    const harness = artifactHarness();
    const cancelled = downloadItem('cancelled', { totalBytes: 32 * 1024 * 1024 });
    const later = [
      downloadItem('completed', { totalBytes: 32 * 1024 * 1024 }),
      downloadItem('completed', { totalBytes: 32 * 1024 * 1024 }),
    ];
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'quota-release', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(cancelled);
        cancelled.finish();
        for (const item of later) harness.emitDownload(item);
        setTimeout(() => {
          for (const item of later) item.finish();
        }, 0);
      },
    );

    expect(later.every((item) => item.setSavePath.mock.calls.length === 1)).toBe(true);
    expect(result.downloads.map((artifact) => artifact.state)).toEqual([
      'cancelled',
      'completed',
      'completed',
    ]);
  });

  it('removes retained artifacts when the backend is disposed', async () => {
    const harness = artifactHarness();
    const item = downloadItem('completed');
    const artifacts = createArtifacts();

    const result = await artifacts.capture(
      harness.wc,
      { sessionId: 'dispose-cleanup', timeoutMs: 1000 },
      async () => {
        harness.emitDownload(item);
        setTimeout(() => item.finish(), 0);
      },
    );
    const artifactPath = result.downloads[0].path;

    expect(artifactPath).toBeDefined();
    await artifacts.dispose();
    expect(fs.existsSync(artifactPath!)).toBe(false);
  });

  it('evicts the oldest files when retained bytes exceed the global budget', async () => {
    const harness = artifactHarness();
    const artifacts = createArtifacts();
    const savedPaths: string[] = [];

    for (let captureIndex = 0; captureIndex < 5; captureIndex += 1) {
      const items = [
        downloadItem('completed', { totalBytes: 32 * 1024 * 1024 }),
        downloadItem('completed', { totalBytes: 32 * 1024 * 1024 }),
      ];
      await artifacts.capture(
        harness.wc,
        { sessionId: 'quota-retained', timeoutMs: 1000 },
        async () => {
          for (const item of items) harness.emitDownload(item);
          setTimeout(() => {
            for (const item of items) item.finish();
          }, 0);
        },
      );
      savedPaths.push(...items.map((item) => item.savedPath()));
    }

    expect(fs.existsSync(savedPaths[0])).toBe(false);
    expect(fs.existsSync(savedPaths[1])).toBe(false);
    expect(fs.existsSync(savedPaths.at(-1)!)).toBe(true);
  });
});
