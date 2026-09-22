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
import { snapshotContent, taskCommitRef } from './sourceContent.js';
import { readLegacyFeatureReceipts } from './historyLegacy.js';
import {
  integrateMakeHistory,
  actUpstreamMerge,
  waitForMakeHistoryMerge,
  finishMakeHistoryCleanup,
  syncSourceBeforeCindyMakeBuild,
} from './upstreamMergeRuntime.js';
import type { CindyMakeMergeState } from '../../shared/cindyMakeMerge.js';
import type { MakeTestContext } from './testController.js';
import { manageCindyMakeTask } from './taskManagement.js';
import { historyBuildRollback, rollbackUnbuiltHistory } from './buildRollback.js';
import { makeBuildErrorDiagnostic } from './buildDiagnostic.js';
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
  personalBuildError,
  type PersonalArtifact,
} from './personalBuild.js';
import { currentVersionProfile, rememberOriginalVersion } from './versionStartup.js';
import { hasPublishedPersonalVersionCommit } from './versionStore.js';
import { readCindyMakeSettings } from './settingsStore.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { isSyntheticTriggerText } from '../../shared/interruptedTurn.js';
import {
  makeHistoryActions,
  activeFeatureReceipts,
  type CindyMakeHistoryState,
  type CindyMakeHistoryItem,
  type MakeHistoryAction,
  type MakeHistoryLifecycle,
  type MakeHistoryIntegration,
  type MakeHistoryBuildSelection,
} from '../../shared/cindyMakeHistory.js';
import type { CindyMakePersonalBuildState } from '../../shared/cindyMakeSession.js';
import {
  appendCindyMakeBuildLog,
  parseCindyMakeBuildError,
} from '../../shared/cindyMakeSession.js';

const ID = /^[A-Za-z0-9-]{1,128}$/;
const HASH = /^[a-f0-9]{40,64}$/i;
const log = createLogger('cindy-make');
let running: (id: string) => boolean = () => true;
let notifyHistoryChanged: () => void = () => {};
/** Owns a source build, including its ordered history merges, independently of Settings. */
interface HistoryBuildJob {
  id: string;
  current: () => boolean;
  abort: AbortController;
  cancelled: boolean;
  done: Promise<void>;
  batch?: CindyMakeHistoryState['batch'];
}
let buildJob: HistoryBuildJob | undefined;
type MakeHistoryCard = Pick<
  typeof messages.$inferSelect,
  'id' | 'sessionId' | 'clientId' | 'role' | 'content' | 'agentMeta' | 'createdAt'
>;

function chronologicalMessageOrder(a: MakeHistoryCard, b: MakeHistoryCard): number {
  return a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id));
}

/** Decode the user-authored text stored in a message's JSON content column. */
function decodeUserPrompt(raw: string): string | undefined {
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed.trim() ? parsed : undefined;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { text?: unknown }).text === 'string'
    ) {
      const text = (parsed as { text: string }).text;
      return text.trim() ? text : undefined;
    }
  } catch {
    return raw.trim() ? raw : undefined;
  }
  return;
}

function latestUserPromptBefore(
  userMessages: MakeHistoryCard[],
  completion: MakeHistoryCard,
): string | undefined {
  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const message = userMessages[index];
    if (chronologicalMessageOrder(message, completion) >= 0) continue;
    const prompt = decodeUserPrompt(message.content);
    if (prompt !== undefined && !isSyntheticTriggerText(prompt)) return prompt;
  }
  return;
}

export function configureMakeHistory(
  probe: typeof running,
  notify: () => void = () => {},
): void {
  running = probe;
  notifyHistoryChanged = notify;
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
    job.abort.abort(personalBuildError('cancelled'));
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
  return readCindyMakeHistory(selectedRunId);
}

/** Only the current build may verify candidates while holding its own build reservation. */
async function readCindyMakeHistory(
  selectedRunId?: string,
  ownBuild?: HistoryBuildJob,
): Promise<CindyMakeHistoryState> {
  const h = context();
  const rows = (
    await h.client.drizzle.select().from(sessions).where(eq(sessions.source, 'cindy-make'))
  ).filter(
    (row) =>
      !row.remoteHostId && row.workingDir && isCindyMakeWorktreePath(h.userData, row.workingDir),
  );
  h.check();
  const cards: MakeHistoryCard[] = [];
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
          content: messages.content,
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
    const record = h.store.read(runId)!;
    const knownCompletions = new Map(record.completions.map((entry) => [entry.id, entry]));
    const sessionCards = cards
      .filter((entry) => entry.sessionId === row.id)
      .sort(chronologicalMessageOrder);
    const userMessages = sessionCards.filter((entry) => entry.role === 'user');
    const completionCards = sessionCards.filter((entry) => {
      try {
        const value = JSON.parse(entry.agentMeta ?? '{}').cindyMakeCompletion;
        return !!value && Number.isFinite(value.reportedAt);
      } catch {
        return false;
      }
    });
    for (const [completionIndex, card] of completionCards.entries()) {
      try {
        const completion = JSON.parse(card.agentMeta ?? '{}').cindyMakeCompletion;
        if (completion && Number.isFinite(completion.reportedAt)) {
          const known = knownCompletions.get(card.clientId);
          const prompt = latestUserPromptBefore(userMessages, card);
          const next = {
            ...completion,
            id: card.clientId,
            ...(prompt !== undefined
              ? { prompt }
              : completionIndex === 0 && record.request.trim()
                ? { prompt: record.request }
                : {}),
          };
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
    (state.upstreamMerge.hasWorkspace || state.upstreamMerge.cancellationRequested)
      ? state.upstreamMerge
      : undefined;
  const ownsBuild = !!ownBuild && buildJob === ownBuild && ownBuild.current();
  const globalBusy =
    cindyMakeTestController.hasActiveJobs() ||
    (!ownsBuild && (!!buildJob || cindyMakeManager.hasActiveWork()));
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
        ['waiting', 'syncing', 'checking', 'merging', 'packaging', 'publishing'].includes(
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
      operation: taskBuilding
        ? 'build'
        : operation && !['failed', 'conflict', 'resolving'].includes(operation.status)
          ? operation.feature!.action
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
      canSelectForBuild:
        completed &&
        lifecycle === 'ready' &&
        workspaceAvailable &&
        verifiedSource &&
        !operation &&
        !taskBuilding &&
        test?.status !== 'starting' &&
        ['unintegrated', 'changed', 'reverted'].includes(integration),
      canHide: !targetBusy && !['starting', 'ready'].includes(test?.status ?? ''),
    });
  }
  const build = readCindyMakeBuildState();
  h.check();
  return {
    items,
    busy: globalBusy || !!pendingMerge,
    activeWork: globalBusy,
    canBuild: buildSourceAvailable && !globalBusy && !pendingMerge,
    build,
    batch: buildJob?.current() ? buildJob.batch : undefined,
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
    build = appendCindyMakeBuildLog(build, {
      ...build,
      status: 'failed',
      stopping: undefined,
      error: 'interrupted',
    });
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
  if (!item || (!item.actions.includes(action as MakeHistoryAction) && !canHide)) {
    // The reason may describe another task blocking source operations while
    // this record is still safe to hide. Use it only after this action is denied;
    // a stale cleanup button for an occupied task still reports busy.
    if (item?.actionReason === 'busy' && ['end', 'retry-cleanup', 'hide'].includes(action))
      throwIpcError('PRECONDITION_FAILED', 'busy');
    throwIpcError('PRECONDITION_FAILED', 'unavailable');
  }
  if (['build', 'integrate', 'reapply'].includes(action) && h.store.readBuildRollback().length) {
    await recoverHistoryBuildRollback();
    h.check();
    return actCindyMakeHistory(runId, action);
  }
  if (action === 'build') {
    if (item.lifecycle === 'ready' && item.completionId) {
      await actCindyMakeTest(item.sessionId, item.completionId, 'build');
      return getCindyMakeHistory(runId);
    }
    const integration = item.actions.includes('integrate')
      ? 'integrate'
      : item.actions.includes('reapply')
        ? 'reapply'
        : undefined;
    if (integration) {
      const completion = item.completions.at(-1);
      if (!item.completionId || !completion?.commit || !completion.tree)
        throwIpcError('PRECONDITION_FAILED', 'unavailable');
      return generateHistoryPersonalVersion(
        [
          {
            runId,
            completionId: item.completionId,
            commit: completion.commit,
            tree: completion.tree,
          },
        ],
        [item.sessionId],
        runId,
      );
    }
    // Source-only retries still retain the originating task as their visible owner.
    return generateHistoryPersonalVersion(undefined, [item.sessionId]);
  }
  if (action === 'hide') {
    // An ended record has already gone through the canonical task cleanup path.
    // Active/cleanup records must finish that path before they become dismissible.
    if (item.lifecycle !== 'ended') await manageCindyMakeTask(item.sessionId, 'end');
    h.store.hide(runId);
  } else if (action === 'end' || action === 'retry-cleanup')
    await manageCindyMakeTask(item.sessionId, 'end');
  else if (action === 'test' || action === 'continue') {
    if (action === 'test' && item.test?.status === 'ready') {
      await cindyMakeTestController.stopTestForBuild(item.sessionId);
      h.check();
    }
    await actCindyMakeTest(
      item.sessionId,
      item.completionId,
      action === 'test' ? 'start' : 'continue',
    );
  } else if (action === 'resolve' || action === 'retry') {
    await actUpstreamMerge({ action: 'resolve' });
    if (action === 'retry') {
      h.check();
      const next = await getCindyMakeHistory(runId);
      if (next.items.find((entry) => entry.runId === runId)?.actions.includes('build'))
        return actCindyMakeHistory(runId, 'build');
      return next;
    }
  } else if (action === 'integrate' || action === 'revert' || action === 'reapply') {
    await integrateHistoryItem(h, item, action);
  } else throwIpcError('INVALID_PARAMS', 'This action is handled by task navigation');
  h.check();
  return getCindyMakeHistory(runId);
}

/** Shared by single-item actions and batches; retains route and source locks. */
async function integrateHistoryItem(
  h: ReturnType<typeof context>,
  item: CindyMakeHistoryItem,
  action: 'integrate' | 'revert' | 'reapply',
  ownBuild?: HistoryBuildJob,
): Promise<CindyMakeMergeState | undefined> {
  const runId = item.runId;
  // Shutdown of an earlier resolution task may be queued behind this editing
  // task. Finish that cleanup before taking the editing task's route lock.
  await finishMakeHistoryCleanup(
    ownBuild?.abort.signal ?? AbortSignal.timeout(120_000),
    async () => {},
  );
  return withSessionRouteLock(item.sessionId, async () => {
    h.check();
    if (ownBuild) {
      ownBuild.abort.signal.throwIfAborted();
      if (buildJob !== ownBuild) throwIpcError('PRECONDITION_FAILED', 'unavailable');
      const fresh = (await readCindyMakeHistory(item.runId, ownBuild)).items.find(
        (entry) => entry.runId === item.runId,
      );
      if (
        !fresh ||
        !fresh.actions.includes(action) ||
        fresh.completionId !== item.completionId ||
        fresh.completions.at(-1)?.commit !== item.completions.at(-1)?.commit ||
        fresh.completions.at(-1)?.tree !== item.completions.at(-1)?.tree
      )
        throw personalBuildError('changed');
    }
    if (running(item.sessionId) || cindyMakeManager.isTaskPreparing(item.sessionId))
      throwIpcError('PRECONDITION_FAILED', 'busy');
    if (
      cindyMakeTestController.hasActiveJobs() ||
      (!ownBuild && (buildJob || cindyMakeManager.hasActiveWork()))
    )
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
    return integrateMakeHistory(
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
      ownBuild?.abort.signal,
    );
  });
}

/** The single-card build owns its reservation before starting or waiting for any merge. */
export async function integrateCompletionForBuild(
  task: MakeTestContext,
  signal: AbortSignal,
  publish: (state: CindyMakePersonalBuildState) => Promise<void>,
): Promise<void> {
  const h = context();
  if (h.store.readBuildRollback().length) await recoverHistoryBuildRollback();
  await finishMakeHistoryCleanup(signal, publish);
  // Card persistence takes this task's route lock too. Publish before acquiring
  // it, or the build waits on its own progress write until the lock times out.
  await publish({ status: 'merging' });
  const operation = await withSessionRouteLock(task.sessionId, async () => {
    signal.throwIfAborted();
    h.check();
    if (!task.isCurrent() || !cindyMakeTestController.isBuilding(task.sessionId))
      throw personalBuildError('unavailable');
    const record = h.store.read(task.runId);
    const completion = record?.completions.at(-1);
    if (
      !record ||
      record.sessionId !== task.sessionId ||
      completion?.id !== task.completionId ||
      completion.commit !== task.commit ||
      (task.tree && completion.tree !== task.tree)
    )
      throw personalBuildError('changed');
    const { env } = await toolEnvironment(h.userData, signal);
    await verifyMakeTestWorkspace(
      {
        userData: h.userData,
        workingDir: task.workingDir,
        runId: task.runId,
        commit: task.commit,
        tree: completion.tree,
      },
      env,
      signal,
    );
    const [row] = await h.client.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.id, task.sessionId))
      .limit(1);
    h.check();
    signal.throwIfAborted();
    if (!task.isCurrent() || !row || running(task.sessionId))
      throw personalBuildError('unavailable');
    const plan = planFeatureChange(record, 'integrate', completion);
    if (!plan.mergeCommit && !plan.steps.length) return;
    if (!record.receipts.length && completion.baseTree === completion.tree) return;
    return integrateMakeHistory(
      plan,
      {
        agentKind: row.agentKind === 'codex' || row.agentKind === 'pi' ? row.agentKind : 'cc',
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: row.effort ?? undefined,
        permissionMode: row.permissionMode ?? undefined,
      },
      signal,
    );
  });
  if (operation) await waitForMakeHistoryMerge(operation, signal, publish);
}

/** A source build has no synthetic task. It packages the current personal branch under the existing project lock. */
export async function generateHistoryPersonalVersion(
  rawSelection?: unknown,
  ownerSessionIds: readonly string[] = [],
  selectedHistoryRunId?: string,
): Promise<CindyMakeHistoryState> {
  let selection: MakeHistoryBuildSelection[] | undefined;
  if (rawSelection !== undefined) {
    if (!Array.isArray(rawSelection) || !rawSelection.length || rawSelection.length > 500)
      throwIpcError('INVALID_PARAMS', 'Invalid build selection');
    selection = rawSelection.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object')
        throwIpcError('INVALID_PARAMS', 'Invalid build selection');
      const value = entry as Record<string, unknown>;
      if (
        typeof value.runId !== 'string' ||
        !ID.test(value.runId) ||
        typeof value.completionId !== 'string' ||
        !ID.test(value.completionId) ||
        typeof value.commit !== 'string' ||
        !HASH.test(value.commit) ||
        typeof value.tree !== 'string' ||
        !HASH.test(value.tree)
      )
        throwIpcError('INVALID_PARAMS', 'Invalid build selection');
      return {
        runId: value.runId,
        completionId: value.completionId,
        commit: value.commit,
        tree: value.tree,
      };
    });
    if (new Set(selection.map((entry) => entry.runId)).size !== selection.length)
      throwIpcError('INVALID_PARAMS', 'Duplicate build selection');
  }
  const h = context();
  let state = await getCindyMakeHistory(selectedHistoryRunId);
  h.check();
  const matches = (item: CindyMakeHistoryItem | undefined, pin: MakeHistoryBuildSelection) =>
    !!item &&
    (item.runId === selectedHistoryRunId
      ? item.actions.includes('build') &&
        (item.actions.includes('integrate') || item.actions.includes('reapply'))
      : item.canSelectForBuild) &&
    item.completionId === pin.completionId &&
    item.completions.at(-1)?.commit === pin.commit &&
    item.completions.at(-1)?.tree === pin.tree;
  if (selection) {
    // Validate every identity before stopping any selected test. Never substitute a newer round.
    if (
      selection.some(
        (pin) =>
          !matches(
            state.items.find((item) => item.runId === pin.runId),
            pin,
          ),
      )
    )
      throwIpcError('PRECONDITION_FAILED', 'unavailable');
    selection.sort((a, b) => {
      const left = state.items.find((item) => item.runId === a.runId)!;
      const right = state.items.find((item) => item.runId === b.runId)!;
      return left.createdAt - right.createdAt || left.runId.localeCompare(right.runId);
    });
    for (const pin of selection) {
      const item = state.items.find((entry) => entry.runId === pin.runId)!;
      await cindyMakeTestController.stopTestForBuild(item.sessionId);
      h.check();
    }
    state = await getCindyMakeHistory(selectedHistoryRunId);
  }
  h.check();
  if (
    !state.canBuild ||
    buildJob ||
    cindyMakeTestController.hasActiveJobs() ||
    cindyMakeManager.hasActiveWork()
  )
    throwIpcError('PRECONDITION_FAILED', 'busy');
  const selectedRuns = new Set(selection?.map((pin) => pin.runId));
  const releaseBuild = cindyMakeManager.claimPersonalBuild(
    ownerSessionIds.length
      ? ownerSessionIds
      : state.items.filter((item) => selectedRuns.has(item.runId)).map((item) => item.sessionId),
    h.current,
  );
  const abort = new AbortController();
  const buildId = randomUUID();
  const startedAt = Date.now();
  const syncLatestSource = readCindyMakeSettings().syncLatestBeforeBuild;
  const publish = async (build: CindyMakePersonalBuildState) => {
    h.check();
    // A late step notification must not erase a requested stop.
    if (job.cancelled && !['ready', 'failed'].includes(build.status)) return;
    h.store.saveBuild(
      appendCindyMakeBuildLog(h.store.readBuild(), { ...build, buildId, startedAt }),
    );
  };
  const job: HistoryBuildJob = {
    id: buildId,
    current: h.current,
    abort,
    cancelled: false,
    done: Promise.resolve(),
  };
  buildJob = job;
  try {
    await publish({ status: 'waiting', syncLatestSource });
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
      let enteredBuilder = false;
      let canRollback = !selection;
      try {
        await finishMakeHistoryCleanup(abort.signal, publish);
        await publish({ status: 'waiting', preparationStep: 'environment' });
        const { tools, env } = await toolEnvironment(h.userData, abort.signal, true);
        const node = await tools.probe('node', ['--version'], abort.signal);
        const git = await tools.probe('git', ['--version'], abort.signal);
        if (!node.path || node.status !== 'ok') throw new Error('environment');
        await publish({ status: 'waiting', preparationStep: 'original' });
        await rememberOriginalVersion(node.path);
        const buildEnvironment = await personalBuildEnvironment(env, git.path);
        if (syncLatestSource) {
          await syncSourceBeforeCindyMakeBuild(abort.signal, publish);
          h.check();
        }
        if (selection) {
          if (h.store.readBuildRollback().length) await recoverHistoryBuildRollback();
          const candidates: CindyMakeHistoryItem[] = [];
          for (const pin of selection) {
            abort.signal.throwIfAborted();
            const fresh = await readCindyMakeHistory(pin.runId, job);
            h.check();
            const item = fresh.items.find((entry) => entry.runId === pin.runId);
            if (
              !matches(item, pin) ||
              !(item!.actions.includes('integrate') || item!.actions.includes('reapply'))
            )
              throw personalBuildError('changed');
            candidates.push(item!);
          }
          // All candidates are checked before the first merge; each is rechecked under its route lock.
          for (const [index, item] of candidates.entries()) {
            abort.signal.throwIfAborted();
            job.batch = {
              current: index + 1,
              total: candidates.length,
              runId: item.runId,
              title: item.title,
            };
            await publish({ status: 'merging' });
            const operation = await integrateHistoryItem(
              h,
              item,
              item.actions.includes('reapply') ? 'reapply' : 'integrate',
              job,
            );
            canRollback = true;
            if (operation) await waitForMakeHistoryMerge(operation, abort.signal, publish);
            h.check();
            abort.signal.throwIfAborted();
            const next = await readCindyMakeHistory(item.runId, job);
            if (
              next.items.find((entry) => entry.runId === item.runId)?.integration !==
                'integrated' ||
              next.items.some(
                (entry) => entry.runId === item.runId && (entry.conflict || entry.operationError),
              )
            )
              throw personalBuildError('conflict');
          }
          job.batch = undefined;
        }
        if (!selection) await publish({ status: 'merging' });
        enteredBuilder = true;
        const artifact = await buildCindyPersonal(
          {
            mode: 'personal',
            userData: h.userData,
            completionId: buildId,
            title: '',
            profile: currentVersionProfile(),
          },
          node.path,
          buildEnvironment,
          CURRENT_CINDY_REGION,
          abort.signal,
          publish,
          h.check,
          (run) => cindyMakeManager.withProject(makeSourceRoot(h.userData), run),
          {
            ...historyBuildRollback(h.store, makeSourceCheckoutPath(h.userData), (commit) =>
              hasPublishedPersonalVersionCommit(h.userData, commit),
            ),
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
        // A cancelled/failed batch follows the same unbuilt-prefix recovery as a single build.
        // Admission failures before the first merge must not undo unrelated earlier work.
        if (!enteredBuilder && canRollback && h.current()) {
          const merge = cindyMakeManager.getState().upstreamMerge;
          // A live conflict candidate is based on the already merged prefix. Keep that baseline
          // until its resolution is adopted; rolling it back would invalidate the recovery task.
          const awaitingMerge = selection && merge?.hasWorkspace && merge.status !== 'merged';
          if (!awaitingMerge) {
            try {
              await recoverHistoryBuildRollback(true);
            } catch (cleanupError) {
              error = cleanupError;
            }
          }
        }
        const diagnostic = abort.signal.aborted ? undefined : makeBuildErrorDiagnostic(error);
        if (h.current())
          await publish({
            status: 'failed',
            ...(diagnostic ? { diagnostic } : {}),
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
      if (h.current()) notifyHistoryChanged();
    });
  return getCindyMakeHistory();
}

/** Finish an interrupted cleanup before reintegration, or undo an early build failure. */
export async function recoverHistoryBuildRollback(rollbackUnbuilt = false): Promise<void> {
  const h = context();
  const source = makeSourceCheckoutPath(h.userData);
  try {
    if (
      !h.store.readBuildRollback().length &&
      (!rollbackUnbuilt ||
        !h.store.list().some((record) => {
          const receipt = record.receipts.at(-1);
          return receipt && !record.versions.some((version) => version.operationId === receipt.id);
        }))
    )
      return;
    const signal = AbortSignal.timeout(120_000);
    const { env } = await toolEnvironment(h.userData, signal);
    await cindyMakeManager.withProject(makeSourceRoot(h.userData), async () => {
      h.check();
      const git = (args: string[], cwd: string, indexFile?: string) => {
        h.check();
        return runSourceGit(
          { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
          args,
          cwd,
          signal,
        );
      };
      const published = (commit: string) => hasPublishedPersonalVersionCommit(h.userData, commit);
      if (rollbackUnbuilt) await rollbackUnbuiltHistory(h.store, source, git, published);
      else await historyBuildRollback(h.store, source, published).recoverRollback(git);
    });
  } catch {
    throw personalBuildError('cleanupFailed');
  }
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
