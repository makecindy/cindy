import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  IOSSimulatorFramePump,
  IOSSimulatorScreenMapStore,
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
const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "cindy-ios-runtime-smoke-"),
);
const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();
let udid: string | null = null;
let manager: WdaProcessManager | null = null;

try {
  const environment = await createIOSSimulatorRuntime().inspect();
  if (!environment.ready)
    throw new Error(
      environment.error ?? environment.issue ?? "environment unavailable",
    );
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
  if (requestedRuntime && !runtime) {
    throw new Error(
      `Requested iOS runtime is not available: ${requestedRuntime}`,
    );
  }
  const template =
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime?.identifier &&
        candidate.deviceTypeIdentifier?.includes("iPhone-17-Pro"),
    ) ??
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime?.identifier &&
        candidate.deviceTypeIdentifier,
    );
  if (!runtime || !template?.deviceTypeIdentifier)
    throw new Error("No compatible runtime/device type");

  const created = await lifecycle.createExact({
    name: `Cindy Runtime Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  udid = created.udid;
  const device = await lifecycle.bootExact(udid);
  await mkdir(cacheRoot, { recursive: true });
  manager = new WdaProcessManager({ archivePath, cacheRoot });
  const running = await manager.start({
    instanceId: "real-smoke",
    simulatorUdid: udid,
    runtimeIdentifier: device.runtimeIdentifier,
    xcodeBuild: environment.xcodeVersion ?? "unknown",
    architecture: process.arch === "x64" ? "x86_64" : "arm64",
  });
  const rotationApp = "com.apple.mobilesafari";
  const rotationLaunch = await runner.run(
    "/usr/bin/xcrun",
    ["simctl", "launch", udid, rotationApp],
    { timeoutMs: 30_000 },
  );
  const accessibility = await running.driver.getAccessibilityTree(
    running.driverSessionId,
  );
  const lowProfile = await running.driver.configureStream(
    running.driverSessionId,
    {
      framesPerSecond: 5,
      jpegQuality: 25,
      scalingPercent: 50,
    },
  );
  const viewportBefore = await running.driver.getWindowSize(
    running.driverSessionId,
  );
  let landscape: string | null = null;
  let orientationError: string | null = null;
  try {
    await running.driver.setOrientation("LANDSCAPE", running.driverSessionId);
    landscape = await running.driver.getOrientation(running.driverSessionId);
  } catch (error) {
    orientationError = error instanceof Error ? error.message : String(error);
  }
  await running.driver.lock(running.driverSessionId);
  await running.driver.unlock(running.driverSessionId);
  if (landscape) {
    await running.driver.setOrientation("PORTRAIT", running.driverSessionId);
  }
  const screenMap = new IOSSimulatorScreenMapStore().capture({
    instanceId: "real-smoke",
    generation: 1,
    capturedAt: accessibility.capturedAt,
    tree: accessibility.tree,
  });
  const pump = new IOSSimulatorFramePump({ maxReconnectAttempts: 1 });
  pump.setVisible({
    instanceId: "real-smoke",
    generation: 1,
    driver: running.driver,
    visible: true,
  });
  const deadline = Date.now() + 15_000;
  while (!pump.snapshot("real-smoke")?.latestFrame && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const frame = pump.snapshot("real-smoke")?.latestFrame;
  pump.clear("real-smoke");
  if (!frame) throw new Error("MJPEG did not produce a frame");

  const screenshotPath = path.join(tempRoot, "smoke.png");
  const screenshot = await runner.run(
    "/usr/bin/xcrun",
    ["simctl", "io", udid, "screenshot", "--type=png", screenshotPath],
    { timeoutMs: 30_000 },
  );
  if (screenshot.exitCode !== 0) throw new Error("simctl screenshot failed");
  const screenshotBytes = await readFile(screenshotPath);
  if (screenshotBytes.length < 8)
    throw new Error("simctl screenshot was empty");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      udid,
      runtime: runtime.identifier,
      accessibilityElements: screenMap.elements.length,
      streamProfile: lowProfile,
      viewportBefore,
      rotationApp,
      rotationLaunchExitCode: rotationLaunch.exitCode,
      landscape,
      orientationError,
      frameBytes: frame.bytes.byteLength,
      screenshotBytes: screenshotBytes.byteLength,
    })}\n`,
  );
} finally {
  if (manager) await manager.stop("real-smoke").catch(() => undefined);
  if (udid) {
    await lifecycle.shutdownExact(udid).catch(() => undefined);
    await lifecycle.deleteExact(udid).catch(() => undefined);
  }
  await rm(tempRoot, { recursive: true, force: true });
}
