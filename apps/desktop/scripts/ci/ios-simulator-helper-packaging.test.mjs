import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectPackagedIOSSimulatorHelper,
  signIOSSimulatorHelper,
} from './lib.mjs';

const roots = [];

function createApp() {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-signed-ios-helper-'));
  roots.push(appPath);
  return appPath;
}

function helperExecutable(appPath) {
  return path.join(
    appPath,
    'Contents',
    'Helpers',
    'Cindy iOS Simulator Helper.app',
    'Contents',
    'MacOS',
    'ios-simulator-sidecar',
  );
}

function unsupportedBuildResult(appPath, patch = {}) {
  const resultPath = path.join(
    appPath,
    'Contents',
    'Resources',
    'ios-simulator',
    'native-helper-build-result.json',
  );
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'unsupported',
      targetArchitecture: 'x86_64',
      reason: 'simulator-kit-architecture-unavailable',
      simulatorKitArchitectures: ['arm64e'],
      ...patch,
    })}\n`,
  );
  return resultPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('packaged iOS Simulator Helper inspection', () => {
  it('reports a packaged Helper when the executable is present', () => {
    const appPath = createApp();
    const executablePath = helperExecutable(appPath);
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'sidecar');

    expect(inspectPackagedIOSSimulatorHelper(appPath, 'x64')).toMatchObject({
      status: 'present',
      executablePath,
    });
  });

  it('accepts only the explicit x86_64 unsupported build result', () => {
    const appPath = createApp();
    const buildResultPath = unsupportedBuildResult(appPath);

    expect(inspectPackagedIOSSimulatorHelper(appPath, 'x64')).toMatchObject({
      status: 'unsupported',
      buildResultPath,
      result: {
        targetArchitecture: 'x86_64',
        reason: 'simulator-kit-architecture-unavailable',
      },
    });
  });

  it('skips signing only for the explicit unsupported result and removes a stale manifest', () => {
    const appPath = createApp();
    unsupportedBuildResult(appPath);
    const manifestPath = path.join(
      appPath,
      'Contents',
      'Resources',
      'ios-simulator',
      'native-sidecar-manifest.json',
    );
    fs.writeFileSync(manifestPath, '{}');

    expect(
      signIOSSimulatorHelper(
        appPath,
        ['--sign', '-'],
        { mode: 'adhoc', teamIdentifier: null },
        'x64',
      ),
    ).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('fails when a missing Helper has no explicit unsupported result', () => {
    const appPath = createApp();
    expect(() => inspectPackagedIOSSimulatorHelper(appPath, 'x64')).toThrow(
      'packaged iOS Simulator helper is missing',
    );
  });

  it('fails for malformed, arm64, or conflicting unsupported results', () => {
    const malformedApp = createApp();
    unsupportedBuildResult(malformedApp, { targetArchitecture: 'arm64' });
    expect(() => inspectPackagedIOSSimulatorHelper(malformedApp, 'x64')).toThrow(
      'build result is invalid',
    );

    const conflictingApp = createApp();
    unsupportedBuildResult(conflictingApp);
    const executablePath = helperExecutable(conflictingApp);
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'sidecar');
    expect(() => inspectPackagedIOSSimulatorHelper(conflictingApp, 'x64')).toThrow(
      'conflicts with unsupported build result',
    );
  });

  it('rejects x86_64 fallback markers for arm64 and universal packages', () => {
    const arm64App = createApp();
    const universalApp = createApp();
    unsupportedBuildResult(arm64App);
    unsupportedBuildResult(universalApp);

    expect(() => inspectPackagedIOSSimulatorHelper(arm64App, 'arm64')).toThrow(
      'fallback is allowed only for x64 packages',
    );
    expect(() => inspectPackagedIOSSimulatorHelper(universalApp, 'universal')).toThrow(
      'fallback is allowed only for x64 packages',
    );
  });

  it('rejects a missing-slice marker that still lists x86_64', () => {
    const appPath = createApp();
    unsupportedBuildResult(appPath, {
      simulatorKitArchitectures: ['x86_64', 'arm64e'],
    });

    expect(() => inspectPackagedIOSSimulatorHelper(appPath, 'x64')).toThrow(
      'build result is invalid',
    );
  });
});
