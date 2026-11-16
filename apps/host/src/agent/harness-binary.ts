/**
 * The engine binary the Host starts, chosen with the desktop's rules (agent-binaries/index.ts prepare
 * with localOnly, factory.ts findUsableLocalBinary):
 * 1. Pi's explicit selection (`<profile>/pi/selected.json`): a valid selection wins over every other
 *    binary; an invalid one leaves Pi unavailable (`pi_selection_invalid`) and never falls back to a
 *    higher leftover install.
 * 2. The Host's bundled or dev checkout binary.
 * 3. The profile install whose binary reports the highest version (not the first directory listed).
 * Read once when an owner runtime starts (main.ts); nothing here installs, updates or deletes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { AGENT_BINARY_LAYOUT, type AgentBinaryKind } from '../../../desktop/src/main/agent-binaries/binaryStatus.js';
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
