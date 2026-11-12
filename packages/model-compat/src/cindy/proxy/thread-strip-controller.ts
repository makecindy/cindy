/**
 * Tracks threads that should proactively apply a body strip on every request,
 * after a thread has recovered once from a corresponding upstream 400.
 *
 * The controller is condition-agnostic (just a thread→model marker with a
 * model-change reset). Run ONE instance per independent strip condition — e.g.
 * one for encrypted_content, a separate one for empty thinking blocks. Sharing a
 * single instance across conditions would cross-contaminate: a recovery for one
 * condition would set shouldStrip=true and make the OTHER condition's active-strip
 * transform fire (e.g. stripping encrypted_content with no encrypted 400 — a real
 * cost: losing the model's reasoning chain).
 *
 * State is intentionally in-memory and per-instance. A process restart returns
 * every thread to the reactive retry path, and a model change clears the mark.
 */
export interface ThreadStripController {
  /** 标记某 thread 进入主动剥离(记下当时的 model)。 */
  markActive(threadId: string, model: string): void;
  /**
   * 状态收敛(有副作用):若该 thread 已标记但 model 变了(切了模型/供应商),清除标记。
   * 每个请求周期在 shouldStrip 之前调用一次。
   */
  reconcile(threadId: string, model: string): void;
  /** 纯读:该 thread 当前是否处于主动剥离状态(不修改任何状态)。 */
  shouldStrip(threadId: string): boolean;
  clear(threadId: string): void;
}

export function createThreadStripController(): ThreadStripController {
  const activeByThread = new Map<string, string>();

  return {
    markActive(threadId, model) {
      const tid = threadId.trim();
      const mid = model.trim();
      if (!tid || !mid) return;
      activeByThread.set(tid, mid);
    },

    reconcile(threadId, model) {
      const tid = threadId.trim();
      const mid = model.trim();
      if (!tid || !mid) return;
      const activeModel = activeByThread.get(tid);
      if (activeModel && activeModel !== mid) {
        activeByThread.delete(tid);
      }
    },

    shouldStrip(threadId) {
      return activeByThread.has(threadId.trim());
    },

    clear(threadId) {
      activeByThread.delete(threadId.trim());
    },
  };
}
