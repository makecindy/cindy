/**
 * The explicit Pi kernel selection (`<root>/selected.json`) and the binary it names: moved out of
 * PiKernelManager (pi-kernel-manager.ts readSelection and selectedBinary) with the logic unchanged so a
 * process without Electron (the Node Host) honors the same selection with the same checks. Not every
 * line is verbatim: the private methods became functions that take the install root and the probe in
 * place of this.deps.root and this.deps.probe, and VERSION and Selection are exported.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PiKernelSource } from '../../shared/piKernel.js';
import { readAtomicFileSync } from '../utils/atomicWriteFile.js';

export const VERSION = /^\d+\.\d+\.\d+$/;
export interface Selection { schema: 1; source: PiKernelSource; version: string; directory: string }
export class PiKernelError extends Error {
  constructor(readonly reason: 'busy' | 'version-changed' | 'install-failed' | 'selection-invalid') {
    super(reason);
  }
}

function selectionFile(root: string): string { return path.join(root, 'selected.json'); }

/** The saved selection, null when there is none; a malformed one is `selection-invalid`. */
export function readPiKernelSelection(root: string): Selection | null {
  const raw = readAtomicFileSync(selectionFile(root));
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as Selection;
    if (s.schema !== 1 || !['official', 'upstream'].includes(s.source) || !VERSION.test(s.version)
      || typeof s.directory !== 'string' || !s.directory.startsWith(`${s.version}-`)
      || !/^\d+\.\d+\.\d+-[a-f0-9-]{36}$/.test(s.directory)) throw new Error();
    return s;
  } catch { throw new PiKernelError('selection-invalid'); }
}

/** A saved downgrade wins over every higher leftover install. Never silently reselect. */
export async function resolveSelectedPiBinary(
  root: string,
  probe: (binary: string, signal?: AbortSignal) => Promise<string | null>,
  signal?: AbortSignal,
): Promise<string | null> {
  const selection = readPiKernelSelection(root);
  if (!selection) return null;
  const directory = path.join(root, selection.directory);
  const executable = process.platform === 'win32' ? 'pi.exe' : 'pi';
  const binary = path.join(directory, executable);
  try {
    if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(binary)).isSymbolicLink()) throw new Error();
    await fs.access(path.join(directory, '.verified'));
    // Native/manual self-updates remain usable; the executable is the version authority.
    if (!await probe(binary, signal)) throw new Error();
    return binary;
  } catch { throw new PiKernelError('selection-invalid'); }
}
