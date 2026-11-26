/**
 * DB worker 排队分级。
 *
 * 侧栏/对账这类重读和本机写会话挤同一条 SQLite worker 时，读会把 128/512 占满，
 * 写直接 overloaded。用 AsyncLocalStorage 给「后台读」盖章：worker 限制后台占用、
 * 出队时写入优先。默认（无标记）= 交互写入，包括本机打字和远程发消息。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type DbRpcAdmissionClass = 'interactive' | 'background';

// A scheduling CAS can be retried once the worker is fenced from starting it.
const retryableWrite = new AsyncLocalStorage<boolean>();

export function runAsRetryableDbWrite<T>(fn: () => T): T {
  return retryableWrite.run(true, fn);
}

export function isRetryableDbWrite(): boolean {
  return retryableWrite.getStore() === true;
}

const storage = new AsyncLocalStorage<DbRpcAdmissionClass>();

export function runAsBackgroundDbRpc<T>(fn: () => T): T {
  return storage.run('background', fn);
}

export function currentDbRpcAdmissionClass(): DbRpcAdmissionClass {
  return storage.getStore() ?? 'interactive';
}

export function isBackgroundDbRpc(): boolean {
  return storage.getStore() === 'background';
}
