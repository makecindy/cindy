import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WINDOWS_UPDATER_RUNTIME_MISSING_ERROR_CODE =
  'windows_vc_runtime_missing';

export const WINDOWS_UPDATER_RUNTIME_DIRECTORY = 'cindy-updater-runtime';

export const WINDOWS_UPDATER_RUNTIME_FILES = [
  'vcruntime140.dll',
  'vcruntime140_1.dll',
] as const;

interface WindowsUpdaterRuntimeManifestFile {
  name: string;
  size: number;
  sha256: string;
  fileVersion: string;
  signer: string;
}

export interface WindowsUpdaterRuntimeManifest {
  schemaVersion: number;
  component: string;
  version: string;
  architecture: string;
  files: WindowsUpdaterRuntimeManifestFile[];
}

export interface WindowsUpdaterPrerequisiteResult {
  satisfied: boolean;
  missingFiles: string[];
}

export type WindowsUpdaterRuntimeStageResult =
  | 'staged'
  | 'fallback-safe'
  | 'blocked';

function isNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runtimeDirectory(resourcesPath: string): string {
  return path.join(resourcesPath, WINDOWS_UPDATER_RUNTIME_DIRECTORY);
}

function validateRuntimeFile(
  directory: string,
  entry: WindowsUpdaterRuntimeManifestFile,
): void {
  const filePath = path.join(directory, entry.name);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size !== entry.size) {
    throw new Error(
      `${entry.name} size mismatch: expected ${entry.size}, got ${stat.isFile() ? stat.size : 'not a file'}`,
    );
  }
  const actualHash = sha256File(filePath);
  if (actualHash !== entry.sha256.toLowerCase()) {
    throw new Error(
      `${entry.name} sha256 mismatch: expected ${entry.sha256}, got ${actualHash}`,
    );
  }
}

/** Keep the proprietary x64 Runtime out of every non-Windows artifact. */
export function windowsUpdaterRuntimeExtraResourceForTarget(
  targetPlatform: string,
): string | null {
  return targetPlatform === 'win32'
    ? `resources/${WINDOWS_UPDATER_RUNTIME_DIRECTORY}`
    : null;
}

/**
 * Validate the vendored app-local runtime exactly as it will be shipped.
 * Packaging calls this as a fail-closed gate; runtime probing catches the
 * error and can still fall back to a machine-wide VC++ Runtime installation.
 */
export function validateBundledWindowsUpdaterRuntime(
  resourcesPath: string,
): WindowsUpdaterRuntimeManifest {
  const directory = runtimeDirectory(resourcesPath);
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as WindowsUpdaterRuntimeManifest;

  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `unsupported Windows updater runtime manifest schema: ${manifest.schemaVersion}`,
    );
  }
  if (manifest.architecture !== 'x64') {
    throw new Error(`Windows updater runtime must be x64, got ${manifest.architecture}`);
  }
  if (!manifest.version) {
    throw new Error('Windows updater runtime manifest version is empty');
  }

  const expectedNames = new Set<string>(WINDOWS_UPDATER_RUNTIME_FILES);
  const actualNames = new Set(manifest.files.map((entry) => entry.name));
  if (
    manifest.files.length !== expectedNames.size
    || actualNames.size !== expectedNames.size
    || [...expectedNames].some((name) => !actualNames.has(name))
  ) {
    throw new Error(
      'Windows updater runtime manifest file set does not match loader dependencies',
    );
  }

  for (const entry of manifest.files) {
    if (!expectedNames.has(entry.name)) {
      throw new Error(`unexpected Windows updater runtime file: ${entry.name}`);
    }
    if (!entry.fileVersion || !entry.signer || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`invalid provenance metadata for ${entry.name}`);
    }
    validateRuntimeFile(directory, entry);
  }

  return manifest;
}

function hasVerifiedBundledRuntime(resourcesPath: string | undefined): boolean {
  if (!resourcesPath) return false;
  try {
    validateBundledWindowsUpdaterRuntime(resourcesPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer the updater's verified app-local DLLs. A complete machine-wide x64
 * Runtime remains a fallback for damaged/legacy packages so the existing
 * no-retry-loop prompt can still recover the update.
 */
export function checkWindowsUpdaterPrerequisites(
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
  resourcesPath = process.resourcesPath,
): WindowsUpdaterPrerequisiteResult {
  if (hasVerifiedBundledRuntime(resourcesPath)) {
    return { satisfied: true, missingFiles: [] };
  }

  if (!systemRoot) {
    return {
      satisfied: false,
      missingFiles: [...WINDOWS_UPDATER_RUNTIME_FILES],
    };
  }

  const systemDirectory = path.join(systemRoot, 'System32');
  const missingFiles = WINDOWS_UPDATER_RUNTIME_FILES.filter(
    (fileName) => !isNonEmptyFile(path.join(systemDirectory, fileName)),
  );

  return {
    satisfied: missingFiles.length === 0,
    missingFiles,
  };
}

/**
 * Copy the verified app-local Runtime beside the timestamped updater executable.
 * `fallback-safe` means no app-local DLL remains and the caller may separately
 * validate System32. `blocked` means a partial DLL could not be removed, so the
 * updater must not start even when a machine-wide Runtime is installed.
 */
export function stageBundledWindowsUpdaterRuntime(
  resourcesPath: string,
  destinationDirectory: string,
): WindowsUpdaterRuntimeStageResult {
  let manifest: WindowsUpdaterRuntimeManifest;
  try {
    manifest = validateBundledWindowsUpdaterRuntime(resourcesPath);
  } catch {
    return 'fallback-safe';
  }

  const sourceDirectory = runtimeDirectory(resourcesPath);
  try {
    for (const entry of manifest.files) {
      fs.copyFileSync(
        path.join(sourceDirectory, entry.name),
        path.join(destinationDirectory, entry.name),
      );
    }
    // Verify the actual loader inputs after the copy. Source verification alone
    // leaves a gap where security software can quarantine or rewrite a target
    // DLL before the updater is spawned.
    for (const entry of manifest.files) {
      validateRuntimeFile(destinationDirectory, entry);
    }
    return 'staged';
  } catch {
    let cleanupFailed = false;
    for (const fileName of WINDOWS_UPDATER_RUNTIME_FILES) {
      try {
        fs.rmSync(path.join(destinationDirectory, fileName), { force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    // A corrupt app-local DLL shadows a valid System32 copy. Never report a
    // safe fallback unless every partial target was actually removed.
    const partialRuntimeRemains = WINDOWS_UPDATER_RUNTIME_FILES.some((fileName) =>
      fs.existsSync(path.join(destinationDirectory, fileName)));
    return cleanupFailed || partialRuntimeRemains ? 'blocked' : 'fallback-safe';
  }
}
