import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  IOSSimulatorNativeFrame,
  IOSSimulatorStreamStats,
} from "../driver.js";
import { createIOSSimulatorNativeDevelopmentAdmissionPolicy } from "../capability-admission.js";
import type { IOSSimulatorNativeSidecarCommand } from "./adapter.js";
import type {
  IOSSimulatorNativeSidecarChannelState,
  IOSSimulatorNativeSidecarTermination,
} from "./channel.js";
import {
  createIOSSimulatorNativeSidecarArguments,
  createIOSSimulatorNativeSidecarEnvironment,
  IOSSimulatorNativeSidecarProcessManager,
  IOSSimulatorNativeSidecarProcessManagerError,
  resolveIOSSimulatorNativeSidecarBinary,
  resolveIOSSimulatorPackagedSidecarBinary,
  type IOSSimulatorNativeSidecarManagedChannel,
} from "./process-manager.js";

const UDID = "A1B2C3D4-1111-2222-3333-444455556666";

const CAPABILITIES = Object.freeze({
  accessibility: false,
  sessions: false,
  jpegStream: false,
  h264Stream: true,
  bgraStream: true,
  discreteInput: true,
  continuousInput: true,
  multiTouch: true,
});

class FakeChannel implements IOSSimulatorNativeSidecarManagedChannel {
  state: IOSSimulatorNativeSidecarChannelState = "idle";
  crashCount = 0;
  stderrTail = "";
  lastTermination: IOSSimulatorNativeSidecarTermination | null = null;
  retirement: Promise<void> | null = null;
  readonly requests: IOSSimulatorNativeSidecarCommand[] = [];
  readonly stop = vi.fn(async () => {
    this.state = "stopped";
  });
  readonly restart = vi.fn(async () => {
    this.state = "running";
  });
  readonly rearm = vi.fn(() => {
    this.crashCount = 0;
    this.state = "idle";
  });
  readonly abortOperationsForExit = vi.fn(() => {
    this.state = "stopped";
  });

  constructor(
    readonly handshake: Record<string, unknown> = {
      protocolVersion: 1,
      simulatorUdid: UDID,
      generation: 7,
      ready: true,
      message: null,
      capabilities: CAPABILITIES,
      probe: {
        coreSimulatorLoaded: true,
        simulatorKitLoaded: true,
        deviceDiscovery: true,
        framebufferSymbols: true,
        framebufferCapture: true,
        framebuffer: {
          width: 1206,
          height: 2622,
          bytesPerRow: 4864,
          byteCount: 12_753_408,
          screenId: 1,
          pixelFormat: "BGRA",
        },
        hid: true,
      },
    },
    readonly availability: Record<string, unknown> = {
      ready: true,
      message: null,
    },
    readonly beforeAvailability?: Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.state = "running";
  }

  async request(command: IOSSimulatorNativeSidecarCommand): Promise<unknown> {
    this.requests.push(command);
    if (command.op === "handshake") return this.handshake;
    if (command.op === "availability") {
      await this.beforeAvailability;
      return this.availability;
    }
    return {};
  }

  async streamFrames(
    _command: IOSSimulatorNativeSidecarCommand,
    _options: {
      signal?: AbortSignal;
      maxFrames?: number;
      maxFrameBytes?: number;
      acknowledgeFrames?: boolean;
      requireContiguousSequence?: boolean;
      onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
    },
  ): Promise<IOSSimulatorStreamStats> {
    return {
      frameCount: 0,
      byteCount: 0,
      startedAt: new Date(0).toISOString(),
      firstFrameAt: null,
      endedAt: new Date(0).toISOString(),
      endReason: "eof",
    };
  }
}

function input() {
  return {
    instanceId: "instance-a",
    simulatorUdid: UDID,
    generation: 7,
  };
}

describe("IOSSimulatorNativeSidecarProcessManager", () => {
  it("forwards updater force-exit aborts to every live channel", async () => {
    const channel = new FakeChannel();
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });
    await manager.start(input());

    manager.abortOperationsForExit();

    expect(channel.abortOperationsForExit).toHaveBeenCalledOnce();
  });

  it("retains a failed-termination slot until the exact channel exits", async () => {
    const channels: FakeChannel[] = [];
    const createChannel = vi.fn(() => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel,
    });
    await manager.start(input());
    const retired = channels[0]!;
    let resolveRetirement!: () => void;
    retired.retirement = new Promise<void>((resolve) => {
      resolveRetirement = resolve;
    });
    void retired.retirement.then(() => {
      retired.retirement = null;
    });
    retired.stop.mockImplementation(async () => {
      retired.state = "stopped";
      throw Object.assign(new Error("still alive"), {
        code: "TERMINATION_FAILED",
      });
    });

    await expect(manager.stop(input().instanceId)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    await expect(manager.start(input())).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    expect(createChannel).toHaveBeenCalledTimes(1);
    manager.abortOperationsForExit();
    expect(retired.abortOperationsForExit).toHaveBeenCalledOnce();

    resolveRetirement();
    await retired.retirement;
    await vi.waitFor(() =>
      expect(manager.diagnostics(input().instanceId).state).toBe("stopped"),
    );
    await manager.start(input());
    expect(createChannel).toHaveBeenCalledTimes(2);
    await manager.stop(input().instanceId);
  });

  it("quarantines a failed startup channel before allowing another launch", async () => {
    const retired = new FakeChannel(undefined, {
      ready: false,
      message: "probe failed",
    });
    let resolveRetirement!: () => void;
    retired.stop.mockImplementation(async () => {
      if (!retired.retirement) {
        retired.retirement = new Promise<void>((resolve) => {
          resolveRetirement = resolve;
        });
        void retired.retirement.then(() => {
          retired.retirement = null;
        });
      }
      retired.state = "stopped";
      throw Object.assign(new Error("still alive"), {
        code: "TERMINATION_FAILED",
      });
    });
    const replacement = new FakeChannel();
    const createChannel = vi
      .fn<() => IOSSimulatorNativeSidecarManagedChannel>()
      .mockReturnValueOnce(retired)
      .mockReturnValue(replacement);
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel,
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    await expect(manager.start(input())).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    expect(createChannel).toHaveBeenCalledTimes(1);

    resolveRetirement();
    await retired.retirement;
    await vi.waitFor(() =>
      expect(manager.diagnostics(input().instanceId).state).toBe("stopped"),
    );
    await manager.start(input());
    expect(createChannel).toHaveBeenCalledTimes(2);
    await manager.stop(input().instanceId);
  });

  it("adds native product flags only for explicitly enabled host capabilities", () => {
    const start = input();
    expect(createIOSSimulatorNativeSidecarArguments(start)).toEqual([
      "--stdio",
      "--simulator-udid",
      UDID,
      "--generation",
      "7",
    ]);
    expect(createIOSSimulatorNativeSidecarArguments(start, true)).toEqual([
      "--stdio",
      "--simulator-udid",
      UDID,
      "--generation",
      "7",
      "--enable-h264-stream",
    ]);
    expect(
      createIOSSimulatorNativeSidecarArguments(start, false, true),
    ).toEqual([
      "--stdio",
      "--simulator-udid",
      UDID,
      "--generation",
      "7",
      "--enable-continuous-input",
    ]);
    expect(createIOSSimulatorNativeSidecarArguments(start, true, true)).toEqual(
      [
        "--stdio",
        "--simulator-udid",
        UDID,
        "--generation",
        "7",
        "--enable-h264-stream",
        "--enable-continuous-input",
      ],
    );
  });

  it("fails closed before spawn when the required OS sandbox is unsupported", async () => {
    const createChannel = vi.fn(() => new FakeChannel());
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel,
      sandboxPolicy: {
        required: true,
        platform: "linux",
        sandboxExecutablePath: "/usr/bin/sandbox-exec",
        homeDirectory: "/home/example",
        developerDirectory: "/Applications/Xcode.app/Contents/Developer",
        coreSimulatorRoot: "/home/example/Library/Developer/CoreSimulator",
        temporaryRoot: "/tmp",
      },
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "SANDBOX_UNSUPPORTED_PLATFORM",
    });
    expect(createChannel).not.toHaveBeenCalled();
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      sandbox: {
        required: true,
        enforced: false,
        reasonCode: "SANDBOX_UNSUPPORTED_PLATFORM",
      },
    });
  });

  it("rejects a changed packaged artifact before creating a channel", async () => {
    const createChannel = vi.fn(() => new FakeChannel());
    const verifyBinaryIntegrity = vi.fn(async () => {
      throw new Error("digest mismatch");
    });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel,
      verifyBinaryIntegrity,
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "ARTIFACT_CHANGED",
      message: "Native sidecar artifact changed before launch.",
    });
    expect(verifyBinaryIntegrity).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("rechecks packaged artifact integrity before a channel restart", async () => {
    const channel = new FakeChannel();
    const verifyBinaryIntegrity = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("digest mismatch"));
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
      verifyBinaryIntegrity,
    });
    await manager.start(input());
    channel.state = "idle";

    await expect(manager.recover(input())).rejects.toMatchObject({
      code: "ARTIFACT_CHANGED",
    });
    expect(verifyBinaryIntegrity).toHaveBeenCalledTimes(2);
    expect(channel.restart).not.toHaveBeenCalled();
    expect(channel.stop).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === "darwin")(
    "owns a mode-0700 sandbox directory and removes it after stop or startup failure",
    async () => {
      const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "cindy-ios-sandbox-manager-test-"),
      );
      const sandboxPolicy = {
        required: true,
        platform: "darwin" as const,
        sandboxExecutablePath: "/usr/bin/sandbox-exec",
        homeDirectory: os.homedir(),
        developerDirectory: "/Applications/Xcode.app/Contents/Developer",
        coreSimulatorRoot: path.join(
          os.homedir(),
          "Library",
          "Developer",
          "CoreSimulator",
        ),
        temporaryRoot,
      };

      try {
        const manager = new IOSSimulatorNativeSidecarProcessManager({
          binaryPath: "/private/fake/ios-simulator-sidecar",
          createChannel: () => new FakeChannel(),
          sandboxPolicy,
        });
        await manager.start(input());
        const [privateDirectory] = await readdir(temporaryRoot);
        expect(privateDirectory).toMatch(
          /^cindy-ios-simulator-sidecar-instance-a-/,
        );
        expect(
          (await stat(path.join(temporaryRoot, privateDirectory))).mode & 0o777,
        ).toBe(0o700);
        expect(
          (
            await stat(
              path.join(temporaryRoot, privateDirectory, "metal-cache"),
            )
          ).mode & 0o777,
        ).toBe(0o700);
        await manager.stop(input().instanceId);
        expect(await readdir(temporaryRoot)).toEqual([]);

        const failedChannel = new FakeChannel();
        vi.spyOn(failedChannel, "start").mockRejectedValue(
          new Error("sandboxed process failed"),
        );
        const failingManager = new IOSSimulatorNativeSidecarProcessManager({
          binaryPath: "/private/fake/ios-simulator-sidecar",
          createChannel: () => failedChannel,
          sandboxPolicy,
        });
        await expect(failingManager.start(input())).rejects.toThrow(
          "Native sidecar process failed to start.",
        );
        expect(await readdir(temporaryRoot)).toEqual([]);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it("performs an exact handshake, probes availability, and reuses the binding", async () => {
    const channel = new FakeChannel();
    const createChannel = vi.fn(() => channel);
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    const first = await manager.start(input());
    const second = await manager.start(input());

    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(channel.requests.map((request) => request.op)).toEqual([
      "handshake",
      "availability",
    ]);
    expect(first).toMatchObject({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 7,
      startedAt: "2026-07-23T00:00:00.000Z",
      handshake: {
        ready: true,
        capabilities: { h264Stream: true, multiTouch: true },
      },
    });
    expect(second.adapter).toBe(first.adapter);
    expect(first).not.toHaveProperty("sandbox");
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: true,
      state: "running",
      crashCount: 0,
    });
    await manager.stop("instance-a");
    expect(channel.requests.at(-1)?.op).toBe("detach");
    expect(channel.stop).toHaveBeenCalledTimes(1);
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "stopped",
      admission: {
        processState: "stopped",
        launch: { active: false },
        capabilities: {
          h264Stream: { active: false, reasonCode: "NOT_REQUESTED" },
          continuousInput: { active: false, reasonCode: "NOT_REQUESTED" },
        },
      },
    });
  });

  it("restarts a failed binding and repeats its exact handshake", async () => {
    const channel = new FakeChannel();
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
      enableContinuousInput: true,
    });
    const first = await manager.start(input());
    channel.state = "failed";
    channel.crashCount = 1;
    channel.lastTermination = {
      reasonCode: "process-exit",
      message:
        "Native sidecar exited beside /Users/example/private/SimulatorKit.framework.",
      exitCode: 23,
      signal: null,
      occurredAt: "2026-07-23T00:00:01.000Z",
      stderrTail:
        "token=private-value VideoToolbox failed at /Users/example/private/CoreSimulator.framework",
    };

    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "failed",
      lastFailure: "Native sidecar exited beside <redacted-path>",
      lastTermination: {
        reasonCode: "process-exit",
        exitCode: 23,
        signal: null,
        occurredAt: "2026-07-23T00:00:01.000Z",
        stderrTail: "token=<redacted> VideoToolbox failed at <redacted-path>",
      },
      admission: {
        processState: "failed",
        launch: { active: false, reasonCode: "PROCESS_NOT_RUNNING" },
        capabilities: {
          h264Stream: { active: false },
          continuousInput: { active: false },
        },
      },
    });
    const recovered = await manager.recover(input());

    expect(channel.restart).toHaveBeenCalledTimes(1);
    expect(channel.requests.map((request) => request.op)).toEqual([
      "handshake",
      "availability",
      "handshake",
      "availability",
      "releaseInput",
    ]);
    expect(recovered.adapter).not.toBe(first.adapter);
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: true,
      state: "running",
      crashCount: 1,
      lastFailure: null,
      lastTermination: {
        reasonCode: "process-exit",
        exitCode: 23,
      },
    });
    await manager.stop("instance-a");
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "stopped",
      lastTermination: {
        reasonCode: "process-exit",
        exitCode: 23,
      },
    });
  });

  it("converges an in-flight start to stopped without leaving a late binding", async () => {
    let releaseAvailability!: () => void;
    const channel = new FakeChannel(
      undefined,
      undefined,
      new Promise<void>((resolve) => {
        releaseAvailability = resolve;
      }),
    );
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
      enableH264Stream: true,
    });

    const start = manager.start(input());
    await vi.waitFor(() =>
      expect(channel.requests.map((request) => request.op)).toContain(
        "availability",
      ),
    );
    const stop = manager.stop("instance-a");
    await vi.waitFor(() => expect(channel.stop).toHaveBeenCalled());
    releaseAvailability();

    await expect(start).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await stop;
    expect(manager.get("instance-a")).toBeNull();
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "stopped",
      lastFailure: null,
      admission: {
        processState: "stopped",
        launch: { active: false },
        capabilities: { h264Stream: { active: false } },
      },
    });

    const stopCalls = channel.stop.mock.calls.length;
    await manager.stop("instance-a");
    expect(channel.stop).toHaveBeenCalledTimes(stopCalls);
  });

  it("does not re-activate a failed binding when stop races recovery", async () => {
    const channel = new FakeChannel();
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });
    await manager.start(input());
    channel.state = "failed";
    let releaseRestart!: () => void;
    channel.restart.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRestart = () => {
            channel.state = "running";
            resolve();
          };
        }),
    );

    const recovery = manager.recover(input());
    await vi.waitFor(() => expect(channel.restart).toHaveBeenCalledTimes(1));
    const stop = manager.stop("instance-a");
    releaseRestart();

    await expect(recovery).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await stop;
    expect(manager.get("instance-a")).toBeNull();
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "stopped",
      lastFailure: null,
    });
  });

  it("removes a failed recovery channel from force-exit tracking", async () => {
    const channel = new FakeChannel();
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });
    await manager.start(input());
    channel.state = "failed";
    channel.restart.mockRejectedValueOnce(new Error("restart failed"));

    await expect(manager.recover(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    manager.abortOperationsForExit();

    expect(channel.abortOperationsForExit).not.toHaveBeenCalled();
  });

  it("only re-arms a parked binding for explicit recovery", async () => {
    const channel = new FakeChannel();
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });
    await manager.start(input());
    channel.state = "parked";
    channel.crashCount = 3;

    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "parked",
      admission: {
        processState: "parked",
        launch: { active: false, reasonCode: "PROCESS_PARKED" },
        capabilities: {
          h264Stream: { active: false },
          continuousInput: { active: false },
        },
      },
    });
    await expect(manager.recover(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(channel.rearm).not.toHaveBeenCalled();

    const recovered = await manager.recover(input(), { rearm: true });
    expect(channel.rearm).toHaveBeenCalledTimes(1);
    expect(channel.restart).toHaveBeenCalledTimes(1);
    expect(recovered.adapter).toBeDefined();
    await manager.stop("instance-a");
  });

  it("fails closed and stops the process on identity or capability drift", async () => {
    const invalid = new FakeChannel({
      protocolVersion: 1,
      simulatorUdid: "WRONG-UDID",
      generation: 7,
      ready: true,
      capabilities: { ...CAPABILITIES, sessions: true },
    });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => invalid,
    });

    await expect(manager.start(input())).rejects.toBeInstanceOf(
      IOSSimulatorNativeSidecarProcessManagerError,
    );
    expect(invalid.stop).toHaveBeenCalledTimes(1);
    expect(manager.get("instance-a")).toBeNull();
  });

  it("does not reuse a running binding across runtime build identities", async () => {
    const channel = new FakeChannel();
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });
    const start = {
      ...input(),
      runtime: {
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        runtimeBuildVersion: "23E244",
        xcodeBuild: "Xcode 26.4\nBuild version 17E192",
        architecture: "arm64" as const,
      },
    };
    await manager.start(start);

    await expect(
      manager.recover({
        ...start,
        runtime: {
          ...start.runtime,
          runtimeBuildVersion: "23E245",
        },
      }),
    ).rejects.toMatchObject({ code: "HANDSHAKE_FAILED" });
    expect(channel.restart).not.toHaveBeenCalled();
    await manager.stop(start.instanceId);
  });

  it("masks detected product capabilities that host policy did not admit", async () => {
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => new FakeChannel(),
      enableContinuousInput: true,
    });

    const running = await manager.start(input());

    expect(running.handshake.capabilities).toMatchObject({
      h264Stream: true,
      continuousInput: true,
      multiTouch: true,
    });
    expect(running.adapter.capabilities).toMatchObject({
      h264Stream: false,
      bgraStream: false,
      continuousInput: true,
      multiTouch: true,
    });
    expect(running.admission.capabilities).toMatchObject({
      h264Stream: {
        detected: true,
        policyAllowed: false,
        active: false,
        reasonCode: "NOT_REQUESTED",
      },
      continuousInput: {
        detected: true,
        policyAllowed: true,
        active: true,
      },
    });
    await manager.stop("instance-a");
  });

  it("does not execute an artifact denied by packaged host admission", async () => {
    const createChannel = vi.fn(() => new FakeChannel());
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel,
      admissionPolicy: {
        host: {
          mode: "packaged",
          platform: "darwin",
          architecture: "arm64",
        },
        artifact: { source: "plugin", trust: "untrusted" },
        compatibility: {
          sidecar: "eligible",
          h264Stream: "eligible",
          continuousInput: "eligible",
          multiTouch: "eligible",
        },
        requested: { h264Stream: true, continuousInput: true },
        resourceAdmission: "allowed",
      },
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
    });
    expect(createChannel).not.toHaveBeenCalled();
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "idle",
      admission: {
        artifact: { source: "plugin", trust: "untrusted" },
        launch: {
          allowed: false,
          reasonCode: "ARTIFACT_UNTRUSTED",
        },
        fallbackRoute: "wda-mjpeg",
      },
    });
  });

  it("retains a sanitized framework probe without exposing sidecar failure details", async () => {
    const channel = new FakeChannel({
      protocolVersion: 1,
      simulatorUdid: UDID,
      generation: 7,
      ready: false,
      message:
        "IOSurface lookup failed at /Users/example/private/SimulatorKit.framework",
      capabilities: {
        accessibility: false,
        sessions: false,
        jpegStream: false,
        h264Stream: false,
        bgraStream: false,
        discreteInput: false,
        continuousInput: false,
        multiTouch: false,
      },
      probe: {
        coreSimulatorLoaded: true,
        simulatorKitLoaded: true,
        deviceDiscovery: true,
        framebufferSymbols: true,
        framebufferCapture: false,
        framebuffer: null,
        hid: true,
      },
    });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Native sidecar capability probe failed.",
    });
    expect(manager.diagnostics("instance-a")).toMatchObject({
      running: false,
      state: "failed",
      probe: {
        coreSimulatorLoaded: true,
        simulatorKitLoaded: true,
        framebufferSymbols: true,
        framebufferCapture: false,
        framebuffer: null,
        hid: true,
      },
      lastFailure: "Native sidecar capability probe failed.",
      admission: {
        processState: "failed",
        launch: { active: false },
      },
    });
    expect(JSON.stringify(manager.diagnostics("instance-a"))).not.toContain(
      "/Users/example",
    );
    expect(JSON.stringify(manager.diagnostics("instance-a"))).not.toContain(
      "SimulatorKit.framework",
    );
    expect(manager.diagnostics("instance-a")).not.toHaveProperty("stderrTail");
  });

  it("marks a failed availability probe inactive without exposing its message", async () => {
    const channel = new FakeChannel(undefined, {
      ready: false,
      message:
        "IOSurface service failed at /Users/example/private/CoreSimulator.framework",
    });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
      enableH264Stream: true,
      enableContinuousInput: true,
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Native sidecar is unavailable.",
    });
    const diagnostics = manager.diagnostics("instance-a");
    expect(diagnostics).toMatchObject({
      running: false,
      state: "failed",
      lastFailure: "Native sidecar is unavailable.",
      admission: {
        processState: "failed",
        launch: { active: false, reasonCode: "PROCESS_NOT_RUNNING" },
        capabilities: {
          h264Stream: { admitted: true, active: false },
          continuousInput: { admitted: true, active: false },
        },
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("/Users/example");
    expect(JSON.stringify(diagnostics)).not.toContain(
      "CoreSimulator.framework",
    );
  });

  it("passes the exact runtime identity only to the host policy resolver", async () => {
    const policyResolver = vi.fn(() =>
      createIOSSimulatorNativeDevelopmentAdmissionPolicy(),
    );
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => new FakeChannel(),
      admissionPolicy: policyResolver,
    });
    const runtime = {
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      runtimeBuildVersion: "23E244",
      xcodeBuild: "17F6",
      architecture: "arm64" as const,
    };

    await manager.start({ ...input(), runtime });

    expect(policyResolver).toHaveBeenCalledOnce();
    expect(policyResolver).toHaveBeenCalledWith({ ...input(), runtime });
    await manager.stop("instance-a");
  });

  it("re-evaluates Host admission before recovery instead of trusting the startup policy", async () => {
    const channel = new FakeChannel();
    const allowed = createIOSSimulatorNativeDevelopmentAdmissionPolicy();
    const policyResolver = vi
      .fn()
      .mockReturnValueOnce(allowed)
      .mockReturnValueOnce({
        ...allowed,
        artifact: { source: "plugin", trust: "untrusted" },
      });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
      admissionPolicy: policyResolver,
    });

    await manager.start(input());
    channel.state = "failed";

    await expect(manager.recover(input())).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
    });
    expect(policyResolver).toHaveBeenCalledTimes(2);
    expect(channel.restart).not.toHaveBeenCalled();
    expect(channel.stop).toHaveBeenCalledTimes(1);
    expect(manager.get(input().instanceId)).toBeNull();
  });

  it("rejects inconsistent framebuffer capture metadata", async () => {
    const channel = new FakeChannel({
      protocolVersion: 1,
      simulatorUdid: UDID,
      generation: 7,
      ready: true,
      message: null,
      capabilities: {
        ...CAPABILITIES,
        h264Stream: false,
        bgraStream: false,
      },
      probe: {
        coreSimulatorLoaded: true,
        simulatorKitLoaded: true,
        deviceDiscovery: true,
        framebufferSymbols: true,
        framebufferCapture: true,
        framebuffer: null,
        hid: false,
      },
    });
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => channel,
    });

    await expect(manager.start(input())).rejects.toMatchObject({
      code: "HANDSHAKE_FAILED",
    });
    expect(channel.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects rebinding an instance id to a stale generation", async () => {
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: "/private/fake/ios-simulator-sidecar",
      createChannel: () => new FakeChannel(),
    });
    await manager.start(input());
    await expect(
      manager.start({ ...input(), generation: 8 }),
    ).rejects.toMatchObject({ code: "HANDSHAKE_FAILED" });
    await manager.stop("instance-a");
  });

  it("builds an allowlisted environment and architecture-specific resource path", () => {
    expect(
      createIOSSimulatorNativeSidecarEnvironment({
        PATH: "/usr/bin",
        TMPDIR: "/private/tmp/example",
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        HOME: "/Users/example",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: "/private/tmp/example",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    });
    expect(
      resolveIOSSimulatorNativeSidecarBinary(
        "/Applications/Cindy.app/Contents/Resources",
        "arm64",
      ),
    ).toBe(
      path.join(
        "/Applications/Cindy.app/Contents/Resources",
        "ios-simulator",
        "native",
        "arm64",
        "ios-simulator-sidecar",
      ),
    );
    expect(() =>
      resolveIOSSimulatorNativeSidecarBinary("relative", "arm64"),
    ).toThrow("must be absolute");
    expect(
      resolveIOSSimulatorPackagedSidecarBinary(
        "/Applications/Cindy.app/Contents/Resources",
      ),
    ).toBe(
      path.join(
        "/Applications/Cindy.app/Contents/Helpers",
        "Cindy iOS Simulator Helper.app",
        "Contents",
        "MacOS",
        "ios-simulator-sidecar",
      ),
    );
    expect(() => resolveIOSSimulatorPackagedSidecarBinary("relative")).toThrow(
      "must be absolute",
    );
  });
});
