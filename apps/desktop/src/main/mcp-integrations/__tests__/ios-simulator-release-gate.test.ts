import { describe, expect, it, vi } from 'vitest';

import type {
  IOSSimulatorEnvironmentReport,
  IOSSimulatorSidecarArtifactDescriptor,
} from '@cindy/ios-simulator-runtime';
import {
  finalizeIOSSimulatorReleaseGateProbe,
  parseIOSSimulatorReleaseGateArgs,
  runIOSSimulatorReleaseGate,
  type IOSSimulatorReleaseGateDependencies,
  type IOSSimulatorReleaseGateOptions,
} from '../ios-simulator-release-gate.js';

const ENVIRONMENT: IOSSimulatorEnvironmentReport = {
  platform: 'darwin',
  supported: true,
  ready: true,
  xcodeSelectPath: '/Applications/Xcode.app/Contents/Developer',
  xcodeVersion: 'Xcode 26.4\nBuild version 17E192',
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      name: 'iOS 26.4',
      version: '26.4',
      buildVersion: '23E244',
      isAvailable: true,
      availabilityError: null,
    },
  ],
  devices: [],
  issue: null,
  error: null,
  setupSteps: [],
};

const ARTIFACT: IOSSimulatorSidecarArtifactDescriptor = {
  artifactId: 'cindy.ios-simulator-sidecar',
  source: 'bundled',
  version: '1.2.3',
  architecture: 'arm64',
  executablePath:
    '/Applications/Cindy.app/Contents/Helpers/Cindy iOS Simulator Helper.app/Contents/MacOS/ios-simulator-sidecar',
  trust: 'verified',
  sha256: 'a'.repeat(64),
};

const OPTIONS: IOSSimulatorReleaseGateOptions = {
  mode: 'static',
  packaged: true,
  platform: 'darwin',
  architecture: 'arm64',
  hostOsRelease: '25.3.0',
  resourcesPath: '/Applications/Cindy.app/Contents/Resources',
  version: '1.2.3',
};

function dependencies(
  patch: {
    environment?: IOSSimulatorEnvironmentReport;
    artifact?: IOSSimulatorSidecarArtifactDescriptor;
  } = {},
) {
  const runNativeProbe = vi.fn(async () => ({
    h264Frames: 3,
    keyFrames: 1,
    singleTouchAccepted: true,
    multiTouchAccepted: true,
    cleanRestartReady: true,
  }));
  const value: IOSSimulatorReleaseGateDependencies = {
    inspectEnvironment: async () => patch.environment ?? ENVIRONMENT,
    resolveArtifact: async () => patch.artifact ?? ARTIFACT,
    runNativeProbe,
  };
  return { value, runNativeProbe };
}

describe('packaged iOS Simulator release gate', () => {
  it.each([0, 1, 2])(
    'fails a successful native probe when cleanup step %i fails and still runs later cleanup',
    async (failingStep) => {
      const cleanup = [0, 1, 2].map((index) =>
        vi.fn(async () => {
          if (index === failingStep) throw new Error(`cleanup-${index}`);
        }),
      );

      await expect(finalizeIOSSimulatorReleaseGateProbe(true, cleanup)).rejects.toMatchObject({
        message: 'IOS_SIMULATOR_RELEASE_CLEANUP_FAILED',
        cause: expect.objectContaining({ message: `cleanup-${failingStep}` }),
      });
      expect(cleanup.every((step) => step.mock.calls.length === 1)).toBe(true);
    },
  );

  it('preserves the original probe failure while still attempting every cleanup step', async () => {
    const probeError = new Error('IOS_SIMULATOR_RELEASE_H264_INVALID');
    const cleanup = [0, 1, 2].map((index) =>
      vi.fn(async () => {
        throw new Error(`cleanup-${index}`);
      }),
    );
    const probe = (async () => {
      let probeSucceeded = false;
      try {
        throw probeError;
      } finally {
        await finalizeIOSSimulatorReleaseGateProbe(probeSucceeded, cleanup);
      }
    })();

    await expect(probe).rejects.toBe(probeError);
    expect(cleanup.every((step) => step.mock.calls.length === 1)).toBe(true);
  });

  it('qualifies an exact verified combination without leaking Host paths', async () => {
    const deps = dependencies();
    const report = await runIOSSimulatorReleaseGate(OPTIONS, deps.value);

    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      mode: 'static',
      artifact: { trust: 'verified', architecture: 'arm64' },
      compatibility: {
        sidecar: 'eligible',
        h264Stream: 'eligible',
        continuousInput: 'eligible',
        multiTouch: 'eligible',
      },
      admission: {
        launchAllowed: true,
        reasonCode: 'PROCESS_NOT_RUNNING',
        fallbackRoute: 'wda-mjpeg',
      },
      native: null,
    });
    expect(JSON.stringify(report)).not.toContain(ARTIFACT.executablePath);
    expect(JSON.stringify(report)).not.toContain(ENVIRONMENT.xcodeSelectPath);
    expect(deps.runNativeProbe).not.toHaveBeenCalled();
  });

  it('proves an ad-hoc or otherwise untrusted package stays on WDA/MJPEG', async () => {
    const deps = dependencies({
      artifact: { ...ARTIFACT, trust: 'untrusted', sha256: null },
    });
    await expect(runIOSSimulatorReleaseGate(OPTIONS, deps.value)).resolves.toMatchObject({
      artifact: { trust: 'untrusted' },
      admission: {
        launchAllowed: false,
        reasonCode: 'ARTIFACT_UNTRUSTED',
        fallbackRoute: 'wda-mjpeg',
      },
      native: null,
    });
  });

  it('runs the temporary-device probe only for an admitted native gate', async () => {
    const deps = dependencies();
    const report = await runIOSSimulatorReleaseGate({ ...OPTIONS, mode: 'native' }, deps.value);

    expect(deps.runNativeProbe).toHaveBeenCalledOnce();
    expect(report.native).toEqual({
      h264Frames: 3,
      keyFrames: 1,
      singleTouchAccepted: true,
      multiTouchAccepted: true,
      cleanRestartReady: true,
    });
  });

  it('refuses a native probe when the runtime build is not promoted', async () => {
    const deps = dependencies({
      environment: {
        ...ENVIRONMENT,
        runtimes: [
          {
            ...ENVIRONMENT.runtimes[0]!,
            buildVersion: '23E245',
          },
        ],
      },
    });
    await expect(
      runIOSSimulatorReleaseGate({ ...OPTIONS, mode: 'native' }, deps.value),
    ).rejects.toThrow('IOS_SIMULATOR_RELEASE_NATIVE_NOT_ADMITTED');
    expect(deps.runNativeProbe).not.toHaveBeenCalled();
  });

  it('parses only explicit static or native packaged gate modes', () => {
    expect(parseIOSSimulatorReleaseGateArgs([])).toEqual({
      enabled: false,
      mode: 'static',
    });
    expect(parseIOSSimulatorReleaseGateArgs(['--ios-simulator-release-gate=native'])).toEqual({
      enabled: true,
      mode: 'native',
    });
    expect(() => parseIOSSimulatorReleaseGateArgs(['--ios-simulator-release-gate=other'])).toThrow(
      'IOS_SIMULATOR_RELEASE_GATE_MODE_INVALID',
    );
    expect(() => parseIOSSimulatorReleaseGateArgs(['--ios-simulator-release-gate='])).toThrow(
      'IOS_SIMULATOR_RELEASE_GATE_MODE_INVALID',
    );
  });
});
