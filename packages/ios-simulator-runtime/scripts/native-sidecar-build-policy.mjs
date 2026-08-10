export const IOS_SIMULATOR_HELPER_BUILD_RESULT_FILENAME = "build-result.json";
export const IOS_SIMULATOR_HELPER_UNSUPPORTED_REASON =
  "simulator-kit-architecture-unavailable";

export function parseMachOArchitectures(value) {
  return [
    ...new Set(
      String(value ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ];
}

function simulatorKitSupportsArchitecture(architectures, targetArchitecture) {
  if (targetArchitecture === "arm64") {
    return architectures.includes("arm64") || architectures.includes("arm64e");
  }
  return architectures.includes(targetArchitecture);
}

export function decideNativeSidecarBuild({
  outputMode,
  targetArchitecture,
  simulatorKitArchitectures,
}) {
  const targetArchitectures =
    targetArchitecture === "universal"
      ? ["x86_64", "arm64"]
      : [targetArchitecture];
  const missingArchitectures = targetArchitectures.filter(
    (candidate) =>
      !simulatorKitSupportsArchitecture(simulatorKitArchitectures, candidate),
  );

  if (missingArchitectures.length === 0) {
    return { action: "build", targetArchitectures };
  }

  if (
    outputMode === "helper" &&
    targetArchitecture === "x86_64" &&
    missingArchitectures.length === 1 &&
    missingArchitectures[0] === "x86_64"
  ) {
    return {
      action: "unsupported",
      targetArchitectures,
      reason: IOS_SIMULATOR_HELPER_UNSUPPORTED_REASON,
    };
  }

  throw new Error(
    `SimulatorKit is missing required architecture(s): ${missingArchitectures.join(", ")}`,
  );
}
