import type { JsonRpcId } from './app-server/protocol.js';

export interface CodexInteractionBrokerKey {
  connectionId: string;
  requestId: JsonRpcId;
}

export interface CodexInteractionBrokerMeta extends CodexInteractionBrokerKey {
  kind: 'request_user_input' | 'dynamic_tool' | 'mcp_elicitation';
  threadId?: string;
  turnId?: string | null;
  itemId?: string | null;
}

interface PendingInteraction<T> {
  meta: CodexInteractionBrokerMeta;
  resolve: (value: T) => void;
  settled: boolean;
}

function brokerKey(key: CodexInteractionBrokerKey): string {
  return `${key.connectionId}:${String(key.requestId)}`;
}

/**
 * Tracks Codex server requests that are waiting for user/UI input.
 *
 * The stable key is connectionId + server JSON-RPC request id. Thread/turn/item
 * ids are kept as metadata and cancellation indexes because Codex may auto-clear
 * requests during turn interrupt/complete or across minor protocol versions.
 */
export class CodexInteractionBroker<T> {
  private readonly pending = new Map<string, PendingInteraction<T>>();

  track(
    meta: CodexInteractionBrokerMeta,
    run: (settle: (value: T) => void) => void | Promise<void>,
  ): Promise<T> {
    const key = brokerKey(meta);
    const existing = this.pending.get(key);
    if (existing && !existing.settled) {
      return Promise.reject(new Error(`Duplicate Codex interaction request id: ${String(meta.requestId)}`));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingInteraction<T> = { meta, resolve, settled: false };
      this.pending.set(key, entry);
      const settle = (value: T) => {
        if (entry.settled) return;
        entry.settled = true;
        this.pending.delete(key);
        resolve(value);
      };
      let result: void | Promise<void>;
      try {
        result = run(settle);
      } catch (err) {
        if (!entry.settled) {
          entry.settled = true;
          this.pending.delete(key);
          reject(err);
        }
        return;
      }
      Promise.resolve(result).catch((err) => {
        if (entry.settled) return;
        entry.settled = true;
        this.pending.delete(key);
        reject(err);
      });
    });
  }

  cancel(key: CodexInteractionBrokerKey, value: T): boolean {
    const entry = this.pending.get(brokerKey(key));
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this.pending.delete(brokerKey(key));
    entry.resolve(value);
    return true;
  }

  cancelWhere(
    predicate: (meta: CodexInteractionBrokerMeta) => boolean,
    value: T,
  ): CodexInteractionBrokerMeta[] {
    const cancelled: CodexInteractionBrokerMeta[] = [];
    for (const [key, entry] of this.pending) {
      if (entry.settled || !predicate(entry.meta)) continue;
      entry.settled = true;
      this.pending.delete(key);
      entry.resolve(value);
      cancelled.push(entry.meta);
    }
    return cancelled;
  }

  has(key: CodexInteractionBrokerKey): boolean {
    const entry = this.pending.get(brokerKey(key));
    return Boolean(entry && !entry.settled);
  }
}
