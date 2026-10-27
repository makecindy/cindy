/**
 * 控制端远程发送耗时（debug 日志，不参与任何发送判定）。
 *
 * 一条远程消息记三个点：点击发送（乐观记录登记）→ 被控端收下（enqueue 成功）→
 * 被控端落库的用户行回显。clientId 只记前 8 位，不记正文或设备身份。
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('remote-send-trace');

const MAX_TRACES = 200;

interface Trace {
  registeredAt: number;
  acceptedAt?: number;
  dispatchStartedAt?: number;
  attempts: number;
}

const traces = new Map<string, Trace>();

function shortId(clientId: string): string {
  return clientId.slice(0, 8);
}

export function traceRemoteSendRegistered(clientId: string): void {
  traces.delete(clientId);
  traces.set(clientId, { registeredAt: performance.now(), attempts: 0 });
  while (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next().value;
    if (oldest === undefined) break;
    traces.delete(oldest);
  }
}

export function traceRemoteSendDispatching(clientId: string): void {
  const trace = traces.get(clientId);
  if (!trace) return;
  trace.attempts += 1;
  trace.dispatchStartedAt = performance.now();
}

export function traceRemoteSendAccepted(clientId: string): void {
  const trace = traces.get(clientId);
  if (!trace || trace.acceptedAt !== undefined) return;
  const now = performance.now();
  trace.acceptedAt = now;
  log.debug(
    `remote send accepted client=${shortId(clientId)}` +
      ` clickToAcceptedMs=${Math.round(now - trace.registeredAt)}` +
      ` lastDispatchMs=${trace.dispatchStartedAt === undefined ? -1 : Math.round(now - trace.dispatchStartedAt)}` +
      ` attempts=${trace.attempts}`,
  );
}

/** 被控端落库的用户行回显到达：输出点击到回显的总耗时并结束追踪。 */
export function traceRemoteSendEcho(clientId: string, role: string): void {
  if (role !== 'user') return;
  const trace = traces.get(clientId);
  if (!trace) return;
  traces.delete(clientId);
  const now = performance.now();
  log.debug(
    `remote send echoed client=${shortId(clientId)}` +
      ` clickToEchoMs=${Math.round(now - trace.registeredAt)}` +
      ` acceptedToEchoMs=${trace.acceptedAt === undefined ? -1 : Math.round(now - trace.acceptedAt)}`,
  );
}

export function traceRemoteSendDropped(clientId: string): void {
  traces.delete(clientId);
}
