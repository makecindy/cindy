import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
} from "../src/index.js";

const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();
let udid: string | null = null;

try {
  const environment = await createIOSSimulatorRuntime().inspect();
  if (!environment.ready) {
    throw new Error(
      environment.error ?? environment.issue ?? "environment unavailable",
    );
  }
  const runtime = environment.runtimes.find(
    (candidate) =>
      candidate.isAvailable && candidate.identifier.includes(".iOS-"),
  );
  const template = environment.devices.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.runtimeIdentifier === runtime?.identifier &&
      candidate.deviceTypeIdentifier,
  );
  if (!runtime || !template?.deviceTypeIdentifier) {
    throw new Error("No compatible iOS runtime/device type");
  }

  const created = await lifecycle.createExact({
    name: `Cindy Device Controls Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  udid = created.udid;
  await lifecycle.bootExact(udid);

  await lifecycle.setAppearance?.(udid, "dark");
  const appearance = await runner.run("/usr/bin/xcrun", [
    "simctl",
    "ui",
    udid,
    "appearance",
  ]);
  if (appearance.exitCode !== 0 || appearance.stdout.trim() !== "dark") {
    throw new Error(
      `appearance verification failed: ${appearance.stdout.trim()}`,
    );
  }
  await lifecycle.setAppearance?.(udid, "light");
  await lifecycle.setIncreaseContrast?.(udid, true);
  const increaseContrast = await runner.run("/usr/bin/xcrun", [
    "simctl",
    "ui",
    udid,
    "increase_contrast",
  ]);
  if (
    increaseContrast.exitCode !== 0 ||
    increaseContrast.stdout.trim() !== "enabled"
  ) {
    throw new Error(
      `increase-contrast verification failed: ${increaseContrast.stdout.trim()}`,
    );
  }
  await lifecycle.setContentSize?.(udid, "accessibility-extra-large");
  const contentSize = await runner.run("/usr/bin/xcrun", [
    "simctl",
    "ui",
    udid,
    "content_size",
  ]);
  if (
    contentSize.exitCode !== 0 ||
    contentSize.stdout.trim() !== "accessibility-extra-large"
  ) {
    throw new Error(
      `content-size verification failed: ${contentSize.stdout.trim()}`,
    );
  }
  await lifecycle.setLocation?.(udid, 31.2304, 121.4737);
  await lifecycle.startLocationRoute?.(udid, {
    waypoints: [
      { latitude: 31.2304, longitude: 121.4737 },
      { latitude: 31.233, longitude: 121.48 },
    ],
    speedMetersPerSecond: 8,
    intervalSeconds: 1,
  });
  await lifecycle.clearLocation?.(udid);
  await lifecycle.setPrivacy?.(
    udid,
    "grant",
    "photos",
    "com.apple.mobilesafari",
  );
  await lifecycle.setPrivacy?.(
    udid,
    "revoke",
    "photos",
    "com.apple.mobilesafari",
  );
  await lifecycle.setPrivacy?.(udid, "reset", "all");
  await lifecycle.setStatusBar?.(udid, {
    time: "9:41",
    wifiBars: 3,
    batteryLevel: 100,
  });
  const statusBar = await runner.run("/usr/bin/xcrun", [
    "simctl",
    "status_bar",
    udid,
    "list",
  ]);
  if (statusBar.exitCode !== 0 || !statusBar.stdout.includes("9:41")) {
    throw new Error(
      `status-bar verification failed: ${statusBar.stdout.trim()}`,
    );
  }
  await lifecycle.clearStatusBar?.(udid);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      udid,
      runtime: runtime.identifier,
      appearance: appearance.stdout.trim(),
      increaseContrast: increaseContrast.stdout.trim(),
      contentSize: contentSize.stdout.trim(),
      location: "set-clear",
      locationRoute: "two-waypoint-start-clear",
      privacy: "grant-revoke-reset",
      statusBar: "override-clear",
    })}\n`,
  );
} finally {
  if (udid) {
    await lifecycle.shutdownExact(udid).catch(() => undefined);
    await lifecycle.deleteExact(udid).catch(() => undefined);
  }
}
