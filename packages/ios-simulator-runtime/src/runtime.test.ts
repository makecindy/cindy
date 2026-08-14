import { describe, expect, it, vi } from "vitest";

import { createIOSSimulatorRuntime } from "./runtime.js";
import { parseSimctlListJson } from "./simctl-parser.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

const SIMCTL_LIST = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      name: "iOS 26.4",
      version: "26.4",
      buildversion: "23E5195a",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-4",
      name: "watchOS 26.4",
      version: "26.4",
      isAvailable: true,
    },
  ],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      {
        udid: "SHUTDOWN-UDID",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
      {
        udid: "BOOTED-UDID",
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
        lastBootedAt: "2026-07-22T08:00:00Z",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-4": [
      {
        udid: "WATCH-UDID",
        name: "Apple Watch",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
});

function runnerForSimctl(simctlList = SIMCTL_LIST): IOSSimulatorCommandRunner {
  return {
    run: vi.fn(async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "/usr/bin/xcode-select -p") {
        return {
          stdout: "/Applications/Xcode.app/Contents/Developer\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (key === "/usr/bin/xcodebuild -version") {
        return {
          stdout: "Xcode 26.4\nBuild version 17E11\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (key === "/usr/bin/xcrun simctl list -j") {
        return { stdout: simctlList, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${key}`);
    }),
  };
}

describe("parseSimctlListJson", () => {
  it("keeps iOS devices only and places booted devices first", () => {
    const parsed = parseSimctlListJson(SIMCTL_LIST);
    expect(parsed.runtimes.map((runtime) => runtime.name)).toEqual([
      "iOS 26.4",
    ]);
    expect(parsed.devices.map((device) => device.udid)).toEqual([
      "BOOTED-UDID",
      "SHUTDOWN-UDID",
    ]);
    expect(parsed.devices[0]).toMatchObject({
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      runtimeVersion: "26.4",
      state: "Booted",
    });
  });

  it("rejects invalid JSON with a stable error code", () => {
    expect(() => parseSimctlListJson("{")).toThrowError(
      expect.objectContaining({ code: "INVALID_SIMCTL_OUTPUT" }),
    );
  });

  it("marks devices unavailable when their iOS runtime is unavailable", () => {
    const parsed = parseSimctlListJson(
      JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
            name: "iOS 18.0",
            version: "18.0",
            isAvailable: false,
            availabilityError: "runtime profile not found",
          },
        ],
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
            {
              udid: "STALE-DEVICE",
              name: "iPhone 16",
              state: "Shutdown",
              isAvailable: true,
            },
          ],
        },
      }),
    );

    expect(parsed.devices[0]?.isAvailable).toBe(false);
  });

  it("deduplicates runtime identifiers and prefers an available record", () => {
    const parsed = parseSimctlListJson(
      JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            name: "iOS 26.0",
            isAvailable: false,
            availabilityError: "stale runtime profile",
          },
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            name: "iOS 26.0",
            isAvailable: true,
          },
        ],
        devices: {},
      }),
    );

    expect(parsed.runtimes).toHaveLength(1);
    expect(parsed.runtimes[0]?.isAvailable).toBe(true);
  });
});

describe("createIOSSimulatorRuntime", () => {
  it("returns a ready report from structured Apple tooling output", async () => {
    const commandRunner = runnerForSimctl();
    const report = await createIOSSimulatorRuntime({
      platform: "darwin",
      commandRunner,
    }).inspect();

    expect(report).toMatchObject({
      supported: true,
      ready: true,
      issue: null,
      xcodeSelectPath: "/Applications/Xcode.app/Contents/Developer",
      xcodeVersion: "Xcode 26.4\nBuild version 17E11",
    });
    expect(report.devices).toHaveLength(2);
  });

  it("never exposes interrupted-create markers as attachable devices", async () => {
    const simctl = JSON.parse(SIMCTL_LIST) as {
      devices: Record<string, Array<Record<string, unknown>>>;
    };
    simctl.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-4"]!.push({
      udid: "MARKER-UDID",
      name: "__CindyPending__profilealpha__11111111-2222-4333-8444-555555555555",
      state: "Booted",
      isAvailable: true,
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    });

    const report = await createIOSSimulatorRuntime({
      platform: "darwin",
      commandRunner: runnerForSimctl(JSON.stringify(simctl)),
    }).inspect();

    expect(report.ready).toBe(true);
    expect(report.devices.map((device) => device.udid)).not.toContain(
      "MARKER-UDID",
    );
  });

  it("uses one exact DEVELOPER_DIR without mutating xcode-select", async () => {
    const commandRunner = runnerForSimctl();
    const developerDir = "/Applications/Xcode-26.4.app/Contents/Developer";
    const controller = new AbortController();
    const report = await createIOSSimulatorRuntime({
      platform: "darwin",
      commandRunner,
      developerDir,
    }).inspect(controller.signal);

    expect(report).toMatchObject({
      ready: true,
      xcodeSelectPath: developerDir,
    });
    expect(commandRunner.run).not.toHaveBeenCalledWith(
      "/usr/bin/xcode-select",
      ["-p"],
    );
    expect(commandRunner.run).toHaveBeenCalledWith(
      "/usr/bin/xcodebuild",
      ["-version"],
      expect.objectContaining({
        env: expect.objectContaining({ DEVELOPER_DIR: developerDir }),
        signal: controller.signal,
      }),
    );
    expect(commandRunner.run).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      ["simctl", "list", "-j"],
      expect.objectContaining({
        env: expect.objectContaining({ DEVELOPER_DIR: developerDir }),
        signal: controller.signal,
      }),
    );
  });

  it("passes one inspection abort signal to every Apple tooling command", async () => {
    const commandRunner = runnerForSimctl();
    const controller = new AbortController();

    await createIOSSimulatorRuntime({
      platform: "darwin",
      commandRunner,
    }).inspect(controller.signal);

    for (const [command, args] of [
      ["/usr/bin/xcode-select", ["-p"]],
      ["/usr/bin/xcodebuild", ["-version"]],
      ["/usr/bin/xcrun", ["simctl", "list", "-j"]],
    ] as const) {
      expect(commandRunner.run).toHaveBeenCalledWith(
        command,
        args,
        expect.objectContaining({ signal: controller.signal }),
      );
    }
  });

  it("rejects a relative DEVELOPER_DIR before running Apple tools", async () => {
    const run = vi.fn();
    const report = await createIOSSimulatorRuntime({
      platform: "darwin",
      commandRunner: { run },
      developerDir: "Xcode.app/Contents/Developer",
    }).inspect();

    expect(report).toMatchObject({
      ready: false,
      issue: "XCODE_NOT_FOUND",
      error: "DEVELOPER_DIR must be an absolute Xcode Developer directory.",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed without running commands on non-macOS platforms", async () => {
    const run = vi.fn();
    const report = await createIOSSimulatorRuntime({
      platform: "linux",
      commandRunner: { run },
    }).inspect();

    expect(report).toMatchObject({
      supported: false,
      ready: false,
      issue: "UNSUPPORTED_PLATFORM",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns setup guidance when Xcode is missing", async () => {
    const report = await createIOSSimulatorRuntime({
      platform: "darwin",
      commandRunner: {
        run: vi.fn(async () => ({
          stdout: "",
          stderr: "unable to get active developer directory",
          exitCode: 1,
        })),
      },
    }).inspect();

    expect(report.issue).toBe("XCODE_NOT_FOUND");
    expect(report.setupSteps).toContain("Install Xcode.");
  });
});
