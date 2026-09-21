import path from 'node:path';
import { existsSync } from 'node:fs';
import { app, net } from 'electron';
import type { CindyMakeMergeState, MakeFeatureMergePlan } from '../../shared/cindyMakeMerge.js';
import type { CindyMakeTaskOptions } from '../../shared/cindyMakeDoctor.js';
import type { CindyMakePersonalBuildState } from '../../shared/cindyMakeSession.js';
import { personalBuildError } from './personalBuild.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { readAtomicFileSync, atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { CINDY_PERSONAL_BRANCH, makeSourceRoot, makeSourceCheckoutPath } from './sourcePaths.js';
import { snapshotContent } from './sourceContent.js';
import { rollbackUnbuiltHistory } from './buildRollback.js';
import { hasPublishedPersonalVersionCommit } from './versionStore.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { readCurrentCindySourceStatus } from './sourcePreparation.js';
import { createLatestSourceVersionReader } from './latestSourceVersion.js';
import { runSourceGit } from './sourceGit.js';
import { cindyMakeManager } from './manager.js';
import { validateCindyMakeTaskStart } from './taskRuntime.js';
import { cleanupCompletedMakeMergeTask } from './taskManagement.js';
import { ensureUpstreamMergeSession, assertUpstreamMergeSession } from './upstreamMergeSession.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { UpstreamMergeController, parseSavedUpstreamMerge } from './upstreamMergeController.js';
import {
  prepareUpstreamMerge,
  applyUpstreamMerge,
  verifyMergeWorktree,
  mergeWorktree,
  mergeError,
  prepareFeatureMerge,
  applyFeatureMerge,
  cleanupMergedCandidate,
  cancelUpstreamMerge,
  discardFeatureMerge,
  type MergeGit,
} from './upstreamMerge.js';

const log = createLogger('cindy-make');
let controller: UpstreamMergeController | undefined;
let unavailable = false;
const ownerKey = () => captureDataOwnerBroadcastScope().ownerScopeKey ?? '';

function recordAppliedMerge(state: CindyMakeMergeState, isCurrent: () => boolean): void {
  if (
    !state.feature ||
    !state.commit ||
    !state.tree ||
    !state.baselineCommit ||
    !state.baselineTree
  )
    return;
  if (!isCurrent()) throw mergeError('busy');
  captureMakeHistoryStore().receipt(state.feature.runId, {
    id: state.id,
    action: state.feature.action,
    at: Date.now(),
    baselineCommit: state.baselineCommit,
    commit: state.commit,
    beforeTree: state.baselineTree,
    tree: state.tree,
    taskTree: state.feature.taskTree,
  });
}

/** The Git adoption can survive a crash before its result reaches the state file. */
async function recoverAppliedMergeReceipt(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
  isCurrent: () => boolean,
): Promise<void> {
  const source = makeSourceCheckoutPath(userData);
  const command: MergeGit = (args, cwd, index) => {
    if (!isCurrent()) throw mergeError('busy');
    return git(args, cwd, index);
  };
  const retainedCommit = async (ref: string): Promise<string | undefined> => {
    const exists = await command(['show-ref', '--verify', '--quiet', ref], source).then(
      () => true,
      (error) => {
        if ((error as { exitCode?: number }).exitCode === 1) return false;
        throw error;
      },
    );
    if (!exists) return;
    const commit = (await command(['show-ref', '--verify', '--hash', ref], source)).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw mergeError('unavailable');
    if ((await command(['rev-parse', commit + '^{commit}'], source)).trim() !== commit)
      throw mergeError('unavailable');
    return commit;
  };
  const commit =
    state.commit ?? (await retainedCommit('refs/cindy-make/features/' + state.id + '/after'));
  if (!commit) return;
  if (!state.feature || !state.baselineCommit || !state.baselineTree)
    throw mergeError('unavailable');
  const head = (await command(['rev-parse', 'HEAD'], source)).trim();
  // The ref is written before adoption, and survives rollback. Neither case
  // authorizes reinserting a receipt for a change no longer in the source.
  if (head === state.baselineCommit && head !== commit) return;
  if (head !== commit) {
    if ((await retainedCommit('refs/cindy-make/failed-builds/' + commit)) === commit) return;
    throw mergeError('baselineChanged');
  }
  const tree = (await command(['rev-parse', commit + '^{tree}'], source)).trim();
  if (
    !/^[0-9a-f]{40}$/i.test(tree) ||
    (state.tree !== undefined && state.tree !== tree) ||
    (await command(['rev-parse', state.baselineCommit + '^{tree}'], source)).trim() !==
      state.baselineTree ||
    (await command(['rev-parse', '--abbrev-ref', 'HEAD'], source)).trim() !==
      CINDY_PERSONAL_BRANCH ||
    (await command(['status', '--porcelain'], source)).trim() ||
    (await snapshotContent(command, source)) !== tree
  )
    throw mergeError('baselineChanged');
  await command(['merge-base', '--is-ancestor', state.baselineCommit, commit], source);
  recordAppliedMerge({ ...state, commit, tree }, isCurrent);
}

/** Called explicitly at bootstrap, before source reset can be invoked. */
export function configureUpstreamMerge(isRunning: (id: string) => boolean): void {
  const userData = app.getPath('userData');
  const root = makeSourceRoot(userData);
  const stateFile = path.join(root, 'upstream-merge.json');
  let savedOwner: string | undefined;
  const git = async (): Promise<MergeGit> => {
    const signal = AbortSignal.timeout(3 * 60_000);
    const env = await createMakeToolchainEnvironment(userData);
    const processEnv = await resolveMakeToolEnvironment(env, ['git'], signal);
    return (args, cwd, indexFile) =>
      runSourceGit(
        { ...processEnv, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
        args,
        cwd,
        signal,
      );
  };
  const refresh = async () => {
    const env = await createMakeToolchainEnvironment(userData);
    await cindyMakeManager.refreshSourceStatus(() => readCurrentCindySourceStatus(root, env));
  };
  try {
    controller = new UpstreamMergeController({
      read: () => {
        const raw = readAtomicFileSync(stateFile);
        if (raw === null) return;
        const saved = parseSavedUpstreamMerge(raw, userData);
        savedOwner = saved.sessionOwner;
        return saved;
      },
      write: (saved) => {
        atomicWriteFileSync(stateFile, JSON.stringify(saved));
        savedOwner = saved.sessionOwner;
      },
      publish: (state) =>
        cindyMakeManager.setUpstreamMerge(state, () => !savedOwner || savedOwner === ownerKey()),
      owner: ownerKey,
      hasWorkspace: (state) => existsSync(mergeWorktree(userData, state.id)),
      exclusive: (run) =>
        cindyMakeManager.withProjectUse(root, () =>
          cindyMakeManager.withProject(root, async () => {
            if (cindyMakeManager.isPreparingSource(root)) throw mergeError('busy');
            return run();
          }),
        ),
      latest: async () => {
        const env = await createMakeToolchainEnvironment(userData);
        const source = await readCurrentCindySourceStatus(root, env);
        const channel = !app.isPackaged
          ? 'dev'
          : /-beta(?:\.|$)/i.test(app.getVersion())
            ? 'beta'
            : 'release';
        // An explicit update gets a fresh pin rather than the Settings display cache.
        const { latestVersion } = await createLatestSourceVersionReader((url, init) =>
          net.fetch(url, init),
        )(source, channel);
        if (latestVersion?.status !== 'ready') throw mergeError('unavailable');
        return latestVersion;
      },
      prepare: async (state, publish) =>
        prepareUpstreamMerge(userData, state, await git(), publish),
      prepareFeature: async (state, plan, publish, isCurrent) => {
        if (!isCurrent() || isRunning(plan.taskSessionId)) throw mergeError('busy');
        return prepareFeatureMerge(userData, state, plan, await git(), publish, isCurrent);
      },
      applied: async (state, isCurrent) => recordAppliedMerge(state, isCurrent),
      apply: async (state, isCurrent, publish) => {
        if (state.feature && (!state.sessionId || state.commit))
          return applyFeatureMerge(userData, state, await git(), isCurrent, publish);
        if (!state.sessionId) throw mergeError('unavailable');
        return withSessionRouteLock(state.sessionId, async () => {
          if (!isCurrent()) throw mergeError('busy');
          await assertUpstreamMergeSession(userData, state);
          return state.feature
            ? applyFeatureMerge(userData, state, await git(), isCurrent, publish)
            : applyUpstreamMerge(userData, state, await git(), isCurrent);
        });
      },
      session: async (state, options, bind, isCurrent) => {
        if (!ownerKey()) throw mergeError('unavailable');
        await verifyMergeWorktree(userData, state, await git());
        try {
          return await ensureUpstreamMergeSession(userData, state, options, bind, isCurrent);
        } catch (error) {
          if ((error as { code?: string })?.code === 'busy') throw error;
          throw mergeError('startFailed');
        }
      },
      running: isRunning,
      refresh,
      cancel: async (state, isCurrent) =>
        cancelUpstreamMerge(userData, state, await git(), isCurrent),
      discard: (state, isCurrent) =>
        cindyMakeManager.withProjectUse(root, async () => {
          const cleanup = async (canCleanup: () => boolean) => {
            const command = await git();
            return cindyMakeManager.withProject(root, async () => {
              // Recover before deleting the candidate: the durable after ref
              // covers crashes between source adoption and state/receipt writes.
              await recoverAppliedMergeReceipt(userData, state, command, canCleanup);
              if (!(await discardFeatureMerge(userData, state, command, canCleanup))) return false;
              if (!canCleanup()) return false;
              // Keep the cancellation receipt until both reclaim and rollback finish.
              // A restart/cleanup retry must undo the same unpublished prefix too.
              await rollbackUnbuiltHistory(
                captureMakeHistoryStore(),
                makeSourceCheckoutPath(userData),
                (args, cwd, index) => {
                  if (!canCleanup()) throw mergeError('busy');
                  return command(args, cwd, index);
                },
                (commit) => hasPublishedPersonalVersionCommit(userData, commit),
              );
              return true;
            });
          };
          // Recycle takes the session route lock and awaits actual runtime exit.
          // Acquire the project lock only afterwards, just as completed cleanup does.
          return state.sessionId
            ? cleanupCompletedMakeMergeTask(
                state.sessionId,
                mergeWorktree(userData, state.id),
                isCurrent,
                cleanup,
                true,
              )
            : cleanup(isCurrent);
        }),
      cleanup: (state, isCurrent) =>
        cindyMakeManager.withProjectUse(root, async () => {
          // Only reclaim the exact file tree already adopted by the personal checkout.
          try {
            const command = await git();
            if (state.sessionId)
              return await cleanupCompletedMakeMergeTask(
                state.sessionId,
                mergeWorktree(userData, state.id),
                isCurrent,
                (canCleanup) =>
                  cindyMakeManager.withProject(root, () =>
                    cleanupMergedCandidate(userData, state, command, canCleanup),
                  ),
              );
            return await cindyMakeManager.withProject(root, () =>
              cleanupMergedCandidate(userData, state, command, isCurrent),
            );
          } catch {
            log.warn('Upstream merge completed; worktree cleanup deferred', {
              operationId: state.id,
            });
            return false;
          }
        }),
    });
  } catch {
    unavailable = true;
    // Unreadable recovery data is never interpreted as permission to delete a candidate.
    cindyMakeManager.setUpstreamMerge({
      id: '',
      ref: '',
      upstreamCommit: '',
      status: 'failed',
      error: 'unavailable',
      hasWorkspace: true,
    });
    log.warn('Could not restore upstream merge state');
  }
}

export async function actUpstreamMerge(raw: unknown): Promise<CindyMakeMergeState | undefined> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throwIpcError('INVALID_PARAMS', 'Invalid upstream merge request');
  const { action, createOptions, operationId } = raw as Record<string, unknown>;
  if (!['update', 'resolve', 'cancel', 'status'].includes(String(action)))
    throwIpcError('INVALID_PARAMS', 'Invalid upstream merge action');
  if (
    (operationId !== undefined &&
      (typeof operationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId))) ||
    (action === 'cancel' && operationId === undefined)
  )
    throwIpcError('INVALID_PARAMS', 'Invalid upstream merge operation');
  const options = validateCindyMakeTaskStart({
    runId: 'merge',
    request: 'merge',
    title: 'merge',
    createOptions,
  }).createOptions;
  if (!controller || unavailable)
    throwIpcError('PRECONDITION_FAILED', 'Upstream merge is unavailable');
  try {
    return action === 'update'
      ? await controller.update(options)
      : action === 'resolve'
        ? await controller.resolve(options, operationId as string | undefined)
        : action === 'cancel'
          ? await controller.cancel(operationId as string)
          : controller.status();
  } catch {
    throwIpcError('PRECONDITION_FAILED', 'Upstream merge is unavailable');
  }
}

/** Only Main passes verified task facts here; renderer requests go through history admission. */
export async function integrateMakeHistory(
  plan: MakeFeatureMergePlan,
  options?: CindyMakeTaskOptions,
  signal?: AbortSignal,
): Promise<CindyMakeMergeState | undefined> {
  if (!controller || unavailable) throw mergeError('unavailable');
  return controller.feature(plan, options, signal);
}

export function assertUpstreamMergeTaskWritable(sessionId: string): void {
  if (controller?.isApplying(sessionId))
    throwIpcError('PRECONDITION_FAILED', 'Upstream merge is being applied');
}

/** Wait without holding a Git or task route lock: the resolution task needs both to finish. */
export async function waitForMakeHistoryMerge(
  state: CindyMakeMergeState | undefined,
  signal: AbortSignal,
  publish: (state: CindyMakePersonalBuildState) => Promise<void>,
): Promise<void> {
  if (!controller || !state) throw personalBuildError('unavailable');
  let step: CindyMakePersonalBuildState['mergeStep'];
  let sessionId: string | undefined;
  let writes = Promise.resolve();
  let result: CindyMakeMergeState;
  try {
    result = await controller.waitForCompletion(state.id, signal, (next) => {
      const nextStep =
        next.status === 'merged'
          ? 'cleanup'
          : next.status === 'resolving' || next.feature?.awaitingResolution
            ? 'conflicts'
            : undefined;
      if (!nextStep || (step === nextStep && sessionId === next.sessionId)) return;
      step = nextStep;
      sessionId = next.sessionId;
      writes = writes.then(() =>
        publish({
          status: 'merging',
          mergeStep: nextStep,
          mergeSessionId: next.sessionId,
        }),
      );
      void writes.catch(() => {});
    });
  } catch (error) {
    // A queued progress update can observe the aborted build and reject too.
    // Drain it without hiding a failure to clean up that cancellation.
    await writes.catch(() => undefined);
    if ((error as { code?: string })?.code === 'cancelFailed')
      throw personalBuildError('cleanupFailed');
    throw error;
  }
  await writes;
  signal.throwIfAborted();
  if (result.hasWorkspace || result.cleanupPending) throw personalBuildError('cleanupFailed');
}

export async function finishMakeHistoryCleanup(
  signal: AbortSignal,
  publish: (state: CindyMakePersonalBuildState) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const state = controller?.status();
  if (
    !(state?.feature && state.cancellationRequested) &&
    (state?.status !== 'merged' || (!state.hasWorkspace && !state.cleanupPending))
  )
    return;
  await publish({ status: 'merging', mergeStep: 'cleanup', mergeSessionId: state.sessionId });
  try {
    await controller!.finishPreviousCleanup();
  } catch {
    throw personalBuildError('cleanupFailed');
  }
  signal.throwIfAborted();
}

export async function interruptUpstreamMergeTurn(sessionId: string): Promise<void> {
  await controller?.interrupt(sessionId);
}
export function prepareUpstreamMergeTurn(sessionId: string): (() => void) | undefined {
  assertUpstreamMergeTaskWritable(sessionId);
  const dispatch = controller?.prepareTurn(sessionId);
  return (
    dispatch &&
    (() => {
      assertUpstreamMergeTaskWritable(sessionId);
      dispatch();
    })
  );
}
export function refreshUpstreamMergeProjection(): void {
  controller?.status();
}
export async function finishUpstreamMergeTurn(sessionId: string): Promise<void> {
  try {
    await controller?.finish(sessionId);
  } catch {
    log.warn('Could not finalize upstream merge task');
  }
}
