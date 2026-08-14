import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractReleaseGateReport,
  parseIOSSimulatorReleaseGateCli,
  validateReleaseGateReport,
} from './ios-simulator-release-gate.mjs';

const BASE_REPORT = {
  schemaVersion: 1,
  ok: true,
  mode: 'static',
  environmentReady: true,
  artifact: {
    source: 'bundled',
    trust: 'verified',
    architecture: 'arm64',
  },
  runtime: {
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
    buildVersion: '23E244',
  },
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
};

describe('iOS Simulator packaged release gate CLI', () => {
  it('parses strict trust and native requirements', () => {
    expect(
      parseIOSSimulatorReleaseGateCli([
        '--app-path=/tmp/Cindy.app',
        '--arch=arm64',
        '--expected-trust=verified',
        '--require-native',
      ]),
    ).toMatchObject({
      appPath: path.resolve('/tmp/Cindy.app'),
      arch: 'arm64',
      expectedTrust: 'verified',
      requireNative: true,
    });
    expect(() =>
      parseIOSSimulatorReleaseGateCli([
        '--app-path=/tmp/Cindy.app',
        '--arch=arm64',
        '--expected-trust=untrusted',
        '--require-native',
      ]),
    ).toThrow('--require-native requires');
  });

  it('extracts the last structured result from mixed Electron output', () => {
    expect(
      extractReleaseGateReport(
        `warmup\n${JSON.stringify(BASE_REPORT)}\n`,
        'diagnostic\n{"unrelated":true}\n',
      ),
    ).toEqual(BASE_REPORT);
  });

  it('accepts a promoted verified static report', () => {
    expect(
      validateReleaseGateReport(BASE_REPORT, {
        appPath: '/tmp/Cindy.app',
        arch: 'arm64',
        expectedTrust: 'verified',
        requireNative: false,
      }),
    ).toBe(BASE_REPORT);
  });

  it('requires untrusted packages to expose only the WDA/MJPEG fallback', () => {
    const report = {
      ...BASE_REPORT,
      artifact: { ...BASE_REPORT.artifact, trust: 'untrusted' },
      admission: {
        launchAllowed: false,
        reasonCode: 'ARTIFACT_UNTRUSTED',
        fallbackRoute: 'wda-mjpeg',
      },
    };
    expect(
      validateReleaseGateReport(report, {
        appPath: '/tmp/Cindy.app',
        arch: 'arm64',
        expectedTrust: 'untrusted',
        requireNative: false,
      }),
    ).toBe(report);
  });

  it('rejects private signing or filesystem metadata in archived output', () => {
    expect(() =>
      validateReleaseGateReport(
        { ...BASE_REPORT, executablePath: '/Applications/Cindy.app' },
        {
          appPath: '/tmp/Cindy.app',
          arch: 'arm64',
          expectedTrust: 'verified',
          requireNative: false,
        },
      ),
    ).toThrow('leaked private metadata');
  });
});
