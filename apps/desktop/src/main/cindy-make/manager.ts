import type {
  CindyMakeGlobalState,
  CindyMakeTaskStart,
  MakeDoctorReport,
  MakeSourceStatus,
  CindyMakeTaskActionState,
  CindyMakeTaskError,
} from '../../shared/cindyMakeDoctor.js';
import { CINDY_MAKE_TASK_ERROR_CODES } from '../../shared/cindyMakeDoctor.js';
import type { SourcePreparationProgress, SourcePreparationResult } from './sourcePreparation.js';
import { untilAborted } from './doctor.js';

interface SharedSourceJob {
  clearOnly: boolean;
  controller: AbortController;
  latest?: SourcePreparationProgress;
  status?: MakeSourceStatus;
  listeners: Set<(progress: SourcePreparationProgress) => void>;
  promise: Promise<SourcePreparationResult>;
}

export interface CindyMakeTaskLifecycle {
  create: (previous?: MakeDoctorReport) => Promise<MakeDoctorReport>;
  onCreated?: () => void;
  prepare: (signal: AbortSignal, publish: (report: MakeDoctorReport) => void) => Promise<void>;
  start: (signal: AbortSignal) => Promise<void>;
  persist: (report: MakeDoctorReport) => Promise<void>;
  isCurrent: () => boolean;
  onError: (error: unknown) => void;
}

interface ActiveTask {
  input: CindyMakeTaskStart;
  controller: AbortController;
  report?: MakeDoctorReport;
  created: Promise<string>;
  done?: Promise<void>;
  lifecycle: CindyMakeTaskLifecycle;
}

interface TaskAction {
  state: CindyMakeTaskActionState;
  isCurrent: () => boolean;
  promise: Promise<void>;
  recycleOnly: boolean;
}

export type CindyMakeOperationKey =
  | { resource: 'environment'; mode: 'check' | 'prepare'; forceManagedTools: boolean }
  | { resource: 'source'; mode: 'prepare' | 'clear'; forceManagedTools: boolean };

export type CindyMakeStateListener = (state: CindyMakeGlobalState) => void;

function keyId(key: CindyMakeOperationKey): string {
  return [key.resource, key.mode, key.forceManagedTools ? 'managed' : 'system'].join(':');
}

function stateSlot(
  key: CindyMakeOperationKey,
): 'environmentCheck' | 'environmentPrepare' | 'sourcePrepare' | 'sourceClear' {
  if (key.resource === 'environment')
    return key.mode === 'check' ? 'environmentCheck' : 'environmentPrepare';
  return key.mode === 'prepare' ? 'sourcePrepare' : 'sourceClear';
}

interface ActiveOperation {
  controller: AbortController;
  key: CindyMakeOperationKey;
  keyId: string;
  operationId: string;
  participants: Set<number>;
  context?: unknown;
  latest?: MakeDoctorReport;
  listeners: Set<(report: MakeDoctorReport) => void>;
  aliases: Set<string>;
  resolve: (report: MakeDoctorReport) => void;
  promise: Promise<MakeDoctorReport>;
}

export interface CindyMakeOperationHandle<T = unknown> {
  controller: AbortController;
  operationId: string;
  attached: boolean;
  promise: Promise<MakeDoctorReport>;
  publish: (report: MakeDoctorReport) => void;
  readonly context?: T;
  complete: (report: MakeDoctorReport, context?: T) => void;
  unsubscribe: () => void;
}

/** Main-owned lifecycle for Cindy Make operations; renderer lifetime is never part of it. */
export class CindyMakeManager {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly aliases = new Map<string, ActiveOperation>();
  private readonly workflows = new Map<string, { sender: number; controller: AbortController }>();
  private readonly states: CindyMakeGlobalState = {};
  private readonly stateListeners = new Set<CindyMakeStateListener>();
  private readonly sourceJobs = new Map<string, SharedSourceJob>();
  private readonly projectJobs = new Map<string, Promise<unknown>>();
  private readonly projectUsers = new Map<string, number>();
  private personalBuild: object | undefined;
  private readonly reports = new Map<
    string,
    { report: MakeDoctorReport; isCurrent: () => boolean }
  >();
  private readonly tasks = new Map<string, ActiveTask>();
  // Retained reports are history; only unsettled work owns the application lock.
  private readonly preparingTasks = new Set<ActiveTask>();
  private readonly taskActions = new Map<string, TaskAction>();
  private readonly runningTaskActions = new Set<TaskAction>();
  private readonly restoredTasks = new Map<
    string,
    { report: MakeDoctorReport; isCurrent: () => boolean }
  >();
  private sourceRevision = 0;
  private isProjectBusy: (root: string) => boolean = () => false;
  private mergeSessionCurrent: () => boolean = () => true;

  setProjectBusyProbe(probe: (root: string) => boolean): void {
    this.isProjectBusy = probe;
  }

  private projectInUse(root: string): boolean {
    return (
      (this.projectUsers.get(root) ?? 0) > 0 ||
      this.isProjectBusy(root) ||
      (!!this.states.upstreamMerge &&
        this.states.upstreamMerge.status !== 'merged' &&
        this.states.upstreamMerge.status !== 'cancelled' &&
        (this.states.upstreamMerge.hasWorkspace === true ||
          this.states.upstreamMerge.cancellationRequested === true ||
          this.states.upstreamMerge.status !== 'failed'))
    );
  }
  /** Active preparation/cleanup must finish before a local application version switch. */
  hasActiveWork(): boolean {
    return (
      this.active.size > 0 ||
      this.sourceJobs.size > 0 ||
      this.preparingTasks.size > 0 ||
      this.runningTaskActions.size > 0 ||
      this.projectUsers.size > 0 ||
      !!this.personalBuild ||
      this.projectJobs.size > 0
    );
  }

  /** Both entry points reserve synchronously, before any asynchronous build work. */
  claimPersonalBuild(): () => void {
    if (this.personalBuild)
      throw Object.assign(new Error('personal build is running'), { code: 'busy' });
    const claim = {};
    this.personalBuild = claim;
    return () => {
      if (this.personalBuild === claim) this.personalBuild = undefined;
    };
  }

  setUpstreamMerge(
    state: CindyMakeGlobalState['upstreamMerge'],
    isCurrent: () => boolean = () => true,
  ): void {
    this.states.upstreamMerge = state;
    this.mergeSessionCurrent = isCurrent;
    this.notify();
  }

  async withProjectUse<T>(root: string, run: () => Promise<T>): Promise<T> {
    if (this.sourceJobs.get(root)?.clearOnly)
      throw Object.assign(new Error('project is being cleared'), { code: 'busy' });
    this.projectUsers.set(root, (this.projectUsers.get(root) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const users = (this.projectUsers.get(root) ?? 1) - 1;
      if (users === 0) this.projectUsers.delete(root);
      else this.projectUsers.set(root, users);
    }
  }

  setReport(report: MakeDoctorReport, isCurrent: () => boolean): void {
    if (!isCurrent()) return;
    this.reports.set(report.runId, { report: structuredClone(report), isCurrent });
    this.notify();
  }

  async withProject<T>(root: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.projectJobs.get(root) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => {
        signal?.throwIfAborted();
        return run();
      })
      .finally(() => {
        if (this.projectJobs.get(root) === pending) this.projectJobs.delete(root);
      });
    this.projectJobs.set(root, pending);
    return pending;
  }

  sourceStatus(root: string): MakeSourceStatus | undefined {
    return this.sourceJobs.get(root)?.status;
  }

  isPreparingSource(root: string): boolean {
    return this.sourceJobs.has(root);
  }

  setSourceStatus(status: MakeSourceStatus): void {
    this.sourceRevision += 1;
    this.states.source = status;
    this.notify();
  }

  async refreshSourceStatus(
    read: (publish: (status: MakeSourceStatus) => boolean) => Promise<MakeSourceStatus>,
  ): Promise<MakeSourceStatus> {
    let revision = ++this.sourceRevision;
    // One revision guard spans every stage, including our own intermediate writes.
    // A preparation/clear or another refresh invalidates all remaining stages.
    const publish = (status: MakeSourceStatus): boolean => {
      if (revision !== this.sourceRevision) return false;
      revision += 1;
      this.setSourceStatus(status);
      return revision === this.sourceRevision;
    };
    const status = await read(publish);
    if (!publish(status) && this.states.source) return structuredClone(this.states.source);
    return status;
  }

  cancelSource(): boolean {
    let cancelled = false;
    for (const job of this.sourceJobs.values()) {
      if (job.controller.signal.aborted) continue;
      job.controller.abort('cancelled');
      cancelled = true;
    }
    return cancelled;
  }

  async prepareSource(input: {
    root: string;
    clearOnly: boolean;
    signal: AbortSignal;
    cancelled: () => SourcePreparationResult;
    onCancelledBeforeStart?: (result: SourcePreparationResult) => Promise<void>;
    onProgress: (progress: SourcePreparationProgress) => void;
    toStatus: (progress: SourcePreparationProgress) => MakeSourceStatus;
    run: (
      signal: AbortSignal,
      publish: (progress: SourcePreparationProgress) => void,
    ) => Promise<SourcePreparationResult>;
  }): Promise<SourcePreparationResult> {
    while (
      this.sourceJobs.has(input.root) &&
      this.sourceJobs.get(input.root)?.clearOnly !== input.clearOnly
    ) {
      if (input.signal.aborted) return input.cancelled();
      await untilAborted(this.sourceJobs.get(input.root)!.promise, input.signal).catch(
        () => undefined,
      );
    }
    if (input.signal.aborted) return input.cancelled();
    if (
      this.states.upstreamMerge?.cancellationRequested ||
      (this.states.upstreamMerge?.hasWorkspace && this.states.upstreamMerge.status !== 'merged')
    )
      throw Object.assign(new Error('upstream merge is pending'), { code: 'busy' });
    if (
      input.clearOnly &&
      (this.projectInUse(input.root) ||
        [...this.tasks.values()].some(
          (task) => task.lifecycle.isCurrent() && task.report?.status === 'running',
        ))
    ) {
      throw Object.assign(new Error('task preparation is running'), { code: 'busy' });
    }
    let job = this.sourceJobs.get(input.root);
    if (!job) {
      job = {
        clearOnly: input.clearOnly,
        controller: new AbortController(),
        listeners: new Set(),
        promise: Promise.resolve(input.cancelled()),
      };
      const current = job;
      this.sourceJobs.set(input.root, current);
      current.latest = {
        ...input.cancelled(),
        status: 'preparing',
        error: undefined,
        phase: this.projectJobs.has(input.root) ? 'waiting' : 'checking',
      };
      current.status = input.toStatus(current.latest);
      this.setSourceStatus(current.status);
      current.promise = this.withProject(input.root, async () => {
        if (current.controller.signal.aborted) {
          const result = input.cancelled();
          await input.onCancelledBeforeStart?.(result);
          current.latest = result;
          current.status = input.toStatus(result);
          this.setSourceStatus(current.status);
          for (const listener of current.listeners) {
            try {
              listener(result);
            } catch {}
          }
          return result;
        }
        if (input.clearOnly && this.projectInUse(input.root))
          throw Object.assign(new Error('project is in use'), { code: 'busy' });
        return input.run(current.controller.signal, (progress) => {
          current.latest = progress;
          current.status = input.toStatus(progress);
          this.setSourceStatus(current.status);
          for (const listener of current.listeners) {
            try {
              listener(progress);
            } catch {}
          }
        });
      })
        .catch((error) => {
          const result: SourcePreparationResult = current.controller.signal.aborted
            ? input.cancelled()
            : {
                ...input.cancelled(),
                status: 'failed',
                error: (error as { code?: unknown })?.code === 'busy' ? 'locked' : 'gitFailed',
              };
          current.status = input.toStatus(result);
          this.setSourceStatus(current.status);
          return result;
        })
        .finally(() => {
          if (this.sourceJobs.get(input.root) === current) this.sourceJobs.delete(input.root);
        });
    }
    const current = job;
    const abort = () => current.controller.abort(input.signal.reason);
    current.listeners.add(input.onProgress);
    input.signal.addEventListener('abort', abort, { once: true });
    if (current.latest) input.onProgress(current.latest);
    try {
      return await current.promise;
    } finally {
      current.listeners.delete(input.onProgress);
      input.signal.removeEventListener('abort', abort);
    }
  }

  startTask(input: CindyMakeTaskStart, lifecycle: CindyMakeTaskLifecycle): Promise<string> {
    this.restoredTasks.delete(input.runId);
    const previous = this.tasks.get(input.runId);
    const existing = previous?.lifecycle.isCurrent() ? previous : undefined;
    if (previous && !existing) previous.controller.abort('owner-changed');
    if (existing) {
      // History retry callers need only the run identity. Explicit conflicting origins
      // still fail; an omitted origin comes from the Main-owned preparation.
      input = {
        ...input,
        originSessionId: input.originSessionId ?? existing.input.originSessionId,
      };
      if (
        existing.input.originSessionId !== input.originSessionId ||
        existing.input.request !== input.request
      ) {
        return Promise.reject(
          Object.assign(new Error('task run does not match'), { code: 'invalid' }),
        );
      }
      if (
        this.preparingTasks.has(existing) ||
        existing.report?.status === 'running' ||
        existing.report?.status === 'completed' ||
        !existing.report
      )
        return existing.created;
    }
    const controller = new AbortController();
    const task: ActiveTask = { input, controller, created: Promise.resolve(''), lifecycle };
    this.tasks.set(input.runId, task);
    this.preparingTasks.add(task);
    task.created = (async () => {
      const report = await lifecycle.create(existing?.report);
      if (!report.task) throw new Error('task identity missing');
      if (!lifecycle.isCurrent()) throw new Error('task owner changed');
      task.report = report;
      await lifecycle.persist(report);
      lifecycle.onCreated?.();
      this.publishTask(task);
      task.done = this.runTask(task).finally(() => {
        this.preparingTasks.delete(task);
        this.notify();
      });
      return report.task.sessionId;
    })().catch((error) => {
      this.preparingTasks.delete(task);
      if (task.report) {
        task.report = { ...task.report, status: 'failed' };
        this.publishTask(task);
      } else if (this.tasks.get(input.runId) === task) this.tasks.delete(input.runId);
      throw error;
    });
    return task.created;
  }

  isTaskPreparing(sessionId: string): boolean {
    return [...this.tasks.values()].some(
      (task) =>
        task.lifecycle.isCurrent() &&
        task.report?.task?.sessionId === sessionId &&
        task.report.status === 'running',
    );
  }

  cancelTasksForSession(sessionId: string): void {
    for (const task of this.tasks.values()) {
      if (task.report?.task?.sessionId === sessionId && task.report.status === 'running')
        task.controller.abort('cancelled');
    }
    this.notify();
  }

  async settleTasksForSession(sessionId: string): Promise<void> {
    this.cancelTasksForSession(sessionId);
    await Promise.all(
      [...this.tasks.values()]
        .filter((task) => task.report?.task?.sessionId === sessionId)
        .map((task) => task.created.then(() => task.done).catch(() => undefined)),
    );
  }

  /** Owns cleanup from dispatch through completion, including when every view unmounts. */
  runTaskAction(
    sessionId: string,
    action: CindyMakeTaskActionState['action'],
    isCurrent: () => boolean,
    run: () => Promise<void>,
    nestedRecycle = false,
  ): Promise<void> {
    if (!isCurrent())
      return Promise.reject(Object.assign(new Error('owner changed'), { code: 'unavailable' }));
    const existing = this.taskActions.get(sessionId);
    if (existing?.isCurrent() && existing.state.status === 'running') {
      // The canonical terminal-session hook runs inside the outer Settings action.
      // It must not await its own parent's promise or overwrite its progress.
      if (nestedRecycle) return run();
      // A later explicit action waits for the existing background recycle to settle.
      if (existing.recycleOnly)
        return existing.promise
          .catch(() => undefined)
          .then(() => this.runTaskAction(sessionId, action, isCurrent, run));
      if (existing.state.action === action) return existing.promise;
      return Promise.reject(Object.assign(new Error('task cleanup in progress'), { code: 'busy' }));
    }
    const entry: TaskAction = {
      state: { action, status: 'running' },
      isCurrent,
      promise: Promise.resolve(),
      recycleOnly: nestedRecycle,
    };
    this.taskActions.set(sessionId, entry);
    this.runningTaskActions.add(entry);
    entry.promise = Promise.resolve()
      .then(() => {
        if (!isCurrent()) throw Object.assign(new Error('owner changed'), { code: 'unavailable' });
        return run();
      })
      .then(
        () => {
          if (this.taskActions.get(sessionId) === entry) this.taskActions.delete(sessionId);
        },
        (error) => {
          const code = (error as { code?: CindyMakeTaskError })?.code;
          entry.state = {
            action,
            status: 'failed',
            error: code && CINDY_MAKE_TASK_ERROR_CODES.includes(code) ? code : 'cleanupFailed',
          };
          throw error;
        },
      )
      .finally(() => {
        this.runningTaskActions.delete(entry);
        if (isCurrent()) this.notify();
      });
    this.notify();
    return entry.promise;
  }

  forgetTask(runId: string): void {
    const live = this.tasks.delete(runId);
    const restored = this.restoredTasks.delete(runId);
    if (live || restored) this.notify();
  }

  projectTaskSession(
    runId: string,
    projection: Partial<NonNullable<MakeDoctorReport['task']>>,
  ): void {
    const report = this.taskReport(runId);
    if (!report?.task) return;
    if (
      Object.entries(projection).every(
        ([key, value]) =>
          report.task![key as keyof NonNullable<MakeDoctorReport['task']>] === value,
      )
    )
      return;
    Object.assign(report.task, projection);
    this.notify();
  }

  taskReport(runId: string): MakeDoctorReport | undefined {
    const task = this.tasks.get(runId);
    if (task?.lifecycle.isCurrent()) return task.report;
    const restored = this.restoredTasks.get(runId);
    return restored?.isCurrent() ? restored.report : undefined;
  }

  restoreTaskReport(
    report: MakeDoctorReport,
    isCurrent: () => boolean,
  ): MakeDoctorReport | undefined {
    if (!isCurrent() || !report.task) return undefined;
    const active = this.tasks.get(report.runId);
    if (active?.lifecycle.isCurrent()) return undefined;
    const restored =
      report.status === 'running' ? { ...report, status: 'cancelled' as const } : report;
    const previous = this.restoredTasks.get(report.runId);
    if (previous?.isCurrent()) {
      // Runtime execution is projected separately from the persisted preparation.
      restored.task = {
        ...restored.task!,
        executing: previous.report.task?.executing,
        integration: previous.report.task?.integration,
      };
      if (JSON.stringify(previous.report) === JSON.stringify(restored)) return undefined;
    }
    this.restoredTasks.set(report.runId, { report: restored, isCurrent });
    this.notify();
    return restored;
  }

  waitForTask(runId: string): Promise<void> {
    const task = this.tasks.get(runId);
    return task ? task.created.then(() => task.done) : Promise.resolve();
  }

  private publishTask(task: ActiveTask): void {
    if (!task.report || !task.lifecycle.isCurrent()) return;
    this.notify();
  }

  private async runTask(task: ActiveTask): Promise<void> {
    const { lifecycle, controller } = task;
    if (task.report?.status === 'completed') return;
    const timeout = setTimeout(() => controller.abort('timeout'), 20 * 60_000);
    let persistence = Promise.resolve();
    let persistenceError: unknown;
    const publish = (report: MakeDoctorReport) => {
      if (controller.signal.aborted) return;
      if (!lifecycle.isCurrent()) {
        controller.abort('owner-changed');
        return;
      }
      task.report = report;
      this.publishTask(task);
      persistence = persistence
        .then(() => lifecycle.persist(report))
        .catch((error) => {
          persistenceError = error;
          controller.abort('persistence');
        });
    };
    try {
      await lifecycle.prepare(controller.signal, publish);
      controller.signal.throwIfAborted();
      if (!lifecycle.isCurrent()) throw new Error('task owner changed');
      publish({ ...task.report!, task: { ...task.report!.task!, phase: 'starting' } });
      await persistence;
      controller.signal.throwIfAborted();
      await lifecycle.start(controller.signal);
      task.report = {
        ...task.report!,
        status: 'completed',
        task: { ...task.report!.task!, phase: 'completed' },
      };
    } catch (error) {
      lifecycle.onError(persistenceError ?? error);
      task.report = {
        ...task.report!,
        status:
          controller.signal.aborted && controller.signal.reason === 'cancelled'
            ? 'cancelled'
            : 'failed',
      };
    } finally {
      clearTimeout(timeout);
    }
    await persistence;
    if (lifecycle.isCurrent()) {
      try {
        await lifecycle.persist(task.report!);
      } catch (error) {
        lifecycle.onError(error);
      }
      this.publishTask(task);
    }
  }

  subscribe(listener: CindyMakeStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  getState(): CindyMakeGlobalState {
    const restored = Object.fromEntries(
      [...this.restoredTasks].flatMap(([runId, task]) =>
        task.isCurrent() ? [[runId, task.report]] : [],
      ),
    );
    const tasks = {
      ...restored,
      ...Object.fromEntries(
        [...this.tasks].flatMap(([runId, task]) =>
          task.report && !task.report.task?.finished && task.lifecycle.isCurrent()
            ? [[runId, task.report]]
            : [],
        ),
      ),
    };
    return structuredClone({
      ...this.states,
      ...(this.states.upstreamMerge && !this.mergeSessionCurrent()
        ? {
            upstreamMerge: {
              ...this.states.upstreamMerge,
              sessionId: undefined,
              ownedByAnotherAccount: true,
            },
          }
        : {}),
      reports: Object.fromEntries(
        [...this.reports].flatMap(([runId, entry]) =>
          entry.isCurrent() ? [[runId, entry.report]] : [],
        ),
      ),
      ...(Object.keys(tasks).length ? { tasks } : { tasks: undefined }),
      taskActions: Object.fromEntries(
        [...this.taskActions].flatMap(([id, job]) => (job.isCurrent() ? [[id, job.state]] : [])),
      ),
    });
  }

  claim<T = unknown>(
    key: CindyMakeOperationKey,
    operationId: string,
    sender: number,
    listener: (report: MakeDoctorReport) => void,
  ): CindyMakeOperationHandle<T> {
    if (this.aliases.has(operationId) || this.workflows.has(operationId))
      throw Object.assign(new Error('already running'), { code: 'busy' });
    const id = keyId(key);
    const existing = this.active.get(id);
    if (existing) {
      const wrapped = (report: MakeDoctorReport) => listener({ ...report, runId: operationId });
      existing.listeners.add(wrapped);
      existing.participants.add(sender);
      existing.aliases.add(operationId);
      this.aliases.set(operationId, existing);
      if (existing.latest) listener({ ...existing.latest, runId: operationId });
      return {
        controller: existing.controller,
        operationId: existing.operationId,
        attached: true,
        promise: existing.promise.then((report) => ({ ...report, runId: operationId })),
        get context() {
          return existing.context as T | undefined;
        },
        publish: () => {},
        complete: () => {},
        unsubscribe: () => existing.listeners.delete(wrapped),
      };
    }

    let resolve!: (report: MakeDoctorReport) => void;
    const operation: ActiveOperation = {
      controller: new AbortController(),
      key,
      keyId: id,
      operationId,
      participants: new Set([sender]),
      listeners: new Set(),
      aliases: new Set([operationId]),
      resolve,
      promise: new Promise<MakeDoctorReport>((resolvePromise) => {
        resolve = resolvePromise;
      }),
    };
    operation.resolve = resolve;
    const wrapped = (report: MakeDoctorReport) => listener({ ...report, runId: operationId });
    operation.listeners.add(wrapped);
    this.active.set(id, operation);
    this.aliases.set(operationId, operation);
    let completed = false;
    const complete = (report: MakeDoctorReport, context?: T) => {
      if (completed) return;
      completed = true;
      operation.latest = report;
      operation.context = context;
      this.states[stateSlot(operation.key)] = { active: false, report };
      this.active.delete(operation.keyId);
      for (const alias of operation.aliases) this.aliases.delete(alias);
      operation.resolve(report);
      this.notify();
    };
    return {
      controller: operation.controller,
      operationId,
      attached: false,
      promise: operation.promise.then((report) => ({ ...report, runId: operationId })),
      get context() {
        return operation.context as T | undefined;
      },
      publish: (report) => {
        if (completed) return;
        operation.latest = report;
        this.states[stateSlot(operation.key)] = { active: true, report };
        this.notify();
        for (const current of operation.listeners) current(report);
      },
      complete,
      unsubscribe: () => operation.listeners.delete(wrapped),
    };
  }

  startWorkflow(
    operationId: string,
    sender: number,
  ): {
    controller: AbortController;
    complete: () => void;
  } {
    if (this.aliases.has(operationId) || this.workflows.has(operationId))
      throw Object.assign(new Error('already running'), { code: 'busy' });
    const workflow = { sender, controller: new AbortController() };
    this.workflows.set(operationId, workflow);
    return {
      controller: workflow.controller,
      complete: () => {
        if (this.workflows.get(operationId) === workflow) this.workflows.delete(operationId);
      },
    };
  }

  cancel(operationId: string, sender: number): 'cancelled' | 'forbidden' | 'not-found' {
    const task = this.tasks.get(operationId);
    if (task && task.lifecycle.isCurrent()) {
      if (task.report?.status !== 'running' || task.report.task?.phase === 'starting')
        return 'not-found';
      task.controller.abort('cancelled');
      return 'cancelled';
    }
    const operation = this.aliases.get(operationId);
    if (!operation) {
      const workflow = this.workflows.get(operationId);
      if (!workflow) return 'not-found';
      if (workflow.sender !== sender) return 'forbidden';
      workflow.controller.abort('cancelled');
      return 'cancelled';
    }
    if (
      operation.key.resource === 'environment' &&
      operation.key.mode === 'check' &&
      !operation.participants.has(sender)
    )
      return 'forbidden';
    if (!operation.controller.signal.aborted) operation.controller.abort('cancelled');
    return 'cancelled';
  }

  snapshot(key: CindyMakeOperationKey): MakeDoctorReport | undefined {
    return this.active.get(keyId(key))?.latest ?? this.states[stateSlot(key)]?.report;
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {}
    }
  }
}

export const cindyMakeManager = new CindyMakeManager();
