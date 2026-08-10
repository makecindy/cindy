import os from "node:os";
import path from "node:path";

export const IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_PROFILE_VERSION = 1 as const;
export const IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_EXECUTABLE =
  "/usr/bin/sandbox-exec";

export type IOSSimulatorNativeSidecarSandboxReasonCode =
  | "SANDBOX_ENFORCED"
  | "SANDBOX_NOT_REQUIRED"
  | "SANDBOX_UNAVAILABLE"
  | "SANDBOX_UNSUPPORTED_PLATFORM"
  | "SANDBOX_PROFILE_INVALID"
  | "SANDBOX_PROCESS_FAILED";

export interface IOSSimulatorNativeSidecarSandboxDiagnostics {
  required: boolean;
  enforced: boolean;
  profileVersion: typeof IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_PROFILE_VERSION;
  reasonCode: IOSSimulatorNativeSidecarSandboxReasonCode;
  reason: string;
}

export interface IOSSimulatorNativeSidecarSandboxPolicy {
  required: boolean;
  platform: NodeJS.Platform;
  sandboxExecutablePath: string;
  homeDirectory: string;
  developerDirectory: string;
  coreSimulatorRoot: string;
  temporaryRoot: string;
}

export interface IOSSimulatorNativeSidecarSandboxPolicyInput {
  required?: boolean;
  platform?: NodeJS.Platform;
  sandboxExecutablePath?: string;
  developerDirectory?: string;
  coreSimulatorRoot?: string;
  temporaryRoot?: string;
  homeDirectory?: string;
}

export interface IOSSimulatorNativeSidecarSandboxLaunchInput {
  policy: IOSSimulatorNativeSidecarSandboxPolicy;
  binaryPath: string;
  simulatorUdid: string;
  architecture: "arm64" | "x86_64";
  temporaryDirectory: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
}

export interface IOSSimulatorNativeSidecarSandboxLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  diagnostics: IOSSimulatorNativeSidecarSandboxDiagnostics;
}

export class IOSSimulatorNativeSidecarSandboxError extends Error {
  constructor(
    readonly code: "SANDBOX_UNSUPPORTED_PLATFORM" | "SANDBOX_PROFILE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "IOSSimulatorNativeSidecarSandboxError";
  }
}

const EXACT_SIMULATOR_UDID =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

type PathDialect = Pick<
  typeof path.posix,
  "isAbsolute" | "join" | "normalize" | "relative" | "sep"
>;

function requireAbsolutePath(
  value: string,
  name: string,
  dialect: PathDialect = path,
): string {
  const normalized = dialect.normalize(value);
  if (!dialect.isAbsolute(normalized)) {
    throw new IOSSimulatorNativeSidecarSandboxError(
      "SANDBOX_PROFILE_INVALID",
      `${name} must be absolute`,
    );
  }
  return normalized;
}

function requireContainedPath(
  value: string,
  parent: string,
  name: string,
  dialect: PathDialect = path,
): string {
  const normalized = requireAbsolutePath(value, name, dialect);
  const relative = dialect.relative(parent, normalized);
  if (
    relative === "" ||
    relative.startsWith(`..${dialect.sep}`) ||
    relative === ".." ||
    dialect.isAbsolute(relative)
  ) {
    throw new IOSSimulatorNativeSidecarSandboxError(
      "SANDBOX_PROFILE_INVALID",
      `${name} must be a private child of its configured root`,
    );
  }
  return normalized;
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function pathRule(
  operation: string,
  filter: "literal" | "subpath" | "path-ancestors",
  value: string,
): string {
  return `(allow ${operation} (${filter} ${sbplString(value)}))`;
}

export function createIOSSimulatorNativeSidecarSandboxPolicy(
  input: IOSSimulatorNativeSidecarSandboxPolicyInput = {},
): IOSSimulatorNativeSidecarSandboxPolicy {
  const platform = input.platform ?? process.platform;
  const dialect: PathDialect = platform === "darwin" ? path.posix : path;
  const homeDirectory = requireAbsolutePath(
    input.homeDirectory ?? os.homedir(),
    "homeDirectory",
    dialect,
  );
  return Object.freeze({
    required: input.required ?? true,
    platform,
    sandboxExecutablePath: requireAbsolutePath(
      input.sandboxExecutablePath ??
        IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_EXECUTABLE,
      "sandboxExecutablePath",
      dialect,
    ),
    homeDirectory,
    developerDirectory: requireAbsolutePath(
      input.developerDirectory ??
        process.env.DEVELOPER_DIR ??
        "/Applications/Xcode.app/Contents/Developer",
      "developerDirectory",
      dialect,
    ),
    coreSimulatorRoot: requireAbsolutePath(
      input.coreSimulatorRoot ??
        dialect.join(homeDirectory, "Library", "Developer", "CoreSimulator"),
      "coreSimulatorRoot",
      dialect,
    ),
    temporaryRoot: requireAbsolutePath(
      input.temporaryRoot ?? os.tmpdir(),
      "temporaryRoot",
      dialect,
    ),
  });
}

export function createIOSSimulatorNativeSidecarUnsandboxedDiagnostics(): IOSSimulatorNativeSidecarSandboxDiagnostics {
  return Object.freeze({
    required: false,
    enforced: false,
    profileVersion: IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_PROFILE_VERSION,
    reasonCode: "SANDBOX_NOT_REQUIRED",
    reason: "The host did not require the native sidecar OS sandbox.",
  });
}

export function createIOSSimulatorNativeSidecarSandboxFailureDiagnostics(
  code: Exclude<
    IOSSimulatorNativeSidecarSandboxReasonCode,
    "SANDBOX_ENFORCED" | "SANDBOX_NOT_REQUIRED"
  >,
): IOSSimulatorNativeSidecarSandboxDiagnostics {
  const reason =
    code === "SANDBOX_UNAVAILABLE"
      ? "The required native sidecar OS sandbox is unavailable."
      : code === "SANDBOX_UNSUPPORTED_PLATFORM"
        ? "The native sidecar OS sandbox is unsupported on this platform."
        : code === "SANDBOX_PROFILE_INVALID"
          ? "The native sidecar OS sandbox profile is invalid."
          : "The sandboxed native sidecar process failed.";
  return Object.freeze({
    required: true,
    enforced: code === "SANDBOX_PROCESS_FAILED",
    profileVersion: IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_PROFILE_VERSION,
    reasonCode: code,
    reason,
  });
}

/**
 * Builds a per-device deny-by-default Seatbelt profile. The profile has no
 * network allow rule, cannot spawn children, cannot inspect or signal other
 * processes, and can write only to CoreSimulator state or the host-created
 * private temp directory.
 */
export function createIOSSimulatorNativeSidecarSandboxProfile(
  input: Omit<
    IOSSimulatorNativeSidecarSandboxLaunchInput,
    "args" | "environment"
  >,
): string {
  const { policy } = input;
  if (policy.platform !== "darwin") {
    throw new IOSSimulatorNativeSidecarSandboxError(
      "SANDBOX_UNSUPPORTED_PLATFORM",
      "Native sidecar sandboxing is supported only on macOS",
    );
  }
  const dialect = path.posix;
  const binaryPath = requireAbsolutePath(
    input.binaryPath,
    "binaryPath",
    dialect,
  );
  const developerDirectory = requireAbsolutePath(
    policy.developerDirectory,
    "developerDirectory",
    dialect,
  );
  const coreSimulatorRoot = requireAbsolutePath(
    policy.coreSimulatorRoot,
    "coreSimulatorRoot",
    dialect,
  );
  const temporaryRoot = requireAbsolutePath(
    policy.temporaryRoot,
    "temporaryRoot",
    dialect,
  );
  const temporaryDirectory = requireContainedPath(
    input.temporaryDirectory,
    temporaryRoot,
    "temporaryDirectory",
    dialect,
  );
  const simulatorUdid = input.simulatorUdid.toUpperCase();
  if (!EXACT_SIMULATOR_UDID.test(simulatorUdid)) {
    throw new IOSSimulatorNativeSidecarSandboxError(
      "SANDBOX_PROFILE_INVALID",
      "simulatorUdid must be an exact canonical UDID",
    );
  }

  const simDeviceService = `com.apple.CoreSimulator.SimDevice.${simulatorUdid}`;
  const simLaunchHostService = `com.apple.CoreSimulator.SimLaunchHost-${
    input.architecture === "arm64" ? "arm64" : "x86"
  }`;

  return [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    '(import "com.apple.corefoundation.sb")',
    "(corefoundation)",
    "",
    "; The helper may execute only itself; it cannot spawn tools or shells.",
    pathRule("process-exec*", "literal", binaryPath),
    "(allow process-info* (target self))",
    "(allow sysctl-read)",
    "",
    "; Dynamic linker, Swift runtime, system frameworks, and private simulator frameworks.",
    "(allow file-read* file-test-existence file-map-executable",
    '  (subpath "/System")',
    '  (subpath "/usr/lib")',
    '  (subpath "/usr/share")',
    '  (subpath "/Library/Apple")',
    '  (subpath "/Library/Developer/CoreSimulator")',
    '  (subpath "/Library/Developer/DeviceKit")',
    '  (subpath "/Library/Developer/PrivateFrameworks")',
    `  (subpath ${sbplString(developerDirectory)})`,
    `  (literal ${sbplString(binaryPath)}))`,
    pathRule(
      "file-read-metadata file-test-existence",
      "path-ancestors",
      binaryPath,
    ),
    pathRule(
      "file-read-metadata file-test-existence",
      "path-ancestors",
      developerDirectory,
    ),
    pathRule(
      "file-read-metadata file-test-existence",
      "path-ancestors",
      "/Library/Developer/CoreSimulator",
    ),
    "(allow file-read* file-test-existence",
    '  (literal "/dev/null")',
    '  (literal "/dev/random")',
    '  (literal "/dev/urandom")',
    '  (literal "/private/etc/localtime")',
    '  (literal "/private/etc/passwd"))',
    '(allow file-read-data file-write-data file-test-existence (subpath "/dev/fd"))',
    "",
    "; CoreSimulator owns its device-set subscriptions, logs, and transient state.",
    pathRule(
      "file-read* file-write* file-test-existence",
      "subpath",
      coreSimulatorRoot,
    ),
    pathRule(
      "file-read-metadata file-test-existence",
      "path-ancestors",
      coreSimulatorRoot,
    ),
    "",
    "; All helper-owned transient state is isolated to one mode-0700 directory.",
    pathRule(
      "file-read* file-write* file-test-existence",
      "subpath",
      temporaryDirectory,
    ),
    pathRule(
      "file-read-metadata file-test-existence",
      "path-ancestors",
      temporaryDirectory,
    ),
    "",
    "; Exact CoreSimulator services for the selected device and architecture.",
    "(allow mach-lookup",
    '  (global-name "com.apple.CoreSimulator.CoreSimulatorService")',
    '  (global-name "com.apple.CARenderServer")',
    '  (global-name "com.apple.coreservices.launchservicesd")',
    '  (global-name "com.apple.cfprefsd.agent")',
    '  (global-name "com.apple.diagnosticd")',
    '  (global-name "com.apple.logd")',
    '  (global-name "com.apple.system.opendirectoryd.libinfo")',
    '  (global-name "com.apple.system.notification_center")',
    '  (global-name "com.apple.powerlog.plxpclogger.xpc")',
    '  (global-name "com.apple.tccd.system")',
    '  (global-name "com.apple.trustd.agent")',
    '  (global-name "com.apple.windowserver.active")',
    `  (global-name ${sbplString(simDeviceService)})`,
    `  (global-name ${sbplString(simLaunchHostService)})`,
    '  (local-name "com.apple.cfprefsd.agent")',
    '  (xpc-service-name "com.apple.CoreSimulator.CoreSimulatorService")',
    '  (xpc-service-name "com.apple.coremedia.videoencoder"))',
    "(allow user-preference-read",
    '  (preference-domain "com.apple.CoreSimulator")',
    '  (preference-domain "com.apple.universalaccess")',
    '  (preference-domain "kCFPreferencesAnyApplication"))',
    '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
    "",
    "; IOSurface and hardware VideoToolbox clients; property mutation is not allowed.",
    "(allow iokit-open-service",
    '  (iokit-registry-entry-class "IOAccelerator" "IOSurfaceRoot"))',
    "(allow iokit-open-user-client",
    '  (iokit-connection "IOAccelerator")',
    '  (iokit-user-client-class "AGXDeviceUserClient"',
    '                           "AppleAVE2UserClient"',
    '                           "IOSurfaceAcceleratorClient"',
    '                           "IOSurfaceRootUserClient"',
    '                           "IOSurfaceSendRight"))',
    "",
  ].join("\n");
}

export function createIOSSimulatorNativeSidecarSandboxLaunchPlan(
  input: IOSSimulatorNativeSidecarSandboxLaunchInput,
): IOSSimulatorNativeSidecarSandboxLaunchPlan {
  if (!input.policy.required) {
    return {
      command: input.binaryPath,
      args: [...input.args],
      cwd: input.temporaryDirectory,
      environment: { ...input.environment },
      diagnostics: createIOSSimulatorNativeSidecarUnsandboxedDiagnostics(),
    };
  }
  const profile = createIOSSimulatorNativeSidecarSandboxProfile(input);
  const environment: NodeJS.ProcessEnv = {
    PATH: input.environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: input.environment.LANG ?? "en_US.UTF-8",
    HOME: input.policy.homeDirectory,
    DEVELOPER_DIR: input.policy.developerDirectory,
    TMPDIR: `${input.temporaryDirectory}${path.posix.sep}`,
    CINDY_IOS_SIDECAR_METAL_CACHE_DIR: path.posix.join(
      input.temporaryDirectory,
      "metal-cache",
    ),
  };
  if (input.environment.LC_ALL) {
    environment.LC_ALL = input.environment.LC_ALL;
  }
  return {
    command: input.policy.sandboxExecutablePath,
    args: ["-p", profile, input.binaryPath, ...input.args],
    cwd: input.temporaryDirectory,
    environment,
    diagnostics: Object.freeze({
      required: true,
      enforced: true,
      profileVersion: IOS_SIMULATOR_NATIVE_SIDECAR_SANDBOX_PROFILE_VERSION,
      reasonCode: "SANDBOX_ENFORCED",
      reason: "The native sidecar is running under the required OS sandbox.",
    }),
  };
}
