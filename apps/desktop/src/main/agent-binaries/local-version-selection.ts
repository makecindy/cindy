/**
 * The installed versions of an agent binary under one install root (`<root>/<version>/<binary>` with a
 * `.verified` marker) and the preferred one by the version each binary reports. Moved out of factory.ts
 * with the logic unchanged so a process without Electron (the Node Host) chooses the same install; the
 * install root is passed in (read when the scan runs, as factory.ts's getInstallRoot was) instead of
 * derived from app.getPath('userData'). Not every line is verbatim: the scan joins the binary and
 * `.verified` paths on the root it read once, where factory.ts's getFinalBinPath and getVerifiedMarker
 * went through getInstallRoot (and its idempotent mkdir) for each path; the paths are the same.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  isBinaryVersionNotOlder,
  normalizeBinaryVersion,
} from './binary-version-probe.js';

export interface VerifiedBinaryCandidate {
  directoryVersion: string;
  binaryPath: string;
}

/** List executable installs carrying the provisioner's completed-download marker. */
export function listVerifiedBinaries(
  installRoot: () => string,
  binaryName: string,
): VerifiedBinaryCandidate[] {
  try {
    const root = installRoot();
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        directoryVersion: entry.name,
        binaryPath: path.join(root, entry.name, binaryName),
      }))
      .filter((candidate) => {
        try {
          fs.accessSync(path.join(root, candidate.directoryVersion, '.verified'));
          fs.accessSync(candidate.binaryPath, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Choose the highest real local semver that is not older than the manifest.
 * A resolver failure is deliberately ignored so this additive check can never
 * turn the existing exact-manifest path into a startup failure.
 */
export async function findPreferredLocalBinary(
  installRoot: () => string,
  binaryName: string,
  manifestVersion: string | undefined,
  resolveVersion:
    ((binaryPath: string, signal?: AbortSignal) => Promise<string | null>) | undefined,
  signal?: AbortSignal,
): Promise<{ version: string; binaryPath: string } | null> {
  const requiredVersion = manifestVersion === undefined ? null : normalizeBinaryVersion(manifestVersion);
  if (!resolveVersion || (manifestVersion !== undefined && !requiredVersion)) return null;

  // Probe all completed installs concurrently so one broken candidate cannot hide
  // a self-updated runtime or multiply the bounded probe delay.
  const resolved = await Promise.all(
    listVerifiedBinaries(installRoot, binaryName).map(async (candidate) => {
      try {
        const reported = await resolveVersion(candidate.binaryPath, signal);
        const version = reported ? normalizeBinaryVersion(reported) : null;
        return version ? { version, binaryPath: candidate.binaryPath } : null;
      } catch {
        return null;
      }
    }),
  );
  return resolved.reduce<{ version: string; binaryPath: string } | null>((preferred, candidate) => {
    if (!candidate || (requiredVersion !== null && !isBinaryVersionNotOlder(candidate.version, requiredVersion)))
      return preferred;
    return !preferred || isBinaryVersionNotOlder(candidate.version, preferred.version)
      ? candidate
      : preferred;
  }, null);
}
