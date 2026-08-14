import { describe, expect, it } from "vitest";

import {
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
} from "./capability-admission.js";
import {
  IOS_SIMULATOR_WDA_CAPABILITIES,
  type IOSSimulatorDiscreteInputDriver,
  type IOSSimulatorJpegStreamDriver,
  type IOSSimulatorSemanticDriver,
  type IOSSimulatorNativeSidecarDriver,
} from "./driver.js";
import { IOSSimulatorDriverRouter } from "./driver-router.js";

function fakeSemantic(): IOSSimulatorSemanticDriver {
  return {
    kind: "wda",
    capabilities: IOS_SIMULATOR_WDA_CAPABILITIES,
  } as IOSSimulatorSemanticDriver;
}

function fakeDiscreteInput(): IOSSimulatorDiscreteInputDriver {
  return {
    kind: "wda",
    capabilities: IOS_SIMULATOR_WDA_CAPABILITIES,
  } as IOSSimulatorDiscreteInputDriver;
}

function fakeJpegStream(): IOSSimulatorJpegStreamDriver {
  return {
    kind: "wda",
    capabilities: IOS_SIMULATOR_WDA_CAPABILITIES,
  } as IOSSimulatorJpegStreamDriver;
}

function fakeNative(): IOSSimulatorNativeSidecarDriver {
  return {
    kind: "native-sidecar",
    simulatorUdid: "UDID-1",
    generation: 4,
    capabilities: {
      accessibility: false,
      sessions: false,
      jpegStream: false,
      h264Stream: true,
      bgraStream: true,
      discreteInput: true,
      continuousInput: true,
      multiTouch: true,
    },
  } as IOSSimulatorNativeSidecarDriver;
}

describe("IOSSimulatorDriverRouter", () => {
  it("keeps WDA as the default route when no native sidecar is configured", () => {
    const router = new IOSSimulatorDriverRouter({
      semantic: fakeSemantic(),
      discreteInput: fakeDiscreteInput(),
      jpegStream: fakeJpegStream(),
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(router.stream("jpeg").adapter).toBe("wda");
    expect(router.stream("h264")).toMatchObject({
      adapter: "wda",
      fallback: true,
    });
    expect(router.continuousInput()).toBeNull();
    expect(router.capabilityReport()).toMatchObject({
      generatedAt: "2026-07-23T00:00:00.000Z",
      nativeSidecar: { available: false },
      routes: {
        discreteInput: { selected: "wda", fallback: false },
        continuousInput: { selected: "wda", fallback: true },
      },
    });
  });

  it("selects native H.264/BGRA and continuous HID only when advertised", () => {
    const native = fakeNative();
    const router = new IOSSimulatorDriverRouter({
      semantic: fakeSemantic(),
      discreteInput: fakeDiscreteInput(),
      jpegStream: fakeJpegStream(),
      nativeSidecar: native,
    });

    expect(router.stream("h264")).toMatchObject({
      adapter: "native-sidecar",
      fallback: false,
      source: native,
    });
    expect(router.stream("bgra")).toMatchObject({
      adapter: "native-sidecar",
      fallback: false,
    });
    expect(router.stream("jpeg").adapter).toBe("wda");
    expect(router.continuousInput()).toBe(native);
    expect(router.capabilityReport().nativeSidecar).toMatchObject({
      available: true,
      simulatorUdid: "UDID-1",
      generation: 4,
    });
  });

  it("falls back immediately when the configured native process is no longer running", () => {
    let available = true;
    const router = new IOSSimulatorDriverRouter({
      semantic: fakeSemantic(),
      discreteInput: fakeDiscreteInput(),
      jpegStream: fakeJpegStream(),
      nativeSidecar: fakeNative(),
      isNativeSidecarAvailable: () => available,
    });
    expect(router.stream("h264").adapter).toBe("native-sidecar");
    available = false;
    expect(router.stream("h264")).toMatchObject({
      adapter: "wda",
      fallback: true,
      reason: "Native sidecar process is not running.",
    });
    expect(router.continuousInput()).toBeNull();
    expect(router.capabilityReport().nativeSidecar).toMatchObject({
      available: false,
      reason: "Native sidecar process is not running.",
    });
  });

  it("uses host admission even when an adapter advertises a denied capability", () => {
    const native = fakeNative();
    const policy = createIOSSimulatorNativeDevelopmentAdmissionPolicy({
      enableContinuousInput: true,
    });
    const admission = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      detectedCapabilities: native.capabilities,
      processState: "running",
    });
    const router = new IOSSimulatorDriverRouter({
      semantic: fakeSemantic(),
      discreteInput: fakeDiscreteInput(),
      jpegStream: fakeJpegStream(),
      nativeSidecar: native,
      nativeAdmission: () => admission,
    });

    expect(router.stream("h264")).toMatchObject({
      adapter: "wda",
      fallback: true,
      reason: "Native capability was not requested by host policy.",
    });
    expect(router.continuousInput()).toBe(native);
    expect(router.capabilityReport().nativeSidecar.admission).toMatchObject({
      fallbackRoute: "wda-mjpeg",
      capabilities: {
        h264Stream: {
          detected: true,
          active: false,
          reasonCode: "NOT_REQUESTED",
        },
        continuousInput: {
          detected: true,
          active: true,
        },
      },
    });
  });
});
