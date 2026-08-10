import { describe, expect, it } from "vitest";

import { IOSSimulatorDeviceGrantStore } from "./device-grant-store.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";

describe("IOSSimulatorDeviceGrantStore", () => {
  it("starts fail-closed and accepts explicit user consent", () => {
    const store = new IOSSimulatorDeviceGrantStore({ now: () => 1_000 });
    expect(store.get(UDID).agentControl).toBe("unknown");
    expect(() => store.requireAgentControl(UDID)).toThrowError(
      expect.objectContaining({ code: "DEVICE_CONTROL_NOT_GRANTED" }),
    );

    expect(store.set(UDID, { agentControl: "allowed" })).toMatchObject({
      simulatorUdid: UDID,
      agentControl: "allowed",
      policySource: "user",
    });
    expect(store.requireAgentControl(UDID).agentControl).toBe("allowed");
  });

  it("does not let a user override a managed policy", () => {
    const store = new IOSSimulatorDeviceGrantStore();
    store.set(UDID, { agentControl: "denied" }, "managed-policy");
    store.set(UDID, { agentControl: "allowed" }, "user");
    expect(store.get(UDID)).toMatchObject({
      agentControl: "denied",
      policySource: "managed-policy",
    });
  });

  it("restores persisted grants with canonical device identities", () => {
    const store = new IOSSimulatorDeviceGrantStore({
      initialGrants: [
        {
          simulatorUdid: UDID.toLowerCase(),
          agentControl: "allowed",
          screenshotCapture: "denied",
          policySource: "user",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      ],
    });

    expect(store.get(UDID)).toEqual({
      simulatorUdid: UDID,
      agentControl: "allowed",
      screenshotCapture: "denied",
      policySource: "user",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(store.listAll()).toEqual([store.get(UDID)]);
  });

  it("persists complete snapshots, rolls elevations back, and keeps revocations fail-closed", () => {
    let failPersistence = false;
    const snapshots: unknown[] = [];
    const store = new IOSSimulatorDeviceGrantStore({
      now: () => 2_000,
      onChange: (grants) => {
        snapshots.push(grants);
        if (failPersistence) throw new Error("disk unavailable");
      },
    });

    store.set(UDID, { agentControl: "allowed" });
    expect(snapshots).toEqual([
      [expect.objectContaining({ agentControl: "allowed" })],
    ]);

    failPersistence = true;
    expect(() => store.set(UDID, { agentControl: "denied" })).toThrow(
      "disk unavailable",
    );
    expect(store.get(UDID).agentControl).toBe("denied");

    const elevationStore = new IOSSimulatorDeviceGrantStore({
      onChange: () => {
        throw new Error("disk unavailable");
      },
    });
    expect(() => elevationStore.set(UDID, { agentControl: "allowed" })).toThrow(
      "disk unavailable",
    );
    expect(elevationStore.get(UDID).agentControl).toBe("unknown");
  });

  it("checks the profile writer before changing a grant", () => {
    const store = new IOSSimulatorDeviceGrantStore({
      assertMutationAllowed: () => {
        throw new Error("writer lease lost");
      },
    });

    expect(() => store.set(UDID, { agentControl: "allowed" })).toThrow(
      "writer lease lost",
    );
    expect(store.get(UDID).agentControl).toBe("unknown");

    const revocationStore = new IOSSimulatorDeviceGrantStore({
      initialGrants: [
        {
          simulatorUdid: UDID,
          agentControl: "allowed",
          screenshotCapture: "unknown",
          policySource: "user",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      ],
      assertMutationAllowed: () => {
        throw new Error("writer lease lost");
      },
    });
    expect(() => revocationStore.set(UDID, { agentControl: "denied" })).toThrow(
      "writer lease lost",
    );
    expect(revocationStore.get(UDID).agentControl).toBe("denied");
  });
});
