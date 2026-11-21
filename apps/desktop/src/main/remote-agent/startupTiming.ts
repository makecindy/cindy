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

/**
 * 启动资料有多大：只有字节数和固定字段名，不含内容。2026-11-21 一次启动在上传启动资料上
 * 等了 65 秒(占总时长 94%)，日志却看不出是资料太大还是线路太慢。
 */
export interface StartupPayloadStats {
  /** 分段上传的 gzip 字节数；内联发送时为 0。 */
  uploadBytes: number;
  /** 分段数；内联发送时为 0。 */
  chunks: number;
  /** 打开载荷里几个大字段各自序列化后的 UTF-8 字节数(未压缩)。 */
  fieldBytes?: Record<string, number>;
}

/** 只量这几个由代码定义的字段名；其余字段都是开关和 ID，量了也没有意义。 */
const OPEN_PAYLOAD_SIZE_FIELDS = [
  'options',
  'workspace',
  'projectFiles',
  'ancestorFiles',
  'importFiles',
  'personal',
] as const;

export function openPayloadFieldBytes(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const sizes: Record<string, number> = {};
  for (const key of OPEN_PAYLOAD_SIZE_FIELDS) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    try {
      sizes[key] = Buffer.byteLength(JSON.stringify(field) ?? '', 'utf8');
    } catch {
      /* diagnostic only */
    }
  }
  return sizes;
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
    finish(status: 'ok' | 'failed', execServer?: StartupExecServerStats, payload?: StartupPayloadStats) {
      emit({
        stage: 'total',
        status,
        durationMs: Math.round(performance.now() - started),
        stagesMs: { ...stagesMs },
        ...(execServer ? { execServer: { ...execServer } } : {}),
        ...(payload
          ? { payload: { ...payload, ...(payload.fieldBytes ? { fieldBytes: { ...payload.fieldBytes } } : {}) } }
          : {}),
      });
    },
  };
}
