/**
 * Harness binary status, shared by the Electron host and the Node host.
 *
 * The only host-specific inputs are injected: packaged identity, the profile
 * root, the dev lookup roots, and an optional extra candidate source (Desktop's
 * packaged Linux runtime fallback). Everything else — cached override, install
 * directory scan, executable checks — is one algorithm.
 */

import fs from 'node:fs';
import path from 'node:path';

export type AgentBinaryKind = 'claude-code' | 'codex' | 'pi';

export interface AgentBinaryLayout {
  /** `<userData>/<installSubdir>/<version>/<binaryName>` plus a `.verified` marker. */
  installSubdir: string;
  binaryName: string;
}

export interface CachedBinaryStatus {
  binaryReady: boolean;
  binaryPath?: string;
}

export interface ReadBinaryStatusOptions {
  kind: AgentBinaryKind;
  isPackaged: boolean;
  userDataDir: string;
  /** Absolute candidate paths for the dev checkout binary, in priority order. */
  devCandidates: readonly string[];
  /** Last path this process prepared; re-validated before use. */
  cachedPath?: string;
  /** Packaged-only fallback discovered by the callers that own those rules. */
  extraCandidate?: () => string | null;
}

export const AGENT_BINARY_LAYOUT: Record<AgentBinaryKind, AgentBinaryLayout> = {
  'claude-code': {
    installSubdir: 'claude-code',
    binaryName: process.platform === 'win32' ? 'claude.exe' : 'claude',
  },
  codex: {
    installSubdir: 'codex-package',
    binaryName: path.join('bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  },
  pi: {
    installSubdir: 'pi',
    binaryName: process.platform === 'win32' ? 'pi.exe' : 'pi',
  },
};

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous, network-free lookup. Never downloads or probes `--version`. */
export function readCachedBinaryStatus(options: ReadBinaryStatusOptions): CachedBinaryStatus {
  if (options.cachedPath && isExecutableFile(options.cachedPath)) {
    return { binaryReady: true, binaryPath: options.cachedPath };
  }
  if (!options.isPackaged) {
    const devPath = options.devCandidates.find(isExecutableFile);
    if (devPath) return { binaryReady: true, binaryPath: devPath };
  }
  const extra = options.extraCandidate?.();
  if (extra) return { binaryReady: true, binaryPath: extra };

  const layout = AGENT_BINARY_LAYOUT[options.kind];
  const installRoot = path.join(options.userDataDir, layout.installSubdir);
  try {
    for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const binary = path.join(installRoot, entry.name, layout.binaryName);
      if (fs.existsSync(binary) && fs.existsSync(path.join(installRoot, entry.name, '.verified'))) {
        return { binaryReady: true, binaryPath: binary };
      }
    }
  } catch {
    /* missing install root: not installed yet */
  }
  return { binaryReady: false };
}
