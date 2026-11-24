/**
 * Claude fast mode 链路核验日志 ——
 *
 * fast mode(research preview, Opus 4.8 / 4.7)生效需要请求侧 `speed:"fast"` +
 * `anthropic-beta: fast-mode-2026-02-01`,而**是否真生效**只能看上游返回的
 * `usage.speed`(== "fast" 才是真跑了 fast):中间网关 / 上游只要不认这个 beta,
 * 请求头照发、`usage.speed` 仍是 standard。所以这里两头都记:
 *   - 开头(请求 transform,passthrough 不改写):cc 这次"问没问" fast(body.speed + beta 头)
 *   - 结尾(响应 observer,只读 tee SSE):上游"答没答应"(usage.speed)
 *
 * 都 debug-gated:Debug 日志开关关闭(生产默认)时 isDebugEnabled() = false →
 * 请求 transform 立即 return null、observer 不挂 sink,零开销、字节级不变。
 * 复刻 codex-proxy-host 的 service_tier observer 套路(SSE tee + 上限 + 命中即停)。
 *
 * 仅链路核验用,不参与路由 / 改写,放在 transform 链最前(passthrough)。
 */

import type {
  ProxyLogger,
  RequestTransform,
  ResponseObserver,
  ResponseObserverCtx,
} from '@cindy/anthropic-compat-proxy';
import { Buffer } from 'node:buffer';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** 匹配 fast-mode-2026-02-01 等任意日期版本的 beta token。 */
const FAST_MODE_BETA = 'fast-mode';
/** observer tee 的硬上限,超过即放弃(防异常超长响应吃内存)。与 codex observer 同量级。 */
const OBSERVER_MAX_BYTES = 2 * 1024 * 1024;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 大小写不敏感取 header 值;无则空串。 */
export function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === 'string') return v;
  }
  return '';
}

/** 请求是否带 fast-mode beta 头(任意日期版本)。 */
function requestHasFastBeta(headers: Readonly<Record<string, string>>): boolean {
  return headerValue(headers, 'anthropic-beta').toLowerCase().includes(FAST_MODE_BETA);
}

/**
 * 按 content-encoding 造流式解压器。Anthropic Messages 响应通常 gzip/br 压缩,
 * observer 拿到的是 raw 上游字节(主路径字节级 pipe,客户端自己解压),所以这里要先解。
 * identity / 空 / 未知编码 → null(直接按文本读)。
 */
export function makeDecompressor(contentEncoding: string): Transform | null {
  switch (contentEncoding.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'br':
      return createBrotliDecompress();
    case 'deflate':
      return createInflate();
    default:
      return null;
  }
}

/** url 去掉 query 后是否命中 Anthropic Messages API。 */
export function isMessagesPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === '/v1/messages' || path.endsWith('/messages');
}

/**
 * 从一条 SSE data JSON 里抽 `usage.speed`。
 *   - message_start: data.message.usage.speed(流式 usage 起点,speed 在这就定了)
 *   - message_delta / 非流式顶层: data.usage.speed(兜底)
 * 都没有则返 null。
 */
export function extractResponseSpeed(data: Record<string, unknown>): string | null {
  const message = isPlainObject(data.message) ? data.message : null;
  const startUsage = message && isPlainObject(message.usage) ? message.usage : null;
  if (startUsage) {
    const s = stringField(startUsage, 'speed');
    if (s) return s;
  }
  const usage = isPlainObject(data.usage) ? data.usage : null;
  if (usage) {
    const s = stringField(usage, 'speed');
    if (s) return s;
  }
  return null;
}

/** 解析一个 SSE frame(可能含 event: / 多行 data:),返回 data JSON。 */
export function readSseFrameData(frame: string, onInvalidData?: () => void): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const part of frame.split(/\r?\n/)) {
    if (part.startsWith('data:')) dataLines.push(part.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const text = dataLines.join('\n').trim();
  if (!text || text === '[DONE]') return null;
  const data = parseJsonObject(text);
  if (!data) onInvalidData?.();
  return data;
}

/**
 * 开头:请求侧 transform —— 只读记日志,**永远 return null 不改写 body**(字节级透传)。
 * 仅对 POST /v1/messages 且 debug 开启时记一条:本次 turn 请求了什么 speed、带没带 fast beta。
 */
export function createClaudeFastModeRequestTransform(log: ProxyLogger): RequestTransform {
  return (body, ctx) => {
    if (!(log.isDebugEnabled?.() ?? false)) return null; // 生产零开销
    if (ctx.method !== 'POST' || !isMessagesPath(ctx.url)) return null;
    if (isPlainObject(body)) {
      log.debug?.('claude fast mode requested (request side)', {
        model: stringField(body, 'model'),
        requestSpeed: stringField(body, 'speed'), // "fast" | "standard" | null
        fastBeta: requestHasFastBeta(ctx.headers), // 请求头是否带 fast-mode-*
      });
    }
    return null; // 不改写,继续后续 transform / 字节透传
  };
}

/**
 * 结尾:响应侧 observer —— 只读 tee SSE,抽上游返回的 `usage.speed`。
 * 这才是 fast "是否真生效"的判据:appliedFast === (responseSpeed === 'fast')。
 * debug 关闭时直接 return null(不挂 sink、不 tee),零开销。
 */
export function createClaudeFastModeResponseObserver(log: ProxyLogger): ResponseObserver {
  return (ctx: ResponseObserverCtx) => {
    if (!(log.isDebugEnabled?.() ?? false)) return null; // 生产零开销:不挂 sink
    if (ctx.method !== 'POST' || !isMessagesPath(ctx.url)) return null;
    if (ctx.status < 200 || ctx.status >= 300) return null;
    const contentType = (ctx.responseHeaders['content-type'] ?? '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');
    const isJson = contentType.includes('application/json');
    if (!isSse && !isJson) return null;

    // 请求侧上下文,日志里和 responseSpeed 并排显示("问的"对"答的")。
    const reqBody = parseJsonObject(ctx.requestBody.toString('utf8'));
    const model = reqBody ? stringField(reqBody, 'model') : null;
    const requestSpeed = reqBody ? stringField(reqBody, 'speed') : null;
    const fastBeta = requestHasFastBeta(ctx.requestHeaders);

    const contentEncoding = headerValue(ctx.responseHeaders, 'content-encoding');
    let done = false;
    let total = 0; // 解压后累计字节,做内存上限
    let buf = '';
    // 找不到 speed 时,把实际看到的 usage 对象原样留底,用于分辨"上游没给 speed"vs"找错位置"。
    let lastUsage: Record<string, unknown> | null = null;

    const emit = (responseSpeed: string | null): void => {
      done = true;
      log.debug?.('claude fast mode applied (usage.speed observed)', {
        reqId: ctx.reqId,
        upstreamBase: ctx.upstreamBase,
        status: ctx.status,
        model,
        requestSpeed,
        fastBeta,
        contentEncoding: contentEncoding || 'identity',
        responseSpeed, // 真生效判据
        appliedFast: responseSpeed === 'fast',
      });
    };

    const processFrame = (frame: string): void => {
      const data = readSseFrameData(frame);
      if (!data) return;
      // 留底实际 usage 对象(message_start.message.usage 或 message_delta/顶层 usage)。
      const message = isPlainObject(data.message) ? data.message : null;
      if (message && isPlainObject(message.usage)) lastUsage = message.usage;
      else if (isPlainObject(data.usage)) lastUsage = data.usage;
      const speed = extractResponseSpeed(data);
      if (speed) emit(speed);
    };

    const drain = (flush: boolean): void => {
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        processFrame(frame);
        if (done) return;
      }
      if (!done && flush && buf.trim()) {
        processFrame(buf);
        buf = '';
      }
    };

    // 解压后的文本进入这里(无论是否解压都走它),做上限保护 + SSE 增量 drain。
    const appendText = (text: string): void => {
      if (done) return;
      total += text.length;
      if (total > OBSERVER_MAX_BYTES) {
        done = true;
        log.debug?.('claude fast mode observer skipped oversized response', {
          reqId: ctx.reqId,
          bytes: total,
        });
        return;
      }
      buf += text;
      if (isSse) drain(false);
    };

    const finalize = (): void => {
      if (done) return;
      if (isSse) {
        drain(true);
        if (!done) {
          log.debug?.('claude fast mode: usage.speed not seen in response', {
            reqId: ctx.reqId,
            model,
            requestSpeed,
            fastBeta,
            contentEncoding: contentEncoding || 'identity',
            // 上游回的 usage 长啥样:有 speed → 我找错位置;无 speed → 上游(网关)没跑 fast。
            usageKeys: lastUsage ? Object.keys(lastUsage) : null,
            usage: lastUsage,
          });
        }
        return;
      }
      // 非流式:整条 body 一次到位,直接取顶层 usage.speed。
      const body = parseJsonObject(buf);
      emit(body ? extractResponseSpeed(body) : null);
    };

    // gzip/br/deflate → 流式解压再 parse;identity → 直接按文本读。
    const decoder = makeDecompressor(contentEncoding);
    if (decoder) {
      decoder.on('data', (d: Buffer) => appendText(d.toString('utf8')));
      decoder.on('end', () => finalize());
      decoder.on('error', (err: Error) => {
        if (done) return;
        done = true;
        log.debug?.('claude fast mode observer decompress error', {
          reqId: ctx.reqId,
          contentEncoding,
          err: err.message,
        });
      });
    }

    return {
      onData: (chunk: Buffer) => {
        if (done) return;
        if (decoder) {
          try {
            decoder.write(chunk);
          } catch {
            /* decoder 已销毁 */
          }
        } else {
          appendText(chunk.toString('utf8'));
        }
      },
      onEnd: () => {
        // 解压路径:end() 后异步触发 decoder 'end' → finalize();非解压路径直接 finalize。
        if (decoder) {
          try {
            decoder.end();
          } catch {
            /* noop */
          }
          return;
        }
        finalize();
      },
      onError: (err: Error) => {
        if (done) return;
        if (decoder) decoder.destroy();
        log.debug?.('claude fast mode observer stream error', {
          reqId: ctx.reqId,
          err: err.message,
        });
      },
    };
  };
}
