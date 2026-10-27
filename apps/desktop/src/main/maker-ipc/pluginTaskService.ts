import { createHash, randomUUID } from 'node:crypto';
import type { Session } from '@cindy/maker-core';
import type { PluginTaskRoute, PluginTaskRun, PluginTaskView, PluginTeamPlan } from '../../shared/pluginTasks.js';
import { isPluginTeamPlanWithinBudget, PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS } from '../../shared/pluginTasks.js';
import type { PluginMessageAttachment } from '../../shared/pluginAttachments.js';
import { withParsedPluginMessageAttachments, type PluginMessageImage } from '../cindy-media/pluginMessageAttachments.js';
import {
  isSameSessionExecution,
  queuedInputBelongsTo,
  type OwnedQueuedInput,
  type SessionExecutionIdentity,
} from './sessionExecutionOwnership.js';

export interface PluginTaskReceipt {
  id: string;
  pluginId: string;
  operation: 'create' | 'send' | 'target';
  targetId: string;
  requestKey: string;
  fingerprint: string;
  payload: string;
  revision: number;
  createdAt: number;
}
function ownsTaskReceipt(receipt: PluginTaskReceipt | undefined, pluginId: string): boolean {
  if (!receipt || receipt.pluginId !== pluginId || receipt.operation !== 'create') return false;
  try {
    const payload = JSON.parse(receipt.payload);
    return !!payload && typeof payload === 'object' && !Array.isArray(payload)
      && payload.ownershipRevoked !== true;
  } catch { return false; }
}
export interface PluginTaskStore {
  get(id: string): Promise<PluginTaskReceipt | undefined>;
  find(
    pluginId: string,
    operation: string,
    targetId: string,
    requestKey: string,
  ): Promise<PluginTaskReceipt | undefined>;
  list(
    pluginId: string,
    operation: string,
    targetId: string | null,
    after: string,
    limit: number,
  ): Promise<PluginTaskReceipt[]>;
  forSession(taskId: string): Promise<PluginTaskReceipt[]>;
  insert(row: PluginTaskReceipt): Promise<void>;
  /** Roll back only this new receipt, before any Session INSERT was attempted. */
  discardUncreated(row: PluginTaskReceipt): Promise<void>;
  save(row: PluginTaskReceipt): Promise<void>;
  revokePlugin(pluginId: string): Promise<void>;
  relocatePlugin(from: string, to: string): Promise<void>;
}
export class PluginTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PluginTaskError';
  }
}
/** Bounds legacy receipts before parsing; oversized authority never becomes a missing plan. */
export function readPluginTaskPlanReceipt(payload: string): { teamPlan?: PluginTeamPlan; settledLabels?: string[]; route?: PluginTaskRoute; [key: string]: unknown } {
  if (typeof payload !== 'string' || payload.length > PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS)
    throw new PluginTaskError('INVALID_REQUEST', 'Task receipt exceeds the supported size');
  const data = JSON.parse(payload);
  if (data.teamPlan !== undefined && !isPluginTeamPlanWithinBudget(data.teamPlan))
    throw new PluginTaskError('INVALID_REQUEST', 'Team plan exceeds the supported size');
  return data;
}

/**
 * true = 给定 label 中被已登记计划的**未结算**条目引用。
 * 计划整体不可变，且 label 是 Worker 归属与委派自动授权的寻址键；
 * 活动计划引用到的 label 不允许改名，否则 releaseWorker 与自动授权都会找不到条目。
 */
export function isTeamPlanLabelLocked(
  plan: PluginTeamPlan | undefined,
  settledLabels: readonly string[] | undefined,
  labels: ReadonlyArray<string | null>,
): boolean {
  if (!plan) return false;
  const settled = new Set(settledLabels ?? []);
  const locked = new Set(
    plan.items.filter((item) => !settled.has(item.label)).map((item) => item.label),
  );
  return labels.some((label) => label !== null && locked.has(label));
}

/**
 * 收据级计划锁：只有当插件仍安装（pluginInstalled，任务归属未被卸载撤销）时才锁定 label。
 * 插件卸载后，原插件任务按普通 Orca 任务继续使用，releaseWorker 已不可用，
 * 保留的收据不得继续禁止改名；停用 / 未批准可恢复，重新启用后计划仍会继续，故仍锁定。
 */
export function isTeamPlanLabelLockedByReceipt(
  receipt: Pick<PluginTaskReceipt, 'payload' | 'operation'> | undefined,
  pluginInstalled: boolean,
  labels: ReadonlyArray<string | null>,
): boolean {
  if (!receipt || receipt.operation !== 'create' || !pluginInstalled) return false;
  const data = readPluginTaskPlanReceipt(receipt.payload);
  return isTeamPlanLabelLocked(data.teamPlan, data.settledLabels, labels);
}
/** Service failures must reject the public task API, without exposing internal diagnostics. */
export function assertPluginTaskResult(result: { ok: boolean; errorCode?: string }, message: string): void {
  if (!result.ok) throw new PluginTaskError(result.errorCode || 'HOST_NOT_READY', message);
}
/** A live task cannot exercise more authority than the plugin's current setting. */
export function isPluginTaskPermissionAllowed(taskMode: unknown, configuredMode: unknown, planModeEnabled = false): boolean {
  const rank = (mode: unknown) => mode === 'plan' ? 0 : mode === 'ask' ? 1 : mode === 'acceptEdits' ? 2 : mode === 'auto' ? 3 : -1;
  const task = rank(taskMode);
  return !planModeEnabled && task >= 0 && task <= Math.max(0, rank(configuredMode));
}
const fail = (code: string, message: string): never => {
  throw new PluginTaskError(code, message);
};
const terminal = (run: PluginTaskRun) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
const ownsInput = (run: PluginTaskRun, value: string) =>
  value === run.inputMessageId || run.inputClientIds?.includes(value) === true;
// Object insertion order is not part of the task API; array order still is.
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value,
)).digest('hex');
/** Main-only context; never populated from tasks.create's wire request. */
export interface PluginTaskCreateContext {
  taskId: string;
  workingDir: string;
  assertCurrent(): void;
}
export interface PluginTaskServiceDeps {
  store: PluginTaskStore;
  /** Bound to the captured account/database epoch and plugin availability. */
  assertCurrent(): void;
  assertAuthorized(pluginId: string): void;
  readPermissionMode(pluginId: string): unknown;
  /** Include the inherited new-task selection when the resolver can use it. */
  readModelPreference(pluginId: string): Partial<PluginTaskRoute> & { inheritedDefault?: string };
  resolveRoute(pluginId: string, route?: PluginTaskRoute, callId?: string): Promise<PluginTaskRoute>;
  createSession(
    pluginId: string,
    taskId: string,
    title: string,
    route: PluginTaskRoute,
    isolatedWorkspace: boolean | undefined,
    requestedRoute: PluginTaskRoute | undefined,
    onPersistenceStarted: () => void,
    callId?: string,
    /** Background task: the Session row is inserted with hidden_at set (never flashes into lists). */
    hidden?: boolean,
    targetContext?: PluginTaskCreateContext,
  ): Promise<void>;
  /**
   * Re-checks `agent.hiddenTasks` (with tasks) for this plugin; throws PERMISSION_DENIED.
   * The pipe checks first; the service re-checks behind its receipt queue.
   */
  assertHiddenTasksAllowed?(pluginId: string): void;
  /**
   * Shared Host writer for `sessions.hidden_at` (plugin setHidden and the detail-page reveal).
   * `assertAllowed` runs synchronously right before the write.
   */
  setHidden?(taskId: string, hidden: boolean, assertAllowed: () => void): Promise<void>;
  /** Uninstall fallback: reveal this plugin's background tasks before ownership is revoked. */
  revealPluginTasks?(pluginId: string): Promise<void>;
  setModel?(taskId: string, route: PluginTaskRoute, assertCurrent: () => Promise<void>): Promise<{ status: string }>;
  readSession(taskId: string): Promise<PluginTaskView | null>;
  readLiveSession(taskId: string): Pick<Session, 'instanceId' | 'stablePlanModeState'> | undefined;
  assertTeamPlanUnstarted?(taskId: string): Promise<void>;
  dispatch(
    pluginId: string,
    taskId: string,
    clientId: string,
    text: string,
    images?: PluginMessageImage[],
  ): Promise<{ ok: boolean; message?: string }>;
  inspect(
    taskId: string,
  ): Promise<{ execution: SessionExecutionIdentity | null; pending: readonly OwnedQueuedInput[] }>;
  cancel(
    pluginId: string,
    taskId: string,
    inputClientIds: readonly string[],
    execution?: SessionExecutionIdentity,
  ): Promise<'cancelled' | 'stopping' | 'stale'>;
  now?: () => number;
  id?: () => string;
  /** Host bookkeeping only; plugins cannot mint or increment usage identities. */
  prepareInvocation?(pluginId: string, id: string, parentId?: string, operation?: string, sessionId?: string): string;
  acceptInvocation?(pluginId: string, id: string): void;
}

/** Uses native input/terminal facts. Never infers completion from idle or the latest assistant. */
export function createPluginTaskService(deps: PluginTaskServiceDeps) {
  const now = deps.now ?? Date.now;
  const id = deps.id ?? randomUUID;
  // One service is retained for a database epoch. Mutations serialize with lifecycle receipts.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => {
      deps.assertCurrent();
      return fn();
    });
    tail = result.catch(() => undefined);
    return result;
  };
  // Drain spans the entire dispatch/control operation, without holding the receipt
  // mutex while native dispatch calls accept()/settle() back into this service.
  let operations: Promise<unknown> = Promise.resolve();
  const completeOperation = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = fn();
    operations = Promise.all([operations, result.catch(() => undefined)]).then(() => undefined);
    return result;
  };
  const assertHiddenTasksAllowed = (pluginId: string) => {
    if (!deps.assertHiddenTasksAllowed) fail('PERMISSION_DENIED', 'Background tasks are unavailable');
    deps.assertHiddenTasksAllowed!(pluginId);
  };
  // The persisted/UI choice can be consumed while Pi is still executing Plan.
  // Keep one live authority across awaits; queued acceptance must also match
  // the runtime selected by the input coordinator, including for cold tasks.
  const capturePlanGuard = (taskId: string, execution?: SessionExecutionIdentity) => {
    const live = deps.readLiveSession(taskId);
    const plan = live?.stablePlanModeState;
    const generation = plan?.generation;
    const assertCurrent = () => {
      const current = deps.readLiveSession(taskId);
      const state = current?.stablePlanModeState;
      if (current !== live || (execution && current?.instanceId !== execution.instanceId)
        || (live && (!plan || plan.enabled || !state || state.enabled || state.generation !== generation)))
        fail('PERMISSION_DENIED', 'Task Plan Mode is active, unknown or changing');
    };
    assertCurrent();
    return assertCurrent;
  };
  const assertDispatch = async (pluginId: string, taskId: string, assertPlanCurrent = capturePlanGuard(taskId)) => {
    const view = await ownTask(pluginId, taskId);
    deps.assertAuthorized(pluginId);
    assertPlanCurrent();
    if (view.status !== 'active') return fail('TASK_BUSY', 'Archived tasks cannot accept input');
    if (!isPluginTaskPermissionAllowed(view.permissionMode, deps.readPermissionMode(pluginId), view.planModeEnabled))
      return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
    return view;
  };
  const save = async (row: PluginTaskReceipt, payload: unknown) => {
    deps.assertCurrent();
    row.payload = JSON.stringify(payload);
    await deps.store.save(row);
    row.revision++;
  };
  const ownTask = async (pluginId: string, taskId: string) => {
    deps.assertAuthorized(pluginId);
    const receipt = await deps.store.get(taskId);
    if (!ownsTaskReceipt(receipt, pluginId))
      return fail('TASK_NOT_FOUND', 'Task not found');
    const view = await deps.readSession(taskId);
    if (!view || view.status === 'deleted') return fail('TASK_NOT_FOUND', 'Task not found');
    if (!ownsTaskReceipt(await deps.store.get(taskId), pluginId))
      return fail('TASK_NOT_FOUND', 'Task not found');
    deps.assertCurrent();
    deps.assertAuthorized(pluginId);
    return { ...view, hidden: view.hidden === true };
  };
  const ownRun = async (pluginId: string, runId: string) => {
    const row = await deps.store.get(runId);
    if (!row || row.pluginId !== pluginId || row.operation !== 'send')
      return fail('TASK_NOT_FOUND', 'Run not found');
    await ownTask(pluginId, row.targetId);
    return row;
  };
  const replay = (row: PluginTaskReceipt | undefined, fingerprint: string, legacyFingerprint?: string) => {
    if (row && row.fingerprint !== fingerprint && row.fingerprint !== legacyFingerprint)
      fail('IDEMPOTENCY_CONFLICT', 'Request key was used with different input');
    return row;
  };
  const newReceipt = (
    pluginId: string,
    operation: 'create' | 'send',
    targetId: string,
    requestKey: string,
    fingerprint: string,
    payload: unknown,
    receiptId = id(),
  ): PluginTaskReceipt => ({
    id: receiptId,
    pluginId,
    operation,
    targetId,
    requestKey,
    fingerprint,
    payload: JSON.stringify(payload),
    revision: 0,
    createdAt: now(),
  });
  const reconcile = async (row: PluginTaskReceipt): Promise<PluginTaskRun> => {
    const run = JSON.parse(row.payload) as PluginTaskRun;
    if (terminal(run)) return run;
    const observed = await deps.inspect(run.taskId);
    return exclusive(async () => {
      // Native settlement/acceptance may have committed while inspection waited.
      // Re-read behind that same receipt queue, with uninstall ownership checked.
      const latest = await ownRun(row.pluginId, row.id);
      const current = JSON.parse(latest.payload) as PluginTaskRun;
      if (terminal(current) || latest.revision !== row.revision) return current;
      if (observed.pending.some((item) => queuedInputBelongsTo(item, (value) => ownsInput(current, value))))
        return current;
      if (isSameSessionExecution(observed.execution, current.execution)) return current;
      // Lack of a terminal is not success. Never replay an ambiguously dispatched input.
      current.status = 'reconciling';
      current.error = 'No matching live execution or pending input; inspect the task before sending a new request.';
      return current;
    });
  };
  return {
    relocatePlugin: (from: string, to: string) => exclusive(async () => {
      await deps.store.relocatePlugin(from, to);
      deps.assertCurrent();
    }),
    // Host-only native lifecycle work shares send/cancel's drain. Do not use
    // exclusive here: native close callbacks may enqueue receipt writes.
    completeOperation,
    /** Retain receipts and user content, but never reuse an uninstalled installation's ownership. */
    withUninstall: (pluginId: string, remove: () => Promise<void>) => exclusive(async () => {
      // Background tasks must never outlive the detail page that discloses them.
      // Reveal first: a failure aborts the uninstall like a failed revocation.
      await deps.revealPluginTasks?.(pluginId);
      deps.assertCurrent();
      await deps.store.revokePlugin(pluginId);
      deps.assertCurrent();
      await remove();
    }),
    /** Account teardown awaits already accepted writes before closing this DB. */
    drain: async () => {
      let pending: Promise<unknown>, active: Promise<unknown>;
      do {
        pending = tail; active = operations;
        await Promise.all([pending, active]);
      } while (pending !== tail || active !== operations);
    },
    create: (
      pluginId: string,
      request: { requestKey: string; title: string; route?: PluginTaskRoute; isolatedWorkspace?: boolean; callId?: string; hidden?: boolean },
      targetContext?: PluginTaskCreateContext,
    ) =>
      exclusive(async () => {
        targetContext?.assertCurrent();
        deps.assertAuthorized(pluginId);
        const hidden = request.hidden === true;
        if (hidden) assertHiddenTasksAllowed(pluginId);
        // hidden:false is the default; only a background request changes the fingerprint,
        // so existing visible receipts replay unchanged.
        const input = [request.title, request.route ?? null, ...(request.isolatedWorkspace ? [true] : []), ...(request.callId ? [{ callId: request.callId }] : []), ...(hidden ? [{ hidden: true }] : []), ...(targetContext ? [{ workingDir: targetContext.workingDir }] : [])];
        const fingerprint = hash(input);
        let row = replay(
          await deps.store.find(pluginId, 'create', '', request.requestKey),
          fingerprint,
          // Preserve exact retries of receipts written by earlier development builds.
          createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        );
        if (row) {
          // Do not recreate a deleted/ambiguous task on replay.
          return ownTask(pluginId, row.id);
        }
        const route = await deps.resolveRoute(pluginId, request.route, request.callId);
        deps.assertCurrent();
        targetContext?.assertCurrent();
        const taskId = targetContext?.taskId ?? id();
        row = newReceipt(
          pluginId,
          'create',
          '',
          request.requestKey,
          fingerprint,
          { route, title: request.title },
          taskId,
        );
        await deps.store.insert(row);
        let persistenceStarted = false;
        try {
          deps.assertCurrent();
          const onPersistenceStarted = () => { persistenceStarted = true; };
          // Visible creation keeps its original call shape; only background tasks add the flag.
          if (targetContext) {
            targetContext.assertCurrent();
            await deps.createSession(pluginId, taskId, request.title, route, undefined, request.route,
              onPersistenceStarted, undefined, undefined, targetContext);
          } else if (hidden) {
            assertHiddenTasksAllowed(pluginId);
            await deps.createSession(pluginId, taskId, request.title, route, request.isolatedWorkspace, request.route,
              onPersistenceStarted, request.callId, true);
          } else {
            await deps.createSession(pluginId, taskId, request.title, route, request.isolatedWorkspace, request.route,
              onPersistenceStarted, request.callId);
          }
        } catch (error) {
          // Once INSERT starts, even an error is ambiguous. Never free that key
          // or infer failure from a subsequently deleted/filtered Session.
          if (!persistenceStarted) await deps.store.discardUncreated(row);
          throw error;
        }
        return ownTask(pluginId, taskId);
      }),
    setTeamPlan: (pluginId: string, taskId: string, plan: PluginTeamPlan) => exclusive(async () => {
      if (!isPluginTeamPlanWithinBudget(plan)) return fail('INVALID_REQUEST', 'Team plan exceeds the supported size');
      await ownTask(pluginId,taskId);
      const row = (await deps.store.get(taskId))!;
      const data = readPluginTaskPlanReceipt(row.payload);
      if (data.teamPlan && hash(data.teamPlan) !== hash(plan)) {
        return fail('IDEMPOTENCY_CONFLICT', 'Team plan is immutable');
      }
      if (data.teamPlan) return {ok:true};
      if ((await deps.store.forSession(taskId)).length) return fail('TASK_BUSY', 'Register the team plan before sending input');
      const observed = await deps.inspect(taskId);
      if (observed.execution || observed.pending.length) return fail('TASK_BUSY', 'Register the team plan before starting work');
      await deps.assertTeamPlanUnstarted?.(taskId);
      deps.assertAuthorized(pluginId);
      await save(row,{...data,teamPlan:plan});
      return {ok:true};
    }),
    settleWorkerLabel: (pluginId: string, taskId: string, label: string) => exclusive(async () => {
      await ownTask(pluginId,taskId);
      const row = (await deps.store.get(taskId))!;
      const data = readPluginTaskPlanReceipt(row.payload);
      if (!data.teamPlan?.items.some((x: {label:string})=>x.label===label)) return fail('INVALID_REQUEST','Worker is not in team plan');
      await save(row,{...data,settledLabels:[...new Set([...(data.settledLabels||[]),label])]});
    }),
    assertDispatch,
    setModel: (pluginId: string, request: { taskId: string; expectedRevision: number; route: PluginTaskRoute | 'plugin-default' }) => exclusive(async () => {
      const modelFields = ['agentKind', 'providerId', 'model', 'effort', 'fastMode'] as const;
      const followDefault = request.route === 'plugin-default';
      const preference = followDefault ? { ...deps.readModelPreference(pluginId) } : undefined;
      const assertUnchanged = async () => {
        const task = await ownTask(pluginId, request.taskId);
        if (task.status !== 'active') return fail('TASK_BUSY', '任务已归档，请先恢复任务');
        if (task.revision !== request.expectedRevision) return fail('STALE_REVISION', '任务配置已变化，请刷新后重试');
        // Plugin preferences and inherited defaults do not change the task
        // revision. Recheck both after admission and at the mutation boundary.
        if (preference) {
          const current = deps.readModelPreference(pluginId);
          if (modelFields.some(key => preference[key] !== current[key])
            || preference.inheritedDefault !== current.inheritedDefault)
            return fail('STALE_REVISION', '插件模型设置已变化，请重试以使用当前设置');
        }
        return task;
      };
      await assertUnchanged();
      // Opt-in: persistent plugin workflows can re-read the user's current
      // plugin selection before each new input, using the same resolver as create.
      // Ordinary tasks and explicit routes retain their existing semantics.
      const route = await deps.resolveRoute(pluginId, request.route === 'plugin-default' ? undefined : request.route);
      const task = await assertUnchanged();
      if (followDefault && modelFields
        .every(key => task.resolvedConfig[key] === route[key])) return { status: 'unchanged', task };
      if (!deps.setModel) return fail('HOST_NOT_READY', '任务模型服务尚未就绪');
      const result = await deps.setModel(request.taskId, route, async () => { await assertUnchanged(); });
      return { ...result, task: await ownTask(pluginId, request.taskId) };
    }),
    get: (pluginId: string, taskId: string) => exclusive(() => ownTask(pluginId, taskId)),
    /** Background/visible switch for this plugin's own local task; Workers and remote tasks are not plugin tasks. */
    setHidden: (pluginId: string, request: { taskId: string; hidden: boolean }) => exclusive(async () => {
      assertHiddenTasksAllowed(pluginId);
      const task = await ownTask(pluginId, request.taskId);
      if (!deps.setHidden) return fail('HOST_NOT_READY', 'Task visibility service is not ready');
      if (task.hidden !== request.hidden) {
        await deps.setHidden(request.taskId, request.hidden, () => {
          deps.assertCurrent();
          deps.assertAuthorized(pluginId);
          assertHiddenTasksAllowed(pluginId);
        });
      }
      return ownTask(pluginId, request.taskId);
    }),
    list: (pluginId: string, after = '', limit = 50) =>
      exclusive(async () => {
        deps.assertAuthorized(pluginId);
        const rows = await deps.store.list(pluginId, 'create', null, after, limit);
        const items = [];
        for (const row of rows) {
          // The store projects valid create payloads as empty to avoid loading plans.
          if (row.payload !== '' && !ownsTaskReceipt(row, pluginId)) continue;
          const view = await deps.readSession(row.id);
          if (view && view.status !== 'deleted') items.push({ ...view, hidden: view.hidden === true });
        }
        return { items, nextCursor: rows.length === limit ? rows.at(-1)!.id : null };
      }),
    send: async (
      pluginId: string,
      request: { taskId: string; requestKey: string; expectedRevision: number; text: string; attachments?: PluginMessageAttachment[]; invocationId?: string },
    ): Promise<PluginTaskRun> => completeOperation(() => withParsedPluginMessageAttachments(request.attachments, async images => {
      const prepared = await exclusive(async () => {
        const view = await ownTask(pluginId, request.taskId);
        const contentIdentity = images.length
          ? [request.text, request.expectedRevision, images.map(({ hash, name }) => [hash, name])]
          : [request.text, request.expectedRevision];
        const fingerprint = hash(request.invocationId === undefined ? contentIdentity : [...contentIdentity, request.invocationId]);
        const previous = replay(
          await deps.store.find(pluginId, 'send', request.taskId, request.requestKey),
          fingerprint,
        );
        if (previous)
          return { run: JSON.parse(previous.payload) as PluginTaskRun, dispatch: false as const };
        const assertPlanCurrent = capturePlanGuard(view.taskId);
        if (!isPluginTaskPermissionAllowed(view.permissionMode, deps.readPermissionMode(pluginId), view.planModeEnabled)) return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
        if (view.status !== 'active')
          return fail('TASK_BUSY', 'Archived tasks cannot accept input');
        if (view.revision !== request.expectedRevision)
          return fail('REVISION_CONFLICT', 'Task configuration changed');
        await deps.resolveRoute(pluginId, view.resolvedConfig);
        await assertDispatch(pluginId, view.taskId, assertPlanCurrent);
        const runId = id();
        const invocationId = deps.prepareInvocation?.(pluginId, runId, request.invocationId, 'tasks.send', view.taskId);
        const run: PluginTaskRun = {
          runId,
          taskId: view.taskId,
          inputMessageId: `plugin-task:${runId}`,
          status: 'queued',
          acceptedAt: now(),
          ...(invocationId ? { invocationId } : {}),
          acceptedConfig: view.resolvedConfig,
          usage: { status: 'unavailable', reason: 'Per-input usage has not been reconciled.' },
        };
        deps.assertAuthorized(pluginId);
        assertPlanCurrent();
        await deps.store.insert(
          newReceipt(pluginId, 'send', view.taskId, request.requestKey, fingerprint, run, runId),
        );
        return { run, dispatch: true as const, assertPlanCurrent };
      });
      if (!prepared.dispatch) return prepared.run;
      let failure: 'failed' | 'reconciling' | undefined;
      let dispatchStarted = false;
      // Never hold the receipt lock while entering Session dispatch/control. The
      // coordinator awaits accept() before vendor dispatch under its own lock.
      try {
        await assertDispatch(pluginId, prepared.run.taskId, prepared.assertPlanCurrent);
        prepared.assertPlanCurrent();
        dispatchStarted = true;
        const outcome = await deps.dispatch(
          pluginId,
          prepared.run.taskId,
          prepared.run.inputMessageId,
          request.text,
          images,
        );
        if (!outcome.ok) failure = 'failed';
        else if (prepared.run.invocationId) {
          // Usage persistence must never turn an accepted input into a retry.
          try { deps.acceptInvocation?.(pluginId, prepared.run.invocationId); } catch { /* Best effort, as tool recording. */ }
        }
      } catch {
        // Before entering dispatch, this input is known not to have reached the host.
        failure = dispatchStarted ? 'reconciling' : 'failed';
      }
      return exclusive(async () => {
        const row = await ownRun(pluginId, prepared.run.runId);
        const run = JSON.parse(row.payload) as PluginTaskRun;
        // A synchronous native terminal wins over a delayed dispatch response.
        if (failure && !terminal(run) && run.status === 'queued') {
          run.status = failure;
          run.error =
            failure === 'failed'
              ? 'Input was not accepted by the host.'
              : 'Dispatch outcome is unknown; this request will not be replayed.';
          await save(row, run);
        }
        return run;
      });
    }).catch(error => {
      const code = (error as { code?: unknown } | null)?.code;
      if (!(error instanceof PluginTaskError) && (code === 'INVALID_ATTACHMENTS' || code === 'TASK_BUSY'))
        throw new PluginTaskError(code, code, code === 'TASK_BUSY');
      throw error;
    })),
    getRun: async (pluginId: string, runId: string) =>
      reconcile(await exclusive(() => ownRun(pluginId, runId))),
    listRuns: async (pluginId: string, taskId: string, after = '', limit = 50) => {
      const rows = await exclusive(async () => {
        await ownTask(pluginId, taskId);
        return deps.store.list(pluginId, 'send', taskId, after, limit);
      });
      const items = await Promise.all(rows.map(reconcile));
      await exclusive(() => ownTask(pluginId, taskId));
      deps.assertCurrent();
      deps.assertAuthorized(pluginId);
      return { items, nextCursor: rows.length === limit ? rows.at(-1)!.id : null };
    },
    cancel: (pluginId: string, runId: string): Promise<PluginTaskRun> => completeOperation(async () => {
      const prepared = await exclusive(async () => {
        const row = await ownRun(pluginId, runId);
        const run = JSON.parse(row.payload) as PluginTaskRun;
        if (terminal(run)) return run;
        deps.assertAuthorized(pluginId);
        run.status = 'stopping';
        await save(row, run);
        return run;
      });
      if (terminal(prepared)) return prepared;
      deps.assertAuthorized(pluginId);
      const outcome = await deps.cancel(
        pluginId,
        prepared.taskId,
        [prepared.inputMessageId, ...(prepared.inputClientIds ?? [])],
        prepared.execution,
      );
      return exclusive(async () => {
        const row = await ownRun(pluginId, runId);
        const run = JSON.parse(row.payload) as PluginTaskRun;
        if (terminal(run)) return run;
        run.status = outcome === 'stale' ? 'reconciling' : outcome;
        if (outcome === 'cancelled') run.completedAt = now();
        await save(row, run);
        return run;
      });
    }),
    /** Awaited before vendor dispatch. Aliases are native recovery provenance, never caller input. */
    accept: (taskId: string, item: OwnedQueuedInput, execution: SessionExecutionIdentity) =>
      exclusive(async () => {
        for (const row of await deps.store.forSession(taskId)) {
          const run = JSON.parse(row.payload) as PluginTaskRun;
          if (!queuedInputBelongsTo(item, (clientId) => ownsInput(run, clientId))) continue;
          if (terminal(run) || run.status === 'stopping') {
            if (
              item.clientId !== run.inputMessageId &&
              !run.inputClientIds?.includes(item.clientId)
            )
              continue;
            return fail('REQUEST_EXPIRED', 'Input was already settled');
          }
          const assertPlanCurrent = capturePlanGuard(taskId, execution);
          const view = await ownTask(row.pluginId, taskId);
          assertPlanCurrent();
          if (view.status !== 'active') return fail('TASK_BUSY', 'Archived tasks cannot accept input');
          if (!isPluginTaskPermissionAllowed(view.permissionMode, deps.readPermissionMode(row.pluginId), view.planModeEnabled)) return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
          if (hash(view.resolvedConfig) !== hash(run.acceptedConfig))
            return fail('ROUTE_UNAVAILABLE', 'Accepted route changed before dispatch');
          await deps.resolveRoute(row.pluginId, run.acceptedConfig);
          await assertDispatch(row.pluginId, taskId, assertPlanCurrent);
          assertPlanCurrent();
          run.inputClientIds = [...new Set([...(run.inputClientIds ?? []), item.clientId])];
          run.execution = execution;
          run.status = 'running';
          await save(row, run);
          if (run.invocationId) {
            try { deps.acceptInvocation?.(row.pluginId, run.invocationId); } catch { /* Never change input acceptance. */ }
          }
          await assertDispatch(row.pluginId, taskId, assertPlanCurrent);
          assertPlanCurrent();
        }
      }),
    settle: (
      taskId: string,
      execution: SessionExecutionIdentity,
      status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
      outputMessageId?: string,
    ) =>
      exclusive(async () => {
        for (const row of await deps.store.forSession(taskId)) {
          const run = JSON.parse(row.payload) as PluginTaskRun;
          if (terminal(run) || !isSameSessionExecution(run.execution, execution)) continue;
          run.status = status;
          run.completedAt = now();
          if (outputMessageId) run.outputMessageId = outputMessageId;
          await save(row, run);
        }
      }),
    discard: (taskId: string, item: OwnedQueuedInput, status: 'cancelled' | 'failed') =>
      exclusive(async () => {
        for (const row of await deps.store.forSession(taskId)) {
          const run = JSON.parse(row.payload) as PluginTaskRun;
          if (terminal(run) || !queuedInputBelongsTo(item, (value) => ownsInput(run, value)))
            continue;
          // A late queue cleanup for an older accepted input cannot settle a
          // newer recovery attempt. Unknown aliases still represent rejection
          // before acceptance and must be settled by the coordinator.
          const latestAccepted = run.inputClientIds?.at(-1);
          if (
            run.execution &&
            latestAccepted &&
            ownsInput(run, item.clientId) &&
            item.clientId !== latestAccepted
          )
            continue;
          run.status = status;
          run.completedAt = now();
          await save(row, run);
        }
      }),
  };
}
export type PluginTaskService = ReturnType<typeof createPluginTaskService>;
