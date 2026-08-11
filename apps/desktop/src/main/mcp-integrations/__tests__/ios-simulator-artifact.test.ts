import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IOSSimulatorPackagedSidecarArtifactResolver,
  verifyIOSSimulatorPackagedSidecarArtifact,
  verifyIOSSimulatorSidecarDigest,
} from '../ios-simulator-artifact.js';

const TEAM_ID = 'ABCDE12345';
const MAIN_BUNDLE_ID = 'com.xd.cindycn';
const HELPER_BUNDLE_ID = `${MAIN_BUNDLE_ID}.ios-simulator-helper`;
const VERSION = '1.2.3';
const REQUIREMENT =
  `anchor apple generic and identifier "${HELPER_BUNDLE_ID}" ` +
  `and certificate leaf[subject.OU] = "${TEAM_ID}"`;

interface Fixture {
  root: string;
  appPath: string;
  resourcesPath: string;
  helperPath: string;
  executablePath: string;
  manifestPath: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** 探针创建真实符号链接来检测 OS 能力，不靠平台名猜测（开发者模式 Windows 可以 symlink）。 */
function canCreateSymlink(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'cindy-ios-artifact-symlink-probe-'));
  try {
    writeFileSync(path.join(probe, 'target'), 'probe');
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const canLink = canCreateSymlink();

async function createFixture(
  patch: {
    executable?: string;
    sha256?: string;
    mode?: 'developer-id' | 'adhoc';
    teamIdentifier?: string | null;
    bundleIdentifier?: string;
    architectures?: string[];
    designatedRequirement?: string;
    extraManifestField?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-artifact-test-')));
  temporaryRoots.push(root);
  const appPath = path.join(root, 'Cindy.app');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const helperPath = path.join(appPath, 'Contents', 'Helpers', 'Cindy iOS Simulator Helper.app');
  const executablePath = path.join(helperPath, 'Contents', 'MacOS', 'ios-simulator-sidecar');
  const manifestPath = path.join(resourcesPath, 'ios-simulator', 'native-sidecar-manifest.json');
  const executable = patch.executable ?? 'native-sidecar';
  const sha256 = patch.sha256 ?? createHash('sha256').update(executable).digest('hex');

  await Promise.all([
    mkdir(path.dirname(executablePath), { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(appPath, 'Contents', 'Info.plist'), '<plist/>'),
    writeFile(path.join(helperPath, 'Contents', 'Info.plist'), '<plist/>'),
    writeFile(executablePath, executable, { mode: 0o755 }),
    writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactId: 'cindy.ios-simulator-sidecar',
        bundleIdentifier: patch.bundleIdentifier ?? HELPER_BUNDLE_ID,
        version: VERSION,
        architectures: patch.architectures ?? ['arm64'],
        sha256,
        signing: {
          mode: patch.mode ?? 'developer-id',
          teamIdentifier: patch.teamIdentifier === undefined ? TEAM_ID : patch.teamIdentifier,
          designatedRequirement: patch.designatedRequirement ?? REQUIREMENT,
          hardenedRuntime: true,
        },
        ...(patch.extraManifestField ? { executablePath: '/tmp/injected' } : {}),
      }),
    ),
  ]);
  return { root, appPath, resourcesPath, helperPath, executablePath, manifestPath };
}

function codesignMetadata(identifier: string, teamIdentifier: string): string {
  return [
    'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded',
    `Identifier=${identifier}`,
    `TeamIdentifier=${teamIdentifier}`,
  ].join('\n');
}

function createCommandRunner(
  fixture: Fixture,
  patch: {
    helperBundleIdentifier?: string;
    mainTeamIdentifier?: string;
    helperTeamIdentifier?: string;
    helperSignatureIdentifier?: string;
    architectures?: string;
    designatedRequirement?: string;
    rejectRequirement?: boolean;
  } = {},
) {
  return vi.fn(async (command: string, args: readonly string[]) => {
    if (command === '/usr/libexec/PlistBuddy') {
      const plistPath = args.at(-1);
      return {
        stdout:
          plistPath === path.join(fixture.appPath, 'Contents', 'Info.plist')
            ? `${MAIN_BUNDLE_ID}\n`
            : `${patch.helperBundleIdentifier ?? HELPER_BUNDLE_ID}\n`,
        stderr: '',
      };
    }
    if (command === '/usr/bin/lipo') {
      return { stdout: `${patch.architectures ?? 'arm64'}\n`, stderr: '' };
    }
    if (command === '/usr/bin/codesign' && args.includes('-R=' + REQUIREMENT)) {
      if (patch.rejectRequirement) throw new Error('requirement rejected');
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign' && args[0] === '--verify') {
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign' && args[1] === '-r') {
      return {
        stdout: '',
        stderr: `designated => ${patch.designatedRequirement ?? REQUIREMENT}\n`,
      };
    }
    if (command === '/usr/bin/codesign' && args.includes('--verbose=4')) {
      const bundlePath = args.at(-1);
      const isHelper = bundlePath === fixture.helperPath;
      return {
        stdout: '',
        stderr: codesignMetadata(
          isHelper ? (patch.helperSignatureIdentifier ?? HELPER_BUNDLE_ID) : MAIN_BUNDLE_ID,
          isHelper
            ? (patch.helperTeamIdentifier ?? TEAM_ID)
            : (patch.mainTeamIdentifier ?? TEAM_ID),
        ),
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  });
}

describe('packaged iOS Simulator sidecar artifact verification', () => {
  it('builds and stages the Host-owned Helper in a clean Forge package', async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(testDirectory, '../../../../forge.config.ts');
    const source = await readFile(sourcePath, 'utf8');
    const helperSourcePath = path.resolve(
      testDirectory,
      '../../../../forge-ios-simulator-helper.ts',
    );
    const helperSource = await readFile(helperSourcePath, 'utf8');
    const resourcesStart = source.indexOf('function extraResourcesForTarget');
    const resourcesEnd = source.indexOf('function assertRealAndroidPlatformTool');
    const ensureWdaStart = source.indexOf('function ensureMacIOSSimulatorWdaArchive');
    const ensureWdaEnd = source.indexOf('const MACOS_VOICE_HELPER_DEPLOYMENT_TARGET');
    const buildStart = source.indexOf('function buildMacIOSSimulatorHelper');
    const buildEnd = source.indexOf('function runSwiftcForTarget');
    const stageStart = helperSource.indexOf('export function stageMacIOSSimulatorHelper');
    const prePackageStart = source.indexOf('prePackage: async');
    const postPackageStart = source.indexOf('postPackage: async');
    const postPackageEnd = source.indexOf('  makers,', postPackageStart);

    for (const marker of [
      resourcesStart,
      resourcesEnd,
      ensureWdaStart,
      ensureWdaEnd,
      buildStart,
      buildEnd,
      stageStart,
      prePackageStart,
      postPackageStart,
      postPackageEnd,
    ]) {
      expect(marker).toBeGreaterThan(-1);
    }

    const resourcesBody = source.slice(resourcesStart, resourcesEnd);
    const ensureWdaBody = source.slice(ensureWdaStart, ensureWdaEnd);
    const buildBody = source.slice(buildStart, buildEnd);
    const stageBody = helperSource.slice(stageStart);
    const prePackageBody = source.slice(prePackageStart, postPackageStart);
    const postPackageBody = source.slice(postPackageStart, postPackageEnd);

    expect(resourcesBody).toContain("base.push('resources/ios-simulator')");
    expect(resourcesBody).toContain("base.push('resources/cli')");
    expect(ensureWdaBody).toContain("process.platform !== 'darwin'");
    expect(ensureWdaBody).toContain('!isMacForgePlatform(platform)');
    expect(ensureWdaBody).toContain("'ensure-wda-source-archive.mjs'");
    expect(ensureWdaBody).toContain('spawnSync(process.execPath');
    expect(ensureWdaBody).toContain('result.error');
    expect(ensureWdaBody).toContain('result.signal');
    expect(ensureWdaBody).toContain('result.status !== 0');
    expect(buildBody).toContain("CINDY_IOS_SIDECAR_OUTPUT_MODE: 'helper'");
    expect(buildBody).toContain('CINDY_IOS_SIDECAR_ARCH: helperArch');
    expect(buildBody).toContain('`${CINDY_APP_ID}.ios-simulator-helper`');
    expect(buildBody).toContain('process.env.APP_VERSION ?? DESKTOP_PACKAGE_VERSION');
    expect(helperSource).toContain(
      "const IOS_SIMULATOR_PACKAGED_BUILD_RESULT = 'native-helper-build-result.json'",
    );
    expect(stageBody).toContain("path.join(appContents, 'Helpers', IOS_SIMULATOR_HELPER_BUNDLE)");
    expect(stageBody).toContain("buildResult.status === 'unsupported'");
    expect(stageBody).toContain('fs.rmSync(sourceRoot');
    expect(stageBody).toContain("fs.rmSync(path.join(resourceRoot, 'native')");
    const ensureWdaIndex = prePackageBody.indexOf('ensureMacIOSSimulatorWdaArchive(platform);');
    const buildHelperIndex = prePackageBody.indexOf('buildMacIOSSimulatorHelper(platform, arch);');
    expect(ensureWdaIndex).toBeGreaterThan(-1);
    expect(buildHelperIndex).toBeGreaterThan(ensureWdaIndex);
    expect(postPackageBody).toContain(
      'stageMacIOSSimulatorHelper(buildPath, opts.platform, opts.arch);',
    );
  });

  it('promotes only the fixed signed Helper layout to a verified descriptor', async () => {
    const fixture = await createFixture();
    const commandRunner = createCommandRunner(fixture);

    await expect(
      verifyIOSSimulatorPackagedSidecarArtifact({
        resourcesPath: fixture.resourcesPath,
        version: VERSION,
        architecture: 'arm64',
        platform: 'darwin',
        commandRunner,
      }),
    ).resolves.toMatchObject({
      artifactId: 'cindy.ios-simulator-sidecar',
      source: 'bundled',
      version: VERSION,
      architecture: 'arm64',
      executablePath: fixture.executablePath,
      trust: 'verified',
      sha256: createHash('sha256').update('native-sidecar').digest('hex'),
    });
    expect(commandRunner).toHaveBeenCalledWith('/usr/bin/codesign', [
      '--verify',
      '--strict',
      `-R=${REQUIREMENT}`,
      fixture.helperPath,
    ]);
  });

  it.each([
    ['digest mismatch', { sha256: '0'.repeat(64) }, {}],
    ['ad-hoc signature', { mode: 'adhoc' as const, teamIdentifier: null }, {}],
    ['manifest bundle mismatch', { bundleIdentifier: 'com.example.helper' }, {}],
    ['main/helper team mismatch', {}, { helperTeamIdentifier: 'ZZZZZ99999' }],
    ['architecture mismatch', { architectures: ['x86_64'] }, { architectures: 'x86_64' }],
    ['designated requirement rejection', {}, { rejectRequirement: true }],
    ['manifest path injection', { extraManifestField: true }, {}],
  ])('keeps %s untrusted', async (_label, manifestPatch, commandPatch) => {
    const fixture = await createFixture(manifestPatch);
    const resolver = new IOSSimulatorPackagedSidecarArtifactResolver({
      resourcesPath: fixture.resourcesPath,
      version: VERSION,
      architecture: 'arm64',
      platform: 'darwin',
      commandRunner: createCommandRunner(fixture, commandPatch),
    });

    await expect(
      resolver.resolve({
        instanceId: 'instance-a',
        simulatorUdid: 'A1B2C3D4-1111-2222-3333-444455556666',
        generation: 7,
      }),
    ).resolves.toMatchObject({
      executablePath: fixture.executablePath,
      trust: 'untrusted',
      sha256: null,
    });
  });

  it.skipIf(!canLink)('rejects a symlinked executable before invoking codesign', async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.root, 'replacement');
    await writeFile(targetPath, 'native-sidecar');
    await rm(fixture.executablePath);
    await symlink(targetPath, fixture.executablePath);
    const commandRunner = createCommandRunner(fixture);

      await expect(
        verifyIOSSimulatorPackagedSidecarArtifact({
          resourcesPath: fixture.resourcesPath,
          version: VERSION,
          architecture: 'arm64',
          platform: 'darwin',
          commandRunner,
        }),
      ).rejects.toThrow('verification failed');
      expect(commandRunner).not.toHaveBeenCalled();
    },
  );

  it('fails a final pre-spawn check after the verified executable changes', async () => {
    const fixture = await createFixture();
    const expectedDigest = createHash('sha256').update('native-sidecar').digest('hex');
    await expect(
      verifyIOSSimulatorSidecarDigest(fixture.executablePath, expectedDigest),
    ).resolves.toBeUndefined();

    await writeFile(fixture.executablePath, 'changed-sidecar');
    await expect(
      verifyIOSSimulatorSidecarDigest(fixture.executablePath, expectedDigest),
    ).rejects.toThrow('verification failed');
  });

  it('signs the nested Helper before the main app in both macOS signing paths', async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(testDirectory, '../../../../scripts/ci/lib.mjs');
    const source = await readFile(sourcePath, 'utf8');
    const adhocBody = source.slice(
      source.indexOf('export function adhocSignMacApp'),
      source.indexOf('export function signMacAppWithIdentity'),
    );
    const developerIdBody = source.slice(
      source.indexOf('export function signMacAppWithIdentity'),
      source.indexOf('export function notarizeMacApp'),
    );

    expect(adhocBody.indexOf('signIOSSimulatorHelper(')).toBeGreaterThan(-1);
    expect(adhocBody.indexOf('signIOSSimulatorHelper(')).toBeLessThan(
      adhocBody.indexOf('--entitlements "${mainEntitlementsPath}"'),
    );
    expect(developerIdBody.indexOf('signIOSSimulatorHelper(')).toBeGreaterThan(-1);
    expect(developerIdBody.indexOf('signIOSSimulatorHelper(')).toBeLessThan(
      developerIdBody.indexOf('Signing main app'),
    );
  });

  it('qualifies the final signed app before creating distributable archives', async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(testDirectory, '../../../../scripts/package-desktop.mjs');
    const source = await readFile(sourcePath, 'utf8');
    const finishDarwinBody = source.slice(
      source.indexOf('async function finishDarwin'),
      source.indexOf('async function finishLinux'),
    );
    const notarizeIndex = finishDarwinBody.indexOf('notarizeMacApp(appPath, identity)');
    const releaseGateIndex = finishDarwinBody.indexOf('runIOSSimulatorReleaseGate(', notarizeIndex);
    const dmgIndex = finishDarwinBody.indexOf('createMacDMG(');
    const adhocIndex = finishDarwinBody.indexOf('adhocSignMacApp(');
    const untrustedGateIndex = finishDarwinBody.indexOf(
      "runIOSSimulatorReleaseGate(appPath, arch, 'untrusted')",
    );
    const appZipIndex = finishDarwinBody.indexOf('Creating app ZIP (ad-hoc signed)');

    expect(notarizeIndex).toBeGreaterThan(-1);
    expect(releaseGateIndex).toBeGreaterThan(notarizeIndex);
    expect(finishDarwinBody).toContain("iosSimulatorHelperSigned ? 'verified' : 'untrusted'");
    expect(finishDarwinBody).toContain(
      'CINDY_IOS_SIMULATOR_RELEASE_NATIVE_SMOKE=1 requires a packaged Native Helper',
    );
    expect(dmgIndex).toBeGreaterThan(releaseGateIndex);
    expect(adhocIndex).toBeGreaterThan(-1);
    expect(untrustedGateIndex).toBeGreaterThan(adhocIndex);
    expect(appZipIndex).toBeGreaterThan(untrustedGateIndex);
  });
});
