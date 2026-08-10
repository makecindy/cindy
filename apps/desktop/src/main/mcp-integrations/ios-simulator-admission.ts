import {
  resolveIOSSimulatorNativeReleaseCompatibility,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
  type IOSSimulatorNativeSidecarStartOptions,
  type IOSSimulatorSidecarArtifactDescriptor,
} from '@cindy/ios-simulator-runtime';

export interface IOSSimulatorDesktopAdmissionPolicyInput {
  packaged: boolean;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  hostOsRelease: string;
  artifact: Readonly<IOSSimulatorSidecarArtifactDescriptor>;
  start: Readonly<IOSSimulatorNativeSidecarStartOptions>;
  developmentRequests: {
    h264Stream: boolean;
    continuousInput: boolean;
  };
}

/**
 * Resolves product capability policy only from Host-owned runtime identity,
 * artifact verification, and the checked-in release promotion registry.
 */
export function resolveIOSSimulatorDesktopAdmissionPolicy(
  input: IOSSimulatorDesktopAdmissionPolicyInput,
): IOSSimulatorNativeCapabilityAdmissionPolicy {
  const compatibility = input.packaged
    ? resolveIOSSimulatorNativeReleaseCompatibility({
        hostOsRelease: input.hostOsRelease,
        xcodeVersion: input.start.runtime?.xcodeBuild ?? null,
        runtimeIdentifier: input.start.runtime?.runtimeIdentifier ?? '',
        runtimeBuildVersion:
          input.start.runtime?.runtimeBuildVersion ?? null,
        architecture: input.artifact.architecture,
      })
    : {
        sidecar: 'unknown' as const,
        h264Stream: 'unknown' as const,
        continuousInput: 'unknown' as const,
        multiTouch: 'unknown' as const,
      };
  return {
    host: {
      mode: input.packaged ? 'packaged' : 'development',
      platform: input.platform,
      architecture: input.architecture,
    },
    artifact: {
      source: input.artifact.source,
      trust: input.artifact.trust,
    },
    compatibility: {
      sidecar: compatibility.sidecar,
      h264Stream: compatibility.h264Stream,
      continuousInput: compatibility.continuousInput,
      multiTouch: compatibility.multiTouch,
    },
    requested: input.packaged
      ? {
          h264Stream: true,
          continuousInput: true,
        }
      : { ...input.developmentRequests },
    resourceAdmission: 'allowed',
  };
}
