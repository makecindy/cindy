import { describe, expect, it } from "vitest";

import {
  evaluateIOSSimulatorCompatibilityCase,
  parseIOSSimulatorCompatibilitySelectors,
  resolveIOSSimulatorNativeReleaseCompatibility,
  selectIOSSimulatorCompatibilityRuntimes,
  selectIOSSimulatorNativeArchitectures,
} from "./compatibility-matrix.js";
import type { IOSSimulatorRuntimeInfo } from "./types.js";

function runtime(version: string): IOSSimulatorRuntimeInfo {
  return {
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}`,
    name: `iOS ${version}`,
    version,
    buildVersion: `build-${version}`,
    isAvailable: true,
    availabilityError: null,
  };
}

describe("iOS Simulator compatibility matrix", () => {
  it("selects oldest, middle, and latest runtimes by default", () => {
    expect(
      selectIOSSimulatorCompatibilityRuntimes(
        [runtime("26.4"), runtime("16.4"), runtime("18.5"), runtime("17.2")],
        null,
      ).map((item) => item.version),
    ).toEqual(["16.4", "18.5", "26.4"]);
  });

  it("resolves explicit identifiers, names, and versions exactly", () => {
    const runtimes = [runtime("18.5"), runtime("26.4")];
    expect(
      selectIOSSimulatorCompatibilityRuntimes(runtimes, [
        "18.5",
        "iOS 26.4",
      ]).map((item) => item.version),
    ).toEqual(["18.5", "26.4"]);
    expect(() =>
      selectIOSSimulatorCompatibilityRuntimes(runtimes, ["27.0"]),
    ).toThrow("Requested iOS runtime is not available: 27.0");
  });

  it("normalizes bounded selector and architecture axes", () => {
    expect(
      parseIOSSimulatorCompatibilitySelectors(
        " arm64, x86_64,arm64 ",
        "architectures",
      ),
    ).toEqual(["arm64", "x86_64"]);
    expect(selectIOSSimulatorNativeArchitectures("x64", null)).toEqual([
      "x86_64",
    ]);
    expect(
      selectIOSSimulatorNativeArchitectures("arm64", ["x86_64", "arm64"]),
    ).toEqual(["x86_64", "arm64"]);
    expect(() =>
      selectIOSSimulatorNativeArchitectures("arm64", ["universal"]),
    ).toThrow("Unsupported native sidecar architecture: universal");
  });

  it("passes a fully functional native case", () => {
    expect(
      evaluateIOSSimulatorCompatibilityCase({
        wdaSmoke: { ok: true },
        wdaRecovery: { ok: true },
        nativeBuild: { ok: true },
        nativeProbe: { ok: true },
        nativeHid: { ok: true },
        requireNative: true,
      }),
    ).toEqual({
      status: "passed",
      reasons: [],
      wdaBaselineReady: true,
      nativeReady: true,
      fallbackReady: true,
      releaseRoute: "native-opt-in-eligible",
    });
  });

  it("degrades to WDA when optional private APIs are unavailable", () => {
    expect(
      evaluateIOSSimulatorCompatibilityCase({
        wdaSmoke: { ok: true },
        wdaRecovery: null,
        nativeBuild: { ok: true },
        nativeProbe: { ok: false },
        nativeHid: { ok: false, skipped: true },
        requireNative: false,
      }),
    ).toMatchObject({
      status: "degraded",
      reasons: ["NATIVE_PROBE_FAILED", "NATIVE_HID_SKIPPED"],
      nativeReady: false,
      fallbackReady: true,
      releaseRoute: "wda-mjpeg",
    });
  });

  it("fails required native cases and any broken WDA baseline", () => {
    expect(
      evaluateIOSSimulatorCompatibilityCase({
        wdaSmoke: { ok: true },
        nativeBuild: { ok: false },
        nativeProbe: { ok: false, skipped: true },
        nativeHid: { ok: false, skipped: true },
        requireNative: true,
      }).status,
    ).toBe("failed");
    expect(
      evaluateIOSSimulatorCompatibilityCase({
        wdaSmoke: { ok: false },
        nativeBuild: { ok: true },
        nativeProbe: { ok: true },
        nativeHid: { ok: true },
        requireNative: false,
      }),
    ).toMatchObject({
      status: "failed",
      fallbackReady: false,
      reasons: ["WDA_SMOKE_FAILED"],
    });
  });

  it("promotes the exact reviewed release combination per capability", () => {
    expect(
      resolveIOSSimulatorNativeReleaseCompatibility({
        hostOsRelease: "25.3.0",
        xcodeVersion: "Xcode 26.4\nBuild version 17E192",
        runtimeIdentifier:
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        runtimeBuildVersion: "23E244",
        architecture: "arm64",
      }),
    ).toEqual({
      matrixVersion: 1,
      matchedCaseId:
        "darwin-25.3.0_xcode-26.4-17E192_ios-26.4-23E244_arm64",
      sidecar: "eligible",
      h264Stream: "eligible",
      continuousInput: "eligible",
      multiTouch: "eligible",
    });
  });

  it.each([
    {
      hostOsRelease: "25.4.0",
      xcodeVersion: "Xcode 26.4\nBuild version 17E192",
      runtimeBuildVersion: "23E244",
      architecture: "arm64" as const,
    },
    {
      hostOsRelease: "25.3.0",
      xcodeVersion: "Xcode 26.4\nBuild version 17E193",
      runtimeBuildVersion: "23E244",
      architecture: "arm64" as const,
    },
    {
      hostOsRelease: "25.3.0",
      xcodeVersion: "Xcode 26.4\nBuild version 17E192",
      runtimeBuildVersion: "23E245",
      architecture: "arm64" as const,
    },
    {
      hostOsRelease: "25.3.0",
      xcodeVersion: "Xcode 26.4\nBuild version 17E192",
      runtimeBuildVersion: "23E244",
      architecture: "x86_64" as const,
    },
    {
      hostOsRelease: "25.3.0",
      xcodeVersion: "17E192",
      runtimeBuildVersion: "23E244",
      architecture: "arm64" as const,
    },
  ])("keeps unreviewed release combinations unknown: %#", (patch) => {
    expect(
      resolveIOSSimulatorNativeReleaseCompatibility({
        hostOsRelease: patch.hostOsRelease,
        xcodeVersion: patch.xcodeVersion,
        runtimeIdentifier:
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        runtimeBuildVersion: patch.runtimeBuildVersion,
        architecture: patch.architecture,
      }),
    ).toMatchObject({
      matchedCaseId: null,
      sidecar: "unknown",
      h264Stream: "unknown",
      continuousInput: "unknown",
      multiTouch: "unknown",
    });
  });

  it("keeps an unreviewed runtime identifier unknown", () => {
    expect(
      resolveIOSSimulatorNativeReleaseCompatibility({
        hostOsRelease: "25.3.0",
        xcodeVersion: "Xcode 26.4\nBuild version 17E192",
        runtimeIdentifier:
          "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
        runtimeBuildVersion: "23E244",
        architecture: "arm64",
      }),
    ).toMatchObject({
      matchedCaseId: null,
      sidecar: "unknown",
      h264Stream: "unknown",
      continuousInput: "unknown",
      multiTouch: "unknown",
    });
  });
});
