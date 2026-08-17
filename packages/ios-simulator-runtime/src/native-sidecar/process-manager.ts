import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
  applyIOSSimulatorNativeCapabilityAdmission,
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
  type IOSSimulatorNativeCapabilityAdmissionDecision,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
} from "../capability-admission.js";
import type {
  IOSSimulatorDriverCapabilities,
  IOSSimulatorNativeSidecarDriver,
} from "../driver.js";
import {
  IOSSimulatorNativeSidecarAdapter,
  type IOSSimulatorNativeSidecarCommand,
  type IOSSimulatorNativeSidecarTransport,
} from "./adapter.js";
import {
  createNodeIOSSimulatorNativeSidecarLauncher,
  IOSSimulatorNativeSidecarChannel,
  type IOSSimulatorNativeSidecarChannelState,
  type IOSSimulatorNativeSidecarTermination,
  type IOSSimulatorNativeSidecarTerminationReasonCode,
} from "./channel.js";
import { IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION } from "./protocol.js";
import {
  createIOSSimulatorNativeSidecarSandboxFailureDiagnostics,
  createIOSSimulatorNativeSidecarSandboxLaunchPlan,
  createIOSSimulatorNativeSidecarSandboxPolicy,
  createIOSSimulatorNativeSidecarUnsandboxedDiagnostics,
  IOSSimulatorNativeSidecarSandboxError,
  type IOSSimulatorNativeSidecarSandboxDiagnostics,
  type IOSSimulatorNativeSidecarSandboxPolicy,
} from "./sandbox.js";
import {
  iosSimulatorNativeDevelopmentSidecarPath,
  iosSimulatorPackagedHelperExecutablePath,
} from "./layout.js";

export interface IOSSimulatorNativeSidecarManagedChannel extends IOSSimulatorNativeSidecarTransport {
  readonly state: IOSSimulatorNativeSidecarChannelState;
  readonly crashCount: number;
  readonly stderrTail: string;
  readonly lastTermination: IOSSimulatorNativeSidecarTermination | null;
  /** Present while an unsuccessfully terminated process still owns the slot. */
  readonly retirement: Promise<void> | null;
  start(): Promise<void>;
  restart(): Promise<void>;
  rearm(): void;
  stop(): Promise<void>;
  abortOperationsForExit?(): void;
}

export interface IOSSimulatorNativeSidecarStartOptions {
  instanceId: string;
  simulatorUdid: string;
  generation: number;
  runtime?: {
    runtimeIdentifier: string;
    runtimeBuildVersion: string | null;
    xcodeBuild: string;
    architecture: "arm64" | "x86_64";
  };
}

export interface IOSSimulatorNativeSidecarRecoverOptions {
  /** Explicit user-driven recovery may re-arm a channel parked by its crash budget. */
  rearm?: boolean;
}

export interface IOSSimulatorNativeSidecarHandshake {
  protocolVersion: number;
  simulatorUdid: string;
  generation: number;
  ready: boolean;
  message: string | null;
  capabilities: Readonly<IOSSimulatorDriverCapabilities>;
  probe: IOSSimulatorNativeSidecarProbe | null;
}

export interface IOSSimulatorNativeSidecarProbe {
  coreSimulatorLoaded: boolean;
  simulatorKitLoaded: boolean;
  deviceDiscovery: boolean;
  framebufferSymbols: boolean;
  framebufferCapture: boolean;
  framebuffer: IOSSimulatorNativeFramebufferMetadata | null;
  hid: boolean;
}

export interface IOSSimulatorNativeFramebufferMetadata {
  width: number;
  height: number;
  bytesPerRow: number;
  byteCount: number;
  screenId: number;
  pixelFormat: "BGRA";
}

export interface IOSSimulatorNativeSidecarDiagnostics {
  running: boolean;
  state: IOSSimulatorNativeSidecarChannelState;
  crashCount: number;
  probe: IOSSimulatorNativeSidecarProbe | null;
  lastFailure: string | null;
  lastTermination: IOSSimulatorNativeSidecarTerminationDiagnostics | null;
  admission: IOSSimulatorNativeCapabilityAdmissionDecision | null;
  sandbox?: IOSSimulatorNativeSidecarSandboxDiagnostics;
}

export interface IOSSimulatorNativeSidecarTerminationDiagnostics {
  reasonCode: IOSSimulatorNativeSidecarTerminationReasonCode;
  message: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  occurredAt: string;
  /** Bounded and redacted; raw channel stderr never crosses this boundary. */
  stderrTail: string | null;
}

export interface IOSSimulatorNativeSidecarRunningInstance {
  instanceId: string;
  simulatorUdid: string;
  generation: number;
  adapter: IOSSimulatorNativeSidecarDriver;
  handshake: IOSSimulatorNativeSidecarHandshake;
  admission: IOSSimulatorNativeCapabilityAdmissionDecision;
  startedAt: string;
}

interface InternalRunningInstance extends IOSSimulatorNativeSidecarRunningInstance {
  startInput: IOSSimulatorNativeSidecarStartOptions;
  channel: IOSSimulatorNativeSidecarManagedChannel;
  policy: IOSSimulatorNativeCapabilityAdmissionPolicy;
  sandbox: IOSSimulatorNativeSidecarSandboxLaunchState;
}

interface PendingSidecarOperation {
  input: IOSSimulatorNativeSidecarStartOptions;
  promise?: Promise<IOSSimulatorNativeSidecarRunningInstance>;
  channel?: IOSSimulatorNativeSidecarManagedChannel;
  policy?: IOSSimulatorNativeCapabilityAdmissionPolicy;
  sandbox?: IOSSimulatorNativeSidecarSandboxLaunchState;
  stopRequested: boolean;
}

interface RetiringSidecarOperation {
  channel: IOSSimulatorNativeSidecarManagedChannel;
  sandbox: IOSSimulatorNativeSidecarSandboxLaunchState;
  policy?: IOSSimulatorNativeCapabilityAdmissionPolicy;
  detectedCapabilities?: Readonly<IOSSimulatorDriverCapabilities>;
  exited: boolean;
  finalizing?: Promise<void>;
}

interface IOSSimulatorNativeSidecarSandboxLaunchState {
  diagnostics: IOSSimulatorNativeSidecarSandboxDiagnostics;
  temporaryDirectory: string | null;
}

export interface IOSSimulatorNativeSidecarProcessManagerOptions {
  binaryPath: string;
  /**
   * Development/test shortcut used only when admissionPolicy is omitted.
   */
  enableH264Stream?: boolean;
  /**
   * Development/test shortcut used only when admissionPolicy is omitted.
   */
  enableContinuousInput?: boolean;
  /**
   * Host-owned policy. A resolver may use the exact runtime identity without
   * trusting any renderer, agent, plugin, or sidecar-provided decision.
   */
  admissionPolicy?:
    | IOSSimulatorNativeCapabilityAdmissionPolicy
    | ((
        input: IOSSimulatorNativeSidecarStartOptions,
      ) => IOSSimulatorNativeCapabilityAdmissionPolicy);
  createChannel?: (
    input: IOSSimulatorNativeSidecarStartOptions,
  ) => IOSSimulatorNativeSidecarManagedChannel;
  /**
   * Host-owned final integrity check performed immediately before every spawn
   * or restart. Packaged hosts use it to close the artifact-resolution TOCTOU
   * window; development harnesses may omit it.
   */
  verifyBinaryIntegrity?: () => void | Promise<void>;
  environment?: NodeJS.ProcessEnv;
  /**
   * Product hosts provide a required macOS policy. Internal correctness
   * harnesses may omit this until they explicitly opt into OS sandboxing.
   */
  sandboxPolicy?: IOSSimulatorNativeSidecarSandboxPolicy;
  now?: () => Date;
}

export class IOSSimulatorNativeSidecarProcessManagerError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARGUMENT"
      | "BINARY_UNAVAILABLE"
      | "ARTIFACT_CHANGED"
      | "HANDSHAKE_FAILED"
      | "ADMISSION_DENIED"
      | "SANDBOX_UNAVAILABLE"
      | "SANDBOX_UNSUPPORTED_PLATFORM"
      | "SANDBOX_PROFILE_INVALID"
      | "TERMINATION_FAILED"
      | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "IOSSimulatorNativeSidecarProcessManagerError";
  }
}

function safeProcessManagerFailure(
  error: unknown,
  fallbackMessage: string,
): IOSSimulatorNativeSidecarProcessManagerError {
  if (error instanceof IOSSimulatorNativeSidecarProcessManagerError) {
    return error;
  }
  return new IOSSimulatorNativeSidecarProcessManagerError(
    "UNAVAILABLE",
    fallbackMessage,
  );
}

function safeNativeSidecarDiagnosticText(
  value: string,
  maxLength: number,
): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "<redacted-url>")
    .replace(
      /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|\/Applications\/|\/Library\/)[^\s"'(),;]+/g,
      "<redacted-path>",
    )
    .replace(
      /\b(authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2<redacted>",
    )
    .slice(-maxLength);
}

function safeNativeSidecarTermination(
  termination: IOSSimulatorNativeSidecarTermination,
): IOSSimulatorNativeSidecarTerminationDiagnostics {
  const stderrTail = safeNativeSidecarDiagnosticText(
    termination.stderrTail,
    8_000,
  ).trim();
  return {
    reasonCode: termination.reasonCode,
    message: safeNativeSidecarDiagnosticText(termination.message, 2_000),
    exitCode: termination.exitCode,
    signal: termination.signal,
    occurredAt: termination.occurredAt,
    stderrTail: stderrTail || null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireIdentity(input: IOSSimulatorNativeSidecarStartOptions): void {
  if (!input.instanceId.trim() || !input.simulatorUdid.trim()) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "INVALID_ARGUMENT",
      "instanceId and simulatorUdid are required",
    );
  }
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "INVALID_ARGUMENT",
      "generation must be a positive safe integer",
    );
  }
}

function sameStartIdentity(
  left: IOSSimulatorNativeSidecarStartOptions,
  right: IOSSimulatorNativeSidecarStartOptions,
): boolean {
  if (
    left.instanceId !== right.instanceId ||
    left.simulatorUdid !== right.simulatorUdid ||
    left.generation !== right.generation
  ) {
    return false;
  }
  if (!left.runtime || !right.runtime) {
    return left.runtime === right.runtime;
  }
  return (
    left.runtime.runtimeIdentifier === right.runtime.runtimeIdentifier &&
    left.runtime.runtimeBuildVersion === right.runtime.runtimeBuildVersion &&
    left.runtime.xcodeBuild === right.runtime.xcodeBuild &&
    left.runtime.architecture === right.runtime.architecture
  );
}

function copyStartInput(
  input: IOSSimulatorNativeSidecarStartOptions,
): IOSSimulatorNativeSidecarStartOptions {
  return {
    ...input,
    runtime: input.runtime ? { ...input.runtime } : undefined,
  };
}

function readCapabilities(value: unknown): IOSSimulatorDriverCapabilities {
  if (!isRecord(value)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar handshake capabilities are missing",
    );
  }
  const keys = [
    "accessibility",
    "sessions",
    "jpegStream",
    "h264Stream",
    "bgraStream",
    "discreteInput",
    "continuousInput",
    "multiTouch",
  ] as const satisfies readonly (keyof IOSSimulatorDriverCapabilities)[];
  const capabilities = {} as IOSSimulatorDriverCapabilities;
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "HANDSHAKE_FAILED",
        `Native sidecar capability ${key} is invalid`,
      );
    }
    capabilities[key] = value[key];
  }
  if (
    capabilities.accessibility ||
    capabilities.sessions ||
    capabilities.jpegStream
  ) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar cannot claim semantic, session, or JPEG ownership",
    );
  }
  if (capabilities.multiTouch && !capabilities.continuousInput) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar multiTouch requires continuousInput",
    );
  }
  return Object.freeze(capabilities);
}

function readProbe(value: unknown): IOSSimulatorNativeSidecarProbe | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar probe report is invalid",
    );
  }
  const keys = [
    "coreSimulatorLoaded",
    "simulatorKitLoaded",
    "deviceDiscovery",
    "framebufferSymbols",
    "framebufferCapture",
    "hid",
  ] as const;
  const probe = {} as Omit<IOSSimulatorNativeSidecarProbe, "framebuffer">;
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "HANDSHAKE_FAILED",
        `Native sidecar probe field ${key} is invalid`,
      );
    }
    probe[key] = value[key];
  }
  const framebuffer = readFramebufferMetadata(value.framebuffer);
  if (probe.framebufferCapture !== (framebuffer !== null)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar framebuffer probe metadata is inconsistent",
    );
  }
  if (probe.framebufferCapture && !probe.framebufferSymbols) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar framebuffer capture requires framebuffer symbols",
    );
  }
  return Object.freeze({ ...probe, framebuffer });
}

function readFramebufferMetadata(
  value: unknown,
): IOSSimulatorNativeFramebufferMetadata | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar framebuffer metadata is invalid",
    );
  }
  const positiveInteger = (field: string): number => {
    const candidate = value[field];
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate <= 0
    ) {
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "HANDSHAKE_FAILED",
        `Native sidecar framebuffer field ${field} is invalid`,
      );
    }
    return candidate;
  };
  const width = positiveInteger("width");
  const height = positiveInteger("height");
  const bytesPerRow = positiveInteger("bytesPerRow");
  const byteCount = positiveInteger("byteCount");
  const screenId = value.screenId;
  if (
    bytesPerRow < width * 4 ||
    byteCount !== bytesPerRow * height ||
    typeof screenId !== "number" ||
    !Number.isSafeInteger(screenId) ||
    screenId < 0 ||
    screenId > 16 ||
    value.pixelFormat !== "BGRA"
  ) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar framebuffer metadata is inconsistent",
    );
  }
  return Object.freeze({
    width,
    height,
    bytesPerRow,
    byteCount,
    screenId,
    pixelFormat: "BGRA",
  });
}

function readHandshake(
  value: unknown,
  expected: IOSSimulatorNativeSidecarStartOptions,
): IOSSimulatorNativeSidecarHandshake {
  if (!isRecord(value)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar handshake must be an object",
    );
  }
  if (value.protocolVersion !== IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar protocol version does not match the host",
    );
  }
  if (
    value.simulatorUdid !== expected.simulatorUdid ||
    value.generation !== expected.generation
  ) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar handshake identity does not match the requested simulator",
    );
  }
  if (typeof value.ready !== "boolean") {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar handshake readiness is invalid",
    );
  }
  if (
    value.message !== undefined &&
    value.message !== null &&
    typeof value.message !== "string"
  ) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "HANDSHAKE_FAILED",
      "Native sidecar handshake message is invalid",
    );
  }
  return {
    protocolVersion: value.protocolVersion,
    simulatorUdid: value.simulatorUdid,
    generation: value.generation,
    ready: value.ready,
    message: typeof value.message === "string" ? value.message : null,
    capabilities: readCapabilities(value.capabilities),
    probe: readProbe(value.probe),
  };
}

/** Returns only variables needed by the signed sidecar and strips DYLD injection. */
export function createIOSSimulatorNativeSidecarEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: source.LANG ?? "en_US.UTF-8",
  };
  for (const key of ["TMPDIR", "DEVELOPER_DIR", "LC_ALL"] as const) {
    if (source[key]) environment[key] = source[key];
  }
  return environment;
}

export function resolveIOSSimulatorNativeSidecarBinary(
  resourceRoot: string,
  architecture: "arm64" | "x86_64",
): string {
  if (!path.isAbsolute(resourceRoot)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "INVALID_ARGUMENT",
      "Native sidecar resource root must be absolute",
    );
  }
  return iosSimulatorNativeDevelopmentSidecarPath(resourceRoot, architecture);
}

export function resolveIOSSimulatorPackagedSidecarBinary(
  resourceRoot: string,
): string {
  if (!path.isAbsolute(resourceRoot)) {
    throw new IOSSimulatorNativeSidecarProcessManagerError(
      "INVALID_ARGUMENT",
      "Packaged native sidecar resource root must be absolute",
    );
  }
  return iosSimulatorPackagedHelperExecutablePath(resourceRoot);
}

export function createIOSSimulatorNativeSidecarArguments(
  input: IOSSimulatorNativeSidecarStartOptions,
  enableH264Stream = false,
  enableContinuousInput = false,
): string[] {
  requireIdentity(input);
  return [
    "--stdio",
    "--simulator-udid",
    input.simulatorUdid,
    "--generation",
    String(input.generation),
    ...(enableH264Stream ? ["--enable-h264-stream"] : []),
    ...(enableContinuousInput ? ["--enable-continuous-input"] : []),
  ];
}

/**
 * Owns one sidecar per simulator instance. A failed start never mutates WDA or
 * simulator ownership, so the caller can retain the deterministic MJPEG path.
 */
export class IOSSimulatorNativeSidecarProcessManager {
  readonly #options: IOSSimulatorNativeSidecarProcessManagerOptions;
  readonly #running = new Map<string, InternalRunningInstance>();
  readonly #starting = new Map<string, PendingSidecarOperation>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #retiring = new Map<string, RetiringSidecarOperation>();
  readonly #liveChannels = new Set<IOSSimulatorNativeSidecarManagedChannel>();
  readonly #lastProbe = new Map<
    string,
    IOSSimulatorNativeSidecarProbe | null
  >();
  readonly #lastFailure = new Map<string, string>();
  readonly #lastTermination = new Map<
    string,
    IOSSimulatorNativeSidecarTerminationDiagnostics
  >();
  readonly #lastAdmission = new Map<
    string,
    IOSSimulatorNativeCapabilityAdmissionDecision
  >();
  readonly #lastSandbox = new Map<
    string,
    IOSSimulatorNativeSidecarSandboxDiagnostics
  >();

  constructor(options: IOSSimulatorNativeSidecarProcessManagerOptions) {
    if (!path.isAbsolute(options.binaryPath)) {
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "INVALID_ARGUMENT",
        "Native sidecar binary path must be absolute",
      );
    }
    this.#options = options;
  }

  get(instanceId: string): IOSSimulatorNativeSidecarRunningInstance | null {
    const running = this.#running.get(instanceId);
    if (!running || running.channel.state !== "running") return null;
    const {
      startInput: _startInput,
      channel: _channel,
      policy: _policy,
      sandbox: _sandbox,
      ...safe
    } = running;
    return {
      ...safe,
      admission: this.admission(instanceId)!,
    };
  }

  admission(
    instanceId: string,
  ): IOSSimulatorNativeCapabilityAdmissionDecision | null {
    const running = this.#running.get(instanceId);
    if (!running) return this.#lastAdmission.get(instanceId) ?? null;
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: running.policy,
      detectedCapabilities: running.handshake.capabilities,
      processState: running.channel.state,
      now: this.#options.now,
    });
    this.#lastAdmission.set(instanceId, decision);
    return decision;
  }

  diagnostics(instanceId: string): IOSSimulatorNativeSidecarDiagnostics {
    const running = this.#running.get(instanceId);
    const admission = this.admission(instanceId);
    const channelTermination = running?.channel.lastTermination ?? null;
    if (channelTermination) {
      this.#lastTermination.set(
        instanceId,
        safeNativeSidecarTermination(channelTermination),
      );
    }
    const lastTermination = this.#lastTermination.get(instanceId) ?? null;
    return {
      running: running?.channel.state === "running",
      state: running?.channel.state ?? admission?.processState ?? "idle",
      crashCount: running?.channel.crashCount ?? 0,
      probe:
        running?.handshake.probe ?? this.#lastProbe.get(instanceId) ?? null,
      lastFailure:
        this.#lastFailure.get(instanceId) ??
        (running && running.channel.state !== "running"
          ? (lastTermination?.message ?? null)
          : null),
      lastTermination,
      admission,
      sandbox:
        running?.sandbox.diagnostics ??
        this.#lastSandbox.get(instanceId) ??
        createIOSSimulatorNativeSidecarUnsandboxedDiagnostics(),
    };
  }

  /** Best-effort synchronous child teardown for updater force-quit. */
  abortOperationsForExit(): void {
    for (const pending of this.#starting.values()) {
      pending.stopRequested = true;
    }
    for (const channel of this.#liveChannels) {
      try {
        channel.abortOperationsForExit?.();
      } catch {
        // Continue terminating the remaining exact channels.
      }
    }
  }

  start(
    input: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    requireIdentity(input);
    const stopping = this.#stopping.get(input.instanceId);
    if (stopping) return stopping.then(() => this.start(input));
    const retiring = this.#retiring.get(input.instanceId);
    if (retiring) return this.#resumeAfterRetiring(input, retiring);
    const running = this.#running.get(input.instanceId);
    if (running) {
      if (!sameStartIdentity(running.startInput, input)) {
        return Promise.reject(
          new IOSSimulatorNativeSidecarProcessManagerError(
            "HANDSHAKE_FAILED",
            "Native sidecar instance id is already bound to another identity",
          ),
        );
      }
      const active = this.get(input.instanceId);
      return active ? Promise.resolve(active) : this.recover(input);
    }
    const pending = this.#starting.get(input.instanceId);
    if (pending) {
      if (!sameStartIdentity(pending.input, input)) {
        return Promise.reject(
          new IOSSimulatorNativeSidecarProcessManagerError(
            "HANDSHAKE_FAILED",
            "Native sidecar instance id is already starting for another identity",
          ),
        );
      }
      return pending.promise!;
    }
    const starting: PendingSidecarOperation = {
      input: copyStartInput(input),
      stopRequested: false,
    };
    const operation = this.#start(input, starting).finally(() => {
      if (this.#starting.get(input.instanceId) === starting) {
        this.#starting.delete(input.instanceId);
      }
    });
    starting.promise = operation;
    this.#starting.set(input.instanceId, starting);
    return operation;
  }

  async #start(
    input: IOSSimulatorNativeSidecarStartOptions,
    operation: PendingSidecarOperation,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    this.#lastFailure.delete(input.instanceId);
    this.#lastTermination.delete(input.instanceId);
    const policy = this.#resolveAdmissionPolicy(input);
    operation.policy = policy;
    const preflight = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      processState: "idle",
      now: this.#options.now,
    });
    this.#lastAdmission.set(input.instanceId, preflight);
    if (!preflight.launch.allowed) {
      const error = new IOSSimulatorNativeSidecarProcessManagerError(
        "ADMISSION_DENIED",
        preflight.launch.reason,
      );
      this.#lastFailure.set(input.instanceId, error.message);
      throw error;
    }
    await this.#verifyBinaryIntegrity(input.instanceId);
    if (!this.#options.createChannel) {
      try {
        await access(this.#options.binaryPath, constants.X_OK);
      } catch {
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "BINARY_UNAVAILABLE",
          "Native sidecar executable is unavailable",
        );
      }
    }
    const sandbox = await this.#prepareSandbox(input, operation);
    const channel =
      this.#options.createChannel?.(input) ??
      new IOSSimulatorNativeSidecarChannel(
        this.#createChannelOptions(input, preflight, sandbox),
      );
    operation.channel = channel;
    this.#liveChannels.add(channel);
    try {
      await channel.start();
      if (operation.stopRequested) {
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "UNAVAILABLE",
          "Native sidecar startup was stopped.",
        );
      }
      const { adapter, handshake, admission } = await this.#activateChannel(
        channel,
        input,
        policy,
      );
      if (operation.stopRequested) {
        await adapter.detach().catch(() => undefined);
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "UNAVAILABLE",
          "Native sidecar startup was stopped.",
        );
      }
      const running: InternalRunningInstance = {
        instanceId: input.instanceId,
        simulatorUdid: input.simulatorUdid,
        generation: input.generation,
        startInput: copyStartInput(input),
        adapter,
        handshake,
        admission,
        startedAt: (this.#options.now ?? (() => new Date()))().toISOString(),
        channel,
        policy,
        sandbox,
      };
      this.#lastSandbox.set(input.instanceId, sandbox.diagnostics);
      this.#running.set(input.instanceId, running);
      return this.get(input.instanceId)!;
    } catch (error) {
      const channelTermination = channel.lastTermination;
      if (channelTermination) {
        this.#lastTermination.set(
          input.instanceId,
          safeNativeSidecarTermination(channelTermination),
        );
      }
      const failure = safeProcessManagerFailure(
        error,
        "Native sidecar process failed to start.",
      );
      const currentAdmission = this.#lastAdmission.get(input.instanceId);
      if (operation.stopRequested) {
        this.#lastAdmission.set(
          input.instanceId,
          evaluateIOSSimulatorNativeCapabilityAdmission({
            policy,
            processState: "stopped",
            now: this.#options.now,
          }),
        );
      } else if (
        currentAdmission?.processState !== "failed" &&
        currentAdmission?.processState !== "parked"
      ) {
        this.#lastAdmission.set(
          input.instanceId,
          evaluateIOSSimulatorNativeCapabilityAdmission({
            policy,
            processState: channel.state === "parked" ? "parked" : "failed",
            now: this.#options.now,
          }),
        );
      }
      if (operation.stopRequested) {
        this.#lastFailure.delete(input.instanceId);
      } else {
        this.#lastFailure.set(input.instanceId, failure.message);
        if (sandbox.diagnostics.enforced) {
          sandbox.diagnostics =
            createIOSSimulatorNativeSidecarSandboxFailureDiagnostics(
              "SANDBOX_PROCESS_FAILED",
            );
          this.#lastSandbox.set(input.instanceId, sandbox.diagnostics);
        }
      }
      let stopFailure: unknown;
      try {
        await this.#stopChannelOrRetire(
          input.instanceId,
          channel,
          sandbox,
          policy,
        );
      } catch (error) {
        stopFailure = error;
      }
      if (this.#retiring.has(input.instanceId)) throw stopFailure;
      try {
        await this.#disposeSandbox(sandbox);
      } finally {
        this.#liveChannels.delete(channel);
      }
      if (stopFailure) throw stopFailure;
      throw failure;
    }
  }

  recover(
    input: IOSSimulatorNativeSidecarStartOptions,
    options: IOSSimulatorNativeSidecarRecoverOptions = {},
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    requireIdentity(input);
    const stopping = this.#stopping.get(input.instanceId);
    if (stopping) {
      return stopping.then(() => this.recover(input, options));
    }
    const retiring = this.#retiring.get(input.instanceId);
    if (retiring) return this.#resumeAfterRetiring(input, retiring);
    const running = this.#running.get(input.instanceId);
    if (!running) return this.start(input);
    if (!sameStartIdentity(running.startInput, input)) {
      return Promise.reject(
        new IOSSimulatorNativeSidecarProcessManagerError(
          "HANDSHAKE_FAILED",
          "Native sidecar recovery identity does not match its existing binding",
        ),
      );
    }
    const active = this.get(input.instanceId);
    if (active) return Promise.resolve(active);
    const pending = this.#starting.get(input.instanceId);
    if (pending) return pending.promise!;
    const starting: PendingSidecarOperation = {
      input: copyStartInput(input),
      channel: running.channel,
      policy: running.policy,
      stopRequested: false,
    };
    const operation = this.#recover(running, input, options, starting).finally(
      () => {
        if (this.#starting.get(input.instanceId) === starting) {
          this.#starting.delete(input.instanceId);
        }
      },
    );
    starting.promise = operation;
    this.#starting.set(input.instanceId, starting);
    return operation;
  }

  async #recover(
    running: InternalRunningInstance,
    input: IOSSimulatorNativeSidecarStartOptions,
    options: IOSSimulatorNativeSidecarRecoverOptions,
    operation: PendingSidecarOperation,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    this.#lastFailure.delete(input.instanceId);
    let policy = running.policy;
    try {
      policy = this.#resolveAdmissionPolicy(input);
      operation.policy = policy;
      const preflight = evaluateIOSSimulatorNativeCapabilityAdmission({
        policy,
        detectedCapabilities: running.handshake.capabilities,
        processState: running.channel.state,
        now: this.#options.now,
      });
      this.#lastAdmission.set(input.instanceId, preflight);
      if (!preflight.launch.allowed) {
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "ADMISSION_DENIED",
          preflight.launch.reason,
        );
      }
      if (running.channel.state === "parked") {
        if (!options.rearm) {
          throw new IOSSimulatorNativeSidecarProcessManagerError(
            "UNAVAILABLE",
            "Native sidecar is parked after repeated crashes",
          );
        }
        running.channel.rearm();
      }
      if (operation.stopRequested) {
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "UNAVAILABLE",
          "Native sidecar recovery was stopped.",
        );
      }
      await this.#verifyBinaryIntegrity(input.instanceId);
      await running.channel.restart();
      if (operation.stopRequested) {
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "UNAVAILABLE",
          "Native sidecar recovery was stopped.",
        );
      }
      const { adapter, handshake, admission } = await this.#activateChannel(
        running.channel,
        input,
        policy,
      );
      if (operation.stopRequested) {
        await adapter.detach().catch(() => undefined);
        throw new IOSSimulatorNativeSidecarProcessManagerError(
          "UNAVAILABLE",
          "Native sidecar recovery was stopped.",
        );
      }
      if (admission.capabilities.continuousInput.active) {
        await running.channel.request({
          version: IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION,
          op: "releaseInput",
          simulatorUdid: input.simulatorUdid,
          generation: input.generation,
        });
      }
      running.adapter = adapter;
      running.handshake = handshake;
      running.admission = admission;
      running.policy = policy;
      running.startedAt = (
        this.#options.now ?? (() => new Date())
      )().toISOString();
      this.#lastSandbox.set(input.instanceId, running.sandbox.diagnostics);
      return this.get(input.instanceId)!;
    } catch (error) {
      const channelTermination = running.channel.lastTermination;
      if (channelTermination) {
        this.#lastTermination.set(
          input.instanceId,
          safeNativeSidecarTermination(channelTermination),
        );
      }
      const failure = safeProcessManagerFailure(
        error,
        operation.stopRequested
          ? "Native sidecar recovery was stopped."
          : "Native sidecar recovery failed.",
      );
      this.#lastAdmission.set(
        input.instanceId,
        evaluateIOSSimulatorNativeCapabilityAdmission({
          policy,
          detectedCapabilities: running.handshake.capabilities,
          processState: operation.stopRequested
            ? "stopped"
            : running.channel.state === "parked"
              ? "parked"
              : "failed",
          now: this.#options.now,
        }),
      );
      if (operation.stopRequested) {
        this.#lastFailure.delete(input.instanceId);
      } else {
        this.#lastFailure.set(input.instanceId, failure.message);
      }
      if (operation.stopRequested || running.channel.state !== "parked") {
        this.#running.delete(input.instanceId);
        let stopFailure: unknown;
        try {
          await this.#stopChannelOrRetire(
            input.instanceId,
            running.channel,
            running.sandbox,
            running.policy,
            running.handshake.capabilities,
          );
        } catch (stopError) {
          stopFailure = stopError;
        }
        if (this.#retiring.has(input.instanceId)) throw stopFailure;
        try {
          await this.#disposeSandbox(running.sandbox);
        } finally {
          this.#liveChannels.delete(running.channel);
        }
        if (stopFailure) throw stopFailure;
      }
      throw failure;
    }
  }

  async #activateChannel(
    channel: IOSSimulatorNativeSidecarManagedChannel,
    input: IOSSimulatorNativeSidecarStartOptions,
    policy: IOSSimulatorNativeCapabilityAdmissionPolicy,
  ): Promise<{
    adapter: IOSSimulatorNativeSidecarDriver;
    handshake: IOSSimulatorNativeSidecarHandshake;
    admission: IOSSimulatorNativeCapabilityAdmissionDecision;
  }> {
    const command: IOSSimulatorNativeSidecarCommand = {
      version: IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION,
      op: "handshake",
      simulatorUdid: input.simulatorUdid,
      generation: input.generation,
    };
    const handshake = readHandshake(await channel.request(command), input);
    this.#lastProbe.set(input.instanceId, handshake.probe);
    let admission = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      detectedCapabilities: handshake.capabilities,
      processState: handshake.ready ? "running" : "failed",
      now: this.#options.now,
    });
    this.#lastAdmission.set(input.instanceId, admission);
    if (!handshake.ready) {
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "UNAVAILABLE",
        "Native sidecar capability probe failed.",
      );
    }
    const adapter = new IOSSimulatorNativeSidecarAdapter({
      simulatorUdid: input.simulatorUdid,
      generation: input.generation,
      capabilities: applyIOSSimulatorNativeCapabilityAdmission(
        handshake.capabilities,
        admission,
      ),
      channel,
    });
    const availability = await adapter.availability();
    if (!availability.ready) {
      admission = evaluateIOSSimulatorNativeCapabilityAdmission({
        policy,
        detectedCapabilities: handshake.capabilities,
        processState: "failed",
        now: this.#options.now,
      });
      this.#lastAdmission.set(input.instanceId, admission);
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "UNAVAILABLE",
        "Native sidecar is unavailable.",
      );
    }
    return { adapter, handshake, admission };
  }

  #resolveAdmissionPolicy(
    input: IOSSimulatorNativeSidecarStartOptions,
  ): IOSSimulatorNativeCapabilityAdmissionPolicy {
    const configured = this.#options.admissionPolicy;
    if (typeof configured === "function") return configured(input);
    return (
      configured ??
      createIOSSimulatorNativeDevelopmentAdmissionPolicy({
        enableH264Stream: this.#options.enableH264Stream,
        enableContinuousInput: this.#options.enableContinuousInput,
      })
    );
  }

  #terminationFailedError(): IOSSimulatorNativeSidecarProcessManagerError {
    return new IOSSimulatorNativeSidecarProcessManagerError(
      "TERMINATION_FAILED",
      "Native sidecar process did not terminate after SIGKILL.",
    );
  }

  #rememberRetiring(
    instanceId: string,
    channel: IOSSimulatorNativeSidecarManagedChannel,
    sandbox: IOSSimulatorNativeSidecarSandboxLaunchState,
    policy?: IOSSimulatorNativeCapabilityAdmissionPolicy,
    detectedCapabilities?: Readonly<IOSSimulatorDriverCapabilities>,
    force = false,
  ): boolean {
    const retirement = channel.retirement;
    if (!retirement && !force) return false;
    const existing = this.#retiring.get(instanceId);
    if (existing) return existing.channel === channel;
    const retiring: RetiringSidecarOperation = {
      channel,
      sandbox,
      policy,
      detectedCapabilities,
      exited: false,
    };
    this.#retiring.set(instanceId, retiring);
    this.#lastFailure.set(
      instanceId,
      "Native sidecar process did not terminate after SIGKILL.",
    );
    if (policy) {
      this.#lastAdmission.set(
        instanceId,
        evaluateIOSSimulatorNativeCapabilityAdmission({
          policy,
          detectedCapabilities,
          processState: "failed",
          now: this.#options.now,
        }),
      );
    }
    if (retirement) {
      void retirement
        .then(async () => {
          retiring.exited = true;
          await this.#finalizeRetiring(instanceId, retiring);
        })
        .catch(() => undefined);
    }
    return true;
  }

  async #finalizeRetiring(
    instanceId: string,
    retiring: RetiringSidecarOperation,
  ): Promise<void> {
    if (this.#retiring.get(instanceId) !== retiring || !retiring.exited) return;
    retiring.finalizing ??= (async () => {
      this.#lastSandbox.set(instanceId, retiring.sandbox.diagnostics);
      await this.#disposeSandbox(retiring.sandbox);
      if (this.#retiring.get(instanceId) !== retiring) return;
      this.#retiring.delete(instanceId);
      this.#liveChannels.delete(retiring.channel);
      this.#lastFailure.delete(instanceId);
      if (retiring.policy) {
        this.#lastAdmission.set(
          instanceId,
          evaluateIOSSimulatorNativeCapabilityAdmission({
            policy: retiring.policy,
            detectedCapabilities: retiring.detectedCapabilities,
            processState: "stopped",
            now: this.#options.now,
          }),
        );
      }
    })();
    await retiring.finalizing;
  }

  async #resumeAfterRetiring(
    input: IOSSimulatorNativeSidecarStartOptions,
    retiring: RetiringSidecarOperation,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    if (!retiring.exited) throw this.#terminationFailedError();
    await this.#finalizeRetiring(input.instanceId, retiring);
    if (this.#retiring.get(input.instanceId) === retiring) {
      throw this.#terminationFailedError();
    }
    return this.start(input);
  }

  async #stopChannelOrRetire(
    instanceId: string,
    channel: IOSSimulatorNativeSidecarManagedChannel,
    sandbox: IOSSimulatorNativeSidecarSandboxLaunchState,
    policy?: IOSSimulatorNativeCapabilityAdmissionPolicy,
    detectedCapabilities?: Readonly<IOSSimulatorDriverCapabilities>,
  ): Promise<void> {
    try {
      await channel.stop();
    } catch (error) {
      const reportedTerminationFailure =
        isRecord(error) && error.code === "TERMINATION_FAILED";
      const terminationFailed =
        this.#rememberRetiring(
          instanceId,
          channel,
          sandbox,
          policy,
          detectedCapabilities,
          reportedTerminationFailure,
        ) || reportedTerminationFailure;
      if (terminationFailed) throw this.#terminationFailedError();
      throw safeProcessManagerFailure(
        error,
        "Native sidecar process failed to stop.",
      );
    }
  }

  async #verifyBinaryIntegrity(instanceId: string): Promise<void> {
    if (!this.#options.verifyBinaryIntegrity) return;
    try {
      await this.#options.verifyBinaryIntegrity();
    } catch {
      const error = new IOSSimulatorNativeSidecarProcessManagerError(
        "ARTIFACT_CHANGED",
        "Native sidecar artifact changed before launch.",
      );
      this.#lastFailure.set(instanceId, error.message);
      throw error;
    }
  }

  async stop(instanceId: string): Promise<void> {
    const existing = this.#stopping.get(instanceId);
    if (existing) return existing;
    const operation = this.#stop(instanceId).finally(() => {
      if (this.#stopping.get(instanceId) === operation) {
        this.#stopping.delete(instanceId);
      }
    });
    this.#stopping.set(instanceId, operation);
    return operation;
  }

  async #stop(instanceId: string): Promise<void> {
    const retiring = this.#retiring.get(instanceId);
    if (retiring) {
      if (!retiring.exited) throw this.#terminationFailedError();
      await this.#finalizeRetiring(instanceId, retiring);
      if (this.#retiring.get(instanceId) === retiring) {
        throw this.#terminationFailedError();
      }
      return;
    }
    const pending = this.#starting.get(instanceId);
    const pendingTermination = pending?.channel?.lastTermination;
    if (pendingTermination) {
      this.#lastTermination.set(
        instanceId,
        safeNativeSidecarTermination(pendingTermination),
      );
    }
    if (pending) {
      pending.stopRequested = true;
      if (pending.channel && pending.sandbox) {
        try {
          await this.#stopChannelOrRetire(
            instanceId,
            pending.channel,
            pending.sandbox,
            pending.policy,
          );
        } catch (error) {
          await pending.promise?.catch(() => undefined);
          throw error;
        }
      } else {
        await pending.channel?.stop();
      }
    }
    await pending?.promise?.catch(() => undefined);
    const newlyRetiring = this.#retiring.get(instanceId);
    if (newlyRetiring) {
      if (!newlyRetiring.exited) throw this.#terminationFailedError();
      await this.#finalizeRetiring(instanceId, newlyRetiring);
      if (this.#retiring.get(instanceId) === newlyRetiring) {
        throw this.#terminationFailedError();
      }
      return;
    }
    const running = this.#running.get(instanceId);
    const runningTermination = running?.channel.lastTermination;
    if (runningTermination) {
      this.#lastTermination.set(
        instanceId,
        safeNativeSidecarTermination(runningTermination),
      );
    }
    if (running) {
      await running.adapter.detach().catch(() => undefined);
      try {
        await this.#stopChannelOrRetire(
          instanceId,
          running.channel,
          running.sandbox,
          running.policy,
          running.handshake.capabilities,
        );
      } catch (error) {
        if (this.#retiring.has(instanceId)) {
          this.#running.delete(instanceId);
        }
        throw error;
      }
      this.#running.delete(instanceId);
      this.#liveChannels.delete(running.channel);
      this.#lastSandbox.set(instanceId, running.sandbox.diagnostics);
      await this.#disposeSandbox(running.sandbox);
      this.#lastAdmission.set(
        instanceId,
        evaluateIOSSimulatorNativeCapabilityAdmission({
          policy: running.policy,
          detectedCapabilities: running.handshake.capabilities,
          processState: "stopped",
          now: this.#options.now,
        }),
      );
      this.#lastFailure.delete(instanceId);
    }
  }

  #createChannelOptions(
    input: IOSSimulatorNativeSidecarStartOptions,
    preflight: IOSSimulatorNativeCapabilityAdmissionDecision,
    sandbox: IOSSimulatorNativeSidecarSandboxLaunchState,
  ): {
    launcher: ReturnType<typeof createNodeIOSSimulatorNativeSidecarLauncher>;
  } {
    const args = createIOSSimulatorNativeSidecarArguments(
      input,
      preflight.capabilities.h264Stream.policyAllowed,
      preflight.capabilities.continuousInput.policyAllowed,
    );
    const environment = createIOSSimulatorNativeSidecarEnvironment(
      this.#options.environment ?? process.env,
    );
    const plan =
      this.#options.sandboxPolicy && sandbox.temporaryDirectory
        ? createIOSSimulatorNativeSidecarSandboxLaunchPlan({
            policy: this.#options.sandboxPolicy,
            binaryPath: this.#options.binaryPath,
            simulatorUdid: input.simulatorUdid,
            architecture:
              input.runtime?.architecture ?? this.#hostArchitecture(),
            temporaryDirectory: sandbox.temporaryDirectory,
            args,
            environment,
          })
        : {
            command: this.#options.binaryPath,
            args,
            cwd: undefined,
            environment,
          };
    return {
      launcher: createNodeIOSSimulatorNativeSidecarLauncher({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.environment,
      }),
    };
  }

  async #prepareSandbox(
    input: IOSSimulatorNativeSidecarStartOptions,
    operation: PendingSidecarOperation,
  ): Promise<IOSSimulatorNativeSidecarSandboxLaunchState> {
    const policy =
      this.#options.sandboxPolicy ??
      createIOSSimulatorNativeSidecarSandboxPolicy({
        required: false,
        platform: process.platform,
      });
    if (!policy.required) {
      const state = {
        diagnostics: createIOSSimulatorNativeSidecarUnsandboxedDiagnostics(),
        temporaryDirectory: null,
      };
      this.#lastSandbox.set(input.instanceId, state.diagnostics);
      operation.sandbox = state;
      return state;
    }
    if (policy.platform !== "darwin") {
      const diagnostics =
        createIOSSimulatorNativeSidecarSandboxFailureDiagnostics(
          "SANDBOX_UNSUPPORTED_PLATFORM",
        );
      this.#lastSandbox.set(input.instanceId, diagnostics);
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "SANDBOX_UNSUPPORTED_PLATFORM",
        diagnostics.reason,
      );
    }
    try {
      await access(policy.sandboxExecutablePath, constants.X_OK);
    } catch {
      const diagnostics =
        createIOSSimulatorNativeSidecarSandboxFailureDiagnostics(
          "SANDBOX_UNAVAILABLE",
        );
      this.#lastSandbox.set(input.instanceId, diagnostics);
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        "SANDBOX_UNAVAILABLE",
        diagnostics.reason,
      );
    }

    let temporaryDirectory: string | null = null;
    try {
      const safeInstanceId =
        input.instanceId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) ||
        "instance";
      temporaryDirectory = await mkdtemp(
        path.join(
          policy.temporaryRoot,
          `cindy-ios-simulator-sidecar-${safeInstanceId}-`,
        ),
      );
      await chmod(temporaryDirectory, 0o700);
      const metalCacheDirectory = path.join(temporaryDirectory, "metal-cache");
      await mkdir(metalCacheDirectory, { mode: 0o700 });
      await chmod(metalCacheDirectory, 0o700);
      const diagnostics = createIOSSimulatorNativeSidecarSandboxLaunchPlan({
        policy,
        binaryPath: this.#options.binaryPath,
        simulatorUdid: input.simulatorUdid,
        architecture: input.runtime?.architecture ?? this.#hostArchitecture(),
        temporaryDirectory,
        args: [],
        environment: {},
      }).diagnostics;
      const state = { diagnostics, temporaryDirectory };
      this.#lastSandbox.set(input.instanceId, diagnostics);
      operation.sandbox = state;
      return state;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
      const diagnostics =
        error instanceof IOSSimulatorNativeSidecarSandboxError &&
        error.code === "SANDBOX_UNSUPPORTED_PLATFORM"
          ? createIOSSimulatorNativeSidecarSandboxFailureDiagnostics(
              "SANDBOX_UNSUPPORTED_PLATFORM",
            )
          : createIOSSimulatorNativeSidecarSandboxFailureDiagnostics(
              "SANDBOX_PROFILE_INVALID",
            );
      this.#lastSandbox.set(input.instanceId, diagnostics);
      throw new IOSSimulatorNativeSidecarProcessManagerError(
        diagnostics.reasonCode === "SANDBOX_UNSUPPORTED_PLATFORM"
          ? "SANDBOX_UNSUPPORTED_PLATFORM"
          : "SANDBOX_PROFILE_INVALID",
        diagnostics.reason,
      );
    }
  }

  async #disposeSandbox(
    sandbox: IOSSimulatorNativeSidecarSandboxLaunchState,
  ): Promise<void> {
    if (!sandbox.temporaryDirectory) return;
    await rm(sandbox.temporaryDirectory, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  #hostArchitecture(): "arm64" | "x86_64" {
    return process.arch === "x64" ? "x86_64" : "arm64";
  }
}
