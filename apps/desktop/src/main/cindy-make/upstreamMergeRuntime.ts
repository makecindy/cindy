import path from 'node:path';
import { existsSync } from 'node:fs';
import { app, net } from 'electron';
import type { CindyMakeMergeState, MakeFeatureMergePlan } from '../../shared/cindyMakeMerge.js';
import type { CindyMakeTaskOptions } from '../../shared/cindyMakeDoctor.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { readAtomicFileSync, atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { makeSourceRoot } from './sourcePaths.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { readCurrentCindySourceStatus } from './sourcePreparation.js';
import { createLatestSourceVersionReader } from './latestSourceVersion.js';
import { runSourceGit } from './sourceGit.js';
import { cindyMakeManager } from './manager.js';
import { validateCindyMakeTaskStart } from './taskRuntime.js';
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
  type MergeGit,
} from './upstreamMerge.js';

const log = createLogger('cindy-make');
let controller: UpstreamMergeController | undefined;
let unavailable = false;
const ownerKey = () => captureDataOwnerBroadcastScope().ownerScopeKey ?? '';

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
      applied: async (state, isCurrent) => {
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
      },
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
      cleanup: async (state) => {
        if (state.sessionId) return;
        // Only reclaim the exact file tree already adopted by the personal checkout.
        try {
          await cleanupMergedCandidate(userData, state, await git());
        } catch {
          log.warn('Upstream merge completed; worktree cleanup deferred', {
            operationId: state.id,
          });
        }
      },
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
): Promise<CindyMakeMergeState | undefined> {
  if (!controller || unavailable) throw mergeError('unavailable');
  return controller.feature(plan, options);
}

export function assertUpstreamMergeTaskWritable(sessionId: string): void {
  if (controller?.isApplying(sessionId))
    throwIpcError('PRECONDITION_FAILED', 'Upstream merge is being applied');
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
