import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type {
  IOSSimulatorAttachInput,
  IOSSimulatorCreatedDevice,
  IOSSimulatorInstance,
  IOSSimulatorMutationRoute,
} from "./instance-types.js";
import {
  IOSSimulatorOwnershipStore,
  type IOSSimulatorClock,
} from "./ownership-store.js";
import {
  IOSSimulatorCreateCleanupRequiredError,
  type IOSSimulatorSimctlLifecycle,
} from "./simctl-lifecycle.js";

export interface IOSSimulatorScheduler {
  schedule(delayMs: number, task: () => void | Promise<void>): () => void;
}

export interface IOSSimulatorInstanceActorOptions {
  store: IOSSimulatorOwnershipStore;
  lifecycle: IOSSimulatorSimctlLifecycle;
  /** Fail-closed preflight before lifecycle side effects that precede store mutation. */
  assertMutationAllowed?: () => void;
  clock?: IOSSimulatorClock;
  scheduler?: IOSSimulatorScheduler;
  detachGraceMs?: number;
  detachCleanupRetryMs?: number;
  onDetachCleanupError?: (
    error: unknown,
    instance: IOSSimulatorInstance,
  ) => void;
}

type IOSSimulatorCreateInput = Omit<IOSSimulatorAttachInput, "device"> & {
  name: string;
  templateDevice: IOSSimulatorAttachInput["device"];
};

export interface IOSSimulatorReconcileOptions {
  preserveDetachGrace?: boolean;
  /**
   * Correct a `viewerState` inherited from a process that is already gone. Only
   * the first sweep of an owner generation knows the persisted value cannot
   * describe a live viewer; later sweeps observe CoreSimulator alone and have no
   * evidence about viewer attachment, so they must leave it untouched.
   */
  normalizeViewerState?: boolean;
}

export type IOSSimulatorMutationSource = "agent" | "user";

export interface IOSSimulatorMutationState {
  instanceId: string;
  activeSource: IOSSimulatorMutationSource | null;
  lastSource: IOSSimulatorMutationSource | null;
  queuedAgentMutations: number;
  agentPaused: boolean;
  takeoverPending: boolean;
}

export interface IOSSimulatorExternalDeviceReconcileInput {
  sessionId: string;
  instanceId: string;
  simulatorUdid: string;
  expectedGeneration: number;
  state: "shutdown" | "missing";
}

export interface IOSSimulatorExternalDeviceReconcileResult {
  applied: boolean;
  instance: IOSSimulatorInstance;
  previousGeneration: number;
}

interface MutableMutationState {
  activeSource: IOSSimulatorMutationSource | null;
  lastSource: IOSSimulatorMutationSource | null;
  queuedAgentMutations: number;
  agentPaused: boolean;
  takeoverEpoch: number;
}

interface ActiveLifecycleStart {
  sessionId: string;
  controller: AbortController;
  settled: Promise<void>;
}

const DEFAULT_DETACH_GRACE_MS = 10 * 60_000;
const DEFAULT_DETACH_CLEANUP_RETRY_MS = 5_000;
const CREATE_ROLLBACK_TIMEOUT_MS = 4_000;

interface DetachGraceCleanupContext {
  instanceId: string;
  sessionId: string;
  generation: number;
  graceExpiresAt: string;
  onResourceStopped: (instance: IOSSimulatorInstance) => void | Promise<void>;
}

interface ScheduledDetachGraceCleanup {
  token: symbol;
  cancel: () => void;
}

function defaultScheduler(): IOSSimulatorScheduler {
  return {
    schedule(delayMs, task) {
      const timer = setTimeout(() => void task(), delayMs);
      return () => clearTimeout(timer);
    },
  };
}

/** Serializes mutations and owns boot-generation and detach-grace semantics. */
export class IOSSimulatorInstanceActor {
  readonly #store: IOSSimulatorOwnershipStore;
  readonly #lifecycle: IOSSimulatorSimctlLifecycle;
  readonly #clock: IOSSimulatorClock;
  readonly #scheduler: IOSSimulatorScheduler;
  readonly #detachGraceMs: number;
  readonly #detachCleanupRetryMs: number;
  readonly #onDetachCleanupError:
    ((error: unknown, instance: IOSSimulatorInstance) => void) | null;
  readonly #assertMutationAllowed: (() => void) | null;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #cancelGrace = new Map<string, ScheduledDetachGraceCleanup>();
  readonly #mutationStates = new Map<string, MutableMutationState>();
  readonly #activeMutations = new Map<
    string,
    { source: IOSSimulatorMutationSource; controller: AbortController }
  >();
  readonly #activeLifecycleStarts = new Map<
    string,
    Set<ActiveLifecycleStart>
  >();
  readonly #lifecycleExitController = new AbortController();

  constructor(options: IOSSimulatorInstanceActorOptions) {
    this.#store = options.store;
    this.#lifecycle = options.lifecycle;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#scheduler = options.scheduler ?? defaultScheduler();
    this.#detachGraceMs = options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS;
    this.#detachCleanupRetryMs =
      options.detachCleanupRetryMs ?? DEFAULT_DETACH_CLEANUP_RETRY_MS;
    this.#onDetachCleanupError = options.onDetachCleanupError ?? null;
    this.#assertMutationAllowed = options.assertMutationAllowed ?? null;
    if (
      !Number.isSafeInteger(this.#detachGraceMs) ||
      this.#detachGraceMs <= 0
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "detachGraceMs must be a positive integer",
      );
    }
    if (
      !Number.isSafeInteger(this.#detachCleanupRetryMs) ||
      this.#detachCleanupRetryMs <= 0
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "detachCleanupRetryMs must be a positive integer",
      );
    }
  }

  attach(input: IOSSimulatorAttachInput): IOSSimulatorInstance {
    const instance = this.#store.attach(input);
    this.#cancelDetachGrace(instance.instanceId);
    return this.#store.update(instance.instanceId, instance.sessionId, {
      viewerState: "attached",
      graceExpiresAt: null,
    });
  }

  /** Serialize a user reattachment with any in-flight grace-period cleanup. */
  attachSerialized(
    input: IOSSimulatorAttachInput,
  ): Promise<IOSSimulatorInstance> {
    const normalizedUdid = input.device.udid.trim().toUpperCase();
    return this.#serialize(
      this.#deviceOperationKey(normalizedUdid),
      async () => {
        const existing = this.#bindingForUdid(normalizedUdid);
        if (!existing) {
          const currentDevice = await this.#lifecycle.findExact(
            normalizedUdid,
            this.#lifecycleExitController.signal,
          );
          if (currentDevice === null) {
            throw new IOSSimulatorInstanceError(
              "SIMULATOR_NOT_FOUND",
              "The selected iOS Simulator device no longer exists.",
              true,
            );
          }
          return this.attach({
            ...input,
            device: currentDevice ?? input.device,
          });
        }
        return this.#serialize(existing.instanceId, async () => {
          const currentDevice = await this.#lifecycle.findExact(
            normalizedUdid,
            this.#lifecycleExitController.signal,
          );
          if (currentDevice === null) {
            throw new IOSSimulatorInstanceError(
              "SIMULATOR_NOT_FOUND",
              "The selected iOS Simulator device no longer exists.",
              true,
            );
          }
          return this.attach({
            ...input,
            // Some test adapters omit the optional lookup result. Production
            // lifecycle adapters return either an exact device or null.
            device: currentDevice ?? input.device,
          });
        });
      },
    );
  }

  create(input: IOSSimulatorCreateInput): Promise<IOSSimulatorInstance> {
    return this.#runTrackedLifecycleStart(
      `create:${input.sessionId}`,
      input.sessionId,
      async (signal) => {
        this.#throwIfLifecycleStartCancelled(signal);
        const deviceTypeIdentifier = input.templateDevice.deviceTypeIdentifier;
        if (!deviceTypeIdentifier) {
          throw new IOSSimulatorInstanceError(
            "INVALID_ARGUMENT",
            "The template simulator does not expose a device type identifier.",
          );
        }
        this.#assertMutationAllowed?.();
        let created: Awaited<
          ReturnType<IOSSimulatorSimctlLifecycle["createExact"]>
        >;
        let cleanupRequired: IOSSimulatorCreateCleanupRequiredError | null =
          null;
        try {
          created = await this.#lifecycle.createExact(
            {
              name: input.name,
              deviceTypeIdentifier,
              runtimeIdentifier: input.templateDevice.runtimeIdentifier,
            },
            signal,
          );
        } catch (error) {
          if (!(error instanceof IOSSimulatorCreateCleanupRequiredError))
            throw error;
          created = error.createdDevice;
          cleanupRequired = error;
        }
        return this.#finalizeCreatedDevice(
          input,
          created,
          signal,
          cleanupRequired,
        );
      },
    );
  }

  list(sessionId: string): IOSSimulatorInstance[] {
    return this.#store.listForSession(sessionId);
  }

  /** List persisted bindings during startup reconciliation, before session routing is known. */
  listAll(): IOSSimulatorInstance[] {
    return this.#store.listAll();
  }

  /** Remove a persisted binding after orphan policy has decided its fate. */
  forget(instanceId: string, sessionId: string): IOSSimulatorInstance {
    this.#store.requireOwned(instanceId, sessionId);
    this.#cancelActiveAgentMutation(instanceId);
    this.#abortLifecycleStartsForInstance(instanceId);
    this.#cancelDetachGrace(instanceId);
    return this.#store.release(instanceId, sessionId);
  }

  /** Reconcile a persisted binding with current simctl state and issue a fresh route. */
  reconcile(
    instanceId: string,
    sessionId: string,
    lifecycleState: IOSSimulatorInstance["lifecycleState"],
    healthState: IOSSimulatorInstance["healthState"],
    errorCode: string | null,
    options: IOSSimulatorReconcileOptions = {},
  ): IOSSimulatorInstance {
    const current = this.#store.requireOwned(instanceId, sessionId);
    // The ownership sweep runs ahead of every tool dispatch, so a reconcile that
    // observed no change must not issue a new route: bumping the generation and
    // minting a new lease invalidates the (generation, leaseId) pair the caller
    // just read, which no caller can ever win against. Viewer attachment is
    // process-local and never observed by CoreSimulator, so an unchanged binding
    // keeps its viewer as well — see `normalizeViewerState` for the one sweep
    // that is allowed to correct a value inherited from a dead process. A
    // pending detach grace is excluded: re-arming that deadline in this process
    // is itself a transition, so it still issues a fresh route.
    const unchanged =
      options.preserveDetachGrace !== true &&
      current.graceExpiresAt === null &&
      current.lifecycleState === lifecycleState &&
      current.healthState === healthState &&
      current.errorCode === errorCode;
    const staleViewerState =
      options.normalizeViewerState === true && current.viewerState !== "detached";
    if (unchanged && !staleViewerState) {
      // Preserving the route must not mean preserving a lease that can no longer
      // authorize one. A persisted lease can already be expired here — restored
      // from a previous process, or idle past its TTL — and because every later
      // sweep is unchanged too, nothing would ever renew it: reads that hand back
      // a full route without heartbeating (`doctor`) would then fail
      // LEASE_EXPIRED forever. `heartbeat` is exactly the needed shape: it leaves
      // a healthy lease and its id untouched, extends one close to expiry under
      // the same id, and mints a new id only when the old one is already unusable.
      return this.#store.heartbeat(instanceId, sessionId);
    }
    this.#cancelActiveAgentMutation(instanceId);
    this.#abortLifecycleStartsForInstance(instanceId);
    const renewed = this.#store.renew(instanceId, sessionId, {
      preserveGrace: options.preserveDetachGrace,
    });
    return this.#store.update(instanceId, sessionId, {
      generation: current.generation + 1,
      lifecycleState,
      healthState,
      errorCode,
      viewerState: "detached",
      lease: renewed.lease,
      ...(options.preserveDetachGrace
        ? { graceExpiresAt: current.graceExpiresAt }
        : { graceExpiresAt: null }),
    });
  }

  /**
   * Apply an exact CoreSimulator state observed outside Cindy without issuing
   * another simctl mutation. The generation/UDID compare-and-swap is checked
   * both before and inside the serialized lifecycle queue so an old liveness
   * result cannot tear down a replacement instance.
   */
  async reconcileExternalDeviceState(
    input: IOSSimulatorExternalDeviceReconcileInput,
    releaseRuntime: (
      previous: IOSSimulatorInstance,
      next: IOSSimulatorInstance,
    ) => void | Promise<void> = () => undefined,
  ): Promise<IOSSimulatorExternalDeviceReconcileResult> {
    const before = this.#store.requireOwned(input.instanceId, input.sessionId);
    if (
      before.generation !== input.expectedGeneration ||
      before.simulatorUdid.toUpperCase() !== input.simulatorUdid.toUpperCase()
    ) {
      return {
        applied: false,
        instance: before,
        previousGeneration: input.expectedGeneration,
      };
    }
    const alreadyReconciled =
      input.state === "shutdown"
        ? before.lifecycleState === "stopped" &&
          before.healthState === "healthy" &&
          before.errorCode === null
        : before.lifecycleState === "error" &&
          before.healthState === "degraded" &&
          before.errorCode === "ORPHANED_DEVICE";
    if (alreadyReconciled) {
      return {
        applied: false,
        instance: before,
        previousGeneration: input.expectedGeneration,
      };
    }

    // Invalidate mutations that entered the queue before this transition and
    // abort the currently active Agent operation. An already-active user
    // operation remains serialized; queued work is cancelled before it runs.
    this.#mutationState(input.instanceId).takeoverEpoch += 1;
    this.#cancelActiveAgentMutation(input.instanceId);
    this.#abortLifecycleStartsForInstance(input.instanceId);
    this.#cancelDetachGrace(input.instanceId);

    return this.#serialize(input.instanceId, async () => {
      const current = this.#store.requireOwned(
        input.instanceId,
        input.sessionId,
      );
      if (
        current.generation !== input.expectedGeneration ||
        current.simulatorUdid.toUpperCase() !==
          input.simulatorUdid.toUpperCase()
      ) {
        return {
          applied: false,
          instance: current,
          previousGeneration: input.expectedGeneration,
        };
      }

      const now = new Date(this.#clock.now()).toISOString();
      const renewed = this.#store.renew(current.instanceId, current.sessionId);
      const next = this.#store.update(current.instanceId, current.sessionId, {
        generation: current.generation + 1,
        lifecycleState: input.state === "shutdown" ? "stopped" : "error",
        healthState: input.state === "shutdown" ? "healthy" : "degraded",
        errorCode: input.state === "shutdown" ? null : "ORPHANED_DEVICE",
        lease: renewed.lease,
        stoppedAt: input.state === "shutdown" ? now : current.stoppedAt,
        lastActiveAt: now,
        graceExpiresAt: null,
      });
      await releaseRuntime(current, next);
      return {
        applied: true,
        instance: this.#store.requireOwned(input.instanceId, input.sessionId),
        previousGeneration: current.generation,
      };
    });
  }

  getOwned(sessionId: string, instanceId: string): IOSSimulatorInstance {
    return this.#store.requireOwned(instanceId, sessionId);
  }

  assertRoute(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    return this.#store.assertMutationRoute(route);
  }

  heartbeatOwned(sessionId: string, instanceId: string): IOSSimulatorInstance {
    return this.#store.heartbeat(instanceId, sessionId);
  }

  heartbeat(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    this.#store.assertMutationRoute(route);
    return this.#store.heartbeat(route.instanceId, route.sessionId);
  }

  markHealth(
    sessionId: string,
    instanceId: string,
    healthState: IOSSimulatorInstance["healthState"],
    errorCode: string | null,
  ): IOSSimulatorInstance {
    return this.#store.update(instanceId, sessionId, {
      healthState,
      errorCode,
    });
  }

  mutationState(instanceId: string): IOSSimulatorMutationState {
    const state = this.#mutationState(instanceId);
    return {
      instanceId,
      activeSource: state.activeSource,
      lastSource: state.lastSource,
      queuedAgentMutations: state.queuedAgentMutations,
      agentPaused: state.agentPaused,
      takeoverPending:
        state.agentPaused &&
        (state.activeSource === "agent" || state.queuedAgentMutations > 0),
    };
  }

  takeover(route: IOSSimulatorMutationRoute): IOSSimulatorMutationState {
    this.#store.assertMutationRoute(route);
    const state = this.#mutationState(route.instanceId);
    state.agentPaused = true;
    state.takeoverEpoch += 1;
    this.#cancelActiveAgentMutation(route.instanceId);
    return this.mutationState(route.instanceId);
  }

  resumeAgentMutations(
    route: IOSSimulatorMutationRoute,
  ): IOSSimulatorMutationState {
    this.#store.assertMutationRoute(route);
    const state = this.#mutationState(route.instanceId);
    state.agentPaused = false;
    return this.mutationState(route.instanceId);
  }

  /** Invalidate queued work and synchronously abort the active mutation. */
  abortMutationsForInstance(instanceId: string): void {
    this.#mutationState(instanceId).takeoverEpoch += 1;
    this.#activeMutations.get(instanceId)?.controller.abort();
  }

  /** Abort and drain mutations owned by one Cindy task before its worktree is recycled. */
  async cancelMutationsForSession(sessionId: string): Promise<void> {
    await this.#abortAndDrainMutations(
      this.#store
        .listForSession(sessionId)
        .map((instance) => instance.instanceId),
    );
  }

  /** Abort and drain every mutation before Host-owned runtime teardown. */
  async cancelAllMutations(): Promise<void> {
    await this.#abortAndDrainMutations([
      ...new Set([
        ...this.#mutationStates.keys(),
        ...this.#activeMutations.keys(),
        ...this.#tails.keys(),
      ]),
    ]);
  }

  /** Serialize one bounded driver mutation behind lifecycle operations. */
  async runMutation<T>(
    route: IOSSimulatorMutationRoute,
    task: (instance: IOSSimulatorInstance, signal: AbortSignal) => Promise<T>,
    source: IOSSimulatorMutationSource = "agent",
  ): Promise<T> {
    const state = this.#mutationState(route.instanceId);
    if (source === "agent") {
      if (state.agentPaused) {
        throw new IOSSimulatorInstanceError(
          "AGENT_MUTATION_PAUSED",
          "Simulator input is paused because the user took control.",
          true,
        );
      }
      state.queuedAgentMutations += 1;
    } else if (
      state.activeSource === "agent" ||
      state.queuedAgentMutations > 0
    ) {
      throw new IOSSimulatorInstanceError(
        "DEVICE_BUSY",
        "An Agent is currently using this simulator. Take control before interacting.",
        true,
      );
    }
    const expectedTakeoverEpoch = state.takeoverEpoch;
    return this.#serialize(route.instanceId, async () => {
      if (source === "agent") {
        state.queuedAgentMutations = Math.max(
          0,
          state.queuedAgentMutations - 1,
        );
        if (
          state.agentPaused ||
          state.takeoverEpoch !== expectedTakeoverEpoch
        ) {
          throw new IOSSimulatorInstanceError(
            "MUTATION_CANCELLED",
            "The queued simulator action was cancelled because simulator control changed.",
            true,
          );
        }
      } else if (state.takeoverEpoch !== expectedTakeoverEpoch) {
        throw new IOSSimulatorInstanceError(
          "MUTATION_CANCELLED",
          "The queued simulator action was cancelled because its lifecycle changed.",
          true,
        );
      } else if (state.activeSource === "agent") {
        throw new IOSSimulatorInstanceError(
          "DEVICE_BUSY",
          "An Agent is currently using this simulator. Take control before interacting.",
          true,
        );
      }
      state.activeSource = source;
      const controller = new AbortController();
      const activeMutation = { source, controller };
      this.#activeMutations.set(route.instanceId, activeMutation);
      try {
        this.#store.assertMutationRoute(route);
        const instance = this.#store.heartbeat(
          route.instanceId,
          route.sessionId,
        );
        if (instance.lifecycleState !== "ready") {
          throw new IOSSimulatorInstanceError(
            "INVALID_INSTANCE_STATE",
            "The simulator must be ready before it can receive input.",
            true,
          );
        }
        const result = await task(instance, controller.signal);
        if (controller.signal.aborted) {
          throw new IOSSimulatorInstanceError(
            "MUTATION_CANCELLED",
            "The active simulator action was cancelled because simulator control changed.",
            true,
          );
        }
        return result;
      } finally {
        if (this.#activeMutations.get(route.instanceId) === activeMutation) {
          this.#activeMutations.delete(route.instanceId);
        }
        state.activeSource = null;
        state.lastSource = source;
      }
    });
  }

  /**
   * Serialize Host-owned cleanup behind any active instance mutation while
   * invalidating queued Agent work. The callback receives ownership only after
   * the exact session still owns the instance, so task removal cannot tear down
   * a device that was concurrently rebound elsewhere.
   */
  runOwnershipCleanup<T>(
    instanceId: string,
    sessionId: string,
    task: (instance: IOSSimulatorInstance, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Validate the old owner before changing mutation/grace state. The
    // serialized check below is still required because ownership can be
    // rebound while cleanup waits behind an existing instance operation.
    this.#store.requireOwned(instanceId, sessionId);
    this.abortMutationsForInstance(instanceId);
    this.#abortLifecycleStartsForInstance(instanceId);
    this.#cancelDetachGrace(instanceId);
    return this.#serialize(instanceId, async () => {
      this.#throwIfLifecycleExitCancelled();
      const instance = this.#store.requireOwned(instanceId, sessionId);
      return task(instance, this.#lifecycleExitController.signal);
    });
  }

  #cancelActiveAgentMutation(instanceId: string): void {
    const active = this.#activeMutations.get(instanceId);
    if (active?.source === "agent") active.controller.abort();
  }

  async #abortAndDrainMutations(instanceIds: string[]): Promise<void> {
    const uniqueInstanceIds = [...new Set(instanceIds)];
    for (const instanceId of uniqueInstanceIds) {
      this.abortMutationsForInstance(instanceId);
    }
    const tails = uniqueInstanceIds
      .map((instanceId) => this.#tails.get(instanceId))
      .filter((tail): tail is Promise<void> => Boolean(tail));
    await Promise.all(tails);
  }

  #lifecycleStartCancelledError(): IOSSimulatorInstanceError {
    return new IOSSimulatorInstanceError(
      "MUTATION_CANCELLED",
      "Simulator startup was cancelled because its lifecycle changed.",
      true,
    );
  }

  #lifecycleExitCancelledError(): IOSSimulatorInstanceError {
    return new IOSSimulatorInstanceError(
      "MUTATION_CANCELLED",
      "Simulator lifecycle cleanup was cancelled because Cindy is exiting.",
      true,
    );
  }

  #throwIfLifecycleExitCancelled(): void {
    const signal = this.#lifecycleExitController.signal;
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : this.#lifecycleExitCancelledError();
  }

  #throwIfLifecycleStartCancelled(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : this.#lifecycleStartCancelledError();
  }

  #abortLifecycleStarts(records: readonly ActiveLifecycleStart[]): void {
    for (const record of records) {
      if (!record.controller.signal.aborted) {
        record.controller.abort(this.#lifecycleStartCancelledError());
      }
    }
  }

  #activeLifecycleStartsForInstance(
    instanceId: string,
  ): ActiveLifecycleStart[] {
    return [...(this.#activeLifecycleStarts.get(instanceId) ?? [])];
  }

  #abortLifecycleStartsForInstance(instanceId: string): void {
    this.#abortLifecycleStarts(
      this.#activeLifecycleStartsForInstance(instanceId),
    );
  }

  #runLifecycleStart(
    route: IOSSimulatorMutationRoute,
    task: (signal: AbortSignal) => Promise<IOSSimulatorInstance>,
  ): Promise<IOSSimulatorInstance> {
    try {
      // Register before the serializer yields so teardown admission can abort
      // both an active boot and a boot queued behind another mutation.
      this.#store.assertMutationRoute(route);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#runTrackedLifecycleStart(
      route.instanceId,
      route.sessionId,
      task,
    );
  }

  #runTrackedLifecycleStart(
    operationKey: string,
    sessionId: string,
    task: (signal: AbortSignal) => Promise<IOSSimulatorInstance>,
  ): Promise<IOSSimulatorInstance> {
    const record: ActiveLifecycleStart = {
      sessionId,
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    let records = this.#activeLifecycleStarts.get(operationKey);
    if (!records) {
      records = new Set();
      this.#activeLifecycleStarts.set(operationKey, records);
    }
    records.add(record);
    const operation = this.#serialize(operationKey, () =>
      task(record.controller.signal),
    );
    record.settled = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        records?.delete(record);
        if (records?.size === 0) {
          this.#activeLifecycleStarts.delete(operationKey);
        }
      });
    return operation;
  }

  #deviceOperationKey(udid: string): string {
    return `attach:${udid.trim().toUpperCase()}`;
  }

  #bindingForUdid(udid: string): IOSSimulatorInstance | null {
    const normalized = udid.trim().toUpperCase();
    return (
      this.#store
        .listAll()
        .find(
          (instance) => instance.simulatorUdid.toUpperCase() === normalized,
        ) ?? null
    );
  }

  #createdAttachInput(
    input: IOSSimulatorCreateInput,
    created: IOSSimulatorCreatedDevice,
    sessionId: string,
  ): IOSSimulatorAttachInput {
    return {
      sessionId,
      worktreeRoot: input.worktreeRoot,
      sourceFingerprint: input.sourceFingerprint,
      creationProvenance: "cindy",
      bootProvenance: "user-booted",
      device: {
        ...input.templateDevice,
        udid: created.udid,
        name: input.name,
        state: "Shutdown",
        lastBootedAt: null,
      },
    };
  }

  #createCleanupSessionId(udid: string): string {
    return `__cindy_create_cleanup__:${udid.trim().toUpperCase()}`;
  }

  #throwCreateFailure(
    cleanupRequired: IOSSimulatorCreateCleanupRequiredError | null,
    signal: AbortSignal,
  ): void {
    this.#throwIfLifecycleStartCancelled(signal);
    if (!cleanupRequired) return;
    if (cleanupRequired.originalReason instanceof Error) {
      throw cleanupRequired.originalReason;
    }
    throw cleanupRequired;
  }

  async #finalizeCreatedDevice(
    input: IOSSimulatorCreateInput,
    created: IOSSimulatorCreatedDevice,
    signal: AbortSignal,
    cleanupRequired: IOSSimulatorCreateCleanupRequiredError | null,
  ): Promise<IOSSimulatorInstance> {
    return this.#serialize(this.#deviceOperationKey(created.udid), async () => {
      const existing = this.#bindingForUdid(created.udid);
      if (existing) {
        this.#throwCreateFailure(cleanupRequired, signal);
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_ATTACHED_ELSEWHERE",
          "The newly created simulator was attached to another Cindy session.",
        );
      }

      let rollbackBinding: IOSSimulatorInstance | null = null;
      try {
        rollbackBinding = this.attach(
          this.#createdAttachInput(
            input,
            created,
            signal.aborted || cleanupRequired
              ? this.#createCleanupSessionId(created.udid)
              : input.sessionId,
          ),
        );
        this.#throwCreateFailure(cleanupRequired, signal);
        if (created.name !== input.name) {
          if (!this.#lifecycle.renameExact) {
            throw new IOSSimulatorInstanceError(
              "SIMULATOR_CREATE_FAILED",
              "The simulator lifecycle cannot finalize the created device name.",
              true,
            );
          }
          await this.#lifecycle.renameExact(created.udid, input.name, signal);
          this.#throwCreateFailure(cleanupRequired, signal);
        }
        return rollbackBinding;
      } catch (error) {
        const current = this.#bindingForUdid(created.udid);
        if (
          current &&
          (!rollbackBinding ||
            current.instanceId !== rollbackBinding.instanceId)
        ) {
          this.#throwCreateFailure(cleanupRequired, signal);
          throw error;
        }
        rollbackBinding = current;
        if (!rollbackBinding) {
          try {
            rollbackBinding = this.attach(
              this.#createdAttachInput(
                input,
                created,
                this.#createCleanupSessionId(created.udid),
              ),
            );
          } catch {
            // A registry write failure must not prevent an exact best-effort
            // rollback. If another binding raced this fallback, protect it.
            if (this.#bindingForUdid(created.udid)) {
              this.#throwCreateFailure(cleanupRequired, signal);
              throw error;
            }
          }
        }

        // `createExact` already spent its bounded cleanup budget before
        // raising CleanupRequired. Persist the exact binding instead of
        // retrying here and extending Desktop shutdown past its deadline.
        const deleted = cleanupRequired
          ? false
          : await this.#rollbackCreatedDevice(created.udid);
        if (deleted && rollbackBinding) {
          try {
            this.#store.release(
              rollbackBinding.instanceId,
              rollbackBinding.sessionId,
            );
          } catch {
            // The device is gone, but retaining the exact binding is safer
            // than replacing the authoritative create/cancellation error.
          }
        } else if (rollbackBinding) {
          try {
            this.#store.update(
              rollbackBinding.instanceId,
              rollbackBinding.sessionId,
              {
                healthState: "degraded",
                errorCode: "SIMULATOR_DELETE_FAILED",
              },
            );
          } catch {
            // The initial attach already persisted the exact identity. Keep it
            // intact if the diagnostic update itself cannot be written.
          }
        }
        this.#throwCreateFailure(cleanupRequired, signal);
        throw error;
      }
    });
  }

  async #rollbackCreatedDevice(udid: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(this.#lifecycleStartCancelledError());
    }, CREATE_ROLLBACK_TIMEOUT_MS);
    timer.unref?.();
    try {
      await this.#lifecycle.deleteExact(udid, controller.signal);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Abort one instance's queued/active CoreSimulator starts and await settlement. */
  cancelLifecycleStartsForInstance(instanceId: string): Promise<void> {
    const records = this.#activeLifecycleStartsForInstance(instanceId);
    this.#abortLifecycleStarts(records);
    return Promise.all(records.map((record) => record.settled)).then(
      () => undefined,
    );
  }

  /** Abort starts owned by a removed Cindy task before its Host barrier drains. */
  cancelLifecycleStartsForSession(sessionId: string): Promise<void> {
    const records = [...this.#activeLifecycleStarts.values()]
      .flatMap((entries) => [...entries])
      .filter((record) => record.sessionId === sessionId);
    this.#abortLifecycleStarts(records);
    return Promise.all(records.map((record) => record.settled)).then(
      () => undefined,
    );
  }

  /** Abort every CoreSimulator start while Desktop shutdown still has a budget. */
  cancelAllLifecycleStarts(): Promise<void> {
    const records = [...this.#activeLifecycleStarts.values()].flatMap(
      (entries) => [...entries],
    );
    this.#abortLifecycleStarts(records);
    return Promise.all(records.map((record) => record.settled)).then(
      () => undefined,
    );
  }

  /** Synchronous force-quit seam; async disposal separately awaits settlement. */
  abortOperationsForExit(): void {
    for (const instanceId of [...this.#cancelGrace.keys()]) {
      this.#cancelDetachGrace(instanceId);
    }
    if (!this.#lifecycleExitController.signal.aborted) {
      this.#lifecycleExitController.abort(this.#lifecycleExitCancelledError());
    }
    for (const instanceId of this.#mutationStates.keys()) {
      this.abortMutationsForInstance(instanceId);
    }
    this.#abortLifecycleStarts(
      [...this.#activeLifecycleStarts.values()].flatMap((entries) => [
        ...entries,
      ]),
    );
  }

  #mutationState(instanceId: string): MutableMutationState {
    let state = this.#mutationStates.get(instanceId);
    if (!state) {
      state = {
        activeSource: null,
        lastSource: null,
        queuedAgentMutations: 0,
        agentPaused: false,
        takeoverEpoch: 0,
      };
      this.#mutationStates.set(instanceId, state);
    }
    return state;
  }

  async #serialize<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(instanceId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(instanceId, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(instanceId) === tail) this.#tails.delete(instanceId);
    }
  }

  start(route: IOSSimulatorMutationRoute): Promise<IOSSimulatorInstance> {
    try {
      if (this.#store.assertMutationRoute(route).lifecycleState === "ready") {
        // A ready start only renews its lease; it owns no CoreSimulator process
        // and must not be cancelled by the startup teardown seam.
        return this.#serialize(route.instanceId, async () => {
          const instance = this.#store.assertMutationRoute(route);
          if (instance.lifecycleState !== "ready") {
            throw new IOSSimulatorInstanceError(
              "INVALID_INSTANCE_STATE",
              "The simulator can no longer renew from its current state.",
              true,
            );
          }
          return this.#store.renew(instance.instanceId, instance.sessionId);
        });
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#runLifecycleStart(route, async (signal) => {
      const instance = this.#store.assertMutationRoute(route);
      this.#throwIfLifecycleStartCancelled(signal);
      if (
        instance.lifecycleState !== "stopped" &&
        instance.lifecycleState !== "error"
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_INSTANCE_STATE",
          "The simulator cannot be started from its current state.",
          true,
        );
      }
      this.#store.update(instance.instanceId, instance.sessionId, {
        lifecycleState: "booting",
        healthState: "recovering",
        errorCode: null,
        // The Host owns the boot as soon as it issues the CoreSimulator
        // mutation, even if readiness is later cancelled during bootstatus.
        bootProvenance: "agent-booted",
      });
      try {
        await this.#lifecycle.bootExact(instance.simulatorUdid, signal);
        this.#throwIfLifecycleStartCancelled(signal);
        const now = new Date(this.#clock.now()).toISOString();
        return this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "ready",
          healthState: "healthy",
          bootProvenance: "agent-booted",
          generation: instance.generation + 1,
          stoppedAt: null,
          lastActiveAt: now,
          graceExpiresAt: null,
        });
      } catch (error) {
        this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "error",
          healthState: "error",
          errorCode:
            error instanceof IOSSimulatorInstanceError
              ? error.code
              : "SIMULATOR_BOOT_FAILED",
        });
        throw error;
      }
    });
  }

  /** Reboot a persisted ready binding after CoreSimulator was lost externally. */
  recover(route: IOSSimulatorMutationRoute): Promise<IOSSimulatorInstance> {
    return this.#runLifecycleStart(route, async (signal) => {
      const instance = this.#store.assertMutationRoute(route);
      this.#throwIfLifecycleStartCancelled(signal);
      if (
        instance.lifecycleState !== "ready" &&
        instance.lifecycleState !== "error" &&
        instance.lifecycleState !== "stopped"
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_INSTANCE_STATE",
          "The simulator cannot be recovered from its current state.",
          true,
        );
      }
      this.#store.update(instance.instanceId, instance.sessionId, {
        lifecycleState: "booting",
        healthState: "recovering",
        errorCode: null,
        bootProvenance: "agent-booted",
      });
      try {
        await this.#lifecycle.bootExact(instance.simulatorUdid, signal);
        this.#throwIfLifecycleStartCancelled(signal);
        const now = new Date(this.#clock.now()).toISOString();
        return this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "ready",
          healthState: "healthy",
          errorCode: null,
          bootProvenance: "agent-booted",
          generation: instance.generation + 1,
          stoppedAt: null,
          lastActiveAt: now,
          graceExpiresAt: null,
        });
      } catch (error) {
        this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "error",
          healthState: "error",
          errorCode:
            error instanceof IOSSimulatorInstanceError
              ? error.code
              : "SIMULATOR_BOOT_FAILED",
        });
        throw error;
      }
    });
  }

  stop(route: IOSSimulatorMutationRoute): Promise<IOSSimulatorInstance> {
    let admission: IOSSimulatorMutationRoute;
    try {
      const instance = this.#store.assertMutationRoute(route);
      admission = {
        sessionId: instance.sessionId,
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
      };
    } catch (error) {
      return Promise.reject(error);
    }
    this.abortMutationsForInstance(admission.instanceId);
    this.#abortLifecycleStartsForInstance(admission.instanceId);
    return this.#serialize(admission.instanceId, async () => {
      this.#throwIfLifecycleExitCancelled();
      const instance = this.#requireAdmittedLifecycleRoute(admission);
      if (instance.lifecycleState === "stopped") return instance;
      this.#store.update(instance.instanceId, instance.sessionId, {
        lifecycleState: "stopping",
      });
      try {
        await this.#lifecycle.shutdownExact(
          instance.simulatorUdid,
          this.#lifecycleExitController.signal,
        );
        this.#throwIfLifecycleExitCancelled();
        const now = new Date(this.#clock.now()).toISOString();
        return this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "stopped",
          healthState: "healthy",
          generation: instance.generation + 1,
          stoppedAt: now,
          lastActiveAt: now,
          graceExpiresAt: null,
          errorCode: null,
        });
      } catch (error) {
        this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "error",
          healthState: "error",
          errorCode:
            error instanceof IOSSimulatorInstanceError
              ? error.code
              : "SIMULATOR_SHUTDOWN_FAILED",
        });
        throw error;
      }
    });
  }

  /** Restore a persisted detach deadline after Host startup reconciliation. */
  async resumeDetachGrace(
    instanceId: string,
    sessionId: string,
    onResourceStopped: (
      instance: IOSSimulatorInstance,
    ) => void | Promise<void> = () => undefined,
  ): Promise<boolean> {
    const instance = this.#store.requireOwned(instanceId, sessionId);
    this.#cancelDetachGrace(instanceId);
    if (
      instance.bootProvenance !== "agent-booted" ||
      instance.viewerState !== "detached" ||
      instance.graceExpiresAt === null
    ) {
      return false;
    }
    const context = this.#detachGraceContext(instance, onResourceStopped);
    const expiresAt = Date.parse(instance.graceExpiresAt);
    const delayMs = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - this.#clock.now())
      : 0;
    if (delayMs > 0) {
      this.#scheduleDetachGraceCleanup(context, delayMs);
    } else {
      await this.#attemptDetachGraceCleanup(context);
    }
    return true;
  }

  detach(
    route: IOSSimulatorMutationRoute,
    onResourceStopped: (
      instance: IOSSimulatorInstance,
    ) => void | Promise<void> = () => undefined,
  ): Promise<IOSSimulatorInstance> {
    let admission: IOSSimulatorMutationRoute;
    try {
      const instance = this.#store.assertMutationRoute(route);
      admission = {
        sessionId: instance.sessionId,
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
      };
    } catch (error) {
      return Promise.reject(error);
    }
    this.abortMutationsForInstance(admission.instanceId);
    this.#abortLifecycleStartsForInstance(admission.instanceId);
    return this.#serialize(admission.instanceId, async () => {
      const instance = this.#requireAdmittedLifecycleRoute(admission);
      this.#cancelDetachGrace(instance.instanceId);
      if (instance.bootProvenance !== "agent-booted") {
        const released = this.#store.release(
          instance.instanceId,
          instance.sessionId,
        );
        await onResourceStopped(released);
        return released;
      }

      const graceExpiresAt = new Date(
        this.#clock.now() + this.#detachGraceMs,
      ).toISOString();
      const detached = this.#store.update(
        instance.instanceId,
        instance.sessionId,
        {
          viewerState: "detached",
          graceExpiresAt,
        },
      );
      this.#scheduleDetachGraceCleanup(
        this.#detachGraceContext(detached, onResourceStopped),
        this.#detachGraceMs,
      );
      return detached;
    });
  }

  #detachGraceContext(
    instance: IOSSimulatorInstance,
    onResourceStopped: (instance: IOSSimulatorInstance) => void | Promise<void>,
  ): DetachGraceCleanupContext {
    if (instance.graceExpiresAt === null) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "Detached simulator cleanup requires a grace deadline.",
      );
    }
    return {
      instanceId: instance.instanceId,
      sessionId: instance.sessionId,
      generation: instance.generation,
      graceExpiresAt: instance.graceExpiresAt,
      onResourceStopped,
    };
  }

  #matchingDetachGrace(
    context: DetachGraceCleanupContext,
  ): IOSSimulatorInstance | null {
    const current = this.#store.get(context.instanceId);
    if (
      !current ||
      current.sessionId !== context.sessionId ||
      current.bootProvenance !== "agent-booted" ||
      current.viewerState !== "detached" ||
      current.generation !== context.generation ||
      current.graceExpiresAt !== context.graceExpiresAt
    ) {
      return null;
    }
    return current;
  }

  #cancelDetachGrace(instanceId: string): void {
    this.#cancelGrace.get(instanceId)?.cancel();
    this.#cancelGrace.delete(instanceId);
  }

  #clearDetachGraceAttempt(instanceId: string, token: symbol): void {
    if (this.#cancelGrace.get(instanceId)?.token === token) {
      this.#cancelGrace.delete(instanceId);
    }
  }

  #scheduleDetachGraceCleanup(
    context: DetachGraceCleanupContext,
    delayMs: number,
  ): void {
    this.#cancelDetachGrace(context.instanceId);
    if (this.#lifecycleExitController.signal.aborted) return;
    const token = Symbol("detach-grace-cleanup");
    const cancel = this.#scheduler.schedule(Math.max(0, delayMs), () =>
      this.#runDetachGraceCleanup(context).then(
        () => this.#clearDetachGraceAttempt(context.instanceId, token),
        (error: unknown) => {
          this.#clearDetachGraceAttempt(context.instanceId, token);
          this.#retryDetachGraceCleanup(context, error);
        },
      ),
    );
    this.#cancelGrace.set(context.instanceId, { token, cancel });
  }

  async #attemptDetachGraceCleanup(
    context: DetachGraceCleanupContext,
  ): Promise<void> {
    try {
      await this.#runDetachGraceCleanup(context);
    } catch (error) {
      this.#retryDetachGraceCleanup(context, error);
    }
  }

  #retryDetachGraceCleanup(
    context: DetachGraceCleanupContext,
    error: unknown,
  ): void {
    if (this.#lifecycleExitController.signal.aborted) return;
    const current = this.#matchingDetachGrace(context);
    if (!current) return;
    try {
      this.#onDetachCleanupError?.(error, current);
    } catch {
      // Diagnostics must never prevent ownership recovery from retrying.
    }
    this.#scheduleDetachGraceCleanup(context, this.#detachCleanupRetryMs);
  }

  #runDetachGraceCleanup(context: DetachGraceCleanupContext): Promise<void> {
    return this.#serialize(context.instanceId, async () => {
      this.#throwIfLifecycleExitCancelled();
      const current = this.#matchingDetachGrace(context);
      if (!current) return;
      this.#assertMutationAllowed?.();
      await this.#lifecycle.shutdownExact(
        current.simulatorUdid,
        this.#lifecycleExitController.signal,
      );
      this.#throwIfLifecycleExitCancelled();
      const afterShutdown = this.#matchingDetachGrace(context);
      if (!afterShutdown) return;
      // Resource release is intentionally before ownership release. The Host
      // callback is idempotent, so either failure leaves a persisted binding
      // that startup reconciliation or this retry loop can safely recover.
      await context.onResourceStopped(afterShutdown);
      const afterResourceStop = this.#matchingDetachGrace(context);
      if (!afterResourceStop) return;
      this.#store.release(
        afterResourceStop.instanceId,
        afterResourceStop.sessionId,
      );
    });
  }

  /**
   * A teardown admitted before the actor queue may follow a start that advances
   * generation. Keep the exact session/instance/lease authority captured at
   * admission, while intentionally ignoring queue-time lease expiry.
   */
  #requireAdmittedLifecycleRoute(
    route: IOSSimulatorMutationRoute,
  ): IOSSimulatorInstance {
    const current = this.#store.requireOwned(route.instanceId, route.sessionId);
    if (current.lease.id !== route.leaseId) {
      throw new IOSSimulatorInstanceError(
        "LEASE_EXPIRED",
        "The simulator control lease is no longer current.",
        true,
      );
    }
    return current;
  }

  async delete(
    route: IOSSimulatorMutationRoute,
  ): Promise<IOSSimulatorInstance> {
    return this.#serialize(route.instanceId, async () => {
      this.#throwIfLifecycleExitCancelled();
      const instance = this.#store.assertMutationRoute(route);
      if (instance.creationProvenance !== "cindy") {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_DELETE_FORBIDDEN",
          "Only simulators created by Cindy can be deleted.",
        );
      }
      this.#assertMutationAllowed?.();
      const device = await this.#lifecycle.findExact(
        instance.simulatorUdid,
        this.#lifecycleExitController.signal,
      );
      this.#throwIfLifecycleExitCancelled();
      // Physical deletion may have succeeded before ownership persistence
      // failed. A retry must still release that exact Cindy-owned binding.
      if (device !== null) {
        if (instance.lifecycleState === "ready") {
          await this.#lifecycle.shutdownExact(
            instance.simulatorUdid,
            this.#lifecycleExitController.signal,
          );
          this.#throwIfLifecycleExitCancelled();
        }
        await this.#lifecycle.deleteExact(
          instance.simulatorUdid,
          this.#lifecycleExitController.signal,
        );
        this.#throwIfLifecycleExitCancelled();
      }
      this.#cancelDetachGrace(instance.instanceId);
      return this.#store.release(instance.instanceId, instance.sessionId);
    });
  }
}
