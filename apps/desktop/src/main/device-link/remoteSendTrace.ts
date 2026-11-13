/**
 * 被控端远程发送耗时追踪（只写 debug 日志，不参与任何投递判定）。
 *
 * 一条远程消息在被控端经过四个点：enqueue 收到 → coordinator 收下 → 用户行落库 →
 * messages:created 推送发出。前两点在 enqueue handler 内，后两点发生在队列派发
 * 之后，已经脱离那次 invoke 的调用栈，所以按 clientId 记一张有界表，在推送转发处
 * 收尾输出一行。clientId 只记前 8 位；不记正文、设备名或会话内容。
 */
import { createLogger } from '../logger';

const log = createLogger('remote-send-trace');

const MAX_TRACES = 200;
const TRACE_TTL_MS = 5 * 60_000;

interface Trace {
  sessionId: string;
  receivedAt: number;
  acceptedAt?: number;
  stages: Record<string, number>;
}

const traces = new Map<string, Trace>();

function shortId(value: string): string {
  return value.slice(0, 8);
}

function prune(now: number): void {
  for (const [clientId, trace] of traces) {
    if (traces.size <= MAX_TRACES && now - trace.receivedAt < TRACE_TTL_MS) break;
    traces.delete(clientId);
  }
}

/** enqueue handler 入口：返回打点函数与收尾函数，调用方只在远程调用时使用。 */
export function beginRemoteSendTrace(
  sessionId: string,
  clientId: string,
): {
  stage(name: string): void;
  accepted(): void;
  finish(outcome: string): void;
} {
  const startedAt = performance.now();
  const stages: Record<string, number> = {};
  let last = startedAt;
  let done = false;
  return {
    stage(name) {
      const now = performance.now();
      stages[name] = Math.round(now - last);
      last = now;
    },
    accepted() {
      const now = Date.now();
      prune(now);
      traces.delete(clientId);
      traces.set(clientId, {
        sessionId,
        receivedAt: now - Math.round(performance.now() - startedAt),
        acceptedAt: now,
        stages: { ...stages },
      });
    },
    finish(outcome) {
      if (done) return;
      done = true;
      log.debug(
        `remote enqueue timing client=${shortId(clientId)} outcome=${outcome}` +
          ` totalMs=${Math.round(performance.now() - startedAt)} stagesMs=${JSON.stringify(stages)}`,
      );
    },
  };
}

/** 推送转发处调用：远程发送的用户行第一次推出去时输出整条链路的耗时。 */
export function observeRemoteSendPush(channel: string, payload: unknown): void {
  if (channel !== 'local-db:messages:created' || traces.size === 0) return;
  if (!payload || typeof payload !== 'object') return;
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return;
  const { clientId, role } = message as { clientId?: unknown; role?: unknown };
  if (role !== 'user' || typeof clientId !== 'string') return;
  const trace = traces.get(clientId);
  if (!trace) return;
  traces.delete(clientId);
  const now = Date.now();
  log.debug(
    `remote send pushed client=${shortId(clientId)}` +
      ` enqueueMs=${(trace.acceptedAt ?? trace.receivedAt) - trace.receivedAt}` +
      ` acceptedToPushMs=${now - (trace.acceptedAt ?? trace.receivedAt)}` +
      ` totalMs=${now - trace.receivedAt}` +
      ` stagesMs=${JSON.stringify(trace.stages)}`,
  );
}

/** 测试与账号切换时清空。 */
export function resetRemoteSendTraces(): void {
  traces.clear();
}
