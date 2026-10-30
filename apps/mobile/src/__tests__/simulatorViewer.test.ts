import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  inspectSimulatorViewer,
  openSimulatorViewer,
} from "../../scripts/lib/simulator-viewer.mjs";

const require = createRequire(import.meta.url);
const cliRoot = dirname(require.resolve("@expo/cli/package.json"));
const apple = join(
  cliRoot,
  "build/src/start/doctor/apple/SimulatorAppPrerequisite.js",
);
const opener = join(
  cliRoot,
  "build/src/start/platforms/ios/ensureSimulatorAppRunning.js",
);

// Execute the installed pnpm patch, with no macOS interaction in tests. An
// unpatched install attempts @expo/osascript and fails the regression test.
function loadCli(file: string, mocks: Record<string, unknown>) {
  const exports = {} as any;
  runInNewContext(readFileSync(file, "utf8"), {
    exports,
    require: (name: string) => {
      if (name in mocks) return mocks[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return exports;
}

function discovery(
  apps: Record<string, string>,
  simctl = "/Xcode Beta.app/Contents/Developer/usr/bin/simctl",
) {
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === "xcrun") return { stdout: simctl };
    if (command === "defaults" && apps[args[1]])
      return { stdout: apps[args[1]] };
    throw new Error("Missing plist");
  });
  const api = loadCli(apple, {
    "@expo/spawn-async": run,
    "node:path": path,
    debug: () => () => {},
    "../../../log": {},
    "../Prerequisite": {
      Prerequisite: class {},
      PrerequisiteCommandError: Error,
    },
  });
  return { api, run };
}

describe("Expo simulator discovery never asks macOS to locate a missing app name", () => {
  it.each([
    ["../Applications/DeviceHub.app", "com.apple.dt.Devices"],
    ["Applications/Simulator.app", "com.apple.iphonesimulator"],
    [
      "Applications/Simulator.app",
      "com.apple.CoreSimulator.SimulatorTrampoline",
    ],
  ])("resolves %s inside the selected toolchain", async (relative, appId) => {
    const appPath = path.resolve(
      "/Xcode Beta.app/Contents/Developer",
      relative,
    );
    const { api, run } = discovery({
      [join(appPath, "Contents/Info.plist")]: appId,
    });
    expect(await api.getSimulatorAppAsync()).toEqual({ appId, appPath });
    expect(run.mock.calls[0]).toEqual(["xcrun", ["--find", "simctl"]]);
    expect(
      run.mock.calls.every(([cmd]) => cmd === "xcrun" || cmd === "defaults"),
    ).toBe(true);
  });
  it("fails without any interactive fallback when neither viewer exists", async () => {
    await expect(discovery({}).api.getSimulatorAppAsync()).rejects.toThrow();
  });
  it("rejects an unexpected app identity", async () => {
    const { api } = discovery({
      "/Xcode Beta.app/Contents/Applications/DeviceHub.app/Contents/Info.plist":
        "unknown.app",
    });
    await expect(api.getSimulatorAppAsync()).rejects.toThrow();
  });
  it.each([
    ["com.apple.dt.Devices", ["devices://device/open?id=selected-device"]],
    [
      "com.apple.iphonesimulator",
      ["--args", "-CurrentDeviceUDID", "selected-device"],
    ],
  ])(
    "opens %s by resolved path and propagates launch failure",
    async (appId, tail) => {
      const run = vi.fn(async () => ({}));
      const api = loadCli(opener, {
        "@expo/spawn-async": run,
        "../../../log": {},
        "../../../utils/delay": {},
        "../../../utils/errors": {},
        "../../doctor/apple/SimulatorAppPrerequisite": {
          getSimulatorAppAsync: async () => ({
            appId,
            appPath: "/Selected Xcode/Viewer.app",
          }),
        },
      });
      await api.openSimulatorAppAsync({ udid: "selected-device" });
      expect(run).toHaveBeenCalledWith("open", [
        "-a",
        "/Selected Xcode/Viewer.app",
        ...tail,
      ]);
      run.mockRejectedValueOnce(new Error("Launch failed"));
      await expect(
        api.openSimulatorAppAsync({ udid: "selected-device" }),
      ).rejects.toThrow("Launch failed");
    },
  );
});

describe("external viewer acceptance", () => {
  const app = {
    appId: "com.apple.dt.Devices",
    appPath: "/Selected Xcode/DeviceHub.app",
  };
  it("requires the selected executable, not another Xcode process with the same name", async () => {
    const run = vi.fn((command: string): string =>
      command === "ps"
        ? "/Other Xcode/DeviceHub.app/Contents/MacOS/DeviceHub\n"
        : "DeviceHub",
    );
    const options = {
      platform: "darwin" as const,
      resolveApp: async () => app,
      run,
    };
    expect(await inspectSimulatorViewer(options)).toMatchObject({
      available: true,
      running: false,
      windowVerified: false,
    });
    run.mockImplementation((command: string) =>
      command === "ps"
        ? `${join(app.appPath, "Contents/MacOS")}/DeviceHub\n`
        : "DeviceHub",
    );
    expect(await inspectSimulatorViewer(options)).toMatchObject({
      running: true,
      windowVerified: false,
    });
  });
  it("does not probe macOS apps on other platforms", async () => {
    const resolveApp = vi.fn();
    expect(
      await inspectSimulatorViewer({ platform: "win32", resolveApp }),
    ).toMatchObject({ status: "unsupported" });
    expect(resolveApp).not.toHaveBeenCalled();
  });
  it("does not open an unavailable viewer", async () => {
    const open = vi.fn();
    await expect(
      openSimulatorViewer("device", {
        inspect: async () => ({
          available: false,
          running: false,
          status: "unavailable",
          windowVerified: false,
          error: "Missing app",
        }),
        open,
      }),
    ).rejects.toThrow("Missing app");
    expect(open).not.toHaveBeenCalled();
  });
  it("requests the selected device and keeps visible-window verification separate", async () => {
    const open = vi.fn();
    const inspect = vi.fn().mockResolvedValue({
      available: true,
      running: true,
      windowVerified: false,
    });
    expect(
      await openSimulatorViewer("device", { inspect, open }),
    ).toMatchObject({ windowVerified: false });
    expect(open).toHaveBeenCalledWith({ udid: "device" });
  });
  it("fails when an accepted launch never produces a viewer process", async () => {
    await expect(
      openSimulatorViewer("device", {
        inspect: async () => ({
          available: true,
          running: false,
          status: "stopped",
          windowVerified: false,
          ...app,
        }),
        open: async () => {},
        wait: async () => {},
      }),
    ).rejects.toThrow("did not start");
  });
});
