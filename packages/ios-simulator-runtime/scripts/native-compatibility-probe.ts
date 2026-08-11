import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createIOSSimulatorNativeSidecarSandboxPolicy,
  IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
  IOSSimulatorNativeSidecarProcessManager,
  parseIOSSimulatorCompatibilitySelectors,
  selectIOSSimulatorCompatibilityRuntimes,
  selectIOSSimulatorNativeArchitectures,
  validateIOSimulatorNativeFrame,
} from "../src/index.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runtimeSelectors = parseIOSSimulatorCompatibilitySelectors(
  process.env.CINDY_IOS_SIMULATOR_RUNTIME,
  "CINDY_IOS_SIMULATOR_RUNTIME",
);
const architecture = selectIOSSimulatorNativeArchitectures(
  process.arch,
  parseIOSSimulatorCompatibilitySelectors(
    process.env.CINDY_IOS_SIDECAR_ARCH,
    "CINDY_IOS_SIDECAR_ARCH",
  ),
)[0];
if (!architecture) throw new Error("A native sidecar architecture is required");

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
const instanceId = "native-compatibility-probe";
const runtime = createIOSSimulatorRuntime();
const lifecycle = createIOSSimulatorSimctlLifecycle();
const manager = new IOSSimulatorNativeSidecarProcessManager({
  binaryPath,
  enableH264Stream: true,
  enableContinuousInput: true,
  sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
    required: true,
    platform: process.platform,
  }),
});
let simulatorUdid: string | null = null;

try {
  const environment = await runtime.inspect();
  if (!environment.ready) {
    throw new Error(
      environment.error ?? environment.issue ?? "environment unavailable",
    );
  }
  const selectedRuntime = selectIOSSimulatorCompatibilityRuntimes(
    environment.runtimes,
    runtimeSelectors,
  )[0];
  if (!selectedRuntime) {
    throw new Error("No compatible iOS runtime for native capability probe");
  }
  const template =
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === selectedRuntime.identifier &&
        candidate.deviceTypeIdentifier,
    ) ??
    environment.devices.find(
      (candidate) => candidate.isAvailable && candidate.deviceTypeIdentifier,
    );
  if (!template?.deviceTypeIdentifier) {
    throw new Error("No compatible simulator device type");
  }

  const created = await lifecycle.createExact({
    name: `Cindy Native Compatibility Probe ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: selectedRuntime.identifier,
  });
  simulatorUdid = created.udid;
  await lifecycle.bootExact(simulatorUdid);

  const running = await manager.start({
    instanceId,
    simulatorUdid,
    generation: 1,
  });
  const probe = running.handshake.probe;
  if (
    !probe?.coreSimulatorLoaded ||
    !probe.simulatorKitLoaded ||
    !probe.deviceDiscovery ||
    !probe.framebufferSymbols ||
    !probe.framebufferCapture ||
    !probe.framebuffer ||
    !probe.hid
  ) {
    throw new Error(
      `Native framework capability probe is incomplete: ${JSON.stringify(probe)}`,
    );
  }
  if (
    !running.handshake.capabilities.h264Stream ||
    !running.handshake.capabilities.continuousInput ||
    !running.handshake.capabilities.multiTouch
  ) {
    throw new Error(
      `Native product capabilities are incomplete: ${JSON.stringify(running.handshake.capabilities)}`,
    );
  }

  const framebuffer = await running.adapter.captureNativeFrame({
    maxFrameBytes: IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
  });
  validateIOSimulatorNativeFrame(framebuffer);
  await running.adapter.configureNativeStream({
    encoding: "h264",
    framesPerSecond: 5,
    scalingPercent: 50,
  });
  let h264Frames = 0;
  let keyFrames = 0;
  const h264Stats = await running.adapter.streamNativeFrames({
    maxFrames: 3,
    maxFrameBytes: IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
    onFrame(frame) {
      validateIOSimulatorNativeFrame(frame);
      if (frame.encoding !== "h264") {
        throw new Error(`Expected H.264 frame, received ${frame.encoding}`);
      }
      h264Frames += 1;
      if (frame.keyFrame) keyFrames += 1;
    },
  });
  if (
    h264Frames !== 3 ||
    keyFrames < 1 ||
    h264Stats.endReason !== "max-frames"
  ) {
    throw new Error(
      `Native H.264 probe was incomplete: ${JSON.stringify({ h264Frames, keyFrames, h264Stats })}`,
    );
  }

  await running.adapter.touchPath([
    { phase: "down", x: 0.3, y: 0.3 },
    { phase: "move", x: 0.4, y: 0.4, dtMs: 20 },
    { phase: "up", x: 0.5, y: 0.5, dtMs: 20 },
  ]);
  await running.adapter.touch2Path(
    [
      { phase: "down", x: 0.4, y: 0.5 },
      { phase: "move", x: 0.35, y: 0.5, dtMs: 20 },
      { phase: "up", x: 0.3, y: 0.5, dtMs: 20 },
    ],
    [
      { phase: "down", x: 0.6, y: 0.5 },
      { phase: "move", x: 0.65, y: 0.5, dtMs: 20 },
      { phase: "up", x: 0.7, y: 0.5, dtMs: 20 },
    ],
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      xcode: environment.xcodeVersion,
      developerDir: environment.xcodeSelectPath,
      architecture,
      runtime: {
        identifier: selectedRuntime.identifier,
        version: selectedRuntime.version,
        buildVersion: selectedRuntime.buildVersion,
      },
      capabilities: running.handshake.capabilities,
      probe,
      framebuffer: {
        width: framebuffer.width,
        height: framebuffer.height,
        bytesPerRow: framebuffer.bytesPerRow,
      },
      h264: {
        frames: h264Frames,
        keyFrames,
        bytes: h264Stats.byteCount,
      },
      hidTransport: {
        singleTouchAccepted: true,
        multiTouchAccepted: true,
      },
    })}\n`,
  );
} finally {
  await manager.stop(instanceId).catch(() => undefined);
  if (simulatorUdid) {
    await lifecycle.shutdownExact(simulatorUdid).catch(() => undefined);
    await lifecycle.deleteExact(simulatorUdid).catch(() => undefined);
  }
}
