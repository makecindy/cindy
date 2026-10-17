/**
 * 任务隧道的往来记录(运行 Agent 的电脑，一个任务一份)。
 *
 * Agent 经隧道访问任务所在电脑的执行环境(Codex exec-server 的 WebSocket)与 Cindy 工具(HTTP)，每一次
 * 都要过设备互联。这里记下最近一次往来的时间、exec-server 请求的计数与往返耗时：Codex 据此判断慢链路
 * 上的线程启动是否仍在推进(有往来就顺延关键 RPC 的上限)，超时时说明停在哪一步(#5764)。
 * 只记方法名、计数与耗时，不记路径与内容。
 */
import type { DeviceHostedLinkActivity } from '@cindy/maker-core';

/** 不超过这个长度的消息完整解析出 id / method；更长的(整段文件内容)只看开头。 */
const ENVELOPE_PARSE_LIMIT = 64 * 1024;
/** 长消息只在开头找 id / method：JSON-RPC 的顶层字段通常在 params / result 之前。 */
const ENVELOPE_HEAD_CHARS = 512;
const HEAD_ID = /^\s*\{\s*(?:"jsonrpc"\s*:\s*"[^"]*"\s*,\s*)?"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/;
const HEAD_METHOD = /"method"\s*:\s*"((?:[^"\\]|\\.)*)"/;
/** 在等回复的请求最多记这么多条(回复认不出来时不无限累积)。 */
const MAX_PENDING = 4096;
/** 往返耗时只统计最近这么多次。 */
const ROUND_TRIP_WINDOW = 256;

interface RpcEnvelope {
  /** JSON 编码后的 id(数字与字符串 id 不混淆)；通知没有 id。 */
  id?: string;
  method?: string;
}

/** 取 JSON-RPC 消息的 id 与 method；不是 JSON 对象时返回 null。 */
export function rpcEnvelope(data: string): RpcEnvelope | null {
  if (data.length <= ENVELOPE_PARSE_LIMIT) {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as { id?: unknown; method?: unknown };
    return {
      ...(typeof record.id === 'number' || typeof record.id === 'string' ? { id: JSON.stringify(record.id) } : {}),
      ...(typeof record.method === 'string' ? { method: record.method } : {}),
    };
  }
  const head = data.slice(0, ENVELOPE_HEAD_CHARS);
  const id = HEAD_ID.exec(head)?.[1];
  const method = HEAD_METHOD.exec(head)?.[1];
  if (id === undefined && method === undefined) return null;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(method !== undefined ? { method } : {}),
  };
}

/** 一个任务隧道上的往来计数。 */
export class TunnelLinkActivity {
  private lastActivityAt: number | null = null;
  private execRequests = 0;
  private execResponses = 0;
  private execMaxInFlight = 0;
  /** 在等回复的请求，键为「连接 + id」，按发出顺序(Map 保持插入顺序，最早的在前)。 */
  private readonly pending = new Map<string, { method: string; sentAt: number }>();
  private readonly roundTrips: number[] = [];
  private httpInFlight = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Agent 发给执行环境的一条 WebSocket 消息。 */
  agentMessage(connId: string, data: string): void {
    this.touch();
    const envelope = rpcEnvelope(data);
    // 通知(没有 id)与回复执行环境发起的请求(没有 method)不算请求。
    if (envelope?.id === undefined || envelope.method === undefined) return;
    this.execRequests += 1;
    this.pending.set(`${connId}\0${envelope.id}`, { method: envelope.method, sentAt: this.now() });
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    this.execMaxInFlight = Math.max(this.execMaxInFlight, this.pending.size);
  }

  /**
   * 执行环境发给 Agent 的一条 WebSocket 消息。只有回复算往来：执行环境主动推的通知(如后台命令的
   * process/output)不说明 Agent 还在推进，Agent 卡住时它们照样会来。
   */
  environmentMessage(connId: string, data: string): void {
    const envelope = rpcEnvelope(data);
    if (envelope?.method !== undefined) return;
    this.touch();
    if (envelope?.id === undefined) return;
    const key = `${connId}\0${envelope.id}`;
    const sent = this.pending.get(key);
    if (!sent) return;
    this.pending.delete(key);
    this.execResponses += 1;
    this.roundTrips.push(this.now() - sent.sentAt);
    if (this.roundTrips.length > ROUND_TRIP_WINDOW) this.roundTrips.shift();
  }

  /** 连接打开或关闭；关闭时这条连接上没等到的回复不会再来。 */
  connection(connId: string, closed: boolean): void {
    this.touch();
    if (!closed) return;
    const prefix = `${connId}\0`;
    for (const key of [...this.pending.keys()]) if (key.startsWith(prefix)) this.pending.delete(key);
  }

  /** Cindy 工具的 HTTP 请求开始 / 结束(回包或失败)。 */
  httpStarted(): void {
    this.touch();
    this.httpInFlight += 1;
  }

  httpFinished(): void {
    this.touch();
    this.httpInFlight = Math.max(0, this.httpInFlight - 1);
  }

  snapshot(): DeviceHostedLinkActivity {
    const now = this.now();
    const oldest = this.pending.values().next().value as { method: string; sentAt: number } | undefined;
    const roundTripTotal = this.roundTrips.reduce((sum, value) => sum + value, 0);
    return {
      lastActivityAt: this.lastActivityAt,
      execRequests: this.execRequests,
      execResponses: this.execResponses,
      execMaxInFlight: this.execMaxInFlight,
      ...(oldest ? { execOldestPending: { method: oldest.method, waitedMs: Math.max(0, now - oldest.sentAt) } } : {}),
      ...(this.roundTrips.length
        ? {
            execRoundTripAvgMs: Math.round(roundTripTotal / this.roundTrips.length),
            execRoundTripMaxMs: Math.max(...this.roundTrips),
          }
        : {}),
      httpInFlight: this.httpInFlight,
    };
  }

  private touch(): void {
    this.lastActivityAt = this.now();
  }
}
