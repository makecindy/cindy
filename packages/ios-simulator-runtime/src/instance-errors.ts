/** Stable instance-management errors shared by host, MCP, and IPC adapters. */
export const IOS_SIMULATOR_INSTANCE_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INSTANCE_NOT_FOUND",
  "INSTANCE_NOT_OWNED",
  "SIMULATOR_ATTACHED_ELSEWHERE",
  "SESSION_INSTANCE_LIMIT_REACHED",
  "DEVICE_CONTROL_NOT_GRANTED",
  "DEVICE_BUSY",
  "AGENT_MUTATION_PAUSED",
  "MUTATION_CANCELLED",
  "LEASE_EXPIRED",
  "STALE_GENERATION",
  "STALE_UI_SNAPSHOT",
  "UI_WAIT_TIMEOUT",
  "NATIVE_INPUT_UNAVAILABLE",
  "INVALID_INSTANCE_STATE",
  "SIMULATOR_NOT_FOUND",
  "SIMULATOR_BOOT_FAILED",
  "SIMULATOR_BOOT_TIMEOUT",
  "SIMULATOR_SHUTDOWN_FAILED",
  "SIMULATOR_CONTROL_FAILED",
  "SIMULATOR_CREATE_FAILED",
  "SIMULATOR_DELETE_FORBIDDEN",
  "SIMULATOR_DELETE_FAILED",
  "PROJECT_NOT_FOUND",
  "AMBIGUOUS_XCODE_PROJECT",
  "APP_BUILD_FAILED",
  "APP_ARTIFACT_INVALID",
  "APP_INSTALL_FAILED",
  "APP_LAUNCH_FAILED",
  "METRO_NOT_READY",
  "APP_TERMINATE_FAILED",
  "OPEN_URL_FAILED",
  "SCREENSHOT_CAPTURE_FAILED",
  "RESOURCE_LIMIT_REACHED",
  "MEMORY_PRESSURE",
  "RECORDING_ALREADY_ACTIVE",
  "RECORDING_NOT_FOUND",
  "RECORDING_FAILED",
] as const;

export type IOSSimulatorInstanceErrorCode =
  (typeof IOS_SIMULATOR_INSTANCE_ERROR_CODES)[number];

/** Error whose code is safe to expose while raw subprocess details stay internal. */
export class IOSSimulatorInstanceError extends Error {
  constructor(
    readonly code: IOSSimulatorInstanceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IOSSimulatorInstanceError";
  }
}
