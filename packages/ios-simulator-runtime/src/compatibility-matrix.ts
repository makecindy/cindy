import type { IOSSimulatorRuntimeInfo } from "./types.js";
import type { IOSSimulatorNativeCompatibilityVerdict } from "./capability-admission.js";

export type IOSSimulatorNativeArchitecture = "arm64" | "x86_64";
export type IOSSimulatorCompatibilityCaseStatus =
  "passed" | "degraded" | "failed";

export interface IOSSimulatorCompatibilityCheck {
  ok: boolean;
  skipped?: boolean;
}

export interface IOSSimulatorCompatibilityCaseEvaluation {
  status: IOSSimulatorCompatibilityCaseStatus;
  reasons: string[];
  wdaBaselineReady: boolean;
  nativeReady: boolean;
  fallbackReady: boolean;
  releaseRoute: "native-opt-in-eligible" | "wda-mjpeg";
}

export interface EvaluateIOSSimulatorCompatibilityCaseInput {
  wdaSmoke: IOSSimulatorCompatibilityCheck;
  wdaRecovery?: IOSSimulatorCompatibilityCheck | null;
  nativeBuild: IOSSimulatorCompatibilityCheck;
  nativeProbe: IOSSimulatorCompatibilityCheck;
  nativeHid: IOSSimulatorCompatibilityCheck;
  requireNative: boolean;
}

export interface IOSSimulatorNativeReleaseCompatibilityInput {
  hostOsRelease: string;
  xcodeVersion: string | null;
  runtimeIdentifier: string;
  runtimeBuildVersion: string | null;
  architecture: IOSSimulatorNativeArchitecture;
}

export interface IOSSimulatorNativeReleaseCompatibilityDecision {
  matrixVersion: number;
  matchedCaseId: string | null;
  sidecar: IOSSimulatorNativeCompatibilityVerdict;
  h264Stream: IOSSimulatorNativeCompatibilityVerdict;
  continuousInput: IOSSimulatorNativeCompatibilityVerdict;
  multiTouch: IOSSimulatorNativeCompatibilityVerdict;
}

interface IOSSimulatorNativeReleaseCompatibilityCase {
  id: string;
  hostOsRelease: string;
  xcodeProductVersion: string;
  xcodeBuildVersion: string;
  runtimeIdentifier: string;
  runtimeBuildVersion: string;
  architecture: IOSSimulatorNativeArchitecture;
  capabilities: {
    sidecar: boolean;
    h264Stream: boolean;
    continuousInput: boolean;
    multiTouch: boolean;
  };
}

export const IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_VERSION = 1;

/**
 * Host-owned release promotion registry. Entries are exact combinations that
 * completed the sandboxed framebuffer, H.264, HID, recovery, and WDA fallback
 * gates. New Xcode or runtime builds stay unknown until their evidence is
 * reviewed and a new exact entry is checked in.
 */
const IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_CASES =
  Object.freeze<readonly IOSSimulatorNativeReleaseCompatibilityCase[]>([
    {
      id: "darwin-25.3.0_xcode-26.4-17E192_ios-26.4-23E244_arm64",
      hostOsRelease: "25.3.0",
      xcodeProductVersion: "26.4",
      xcodeBuildVersion: "17E192",
      runtimeIdentifier:
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      runtimeBuildVersion: "23E244",
      architecture: "arm64",
      capabilities: {
        sidecar: true,
        h264Stream: true,
        continuousInput: true,
        multiTouch: true,
      },
    },
  ]);

export class IOSSimulatorCompatibilityMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IOSSimulatorCompatibilityMatrixError";
  }
}

/** Parses a bounded, comma-separated selector list used by local and CI jobs. */
export function parseIOSSimulatorCompatibilitySelectors(
  value: string | undefined,
  name: string,
): string[] | null {
  if (!value?.trim()) return null;
  const selectors = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (selectors.length === 0) return null;
  if (selectors.length > 32 || selectors.some((item) => item.length > 256)) {
    throw new IOSSimulatorCompatibilityMatrixError(
      `${name} contains too many or oversized selectors`,
    );
  }
  return selectors;
}

/** Selects exact runtimes, or an oldest/middle/latest default matrix. */
export function selectIOSSimulatorCompatibilityRuntimes(
  runtimes: readonly IOSSimulatorRuntimeInfo[],
  selectors: readonly string[] | null,
): IOSSimulatorRuntimeInfo[] {
  const available = runtimes.filter(
    (runtime) =>
      runtime.isAvailable && runtime.identifier.includes(".SimRuntime.iOS-"),
  );
  if (selectors) {
    return selectors.map((selector) => {
      const match = available.find(
        (runtime) =>
          runtime.identifier === selector ||
          runtime.version === selector ||
          runtime.name === selector,
      );
      if (!match) {
        throw new IOSSimulatorCompatibilityMatrixError(
          `Requested iOS runtime is not available: ${selector}`,
        );
      }
      return match;
    });
  }
  const sorted = available
    .slice()
    .sort((left, right) =>
      compareIOSSimulatorVersions(left.version, right.version),
    );
  const picks = [
    sorted[0],
    sorted[Math.floor(sorted.length / 2)],
    sorted.at(-1),
  ].filter((runtime): runtime is IOSSimulatorRuntimeInfo => Boolean(runtime));
  return [
    ...new Map(picks.map((runtime) => [runtime.identifier, runtime])).values(),
  ];
}

/** Resolves sidecar architecture axes without accepting arbitrary target strings. */
export function selectIOSSimulatorNativeArchitectures(
  hostArchitecture: NodeJS.Architecture,
  selectors: readonly string[] | null,
): IOSSimulatorNativeArchitecture[] {
  const host =
    hostArchitecture === "arm64"
      ? "arm64"
      : hostArchitecture === "x64"
        ? "x86_64"
        : null;
  if (!selectors) {
    if (!host) {
      throw new IOSSimulatorCompatibilityMatrixError(
        `Unsupported native sidecar host architecture: ${hostArchitecture}`,
      );
    }
    return [host];
  }
  const normalized = selectors.map((selector) => {
    if (selector === "arm64" || selector === "x86_64") return selector;
    throw new IOSSimulatorCompatibilityMatrixError(
      `Unsupported native sidecar architecture: ${selector}`,
    );
  });
  return [...new Set(normalized)];
}

/** Produces the release-safe verdict for one Xcode/runtime/architecture case. */
export function evaluateIOSSimulatorCompatibilityCase(
  input: EvaluateIOSSimulatorCompatibilityCaseInput,
): IOSSimulatorCompatibilityCaseEvaluation {
  const reasons: string[] = [];
  const recoveryReady =
    input.wdaRecovery === undefined ||
    input.wdaRecovery === null ||
    input.wdaRecovery.skipped === true ||
    input.wdaRecovery.ok;
  const wdaBaselineReady = input.wdaSmoke.ok && recoveryReady;
  if (!input.wdaSmoke.ok) reasons.push("WDA_SMOKE_FAILED");
  if (!recoveryReady) reasons.push("WDA_RECOVERY_FAILED");

  const nativeReady =
    input.nativeBuild.ok && input.nativeProbe.ok && input.nativeHid.ok;
  if (!input.nativeBuild.ok) reasons.push("NATIVE_BUILD_FAILED");
  if (!input.nativeProbe.ok) reasons.push("NATIVE_PROBE_FAILED");
  if (!input.nativeHid.ok) {
    reasons.push(
      input.nativeHid.skipped ? "NATIVE_HID_SKIPPED" : "NATIVE_HID_FAILED",
    );
  }

  const fallbackReady = wdaBaselineReady;
  const status: IOSSimulatorCompatibilityCaseStatus = !wdaBaselineReady
    ? "failed"
    : nativeReady
      ? "passed"
      : input.requireNative
        ? "failed"
        : "degraded";
  return {
    status,
    reasons,
    wdaBaselineReady,
    nativeReady,
    fallbackReady,
    releaseRoute: nativeReady ? "native-opt-in-eligible" : "wda-mjpeg",
  };
}

function parseXcodeIdentity(value: string | null): {
  productVersion: string;
  buildVersion: string;
} | null {
  if (!value) return null;
  const productVersion = value.match(/^Xcode\s+([^\s]+)\s*$/m)?.[1] ?? null;
  const buildVersion =
    value.match(/^Build version\s+([A-Za-z0-9._-]+)\s*$/m)?.[1] ?? null;
  if (!productVersion || !buildVersion) return null;
  return { productVersion, buildVersion };
}

function promotedVerdict(
  value: boolean,
): IOSSimulatorNativeCompatibilityVerdict {
  return value ? "eligible" : "ineligible";
}

/** Resolves only exact, reviewed release combinations; every near miss stays unknown. */
export function resolveIOSSimulatorNativeReleaseCompatibility(
  input: IOSSimulatorNativeReleaseCompatibilityInput,
): IOSSimulatorNativeReleaseCompatibilityDecision {
  const xcode = parseXcodeIdentity(input.xcodeVersion);
  const matched = xcode
    ? IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_CASES.find(
        (entry) =>
          entry.hostOsRelease === input.hostOsRelease &&
          entry.xcodeProductVersion === xcode.productVersion &&
          entry.xcodeBuildVersion === xcode.buildVersion &&
          entry.runtimeIdentifier === input.runtimeIdentifier &&
          entry.runtimeBuildVersion === input.runtimeBuildVersion &&
          entry.architecture === input.architecture,
      )
    : null;
  if (!matched) {
    return {
      matrixVersion: IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_VERSION,
      matchedCaseId: null,
      sidecar: "unknown",
      h264Stream: "unknown",
      continuousInput: "unknown",
      multiTouch: "unknown",
    };
  }
  return {
    matrixVersion: IOS_SIMULATOR_NATIVE_RELEASE_COMPATIBILITY_VERSION,
    matchedCaseId: matched.id,
    sidecar: promotedVerdict(matched.capabilities.sidecar),
    h264Stream: promotedVerdict(matched.capabilities.h264Stream),
    continuousInput: promotedVerdict(
      matched.capabilities.continuousInput,
    ),
    multiTouch: promotedVerdict(matched.capabilities.multiTouch),
  };
}

export function compareIOSSimulatorVersions(
  left: string | null,
  right: string | null,
): number {
  const parse = (value: string | null) =>
    (value ?? "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
