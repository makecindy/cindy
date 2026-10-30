import type { BotAutonomyExecution } from '../../shared/botAutonomy.js';

/** The caller's conversation at creation. Following and execution location never rewrite it. */
export interface TaskCompletionOrigin {
  botId: string;
  sessionId: string;
  groupId?: string;
  threadRootId?: string;
}

export interface TaskCompletionReceipt {
  id: string;
  execution: BotAutonomyExecution;
  text: string;
  status: 'pending' | 'delivered' | 'failed';
  errorCode?: string;
  failureShown?: boolean;
  postSnapshot?: unknown;
}

export interface TaskCompletionRecord {
  origin: TaskCompletionOrigin;
  receipts: TaskCompletionReceipt[];
}

interface TaskCompletionTerminal {
  sessionId: string;
  execution: BotAutonomyExecution;
  successful: boolean;
  text: string;
}

export interface TaskCompletionDeliveryDeps {
  read(sessionId: string): Promise<TaskCompletionRecord | null>;
  update(sessionId: string, change: (record: TaskCompletionRecord) => void): Promise<void>;
  pending(): Promise<string[]>;
  post(sessionId: string, origin: TaskCompletionOrigin, receipt: TaskCompletionReceipt,
    freeze: (prepare: () => Promise<unknown>) => Promise<unknown>): Promise<
      { ok: true } | { ok: false; errorCode: string; retryable: boolean }>;
  showFailure(sessionId: string, receipt: TaskCompletionReceipt): Promise<void>;
  isCurrent(): boolean;
  log(error: unknown): void;
}

/** Durable delivery, separate from the task's execution and its current follower. */
export function createTaskCompletionDelivery(deps: TaskCompletionDeliveryDeps) {
  const reports = new Map<string, { execution: BotAutonomyExecution; final: boolean }>();
  const operations = new Map<string, Promise<unknown>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const unsettled = new Map<string, TaskCompletionTerminal>();
  let disposed = false;
  const current = () => !disposed && deps.isCurrent();
  const same = (a: BotAutonomyExecution, b: BotAutonomyExecution) =>
    a.instanceId === b.instanceId && a.generation === b.generation;
  const serial = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const run = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    operations.set(id, run);
    try { return await run; }
    finally { if (operations.get(id) === run) operations.delete(id); }
  };
  const retry = (id: string) => {
    if (!current() || timers.has(id)) return;
    const timer = setTimeout(() => {
      timers.delete(id);
      const terminal = unsettled.get(id);
      void (terminal ? settle(terminal) : deliver(id)).catch(deps.log);
    }, 60_000);
    timer.unref?.();
    timers.set(id, timer);
  };
  const deliverUnserialized = async (id: string) => {
    if (!current()) return;
    const record = await deps.read(id);
    if (!record || !current()) return;
    for (const receipt of record.receipts) {
      if (receipt.status === 'delivered' || !current()) continue;
      const showFailure = async () => {
        if (receipt.failureShown || !current()) return;
        await deps.showFailure(id, receipt);
        await deps.update(id, saved => { saved.receipts.find(item => item.id === receipt.id)!.failureShown = true; });
        receipt.failureShown = true;
      };
      try {
        if (receipt.status === 'failed') { await showFailure(); continue; }
        const result = await deps.post(id, record.origin, receipt, async prepare => {
          if (receipt.postSnapshot !== undefined) return receipt.postSnapshot;
          const snapshot = await prepare();
          if (!current()) throw new Error('OWNER_CHANGED');
          await deps.update(id, saved => {
            const target = saved.receipts.find(item => item.id === receipt.id)!;
            target.postSnapshot ??= snapshot;
            receipt.postSnapshot = target.postSnapshot;
          });
          return receipt.postSnapshot;
        });
        if (!current()) return;
        await deps.update(id, saved => {
          const target = saved.receipts.find(item => item.id === receipt.id)!;
          target.status = result.ok ? 'delivered' : result.retryable ? 'pending' : 'failed';
          target.errorCode = result.ok ? undefined : result.errorCode;
        });
        if (!result.ok) {
          receipt.errorCode = result.errorCode;
          await showFailure();
          if (result.retryable) retry(id);
        }
      } catch (error) {
        deps.log(error);
        if (current()) {
          retry(id);
          // Retain both the original result and a visible failure when transport throws.
          try {
            await deps.update(id, saved => { saved.receipts.find(item => item.id === receipt.id)!.errorCode ??= 'REQUEST_FAILED'; });
            await showFailure();
          } catch (noticeError) { deps.log(noticeError); }
        }
      }
    }
  };
  const deliver = (id: string) => serial(id, () => deliverUnserialized(id));
  async function settle(input: TaskCompletionTerminal) {
    const report = reports.get(input.sessionId);
    if (!report || !same(report.execution, input.execution)) return;
    if (!report.final || !input.successful || !current()) {
      reports.delete(input.sessionId);
      return;
    }
    try {
      await serial(input.sessionId, async () => {
        const saved = await deps.read(input.sessionId);
        if (!saved || !current()) return;
        if (!saved.receipts.some(receipt => same(receipt.execution, input.execution))) {
          await deps.update(input.sessionId, record => {
            record.receipts.push({ id: `task-result:${input.sessionId}:${input.execution.instanceId}:${input.execution.generation}`,
              execution: input.execution, text: input.text, status: 'pending' });
          });
        }
        unsettled.delete(input.sessionId);
        if (reports.get(input.sessionId) === report) reports.delete(input.sessionId);
        await deliverUnserialized(input.sessionId);
      });
    } catch (error) {
      deps.log(error);
      if (!current()) return;
      unsettled.set(input.sessionId, input);
      retry(input.sessionId);
      try {
        await deps.showFailure(input.sessionId, { id: `task-result:${input.sessionId}:${input.execution.instanceId}:${input.execution.generation}`,
          execution: input.execution, text: input.text, status: 'pending', errorCode: 'PERSIST_FAILED' });
      } catch (noticeError) { deps.log(noticeError); }
    }
  }
  return {
    report(id: string, execution: BotAutonomyExecution, final: boolean) {
      if (current()) reports.set(id, { execution: { ...execution }, final });
    },
    hasOrigin: async (id: string) => current() && !!await deps.read(id),
    settle,
    /** Suppress follower replies even if delivery failed; only the frozen origin may receive it. */
    async handles(id: string) { return current() && !!await deps.read(id); },
    async restore() {
      for (const id of await deps.pending()) {
        if (!current()) return;
        await deliver(id);
      }
    },
    dispose() {
      disposed = true;
      reports.clear();
      unsettled.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
