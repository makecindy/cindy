import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { app } from 'electron';
import type { CindyMakeSyncDone, CindyMakeSyncState } from '../../shared/cindyMakeSync.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { createLogger } from '../logger.js';
import { cindyMakeManager } from './manager.js';
import { PersonalSync, type PersonalSyncRecord } from './personalSync.js';
import { hasUnbuiltPersonalChanges, personalRemoteForSync } from './personalRemoteRuntime.js';
import { PERSONAL_UPSTREAM_REF } from './sourceContent.js';
import { runSourceGit } from './sourceGit.js';
import { CINDY_PERSONAL_BRANCH, makeSourceCheckoutPath, makeSourceRoot } from './sourcePaths.js';
import { readCurrentCindySourceStatus } from './sourcePreparation.js';
import { validateCindyMakeTaskStart } from './taskRuntime.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import {
  abandonForSync,
  acceptForSync,
  combineForSync,
  resolveSyncTarget,
  resumeForSync,
  sourceOperation,
  updateForSync,
} from './upstreamMergeRuntime.js';

const COMMIT = /^[0-9a-f]{40}$/i;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only well-formed values survive; anything else is a fresh start. */
export function parseSyncRecord(raw: string | null): PersonalSyncRecord {
  let saved: { waiting?: unknown; done?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    // A truncated or otherwise malformed record is a fresh start, never a throw:
    // `load` runs at bootstrap, and the fresh record the contract promises must
    // not depend on a caller catching for it.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      saved = parsed as { waiting?: unknown; done?: unknown };
  } catch {
    saved = {};
  }
  const record: PersonalSyncRecord = {};
  if (typeof saved.waiting === 'string' && OPERATION_ID.test(saved.waiting))
    record.waiting = saved.waiting;
  const done = saved.done as Partial<CindyMakeSyncDone> | undefined;
  if (done && typeof done === 'object' && Number.isSafeInteger(done.at)) {
    const text = (value: unknown) =>
      typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
    const ref = text(done.ref);
    const held = text(done.held);
    record.done = {
      at: done.at!,
      ...(ref ? { ref } : {}),
      ...(held ? { held } : {}),
      ...(done.ahead === true ? { ahead: true } : {}),
      ...(done.uploadAfterBuild === true ? { uploadAfterBuild: true } : {}),
      ...(done.buildFirst === true ? { buildFirst: true } : {}),
      ...(text(done.generateFirst) ? { generateFirst: text(done.generateFirst) } : {}),
    };
  }
  return record;
}

const log = createLogger('cindy-make');
let sync: PersonalSync | undefined;

/** Called at bootstrap after the source-merge lifecycle and the GitHub binding. */
export function configurePersonalSync(): void {
  const userData = app.getPath('userData');
  const root = makeSourceRoot(userData);
  const source = makeSourceCheckoutPath(userData);
  // Beside the checkout like the other source-operation records; not owner data.
  const recordFile = path.join(root, 'sync.json');
  const git = async (args: string[]) => {
    const signal = AbortSignal.timeout(60_000);
    const tools = await createMakeToolchainEnvironment(userData);
    const env = await resolveMakeToolEnvironment(tools, ['git'], signal);
    return runSourceGit(env, args, source, signal);
  };
  const isAncestor = (ancestor: string, descendant: string) =>
    git(['merge-base', '--is-ancestor', ancestor, descendant]).then(
      () => true,
      (error) => {
        if ((error as { exitCode?: number }).exitCode === 1) return false;
        throw error;
      },
    );
  const readCommit = async (ref: string) => {
    const commit = (
      await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')
    ).trim();
    return COMMIT.test(commit) ? commit : undefined;
  };
  sync = new PersonalSync({
    remote: personalRemoteForSync,
    target: resolveSyncTarget,
    base: async () => {
      const recorded = await readCommit(PERSONAL_UPSTREAM_REF);
      const personal = await readCommit(`refs/heads/${CINDY_PERSONAL_BRANCH}`);
      // The recorded base is trusted only as the personal tip's ancestor — the
      // same clamp as the source-status and merge-runtime reads: an interrupted
      // move leaves "old tip + new base", and Sync seeing that base would skip
      // the update it needs while the source stays old. The shared history of
      // the two recovers the base the tip really sits on.
      if (recorded && (!personal || (await isAncestor(recorded, personal)))) return recorded;
      const clamped =
        recorded && personal
          ? (await git(['merge-base', personal, recorded]).catch(() => '')).trim()
          : '';
      if (COMMIT.test(clamped)) return clamped;
      // Sources prepared before the base was recorded: the official commit they were made
      // from (the same fallback the status uses). Recorded once so the combine reads it too.
      const tools = await createMakeToolchainEnvironment(userData);
      const derived = (await readCurrentCindySourceStatus(root, tools)).baseCommit;
      if (!derived || !COMMIT.test(derived) || !personal || !(await isAncestor(derived, personal)))
        return undefined;
      // Create-only: never overwrites a base recorded meanwhile.
      await git(['update-ref', PERSONAL_UPSTREAM_REF, derived, '']).catch(() => undefined);
      return readCommit(PERSONAL_UPSTREAM_REF);
    },
    isAncestor,
    unbuilt: async () => {
      const commit = await readCommit(`refs/heads/${CINDY_PERSONAL_BRANCH}`);
      if (!commit) return false;
      const tree = (await git(['rev-parse', `${commit}^{tree}`])).trim();
      return hasUnbuiltPersonalChanges(commit, tree);
    },
    operation: sourceOperation,
    resume: resumeForSync,
    combine: combineForSync,
    update: updateForSync,
    abandon: abandonForSync,
    accept: acceptForSync,
    reserve: () => cindyMakeManager.claimManualSourceSync(),
    load: () => parseSyncRecord(readAtomicFileSync(recordFile)),
    save: (record) => {
      mkdirSync(path.dirname(recordFile), { recursive: true });
      atomicWriteFileSync(recordFile, JSON.stringify(record));
    },
    publish: (state) => cindyMakeManager.setPersonalSync(state),
    now: Date.now,
    log,
  });
  cindyMakeManager.setPersonalSync(sync.state());
  // A conflict task Sync waited for was adopted (or abandoned): continue or report.
  cindyMakeManager.subscribe((state) => sync?.operationChanged(state.upstreamMerge));
}

/** IPC body for `app:cindy-make-sync`; local Desktop only, no device-link grant. */
export async function actPersonalSync(raw: unknown): Promise<CindyMakeSyncState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throwIpcError('INVALID_PARAMS', 'Invalid sync request');
  const { action, createOptions, side } = raw as Record<string, unknown>;
  if (
    action !== 'sync' &&
    action !== 'status' &&
    action !== 'abandon' &&
    action !== 'accept' &&
    action !== 'keep'
  )
    throwIpcError('INVALID_PARAMS', 'Invalid sync action');
  if (action === 'keep' && side !== 'github' && side !== 'local')
    throwIpcError('INVALID_PARAMS', 'Invalid sync side');
  if (!sync) throwIpcError('PRECONDITION_FAILED', 'unavailable');
  if (action === 'status') return sync.state();
  if (action === 'abandon') return sync.abandon();
  if (action === 'accept') return sync.accept();
  const options = validateCindyMakeTaskStart({
    runId: 'sync',
    request: 'sync',
    title: 'sync',
    createOptions,
  }).createOptions;
  return action === 'keep'
    ? sync.keep(side as 'github' | 'local', options)
    : sync.sync(options);
}
