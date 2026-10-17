import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

/**
 * The device-level fact "the source at this snapshot carries personal changes
 * that are not generated on this computer yet and a failed generation could
 * still undo": recorded together with the source snapshot it describes, beside
 * the managed source (`makeSourceRoot`), never in the per-account build history.
 *
 * The managed source is shared by every Cindy account on the device while the
 * build history stays account-isolated, so "the current account has no receipts
 * for it" must never read as "the source has no pending generation". The
 * record's transitions keep the fact consistent with the source:
 *
 * - integrating a change records the resulting snapshot (before its receipt
 *   lands, so a crash in between never hides an unbuilt integration);
 * - generating a personal version settles the snapshot it was built from;
 * - a completed rollback or source restore drops the undone snapshot;
 * - an adopted rewrite (official update / combine) carries recorded snapshots
 *   over to the rewritten result that contains them.
 *
 * A missing or unreadable record proves nothing and must never read as
 * "nothing pending" (see hasPendingBuild). A valid record marked untrusted
 * preserves its snapshots but remains unknown until a successful generation.
 */

const FILE = 'pending-build.json';
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_FILE_BYTES = 256 * 1024;
/**
 * Generous bound against a damaged file growing without end. Newest entries are
 * kept: the snapshot the source is at is always the most recent one recorded,
 * and only a rollback chain longer than this could lose its oldest link.
 */
const MAX_SNAPSHOTS = 64;

export interface PendingBuildSnapshot {
  commit: string;
  tree: string;
}

interface PendingBuildLedger {
  snapshots: PendingBuildSnapshot[];
  readable: boolean;
  trusted: boolean;
}

const file = (root: string) => path.join(root, FILE);

/**
 * The recorded snapshots, oldest first. `undefined` means the record is
 * missing or unreadable — which proves nothing and must never read as
 * "nothing pending".
 */
function readLedger(root: string): PendingBuildLedger {
  let info;
  try {
    info = lstatSync(file(root));
    if (!info.isFile() || info.isSymbolicLink())
      return { snapshots: [], readable: false, trusted: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { snapshots: [], readable: false, trusted: false };
    return { snapshots: [], readable: false, trusted: false };
  }
  const raw = readAtomicFileSync(file(root));
  if (raw === null || raw.length > MAX_FILE_BYTES)
    return { snapshots: [], readable: false, trusted: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { snapshots: [], readable: false, trusted: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { snapshots: [], readable: false, trusted: false };
  const input = value as Record<string, unknown>;
  if (
    input.schema !== 1 ||
    !Array.isArray(input.snapshots) ||
    (input.trusted !== undefined && typeof input.trusted !== 'boolean')
  )
    return { snapshots: [], readable: false, trusted: false };
  const snapshots: PendingBuildSnapshot[] = [];
  for (const entry of input.snapshots) {
    const snapshot = entry as { commit?: unknown; tree?: unknown } | null;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      typeof snapshot.commit !== 'string' ||
      !HASH.test(snapshot.commit) ||
      typeof snapshot.tree !== 'string' ||
      !HASH.test(snapshot.tree)
    )
      return { snapshots: [], readable: false, trusted: false };
    snapshots.push({ commit: snapshot.commit, tree: snapshot.tree });
  }
  return { snapshots, readable: true, trusted: input.trusted !== false };
}

export function readPendingBuilds(root: string): PendingBuildSnapshot[] | undefined {
  const ledger = readLedger(root);
  return ledger.readable ? ledger.snapshots : undefined;
}

function writePendingBuilds(root: string, snapshots: PendingBuildSnapshot[], trusted = true): void {
  mkdirSync(root, { recursive: true });
  atomicWriteFileSync(file(root), JSON.stringify({ schema: 1, snapshots, trusted }));
}

/** Establish a clean ledger only for a newly-created source with no prior record. */
export function initializePendingBuilds(root: string): void {
  try {
    lstatSync(file(root));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  writePendingBuilds(root, []);
}

/** The snapshot no longer exists in the source: its fact is stale. Absent record: nothing to do. */
export function dropPendingBuild(root: string, snapshot: { commit: string; tree?: string }): void {
  const ledger = readLedger(root);
  const kept = ledger.snapshots.filter((entry) => entry.commit !== snapshot.commit);
  if (kept.length !== ledger.snapshots.length) writePendingBuilds(root, kept, ledger.trusted);
}

/**
 * The source moved to `snapshot` with changes that are not generated here yet.
 * Earlier snapshots stay recorded: a rollback chain steps back over them, and
 * each undone snapshot is dropped as the source leaves it.
 */
export function recordPendingBuild(root: string, snapshot: PendingBuildSnapshot): void {
  if (!HASH.test(snapshot.commit) || !HASH.test(snapshot.tree))
    throw new Error('Invalid pending build snapshot');
  const ledger = readLedger(root);
  const entries = ledger.snapshots.filter(
    (entry) => entry.commit !== snapshot.commit || entry.tree !== snapshot.tree,
  );
  entries.push(snapshot);
  const bounded = entries.slice(-MAX_SNAPSHOTS);
  // Losing an older snapshot also loses the proof that a rollback can still be
  // explained. Keep the entries for diagnostics, but force the next decision
  // through the unknown/failed-closed path until a generation settles them.
  writePendingBuilds(root, bounded, ledger.trusted && bounded.length === entries.length);
}

/**
 * A generated personal version settles the pending generation it was built
 * from, and with it every earlier snapshot its content carries: nothing left in
 * the source keeps waiting for a generation that already covered it. Source
 * moves queue behind the same project lock a build holds, so nothing can be
 * recorded against the built source in between.
 */
export function settlePendingBuilds(root: string): void {
  const ledger = readLedger(root);
  // A successful generation is the proof that settles even an unknown ledger.
  if (!ledger.trusted || ledger.snapshots.length) writePendingBuilds(root, []);
}

/**
 * An adopted rewrite (official update / combine) carried the recorded changes
 * into its result: the fact follows the content to the snapshot that now holds it.
 */
export function rewritePendingBuilds(
  root: string,
  from: readonly string[],
  to: PendingBuildSnapshot,
): void {
  if (!HASH.test(to.commit) || !HASH.test(to.tree)) return;
  const ledger = readLedger(root);
  const known = ledger.snapshots;
  const carried = new Set(from);
  const entries = known.map((entry) => (carried.has(entry.commit) ? to : entry));
  if (entries.some((entry) => entry === to)) {
    const unique = entries.filter(
      (entry, at) => entries.findIndex((other) => other === entry) === at,
    );
    const bounded = unique.slice(-MAX_SNAPSHOTS);
    writePendingBuilds(root, bounded, ledger.trusted && bounded.length === unique.length);
    return;
  }
  const bounded = entries.slice(-MAX_SNAPSHOTS);
  writePendingBuilds(root, bounded, ledger.trusted && bounded.length === entries.length);
}

/**
 * Whether the snapshot is recorded as carrying a pending generation. `undefined`
 * when the record cannot prove anything either way: the caller must then treat
 * the snapshot as pending unless a generated version already covers it.
 *
 * A commit names exactly one source snapshot, so the commit identifies the
 * record entry; the tree is kept with it as the snapshot's content identity.
 */
export function hasPendingBuild(
  root: string,
  head: { commit: string; tree: string },
): boolean | undefined {
  const ledger = readLedger(root);
  if (ledger.snapshots.some((entry) => entry.commit === head.commit)) return true;
  return ledger.trusted ? false : undefined;
}
