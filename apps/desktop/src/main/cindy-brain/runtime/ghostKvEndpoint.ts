/**
 * /kv 协议端点的纯函数分派层(意识自定义参数存取,FORGE_GUIDE §4.8)。
 *
 * 与 ghostFiles.ts 同拓扑:与 Electron 解耦、单测直接覆盖(规范 14),
 * 唯一调用方是 electronSandboxAdapter 的 cindy-ghost:// 协议 handler。
 *
 * 协议(设置页 / 面板 / 电子脑同源共用,`fetch('/kv')`):
 * - GET            → 200 + 该意识 KV JSON(无数据 = {});
 * - PUT / POST     → body 必须是 JSON object,序列化 ≤ 64KB,整体覆盖写,204;
 * - 坏 JSON / 非 object → 400;超限 → 413;其它 method → 405;
 * - 存储层意外错误 → 500(**不外泄 message**,细节走日志)。
 *
 * 身份与隔离不在这层:ghostId 来自协议 handler 的分区绑定(主机派生,
 * 不信自报),跨意识请求早在分区断网闸 + host 断言就被掐了。
 */

import { GHOST_KV_MAX_BYTES, GhostKvError } from '../ghostKvStore.js';

export interface GhostKvRequestOutcome {
  status: number;
  /** 有 body 时恒为 JSON 文本(调用方统一佩 application/json 头)。 */
  body?: string;
}

/** 有界读取的最小请求面(结构化类型,避免绑死 DOM lib;Fetch Request 天然满足)。 */
interface BoundedBodySource {
  headers: { get(name: string): string | null };
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<unknown>;
    };
  } | null;
}

/**
 * 有界读 body(P1 防线:主机不能被沙箱 OOM)。不受信 body 永不全量进内存:
 * - content-length 声明超限 → 不碰 body 直接抛 TOO_LARGE(现实向量:renderer
 *   fetch 的 string/Blob body Chromium 必带 content-length);
 * - 无/假 content-length 兜底:流式累读,字节数一过上限立即断流抛 TOO_LARGE
 *   ——恶意方最多让主进程持有 64KB+一个 chunk,不是整个 body。
 * 抛出的 TOO_LARGE 由 handleGhostKvRequest 折叠成 413。
 */
export async function readBoundedBodyText(request: BoundedBodySource): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > GHOST_KV_MAX_BYTES) {
    throw new GhostKvError('TOO_LARGE', 'content-length 声明超限');
  }
  const body = request.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > GHOST_KV_MAX_BYTES) {
        throw new GhostKvError('TOO_LARGE', 'body 流超限');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    // 超限断流时取消余下的流(释放上游);正常读完 cancel 是 no-op。
    await reader.cancel().catch(() => {});
  }
}

interface GhostKvEndpointStore {
  read(ghostId: string): Record<string, unknown>;
  write(ghostId: string, value: Record<string, unknown>): void;
}

export async function handleGhostKvRequest(args: {
  method: string;
  /** 惰性读 body(Fetch Request.text() 一次性流,只在写路径消费)。 */
  readBodyText: () => Promise<string>;
  store: GhostKvEndpointStore;
  ghostId: string;
  isCurrent?: () => boolean;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<GhostKvRequestOutcome> {
  const { method, readBodyText, store, ghostId, log } = args;
  const isCurrent = args.isCurrent ?? (() => true);
  if (!isCurrent()) return { status: 403 };

  if (method === 'GET') {
    try {
      return { status: 200, body: JSON.stringify(store.read(ghostId)) };
    } catch (err) {
      log?.warn('ghost KV 读取意外失败', { ghostId, err: String(err) });
      return { status: 500 };
    }
  }

  if (method === 'PUT' || method === 'POST') {
    let text: string;
    try {
      text = await readBodyText();
    } catch (err) {
      if (!isCurrent()) return { status: 403 };
      // 有界读取器的超限断流 → 413;其它读流失败(中断等)→ 400。
      if (err instanceof GhostKvError && err.code === 'TOO_LARGE') {
        return { status: 413 };
      }
      return { status: 400 };
    }
    if (!isCurrent()) return { status: 403 };
    // 体积双保险(readBodyText 已流式限额;这里兜非有界注入的调用方)
    // 且先量再 parse:不给超限 payload 任何 JSON.parse 面。
    if (Buffer.byteLength(text, 'utf8') > GHOST_KV_MAX_BYTES) {
      return { status: 413 };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { status: 400 };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 400 };
    }
    try {
      if (!isCurrent()) return { status: 403 };
      store.write(ghostId, value as Record<string, unknown>);
      return { status: 204 };
    } catch (err) {
      if (err instanceof GhostKvError) {
        // 存储层双保险的校验错(理论上上面已拦):按语义映射,不当 500。
        return { status: err.code === 'TOO_LARGE' ? 413 : 400 };
      }
      log?.warn('ghost KV 写入意外失败', { ghostId, err: String(err) });
      return { status: 500 };
    }
  }

  return { status: 405 };
}
