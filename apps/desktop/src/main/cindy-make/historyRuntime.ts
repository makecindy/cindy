import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { app, shell } from 'electron';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { cindyMakeManager } from './manager.js';
import { captureMakeHistoryStore } from './historyOwner.js';
import { captureMakeHistoryCompletion, captureMakeHistoryReport } from './historyCapture.js';
import { planFeatureChange } from './featurePlan.js';
import { taskCommitRef } from './sourceContent.js';
import { readLegacyFeatureReceipts } from './historyLegacy.js';
import { integrateMakeHistory, actUpstreamMerge } from './upstreamMergeRuntime.js';
import { manageCindyMakeTask } from './taskManagement.js';
import { actCindyMakeTest, cindyMakeTestController } from './testRuntime.js';
import {
  makeSourceCheckoutPath,
  makeSourceRoot,
  makeTaskWorktreePath,
  isCindyMakeWorktreePath,
} from './sourcePaths.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { runSourceGit } from './sourceGit.js';
import { verifyMakeTestWorkspace } from './testRunner.js';
import {
  buildCindyPersonal,
  personalArtifactPath,
  personalBuildEnvironment,
  type PersonalArtifact,
} from './personalBuild.js';
import { currentVersionProfile, rememberOriginalVersion } from './versionStartup.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  makeHistoryActions,
  activeFeatureReceipts,
  type CindyMakeHistoryState,
  type CindyMakeHistoryItem,
  type MakeHistoryAction,
  type MakeHistoryLifecycle,
  type MakeHistoryIntegration,
} from '../../shared/cindyMakeHistory.js';
import type { CindyMakePersonalBuildState } from '../../shared/cindyMakeSession.js';
import { parseCindyMakeBuildError } from '../../shared/cindyMakeSession.js';

const ID = /^[A-Za-z0-9-]{1,128}$/;
const HASH = /^[a-f0-9]{40,64}$/i;
const log = createLogger('cindy-make');
let running: (id: string) => boolean = () => true;
let buildJob:
  | {
      id: string;
      current: () => boolean;
      abort: AbortController;
      cancelled: boolean;
      done: Promise<void>;
    }
  | undefined;
export function configureMakeHistory(probe: typeof running): void {
  running = probe;
}
export function stopMakeHistoryBuild(): void {
  buildJob?.abort.abort();
}
/** A stale window cannot stop a newer build or one belonging to another owner. */
export async function cancelHistoryPersonalVersion(
  buildId: unknown,
): Promise<CindyMakeHistoryState> {
  if (typeof buildId !== 'string' || !ID.test(buildId))
    throwIpcError('INVALID_PARAMS', 'Invalid build identity');
  const h = context();
  const job = buildJob;
  const build = h.store.readBuild();
  if (!job && build?.buildId === buildId) {
    await cindyMakeTestController.cancelBuild(buildId);
    h.check();
  }
  let stoppingState: CindyMakePersonalBuildState | undefined;
  if (
    job &&
    job.id === buildId &&
    job.current() &&
    build?.buildId === buildId &&
    !['ready', 'failed'].includes(build.status)
  ) {
    stoppingState = { ...build, stopping: true };
    h.store.saveBuild(stoppingState);
    job.cancelled = true;
    job.abort.abort();
  }
  const next = await getCindyMakeHistory();
  return stoppingState && next.build?.error === 'cancelled'
    ? { ...next, build: stoppingState }
    : next;
}
function context() {
  const client = getDbClient();
  const owner = captureDataOwnerBroadcastScope();
  const store = captureMakeHistoryStore();
  const userData = app.getPath('userData');
  const current = () => {
    try {
      return (
        isDataOwnerBroadcastScopeCurrent(owner) &&
        getDbClient() === client &&
        app.getPath('userData') === userData
      );
    } catch {
      return false;
    }
  };
  const check = () => {
    if (!current()) throwIpcError('PRECONDITION_FAILED', 'unavailable');
  };
  check();
  return { client, owner, store, userData, current, check };
}
async function toolEnvironment(userData: string, signal: AbortSignal, build = false) {
  const tools = await createMakeToolchainEnvironment(userData);
  const env = await resolveMakeToolEnvironment(
    tools,
    build ? ['git', 'node', 'pnpm', 'python'] : ['git'],
    signal,
  );
  return { tools, env };
}

/** Hydrate old installations once from their own task facts; ended tasks are deliberately included. */
export async function getCindyMakeHistory(selectedRunId?: string): Promise<CindyMakeHistoryState> {
  const h = context();
  const rows = (
    await h.client.drizzle.select().from(sessions).where(eq(sessions.source, 'cindy-make'))
  ).filter(
    (row) =>
      !row.remoteHostId && row.workingDir && isCindyMakeWorktreePath(h.userData, row.workingDir),
  );
  h.check();
  const cards: Array<
    Pick<
      typeof messages.$inferSelect,
      'id' | 'sessionId' | 'clientId' | 'role' | 'content' | 'agentMeta' | 'createdAt'
    >
  > = [];
  for (let start = 0; start < rows.length; start += 100) {
    cards.push(
      ...(await h.client.drizzle
        .select({
          id: messages.id,
          sessionId: messages.sessionId,
          clientId: messages.clientId,
          role: messages.role,
          createdAt: messages.createdAt,
          agentMeta: messages.agentMeta,
          content: sql<string>`CASE WHEN ${messages.clientId} LIKE 'cindy-make-preparation-%' THEN ${messages.content} ELSE '' END`,
        })
        .from(messages)
        .where(
          and(
            inArray(
              messages.sessionId,
              rows.slice(start, start + 100).map((row) => row.id),
            ),
            isNull(messages.rewindAt),
            or(
              eq(messages.role, 'user'),
              like(messages.clientId, 'cindy-make-preparation-%'),
              sql`json_type(CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END, '$.cindyMakeCompletion') = 'object'`,
            ),
          ),
        )),
    );
    h.check();
  }
  const source = makeSourceCheckoutPath(h.userData);
  const sourceAvailable = existsSync(path.join(source, '.git'));
  for (const row of rows) {
    const runId = path.basename(row.workingDir!);
    const prep = cards.find(
      (card) => card.sessionId === row.id && card.clientId === 'cindy-make-preparation-' + runId,
    );
    let report;
    let originalRequest: string | undefined;
    try {
      const data = JSON.parse(prep?.content ?? '{}').__cindyMakeCard?.data;
      report = data?.report;
      if (typeof data?.request === 'string') originalRequest = data.request;
    } catch {
      /* A damaged legacy card is not invented history. */
    }
    if (report?.runId === runId && report.task?.sessionId === row.id)
      captureMakeHistoryReport(report, h.store, row.createdAt);
    h.store.seed({
      runId,
      sessionId: row.id,
      title: row.title ?? '',
      request: report?.task?.request ?? originalRequest ?? h.store.read(runId)?.request ?? '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt ?? row.createdAt,
    });
    const knownCompletions = new Map(
      h.store.read(runId)!.completions.map((entry) => [entry.id, entry]),
    );
    for (const card of cards.filter((entry) => entry.sessionId === row.id)) {
      try {
        const completion = JSON.parse(card.agentMeta ?? '{}').cindyMakeCompletion;
        if (completion && Number.isFinite(completion.reportedAt)) {
          const known = knownCompletions.get(card.clientId);
          const next = { ...completion, id: card.clientId };
          // A legacy tree was verified against this exact commit; an older card cannot erase it.
          if (!next.tree && next.commit === known?.commit && known?.tree) next.tree = known.tree;
          if (!next.baseTree && next.commit === known?.commit && known?.baseTree)
            next.baseTree = known.baseTree;
          if (JSON.stringify(next) !== JSON.stringify(known))
            captureMakeHistoryCompletion(h.store, runId, card.clientId, next);
        }
      } catch {
        /* Invalid legacy metadata cannot authorize an action. */
      }
    }
  }
  const state = cindyMakeManager.getState();
  let buildSourceAvailable =
    sourceAvailable &&
    (state.source?.currentBranch === undefined || state.source.currentBranch === 'cindy-personal');
  const pendingMerge =
    state.upstreamMerge &&
    state.upstreamMerge.status !== 'merged' &&
    state.upstreamMerge.hasWorkspace
      ? state.upstreamMerge
      : undefined;
  const globalBusy =
    !!buildJob || cindyMakeTestController.hasActiveJobs() || cindyMakeManager.hasActiveWork();
  const items: CindyMakeHistoryItem[] = [];
  for (const record of h.store.list()) {
    if (record.hiddenAt !== undefined) continue;
    const row = rows.find((entry) => entry.id === record.sessionId);
    const report = state.tasks?.[record.runId];
    const cleanup = state.taskActions?.[record.sessionId];
    const workspace = makeTaskWorktreePath(h.userData, record.runId);
    const workspaceAvailable = !record.endedAt && existsSync(path.join(workspace, '.git'));
    const completion = record.completions.at(-1);
    const completionMessage = cards.find(
      (card) => card.sessionId === record.sessionId && card.clientId === completion?.id,
    );
    const laterMessage =
      !completionMessage ||
      cards.some(
        (card) =>
          card.sessionId === record.sessionId &&
          card.role === 'user' &&
          (card.createdAt > completionMessage.createdAt ||
            (card.createdAt === completionMessage.createdAt && card.id > completionMessage.id)),
      );
    let completed =
      !!row &&
      (row.status === 'active' || record.endedAt !== undefined) &&
      !!completion &&
      !completion.continuedAt &&
      !laterMessage &&
      HASH.test(completion.commit ?? '') &&
      HASH.test(completion.tree ?? '');
    let lifecycle: MakeHistoryLifecycle = record.endedAt
      ? 'ended'
      : report?.task?.cleanupPending ||
          cleanup?.status === 'failed' ||
          (row?.status === 'deleted' && existsSync(workspace))
        ? 'cleanup'
        : row?.status === 'deleted' || !row
          ? 'ended'
          : report?.status === 'running'
            ? 'preparing'
            : running(record.sessionId)
              ? 'running'
              : report?.status === 'failed' || report?.status === 'cancelled'
                ? 'failed'
                : completed
                  ? 'ready'
                  : 'editing';
    let changedSinceCompletion =
      !!completion?.continuedAt || laterMessage || running(record.sessionId);
    if (
      completed &&
      row?.status === 'active' &&
      completion &&
      (['starting', 'ready'].includes(completion.test?.status ?? '') ||
        ['waiting', 'checking', 'merging', 'packaging', 'publishing'].includes(
          completion.personal?.status ?? '',
        ))
    ) {
      // Reuse the task card's live job lookup and restart recovery. Settings must
      // never independently guess whether a persisted test is still running.
      try {
        const current = await cindyMakeTestController.act(
          record.sessionId,
          completion.id,
          'status',
        );
        Object.assign(completion, current);
        if (current.continuedAt) completed = false;
      } catch {
        // A newer user message/clear can invalidate the completion during this read.
        // Drop its controls; do not fail the entire history or revive an old test.
        completed = false;
      }
      h.check();
      if (!completed) {
        lifecycle = 'editing';
        changedSinceCompletion = true;
      }
    }
    let verifiedSource = sourceAvailable;
    let personalHead: string | undefined;
    if (selectedRunId === record.runId && sourceAvailable && !globalBusy && !pendingMerge) {
      let checkedBranch = false;
      try {
        const signal = AbortSignal.timeout(15000);
        const { env } = await toolEnvironment(h.userData, signal);
        h.check();
        buildSourceAvailable =
          (await runSourceGit(env, ['branch', '--show-current'], source, signal)) ===
          'cindy-personal';
        checkedBranch = true;
        if (!buildSourceAvailable) throw new Error('Source branch changed');
        const git = (args: string[], cwd: string) => runSourceGit(env, args, cwd, signal);
        personalHead = (await git(['rev-parse', 'HEAD'], source)).trim();
        if (completion && HASH.test(completion.commit ?? '') && !completion.tree) {
          const tree = (await git(['rev-parse', completion.commit + '^{tree}'], source)).trim();
          if (HASH.test(tree)) {
            h.check();
            Object.assign(
              completion,
              h.store.verifyCompletionFacts(record.runId, completion.id, completion.commit!, {
                tree,
              }),
            );
            completed =
              !!row &&
              (row.status === 'active' || record.endedAt !== undefined) &&
              !completion.continuedAt &&
              !laterMessage;
            if (completed && lifecycle === 'editing') lifecycle = 'ready';
          }
        }
        const legacy = await readLegacyFeatureReceipts(record, git, source);
        h.check();
        for (const receipt of legacy) {
          h.store.receipt(record.runId, receipt);
          record.receipts.push(receipt);
          const built = record.completions.find(
            (entry) => entry.personal?.commit === receipt.commit,
          )?.personal;
          if (built)
            h.store.version(record.runId, {
              operationId: receipt.id,
              commit: receipt.commit,
              versionId: built.versionId,
              at: built.generatedAt,
            });
        }
        if (legacy.length) record.versions = h.store.read(record.runId)!.versions;
        if (completion && !completion.baseTree && workspaceAvailable) {
          const base = await git(
            ['rev-parse', '--verify', 'refs/cindy-make/tasks/' + record.runId + '/base^{tree}'],
            source,
          ).catch(() => '');
          if (HASH.test(base.trim())) {
            h.check();
            Object.assign(
              completion,
              h.store.verifyCompletionFacts(record.runId, completion.id, completion.commit!, {
                baseTree: base.trim(),
              }),
            );
          }
        }
        for (const receipt of record.receipts)
          for (const tree of [receipt.beforeTree, receipt.tree])
            await runSourceGit(env, ['cat-file', '-e', tree + '^{tree}'], source, signal);
        if (HASH.test(completion?.commit ?? '') && HASH.test(completion?.tree ?? '')) {
          try {
            if (workspaceAvailable) {
              await verifyMakeTestWorkspace(
                {
                  userData: h.userData,
                  workingDir: workspace,
                  runId: record.runId,
                  commit: completion!.commit!,
                  tree: completion!.tree,
                },
                env,
                signal,
              );
            } else {
              const savedCommit = (
                await runSourceGit(
                  env,
                  ['rev-parse', '--verify', taskCommitRef(record.runId) + '^{commit}'],
                  source,
                  signal,
                )
              ).trim();
              const savedTree = (
                await runSourceGit(env, ['rev-parse', savedCommit + '^{tree}'], source, signal)
              ).trim();
              if (savedCommit !== completion!.commit || savedTree !== completion!.tree)
                throw new Error('Completion commit is not retained');
            }
            changedSinceCompletion = false;
          } catch (error) {
            if ((error as { code?: string }).code === 'changed') {
              completed = false;
              lifecycle = 'editing';
              changedSinceCompletion = true;
            } else verifiedSource = false;
          }
        }
      } catch {
        verifiedSource = false;
        if (!checkedBranch) buildSourceAvailable = false;
      }
      h.check();
    }
    const last = record.receipts.at(-1);
    let integration: MakeHistoryIntegration =
      last?.action === 'revert'
        ? 'reverted'
        : last
          ? (changedSinceCompletion && lifecycle !== 'ended') || completion?.tree !== last.taskTree
            ? 'changed'
            : 'integrated'
          : !changedSinceCompletion &&
              completion?.baseTree &&
              completion.baseTree === completion.tree
            ? 'unchanged'
            : 'unintegrated';
    if (
      (!verifiedSource && last) ||
      (!last &&
        record.completions.some(
          (entry) =>
            entry.personal?.status === 'ready' && !Array.isArray(entry.personal.includedFeatures),
        ))
    )
      integration = 'unknown';
    const operation = pendingMerge?.feature?.runId === record.runId ? pendingMerge : undefined;
    const targetBusy =
      running(record.sessionId) ||
      cindyMakeManager.isTaskPreparing(record.sessionId) ||
      cleanup?.status === 'running' ||
      cindyMakeTestController.isUsingWorkspace?.(workspace) === true;
    const blockedByGlobalWork = globalBusy || (!!pendingMerge && !operation);
    const version = record.versions.at(-1);
    const needsBuild =
      !!last &&
      (version?.operationId !== last.id || (!!personalHead && version?.commit !== personalHead));
    const taskBuilding = cindyMakeTestController.isBuilding(record.sessionId);
    const test =
      completed && lifecycle === 'ready' && completion?.lastAction !== 'build'
        ? completion?.test
        : undefined;
    const taskBuild = completion?.personal;
    const projectedBuild =
      taskBuild && !taskBuilding && !['ready', 'failed'].includes(taskBuild.status)
        ? { status: 'failed' as const, error: 'interrupted' as const }
        : taskBuild;
    const historyActions = makeHistoryActions({
      lifecycle,
      integration,
      sessionAvailable: !!row && row.status !== 'deleted',
      workspaceAvailable,
      sourceAvailable: verifiedSource,
      completed,
      test,
      buildFailed: completion?.personal?.status === 'failed',
      needsBuild,
      buildSourceAvailable,
      canEdit: row?.status === 'active' && !!record.request.trim(),
      hasReceipts:
        last?.action === 'revert'
          ? last.beforeTree !== last.tree
          : activeFeatureReceipts(record.receipts).some(
              (receipt) => receipt.beforeTree !== receipt.tree,
            ),
      newChanges: completion?.tree !== last?.taskTree,
      busy: blockedByGlobalWork || record.runId !== selectedRunId || running(record.sessionId),
      allowCleanupWhileBusy: blockedByGlobalWork && !targetBusy && !operation,
      conflict: !!operation,
      recoverableFailure: operation?.status === 'failed' && !operation.feature?.awaitingResolution,
    });
    items.push({
      ...record,
      lifecycle,
      integration,
      build: projectedBuild,
      test,
      completionId: completed ? completion?.id : undefined,
      resolutionSessionId: operation?.sessionId,
      conflict: !!operation?.feature?.awaitingResolution,
      operationError:
        operation?.error ?? (cleanup?.status === 'failed' ? cleanup.error : undefined),
      operation:
        operation && !['failed', 'conflict', 'resolving'].includes(operation.status)
          ? operation.feature!.action
          : taskBuilding
            ? 'build'
            : cleanup?.status === 'running'
              ? 'end'
              : undefined,
      needsBuild,
      actions: historyActions,
      actionReason:
        historyActions.length === 0 ||
        (targetBusy && historyActions.length === 1 && historyActions[0] === 'open')
          ? blockedByGlobalWork || running(record.sessionId)
            ? 'busy'
            : record.runId !== selectedRunId
              ? 'checking'
              : !row || row.status === 'deleted'
                ? 'sessionUnavailable'
                : completion?.continuedAt || (completion && laterMessage)
                  ? 'changedAfterCompletion'
                  : !completed
                    ? 'completionUnavailable'
                    : !verifiedSource
                      ? 'sourceUnavailable'
                      : 'ended'
          : undefined,
      canHide: !targetBusy && !['starting', 'ready'].includes(test?.status ?? ''),
    });
  }
  const build = readCindyMakeBuildState();
  h.check();
  return {
    items,
    busy: globalBusy || !!pendingMerge,
    canBuild: buildSourceAvailable && !globalBusy && !pendingMerge,
    build,
  };
}

/** The same restart reconciliation for local history and portable task cards. */
export function readCindyMakeBuildState(): CindyMakePersonalBuildState | undefined {
  const h = context();
  let build = h.store.readBuild();
  const activeBuild = cindyMakeTestController.activeBuild();
  if (
    build &&
    !buildJob &&
    !(activeBuild?.buildId && activeBuild.buildId === build.buildId) &&
    !['ready', 'failed'].includes(build.status)
  ) {
    build = { ...build, status: 'failed', stopping: undefined, error: 'interrupted' };
    h.store.saveBuild(build);
  }
  h.check();
  return build;
}

export async function actCindyMakeHistory(
  runId: unknown,
  action: unknown,
): Promise<CindyMakeHistoryState> {
  if (typeof runId !== 'string' || !ID.test(runId) || typeof action !== 'string')
    throwIpcError('INVALID_PARAMS', 'Invalid history action');
  const h = context();
  const state = await getCindyMakeHistory(runId);
  h.check();
  const item = state.items.find((entry) => entry.runId === runId);
  const canHide = action === 'hide' && item?.canHide === true;
  // Keep a stale cleanup button harmless when this record itself is still
  // running, preparing, being tested, or already cleaning.  The snapshot
  // carries the stable reason so Renderer can show the actionable busy tip
  // immediately instead of reporting a generic unavailable action.
  if (item?.actionReason === 'busy' && ['end', 'retry-cleanup', 'hide'].includes(action))
    throwIpcError('PRECONDITION_FAILED', 'busy');
  if (!item || (!item.actions.includes(action as MakeHistoryAction) && !canHide))
    throwIpcError('PRECONDITION_FAILED', 'unavailable');
  if (action === 'build') return generateHistoryPersonalVersion();
  if (action === 'hide') {
    // An ended record has already gone through the canonical task cleanup path.
    // Active/cleanup records must finish that path before they become dismissible.
    if (item.lifecycle !== 'ended') await manageCindyMakeTask(item.sessionId, 'end');
    h.store.hide(runId);
  } else if (action === 'end' || action === 'retry-cleanup')
    await manageCindyMakeTask(item.sessionId, 'end');
  else if (action === 'test' || action === 'continue')
    await actCindyMakeTest(
      item.sessionId,
      item.completionId,
      action === 'test' ? 'start' : 'continue',
    );
  else if (action === 'resolve' || action === 'retry')
    await actUpstreamMerge({ action: 'resolve' });
  else if (action === 'integrate' || action === 'revert' || action === 'reapply') {
    await withSessionRouteLock(item.sessionId, async () => {
      h.check();
      if (running(item.sessionId) || cindyMakeManager.isTaskPreparing(item.sessionId))
        throwIpcError('PRECONDITION_FAILED', 'busy');
      if (buildJob || cindyMakeTestController.hasActiveJobs() || cindyMakeManager.hasActiveWork())
        throwIpcError('PRECONDITION_FAILED', 'busy');
      const [row] = await h.client.drizzle
        .select()
        .from(sessions)
        .where(eq(sessions.id, item.sessionId))
        .limit(1);
      h.check();
      const record = h.store.read(runId)!;
      if (record.receipts.at(-1)?.id !== item.receipts.at(-1)?.id)
        throwIpcError('PRECONDITION_FAILED', 'busy');
      const completion = record.completions.find((entry) => entry.id === item.completionId);
      if (action === 'integrate') {
        if (!completion) throwIpcError('PRECONDITION_FAILED', 'unavailable');
        const signal = AbortSignal.timeout(15000);
        const { env } = await toolEnvironment(h.userData, signal);
        const workspaceExists = !!row?.workingDir && existsSync(path.join(row.workingDir, '.git'));
        if (workspaceExists) {
          await verifyMakeTestWorkspace(
            {
              userData: h.userData,
              workingDir: row!.workingDir!,
              runId,
              commit: completion.commit!,
              tree: completion.tree,
            },
            env,
            signal,
          );
        } else {
          const savedCommit = (
            await runSourceGit(
              env,
              ['rev-parse', '--verify', taskCommitRef(runId) + '^{commit}'],
              makeSourceCheckoutPath(h.userData),
              signal,
            )
          ).trim();
          const savedTree = (
            await runSourceGit(
              env,
              ['rev-parse', savedCommit + '^{tree}'],
              makeSourceCheckoutPath(h.userData),
              signal,
            )
          ).trim();
          if (savedCommit !== completion.commit || savedTree !== completion.tree)
            throwIpcError('PRECONDITION_FAILED', 'unavailable');
        }
        h.check();
      }
      const plan = planFeatureChange(record, action, completion);
      if (action === 'integrate' && !plan.mergeCommit && plan.steps.length === 0) return;
      await integrateMakeHistory(
        plan,
        row
          ? {
              agentKind: row.agentKind === 'codex' || row.agentKind === 'pi' ? row.agentKind : 'cc',
              model: row.model ?? undefined,
              providerId: row.providerId,
              effort: row.effort ?? undefined,
              permissionMode: row.permissionMode ?? undefined,
            }
          : undefined,
      );
    });
  } else throwIpcError('INVALID_PARAMS', 'This action is handled by task navigation');
  h.check();
  return getCindyMakeHistory(runId);
}

/** A source build has no synthetic task. It packages the current personal branch under the existing project lock. */
export async function generateHistoryPersonalVersion(): Promise<CindyMakeHistoryState> {
  const h = context();
  const state = await getCindyMakeHistory();
  h.check();
  if (
    !state.canBuild ||
    buildJob ||
    cindyMakeTestController.hasActiveJobs() ||
    cindyMakeManager.hasActiveWork()
  )
    throwIpcError('PRECONDITION_FAILED', 'busy');
  const releaseBuild = cindyMakeManager.claimPersonalBuild();
  const abort = new AbortController();
  const buildId = randomUUID();
  const startedAt = Date.now();
  const publish = async (build: CindyMakePersonalBuildState) => {
    h.check();
    // A late step notification must not erase a requested stop.
    if (job.cancelled && !['ready', 'failed'].includes(build.status)) return;
    h.store.saveBuild({ ...build, buildId, startedAt });
  };
  const job = { id: buildId, current: h.current, abort, cancelled: false, done: Promise.resolve() };
  buildJob = job;
  try {
    await publish({ status: 'waiting' });
  } catch (error) {
    if (buildJob === job) buildJob = undefined;
    releaseBuild();
    throw error;
  }
  job.done = cindyMakeManager
    .withProjectUse(makeSourceRoot(h.userData), async () => {
      const watcher = setInterval(() => {
        if (!h.current()) abort.abort();
      }, 1000);
      try {
        const { tools, env } = await toolEnvironment(h.userData, abort.signal, true);
        const node = await tools.probe('node', ['--version'], abort.signal);
        const git = await tools.probe('git', ['--version'], abort.signal);
        if (!node.path || node.status !== 'ok') throw new Error('environment');
        await rememberOriginalVersion(node.path);
        const artifact = await buildCindyPersonal(
          {
            mode: 'personal',
            userData: h.userData,
            completionId: buildId,
            title: '',
            profile: currentVersionProfile(),
          },
          node.path,
          await personalBuildEnvironment(env, git.path),
          CURRENT_CINDY_REGION,
          abort.signal,
          publish,
          h.check,
          (run) => cindyMakeManager.withProject(makeSourceRoot(h.userData), run),
          {
            features: () =>
              h.store.list().flatMap((record) => {
                const last = record.receipts.at(-1);
                return last ? [{ runId: record.runId, operationId: last.id }] : [];
              }),
          },
        );
        h.check();
        recordHistoryBuild(h.store, artifact);
        await publish({ status: 'ready', ...artifact, generatedAt: Date.now() });
      } catch (error) {
        if (h.current())
          await publish({
            status: 'failed',
            error:
              (error as { code?: unknown })?.code === 'cleanupFailed'
                ? 'cleanupFailed'
                : abort.signal.aborted
                  ? job.cancelled
                    ? 'cancelled'
                    : 'interrupted'
                  : parseCindyMakeBuildError((error as { code?: unknown })?.code),
          });
      } finally {
        clearInterval(watcher);
      }
    })
    .catch(() => {
      log.warn('Could not persist Cindy Make build result');
    })
    .finally(() => {
      if (buildJob === job) buildJob = undefined;
      releaseBuild();
    });
  return getCindyMakeHistory();
}
export function recordHistoryBuild(
  store: ReturnType<typeof captureMakeHistoryStore>,
  artifact: PersonalArtifact,
): void {
  for (const feature of artifact.includedFeatures ?? [])
    store.version(feature.runId, {
      operationId: feature.operationId,
      commit: artifact.commit,
      versionId: artifact.versionId,
      at: Date.now(),
    });
}
export async function openHistoryPersonalBuild(): Promise<void> {
  const h = context();
  const build = h.store.readBuild();
  if (build?.status !== 'ready' || !build.buildId || !ID.test(build.buildId))
    throwIpcError('PRECONDITION_FAILED', 'unavailable');
  try {
    const file = await personalArtifactPath(h.userData, build.buildId, build as PersonalArtifact);
    h.check();
    shell.showItemInFolder(file);
  } catch {
    if (h.current()) h.store.saveBuild({ ...build, status: 'failed', error: 'unavailable' });
    throwIpcError('PRECONDITION_FAILED', 'unavailable');
  }
}
