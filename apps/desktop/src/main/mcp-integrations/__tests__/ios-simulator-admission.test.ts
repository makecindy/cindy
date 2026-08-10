import { describe, expect, it } from 'vitest';

import {
  evaluateIOSSimulatorNativeCapabilityAdmission,
  type IOSSimulatorSidecarArtifactDescriptor,
} from '@cindy/ios-simulator-runtime';
import { resolveIOSSimulatorDesktopAdmissionPolicy } from '../ios-simulator-admission.js';

const ARTIFACT: IOSSimulatorSidecarArtifactDescriptor = {
  artifactId: 'cindy.ios-simulator-sidecar',
  source: 'bundled',
  version: '1.0.0',
  architecture: 'arm64',
  executablePath:
    '/Applications/Cindy.app/Contents/Helpers/Cindy iOS Simulator Helper.app/Contents/MacOS/ios-simulator-sidecar',
  trust: 'verified',
  sha256: 'a'.repeat(64),
};
const START = {
  instanceId: 'instance-a',
  simulatorUdid: 'A1B2C3D4-1111-2222-3333-444455556666',
  generation: 7,
  runtime: {
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
    runtimeBuildVersion: '23E244',
    xcodeBuild: 'Xcode 26.4\nBuild version 17E192',
    architecture: 'arm64' as const,
  },
};

function policy(
  patch: {
    artifact?: IOSSimulatorSidecarArtifactDescriptor;
    xcodeBuild?: string;
    runtimeBuildVersion?: string | null;
    hostOsRelease?: string;
    packaged?: boolean;
    developmentRequests?: {
      h264Stream: boolean;
      continuousInput: boolean;
    };
  } = {},
) {
  return resolveIOSSimulatorDesktopAdmissionPolicy({
    packaged: patch.packaged ?? true,
    platform: 'darwin',
    architecture: 'arm64',
    hostOsRelease: patch.hostOsRelease ?? '25.3.0',
    artifact: patch.artifact ?? ARTIFACT,
    start: {
      ...START,
      runtime: {
        ...START.runtime,
        xcodeBuild: patch.xcodeBuild ?? START.runtime.xcodeBuild,
        runtimeBuildVersion:
          patch.runtimeBuildVersion === undefined
            ? START.runtime.runtimeBuildVersion
            : patch.runtimeBuildVersion,
      },
    },
    developmentRequests: patch.developmentRequests ?? {
      h264Stream: false,
      continuousInput: false,
    },
  });
}

describe('iOS Simulator Desktop native admission policy', () => {
  it('auto-requests independently promoted packaged capabilities', () => {
    const resolved = policy();
    expect(resolved).toMatchObject({
      host: { mode: 'packaged' },
      artifact: { trust: 'verified' },
      compatibility: {
        sidecar: 'eligible',
        h264Stream: 'eligible',
        continuousInput: 'eligible',
        multiTouch: 'eligible',
      },
      requested: {
        h264Stream: true,
        continuousInput: true,
      },
    });
    expect(
      evaluateIOSSimulatorNativeCapabilityAdmission({
        policy: resolved,
        processState: 'idle',
      }).launch,
    ).toMatchObject({ allowed: true });
  });

  it('soft-opens a near-miss packaged runtime for capability probing', () => {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: policy({ runtimeBuildVersion: '23E245' }),
      processState: 'idle',
    });
    expect(decision).toMatchObject({
      launch: {
        allowed: true,
      },
      capabilities: {
        h264Stream: { compatible: null, reasonCode: 'AWAITING_PROBE' },
        continuousInput: { compatible: null, reasonCode: 'AWAITING_PROBE' },
      },
      fallbackRoute: 'wda-mjpeg',
    });
  });

  it('soft-opens a near-miss host OS release for capability probing', () => {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: policy({ hostOsRelease: '25.4.0' }),
      processState: 'idle',
    });
    expect(decision).toMatchObject({
      launch: {
        allowed: true,
      },
      capabilities: {
        h264Stream: { compatible: null, reasonCode: 'AWAITING_PROBE' },
        continuousInput: { compatible: null, reasonCode: 'AWAITING_PROBE' },
      },
      fallbackRoute: 'wda-mjpeg',
    });
  });

  it('still rejects an untrusted artifact for a promoted combination', () => {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: policy({
        artifact: { ...ARTIFACT, trust: 'untrusted', sha256: null },
      }),
      processState: 'idle',
    });
    expect(decision.launch).toMatchObject({
      allowed: false,
      reasonCode: 'ARTIFACT_UNTRUSTED',
    });
  });

  it('preserves explicit development requests without release promotion', () => {
    expect(
      policy({
        packaged: false,
        developmentRequests: {
          h264Stream: true,
          continuousInput: false,
        },
      }),
    ).toMatchObject({
      host: { mode: 'development' },
      compatibility: {
        sidecar: 'unknown',
        h264Stream: 'unknown',
        continuousInput: 'unknown',
        multiTouch: 'unknown',
      },
      requested: {
        h264Stream: true,
        continuousInput: false,
      },
    });
  });
});
