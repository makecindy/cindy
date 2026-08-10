import type { IOSSimulatorDriverCapabilities } from "./driver.js";

export type IOSSimulatorNativeHostMode = "development" | "packaged";
export type IOSSimulatorNativeArtifactSource = "bundled" | "plugin";
export type IOSSimulatorNativeArtifactTrust =
  "development" | "verified" | "untrusted";
export type IOSSimulatorNativeCompatibilityVerdict =
  "eligible" | "ineligible" | "unknown";
export type IOSSimulatorNativeResourceAdmission = "allowed" | "denied";
export type IOSSimulatorNativeRuntimeState =
  "idle" | "running" | "failed" | "parked" | "stopped";

export type IOSSimulatorNativeAdmissionReasonCode =
  | "ADMITTED"
  | "AWAITING_PROBE"
  | "NOT_REQUESTED"
  | "NOT_DETECTED"
  | "HOST_UNSUPPORTED"
  | "ARTIFACT_UNTRUSTED"
  | "DEVELOPMENT_ARTIFACT_NOT_ALLOWED"
  | "COMPATIBILITY_INELIGIBLE"
  | "COMPATIBILITY_UNVERIFIED"
  | "RESOURCE_DENIED"
  | "PRODUCT_DISABLED"
  | "DEPENDENCY_DENIED"
  | "PROCESS_NOT_RUNNING"
  | "PROCESS_PARKED";

export interface IOSSimulatorNativeCapabilityAdmissionPolicy {
  host: {
    mode: IOSSimulatorNativeHostMode;
    platform: NodeJS.Platform;
    architecture: NodeJS.Architecture | "x86_64";
  };
  artifact: {
    source: IOSSimulatorNativeArtifactSource;
    trust: IOSSimulatorNativeArtifactTrust;
  };
  compatibility: {
    sidecar: IOSSimulatorNativeCompatibilityVerdict;
    h264Stream: IOSSimulatorNativeCompatibilityVerdict;
    continuousInput: IOSSimulatorNativeCompatibilityVerdict;
    multiTouch: IOSSimulatorNativeCompatibilityVerdict;
  };
  requested: {
    h264Stream: boolean;
    continuousInput: boolean;
  };
  resourceAdmission: IOSSimulatorNativeResourceAdmission;
}

export interface IOSSimulatorNativeCapabilityAdmissionEntry {
  requested: boolean;
  compatible: boolean | null;
  detected: boolean | null;
  policyAllowed: boolean;
  admitted: boolean;
  active: boolean;
  reasonCode: IOSSimulatorNativeAdmissionReasonCode;
  reason: string;
}

export interface IOSSimulatorNativeCapabilityAdmissionDecision {
  generatedAt: string;
  hostMode: IOSSimulatorNativeHostMode;
  artifact: {
    source: IOSSimulatorNativeArtifactSource;
    trust: IOSSimulatorNativeArtifactTrust;
  };
  processState: IOSSimulatorNativeRuntimeState;
  launch: {
    allowed: boolean;
    active: boolean;
    reasonCode: IOSSimulatorNativeAdmissionReasonCode;
    reason: string;
  };
  capabilities: {
    h264Stream: IOSSimulatorNativeCapabilityAdmissionEntry;
    bgraStream: IOSSimulatorNativeCapabilityAdmissionEntry;
    continuousInput: IOSSimulatorNativeCapabilityAdmissionEntry;
    multiTouch: IOSSimulatorNativeCapabilityAdmissionEntry;
  };
  fallbackRoute: "wda-mjpeg";
}

export interface EvaluateIOSSimulatorNativeCapabilityAdmissionInput {
  policy: IOSSimulatorNativeCapabilityAdmissionPolicy;
  detectedCapabilities?: Readonly<IOSSimulatorDriverCapabilities> | null;
  processState?: IOSSimulatorNativeRuntimeState;
  /** Runtime admission soft-opens unknown matrix entries; release probes opt in to strict promotion. */
  requireVerifiedCompatibility?: boolean;
  now?: () => Date;
}

const REASONS: Record<IOSSimulatorNativeAdmissionReasonCode, string> = {
  ADMITTED: "Native capability is admitted and active.",
  AWAITING_PROBE: "Native capability is awaiting the sidecar handshake.",
  NOT_REQUESTED: "Native capability was not requested by host policy.",
  NOT_DETECTED: "The sidecar did not advertise the native capability.",
  HOST_UNSUPPORTED: "Native sidecar is unavailable on this host.",
  ARTIFACT_UNTRUSTED: "Native sidecar artifact is not trusted by the host.",
  DEVELOPMENT_ARTIFACT_NOT_ALLOWED:
    "A development sidecar artifact is not allowed in a packaged client.",
  COMPATIBILITY_INELIGIBLE:
    "The Xcode, runtime, and architecture combination is not eligible.",
  COMPATIBILITY_UNVERIFIED:
    "The native compatibility combination has not been verified.",
  RESOURCE_DENIED: "Runtime resource admission denied native acceleration.",
  PRODUCT_DISABLED: "The native product capability is disabled.",
  DEPENDENCY_DENIED: "A required native capability was not admitted.",
  PROCESS_NOT_RUNNING: "Native sidecar process is not running.",
  PROCESS_PARKED:
    "Native sidecar is parked after repeated failures and requires explicit recovery.",
};

function isSupportedHost(
  policy: IOSSimulatorNativeCapabilityAdmissionPolicy,
): boolean {
  return (
    policy.host.platform === "darwin" &&
    (policy.host.architecture === "arm64" ||
      policy.host.architecture === "x64" ||
      policy.host.architecture === "x86_64")
  );
}

function compatibilityValue(
  verdict: IOSSimulatorNativeCompatibilityVerdict,
): boolean | null {
  if (verdict === "eligible") return true;
  if (verdict === "ineligible") return false;
  return null;
}

function compatibilityGate(
  verdict: IOSSimulatorNativeCompatibilityVerdict,
  requireVerifiedCompatibility: boolean,
): IOSSimulatorNativeAdmissionReasonCode | null {
  if (verdict === "ineligible") return "COMPATIBILITY_INELIGIBLE";
  if (verdict === "unknown" && requireVerifiedCompatibility) {
    return "COMPATIBILITY_UNVERIFIED";
  }
  return null;
}

function launchGate(
  policy: IOSSimulatorNativeCapabilityAdmissionPolicy,
  requireVerifiedCompatibility: boolean,
): IOSSimulatorNativeAdmissionReasonCode | null {
  if (!isSupportedHost(policy)) return "HOST_UNSUPPORTED";
  if (policy.artifact.trust === "untrusted") return "ARTIFACT_UNTRUSTED";
  if (
    policy.host.mode === "packaged" &&
    policy.artifact.trust === "development"
  ) {
    return "DEVELOPMENT_ARTIFACT_NOT_ALLOWED";
  }
  const compatibility = compatibilityGate(
    policy.compatibility.sidecar,
    requireVerifiedCompatibility,
  );
  if (compatibility) return compatibility;
  if (policy.resourceAdmission === "denied") return "RESOURCE_DENIED";
  return null;
}

function inactiveProcessReason(
  state: IOSSimulatorNativeRuntimeState,
): IOSSimulatorNativeAdmissionReasonCode {
  return state === "parked" ? "PROCESS_PARKED" : "PROCESS_NOT_RUNNING";
}

function capabilityEntry(input: {
  requested: boolean;
  compatibility: IOSSimulatorNativeCompatibilityVerdict;
  requireVerifiedCompatibility: boolean;
  detected: boolean | null;
  processState: IOSSimulatorNativeRuntimeState;
  launchDenied: IOSSimulatorNativeAdmissionReasonCode | null;
  dependencyAllowed?: boolean;
  productDisabled?: boolean;
}): IOSSimulatorNativeCapabilityAdmissionEntry {
  let denied = input.launchDenied;
  if (!denied && input.productDisabled) denied = "PRODUCT_DISABLED";
  if (!denied && !input.requested) denied = "NOT_REQUESTED";
  if (!denied) {
    denied = compatibilityGate(
      input.compatibility,
      input.requireVerifiedCompatibility,
    );
  }
  if (!denied && input.dependencyAllowed === false) {
    denied = "DEPENDENCY_DENIED";
  }
  const policyAllowed = denied === null;
  const admitted = policyAllowed && input.detected === true;
  const active = admitted && input.processState === "running";
  let reasonCode: IOSSimulatorNativeAdmissionReasonCode;
  if (denied) {
    reasonCode = denied;
  } else if (input.detected === null) {
    reasonCode =
      input.processState === "idle" || input.processState === "running"
        ? "AWAITING_PROBE"
        : inactiveProcessReason(input.processState);
  } else if (!input.detected) {
    reasonCode = "NOT_DETECTED";
  } else if (!active) {
    reasonCode = inactiveProcessReason(input.processState);
  } else {
    reasonCode = "ADMITTED";
  }
  return {
    requested: input.requested,
    compatible: compatibilityValue(input.compatibility),
    detected: input.detected,
    policyAllowed,
    admitted,
    active,
    reasonCode,
    reason: REASONS[reasonCode],
  };
}

/**
 * Converts host policy plus an untrusted sidecar handshake into the only
 * capability decision that adapters and operation routing may consume.
 */
export function evaluateIOSSimulatorNativeCapabilityAdmission(
  input: EvaluateIOSSimulatorNativeCapabilityAdmissionInput,
): IOSSimulatorNativeCapabilityAdmissionDecision {
  const processState = input.processState ?? "idle";
  const detected = input.detectedCapabilities ?? null;
  const requireVerifiedCompatibility = input.requireVerifiedCompatibility === true;
  const launchDenied = launchGate(input.policy, requireVerifiedCompatibility);
  const launchAllowed = launchDenied === null;
  const launchActive = launchAllowed && processState === "running";
  const launchReasonCode = launchDenied
    ? launchDenied
    : launchActive
      ? "ADMITTED"
      : inactiveProcessReason(processState);
  const h264 = capabilityEntry({
    requested: input.policy.requested.h264Stream,
    compatibility: input.policy.compatibility.h264Stream,
    requireVerifiedCompatibility,
    detected: detected?.h264Stream ?? null,
    processState,
    launchDenied,
  });
  const continuousInput = capabilityEntry({
    requested: input.policy.requested.continuousInput,
    compatibility: input.policy.compatibility.continuousInput,
    requireVerifiedCompatibility,
    detected: detected?.continuousInput ?? null,
    processState,
    launchDenied,
  });
  const multiTouch = capabilityEntry({
    requested: input.policy.requested.continuousInput,
    compatibility: input.policy.compatibility.multiTouch,
    requireVerifiedCompatibility,
    detected: detected?.multiTouch ?? null,
    processState,
    launchDenied,
    dependencyAllowed: continuousInput.policyAllowed,
  });
  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    hostMode: input.policy.host.mode,
    artifact: { ...input.policy.artifact },
    processState,
    launch: {
      allowed: launchAllowed,
      active: launchActive,
      reasonCode: launchReasonCode,
      reason: REASONS[launchReasonCode],
    },
    capabilities: {
      h264Stream: h264,
      bgraStream: capabilityEntry({
        requested: false,
        compatibility: input.policy.compatibility.h264Stream,
        requireVerifiedCompatibility,
        detected: detected?.bgraStream ?? null,
        processState,
        launchDenied,
        productDisabled: true,
      }),
      continuousInput,
      multiTouch,
    },
    fallbackRoute: "wda-mjpeg",
  };
}

/**
 * Masks every host-denied product capability even when a sidecar advertises
 * it. Correctness-only capture APIs remain available through explicit adapter
 * methods and do not imply a product BGRA route.
 */
export function applyIOSSimulatorNativeCapabilityAdmission(
  detected: Readonly<IOSSimulatorDriverCapabilities>,
  decision: IOSSimulatorNativeCapabilityAdmissionDecision,
): Readonly<IOSSimulatorDriverCapabilities> {
  return Object.freeze({
    accessibility: false,
    sessions: false,
    jpegStream: false,
    h264Stream: detected.h264Stream && decision.capabilities.h264Stream.active,
    bgraStream: false,
    discreteInput:
      detected.discreteInput && decision.capabilities.continuousInput.active,
    continuousInput:
      detected.continuousInput && decision.capabilities.continuousInput.active,
    multiTouch: detected.multiTouch && decision.capabilities.multiTouch.active,
  });
}

/** Backward-compatible development policy for local smoke and injected tests. */
export function createIOSSimulatorNativeDevelopmentAdmissionPolicy(
  input: {
    enableH264Stream?: boolean;
    enableContinuousInput?: boolean;
    platform?: NodeJS.Platform;
    architecture?: NodeJS.Architecture | "x86_64";
  } = {},
): IOSSimulatorNativeCapabilityAdmissionPolicy {
  return {
    host: {
      mode: "development",
      platform: input.platform ?? "darwin",
      architecture: input.architecture ?? "arm64",
    },
    artifact: {
      source: "bundled",
      trust: "development",
    },
    compatibility: {
      sidecar: "unknown",
      h264Stream: "unknown",
      continuousInput: "unknown",
      multiTouch: "unknown",
    },
    requested: {
      h264Stream: input.enableH264Stream === true,
      continuousInput: input.enableContinuousInput === true,
    },
    resourceAdmission: "allowed",
  };
}
