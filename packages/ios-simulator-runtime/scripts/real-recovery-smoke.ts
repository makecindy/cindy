import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  WdaProcessManager,
} from "../src/index.js";

const archivePath = path.resolve(
  process.cwd(),
  "../../apps/desktop/resources/ios-simulator/WebDriverAgent-v15.1.6.tar.gz",
);
const cacheRoot = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "cindy-ios-simulator-smoke",
  "wda",
);
const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();
let udid: string | null = null;
let manager: WdaProcessManager | null = null;

const initialEnvironment = await createIOSSimulatorRuntime().inspect();
if (!initialEnvironment.ready) {
  throw new Error(
    initialEnvironment.error ??
      initialEnvironment.issue ??
      "environment unavailable",
  );
}
const originallyBooted = initialEnvironment.devices
  .filter(
    (device) => device.isAvailable && device.state.toLowerCase() === "booted",
  )
  .map((device) => device.udid);

try {
  const requestedRuntime = process.env.CINDY_IOS_SIMULATOR_RUNTIME?.trim();
  const runtime = initialEnvironment.runtimes.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.identifier.includes(".iOS-") &&
      (!requestedRuntime ||
        candidate.identifier === requestedRuntime ||
        candidate.version === requestedRuntime ||
        candidate.name === requestedRuntime),
  );
  if (requestedRuntime && !runtime) {
    throw new Error(
      `Requested iOS runtime is not available: ${requestedRuntime}`,
    );
  }
  const template =
    initialEnvironment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime?.identifier &&
        candidate.deviceTypeIdentifier?.includes("iPhone-17-Pro"),
    ) ??
    initialEnvironment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime?.identifier &&
        candidate.deviceTypeIdentifier?.includes("iPhone"),
    ) ??
    initialEnvironment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime?.identifier &&
        candidate.deviceTypeIdentifier,
    );
  if (!runtime || !template?.deviceTypeIdentifier) {
    throw new Error("No compatible iPhone runtime/device type");
  }

  const created = await lifecycle.createExact({
    name: `Cindy Recovery Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  udid = created.udid;
  const device = await lifecycle.bootExact(udid);
  await mkdir(cacheRoot, { recursive: true });
  manager = new WdaProcessManager({ archivePath, cacheRoot });
  const startOptions = {
    instanceId: "real-recovery-smoke",
    simulatorUdid: udid,
    runtimeIdentifier: device.runtimeIdentifier,
    xcodeBuild: initialEnvironment.xcodeVersion ?? "unknown",
    architecture:
      process.arch === "x64" ? ("x86_64" as const) : ("arm64" as const),
  };
  await manager.start(startOptions);

  const quit = await runner.run(
    "/usr/bin/osascript",
    ["-e", 'tell application "Simulator" to quit'],
    { timeoutMs: 30_000 },
  );
  if (quit.exitCode !== 0)
    throw new Error("Simulator.app did not quit cleanly");

  await manager.stop(startOptions.instanceId);
  await lifecycle.bootExact(udid);
  const recovered = await manager.start(startOptions);
  const health = await recovered.driver.probe();
  const accessibility = await recovered.driver.getAccessibilityTree(
    recovered.driverSessionId,
  );
  if (!health.ready)
    throw new Error("WDA did not recover after Simulator.app quit");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      udid,
      restoredUserDevices: originallyBooted.length,
      recoveredPid: recovered.pid,
      accessibilityCapturedAt: accessibility.capturedAt,
    })}\n`,
  );
} finally {
  if (manager) await manager.stop("real-recovery-smoke").catch(() => undefined);
  if (udid) {
    await lifecycle.shutdownExact(udid).catch(() => undefined);
    await lifecycle.deleteExact(udid).catch(() => undefined);
  }
  for (const originalUdid of originallyBooted) {
    await lifecycle.bootExact(originalUdid).catch(() => undefined);
  }
}
