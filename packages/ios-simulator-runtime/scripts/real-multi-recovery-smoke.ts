import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  normalizeIOSSimulatorScreenMap,
  WdaProcessManager,
  type IOSSimulatorAutomationDriver,
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
const count = boundedInteger(process.env.CINDY_IOS_SIMULATOR_COUNT, 2, 2, 4);
const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();
const environment = await createIOSSimulatorRuntime().inspect();
if (!environment.ready) {
  throw new Error(
    environment.error ?? environment.issue ?? "environment unavailable",
  );
}

const originallyBooted = environment.devices
  .filter(
    (device) => device.isAvailable && device.state.toLowerCase() === "booted",
  )
  .map((device) => device.udid);
const requestedRuntime = process.env.CINDY_IOS_SIMULATOR_RUNTIME?.trim();
const runtime =
  environment.runtimes.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.identifier.includes(".iOS-") &&
      (!requestedRuntime ||
        candidate.identifier === requestedRuntime ||
        candidate.version === requestedRuntime ||
        candidate.name === requestedRuntime),
  ) ??
  (!requestedRuntime
    ? (environment.runtimes.find(
        (candidate) =>
          candidate.isAvailable && candidate.identifier.includes(".iOS-26-4"),
      ) ??
      environment.runtimes.find(
        (candidate) =>
          candidate.isAvailable && candidate.identifier.includes(".iOS-"),
      ))
    : undefined);
if (requestedRuntime && !runtime) {
  throw new Error(
    `Requested iOS runtime is not available: ${requestedRuntime}`,
  );
}
const template =
  environment.devices.find(
    (device) =>
      device.isAvailable &&
      device.runtimeIdentifier === runtime?.identifier &&
      device.deviceTypeIdentifier?.includes("iPhone-17-Pro"),
  ) ??
  environment.devices.find(
    (device) =>
      device.isAvailable &&
      device.runtimeIdentifier === runtime?.identifier &&
      device.deviceTypeIdentifier?.includes("iPhone"),
  ) ??
  environment.devices.find(
    (device) =>
      device.isAvailable &&
      device.runtimeIdentifier === runtime?.identifier &&
      device.deviceTypeIdentifier,
  );
if (!runtime || !template?.deviceTypeIdentifier) {
  throw new Error("No compatible iOS runtime/device type");
}

const manager = new WdaProcessManager({ archivePath, cacheRoot });
const instanceIds = Array.from(
  { length: count },
  (_, index) => `real-multi-recovery-${index + 1}`,
);
const udids: string[] = [];

try {
  await mkdir(cacheRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const created = await lifecycle.createExact({
      name: `Cindy Multi Recovery Smoke ${Date.now()}-${index + 1}`,
      deviceTypeIdentifier: template.deviceTypeIdentifier,
      runtimeIdentifier: runtime.identifier,
    });
    udids.push(created.udid);
  }

  const devices = [];
  for (const udid of udids) devices.push(await lifecycle.bootExact(udid));
  for (let index = 0; index < devices.length; index += 1) {
    await manager.start({
      instanceId: instanceIds[index]!,
      simulatorUdid: devices[index]!.udid,
      runtimeIdentifier: devices[index]!.runtimeIdentifier,
      xcodeBuild: environment.xcodeVersion ?? "unknown",
      architecture: process.arch === "x64" ? "x86_64" : "arm64",
    });
  }

  const open = await runner.run("/usr/bin/open", ["-a", "Simulator"], {
    timeoutMs: 30_000,
  });
  if (open.exitCode !== 0)
    throw new Error("Simulator.app did not open cleanly");
  await waitForSimulatorProcess();

  const quit = await runner.run(
    "/usr/bin/osascript",
    ["-e", 'tell application "Simulator" to quit'],
    { timeoutMs: 30_000 },
  );
  if (quit.exitCode !== 0)
    throw new Error("Simulator.app did not quit cleanly");

  const naturallyShutdown = (
    await Promise.all(udids.map((udid) => waitForShutdown(udid, 10_000)))
  ).filter(Boolean).length;
  let explicitlyShutdown = 0;
  for (const udid of udids) {
    const device = await lifecycle.findExact(udid);
    if (device?.state.toLowerCase() === "booted") {
      await lifecycle.shutdownExact(udid);
      explicitlyShutdown += 1;
    }
  }
  await Promise.all(udids.map((udid) => waitForShutdown(udid, 30_000)));
  for (const instanceId of instanceIds) await manager.stop(instanceId);

  const recovered: Array<{
    instance: number;
    udid: string;
    ready: boolean;
    accessibilityElements: number;
    frameBytes: number;
  }> = [];
  for (let index = 0; index < udids.length; index += 1) {
    const device = await lifecycle.bootExact(udids[index]!);
    const instance = await manager.start({
      instanceId: instanceIds[index]!,
      simulatorUdid: device.udid,
      runtimeIdentifier: device.runtimeIdentifier,
      xcodeBuild: environment.xcodeVersion ?? "unknown",
      architecture: process.arch === "x64" ? "x86_64" : "arm64",
    });
    const health = await instance.driver.probe();
    const accessibility = await instance.driver.getAccessibilityTree(
      instance.driverSessionId,
    );
    const screenMap = normalizeIOSSimulatorScreenMap({
      instanceId: instanceIds[index]!,
      generation: 1,
      interactionEpoch: 0,
      capturedAt: accessibility.capturedAt,
      tree: accessibility.tree,
    });
    const frameBytes = await readFirstFrame(instance.driver);
    if (!health.ready || frameBytes <= 0) {
      throw new Error(`Instance ${index + 1} did not recover`);
    }
    recovered.push({
      instance: index + 1,
      udid: device.udid,
      ready: health.ready,
      accessibilityElements: screenMap.elements.length,
      frameBytes,
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      count,
      runtime: runtime.identifier,
      naturallyShutdown,
      explicitlyShutdown,
      recovered,
    })}\n`,
  );
} finally {
  for (const instanceId of instanceIds)
    await manager.stop(instanceId).catch(() => undefined);
  for (const udid of udids) {
    await lifecycle.shutdownExact(udid).catch(() => undefined);
    await lifecycle.deleteExact(udid).catch(() => undefined);
  }
  for (const originalUdid of originallyBooted) {
    await lifecycle.bootExact(originalUdid).catch(() => undefined);
  }
}

async function waitForShutdown(
  udid: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const device = await lifecycle.findExact(udid);
    if (device?.state.toLowerCase() === "shutdown") return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForSimulatorProcess(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const process = await runner.run("/usr/bin/pgrep", ["-x", "Simulator"]);
    if (process.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Simulator.app did not become running");
}

async function readFirstFrame(
  driver: IOSSimulatorAutomationDriver,
): Promise<number> {
  const controller = new AbortController();
  let bytes = 0;
  const stats = await driver.streamFrames({
    signal: controller.signal,
    maxFrameBytes: 16 * 1024 * 1024,
    onFrame(frame) {
      bytes = frame.bytes.byteLength;
      controller.abort();
    },
  });
  if (stats.frameCount < 1) return 0;
  return bytes;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}
