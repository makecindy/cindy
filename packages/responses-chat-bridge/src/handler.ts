import type { ServerResponse } from 'node:http';

import { ChatSseTranslator } from './chat-sse-translator.js';
import { coalesceLeadingSystemMessages, translateResponsesRequestWithContext } from './translate-request.js';
import {
  UnsupportedResponsesFeatureError,
  type ChatBridgeLogger,
  type ChatBridgeProviderConfig,
  type ChatMessage,
  type ResponsesChatBridgeHandler,
  type ResponsesRequest,
} from './types.js';

const MAX_ERROR_BODY_CHARS = 16 * 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyUpstreamErrorBody(text: string): 'empty' | 'json' | 'text' {
  if (!text.trim()) return 'empty';
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return 'text';
  }
}

function isSystemMessageOrderError(status: number, text: string): boolean {
  if (status !== 400) return false;
  try {
    const body: unknown = JSON.parse(text);
    return isPlainObject(body)
      && isPlainObject(body.error)
      && typeof body.error.message === 'string'
      && /^system message must be at the beginning\.?$/i.test(body.error.message.trim());
  } catch {
    return false;
  }
}

/** Only retry a prefix merge; moving later instructions across a turn changes their scope. */
function hasConsecutiveSystemPrefix(messages: ChatMessage[]): boolean {
  let prefixLength = 0;
  while (messages[prefixLength]?.role === 'system') prefixLength += 1;
  return prefixLength > 1 && messages.every((message, index) => (
    index < prefixLength || (message.role !== 'system' && message.role !== 'developer')
  ));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 写一条 OpenAI Responses SSE 事件。协议要求 **`event: <type>` 行 + `data:` 行**,且 data 里带
 * 全响应连续递增的 `sequence_number` —— codex app-server 按 `event:` 行分发事件类型,缺了会
 * 静默丢弃整条流(界面无输出、agent 事件流为空)。sequenceNumber 由 handler 统一维护注入,
 * 保持 translator 纯净。
 */
function writeSse(res: ServerResponse, event: unknown, sequenceNumber: number): void {
  if (!isPlainObject(event) || typeof event.type !== 'string') return;
  const payload = { ...event, sequence_number: sequenceNumber };
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

function joinUrl(base: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryIndex = normalizedPath.indexOf('?');
  const pathname = queryIndex === -1 ? normalizedPath : normalizedPath.slice(0, queryIndex);
  const hasEncodedPathSeparator = /%(?:2f|5c)/i.test(pathname);
  const hasDotSegment = pathname
    .split('/')
    .some((segment) => {
      const normalizedDots = segment.replace(/%2e/gi, '.');
      return normalizedDots === '.' || normalizedDots === '..';
    });
  if (
    normalizedPath.length > 2_048
    || normalizedPath.startsWith('//')
    || normalizedPath.includes('#')
    || normalizedPath.includes('\\')
    || /[^\u0021-\u007e]/.test(normalizedPath)
    || !/^\/[A-Za-z0-9\-._~%!$&()*+,;=:@/?]*$/.test(normalizedPath)
    || /%(?![0-9A-Fa-f]{2})/.test(normalizedPath)
    || hasEncodedPathSeparator
    || hasDotSegment
  ) {
    throw new TypeError('invalid chat completions path');
  }
  const url = new URL(base);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
  ) {
    throw new TypeError('invalid upstream base URL');
  }
  const pathQuery = queryIndex === -1 ? '' : normalizedPath.slice(queryIndex + 1);
  const baseQuery = url.search.slice(1);
  url.pathname = `${trimTrailingSlashes(url.pathname)}${pathname}`;
  url.search = [baseQuery, pathQuery].filter(Boolean).join('&');
  url.hash = '';
  return url.toString();
}

function responsesError(status: number, code: string, message: string): Record<string, unknown> {
  return {
    error: {
      type: status === 401 || status === 403 ? 'authentication_error' :
        status === 429 ? 'rate_limit_error' :
          status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
      message,
    },
  };
}

async function readErrorText(upstream: Response): Promise<string> {
  try {
    return (await upstream.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

async function readResponseText(upstream: Response): Promise<string> {
  const reader = upstream.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_RESPONSE_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        chunks.push(decoder.decode());
        return chunks.join('');
      }
      const remaining = MAX_RESPONSE_BODY_BYTES - bytesRead;
      const bounded = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += bounded.byteLength;
      chunks.push(decoder.decode(bounded, { stream: true }));
      if (bounded.byteLength < value.byteLength || bytesRead >= MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        return chunks.join('');
      }
    }
    await reader.cancel();
    return chunks.join('');
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures after a body read error.
    }
    return '';
  } finally {
    reader.releaseLock();
  }
}

export interface ResponsesChatHandlerOptions {
  logger?: ChatBridgeLogger;
  fetchImpl?: typeof fetch;
}

/** Create an in-process Responses-to-Chat handler for one resolved provider runtime. */
export function createResponsesChatHandler(
  provider: ChatBridgeProviderConfig,
  opts: ResponsesChatHandlerOptions = {},
): ResponsesChatBridgeHandler {
  const log = opts.logger ?? {};
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async handle({ parsedBody, res }): Promise<void> {
      if (!isPlainObject(parsedBody) || typeof parsedBody.model !== 'string') {
        writeJson(res, 400, responsesError(400, 'invalid_request', 'invalid Responses request body'));
        return;
      }
      const request = parsedBody as ResponsesRequest;
      const realModel = provider.rewriteModel?.(request.model) ?? request.model;
      let translated;
      try {
        translated = translateResponsesRequestWithContext(request, {
          model: realModel,
          capabilities: provider.capabilities,
          onDroppedTool: (type, index) => {
            if (type === 'web_search') {
              log.warn?.('responses-chat bridge dropped unsupported built-in tool', {
                model: request.model,
                tool: type,
                index,
                action: 'continue_without_tool',
              });
              return;
            }
            log.warn?.('responses-chat bridge dropped non-function tool', { type, index });
          },
        });
      } catch (error) {
        if (error instanceof UnsupportedResponsesFeatureError) {
          log.warn?.('responses-chat bridge rejected unsupported feature', {
            model: request.model,
            feature: error.feature,
          });
          writeJson(res, 400, responsesError(400, 'unsupported_feature', error.message));
          return;
        }
        throw error;
      }
      const { request: chatRequest, toolContext } = translated;

      let upstreamUrl: string;
      try {
        upstreamUrl = joinUrl(
          provider.upstreamBase,
          provider.chatCompletionsPath ?? '/chat/completions',
        );
      } catch (error) {
        log.error?.('responses-chat bridge invalid upstream configuration', {
          model: request.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(
          res,
          502,
          responsesError(502, 'invalid_upstream_config', 'provider upstream configuration is invalid'),
        );
        return;
      }

      let providerHeaders: Record<string, string>;
      try {
        providerHeaders = await provider.buildHeaders();
      } catch (error) {
        log.error?.('responses-chat bridge auth unavailable', {
          model: request.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(res, 502, responsesError(502, 'authentication_unavailable', 'provider authentication is unavailable'));
        return;
      }

      const abort = new AbortController();
      const abortUpstream = (): void => abort.abort();
      res.once('close', abortUpstream);
      let upstream: Response;
      let upstreamErrorText: string | undefined;
      try {
        const send = (): Promise<Response> => fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: {
            ...providerHeaders,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(chatRequest),
          signal: abort.signal,
        });
        upstream = await send();
        if (!upstream.ok) {
          upstreamErrorText = await readErrorText(upstream);
          // Qwen can reject instructions + developer even before the first user (#3583).
          // Retry only a precise pre-generation rejection, once and within this request.
          // Explicit policies and native developer-role semantics remain authoritative.
          if (
            provider.capabilities?.systemMessagePolicy === undefined
            && provider.capabilities?.developerRole !== 'developer'
            && isSystemMessageOrderError(upstream.status, upstreamErrorText)
            && !abort.signal.aborted
            && hasConsecutiveSystemPrefix(chatRequest.messages)
          ) {
            const coalesced = coalesceLeadingSystemMessages(chatRequest.messages);
            if (coalesced !== chatRequest.messages) {
              chatRequest.messages = coalesced;
              upstream = await send();
              upstreamErrorText = upstream.ok ? undefined : await readErrorText(upstream);
            }
          }
        }
        if (abort.signal.aborted) {
          res.off('close', abortUpstream);
          void upstream.body?.cancel().catch(() => {});
          return;
        }
      } catch (error) {
        res.off('close', abortUpstream);
        if (abort.signal.aborted) return;
        log.warn?.('responses-chat bridge upstream unreachable', {
          model: request.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(res, 502, responsesError(502, 'upstream_unreachable', 'provider upstream is unreachable'));
        return;
      }

      const reportUpstreamError = async (status: number, body: string): Promise<void> => {
        if (!provider.onUpstreamError) return;
        try {
          await provider.onUpstreamError({ status, body, requestHeaders: providerHeaders });
        } catch (error) {
          log.warn?.('responses-chat bridge onUpstreamError failed', {
            model: request.model,
            status,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      if (!upstream.ok || !upstream.body) {
        const text = upstreamErrorText ?? await readErrorText(upstream);
        log.warn?.('responses-chat bridge upstream error', {
          model: request.model,
          status: upstream.status,
          errorKind: classifyUpstreamErrorBody(text),
        });
        await reportUpstreamError(upstream.status, text);
        res.off('close', abortUpstream);
        writeJson(
          res,
          upstream.status,
          responsesError(upstream.status, 'upstream_error', text || `provider returned HTTP ${upstream.status}`),
        );
        return;
      }

      const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        const text = await readResponseText(upstream);
        let jsonBody: unknown;
        try {
          jsonBody = JSON.parse(text);
        } catch {
          jsonBody = undefined;
        }
        if (isPlainObject(jsonBody) && Array.isArray(jsonBody.choices)) {
          const translator = new ChatSseTranslator(request.model, {
            toolContext,
            zeroUsageOnMissing: provider.capabilities?.zeroUsageOnMissing,
            inlineReasoning: provider.capabilities?.inlineReasoning,
          });
          const events = [
            ...translator.push(jsonBody),
            ...translator.finish(),
          ];
          const terminal = [...events].reverse().find((event) => (
            isPlainObject(event)
            && (
              event.type === 'response.completed'
              || event.type === 'response.incomplete'
              || event.type === 'response.failed'
            )
            && isPlainObject(event.response)
          )) as Record<string, unknown> | undefined;
          if (request.stream !== false) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            let sequenceNumber = 0;
            for (const event of events) writeSse(res, event, sequenceNumber++);
            res.end();
            res.off('close', abortUpstream);
            return;
          }
          res.off('close', abortUpstream);
          writeJson(res, 200, terminal && isPlainObject(terminal.response)
            ? terminal.response
            : responsesError(502, 'invalid_upstream_response', 'provider response could not be translated'));
          return;
        }
        log.warn?.('responses-chat bridge upstream returned non-SSE response', {
          model: request.model,
          status: upstream.status,
          contentType: contentType || 'missing',
        });
        res.off('close', abortUpstream);
        writeJson(
          res,
          502,
          responsesError(502, 'invalid_upstream_response', text || 'provider did not return a streaming SSE response'),
        );
        return;
      }

      if (request.stream !== false) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
      }
      const translator = new ChatSseTranslator(request.model, {
        toolContext,
        zeroUsageOnMissing: provider.capabilities?.zeroUsageOnMissing,
        inlineReasoning: provider.capabilities?.inlineReasoning,
      });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamFailed = false;
      // 全响应连续递增的 SSE sequence_number（Responses 协议要求）。
      let seq = 0;
      let terminalEvent: Record<string, unknown> | undefined;
      const emit = (output: unknown): void => {
        if (request.stream === false) {
          if (
            isPlainObject(output)
            && (
              output.type === 'response.completed'
              || output.type === 'response.incomplete'
              || output.type === 'response.failed'
            )
            && isPlainObject(output.response)
          ) {
            terminalEvent = output;
          }
          return;
        }
        writeSse(res, output, seq++);
      };
      // 返回 true = 该帧是流内终态 provider error(已发出 response.failed):
      // 上游可能在错误事件后保持连接不关,继续等 EOF 会让请求、上游连接与
      // 相关会话资源一直挂着 —— 调用侧应立即停读并取消上游 reader(#2839)。
      const parseDataPayload = (payload: string): boolean => {
        if (!payload) return false;
        if (payload === '[DONE]') {
          translator.markTerminal();
          return false;
        }
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          throw new Error('upstream SSE data frame is malformed');
        }
        const streamedError = isPlainObject(event) && isPlainObject(event.error)
          ? event.error
          : null;
        if (streamedError) {
          const message = typeof streamedError.message === 'string'
            ? streamedError.message
            : 'provider returned an error event';
          void reportUpstreamError(
            typeof streamedError.status === 'number' ? streamedError.status : 502,
            JSON.stringify(streamedError).slice(0, MAX_ERROR_BODY_CHARS),
          );
          for (const output of translator.fail(message)) emit(output);
          return true;
        }
        for (const output of translator.push(event)) emit(output);
        return false;
      };
      let upstreamErrored = false;
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let start = 0;
          let newline: number;
          while ((newline = buffer.indexOf('\n', start)) >= 0) {
            const line = buffer.slice(start, newline).replace(/\r$/, '');
            start = newline + 1;
            if (!line.startsWith('data:')) continue;
            if (parseDataPayload(line.slice(5).trim())) {
              upstreamErrored = true;
              break readLoop;
            }
          }
          if (start > 0) buffer = buffer.slice(start);
          if (buffer.length > MAX_SSE_BUFFER_CHARS) {
            throw new Error('upstream SSE line exceeds 1 MiB');
          }
        }
        if (upstreamErrored) {
          // 终态错误之后:当前 chunk 剩余帧不再解析,取消上游 reader 释放
          // 连接。不 await:注入的 fetchImpl 可能给出取消长期 pending 的流,
          // 挂起的取消不能阻塞下游收口。
          try {
            reader.cancel().catch(() => {
              // 取消失败不影响下游收口。
            });
          } catch {
            // 同步抛出的取消失败同样不影响下游收口。
          }
        } else {
          buffer += decoder.decode();
          if (buffer.trim()) {
            for (const line of buffer.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue;
              if (parseDataPayload(line.slice(5).trim())) break;
            }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          streamFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          log.warn?.('responses-chat bridge stream failed', { model: request.model, error: message });
          for (const output of translator.fail(message)) emit(output);
        }
      } finally {
        res.off('close', abortUpstream);
        if (!streamFailed && !abort.signal.aborted) {
          for (const output of translator.finish(true)) emit(output);
        }
        if (request.stream === false) {
          writeJson(res, 200, terminalEvent && isPlainObject(terminalEvent.response)
            ? terminalEvent.response
            : responsesError(502, 'invalid_upstream_response', 'provider response could not be translated'));
        } else {
          res.end();
        }
      }
    },
  };
}
