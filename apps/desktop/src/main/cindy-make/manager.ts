import type { CindyMakeGlobalState, MakeDoctorReport } from '../../shared/cindyMakeDoctor.js';

export type CindyMakeOperationKey =
  | { resource: 'environment'; mode: 'check' | 'prepare'; forceManagedTools: boolean }
  | { resource: 'source'; mode: 'prepare' | 'clear'; forceManagedTools: boolean };

export type CindyMakeStateListener = (state: CindyMakeGlobalState) => void;

function keyId(key: CindyMakeOperationKey): string {
  return [key.resource, key.mode, key.forceManagedTools ? 'managed' : 'system'].join(':');
}

function stateSlot(key: CindyMakeOperationKey): keyof CindyMakeGlobalState {
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

  subscribe(listener: CindyMakeStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  getState(): CindyMakeGlobalState {
    return { ...this.states };
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
    for (const listener of this.stateListeners) listener(state);
  }
}

export const cindyMakeManager = new CindyMakeManager();
