import { createHash, randomUUID } from 'node:crypto';
import type { PluginTaskRoute, PluginTaskRun, PluginTaskView, PluginTeamPlan } from '../../shared/pluginTasks.js';
import { isPluginTeamPlanWithinBudget, PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS } from '../../shared/pluginTasks.js';
import {
  isSameSessionExecution,
  queuedInputBelongsTo,
  type OwnedQueuedInput,
  type SessionExecutionIdentity,
} from './sessionExecutionOwnership.js';

export interface PluginTaskReceipt {
  id: string;
  pluginId: string;
  operation: 'create' | 'send';
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
export interface PluginTaskServiceDeps {
  store: PluginTaskStore;
  /** Bound to the captured account/database epoch and plugin availability. */
  assertCurrent(): void;
  assertAuthorized(pluginId: string): void;
  readPermissionMode(pluginId: string): unknown;
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
  ): Promise<void>;
  setModel?(taskId: string, route: PluginTaskRoute, assertCurrent: () => Promise<void>): Promise<{ status: string }>;
  readSession(taskId: string): Promise<PluginTaskView | null>;
  assertTeamPlanUnstarted?(taskId: string): Promise<void>;
  dispatch(
    pluginId: string,
    taskId: string,
    clientId: string,
    text: string,
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
  const assertDispatch = async (pluginId: string, taskId: string) => {
    const view = await ownTask(pluginId, taskId);
    deps.assertAuthorized(pluginId);
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
    return view;
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
    // Host-only native lifecycle work shares send/cancel's drain. Do not use
    // exclusive here: native close callbacks may enqueue receipt writes.
    completeOperation,
    /** Retain receipts and user content, but never reuse an uninstalled installation's ownership. */
    withUninstall: (pluginId: string, remove: () => Promise<void>) => exclusive(async () => {
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
      request: { requestKey: string; title: string; route?: PluginTaskRoute; isolatedWorkspace?: boolean; callId?: string },
    ) =>
      exclusive(async () => {
        deps.assertAuthorized(pluginId);
        const input = [request.title, request.route ?? null, ...(request.isolatedWorkspace ? [true] : []), ...(request.callId ? [{ callId: request.callId }] : [])];
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
        const taskId = id();
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
          await deps.createSession(pluginId, taskId, request.title, route, request.isolatedWorkspace, request.route,
            () => { persistenceStarted = true; }, request.callId);
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
    setModel: (pluginId: string, request: { taskId: string; expectedRevision: number; route: PluginTaskRoute }) => exclusive(async () => {
      const assertUnchanged = async () => {
        const task = await ownTask(pluginId, request.taskId);
        if (task.status !== 'active') return fail('TASK_BUSY', '任务已归档，请先恢复任务');
        if (task.revision !== request.expectedRevision) return fail('STALE_REVISION', '任务配置已变化，请刷新后重试');
      };
      await assertUnchanged();
      const route = await deps.resolveRoute(pluginId, request.route);
      await assertUnchanged();
      if (!deps.setModel) return fail('HOST_NOT_READY', '任务模型服务尚未就绪');
      const result = await deps.setModel(request.taskId, route, assertUnchanged);
      return { ...result, task: await ownTask(pluginId, request.taskId) };
    }),
    get: (pluginId: string, taskId: string) => exclusive(() => ownTask(pluginId, taskId)),
    list: (pluginId: string, after = '', limit = 50) =>
      exclusive(async () => {
        deps.assertAuthorized(pluginId);
        const rows = await deps.store.list(pluginId, 'create', null, after, limit);
        const items = [];
        for (const row of rows) {
          // The store projects valid create payloads as empty to avoid loading plans.
          if (row.payload !== '' && !ownsTaskReceipt(row, pluginId)) continue;
          const view = await deps.readSession(row.id);
          if (view && view.status !== 'deleted') items.push(view);
        }
        return { items, nextCursor: rows.length === limit ? rows.at(-1)!.id : null };
      }),
    send: async (
      pluginId: string,
      request: { taskId: string; requestKey: string; expectedRevision: number; text: string },
    ): Promise<PluginTaskRun> => completeOperation(async () => {
      const prepared = await exclusive(async () => {
        const view = await ownTask(pluginId, request.taskId);
        const fingerprint = hash([request.text, request.expectedRevision]);
        const previous = replay(
          await deps.store.find(pluginId, 'send', request.taskId, request.requestKey),
          fingerprint,
        );
        if (previous)
          return { run: JSON.parse(previous.payload) as PluginTaskRun, dispatch: false };
        if (!isPluginTaskPermissionAllowed(view.permissionMode, deps.readPermissionMode(pluginId), view.planModeEnabled)) return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
        if (view.status !== 'active')
          return fail('TASK_BUSY', 'Archived tasks cannot accept input');
        if (view.revision !== request.expectedRevision)
          return fail('REVISION_CONFLICT', 'Task configuration changed');
        await deps.resolveRoute(pluginId, view.resolvedConfig);
        await assertDispatch(pluginId, view.taskId);
        const runId = id();
        const run: PluginTaskRun = {
          runId,
          taskId: view.taskId,
          inputMessageId: `plugin-task:${runId}`,
          status: 'queued',
          acceptedAt: now(),
          acceptedConfig: view.resolvedConfig,
          usage: { status: 'unavailable', reason: 'Per-input usage has not been reconciled.' },
        };
        deps.assertAuthorized(pluginId);
        await deps.store.insert(
          newReceipt(pluginId, 'send', view.taskId, request.requestKey, fingerprint, run, runId),
        );
        return { run, dispatch: true };
      });
      if (!prepared.dispatch) return prepared.run;
      let failure: 'failed' | 'reconciling' | undefined;
      let dispatchStarted = false;
      // Never hold the receipt lock while entering Session dispatch/control. The
      // coordinator awaits accept() before vendor dispatch under its own lock.
      try {
        await assertDispatch(pluginId, prepared.run.taskId);
        dispatchStarted = true;
        const outcome = await deps.dispatch(
          pluginId,
          prepared.run.taskId,
          prepared.run.inputMessageId,
          request.text,
        );
        if (!outcome.ok) failure = 'failed';
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
    }),
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
          const view = await ownTask(row.pluginId, taskId);
          if (view.status !== 'active') return fail('TASK_BUSY', 'Archived tasks cannot accept input');
          if (!isPluginTaskPermissionAllowed(view.permissionMode, deps.readPermissionMode(row.pluginId), view.planModeEnabled)) return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
          if (hash(view.resolvedConfig) !== hash(run.acceptedConfig))
            return fail('ROUTE_UNAVAILABLE', 'Accepted route changed before dispatch');
          await deps.resolveRoute(row.pluginId, run.acceptedConfig);
          await assertDispatch(row.pluginId, taskId);
          run.inputClientIds = [...new Set([...(run.inputClientIds ?? []), item.clientId])];
          run.execution = execution;
          run.status = 'running';
          await save(row, run);
          await assertDispatch(row.pluginId, taskId);
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
