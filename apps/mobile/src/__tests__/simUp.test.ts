import { describe, expect, it, vi } from "vitest";
import {
  extractSimUpArgs,
  metroPortOfJsLocation,
  planSimUpMetro,
  runSimUp,
  selectSimUpDevice,
} from "../../scripts/lib/sim-up.mjs";

const bundleId = "com.xd.cindy";
const cindy = { name: "cindy", path: "/set" };
const iPhone = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro";
const device = (
  udid: string,
  state: string,
  extra: Record<string, unknown> = {},
) => ({
  udid,
  name: udid,
  state,
  isAvailable: true,
  deviceTypeIdentifier: iPhone,
  ...extra,
});
const metro = (
  port: number,
  code: string,
  worktree = "/repo",
  isMetro = true,
) => ({
  port,
  pid: port,
  worktree,
  isMetro,
  identity: { healthy: code === "target-fresh", code },
});
const matched = {
  healthy: true,
  source: "src",
  native: { healthy: true, code: "native-matched" },
};

function setup(overrides: Record<string, unknown> = {}) {
  return {
    log: vi.fn(),
    listDevices: vi.fn(() => [device("A", "Shutdown")]),
    hasApp: vi.fn(() => true),
    readJsLocation: vi.fn(() => null),
    isPortListening: vi.fn(() => false),
    setJsLocation: vi.fn(),
    boot: vi.fn(async () => {}),
    launch: vi.fn(),
    activate: vi.fn(),
    appVisibility: vi.fn(() => "visible"),
    now: () => 0,
    sleep: vi.fn(async () => {}),
    metroState: vi.fn(() => ({
      healthy: true,
      probeErrors: [],
      metros: [],
      busyPorts: [],
    })),
    worktreeExists: vi.fn(() => true),
    stopMetro: vi.fn(async () => true),
    startMetro: vi.fn(async () => {}),
    metroLogPath: (port: number) => `/logs/metro-${port}.log`,
    logSize: () => 0,
    waitForBundle: vi.fn(async () => ({ status: "bundled" })),
    whoami: vi.fn(() => matched),
    rebuild: vi.fn(async () => ({
      status: 0,
      output: "",
      logPath: "/logs/rebuild.log",
    })),
    ...overrides,
  };
}

const up = (
  deps: ReturnType<typeof setup>,
  options: Record<string, unknown> = {},
) =>
  runSimUp(
    {
      region: "global",
      mock: true,
      bundleId,
      worktreeRoot: "/repo",
      deviceSets: [cindy],
      simulatorUdid: null,
      deviceName: null,
      takeover: false,
      explicitPort: null,
      ...options,
    },
    deps,
  );

describe("mobile:sim:up flow", () => {
  // Regression 2026-11-03: agents had to chain boot, start, rebuild and whoami themselves and
  // repeatedly reported the phone app as unbuildable after one of those steps failed.
  it("takes a shut-down device all the way to a verified launch", async () => {
    const deps = setup();
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      code: "READY",
      udid: "A",
      port: 8081,
      native: "reused",
      bundleVerified: true,
      pageVerified: false,
    });
    expect(deps.boot).toHaveBeenCalledWith(cindy, "A");
    expect(deps.startMetro).toHaveBeenCalledWith({
      port: 8081,
      takeover: false,
    });
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it("reuses everything on a second run", async () => {
    const deps = setup({
      listDevices: vi.fn(() => [device("A", "Booted")]),
      metroState: vi.fn(() => ({
        healthy: true,
        probeErrors: [],
        metros: [metro(8081, "target-fresh")],
        busyPorts: [8081],
      })),
    });
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      udid: "A",
      port: 8081,
      native: "reused",
    });
    expect(deps.boot).not.toHaveBeenCalled();
    expect(deps.startMetro).not.toHaveBeenCalled();
  });

  it("leaves a foreign 8081 running and points the device at its own port", async () => {
    const deps = setup({
      metroState: vi.fn(() => ({
        healthy: true,
        probeErrors: [],
        metros: [metro(8081, "occupied-foreign", "/other")],
        busyPorts: [8081],
      })),
    });
    await expect(up(deps)).resolves.toMatchObject({ ok: true, port: 8082 });
    expect(deps.startMetro).toHaveBeenCalledWith({
      port: 8082,
      takeover: false,
    });
    expect(deps.setJsLocation).toHaveBeenCalledWith(cindy, "A", bundleId, 8082);
  });

  // Regression 2026-11-03: right after boot `simctl launch` succeeded but the app stayed in the
  // background on the home screen and never requested a bundle.
  it("relaunches when the app does not load after launch", async () => {
    const waitForBundle = vi
      .fn()
      .mockResolvedValueOnce({ status: "timeout" })
      .mockResolvedValueOnce({ status: "bundled" });
    const deps = setup({ waitForBundle });
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      bundleVerified: true,
    });
    expect(deps.launch).toHaveBeenCalledTimes(2);
  });

  // Regression 2026-11-03: right after boot calaccessd opened Calendar and the loaded app ended
  // up behind the home screen while the run still reported success.
  it("brings the app back when it is not in front", async () => {
    const appVisibility = vi
      .fn()
      .mockReturnValueOnce("hidden")
      .mockReturnValue("visible");
    const deps = setup({ appVisibility });
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      foreground: true,
    });
    expect(deps.activate).toHaveBeenCalledTimes(1);
    // Freshly booted: the first check waits for the boot to settle.
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 20_000);
  });

  it("fails instead of reporting success while the app stays behind", async () => {
    const deps = setup({ appVisibility: vi.fn(() => "hidden") });
    await expect(up(deps)).rejects.toMatchObject({
      code: "APP_NOT_FOREGROUND",
    });
    expect(deps.activate).toHaveBeenCalledTimes(2);
  });

  it("leaves foreground unconfirmed when the device log has no state", async () => {
    const deps = setup({
      appVisibility: vi.fn(() => "unknown"),
      listDevices: vi.fn(() => [device("A", "Booted")]),
    });
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      foreground: null,
    });
    expect(deps.sleep).toHaveBeenCalledWith(3_000);
  });

  it("fails when a Metro it started never serves the app", async () => {
    const deps = setup({
      waitForBundle: vi.fn(async () => ({ status: "timeout" })),
    });
    await expect(up(deps)).rejects.toMatchObject({
      code: "BUNDLE_NOT_SEEN",
      step: "launch",
    });
    expect(deps.launch).toHaveBeenCalledTimes(3);
  });

  // Metros started before sim-start recorded a log, or whose log could not be created.
  it("reports the bundle as unconfirmed when the Metro has no log", async () => {
    const deps = setup({ metroLogPath: () => null });
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      bundleVerified: false,
      metroLog: null,
    });
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.waitForBundle).not.toHaveBeenCalled();
  });

  it("fails when a reused Metro with a log never serves the app", async () => {
    const deps = setup({
      waitForBundle: vi.fn(async () => ({ status: "timeout" })),
      metroState: vi.fn(() => ({
        healthy: true,
        probeErrors: [],
        metros: [metro(8081, "target-fresh")],
        busyPorts: [8081],
      })),
    });
    await expect(up(deps)).rejects.toMatchObject({ code: "BUNDLE_NOT_SEEN" });
  });

  it("points the log check at the port it used", async () => {
    const deps = setup({
      metroState: vi.fn(() => ({
        healthy: true,
        probeErrors: [],
        metros: [metro(8081, "occupied-foreign", "/other")],
        busyPorts: [8081],
      })),
    });
    await expect(up(deps)).resolves.toMatchObject({
      next: expect.stringContaining("pnpm mobile:sim:logcheck -- --port 8082"),
    });
    await expect(up(setup())).resolves.toMatchObject({
      next: expect.not.stringContaining("--port"),
    });
  });

  it("reports a failed bundle instead of retrying", async () => {
    const deps = setup({
      waitForBundle: vi.fn(async () => ({
        status: "failed",
        line: "iOS Bundling failed",
      })),
    });
    await expect(up(deps)).rejects.toMatchObject({
      code: "BUNDLE_FAILED",
      message: "iOS Bundling failed",
    });
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { healthy: false, code: 'native-mismatch' },
    { healthy: false, code: 'native-unknown', reason: 'installed-fingerprint-missing' },
  ])("rebuilds an incompatible or fingerprint-less app and checks its installed identity: %j", async (native) => {
    const whoami = vi
      .fn()
      .mockReturnValueOnce({
        healthy: false,
        native,
      })
      .mockReturnValue(matched);
    // With a parallel port rebuild installs, then exits nonzero with "launch blocked".
    const deps = setup({
      whoami,
      rebuild: vi.fn(async () => ({
        status: 1,
        output: "launch blocked",
        logPath: "/l",
      })),
    });
    await expect(up(deps)).resolves.toMatchObject({
      ok: true,
      native: "rebuilt",
    });
    expect(deps.rebuild).toHaveBeenCalledWith({ udid: "A" });
  });

  it("names the missing build tool when rebuild cannot start", async () => {
    const deps = setup({
      whoami: vi.fn(() => ({
        healthy: false,
        native: { healthy: false, code: "native-missing" },
      })),
      rebuild: vi.fn(async () => ({
        status: 1,
        output: "✗ IOS_BUILD_TOOLS_UNAVAILABLE: pod=missing",
        logPath: "/l",
      })),
    });
    await expect(up(deps)).rejects.toMatchObject({
      code: "IOS_BUILD_TOOLS_UNAVAILABLE",
      step: "native",
    });
  });

  // #9422 review: whoami's installed-read failures must also stop the default
  // up workflow before rebuilding. Existing probe cases missed these reasons
  // (unit: runSimUp with injected process boundaries, no devices or waits).
  it.each([
    "probe-timeout",
    "target-not-unique",
    "native-fingerprint-timeout",
    "native-fingerprint-unavailable",
    "installed-fingerprint-timeout",
    "installed-fingerprint-unreadable",
  ])(
    "does not treat a failed native check as a missing app: %s",
    async (reason) => {
      const deps = setup({
        whoami: vi.fn(() => ({
          healthy: false,
          native: { healthy: false, code: "native-unknown", reason },
        })),
      });
      await expect(up(deps)).rejects.toMatchObject({
        code: "NATIVE_PROBE_FAILED",
      });
      expect(deps.rebuild).not.toHaveBeenCalled();
    },
  );

  it("does not read a failed port probe as free ports", async () => {
    const deps = setup({
      metroState: vi.fn(() => ({
        healthy: false,
        probeErrors: [{ code: "METRO_LISTENERS_TIMEOUT" }],
        metros: [],
        busyPorts: [],
      })),
    });
    await expect(up(deps)).rejects.toMatchObject({
      code: "METRO_PROBE_FAILED",
    });
    expect(deps.boot).not.toHaveBeenCalled();
  });

  it("never claims success when the final identity check fails", async () => {
    const whoami = vi
      .fn()
      .mockReturnValueOnce(matched)
      .mockReturnValue({ healthy: false, native: matched.native });
    await expect(up(setup({ whoami }))).rejects.toMatchObject({
      code: "IDENTITY_FAILED",
      step: "verify",
    });
  });

  it("asks for a new device instead of creating one", async () => {
    const deps = setup({ hasApp: vi.fn(() => false) });
    await expect(up(deps)).rejects.toMatchObject({
      code: "NO_REUSABLE_DEVICE",
      next: expect.stringContaining("cindy-simulator"),
    });
    expect(deps.boot).not.toHaveBeenCalled();
  });

  it("lists the candidates when it cannot choose a device", async () => {
    const deps = setup({
      listDevices: vi.fn(() => [
        device("A", "Shutdown"),
        device("B", "Shutdown"),
      ]),
    });
    await expect(up(deps)).rejects.toMatchObject({
      code: "DEVICE_CHOICE_NEEDED",
      next: expect.stringContaining("--device"),
      detail: { choices: [{ udid: "A" }, { udid: "B" }] },
    });
    expect(deps.boot).not.toHaveBeenCalled();
  });

  it("rejects an exact UDID that no device set knows", async () => {
    await expect(up(setup(), { simulatorUdid: "NOPE" })).rejects.toMatchObject({
      code: "UNKNOWN_DEVICE",
    });
  });
});

describe("selectSimUpDevice", () => {
  const select = (
    devices: ReturnType<typeof device>[],
    options: Record<string, unknown> = {},
  ) =>
    selectSimUpDevice(devices, {
      bundleId,
      metros: [],
      deviceName: null,
      hasApp: () => true,
      readJsLocation: () => null,
      isPortListening: () => false,
      ...options,
    });

  it("prefers the booted device already on this worktree", () => {
    const devices = [
      device("OTHER", "Booted"),
      device("MINE", "Booted"),
      device("IDLE", "Shutdown"),
    ];
    expect(
      select(devices, {
        metros: [
          metro(8081, "occupied-foreign", "/other"),
          metro(8082, "target-fresh"),
        ],
        readJsLocation: (candidate: { udid: string }) =>
          candidate.udid === "MINE" ? "localhost:8082" : null,
      }).device?.udid,
    ).toBe("MINE");
  });

  it("uses the only free device, skipping ones serving another worktree or another project", () => {
    const devices = [
      device("BUSY", "Booted"),
      device("GAME", "Booted"),
      device("EMPTY", "Shutdown"),
      device("IDLE", "Shutdown"),
    ];
    expect(
      select(devices, {
        metros: [metro(8081, "occupied-foreign", "/other")],
        hasApp: (candidate: { udid: string }) =>
          !["GAME", "EMPTY"].includes(candidate.udid),
      }).device?.udid,
    ).toBe("IDLE");
  });

  // Review of #8738: a device pointed at a port outside the scanned 8081-8086 range
  // looked idle, so a lone candidate would have been repointed and relaunched.
  it("treats a device on an unscanned port with a listener as busy", () => {
    const devices = [device("BUSY", "Booted"), device("IDLE", "Shutdown")];
    const isPortListening = vi.fn((port: number) => port === 8100);
    const result = select(devices, {
      readJsLocation: (candidate: { udid: string }) =>
        candidate.udid === "BUSY" ? "localhost:8100" : null,
      isPortListening,
    });
    expect(result.device?.udid).toBe("IDLE");
    expect(isPortListening).toHaveBeenCalledWith(8100);
  });

  it("uses a booted device whose port has no listener", () => {
    expect(
      select([device("A", "Booted")], {
        readJsLocation: () => "localhost:8100",
      }).device?.udid,
    ).toBe("A");
  });

  // Regression 2026-11-04: picking the most recently used device took another project's
  // simulator, used by that project's task the same morning.
  it("asks instead of guessing between several devices", () => {
    const result = select([
      device("OLD", "Shutdown", { lastUsedAt: "2026-10-01T00:00:00Z" }),
      device("NEW", "Shutdown", { lastUsedAt: "2026-11-04T00:00:00Z" }),
    ]);
    expect(result.device).toBeNull();
    expect(result.choices.map((candidate) => candidate.udid)).toEqual([
      "OLD",
      "NEW",
    ]);
  });

  it("ignores iPads and unavailable devices", () => {
    expect(
      select([
        device("PAD", "Shutdown", {
          deviceTypeIdentifier:
            "com.apple.CoreSimulator.SimDeviceType.iPad-Pro",
        }),
        device("GONE", "Shutdown", { isAvailable: false }),
      ]),
    ).toEqual({ device: null, choices: [] });
  });

  it("honours a named device even before the app is installed", () => {
    const devices = [
      device("A", "Shutdown"),
      { ...device("B", "Shutdown"), name: "iPhone Air" },
    ];
    expect(
      select(devices, { deviceName: "iPhone Air", hasApp: () => false }).device
        ?.udid,
    ).toBe("B");
    expect(select(devices, { deviceName: "Missing" }).device).toBeNull();
  });
});

describe("planSimUpMetro", () => {
  const plan = (input: Record<string, unknown>) =>
    planSimUpMetro({
      metros: [],
      busyPorts: [],
      explicitPort: null,
      takeover: false,
      worktreeExists: () => true,
      ...input,
    });

  it("reuses a fresh Metro of this worktree on any port", () => {
    expect(
      plan({ metros: [metro(8083, "target-fresh")], busyPorts: [8083] }),
    ).toMatchObject({ action: "reuse", port: 8083 });
  });

  it("restarts only its own stale Metro", () => {
    expect(
      plan({ metros: [metro(8081, "target-stale")], busyPorts: [8081] }),
    ).toEqual({ action: "start", port: 8081, takeover: true });
    expect(
      plan({ metros: [metro(8082, "target-env-stale")], busyPorts: [8082] }),
    ).toMatchObject({ action: "restart-own", port: 8082 });
  });

  it("takes over an orphan 8081 but needs permission for a live worktree", () => {
    const metros = [metro(8081, "occupied-foreign", "/gone")];
    expect(
      plan({ metros, busyPorts: [8081], worktreeExists: () => false }),
    ).toEqual({ action: "start", port: 8081, takeover: true });
    expect(plan({ metros, busyPorts: [8081] })).toEqual({
      action: "start",
      port: 8082,
      takeover: false,
    });
    expect(plan({ metros, busyPorts: [8081], takeover: true })).toEqual({
      action: "start",
      port: 8081,
      takeover: true,
    });
  });

  it("never takes over an unknown process", () => {
    expect(plan({ busyPorts: [8081], takeover: true })).toEqual({
      action: "start",
      port: 8082,
      takeover: false,
    });
  });

  it("stays on an explicit port and reports when nothing is free", () => {
    expect(plan({ explicitPort: 8085 })).toEqual({
      action: "start",
      port: 8085,
      takeover: false,
    });
    expect(plan({ explicitPort: 8085, busyPorts: [8085] })).toBeNull();
    expect(
      plan({ busyPorts: [8081, 8082, 8083, 8084, 8085, 8086] }),
    ).toBeNull();
  });
});

describe("sim-up arguments", () => {
  it("extracts its own options and leaves the shared ones", () => {
    expect(
      extractSimUpArgs([
        "--takeover",
        "--device",
        "iPhone Air",
        "--port",
        "8082",
      ]),
    ).toEqual({
      takeover: true,
      deviceName: "iPhone Air",
      passthrough: ["--port", "8082"],
    });
    expect(extractSimUpArgs(["--device=iPhone Air"]).deviceName).toBe(
      "iPhone Air",
    );
    expect(() => extractSimUpArgs(["--device"])).toThrow("--device");
  });

  it("falls back to 8081 when the device has no Metro location", () => {
    expect(metroPortOfJsLocation(null)).toBe(8081);
    expect(metroPortOfJsLocation("localhost:8083")).toBe(8083);
  });
});
