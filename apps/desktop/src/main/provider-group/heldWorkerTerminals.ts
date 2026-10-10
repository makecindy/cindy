/**
 * 协同 Worker 在供应商组换电脑期间先不回报给 Lead 的那次终态(docs/product-rules/provider-groups.md §6.1)。
 *
 * Worker 失败那一刻组会先试着换电脑时，输入协调器登记了「先不呈现」(与 error 行暂存同一次登记，按登记 id 结算)。
 * 这一轮还没有结局，不能先把「异常终止」回报给 Lead——Lead 会据此重新安排，同时 Worker 却在另一台电脑上接着做：
 * - 换成了(续跑已发出)：丢掉这次终态，续跑那一轮结束时照常把结果回报给 Lead；
 * - 没换成(交回原有处理、用户中途接手、迟迟没有结局)：把这次异常终止回报给 Lead，与没有供应商组时一致。
 *
 * 暂存时记下账号：结算时已换了账号就不再回报。结算只认自己那次登记，迟到的旧结算碰不到下一次失败。
 */

export interface ProviderGroupHeldWorkerTerminalsDeps<T> {
  /** 把暂存的终态回报给 Lead(与没有暂存时 terminal 路径同一个收口)。 */
  deliver(sessionId: string, terminal: T): void;
  /** 当前登录账号的作用域键。 */
  ownerKey(): string;
  log?(message: string, meta?: Record<string, unknown>): void;
}

export interface ProviderGroupHeldWorkerTerminals<T> {
  /** 暂存这次终态；同一次登记期间重复的终态也算已暂存(只回报一次)。 */
  stash(sessionId: string, holdId: number, terminal: T): void;
  /** 换成了：这次终态不再回报。 */
  discard(sessionId: string, holdId: number): void;
  /** 不再换了：回报这次终态。重复调用无副作用。 */
  release(sessionId: string, holdId: number): void;
}

interface HeldWorkerTerminal<T> {
  terminal: T;
  owner: string;
}

export function createProviderGroupHeldWorkerTerminals<T>(
  deps: ProviderGroupHeldWorkerTerminalsDeps<T>,
): ProviderGroupHeldWorkerTerminals<T> {
  /** sessionId → 登记 id → 暂存的终态。 */
  const held = new Map<string, Map<number, HeldWorkerTerminal<T>>>();

  function take(sessionId: string, holdId: number): HeldWorkerTerminal<T> | null {
    const entries = held.get(sessionId);
    const entry = entries?.get(holdId);
    if (!entries || !entry) return null;
    entries.delete(holdId);
    if (entries.size === 0) held.delete(sessionId);
    return entry;
  }

  return {
    stash(sessionId, holdId, terminal) {
      const entries = held.get(sessionId) ?? new Map<number, HeldWorkerTerminal<T>>();
      if (entries.has(holdId)) return;
      entries.set(holdId, { terminal, owner: deps.ownerKey() });
      held.set(sessionId, entries);
    },

    discard(sessionId, holdId) {
      take(sessionId, holdId);
    },

    release(sessionId, holdId) {
      const entry = take(sessionId, holdId);
      if (!entry) return;
      if (entry.owner !== deps.ownerKey()) {
        deps.log?.('provider group: dropped a held Worker report after the account changed', { sessionId });
        return;
      }
      deps.deliver(sessionId, entry.terminal);
    },
  };
}
