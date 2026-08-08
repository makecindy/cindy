/** Stable business error codes returned by the host-neutral discovery runtime. */
export const IOS_SIMULATOR_RUNTIME_ERROR_CODES = [
  "UNSUPPORTED_PLATFORM",
  "XCODE_NOT_FOUND",
  "SIMCTL_FAILED",
  "INVALID_SIMCTL_OUTPUT",
  "IOS_RUNTIME_NOT_FOUND",
  "NO_SIMULATOR_DEVICES",
] as const;

export type IOSSimulatorRuntimeErrorCode =
  (typeof IOS_SIMULATOR_RUNTIME_ERROR_CODES)[number];

/** One installed Apple simulator runtime, such as iOS 26.4. */
export interface IOSSimulatorRuntimeInfo {
  identifier: string;
  name: string;
  version: string | null;
  buildVersion: string | null;
  isAvailable: boolean;
  availabilityError: string | null;
}

/** A simulated iPhone or iPad returned by `simctl list -j`. */
export interface IOSSimulatorDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  availabilityError: string | null;
  runtimeIdentifier: string;
  runtimeName: string;
  runtimeVersion: string | null;
  deviceTypeIdentifier: string | null;
  lastBootedAt: string | null;
}

/** Actionable environment snapshot consumed by MCP, IPC, and the pane. */
export interface IOSSimulatorEnvironmentReport {
  platform: NodeJS.Platform;
  supported: boolean;
  ready: boolean;
  xcodeSelectPath: string | null;
  xcodeVersion: string | null;
  runtimes: IOSSimulatorRuntimeInfo[];
  devices: IOSSimulatorDevice[];
  issue: IOSSimulatorRuntimeErrorCode | null;
  error: string | null;
  setupSteps: string[];
}

/** Bounded subprocess result. The runtime never invokes a shell. */
export interface IOSSimulatorCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Earlier output was discarded after the bounded rolling buffer filled. */
  outputTruncated?: boolean;
}

export interface IOSSimulatorCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: {
      timeoutMs?: number;
      maxBufferBytes?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
    },
  ): Promise<IOSSimulatorCommandResult>;
}

/** Public module interface. Tooling details remain hidden behind one inspection call. */
export interface IOSSimulatorRuntime {
  inspect(): Promise<IOSSimulatorEnvironmentReport>;
}
