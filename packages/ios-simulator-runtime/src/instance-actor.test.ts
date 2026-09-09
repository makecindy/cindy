import { describe, expect, it, vi } from "vitest";

import { IOSSimulatorInstanceActor } from "./instance-actor.js";
import { IOSSimulatorOwnershipStore } from "./ownership-store.js";
import {
  IOSSimulatorCreateCleanupRequiredError,
  type IOSSimulatorSimctlLifecycle,
} from "./simctl-lifecycle.js";
import type { IOSSimulatorInstance } from "./instance-types.js";
import type { IOSSimulatorDevice } from "./types.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";
const DEVICE: IOSSimulatorDevice = {
  udid: UDID,
  name: "iPhone 17 Pro",
  state: "Shutdown",
  isAvailable: true,
  availabilityError: null,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
  runtimeName: "iOS 26.4",
  runtimeVersion: "26.4",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  lastBootedAt: null,
};

function createHarness(
  options: {
    booted?: boolean;
    cindy?: boolean;
    onDetachCleanupError?: (error: unknown) => void;
    onStoreChange?: (instances: IOSSimulatorInstance[]) => void;
  } = {},
) {
  let now = 1_000;
  let id = 0;
  const store = new IOSSimulatorOwnershipStore({
    clock: { now: () => now },
    createId: () => `id-${++id}`,
    leaseDurationMs: 1_000_000,
    onChange: options.onStoreChange,
  });
  const scheduled: Array<() => void | Promise<void>> = [];
  const lifecycle: IOSSimulatorSimctlLifecycle = {
    findExact: vi.fn(async () => DEVICE),
    bootExact: vi.fn(async () => ({ ...DEVICE, state: "Booted" })),
    shutdownExact: vi.fn(async () => undefined),
    createExact: vi.fn(),
    deleteExact: vi.fn(async () => undefined),
  };
  const actor = new IOSSimulatorInstanceActor({
    store,
    lifecycle,
    clock: { now: () => now },
    detachGraceMs: 10 * 60_000,
    detachCleanupRetryMs: 1_000,
    onDetachCleanupError: options.onDetachCleanupError,
    scheduler: {
      schedule: (_delay, task) => {
        const run = () => {
          const index = scheduled.indexOf(run);
          if (index >= 0) scheduled.splice(index, 1);
          return task();
        };
        scheduled.push(run);
        return () => {
          const index = scheduled.indexOf(run);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
    },
  });
  const instance = actor.attach({
    sessionId: "session-a",
    worktreeRoot: "/tmp/session-a",
    sourceFingerprint: "abc",
    device: { ...DEVICE, state: options.booted ? "Booted" : "Shutdown" },
    creationProvenance: options.cindy ? "cindy" : "external",
  });
  return {
    actor,
    store,
    lifecycle,
    scheduled,
    setNow(value: number) {
      now = value;
    },
    route(candidate = instance) {
      return {
        sessionId: candidate.sessionId,
        instanceId: candidate.instanceId,
        generation: candidate.generation,
        leaseId: candidate.lease.id,
      };
    },
    instance,
  };
}

describe("IOSSimulatorInstanceActor", () => {
  it("keeps the current route when a reconcile observes no change", () => {
    const harness = createHarness();
    const before = harness.instance;

    const reconciled = harness.actor.reconcile(
      before.instanceId,
      before.sessionId,
      before.lifecycleState,
      before.healthState,
      before.errorCode,
    );

    expect(reconciled.generation).toBe(before.generation);
    expect(reconciled.lease.id).toBe(before.lease.id);
    // CoreSimulator says nothing about viewer attachment, so an unchanged
    // binding must not have a live viewer kicked out from under it.
    expect(reconciled.viewerState).toBe("attached");
    expect(() =>
      harness.actor.assertRoute(harness.route(before)),
    ).not.toThrow();
  });

  it("renews an expired lease on an unchanged reconcile without issuing a new generation", () => {
    const harness = createHarness();
    const before = harness.instance;
    // A persisted lease restored from a previous process, or idle past its TTL.
    harness.setNow(Date.parse(before.lease.expiresAt) + 1);

    const reconciled = harness.actor.reconcile(
      before.instanceId,
      before.sessionId,
      before.lifecycleState,
      before.healthState,
      before.errorCode,
    );

    // Without this, every later sweep stays unchanged too, so the binding could
    // never produce a usable route again.
    expect(reconciled.generation).toBe(before.generation);
    expect(reconciled.lease.id).not.toBe(before.lease.id);
    expect(reconciled.viewerState).toBe(before.viewerState);
    expect(() =>
      harness.actor.assertRoute(harness.route(reconciled)),
    ).not.toThrow();
  });

  it("issues a new route when the observed state changed", () => {
    const harness = createHarness();
    const before = harness.instance;

    const reconciled = harness.actor.reconcile(
      before.instanceId,
      before.sessionId,
      "ready",
      before.healthState,
      before.errorCode,
    );

    expect(reconciled.generation).toBe(before.generation + 1);
    expect(reconciled.lease.id).not.toBe(before.lease.id);
    expect(reconciled.viewerState).toBe("detached");
  });

  it("normalizes a viewer state inherited from a dead process", () => {
    const harness = createHarness();
    const before = harness.instance;

    const reconciled = harness.actor.reconcile(
      before.instanceId,
      before.sessionId,
      before.lifecycleState,
      before.healthState,
      before.errorCode,
      { normalizeViewerState: true },
    );

    expect(reconciled.viewerState).toBe("detached");
  });

  it("increments generation across exact start and stop operations", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    expect(started).toMatchObject({
      lifecycleState: "ready",
      bootProvenance: "agent-booted",
      generation: 2,
    });
    expect(harness.lifecycle.bootExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );

    const stopped = await harness.actor.stop(harness.route(started));
    expect(stopped).toMatchObject({ lifecycleState: "stopped", generation: 3 });
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    await expect(
      harness.actor.stop(harness.route(started)),
    ).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
  });

  it("cancels an in-flight start before an admitted stop waits on the serializer", async () => {
    const harness = createHarness();
    let bootSignal: AbortSignal | undefined;
    vi.mocked(harness.lifecycle.bootExact).mockImplementationOnce(
      (_udid, signal) =>
        new Promise((_resolve, reject) => {
          bootSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const starting = harness.actor.start(harness.route());
    await vi.waitFor(() =>
      expect(harness.lifecycle.bootExact).toHaveBeenCalledWith(
        UDID,
        expect.any(AbortSignal),
      ),
    );
    const route = harness.route();
    const stopping = harness.actor.stop(route);
    expect(bootSignal?.aborted).toBe(true);
    harness.setNow(2_000_000);
    route.sessionId = "forged-session";
    route.instanceId = "forged-instance";
    route.leaseId = "forged-lease";

    await expect(starting).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(stopping).resolves.toMatchObject({
      lifecycleState: "stopped",
      generation: 2,
    });
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
  });

  it("aborts an in-flight stop through the force-exit seam", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    let shutdownSignal: AbortSignal | undefined;
    vi.mocked(harness.lifecycle.shutdownExact).mockImplementationOnce(
      (_udid, signal) =>
        new Promise((_resolve, reject) => {
          shutdownSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const stopping = harness.actor.stop(harness.route(started));
    await vi.waitFor(() => expect(shutdownSignal).toBeDefined());
    harness.actor.abortOperationsForExit();

    expect(shutdownSignal?.aborted).toBe(true);
    await expect(stopping).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
  });

  it("cancels an in-flight start while preserving Host-owned detach grace", async () => {
    const harness = createHarness();
    let bootSignal: AbortSignal | undefined;
    vi.mocked(harness.lifecycle.bootExact).mockImplementationOnce(
      (_udid, signal) =>
        new Promise((_resolve, reject) => {
          bootSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const starting = harness.actor.start(harness.route());
    await vi.waitFor(() =>
      expect(harness.lifecycle.bootExact).toHaveBeenCalledWith(
        UDID,
        expect.any(AbortSignal),
      ),
    );
    const detaching = harness.actor.detach(harness.route());
    expect(bootSignal?.aborted).toBe(true);

    await expect(starting).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(detaching).resolves.toMatchObject({
      generation: 1,
      viewerState: "detached",
      bootProvenance: "agent-booted",
    });
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it("cancels startup by owning session and through the force-exit seam", async () => {
    const harness = createHarness();
    let bootSignal: AbortSignal | undefined;
    vi.mocked(harness.lifecycle.bootExact).mockImplementation(
      (_udid, signal) =>
        new Promise((_resolve, reject) => {
          bootSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const starting = harness.actor.start(harness.route());
    await vi.waitFor(() => expect(bootSignal).toBeDefined());
    await harness.actor.cancelLifecycleStartsForSession("another-session");
    expect(bootSignal?.aborted).toBe(false);

    const sessionCancellation =
      harness.actor.cancelLifecycleStartsForSession("session-a");
    expect(bootSignal?.aborted).toBe(true);
    await sessionCancellation;
    await expect(starting).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });

    bootSignal = undefined;
    const recovering = harness.actor.recover(harness.route());
    await vi.waitFor(() =>
      expect(harness.lifecycle.bootExact).toHaveBeenCalledTimes(2),
    );
    const recoverySignal = vi.mocked(harness.lifecycle.bootExact).mock
      .calls[1]?.[1];
    expect(() => harness.actor.abortOperationsForExit()).not.toThrow();
    expect(recoverySignal?.aborted).toBe(true);
    await expect(recovering).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
  });

  it("does not let an admitted teardown cross a replacement lease", async () => {
    const harness = createHarness({ booted: true });
    const route = harness.route();
    const renewing = harness.actor.start(route);
    const stopping = harness.actor.stop(route);

    await expect(renewing).resolves.toMatchObject({
      lease: { id: expect.not.stringMatching(route.leaseId) },
    });
    await expect(stopping).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it("reboots a persisted binding after CoreSimulator loss and invalidates its old route", async () => {
    const harness = createHarness({ booted: true });
    const recovered = await harness.actor.recover(harness.route());

    expect(recovered).toMatchObject({
      lifecycleState: "ready",
      healthState: "healthy",
      bootProvenance: "agent-booted",
      generation: harness.instance.generation + 1,
    });
    expect(harness.lifecycle.bootExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    await expect(harness.actor.recover(harness.route())).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
  });

  it("records an external shutdown without issuing another simctl mutation", async () => {
    const harness = createHarness({ booted: true });
    const releaseRuntime = vi.fn(async () => undefined);

    const result = await harness.actor.reconcileExternalDeviceState(
      {
        sessionId: harness.instance.sessionId,
        instanceId: harness.instance.instanceId,
        simulatorUdid: harness.instance.simulatorUdid,
        expectedGeneration: harness.instance.generation,
        state: "shutdown",
      },
      releaseRuntime,
    );

    expect(result).toMatchObject({
      applied: true,
      previousGeneration: harness.instance.generation,
      instance: {
        lifecycleState: "stopped",
        healthState: "healthy",
        errorCode: null,
        generation: harness.instance.generation + 1,
        viewerState: "attached",
      },
    });
    expect(releaseRuntime).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.bootExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it("marks an externally missing device as orphaned", async () => {
    const harness = createHarness({ booted: true });

    const result = await harness.actor.reconcileExternalDeviceState({
      sessionId: harness.instance.sessionId,
      instanceId: harness.instance.instanceId,
      simulatorUdid: harness.instance.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "missing",
    });

    expect(result).toMatchObject({
      applied: true,
      instance: {
        lifecycleState: "error",
        healthState: "degraded",
        errorCode: "ORPHANED_DEVICE",
        generation: harness.instance.generation + 1,
      },
    });
    expect(harness.lifecycle.bootExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it("cancels active and queued Agent mutations before applying external state", async () => {
    const harness = createHarness({ booted: true });
    let releaseActive: () => void = () => undefined;
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
      },
    );
    const queued = harness.actor
      .runMutation(harness.route(), async () => "should-not-run")
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const reconcile = harness.actor.reconcileExternalDeviceState({
      sessionId: harness.instance.sessionId,
      instanceId: harness.instance.instanceId,
      simulatorUdid: harness.instance.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "shutdown",
    });
    expect(activeSignal?.aborted).toBe(true);
    releaseActive();

    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(queued).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(reconcile).resolves.toMatchObject({
      applied: true,
      instance: { lifecycleState: "stopped" },
    });
  });

  it("cancels an active Agent mutation as soon as stop is admitted", async () => {
    const harness = createHarness({ booted: true });
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    await vi.waitFor(() => expect(activeSignal).toBeDefined());

    const stopping = harness.actor.stop(harness.route());
    expect(activeSignal?.aborted).toBe(true);
    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(stopping).resolves.toMatchObject({
      lifecycleState: "stopped",
    });
  });

  it("cancels an active user mutation through the force-exit seam", async () => {
    const harness = createHarness({ booted: true });
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      "user",
    );
    await vi.waitFor(() => expect(activeSignal).toBeDefined());

    expect(() => harness.actor.abortOperationsForExit()).not.toThrow();
    expect(activeSignal?.aborted).toBe(true);
    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  });

  it("aborts and drains active and queued mutations for one session", async () => {
    const harness = createHarness({ booted: true });
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor
      .runMutation(
        harness.route(),
        async (_instance, signal) => {
          activeSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        "user",
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const queued = harness.actor
      .runMutation(harness.route(), async () => "should-not-run", "user")
      .catch((error: unknown) => error);

    const cancelling = harness.actor.cancelMutationsForSession("session-a");
    expect(activeSignal?.aborted).toBe(true);
    await expect(cancelling).resolves.toBeUndefined();
    await expect(active).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(queued).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
  });

  it("ignores a stale liveness result without cancelling the new generation", async () => {
    const harness = createHarness({ booted: true });
    const recovered = await harness.actor.recover(harness.route());
    let releaseMutation: () => void = () => undefined;
    let mutationSignal: AbortSignal | undefined;
    const mutation = harness.actor.runMutation(
      harness.route(recovered),
      async (_instance, signal) => {
        mutationSignal = signal;
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
        return "completed";
      },
    );
    await vi.waitFor(() => expect(mutationSignal).toBeDefined());

    const result = await harness.actor.reconcileExternalDeviceState({
      sessionId: recovered.sessionId,
      instanceId: recovered.instanceId,
      simulatorUdid: recovered.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "shutdown",
    });

    expect(result).toMatchObject({
      applied: false,
      instance: { generation: recovered.generation, lifecycleState: "ready" },
    });
    expect(mutationSignal?.aborted).toBe(false);
    releaseMutation();
    await expect(mutation).resolves.toBe("completed");
  });

  it("does not advance generation for a repeated external shutdown", async () => {
    const harness = createHarness({ booted: true });
    const first = await harness.actor.reconcileExternalDeviceState({
      sessionId: harness.instance.sessionId,
      instanceId: harness.instance.instanceId,
      simulatorUdid: harness.instance.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "shutdown",
    });
    const second = await harness.actor.reconcileExternalDeviceState({
      sessionId: first.instance.sessionId,
      instanceId: first.instance.instanceId,
      simulatorUdid: first.instance.simulatorUdid,
      expectedGeneration: first.instance.generation,
      state: "shutdown",
    });

    expect(second).toMatchObject({
      applied: false,
      instance: { generation: first.instance.generation },
    });
  });

  it("keeps agent-booted devices for grace then shuts down and releases", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    harness.setNow(2_000);
    const detached = await harness.actor.detach(
      harness.route(started),
      onResourceReleased,
    );

    expect(detached.viewerState).toBe("detached");
    expect(detached.graceExpiresAt).toBe(new Date(602_000).toISOString());
    expect(harness.scheduled).toHaveLength(1);
    expect(onResourceReleased).not.toHaveBeenCalled();
    await harness.scheduled[0]?.();
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(onResourceReleased).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: detached.instanceId }),
    );
  });

  it("restores the remaining persisted detach grace after reconciliation", async () => {
    const original = createHarness();
    const started = await original.actor.start(original.route());
    const detached = await original.actor.detach(original.route(started));
    const scheduled: Array<{
      delayMs: number;
      task: () => void | Promise<void>;
    }> = [];
    let now = 101_000;
    const lifecycle = {
      ...original.lifecycle,
      shutdownExact: vi.fn(async () => undefined),
    };
    let restoredId = 0;
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      createId: () => `restored-${++restoredId}`,
      initialInstances: [detached],
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
      scheduler: {
        schedule: (delayMs, task) => {
          const entry = { delayMs, task };
          scheduled.push(entry);
          return () => {
            const index = scheduled.indexOf(entry);
            if (index >= 0) scheduled.splice(index, 1);
          };
        },
      },
    });
    const reconciled = actor.reconcile(
      detached.instanceId,
      detached.sessionId,
      "ready",
      "healthy",
      null,
      { preserveDetachGrace: true },
    );
    const onResourceStopped = vi.fn();

    await expect(
      actor.resumeDetachGrace(
        reconciled.instanceId,
        reconciled.sessionId,
        onResourceStopped,
      ),
    ).resolves.toBe(true);

    expect(reconciled.graceExpiresAt).toBe(detached.graceExpiresAt);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(
      Date.parse(detached.graceExpiresAt!) - now,
    );
    await scheduled[0]?.task();
    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    expect(store.get(detached.instanceId)).toBeNull();
    expect(onResourceStopped).toHaveBeenCalledTimes(1);
  });

  it("immediately recovers an expired persisted detach grace", async () => {
    const original = createHarness();
    const started = await original.actor.start(original.route());
    const detached = await original.actor.detach(original.route(started));
    const now = Date.parse(detached.graceExpiresAt!) + 1;
    const lifecycle = {
      ...original.lifecycle,
      shutdownExact: vi.fn(async () => undefined),
    };
    let restoredId = 0;
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      createId: () => `restored-${++restoredId}`,
      initialInstances: [detached],
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const reconciled = actor.reconcile(
      detached.instanceId,
      detached.sessionId,
      "ready",
      "healthy",
      null,
      { preserveDetachGrace: true },
    );
    const onResourceStopped = vi.fn();

    await expect(
      actor.resumeDetachGrace(
        reconciled.instanceId,
        reconciled.sessionId,
        onResourceStopped,
      ),
    ).resolves.toBe(true);

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    expect(store.get(detached.instanceId)).toBeNull();
    expect(onResourceStopped).toHaveBeenCalledTimes(1);
  });

  it("releases preexisting devices immediately without shutdown", async () => {
    const harness = createHarness({ booted: true });
    const onResourceReleased = vi.fn();
    const detached = await harness.actor.detach(
      harness.route(),
      onResourceReleased,
    );

    expect(detached.bootProvenance).toBe("preexisting");
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(onResourceReleased).toHaveBeenCalledWith(detached);
  });

  it("retries grace cleanup without rejecting when shutdown fails", async () => {
    const onDetachCleanupError = vi.fn();
    const harness = createHarness({ onDetachCleanupError });
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    vi.mocked(harness.lifecycle.shutdownExact).mockRejectedValueOnce(
      new Error("shutdown failed"),
    );

    const detached = await harness.actor.detach(
      harness.route(started),
      onResourceReleased,
    );
    await expect(harness.scheduled[0]?.()).resolves.toBeUndefined();

    expect(harness.store.get(detached.instanceId)).not.toBeNull();
    expect(onResourceReleased).not.toHaveBeenCalled();
    expect(onDetachCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "shutdown failed" }),
      expect.objectContaining({ instanceId: detached.instanceId }),
    );
    expect(harness.scheduled).toHaveLength(1);

    await expect(harness.scheduled[0]?.()).resolves.toBeUndefined();
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(onResourceReleased).toHaveBeenCalledTimes(1);
  });

  it("keeps ownership and retries when deferred resource release fails", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceStopped = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("resource release failed"));
    const detached = await harness.actor.detach(
      harness.route(started),
      onResourceStopped,
    );

    await expect(harness.scheduled[0]?.()).resolves.toBeUndefined();
    expect(harness.store.get(detached.instanceId)).not.toBeNull();
    expect(harness.scheduled).toHaveLength(1);

    await expect(harness.scheduled[0]?.()).resolves.toBeUndefined();
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(onResourceStopped).toHaveBeenCalledTimes(2);
  });

  it("cancels a retry when the detached simulator is reattached", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    vi.mocked(harness.lifecycle.shutdownExact).mockRejectedValueOnce(
      new Error("shutdown failed"),
    );
    await harness.actor.detach(harness.route(started));
    await harness.scheduled[0]?.();
    const retry = harness.scheduled[0]!;

    harness.actor.attach({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      device: { ...DEVICE, state: "Booted" },
      creationProvenance: "external",
      bootProvenance: "agent-booted",
    });

    expect(harness.scheduled).toHaveLength(0);
    await retry();
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledTimes(1);
  });

  it("cancels deferred resource release when a detached device is reattached", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    await harness.actor.detach(harness.route(started), onResourceReleased);
    expect(harness.scheduled).toHaveLength(1);

    harness.actor.attach({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      device: { ...DEVICE, state: "Booted" },
      creationProvenance: "external",
      bootProvenance: "agent-booted",
    });

    expect(harness.scheduled).toHaveLength(0);
    expect(onResourceReleased).not.toHaveBeenCalled();
  });

  it("aborts in-flight detach cleanup on exit without scheduling a retry", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceStopped = vi.fn();
    let shutdownSignal: AbortSignal | undefined;
    vi.mocked(harness.lifecycle.shutdownExact).mockImplementationOnce(
      (_udid, signal) =>
        new Promise((_resolve, reject) => {
          shutdownSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const detached = await harness.actor.detach(
      harness.route(started),
      onResourceStopped,
    );

    const cleanup = Promise.resolve(harness.scheduled[0]?.());
    await vi.waitFor(() => expect(shutdownSignal).toBeDefined());
    harness.actor.abortOperationsForExit();

    expect(shutdownSignal?.aborted).toBe(true);
    await expect(cleanup).resolves.toBeUndefined();
    expect(harness.store.get(detached.instanceId)).not.toBeNull();
    expect(harness.scheduled).toHaveLength(0);
    expect(onResourceStopped).not.toHaveBeenCalled();
  });

  it("serializes reattachment behind an in-flight grace shutdown", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    let finishShutdown: () => void = () => undefined;
    vi.mocked(harness.lifecycle.shutdownExact).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    await harness.actor.detach(harness.route(started), onResourceReleased);

    const cleanup = Promise.resolve(harness.scheduled[0]?.());
    await vi.waitFor(() =>
      expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(
        UDID,
        expect.any(AbortSignal),
      ),
    );
    let reattached = false;
    const reattach = harness.actor
      .attachSerialized({
        sessionId: "session-a",
        worktreeRoot: "/tmp/session-a",
        sourceFingerprint: "abc",
        device: { ...DEVICE, state: "Booted" },
        creationProvenance: "external",
        bootProvenance: "agent-booted",
      })
      .then((instance) => {
        reattached = true;
        return instance;
      });
    await Promise.resolve();
    expect(reattached).toBe(false);

    finishShutdown();
    await cleanup;
    const next = await reattach;
    expect(next.instanceId).not.toBe(started.instanceId);
    expect(harness.store.listAll()).toEqual([next]);
    expect(onResourceReleased).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: started.instanceId }),
    );
  });

  it("never deletes an external simulator", async () => {
    const harness = createHarness();
    await expect(harness.actor.delete(harness.route())).rejects.toMatchObject({
      code: "SIMULATOR_DELETE_FORBIDDEN",
    });
    expect(harness.lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it("deletes only an exact Cindy-provenance simulator", async () => {
    const harness = createHarness({ cindy: true });
    await harness.actor.delete(harness.route());
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    expect(harness.store.get(harness.instance.instanceId)).toBeNull();
  });

  it("shuts down a ready Cindy simulator before deleting it", async () => {
    const harness = createHarness({ booted: true, cindy: true });
    await harness.actor.delete(harness.route());
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledWith(
      UDID,
      expect.any(AbortSignal),
    );
  });

  it("releases ownership on retry when the Cindy simulator was already physically deleted", async () => {
    let failOwnershipWrite = false;
    let physicalDeviceExists = true;
    const harness = createHarness({
      cindy: true,
      onStoreChange: () => {
        if (failOwnershipWrite) throw new Error("registry write failed");
      },
    });
    vi.mocked(harness.lifecycle.findExact).mockImplementation(async () =>
      physicalDeviceExists ? DEVICE : null,
    );
    vi.mocked(harness.lifecycle.deleteExact).mockImplementation(async () => {
      physicalDeviceExists = false;
    });

    failOwnershipWrite = true;
    await expect(harness.actor.delete(harness.route())).rejects.toThrow(
      "registry write failed",
    );
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledTimes(1);
    expect(harness.store.get(harness.instance.instanceId)).not.toBeNull();

    failOwnershipWrite = false;
    await harness.actor.delete(harness.route());

    expect(harness.lifecycle.findExact).toHaveBeenCalledTimes(2);
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledTimes(1);
    expect(harness.store.get(harness.instance.instanceId)).toBeNull();
  });

  it("creates a Cindy-owned simulator from an exact installed template", async () => {
    const harness = createHarness();
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    vi.mocked(harness.lifecycle.createExact).mockResolvedValue({
      udid: createdUdid,
      name: "Cindy iPhone",
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });
    await harness.actor.detach(harness.route());

    const created = await harness.actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: "Cindy iPhone",
      templateDevice: DEVICE,
    });

    expect(harness.lifecycle.createExact).toHaveBeenCalledWith(
      {
        name: "Cindy iPhone",
        runtimeIdentifier: DEVICE.runtimeIdentifier,
        deviceTypeIdentifier: DEVICE.deviceTypeIdentifier,
      },
      expect.any(AbortSignal),
    );
    expect(created).toMatchObject({
      simulatorUdid: createdUdid,
      simulatorName: "Cindy iPhone",
      creationProvenance: "cindy",
      lifecycleState: "stopped",
    });
  });

  it("persists exact ownership before renaming an interrupted-create marker", async () => {
    const harness = createHarness();
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const markerName =
      "__CindyPending__testprofile__11111111-2222-4333-8444-555555555555";
    vi.mocked(harness.lifecycle.createExact).mockResolvedValue({
      udid: createdUdid,
      name: markerName,
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });
    harness.lifecycle.renameExact = vi.fn(async (udid, name) => {
      expect(harness.store.listAll()).toEqual([
        expect.objectContaining({
          simulatorUdid: createdUdid,
          simulatorName: "Cindy iPhone",
          sessionId: "session-a",
        }),
      ]);
      expect(udid).toBe(createdUdid);
      expect(name).toBe("Cindy iPhone");
    });
    await harness.actor.detach(harness.route());

    const created = await harness.actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: "Cindy iPhone",
      templateDevice: DEVICE,
    });

    expect(harness.lifecycle.renameExact).toHaveBeenCalledWith(
      createdUdid,
      "Cindy iPhone",
      expect.any(AbortSignal),
    );
    expect(created).toMatchObject({
      simulatorUdid: createdUdid,
      simulatorName: "Cindy iPhone",
    });
  });

  it("cancels and rolls back an in-flight create by owning session", async () => {
    const harness = createHarness();
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    let createSignal: AbortSignal | undefined;
    let resolveCreate: (created: {
      udid: string;
      name: string;
      runtimeIdentifier: string;
      deviceTypeIdentifier: string;
    }) => void = () => undefined;
    vi.mocked(harness.lifecycle.createExact).mockImplementationOnce(
      (_input, signal) =>
        new Promise((resolve) => {
          createSignal = signal;
          resolveCreate = resolve;
        }),
    );

    const creating = harness.actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: "Cindy iPhone",
      templateDevice: DEVICE,
    });
    await vi.waitFor(() => expect(createSignal).toBeDefined());

    await harness.actor.cancelLifecycleStartsForSession("another-session");
    expect(createSignal?.aborted).toBe(false);
    const cancelling =
      harness.actor.cancelLifecycleStartsForSession("session-a");
    expect(createSignal?.aborted).toBe(true);
    let drained = false;
    void cancelling.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveCreate({
      udid: createdUdid,
      name: "Cindy iPhone",
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });

    await expect(creating).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(cancelling).resolves.toBeUndefined();
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledWith(
      createdUdid,
      expect.any(AbortSignal),
    );
    expect(
      harness.actor
        .listAll()
        .some((instance) => instance.simulatorUdid === createdUdid),
    ).toBe(false);
  });

  it("does not delete a newly created device that another session attached first", async () => {
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const createdDevice = {
      ...DEVICE,
      udid: createdUdid,
      name: "Cindy iPhone",
    };
    let resolveCreate: (created: {
      udid: string;
      name: string;
      runtimeIdentifier: string;
      deviceTypeIdentifier: string;
    }) => void = () => undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => createdDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(
        () =>
          new Promise<
            Awaited<ReturnType<IOSSimulatorSimctlLifecycle["createExact"]>>
          >((resolve) => {
            resolveCreate = resolve;
          }),
      ),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      lifecycle,
      store: new IOSSimulatorOwnershipStore({ maxInstancesPerSession: 2 }),
    });

    const creating = actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: createdDevice.name,
      templateDevice: DEVICE,
    });
    await vi.waitFor(() =>
      expect(lifecycle.createExact).toHaveBeenCalledOnce(),
    );
    const attachedElsewhere = await actor.attachSerialized({
      sessionId: "session-b",
      worktreeRoot: "/tmp/session-b",
      sourceFingerprint: "def",
      device: createdDevice,
    });
    resolveCreate({
      udid: createdUdid,
      name: createdDevice.name,
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });

    await expect(creating).rejects.toMatchObject({
      code: "SIMULATOR_ATTACHED_ELSEWHERE",
    });
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
    expect(
      actor.getOwned("session-b", attachedElsewhere.instanceId),
    ).toMatchObject({
      simulatorUdid: createdUdid,
    });
  });

  it("rejects a stale attach queued behind created-device rollback", async () => {
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const createdDevice = {
      ...DEVICE,
      udid: createdUdid,
      name: "Cindy iPhone",
    };
    let createSignal: AbortSignal | undefined;
    let resolveCreate: (created: {
      udid: string;
      name: string;
      runtimeIdentifier: string;
      deviceTypeIdentifier: string;
    }) => void = () => undefined;
    let resolveDelete: () => void = () => undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => null),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(
        (_input, signal) =>
          new Promise<
            Awaited<ReturnType<IOSSimulatorSimctlLifecycle["createExact"]>>
          >((resolve) => {
            createSignal = signal;
            resolveCreate = resolve;
          }),
      ),
      deleteExact: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          }),
      ),
    };
    const actor = new IOSSimulatorInstanceActor({
      lifecycle,
      store: new IOSSimulatorOwnershipStore({ maxInstancesPerSession: 2 }),
    });

    const creating = actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: createdDevice.name,
      templateDevice: DEVICE,
    });
    await vi.waitFor(() => expect(createSignal).toBeDefined());
    const cancelling = actor.cancelLifecycleStartsForSession("session-a");
    resolveCreate({
      udid: createdUdid,
      name: createdDevice.name,
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });
    await vi.waitFor(() =>
      expect(lifecycle.deleteExact).toHaveBeenCalledOnce(),
    );

    const staleAttach = actor.attachSerialized({
      sessionId: "session-b",
      worktreeRoot: "/tmp/session-b",
      sourceFingerprint: "def",
      device: createdDevice,
    });
    resolveDelete();

    await expect(creating).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(cancelling).resolves.toBeUndefined();
    await expect(staleAttach).rejects.toMatchObject({
      code: "SIMULATOR_NOT_FOUND",
    });
    expect(actor.listAll()).toEqual([]);
  });

  it("aborts an exact attach probe so exit can drain queued create rollback", async () => {
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const createdDevice = {
      ...DEVICE,
      udid: createdUdid,
      name: "Cindy iPhone",
    };
    let findSignal: AbortSignal | undefined;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(
        (_udid, signal) =>
          new Promise<
            Awaited<ReturnType<IOSSimulatorSimctlLifecycle["findExact"]>>
          >((_resolve, reject) => {
            findSignal = signal;
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(async () => ({
        udid: createdUdid,
        name: createdDevice.name,
        runtimeIdentifier: DEVICE.runtimeIdentifier,
        deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
      })),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      lifecycle,
      store: new IOSSimulatorOwnershipStore({ maxInstancesPerSession: 2 }),
    });

    const attaching = actor.attachSerialized({
      sessionId: "session-b",
      worktreeRoot: "/tmp/session-b",
      sourceFingerprint: "def",
      device: createdDevice,
    });
    await vi.waitFor(() => expect(findSignal).toBeDefined());
    const creating = actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: createdDevice.name,
      templateDevice: DEVICE,
    });
    await vi.waitFor(() =>
      expect(lifecycle.createExact).toHaveBeenCalledOnce(),
    );

    actor.abortOperationsForExit();
    const draining = actor.cancelAllLifecycleStarts();

    expect(findSignal?.aborted).toBe(true);
    await expect(attaching).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(creating).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(draining).resolves.toBeUndefined();
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(
      createdUdid,
      expect.any(AbortSignal),
    );
    expect(actor.listAll()).toEqual([]);
  });

  it("persists the exact created device when cancellation rollback fails", async () => {
    const harness = createHarness();
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    let createSignal: AbortSignal | undefined;
    let resolveCreate: (created: {
      udid: string;
      name: string;
      runtimeIdentifier: string;
      deviceTypeIdentifier: string;
    }) => void = () => undefined;
    vi.mocked(harness.lifecycle.createExact).mockImplementationOnce(
      (_input, signal) =>
        new Promise((resolve) => {
          createSignal = signal;
          resolveCreate = resolve;
        }),
    );
    vi.mocked(harness.lifecycle.deleteExact).mockRejectedValueOnce(
      new Error("delete failed"),
    );

    const creating = harness.actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: "Cindy iPhone",
      templateDevice: DEVICE,
    });
    await vi.waitFor(() => expect(createSignal).toBeDefined());
    const cancelling =
      harness.actor.cancelLifecycleStartsForSession("session-a");
    resolveCreate({
      udid: createdUdid,
      name: "Cindy iPhone",
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });

    await expect(creating).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(cancelling).resolves.toBeUndefined();
    expect(
      harness.actor
        .listAll()
        .find((instance) => instance.simulatorUdid === createdUdid),
    ).toEqual(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^__cindy_create_cleanup__:/),
        creationProvenance: "cindy",
        healthState: "degraded",
        errorCode: "SIMULATOR_DELETE_FAILED",
      }),
    );
  });

  it("persists a timed-out created device without repeating spent cleanup", async () => {
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const createFailure = new Error("create timed out");
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(async () => {
        throw new IOSSimulatorCreateCleanupRequiredError(
          {
            udid: createdUdid,
            name: "Cindy iPhone",
            runtimeIdentifier: DEVICE.runtimeIdentifier,
            deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
          },
          createFailure,
        );
      }),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      lifecycle,
      store: new IOSSimulatorOwnershipStore(),
    });

    await expect(
      actor.create({
        sessionId: "session-a",
        worktreeRoot: "/tmp/session-a",
        sourceFingerprint: "abc",
        name: "Cindy iPhone",
        templateDevice: DEVICE,
      }),
    ).rejects.toBe(createFailure);
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
    expect(actor.listAll()).toEqual([
      expect.objectContaining({
        sessionId: expect.stringMatching(/^__cindy_create_cleanup__:/),
        simulatorUdid: createdUdid,
        healthState: "degraded",
        errorCode: "SIMULATOR_DELETE_FAILED",
      }),
    ]);
  });

  it("deletes a newly created device when the ownership write fails after preflight", async () => {
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    let mutationChecks = 0;
    const assertMutationAllowed = vi.fn(() => {
      mutationChecks += 1;
      if (mutationChecks > 1) throw new Error("writer lease lost");
    });
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(async () => ({
        udid: createdUdid,
        name: "Cindy iPhone",
        runtimeIdentifier: DEVICE.runtimeIdentifier,
        deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
      })),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      lifecycle,
      assertMutationAllowed,
      store: new IOSSimulatorOwnershipStore({ assertMutationAllowed }),
    });

    await expect(
      actor.create({
        sessionId: "session-a",
        worktreeRoot: "/tmp/session-a",
        sourceFingerprint: "abc",
        name: "Cindy iPhone",
        templateDevice: DEVICE,
      }),
    ).rejects.toThrow("writer lease lost");
    expect(lifecycle.createExact).toHaveBeenCalledTimes(1);
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(
      createdUdid,
      expect.any(AbortSignal),
    );
    expect(actor.listAll()).toEqual([]);
  });

  it("serializes bounded driver mutations and revalidates their route", async () => {
    const harness = createHarness({ booted: true });
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = harness.actor.runMutation(harness.route(), async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = harness.actor.runMutation(harness.route(), async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reports Agent activity and cancels queued mutations on user takeover", async () => {
    const harness = createHarness({ booted: true });
    let releaseActive: () => void = () => undefined;
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
      },
    );
    const queued = harness.actor
      .runMutation(harness.route(), async () => "should-not-run")
      .catch((error: unknown) => error);

    await vi.waitFor(() =>
      expect(
        harness.actor.mutationState(harness.instance.instanceId),
      ).toMatchObject({
        activeSource: "agent",
        queuedAgentMutations: 1,
      }),
    );
    await expect(
      harness.actor.runMutation(harness.route(), async () => undefined, "user"),
    ).rejects.toMatchObject({ code: "DEVICE_BUSY" });

    expect(harness.actor.takeover(harness.route())).toMatchObject({
      activeSource: "agent",
      agentPaused: true,
      takeoverPending: true,
    });
    expect(activeSignal?.aborted).toBe(true);
    releaseActive();
    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(queued).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
    expect(
      harness.actor.mutationState(harness.instance.instanceId),
    ).toMatchObject({
      activeSource: null,
      queuedAgentMutations: 0,
      agentPaused: true,
      takeoverPending: false,
    });

    await expect(
      harness.actor.runMutation(harness.route(), async () => "user-ok", "user"),
    ).resolves.toBe("user-ok");
    await expect(
      harness.actor.runMutation(harness.route(), async () => undefined),
    ).rejects.toMatchObject({ code: "AGENT_MUTATION_PAUSED" });
    expect(harness.actor.resumeAgentMutations(harness.route())).toMatchObject({
      agentPaused: false,
    });
    await expect(
      harness.actor.runMutation(harness.route(), async () => "agent-ok"),
    ).resolves.toBe("agent-ok");
  });

  it("serializes ownership cleanup after cancelling active and queued Agent mutations", async () => {
    const harness = createHarness({ booted: true });
    let releaseActive: () => void = () => undefined;
    let activeSignal: AbortSignal | undefined;
    const order: string[] = [];
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        order.push("active");
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
      },
    );
    const queued = harness.actor
      .runMutation(harness.route(), async () => order.push("queued"))
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const cleanup = harness.actor.runOwnershipCleanup(
      harness.instance.instanceId,
      harness.instance.sessionId,
      async (instance) => {
        order.push("cleanup");
        return instance;
      },
    );

    expect(activeSignal?.aborted).toBe(true);
    releaseActive();
    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(queued).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(cleanup).resolves.toMatchObject({
      instanceId: harness.instance.instanceId,
      sessionId: harness.instance.sessionId,
    });
    expect(order).toEqual(["active", "cleanup"]);
  });

  it("does not disturb the current owner when stale cleanup names another session", async () => {
    const harness = createHarness({ booted: true });
    let releaseActive: () => void = () => undefined;
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
        return "completed";
      },
    );
    await vi.waitFor(() => expect(activeSignal).toBeDefined());

    expect(() =>
      harness.actor.runOwnershipCleanup(
        harness.instance.instanceId,
        "stale-session",
        async () => undefined,
      ),
    ).toThrowError(expect.objectContaining({ code: "INSTANCE_NOT_OWNED" }));

    expect(activeSignal?.aborted).toBe(false);
    expect(
      harness.actor.mutationState(harness.instance.instanceId),
    ).toMatchObject({
      activeSource: "agent",
      queuedAgentMutations: 0,
    });
    releaseActive();
    await expect(active).resolves.toBe("completed");
  });
});
