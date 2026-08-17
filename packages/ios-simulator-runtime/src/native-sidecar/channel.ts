import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type {
  IOSSimulatorNativeFrame,
  IOSSimulatorStreamStats,
} from "../driver.js";
import type {
  IOSSimulatorNativeSidecarTransport,
  IOSSimulatorNativeSidecarCommand,
} from "./adapter.js";
import {
  decodeIOSSimulatorNativeSidecarJson,
  decodeIOSSimulatorNativeSidecarStreamFrame,
  encodeIOSSimulatorNativeSidecarJson,
  IOSSimulatorNativeSidecarFrameDecoder,
  IOSSimulatorNativeSidecarMessageKind,
  IOSSimulatorNativeSidecarProtocolError,
  type IOSSimulatorNativeSidecarStreamEnd,
  type IOSSimulatorNativeSidecarFrame,
} from "./protocol.js";
import { validateIOSimulatorNativeFrame } from "./frame-validation.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 2;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const MAX_EARLY_STREAM_EVENTS_PER_STREAM = 4;
const MAX_EARLY_STREAMS = 8;
const MAX_EARLY_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_CLOSED_STREAMS = 64;
const MAX_LOCALLY_SETTLED_REQUESTS = 256;

export type IOSSimulatorNativeSidecarChannelState =
  "idle" | "running" | "failed" | "parked" | "stopped";

export type IOSSimulatorNativeSidecarTerminationReasonCode =
  | "launch-failed"
  | "process-error"
  | "process-exit"
  | "stdout-closed"
  | "protocol-error"
  | "request-timeout"
  | "write-failed";

/** Raw channel-local evidence. Callers must sanitize text before exposing it. */
export interface IOSSimulatorNativeSidecarTermination {
  reasonCode: IOSSimulatorNativeSidecarTerminationReasonCode;
  message: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  occurredAt: string;
  stderrTail: string;
}

export interface IOSSimulatorNativeSidecarManagedProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves only after the process and its inherited stdio handles close. */
  readonly exited: Promise<void>;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface IOSSimulatorNativeSidecarProcessLauncher {
  launch(): IOSSimulatorNativeSidecarManagedProcess;
}

export interface IOSSimulatorNativeSidecarNodeLauncherOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function createNodeIOSSimulatorNativeSidecarLauncher(
  options: IOSSimulatorNativeSidecarNodeLauncherOptions,
): IOSSimulatorNativeSidecarProcessLauncher {
  return {
    launch() {
      const child: ChildProcessWithoutNullStreams = spawn(
        options.command,
        options.args ?? [],
        {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      return new NodeIOSSimulatorNativeSidecarManagedProcess(child);
    },
  };
}

/** Ensures a detached POSIX sidecar is terminated as a process group. */
class NodeIOSSimulatorNativeSidecarManagedProcess implements IOSSimulatorNativeSidecarManagedProcess {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
  }

  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(
    event: "error" | "exit",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    if (event === "error") {
      this.child.once("error", listener as (error: Error) => void);
    } else {
      this.child.once(
        "exit",
        listener as (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => void,
      );
    }
    return this;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (process.platform !== "win32" && this.pid !== undefined) {
      try {
        process.kill(-this.pid, signal);
        return true;
      } catch {
        // The process may have exited between the state check and group kill.
      }
    }
    return this.child.kill(signal);
  }
}

export interface IOSSimulatorNativeSidecarChannelOptions {
  launcher: IOSSimulatorNativeSidecarProcessLauncher;
  requestTimeoutMs?: number;
  maxCrashes?: number;
  maxConsecutiveTimeouts?: number;
  restartBaseDelayMs?: number;
  stopTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export class IOSSimulatorNativeSidecarChannelError extends Error {
  constructor(
    readonly code:
      | "UNAVAILABLE"
      | "TIMEOUT"
      | "ABORTED"
      | "PROTOCOL_ERROR"
      | "PARKED"
      | "TERMINATION_FAILED"
      | "PROCESS_EXITED",
    message: string,
  ) {
    super(message);
    this.name = "IOSSimulatorNativeSidecarChannelError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
}

interface StreamState {
  streamId: string;
  command: IOSSimulatorNativeSidecarCommand;
  maxFrames?: number;
  maxFrameBytes?: number;
  acknowledgeFrames: boolean;
  awaitStreamEndAfterMaxFrames: boolean;
  requireContiguousSequence: boolean;
  onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
  frameCount: number;
  byteCount: number;
  lastSequence: number | null;
  startedAt: string;
  firstFrameAt: string | null;
  tail: Promise<void>;
  finished: boolean;
  stopping: boolean;
  removeAbortListener: () => void;
  resolve(stats: IOSSimulatorStreamStats): void;
  reject(error: unknown): void;
}

type DecodedStreamFrame = ReturnType<
  typeof decodeIOSSimulatorNativeSidecarStreamFrame
>;

type EarlyStreamEvent =
  | { kind: "frame"; frame: DecodedStreamFrame }
  | { kind: "end"; end: IOSSimulatorNativeSidecarStreamEnd };

function abortError(): IOSSimulatorNativeSidecarChannelError {
  return new IOSSimulatorNativeSidecarChannelError(
    "ABORTED",
    "Native sidecar request was aborted.",
  );
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IOSSimulatorNativeSidecarChannelError(
      "UNAVAILABLE",
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IOSSimulatorNativeSidecarChannelError(
      "PROTOCOL_ERROR",
      `Native sidecar reply field ${name} is invalid`,
    );
  }
  return value;
}

function streamEnd(
  value: Record<string, unknown>,
): IOSSimulatorNativeSidecarStreamEnd {
  const reason = value.reason;
  if (
    reason !== "max-frames" &&
    reason !== "aborted" &&
    reason !== "eof" &&
    reason !== "error"
  ) {
    throw new IOSSimulatorNativeSidecarChannelError(
      "PROTOCOL_ERROR",
      "Native sidecar stream end reason is invalid",
    );
  }
  return {
    streamId: readString(value.streamId, "streamId"),
    simulatorUdid: readString(value.simulatorUdid, "simulatorUdid"),
    generation:
      typeof value.generation === "number" &&
      Number.isSafeInteger(value.generation) &&
      value.generation > 0
        ? value.generation
        : (() => {
            throw new IOSSimulatorNativeSidecarChannelError(
              "PROTOCOL_ERROR",
              "Native sidecar stream generation is invalid",
            );
          })(),
    reason,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

/**
 * Bounded stdio multiplexer for one sidecar process. The process is injected so
 * tests and future signed-binary launchers share exactly the same protocol code.
 */
export class IOSSimulatorNativeSidecarChannel implements IOSSimulatorNativeSidecarTransport {
  readonly #options: Required<
    Pick<
      IOSSimulatorNativeSidecarChannelOptions,
      | "requestTimeoutMs"
      | "maxCrashes"
      | "maxConsecutiveTimeouts"
      | "restartBaseDelayMs"
      | "stopTimeoutMs"
    >
  > &
    Pick<IOSSimulatorNativeSidecarChannelOptions, "sleep" | "now">;
  readonly #launcher: IOSSimulatorNativeSidecarProcessLauncher;
  #decoder = new IOSSimulatorNativeSidecarFrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #locallySettledRequestIds = new Set<string>();
  readonly #streams = new Map<string, StreamState>();
  readonly #earlyStreamEvents = new Map<string, EarlyStreamEvent[]>();
  readonly #closedStreams = new Map<
    string,
    { simulatorUdid: string; generation: number }
  >();
  #process: IOSSimulatorNativeSidecarManagedProcess | null = null;
  #state: IOSSimulatorNativeSidecarChannelState = "idle";
  #requestSequence = 0;
  #crashCount = 0;
  #consecutiveTimeouts = 0;
  #stderr = "";
  #lastTermination: IOSSimulatorNativeSidecarTermination | null = null;
  #lastTerminationProcess: IOSSimulatorNativeSidecarManagedProcess | null =
    null;
  #earlyStreamBytes = 0;
  #stopRequested = false;
  #stopPromise: Promise<void> | null = null;
  #stoppingProcess: IOSSimulatorNativeSidecarManagedProcess | null = null;

  constructor(options: IOSSimulatorNativeSidecarChannelOptions) {
    this.#launcher = options.launcher;
    this.#options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxCrashes: options.maxCrashes ?? DEFAULT_MAX_CRASHES,
      maxConsecutiveTimeouts:
        options.maxConsecutiveTimeouts ?? DEFAULT_MAX_CONSECUTIVE_TIMEOUTS,
      restartBaseDelayMs:
        options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      sleep: options.sleep,
      now: options.now,
    };
    requirePositiveInteger(this.#options.requestTimeoutMs, "requestTimeoutMs");
    requirePositiveInteger(this.#options.maxCrashes, "maxCrashes");
    requirePositiveInteger(
      this.#options.maxConsecutiveTimeouts,
      "maxConsecutiveTimeouts",
    );
    requirePositiveInteger(
      this.#options.restartBaseDelayMs,
      "restartBaseDelayMs",
    );
    requirePositiveInteger(this.#options.stopTimeoutMs, "stopTimeoutMs");
  }

  get state(): IOSSimulatorNativeSidecarChannelState {
    return this.#state;
  }

  get crashCount(): number {
    return this.#crashCount;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  get lastTermination(): IOSSimulatorNativeSidecarTermination | null {
    return this.#lastTermination ? { ...this.#lastTermination } : null;
  }

  /** Resolves only after a quarantined process has actually closed. */
  get retirement(): Promise<void> | null {
    return this.#stoppingProcess?.exited ?? null;
  }

  async start(): Promise<void> {
    if (this.#stopPromise) await this.#stopPromise;
    if (this.#stoppingProcess) throw this.#terminationFailedError();
    if (this.#state === "running" && this.#process) return;
    if (this.#state === "parked") {
      throw new IOSSimulatorNativeSidecarChannelError(
        "PARKED",
        "Native sidecar is parked after repeated crashes; re-arm is required.",
      );
    }
    this.#stopRequested = false;
    let process: IOSSimulatorNativeSidecarManagedProcess;
    this.#stderr = "";
    try {
      process = this.#launcher.launch();
    } catch (error) {
      const wrapped = new IOSSimulatorNativeSidecarChannelError(
        "PROCESS_EXITED",
        `Unable to launch native sidecar: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.#recordTermination(wrapped, { reasonCode: "launch-failed" });
      this.#lastTerminationProcess = null;
      this.#recordCrash();
      throw wrapped;
    }
    this.#process = process;
    this.#state = "running";
    this.#locallySettledRequestIds.clear();
    this.#decoderReset();
    process.stdout.on("data", (chunk: Buffer | Uint8Array | string) => {
      try {
        const bytes =
          typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk);
        for (const frame of this.#decoder.push(bytes)) this.#handleFrame(frame);
      } catch (error) {
        this.#terminateProcess(
          process,
          error instanceof IOSSimulatorNativeSidecarChannelError
            ? error
            : new IOSSimulatorNativeSidecarChannelError(
                "PROTOCOL_ERROR",
                error instanceof Error ? error.message : String(error),
              ),
          true,
          { reasonCode: "protocol-error" },
        );
      }
    });
    process.stdout.once("end", () => {
      try {
        this.#decoder.finish();
      } catch (error) {
        this.#terminateProcess(
          process,
          new IOSSimulatorNativeSidecarChannelError(
            "PROTOCOL_ERROR",
            error instanceof Error ? error.message : String(error),
          ),
          true,
          { reasonCode: "protocol-error" },
        );
        return;
      }
      this.#terminateProcess(
        process,
        new IOSSimulatorNativeSidecarChannelError(
          "PROCESS_EXITED",
          "Native sidecar stdout closed.",
        ),
        true,
        { reasonCode: "stdout-closed" },
      );
    });
    process.stderr.on("data", (chunk: Buffer | Uint8Array | string) => {
      const text =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      this.#stderr = `${this.#stderr}${text}`;
      if (Buffer.byteLength(this.#stderr) > MAX_STDERR_TAIL_BYTES) {
        this.#stderr = this.#stderr.slice(-MAX_STDERR_TAIL_BYTES);
      }
    });
    process.once("error", (error) =>
      this.#terminateProcess(
        process,
        new IOSSimulatorNativeSidecarChannelError(
          "PROCESS_EXITED",
          `Native sidecar process error: ${error.message}`,
        ),
        true,
        { reasonCode: "process-error" },
      ),
    );
    process.once("exit", (code, signal) => {
      if (
        this.#process !== process &&
        this.#lastTerminationProcess === process
      ) {
        this.#augmentTerminationExit(code, signal);
        return;
      }
      this.#terminateProcess(
        process,
        new IOSSimulatorNativeSidecarChannelError(
          "PROCESS_EXITED",
          `Native sidecar exited (${signal ?? code ?? "unknown"}).`,
        ),
        false,
        { reasonCode: "process-exit", exitCode: code, signal },
      );
    });
  }

  async restart(): Promise<void> {
    if (this.#state === "parked") {
      throw new IOSSimulatorNativeSidecarChannelError(
        "PARKED",
        "Native sidecar is parked; call rearm before restarting.",
      );
    }
    if (this.#state === "running") return;
    const sleep =
      this.#options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const delay =
      this.#options.restartBaseDelayMs *
      2 ** Math.min(Math.max(this.#crashCount - 1, 0), 5);
    await sleep(delay);
    await this.start();
  }

  rearm(): void {
    if (this.#process || this.#stoppingProcess) return;
    this.#crashCount = 0;
    this.#consecutiveTimeouts = 0;
    this.#state = "idle";
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    const process = this.#process;
    this.#process = null;
    this.#state = "stopped";
    this.#rejectAll(
      new IOSSimulatorNativeSidecarChannelError(
        "ABORTED",
        "Native sidecar channel stopped.",
      ),
    );
    if (process) return this.#ensureProcessClosed(process, true);
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#stoppingProcess) throw this.#terminationFailedError();
  }

  /** Synchronously kill both active and already-stopping process groups. */
  abortOperationsForExit(): void {
    this.#stopRequested = true;
    this.#state = "stopped";
    this.#rejectAll(
      new IOSSimulatorNativeSidecarChannelError(
        "ABORTED",
        "Native sidecar channel aborted for Host exit.",
      ),
    );
    const processes = new Set([
      ...(this.#process ? [this.#process] : []),
      ...(this.#stoppingProcess ? [this.#stoppingProcess] : []),
    ]);
    this.#process = null;
    for (const process of processes) {
      try {
        process.kill("SIGKILL");
      } catch {
        // The process may have exited between collection and termination.
      }
    }
  }

  #ensureProcessClosed(
    process: IOSSimulatorNativeSidecarManagedProcess,
    terminate: boolean,
  ): Promise<void> {
    if (this.#stopPromise && this.#stoppingProcess === process) {
      return this.#stopPromise;
    }
    if (this.#stopPromise) {
      return this.#stopPromise.then(() =>
        this.#ensureProcessClosed(process, terminate),
      );
    }
    this.#stoppingProcess = process;
    void process.exited
      .then(() => {
        if (this.#stoppingProcess === process) {
          this.#stoppingProcess = null;
        }
      })
      .catch(() => undefined);
    const operation = terminate
      ? this.#terminateStoppedProcess(process)
      : process.exited;
    const stopPromise = operation.finally(() => {
      if (this.#stopPromise === stopPromise) {
        this.#stopPromise = null;
      }
    });
    this.#stopPromise = stopPromise;
    return stopPromise;
  }

  async #terminateStoppedProcess(
    process: IOSSimulatorNativeSidecarManagedProcess,
  ): Promise<void> {
    const terminated = this.#waitForProcessExit(
      process,
      this.#options.stopTimeoutMs,
    );
    process.kill("SIGTERM");
    if (await terminated) return;
    const killed = this.#waitForProcessExit(
      process,
      this.#options.stopTimeoutMs,
    );
    process.kill("SIGKILL");
    if (!(await killed)) throw this.#terminationFailedError();
  }

  #terminationFailedError(): IOSSimulatorNativeSidecarChannelError {
    return new IOSSimulatorNativeSidecarChannelError(
      "TERMINATION_FAILED",
      "Native sidecar process did not terminate after SIGKILL.",
    );
  }

  #waitForProcessExit(
    process: IOSSimulatorNativeSidecarManagedProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(false);
      }, timeoutMs);
      void process.exited.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  request(
    command: IOSSimulatorNativeSidecarCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#sendRequest(command, signal);
  }

  async streamFrames(
    command: IOSSimulatorNativeSidecarCommand,
    options: {
      signal?: AbortSignal;
      maxFrames?: number;
      maxFrameBytes?: number;
      acknowledgeFrames?: boolean;
      awaitStreamEndAfterMaxFrames?: boolean;
      requireContiguousSequence?: boolean;
      onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
    },
  ): Promise<IOSSimulatorStreamStats> {
    if (options.signal?.aborted) throw abortError();
    if (
      options.maxFrames !== undefined &&
      (!Number.isSafeInteger(options.maxFrames) || options.maxFrames <= 0)
    ) {
      throw new IOSSimulatorNativeSidecarChannelError(
        "UNAVAILABLE",
        "maxFrames must be a positive safe integer",
      );
    }
    if (
      options.maxFrameBytes !== undefined &&
      (!Number.isSafeInteger(options.maxFrameBytes) ||
        options.maxFrameBytes <= 0)
    ) {
      throw new IOSSimulatorNativeSidecarChannelError(
        "UNAVAILABLE",
        "maxFrameBytes must be a positive safe integer",
      );
    }
    // A stream start reply establishes the id needed for deterministic
    // cancellation. Do not orphan that reply by aborting the request itself;
    // register the returned stream first, then stop it through stopStream.
    const result = await this.#sendRequest(command);
    if (!isRecord(result)) {
      throw new IOSSimulatorNativeSidecarChannelError(
        "PROTOCOL_ERROR",
        `Native sidecar ${command.op} reply must be an object`,
      );
    }
    const streamId = readString(result.streamId, "streamId");
    const startedAt = this.#timestamp();
    let resolve!: (stats: IOSSimulatorStreamStats) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<IOSSimulatorStreamStats>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const state: StreamState = {
      streamId,
      command,
      maxFrames: options.maxFrames,
      maxFrameBytes: options.maxFrameBytes,
      acknowledgeFrames: options.acknowledgeFrames === true,
      awaitStreamEndAfterMaxFrames:
        options.awaitStreamEndAfterMaxFrames === true,
      requireContiguousSequence: options.requireContiguousSequence === true,
      onFrame: options.onFrame,
      frameCount: 0,
      byteCount: 0,
      lastSequence: null,
      startedAt,
      firstFrameAt: null,
      tail: Promise.resolve(),
      finished: false,
      stopping: false,
      removeAbortListener: () => undefined,
      resolve,
      reject,
    };
    if (this.#streams.has(streamId) || this.#closedStreams.has(streamId)) {
      throw new IOSSimulatorNativeSidecarChannelError(
        "PROTOCOL_ERROR",
        `Native sidecar reused stream id ${streamId}`,
      );
    }
    this.#streams.set(streamId, state);
    if (options.signal) {
      if (options.signal.aborted) {
        void this.#stopStream(state);
      } else {
        const onAbort = () => {
          void this.#stopStream(state);
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        state.removeAbortListener = () =>
          options.signal?.removeEventListener("abort", onAbort);
      }
    }
    this.#drainEarlyStreamEvents(state);
    return promise;
  }

  #sendRequest(
    command: IOSSimulatorNativeSidecarCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.#state !== "running" || !this.#process) {
      return Promise.reject(
        new IOSSimulatorNativeSidecarChannelError(
          this.#state === "parked" ? "PARKED" : "UNAVAILABLE",
          this.#state === "parked"
            ? "Native sidecar is parked; re-arm is required."
            : "Native sidecar process is not running.",
        ),
      );
    }
    const id = `sidecar-${++this.#requestSequence}`;
    const request = encodeIOSSimulatorNativeSidecarJson({ ...command, id });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.removeAbortListener();
        this.#rememberLocallySettledRequest(id);
        const error = new IOSSimulatorNativeSidecarChannelError(
          "TIMEOUT",
          `Native sidecar request ${command.op} timed out.`,
        );
        reject(error);
        this.#consecutiveTimeouts += 1;
        if (this.#consecutiveTimeouts >= this.#options.maxConsecutiveTimeouts) {
          this.#terminateProcess(this.#process, error, true);
        }
      }, this.#options.requestTimeoutMs);
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(timeout);
        this.#pending.delete(id);
        pending.removeAbortListener();
        this.#rememberLocallySettledRequest(id);
        pending.reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        timeout,
        removeAbortListener: () =>
          signal?.removeEventListener("abort", onAbort),
      });
      try {
        const process = this.#process;
        process?.stdin.write(request, (error?: Error | null) => {
          if (!error) return;
          this.#terminateProcess(
            process,
            new IOSSimulatorNativeSidecarChannelError(
              "PROCESS_EXITED",
              `Unable to write to native sidecar: ${error.message}`,
            ),
            true,
            { reasonCode: "write-failed" },
          );
        });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(
          new IOSSimulatorNativeSidecarChannelError(
            "UNAVAILABLE",
            `Unable to write to native sidecar: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  #handleFrame(frame: IOSSimulatorNativeSidecarFrame): void {
    if (frame.kind === IOSSimulatorNativeSidecarMessageKind.Json) {
      const reply = decodeIOSSimulatorNativeSidecarJson(frame);
      const id = readString(reply.id, "id");
      const pending = this.#pending.get(id);
      if (!pending && this.#locallySettledRequestIds.delete(id)) return;
      if (!pending)
        throw new IOSSimulatorNativeSidecarProtocolError(
          `Unknown reply id ${id}`,
        );
      // Validate while the request is still registered. A protocol fault
      // terminates the sidecar and #rejectAll must still be able to settle this
      // promise instead of leaving startup or an operation hung forever.
      if (reply.ok !== true && reply.ok !== false) {
        throw new IOSSimulatorNativeSidecarProtocolError(
          `Reply ${id} has invalid ok field`,
        );
      }
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.removeAbortListener();
      this.#consecutiveTimeouts = 0;
      if (reply.ok) {
        pending.resolve(reply.result);
      } else {
        const error = isRecord(reply.error) ? reply.error : null;
        pending.reject(
          new IOSSimulatorNativeSidecarChannelError(
            "PROTOCOL_ERROR",
            typeof error?.message === "string"
              ? error.message
              : `Native sidecar request ${id} failed.`,
          ),
        );
      }
      return;
    }
    if (frame.kind === IOSSimulatorNativeSidecarMessageKind.StreamFrame) {
      const decoded = decodeIOSSimulatorNativeSidecarStreamFrame(frame);
      const state = this.#streams.get(decoded.metadata.streamId);
      if (!state) {
        if (this.#closedStreams.has(decoded.metadata.streamId)) {
          throw new IOSSimulatorNativeSidecarProtocolError(
            `Native sidecar emitted a frame for closed stream ${decoded.metadata.streamId}`,
          );
        }
        this.#bufferEarlyStreamEvent(
          decoded.metadata.streamId,
          {
            kind: "frame",
            frame: decoded,
          },
          decoded.bytes.byteLength,
        );
        return;
      }
      this.#handleDecodedStreamFrame(state, decoded);
      return;
    }
    if (frame.kind === IOSSimulatorNativeSidecarMessageKind.StreamEnd) {
      const end = streamEnd(decodeIOSSimulatorNativeSidecarJson(frame));
      const state = this.#streams.get(end.streamId);
      if (!state) {
        const closed = this.#closedStreams.get(end.streamId);
        if (closed) {
          if (
            closed.simulatorUdid !== end.simulatorUdid ||
            closed.generation !== end.generation
          ) {
            throw new IOSSimulatorNativeSidecarProtocolError(
              "Native sidecar closed-stream identity does not match",
            );
          }
          return;
        }
        this.#bufferEarlyStreamEvent(end.streamId, { kind: "end", end }, 0);
        return;
      }
      this.#handleDecodedStreamEnd(state, end);
      return;
    }
    throw new IOSSimulatorNativeSidecarProtocolError(
      `Unsupported native sidecar message kind ${String(frame.kind)}`,
    );
  }

  #handleDecodedStreamFrame(
    state: StreamState,
    decoded: DecodedStreamFrame,
  ): void {
    if (
      decoded.metadata.simulatorUdid !== state.command.simulatorUdid ||
      decoded.metadata.generation !== state.command.generation
    ) {
      throw new IOSSimulatorNativeSidecarProtocolError(
        "Native sidecar stream identity does not match the request",
      );
    }
    if (
      state.requireContiguousSequence &&
      decoded.metadata.sequence !==
        (state.lastSequence === null ? 0 : state.lastSequence + 1)
    ) {
      this.#sendStopStream(state);
      this.#rejectStream(
        state,
        new IOSSimulatorNativeSidecarProtocolError(
          "Native sidecar stream sequence is not contiguous",
        ),
      );
      return;
    }
    state.lastSequence = decoded.metadata.sequence;
    if (state.stopping) return;
    if (
      state.maxFrameBytes !== undefined &&
      decoded.bytes.byteLength > state.maxFrameBytes
    ) {
      void this.#stopStream(state, "error");
      return;
    }
    state.tail = state.tail
      .then(async () => {
        if (state.finished) return;
        if (
          state.awaitStreamEndAfterMaxFrames &&
          state.maxFrames !== undefined &&
          state.frameCount >= state.maxFrames
        ) {
          throw new IOSSimulatorNativeSidecarProtocolError(
            "Native sidecar emitted a frame after the declared maximum",
          );
        }
        const receivedAt = this.#timestamp();
        state.frameCount += 1;
        state.byteCount += decoded.bytes.byteLength;
        state.firstFrameAt ??= receivedAt;
        const frameValue: IOSSimulatorNativeFrame =
          decoded.metadata.encoding === "h264"
            ? {
                encoding: "h264",
                sequence: decoded.metadata.sequence,
                format: decoded.metadata.h264Format!,
                bytes: decoded.bytes,
                receivedAt,
                width: decoded.metadata.width,
                height: decoded.metadata.height,
                orientation: decoded.metadata.orientation,
                scale: decoded.metadata.scale,
                colorSpace: decoded.metadata.colorSpace,
                timestampMicros: decoded.metadata.timestampMicros,
                keyFrame: decoded.metadata.keyFrame === true,
              }
            : {
                encoding: "bgra",
                sequence: decoded.metadata.sequence,
                bytes: decoded.bytes,
                receivedAt,
                width: decoded.metadata.width,
                height: decoded.metadata.height,
                bytesPerRow: decoded.metadata.bytesPerRow!,
                orientation: decoded.metadata.orientation,
                scale: decoded.metadata.scale,
                colorSpace: decoded.metadata.colorSpace,
                timestampMicros: decoded.metadata.timestampMicros,
              };
        validateIOSimulatorNativeFrame(frameValue, {
          maxFrameBytes: state.maxFrameBytes,
        });
        await state.onFrame(frameValue);
        if (state.stopping) return;
        if (state.acknowledgeFrames) {
          await this.#sendRequest({
            version: 1,
            op: "ackStreamFrame",
            simulatorUdid: state.command.simulatorUdid,
            generation: state.command.generation,
            params: {
              streamId: state.streamId,
              sequence: decoded.metadata.sequence,
            },
          });
        }
        if (state.stopping) return;
        if (
          state.maxFrames !== undefined &&
          state.frameCount >= state.maxFrames
        ) {
          if (state.awaitStreamEndAfterMaxFrames) return;
          this.#sendStopStream(state);
          this.#finishStream(state, "max-frames");
        }
      })
      .catch((error) => {
        if (state.stopping) return;
        this.#sendStopStream(state);
        this.#rejectStream(state, error);
      });
  }

  #handleDecodedStreamEnd(
    state: StreamState,
    end: IOSSimulatorNativeSidecarStreamEnd,
  ): void {
    if (
      end.simulatorUdid !== state.command.simulatorUdid ||
      end.generation !== state.command.generation
    ) {
      throw new IOSSimulatorNativeSidecarProtocolError(
        "Native sidecar stream end identity does not match the request",
      );
    }
    state.tail = state.tail.then(() => {
      this.#finishStream(state, end.reason, end.message);
    });
  }

  #bufferEarlyStreamEvent(
    streamId: string,
    event: EarlyStreamEvent,
    byteCount: number,
  ): void {
    if (this.#closedStreams.has(streamId)) {
      throw new IOSSimulatorNativeSidecarProtocolError(
        `Native sidecar emitted an event for closed stream ${streamId}`,
      );
    }
    const events = this.#earlyStreamEvents.get(streamId);
    if (
      (!events && this.#earlyStreamEvents.size >= MAX_EARLY_STREAMS) ||
      (events && events.length >= MAX_EARLY_STREAM_EVENTS_PER_STREAM) ||
      this.#earlyStreamBytes + byteCount > MAX_EARLY_STREAM_BYTES
    ) {
      throw new IOSSimulatorNativeSidecarProtocolError(
        "Native sidecar emitted too many frames before stream registration",
      );
    }
    const next = events ?? [];
    next.push(event);
    this.#earlyStreamEvents.set(streamId, next);
    this.#earlyStreamBytes += byteCount;
  }

  #drainEarlyStreamEvents(state: StreamState): void {
    const events = this.#earlyStreamEvents.get(state.streamId);
    if (!events) return;
    this.#earlyStreamEvents.delete(state.streamId);
    for (const event of events) {
      this.#earlyStreamBytes -=
        event.kind === "frame" ? event.frame.bytes.byteLength : 0;
      if (event.kind === "frame")
        this.#handleDecodedStreamFrame(state, event.frame);
      else this.#handleDecodedStreamEnd(state, event.end);
    }
  }

  async #stopStream(
    state: StreamState,
    reason: "aborted" | "max-frames" | "error" = "aborted",
  ): Promise<void> {
    if (state.finished || state.stopping) return;
    state.stopping = true;
    this.#sendStopStream(state);
    state.tail = state.tail.then(() => {
      this.#finishStream(state, reason);
    });
  }

  #sendStopStream(state: StreamState): void {
    void this.#sendRequest({
      version: 1,
      op: "stopStream",
      simulatorUdid: state.command.simulatorUdid,
      generation: state.command.generation,
      params: { streamId: state.streamId },
    }).catch(() => undefined);
  }

  #finishStream(
    state: StreamState,
    reason: IOSSimulatorStreamStats["endReason"],
    message?: string,
  ): void {
    if (state.finished) return;
    state.finished = true;
    state.removeAbortListener();
    this.#streams.delete(state.streamId);
    this.#rememberClosedStream(state);
    state.resolve({
      frameCount: state.frameCount,
      byteCount: state.byteCount,
      startedAt: state.startedAt,
      firstFrameAt: state.firstFrameAt,
      endedAt: this.#timestamp(),
      endReason: reason,
      ...(message ? { endMessage: message } : {}),
    });
  }

  #rejectStream(state: StreamState, error: unknown): void {
    if (state.finished) return;
    state.finished = true;
    state.removeAbortListener();
    this.#streams.delete(state.streamId);
    this.#rememberClosedStream(state);
    state.reject(error);
  }

  #rememberClosedStream(state: StreamState): void {
    this.#closedStreams.delete(state.streamId);
    this.#closedStreams.set(state.streamId, {
      simulatorUdid: state.command.simulatorUdid,
      generation: state.command.generation,
    });
    while (this.#closedStreams.size > MAX_CLOSED_STREAMS) {
      const oldest = this.#closedStreams.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.#closedStreams.delete(oldest);
    }
  }

  #recordCrash(): void {
    this.#crashCount += 1;
    this.#state =
      this.#crashCount >= this.#options.maxCrashes ? "parked" : "failed";
  }

  #terminateProcess(
    process: IOSSimulatorNativeSidecarManagedProcess | null,
    error: IOSSimulatorNativeSidecarChannelError,
    kill: boolean,
    termination: {
      reasonCode: IOSSimulatorNativeSidecarTerminationReasonCode;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    } = {
      reasonCode:
        error.code === "TIMEOUT" ? "request-timeout" : "process-error",
    },
  ): void {
    if (!process || this.#process !== process) return;
    this.#process = null;
    if (this.#stopRequested) {
      this.#state = "stopped";
    } else {
      this.#recordTermination(error, termination);
      this.#lastTerminationProcess = process;
      this.#recordCrash();
    }
    this.#rejectAll(error);
    void this.#ensureProcessClosed(process, kill).catch(() => undefined);
  }

  #recordTermination(
    error: IOSSimulatorNativeSidecarChannelError,
    termination: {
      reasonCode: IOSSimulatorNativeSidecarTerminationReasonCode;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    },
  ): void {
    this.#lastTermination = {
      reasonCode: termination.reasonCode,
      message: error.message,
      exitCode: termination.exitCode ?? null,
      signal: termination.signal ?? null,
      occurredAt: this.#timestamp(),
      stderrTail: this.#stderr,
    };
  }

  #augmentTerminationExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!this.#lastTermination) return;
    this.#lastTermination = {
      ...this.#lastTermination,
      exitCode,
      signal,
      stderrTail: this.#stderr,
    };
  }

  #rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const stream of this.#streams.values()) {
      stream.finished = true;
      stream.removeAbortListener();
      stream.reject(error);
    }
    this.#streams.clear();
    this.#earlyStreamEvents.clear();
    this.#closedStreams.clear();
    this.#earlyStreamBytes = 0;
  }

  /**
   * The Helper cannot cancel a command that already crossed stdio. Keep a
   * bounded one-reply tombstone so an expected late reply cannot be mistaken
   * for protocol desynchronization after local abort or timeout.
   */
  #rememberLocallySettledRequest(id: string): void {
    this.#locallySettledRequestIds.add(id);
    while (this.#locallySettledRequestIds.size > MAX_LOCALLY_SETTLED_REQUESTS) {
      const oldest = this.#locallySettledRequestIds.values().next().value;
      if (oldest === undefined) break;
      this.#locallySettledRequestIds.delete(oldest);
    }
  }

  #timestamp(): string {
    return (this.#options.now ?? (() => new Date()))().toISOString();
  }

  #decoderReset(): void {
    // The decoder is immutable by design; a fresh process receives a fresh
    // instance through this replacement to avoid carrying partial bytes over.
    this.#decoder = new IOSSimulatorNativeSidecarFrameDecoder();
  }
}
