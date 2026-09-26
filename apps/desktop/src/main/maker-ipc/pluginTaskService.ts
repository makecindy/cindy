import { createHash, randomUUID } from 'node:crypto';
import type { PluginTaskRoute, PluginTaskRun, PluginTaskView, PluginTeamPlan } from '../../shared/pluginTasks.js';
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
  save(row: PluginTaskReceipt): Promise<void>;
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
const fail = (code: string, message: string): never => {
  throw new PluginTaskError(code, message);
};
const terminal = (run: PluginTaskRun) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
const ownsInput = (run: PluginTaskRun, value: string) =>
  value === run.inputMessageId || run.inputClientIds?.includes(value) === true;
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export interface PluginTaskServiceDeps {
  store: PluginTaskStore;
  /** Bound to the captured account/database epoch and plugin availability. */
  assertCurrent(): void;
  assertAuthorized(pluginId: string): void;
  resolveRoute(pluginId: string, route?: PluginTaskRoute): Promise<PluginTaskRoute>;
  createSession(
    pluginId: string,
    taskId: string,
    title: string,
    route: PluginTaskRoute,
    isolatedWorkspace?: boolean,
  ): Promise<void>;
  readSession(taskId: string): Promise<PluginTaskView | null>;
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
  const save = async (row: PluginTaskReceipt, payload: unknown) => {
    deps.assertCurrent();
    row.payload = JSON.stringify(payload);
    await deps.store.save(row);
    row.revision++;
  };
  const ownTask = async (pluginId: string, taskId: string) => {
    deps.assertAuthorized(pluginId);
    const receipt = await deps.store.get(taskId);
    if (!receipt || receipt.pluginId !== pluginId || receipt.operation !== 'create')
      return fail('TASK_NOT_FOUND', 'Task not found');
    const view = await deps.readSession(taskId);
    if (!view || view.status === 'deleted') return fail('TASK_NOT_FOUND', 'Task not found');
    return view;
  };
  const ownRun = async (pluginId: string, runId: string) => {
    const row = await deps.store.get(runId);
    if (!row || row.pluginId !== pluginId || row.operation !== 'send')
      return fail('TASK_NOT_FOUND', 'Run not found');
    await ownTask(pluginId, row.targetId);
    return row;
  };
  const replay = (row: PluginTaskReceipt | undefined, fingerprint: string) => {
    if (row && row.fingerprint !== fingerprint)
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
    if (
      observed.pending.some((item) => queuedInputBelongsTo(item, (value) => ownsInput(run, value)))
    )
      return run;
    if (isSameSessionExecution(observed.execution, run.execution)) return run;
    // Lack of a terminal is not success. Never replay an ambiguously dispatched input.
    run.status = 'reconciling';
    run.error =
      'No matching live execution or pending input; inspect the task before sending a new request.';
    return run;
  };
  return {
    create: (
      pluginId: string,
      request: { requestKey: string; title: string; route?: PluginTaskRoute; isolatedWorkspace?: boolean },
    ) =>
      exclusive(async () => {
        deps.assertAuthorized(pluginId);
        const fingerprint = hash([request.title, request.route ?? null, ...(request.isolatedWorkspace ? [true] : [])]);
        let row = replay(
          await deps.store.find(pluginId, 'create', '', request.requestKey),
          fingerprint,
        );
        if (row) {
          // Do not recreate a deleted/ambiguous task on replay.
          return ownTask(pluginId, row.id);
        }
        const route = await deps.resolveRoute(pluginId, request.route);
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
        deps.assertCurrent();
        await deps.createSession(pluginId, taskId, request.title, route, request.isolatedWorkspace);
        return ownTask(pluginId, taskId);
      }),
    setTeamPlan: (pluginId: string, taskId: string, plan: PluginTeamPlan) => exclusive(async () => {
      await ownTask(pluginId,taskId);
      const row = (await deps.store.get(taskId))!;
      const data = JSON.parse(row.payload);
      if (data.teamPlan && hash(data.teamPlan) !== hash(plan)) {
        // Older plans may acquire scope once, without changing their execution identity.
        const previous = data.teamPlan as PluginTeamPlan;
        const compatible = hash({ ...plan, task: previous.task,
          items: plan.items.map((item, i) => ({ ...item, task: previous.items[i]?.task })) }) === hash(previous)
          && (!previous.task || previous.task === plan.task)
          && previous.items.every((item, i) => !item.task || item.task === plan.items[i]?.task);
        if (!compatible) return fail('IDEMPOTENCY_CONFLICT', 'Team plan is immutable');
      }
      deps.assertAuthorized(pluginId);
      await save(row,{...data,teamPlan:plan});
      return {ok:true};
    }),
    settleWorkerLabel: (pluginId: string, taskId: string, label: string) => exclusive(async () => {
      await ownTask(pluginId,taskId);
      const row = (await deps.store.get(taskId))!;
      const data = JSON.parse(row.payload);
      if (!data.teamPlan?.items.some((x: {label:string})=>x.label===label)) return fail('INVALID_REQUEST','Worker is not in team plan');
      await save(row,{...data,settledLabels:[...new Set([...(data.settledLabels||[]),label])]});
    }),
    get: (pluginId: string, taskId: string) => exclusive(() => ownTask(pluginId, taskId)),
    list: (pluginId: string, after = '', limit = 50) =>
      exclusive(async () => {
        deps.assertAuthorized(pluginId);
        const rows = await deps.store.list(pluginId, 'create', null, after, limit);
        const items = [];
        for (const row of rows) {
          const view = await deps.readSession(row.id);
          if (view && view.status !== 'deleted') items.push(view);
        }
        return { items, nextCursor: rows.length === limit ? rows.at(-1)!.id : null };
      }),
    send: async (
      pluginId: string,
      request: { taskId: string; requestKey: string; expectedRevision: number; text: string },
    ): Promise<PluginTaskRun> => {
      const prepared = await exclusive(async () => {
        const view = await ownTask(pluginId, request.taskId);
        const fingerprint = hash([request.text, request.expectedRevision]);
        const previous = replay(
          await deps.store.find(pluginId, 'send', request.taskId, request.requestKey),
          fingerprint,
        );
        if (previous)
          return { run: JSON.parse(previous.payload) as PluginTaskRun, dispatch: false };
        if (view.permissionMode === 'bypassPermissions') return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
        if (view.status !== 'active')
          return fail('TASK_BUSY', 'Archived tasks cannot accept input');
        if (view.revision !== request.expectedRevision)
          return fail('REVISION_CONFLICT', 'Task configuration changed');
        await deps.resolveRoute(pluginId, view.resolvedConfig);
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
      // Never hold the receipt lock while entering Session dispatch/control. The
      // coordinator awaits accept() before vendor dispatch under its own lock.
      try {
        deps.assertAuthorized(pluginId);
        const outcome = await deps.dispatch(
          pluginId,
          prepared.run.taskId,
          prepared.run.inputMessageId,
          request.text,
        );
        if (!outcome.ok) failure = 'failed';
      } catch {
        failure = 'reconciling';
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
    },
    getRun: async (pluginId: string, runId: string) =>
      reconcile(await exclusive(() => ownRun(pluginId, runId))),
    listRuns: async (pluginId: string, taskId: string, after = '', limit = 50) => {
      const rows = await exclusive(async () => {
        await ownTask(pluginId, taskId);
        return deps.store.list(pluginId, 'send', taskId, after, limit);
      });
      const items = await Promise.all(rows.map(reconcile));
      deps.assertCurrent();
      deps.assertAuthorized(pluginId);
      return { items, nextCursor: rows.length === limit ? rows.at(-1)!.id : null };
    },
    cancel: async (pluginId: string, runId: string): Promise<PluginTaskRun> => {
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
    },
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
          if (view.permissionMode === 'bypassPermissions') return fail('PERMISSION_DENIED', 'Task permission exceeds plugin dispatch policy');
          if (hash(view.resolvedConfig) !== hash(run.acceptedConfig))
            return fail('ROUTE_UNAVAILABLE', 'Accepted route changed before dispatch');
          await deps.resolveRoute(row.pluginId, run.acceptedConfig);
          run.inputClientIds = [...new Set([...(run.inputClientIds ?? []), item.clientId])];
          run.execution = execution;
          run.status = 'running';
          await save(row, run);
        }
      }),
    settle: (
      taskId: string,
      execution: SessionExecutionIdentity,
      status: 'completed' | 'failed',
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
