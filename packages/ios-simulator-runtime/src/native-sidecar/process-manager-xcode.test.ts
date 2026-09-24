import { describe, expect, it, vi } from "vitest";

import { createIOSSimulatorNativeDevelopmentAdmissionPolicy } from "../capability-admission.js";
import { createNodeIOSSimulatorNativeSidecarLauncher } from "./channel.js";
import { IOSSimulatorNativeSidecarProcessManager } from "./process-manager.js";
import { createIOSSimulatorNativeSidecarSandboxPolicy } from "./sandbox.js";

// Exercise production launch-option construction without spawning Apple tools,
// changing xcode-select, or operating any real simulator on any CI platform.
vi.mock("./channel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel.js")>();
  return {
    ...actual,
    createNodeIOSSimulatorNativeSidecarLauncher: vi.fn(
      actual.createNodeIOSSimulatorNativeSidecarLauncher,
    ),
    IOSSimulatorNativeSidecarChannel: class {
      state = "idle";
      crashCount = 0;
      stderrTail = "";
      lastTermination = null;
      retirement = null;
      async start() {
        this.state = "running";
      }
      async restart() {
        this.state = "running";
      }
      async stop() {
        this.state = "stopped";
      }
      async request(command: {
        op: string;
        simulatorUdid: string;
        generation: number;
      }) {
        if (command.op !== "handshake") return { ready: true, message: null };
        return {
          protocolVersion: 1,
          simulatorUdid: command.simulatorUdid,
          generation: command.generation,
          ready: true,
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
        };
      }
    },
  };
});

describe("Native inspected toolchain binding", () => {
  it("uses the inspected directory for launch and retains it during recovery", async () => {
    const developerDirectory = "/Applications/Xcode A.app/Contents/Developer";
    const environment = {
      DEVELOPER_DIR: "/Applications/Xcode B.app/Contents/Developer",
    };
    const start = {
      instanceId: "toolchain-test",
      simulatorUdid: "A1B2C3D4-1111-2222-3333-444455556666",
      generation: 1,
      runtime: {
        runtimeIdentifier: "runtime",
        runtimeBuildVersion: "build",
        xcodeBuild: "Xcode A",
        architecture: "arm64" as const,
        developerDirectory,
      },
    };
    const admissionPolicy = vi.fn(() =>
      createIOSSimulatorNativeDevelopmentAdmissionPolicy(),
    );
    const manager = new IOSSimulatorNativeSidecarProcessManager({
      binaryPath: process.execPath,
      environment,
      admissionPolicy,
      sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
        required: false,
        platform: "darwin",
        // Model macOS paths explicitly, even when the test host is Windows.
        homeDirectory: "/Users/example",
        temporaryRoot: "/private/tmp",
      }),
    });
    vi.mocked(createNodeIOSSimulatorNativeSidecarLauncher).mockClear();
    try {
      await manager.start(start);
      expect(admissionPolicy).toHaveBeenCalledWith(start);
      expect(createNodeIOSSimulatorNativeSidecarLauncher).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ DEVELOPER_DIR: developerDirectory }),
        }),
      );
      environment.DEVELOPER_DIR =
        "/Applications/Xcode C.app/Contents/Developer";
      await manager.recover(start);
      expect(
        createNodeIOSSimulatorNativeSidecarLauncher,
      ).toHaveBeenCalledOnce();
      expect(admissionPolicy).toHaveBeenLastCalledWith(start);
    } finally {
      await manager.stop(start.instanceId);
    }
  });
});
