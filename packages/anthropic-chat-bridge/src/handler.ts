/**
 * Bridge handler ——
 *
 * 以 anthropic-compat-proxy 的 `RoutingDecision.localHandler` 形态运行(**不是**独立 server):
 * 代理在路由决策命中 Chat-Completions wire 的自定义供应商时,把已收集的请求(parsed body +
 * ctx + res)直接交给本 handler,由它:
 *   1. strip model 前缀 → 真实 model id
 *   2. translateRequest → OpenAI Chat Completions 请求
 *   3. 注入 provider headers(buildHeaders 拿 API key)→ POST 上游 /chat/completions
 *   4. 逐条把上游 Chat Completions SSE 翻译成 Anthropic Messages SSE 写回 res
 *
 * 与 anthropic-responses-bridge 的分工一致:本包是插进引擎 `localHandler` 插槽的协议
 * 翻译 handler;消息流不多跳。响应是**翻译流**(非字节透传),逐事件翻译不缓冲整流,
 * 流式延迟仍接近零(唯一的缓冲是 tool_calls —— 见 translate-sse.ts 头注释的累积策略)。
 *
 * 错误契约(与引擎 runLocalHandler 对齐):本 handler 内部把可预期错误写成 Anthropic 风格
 * error 响应;意外抛错交给引擎(未写头 → 502 fail-open)。
 */

import type { ServerResponse } from 'node:http';

import { translateRequest } from './translate-request.js';
import { AnthropicSseTranslator, type AnthropicSseEvent } from './translate-sse.js';
import type {
  AnthropicMessagesRequest,
  BridgeLogger,
  ChatBridgeProviderConfig,
  UpstreamRateLimitInfo,
} from './types.js';

/**
 * 解析上游响应的 `x-ratelimit-*` 头(标准 OpenAI 风格)。全部字段都解析不出 → null(不回调)。
 * reset 类头格式跨供应商不稳定,不解析 —— 只取确定的数值字段,诚实降级。
 */
function parseRateLimitHeaders(headers: Headers): UpstreamRateLimitInfo | null {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw == null) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const info: UpstreamRateLimitInfo = {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
  };
  return Object.values(info).some((v) => v !== undefined) ? info : null;
}

/** 按 model 前缀匹配 provider 配置(最长前缀优先,防前缀互为子串时歧义;空前缀匹配所有)。 */
function matchProvider(model: string, providers: ChatBridgeProviderConfig[]): ChatBridgeProviderConfig | null {
  let best: ChatBridgeProviderConfig | null = null;
  for (const p of providers) {
    if (p.prefix && model.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) {
      best = p;
    } else if (!p.prefix && !best) {
      best = p;
    }
  }
  return best;
}

/** upstream 状态码 → Anthropic error type(尽量语义对齐,方便 SDK 分类)。 */
function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  return 'api_error';
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(buf.length) });
  res.end(buf);
}

function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

/** image block 的粗估 token 占位(与 anthropic-responses-bridge 同值)。 */
const IMAGE_BLOCK_ESTIMATE_CHARS = 1400 * 4;

/** chars/4 粗估 token —— 给 count_tokens 用(Chat 系上游无 Anthropic 的 count 端点)。 */
function estimateTokens(req: AnthropicMessagesRequest): number {
  let chars = 0;
  const sys = req.system;
  if (typeof sys === 'string') chars += sys.length;
  else if (Array.isArray(sys)) for (const b of sys) chars += (b?.text ?? '').length;
  // tools 的 JSON schema 是 prompt 的大头(Claude Code 常带几十 KB 工具定义),不算会让
  // /context 上下文表严重偏小、compaction 迟触发。
  for (const t of req.tools ?? []) {
    chars += (t.name?.length ?? 0) + (t.description?.length ?? 0);
    if (t.input_schema) {
      try {
        chars += JSON.stringify(t.input_schema).length;
      } catch {
        /* 环引用等异常 schema:跳过,不影响其余估算 */
      }
    }
  }
  for (const m of req.messages ?? []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        const rec = block as Record<string, unknown>;
        if (typeof rec.text === 'string') chars += rec.text.length;
        // 图像 block:base64 字节数与 token 数无关(vision 按分辨率计),且 stringify 整段
        // base64 会为一个 /4 粗估分配数 MB 临时串 —— 用固定占位。
        else if (rec.type === 'image') chars += IMAGE_BLOCK_ESTIMATE_CHARS;
        else chars += JSON.stringify(rec).length;
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** createAnthropicChatHandler 的 handle 入参 —— 与 compat-proxy LocalRequestHandler 的 args 同形。 */
export interface AnthropicChatHandleArgs {
  parsedBody: unknown;
  ctx: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };
  res: ServerResponse;
}

export interface AnthropicChatBridgeHandler {
  handle(args: AnthropicChatHandleArgs): Promise<void>;
}

export interface AnthropicChatHandlerOptions {
  /** 供应商配置列表(按 model 前缀路由;空前缀匹配所有)。前缀需互不为前缀关系,避免歧义。 */
  providers: ChatBridgeProviderConfig[];
  logger?: BridgeLogger;
  /**
   * 上游 fetch。默认全局 fetch(undici)—— 它**不吃系统代理**,宿主在「系统代理」模式
   * 下必须注入自己的代理感知实现(desktop 注入 maker-host/outbound-fetch)。
   */
  fetchImpl?: typeof fetch;
}

// 去尾部斜杠。不用 /\/+$/ 正则——超长 '/' 串上会 O(n²) 回溯(CodeQL js/polynomial-redos)。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

/**
 * 创建 Anthropic → Chat Completions 翻译 handler。host 把它包进 compat-proxy 的
 * `RoutingDecision.localHandler`:`{ localHandler: (args) => handler.handle(args) }`。
 */
export function createAnthropicChatHandler(opts: AnthropicChatHandlerOptions): AnthropicChatBridgeHandler {
  // 协议标识 fail-fast:注册了未实现的 wireProtocol 直接抛,不让它静默注册成不可用的源。
  for (const p of opts.providers) {
    if (p.wireProtocol !== undefined && p.wireProtocol !== 'openai-chat') {
      throw new Error(`bridge provider '${p.prefix}' 声明了未实现的 wireProtocol: ${String(p.wireProtocol)}`);
    }
  }
  const providers = opts.providers.map((p) => ({ ...p, upstreamBase: trimTrailingSlashes(p.upstreamBase) }));
  const log = opts.logger ?? {};
  const fetchImpl = opts.fetchImpl ?? fetch;
  let reqSeq = 0;

  async function handle({ parsedBody, ctx, res }: AnthropicChatHandleArgs): Promise<void> {
    const reqId = ++reqSeq;

    if (!isPlainObject(parsedBody)) {
      writeJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } });
      return;
    }
    const parsed = parsedBody as AnthropicMessagesRequest;

    // 按 model 前缀匹配 provider(count_tokens 请求 body 也带 model)。
    const wireModel = typeof parsed.model === 'string' ? parsed.model : '';
    const provider = matchProvider(wireModel, providers);
    if (!provider) {
      writeJson(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `no bridge provider for model '${wireModel}'` },
      });
      return;
    }
    // [1m] 是 cc 侧 wire 约定(目录窗口 ≥1M 的模型会带,见 maker-core toSdkModelString);
    // Chat 系上游不认识这个后缀,必须剥掉。
    const realModel = wireModel.slice(provider.prefix.length).replace(/\[1m\]$/, '');

    // count_tokens:上游无对应端点,本地估算返回。
    if (ctx.url.includes('count_tokens')) {
      writeJson(res, 200, { input_tokens: estimateTokens(parsed) });
      return;
    }

    const sessionId = ctx.headers['x-claude-code-session-id'] ?? undefined;

    // 鉴权:每请求让 provider 构造最新 headers。
    let providerHeaders: Record<string, string>;
    try {
      providerHeaders = await provider.buildHeaders({ sessionId });
    } catch (err) {
      log.error?.('buildHeaders failed', { reqId, prefix: provider.prefix, err: err instanceof Error ? err.message : String(err) });
      writeJson(res, 502, {
        type: 'error',
        error: { type: 'authentication_error', message: `bridge auth unavailable for ${provider.prefix}(请检查 API 密钥配置)` },
      });
      return;
    }

    const chatRequest = translateRequest(parsed, {
      model: realModel,
      capabilities: provider.capabilities,
    });

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let upstream: Response;
    try {
      upstream = await fetchImpl(
        `${provider.upstreamBase}${provider.chatCompletionsPath ?? '/chat/completions'}`,
        {
          method: 'POST',
          headers: {
            ...providerHeaders,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(chatRequest),
          signal: abort.signal,
        },
      );
    } catch (err) {
      if (abort.signal.aborted) return;
      log.error?.('upstream fetch failed', { reqId, err: err instanceof Error ? err.message : String(err) });
      writeJson(res, 502, { type: 'error', error: { type: 'api_error', message: `upstream unreachable: ${String(err)}` } });
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const text = upstream.body ? await upstream.text().catch(() => '') : '';
      log.warn?.('upstream non-2xx', { reqId, status: upstream.status, body: text.slice(0, 2000) });
      if (!upstream.ok && provider.onUpstreamError) {
        try {
          await provider.onUpstreamError({
            status: upstream.status,
            body: text,
            requestHeaders: providerHeaders,
          });
        } catch (err) {
          // Provider 状态收口失败不能吞掉或改写真实上游错误;调用方仍需看到原始状态码/正文。
          log.warn?.('onUpstreamError failed', {
            reqId,
            prefix: provider.prefix,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      writeJson(res, upstream.status, {
        type: 'error',
        error: { type: anthropicErrorType(upstream.status), message: text.slice(0, 2000) || `upstream ${upstream.status}` },
      });
      return;
    }

    // 上游限流头(标准 OpenAI 风格,多数 Chat 端点返 x-ratelimit-*)→ 尽力回调给 host 做额度展示。
    if (provider.onRateLimit) {
      const rateLimit = parseRateLimitHeaders(upstream.headers);
      if (rateLimit) {
        try {
          provider.onRateLimit(rateLimit);
        } catch {
          /* 回调异常不影响流转发 */
        }
      }
    }

    // 上游 2xx 但 content-type 不是 SSE(反代/网关吐 JSON 或 HTML):大概率整流翻不出
    // 任何事件,先留一条 warn —— 零事件收尾时的合成 error 会带上正文前缀。
    const upstreamContentType = upstream.headers.get('content-type') ?? '';
    if (!upstreamContentType.toLowerCase().includes('event-stream')) {
      log.warn?.('upstream 2xx with non-SSE content-type', {
        reqId,
        status: upstream.status,
        contentType: upstreamContentType || '(missing)',
      });
    }

    // 开始流式回写。
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    // 用 wireModel(带前缀)而非 realModel 构造 —— message_start 回显带前缀 id,
    // CC 的 modelUsage 据此记账,下游 usage 可按前缀区分桥接轮,不与真网关同名裸模型混淆。
    const translator = new AnthropicSseTranslator(wireModel);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // 零事件诊断:整流一条 Anthropic 事件都没写回时,CLI 只能报
    // "empty or malformed response (HTTP 200)" 并盲目重试,真实错误被完全掩盖。
    // 记录写回事件数与上游正文前缀,收尾时合成一条带上游信息的 error 事件 + warn 日志。
    let eventsWritten = 0;
    let rawPrefix = '';
    const RAW_PREFIX_LIMIT = 500;
    const writeOut = (ev: AnthropicSseEvent): void => {
      eventsWritten += 1;
      writeSseEvent(res, ev);
    };
    const finalizeStream = (): void => {
      for (const outEv of translator.finish(true)) writeOut(outEv);
      if (eventsWritten > 0) return;
      const bodyPrefix = rawPrefix.trim().slice(0, 300);
      log.warn?.('upstream stream yielded no translatable events', {
        reqId,
        contentType: upstreamContentType || '(missing)',
        bodyPrefix,
      });
      writeOut({
        event: 'error',
        data: {
          type: 'error',
          error: {
            type: 'api_error',
            message:
              `upstream returned HTTP ${upstream.status} but produced no translatable SSE events ` +
              `(content-type: ${upstreamContentType || 'missing'}${bodyPrefix ? `; body: ${bodyPrefix}` : ''})`,
          },
        },
      });
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        if (rawPrefix.length < RAW_PREFIX_LIMIT) {
          rawPrefix = (rawPrefix + chunkText).slice(0, RAW_PREFIX_LIMIT);
        }
        buf += chunkText;
        // SSE 事件以空行分隔;逐行取 `data:` 负载。用游标扫描、chunk 末尾一次性 slice ——
        // 避免每行 slice 整个剩余缓冲(大 chunk 数百行时是 O(n²) 拷贝,这是每 token 热路径)。
        let start = 0;
        let nl: number;
        while ((nl = buf.indexOf('\n', start)) >= 0) {
          const line = buf.slice(start, nl).replace(/\r$/, '');
          start = nl + 1;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') {
            translator.markTerminal();
            continue;
          }
          let ev: unknown;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          for (const outEv of translator.push(ev)) writeOut(outEv);
        }
        if (start > 0) buf = buf.slice(start);
      }
      // 上游正常结束:兜底收尾(finish_reason + [DONE] 时已按需输出;这里补 tool_use /
      // message 收尾)。整流零事件时合成带上游信息的 error 事件,绝不空 200 收尾。
      finalizeStream();
    } catch (err) {
      if (!abort.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn?.('upstream stream error', { reqId, err: errMsg });
        // 断流不走 finalizeStream:已写出部分事件后再补 message_stop,Claude Code 会
        // 把截断响应当正常完成、上游读取错误被掩盖(review 反馈 P1)。fail() 关块后
        // 发 error 事件收尾(错误帧已收尾时返回空,不重复报错)。
        for (const outEv of translator.fail(`upstream stream error: ${errMsg}`)) writeOut(outEv);
      }
    } finally {
      res.end();
    }
  }

  log.debug?.('anthropic-chat-bridge handler ready', { providers: providers.map((p) => p.prefix || '(all)') });
  return { handle };
}
