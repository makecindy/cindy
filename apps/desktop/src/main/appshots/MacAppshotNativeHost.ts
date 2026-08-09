import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { AppshotCaptureError, type AppshotFailureCode } from './coordinator.js';

export interface MacAppshotNativeResult {
  pngPath: string;
  applicationName: string;
  bundleIdentifier: string | null;
  windowTitle: string | null;
  accessibilityText: string | null;
  accessibilityTruncated: boolean;
  accessibilityUnavailableReason?: 'permission' | 'unsupported' | 'timeout';
}

const HELPER_RESOURCE = path.join('tools', 'appshots', 'xdt-macos-appshot-helper');
const HELPER_SOURCE_RELATIVE = path.join('native', 'appshots', 'macos-appshot-helper.swift');
const HELPER_TIMEOUT_MS = 10_000;
const HELPER_BUILD_TIMEOUT_MS = 30_000;
const HELPER_SELF_TEST_TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_SELF_TEST_STDOUT_BYTES = 4 * 1024;
const MAX_SCALAR_BYTES = 4 * 1024;
const MAX_ACCESSIBILITY_BYTES = 512 * 1024;
const DEPLOYMENT_TARGET = 'macos14.0';
const BUILD_RECIPE_VERSION = 'v1';
const SWIFTC_FLAGS = ['-O'] as const;
const MAX_PUBLISH_ATTEMPTS = 3;
let helperBinaryPromise: Promise<string> | null = null;

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface CandidateValidation {
  valid: boolean;
  identity: FileIdentity | null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedString(value: unknown, allowEmpty = true): value is string {
  return typeof value === 'string' && byteLength(value) <= MAX_SCALAR_BYTES && (allowEmpty || value.length > 0);
}

function isNullableBoundedString(value: unknown): value is string | null {
  return value === null || isBoundedString(value);
}

function parseResult(stdout: string): MacAppshotNativeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new AppshotCaptureError('native-failure');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppshotCaptureError('native-failure');
  const value = raw as Record<string, unknown>;
  if (
    value.type !== 'capture'
    || !isBoundedString(value.pngPath, false)
    || !isBoundedString(value.applicationName, false)
    || !isNullableBoundedString(value.bundleIdentifier)
    || !isNullableBoundedString(value.windowTitle)
    || !(value.accessibilityText === null || (typeof value.accessibilityText === 'string' && byteLength(value.accessibilityText) <= MAX_ACCESSIBILITY_BYTES))
    || typeof value.accessibilityTruncated !== 'boolean'
    || !(value.accessibilityUnavailableReason === undefined || value.accessibilityUnavailableReason === 'permission' || value.accessibilityUnavailableReason === 'unsupported' || value.accessibilityUnavailableReason === 'timeout')
  ) {
    throw new AppshotCaptureError('native-failure');
  }
  return {
    pngPath: value.pngPath,
    applicationName: value.applicationName,
    bundleIdentifier: value.bundleIdentifier,
    windowTitle: value.windowTitle,
    accessibilityText: value.accessibilityText,
    accessibilityTruncated: value.accessibilityTruncated,
    ...(value.accessibilityUnavailableReason === undefined
      ? {}
      : { accessibilityUnavailableReason: value.accessibilityUnavailableReason }),
  };
}

function mapNativeFailure(stderr: string): AppshotFailureCode {
  if (stderr.includes('APPSHOT_SCREEN_PERMISSION')) return 'screen-permission';
  if (stderr.includes('APPSHOT_NO_WINDOW')) return 'no-window';
  if (stderr.includes('APPSHOT_WINDOW_CLOSED')) return 'window-closed';
  if (stderr.includes('APPSHOT_PROTECTED_CONTENT')) return 'protected-content';
  return 'native-failure';
}

function execHelper(binary: string, outputDir: string, selfTestBeforeCapture: boolean): Promise<string> {
  const args = selfTestBeforeCapture
    ? ['--self-test-and-capture', '--output-dir', outputDir]
    : ['--output-dir', outputDir];
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new AppshotCaptureError(mapNativeFailure(stderr)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class MacAppshotNativeHost {
  async capture(outputDir: string): Promise<MacAppshotNativeResult> {
    if (process.platform !== 'darwin') throw new AppshotCaptureError('unsupported-platform');
    const selfTestBeforeCapture = !app.isPackaged;
    const binary = await resolveMacAppshotHelperBinary();
    return parseResult(await execHelper(binary, outputDir, selfTestBeforeCapture));
  }
}

function resolveMacAppshotHelperBinary(): Promise<string> {
  if (!helperBinaryPromise) {
    helperBinaryPromise = buildMacAppshotHelperBinary().finally(() => {
      helperBinaryPromise = null;
    });
  }
  return helperBinaryPromise;
}

async function buildMacAppshotHelperBinary(): Promise<string> {
  if (app.isPackaged) return path.join(process.resourcesPath, HELPER_RESOURCE);
  const source = resolveDevHelperSource();
  const helperDirectory = path.join(app.getPath('userData'), 'appshots');
  try {
    const sourceBytes = fs.readFileSync(source);
    const target = targetForCurrentArchitecture();
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const cacheKey = createHash('sha256').update(JSON.stringify({
      buildRecipeVersion: BUILD_RECIPE_VERSION,
      architecture: process.arch,
      deploymentTarget: DEPLOYMENT_TARGET,
      sourceHash,
      target,
      flags: SWIFTC_FLAGS,
    })).digest('hex');
    fs.mkdirSync(helperDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(helperDirectory, 0o700);
    const binary = path.join(helperDirectory, `xdt-macos-appshot-helper-${cacheKey}`);
    // Old recipe-addressed helpers are intentionally retained as a tiny dev
    // cache. Age-based deletion can race another Cindy process executing one.
    const cachedCandidate = await validateHelperCandidate(binary);
    if (cachedCandidate.valid) return binary;
    removeCandidateIfUnchanged(binary, cachedCandidate.identity);

    const uniqueBuildId = `${process.pid}-${randomUUID()}`;
    const sourceSnapshot = path.join(
      helperDirectory,
      `.xdt-macos-appshot-helper-${cacheKey}-${uniqueBuildId}.swift`,
    );
    const temporaryBinary = path.join(
      helperDirectory,
      `.xdt-macos-appshot-helper-${cacheKey}-${uniqueBuildId}.tmp`,
    );
    try {
      fs.writeFileSync(sourceSnapshot, sourceBytes, { flag: 'wx', mode: 0o600 });
      await execSwiftc([
        sourceSnapshot,
        ...SWIFTC_FLAGS,
        '-target',
        target,
        '-o',
        temporaryBinary,
      ]);
      fs.chmodSync(temporaryBinary, 0o755);
      const compiledCandidate = await validateHelperCandidate(temporaryBinary);
      if (!compiledCandidate.valid || !compiledCandidate.identity) {
        throw new AppshotCaptureError('native-failure');
      }
      return await publishHelperCandidate(temporaryBinary, binary, compiledCandidate.identity);
    } finally {
      removeTemporaryFile(sourceSnapshot);
      removeTemporaryFile(temporaryBinary);
    }
  } catch {
    throw new AppshotCaptureError('native-failure');
  }
}

async function publishHelperCandidate(
  temporaryBinary: string,
  binary: string,
  validatedIdentity: FileIdentity,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const temporaryCandidate = inspectHelperCandidate(temporaryBinary);
    if (!temporaryCandidate?.executable || !sameIdentity(validatedIdentity, temporaryCandidate.identity)) {
      throw new AppshotCaptureError('native-failure');
    }
    try {
      // link is the no-clobber atomic publish primitive available in Node. A
      // competing process either installs this complete inode or wins with its
      // own complete inode; no process can observe a partial final path.
      fs.linkSync(temporaryBinary, binary);
      const publishedCandidate = inspectHelperCandidate(binary);
      if (!publishedCandidate?.executable || !sameIdentity(validatedIdentity, publishedCandidate.identity)) {
        removeCandidateIfUnchanged(binary, publishedCandidate?.identity ?? null);
        throw new AppshotCaptureError('native-failure');
      }
      return binary;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const winner = await validateHelperCandidate(binary);
    if (winner.valid) return binary;
    removeCandidateIfUnchanged(binary, winner.identity);
  }
  throw new AppshotCaptureError('native-failure');
}

function inspectHelperCandidate(filePath: string): { identity: FileIdentity; executable: boolean } | null {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (stat.dev === 0n || stat.ino === 0n) return null;
    const identity = { dev: stat.dev, ino: stat.ino };
    if (!stat.isFile() || stat.isSymbolicLink()) return { identity, executable: false };
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return { identity, executable: true };
    } catch {
      return { identity, executable: false };
    }
  } catch {
    return null;
  }
}

async function validateHelperCandidate(filePath: string): Promise<CandidateValidation> {
  const before = inspectHelperCandidate(filePath);
  if (!before?.executable) return { valid: false, identity: before?.identity ?? null };
  const selfTestPassed = await execHelperSelfTest(filePath);
  const after = inspectHelperCandidate(filePath);
  return {
    valid: selfTestPassed && Boolean(after?.executable) && sameIdentity(before.identity, after?.identity),
    identity: before.identity,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity | undefined): boolean {
  return Boolean(right) && left.dev === right?.dev && left.ino === right.ino;
}

function removeCandidateIfUnchanged(filePath: string, observed: FileIdentity | null): boolean {
  if (!observed) return false;
  const quarantined = `${filePath}.invalid-${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.renameSync(filePath, quarantined);
  } catch {
    return false;
  }
  const moved = inspectHelperCandidate(quarantined);
  if (moved && sameIdentity(observed, moved.identity)) {
    removeTemporaryFile(quarantined);
    return true;
  }

  try {
    // The path changed after validation. Restore that exact replacement under
    // the cache key without clobbering a still-newer process winner.
    fs.linkSync(quarantined, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new AppshotCaptureError('native-failure');
    }
  } finally {
    removeTemporaryFile(quarantined);
  }
  return false;
}

/** Narrow executable seam for exact filesystem-identity regression tests. */
export function __testOnlyRemoveCandidateIfUnchanged(
  filePath: string,
  observed: { dev: bigint; ino: bigint },
): boolean {
  return removeCandidateIfUnchanged(filePath, observed);
}

function removeTemporaryFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing temp means compilation failed before writing or cleanup already won.
  }
}

function targetForCurrentArchitecture(): string {
  if (process.arch === 'arm64') return `arm64-apple-${DEPLOYMENT_TARGET}`;
  if (process.arch === 'x64') return `x86_64-apple-${DEPLOYMENT_TARGET}`;
  throw new AppshotCaptureError('native-failure');
}

function resolveDevHelperSource(): string {
  const fromAppPath = path.join(app.getAppPath(), HELPER_SOURCE_RELATIVE);
  return fs.existsSync(fromAppPath) ? fromAppPath : path.join(__dirname, '..', '..', HELPER_SOURCE_RELATIVE);
}

function execSwiftc(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('swiftc', args, { timeout: HELPER_BUILD_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES }, (error) => {
      if (error) reject(new AppshotCaptureError('native-failure'));
      else resolve();
    });
  });
}

function execHelperSelfTest(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--self-test'],
      {
        timeout: HELPER_SELF_TEST_TIMEOUT_MS,
        maxBuffer: MAX_SELF_TEST_STDOUT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(isValidSelfTestResponse(stdout));
      },
    );
  });
}

function isValidSelfTestResponse(stdout: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return Object.keys(payload).length === 2 && payload.type === 'self-test' && payload.ok === true;
}
