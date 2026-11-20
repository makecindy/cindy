/**
 * The engine binary the Host starts, chosen with the desktop's rules (agent-binaries/index.ts prepare
 * with localOnly, factory.ts findUsableLocalBinary):
 * 1. Pi's explicit selection (`<profile>/pi/selected.json`): a valid selection wins over every other
 *    binary; an invalid one leaves Pi unavailable (`pi_selection_invalid`) and never falls back to a
 *    higher leftover install.
 * 2. The Host's bundled or dev checkout binary.
 * 3. The profile install whose binary reports the highest version (not the first directory listed).
 * Read once when an owner runtime starts (main.ts); nothing here installs, updates or deletes. The
 * harness status the Host reports (probe and boot values) is then that choice, not a separate scan.
 */
import fs from 'node:fs';
import path from 'node:path';

import { AGENT_BINARY_LAYOUT, readCachedBinaryStatus, type AgentBinaryKind } from '../../../desktop/src/main/agent-binaries/binaryStatus.js';
import { probeBinaryVersion } from '../../../desktop/src/main/agent-binaries/binary-version-probe.js';
import { findPreferredLocalBinary } from '../../../desktop/src/main/agent-binaries/local-version-selection.js';
import { resolveSelectedPiBinary } from '../../../desktop/src/main/agent-binaries/pi-kernel-selection.js';

export interface HarnessBinary {
  binaryPath: string | null;
  /** As the desktop's prepare reports it: Pi has a selection that cannot be used. */
  error?: 'pi_selection_invalid';
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveHarnessBinaryPath(
  kind: AgentBinaryKind,
  options: { userDataDir: string; bundledCandidates: readonly string[] },
): Promise<HarnessBinary> {
  const layout = AGENT_BINARY_LAYOUT[kind];
  const installRoot = path.join(options.userDataDir, layout.installSubdir);
  if (kind === 'pi') {
    try {
      // The desktop's hasSelection + selectedBinary: null only when there is no selection.
      const selected = await resolveSelectedPiBinary(installRoot, probeBinaryVersion);
      if (selected) return { binaryPath: selected };
    } catch {
      // Do not resurrect a higher leftover version after an explicit downgrade.
      return { binaryPath: null, error: 'pi_selection_invalid' };
    }
  }
  const bundled = options.bundledCandidates.find(isExecutableFile);
  if (bundled) return { binaryPath: bundled };
  const local = await findPreferredLocalBinary(() => installRoot, layout.binaryName, undefined, probeBinaryVersion);
  return { binaryPath: local?.binaryPath ?? null };
}

/** The engines the Host runs, in the order the desktop's dev lookup uses. */
export const HOST_HARNESS_KINDS = ['claude-code', 'codex', 'pi'] as const;
const platformKey = `${process.platform}-${process.arch}`;

/** The Host's bundled or dev checkout binary of an engine. */
function bundledHarnessBinary(kind: AgentBinaryKind, harnessRoot: string): string {
  const layout = kind === 'claude-code'
    ? { dir: 'claude-code-bin', file: AGENT_BINARY_LAYOUT['claude-code'].binaryName }
    : kind === 'codex'
      ? { dir: 'codex-package-bin', file: AGENT_BINARY_LAYOUT.codex.binaryName }
      : { dir: 'pi-bin', file: AGENT_BINARY_LAYOUT.pi.binaryName };
  return path.join(harnessRoot, layout.dir, platformKey, layout.file);
}

export interface HostHarnessBinaries {
  /** Choose every engine binary (resolveHarnessBinaryPath); status() reports this choice from then on. */
  resolve(): Promise<Record<AgentBinaryKind, string | null>>;
  /**
   * Whether each engine can start. Once resolve() has run, an engine is ready only when its chosen
   * binary is still executable: an invalid Pi selection is not ready even with a higher install left.
   * Before that (no owner runtime yet), the synchronous scan of binaryStatus.ts.
   */
  status(): Record<AgentBinaryKind, boolean>;
}

export function createHostHarnessBinaries(ports: {
  userDataDir: () => string;
  harnessRoot: () => string;
  onUnavailable: (kind: AgentBinaryKind, error: 'pi_selection_invalid') => void;
}): HostHarnessBinaries {
  let chosen: Record<AgentBinaryKind, string | null> | null = null;
  return {
    async resolve() {
      const entries = await Promise.all(HOST_HARNESS_KINDS.map(async (kind) => {
        const resolved = await resolveHarnessBinaryPath(kind, {
          userDataDir: ports.userDataDir(),
          bundledCandidates: [bundledHarnessBinary(kind, ports.harnessRoot())],
        });
        if (resolved.error) ports.onUnavailable(kind, resolved.error);
        return [kind, resolved.binaryPath] as const;
      }));
      chosen = Object.fromEntries(entries) as Record<AgentBinaryKind, string | null>;
      return chosen;
    },
    status() {
      const current = chosen;
      return Object.fromEntries(HOST_HARNESS_KINDS.map((kind) => {
        if (current) {
          const binary = current[kind];
          return [kind, binary !== null && isExecutableFile(binary)];
        }
        const status = readCachedBinaryStatus({
          kind,
          isPackaged: false,
          userDataDir: ports.userDataDir(),
          devCandidates: [bundledHarnessBinary(kind, ports.harnessRoot())].map((candidate) => path.resolve(candidate)),
        });
        return [kind, status.binaryReady];
      })) as Record<AgentBinaryKind, boolean>;
    },
  };
}
