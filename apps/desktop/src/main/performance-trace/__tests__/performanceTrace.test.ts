import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { PerformanceTraceController, type TraceControllerDeps } from '../controller';
import { projectCpuProfile, projectTraceEvent, type TraceReport } from '../report';
import { measureTraceOperation, setTraceOperationObserver } from '../measure';
import { createTraceCommandHandler, createTraceStatePublisher } from '../ipc';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { PERFORMANCE_TRACE_STATE_CHANNEL } from '../../../shared/performanceTrace';
import { submitPerformanceReport } from '../upload';
import type { LogUploadMeta } from '../../log-upload/types';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, mkdir, utimes, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTraceArtifacts, redactTraceArtifact, TRACE_ARTIFACT_NAMES, type TraceArtifact } from '../artifacts';
import { restorePerformanceFiles } from '../restore';
import { cleanupTraceReports, startTraceRetention, TRACE_RETENTION_MS } from '../retention';

const redactionWorker = vi.hoisted(() => ({
  script: '', exitScript: '', hangScript: '', mode: 'normal', active: 0,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const script = redactionWorker.mode === 'exit' ? redactionWorker.exitScript
        : redactionWorker.mode === 'hang' ? redactionWorker.hangScript
        : redactionWorker.mode === 'missing' ? `${redactionWorker.script}.missing` : redactionWorker.script;
      super(String(filename).endsWith('traceRedactionWorker.js') ? script : filename, options);
      redactionWorker.active++;
      this.once('exit', () => { redactionWorker.active--; });
    }
  } };
});
let workerDirectory: string;
beforeAll(async () => {
  workerDirectory = await mkdtemp(path.join(os.tmpdir(), 'cindy-trace-worker-'));
  redactionWorker.script = path.join(workerDirectory, 'traceRedactionWorker.cjs');
  redactionWorker.exitScript = path.join(workerDirectory, 'exit.cjs');
  redactionWorker.hangScript = path.join(workerDirectory, 'hang.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../traceRedactionWorker.ts', import.meta.url))],
    outfile: redactionWorker.script, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  await writeFile(redactionWorker.exitScript, 'process.exit(0);');
  await writeFile(redactionWorker.hangScript, "require('node:worker_threads').parentPort.on('message', () => {});");
});
afterAll(async () => { await rm(workerDirectory, { recursive: true, force: true }); });

/** Test value: production recording lifecycle and upload projection. User-requested diagnostics
 * must preserve local evidence on failure and isolate owners. Full-file uploads retain all
 * samples while redacting recognizable secrets; restoration verifies checksums and completeness.
 * Existing log-upload tests cover logs only, not recordings/profiles. Minimal failures: concurrent
 * start/stop, a rejected upload, owner change, or one profiler frame/event with a secret field.
 * Minimal new failure: a missing chunk/marker, failed final request, or secret in a raw profile.
 * Renderer recovery gap: a completed report retains a destroyed sender; the replacement main
 * window must be able to reveal/upload it without allowing active or cross-owner takeover.
 * Review gaps: owner changes during summary save, replacement window during auto-stop,
 * and a trusted secondary renderer invoking start directly (unit, deferred I/O/windows).
 * Worker regression: upload used main-thread JSON.parse/stringify. Real bundled worker
 * tests forbid caller-thread JSON work and require unchanged input, complete samples,
 * redacted secrets and no requests after malformed input/worker exit/startup failure.
 * Bundle once per file; byte transfers and worker cleanup use the production upload entry.
 * Tier: unit, injected clocks/network/profilers; bounded files in an isolated OS temp directory.
 * Standalone Vitest run: 1.02s on Windows (2026-10-30); test execution 564ms.
 */
function fixture() {
  let now = 1000,
    owner = 'alice:1';
  const reports: TraceReport[] = [];
  const stop = vi.fn(async () => ({ profiles: [], partial: false }));
  const deps: TraceControllerDeps = {
    now: () => now,
    owner: () => owner,
    reportId: () => 'ABCD-EFGH',
    environment: () => ({ appVersion: 'test', platform: 'win32', arch: 'x64' }),
    begin: vi.fn(async () => ({ stop })),
    save: vi.fn(async (report) => {
      reports.push(structuredClone(report));
    }),
    upload: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  return {
    controller: new PerformanceTraceController(deps),
    deps,
    stop,
    reports,
    advance: (value: number) => {
      now += value;
    },
    owner: (value: string) => {
      owner = value;
    },
  };
}
afterEach(() => {
  redactionWorker.mode = 'normal';
  expect(redactionWorker.active).toBe(0);
  setTraceOperationObserver(null);
  vi.useRealTimers();
});

describe('performance recording', () => {
  it('terminates a stalled preparation worker at the deadline', async () => {
    redactionWorker.mode = 'hang';
    vi.useFakeTimers();
    try {
      const result = expect(redactTraceArtifact(Buffer.from('{}'))).rejects.toThrow('LOG_UPLOAD_FAILED');
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
  it('redacts in the worker without parsing or serializing JSON on the caller thread', async () => {
    const original = Buffer.from(JSON.stringify({ samples: [1, 2, 3], token: 'test-only-secret' }));
    const before = Buffer.from(original);
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('main-thread parse'); });
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('main-thread stringify'); });
    let cleaned: Buffer;
    try {
      cleaned = await redactTraceArtifact(original);
    } finally {
      parse.mockRestore();
      stringify.mockRestore();
    }
    expect(original.equals(before)).toBe(true);
    expect(JSON.parse(cleaned.toString())).toEqual({ samples: [1, 2, 3], token: '<redacted:sensitive-field>' });
  });

  it.each(['malformed', 'exit', 'missing'])('fails closed before upload for %s artifact preparation', async (kind) => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = { ...f.reports[0], partial: true };
    const bytes = Buffer.from(kind === 'malformed' ? '{"token":"test-only-secret"' : JSON.stringify(report));
    const before = Buffer.from(bytes);
    const deps = uploadDeps([{ name: 'report.json', bytes }], []);
    redactionWorker.mode = kind;
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow('LOG_UPLOAD_FAILED');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(bytes.equals(before)).toBe(true);
  });
  it.each([false, true])(
    'discards a report when ownership changes during saving (save fails: %s)',
    async (fails) => {
      const f = fixture();
      let finish!: () => void;
      let entered!: () => void;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.mocked(f.deps.save).mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () => (fails ? reject(new Error('save failed')) : resolve());
            entered();
          }),
      );
      await f.controller.start();
      const stopping = f.controller.stop();
      await saving;
      f.owner('bob:2');
      finish();
      expect((await stopping).phase).toBe('idle');
      // A discarded result must not merely be hidden by snapshot's owner filter.
      f.owner('alice:1');
      expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
      await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
      await expect(f.controller.upload('')).rejects.toThrow('PRECONDITION_FAILED');
      expect(f.deps.reveal).not.toHaveBeenCalled();
      expect(f.deps.upload).not.toHaveBeenCalled();
    },
  );

  it('publishes automatic stop completion to the replacement main window without moving the capture', async () => {
    const f = fixture();
    const originalSend = vi.fn(),
      replacementSend = vi.fn();
    let destroyed = false,
      trusted = true;
    const original = {
      isDestroyed: () => destroyed,
      webContents: { isDestroyed: () => destroyed, send: originalSend },
    } as unknown as BrowserWindow;
    const replacement = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: replacementSend },
    } as unknown as BrowserWindow;
    let current: BrowserWindow | null = original;
    const publish = createTraceStatePublisher({
      getMainWindow: () => current,
      isTrustedWindow: () => trusted,
    });
    f.deps.changed = publish;
    let finish!: () => void;
    f.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ profiles: [], partial: true });
        }),
    );
    await f.controller.start();
    destroyed = true;
    current = replacement;
    // Native capture calls close on source destruction. The new renderer can
    // mount while it is saving; it needs a later push without another IPC command.
    const closing = f.controller.close();
    expect(f.controller.snapshot().phase).toBe('saving');
    expect(replacementSend).toHaveBeenLastCalledWith(
      PERFORMANCE_TRACE_STATE_CHANNEL,
      expect.objectContaining({ phase: 'saving' }),
    );
    finish();
    await closing;
    expect(replacementSend).toHaveBeenLastCalledWith(
      PERFORMANCE_TRACE_STATE_CHANNEL,
      expect.objectContaining({ phase: 'ready', reportId: 'ABCD-EFGH', partial: true }),
    );
    expect(originalSend).toHaveBeenCalledTimes(2); // starting, recording only
    expect(f.deps.begin).toHaveBeenCalledOnce();
    expect(f.deps.upload).not.toHaveBeenCalled();
    replacementSend.mockClear();
    trusted = false;
    publish(f.controller.snapshot());
    current = original; // destroyed windows are never recipients
    trusted = true;
    publish(f.controller.snapshot());
    current = null;
    publish(f.controller.snapshot());
    expect(replacementSend).not.toHaveBeenCalled();
    expect(originalSend).toHaveBeenCalledTimes(2);
  });
  // Session invalidation fires before the new generation is committed. The callback passed
  // to native startup must already reject this old operation at that boundary.
  it('invalidates pending startup and discards the capture without saving across accounts', async () => {
    const f = fixture();
    let finish!: () => void;
    let isCurrent!: () => boolean;
    vi.mocked(f.deps.begin).mockImplementationOnce((_id, _at, current) => {
      isCurrent = current;
      return new Promise((resolve) => {
        finish = () => resolve({ stop: f.stop });
      });
    });
    const starting = f.controller.start();
    const rejected = expect(starting).rejects.toThrow('PRECONDITION_FAILED');
    expect(isCurrent()).toBe(true);
    const closing = f.controller.invalidate();
    expect(isCurrent()).toBe(false);
    f.owner('bob:2');
    finish();
    await Promise.all([rejected, closing]);
    expect(f.stop).toHaveBeenCalledWith({ discard: true });
    expect(f.reports).toEqual([]);
    expect(f.controller.snapshot().phase).toBe('idle');
  });
  // Review: a close during pending begin used to return before capture.stop/save.
  // Unit: deferred native start (success and failure), no real waits or profiler.
  it.each([false, true])(
    'waits for pending startup before closing (start fails: %s)',
    async (fails) => {
      const f = fixture();
      let finish!: () => void;
      vi.mocked(f.deps.begin).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () => (fails ? reject(new Error('start failed')) : resolve({ stop: f.stop }));
          }),
      );
      const starting = f.controller.start().catch(() => undefined);
      let closed = false;
      const closing = f.controller.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await Promise.all([starting, closing]);
      expect(closed).toBe(true);
      expect(f.stop).toHaveBeenCalledTimes(fails ? 0 : 1);
      expect(f.reports).toHaveLength(fails ? 0 : 1);
      expect(f.controller.snapshot().phase).toBe(fails ? 'idle' : 'ready');
    },
  );
  // Retention must not let reveal recreate an expired report or remove an in-flight upload.
  it('releases completed reports for retention while protecting captures and uploads', async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(false);
    await f.controller.stop();
    let finish!: () => void;
    vi.mocked(f.deps.save).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const revealing = f.controller.reveal();
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(false);
    expect(f.controller.canStart()).toBe(false);
    await expect(f.controller.upload('')).rejects.toThrow('PRECONDITION_FAILED');
    finish();
    await revealing;
    vi.mocked(f.deps.upload).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const uploading = f.controller.upload('');
    await vi.waitFor(() => expect(f.deps.upload).toHaveBeenCalledOnce());
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(false);
    finish();
    await uploading;
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(true);
    expect(f.controller.snapshot().phase).toBe('idle');
    await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
    await expect(f.controller.upload('')).rejects.toThrow('PRECONDITION_FAILED');
  });
  it('records only during a capture, preserves timeline data, and saves once on concurrent stops', async () => {
    const f = fixture();
    const event = {
      at: 1000,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      text: 'private text',
    };
    f.controller.events([event]);
    await f.controller.start();
    f.controller.events([event]);
    f.advance(100);
    await Promise.all([f.controller.stop(), f.controller.stop()]);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({
      durationMs: 100,
      scope: 'local-desktop',
      remoteHostCaptured: false,
      events: [{ at: 1000, kind: 'input', label: 'keydown', durationMs: 80 }],
    });
    expect(JSON.stringify(f.reports)).not.toContain('private text');
  });
  it('rejects overlapping starts and stops automatically without uploading', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.deps.begin).mockImplementationOnce(async () => {
      f.advance(10_000);
      return { stop: f.stop };
    });
    await f.controller.start();
    await expect(f.controller.start()).rejects.toThrow('PRECONDITION_FAILED');
    f.advance(50_000);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.controller.snapshot()).toMatchObject({ phase: 'ready', durationMs: 60_000 });
    expect(f.deps.upload).not.toHaveBeenCalled();
  });
  it('waits for an already-saving capture when the application closes', async () => {
    const f = fixture();
    let finish!: () => void;
    f.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ profiles: [], partial: false });
        }),
    );
    await f.controller.start();
    const stopping = f.controller.stop();
    let closed = false;
    const closing = f.controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await Promise.all([stopping, closing]);
    expect(f.reports).toHaveLength(1);
    expect(closed).toBe(true);
  });
  it('keeps the same report id and local evidence after failed upload, then retries once', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    vi.mocked(f.deps.upload).mockRejectedValueOnce(new Error('offline'));
    await expect(f.controller.upload('slow typing')).rejects.toThrow('offline');
    expect(f.controller.snapshot()).toMatchObject({
      phase: 'ready',
      reportId: 'ABCD-EFGH',
      uploaded: false,
    });
    await f.controller.reveal();
    await f.controller.upload('slow typing');
    await f.controller.upload('slow typing');
    expect(f.deps.reveal).toHaveBeenCalledWith('ABCD-EFGH');
    expect(f.deps.upload).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().uploaded).toBe(true);
  });
  it('hides old-owner results and rejects upload and reveal after switching accounts', async () => {
    const f = fixture();
    await f.controller.start();
    f.owner('bob:2');
    await f.controller.close();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
    await expect(f.controller.upload('')).rejects.toThrow('PRECONDITION_FAILED');
    await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
    expect(f.deps.upload).not.toHaveBeenCalled();
  });
  // Review regression: reveal must not open the old owner's files after an awaited save.
  // The preceding owner test only switches before invocation; this unit suspends the save.
  it('rejects revealing old-owner files when the account changes during saving', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    let finishSave!: () => void;
    vi.mocked(f.deps.save).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const revealing = f.controller.reveal();
    const rejected = expect(revealing).rejects.toThrow('PRECONDITION_FAILED');
    f.owner('bob:2');
    finishSave();
    await rejected;
    expect(f.deps.reveal).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
  });
  it('recovers a failed start and retains partial results if a profiler fails at stop', async () => {
    const f = fixture();
    vi.mocked(f.deps.begin).mockRejectedValueOnce(new Error('busy'));
    await expect(f.controller.start()).rejects.toThrow('busy');
    expect(f.controller.snapshot().phase).toBe('idle');
    await f.controller.start();
    f.stop.mockRejectedValueOnce(new Error('renderer gone'));
    await f.controller.stop();
    expect(f.reports[0].partial).toBe(true);
    expect(f.controller.snapshot().phase).toBe('ready');
  });
  it('retries saving the in-memory report after disk write failure', async () => {
    const f = fixture();
    await f.controller.start();
    vi.mocked(f.deps.save).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.controller.stop()).rejects.toThrow('disk full');
    expect(f.controller.snapshot()).toMatchObject({ phase: 'ready', partial: true });
    await f.controller.reveal();
    expect(f.reports).toHaveLength(1);
  });
});

describe('performance report retention', () => {
  // Review: expired raw profiles survived indefinitely without another recording.
  // Real cleanup entry, bounded OS temp fixtures; the former tests covered no retention.
  it('removes only expired generated directories and preserves active/new/exported files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-trace-retention-'));
    const now = Date.now();
    const old = new Date(now - TRACE_RETENTION_MS - 1);
    try {
      for (const name of ['2345-6789', 'BCDE-FGHJ', 'K M N', 'PQRS-TVWX']) {
        const dir = path.join(root, name);
        await mkdir(dir);
        await writeFile(path.join(dir, 'chromium-trace.json'), '{}');
        if (name !== 'PQRS-TVWX') await utimes(dir, old, old);
      }
      await writeFile(path.join(root, 'YZ23-4567'), 'not a directory');
      await cleanupTraceReports(root, (id) => id !== 'BCDE-FGHJ', now);
      expect((await readdir(root)).sort()).toEqual([
        'BCDE-FGHJ',
        'K M N',
        'PQRS-TVWX',
        'YZ23-4567',
      ]);
      await cleanupTraceReports(root, () => true, now);
      expect(await readdir(root)).not.toContain('BCDE-FGHJ');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('sweeps at startup and hourly without recordings, avoids overlaps, and stops on disposal', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sweep = vi.fn(async () => {});
    sweep.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = startTraceRetention(sweep);
    expect(sweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sweep).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    dispose();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

describe('report boundary', () => {
  it('rejects start from a trusted secondary window without replacing the current report', async () => {
    const f = fixture();
    const main = {} as IpcMainInvokeEvent,
      secondary = {} as IpcMainInvokeEvent;
    let source: IpcMainInvokeEvent | null = null;
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize: () => {},
      isSource: (event) => event === source,
      isSourceDestroyed: () => false,
      isMainWindow: (event) => event === main,
      selectSource: (event) => {
        source = event;
      },
      showFolder: vi.fn(async () => {}),
    });
    await expect(handler(secondary, 'start', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBeNull();
    expect(f.deps.begin).not.toHaveBeenCalled();
    await handler(main, 'start', undefined);
    await handler(main, 'stop', undefined);
    const report = f.controller.snapshot();
    await expect(handler(secondary, 'start', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBe(main);
    expect(f.controller.snapshot()).toEqual(report);
    expect(f.deps.begin).toHaveBeenCalledOnce();
    await handler(main, 'upload', '');
    expect(f.deps.upload).toHaveBeenCalledOnce();
  });
  it('checks sender authorization and recording window before starting or reading files', async () => {
    const f = fixture();
    let source = false;
    const authorize = vi.fn<() => void>(() => {
      throw new Error('untrusted sender');
    });
    const showFolder = vi.fn(async () => {});
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize,
      isSource: () => source,
      isSourceDestroyed: () => false,
      isMainWindow: () => true,
      selectSource: () => {
        source = true;
      },
      showFolder,
    });
    const event = {} as IpcMainInvokeEvent;
    await expect(handler(event, 'start', undefined)).rejects.toThrow('untrusted sender');
    expect(f.deps.begin).not.toHaveBeenCalled();
    authorize.mockImplementation(() => {});
    await expect(handler(event, { toString: () => 'start' }, undefined)).rejects.toThrow(
      'INVALID_PARAMS',
    );
    await expect(handler(event, 'start', 'x'.repeat(1001))).rejects.toThrow('INVALID_PARAMS');
    await handler(event, 'show-local', undefined);
    expect(showFolder).toHaveBeenCalledOnce();
    await handler(event, 'start', undefined);
    source = false;
    await expect(handler(event, 'stop', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    source = true;
    await handler(event, 'stop', undefined);
    vi.mocked(f.deps.reveal).mockRejectedValueOnce(new Error('/Users/private/report.json'));
    await expect(handler(event, 'show-local', undefined)).rejects.toThrow(
      '[INTERNAL] Performance recording operation failed',
    );
  });
  it.each(['state', 'show-local', 'upload'])(
    'restores a completed report through %s after its source window is destroyed',
    async (command) => {
      const f = fixture();
      const original = {} as IpcMainInvokeEvent;
      const replacement = {} as IpcMainInvokeEvent;
      let source = original;
      let main = original;
      let destroyed = false;
      const handler = createTraceCommandHandler({
        controller: f.controller,
        authorize: () => {},
        isSource: (event) => event === source,
        isSourceDestroyed: () => destroyed,
        isMainWindow: (event) => event === main,
        selectSource: (event) => {
          source = event;
          destroyed = false;
        },
        showFolder: vi.fn(async () => {}),
      });
      await handler(original, 'start', undefined);
      await handler(original, 'stop', undefined);
      // Reloading the same WebContents already works without transferring ownership.
      await handler(original, 'show-local', undefined);
      destroyed = true;
      main = replacement;
      const state = await handler(replacement, command, undefined);
      expect(state.phase).toBe('ready');
      expect(state.reportId).toBe('ABCD-EFGH');
      expect(source).toBe(replacement);
      await handler(replacement, 'show-local', undefined);
      await handler(replacement, 'upload', 'recovered report');
      expect(f.deps.reveal).toHaveBeenLastCalledWith('ABCD-EFGH');
      expect(f.deps.upload).toHaveBeenCalledWith(
        expect.objectContaining({ reportId: 'ABCD-EFGH' }),
        expect.any(String),
      );
      expect(f.deps.begin).toHaveBeenCalledOnce();
    },
  );

  it('does not transfer reports to another window during capture or across owner boundaries', async () => {
    const f = fixture();
    const original = {} as IpcMainInvokeEvent;
    const replacement = {} as IpcMainInvokeEvent;
    let source = original;
    let destroyed = true;
    let main = true;
    let trusted = true;
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize: () => {
        if (!trusted) throw new Error('untrusted sender');
      },
      isSource: (event) => event === source,
      isSourceDestroyed: () => destroyed,
      isMainWindow: () => main,
      selectSource: (event) => {
        source = event;
      },
      showFolder: vi.fn(async () => {}),
    });
    await handler(original, 'start', undefined);
    expect((await handler(replacement, 'state', undefined)).phase).toBe('recording');
    await expect(handler(replacement, 'stop', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBe(original);
    await handler(original, 'stop', undefined);
    destroyed = false;
    await expect(handler(replacement, 'upload', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    destroyed = true;
    main = false;
    await expect(handler(replacement, 'show-local', undefined)).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    main = true;
    trusted = false;
    await expect(handler(replacement, 'upload', undefined)).rejects.toThrow('untrusted sender');
    trusted = true;
    f.owner('bob:2');
    expect((await handler(replacement, 'state', undefined)).phase).toBe('idle');
    await expect(handler(replacement, 'upload', undefined)).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBe(original);
    expect(f.deps.upload).not.toHaveBeenCalled();
    expect(f.deps.reveal).not.toHaveBeenCalled();
  });
  it('projects only fixed event labels and bounded numeric timings', () => {
    const input = {
      at: 1200,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      inputDelayMs: 50,
      processingMs: 10,
      key: 'secret',
      target: '/Users/private',
    };
    expect(projectTraceEvent(input, 1000, 2000)).toEqual({
      at: 1200,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      inputDelayMs: 50,
      processingMs: 10,
    });
    for (const extra of [
      { label: 'secret' },
      { at: 0 },
      { durationMs: NaN },
      { kind: '__proto__' },
    ])
      expect(projectTraceEvent({ ...input, ...extra }, 1000, 2000)).toBeNull();
  });
  it('keeps bundled CPU stack locations and sample timing while removing external paths and arbitrary fields', () => {
    const profile = projectCpuProfile(
      {
        startTime: 100,
        endTime: 300,
        samples: [1, 2],
        timeDeltas: [100, 100],
        nodes: [
          {
            id: 1,
            callFrame: {
              functionName: 'parseMarkdown',
              url: 'http://localhost:5173/src/app.ts?secret=abc',
              lineNumber: 10,
              columnNumber: 5,
            },
            children: [2],
          },
          {
            id: 2,
            callFrame: {
              functionName: 'secretFunction',
              url: 'https://private.example/secret.js',
              lineNumber: 42,
              columnNumber: 7,
            },
          },
        ],
      },
      process.cwd(),
      'http://localhost:5173',
    );
    expect(profile.nodes[0].callFrame).toEqual({
      functionName: 'parseMarkdown',
      url: 'app.ts',
      lineNumber: 10,
      columnNumber: 5,
    });
    expect(profile.nodes[1].callFrame).toEqual({
      functionName: '(external or anonymous)',
      url: '',
      lineNumber: -1,
      columnNumber: -1,
    });
    expect(profile.samples).toEqual([1, 2]);
    expect(profile.timeDeltas).toEqual([100, 100]);
    expect(JSON.stringify(profile)).not.toMatch(/secret|private|localhost/);
  });
  it('requires consent before sending and checks owner again between upload batches', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    report.events = Array.from({ length: 600 }, () => ({
      at: 1000,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
    }));
    let owner = 'alice',
      consent = false;
    const fetch = vi.fn(async () => {
      owner = 'bob';
      return new Response('', { status: 200 });
    });
    const deps = {
      owner: () => owner,
      gate: () =>
        consent
          ? { kind: 'allowed' as const }
          : { kind: 'denied' as const, reason: 'no-consent' as const },
      target: () => ({ project: 'fixture', logstore: 'fixture', endpointHost: 'invalid.example' }),
      meta: (uploadCode: string): LogUploadMeta => ({
        uploadCode,
        reason: 'manual',
        userId: 'fixture',
        deviceId: 'fixture',
        appVersion: 'test',
        region: 'global',
        platform: 'win32',
        arch: 'x64',
        osVersion: 'fixture',
        uiLanguage: 'en',
      }),
      fetch,
      artifacts: async () =>
        TRACE_ARTIFACT_NAMES.map((name) => ({
          name,
          bytes: Buffer.from(JSON.stringify(name === 'report.json' ? report : { samples: [1, 2] })),
        })),
    };
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow(
      'PRIVACY_CONSENT_REQUIRED',
    );
    expect(fetch).not.toHaveBeenCalled();
    consent = true;
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow('PRECONDITION_FAILED');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('uploads full files through the log sink and restores all samples with secrets redacted', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-performance-files-'));
    try {
      const original = {
        nodes: [
          {
            id: 1,
            callFrame: { functionName: 'render', url: 'file:///app/main.js', lineNumber: 42 },
          },
        ],
        samples: Array.from({ length: 30_100 }, () => 1),
        timeDeltas: Array.from({ length: 30_100 }, () => 4000),
        credentials: { token: 'test-only-secret' },
        email: 'fixture@example.invalid',
        nested: { 'x-api-key': 'another-test-only-secret' },
        payload: randomBytes(100_000).toString('base64'),
      };
      for (const name of TRACE_ARTIFACT_NAMES)
        await writeFile(
          path.join(directory, name),
          JSON.stringify(name === 'report.json' ? report : original),
        );
      await writeFile(path.join(directory, 'unrelated.txt'), 'must not upload');
      const artifacts = await readTraceArtifacts(directory);
      expect(artifacts.map((file) => file.name)).toEqual([...TRACE_ARTIFACT_NAMES]);
      const rows: unknown[] = [];
      const deps = uploadDeps(artifacts, rows);
      await submitPerformanceReport(deps, report, 'Authorization: Bearer fake-note-secret');
      expect(JSON.stringify(rows)).not.toContain('fake-note-secret');
      const restored = restorePerformanceFiles(
        [...rows].reverse().concat(rows[0]),
        report.reportId,
      );
      expect(restored.files.size).toBe(4);
      const profile = JSON.parse(restored.files.get('main.cpuprofile')!.toString());
      expect(profile.samples).toEqual(original.samples);
      expect(profile.timeDeltas).toEqual(original.timeDeltas);
      expect(profile.nodes).toEqual(original.nodes);
      expect(profile.payload).toBe(original.payload);
      expect(restored.files.get('main.cpuprofile')!.toString()).not.toMatch(
        /test-only-secret|fixture@example.invalid/,
      );
      expect(await readFile(path.join(directory, 'main.cpuprofile'), 'utf8')).toContain(
        'test-only-secret',
      );
      expect(rows.every((row) => Buffer.byteLength((row as { msg: string }).msg) < 20 * 1024)).toBe(
        true,
      );
      expect(() => restorePerformanceFiles(rows.slice(0, -1), report.reportId)).toThrow();
      expect(() =>
        restorePerformanceFiles(
          rows.filter((_, i) => i !== 2),
          report.reportId,
        ),
      ).toThrow();
      const tampered = structuredClone(rows) as Array<{ msg: string }>;
      const manifest = JSON.parse(tampered[0].msg);
      manifest.data.files[0].sha256 = '0'.repeat(64);
      tampered[0].msg = JSON.stringify(manifest);
      expect(() => restorePerformanceFiles(tampered, report.reportId)).toThrow(/checksum/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retains local evidence after final-marker failure and retries with one independently complete attempt', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    const artifacts = TRACE_ARTIFACT_NAMES.map((name) => ({
      name,
      bytes: Buffer.from(
        JSON.stringify(name === 'report.json' ? report : { nodes: [], samples: [] }),
      ),
    }));
    const rows: unknown[] = [];
    const deps = uploadDeps(artifacts, rows);
    const send = deps.fetch;
    deps.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (JSON.parse(body.__logs__[0].msg).data.kind === 'complete')
        return new Response('', { status: 503 });
      return send(url, init);
    });
    f.deps.upload = (r, note) => submitPerformanceReport(deps, r, note);
    await expect(f.controller.upload('note')).rejects.toThrow('LOG_UPLOAD_FAILED');
    expect(f.controller.snapshot()).toMatchObject({
      phase: 'ready',
      uploaded: false,
      reportId: report.reportId,
    });
    expect(() => restorePerformanceFiles(rows, report.reportId)).toThrow();
    deps.fetch = send;
    await f.controller.upload('note');
    expect(f.controller.snapshot().uploaded).toBe(true);
    expect(restorePerformanceFiles(rows, report.reportId).files.size).toBe(4);
    expect(
      new Set(rows.map((row) => JSON.parse((row as { msg: string }).msg).attemptId)).size,
    ).toBe(2);
  });
  it('rejects missing/invalid full files before any request and reports missing files for a partial recording', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    const report = f.reports[0];
    const rows: unknown[] = [];
    const files: TraceArtifact[] = [
      { name: 'report.json', bytes: Buffer.from(JSON.stringify(report)) },
    ];
    const deps = uploadDeps(files, rows);
    await expect(submitPerformanceReport(deps, report, '')).rejects.toThrow('LOG_UPLOAD_FAILED');
    expect(deps.fetch).not.toHaveBeenCalled();
    report.partial = true;
    files[0].bytes = Buffer.from(JSON.stringify(report));
    await submitPerformanceReport(deps, report, '');
    expect(restorePerformanceFiles(rows, report.reportId).manifest.missing).toHaveLength(3);
  });
  it('measures selected IPC calls without changing return values, rejections or exposing arguments', async () => {
    const events: unknown[] = [];
    setTraceOperationObserver((e) => events.push(e));
    expect(measureTraceOperation('local-db:sessions:list', () => 42)).toBe(42);
    const error = new Error('original');
    await expect(
      measureTraceOperation('maker:list-agent-skills', () => Promise.reject(error)),
    ).rejects.toBe(error);
    measureTraceOperation('private-channel-name', () => 0);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/original|private-channel/);
  });
});

function uploadDeps(artifacts: TraceArtifact[], rows: unknown[]) {
  return {
    owner: () => 'owner',
    gate: () => ({ kind: 'allowed' as const }),
    target: () => ({ project: 'fixture', logstore: 'fixture', endpointHost: 'invalid.example' }),
    meta: (uploadCode: string): LogUploadMeta => ({
      uploadCode,
      reason: 'manual',
      userId: 'fixture',
      deviceId: 'fixture',
      appVersion: 'test',
      region: 'global',
      platform: 'win32',
      arch: 'x64',
      osVersion: 'fixture',
      uiLanguage: 'en',
    }),
    artifacts: async () => artifacts,
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(1024 * 1024);
      rows.push(...body.__logs__);
      return new Response('', { status: 200 });
    }),
  };
}
