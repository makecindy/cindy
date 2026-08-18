import path from "node:path";

import {
  evaluateIOSSimulatorNativeCapabilityAdmission,
  type IOSSimulatorNativeArtifactSource,
  type IOSSimulatorNativeArtifactTrust,
  type IOSSimulatorNativeCapabilityAdmissionDecision,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
} from "../capability-admission.js";
import type {
  IOSSimulatorNativeSidecarDiagnostics,
  IOSSimulatorNativeSidecarRecoverOptions,
  IOSSimulatorNativeSidecarRunningInstance,
  IOSSimulatorNativeSidecarStartOptions,
} from "./process-manager.js";

/** Host-private identity and trust result for one executable candidate. */
export interface IOSSimulatorSidecarArtifactDescriptor {
  artifactId: string;
  source: IOSSimulatorNativeArtifactSource;
  version: string;
  architecture: "arm64" | "x86_64";
  executablePath: string;
  trust: IOSSimulatorNativeArtifactTrust;
  sha256: string | null;
}

/** Resolves candidates without granting plugin code process-launch authority. */
export interface IOSSimulatorSidecarArtifactResolver {
  /**
   * This resolver is implemented by the Host, never by plugin sandbox code.
   * A future plugin-backed resolver must verify the artifact before returning
   * a trusted descriptor.
   */
  resolve(
    input: IOSSimulatorNativeSidecarStartOptions,
  ):
    | IOSSimulatorSidecarArtifactDescriptor
    | null
    | Promise<IOSSimulatorSidecarArtifactDescriptor | null>;
}

/** Evaluates current Host policy for one exact artifact and simulator runtime. */
export interface IOSSimulatorAdmissionPolicy {
  /** Produces policy from Host state; artifact source/trust are overwritten by the supervisor. */
  resolve(input: {
    artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>;
    start: Readonly<IOSSimulatorNativeSidecarStartOptions>;
  }): IOSSimulatorNativeCapabilityAdmissionPolicy;
}

/** Minimal native capability surface consumed by WDA and the Desktop Host. */
export interface IOSSimulatorCapabilityProvider {
  readonly providerId: string;
  get(instanceId: string): IOSSimulatorNativeSidecarRunningInstance | null;
  admission(
    instanceId: string,
  ): IOSSimulatorNativeCapabilityAdmissionDecision | null;
  diagnostics(instanceId: string): IOSSimulatorNativeSidecarDiagnostics | null;
  start(
    input: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance>;
  recover(
    input: IOSSimulatorNativeSidecarStartOptions,
    options?: IOSSimulatorNativeSidecarRecoverOptions,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance>;
  stop(instanceId: string): Promise<void>;
  /** Best-effort synchronous child teardown before a forced Host exit. */
  abortOperationsForExit?(): void;
}

/** Lifecycle owner used for provider disable, upgrade, uninstall, and Host quit. */
export interface IOSSimulatorSidecarSupervisor extends IOSSimulatorCapabilityProvider {
  enable(): void;
  disable(): Promise<void>;
  invalidateArtifact(artifactId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Internal process-manager surface hidden behind the provider boundary. */
export interface IOSSimulatorSidecarRuntime extends Omit<
  IOSSimulatorCapabilityProvider,
  "providerId"
> {}

/** Host-only inputs used to construct a runtime for one artifact identity. */
export interface IOSSimulatorSidecarRuntimeFactoryInput {
  artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>;
  admissionPolicy: (
    input: IOSSimulatorNativeSidecarStartOptions,
  ) => IOSSimulatorNativeCapabilityAdmissionPolicy;
}

export type IOSSimulatorSidecarRuntimeFactory = (
  input: IOSSimulatorSidecarRuntimeFactoryInput,
) => IOSSimulatorSidecarRuntime;

/** Stable, sanitized failures emitted by the Host provider boundary. */
export class IOSSimulatorCapabilityProviderError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_DISABLED"
      | "ARTIFACT_UNAVAILABLE"
      | "ARTIFACT_INVALID"
      | "ARTIFACT_CHANGED"
      | "ADMISSION_DENIED"
      | "START_STOPPED"
      | "TERMINATION_FAILED"
      | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "IOSSimulatorCapabilityProviderError";
  }
}

interface ArtifactBinding {
  artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>;
  artifactKey: string;
  runtime: IOSSimulatorSidecarRuntime;
}

interface PendingProviderOperation {
  input: IOSSimulatorNativeSidecarStartOptions;
  promise?: Promise<IOSSimulatorNativeSidecarRunningInstance>;
  artifactId?: string;
  stopRequested: boolean;
}

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

function validateArtifact(
  value: IOSSimulatorSidecarArtifactDescriptor,
  input: IOSSimulatorNativeSidecarStartOptions,
): Readonly<IOSSimulatorSidecarArtifactDescriptor> {
  if (
    !value ||
    !SAFE_ARTIFACT_ID.test(value.artifactId) ||
    !SAFE_VERSION.test(value.version) ||
    (value.source !== "bundled" && value.source !== "plugin") ||
    (value.architecture !== "arm64" && value.architecture !== "x86_64") ||
    !path.isAbsolute(value.executablePath) ||
    (value.trust !== "development" &&
      value.trust !== "verified" &&
      value.trust !== "untrusted") ||
    (value.sha256 !== null && !SHA256.test(value.sha256)) ||
    (value.trust === "verified" && value.sha256 === null) ||
    (input.runtime !== undefined &&
      value.architecture !== input.runtime.architecture)
  ) {
    throw new IOSSimulatorCapabilityProviderError(
      "ARTIFACT_INVALID",
      "The native capability artifact descriptor is invalid.",
    );
  }
  return Object.freeze({
    ...value,
    executablePath: path.normalize(value.executablePath),
    sha256: value.sha256?.toLowerCase() ?? null,
  });
}

function artifactKey(
  artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
): string {
  return [
    artifact.source,
    artifact.artifactId,
    artifact.version,
    artifact.architecture,
    artifact.sha256 ?? "development",
    artifact.executablePath,
  ].join("\0");
}

function sameIdentity(
  left: IOSSimulatorNativeSidecarStartOptions,
  right: IOSSimulatorNativeSidecarStartOptions,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.simulatorUdid === right.simulatorUdid &&
    left.generation === right.generation &&
    left.runtime?.runtimeIdentifier === right.runtime?.runtimeIdentifier &&
    left.runtime?.runtimeBuildVersion === right.runtime?.runtimeBuildVersion &&
    left.runtime?.xcodeBuild === right.runtime?.xcodeBuild &&
    left.runtime?.architecture === right.runtime?.architecture
  );
}

function stoppedError(): IOSSimulatorCapabilityProviderError {
  return new IOSSimulatorCapabilityProviderError(
    "START_STOPPED",
    "Native capability provider startup was stopped.",
  );
}

function isTerminationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TERMINATION_FAILED"
  );
}

/**
 * Host-owned supervisor that converts artifact candidates into process
 * managers. Plugin sandboxes cannot inject runtimes, policies, or process
 * launchers through this boundary.
 */
export class HostIOSSimulatorSidecarSupervisor implements IOSSimulatorSidecarSupervisor {
  readonly providerId: string;
  readonly #artifactResolver: IOSSimulatorSidecarArtifactResolver;
  readonly #admissionPolicy: IOSSimulatorAdmissionPolicy;
  readonly #createRuntime: IOSSimulatorSidecarRuntimeFactory;
  readonly #bindings = new Map<string, ArtifactBinding>();
  readonly #runtimes = new Map<string, IOSSimulatorSidecarRuntime>();
  readonly #runtimeArtifacts = new Map<string, string>();
  readonly #starting = new Map<string, PendingProviderOperation>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #lastDiagnostics = new Map<
    string,
    IOSSimulatorNativeSidecarDiagnostics
  >();
  readonly #lastAdmission = new Map<
    string,
    IOSSimulatorNativeCapabilityAdmissionDecision
  >();
  #enabled = true;
  #disposing = false;
  #disposed = false;

  constructor(options: {
    providerId: string;
    artifactResolver: IOSSimulatorSidecarArtifactResolver;
    admissionPolicy: IOSSimulatorAdmissionPolicy;
    createRuntime: IOSSimulatorSidecarRuntimeFactory;
  }) {
    if (!SAFE_ARTIFACT_ID.test(options.providerId)) {
      throw new IOSSimulatorCapabilityProviderError(
        "ARTIFACT_INVALID",
        "Native capability provider id is invalid.",
      );
    }
    this.providerId = options.providerId;
    this.#artifactResolver = options.artifactResolver;
    this.#admissionPolicy = options.admissionPolicy;
    this.#createRuntime = options.createRuntime;
  }

  enable(): void {
    if (this.#disposing || this.#disposed) {
      throw new IOSSimulatorCapabilityProviderError(
        "PROVIDER_DISABLED",
        "Native capability provider is disposing or disposed.",
      );
    }
    this.#enabled = true;
  }

  async disable(): Promise<void> {
    this.#enabled = false;
    await Promise.all([...this.#instanceIds()].map((id) => this.stop(id)));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposing = true;
    await this.disable();
    this.#runtimes.clear();
    this.#runtimeArtifacts.clear();
    this.#disposed = true;
    this.#disposing = false;
  }

  abortOperationsForExit(): void {
    for (const pending of this.#starting.values()) {
      pending.stopRequested = true;
    }
    for (const runtime of new Set([
      ...this.#runtimes.values(),
      ...[...this.#bindings.values()].map((binding) => binding.runtime),
    ])) {
      try {
        runtime.abortOperationsForExit?.();
      } catch {
        // The updater must still be able to exit if one runtime is already gone.
      }
    }
  }

  async invalidateArtifact(artifactId: string): Promise<void> {
    if (!SAFE_ARTIFACT_ID.test(artifactId)) {
      throw new IOSSimulatorCapabilityProviderError(
        "ARTIFACT_INVALID",
        "Native capability artifact id is invalid.",
      );
    }
    const affected = [...this.#bindings.entries()]
      .filter(([, binding]) => binding.artifact.artifactId === artifactId)
      .map(([instanceId]) => instanceId);
    for (const [instanceId, pending] of this.#starting) {
      if (
        pending.artifactId === undefined ||
        pending.artifactId === artifactId
      ) {
        pending.stopRequested = true;
        affected.push(instanceId);
      }
    }
    await Promise.all(affected.map((instanceId) => this.stop(instanceId)));
    for (const [key, runtimeArtifactId] of this.#runtimeArtifacts) {
      if (runtimeArtifactId !== artifactId) continue;
      if (
        [...this.#bindings.values()].some(
          (binding) => binding.artifactKey === key,
        )
      ) {
        continue;
      }
      this.#runtimes.delete(key);
      this.#runtimeArtifacts.delete(key);
    }
  }

  get(instanceId: string): IOSSimulatorNativeSidecarRunningInstance | null {
    return this.#bindings.get(instanceId)?.runtime.get(instanceId) ?? null;
  }

  admission(
    instanceId: string,
  ): IOSSimulatorNativeCapabilityAdmissionDecision | null {
    return (
      this.#bindings.get(instanceId)?.runtime.admission(instanceId) ??
      this.#lastAdmission.get(instanceId) ??
      null
    );
  }

  diagnostics(instanceId: string): IOSSimulatorNativeSidecarDiagnostics | null {
    return (
      this.#bindings.get(instanceId)?.runtime.diagnostics(instanceId) ??
      this.#lastDiagnostics.get(instanceId) ??
      null
    );
  }

  start(
    input: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    const stopping = this.#stopping.get(input.instanceId);
    if (stopping) return stopping.then(() => this.start(input));
    const pending = this.#starting.get(input.instanceId);
    if (pending) {
      if (!sameIdentity(pending.input, input)) {
        return Promise.reject(
          new IOSSimulatorCapabilityProviderError(
            "ARTIFACT_CHANGED",
            "Native capability instance is already starting for another identity.",
          ),
        );
      }
      return pending.promise!;
    }
    const operation: PendingProviderOperation = {
      input: { ...input },
      stopRequested: false,
    };
    const promise = this.#start(input, operation).finally(() => {
      if (this.#starting.get(input.instanceId) === operation) {
        this.#starting.delete(input.instanceId);
      }
    });
    operation.promise = promise;
    this.#starting.set(input.instanceId, operation);
    return promise;
  }

  async #start(
    input: IOSSimulatorNativeSidecarStartOptions,
    operation: PendingProviderOperation,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    this.#assertEnabled();
    const artifact = await this.#resolveArtifact(input);
    operation.artifactId = artifact.artifactId;
    if (operation.stopRequested) throw stoppedError();
    const key = artifactKey(artifact);
    const existing = this.#bindings.get(input.instanceId);
    if (existing && existing.artifactKey !== key) {
      throw new IOSSimulatorCapabilityProviderError(
        "ARTIFACT_CHANGED",
        "Native capability artifact changed while the instance was bound.",
      );
    }
    const policy = this.#resolvePolicy(artifact, input);
    try {
      this.#assertAdmitted(input.instanceId, policy);
    } catch (error) {
      if (existing) {
        await this.#stopBindingForRelease(input.instanceId, existing);
        this.#rememberDiagnostics(input.instanceId, existing.runtime);
        this.#bindings.delete(input.instanceId);
      }
      throw error;
    }
    const runtime =
      existing?.runtime ??
      this.#runtimeFor(key, artifact, (start) =>
        this.#resolvePolicy(artifact, start),
      );
    const binding = { artifact, artifactKey: key, runtime };
    this.#bindings.set(input.instanceId, binding);
    try {
      const running = await runtime.start(input);
      if (operation.stopRequested) {
        await this.#stopBindingForRelease(input.instanceId, binding);
        throw stoppedError();
      }
      this.#rememberDiagnostics(input.instanceId, runtime);
      return running;
    } catch (error) {
      this.#rememberDiagnostics(input.instanceId, runtime);
      if (
        !(
          error instanceof IOSSimulatorCapabilityProviderError &&
          error.code === "TERMINATION_FAILED"
        ) &&
        !isTerminationFailure(error) &&
        !runtime.get(input.instanceId)
      ) {
        this.#bindings.delete(input.instanceId);
      }
      if (error instanceof IOSSimulatorCapabilityProviderError) throw error;
      if (isTerminationFailure(error)) {
        throw new IOSSimulatorCapabilityProviderError(
          "TERMINATION_FAILED",
          "Native capability process did not terminate after SIGKILL.",
        );
      }
      throw new IOSSimulatorCapabilityProviderError(
        "UNAVAILABLE",
        "Native capability provider is unavailable.",
      );
    }
  }

  recover(
    input: IOSSimulatorNativeSidecarStartOptions,
    options: IOSSimulatorNativeSidecarRecoverOptions = {},
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    const stopping = this.#stopping.get(input.instanceId);
    if (stopping) {
      return stopping.then(() => this.recover(input, options));
    }
    const pending = this.#starting.get(input.instanceId);
    if (pending) {
      if (!sameIdentity(pending.input, input)) {
        return Promise.reject(
          new IOSSimulatorCapabilityProviderError(
            "ARTIFACT_CHANGED",
            "Native capability instance is already starting for another identity.",
          ),
        );
      }
      return pending.promise!;
    }
    const operation: PendingProviderOperation = {
      input: { ...input },
      stopRequested: false,
    };
    const promise = this.#recover(input, options, operation).finally(() => {
      if (this.#starting.get(input.instanceId) === operation) {
        this.#starting.delete(input.instanceId);
      }
    });
    operation.promise = promise;
    this.#starting.set(input.instanceId, operation);
    return promise;
  }

  async #recover(
    input: IOSSimulatorNativeSidecarStartOptions,
    options: IOSSimulatorNativeSidecarRecoverOptions,
    operation: PendingProviderOperation,
  ): Promise<IOSSimulatorNativeSidecarRunningInstance> {
    this.#assertEnabled();
    const binding = this.#bindings.get(input.instanceId);
    if (!binding) return this.#start(input, operation);
    const artifact = await this.#resolveArtifact(input);
    operation.artifactId = artifact.artifactId;
    if (operation.stopRequested) throw stoppedError();
    if (artifactKey(artifact) !== binding.artifactKey) {
      await this.#stopBindingForRelease(input.instanceId, binding);
      this.#rememberDiagnostics(input.instanceId, binding.runtime);
      this.#bindings.delete(input.instanceId);
      throw new IOSSimulatorCapabilityProviderError(
        "ARTIFACT_CHANGED",
        "Native capability artifact changed before recovery.",
      );
    }
    const policy = this.#resolvePolicy(artifact, input);
    try {
      this.#assertAdmitted(input.instanceId, policy);
    } catch (error) {
      await this.#stopBindingForRelease(input.instanceId, binding);
      this.#rememberDiagnostics(input.instanceId, binding.runtime);
      this.#bindings.delete(input.instanceId);
      throw error;
    }
    if (operation.stopRequested) throw stoppedError();
    try {
      const running = await binding.runtime.recover(input, options);
      if (operation.stopRequested) {
        await this.#stopBindingForRelease(input.instanceId, binding);
        throw stoppedError();
      }
      this.#rememberDiagnostics(input.instanceId, binding.runtime);
      return running;
    } catch (error) {
      this.#rememberDiagnostics(input.instanceId, binding.runtime);
      if (operation.stopRequested && !isTerminationFailure(error)) {
        throw stoppedError();
      }
      if (error instanceof IOSSimulatorCapabilityProviderError) throw error;
      if (isTerminationFailure(error)) {
        throw new IOSSimulatorCapabilityProviderError(
          "TERMINATION_FAILED",
          "Native capability process did not terminate after SIGKILL.",
        );
      }
      throw new IOSSimulatorCapabilityProviderError(
        "UNAVAILABLE",
        "Native capability provider recovery failed.",
      );
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

  async #stopBindingForRelease(
    instanceId: string,
    binding: ArtifactBinding,
  ): Promise<void> {
    try {
      await binding.runtime.stop(instanceId);
    } catch (error) {
      this.#rememberDiagnostics(instanceId, binding.runtime);
      if (isTerminationFailure(error)) {
        throw new IOSSimulatorCapabilityProviderError(
          "TERMINATION_FAILED",
          "Native capability process did not terminate after SIGKILL.",
        );
      }
      // Preserve the existing best-effort behavior for non-lifecycle failures.
    }
  }

  async #stop(instanceId: string): Promise<void> {
    const pending = this.#starting.get(instanceId);
    if (pending) pending.stopRequested = true;
    let binding = this.#bindings.get(instanceId);
    if (binding) await this.#stopBindingForRelease(instanceId, binding);
    await pending?.promise?.catch(() => undefined);
    binding = this.#bindings.get(instanceId) ?? binding;
    if (binding) {
      await this.#stopBindingForRelease(instanceId, binding);
      this.#rememberDiagnostics(instanceId, binding.runtime);
    }
    this.#bindings.delete(instanceId);
  }

  async #resolveArtifact(
    input: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<Readonly<IOSSimulatorSidecarArtifactDescriptor>> {
    let artifact: IOSSimulatorSidecarArtifactDescriptor | null;
    try {
      artifact = await this.#artifactResolver.resolve(input);
    } catch {
      throw new IOSSimulatorCapabilityProviderError(
        "UNAVAILABLE",
        "Native capability artifact resolution failed.",
      );
    }
    if (!artifact) {
      throw new IOSSimulatorCapabilityProviderError(
        "ARTIFACT_UNAVAILABLE",
        "No native capability artifact is available for this host.",
      );
    }
    return validateArtifact(artifact, input);
  }

  #resolvePolicy(
    artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
    start: IOSSimulatorNativeSidecarStartOptions,
  ): IOSSimulatorNativeCapabilityAdmissionPolicy {
    let policy: IOSSimulatorNativeCapabilityAdmissionPolicy;
    try {
      policy = this.#admissionPolicy.resolve({ artifact, start });
    } catch {
      throw new IOSSimulatorCapabilityProviderError(
        "UNAVAILABLE",
        "Native capability admission policy failed.",
      );
    }
    return {
      ...policy,
      artifact: {
        source: artifact.source,
        trust: artifact.trust,
      },
    };
  }

  #assertAdmitted(
    instanceId: string,
    policy: IOSSimulatorNativeCapabilityAdmissionPolicy,
  ): void {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      processState: "idle",
    });
    this.#lastAdmission.set(instanceId, decision);
    if (decision.launch.allowed) return;
    this.#lastDiagnostics.set(instanceId, {
      running: false,
      state: "idle",
      crashCount: 0,
      probe: null,
      lastFailure: "Native capability provider admission was denied.",
      recoveryEligible: false,
      lastTermination: null,
      admission: decision,
    });
    throw new IOSSimulatorCapabilityProviderError(
      "ADMISSION_DENIED",
      decision.launch.reason,
    );
  }

  #runtimeFor(
    key: string,
    artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>,
    admissionPolicy: (
      input: IOSSimulatorNativeSidecarStartOptions,
    ) => IOSSimulatorNativeCapabilityAdmissionPolicy,
  ): IOSSimulatorSidecarRuntime {
    const existing = this.#runtimes.get(key);
    if (existing) return existing;
    const runtime = this.#createRuntime({ artifact, admissionPolicy });
    this.#runtimes.set(key, runtime);
    this.#runtimeArtifacts.set(key, artifact.artifactId);
    return runtime;
  }

  #rememberDiagnostics(
    instanceId: string,
    runtime: IOSSimulatorSidecarRuntime,
  ): void {
    const diagnostics = runtime.diagnostics(instanceId);
    if (diagnostics) this.#lastDiagnostics.set(instanceId, diagnostics);
    const admission = runtime.admission(instanceId);
    if (admission) this.#lastAdmission.set(instanceId, admission);
  }

  #assertEnabled(): void {
    if (!this.#enabled || this.#disposing || this.#disposed) {
      throw new IOSSimulatorCapabilityProviderError(
        "PROVIDER_DISABLED",
        "Native capability provider is disabled.",
      );
    }
  }

  #instanceIds(): Set<string> {
    return new Set([...this.#bindings.keys(), ...this.#starting.keys()]);
  }
}

/** Fixed Host resolver used by the current bundled implementation. */
export class IOSSimulatorStaticSidecarArtifactResolver implements IOSSimulatorSidecarArtifactResolver {
  readonly #artifact: IOSSimulatorSidecarArtifactDescriptor;

  constructor(artifact: IOSSimulatorSidecarArtifactDescriptor) {
    this.#artifact = { ...artifact };
  }

  resolve(): IOSSimulatorSidecarArtifactDescriptor {
    return { ...this.#artifact };
  }
}
