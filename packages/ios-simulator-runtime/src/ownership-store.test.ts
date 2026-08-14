import { describe, expect, it } from "vitest";

import { IOSSimulatorInstanceError } from "./instance-errors.js";
import { IOSSimulatorOwnershipStore } from "./ownership-store.js";
import type { IOSSimulatorDevice } from "./types.js";

const DEVICE: IOSSimulatorDevice = {
  udid: "1A9D41E0-E031-4AD0-A8B5-847480802E8E",
  name: "iPhone 17 Pro",
  state: "Booted",
  isAvailable: true,
  availabilityError: null,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
  runtimeName: "iOS 26.4",
  runtimeVersion: "26.4",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  lastBootedAt: null,
};

function input(sessionId: string, device = DEVICE) {
  return {
    sessionId,
    worktreeRoot: `/tmp/${sessionId}`,
    sourceFingerprint: `fingerprint-${sessionId}`,
    device,
  };
}

describe("IOSSimulatorOwnershipStore", () => {
  it("enforces global UDID ownership and the Phase 1 per-session cap", () => {
    let id = 0;
    const store = new IOSSimulatorOwnershipStore({
      createId: () => `id-${++id}`,
    });
    const first = store.attach(input("session-a"));

    expect(() => store.attach(input("session-b"))).toThrowError(
      expect.objectContaining({ code: "SIMULATOR_ATTACHED_ELSEWHERE" }),
    );
    expect(() =>
      store.attach(
        input("session-a", {
          ...DEVICE,
          udid: "2A9D41E0-E031-4AD0-A8B5-847480802E8E",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "SESSION_INSTANCE_LIMIT_REACHED" }),
    );
    expect(store.attach(input("session-a")).instanceId).toBe(first.instanceId);
  });

  it("fails closed for cross-session, stale-generation, and expired-lease routes", () => {
    let now = 1_000;
    let id = 0;
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      createId: () => `id-${++id}`,
      leaseDurationMs: 500,
    });
    const instance = store.attach(input("session-a"));

    expect(() =>
      store.requireOwned(instance.instanceId, "session-b"),
    ).toThrowError(expect.objectContaining({ code: "INSTANCE_NOT_OWNED" }));
    expect(() =>
      store.assertMutationRoute({
        sessionId: "session-a",
        instanceId: instance.instanceId,
        generation: instance.generation + 1,
        leaseId: instance.lease.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_GENERATION" }));

    now = 1_500;
    expect(() =>
      store.assertMutationRoute({
        sessionId: "session-a",
        instanceId: instance.instanceId,
        generation: instance.generation,
        leaseId: instance.lease.id,
      }),
    ).toThrowError(expect.objectContaining({ code: "LEASE_EXPIRED" }));
  });

  it("heartbeats an active lease without rotating its id and replaces an expired lease", () => {
    let now = 1_000;
    let id = 0;
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      createId: () => `id-${++id}`,
      leaseDurationMs: 1_000,
    });
    const instance = store.attach(input("session-a"));

    now = 1_100;
    const coalesced = store.heartbeat(instance.instanceId, "session-a");
    expect(coalesced.lease).toEqual(instance.lease);

    now = 1_500;
    const active = store.heartbeat(instance.instanceId, "session-a");
    expect(active.lease.id).toBe(instance.lease.id);
    expect(active.lease.expiresAt).toBe(new Date(2_500).toISOString());

    now = 3_000;
    const replaced = store.heartbeat(instance.instanceId, "session-a");
    expect(replaced.lease.id).not.toBe(instance.lease.id);
    expect(replaced.lease.expiresAt).toBe(new Date(4_000).toISOString());
  });

  it("fails a coalesced heartbeat after the persisted writer lease is lost", () => {
    let writerAvailable = true;
    const store = new IOSSimulatorOwnershipStore({
      assertMutationAllowed: () => {
        if (!writerAvailable) {
          throw new IOSSimulatorInstanceError(
            "DEVICE_BUSY",
            "writer unavailable",
            true,
          );
        }
      },
    });
    const instance = store.attach(input("session-a"));
    writerAvailable = false;

    expect(() =>
      store.heartbeat(instance.instanceId, instance.sessionId),
    ).toThrowError(expect.objectContaining({ code: "DEVICE_BUSY" }));
    expect(store.get(instance.instanceId)).toEqual(instance);
  });

  it("can raise the per-session cap without weakening global ownership", () => {
    let id = 0;
    const store = new IOSSimulatorOwnershipStore({
      createId: () => `id-${++id}`,
      maxInstancesPerSession: 4,
    });
    for (let index = 1; index <= 4; index += 1) {
      store.attach(
        input("session-a", {
          ...DEVICE,
          udid: `${index}A9D41E0-E031-4AD0-A8B5-847480802E8E`,
        }),
      );
    }
    expect(store.listForSession("session-a")).toHaveLength(4);
  });

  it("fails before mutation when the persisted writer lease is unavailable", () => {
    const store = new IOSSimulatorOwnershipStore({
      assertMutationAllowed: () => {
        throw new IOSSimulatorInstanceError(
          "DEVICE_BUSY",
          "writer unavailable",
          true,
        );
      },
    });

    expect(() => store.attach(input("session-a"))).toThrowError(
      expect.objectContaining({ code: "DEVICE_BUSY" }),
    );
    expect(store.listAll()).toEqual([]);
  });

  it("rolls attach, update, and release back when persistence fails", () => {
    let failPersistence = true;
    const attachStore = new IOSSimulatorOwnershipStore({
      createId: () => "attach-id",
      onChange: () => {
        if (failPersistence) throw new Error("disk unavailable");
      },
    });
    expect(() => attachStore.attach(input("session-a"))).toThrow(
      "disk unavailable",
    );
    expect(attachStore.listAll()).toEqual([]);

    failPersistence = false;
    let id = 0;
    const store = new IOSSimulatorOwnershipStore({
      createId: () => `id-${++id}`,
      onChange: () => {
        if (failPersistence) throw new Error("disk unavailable");
      },
    });
    const instance = store.attach(input("session-a"));
    failPersistence = true;

    expect(() =>
      store.update(instance.instanceId, instance.sessionId, {
        healthState: "error",
      }),
    ).toThrow("disk unavailable");
    expect(store.get(instance.instanceId)).toEqual(instance);

    expect(() =>
      store.release(instance.instanceId, instance.sessionId),
    ).toThrow("disk unavailable");
    expect(store.get(instance.instanceId)).toEqual(instance);
  });
});
