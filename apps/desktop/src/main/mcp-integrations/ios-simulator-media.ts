import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import {
  createNodeIOSSimulatorCommandRunner,
  IOSSimulatorInstanceError,
  compareIOSSimulatorRgbaImages,
  type IOSSimulatorPixelDiff,
  type IOSSimulatorCommandRunner,
} from '@cindy/ios-simulator-runtime';

import { ingestMedia, type IngestedMedia, type IngestMediaParams } from '../cindy-media/ingest.js';
import type { LedgerDb } from '../cindy-media/ledger.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { tryGetDbClient } from '../localDb/client/current.js';

const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
// cindy-media currently ingests buffers. Keep the recording ceiling bounded to
// an amount Electron Main can safely validate and ingest without multi-GiB
// allocations; larger captures are rejected before readFile.
const MAX_BUFFERED_RECORDING_BYTES = 128 * 1024 * 1024;
const RECORDING_STARTED_MARKER = 'Recording started';
const RECORDING_STARTUP_TIMEOUT_MS = 5_000;
const RECORDING_STOP_TIMEOUT_MS = 5_000;
const RECORDING_TERM_TIMEOUT_MS = 1_000;
const RECORDING_KILL_TIMEOUT_MS = 500;
const RECORDING_DISCARD_KILL_TIMEOUT_MS = 500;
const RECORDING_INGEST_TIMEOUT_MS = 30_000;

type IOSSimulatorMediaIngest = (params: IngestMediaParams) => Promise<IngestedMedia>;

export interface IOSSimulatorMediaCaptureOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  ingest?: IOSSimulatorMediaIngest;
  recordingLauncher?: IOSSimulatorRecordingLauncher;
  getOwnerScopeKey?: () => string;
  isOwnerScopeCurrent?: (ownerScopeKey: string) => boolean;
}

export interface IOSSimulatorRecordingProcess {
  /** Resolves only after simctl has processed the first frame. */
  started: Promise<void>;
  exited: Promise<void>;
  /** True while the detached recorder process group still owns live members. */
  isAlive?(): boolean;
  kill(signal: NodeJS.Signals): void;
}

export interface IOSSimulatorRecordingLauncher {
  launch(args: readonly string[]): IOSSimulatorRecordingProcess;
}

export interface IOSSimulatorScreenshotInput {
  simulatorUdid: string;
  sessionId: string;
  instanceId: string;
  source: 'agent' | 'user';
  signal?: AbortSignal;
}

interface ActiveRecording {
  recordingId: string;
  simulatorUdid: string;
  sessionId: string;
  instanceId: string;
  generation: number;
  source: 'agent' | 'user';
  tempRoot: string;
  videoPath: string;
  process: IOSSimulatorRecordingProcess;
  phase: 'starting' | 'active' | 'finalizing';
  discardRequested: boolean;
  discardSignalSent: boolean;
  discarded: Promise<void>;
  resolveDiscarded(): void;
  sessionEpoch: number;
  instanceEpoch: number;
  ownerScopeKey: string;
  ingestDb: LedgerDb | null;
}

interface IOSSimulatorMediaOwnerScope {
  ownerScopeKey: string;
  ingestDb: LedgerDb | null;
}

interface ActiveScreenshotRequest {
  sessionId: string;
  instanceId: string;
  sessionEpoch: number;
  ownerScope: IOSSimulatorMediaOwnerScope;
  cancelled: boolean;
  cancelledSignal: Promise<void>;
  resolveCancelled(): void;
}

function isProcessGroupAlive(pid: number, leaderClosed: boolean): boolean {
  if (process.platform === 'win32') return !leaderClosed;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

function createRecordingLauncher(): IOSSimulatorRecordingLauncher {
  return {
    launch(args) {
      const child = spawn('/usr/bin/xcrun', [...args], {
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.on('error', () => {
        // ChildProcess requires an error listener to avoid an uncaught Main
        // exception. The error is deliberately not treated as proof of exit.
      });
      if (!child.pid) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_FAILED',
          'The recording process did not start.',
        );
      }
      const pid = child.pid;
      let leaderClosed = false;
      let resolveStarted: () => void = () => undefined;
      let startedResolved = false;
      let stderrTail = '';
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string | Buffer) => {
        if (startedResolved) return;
        stderrTail = `${stderrTail}${chunk.toString()}`;
        if (stderrTail.includes(RECORDING_STARTED_MARKER)) {
          startedResolved = true;
          stderrTail = '';
          resolveStarted();
          return;
        }
        stderrTail = stderrTail.slice(-(RECORDING_STARTED_MARKER.length - 1));
      });
      const exited = new Promise<void>((resolve) => {
        child.once('close', () => {
          leaderClosed = true;
          resolve();
        });
        // A post-spawn error is not proof that the detached process group is
        // gone. `close` plus the group liveness probe remains authoritative.
      });
      return {
        started,
        exited,
        isAlive: () => isProcessGroupAlive(pid, leaderClosed),
        kill(signal) {
          if (process.platform !== 'win32') {
            try {
              process.kill(-pid, signal);
              return;
            } catch {
              // The process group may have already exited; fall back to child.
            }
          }
          child.kill(signal);
        },
      };
    },
  };
}

async function waitForRecordingStartup(
  process: IOSSimulatorRecordingProcess,
  timeoutMs: number,
): Promise<'started' | 'exited' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (result: 'started' | 'exited' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const confirmExit = (): void => {
      try {
        if (process.isAlive && !process.isAlive()) finish('exited');
      } catch {
        // A failed liveness probe cannot prove the process group is gone.
      }
    };
    if (process.isAlive) {
      poll = setInterval(confirmExit, 25);
      confirmExit();
    }
    void process.started.then(
      () => finish('started'),
      () => undefined,
    );
    void process.exited.then(
      () => {
        if (!process.isAlive) finish('exited');
        else confirmExit();
      },
      () => undefined,
    );
  });
}

async function waitForRecordingExit(
  process: IOSSimulatorRecordingProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const confirmExit = (): void => {
      try {
        if (process.isAlive && !process.isAlive()) finish(true);
      } catch {
        // A failed liveness probe cannot prove the process group is gone.
      }
    };
    if (process.isAlive) {
      poll = setInterval(confirmExit, 25);
      confirmExit();
    }
    void process.exited.then(
      () => {
        if (!process.isAlive) finish(true);
        else confirmExit();
      },
      () => undefined,
    );
  });
}

function signalRecordingProcess(
  process: IOSSimulatorRecordingProcess,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(signal);
  } catch {
    // Exit observation remains authoritative; continue through the bounded waits.
  }
}

async function terminateRecordingProcess(
  process: IOSSimulatorRecordingProcess,
  mode: 'finalize' | 'discard',
): Promise<'finalized' | 'terminated' | 'stuck'> {
  if (mode === 'finalize') {
    signalRecordingProcess(process, 'SIGINT');
    if (await waitForRecordingExit(process, RECORDING_STOP_TIMEOUT_MS)) return 'finalized';
    signalRecordingProcess(process, 'SIGTERM');
    if (await waitForRecordingExit(process, RECORDING_TERM_TIMEOUT_MS)) return 'terminated';
  }
  signalRecordingProcess(process, 'SIGKILL');
  return (await waitForRecordingExit(
    process,
    mode === 'discard' ? RECORDING_DISCARD_KILL_TIMEOUT_MS : RECORDING_KILL_TIMEOUT_MS,
  ))
    ? 'terminated'
    : 'stuck';
}

/** Explicit simulator media capture. Transient stream frames never enter this path. */
export class IOSSimulatorMediaCapture {
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #customIngest: IOSSimulatorMediaIngest | null;
  readonly #getOwnerScopeKey: () => string;
  readonly #isOwnerScopeCurrent: (ownerScopeKey: string) => boolean;
  readonly #recordingLauncher: IOSSimulatorRecordingLauncher;
  readonly #recordings = new Map<string, ActiveRecording>();
  readonly #recordingOperationTails = new Map<string, Promise<void>>();
  readonly #screenshotRequestsBySession = new Map<string, Set<ActiveScreenshotRequest>>();
  readonly #rawIngestsBySession = new Map<string, Set<Promise<void>>>();
  readonly #rawIngestsByInstance = new Map<string, Set<Promise<void>>>();
  readonly #instanceSessions = new Map<string, string>();
  readonly #sessionEpochs = new Map<string, number>();
  readonly #instanceEpochs = new Map<string, number>();
  #ingestPoisoned = false;
  #closed = false;

  constructor(options: IOSSimulatorMediaCaptureOptions = {}) {
    this.#runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#customIngest = options.ingest ?? null;
    this.#getOwnerScopeKey = options.getOwnerScopeKey ?? activeOwnerScopeKey;
    this.#isOwnerScopeCurrent =
      options.isOwnerScopeCurrent ??
      ((ownerScopeKey) =>
        !isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerScopeKey);
    this.#recordingLauncher = options.recordingLauncher ?? createRecordingLauncher();
  }

  #captureOwnerScope(): IOSSimulatorMediaOwnerScope {
    return {
      ownerScopeKey: this.#getOwnerScopeKey(),
      ingestDb: this.#customIngest ? null : (tryGetDbClient()?.drizzle ?? null),
    };
  }

  #assertOwnerScopeCurrent(scope: IOSSimulatorMediaOwnerScope): void {
    if (!this.#isOwnerScopeCurrent(scope.ownerScopeKey)) {
      throw new IOSSimulatorInstanceError(
        'RECORDING_NOT_FOUND',
        'The simulator media request was cancelled because its data owner changed.',
        true,
      );
    }
  }

  #assertScreenshotCurrent(request: ActiveScreenshotRequest): void {
    if (
      this.#closed ||
      this.#ingestPoisoned ||
      request.cancelled ||
      this.#epoch(this.#sessionEpochs, request.sessionId) !== request.sessionEpoch
    ) {
      throw new IOSSimulatorInstanceError(
        'MUTATION_CANCELLED',
        'The simulator screenshot was cancelled while its task was closing.',
        true,
      );
    }
    this.#assertOwnerScopeCurrent(request.ownerScope);
  }

  #ingestMedia(
    params: IngestMediaParams,
    scope: IOSSimulatorMediaOwnerScope,
  ): Promise<IngestedMedia> {
    const callerGuard = params.assertStillValid;
    const guardedParams: IngestMediaParams = {
      ...params,
      assertStillValid: () => {
        this.#assertOwnerScopeCurrent(scope);
        callerGuard?.();
      },
    };
    guardedParams.assertStillValid?.();
    if (this.#customIngest) return this.#customIngest(guardedParams);
    if (!scope.ingestDb) {
      throw new IOSSimulatorInstanceError(
        'RECORDING_FAILED',
        'The simulator media database is not ready.',
        true,
      );
    }
    return ingestMedia(
      {
        ...guardedParams,
        refCompensationScope: captureMediaRefCompensationScope(scope.ownerScopeKey),
      },
      scope.ingestDb,
    );
  }

  #serializeRecordingOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#recordingOperationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#recordingOperationTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#recordingOperationTails.get(sessionId) === tail) {
        this.#recordingOperationTails.delete(sessionId);
      }
    });
    return result;
  }

  #epoch(epochs: Map<string, number>, key: string): number {
    return epochs.get(key) ?? 0;
  }

  #advanceEpoch(epochs: Map<string, number>, key: string): void {
    epochs.set(key, this.#epoch(epochs, key) + 1);
  }

  #assertRecordingCurrent(recording: ActiveRecording): void {
    if (
      this.#closed ||
      this.#ingestPoisoned ||
      recording.discardRequested ||
      this.#epoch(this.#sessionEpochs, recording.sessionId) !== recording.sessionEpoch ||
      this.#epoch(this.#instanceEpochs, recording.instanceId) !== recording.instanceEpoch ||
      !this.#isOwnerScopeCurrent(recording.ownerScopeKey)
    ) {
      throw new IOSSimulatorInstanceError(
        'RECORDING_NOT_FOUND',
        'The simulator recording was discarded while its task or instance was closing.',
        true,
      );
    }
  }

  #markDiscardRequested(recording: ActiveRecording): void {
    if (!recording.discardRequested) {
      recording.discardRequested = true;
      recording.resolveDiscarded();
    }
  }

  #awaitRecordingIngest(
    recording: ActiveRecording,
    operation: Promise<IngestedMedia>,
  ): Promise<IngestedMedia> {
    return new Promise<IngestedMedia>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        this.#ingestPoisoned = true;
        this.#markDiscardRequested(recording);
        finish(() =>
          reject(
            new IOSSimulatorInstanceError(
              'RECORDING_FAILED',
              'The simulator recording could not be saved before the bounded timeout.',
              true,
            ),
          ),
        );
      }, RECORDING_INGEST_TIMEOUT_MS);
      void recording.discarded.then(() => {
        finish(() => {
          try {
            this.#assertRecordingCurrent(recording);
          } catch (error) {
            reject(error);
          }
        });
      });
      void operation.then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  #trackRawIngest(
    sessionId: string,
    instanceId: string,
    operation: Promise<IngestedMedia>,
  ): Promise<IngestedMedia> {
    const completion = operation.then(
      () => undefined,
      () => undefined,
    );
    const sessionSet = this.#rawIngestsBySession.get(sessionId) ?? new Set();
    const instanceSet = this.#rawIngestsByInstance.get(instanceId) ?? new Set();
    sessionSet.add(completion);
    instanceSet.add(completion);
    this.#rawIngestsBySession.set(sessionId, sessionSet);
    this.#rawIngestsByInstance.set(instanceId, instanceSet);
    void completion.then(() => {
      sessionSet.delete(completion);
      instanceSet.delete(completion);
      if (sessionSet.size === 0) this.#rawIngestsBySession.delete(sessionId);
      if (instanceSet.size === 0) this.#rawIngestsByInstance.delete(instanceId);
    });
    return operation;
  }

  #awaitScreenshotRequest(
    request: ActiveScreenshotRequest,
    operation: Promise<IngestedMedia>,
  ): Promise<IngestedMedia> {
    return new Promise<IngestedMedia>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };
      void request.cancelledSignal.then(() => {
        finish(() => {
          try {
            this.#assertScreenshotCurrent(request);
          } catch (error) {
            reject(error);
          }
        });
      });
      void operation.then(
        (result) =>
          finish(() => {
            try {
              this.#assertScreenshotCurrent(request);
              resolve(result);
            } catch (error) {
              reject(error);
            }
          }),
        (error) => finish(() => reject(error)),
      );
    });
  }

  #awaitScreenshotIngest(
    request: ActiveScreenshotRequest,
    operation: Promise<IngestedMedia>,
  ): Promise<IngestedMedia> {
    return new Promise<IngestedMedia>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        this.#ingestPoisoned = true;
        request.cancelled = true;
        finish(() =>
          reject(
            new IOSSimulatorInstanceError(
              'SCREENSHOT_CAPTURE_FAILED',
              'The simulator screenshot could not be saved before the bounded timeout.',
              true,
            ),
          ),
        );
      }, RECORDING_INGEST_TIMEOUT_MS);
      void request.cancelledSignal.then(() => {
        finish(() => {
          try {
            this.#assertScreenshotCurrent(request);
          } catch (error) {
            reject(error);
          }
        });
      });
      void operation.then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  #requestScreenshotDiscard(
    matches: (request: ActiveScreenshotRequest) => boolean = () => true,
  ): ActiveScreenshotRequest[] {
    const requests = Array.from(this.#screenshotRequestsBySession.values())
      .flatMap((items) => [...items])
      .filter(matches);
    for (const request of requests) {
      if (request.cancelled) continue;
      request.cancelled = true;
      request.resolveCancelled();
    }
    return requests;
  }

  #awaitRawIngestQuiescence(operations: Iterable<Promise<void>>, scope: string): Promise<void> {
    const pending = [...operations];
    if (pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        this.#ingestPoisoned = true;
        finish(() =>
          reject(
            new IOSSimulatorInstanceError(
              'RECORDING_FAILED',
              `The simulator recording store did not become idle before ${scope} cleanup timed out.`,
              true,
            ),
          ),
        );
      }, RECORDING_INGEST_TIMEOUT_MS);
      void Promise.all(pending).then(
        () => finish(resolve),
        (error) => finish(() => reject(error)),
      );
    });
  }

  #requestDiscard(matches: (recording: ActiveRecording) => boolean = () => true): void {
    for (const recording of this.#recordings.values()) {
      if (!matches(recording)) continue;
      this.#markDiscardRequested(recording);
      if (!recording.discardSignalSent) {
        recording.discardSignalSent = true;
        // Discard never preserves the MOV. Kill immediately so one finalizing
        // recorder cannot hold Desktop teardown while another remains active.
        signalRecordingProcess(recording.process, 'SIGKILL');
      }
    }
  }

  async #discardMatching(
    matches: (recording: ActiveRecording) => boolean = () => true,
  ): Promise<void> {
    const recordings = Array.from(this.#recordings.values()).filter(matches);
    const stuckRecordingIds: string[] = [];
    await Promise.all(
      recordings.map(async (recording) => {
        const exited = recording.discardSignalSent
          ? await waitForRecordingExit(recording.process, RECORDING_KILL_TIMEOUT_MS)
          : (await terminateRecordingProcess(recording.process, 'discard')) !== 'stuck';
        if (!exited) {
          // Keep the process and temp path tracked so a later lifecycle pass can
          // retry SIGKILL. Clearing the signal latch lets #requestDiscard send
          // another kill instead of treating the first unconfirmed signal as
          // completed cleanup.
          recording.discardSignalSent = false;
          stuckRecordingIds.push(recording.recordingId);
          return;
        }
        this.#recordings.delete(recording.recordingId);
        await rm(recording.tempRoot, { recursive: true, force: true });
      }),
    );
    if (stuckRecordingIds.length > 0) {
      throw new IOSSimulatorInstanceError(
        'RECORDING_FAILED',
        'One or more simulator recording processes did not confirm exit after SIGKILL.',
        true,
      );
    }
  }

  async captureScreenshotBytes(
    input: Pick<IOSSimulatorScreenshotInput, 'simulatorUdid' | 'signal'>,
  ): Promise<Buffer> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-screenshot-'));
    const screenshotPath = path.join(tempRoot, 'screenshot.png');
    try {
      const result = await this.#runner.run(
        'xcrun',
        ['simctl', 'io', input.simulatorUdid, 'screenshot', '--type=png', screenshotPath],
        { timeoutMs: 30_000, maxBufferBytes: 256 * 1024, signal: input.signal },
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          'SCREENSHOT_CAPTURE_FAILED',
          'The simulator screenshot could not be captured.',
          true,
        );
      }
      const info = await stat(screenshotPath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_SCREENSHOT_BYTES) {
        throw new IOSSimulatorInstanceError(
          'SCREENSHOT_CAPTURE_FAILED',
          'The simulator screenshot is invalid.',
        );
      }
      const buffer = await readFile(screenshotPath);
      if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new IOSSimulatorInstanceError(
          'SCREENSHOT_CAPTURE_FAILED',
          'The simulator screenshot is not a PNG image.',
        );
      }
      return buffer;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async takeScreenshot(input: IOSSimulatorScreenshotInput): Promise<IngestedMedia> {
    const ownerScope = this.#captureOwnerScope();
    let resolveCancelled: () => void = () => undefined;
    const request: ActiveScreenshotRequest = {
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      sessionEpoch: this.#epoch(this.#sessionEpochs, input.sessionId),
      ownerScope,
      cancelled: false,
      cancelledSignal: new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      }),
      resolveCancelled: () => resolveCancelled(),
    };
    const requests = this.#screenshotRequestsBySession.get(input.sessionId) ?? new Set();
    requests.add(request);
    this.#screenshotRequestsBySession.set(input.sessionId, requests);
    const cancelForAbortedMutation = (): void => {
      if (request.cancelled) return;
      request.cancelled = true;
      request.resolveCancelled();
    };
    if (input.signal?.aborted) cancelForAbortedMutation();
    else input.signal?.addEventListener('abort', cancelForAbortedMutation, { once: true });
    const operation = (async (): Promise<IngestedMedia> => {
      this.#assertScreenshotCurrent(request);
      const buffer = await this.captureScreenshotBytes(input);
      this.#assertScreenshotCurrent(request);
      const ingestOperation = this.#trackRawIngest(
        input.sessionId,
        input.instanceId,
        this.#ingestMedia(
          {
            buffer,
            mimeType: 'image/png',
            refs: [
              {
                refKind: 'session-attachment',
                refId: input.sessionId,
                originSessionId: input.sessionId,
                originKind: input.source === 'agent' ? 'tool' : 'user',
                originId: input.instanceId,
                label: 'iOS Simulator screenshot',
              },
            ],
            assertStillValid: () => this.#assertScreenshotCurrent(request),
          },
          ownerScope,
        ),
      );
      const ingested = await this.#awaitScreenshotIngest(request, ingestOperation);
      this.#assertScreenshotCurrent(request);
      return ingested;
    })();
    try {
      return await this.#awaitScreenshotRequest(request, operation);
    } finally {
      input.signal?.removeEventListener('abort', cancelForAbortedMutation);
      requests.delete(request);
      if (requests.size === 0) this.#screenshotRequestsBySession.delete(input.sessionId);
    }
  }

  async startRecording(input: {
    simulatorUdid: string;
    sessionId: string;
    instanceId: string;
    generation: number;
    source: 'agent' | 'user';
  }): Promise<{ recordingId: string; startedAt: string }> {
    if (this.#ingestPoisoned) {
      throw new IOSSimulatorInstanceError(
        'RECORDING_FAILED',
        'The simulator media store is unavailable until Cindy restarts.',
        true,
      );
    }
    const ownerScope = this.#captureOwnerScope();
    this.#assertOwnerScopeCurrent(ownerScope);
    const sessionEpoch = this.#epoch(this.#sessionEpochs, input.sessionId);
    const instanceEpoch = this.#epoch(this.#instanceEpochs, input.instanceId);
    this.#instanceSessions.set(input.instanceId, input.sessionId);
    return this.#serializeRecordingOperation(input.sessionId, async () => {
      if (this.#closed || this.#ingestPoisoned) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_FAILED',
          'The simulator media service is shutting down.',
          true,
        );
      }
      this.#assertOwnerScopeCurrent(ownerScope);
      if (
        this.#epoch(this.#sessionEpochs, input.sessionId) !== sessionEpoch ||
        this.#epoch(this.#instanceEpochs, input.instanceId) !== instanceEpoch
      ) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_NOT_FOUND',
          'The simulator recording request was cancelled while its task or instance was closing.',
          true,
        );
      }
      const abandonedStart = (recording: ActiveRecording): boolean =>
        recording.instanceId === input.instanceId &&
        recording.phase === 'starting' &&
        recording.discardRequested;
      if (Array.from(this.#recordings.values()).some(abandonedStart)) {
        this.#requestDiscard(abandonedStart);
        await this.#discardMatching(abandonedStart);
      }
      if (
        Array.from(this.#recordings.values()).some((item) => item.instanceId === input.instanceId)
      ) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_ALREADY_ACTIVE',
          'This simulator already has an active recording.',
        );
      }
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-recording-'));
      const videoPath = path.join(tempRoot, 'recording.mov');
      const recordingId = randomUUID();
      let recording: ActiveRecording | null = null;
      try {
        if (
          this.#closed ||
          this.#ingestPoisoned ||
          this.#epoch(this.#sessionEpochs, input.sessionId) !== sessionEpoch ||
          this.#epoch(this.#instanceEpochs, input.instanceId) !== instanceEpoch
        ) {
          throw new IOSSimulatorInstanceError(
            'RECORDING_NOT_FOUND',
            'The simulator recording request was cancelled while its task or instance was closing.',
            true,
          );
        }
        this.#assertOwnerScopeCurrent(ownerScope);
        let resolveDiscarded: () => void = () => undefined;
        const discarded = new Promise<void>((resolve) => {
          resolveDiscarded = resolve;
        });
        const process = this.#recordingLauncher.launch([
          'simctl',
          'io',
          input.simulatorUdid,
          'recordVideo',
          '--codec=h264',
          videoPath,
        ]);
        recording = {
          ...input,
          recordingId,
          tempRoot,
          videoPath,
          process,
          phase: 'starting',
          discardRequested: false,
          discardSignalSent: false,
          discarded,
          resolveDiscarded,
          sessionEpoch,
          instanceEpoch,
          ownerScopeKey: ownerScope.ownerScopeKey,
          ingestDb: ownerScope.ingestDb,
        };
        this.#recordings.set(recordingId, recording);
        const startup = await waitForRecordingStartup(process, RECORDING_STARTUP_TIMEOUT_MS);
        let startupError: unknown = null;
        try {
          this.#assertRecordingCurrent(recording);
        } catch (error) {
          startupError = error;
        }
        if (!startupError && startup === 'exited') {
          startupError = new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            'The recording process exited before capture became ready.',
            true,
          );
        }
        if (!startupError && startup === 'timeout') {
          startupError = new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            'The recording process did not process its first frame before the startup timeout.',
            true,
          );
        }
        if (!startupError && process.isAlive) {
          try {
            if (!process.isAlive()) {
              startupError = new IOSSimulatorInstanceError(
                'RECORDING_FAILED',
                'The recording process exited before capture became ready.',
                true,
              );
            }
          } catch {
            startupError = new IOSSimulatorInstanceError(
              'RECORDING_FAILED',
              'The recording process could not be verified after startup.',
              true,
            );
          }
        }
        if (startupError) {
          const matches = (candidate: ActiveRecording): boolean => candidate === recording;
          this.#requestDiscard(matches);
          await this.#discardMatching(matches);
          throw startupError;
        }
        recording.phase = 'active';
        return { recordingId, startedAt: new Date().toISOString() };
      } catch (error) {
        if (!recording) {
          await rm(tempRoot, { recursive: true, force: true });
        }
        throw error;
      }
    });
  }

  async stopRecording(input: {
    recordingId: string;
    sessionId: string;
    instanceId: string;
    generation: number;
  }): Promise<IngestedMedia> {
    return this.#serializeRecordingOperation(input.sessionId, async () => {
      const recording = this.#recordings.get(input.recordingId);
      if (
        !recording ||
        recording.sessionId !== input.sessionId ||
        recording.instanceId !== input.instanceId ||
        recording.generation !== input.generation
      ) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_NOT_FOUND',
          'The simulator recording does not exist for this current instance generation.',
        );
      }
      recording.phase = 'finalizing';
      let processExitConfirmed = false;
      try {
        const termination = await terminateRecordingProcess(recording.process, 'finalize');
        processExitConfirmed = termination !== 'stuck';
        if (termination !== 'finalized') {
          throw new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            termination === 'stuck'
              ? 'The simulator recording process could not be stopped safely.'
              : 'The simulator recording could not be finalized safely.',
            true,
          );
        }
        this.#assertRecordingCurrent(recording);
        const info = await stat(recording.videoPath);
        if (!info.isFile() || info.size <= 0 || info.size > MAX_BUFFERED_RECORDING_BYTES) {
          throw new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            'The simulator recording is invalid.',
          );
        }
        const buffer = await readFile(recording.videoPath);
        this.#assertRecordingCurrent(recording);
        const ingestOperation = this.#trackRawIngest(
          recording.sessionId,
          recording.instanceId,
          this.#ingestMedia(
            {
              buffer,
              mimeType: 'video/quicktime',
              refs: [
                {
                  refKind: 'session-attachment',
                  refId: recording.sessionId,
                  originSessionId: recording.sessionId,
                  originKind: recording.source === 'agent' ? 'tool' : 'user',
                  originId: recording.instanceId,
                  label: 'iOS Simulator recording',
                },
              ],
              assertStillValid: () => this.#assertRecordingCurrent(recording),
            },
            {
              ownerScopeKey: recording.ownerScopeKey,
              ingestDb: recording.ingestDb,
            },
          ),
        );
        return await this.#awaitRecordingIngest(recording, ingestOperation);
      } finally {
        if (processExitConfirmed) {
          this.#recordings.delete(recording.recordingId);
          await rm(recording.tempRoot, { recursive: true, force: true });
        }
      }
    });
  }

  async discardInstance(instanceId: string): Promise<void> {
    const matches = (recording: ActiveRecording) => recording.instanceId === instanceId;
    let sessionId = this.#instanceSessions.get(instanceId);
    this.#advanceEpoch(this.#instanceEpochs, instanceId);
    const screenshotRequests = this.#requestScreenshotDiscard(
      (request) => request.instanceId === instanceId,
    );
    sessionId ??= screenshotRequests[0]?.sessionId;
    this.#requestDiscard(matches);
    if (!sessionId) {
      await this.#discardMatching(matches);
      await this.#awaitRawIngestQuiescence(
        this.#rawIngestsByInstance.get(instanceId) ?? [],
        'instance',
      );
      return;
    }
    return this.#serializeRecordingOperation(sessionId, async () => {
      await this.#discardMatching(matches);
      await this.#awaitRawIngestQuiescence(
        this.#rawIngestsByInstance.get(instanceId) ?? [],
        'instance',
      );
      this.#instanceSessions.delete(instanceId);
    });
  }

  async discardSession(sessionId: string): Promise<void> {
    const matches = (recording: ActiveRecording) => recording.sessionId === sessionId;
    this.#advanceEpoch(this.#sessionEpochs, sessionId);
    this.#requestScreenshotDiscard((request) => request.sessionId === sessionId);
    this.#requestDiscard(matches);
    return this.#serializeRecordingOperation(sessionId, async () => {
      await this.#discardMatching(matches);
      await this.#awaitRawIngestQuiescence(this.#rawIngestsBySession.get(sessionId) ?? [], 'task');
      for (const [instanceId, boundSessionId] of this.#instanceSessions) {
        if (boundSessionId === sessionId) this.#instanceSessions.delete(instanceId);
      }
    });
  }

  /** Graceful Host teardown closes the gate before waiting for in-flight starts. */
  async dispose(): Promise<void> {
    this.#closed = true;
    this.#requestScreenshotDiscard();
    this.#requestDiscard();
    await Promise.all([...this.#recordingOperationTails.values()]);
    const rawIngestQuiescence = this.#awaitRawIngestQuiescence(
      Array.from(this.#rawIngestsBySession.values()).flatMap((operations) => [...operations]),
      'host',
    ).then(
      () => null,
      (error: unknown) => error,
    );
    let firstError: unknown = null;
    try {
      await this.#discardMatching();
    } catch (error) {
      firstError = error;
    }
    firstError ??= await rawIngestQuiescence;
    this.#instanceSessions.clear();
    if (firstError) throw firstError;
  }

  /** Updater force-quit cannot await cleanup, so synchronously kill every group. */
  abortOperationsForExit(): void {
    this.#closed = true;
    this.#requestScreenshotDiscard();
    for (const recording of this.#recordings.values()) {
      this.#markDiscardRequested(recording);
      if (!recording.discardSignalSent) {
        recording.discardSignalSent = true;
        signalRecordingProcess(recording.process, 'SIGKILL');
      }
      try {
        rmSync(recording.tempRoot, { recursive: true, force: true });
      } catch {
        // The next graceful cleanup attempt remains bounded and idempotent.
      }
    }
  }
}

/** Decode two PNG screenshots in main and return bounded pixel metrics only. */
export async function compareIOSSimulatorPngBuffers(
  baseline: Uint8Array,
  current: Uint8Array,
  threshold = 16,
): Promise<IOSSimulatorPixelDiff> {
  try {
    const [before, after] = await Promise.all([
      sharp(baseline).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(current).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    return compareIOSSimulatorRgbaImages(
      { width: before.info.width, height: before.info.height, data: before.data },
      { width: after.info.width, height: after.info.height, data: after.data },
      { threshold },
    );
  } catch (error) {
    if (error instanceof IOSSimulatorInstanceError) throw error;
    throw new IOSSimulatorInstanceError(
      'SCREENSHOT_CAPTURE_FAILED',
      'The simulator screenshots could not be decoded for visual comparison.',
    );
  }
}
