import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stageMacIOSSimulatorHelper } from '../../../forge-ios-simulator-helper';

const roots: string[] = [];

async function supportsPosixExecutableMode(filePath: string): Promise<boolean> {
  const originalMode = (await stat(filePath)).mode & 0o777;
  try {
    await chmod(filePath, 0o755);
    const executableMode = (await stat(filePath)).mode & 0o777;
    return executableMode === 0o755;
  } catch {
    return false;
  } finally {
    try {
      await chmod(filePath, originalMode);
    } catch {
      // The fixture is temporary and will be removed by afterEach.
    }
  }
}

async function createFixture(result: Record<string, unknown>, includeExecutable: boolean) {
  const buildPath = await mkdtemp(path.join(os.tmpdir(), 'cindy-forge-ios-helper-'));
  roots.push(buildPath);
  const appContents = path.join(buildPath, 'Cindy.app', 'Contents');
  const resourceRoot = path.join(appContents, 'Resources', 'ios-simulator');
  const helperRoot = path.join(resourceRoot, 'helper');
  const executablePath = path.join(
    helperRoot,
    'Cindy iOS Simulator Helper.app',
    'Contents',
    'MacOS',
    'ios-simulator-sidecar',
  );
  await mkdir(helperRoot, { recursive: true });
  await writeFile(path.join(helperRoot, 'build-result.json'), `${JSON.stringify(result)}\n`);
  await writeFile(path.join(resourceRoot, 'wda-source.tar.gz'), 'wda');
  await mkdir(path.join(resourceRoot, 'native'), { recursive: true });
  await writeFile(path.join(resourceRoot, 'native', 'stale'), 'stale');
  if (includeExecutable) {
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(executablePath, 'sidecar', { mode: 0o644 });
  }
  const posixExecutableModeSupported = includeExecutable
    ? await supportsPosixExecutableMode(executablePath)
    : false;
  return { buildPath, appContents, resourceRoot, posixExecutableModeSupported };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stageMacIOSSimulatorHelper', () => {
  it('stages a built Helper and removes temporary native resources', async () => {
    const fixture = await createFixture(
      {
        schemaVersion: 1,
        status: 'built',
        targetArchitecture: 'x86_64',
        simulatorKitArchitectures: ['x86_64', 'arm64e'],
      },
      true,
    );

    stageMacIOSSimulatorHelper(fixture.buildPath, 'darwin', 'x64');

    const executable = path.join(
      fixture.appContents,
      'Helpers',
      'Cindy iOS Simulator Helper.app',
      'Contents',
      'MacOS',
      'ios-simulator-sidecar',
    );
    const executableStat = await stat(executable);
    expect(executableStat.mode).toEqual(expect.any(Number));
    if (fixture.posixExecutableModeSupported) {
      expect(executableStat.mode & 0o777).toBe(0o755);
    }
    await expect(stat(path.join(fixture.resourceRoot, 'helper'))).rejects.toThrow();
    await expect(stat(path.join(fixture.resourceRoot, 'native'))).rejects.toThrow();
    await expect(
      stat(path.join(fixture.resourceRoot, 'native-helper-build-result.json')),
    ).rejects.toThrow();
  });

  it('preserves an explicit x86_64 unsupported result and removes stale Helper content', async () => {
    const result = {
      schemaVersion: 1,
      status: 'unsupported',
      targetArchitecture: 'x86_64',
      reason: 'simulator-kit-architecture-unavailable',
      simulatorKitArchitectures: ['arm64e'],
    };
    const fixture = await createFixture(result, false);
    const staleDestination = path.join(
      fixture.appContents,
      'Helpers',
      'Cindy iOS Simulator Helper.app',
    );
    await mkdir(staleDestination, { recursive: true });

    stageMacIOSSimulatorHelper(fixture.buildPath, 'darwin', 'x64');

    await expect(stat(staleDestination)).rejects.toThrow();
    await expect(stat(path.join(fixture.resourceRoot, 'helper'))).rejects.toThrow();
    await expect(stat(path.join(fixture.resourceRoot, 'native'))).rejects.toThrow();
    await expect(
      readFile(path.join(fixture.resourceRoot, 'native-helper-build-result.json'), 'utf8'),
    ).resolves.toContain('simulator-kit-architecture-unavailable');
    await expect(readFile(path.join(fixture.resourceRoot, 'wda-source.tar.gz'), 'utf8')).resolves.toBe(
      'wda',
    );
  });

  it('rejects a missing executable without the exact unsupported result', async () => {
    const fixture = await createFixture(
      {
        schemaVersion: 1,
        status: 'built',
        targetArchitecture: 'x86_64',
        simulatorKitArchitectures: ['x86_64'],
      },
      false,
    );
    expect(() => stageMacIOSSimulatorHelper(fixture.buildPath, 'darwin', 'x64')).toThrow(
      'helper executable missing',
    );
  });

  it('rejects unsupported markers for arm64 or unknown reasons', async () => {
    const fixture = await createFixture(
      {
        schemaVersion: 1,
        status: 'unsupported',
        targetArchitecture: 'arm64',
        reason: 'simulator-kit-architecture-unavailable',
        simulatorKitArchitectures: ['x86_64'],
      },
      false,
    );
    expect(() => stageMacIOSSimulatorHelper(fixture.buildPath, 'darwin', 'x64')).toThrow(
      'invalid iOS Simulator helper build result',
    );
  });

  it('rejects an x86_64 fallback marker for arm64 and universal packages', async () => {
    const result = {
      schemaVersion: 1,
      status: 'unsupported',
      targetArchitecture: 'x86_64',
      reason: 'simulator-kit-architecture-unavailable',
      simulatorKitArchitectures: ['arm64e'],
    };
    const arm64Fixture = await createFixture(result, false);
    const universalFixture = await createFixture(result, false);

    expect(() =>
      stageMacIOSSimulatorHelper(arm64Fixture.buildPath, 'darwin', 'arm64'),
    ).toThrow('targets x86_64, expected arm64');
    expect(() =>
      stageMacIOSSimulatorHelper(universalFixture.buildPath, 'darwin', 'universal'),
    ).toThrow('targets x86_64, expected universal');
  });

  it('rejects a built result from a different package architecture', async () => {
    const fixture = await createFixture(
      {
        schemaVersion: 1,
        status: 'built',
        targetArchitecture: 'x86_64',
        simulatorKitArchitectures: ['x86_64', 'arm64e'],
      },
      true,
    );

    expect(() => stageMacIOSSimulatorHelper(fixture.buildPath, 'darwin', 'arm64')).toThrow(
      'targets x86_64, expected arm64',
    );
  });

  it('rejects a missing-slice marker that still lists x86_64', async () => {
    const fixture = await createFixture(
      {
        schemaVersion: 1,
        status: 'unsupported',
        targetArchitecture: 'x86_64',
        reason: 'simulator-kit-architecture-unavailable',
        simulatorKitArchitectures: ['x86_64', 'arm64e'],
      },
      false,
    );

    expect(() => stageMacIOSSimulatorHelper(fixture.buildPath, 'darwin', 'x64')).toThrow(
      'invalid iOS Simulator helper build result',
    );
  });
});
