import { describe, expect, it } from "vitest";
import { REMOTE_INVOKE_ALLOWLIST } from "../allowlist.js";
import { MACHINE_STATUS_CHANNEL, parseMachineStatus } from "../machineStatus.js";

describe("machine status device-link contract", () => {
  it("is callable by another computer on the account", () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(MACHINE_STATUS_CHANNEL)).toBe(true);
  });

  it("reads a status from a newer or partial computer, missing facts as unknown", () => {
    expect(parseMachineStatus({
      capturedAt: "t", cpu: { logicalCores: 8 }, memory: { totalBytes: 1 }, gpu: { from: "a later version" },
    })).toEqual({
      capturedAt: "t",
      cpu: { logicalCores: 8, busyPercent: null, loadAverage1m: null },
      memory: { totalBytes: 1, availableBytes: null },
      disk: null, idleSeconds: null, onBattery: null, runningTasks: null,
    });
  });

  it("rejects a reply that cannot describe the computer", () => {
    expect(parseMachineStatus({ capturedAt: "t", cpu: {}, memory: {} })).toBeNull();
    expect(parseMachineStatus(null)).toBeNull();
  });
});
