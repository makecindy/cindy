import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  IOS_SIMULATOR_NATIVE_HELPER_BUNDLE,
  iosSimulatorPackagedHelperExecutablePath,
  type IOSSimulatorSidecarArtifactDescriptor,
  type IOSSimulatorSidecarArtifactResolver,
  type IOSSimulatorNativeSidecarStartOptions,
} from '@cindy/ios-simulator-runtime';

const ARTIFACT_ID = 'cindy.ios-simulator-sidecar';
const MANIFEST_FILE = 'native-sidecar-manifest.json';
const SHA256 = /^[a-f0-9]{64}$/;
const BUNDLE_IDENTIFIER = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

interface IOSSimulatorSidecarManifest {
  schemaVersion: 1;
  artifactId: typeof ARTIFACT_ID;
  bundleIdentifier: string;
  version: string;
  architectures: Array<'arm64' | 'x86_64'>;
  sha256: string;
  signing: {
    mode: 'developer-id' | 'adhoc';
    teamIdentifier: string | null;
    designatedRequirement: string;
    hardenedRuntime: true;
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface IOSSimulatorPackagedArtifactResolverOptions {
  resourcesPath: string;
  version: string;
  architecture: 'arm64' | 'x86_64';
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
}

class PackagedArtifactVerificationError extends Error {
  constructor() {
    super('Packaged iOS Simulator helper verification failed.');
    this.name = 'PackagedArtifactVerificationError';
  }
}

function fail(): never {
  throw new PackagedArtifactVerificationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function readManifest(value: unknown): IOSSimulatorSidecarManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'artifactId',
      'bundleIdentifier',
      'version',
      'architectures',
      'sha256',
      'signing',
    ]) ||
    value.schemaVersion !== 1 ||
    value.artifactId !== ARTIFACT_ID ||
    typeof value.bundleIdentifier !== 'string' ||
    !BUNDLE_IDENTIFIER.test(value.bundleIdentifier) ||
    typeof value.version !== 'string' ||
    !VERSION.test(value.version) ||
    !Array.isArray(value.architectures) ||
    value.architectures.length === 0 ||
    value.architectures.some(
      (architecture) => architecture !== 'arm64' && architecture !== 'x86_64',
    ) ||
    new Set(value.architectures).size !== value.architectures.length ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    !isRecord(value.signing) ||
    !hasExactKeys(value.signing, [
      'mode',
      'teamIdentifier',
      'designatedRequirement',
      'hardenedRuntime',
    ]) ||
    (value.signing.mode !== 'developer-id' && value.signing.mode !== 'adhoc') ||
    (value.signing.teamIdentifier !== null &&
      (typeof value.signing.teamIdentifier !== 'string' ||
        !/^[A-Z0-9]{10}$/.test(value.signing.teamIdentifier))) ||
    typeof value.signing.designatedRequirement !== 'string' ||
    !value.signing.designatedRequirement.trim() ||
    value.signing.hardenedRuntime !== true
  ) {
    fail();
  }
  return value as unknown as IOSSimulatorSidecarManifest;
}

function defaultCommandRunner(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new PackagedArtifactVerificationError());
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

function digestMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function requirePlainPath(filePath: string, kind: 'file' | 'directory'): Promise<void> {
  const metadata = await lstat(filePath);
  if (
    metadata.isSymbolicLink() ||
    (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())
  ) {
    fail();
  }
}

function parseCodesignMetadata(output: CommandResult): {
  identifier: string;
  teamIdentifier: string;
  hardenedRuntime: boolean;
} {
  const text = `${output.stdout}\n${output.stderr}`;
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const flags = text.match(/^CodeDirectory .*\bflags=([^( \n]+|\S+)\(([^)]*)\)/m)?.[2] ?? '';
  if (!identifier || !teamIdentifier) fail();
  return {
    identifier,
    teamIdentifier,
    hardenedRuntime: flags.split(',').some((flag) => flag.trim() === 'runtime'),
  };
}

function parseDesignatedRequirement(output: CommandResult): string {
  const text = `${output.stdout}\n${output.stderr}`;
  const requirement = text.match(/designated\s*=>\s*(.+)/)?.[1]?.trim();
  if (!requirement) fail();
  return requirement;
}

function parseArchitectures(output: CommandResult): Array<'arm64' | 'x86_64'> {
  const architectures = output.stdout
    .trim()
    .split(/\s+/)
    .filter(
      (architecture): architecture is 'arm64' | 'x86_64' =>
        architecture === 'arm64' || architecture === 'x86_64',
    );
  if (architectures.length === 0) fail();
  return architectures;
}

async function readPlistString(
  commandRunner: CommandRunner,
  plistPath: string,
  key: string,
): Promise<string> {
  const result = await commandRunner('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath]);
  const value = result.stdout.trim();
  if (!value) fail();
  return value;
}

function expectedRequirement(bundleIdentifier: string, teamIdentifier: string): string {
  return (
    `anchor apple generic and identifier "${bundleIdentifier}" ` +
    `and certificate leaf[subject.OU] = "${teamIdentifier}"`
  );
}

export async function verifyIOSSimulatorPackagedSidecarArtifact(
  options: IOSSimulatorPackagedArtifactResolverOptions,
): Promise<IOSSimulatorSidecarArtifactDescriptor> {
  if ((options.platform ?? process.platform) !== 'darwin') fail();
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const appPath = path.dirname(path.dirname(options.resourcesPath));
  const canonicalAppPath = await realpath(appPath);
  const canonicalResourcesPath = path.join(canonicalAppPath, 'Contents', 'Resources');
  if ((await realpath(options.resourcesPath)) !== canonicalResourcesPath) fail();

  const helperPath = path.join(
    canonicalAppPath,
    'Contents',
    'Helpers',
    IOS_SIMULATOR_NATIVE_HELPER_BUNDLE,
  );
  const executablePath = iosSimulatorPackagedHelperExecutablePath(canonicalResourcesPath);
  const manifestPath = path.join(canonicalResourcesPath, 'ios-simulator', MANIFEST_FILE);
  const mainInfoPlist = path.join(canonicalAppPath, 'Contents', 'Info.plist');
  const helperInfoPlist = path.join(helperPath, 'Contents', 'Info.plist');

  await Promise.all([
    requirePlainPath(helperPath, 'directory'),
    requirePlainPath(executablePath, 'file'),
    requirePlainPath(manifestPath, 'file'),
    requirePlainPath(mainInfoPlist, 'file'),
    requirePlainPath(helperInfoPlist, 'file'),
  ]);
  if (
    (await realpath(helperPath)) !== helperPath ||
    (await realpath(executablePath)) !== executablePath ||
    (await realpath(manifestPath)) !== manifestPath
  ) {
    fail();
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail();
  }
  const manifest = readManifest(manifestValue);
  const actualDigest = await sha256File(executablePath);
  if (!digestMatches(actualDigest, manifest.sha256)) fail();

  const [
    mainBundleIdentifier,
    helperBundleIdentifier,
    mainSignatureOutput,
    helperSignatureOutput,
    designatedRequirementOutput,
    architectureOutput,
  ] = await Promise.all([
    readPlistString(commandRunner, mainInfoPlist, 'CFBundleIdentifier'),
    readPlistString(commandRunner, helperInfoPlist, 'CFBundleIdentifier'),
    commandRunner('/usr/bin/codesign', ['-d', '--verbose=4', canonicalAppPath]),
    commandRunner('/usr/bin/codesign', ['-d', '--verbose=4', helperPath]),
    commandRunner('/usr/bin/codesign', ['-d', '-r', '-', helperPath]),
    commandRunner('/usr/bin/lipo', ['-archs', executablePath]),
    commandRunner('/usr/bin/codesign', ['--verify', '--strict', canonicalAppPath]),
    commandRunner('/usr/bin/codesign', ['--verify', '--strict', helperPath]),
  ]);
  const expectedHelperBundleIdentifier = `${mainBundleIdentifier}.ios-simulator-helper`;
  const mainSignature = parseCodesignMetadata(mainSignatureOutput);
  const helperSignature = parseCodesignMetadata(helperSignatureOutput);
  const designatedRequirement = parseDesignatedRequirement(designatedRequirementOutput);
  const architectures = parseArchitectures(architectureOutput);

  if (
    helperBundleIdentifier !== expectedHelperBundleIdentifier ||
    manifest.bundleIdentifier !== expectedHelperBundleIdentifier ||
    helperSignature.identifier !== expectedHelperBundleIdentifier ||
    mainSignature.identifier !== mainBundleIdentifier ||
    manifest.version !== options.version ||
    manifest.signing.mode !== 'developer-id' ||
    !manifest.signing.teamIdentifier ||
    manifest.signing.teamIdentifier !== mainSignature.teamIdentifier ||
    helperSignature.teamIdentifier !== mainSignature.teamIdentifier ||
    !helperSignature.hardenedRuntime ||
    manifest.signing.designatedRequirement !== designatedRequirement ||
    !manifest.architectures.includes(options.architecture) ||
    !architectures.includes(options.architecture)
  ) {
    fail();
  }

  await commandRunner('/usr/bin/codesign', [
    '--verify',
    '--strict',
    `-R=${expectedRequirement(expectedHelperBundleIdentifier, mainSignature.teamIdentifier)}`,
    helperPath,
  ]);

  return {
    artifactId: ARTIFACT_ID,
    source: 'bundled',
    version: options.version,
    architecture: options.architecture,
    executablePath,
    trust: 'verified',
    sha256: actualDigest,
  };
}

export class IOSSimulatorPackagedSidecarArtifactResolver implements IOSSimulatorSidecarArtifactResolver {
  readonly #options: IOSSimulatorPackagedArtifactResolverOptions;

  constructor(options: IOSSimulatorPackagedArtifactResolverOptions) {
    this.#options = { ...options };
  }

  async resolve(
    _input: IOSSimulatorNativeSidecarStartOptions,
  ): Promise<IOSSimulatorSidecarArtifactDescriptor> {
    const executablePath = iosSimulatorPackagedHelperExecutablePath(this.#options.resourcesPath);
    try {
      return await verifyIOSSimulatorPackagedSidecarArtifact(this.#options);
    } catch {
      return {
        artifactId: ARTIFACT_ID,
        source: 'bundled',
        version: this.#options.version,
        architecture: this.#options.architecture,
        executablePath,
        trust: 'untrusted',
        sha256: null,
      };
    }
  }
}

export async function verifyIOSSimulatorSidecarDigest(
  executablePath: string,
  expectedSha256: string,
): Promise<void> {
  if (!SHA256.test(expectedSha256)) fail();
  const metadata = await lstat(executablePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail();
  const actualDigest = await sha256File(executablePath);
  if (!digestMatches(actualDigest, expectedSha256)) fail();
}
