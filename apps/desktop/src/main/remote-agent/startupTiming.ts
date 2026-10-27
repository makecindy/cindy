import { performance } from 'node:perf_hooks';

export interface StartupTimingLogger {
  debug?(message: string, fields: Record<string, unknown>): void;
}

/** 固定字段的启动诊断；不接受 RPC 内容、路径或配置正文。 */
export interface StartupExecServerStats {
  shortcutEnabled: boolean;
  ancestorLevels: number;
  connections: number;
  answered: number;
  forwarded: number;
}

/** 本机单调时钟计时；只接收关联 ID 和固定阶段名，不接收路径、配置、凭证或错误正文。 */
export function remoteAgentStartupTiming(
  log: StartupTimingLogger | undefined,
  context: {
    side: 'controller' | 'transport' | 'host';
    kind: string;
    sessionId?: string;
    runId?: string;
    reconnect?: boolean;
  },
) {
  const started = performance.now();
  const stagesMs: Record<string, number> = {};
  const refs = {
    side: context.side,
    kind: context.kind,
    ...(context.sessionId ? { sessionRef: context.sessionId.slice(0, 8) } : {}),
    ...(context.runId ? { runRef: context.runId.slice(0, 8) } : {}),
    ...(context.reconnect !== undefined ? { reconnect: context.reconnect } : {}),
  };
  const emit = (fields: Record<string, unknown>) => {
    // 诊断输出失败不能改变创建结果或覆盖原始异常。
    try {
      log?.debug?.('remote agent startup timing', { ...refs, ...fields });
    } catch {
      /* diagnostic only */
    }
  };
  return {
    async measure<T>(stage: string, operation: () => Promise<T>): Promise<T> {
      const begin = performance.now();
      emit({ stage, status: 'started', elapsedMs: Math.round(begin - started) });
      let status = 'failed';
      try {
        const result = await operation();
        status = 'ok';
        return result;
      } finally {
        const durationMs = Math.max(0, Math.round(performance.now() - begin));
        stagesMs[stage] = (stagesMs[stage] ?? 0) + durationMs;
        emit({ stage, status, durationMs, elapsedMs: Math.round(performance.now() - started) });
      }
    },
    finish(status: 'ok' | 'failed', execServer?: StartupExecServerStats) {
      emit({
        stage: 'total',
        status,
        durationMs: Math.round(performance.now() - started),
        stagesMs: { ...stagesMs },
        ...(execServer ? { execServer: { ...execServer } } : {}),
      });
    },
  };
}
