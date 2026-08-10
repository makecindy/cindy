import path from "node:path";

export const IOS_SIMULATOR_NATIVE_SIDECAR_EXECUTABLE = "ios-simulator-sidecar";
export const IOS_SIMULATOR_NATIVE_HELPER_BUNDLE =
  "Cindy iOS Simulator Helper.app";

/** Returns the source-tree binary used by Desktop development and native smoke tests. */
export function iosSimulatorNativeDevelopmentSidecarPath(
  resourceRoot: string,
  architecture: "arm64" | "x86_64",
): string {
  return path.join(
    resourceRoot,
    "ios-simulator",
    "native",
    architecture,
    IOS_SIMULATOR_NATIVE_SIDECAR_EXECUTABLE,
  );
}

/**
 * Returns the Host-owned nested helper executable in a packaged Cindy app.
 * The caller must validate that `resourceRoot` is the trusted Electron resource root.
 */
export function iosSimulatorPackagedHelperExecutablePath(
  resourceRoot: string,
): string {
  return path.join(
    path.dirname(resourceRoot),
    "Helpers",
    IOS_SIMULATOR_NATIVE_HELPER_BUNDLE,
    "Contents",
    "MacOS",
    IOS_SIMULATOR_NATIVE_SIDECAR_EXECUTABLE,
  );
}
