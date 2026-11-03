import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

// The pinned @expo/cli patch owns discovery for both Expo and our scripts.
// Keep a single toolchain/path decision, including DEVELOPER_DIR overrides.
function expoViewer() {
  const root = dirname(require.resolve("@expo/cli/package.json"));
  return {
    ...require(
      join(root, "build/src/start/doctor/apple/SimulatorAppPrerequisite.js"),
    ),
    ...require(
      join(root, "build/src/start/platforms/ios/ensureSimulatorAppRunning.js"),
    ),
  };
}

export async function inspectSimulatorViewer({
  platform = process.platform,
  resolveApp = () => expoViewer().getSimulatorAppAsync(),
  run = (command, args) =>
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
} = {}) {
  if (platform !== "darwin")
    return {
      available: false,
      running: false,
      status: "unsupported",
      windowVerified: false,
    };
  try {
    const { appId, appPath } = await resolveApp();
    const processes = run("ps", ["-axo", "comm="]);
    // Xcode 27's CFBundleExecutable is DevicesTrampoline; the long-lived
    // process is DeviceHub. Match direct executables inside the selected app.
    const executableDirectory = join(appPath, "Contents/MacOS") + "/";
    const running = processes.split("\n").some((line) => {
      const command = line.trim();
      return (
        command.startsWith(executableDirectory) &&
        command.length > executableDirectory.length &&
        !command.slice(executableDirectory.length).includes("/")
      );
    });
    return {
      available: true,
      appId,
      appPath,
      running,
      status: running ? "running" : "stopped",
      windowVerified: false,
    };
  } catch (error) {
    return {
      available: false,
      running: false,
      status: "unavailable",
      error: error.message,
      windowVerified: false,
    };
  }
}

export async function openSimulatorViewer(
  udid,
  {
    inspect = inspectSimulatorViewer,
    open = (device) => expoViewer().openSimulatorAppAsync(device),
    wait = (ms) => delay(ms),
  } = {},
) {
  const before = await inspect();
  if (!before.available)
    throw new Error(
      before.error ?? "Simulator viewer requires macOS with Xcode.",
    );
  // Request the selected device even if the app is running. Legacy Simulator
  // may ignore its startup UDID then; visible-window acceptance remains separate.
  await open({ udid });
  for (let attempt = 0; attempt < 20; attempt++) {
    const viewer = await inspect();
    if (viewer.running) return viewer;
    await wait(250);
  }
  throw new Error(
    "Simulator viewer did not start; the window has not been verified.",
  );
}
