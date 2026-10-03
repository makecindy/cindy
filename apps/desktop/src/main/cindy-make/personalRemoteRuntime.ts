import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { app } from 'electron';

import {
  CINDY_MAKE_REMOTE_ACTIONS,
  type CindyMakePersonalRemoteAction,
  type CindyMakePersonalRemoteState,
} from '../../shared/cindyMakePersonalRemote.js';
import { getSharedGhCliTokenSource } from '../git-context/ghCliTokenSource.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { readGhostSecret } from '../secrets/providerSecretStore.js';
import { readAtomicFileSync, atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { hasUnbuiltHistory } from './buildRollback.js';
import type { PersonalSyncRemote } from './personalSync.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { cindyMakeManager } from './manager.js';
import {
  PersonalRemoteController,
  PersonalRemoteError,
  adoptedRewrite,
  ensureOfficialFork,
  findPersonalFork,
  inspectPersonalFork,
  parsePersonalRemoteRecord,
  personalGitEnv,
  readGithubIdentity,
  type PersonalRemoteGitOptions,
} from './personalRemote.js';
import { runSourceGit } from './sourceGit.js';
import { readCurrentCindySourceStatus } from './sourcePreparation.js';
import { makeSourceCheckoutPath, makeSourceRoot } from './sourcePaths.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { hasPublishedPersonalVersionCommit } from './versionStore.js';
import {
  ContributionError,
  PersonalContribution,
  parseContributionStore,
} from './personalContribution.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import {
  CONTRIBUTION_LIMITS,
  type CindyMakeContributionDraft,
  type CindyMakeContributionView,
} from '../../shared/cindyMakeContribution.js';

const log = createLogger('cindy-make');
let controller: PersonalRemoteController | undefined;
let contribution: PersonalContribution | undefined;

/** Called explicitly at bootstrap; the module itself has no import-time side effects. */
export function configurePersonalRemote(): void {
  const userData = app.getPath('userData');
  const root = makeSourceRoot(userData);
  const file = path.join(root, 'personal-remote.json');
  const source = makeSourceCheckoutPath(userData);
  const read = () => parsePersonalRemoteRecord(readAtomicFileSync(file));
  // Same credential order as the shared GitHub connection: the gh login, then
  // the current account's saved token. Neither is ever returned to the renderer.
  const identity = () =>
    readGithubIdentity({
      readToken: async () =>
        (await getSharedGhCliTokenSource().readToken()) ??
        readGhostSecret('cindy-github', 'github_pat'),
      fetch: outboundFetch,
    });
  const git = async (args: string[], cwd: string, options?: PersonalRemoteGitOptions) => {
    const signal = AbortSignal.timeout(3 * 60_000);
    const tools = await createMakeToolchainEnvironment(userData);
    const env = await resolveMakeToolEnvironment(tools, ['git'], signal);
    return runSourceGit(personalGitEnv(env, options), args, cwd, signal);
  };
  controller = new PersonalRemoteController({
    source,
    read,
    write: (record) => {
      mkdirSync(root, { recursive: true });
      atomicWriteFileSync(file, JSON.stringify(record));
    },
    identity,
    ensureFork: (identity) => ensureOfficialFork(outboundFetch, identity),
    findPersonalFork: (identity) => findPersonalFork(outboundFetch, identity),
    inspectFork: (identity, repository) => inspectPersonalFork(outboundFetch, identity, repository),
    git,
    sourceExists: () => existsSync(path.join(source, '.git')),
    withProject: (run) =>
      cindyMakeManager.withProjectUse(root, () => cindyMakeManager.withProject(root, run)),
    withSourceUse: (run) => cindyMakeManager.withSourceReader(root, run),
    hasUnbuiltChanges: (commit, tree) => hasUnbuiltPersonalChanges(commit, tree),
    isBuilt: (commit) => hasPublishedPersonalVersionCommit(userData, commit),
    sourceSettled: (withinSync) => cindyMakeManager.isSourceSettled(root, withinSync),
    officialBase: async () => {
      const tools = await createMakeToolchainEnvironment(userData);
      return (await readCurrentCindySourceStatus(root, tools)).baseCommit;
    },
    sourceChanged: () => {
      void (async () => {
        const tools = await createMakeToolchainEnvironment(userData);
        await cindyMakeManager.refreshSourceStatus(() => readCurrentCindySourceStatus(root, tools));
      })().catch(() => undefined);
    },
    publish: (state) => cindyMakeManager.setPersonalRemote(state),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log,
  });
  const contributions = () => ownerScopedUserDataPath('cindy-make-contributions.json');
  contribution = new PersonalContribution({
    source,
    ownerScope: () => activeOwnerScopeKey(),
    binding: read,
    identity,
    inspectFork: (identity, repository) => inspectPersonalFork(outboundFetch, identity, repository),
    git,
    // The latest completed round of this computer's change: its creation baseline and content.
    change: (runId) => {
      const record = captureMakeHistoryStore().read(runId);
      const completion = record?.completions.findLast((entry) => entry.tree && entry.baseTree);
      return record && completion?.tree && completion.baseTree
        ? {
            title: record.title,
            request: record.request,
            baseTree: completion.baseTree,
            tree: completion.tree,
          }
        : undefined;
    },
    ledgerPath: contributions,
    readStore: (file) => parseContributionStore(readAtomicFileSync(file)),
    writeStore: (file, store) => {
      mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFileSync(file, JSON.stringify(store));
    },
    fetch: outboundFetch,
    gitIdentity: async () => {
      const value = async (key: string) =>
        (await git(['config', '--get', key], source).catch(() => '')).trim() || undefined;
      return { name: await value('user.name'), email: await value('user.email') };
    },
    withSourceUse: (run) => cindyMakeManager.withSourceReader(root, run),
    now: Date.now,
  });
  // Share each newly established personal version: after a generation settles
  // (a failed one has already been rolled back) and after an official update this
  // session watched being adopted. A result restored at startup is not replayed.
  let building = cindyMakeManager.isPersonalBuildRunning();
  let merge = cindyMakeManager.getState().upstreamMerge;
  let recorded = '';
  cindyMakeManager.subscribe((state) => {
    let changed = false;
    const running = cindyMakeManager.isPersonalBuildRunning();
    if (building && !running) changed = true;
    building = running;
    const next = state.upstreamMerge;
    // Every adopted official update or combine (also one restored at startup) is lineage
    // that lets the upload replace the fork's version without losing a change.
    const rewrite = next && adoptedRewrite(next);
    const lineage = rewrite ? `${next!.id}:${rewrite.to}` : '';
    // Only an adopted result is recorded here (and by the pre-move journal): a
    // candidate the user abandons must never evict a real, still-reachable
    // source from the trust ledger.
    if (rewrite && lineage !== recorded) {
      recorded = lineage;
      try {
        journalMergeProvenance(next!);
      } catch (error) {
        // A late re-record of an already-adopted result may fail harmlessly: the
        // pre-move journal has guarded the adoption itself (see
        // `journalMergeProvenance`).
        log.warn('cindy-make personal remote: lineage not recorded', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    if (
      next?.status === 'merged' &&
      !next.feature &&
      merge?.id === next.id &&
      merge.status !== 'merged'
    )
      changed = true;
    merge = next;
    if (changed) controller?.autoSync();
  });
}

/**
 * The personal version at `commit` carries integrations a failed generation could still
 * undo (or a build rollback is pending): it is not established yet.
 */
export async function hasUnbuiltPersonalChanges(commit: string, tree: string): Promise<boolean> {
  const userData = app.getPath('userData');
  const store = captureMakeHistoryStore();
  return (
    store.readBuildRollback().length > 0 ||
    hasUnbuiltHistory(store, { commit, tree }, (candidate) =>
      hasPublishedPersonalVersionCommit(userData, candidate),
    )
  );
}

/**
 * Durably record where an adopted update or combine carried content this computer
 * has not verified yet, and the rewrite that carries it under new commits. Called
 * before the personal source moves to the rewritten result: afterwards the old tip
 * is no longer an ancestor of the result, and a crash between the move and the
 * merged-state publish must never leave the carried content looking verified.
 * A failure to write these facts must stop the adoption, so it is never swallowed
 * here — only the subscriber's late re-record may tolerate one.
 */
export function journalMergeProvenance(state: {
  status: string;
  feature?: unknown;
  baselineCommit?: string;
  commit?: string;
  remote?: { commit?: string };
}): void {
  const rewrite = adoptedRewrite(state);
  if (!rewrite) return;
  if (!controller) throw new Error('personal remote not configured');
  if (state.remote?.commit) controller.recordUnverifiedRemote(state.remote.commit);
  controller.recordRewrite(rewrite.from, rewrite.to);
}

/** The GitHub steps of Sync; undefined when the personal version is not shared there. */
export function personalRemoteForSync(): PersonalSyncRemote | undefined {
  const remote = controller;
  const state = remote?.state();
  if (!remote || !state?.repository || state.choice !== 'github') return undefined;
  return {
    sync: () => remote.syncNow(),
    tips: () => remote.fetchedTips(),
    keep: (side) => remote.keepSide(side),
  };
}

/** A new task branches from `cindy-personal`: include changes saved by other computers first. */
export async function syncPersonalRemoteBeforeTask(): Promise<void> {
  try {
    await controller?.syncBeforeTask();
  } catch {
    // Never block a task; the Settings row reports a failed synchronization.
  }
}

/** IPC body for `app:cindy-make-personal-remote`; local Desktop only, no device-link grant. */
export async function actPersonalRemote(raw: unknown): Promise<CindyMakePersonalRemoteState> {
  if (typeof raw !== 'string' || !(CINDY_MAKE_REMOTE_ACTIONS as readonly string[]).includes(raw))
    throwIpcError('INVALID_PARAMS', 'Invalid personal remote action');
  if (!controller) throwIpcError('PRECONDITION_FAILED', 'Personal remote is unavailable');
  const action = raw as CindyMakePersonalRemoteAction;
  try {
    switch (action) {
      case 'status':
        return await controller.status();
      case 'refresh':
        return await controller.refresh();
      case 'save':
        return controller.save();
      case 'sync':
        return controller.sync();
      case 'keep-local':
        return controller.keepLocal();
      case 'disconnect':
        return await controller.disconnect();
    }
  } catch (error) {
    if (error instanceof PersonalRemoteError) throwIpcError('PRECONDITION_FAILED', error.code);
    if ((error as { code?: unknown })?.code === 'busy')
      throwIpcError('PRECONDITION_FAILED', 'busy');
    throwIpcError('PRECONDITION_FAILED', 'Personal remote is unavailable');
  }
}

const textField = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

/** IPC body for `app:cindy-make-contribution`; submitting is local Desktop only. */
export async function actCindyMakeContribution(
  raw: unknown,
): Promise<CindyMakeContributionView[] | CindyMakeContributionDraft | CindyMakeContributionView> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throwIpcError('INVALID_PARAMS', 'Invalid contribution request');
  const input = raw as Record<string, unknown>;
  const service = contribution;
  if (!service) throwIpcError('PRECONDITION_FAILED', 'unavailable');
  if (input.action === 'status') return service.statuses();
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(input.runId))
    throwIpcError('INVALID_PARAMS', 'Invalid contribution change');
  const runId = input.runId;
  const submit =
    input.action === 'submit' &&
    textField(input.title, CONTRIBUTION_LIMITS.title) &&
    textField(input.body, CONTRIBUTION_LIMITS.body) &&
    textField(input.name, CONTRIBUTION_LIMITS.name) &&
    textField(input.email, CONTRIBUTION_LIMITS.email);
  if (input.action !== 'draft' && !submit)
    throwIpcError('INVALID_PARAMS', 'Invalid contribution request');
  try {
    return input.action === 'draft'
      ? await service.draft(runId)
      : await service.submit({
          runId,
          title: input.title as string,
          body: input.body as string,
          name: input.name as string,
          email: input.email as string,
        });
  } catch (error) {
    if (error instanceof ContributionError) throwIpcError('PRECONDITION_FAILED', error.code);
    throwIpcError('PRECONDITION_FAILED', 'failed');
  }
}
