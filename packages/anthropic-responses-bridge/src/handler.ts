/**
 * Bridge handler ——
 *
 * 以 anthropic-compat-proxy 的 `RoutingDecision.localHandler` 形态运行(**不是**独立 server):
 * 代理在路由决策命中订阅前缀 model 时,把已收集的请求(parsed body + ctx + res)直接交给本
 * handler,由它:
 *   1. strip model 前缀 → 真实 model id
 *   2. translateRequest → OpenAI Responses 请求
 *   3. 注入 OAuth headers(provider.buildHeaders 拿最新凭证)→ POST 上游 /responses
 *   4. 按调用方的 stream 模式把上游 Responses SSE / JSON 翻译成 Anthropic Messages SSE / JSON
 *
 * 会话态(effort / Fast)由 host 的 routingTransform 在决策点解析后经 `prefs` 闭包传入,
 * 不走任何伪 header。响应是**翻译流**(非字节透传)——这是本包与 compat-proxy 引擎的分工:
 * 引擎守字节级零延迟透传,handler 做协议翻译;逐事件翻译不缓冲整流,流式延迟仍接近零。
 *
 * 错误契约(与引擎 runLocalHandler 对齐):本 handler 内部把可预期错误写成 Anthropic 风格
 * error 响应;意外抛错交给引擎(未写头 → 502 fail-open)。
 */

import type { ServerResponse } from 'node:http';

import { AnthropicMessageCollector } from './anthropic-message-collector.js';
import { translateRequest, type ResponsesReasoningEffort } from './translate-request.js';
import { SseTranslator, type AnthropicSseEvent } from './translate-sse.js';
import type {
  AnthropicMessagesRequest,
  BridgeLogger,
  BridgeProviderConfig,
  UpstreamRateLimitInfo,
} from './types.js';

/**
 * maker 的 effort 档(minimal/low/medium/high/xhigh/max)→ Responses 端点接受的 4 档。
 * Responses(codex / api.x.ai)只认 low/medium/high/xhigh:minimal 收敛到 low、max 收敛到 xhigh。
 * 无输入 / 无法识别 → undefined(translateRequest 回退默认档)。
 */
function normalizeReasoningEffort(raw: string | undefined): ResponsesReasoningEffort | undefined {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'xhigh';
    default:
      return undefined;
  }
}

/**
 * 解析上游响应的 `x-ratelimit-*` 头(标准 OpenAI 风格)。全部字段都解析不出 → null(不回调)。
 * reset 类头(如 "6m0s")格式跨供应商不稳定,不解析 —— 只取确定的数值字段,诚实降级。
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

/** 按 model 前缀匹配 provider 配置(最长前缀优先,防前缀互为子串时歧义)。 */
function matchProvider(model: string, providers: BridgeProviderConfig[]): BridgeProviderConfig | null {
  let best: BridgeProviderConfig | null = null;
  for (const p of providers) {
    if (model.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best;
}

/** upstream 状态码 → Anthropic error type(尽量语义对齐,方便 SDK 分类)。 */
function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  if (status >= 500) return 'api_error';
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

const MAX_NON_STREAM_BODY_BYTES = 16 * 1024 * 1024;

async function readBodyWithLimit(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limitBytes) {
        await reader.cancel();
        throw new Error(`upstream response exceeds ${limitBytes} bytes`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 按 SSE 规范切事件:空行分隔事件,**同一事件的多条 `data:` 行先以 `\n` 拼成一个负载**
 * 再解析。逐行独立 JSON.parse 会把「合法但跨多行」的事件当成坏帧,整个非流式 fallback
 * 被判成 502(review 反馈)。与 responses-anthropic-bridge 的 parseSseBlock 同口径。
 */
function parseSsePayloads(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const payload = data.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    payloads.push(JSON.parse(payload) as unknown);
  }
  return payloads;
}

/** image block 的粗估 token 占位(Anthropic 图像典型 ~1100-1600 tok;粗估用中值,免 stringify 整段 base64)。 */
const IMAGE_BLOCK_ESTIMATE_CHARS = 1400 * 4;

/** chars/4 粗估 token —— 给 count_tokens 用(codex 后端无 count 端点)。 */
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

/** host 在路由决策点解析出的会话态偏好(经闭包传入,不走伪 header)。 */
export interface BridgeSessionPrefs {
  /** 用户选定的思维深度档(maker 6 档,handler 内收敛到 Responses 4 档);缺省走默认档。 */
  reasoningEffort?: string;
  /** Fast 模式;仅 provider 声明了 fastServiceTier 时映射成 service_tier。 */
  fast?: boolean;
}

/** createResponsesHandler 的 handle 入参 —— 与 compat-proxy LocalRequestHandler 的 args 同形 + prefs。 */
export interface BridgeHandleArgs {
  parsedBody: unknown;
  ctx: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };
  res: ServerResponse;
  prefs?: BridgeSessionPrefs;
}

export interface ResponsesBridgeHandler {
  handle(args: BridgeHandleArgs): Promise<void>;
}

export interface ResponsesHandlerOptions {
  /** 供应商配置列表(按 model 前缀路由)。前缀需互不为前缀关系,避免歧义。 */
  providers: BridgeProviderConfig[];
  logger?: BridgeLogger;
  /**
   * 上游 fetch。默认全局 fetch(undici)—— 它**不吃系统代理**,宿主在「系统代理」模式
   * 下必须注入自己的代理感知实现(desktop 注入 maker-host/outbound-fetch),否则
   * chatgpt.com / api.x.ai 这类境外上游会裸直连失败。形态与
   * responses-chat-bridge 的同名选项一致。
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
 * 创建订阅直连 handler。host 把它包进 compat-proxy 的 `RoutingDecision.localHandler`:
 * `{ localHandler: (a) => handler.handle({ ...a, prefs }) }`。
 */
export function createResponsesHandler(opts: ResponsesHandlerOptions): ResponsesBridgeHandler {
  // 协议标识 fail-fast:注册了未实现的 wireProtocol 直接抛,不让它静默注册成不可用的源。
  for (const p of opts.providers) {
    if (p.wireProtocol !== undefined && p.wireProtocol !== 'openai-responses') {
      throw new Error(`bridge provider '${p.prefix}' 声明了未实现的 wireProtocol: ${String(p.wireProtocol)}`);
    }
  }
  const providers = opts.providers.map((p) => ({ ...p, upstreamBase: trimTrailingSlashes(p.upstreamBase) }));
  const log = opts.logger ?? {};
  const fetchImpl = opts.fetchImpl ?? fetch;
  let reqSeq = 0;

  async function handle({ parsedBody, ctx, res, prefs }: BridgeHandleArgs): Promise<void> {
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
      // compat-proxy 只把匹配前缀的请求交到这;没匹配上说明配置/路由不一致。
      writeJson(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `no bridge provider for model '${wireModel}'` },
      });
      return;
    }
    // [1m] 是 cc 侧 wire 约定(目录窗口 ≥1M 的模型会带,见 maker-core toSdkModelString);
    // bridge 上游(chatgpt backend / api.x.ai)不认识这个后缀,必须剥掉。
    const realModel = wireModel.slice(provider.prefix.length).replace(/\[1m\]$/, '');

    // count_tokens:上游无对应端点,本地估算返回。
    if (ctx.url.includes('count_tokens')) {
      writeJson(res, 200, { input_tokens: estimateTokens(parsed) });
      return;
    }

    const sessionId =
      ctx.headers['x-claude-code-session-id'] ??
      parsed.metadata?.user_id ??
      undefined;

    // 鉴权:每请求让 provider 构造最新 headers(内部负责取 token / 懒刷新)。
    let providerHeaders: Record<string, string>;
    try {
      providerHeaders = await provider.buildHeaders({ sessionId });
    } catch (err) {
      log.error?.('buildHeaders failed', { reqId, prefix: provider.prefix, err: err instanceof Error ? err.message : String(err) });
      writeJson(res, 502, {
        type: 'error',
        error: { type: 'authentication_error', message: `bridge auth unavailable for ${provider.prefix} (订阅登录可能已失效,请重新登录)` },
      });
      return;
    }

    // reasoning 档:host 经 prefs 闭包传入用户选定 effort(CC 不会把非 Anthropic 模型的 effort
    // 放进请求体,由 host 从会话态解析);模型不支持 reasoning → 'none'。
    const reasoningSupported = provider.supportsReasoning ? provider.supportsReasoning(realModel) : true;
    const prefEffort = normalizeReasoningEffort(prefs?.reasoningEffort);
    const reasoningEffort = !reasoningSupported ? 'none' : prefEffort;

    // Fast 模式:prefs.fast × provider.fastServiceTier(codex='priority')。
    const serviceTier = prefs?.fast === true && provider.fastServiceTier ? provider.fastServiceTier : undefined;

    // 上游服务端工具(如 xAI x_search):只由 provider 按 model 静态声明,不受会话态影响,
    // 保证同一会话逐轮请求带同一份工具列表(前缀稳定)。
    const serverSideTools = provider.serverSideTools?.(realModel);

    // Anthropic Messages 语义:**只有显式 `stream:true` 才是 SSE**,字段缺失等同非流式。
    // Claude Code 的非流式 fallback 走 SDK 的 `messages.create()`,它**不带 stream 字段**
    // (2026-08-10 用随包 cc 二进制实测),按 `stream !== false` 判会把 fallback 误当流式、
    // 回一个 SSE,CLI 随即报 "empty or malformed response (HTTP 200)"。
    const downstreamStreaming = parsed.stream === true;
    const responsesReq = translateRequest(parsed, {
      model: realModel,
      promptCacheKey: sessionId,
      maxOutputTokensSupported: provider.maxOutputTokensSupported,
      reasoningEffort,
      serviceTier,
      providerPrefix: provider.prefix,
      serverSideTools,
    });

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let upstream: Response;
    try {
      upstream = await fetchImpl(`${provider.upstreamBase}/responses`, {
        method: 'POST',
        headers: {
          ...providerHeaders,
          'content-type': 'application/json',
          // 恒 SSE:上游只接受流式(见 translateRequest 的 stream 注释),非流式调用方
          // 由下游缓冲满足。
          accept: 'text/event-stream',
        },
        body: JSON.stringify(responsesReq),
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      log.error?.('upstream fetch failed', { reqId, err: err instanceof Error ? err.message : String(err) });
      writeJson(res, 502, { type: 'error', error: { type: 'api_error', message: `upstream unreachable: ${String(err)}` } });
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const text = upstream.body ? await upstream.text().catch(() => '') : '';
      const status = upstream.ok ? 502 : upstream.status;
      log.warn?.(upstream.ok ? 'upstream 2xx without response body' : 'upstream non-2xx', {
        reqId,
        status: upstream.status,
        body: text.slice(0, 2000),
      });
      if (!upstream.ok && provider.onUpstreamError) {
        try {
          await provider.onUpstreamError({
            status: upstream.status,
            body: text,
            requestHeaders: providerHeaders,
          });
        } catch (err) {
          // Provider 状态收口失败不能吞掉或改写真实上游错误；调用方仍需看到原始状态码/正文。
          log.warn?.('onUpstreamError failed', {
            reqId,
            prefix: provider.prefix,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      writeJson(res, status, {
        type: 'error',
        error: {
          type: anthropicErrorType(status),
          message: text.slice(0, 2000) || (
            upstream.ok
              ? 'provider returned a successful response without a body'
              : `upstream ${upstream.status}`
          ),
        },
      });
      return;
    }

    // 上游限流头(api.x.ai 返 x-ratelimit-*;codex 后端不返)→ 尽力回调给 host 做额度展示。
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

    const upstreamContentType = upstream.headers.get('content-type') ?? '';
    const upstreamIsSse = upstreamContentType.toLowerCase().includes('event-stream');

    // 非流式调用方(Claude Code 流式失败后的 fallback,请求体不带 stream 字段)要求一个
    // 完整的 Anthropic Message JSON。上游恒回 SSE(只接受流式),所以这里缓冲整流后组装;
    // 同时兼容个别上游直接给 Responses JSON 的情况。
    if (!downstreamStreaming) {
      const translator = new SseTranslator(wireModel);
      const collector = new AnthropicMessageCollector();
      const collect = (event: AnthropicSseEvent): void => collector.push(event);
      try {
        const body = await readBodyWithLimit(upstream, MAX_NON_STREAM_BODY_BYTES);
        if (!body.trim()) throw new Error('provider returned an empty response body');
        if (upstreamIsSse) {
          for (const event of parseSsePayloads(body)) {
            for (const output of translator.push(event)) collect(output);
          }
          for (const output of translator.finish()) collect(output);
        } else {
          const responseJson = JSON.parse(body) as unknown;
          for (const output of translator.pushJson(responseJson)) collect(output);
        }
      } catch (err) {
        // 客户端已断开(res close → abort):上游读取抛错只是取消的副作用,不写响应。
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.('upstream non-stream response invalid', { reqId, error: message });
        writeJson(res, 502, {
          type: 'error',
          error: { type: 'api_error', message: `invalid upstream response: ${message}` },
        });
        return;
      }

      const result = collector.finish();
      if (!result.ok) {
        writeJson(res, 502, { type: 'error', error: result.error });
        return;
      }
      writeJson(res, 200, result.message);
      return;
    }

    // 上游 2xx 但 content-type 不是 SSE(反代/网关吐 JSON 或 HTML):大概率整流翻不出
    // 任何事件,先留一条 warn ——零事件收尾时的合成 error 会带上正文前缀(#941)。
    // 判定大小写不敏感(HTTP header 值的 media type 不区分大小写);真实状态码进日志,
    // 本路径接受任意 2xx,不硬编码 200(review 反馈)。
    if (!upstreamIsSse) {
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

    // 用 wireModel(带前缀,如 chatgpt/gpt-5.5)而非 realModel 构造 —— message_start 回显带前缀 id,
    // CC 的 modelUsage 据此记账,下游 usage 可按前缀区分订阅轮,不与真网关同名裸模型混淆。
    const translator = new SseTranslator(wireModel);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // 零事件诊断:整流一条 Anthropic 事件都没写回时,CLI 只能报
    // "empty or malformed response (HTTP 200)" 并盲目重试,真实错误被完全掩盖(#941)。
    // 记录写回事件数与上游正文前缀,收尾时合成一条带上游信息的 error 事件 + warn 日志。
    let eventsWritten = 0;
    let rawPrefix = '';
    const RAW_PREFIX_LIMIT = 500;
    const writeOut = (ev: AnthropicSseEvent): void => {
      eventsWritten += 1;
      writeSseEvent(res, ev);
    };
    const finalizeStream = (): void => {
      if (eventsWritten === 0) {
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
        return;
      }
      // 至少有一个事件但没有 response.completed / response.incomplete:finish() 产出
      // stream_truncated error,绝不把 clean EOF 伪装成正常 message_stop。
      for (const outEv of translator.finish()) writeOut(outEv);
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
          if (!payload || payload === '[DONE]') continue;
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
      // 上游干净结束:零事件时合成带上游信息的 error 事件;有事件但没走
      // response.completed 时按截断报错。两条路径都绝不以空 200 / 伪装完成收尾。
      finalizeStream();
    } catch (err) {
      if (!abort.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn?.('upstream stream error', { reqId, err: errMsg });
        // 断流不走 finalizeStream:已写出部分事件后再补 message_stop,Claude Code 会
        // 把截断响应当正常完成、上游读取错误被掩盖(review 反馈 P1)。fail() 关块后
        // 发 error 事件收尾(错误帧已收尾时返回空,不重复报错);流失败于任何事件
        // 之前时 error 事件同样成立,零事件合成诊断只服务「干净结束却零事件」路径。
        for (const outEv of translator.fail(`upstream stream error: ${errMsg}`)) writeOut(outEv);
      }
    } finally {
      res.end();
    }
  }

  log.debug?.('anthropic-responses-bridge handler ready', { providers: providers.map((p) => p.prefix) });
  return { handle };
}
