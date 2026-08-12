import { describe, expect, it } from "vitest";

import {
  IOSSimulatorResourceScheduler,
  parseMacOSMemoryPressureFreePercentage,
} from "./resource-scheduler.js";

describe("IOSSimulatorResourceScheduler", () => {
  it("parses macOS reclaimable memory pressure output", () => {
    expect(
      parseMacOSMemoryPressureFreePercentage(
        "System-wide memory free percentage: 64%",
      ),
    ).toBe(64);
    expect(parseMacOSMemoryPressureFreePercentage("unavailable")).toBeNull();
  });

  it("uses macOS pressure instead of rejecting on low immediately-free pages", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      memoryProbe: async () => ({
        source: "macos-memory-pressure",
        freePercentage: 64,
        freeBytes: 128 * 1024 ** 2,
        totalBytes: 48 * 1024 ** 3,
      }),
    });

    await expect(scheduler.runStart("a", async () => "started")).resolves.toBe(
      "started",
    );
  });

  it("blocks only critical pressure for the first instance", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      memoryProbe: () => ({
        source: "macos-memory-pressure",
        freePercentage: 9,
        freeBytes: 8 * 1024 ** 3,
        totalBytes: 48 * 1024 ** 3,
      }),
    });

    await expect(
      scheduler.runStart("a", async () => undefined),
    ).rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  });

  it("requires more headroom beyond the two-instance soft limit", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      memoryProbe: () => ({
        source: "macos-memory-pressure",
        freePercentage: 15,
        freeBytes: 8 * 1024 ** 3,
        totalBytes: 48 * 1024 ** 3,
      }),
    });

    await scheduler.runStart("a", async () => undefined);
    await scheduler.runStart("b", async () => undefined);
    await expect(
      scheduler.runStart("c", async () => undefined),
    ).rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  });

  it("serializes boot/start work globally", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = scheduler.runStart("a", async () => {
      order.push("a-start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("a-end");
    });
    const second = scheduler.runStart("b", async () => {
      order.push("b");
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("rejects a new start under memory pressure", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      freeMemoryBytes: () => 1,
    });
    await expect(
      scheduler.runStart("a", async () => undefined),
    ).rejects.toMatchObject({
      code: "MEMORY_PRESSURE",
    });
  });

  it("releases the serialized gate after an admission rejection", async () => {
    let freeMemory = 1;
    const scheduler = new IOSSimulatorResourceScheduler({
      freeMemoryBytes: () => freeMemory,
    });
    await expect(
      scheduler.runStart("a", async () => undefined),
    ).rejects.toMatchObject({
      code: "MEMORY_PRESSURE",
    });
    freeMemory = 100 * 1024 ** 3;
    await expect(scheduler.runStart("b", async () => "started")).resolves.toBe(
      "started",
    );
  });

  it("keeps a booted instance admitted when later startup work fails", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      softLimit: 1,
      hardLimit: 1,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });

    await expect(
      scheduler.runStart("a", async (commitRunning) => {
        commitRunning();
        throw new Error("driver failed");
      }),
    ).rejects.toThrow("driver failed");
    expect(scheduler.runningCount()).toBe(1);
    await expect(
      scheduler.runStart("b", async () => undefined),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_REACHED" });
    await expect(
      scheduler.runStart("a", async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(scheduler.runningCount()).toBe(1);
  });

  it("restores persisted occupancy without bypassing limits for another instance", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      softLimit: 1,
      hardLimit: 1,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });

    scheduler.restoreRunning("persisted");
    scheduler.restoreRunning("persisted");

    expect(scheduler.runningCount()).toBe(1);
    await expect(
      scheduler.runStart("new", async () => undefined),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_REACHED" });
    await expect(
      scheduler.runStart("persisted", async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("uses a hard architectural cap of four", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      softLimit: 4,
      hardLimit: 4,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });
    for (const id of ["a", "b", "c", "d"])
      await scheduler.runStart(id, async () => undefined);
    await expect(
      scheduler.runStart("e", async () => undefined),
    ).rejects.toMatchObject({
      code: "RESOURCE_LIMIT_REACHED",
    });
  });

  it("reports the configured limits and current running count", async () => {
    const scheduler = new IOSSimulatorResourceScheduler({
      softLimit: 2,
      hardLimit: 4,
      freeMemoryBytes: () => 100 * 1024 ** 3,
    });

    expect(scheduler.snapshot()).toEqual({
      runningCount: 0,
      softLimit: 2,
      hardLimit: 4,
    });
    await scheduler.runStart("a", async () => undefined);
    expect(scheduler.snapshot()).toEqual({
      runningCount: 1,
      softLimit: 2,
      hardLimit: 4,
    });
  });
});
