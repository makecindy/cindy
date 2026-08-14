import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
} from "../capability-admission.js";
import type {
  IOSSimulatorAutomationDriver,
  IOSSimulatorNativeSidecarDriver,
} from "../driver.js";
import type { IOSSimulatorNativeSidecarStartOptions } from "../native-sidecar/process-manager.js";
import type { IOSSimulatorCommandRunner } from "../types.js";
import { WdaError } from "./errors.js";
import {
  createWdaOwnerFingerprint,
  findCindyWdaDiagnosticCandidates,
  findCindyWdaOrphanProcessGroups,
  findCindyWdaRunnerCandidates,
  hasConflictingWdaController,
  matchesCindyWdaDiagnosticCommand,
  matchesCindyWdaRunnerEnvironment,
  matchesLegacyCindyWdaRunnerEnvironment,
  WdaProcessManager,
  type WdaManagedProcess,
  type WdaOrphanProcessCleaner,
  type WdaProcessManagerOptions,
} from "./process-manager.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";
const roots: string[] = [];

interface HarnessOptions {
  startTimeoutMs?: number;
  leaderExitsOn?: readonly NodeJS.Signals[];
  groupExitsOn?: readonly NodeJS.Signals[];
  orphanProcessCleaner?: WdaOrphanProcessCleaner;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createHarness(
  nativeCapabilityProvider?: WdaProcessManagerOptions["nativeCapabilityProvider"],
  harnessOptions: HarnessOptions = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cindy-wda-manager-test-"));
  roots.push(root);
  const archivePath = path.join(root, "wda.tar.gz");
  const archive = Buffer.from("archive");
  await writeFile(archivePath, archive);
  const manifest = {
    tag: "v-test",
    revision: "a".repeat(40),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
  };
  const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
    async (_command, args) => {
      if (args.includes("-xzf")) {
        const destination = args[args.indexOf("-C") + 1]!;
        await mkdir(path.join(destination, "WebDriverAgent.xcodeproj"), {
          recursive: true,
        });
        await writeFile(
          path.join(destination, "WebDriverAgent.xcodeproj", "project.pbxproj"),
          "project",
        );
      }
      return { stdout: "build output", stderr: "", exitCode: 0 };
    },
  );
  let exitProcess:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  let leaderExited = false;
  let groupAlive = true;
  const killed: NodeJS.Signals[] = [];
  const settleLeader = (signal: NodeJS.Signals | null) => {
    if (leaderExited) return;
    leaderExited = true;
    exitProcess?.({ code: signal ? null : 0, signal });
  };
  const exitGroup = (signal: NodeJS.Signals | null = null) => {
    groupAlive = false;
    settleLeader(signal);
  };
  const process: WdaManagedProcess = {
    pid: 42,
    exited: new Promise((resolve) => {
      exitProcess = resolve;
    }),
    isAlive: vi.fn(() => groupAlive),
    kill: vi.fn((signal) => {
      killed.push(signal);
      if (harnessOptions.leaderExitsOn?.includes(signal)) {
        settleLeader(signal);
      }
      if (
        harnessOptions.groupExitsOn === undefined ||
        harnessOptions.groupExitsOn.includes(signal)
      ) {
        exitGroup(signal);
      }
    }),
    onOutput: vi.fn(() => () => undefined),
  };
  let probeCount = 0;
  const driver = {
    kind: "wda" as const,
    probe: vi.fn(async () => {
      probeCount += 1;
      if (probeCount === 1) throw new Error("not ready");
      return {
        ready: true,
        message: null,
        osName: "iOS",
        osVersion: "26.4",
        sdkVersion: "26.4",
        deviceIp: null,
      };
    }),
    createSession: vi.fn(async () => ({
      id: "wda-session",
      capabilities: {},
      createdAt: new Date(0).toISOString(),
    })),
    configureStream: vi.fn(async (_sessionId, profile) => profile),
    deleteSession: vi.fn(async () => undefined),
  };
  let now = 1_000;
  const ports = [18_100, 19_100, 18_101, 19_101];
  const launch = vi.fn(() => process);
  const orphanProcessCleaner = vi.fn<WdaOrphanProcessCleaner>(
    harnessOptions.orphanProcessCleaner ?? (async () => undefined),
  );
  const manager = new WdaProcessManager({
    archivePath,
    cacheRoot: path.join(root, "cache"),
    sourceManifest: manifest,
    commandRunner: { run },
    processLauncher: { launch },
    allocatePort: vi.fn(async () => ports.shift()!),
    createDriver: vi.fn(
      () => driver as unknown as IOSSimulatorAutomationDriver,
    ),
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    nativeCapabilityProvider,
    orphanProcessCleaner,
    startTimeoutMs: harnessOptions.startTimeoutMs,
  });
  return {
    root,
    manager,
    run,
    driver,
    process,
    killed,
    launch,
    orphanProcessCleaner,
    exitGroup,
    exitLeader: settleLeader,
  };
}

describe("WDA orphan ownership matching", () => {
  const cacheRoot =
    "/Users/test/Library/Application Support/Cindy Test/ios-simulator/wda";
  const coreSimulatorRoot = "/Users/test/Library/Developer/CoreSimulator";
  const xcodebuild =
    "/Applications/Xcode Test.app/Contents/Developer/usr/bin/xcodebuild";
  const ownerFingerprint = createWdaOwnerFingerprint(
    cacheRoot,
    "instance-a",
    UDID,
  );
  const input = {
    cacheRoot,
    instanceId: "instance-a",
    simulatorUdid: UDID,
    ownerFingerprint,
    coreSimulatorRoot,
    xcodebuildExecutablePaths: [xcodebuild],
  };
  const project = `${cacheRoot}/source/${"a".repeat(40)}/WebDriverAgent.xcodeproj`;
  const derived = `${cacheRoot}/derived/${"b".repeat(64)}`;
  const command =
    `${xcodebuild} -quiet -project ${project}` +
    ` -scheme WebDriverAgentRunner` +
    ` -destination platform=iOS Simulator,id=${UDID},arch=arm64` +
    ` -derivedDataPath ${derived} test-without-building` +
    ` CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO`;

  it("binds the owner fingerprint to profile, instance, and exact simulator", () => {
    expect(ownerFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createWdaOwnerFingerprint(cacheRoot, "instance-a", UDID.toLowerCase()),
    ).toBe(ownerFingerprint);
    expect(
      createWdaOwnerFingerprint(`${cacheRoot}-other`, "instance-a", UDID),
    ).not.toBe(ownerFingerprint);
    expect(createWdaOwnerFingerprint(cacheRoot, "instance-b", UDID)).not.toBe(
      ownerFingerprint,
    );
  });

  it("matches only an exact controller argv and keeps legacy ownership narrow", () => {
    const tagged =
      `${command} CINDY_WDA_OWNER_FINGERPRINT=${ownerFingerprint}` +
      ` UPGRADE_TIMESTAMP=${ownerFingerprint}`;
    expect(findCindyWdaOrphanProcessGroups(`420 420 ${tagged}`, input)).toEqual(
      [420],
    );
    expect(
      findCindyWdaOrphanProcessGroups(`421 421 ${command}`, input),
    ).toEqual([421]);

    const wrong = "c".repeat(64);
    const rejected = [
      `${tagged} EXTRA=1`,
      `${command} CINDY_WDA_OWNER_FINGERPRINT=${ownerFingerprint}suffix UPGRADE_TIMESTAMP=${ownerFingerprint}`,
      `${command} CINDY_WDA_OWNER_FINGERPRINT=${wrong} UPGRADE_TIMESTAMP=${wrong}`,
      command.replace("test-without-building", "not-test-without-building"),
      command.replace(`/source/${"a".repeat(40)}/`, "/source/../source/"),
      command.replace(xcodebuild, "/tmp/xcodebuild"),
      command.replace(UDID, "2A9D41E0-E031-4AD0-A8B5-847480802E8E"),
    ];
    for (const [index, candidate] of rejected.entries()) {
      expect(
        findCindyWdaOrphanProcessGroups(
          `${500 + index} ${500 + index} ${candidate}`,
          input,
        ),
      ).toEqual([]);
    }
    expect(findCindyWdaOrphanProcessGroups(`600 601 ${tagged}`, input)).toEqual(
      [],
    );
  });

  it("blocks an unowned same-device WDA controller without granting kill authority", () => {
    const external =
      `${xcodebuild} -quiet -project /tmp/ExternalAgent/WebDriverAgent.xcodeproj` +
      ` -destination platform=iOS Simulator,id=${UDID},arch=arm64` +
      ` -scheme WebDriverAgentRunner test-without-building`;
    expect(hasConflictingWdaController(`650 650 ${external}`, input)).toBe(
      true,
    );
    expect(
      findCindyWdaOrphanProcessGroups(`650 650 ${external}`, input),
    ).toEqual([]);
    expect(
      hasConflictingWdaController(
        `651 651 ${external.replace(UDID, "2A9D41E0-E031-4AD0-A8B5-847480802E8E")}`,
        input,
      ),
    ).toBe(false);
    expect(
      hasConflictingWdaController(
        `652 652 ${external.replace("WebDriverAgentRunner", "UserApp")}`,
        input,
      ),
    ).toBe(false);

    const otherXcode =
      "/Applications/Xcode Beta.app/Contents/Developer/usr/bin/xcodebuild";
    const otherXcodeCommand = external.replace(xcodebuild, otherXcode);
    expect(
      hasConflictingWdaController(`653 653 ${otherXcodeCommand}`, {
        ...input,
        inspectedXcodebuildExecutablePaths: [xcodebuild, otherXcode],
      }),
    ).toBe(true);
    expect(
      findCindyWdaOrphanProcessGroups(`653 653 ${otherXcodeCommand}`, {
        ...input,
        inspectedXcodebuildExecutablePaths: [xcodebuild, otherXcode],
      }),
    ).toEqual([]);
  });

  it("reads an owner marker only after selecting an exact same-device Runner", () => {
    const executable =
      `${coreSimulatorRoot}/Devices/${UDID}/data/Containers/Bundle/Application/` +
      `F152910A-1B1D-4F11-A669-68C785E9F638/` +
      `WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`;
    const candidates = findCindyWdaRunnerCandidates(
      `700 700 ${executable}`,
      input,
    );
    expect(candidates).toEqual([
      { pid: 700, processGroupId: 700, executablePath: executable },
    ]);
    expect(
      matchesCindyWdaRunnerEnvironment(
        `700 700 ${executable} USE_PORT=18100 UPGRADE_TIMESTAMP=${ownerFingerprint}`,
        candidates[0]!,
        ownerFingerprint,
      ),
    ).toBe(true);
    expect(
      matchesCindyWdaRunnerEnvironment(
        `700 700 ${executable} UPGRADE_TIMESTAMP=${ownerFingerprint} UPGRADE_TIMESTAMP=${ownerFingerprint}`,
        candidates[0]!,
        ownerFingerprint,
      ),
    ).toBe(false);
    expect(
      matchesCindyWdaRunnerEnvironment(
        `700 700 ${executable} UPGRADE_TIMESTAMP=${"c".repeat(64)}`,
        candidates[0]!,
        ownerFingerprint,
      ),
    ).toBe(false);
    expect(
      findCindyWdaRunnerCandidates(
        `701 701 ${executable.replace(UDID, "2A9D41E0-E031-4AD0-A8B5-847480802E8E")}`,
        input,
      ),
    ).toEqual([]);

    const legacyEnvironment =
      `700 700 ${executable}` +
      ` SIMULATOR_UDID=${UDID}` +
      ` XCODE_SCHEME_NAME=WebDriverAgentRunner` +
      ` UPGRADE_TIMESTAMP=` +
      ` DYLD_LIBRARY_PATH=${cacheRoot}/derived/${"b".repeat(64)}` +
      `/Build/Products/Debug-iphonesimulator`;
    expect(
      matchesLegacyCindyWdaRunnerEnvironment(
        legacyEnvironment,
        candidates[0]!,
        input,
      ),
    ).toBe(true);
    expect(
      matchesLegacyCindyWdaRunnerEnvironment(
        legacyEnvironment.replace(
          "UPGRADE_TIMESTAMP= ",
          `UPGRADE_TIMESTAMP=${"c".repeat(64)} `,
        ),
        candidates[0]!,
        input,
      ),
    ).toBe(false);
    expect(
      matchesLegacyCindyWdaRunnerEnvironment(
        legacyEnvironment.replace(cacheRoot, `${cacheRoot}-other`),
        candidates[0]!,
        input,
      ),
    ).toBe(false);
  });

  it("reads only exact simctl candidates and revalidates diagnostic ownership", () => {
    const simctl = path.posix.join(path.posix.dirname(xcodebuild), "simctl");
    const diagnosticInput = {
      cacheRoot,
      simulatorUdid: UDID,
      xcodebuildExecutablePaths: [xcodebuild],
    };
    const candidates = findCindyWdaDiagnosticCandidates(
      [
        `810 810 ${simctl}`,
        "811 811 /usr/bin/xcrun",
        "812 812 /tmp/xcrun",
      ].join("\n"),
      diagnosticInput,
    );
    expect(candidates).toEqual([
      { pid: 810, processGroupId: 810, executablePath: simctl },
      { pid: 811, processGroupId: 811, executablePath: "/usr/bin/xcrun" },
    ]);

    const output = `${derived}/Logs/Test/Diagnostics`;
    const direct =
      `810 810 ${simctl} diagnose -b --timeout=60` +
      ` --output=${output} --udid=${UDID}`;
    expect(
      matchesCindyWdaDiagnosticCommand(direct, candidates[0]!, diagnosticInput),
    ).toBe(true);
    expect(
      matchesCindyWdaDiagnosticCommand(
        `811 811 /usr/bin/xcrun simctl diagnose --udid=${UDID} --output ${output}`,
        candidates[1]!,
        diagnosticInput,
      ),
    ).toBe(true);

    const rejected = [
      direct.replace("810 810", "900 900"),
      direct.replace(" diagnose ", " list "),
      direct.replace(UDID, "2A9D41E0-E031-4AD0-A8B5-847480802E8E"),
      direct.replace(output, `${cacheRoot}-other/derived/${"b".repeat(64)}`),
      `${direct} --udid=${UDID}`,
      direct.replace(output, `${derived}-reused`),
    ];
    for (const commandLine of rejected) {
      expect(
        matchesCindyWdaDiagnosticCommand(
          commandLine,
          candidates[0]!,
          diagnosticInput,
        ),
      ).toBe(false);
    }
  });
});

describe("WdaProcessManager", () => {
  it("runs orphan recovery before source preparation and launch", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    expect(harness.orphanProcessCleaner).toHaveBeenCalledTimes(2);
    expect(harness.orphanProcessCleaner).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheRoot: path.join(harness.root, "cache"),
        instanceId: "instance-a",
        simulatorUdid: UDID,
        ownerFingerprint: createWdaOwnerFingerprint(
          path.join(harness.root, "cache"),
          "instance-a",
          UDID,
        ),
        signal: expect.any(AbortSignal),
        rejectForeign: true,
      }),
    );
    expect(
      harness.orphanProcessCleaner.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.run.mock.invocationCallOrder[0]!);
    expect(harness.run.mock.invocationCallOrder[0]).toBeLessThan(
      harness.orphanProcessCleaner.mock.invocationCallOrder[1]!,
    );
    expect(
      harness.orphanProcessCleaner.mock.invocationCallOrder[1],
    ).toBeLessThan(harness.launch.mock.invocationCallOrder[0]!);
  });

  it("fails closed before build when orphan recovery is unavailable", async () => {
    const orphanProcessCleaner = vi.fn(async () => {
      throw new WdaError("TERMINATION_FAILED", "inventory unavailable");
    });
    const harness = await createHarness(undefined, { orphanProcessCleaner });

    await expect(
      harness.manager.start({
        instanceId: "instance-a",
        simulatorUdid: UDID,
        runtimeIdentifier: "runtime",
        xcodeBuild: "build",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({ code: "TERMINATION_FAILED" });
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.launch).not.toHaveBeenCalled();
  });

  it("cancels a pending orphan inventory without hanging stop", async () => {
    let calls = 0;
    const orphanProcessCleaner = vi.fn<WdaOrphanProcessCleaner>(
      async (input) => {
        calls += 1;
        if (calls > 1) return;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () =>
            reject(new WdaError("START_CANCELLED", "cancelled"));
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
        });
      },
    );
    const harness = await createHarness(undefined, { orphanProcessCleaner });
    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() =>
      expect(orphanProcessCleaner).toHaveBeenCalledTimes(1),
    );

    const stop = harness.manager.stop("instance-a");
    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stop).resolves.toBeUndefined();
    expect(orphanProcessCleaner).toHaveBeenCalledTimes(2);
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.launch).not.toHaveBeenCalled();
  });

  it("builds once, starts on private ports, probes, and reuses a running instance", async () => {
    const harness = await createHarness();
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      xcodeBuild: "17E11",
      architecture: "arm64" as const,
    };
    const first = await harness.manager.start(input);
    const second = await harness.manager.start(input);

    expect(first).toMatchObject({
      instanceId: "instance-a",
      pid: 42,
      controlPort: 18_100,
      mjpegPort: 19_100,
      sourceRevision: "a".repeat(40),
      driverSessionId: "wda-session",
    });
    expect(second.pid).toBe(first.pid);
    expect(harness.driver.probe).toHaveBeenCalledTimes(2);
    expect(harness.driver.configureStream).toHaveBeenCalledWith("wda-session", {
      framesPerSecond: 5,
      jpegQuality: 25,
      scalingPercent: 50,
    });
    expect(
      harness.manager.diagnostics("instance-a").capabilityReport,
    ).toMatchObject({
      nativeSidecar: { available: false },
      routes: {
        discreteInput: { selected: "wda", fallback: false },
        stream: {
          jpeg: { selected: "wda", fallback: false },
          h264: { selected: "wda", fallback: true },
        },
      },
    });
    expect(
      harness.run.mock.calls.filter(([, args]) =>
        args.includes("build-for-testing"),
      ),
    ).toHaveLength(1);
  });

  it("stops with SIGINT and removes the public running record", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await harness.manager.stop("instance-a");
    expect(harness.killed).toEqual(["SIGINT"]);
    expect(harness.driver.deleteSession).toHaveBeenCalledWith("wda-session");
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("drops a cached running record when the live WDA probe fails", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    harness.driver.probe.mockRejectedValueOnce(new Error("connection refused"));

    await expect(harness.manager.probe("instance-a")).resolves.toBeNull();

    expect(harness.manager.get("instance-a")).toBeNull();
    expect(harness.driver.deleteSession).toHaveBeenCalledWith("wda-session");
    expect(harness.killed).toEqual(["SIGINT"]);
  });

  it("cancels an in-flight WDA build without launching a late process", async () => {
    const harness = await createHarness();
    const runBuild = harness.run.getMockImplementation()!;
    harness.run.mockImplementation(async (...args) => {
      if (args[1].includes("build-for-testing")) {
        return new Promise((resolve) => {
          const signal = args[2]?.signal;
          const finish = () =>
            resolve({ stdout: "", stderr: "", exitCode: null });
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
      return runBuild(...args);
    });

    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() =>
      expect(
        harness.run.mock.calls.some(([, args]) =>
          args.includes("build-for-testing"),
        ),
      ).toBe(true),
    );
    const stop = harness.manager.stop("instance-a");

    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stop).resolves.toBeUndefined();

    expect(harness.manager.get("instance-a")).toBeNull();
    expect(harness.launch).not.toHaveBeenCalled();
    expect(harness.driver.createSession).not.toHaveBeenCalled();
    const buildCall = harness.run.mock.calls.find(([, args]) =>
      args.includes("build-for-testing"),
    );
    expect(buildCall?.[2]?.signal?.aborted).toBe(true);
  });

  it("stops promptly while shared WDA source extraction finishes independently", async () => {
    const harness = await createHarness();
    const runCommand = harness.run.getMockImplementation()!;
    let releaseExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    harness.run.mockImplementation(async (...args) => {
      if (!args[1].includes("-xzf")) return runCommand(...args);
      await extractionGate;
      return runCommand(...args);
    });

    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() =>
      expect(
        harness.run.mock.calls.some(([, args]) => args.includes("-xzf")),
      ).toBe(true),
    );

    await expect(harness.manager.stop("instance-a")).resolves.toBeUndefined();
    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(harness.launch).not.toHaveBeenCalled();

    releaseExtraction();
    await vi.waitFor(async () => {
      const marker = await readFile(
        path.join(
          harness.root,
          "cache",
          "source",
          "a".repeat(40),
          ".cindy-wda-source.json",
        ),
        "utf8",
      );
      expect(marker).toContain('"revision"');
    });
  });

  it("cancels readiness probing and terminates the already-launched process", async () => {
    const harness = await createHarness();
    harness.driver.probe.mockImplementation(() => new Promise(() => undefined));
    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() => expect(harness.driver.probe).toHaveBeenCalled());

    const stop = harness.manager.stop("instance-a");

    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stop).resolves.toBeUndefined();
    expect(harness.killed).toEqual(["SIGINT"]);
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("synchronously kills live WDA processes during updater force-exit", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    harness.manager.abortOperationsForExit();

    expect(harness.killed).toEqual(["SIGKILL"]);
  });

  it("keeps stop-gap WDA processes visible to force-exit cleanup", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    let releaseDelete!: () => void;
    harness.driver.deleteSession.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          releaseDelete = () => resolve(undefined);
        }),
    );
    const stop = harness.manager.stop("instance-a");
    await vi.waitFor(() =>
      expect(harness.driver.deleteSession).toHaveBeenCalledWith("wda-session"),
    );

    harness.manager.abortOperationsForExit();
    expect(harness.killed).toEqual(["SIGKILL"]);

    releaseDelete();
    await stop;
  });

  it("awaits full process-group termination before returning a readiness timeout", async () => {
    const harness = await createHarness(undefined, {
      startTimeoutMs: 500,
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: ["SIGKILL"],
    });
    harness.driver.probe.mockRejectedValue(new Error("connection refused"));

    await expect(
      harness.manager.start({
        instanceId: "instance-a",
        simulatorUdid: UDID,
        runtimeIdentifier: "runtime",
        xcodeBuild: "build",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({ code: "START_TIMEOUT" });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(false);
  });

  it("terminates the whole process group when WDA session setup fails", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: ["SIGKILL"],
    });
    harness.driver.createSession.mockRejectedValue(new Error("session failed"));

    await expect(
      harness.manager.start({
        instanceId: "instance-a",
        simulatorUdid: UDID,
        runtimeIdentifier: "runtime",
        xcodeBuild: "build",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(false);
  });

  it("waits through stop escalation when the leader exits before its process group", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: ["SIGKILL"],
    });
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    await harness.manager.stop("instance-a");

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(false);
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("routes an unexpected leader exit through the process-group termination barrier", async () => {
    const harness = await createHarness(undefined, {
      groupExitsOn: ["SIGKILL"],
    });
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    harness.exitLeader("SIGTERM");

    await vi.waitFor(() => {
      expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
      expect(harness.manager.get("instance-a")).toBeNull();
    });
    expect(harness.process.isAlive()).toBe(false);
  });

  it("uses normal running teardown when process exit races the start commit", async () => {
    const harness = await createHarness(undefined, {
      groupExitsOn: [],
    });
    harness.driver.configureStream.mockImplementation(
      async (_sessionId, profile) => {
        harness.exitLeader("SIGTERM");
        return profile;
      },
    );

    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    await vi.waitFor(() =>
      expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]),
    );
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("quarantines an unkillable process group and blocks replacement starts", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: [],
    });
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64" as const,
    };
    await harness.manager.start(input);

    await expect(harness.manager.stop("instance-a")).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    await expect(harness.manager.start(input)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(true);
    expect(harness.launch).toHaveBeenCalledTimes(1);
  });

  it("quarantines an unkillable readiness-timeout group before retrying start", async () => {
    const harness = await createHarness(undefined, {
      startTimeoutMs: 500,
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: [],
    });
    harness.driver.probe.mockRejectedValue(new Error("connection refused"));
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64" as const,
    };

    await expect(harness.manager.start(input)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    await expect(harness.manager.start(input)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(true);
    expect(harness.launch).toHaveBeenCalledTimes(1);
  });

  it("cleans a retired process group before allowing a replacement start", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: [],
    });
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64" as const,
    };
    await harness.manager.start(input);
    await expect(harness.manager.stop("instance-a")).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });

    const replacement: WdaManagedProcess = {
      pid: 43,
      exited: new Promise(() => undefined),
      isAlive: vi.fn(() => true),
      kill: vi.fn(),
      onOutput: vi.fn(() => () => undefined),
    };
    harness.launch.mockReturnValue(replacement);
    harness.exitGroup();

    const running = await harness.manager.start(input);

    expect(running.pid).toBe(43);
    expect(harness.launch).toHaveBeenCalledTimes(2);
    harness.manager.abortOperationsForExit();
    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(replacement.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("attaches the optional native adapter by exact generation and stops it with WDA", async () => {
    const nativeDriver = {
      kind: "native-sidecar",
      simulatorUdid: UDID,
      generation: 9,
      capabilities: Object.freeze({
        accessibility: false,
        sessions: false,
        jpegStream: false,
        h264Stream: true,
        bgraStream: true,
        discreteInput: true,
        continuousInput: true,
        multiTouch: true,
      }),
    } as IOSSimulatorNativeSidecarDriver;
    const nativeAdmission = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: createIOSSimulatorNativeDevelopmentAdmissionPolicy({
        enableH264Stream: true,
        enableContinuousInput: true,
      }),
      detectedCapabilities: nativeDriver.capabilities,
      processState: "running",
    });
    const nativeManager = {
      providerId: "cindy.bundled-ios-simulator",
      diagnostics: vi.fn(() => ({
        running: true,
        state: "running" as const,
        crashCount: 0,
        probe: null,
        lastFailure: null,
        lastTermination: null,
        admission: nativeAdmission,
      })),
      admission: vi.fn(() => nativeAdmission),
      get: vi.fn(() => ({
        adapter: nativeDriver,
        instanceId: "instance-a",
        simulatorUdid: UDID,
        generation: 9,
        handshake: {
          protocolVersion: 1,
          simulatorUdid: UDID,
          generation: 9,
          ready: true,
          message: null,
          capabilities: nativeDriver.capabilities,
          probe: null,
        },
        admission: nativeAdmission,
        startedAt: new Date(0).toISOString(),
      })),
      start: vi.fn(async (input: IOSSimulatorNativeSidecarStartOptions) => {
        expect(input.generation).toBe(9);
        return {
          adapter: nativeDriver,
          instanceId: "instance-a",
          simulatorUdid: UDID,
          generation: 9,
          handshake: {
            protocolVersion: 1,
            simulatorUdid: UDID,
            generation: 9,
            ready: true,
            message: null,
            capabilities: nativeDriver.capabilities,
            probe: null,
          },
          admission: nativeAdmission,
          startedAt: new Date(0).toISOString(),
        };
      }),
      recover: vi.fn(async () => ({
        adapter: nativeDriver,
        instanceId: "instance-a",
        simulatorUdid: UDID,
        generation: 9,
        handshake: {
          protocolVersion: 1,
          simulatorUdid: UDID,
          generation: 9,
          ready: true,
          message: null,
          capabilities: nativeDriver.capabilities,
          probe: null,
        },
        admission: nativeAdmission,
        startedAt: new Date(1).toISOString(),
      })),
      stop: vi.fn(async () => undefined),
    } satisfies WdaProcessManagerOptions["nativeCapabilityProvider"];
    const harness = await createHarness(nativeManager);
    const running = await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 9,
      runtimeIdentifier: "runtime",
      runtimeBuildVersion: "runtime-build",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    expect(nativeManager.start).toHaveBeenCalledTimes(1);
    expect(nativeManager.start).toHaveBeenCalledWith({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 9,
      runtime: {
        runtimeIdentifier: "runtime",
        runtimeBuildVersion: "runtime-build",
        xcodeBuild: "build",
        architecture: "arm64",
      },
    });
    expect(
      harness.manager.diagnostics("instance-a").capabilityReport,
    ).toMatchObject({
      nativeSidecar: {
        available: true,
        simulatorUdid: UDID,
        generation: 9,
      },
      routes: {
        stream: {
          h264: { selected: "native-sidecar", fallback: false },
        },
      },
    });
    expect(running.driverRouter?.capabilityReport()).toMatchObject({
      nativeSidecar: { available: true },
    });
    nativeManager.get.mockImplementation(() => null as never);
    expect(running.driverRouter?.stream("h264")).toMatchObject({
      adapter: "wda",
      fallback: true,
    });
    const recoveredNativeDriver = {
      ...nativeDriver,
      capabilities: nativeDriver.capabilities,
    } as IOSSimulatorNativeSidecarDriver;
    const recoveredNative = {
      adapter: recoveredNativeDriver,
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 9,
      handshake: {
        protocolVersion: 1,
        simulatorUdid: UDID,
        generation: 9,
        ready: true,
        message: null,
        capabilities: recoveredNativeDriver.capabilities,
        probe: null,
      },
      admission: nativeAdmission,
      startedAt: new Date(1).toISOString(),
    };
    nativeManager.get.mockImplementation(() => recoveredNative);
    nativeManager.recover.mockResolvedValue(recoveredNative);

    const recovered = await harness.manager.recoverNativeSidecar("instance-a", {
      rearm: true,
    });

    expect(nativeManager.recover).toHaveBeenCalledWith(
      {
        instanceId: "instance-a",
        simulatorUdid: UDID,
        generation: 9,
        runtime: {
          runtimeIdentifier: "runtime",
          runtimeBuildVersion: "runtime-build",
          xcodeBuild: "build",
          architecture: "arm64",
        },
      },
      { rearm: true },
    );
    expect(recovered?.driverRouter?.stream("h264")).toMatchObject({
      adapter: "native-sidecar",
      source: recoveredNativeDriver,
    });
    expect(recovered?.pid).toBe(running.pid);
    expect(harness.driver.createSession).toHaveBeenCalledTimes(1);
    await harness.manager.stop("instance-a");
    expect(nativeManager.stop).toHaveBeenCalledWith("instance-a");
  });
});
