import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIOSSimulatorNativeSidecarSandboxPolicy,
  IOSSimulatorNativeSidecarProcessManager,
  IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
  validateIOSimulatorNativeFrame,
} from "../src/index.js";

const simulatorUdid =
  process.argv[process.argv.indexOf("--simulator-udid") + 1];
if (
  !simulatorUdid ||
  !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorUdid)
) {
  throw new Error(
    "Usage: pnpm native:sandbox-smoke -- --simulator-udid <exact-booted-UDID>",
  );
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const architecture =
  process.env.CINDY_IOS_SIDECAR_ARCH === "x86_64" ||
  process.env.CINDY_IOS_SIDECAR_ARCH === "arm64"
    ? process.env.CINDY_IOS_SIDECAR_ARCH
    : process.arch === "x64"
      ? "x86_64"
      : "arm64";
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
const instanceId = "native-sandbox-smoke";
const manager = new IOSSimulatorNativeSidecarProcessManager({
  binaryPath,
  sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
    required: true,
    platform: process.platform,
  }),
});

try {
  const running = await manager.start({
    instanceId,
    simulatorUdid,
    generation: 1,
    runtime: {
      runtimeIdentifier: "smoke",
      runtimeBuildVersion: null,
      xcodeBuild: "smoke",
      architecture,
    },
  });
  const frame = await running.adapter.captureNativeFrame({
    maxFrameBytes: IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
  });
  validateIOSimulatorNativeFrame(frame);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      sandbox: manager.diagnostics(instanceId).sandbox,
      probe: running.handshake.probe,
      framebuffer: {
        width: frame.width,
        height: frame.height,
        bytesPerRow: frame.bytesPerRow,
        byteCount: frame.bytes.byteLength,
      },
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "Error", message: "Unknown sandbox smoke failure" },
      diagnostics: manager.diagnostics(instanceId),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await manager.stop(instanceId).catch(() => undefined);
}
