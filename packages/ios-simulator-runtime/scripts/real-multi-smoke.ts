import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  WdaProcessManager,
  type IOSSimulatorStreamProfile,
  type IOSSimulatorStreamStats,
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
const count = boundedInteger(process.env.CINDY_IOS_SIMULATOR_COUNT, 4, 1, 4);
const durationMs = boundedInteger(
  process.env.CINDY_IOS_SIMULATOR_DURATION_MS,
  30_000,
  5_000,
  120_000,
);
const profile: IOSSimulatorStreamProfile = {
  framesPerSecond: boundedInteger(
    process.env.CINDY_IOS_SIMULATOR_FPS,
    5,
    1,
    20,
  ),
  jpegQuality: 25,
  scalingPercent: 50,
};

const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();
const environment = await createIOSSimulatorRuntime().inspect();
if (!environment.ready) {
  throw new Error(
    environment.error ?? environment.issue ?? "environment unavailable",
  );
}

const initiallyRunning =
  (await runner.run("/usr/bin/pgrep", ["-x", "Simulator"])).exitCode === 0;
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
      device.deviceTypeIdentifier,
  );
if (!runtime || !template?.deviceTypeIdentifier) {
  throw new Error("No compatible iOS runtime/device type");
}

const manager = new WdaProcessManager({ archivePath, cacheRoot });
const instanceIds = Array.from(
  { length: count },
  (_, index) => `real-multi-${index + 1}`,
);
const udids: string[] = [];

try {
  await mkdir(cacheRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const created = await lifecycle.createExact({
      name: `Cindy Multi Smoke ${Date.now()}-${index + 1}`,
      deviceTypeIdentifier: template.deviceTypeIdentifier,
      runtimeIdentifier: runtime.identifier,
    });
    udids.push(created.udid);
  }

  const devices = [];
  for (const udid of udids) devices.push(await lifecycle.bootExact(udid));
  const running = [];
  for (let index = 0; index < devices.length; index += 1) {
    running.push(
      await manager.start({
        instanceId: instanceIds[index]!,
        simulatorUdid: devices[index]!.udid,
        runtimeIdentifier: devices[index]!.runtimeIdentifier,
        xcodeBuild: environment.xcodeVersion ?? "unknown",
        architecture: process.arch === "x64" ? "x86_64" : "arm64",
      }),
    );
  }
  for (const instance of running) {
    await instance.driver.configureStream(instance.driverSessionId, profile);
  }

  const startedAt = Date.now();
  const controllers = running.map(() => new AbortController());
  const timer = setTimeout(
    () => controllers.forEach((controller) => controller.abort()),
    durationMs,
  );
  const stats = await Promise.all(
    running.map((instance, index) =>
      instance.driver.streamFrames({
        signal: controllers[index]!.signal,
        maxFrameBytes: 16 * 1024 * 1024,
        onFrame: () => undefined,
      }),
    ),
  );
  clearTimeout(timer);
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const results = stats.map((value, index) =>
    summarize(value, elapsedMs, index + 1),
  );
  if (results.some((result) => result.endReason !== "aborted")) {
    throw new Error(`A stream ended unexpectedly: ${JSON.stringify(results)}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      count,
      durationMs: elapsedMs,
      profile,
      runtime: runtime.identifier,
      results,
    })}\n`,
  );
} finally {
  for (const instanceId of instanceIds)
    await manager.stop(instanceId).catch(() => undefined);
  for (const udid of udids) {
    await lifecycle.shutdownExact(udid).catch(() => undefined);
    await lifecycle.deleteExact(udid).catch(() => undefined);
  }
  if (!initiallyRunning) {
    await runner
      .run(
        "/usr/bin/osascript",
        ["-e", 'tell application "Simulator" to quit'],
        {
          timeoutMs: 30_000,
        },
      )
      .catch(() => undefined);
    for (const udid of originallyBooted)
      await lifecycle.bootExact(udid).catch(() => undefined);
  }
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

function summarize(
  stats: IOSSimulatorStreamStats,
  elapsedMs: number,
  index: number,
) {
  const seconds = elapsedMs / 1_000;
  return {
    instance: index,
    frameCount: stats.frameCount,
    actualFps: Number((stats.frameCount / seconds).toFixed(2)),
    byteCount: stats.byteCount,
    bandwidthMiBPerSecond: Number(
      (stats.byteCount / seconds / 1024 / 1024).toFixed(3),
    ),
    firstFrameMs: stats.firstFrameAt
      ? Math.max(
          0,
          Date.parse(stats.firstFrameAt) - Date.parse(stats.startedAt),
        )
      : null,
    endReason: stats.endReason,
  };
}
