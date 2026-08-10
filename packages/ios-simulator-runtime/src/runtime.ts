import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorRuntimeError } from "./errors.js";
import { isIOSSimulatorPendingCreateName } from "./simctl-lifecycle.js";
import { parseSimctlListJson } from "./simctl-parser.js";
import path from "node:path";
import type {
  IOSSimulatorCommandRunner,
  IOSSimulatorEnvironmentReport,
  IOSSimulatorRuntime,
  IOSSimulatorRuntimeErrorCode,
} from "./types.js";

const XCRUN = "/usr/bin/xcrun";
const XCODE_SELECT = "/usr/bin/xcode-select";
const XCODEBUILD = "/usr/bin/xcodebuild";

export interface CreateIOSSimulatorRuntimeOptions {
  platform?: NodeJS.Platform;
  commandRunner?: IOSSimulatorCommandRunner;
  /**
   * Inspects one exact Xcode installation without mutating the machine-wide
   * xcode-select setting. Compatibility matrix jobs use this to keep cases
   * isolated from one another.
   */
  developerDir?: string;
}

function unavailableReport(
  platform: NodeJS.Platform,
  issue: IOSSimulatorRuntimeErrorCode,
  error: string,
  setupSteps: string[],
  partial: Partial<IOSSimulatorEnvironmentReport> = {},
): IOSSimulatorEnvironmentReport {
  return {
    platform,
    supported: platform === "darwin",
    ready: false,
    xcodeSelectPath: null,
    xcodeVersion: null,
    runtimes: [],
    devices: [],
    issue,
    error,
    setupSteps,
    ...partial,
  };
}

function commandError(command: string, stderr: string): string {
  const detail = stderr.trim();
  return detail ? `${command} failed: ${detail}` : `${command} failed`;
}

/** Create the host-neutral simulator discovery module. */
export function createIOSSimulatorRuntime(
  options: CreateIOSSimulatorRuntimeOptions = {},
): IOSSimulatorRuntime {
  const platform = options.platform ?? process.platform;
  const runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
  const requestedDeveloperDir =
    options.developerDir ?? process.env.DEVELOPER_DIR?.trim() ?? null;

  return {
    async inspect(
      signal?: AbortSignal,
    ): Promise<IOSSimulatorEnvironmentReport> {
      if (platform !== "darwin") {
        return unavailableReport(
          platform,
          "UNSUPPORTED_PLATFORM",
          "Apple iOS Simulator is only available on macOS.",
          ["Open this project in a local Cindy session on macOS."],
        );
      }

      if (
        requestedDeveloperDir !== null &&
        (!requestedDeveloperDir || !path.isAbsolute(requestedDeveloperDir))
      ) {
        return unavailableReport(
          platform,
          "XCODE_NOT_FOUND",
          "DEVELOPER_DIR must be an absolute Xcode Developer directory.",
          ["Select an absolute Xcode.app/Contents/Developer directory."],
        );
      }
      const commandOptions =
        requestedDeveloperDir || signal
          ? {
              ...(requestedDeveloperDir
                ? {
                    env: {
                      ...process.env,
                      DEVELOPER_DIR: requestedDeveloperDir,
                    },
                  }
                : {}),
              ...(signal ? { signal } : {}),
            }
          : undefined;
      let xcodeSelectPath = requestedDeveloperDir;
      if (xcodeSelectPath === null) {
        const selected = await runner.run(XCODE_SELECT, ["-p"], commandOptions);
        if (selected.exitCode !== 0 || !selected.stdout.trim()) {
          return unavailableReport(
            platform,
            "XCODE_NOT_FOUND",
            commandError("xcode-select -p", selected.stderr),
            [
              "Install Xcode.",
              "Open Xcode once and select its developer tools.",
            ],
          );
        }
        xcodeSelectPath = selected.stdout.trim();
      }

      const version = await runner.run(
        XCODEBUILD,
        ["-version"],
        commandOptions,
      );
      if (version.exitCode !== 0) {
        return unavailableReport(
          platform,
          "XCODE_NOT_FOUND",
          commandError("xcodebuild -version", version.stderr),
          [
            "Install or repair Xcode.",
            "Run xcode-select to choose the active Xcode installation.",
          ],
          { xcodeSelectPath },
        );
      }
      const xcodeVersion = version.stdout.trim() || null;

      const listed = await runner.run(
        XCRUN,
        ["simctl", "list", "-j"],
        commandOptions,
      );
      if (listed.exitCode !== 0) {
        return unavailableReport(
          platform,
          "SIMCTL_FAILED",
          commandError("xcrun simctl list -j", listed.stderr),
          ["Open Xcode and verify the iOS platform is installed."],
          { xcodeSelectPath, xcodeVersion },
        );
      }

      try {
        const parsed = parseSimctlListJson(listed.stdout);
        const availableRuntimes = parsed.runtimes.filter(
          (runtime) => runtime.isAvailable,
        );
        const visibleDevices = parsed.devices.filter(
          (device) => !isIOSSimulatorPendingCreateName(device.name),
        );
        const availableDevices = visibleDevices.filter(
          (device) => device.isAvailable,
        );
        if (availableRuntimes.length === 0) {
          return unavailableReport(
            platform,
            "IOS_RUNTIME_NOT_FOUND",
            "Xcode has no available iOS Simulator runtime.",
            [
              "Install an iOS Simulator runtime in Xcode Settings.",
              "Or run xcodebuild -downloadPlatform iOS.",
            ],
            {
              xcodeSelectPath,
              xcodeVersion,
              runtimes: parsed.runtimes,
              devices: visibleDevices,
            },
          );
        }
        if (availableDevices.length === 0) {
          return unavailableReport(
            platform,
            "NO_SIMULATOR_DEVICES",
            "Xcode has no available simulated iPhone or iPad.",
            [
              "Create a simulator in Xcode under Window > Devices and Simulators.",
            ],
            {
              xcodeSelectPath,
              xcodeVersion,
              runtimes: parsed.runtimes,
              devices: visibleDevices,
            },
          );
        }
        return {
          platform,
          supported: true,
          ready: true,
          xcodeSelectPath,
          xcodeVersion,
          runtimes: parsed.runtimes,
          devices: visibleDevices,
          issue: null,
          error: null,
          setupSteps: [],
        };
      } catch (error) {
        const normalized =
          error instanceof IOSSimulatorRuntimeError
            ? error
            : new IOSSimulatorRuntimeError(
                "INVALID_SIMCTL_OUTPUT",
                error instanceof Error ? error.message : String(error),
              );
        return unavailableReport(
          platform,
          normalized.code,
          normalized.message,
          ["Restart Xcode and retry simulator discovery."],
          { xcodeSelectPath, xcodeVersion },
        );
      }
    },
  };
}
