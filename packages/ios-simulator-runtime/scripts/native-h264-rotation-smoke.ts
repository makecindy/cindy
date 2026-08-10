import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  IOSSimulatorNativeSidecarProcessManager,
  WdaProcessManager,
  type IOSSimulatorH264Frame,
} from "../src/index.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const archivePath = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "WebDriverAgent-v15.1.6.tar.gz",
);
const cacheRoot = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "cindy-ios-simulator-smoke",
  "wda",
);
const architecture = process.arch === "x64" ? "x86_64" : "arm64";
const binaryPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "native",
  architecture,
  "ios-simulator-sidecar",
);
const maxFrameBytes = 16 * 1024 * 1024 - 64 * 1024 - 4;
const instanceId = "native-h264-rotation-smoke";
const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let simulatorUdid: string | null = null;
let wdaManager: WdaProcessManager | null = null;
let sidecarManager: IOSSimulatorNativeSidecarProcessManager | null = null;

try {
  const environment = await createIOSSimulatorRuntime().inspect();
  if (!environment.ready) {
    throw new Error(
      environment.error ??
        environment.issue ??
        "Simulator environment unavailable",
    );
  }
  const requestedRuntime = process.env.CINDY_IOS_SIMULATOR_RUNTIME?.trim();
  const runtime = environment.runtimes.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.identifier.includes(".iOS-") &&
      (!requestedRuntime ||
        candidate.identifier === requestedRuntime ||
        candidate.version === requestedRuntime ||
        candidate.name === requestedRuntime),
  );
  if (!runtime) {
    throw new Error(
      requestedRuntime
        ? `Requested iOS runtime is not available: ${requestedRuntime}`
        : "No available iOS runtime",
    );
  }
  const template =
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime.identifier &&
        candidate.deviceTypeIdentifier?.includes("iPhone-17-Pro"),
    ) ??
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime.identifier &&
        candidate.deviceTypeIdentifier,
    );
  if (!template?.deviceTypeIdentifier) {
    throw new Error("No compatible simulator device type");
  }

  const created = await lifecycle.createExact({
    name: `Cindy Native H264 Rotation Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  simulatorUdid = created.udid;
  const device = await lifecycle.bootExact(simulatorUdid);
  await mkdir(cacheRoot, { recursive: true });

  wdaManager = new WdaProcessManager({ archivePath, cacheRoot });
  const wda = await wdaManager.start({
    instanceId,
    simulatorUdid,
    runtimeIdentifier: device.runtimeIdentifier,
    xcodeBuild: environment.xcodeVersion ?? "unknown",
    architecture,
  });
  const launch = await runner.run(
    "/usr/bin/xcrun",
    ["simctl", "launch", simulatorUdid, "com.apple.mobilesafari"],
    { timeoutMs: 30_000 },
  );
  if (launch.exitCode !== 0) {
    throw new Error(
      "Unable to launch a rotatable app in the temporary simulator",
    );
  }
  await delay(1_000);
  await wda.driver.setOrientation("PORTRAIT", wda.driverSessionId);
  const waitForOrientation = async (
    expected: "PORTRAIT" | "LANDSCAPE",
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await wda.driver.getOrientation(wda.driverSessionId)) === expected) {
        return;
      }
      await delay(100);
    }
    throw new Error(`WDA did not reach ${expected} orientation`);
  };
  await waitForOrientation("PORTRAIT");

  sidecarManager = new IOSSimulatorNativeSidecarProcessManager({
    binaryPath,
    enableH264Stream: true,
  });
  const native = await sidecarManager.start({
    instanceId,
    simulatorUdid,
    generation: 1,
  });
  if (!native.handshake.capabilities.h264Stream) {
    throw new Error("Opt-in sidecar did not advertise H.264 streaming");
  }
  let observedFrames = 0;
  const captureProfile = async (
    orientation: "PORTRAIT" | "LANDSCAPE",
  ): Promise<IOSSimulatorH264Frame> => {
    await native.adapter.configureNativeStream({
      encoding: "h264",
      framesPerSecond: 5,
      scalingPercent: 50,
      orientation,
    });
    let firstFrame: IOSSimulatorH264Frame | null = null;
    let previousSequence = -1;
    const stats = await native.adapter.streamNativeFrames({
      maxFrames: 3,
      maxFrameBytes,
      onFrame(frame) {
        if (frame.encoding !== "h264") {
          throw new Error(`Expected H.264, received ${frame.encoding}`);
        }
        if (frame.sequence !== previousSequence + 1) {
          throw new Error(
            `Expected sequence ${previousSequence + 1}, received ${String(frame.sequence)}`,
          );
        }
        previousSequence = frame.sequence;
        observedFrames += 1;
        firstFrame ??= frame;
      },
    });
    if (
      stats.endReason !== "max-frames" ||
      stats.frameCount !== 3 ||
      !firstFrame ||
      !firstFrame.keyFrame ||
      firstFrame.orientation !== orientation ||
      (orientation === "PORTRAIT"
        ? firstFrame.width >= firstFrame.height
        : firstFrame.width <= firstFrame.height)
    ) {
      throw new Error(
        `Native H.264 ${orientation} profile is invalid: ${JSON.stringify({
          stats,
          frame: firstFrame
            ? {
                width: firstFrame.width,
                height: firstFrame.height,
                orientation: firstFrame.orientation,
                keyFrame: firstFrame.keyFrame,
              }
            : null,
        })}`,
      );
    }
    return firstFrame;
  };

  const initialPortrait = await captureProfile("PORTRAIT");
  await wda.driver.setOrientation("LANDSCAPE", wda.driverSessionId);
  await waitForOrientation("LANDSCAPE");
  const landscape = await captureProfile("LANDSCAPE");
  await wda.driver.setOrientation("PORTRAIT", wda.driverSessionId);
  await waitForOrientation("PORTRAIT");
  const finalPortrait = await captureProfile("PORTRAIT");

  if (
    initialPortrait.width !== finalPortrait.width ||
    initialPortrait.height !== finalPortrait.height ||
    initialPortrait.width !== landscape.height ||
    initialPortrait.height !== landscape.width
  ) {
    throw new Error("Native H.264 rotated dimensions are inconsistent");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      simulatorUdid,
      runtime: runtime.identifier,
      architecture,
      observedFrames,
      dimensionTransitions: 2,
      initialPortrait: {
        width: initialPortrait.width,
        height: initialPortrait.height,
        keyFrame: initialPortrait.keyFrame,
      },
      landscape: {
        width: landscape.width,
        height: landscape.height,
        keyFrame: landscape.keyFrame,
      },
      finalPortrait: {
        width: finalPortrait.width,
        height: finalPortrait.height,
        keyFrame: finalPortrait.keyFrame,
      },
      endReason: "max-frames",
    })}\n`,
  );
} finally {
  if (sidecarManager) {
    await sidecarManager.stop(instanceId).catch(() => undefined);
  }
  if (wdaManager) {
    await wdaManager.stop(instanceId).catch(() => undefined);
  }
  if (simulatorUdid) {
    await lifecycle.shutdownExact(simulatorUdid).catch(() => undefined);
    await lifecycle.deleteExact(simulatorUdid).catch(() => undefined);
  }
}
