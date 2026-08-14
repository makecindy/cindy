import { describe, expect, it } from "vitest";

import { collectIOSSimulatorCompatibilityReport } from "./compatibility.js";

describe("collectIOSSimulatorCompatibilityReport", () => {
  it("keeps the report JSON-safe and records WDA pin metadata", async () => {
    const report = await collectIOSSimulatorCompatibilityReport({
      platform: "linux",
    });
    expect(report).toMatchObject({
      schemaVersion: 2,
      platform: "linux",
      host: { architecture: process.arch },
      supported: false,
      ready: false,
      wda: {
        tag: "v15.1.6",
        revision: "5f8280e761dc0b5b9b28368e63a8f0cc8d868346",
      },
      simulatorDevices: { total: 0, available: 0, booted: 0 },
      nativePolicy: {
        packagedDefault: "wda-mjpeg",
        admissionVersion: 1,
        packagedRequiresVerifiedArtifact: true,
        packagedRequiresEligibleMatrix: true,
        packagedPromotedRoute: "native-capability-auto",
        releaseCompatibilityVersion: 1,
        productBgraStream: false,
      },
    });
    expect(() => JSON.stringify(report)).not.toThrow();
    expect(report.generatedAt).toMatch(/^20\d\d-/);
  });

  it("summarizes available and booted devices from the runtime report", async () => {
    const runner = {
      async run(command: string, args: readonly string[]) {
        if (command === "/usr/bin/xcode-select") {
          return {
            stdout: "/Applications/Xcode.app/Contents/Developer\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "-version") {
          return {
            stdout: "Xcode 26.4\nBuild version 17F",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            runtimes: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-4": {
                name: "iOS 26.4",
                identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
                version: "26.4",
                buildversion: "23E219",
                isAvailable: true,
              },
            },
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
                { udid: "A", name: "A", state: "Booted", isAvailable: true },
                { udid: "B", name: "B", state: "Shutdown", isAvailable: true },
              ],
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const report = await collectIOSSimulatorCompatibilityReport({
      commandRunner: runner,
      platform: "darwin",
    });
    expect(report).toMatchObject({
      ready: true,
      xcode: {
        version: "Xcode 26.4\nBuild version 17F",
        productVersion: "26.4",
        buildVersion: "17F",
      },
      simulatorDevices: { total: 2, available: 2, booted: 1 },
    });
  });

  it("accepts stable host and time inputs for matrix artifacts", async () => {
    const report = await collectIOSSimulatorCompatibilityReport({
      platform: "linux",
      architecture: "arm64",
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });

    expect(report).toMatchObject({
      generatedAt: "2026-07-25T00:00:00.000Z",
      host: { architecture: "arm64" },
    });
  });
});
