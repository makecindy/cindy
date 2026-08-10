import { access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  createIOSSimulatorSimctlLifecycle,
  IOSSimulatorCreateCleanupRequiredError,
} from "./simctl-lifecycle.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";
const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-4";

function devicesJson(
  devices: Array<{
    udid: string;
    name: string;
    state?: string;
    deviceTypeIdentifier?: string;
  }>,
): string {
  return JSON.stringify({
    runtimes: [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        name: "iOS 26.4",
        version: "26.4",
        isAvailable: true,
      },
    ],
    devices: {
      [RUNTIME]: devices.map((device) => ({
        ...device,
        state: device.state ?? "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: device.deviceTypeIdentifier ?? DEVICE_TYPE,
      })),
    },
  });
}

function listJson(state: string): string {
  return devicesJson([{ udid: UDID, name: "iPhone 17 Pro", state }]);
}

describe("createIOSSimulatorSimctlLifecycle", () => {
  it("boots and polls an exact UDID until bootstatus succeeds", async () => {
    let now = 0;
    let listCount = 0;
    let bootStatusCount = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: listJson(listCount < 3 ? "Shutdown" : "Booted"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "boot") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[1] === "bootstatus") {
          bootStatusCount += 1;
          return {
            stdout: "",
            stderr: "",
            exitCode: bootStatusCount === 1 ? null : 0,
          };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      pollIntervalMs: 1_000,
      bootTimeoutMs: 10_000,
    });

    await expect(lifecycle.bootExact(UDID)).resolves.toMatchObject({
      udid: UDID,
      state: "Booted",
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "boot",
      UDID,
    ]);
    expect(bootStatusCount).toBe(2);
  });

  it("accepts a transient boot exit when CoreSimulator has already started the device", async () => {
    let listCount = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: listJson(listCount === 1 ? "Shutdown" : "Booted"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "boot") {
          return {
            stdout: "",
            stderr: "Unable to boot device: transition already in progress",
            exitCode: 1,
          };
        }
        if (args[1] === "bootstatus") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      clock: {
        now: () => 0,
        sleep: async () => undefined,
      },
    });

    await expect(lifecycle.bootExact(UDID)).resolves.toMatchObject({
      udid: UDID,
      state: "Booted",
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "boot",
      UDID,
    ]);
  });

  it("propagates startup cancellation into every simctl subprocess", async () => {
    const controller = new AbortController();
    let listCount = 0;
    let bootStatusSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: listJson(listCount === 1 ? "Shutdown" : "Booted"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "boot") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[1] === "bootstatus") {
          bootStatusSignal = options?.signal;
          return await new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve({ stdout: "", stderr: "", exitCode: null }),
              { once: true },
            );
          });
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      clock: {
        now: () => 0,
        sleep: async () => undefined,
      },
    });

    const booting = lifecycle.bootExact(UDID, controller.signal);
    await vi.waitFor(() => expect(bootStatusSignal).toBe(controller.signal));
    controller.abort(new Error("cancelled for teardown"));

    await expect(booting).rejects.toThrow("cancelled for teardown");
    for (const [, , options] of run.mock.calls) {
      expect(options?.signal).toBe(controller.signal);
    }
  });

  it("propagates cleanup cancellation into shutdown and delete subprocesses", async () => {
    const shutdownController = new AbortController();
    const deleteController = new AbortController();
    let shutdownSignal: AbortSignal | undefined;
    let deleteSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "list") {
          return { stdout: listJson("Booted"), stderr: "", exitCode: 0 };
        }
        if (args[1] === "shutdown") {
          shutdownSignal = options?.signal;
          return await new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve({ stdout: "", stderr: "", exitCode: null }),
              { once: true },
            );
          });
        }
        if (args[1] === "delete") {
          deleteSignal = options?.signal;
          return await new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve({ stdout: "", stderr: "", exitCode: null }),
              { once: true },
            );
          });
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    const shuttingDown = lifecycle.shutdownExact(
      UDID,
      shutdownController.signal,
    );
    await vi.waitFor(() =>
      expect(shutdownSignal).toBe(shutdownController.signal),
    );
    shutdownController.abort(new Error("shutdown cancelled for exit"));
    await expect(shuttingDown).rejects.toThrow("shutdown cancelled for exit");

    const deleting = lifecycle.deleteExact(UDID, deleteController.signal);
    await vi.waitFor(() => expect(deleteSignal).toBe(deleteController.signal));
    deleteController.abort(new Error("delete cancelled for exit"));
    await expect(deleting).rejects.toThrow("delete cancelled for exit");

    expect(run.mock.calls[0]?.[2]?.signal).toBe(shutdownController.signal);
  });

  it("uses exact argv for create, shutdown, and delete", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          return { stdout: listJson("Booted"), stderr: "", exitCode: 0 };
        }
        if (args[1] === "create")
          return { stdout: `${UDID}\n`, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "testprofile",
    });

    await lifecycle.createExact({
      name: "Cindy iPhone",
      deviceTypeIdentifier:
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    });
    await lifecycle.renameExact?.(UDID, "Cindy iPhone");
    await lifecycle.shutdownExact(UDID);
    await lifecycle.deleteExact(UDID);

    expect(run).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      [
        "simctl",
        "create",
        expect.stringMatching(/^__CindyPending__testprofile__[0-9a-f-]{36}$/),
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      ],
      { timeoutMs: 60_000 },
    );
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "rename",
      UDID,
      "Cindy iPhone",
    ]);
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "shutdown",
      UDID,
    ]);
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "delete",
      UDID,
    ]);
  });

  it("recovers and deletes a cancelled create whose UUID never reached stdout", async () => {
    const controller = new AbortController();
    const reason = new Error("create cancelled before stdout");
    const preexistingUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    let markerName = "";
    let createSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "create") {
          markerName = args[2]!;
          createSignal = options?.signal;
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { stdout: "", stderr: "", exitCode: null };
        }
        if (args[1] === "list") {
          return {
            stdout: devicesJson([
              {
                udid: preexistingUdid,
                name: "Cindy iPhone",
              },
              { udid: UDID, name: markerName },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "delete" || args[1] === "rename") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "testprofile",
    });

    const creating = lifecycle.createExact(
      {
        name: "Cindy iPhone",
        deviceTypeIdentifier: DEVICE_TYPE,
        runtimeIdentifier: RUNTIME,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(createSignal).toBe(controller.signal));
    controller.abort(reason);

    await expect(creating).rejects.toBe(reason);
    expect(markerName).toMatch(/^__CindyPending__testprofile__[0-9a-f-]{36}$/);
    const deleteCalls = run.mock.calls.filter(
      ([, args]) => args[1] === "delete",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.[1]).toEqual(["simctl", "delete", UDID]);
    expect(JSON.stringify(deleteCalls)).not.toContain(preexistingUdid);
  });

  it("deletes a delayed unclaimed marker during the next profile startup recovery", async () => {
    const controller = new AbortController();
    const reason = new Error("create cancelled before delayed marker appeared");
    let markerName = "";
    let createSignal: AbortSignal | undefined;
    let listCount = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "create") {
          markerName = args[2]!;
          createSignal = options?.signal;
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { stdout: "", stderr: "", exitCode: null };
        }
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout:
              listCount === 1
                ? devicesJson([])
                : devicesJson([{ udid: UDID, name: markerName }]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "delete") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "testprofile",
    });

    const creating = lifecycle.createExact(
      {
        name: "Cindy iPhone",
        deviceTypeIdentifier: DEVICE_TYPE,
        runtimeIdentifier: RUNTIME,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(createSignal).toBe(controller.signal));
    controller.abort(reason);
    await expect(creating).rejects.toBe(reason);
    expect(
      run.mock.calls.filter(([, args]) => args[1] === "delete"),
    ).toHaveLength(0);

    await expect(
      lifecycle.recoverPendingCreatesAtStartup?.([]),
    ).resolves.toEqual([UDID]);
    expect(run.mock.calls.filter(([, args]) => args[1] === "delete")).toEqual([
      expect.arrayContaining(["/usr/bin/xcrun", ["simctl", "delete", UDID]]),
    ]);
  });

  it("renames only this profile's markers with persisted exact ownership", async () => {
    const ownedUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const otherProfileUdid = "3A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const ordinaryUdid = "4A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          return {
            stdout: devicesJson([
              {
                udid: UDID,
                name: "__CindyPending__profilealpha__11111111-2222-4333-8444-555555555555",
              },
              {
                udid: ownedUdid,
                name: "__CindyPending__profilealpha__22222222-3333-4444-8555-666666666666",
              },
              {
                udid: otherProfileUdid,
                name: "__CindyPending__profilebeta__33333333-4444-4555-8666-777777777777",
              },
              { udid: ordinaryUdid, name: "Cindy iPhone" },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "delete" || args[1] === "rename") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "profilealpha",
    });

    await expect(
      lifecycle.reconcilePendingCreates?.([
        { udid: ownedUdid, name: "Cindy Restored iPhone" },
      ]),
    ).resolves.toEqual([ownedUdid]);
    const deleteCalls = run.mock.calls.filter(
      ([, args]) => args[1] === "delete",
    );
    expect(deleteCalls).toHaveLength(0);
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "rename",
      ownedUdid,
      "Cindy Restored iPhone",
    ]);
  });

  it("startup recovery deletes only unclaimed markers from this exact profile", async () => {
    const ownedUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const otherProfileUdid = "3A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const ordinaryUdid = "4A9D41E0-E031-4AD0-A8B5-847480802E8E";
    const unclaimedName =
      "__CindyPending__profilealpha__11111111-2222-4333-8444-555555555555";
    const ownedName =
      "__CindyPending__profilealpha__22222222-3333-4444-8555-666666666666";
    const devices = [
      { udid: UDID, name: unclaimedName },
      { udid: ownedUdid, name: ownedName },
      {
        udid: otherProfileUdid,
        name: "__CindyPending__profilebeta__33333333-4444-4555-8666-777777777777",
      },
      { udid: ordinaryUdid, name: "Cindy iPhone" },
    ];
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          return {
            stdout: devicesJson(devices),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "delete" || args[1] === "rename") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "profilealpha",
    });

    await expect(
      lifecycle.recoverPendingCreatesAtStartup?.([
        { udid: ownedUdid, name: "Cindy Restored iPhone" },
      ]),
    ).resolves.toEqual([UDID, ownedUdid]);
    expect(run.mock.calls.filter(([, args]) => args[1] === "delete")).toEqual([
      expect.arrayContaining(["/usr/bin/xcrun", ["simctl", "delete", UDID]]),
    ]);
    expect(run.mock.calls.filter(([, args]) => args[1] === "rename")).toEqual([
      expect.arrayContaining([
        "/usr/bin/xcrun",
        ["simctl", "rename", ownedUdid, "Cindy Restored iPhone"],
      ]),
    ]);
    expect(JSON.stringify(run.mock.calls)).not.toContain(
      `["simctl","delete","${otherProfileUdid}"]`,
    );
    expect(JSON.stringify(run.mock.calls)).not.toContain(
      `["simctl","delete","${ordinaryUdid}"]`,
    );
  });

  it("does not delete a pending device that changes during startup revalidation", async () => {
    const markerName =
      "__CindyPending__profilealpha__11111111-2222-4333-8444-555555555555";
    let listCount = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: devicesJson([
              {
                udid: UDID,
                name:
                  listCount === 1 ? markerName : "Externally Renamed iPhone",
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "delete") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "profilealpha",
    });

    await expect(
      lifecycle.recoverPendingCreatesAtStartup?.([]),
    ).resolves.toEqual([]);
    expect(
      run.mock.calls.filter(([, args]) => args[1] === "list"),
    ).toHaveLength(2);
    expect(run.mock.calls.filter(([, args]) => args[1] === "delete")).toEqual(
      [],
    );
  });

  it("cancels create and deletes only an exact late-created UDID", async () => {
    const controller = new AbortController();
    const reason = new Error("create cancelled for exit");
    let createSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "create") {
          createSignal = options?.signal;
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { stdout: `${UDID}\n`, stderr: "", exitCode: null };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "testprofile",
    });

    const creating = lifecycle.createExact(
      {
        name: "Cindy iPhone",
        deviceTypeIdentifier:
          "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(createSignal).toBe(controller.signal));
    controller.abort(reason);

    await expect(creating).rejects.toBe(reason);
    expect(run).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/xcrun",
      [
        "simctl",
        "create",
        expect.stringMatching(/^__CindyPending__testprofile__[0-9a-f-]{36}$/),
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      ],
      { timeoutMs: 60_000, signal: controller.signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcrun",
      ["simctl", "delete", UDID],
      { timeoutMs: 4_000 },
    );
  });

  it("returns the exact created identity when cancellation cleanup fails", async () => {
    const controller = new AbortController();
    const reason = new Error("create cancelled for exit");
    let createSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "create") {
          createSignal = options?.signal;
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { stdout: `${UDID}\n`, stderr: "", exitCode: null };
        }
        return { stdout: "", stderr: "delete failed", exitCode: 1 };
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      createMarkerNamespace: "testprofile",
    });

    const creating = lifecycle.createExact(
      {
        name: "Cindy iPhone",
        deviceTypeIdentifier:
          "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(createSignal).toBe(controller.signal));
    controller.abort(reason);

    await expect(creating).rejects.toMatchObject({
      name: "IOSSimulatorCreateCleanupRequiredError",
      code: "SIMULATOR_DELETE_FAILED",
      originalReason: reason,
      createdDevice: {
        udid: UDID,
        name: expect.stringMatching(
          /^__CindyPending__testprofile__[0-9a-f-]{36}$/,
        ),
        deviceTypeIdentifier:
          "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      },
    } satisfies Partial<IOSSimulatorCreateCleanupRequiredError>);
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcrun",
      ["simctl", "delete", UDID],
      { timeoutMs: 4_000 },
    );
  });

  it("preserves an exact UUID when create times out and cleanup fails", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) =>
        args[1] === "create"
          ? { stdout: `${UDID}\n`, stderr: "", exitCode: null }
          : { stdout: "", stderr: "delete failed", exitCode: 1 },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await expect(
      lifecycle.createExact({
        name: "Cindy iPhone",
        deviceTypeIdentifier:
          "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      }),
    ).rejects.toMatchObject({
      name: "IOSSimulatorCreateCleanupRequiredError",
      code: "SIMULATOR_DELETE_FAILED",
      originalReason: expect.objectContaining({
        code: "SIMULATOR_CREATE_FAILED",
      }),
      createdDevice: expect.objectContaining({ udid: UDID }),
    });
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcrun",
      ["simctl", "delete", UDID],
      { timeoutMs: 4_000 },
    );
  });

  it("rejects non-UUID mutation selectors before invoking simctl", async () => {
    const run = vi.fn();
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await expect(lifecycle.shutdownExact("booted")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses bounded argv for appearance, location, and privacy controls", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });
    const signal = new AbortController().signal;

    await lifecycle.setAppearance?.(UDID, "dark", signal);
    await lifecycle.setLocation?.(UDID, 31.2304, 121.4737, signal);
    await lifecycle.startLocationRoute?.(
      UDID,
      {
        waypoints: [
          { latitude: 31.2304, longitude: 121.4737 },
          { latitude: 31.233, longitude: 121.48 },
        ],
        speedMetersPerSecond: 12,
        intervalSeconds: 2,
      },
      signal,
    );
    await lifecycle.clearLocation?.(UDID, signal);
    await lifecycle.setPrivacy?.(
      UDID,
      "grant",
      "photos",
      "com.example.app",
      signal,
    );
    await lifecycle.setPrivacy?.(UDID, "reset", "all", undefined, signal);
    await lifecycle.pushNotification?.(
      UDID,
      "com.example.app",
      {
        aps: { alert: "Hello" },
      },
      signal,
    );
    await lifecycle.setStatusBar?.(
      UDID,
      {
        time: "9:41",
        wifiBars: 3,
        batteryLevel: 100,
      },
      signal,
    );
    await lifecycle.clearStatusBar?.(UDID, signal);

    expect(run).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/xcrun",
      ["simctl", "ui", UDID, "appearance", "dark"],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcrun",
      ["simctl", "location", UDID, "set", "31.2304,121.4737"],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      "/usr/bin/xcrun",
      [
        "simctl",
        "location",
        UDID,
        "start",
        "--speed=12",
        "--interval=2",
        "31.2304,121.4737",
        "31.233,121.48",
      ],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      4,
      "/usr/bin/xcrun",
      ["simctl", "location", UDID, "clear"],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      5,
      "/usr/bin/xcrun",
      ["simctl", "privacy", UDID, "grant", "photos", "com.example.app"],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      6,
      "/usr/bin/xcrun",
      ["simctl", "privacy", UDID, "reset", "all"],
      { signal },
    );
    const pushCall = run.mock.calls[6];
    expect(pushCall?.[0]).toBe("/usr/bin/xcrun");
    expect(pushCall?.[1]).toEqual(
      expect.arrayContaining(["simctl", "push", UDID, "com.example.app"]),
    );
    expect(pushCall?.[2]).toEqual({ signal });
    const payloadPath = pushCall?.[1]?.at(-1);
    expect(typeof payloadPath).toBe("string");
    await expect(access(String(payloadPath))).rejects.toThrow();
    expect(run).toHaveBeenNthCalledWith(
      8,
      "/usr/bin/xcrun",
      [
        "simctl",
        "status_bar",
        UDID,
        "override",
        "--time",
        "9:41",
        "--wifiBars",
        "3",
        "--batteryLevel",
        "100",
      ],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      9,
      "/usr/bin/xcrun",
      ["simctl", "status_bar", UDID, "clear"],
      { signal },
    );
  });

  it("uses bounded argv for accessibility contrast and Dynamic Type controls", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });
    const signal = new AbortController().signal;

    await lifecycle.setIncreaseContrast?.(UDID, true, signal);
    await lifecycle.setContentSize?.(UDID, "accessibility-extra-large", signal);

    expect(run).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/xcrun",
      ["simctl", "ui", UDID, "increase_contrast", "enabled"],
      { signal },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcrun",
      ["simctl", "ui", UDID, "content_size", "accessibility-extra-large"],
      { signal },
    );
  });

  it("preserves the abort reason for an active simulator control", async () => {
    const controller = new AbortController();
    const reason = new Error("control cancelled for exit");
    let commandSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, _args, options) => {
        commandSignal = options?.signal;
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { stdout: "", stderr: "", exitCode: null };
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    const changing = lifecycle.setAppearance?.(UDID, "dark", controller.signal);
    await vi.waitFor(() => expect(commandSignal).toBe(controller.signal));
    controller.abort(reason);

    await expect(changing).rejects.toBe(reason);
  });

  it("rejects invalid location and privacy arguments before invoking simctl", async () => {
    const run = vi.fn();
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await expect(lifecycle.setLocation?.(UDID, 91, 0)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      lifecycle.startLocationRoute?.(UDID, {
        waypoints: [{ latitude: 0, longitude: 0 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.startLocationRoute?.(UDID, {
        waypoints: [
          { latitude: 0, longitude: 0 },
          { latitude: 1, longitude: 1 },
        ],
        intervalSeconds: 1,
        distanceMeters: 10,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setPrivacy?.(UDID, "grant", "photos"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setPrivacy?.(UDID, "reset", "all", "bad bundle id"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setIncreaseContrast?.(UDID, "yes" as unknown as boolean),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setContentSize?.(UDID, "invalid" as never),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.pushNotification?.(UDID, "com.example.app", {
        alert: "missing aps",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(lifecycle.setStatusBar?.(UDID, {})).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
