import { mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IOSSimulatorCommandRunner } from '@cindy/ios-simulator-runtime';

import { IOSSimulatorMediaCapture } from '../ios-simulator-media';

afterEach(() => {
  vi.useRealTimers();
});

describe('IOSSimulatorMediaCapture', () => {
  it('captures an exact UDID into cindy-media with a session reference', async () => {
    const ingest = vi.fn(async (params) => ({
      hash: 'a'.repeat(64),
      ext: '.png',
      mimeType: 'image/png',
      bytes: params.buffer.length,
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
      deduplicated: false,
      refIds: ['ref-a'],
    }));
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const capture = new IOSSimulatorMediaCapture({ commandRunner: { run }, ingest });
    const result = await capture.takeScreenshot({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      source: 'agent',
    });

    expect(result.url).toMatch(/^cindy-media:\/\/blobs\//);
    expect(run).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['simctl', 'io', 'EXACT-UDID', 'screenshot', '--type=png']),
      expect.any(Object),
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/png',
        refs: [
          expect.objectContaining({
            refKind: 'session-attachment',
            refId: 'session-a',
            originSessionId: 'session-a',
          }),
        ],
      }),
    );
  });

  it('forwards screenshot cancellation to xcrun and removes the temporary directory', async () => {
    let screenshotPath = '';
    let runnerSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner['run']>(async (_command, args, options) => {
      screenshotPath = args.at(-1)!;
      runnerSignal = options?.signal;
      return new Promise((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => resolve({ stdout: '', stderr: '', exitCode: null }),
          { once: true },
        );
      });
    });
    const capture = new IOSSimulatorMediaCapture({ commandRunner: { run } });
    const controller = new AbortController();

    const screenshot = capture.captureScreenshotBytes({
      simulatorUdid: 'EXACT-UDID',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(runnerSignal).toBe(controller.signal));
    const tempRoot = path.dirname(screenshotPath);
    controller.abort(new Error('task closed'));

    await expect(screenshot).rejects.toMatchObject({ code: 'SCREENSHOT_CAPTURE_FAILED' });
    await expect(stat(tempRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates screenshot ingest when its host mutation is cancelled after capture', async () => {
    let markIngestStarted: () => void = () => undefined;
    let releaseIngest: () => void = () => undefined;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const ingest = vi.fn(async (params) => {
      markIngestStarted();
      await ingestGate;
      params.assertStillValid?.();
      return {
        hash: 'b'.repeat(64),
        ext: '.png',
        mimeType: 'image/png',
        bytes: params.buffer.length,
        url: `cindy-media://blobs/${'b'.repeat(64)}.png`,
        deduplicated: false,
        refIds: ['late-ref'],
      };
    });
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const capture = new IOSSimulatorMediaCapture({ commandRunner: { run }, ingest });
    const controller = new AbortController();

    const screenshot = capture.takeScreenshot({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      source: 'agent',
      signal: controller.signal,
    });
    await ingestStarted;
    controller.abort(new Error('task closed'));

    await expect(screenshot).rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });
    releaseIngest();
    await expect(capture.dispose()).resolves.toBeUndefined();
  });

  it('does not ingest a screenshot after its data owner changes during capture', async () => {
    let ownerScopeKey = 'owner-a';
    const ingest = vi.fn();
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      ownerScopeKey = 'owner-b';
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const capture = new IOSSimulatorMediaCapture({
      commandRunner: { run },
      ingest,
      getOwnerScopeKey: () => ownerScopeKey,
      isOwnerScopeCurrent: (expected) => ownerScopeKey === expected,
    });

    await expect(
      capture.takeScreenshot({
        simulatorUdid: 'EXACT-UDID',
        sessionId: 'session-a',
        instanceId: 'instance-a',
        source: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('quiesces a screenshot before task cleanup and prevents a late session reference', async () => {
    let markCaptureStarted: () => void = () => undefined;
    let markCaptureFinished: () => void = () => undefined;
    let releaseCapture: () => void = () => undefined;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureFinished = new Promise<void>((resolve) => {
      markCaptureFinished = resolve;
    });
    const ingest = vi.fn();
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      markCaptureStarted();
      await captureGate;
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      markCaptureFinished();
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const capture = new IOSSimulatorMediaCapture({ commandRunner: { run }, ingest });

    const screenshot = capture.takeScreenshot({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      source: 'agent',
    });
    await captureStarted;
    await expect(capture.discardSession('session-a')).resolves.toBeUndefined();
    await expect(screenshot).rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });

    releaseCapture();
    await captureFinished;
    await Promise.resolve();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not poison media storage while screenshot capture itself is slow', async () => {
    let releaseFirstCapture: () => void = () => undefined;
    let markFirstCaptureStarted: () => void = () => undefined;
    const firstCaptureStarted = new Promise<void>((resolve) => {
      markFirstCaptureStarted = resolve;
    });
    const firstCaptureGate = new Promise<void>((resolve) => {
      releaseFirstCapture = resolve;
    });
    let captureCount = 0;
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      captureCount += 1;
      if (captureCount === 1) {
        markFirstCaptureStarted();
        await firstCaptureGate;
      }
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, captureCount]));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const ingest = vi.fn(async (params) => ({
      hash: 'f'.repeat(64),
      ext: '.png',
      mimeType: 'image/png',
      bytes: params.buffer.length,
      url: `cindy-media://blobs/${'f'.repeat(64)}.png`,
      deduplicated: false,
      refIds: ['ref-screenshot'],
    }));
    const capture = new IOSSimulatorMediaCapture({ commandRunner: { run }, ingest });

    vi.useFakeTimers();
    const first = capture.takeScreenshot({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      source: 'agent',
    });
    await firstCaptureStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ingest).not.toHaveBeenCalled();

    releaseFirstCapture();
    await expect(first).resolves.toMatchObject({ refIds: ['ref-screenshot'] });
    await expect(
      capture.takeScreenshot({
        simulatorUdid: 'EXACT-UDID',
        sessionId: 'session-b',
        instanceId: 'instance-b',
        source: 'user',
      }),
    ).resolves.toMatchObject({ refIds: ['ref-screenshot'] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds only screenshot ingest and poisons later media when storage never settles', async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const ingest = vi.fn(() => new Promise<never>(() => undefined));
    const launch = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      commandRunner: { run },
      ingest,
      recordingLauncher: { launch },
    });

    vi.useFakeTimers();
    const screenshot = capture.takeScreenshot({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      source: 'agent',
    });
    const screenshotFailure = expect(screenshot).rejects.toMatchObject({
      code: 'SCREENSHOT_CAPTURE_FAILED',
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);

    await screenshotFailure;
    await expect(
      capture.startRecording({
        simulatorUdid: 'EXACT-UDID-2',
        sessionId: 'session-b',
        instanceId: 'instance-b',
        generation: 1,
        source: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    expect(launch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records an exact UDID and ingests the finalized MOV through cindy-media', async () => {
    const ingest = vi.fn(async (params) => ({
      hash: 'b'.repeat(64),
      ext: '.mov',
      mimeType: 'video/quicktime',
      bytes: params.buffer.length,
      url: `cindy-media://blobs/${'b'.repeat(64)}.mov`,
      deduplicated: false,
      refIds: ['ref-video'],
    }));
    let launchArgs: readonly string[] = [];
    let resolveExit: () => void = () => undefined;
    const recordingLauncher = {
      launch: vi.fn((args: readonly string[]) => {
        launchArgs = args;
        const videoPath = args.at(-1)!;
        return {
          started: Promise.resolve(),
          exited: new Promise<void>((resolve) => {
            resolveExit = resolve;
          }),
          kill: vi.fn(async () => {
            await writeFile(videoPath, Buffer.from('mov-bytes'));
            resolveExit();
          }),
        };
      }),
    };
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher, ingest });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'user',
    });
    const result = await capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });

    expect(launchArgs).toEqual([
      'simctl',
      'io',
      'EXACT-UDID',
      'recordVideo',
      '--codec=h264',
      expect.stringMatching(/recording\.mov$/),
    ]);
    expect(result.mimeType).toBe('video/quicktime');
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'video/quicktime',
        refs: [
          expect.objectContaining({
            refKind: 'session-attachment',
            refId: 'session-a',
            originKind: 'user',
          }),
        ],
      }),
    );
    await expect(stat(path.dirname(launchArgs.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an immediately exited recorder and clears its state and temp directory', async () => {
    const videoPaths: string[] = [];
    const launch = vi.fn((args: readonly string[]) => {
      videoPaths.push(args.at(-1)!);
      return {
        started: new Promise<void>(() => undefined),
        exited: Promise.resolve(),
        isAlive: () => false,
        kill: vi.fn(),
      };
    });
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });
    const input = {
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent' as const,
    };

    await expect(capture.startRecording(input)).rejects.toMatchObject({
      code: 'RECORDING_FAILED',
    });
    await expect(capture.startRecording(input)).rejects.toMatchObject({
      code: 'RECORDING_FAILED',
    });

    expect(launch).toHaveBeenCalledTimes(2);
    await Promise.all(
      videoPaths.map((videoPath) =>
        expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' }),
      ),
    );
  });

  it('does not report recording success before the first frame is processed', async () => {
    let resolveStarted: () => void = () => undefined;
    let resolveExit: () => void = () => undefined;
    let processAlive = true;
    const kill = vi.fn(() => {
      processAlive = false;
      resolveExit();
    });
    const launch = vi.fn(() => ({
      started: new Promise<void>((resolve) => {
        resolveStarted = resolve;
      }),
      exited: new Promise<void>((resolve) => {
        resolveExit = resolve;
      }),
      isAlive: () => processAlive,
      kill,
    }));
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });
    let settled = false;
    const starting = capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveStarted();
    await expect(starting).resolves.toEqual({
      recordingId: expect.any(String),
      startedAt: expect.any(String),
    });
    await expect(capture.discardInstance('instance-a')).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills and clears a recorder that never processes its first frame', async () => {
    let resolveExit: () => void = () => undefined;
    let processAlive = true;
    let videoPath = '';
    const kill = vi.fn(() => {
      processAlive = false;
      resolveExit();
    });
    const launch = vi.fn((args: readonly string[]) => {
      videoPath = args.at(-1)!;
      return {
        started: new Promise<void>(() => undefined),
        exited: new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
        isAlive: () => processAlive,
        kill,
      };
    });
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });

    vi.useFakeTimers();
    const starting = capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    const failure = expect(starting).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);

    await failure;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a stuck startup cleanup before launching the next recorder', async () => {
    let firstResolveExit: () => void = () => undefined;
    let firstAlive = true;
    let firstKillCount = 0;
    let secondResolveExit: () => void = () => undefined;
    let secondAlive = true;
    const firstKill = vi.fn(() => {
      firstKillCount += 1;
      if (firstKillCount < 2) return;
      firstAlive = false;
      firstResolveExit();
    });
    const secondKill = vi.fn(() => {
      secondAlive = false;
      secondResolveExit();
    });
    const launch = vi.fn(() => {
      if (launch.mock.calls.length === 1) {
        return {
          started: new Promise<void>(() => undefined),
          exited: new Promise<void>((resolve) => {
            firstResolveExit = resolve;
          }),
          isAlive: () => firstAlive,
          kill: firstKill,
        };
      }
      return {
        started: Promise.resolve(),
        exited: new Promise<void>((resolve) => {
          secondResolveExit = resolve;
        }),
        isAlive: () => secondAlive,
        kill: secondKill,
      };
    });
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });
    const input = {
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent' as const,
    };

    vi.useFakeTimers();
    const firstStart = capture.startRecording(input);
    const firstFailure = expect(firstStart).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_500);
    await firstFailure;
    expect(firstKill).toHaveBeenCalledTimes(1);

    const secondStart = await capture.startRecording(input);
    expect(secondStart.recordingId).toEqual(expect.any(String));
    expect(firstKill).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(2);
    await expect(capture.discardInstance('instance-a')).resolves.toBeUndefined();
    expect(secondKill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a starting recorder visible to Host disposal', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn(() => resolveExit());
    const launch = vi.fn((args: readonly string[]) => {
      videoPath = args.at(-1)!;
      return {
        started: new Promise<void>(() => undefined),
        exited: new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
        kill,
      };
    });
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });
    const starting = capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());

    const disposing = capture.dispose();

    await expect(starting).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(disposing).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not ingest a recording after its data owner changes during finalization', async () => {
    let ownerScopeKey = 'owner-a';
    let videoPath = '';
    let resolveExit: () => void = () => undefined;
    const ingest = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      getOwnerScopeKey: () => ownerScopeKey,
      isOwnerScopeCurrent: (expected) => ownerScopeKey === expected,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill: vi.fn(async (signal: NodeJS.Signals) => {
              if (signal !== 'SIGINT') return;
              ownerScopeKey = 'owner-b';
              await writeFile(videoPath, Buffer.from('mov-bytes'));
              resolveExit();
            }),
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });

    await expect(
      capture.stopRecording({
        recordingId: started.recordingId,
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not launch a queued recording after its data owner changes', async () => {
    let ownerScopeKey = 'owner-a';
    let firstVideoPath = '';
    let resolveFirstExit: () => void = () => undefined;
    let markIngestStarted: () => void = () => undefined;
    let releaseIngest: () => void = () => undefined;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const ingest = vi.fn(async (params) => {
      markIngestStarted();
      await ingestGate;
      params.assertStillValid?.();
      return {
        hash: 'c'.repeat(64),
        ext: '.mov',
        mimeType: 'video/quicktime',
        bytes: params.buffer.length,
        url: `cindy-media://blobs/${'c'.repeat(64)}.mov`,
        deduplicated: false,
        refIds: ['ref-video'],
      };
    });
    const launch = vi.fn((args: readonly string[]) => {
      firstVideoPath ||= args.at(-1)!;
      return {
        started: Promise.resolve(),
        exited: new Promise<void>((resolve) => {
          resolveFirstExit = resolve;
        }),
        kill: vi.fn(async (signal: NodeJS.Signals) => {
          if (signal !== 'SIGINT') return;
          await writeFile(firstVideoPath, Buffer.from('mov-bytes'));
          resolveFirstExit();
        }),
      };
    });
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      getOwnerScopeKey: () => ownerScopeKey,
      isOwnerScopeCurrent: (expected) => ownerScopeKey === expected,
      recordingLauncher: { launch },
    });
    const first = await capture.startRecording({
      simulatorUdid: 'UDID-A',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    const stopping = capture.stopRecording({
      recordingId: first.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
    });
    await ingestStarted;
    const queuedStart = capture.startRecording({
      simulatorUdid: 'UDID-B',
      sessionId: 'session-a',
      instanceId: 'instance-b',
      generation: 1,
      source: 'agent',
    });

    ownerScopeKey = 'owner-b';
    releaseIngest();

    await expect(stopping).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(queuedStart).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    expect(launch).toHaveBeenCalledOnce();
  });

  it('rejects oversized recordings before buffering them in Electron Main', async () => {
    const ingest = vi.fn();
    let videoPath = '';
    let resolveExit: () => void = () => undefined;
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill: vi.fn(async () => {
              await writeFile(videoPath, Buffer.alloc(0));
              await truncate(videoPath, 128 * 1024 * 1024 + 1);
              resolveExit();
            }),
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    await expect(
      capture.stopRecording({
        recordingId: started.recordingId,
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    expect(ingest).not.toHaveBeenCalled();
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates and removes active recording state when an instance is discarded', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') resolveExit();
    });
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill,
          };
        }),
      },
    });
    await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const discarded = capture.discardInstance('instance-a');
    await discarded;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGKILL']);
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      capture.stopRecording({
        recordingId: 'missing',
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
  });

  it('discards every active recording owned by one session without touching another task', async () => {
    const videoPaths: string[] = [];
    const kills: Array<ReturnType<typeof vi.fn>> = [];
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPaths.push(args.at(-1)!);
          let resolveExit: () => void = () => undefined;
          const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
          });
          const kill = vi.fn((signal: NodeJS.Signals) => {
            if (signal === 'SIGKILL') resolveExit();
          });
          kills.push(kill);
          return { started: Promise.resolve(), exited, kill };
        }),
      },
    });
    await capture.startRecording({
      simulatorUdid: 'SESSION-A-UDID-1',
      sessionId: 'session-a',
      instanceId: 'instance-a-1',
      generation: 1,
      source: 'agent',
    });
    await capture.startRecording({
      simulatorUdid: 'SESSION-B-UDID',
      sessionId: 'session-b',
      instanceId: 'instance-b',
      generation: 1,
      source: 'user',
    });
    await capture.startRecording({
      simulatorUdid: 'SESSION-A-UDID-2',
      sessionId: 'session-a',
      instanceId: 'instance-a-2',
      generation: 1,
      source: 'user',
    });

    await capture.discardSession('session-a');

    expect(kills[0]).toHaveBeenCalledWith('SIGKILL');
    expect(kills[1]).not.toHaveBeenCalled();
    expect(kills[2]).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(videoPaths[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.dirname(videoPaths[1]!))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(stat(path.dirname(videoPaths[2]!))).rejects.toMatchObject({ code: 'ENOENT' });

    await capture.discardSession('session-b');
    expect(kills[1]).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(videoPaths[1]!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let another task pending ingest block session cleanup', async () => {
    let videoPath = '';
    let resolveExit: () => void = () => undefined;
    let markIngestStarted: () => void = () => undefined;
    let releaseIngest: () => void = () => undefined;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const ingest = vi.fn(async (params) => {
      markIngestStarted();
      await ingestGate;
      params.assertStillValid?.();
      return {
        hash: 'd'.repeat(64),
        ext: '.mov',
        mimeType: 'video/quicktime',
        bytes: params.buffer.length,
        url: `cindy-media://blobs/${'d'.repeat(64)}.mov`,
        deduplicated: false,
        refIds: ['ref-video'],
      };
    });
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill: vi.fn(async (signal: NodeJS.Signals) => {
              if (signal !== 'SIGINT') return;
              await writeFile(videoPath, Buffer.from('mov-bytes'));
              resolveExit();
            }),
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'SESSION-B-UDID',
      sessionId: 'session-b',
      instanceId: 'instance-b',
      generation: 1,
      source: 'agent',
    });
    const stopping = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-b',
      instanceId: 'instance-b',
      generation: 1,
    });
    await ingestStarted;

    await expect(capture.discardSession('session-a')).resolves.toBeUndefined();

    releaseIngest();
    await expect(stopping).resolves.toMatchObject({ refIds: ['ref-video'] });
  });

  it('invalidates pending ingest without making session cleanup wait for it', async () => {
    let videoPath = '';
    let resolveExit: () => void = () => undefined;
    let markIngestStarted: () => void = () => undefined;
    let releaseIngest: () => void = () => undefined;
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    const ingestGate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const ingest = vi.fn(async (params) => {
      markIngestStarted();
      await ingestGate;
      params.assertStillValid?.();
      return {
        hash: 'e'.repeat(64),
        ext: '.mov',
        mimeType: 'video/quicktime',
        bytes: params.buffer.length,
        url: `cindy-media://blobs/${'e'.repeat(64)}.mov`,
        deduplicated: false,
        refIds: ['late-ref'],
      };
    });
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill: vi.fn(async (signal: NodeJS.Signals) => {
              if (signal !== 'SIGINT') return;
              await writeFile(videoPath, Buffer.from('mov-bytes'));
              resolveExit();
            }),
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'SESSION-A-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    const stopping = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
    });
    await ingestStarted;

    const discarding = capture.discardSession('session-a');
    let cleanupSettled = false;
    void discarding.then(
      () => {
        cleanupSettled = true;
      },
      () => {
        cleanupSettled = true;
      },
    );
    await expect(stopping).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    releaseIngest();
    await expect(discarding).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('bounds recording ingest even when storage never settles', async () => {
    let videoPath = '';
    let resolveExit: () => void = () => undefined;
    let processAlive = true;
    const ingest = vi.fn(() => new Promise<never>(() => undefined));
    const launch = vi.fn((args: readonly string[]) => {
      videoPath = args.at(-1)!;
      return {
        started: Promise.resolve(),
        exited: new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
        isAlive: () => processAlive,
        kill: vi.fn(() => {
          processAlive = false;
          resolveExit();
        }),
      };
    });
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: { launch },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    await writeFile(videoPath, Buffer.from('mov-bytes'));

    vi.useFakeTimers();
    const stopping = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(stopping).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    const cleanup = capture.discardSession('session-a');
    const cleanupFailure = expect(cleanup).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.advanceTimersByTimeAsync(30_000);
    await cleanupFailure;
    await expect(
      capture.startRecording({
        simulatorUdid: 'EXACT-UDID-2',
        sessionId: 'session-b',
        instanceId: 'instance-b',
        generation: 1,
        source: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports incomplete cleanup and retains tracking when SIGKILL is not confirmed', async () => {
    let videoPath = '';
    const kill = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>(() => undefined),
            kill,
          };
        }),
      },
    });
    await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const discarded = capture.discardInstance('instance-a');
    const rejection = expect(discarded).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.advanceTimersByTimeAsync(500);
    await rejection;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGKILL']);
    await expect(stat(path.dirname(videoPath))).resolves.toBeDefined();

    const retry = capture.discardInstance('instance-a');
    const retryRejection = expect(retry).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.advanceTimersByTimeAsync(500);
    await retryRejection;
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGKILL', 'SIGKILL']);
    await rm(path.dirname(videoPath), { recursive: true, force: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a finalized recording safely when no exit event arrives after SIGKILL', async () => {
    const ingest = vi.fn();
    let videoPath = '';
    const kill = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>(() => undefined),
            kill,
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopped = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });
    const rejection = expect(stopped).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.advanceTimersByTimeAsync(6_500);
    await rejection;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(ingest).not.toHaveBeenCalled();
    await expect(stat(path.dirname(videoPath))).resolves.toBeDefined();
    await expect(
      capture.startRecording({
        simulatorUdid: 'EXACT-UDID',
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 3,
        source: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_ALREADY_ACTIVE' });
    await rm(path.dirname(videoPath), { recursive: true, force: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat a leader exit as success while its recording group is alive', async () => {
    let resolveLeaderExit: () => void = () => undefined;
    let groupAlive = true;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGINT') resolveLeaderExit();
      if (signal === 'SIGKILL') groupAlive = false;
    });
    const ingest = vi.fn(async () => ({
      hash: 'c'.repeat(64),
      ext: '.mov',
      mimeType: 'video/quicktime',
      bytes: 9,
      url: `cindy-media://blobs/${'c'.repeat(64)}.mov`,
      deduplicated: false,
      refIds: ['ref-video'],
    }));
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveLeaderExit = resolve;
            }),
            isAlive: () => groupAlive,
            kill,
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });
    await writeFile(videoPath, Buffer.from('mov-bytes'));

    vi.useFakeTimers();
    const stopped = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });
    await vi.advanceTimersByTimeAsync(6_025);
    await expect(stopped).rejects.toMatchObject({ code: 'RECORDING_FAILED' });

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(ingest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the start gate before an in-flight recording can launch during dispose', async () => {
    const launch = vi.fn();
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });

    const starting = capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });
    const disposing = capture.dispose();

    await expect(starting).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await expect(disposing).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects a queued recording start when session cleanup wins before registration', async () => {
    const launch = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: { launch },
    });

    const starting = capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    const discarding = capture.discardSession('session-a');

    await expect(starting).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(discarding).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it('synchronously kills active recorders on force-exit and rejects later starts', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') resolveExit();
    });
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill,
          };
        }),
      },
    });
    await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    capture.abortOperationsForExit();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      capture.startRecording({
        simulatorUdid: 'EXACT-UDID-2',
        sessionId: 'session-a',
        instanceId: 'instance-b',
        generation: 1,
        source: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await capture.dispose();
  });

  it('keeps a finalizing recorder visible to the force-exit path', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') resolveExit();
    });
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill,
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopped = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith('SIGINT');

    capture.abortOperationsForExit();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stopped).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans active recorders before reporting a hung ingest during dispose', async () => {
    const paths = new Map<string, string>();
    const kills = new Map<string, ReturnType<typeof vi.fn>>();
    const ingest = vi.fn(() => new Promise<never>(() => undefined));
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          const instanceId = args[2] === 'UDID-A' ? 'instance-a' : 'instance-b';
          paths.set(instanceId, args.at(-1)!);
          let resolveExit: () => void = () => undefined;
          let processAlive = true;
          const kill = vi.fn(() => {
            processAlive = false;
            resolveExit();
          });
          kills.set(instanceId, kill);
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            isAlive: () => processAlive,
            kill,
          };
        }),
      },
    });
    const first = await capture.startRecording({
      simulatorUdid: 'UDID-A',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    await writeFile(paths.get('instance-a')!, Buffer.from('mov-bytes'));
    await capture.startRecording({
      simulatorUdid: 'UDID-B',
      sessionId: 'session-b',
      instanceId: 'instance-b',
      generation: 1,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopping = capture.stopRecording({
      recordingId: first.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const disposing = capture.dispose();
    const disposeFailure = expect(disposing).rejects.toMatchObject({ code: 'RECORDING_FAILED' });

    await expect(stopping).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await vi.advanceTimersByTimeAsync(30_000);
    await disposeFailure;

    expect(kills.get('instance-a')).toHaveBeenCalledWith('SIGKILL');
    expect(kills.get('instance-b')).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(paths.get('instance-a')!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.dirname(paths.get('instance-b')!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('regular dispose immediately kills both finalizing and active recorders', async () => {
    const exits = new Map<string, () => void>();
    const kills = new Map<string, ReturnType<typeof vi.fn>>();
    const paths = new Map<string, string>();
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          const instanceId = args[2] === 'UDID-A' ? 'instance-a' : 'instance-b';
          paths.set(instanceId, args.at(-1)!);
          const kill = vi.fn((signal: NodeJS.Signals) => {
            if (signal === 'SIGKILL') exits.get(instanceId)?.();
          });
          kills.set(instanceId, kill);
          return {
            started: Promise.resolve(),
            exited: new Promise<void>((resolve) => exits.set(instanceId, resolve)),
            kill,
          };
        }),
      },
    });
    const first = await capture.startRecording({
      simulatorUdid: 'UDID-A',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    await capture.startRecording({
      simulatorUdid: 'UDID-B',
      sessionId: 'session-a',
      instanceId: 'instance-b',
      generation: 1,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopping = capture.stopRecording({
      recordingId: first.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
    });
    await Promise.resolve();
    const disposing = capture.dispose();

    expect(kills.get('instance-a')).toHaveBeenCalledWith('SIGKILL');
    expect(kills.get('instance-b')).toHaveBeenCalledWith('SIGKILL');
    await expect(stopping).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(disposing).resolves.toBeUndefined();
    await expect(stat(path.dirname(paths.get('instance-a')!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.dirname(paths.get('instance-b')!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
