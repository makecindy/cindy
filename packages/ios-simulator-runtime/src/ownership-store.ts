import { randomUUID } from "node:crypto";

import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type {
  IOSSimulatorAttachInput,
  IOSSimulatorInstance,
  IOSSimulatorLease,
  IOSSimulatorMutationRoute,
} from "./instance-types.js";

export interface IOSSimulatorClock {
  now(): number;
}

export interface IOSSimulatorOwnershipStoreOptions {
  clock?: IOSSimulatorClock;
  createId?: () => string;
  leaseDurationMs?: number;
  maxInstancesPerSession?: number;
  /** Previously persisted records restored before the first host call. */
  initialInstances?: IOSSimulatorInstance[];
  /** Called after each mutation so a host can persist a bounded snapshot. */
  onChange?: (instances: IOSSimulatorInstance[]) => void;
  /** Fail-closed gate used by persisted stores before changing ownership. */
  assertMutationAllowed?: () => void;
}

const DEFAULT_LEASE_DURATION_MS = 60_000;

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `${label} is required`,
    );
  }
  return normalized;
}

function copyInstance(instance: IOSSimulatorInstance): IOSSimulatorInstance {
  return { ...instance, lease: { ...instance.lease } };
}

/**
 * In-memory Phase 1 ownership registry. Its interface is intentionally
 * persistence-friendly so Phase 2 recovery can replace the backing store.
 */
export class IOSSimulatorOwnershipStore {
  readonly #clock: IOSSimulatorClock;
  readonly #createId: () => string;
  readonly #leaseDurationMs: number;
  readonly #maxInstancesPerSession: number;
  readonly #onChange: ((instances: IOSSimulatorInstance[]) => void) | null;
  readonly #assertMutationAllowed: (() => void) | null;
  readonly #instances = new Map<string, IOSSimulatorInstance>();
  readonly #instanceByUdid = new Map<string, string>();

  constructor(options: IOSSimulatorOwnershipStoreOptions = {}) {
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#createId = options.createId ?? randomUUID;
    this.#leaseDurationMs =
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#maxInstancesPerSession = options.maxInstancesPerSession ?? 1;
    this.#onChange = options.onChange ?? null;
    this.#assertMutationAllowed = options.assertMutationAllowed ?? null;
    if (
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs <= 0 ||
      !Number.isSafeInteger(this.#maxInstancesPerSession) ||
      this.#maxInstancesPerSession <= 0
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "Ownership limits must be positive integers",
      );
    }
    for (const instance of options.initialInstances ?? []) {
      this.#restore(instance);
    }
  }

  #restore(instance: IOSSimulatorInstance): void {
    const copy = {
      ...copyInstance(instance),
      simulatorUdid: requireNonEmpty(
        instance.simulatorUdid,
        "simulatorUdid",
      ).toUpperCase(),
    };
    if (
      this.#instances.has(copy.instanceId) ||
      this.#instanceByUdid.has(copy.simulatorUdid)
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "Persisted simulator ownership contains duplicate identities",
      );
    }
    this.#instances.set(copy.instanceId, copy);
    this.#instanceByUdid.set(copy.simulatorUdid, copy.instanceId);
  }

  #changed(): void {
    this.#onChange?.(this.listAll());
  }

  #newLease(now: number): IOSSimulatorLease {
    return {
      id: this.#createId(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#leaseDurationMs).toISOString(),
    };
  }

  attach(input: IOSSimulatorAttachInput): IOSSimulatorInstance {
    const sessionId = requireNonEmpty(input.sessionId, "sessionId");
    const udid = requireNonEmpty(
      input.device.udid,
      "simulatorUdid",
    ).toUpperCase();
    const existingId = this.#instanceByUdid.get(udid);
    if (existingId) {
      const existing = this.#instances.get(existingId);
      if (existing?.sessionId !== sessionId) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_ATTACHED_ELSEWHERE",
          "The simulator is attached to another Cindy session.",
        );
      }
      if (existing) return this.renew(existing.instanceId, sessionId);
    }
    if (this.listForSession(sessionId).length >= this.#maxInstancesPerSession) {
      throw new IOSSimulatorInstanceError(
        "SESSION_INSTANCE_LIMIT_REACHED",
        "This Cindy session already has the maximum number of simulator instances.",
      );
    }
    this.#assertMutationAllowed?.();

    const now = this.#clock.now();
    const state =
      input.device.state.toLowerCase() === "booted" ? "ready" : "stopped";
    const instance: IOSSimulatorInstance = {
      instanceId: this.#createId(),
      sessionId,
      sessionKind: "local",
      worktreeRoot: requireNonEmpty(input.worktreeRoot, "worktreeRoot"),
      sourceFingerprint: requireNonEmpty(
        input.sourceFingerprint,
        "sourceFingerprint",
      ),
      simulatorUdid: udid,
      simulatorName: requireNonEmpty(input.device.name, "simulatorName"),
      runtimeIdentifier: requireNonEmpty(
        input.device.runtimeIdentifier,
        "runtimeIdentifier",
      ),
      deviceTypeIdentifier: requireNonEmpty(
        input.device.deviceTypeIdentifier ?? "unknown",
        "deviceTypeIdentifier",
      ),
      creationProvenance: input.creationProvenance ?? "external",
      bootProvenance:
        input.bootProvenance ??
        (state === "ready" ? "preexisting" : "user-booted"),
      generation: 1,
      lifecycleState: state,
      viewerState: "attached",
      healthState: "healthy",
      lease: this.#newLease(now),
      createdAt: new Date(now).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
      stoppedAt: state === "stopped" ? new Date(now).toISOString() : null,
      graceExpiresAt: null,
      errorCode: null,
    };
    this.#instances.set(instance.instanceId, instance);
    this.#instanceByUdid.set(udid, instance.instanceId);
    try {
      this.#changed();
    } catch (error) {
      this.#instances.delete(instance.instanceId);
      this.#instanceByUdid.delete(udid);
      throw error;
    }
    return copyInstance(instance);
  }

  listForSession(sessionId: string): IOSSimulatorInstance[] {
    const normalized = requireNonEmpty(sessionId, "sessionId");
    return Array.from(this.#instances.values())
      .filter((instance) => instance.sessionId === normalized)
      .map(copyInstance);
  }

  listAll(): IOSSimulatorInstance[] {
    return Array.from(this.#instances.values()).map(copyInstance);
  }

  get(instanceId: string): IOSSimulatorInstance | null {
    const instance = this.#instances.get(instanceId);
    return instance ? copyInstance(instance) : null;
  }

  requireOwned(instanceId: string, sessionId: string): IOSSimulatorInstance {
    const instance = this.#instances.get(
      requireNonEmpty(instanceId, "instanceId"),
    );
    if (!instance) {
      throw new IOSSimulatorInstanceError(
        "INSTANCE_NOT_FOUND",
        "The iOS Simulator instance no longer exists.",
      );
    }
    if (instance.sessionId !== requireNonEmpty(sessionId, "sessionId")) {
      throw new IOSSimulatorInstanceError(
        "INSTANCE_NOT_OWNED",
        "The iOS Simulator instance belongs to another Cindy session.",
      );
    }
    return copyInstance(instance);
  }

  assertMutationRoute(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    const instance = this.requireOwned(route.instanceId, route.sessionId);
    if (instance.generation !== route.generation) {
      throw new IOSSimulatorInstanceError(
        "STALE_GENERATION",
        "The simulator restarted or was reattached. Refresh instance state and retry.",
        true,
      );
    }
    if (instance.lease.id !== route.leaseId) {
      throw new IOSSimulatorInstanceError(
        "LEASE_EXPIRED",
        "The simulator control lease is no longer current.",
        true,
      );
    }
    if (Date.parse(instance.lease.expiresAt) <= this.#clock.now()) {
      throw new IOSSimulatorInstanceError(
        "LEASE_EXPIRED",
        "The simulator control lease expired.",
        true,
      );
    }
    return instance;
  }

  renew(
    instanceId: string,
    sessionId: string,
    options: { preserveGrace?: boolean } = {},
  ): IOSSimulatorInstance {
    const instance = this.requireOwned(instanceId, sessionId);
    const now = this.#clock.now();
    return this.update(instanceId, sessionId, {
      lease: this.#newLease(now),
      lastActiveAt: new Date(now).toISOString(),
      ...(options.preserveGrace ? {} : { graceExpiresAt: null }),
    });
  }

  /** Extend an active lease as needed; hot input paths do not persist on every sample. */
  heartbeat(instanceId: string, sessionId: string): IOSSimulatorInstance {
    const instance = this.requireOwned(instanceId, sessionId);
    this.#assertMutationAllowed?.();
    const now = this.#clock.now();
    const expiresAt = Date.parse(instance.lease.expiresAt);
    if (expiresAt > now && expiresAt - now > this.#leaseDurationMs / 2) {
      return instance;
    }
    const lease =
      expiresAt <= now
        ? this.#newLease(now)
        : {
            ...instance.lease,
            expiresAt: new Date(now + this.#leaseDurationMs).toISOString(),
          };
    return this.update(instanceId, sessionId, {
      lease,
      lastActiveAt: new Date(now).toISOString(),
    });
  }

  update(
    instanceId: string,
    sessionId: string,
    patch: Partial<
      Omit<IOSSimulatorInstance, "instanceId" | "sessionId" | "simulatorUdid">
    >,
  ): IOSSimulatorInstance {
    const current = this.requireOwned(instanceId, sessionId);
    this.#assertMutationAllowed?.();
    const next: IOSSimulatorInstance = {
      ...current,
      ...patch,
      lease: patch.lease ? { ...patch.lease } : current.lease,
    };
    this.#instances.set(instanceId, next);
    try {
      this.#changed();
    } catch (error) {
      this.#instances.set(instanceId, current);
      throw error;
    }
    return copyInstance(next);
  }

  release(instanceId: string, sessionId: string): IOSSimulatorInstance {
    const current = this.requireOwned(instanceId, sessionId);
    this.#assertMutationAllowed?.();
    this.#instances.delete(instanceId);
    this.#instanceByUdid.delete(current.simulatorUdid);
    try {
      this.#changed();
    } catch (error) {
      this.#instances.set(instanceId, current);
      this.#instanceByUdid.set(current.simulatorUdid, instanceId);
      throw error;
    }
    return current;
  }
}
